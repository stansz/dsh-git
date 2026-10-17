/**
 * Test support: real repositories, and a GitHub API stand-in.
 *
 * Two rules shape this file, and both exist to keep the tests honest:
 *
 *   - Fixtures are built with the real 'git' command, never with the code under
 *     test. A test that arranges its repository through the functions it is
 *     testing can pass while the product is wrong.
 *
 *   - GitHub is stood in for at the HTTP boundary — globalThis.fetch — and the
 *     stand-in performs the merge for real, in the bare origin repository. So
 *     "open a pull request, merge it, prune the branch" is exercised end to end
 *     with actual git refs moving, not with canned JSON. The plugin's own push,
 *     fetch and ls-remote calls reach the same bare repository through a
 *     url.<path>.insteadOf rewrite, so the remote URL is a real github.com URL
 *     while nothing touches the network.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The dsh-git checkout these tests belong to. */
export const REPO_ROOT = resolve(import.meta.dirname, '..');
/** The workspace directory that holds the three repositories side by side. */
export const WORKSPACE = resolve(REPO_ROOT, '..');

/* ------------------------------------------------------------------ */
/* Temporary directories                                               */
/* ------------------------------------------------------------------ */

const TEMPS = [];
let cleaned = false;

/** A real, unique, resolved temporary directory. Removed at process exit. */
export function tempDir(prefix = 'dsh-git-test-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TEMPS.push(dir);
  return dir;
}

/** Remove every temporary directory this process made. Safe to call twice. */
export function cleanupTemps() {
  if (cleaned) return;
  cleaned = true;
  for (const dir of [...TEMPS].reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a checkout with an open lock can survive one attempt; rm -rf at exit is best effort */
    }
  }
}

process.on('exit', cleanupTemps);

/* ------------------------------------------------------------------ */
/* Raw git                                                             */
/* ------------------------------------------------------------------ */

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

/** Run git, returning the result instead of throwing. */
export function git(cwd, args, options = {}) {
  try {
    const stdout = execFileSync('git', args.map(String), {
      cwd,
      encoding: 'utf8',
      env: { ...GIT_ENV, ...(options.env ?? {}) },
      timeout: options.timeoutMs ?? 30000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.status === 'number' ? error.status : null,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? '').trim() || String(error?.message ?? error),
    };
  }
}

/** Run git and throw with git's own words on failure. For arrangement and assertions. */
export function gitOk(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (!result.ok) {
    throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ':' + EOL + result.stderr);
  }
  return result.stdout.trim();
}

/** The current branch name, or undefined for a detached HEAD. */
export function currentBranch(cwd) {
  const result = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.ok && result.stdout.trim() !== '' ? result.stdout.trim() : undefined;
}

/** The commit a ref points at. */
export function shaOf(cwd, ref = 'HEAD') {
  return gitOk(cwd, ['rev-parse', '--verify', ref + '^{commit}']);
}

/** Every local branch name. */
export function branches(cwd) {
  const out = gitOk(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return out === '' ? [] : out.split(EOL);
}

/** Whether a local branch exists. */
export function hasBranch(cwd, name) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name]).ok;
}

/** The subject of the newest commit. */
export function lastSubject(cwd) {
  return gitOk(cwd, ['log', '-1', '--format=%s']);
}

/** Stage everything and commit. For arrangement only. */
export function commitAll(cwd, message = 'fixture change') {
  gitOk(cwd, ['add', '-A']);
  gitOk(cwd, ['commit', '--quiet', '-m', message]);
  return shaOf(cwd);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const USER = { name: 'DSH Git Tests', email: 'dsh-git-tests@example.invalid' };

function configIdentity(dir) {
  gitOk(dir, ['config', 'user.name', USER.name]);
  gitOk(dir, ['config', 'user.email', USER.email]);
  gitOk(dir, ['config', 'commit.gpgsign', 'false']);
  gitOk(dir, ['config', 'tag.gpgsign', 'false']);
  gitOk(dir, ['config', 'init.defaultBranch', 'main']);
}

/** Create a repository with one commit on the named branch. */
export function initRepo(dir, options = {}) {
  const branch = options.branch ?? 'main';
  mkdirSync(dir, { recursive: true });
  gitOk(dir, ['init', '--quiet', '-b', branch]);
  configIdentity(dir);
  if (options.seed !== false) {
    writeFileSync(join(dir, 'README.md'), '# ' + (options.title ?? 'fixture') + EOL);
    commitAll(dir, 'initial commit');
  }
  return dir;
}

/**
 * A working clone with a real bare origin it can push to and fetch from.
 *
 * 'work' is the clone the plugin operates on; 'bare' is what origin points at
 * for plain-git fixtures. 'seed' is the repository that made the first commit.
 */
export function fixture(options = {}) {
  const parent = tempDir('dsh-git-fixture-');
  const bare = join(parent, 'origin.git');
  mkdirSync(bare, { recursive: true });
  gitOk(parent, ['init', '--quiet', '--bare', '-b', 'main', bare]);

  const seed = join(parent, 'seed');
  initRepo(seed, { branch: 'main', title: options.title ?? 'fixture' });
  gitOk(seed, ['remote', 'add', 'origin', bare]);
  gitOk(seed, ['push', '--quiet', '-u', 'origin', 'main']);

  const work = join(parent, 'work');
  gitOk(parent, ['clone', '--quiet', bare, work]);
  configIdentity(work);

  return { parent, bare, seed, work };
}

let fixtureCounter = 0;

/**
 * A fixture whose origin is a real github.com URL.
 *
 * The URL is rewritten to the bare repository with url.<bare>.insteadOf, so
 * 'git push origin', 'git fetch origin' and 'git ls-remote origin' all travel
 * through git's real transport layer to a local directory, while the plugin
 * sees the github.com remote it needs in order to talk to its API client.
 */
export function githubFixture(options = {}) {
  const base = fixture(options);
  fixtureCounter += 1;
  const owner = options.owner ?? 'dsh-test';
  const repo = options.repo ?? 'fixture-' + String(fixtureCounter);
  const host = options.host ?? 'github.com';
  const url = 'https://' + host + '/' + owner + '/' + repo + '.git';

  gitOk(base.work, ['remote', 'set-url', 'origin', url]);
  gitOk(base.work, ['config', 'url.' + base.bare + '.insteadOf', url]);

  return { ...base, owner, repo, host, url };
}

/** A second clone of the same bare origin: "somebody else", or a branch checkout. */
export function cloneOf(fixtureValue, name = 'other') {
  const dir = join(fixtureValue.parent, name);
  gitOk(fixtureValue.parent, ['clone', '--quiet', fixtureValue.bare, dir]);
  configIdentity(dir);
  return dir;
}

/* ------------------------------------------------------------------ */
/* Files and expectations                                              */
/* ------------------------------------------------------------------ */

/** Write files into a repository. Keys are repository-relative paths. */
export function writeFiles(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/** Read a repository-relative file. */
export function readRepoFile(repo, path) {
  return readFileSync(join(repo, path), 'utf8');
}

/** Whether a repository-relative path exists. */
export function repoHas(repo, path) {
  return existsSync(join(repo, path));
}

/* ------------------------------------------------------------------ */
/* The plugin under test                                               */
/* ------------------------------------------------------------------ */

/**
 * A raw configuration object for one test.
 *
 * Every path that could write outside the test's own temporary tree is pinned
 * here: stateRoot is what keeps a test from touching the live ~/.dsh/state
 * directory the running Harness uses.
 */
export function config(overrides = {}) {
  return {
    stateRoot: tempDir('dsh-git-state-'),
    timeoutMs: 30000,
    turnSyncTimeoutMs: 15000,
    ...overrides,
  };
}

/** A fresh session id, so state written by one test can never reach another. */
let sessionCounter = 0;
export function sessionId(prefix = 'test-session') {
  sessionCounter += 1;
  return prefix + '-' + String(sessionCounter);
}

/**
 * Run one tool action exactly as the tool runs it.
 *
 * runAction is the same entry point the registered tool calls, so the action
 * receives the same shape: config, reference directory and session id.
 */
export async function action(name, args, options = {}) {
  const { runAction } = await import('../lib/actions.mjs');
  return await runAction(name, args, {
    config: options.config ?? config(),
    reference: options.reference,
    sessionId: options.sessionId ?? sessionId(),
    signal: options.signal,
  });
}

/** A resolved config for assertions, using the same defaults the plugin resolves. */
export async function resolved(overrides = {}) {
  const { resolveConfig } = await import('../lib/config.mjs');
  return resolveConfig(overrides);
}

/** Record a file as changed by a session, the way the file tools do. */
export async function recordChange(repo, path, options = {}) {
  const { record } = await import('../lib/session-files.mjs');
  const { toplevel } = await import('../lib/git.mjs');
  const absolute = resolve(repo, path);
  const root = (await toplevel(absolute)) ?? repo;
  return record(options.sessionId ?? sessionId(), root, absolute, {
    stateRoot: options.stateRoot,
  });
}

/* ------------------------------------------------------------------ */
/* The GitHub stand-in                                                 */
/* ------------------------------------------------------------------ */

const TOKEN = 'test-token';

// The stand-in only answers to this token, and the client resolves a token
// lazily from the environment. Pinning it here keeps every GitHub test off the
// machine's real login — and, in CI, off the GITHUB_TOKEN the runner sets.
process.env.GH_TOKEN = TOKEN;

/**
 * Install a GitHub REST API stand-in for one test.
 *
 * Only the routes the plugin uses are implemented, and each is answered from
 * the state of a real bare repository:
 *
 *   GET    /user
 *   GET    /repos/:owner/:repo
 *   GET    /repos/:owner/:repo/pulls
 *   POST   /repos/:owner/:repo/pulls
 *   GET    /repos/:owner/:repo/pulls/:number
 *   PATCH  /repos/:owner/:repo/pulls/:number
 *   PUT    /repos/:owner/:repo/pulls/:number/merge     (merges a real branch)
 *   DELETE /repos/:owner/:repo/git/refs/heads/:branch  (deletes a real ref)
 *   GET    /repos/:owner/:repo/git/matching-refs/heads/:prefix
 *
 * Returns the stand-in plus a restore function. globalThis.fetch is put back
 * when the test ends, so one test's fake can never leak into another's.
 */
export function githubServer(options = {}) {
  const token = options.token ?? TOKEN;
  const login = options.login ?? 'dsh-test-user';
  const repos = new Map();
  for (const entry of options.repos ?? []) {
    repos.set(entry.owner + '/' + entry.repo, {
      owner: entry.owner,
      repo: entry.repo,
      dir: entry.dir,
      host: entry.host ?? 'github.com',
      defaultBranch: entry.defaultBranch ?? 'main',
    });
  }

  const pulls = [];
  const calls = [];
  const forced = [];

  const previousFetch = globalThis.fetch;
  const restore = () => {
    globalThis.fetch = previousFetch;
  };

  const json = (status, body, headers = {}) => new Response(
    body === undefined ? null : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );

  const run = (cwd, args) => {
    try {
      return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim() };
    } catch (error) {
      return { ok: false, out: String(error?.stdout ?? '').trim(), err: String(error?.stderr ?? error).trim() };
    }
  };

  const refSha = (repo, branch) => {
    const result = run(repo.dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]);
    return result.ok && /^[0-9a-f]{40,64}$/u.test(result.out) ? result.out : undefined;
  };

  const repoFor = (owner, name) => repos.get(owner + '/' + name);

  /** One pull request in the shape the REST API returns. */
  const pullShape = (pull) => {
    const repo = repos.get(pull.owner + '/' + pull.repo);
    // An open pull request reports the branch's current tip; a merged one keeps
    // the commit that was merged, exactly like the API does after the branch is gone.
    const live = repo !== undefined && pull.state === 'open' ? refSha(repo, pull.head) : undefined;
    return {
      number: pull.number,
      html_url: pull.html_url,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      draft: pull.draft,
      merged_at: pull.merged_at ?? null,
      merge_commit_sha: pull.merge_commit_sha ?? null,
      merged: pull.merged_at !== undefined && pull.merged_at !== null,
      mergeable: pull.merged_at == null,
      mergeable_state: pull.merged_at == null ? 'clean' : 'unknown',
      head: { ref: pull.head, sha: live ?? pull.headSha, label: pull.owner + ':' + pull.head },
      base: { ref: pull.base },
    };
  };

  const pullFor = (repo, number) => pulls.find((pull) => pull.owner === repo.owner
    && pull.repo === repo.repo && pull.number === number);

  /** Perform the merge for real in a scratch clone, then push the base back. */
  const mergeForReal = (repo, pull) => {
    const scratch = join(tempDir('dsh-gh-merge-'), 'clone');
    const result = run(process.cwd(), ['clone', '--quiet', repo.dir, scratch]);
    if (!result.ok) return { ok: false, error: 'clone failed: ' + result.err };
    const fetched = run(scratch, ['fetch', '--quiet', 'origin', '+refs/heads/' + pull.head + ':refs/remotes/origin/' + pull.head]);
    if (!fetched.ok) return { ok: false, error: 'the head branch is missing: ' + fetched.err };
    const merged = run(scratch, [
      '-c', 'user.name=' + USER.name,
      '-c', 'user.email=' + USER.email,
      'merge', '--no-ff', '--quiet',
      '-m', 'Merge pull request #' + pull.number + ' from ' + pull.owner + '/' + pull.head,
      'origin/' + pull.head,
    ]);
    if (!merged.ok) return { ok: false, error: merged.err, conflict: true };
    const pushed = run(scratch, ['push', '--quiet', 'origin', 'HEAD:refs/heads/' + repo.defaultBranch]);
    if (!pushed.ok) return { ok: false, error: pushed.err };
    const sha = run(scratch, ['rev-parse', 'HEAD']);
    return { ok: true, sha: sha.out };
  };

  async function handle(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const call = {
      method,
      path: url.pathname + url.search,
      authorization: headers.get('authorization'),
      accept: headers.get('accept'),
      body: typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    // Authentication first: a route that answered without a token would hide a
    // regression in how the plugin attaches credentials.
    if (call.authorization !== 'Bearer ' + token) {
      return json(401, { message: 'Bad credentials' });
    }

    // A test can force one failure to exercise the error mapping.
    const hit = forced.findIndex((entry) => entry.method === method && url.pathname.startsWith(entry.pathPrefix));
    if (hit !== -1) {
      const entry = forced.splice(hit, 1)[0];
      return json(entry.status, entry.body ?? { message: entry.message ?? 'forced failure' });
    }

    const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
    if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
      return json(200, { login, name: 'DSH Git Tests', type: 'User' }, { 'x-oauth-scopes': 'repo' });
    }

    if (segments[0] !== 'repos') return json(404, { message: 'Not Found' });
    const repo = repoFor(segments[1], segments[2]);
    if (repo === undefined) return json(404, { message: 'Not Found' });
    const rest = segments.slice(3);

    // GET /repos/:owner/:repo
    if (method === 'GET' && rest.length === 0) {
      return json(200, {
        full_name: repo.owner + '/' + repo.repo,
        default_branch: repo.defaultBranch,
        private: false,
      });
    }

    // .../pulls
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const head = url.searchParams.get('head');
        const base = url.searchParams.get('base');
        const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
        const branch = head === null ? undefined : head.slice(head.indexOf(':') + 1);
        const list = pulls
          .filter((pull) => pull.owner === repo.owner && pull.repo === repo.repo)
          .filter((pull) => state === 'all' || pull.state === state)
          .filter((pull) => branch === undefined || pull.head === branch)
          .filter((pull) => base === null || pull.base === base)
          .sort((a, b) => b.number - a.number)
          .slice(0, Number.isFinite(perPage) ? perPage : 30)
          .map(pullShape);
        return json(200, list);
      }
      if (method === 'POST') {
        const body = call.body ?? {};
        if (typeof body.title !== 'string' || body.title.trim() === ''
          || typeof body.head !== 'string' || typeof body.base !== 'string') {
          return json(422, { message: 'Validation Failed', errors: [{ message: 'missing title, head or base' }] });
        }
        if (body.head === body.base) {
          return json(422, { message: 'Validation Failed', errors: [{ message: 'head and base are the same branch' }] });
        }
        const headSha = refSha(repo, body.head);
        if (headSha === undefined) {
          return json(422, { message: 'Validation Failed', errors: [{ message: 'No commits between ' + body.base + ' and ' + body.head }] });
        }
        const baseSha = refSha(repo, body.base);
        if (baseSha === undefined) return json(422, { message: 'Validation Failed', errors: [{ message: 'base branch not found' }] });
        if (headSha === baseSha) {
          return json(422, { message: 'Validation Failed', errors: [{ message: 'No commits between ' + body.base + ' and ' + body.head }] });
        }
        const existing = pulls.find((pull) => pull.owner === repo.owner && pull.repo === repo.repo
          && pull.state === 'open' && pull.head === body.head && pull.base === body.base);
        if (existing !== undefined) {
          return json(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for ' + body.head }] });
        }
        const number = pulls.reduce((max, pull) => Math.max(max, pull.number), 0) + 1;
        const pull = {
          owner: repo.owner,
          repo: repo.repo,
          number,
          html_url: 'https://' + repo.host + '/' + repo.owner + '/' + repo.repo + '/pull/' + String(number),
          title: body.title,
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          draft: body.draft === true,
          head: body.head,
          base: body.base,
          headSha,
        };
        pulls.push(pull);
        return json(201, pullShape(pull));
      }
    }

    // .../pulls/:number and .../pulls/:number/merge
    if (rest.length >= 2 && rest[0] === 'pulls' && /^[0-9]+$/u.test(rest[1])) {
      const pull = pullFor(repo, Number.parseInt(rest[1], 10));
      if (pull === undefined) return json(404, { message: 'Not Found' });
      if (method === 'GET' && rest.length === 2) return json(200, pullShape(pull));
      if (method === 'PATCH' && rest.length === 2) {
        const body = call.body ?? {};
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        return json(200, pullShape(pull));
      }
      if (method === 'PUT' && rest.length === 3 && rest[2] === 'merge') {
        if (pull.merged_at != null || pull.state !== 'open') {
          return json(405, { message: 'Pull Request is not mergeable' });
        }
        const merged = mergeForReal(repo, pull);
        if (merged.ok !== true) {
          return json(405, { message: 'Pull Request is not mergeable: ' + merged.error });
        }
        pull.state = 'closed';
        pull.merged_at = new Date().toISOString();
        pull.merge_commit_sha = merged.sha;
        pull.headSha = refSha(repo, pull.head) ?? pull.headSha;
        return json(200, { merged: true, sha: merged.sha, message: 'Pull Request successfully merged' });
      }
    }

    // .../git/refs/heads/:branch
    if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length > 3) {
      const branch = rest.slice(3).join('/');
      const sha = refSha(repo, branch);
      if (method === 'DELETE') {
        if (sha === undefined) return json(422, { message: 'Reference does not exist' });
        run(repo.dir, ['update-ref', '-d', 'refs/heads/' + branch, sha]);
        return new Response(null, { status: 204 });
      }
      if (method === 'GET') {
        if (sha === undefined) return json(404, { message: 'Not Found' });
        return json(200, { ref: 'refs/heads/' + branch, object: { sha, type: 'commit' } });
      }
    }

    // .../git/matching-refs/heads/:prefix
    if (rest[0] === 'git' && rest[1] === 'matching-refs' && rest[2] === 'heads') {
      const prefix = rest.slice(3).join('/');
      const listed = run(repo.dir, ['for-each-ref', '--format=%(refname)', 'refs/heads/' + prefix]);
      const refs = listed.ok === false || listed.out === ''
        ? []
        : listed.out.split(EOL).filter((line) => line !== '').map((name) => ({
          ref: name,
          object: { sha: refSha(repo, name.slice('refs/heads/'.length)) },
        }));
      return json(200, refs);
    }

    return json(404, { message: 'Not Found: ' + method + ' ' + url.pathname });
  }

  const server = {
    token,
    login,
    pulls,
    calls,
    fetch: handle,
    pullForRepo(repoName) {
      return pulls.filter((pull) => pull.owner + '/' + pull.repo === repoName);
    },
    /** Force the next matching request to fail with this status. */
    force(method, pathPrefix, status, body) {
      forced.push({ method, pathPrefix, status, body });
    },
    restore,
  };
  globalThis.fetch = handle;
  return server;
}

/* ------------------------------------------------------------------ */
/* Fake gh CLI                                                         */
/* ------------------------------------------------------------------ */

/**
 * A 'gh' executable for the credential-chain tests.
 *
 * The plugin resolves a token from GH_TOKEN, then GITHUB_TOKEN, then
 * 'gh auth token --hostname <host>'. Testing the third step against the real gh
 * would read this machine's stored credential, so the tests put a script on
 * PATH that prints a known token — or fails, for the no-credential case.
 */
export function fakeGh(directory, options = {}) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'gh');
  const lines = options.fail === true
    ? ['#!/bin/sh', 'echo "You are not logged into any GitHub hosts." >&2', 'exit 1', '']
    : ['#!/bin/sh', 'echo "' + (options.token ?? 'gh-cli-token') + '"', ''];
  writeFileSync(path, lines.join(EOL), { mode: 0o755 });
  return path;
}

/** The PATH a child should get so that fakeGh wins over the real gh. */
export function pathWith(directory) {
  return directory + ':/usr/bin:/bin';
}

export { TOKEN as TEST_TOKEN };
