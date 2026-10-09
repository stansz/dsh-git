/**
 * dsh-git — the GitHub half of the git surface: the REST API over global `fetch`.
 *
 * This module deliberately does not shell out to `gh`. `gh pr merge
 * --delete-branch` (cli/cli#14537) performs its local branch cleanup in the
 * repository of the *current directory*, matching the branch by name alone. Run
 * from a directory that is not the pull request's repository — the normal case
 * for an agent that moves between checkouts — it can delete an unrelated
 * repository's worktree and its unpushed commits. The REST API cannot make that
 * mistake: every request names the owner and the repository it applies to.
 *
 * The second reason is diagnostics. The API answers with status codes a caller
 * can branch on (405 not mergeable, 409 head changed, 404 already closed), where
 * a CLI's prose has to be pattern-matched and changes without notice. Nothing in
 * this module decides anything by matching error text.
 *
 * Every export returns an envelope and never throws across the module boundary:
 * `{ok: true, ...}` or `{ok: false, code, error}`. `code` is a stable string;
 * `error` is one short sentence for a human. The token is read lazily, memoized
 * for the process, never logged, never written to disk, and stripped from every
 * string that can reach a caller.
 *
 * git itself is the caller's business: this module never reads a repository, and
 * facts such as "how many commits is the branch ahead" arrive as arguments
 * (`upsertPull` expects the caller to have run its own `aheadOf` pre-check).
 * Only `node:` builtins are imported — never `./git.mjs`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

/** How long one GitHub API request may take before it is aborted. */
const DEFAULT_TIMEOUT_MS = 15000;

/** How long the `gh auth token` fallback may take before the chain gives up on it. */
const GH_TOKEN_TIMEOUT_MS = 10000;

/** What replaces anything shaped like a credential before a caller can see it. */
const REDACTED = '[redacted]';

/**
 * Credential shapes, redacted wherever they appear:
 *   ghp_        personal access token (classic)
 *   gho_        OAuth access token
 *   ghu_        user-to-server token
 *   ghs_        server-to-server token (GitHub App installation)
 *   ghr_        refresh token
 *   github_pat_ fine-grained personal access token
 * The trailing class is deliberately greedy over `[A-Za-z0-9_]`, which is the
 * whole alphabet of every one of these shapes, so the match cannot stop early
 * and leave the tail of a real secret in the text.
 */
const SECRET_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/gu;

/** The API version every request pins. */
const API_VERSION = '2022-11-28';

/** Protocols a remote URL may use and still be a git remote. */
const REMOTE_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:']);

/** The merge methods the merge endpoint accepts. */
const MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

/**
 * The one memoized token resolution for the process.
 *
 * `key` records which host and which credential source the promise belongs to,
 * so a client configured with a different environment is not served another
 * client's answer, and the promise itself is what makes `gh auth token` (a
 * Keychain read, tens of milliseconds) run once instead of once per request.
 *
 * @type {{key: string, promise: Promise<object>} | undefined}
 */
let tokenMemo;

/**
 * The one memoized availability probe for the process, keyed the same way.
 *
 * @type {{key: string, promise: Promise<object>} | undefined}
 */
let availabilityProbe;

/** Whether a value is a usable non-empty string. */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Cut text to a length a caller can put in a message, marking that it was cut. */
function truncate(text, max) {
  if (typeof text !== 'string') return text;
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/**
 * Replace the token and every credential-shaped string with `[redacted]`.
 *
 * The literal token is replaced first, because a real token is the one secret
 * this process actually holds; the pattern then catches a second credential
 * echoed by the API, or one belonging to a different host, that the literal
 * replacement would miss. The replacement is applied to raw response text
 * before it is parsed, so JSON survives (neither `[` nor `]` needs escaping)
 * and nothing downstream can re-introduce the secret.
 *
 * @param {string} text - any text that might reach a caller or a log.
 * @param {string} [token] - the live token, when this process has one.
 * @returns {string} the same text with credentials removed.
 */
function redact(text, token) {
  if (typeof text !== 'string' || text === '') return text;
  let safe = isNonEmptyString(token) ? text.split(token).join(REDACTED) : text;
  // A global regex is lastIndex-free here: String.replace always starts at 0.
  safe = safe.replace(SECRET_PATTERN, REDACTED);
  return safe;
}

/** Drop `undefined` fields: envelopes cross the tools layer, which rejects them. */
function compact(fields) {
  const clean = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

/** A pre-flight refusal: nothing was sent, so there is no status to report. */
function refusal(code, error) {
  return { ok: false, code, error: redact(error) };
}

/** How a rejected argument is described, without echoing a secret if one was passed. */
function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(truncate(redact(value), 40));
  return typeof value;
}

/**
 * Validate required string fields of an options object.
 *
 * @returns {{ok: false, code: string, error: string} | undefined} a refusal
 *   envelope, or undefined when every field is a non-empty string.
 */
function requireText(opts, names) {
  if (opts === null || typeof opts !== 'object') {
    return refusal('invalid-argument', 'expected an options object with ' + names.join(', '));
  }
  for (const name of names) {
    if (!isNonEmptyString(opts[name])) {
      return refusal('invalid-argument', name + ' must be a non-empty string (got ' + describeValue(opts[name]) + ')');
    }
  }
  return undefined;
}

/** Validate a pull request number. */
function requireNumber(opts) {
  if (opts === null || typeof opts !== 'object' || !Number.isInteger(opts.number) || opts.number <= 0) {
    return refusal('invalid-argument', 'number must be a positive integer (got ' + describeValue(opts?.number) + ')');
  }
  return undefined;
}

/** Lower-case a host, dropping a scheme and trailing slashes a caller may have pasted. */
function normalizeHost(value) {
  if (typeof value !== 'string') return undefined;
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//u, '');
  host = host.replace(/\/+$/u, '');
  if (host === '' || /\s/u.test(host) || host.includes('@')) return undefined;
  return host;
}

/** The host part of a possibly ported host string. */
function hostWithoutPort(host) {
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Where the REST API lives for a web host.
 *
 * github.com serves its API on api.github.com, not on the web host; a GitHub
 * Enterprise Server serves the same API under /api/v3 on its own host. The
 * client's `host` is the host a remote URL names, so `parseRemote` output can be
 * handed straight to `createGithubClient`.
 */
function apiBase(host) {
  const bare = hostWithoutPort(host);
  if (bare === 'github.com' || bare === 'api.github.com') return 'https://api.github.com';
  return 'https://' + host + '/api/v3';
}

/** Whether a path segment can be a GitHub owner or repository name. */
function isRepoName(value) {
  return typeof value === 'string'
    && value !== ''
    && value !== '.'
    && value !== '..'
    && /^[A-Za-z0-9._-]+$/u.test(value);
}

/** Turn a matched host and path into the parse result, or undefined when it is not o/r. */
function finishRemote(hostname, pathText, wanted) {
  const host = String(hostname).toLowerCase();
  const matchHost = hostWithoutPort(wanted);
  // The host must be the requested one or a subdomain of it: `notgithub.com`
  // must not match `github.com`, and neither may `github.com.evil.example`.
  if (host !== matchHost && !host.endsWith('.' + matchHost)) return undefined;

  let path = String(pathText);
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  // Exactly owner/repo and nothing else: `/o/r/tree/main`, `/o/r/` and `/o`
  // are all rejected rather than guessed at.
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length !== 2) return undefined;

  const owner = segments[0];
  let repo = segments[1];
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (!isRepoName(owner) || !isRepoName(repo)) return undefined;
  // The host is reported as the one that was asked about, so `ssh.github.com`
  // and `www.github.com` both resolve to github.com for API purposes.
  return { owner, repo, host: wanted };
}

/**
 * Parse a git remote URL into its owner, repository and host.
 *
 * Handles the forms a real remote takes: `https://github.com/o/r(.git)`,
 * `https://user@github.com/o/r(.git)`, `git@github.com:o/r(.git)`,
 * `ssh://git@github.com/o/r(.git)` and the `git+https://` variant a package
 * manager writes. The host must be `host` itself or a subdomain of it, and the
 * path must be exactly two segments, so a web URL such as
 * `https://github.com/o/r/pull/12` is rejected rather than silently parsed as a
 * repository called `pull`.
 *
 * @param {string} url - the remote URL, in any of the supported forms.
 * @param {string} [host] - the host it must belong to; `github.com` by default.
 * @returns {{owner: string, repo: string, host: string} | undefined} undefined
 *   for a non-matching host, an unparseable URL, an empty or over-long path, or
 *   anything ambiguous. Never throws.
 */
export function parseRemote(url, host = 'github.com') {
  try {
    if (typeof url !== 'string') return undefined;
    const raw = url.trim();
    if (raw === '') return undefined;
    const wanted = normalizeHost(host);
    if (wanted === undefined) return undefined;

    // scp-like syntax (git@github.com:o/r) is not a URL and must be recognised
    // before anything hands the string to the URL parser.
    if (!raw.includes('://')) {
      const scp = /^(?<user>[^@/\s]+)@(?<scpHost>[^:/\s]+):(?<path>[^\s]+)$/u.exec(raw);
      if (scp !== null) return finishRemote(scp.groups.scpHost, scp.groups.path, wanted);
    }

    let parsed;
    try {
      // `git+https://…` and `git+ssh://…` are the same URL with a package-manager
      // prefix; the prefix is stripped so the URL parser sees the real scheme.
      parsed = new URL(raw.replace(/^git\+/u, ''));
    } catch {
      return undefined;
    }
    if (!REMOTE_PROTOCOLS.has(parsed.protocol)) return undefined;
    return finishRemote(parsed.hostname, parsed.pathname, wanted);
  } catch {
    // "Never throws" is the contract, including for inputs no one anticipated.
    return undefined;
  }
}

/** The environment token, if one is set. GH_TOKEN wins over GITHUB_TOKEN. */
function envToken(env) {
  // Step 1 of the chain: an explicit GH_TOKEN.
  if (isNonEmptyString(env?.GH_TOKEN)) return { source: 'GH_TOKEN', value: env.GH_TOKEN.trim() };
  // Step 2: the GITHUB_TOKEN every CI system sets.
  if (isNonEmptyString(env?.GITHUB_TOKEN)) return { source: 'GITHUB_TOKEN', value: env.GITHUB_TOKEN.trim() };
  return undefined;
}

/**
 * The memo key for a token resolution.
 *
 * For an environment token the key carries a SHA-256 digest of the value, never
 * the value itself: the digest keeps the secret out of a key that could be
 * logged, while still making a changed token resolve afresh instead of being
 * masked by a stale memo. For the `gh` fallback there is nothing to digest, so
 * the host alone identifies it.
 */
function tokenKey(env, host) {
  const direct = envToken(env);
  if (direct !== undefined) {
    const digest = createHash('sha256').update(direct.value).digest('hex');
    return host + '|' + direct.source + '|' + digest;
  }
  return host + '|gh-cli';
}

/** The environment a child process gets: the injected env, with PATH guaranteed. */
function childEnv(env) {
  if (env !== null && typeof env === 'object' && typeof env.PATH === 'string') return env;
  return { ...(env ?? {}), PATH: process.env.PATH ?? '' };
}

/**
 * Step 3 of the chain: ask `gh` for the token it stores.
 *
 * `execFile` with a timeout and `windowsHide`, never a shell: no argument can be
 * interpreted, and a hung `gh` cannot hang the caller. The token is returned to
 * the caller and goes nowhere else — not into a message, not into a file.
 *
 * @returns {Promise<{ok: true, token: string, source: string}
 *   | {ok: false, code: 'no-credentials', error: string}>} never rejects.
 */
function ghAuthToken(env, host) {
  return new Promise((resolve) => {
    try {
      execFile(
        'gh',
        ['auth', 'token', '--hostname', host],
        {
          encoding: 'utf8',
          timeout: GH_TOKEN_TIMEOUT_MS,
          windowsHide: true,
          env: childEnv(env),
        },
        (error, stdout, stderr) => {
          if (error !== null && error !== undefined) {
            const reason = isNonEmptyString(error.code) ? String(error.code) : 'failed';
            // stderr helps a caller degrade gracefully ("not logged in" is very
            // different from "gh is not installed"); it is redacted anyway.
            const hint = truncate(redact(String(stderr ?? '').trim().split('\n')[0] ?? ''), 120);
            resolve({
              ok: false,
              code: 'no-credentials',
              error: 'no GitHub token: GH_TOKEN and GITHUB_TOKEN are unset and `gh auth token --hostname '
                + host + '` ' + reason + (hint === '' ? '' : ' (' + hint + ')'),
            });
            return;
          }
          const token = String(stdout ?? '').trim();
          if (token === '') {
            resolve({
              ok: false,
              code: 'no-credentials',
              error: 'no GitHub token: GH_TOKEN and GITHUB_TOKEN are unset and `gh auth token --hostname '
                + host + '` printed nothing',
            });
            return;
          }
          resolve({ ok: true, token, source: 'gh-cli' });
        },
      );
    } catch (error) {
      resolve({
        ok: false,
        code: 'no-credentials',
        error: redact('no GitHub token: `gh auth token --hostname ' + host + '` could not be started ('
          + String(error?.message ?? error) + ')'),
      });
    }
  });
}

/**
 * Resolve the token once, in the documented order, and memoize the promise.
 *
 * @param {object} env - the client's environment.
 * @param {string} host - the API host the token is for.
 * @returns {Promise<{ok: true, token: string, source: string}
 *   | {ok: false, code: 'no-credentials', error: string}>} never rejects.
 */
function resolveTokenOnce(env, host) {
  const key = tokenKey(env, host);
  if (tokenMemo === undefined || tokenMemo.key !== key) {
    const promise = (async () => {
      const direct = envToken(env);
      if (direct !== undefined) return { ok: true, token: direct.value, source: direct.source };
      return ghAuthToken(env, host);
    })().catch((error) => ({
      ok: false,
      code: 'no-credentials',
      error: redact('no GitHub token: ' + String(error?.message ?? error)),
    }));
    tokenMemo = { key, promise };
  }
  return tokenMemo.promise;
}

/** Read a header from a real `Headers` object or from a stub that is a plain object. */
function headerValue(headers, name) {
  if (headers === null || headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(wanted);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

/** Whether a 403 is really a rate limit: the headers say so, and nothing else decides it. */
function isRateLimited(headers) {
  if (headerValue(headers, 'x-ratelimit-remaining') === '0') return true;
  return headerValue(headers, 'retry-after') !== undefined;
}

/** The stable code for an HTTP failure status. */
function codeForStatus(status, headers) {
  if (status === 401) return 'auth';
  if (status === 403) return isRateLimited(headers) ? 'rate-limited' : 'auth';
  if (status === 404) return 'not-found';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate-limited';
  return 'http-error';
}

/** The short human message inside a response body, whatever shape it arrived in. */
function bodyMessage(data) {
  if (typeof data === 'string') return truncate(data.trim(), 200);
  if (data === null || typeof data !== 'object') return undefined;
  if (isNonEmptyString(data.message)) return truncate(data.message.trim(), 200);
  if (isNonEmptyString(data.error)) return truncate(data.error.trim(), 200);
  return undefined;
}

/** The validation errors a 422 carries, flattened into one short line. */
function bodyDetail(data) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const parts = errors.slice(0, 4).map((entry) => {
    if (typeof entry === 'string') return entry;
    if (isNonEmptyString(entry?.message)) return entry.message;
    if (isNonEmptyString(entry?.code)) return entry.code;
    return undefined;
  }).filter((entry) => entry !== undefined);
  return parts.length === 0 ? undefined : truncate(parts.join('; '), 300);
}

/** A failure that came back from the API, with the status and message attached. */
function apiFailure(code, method, path, status, message, detail, token) {
  const short = message === undefined ? undefined : truncate(redact(message, token), 200);
  const extra = detail === undefined ? undefined : truncate(redact(detail, token), 300);
  const described = 'GitHub ' + method + ' ' + path + ' failed with HTTP ' + status
    + (short === undefined ? '' : ': ' + short);
  return compact({ ok: false, code, status, message: short, detail: extra, error: redact(described, token) });
}

/**
 * Combine the caller's signal with a timeout.
 *
 * `AbortSignal.any` is used when the runtime has it; otherwise a controller is
 * wired to both. Either way the returned `cleanup` must run, so the manual
 * path's timer cannot keep the process alive.
 *
 * @returns {{signal: AbortSignal | undefined, cleanup: () => void}}
 */
function combineSignal(callerSignal, timeoutMs) {
  const usable = callerSignal !== undefined
    && callerSignal !== null
    && typeof callerSignal === 'object'
    && typeof callerSignal.aborted === 'boolean'
    ? callerSignal
    : undefined;

  if (typeof AbortSignal === 'function'
    && typeof AbortSignal.any === 'function'
    && typeof AbortSignal.timeout === 'function') {
    // AbortSignal.timeout's timer is unref'd by the runtime, so there is nothing
    // to clear here and an in-flight request cannot hold the event loop open.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return {
      signal: usable === undefined ? timeoutSignal : AbortSignal.any([usable, timeoutSignal]),
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onAbort = () => controller.abort();
  if (usable !== undefined) {
    if (usable.aborted) controller.abort();
    else usable.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (usable !== undefined) usable.removeEventListener('abort', onAbort);
    },
  };
}

/** Turn a thrown fetch/stream error into an envelope, distinguishing cancel from timeout. */
function thrownFailure(error, callerSignal, combinedSignal, method, path, token) {
  const cancelled = callerSignal?.aborted === true;
  const aborted = combinedSignal?.aborted === true
    || error?.name === 'AbortError'
    || error?.name === 'TimeoutError';
  if (aborted) {
    if (cancelled) {
      return compact({
        ok: false,
        code: 'aborted',
        error: 'the GitHub request was cancelled by the caller (' + method + ' ' + path + ')',
      });
    }
    return compact({
      ok: false,
      code: 'timeout',
      error: 'the GitHub request timed out (' + method + ' ' + path + ')',
    });
  }
  const described = 'the GitHub request failed (' + method + ' ' + path + '): '
    + String(error?.message ?? error);
  return compact({ ok: false, code: 'network', error: redact(described, token) });
}

/**
 * Send one request and normalise everything about it into an envelope.
 *
 * Guarantees: the token is resolved first and returned as `no-credentials`
 * without any request when it is missing; a caller-aborted signal short-circuits
 * before the request; every request carries `Authorization`, `Accept`,
 * `X-GitHub-Api-Version` and `User-Agent`; the response body text passes the
 * redactor before it is parsed, so no caller can be handed the token; a non-JSON
 * body never throws; and a non-2xx status is an envelope, not an exception.
 *
 * @param {object} ctx - the client context (host, base, timeoutMs, env, token).
 * @param {string} method - HTTP method.
 * @param {string} path - API path beginning with `/`.
 * @param {{body?: object, signal?: AbortSignal}} [options]
 * @returns {Promise<object>} `{ok: true, status, headers, data}` or a failure
 *   envelope. Never throws.
 */
async function send(ctx, method, path, options = {}) {
  const callerSignal = options.signal ?? undefined;
  const aborted = () => compact({
    ok: false,
    code: 'aborted',
    error: 'the GitHub request was cancelled before it was sent (' + method + ' ' + path + ')',
  });
  if (callerSignal !== undefined && callerSignal !== null && callerSignal.aborted === true) {
    return aborted();
  }

  const auth = await ctx.token();
  if (auth.ok !== true) return compact({ ok: false, code: auth.code, error: auth.error });

  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return refusal('unsupported', 'this runtime has no global fetch; Node 18 or newer is required');
  }

  let payload;
  if (options.body !== undefined) {
    try {
      payload = JSON.stringify(options.body);
    } catch (error) {
      return refusal('invalid-argument', 'the request body is not serialisable: ' + String(error?.message ?? error));
    }
  }

  const headers = {
    Authorization: 'Bearer ' + auth.token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'dsh-git',
  };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';

  const { signal, cleanup } = combineSignal(callerSignal, ctx.timeoutMs);
  let response;
  let text = '';
  let readError;
  try {
    response = await fetchImpl(ctx.base + path, { method, headers, body: payload, signal });
    try {
      text = await response.text();
    } catch (error) {
      readError = error;
    }
  } catch (error) {
    return thrownFailure(error, callerSignal, signal, method, path, auth.token);
  } finally {
    cleanup();
  }

  if (readError !== undefined) {
    return thrownFailure(readError, callerSignal, signal, method, path, auth.token);
  }

  const status = Number(response.status);
  const responseHeaders = response.headers;
  // Every body passes the redactor before parsing: `[redacted]` is valid JSON, so
  // the structure survives while the secret does not.
  const safeText = redact(text ?? '', auth.token);
  let data;
  let parseFailed = false;
  if (safeText.trim() !== '') {
    try {
      data = JSON.parse(safeText);
    } catch {
      parseFailed = true;
      data = undefined;
    }
  }

  if (status >= 200 && status < 300) {
    if (parseFailed) {
      return compact({
        ok: false,
        code: 'unexpected-response',
        status,
        message: truncate(safeText.trim(), 200),
        error: 'GitHub ' + method + ' ' + path + ' returned HTTP ' + status + ' with a body that is not JSON',
      });
    }
    return { ok: true, status, headers: responseHeaders, data };
  }

  const message = bodyMessage(data) ?? (data === undefined && safeText !== '' ? truncate(safeText.trim(), 200) : undefined);
  return apiFailure(codeForStatus(status, responseHeaders), method, path, status, message, bodyDetail(data), auth.token);
}

/**
 * Whether the configured credentials work, with the account they belong to.
 *
 * Memoized for the process per credential source, so a tool that asks before
 * every operation reads the Keychain once.
 *
 * @param {object} ctx - the client context.
 * @returns {Promise<{ok: boolean, login?: string, scopes?: string, error?: string,
 *   code?: string}>} `code` is `no-credentials` when the token chain came up
 *   empty (and no request is made), or the HTTP code of `GET /user`.
 */
async function runIsAvailable(ctx) {
  const key = tokenKey(ctx.env, ctx.host) + '|probe';
  if (availabilityProbe === undefined || availabilityProbe.key !== key) {
    const promise = (async () => {
      const auth = await ctx.token();
      if (auth.ok !== true) return compact({ ok: false, code: auth.code, error: auth.error });
      const response = await send(ctx, 'GET', '/user', {});
      if (response.ok !== true) {
        return compact({
          ok: false,
          code: response.code,
          status: response.status,
          message: response.message,
          error: response.error,
        });
      }
      // `x-oauth-scopes` is absent for a fine-grained token, and `login` is
      // always present on a 200 from /user; both are optional in the envelope.
      return compact({
        ok: true,
        login: isNonEmptyString(response.data?.login) ? response.data.login : undefined,
        scopes: headerValue(response.headers, 'x-oauth-scopes'),
      });
    })().catch((error) => compact({
      ok: false,
      code: 'network',
      error: redact('the GitHub availability probe failed: ' + String(error?.message ?? error)),
    }));
    availabilityProbe = { key, promise };
  }
  return availabilityProbe.promise;
}

/** The `/repos/{owner}/{repo}` prefix every operation shares. */
function repoPath(opts) {
  return '/repos/' + encodeURIComponent(opts.owner) + '/' + encodeURIComponent(opts.repo);
}

/**
 * The lookup `upsertPull` freezes: the open pull request whose head is the
 * branch, and nothing else. `head` alone is deliberate — a base filter here
 * would hide a pull request opened from this branch into another base, and the
 * caller can always narrow the search with `findPull`.
 */
function upsertQuery(opts) {
  return repoPath(opts) + '/pulls?head=' + encodeURIComponent(opts.owner + ':' + opts.head)
    + '&state=open&per_page=1';
}

/** `findPull`'s lookup: the same query, narrowed by base when the caller named one. */
function findQuery(opts, state) {
  return repoPath(opts) + '/pulls?head=' + encodeURIComponent(opts.owner + ':' + opts.head)
    + (isNonEmptyString(opts.base) ? '&base=' + encodeURIComponent(opts.base) : '')
    + '&state=' + encodeURIComponent(state)
    + '&per_page=1';
}

/** The compact pull request shape `upsertPull` reports. */
function pullSummary(data) {
  return compact({
    number: Number.isInteger(data?.number) ? data.number : undefined,
    url: isNonEmptyString(data?.html_url) ? data.html_url : undefined,
    state: isNonEmptyString(data?.state) ? data.state : undefined,
    draft: typeof data?.draft === 'boolean' ? data.draft : undefined,
  });
}

/** The fields a PATCH may carry: only what the caller actually supplied. */
function patchBody(opts) {
  const body = {};
  if (typeof opts.title === 'string') body.title = opts.title;
  if (typeof opts.body === 'string') body.body = opts.body;
  return Object.keys(body).length === 0 ? undefined : body;
}

/** The create payload; `draft` is sent only when the caller stated it. */
function createBody(opts) {
  const body = {
    title: opts.title,
    head: opts.head,
    base: opts.base,
    body: typeof opts.body === 'string' ? opts.body : '',
  };
  if (typeof opts.draft === 'boolean') body.draft = opts.draft;
  return body;
}

/**
 * Create the pull request for a head branch, or update and return the open one.
 *
 * Idempotent by construction: the open pull request for the head branch is
 * looked up first, so a second call with the same branches updates the title and
 * body of the existing one instead of failing. Nothing is decided by matching
 * error prose — a 422 from the create is answered by re-querying, which covers a
 * concurrent create without parsing a word of the message.
 *
 * @param {object} ctx - the client context.
 * @param {{owner: string, repo: string, head: string, base: string, title?: string,
 *   body?: string, draft?: boolean, ahead?: number, signal?: AbortSignal}} opts
 *   `ahead` is the caller's own `aheadOf` result. `ahead: 0` is answered before
 *   any request is made — this module never reads a repository, so the caller
 *   supplies the fact, and the API's 422 is the fallback for when it does not.
 * @returns {Promise<{ok: boolean, created?: boolean, number?: number, url?: string,
 *   state?: string, draft?: boolean, error?: string, code?: string}>}
 *   `code` is `same-branch` when head and base are the same branch (no request is
 *   made), `no-commits-between` when the caller passed `ahead: 0` or the create
 *   was rejected while no pull request exists, `no-credentials` when no token
 *   could be found, `invalid-argument` for a missing field, or the mapped HTTP
 *   code.
 */
async function runUpsertPull(ctx, opts) {
  const invalid = requireText(opts, ['owner', 'repo', 'head', 'base']);
  if (invalid !== undefined) return invalid;
  // Short-circuit before anything is sent: a pull request between one branch and
  // itself cannot exist, and the API's answer to the attempt is not worth a round
  // trip.
  if (opts.head === opts.base) {
    return refusal('same-branch', 'head and base are the same branch (' + opts.head
      + '); a pull request needs two different branches');
  }
  // The caller owns `aheadOf` — this module never reads a repository — so when it
  // hands the fact in, `ahead: 0` is answered here instead of by the API. The 422
  // mapping further down is the fallback for a caller that did not look.
  if (opts.ahead === 0) {
    return refusal('no-commits-between', 'there are no commits between ' + opts.base
      + ' and ' + opts.head + '; there is nothing to open a pull request for');
  }

  const list = upsertQuery(opts);
  const found = await send(ctx, 'GET', list, { signal: opts.signal });
  if (found.ok !== true) return found;
  if (!Array.isArray(found.data)) {
    return compact({
      ok: false,
      code: 'unexpected-response',
      status: found.status,
      error: 'GitHub GET ' + list + ' returned HTTP ' + found.status + ' with a body that is not a list of pull requests',
    });
  }

  if (found.data.length > 0) {
    const existing = found.data[0];
    if (!Number.isInteger(existing?.number)) {
      return compact({
        ok: false,
        code: 'unexpected-response',
        status: found.status,
        error: 'the existing pull request in the list response has no number',
      });
    }
    const patch = patchBody(opts);
    if (patch !== undefined) {
      const updated = await send(ctx, 'PATCH', repoPath(opts) + '/pulls/' + existing.number, {
        body: patch,
        signal: opts.signal,
      });
      if (updated.ok !== true) return updated;
      return compact({ ok: true, created: false, ...pullSummary(updated.data ?? existing) });
    }
    return compact({ ok: true, created: false, ...pullSummary(existing) });
  }

  // The pull request does not exist yet, so this is the only path that needs a
  // title — the API demands one to open a pull request.
  if (!isNonEmptyString(opts.title)) {
    return refusal('invalid-argument', 'title must be a non-empty string to open a pull request (got '
      + describeValue(opts.title) + ')');
  }

  const created = await send(ctx, 'POST', repoPath(opts) + '/pulls', {
    body: createBody(opts),
    signal: opts.signal,
  });
  if (created.ok === true) {
    return compact({ ok: true, created: true, ...pullSummary(created.data) });
  }
  if (created.status === 422) {
    // Status only, never prose: 422 on this endpoint is either "a pull request
    // already exists" (a concurrent create) or "no commits between". Re-querying
    // separates them by fact rather than by wording, and a pull request that now
    // exists is the answer either way.
    const again = await send(ctx, 'GET', list, { signal: opts.signal });
    if (again.ok === true && Array.isArray(again.data) && again.data.length > 0) {
      return compact({ ok: true, created: false, ...pullSummary(again.data[0]) });
    }
    return compact({
      ok: false,
      code: 'no-commits-between',
      status: created.status,
      message: created.message,
      detail: created.detail,
      error: created.error + ' (nothing was created; check that '
        + opts.head + ' is ahead of ' + opts.base + ')',
    });
  }
  return created;
}

/**
 * Find the pull request for a head branch.
 *
 * @param {object} ctx - the client context.
 * @param {{owner: string, repo: string, head: string, base?: string,
 *   state?: 'open'|'closed'|'all', signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, pull?: object, error?: string, code?: string}>}
 *   `ok: true` with no `pull` means the query succeeded and nothing matched; the
 *   `pull` is the API's own object, not a projection, so a caller can read
 *   `head.sha` or `mergeable_state` from it. Failure codes are the mapped HTTP
 *   codes, or `no-credentials`/`invalid-argument` when nothing was sent.
 */
async function runFindPull(ctx, opts) {
  const invalid = requireText(opts, ['owner', 'repo', 'head']);
  if (invalid !== undefined) return invalid;
  const state = isNonEmptyString(opts.state) ? opts.state : 'open';
  const path = findQuery(opts, state);
  const found = await send(ctx, 'GET', path, { signal: opts.signal });
  if (found.ok !== true) return found;
  if (!Array.isArray(found.data)) {
    return compact({
      ok: false,
      code: 'unexpected-response',
      status: found.status,
      error: 'GitHub GET ' + path + ' returned HTTP ' + found.status + ' with a body that is not a list of pull requests',
    });
  }
  return compact({ ok: true, pull: found.data[0] ?? undefined });
}

/**
 * Whether a pull request from this branch was merged.
 *
 * This is the only sound proof that a task branch's work reached the base when the
 * merge was a squash. Squash rewrites the commits, so the branch is not an ancestor of
 * the base, and every local test — ancestry, tree equality, patch identity — either
 * fails or would be a guess. Deleting a branch is precisely the decision that must not
 * be guessed at.
 *
 * @param {object} ctx - the client context.
 * @param {{owner: string, repo: string, head: string, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, merged?: boolean, number?: number, url?: string,
 *   error?: string, code?: string}>} `merged: false` with `ok: true` means no merged
 *   pull request was found — which is not evidence that the branch is unmerged, only
 *   that this question could not prove that it is.
 */
async function runFindMergedPull(ctx, opts) {
  const invalid = requireText(opts, ['owner', 'repo', 'head']);
  if (invalid !== undefined) return invalid;

  // `state=closed` is the API's word for "not open", and a merged pull request is
  // closed. There is no `merged` filter to ask for directly, so the list is scanned
  // for a `merged_at`, which the API sets only when the merge happened.
  const path = repoPath(opts) + '/pulls?head=' + encodeURIComponent(opts.owner + ':' + opts.head)
    + '&state=closed&per_page=20';
  const found = await send(ctx, 'GET', path, { signal: opts.signal });
  if (found.ok !== true) return found;
  if (!Array.isArray(found.data)) {
    return compact({
      ok: false,
      code: 'unexpected-response',
      status: found.status,
      error: 'GitHub GET ' + path + ' returned HTTP ' + found.status + ' with a body that is not a list of pull requests',
    });
  }

  const merged = found.data.find((entry) => entry?.merged_at !== null && entry?.merged_at !== undefined);
  if (merged === undefined) return { ok: true, merged: false };
  return compact({
    ok: true,
    merged: true,
    number: Number.isInteger(merged.number) ? merged.number : undefined,
    url: isNonEmptyString(merged.html_url) ? merged.html_url : undefined,
  });
}

/**
 * Read one pull request as a compact summary.
 *
 * @param {object} ctx - the client context.
 * @param {{owner: string, repo: string, number: number, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, pull?: {number?: number, url?: string, state?: string,
 *   mergeable?: boolean, mergeStateStatus?: string, merged?: boolean, title?: string,
 *   head?: string, base?: string}, error?: string, code?: string}>}
 *   `head` and `base` are branch names. `mergeable` is absent while GitHub is
 *   still computing it (the API sends null), so a caller must treat it as
 *   unknown rather than false. Failures carry the mapped HTTP code.
 */
async function runViewPull(ctx, opts) {
  const invalid = requireText(opts, ['owner', 'repo']) ?? requireNumber(opts);
  if (invalid !== undefined) return invalid;
  const path = repoPath(opts) + '/pulls/' + opts.number;
  const response = await send(ctx, 'GET', path, { signal: opts.signal });
  if (response.ok !== true) return response;
  const data = response.data;
  if (data === null || typeof data !== 'object') {
    return compact({
      ok: false,
      code: 'unexpected-response',
      status: response.status,
      error: 'GitHub GET ' + path + ' returned HTTP ' + response.status + ' with a body that is not a pull request',
    });
  }
  return compact({
    ok: true,
    pull: compact({
      number: Number.isInteger(data.number) ? data.number : undefined,
      url: isNonEmptyString(data.html_url) ? data.html_url : undefined,
      state: isNonEmptyString(data.state) ? data.state : undefined,
      mergeable: typeof data.mergeable === 'boolean' ? data.mergeable : undefined,
      mergeStateStatus: isNonEmptyString(data.mergeable_state) ? data.mergeable_state : undefined,
      merged: typeof data.merged === 'boolean' ? data.merged : undefined,
      title: typeof data.title === 'string' ? data.title : undefined,
      head: isNonEmptyString(data.head?.ref) ? data.head.ref : undefined,
      base: isNonEmptyString(data.base?.ref) ? data.base.ref : undefined,
    }),
  });
}

/**
 * Merge a pull request.
 *
 * @param {object} ctx - the client context.
 * @param {{owner: string, repo: string, number: number,
 *   method: 'squash'|'merge'|'rebase', signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, merged?: boolean, sha?: string, error?: string,
 *   code?: string}>} `code` is `not-mergeable` for a 405 (conflicts, a required
 *   review, a blocked check), `head-changed` for a 409 (the branch moved under
 *   the merge), `not-open` for a 404 — the pull request is already merged or
 *   closed, which is not a failure worth retrying. `invalid-argument` for a
 *   missing field or an unknown method, `no-credentials` when nothing was sent.
 */
async function runMergePull(ctx, opts) {
  const invalid = requireText(opts, ['owner', 'repo']) ?? requireNumber(opts);
  if (invalid !== undefined) return invalid;
  if (!MERGE_METHODS.has(opts.method)) {
    return refusal('invalid-argument', 'method must be one of squash, merge, rebase (got '
      + describeValue(opts.method) + ')');
  }
  const path = repoPath(opts) + '/pulls/' + opts.number + '/merge';
  const response = await send(ctx, 'PUT', path, {
    body: { merge_method: opts.method },
    signal: opts.signal,
  });

  if (response.ok === true) {
    // GitHub answers 200 with the merge commit. A 200 that says merged:false is
    // reported as a failure rather than as a merge that did not happen.
    if (response.data?.merged === true) {
      return compact({
        ok: true,
        merged: true,
        sha: isNonEmptyString(response.data.sha) ? response.data.sha : undefined,
      });
    }
    return compact({
      ok: false,
      merged: false,
      code: 'not-mergeable',
      status: response.status,
      message: bodyMessage(response.data),
      error: 'GitHub PUT ' + path + ' answered HTTP ' + response.status + ' without merging',
    });
  }

  if (response.status === 405) {
    return compact({ ...response, code: 'not-mergeable' });
  }
  if (response.status === 409) {
    return compact({ ...response, code: 'head-changed' });
  }
  if (response.status === 404) {
    // The contract's reading of a 404 here: nothing to merge, because the pull
    // request is already merged or closed. That is a state, not a retry.
    return compact({ ...response, code: 'not-open' });
  }
  return response;
}

/**
 * Delete a branch on the remote.
 *
 * The REST call names the repository explicitly, which is the whole reason this
 * module does not use `gh pr merge --delete-branch` (cli/cli#14537: that flag
 * deletes by branch name in the current directory's repository).
 *
 * @param {object} ctx - the client context.
 * @param {{owner: string, repo: string, branch: string, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, deleted?: boolean, error?: string, code?: string}>}
 *   `deleted: false` with `ok: true` means the branch was already gone (a 422
 *   "reference does not exist" is success — the caller's goal already holds).
 *   Other failures carry the mapped HTTP code.
 */
async function runDeleteRemoteBranch(ctx, opts) {
  const invalid = requireText(opts, ['owner', 'repo', 'branch']);
  if (invalid !== undefined) return invalid;

  // A branch name is a ref path, so its slashes stay structural and each segment
  // is encoded on its own; `feature/x` must not become `feature%2Fx`.
  const segments = opts.branch.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return refusal('invalid-argument', 'branch is not a usable ref name (' + describeValue(opts.branch) + ')');
  }
  const ref = segments.map((segment) => encodeURIComponent(segment)).join('/');

  const path = repoPath(opts) + '/git/refs/heads/' + ref;
  const response = await send(ctx, 'DELETE', path, { signal: opts.signal });
  if (response.ok === true) return { ok: true, deleted: true };
  // Status only: 422 on this endpoint is "reference does not exist", and a branch
  // that is already absent is the state the caller asked for. Retrying a delete
  // must never turn into an error.
  if (response.status === 422) return { ok: true, deleted: false };
  return response;
}

/**
 * The repository's default branch.
 *
 * @param {object} ctx - the client context.
 * @param {{owner: string, repo: string, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, branch?: string, error?: string, code?: string}>}
 *   `code` is `not-found` for a missing repository and `unexpected-response` when
 *   a 200 carries no `default_branch`.
 */
async function runGetDefaultBranch(ctx, opts) {
  const invalid = requireText(opts, ['owner', 'repo']);
  if (invalid !== undefined) return invalid;
  const path = repoPath(opts);
  const response = await send(ctx, 'GET', path, { signal: opts.signal });
  if (response.ok !== true) return response;
  if (!isNonEmptyString(response.data?.default_branch)) {
    return compact({
      ok: false,
      code: 'unexpected-response',
      status: response.status,
      error: 'GitHub GET ' + path + ' returned HTTP ' + response.status + ' without a default_branch',
    });
  }
  return { ok: true, branch: response.data.default_branch };
}

/**
 * Build a GitHub REST client for one host.
 *
 * The token is not read here: it is resolved on the first call that needs it, so
 * constructing a client never touches the Keychain and never fails. Every method
 * returns an envelope and never throws, and every method that needs credentials
 * returns `{ok: false, code: 'no-credentials'}` without making a request when the
 * chain (`GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`) comes up empty.
 *
 * @param {{host?: string, timeoutMs?: number, env?: object}} [config]
 *   `host` is the web host a remote URL names (`github.com`, or a GitHub
 *   Enterprise Server host — the REST base URL is derived from it). `timeoutMs`
 *   bounds each request. `env` is layered over `process.env`, so a caller can
 *   mask one key with `undefined`; it is the environment the `gh` fallback runs
 *   with, and that is what makes the chain testable without a live account.
 * @returns {{
 *   isAvailable: () => Promise<object>,
 *   upsertPull: (opts: object) => Promise<object>,
 *   findPull: (opts: object) => Promise<object>,
 *   findMergedPull: (opts: object) => Promise<object>,
 *   viewPull: (opts: object) => Promise<object>,
 *   mergePull: (opts: object) => Promise<object>,
 *   deleteRemoteBranch: (opts: object) => Promise<object>,
 *   listRemoteBranches: (opts: object) => Promise<object>,
 *   getDefaultBranch: (opts: object) => Promise<object>,
 * }} the client. All methods return envelopes; none throws.
 */
/**
 * The remote branches under a prefix.
 *
 * Asked of the API rather than git ls-remote so every question prune puts to the
 * remote travels the same authenticated path -- and so that a branch with no
 * local ref, which is the case this exists for, can be seen at all.
 *
 * @param {object} ctx - the client context.
 * @param {{owner: string, repo: string, prefix?: string, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, branches?: string[], error?: string, code?: string}>}
 *   branch names without the refs/heads/ prefix.
 */
async function runListRemoteBranches(ctx, opts) {
  const invalid = requireText(opts, ['owner', 'repo']);
  if (invalid !== undefined) return invalid;

  const prefix = isNonEmptyString(opts.prefix) ? opts.prefix : '';
  const ref = prefix.split('/').filter((segment) => segment !== '').map((segment) => encodeURIComponent(segment)).join('/');
  const path = repoPath(opts) + '/git/matching-refs/heads/' + ref;
  const response = await send(ctx, 'GET', path, { signal: opts.signal });
  if (response.ok !== true) return response;
  if (!Array.isArray(response.data)) {
    return compact({
      ok: false,
      code: 'unexpected-response',
      status: response.status,
      error: 'GitHub GET ' + path + ' returned HTTP ' + response.status + ' with a body that is not a list of refs',
    });
  }

  const branches = [];
  for (const entry of response.data) {
    const name = typeof entry?.ref === 'string' ? entry.ref : '';
    if (!name.startsWith('refs/heads/')) continue;
    branches.push(name.slice('refs/heads/'.length));
  }
  return { ok: true, branches };
}

export function createGithubClient(config) {
  const options = config !== null && typeof config === 'object' ? config : {};
  const host = normalizeHost(options.host) ?? 'github.com';
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const env = options.env !== null && typeof options.env === 'object'
    ? { ...process.env, ...options.env }
    : process.env;

  const ctx = {
    host,
    base: apiBase(host),
    timeoutMs,
    env,
    // Lazy and memoized: the first call that needs a token resolves it once for
    // the process, and nothing here is ever written down.
    token: () => resolveTokenOnce(env, host),
  };

  // Each method is the documented implementation above, bound to this client's
  // host, timeout and environment; the envelope shapes are documented there.
  return {
    /** @see runIsAvailable — whether these credentials work, and whose they are. */
    isAvailable: () => runIsAvailable(ctx),
    /** @see runUpsertPull — idempotent create-or-update of the head branch's pull request. */
    upsertPull: (opts) => runUpsertPull(ctx, opts),
    /** @see runFindPull — the pull request for a head branch, if one matches. */
    findPull: (opts) => runFindPull(ctx, opts),
    /** @see runFindMergedPull — whether a pull request from this branch was merged. */
    findMergedPull: (opts) => runFindMergedPull(ctx, opts),
    /** @see runViewPull — one pull request as a compact summary. */
    viewPull: (opts) => runViewPull(ctx, opts),
    /** @see runMergePull — merge, with 405/409/404 told apart by code. */
    mergePull: (opts) => runMergePull(ctx, opts),
    /** @see runDeleteRemoteBranch — delete a remote branch by explicit owner and repo. */
    deleteRemoteBranch: (opts) => runDeleteRemoteBranch(ctx, opts),
    /** @see runListRemoteBranches — the remote branches under a prefix. */
    listRemoteBranches: (opts) => runListRemoteBranches(ctx, opts),
    /** @see runGetDefaultBranch — the repository's default branch. */
    getDefaultBranch: (opts) => runGetDefaultBranch(ctx, opts),
  };
}
