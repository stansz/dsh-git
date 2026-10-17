/**
 * What each git action actually does.
 *
 * The tool definitions and the guard share this module so the replacement a
 * guard names is the operation that really exists — a deny message pointing at
 * a made-up action is worse than no message.
 *
 * Every action returns the tool's result envelope and never throws. That is not
 * politeness: a tool that throws gives the model a stack trace instead of a
 * next step, and the model's recovery from a stack trace is to reach for raw
 * git again, which is the behaviour this plugin exists to end.
 *
 * Determinism is the design rule throughout. Where a decision could be left to
 * the model — which repository, which branch to compare against, whether a push
 * is safe, whether a branch may be deleted — it is computed here from the
 * repository itself and stated in the result.
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import * as git from './git.mjs';
import * as state from './state.mjs';
import { createGithubClient, parseRemote } from './github.mjs';
import { resolveConfig, isProtectedBranch, isTaskBranch, protectedList } from './config.mjs';
import { turnSubject } from './render.mjs';
import { pathsOf } from './session-files.mjs';
import { describeProof, isCommitId } from './merge-proof.mjs';

/** Directories never worth descending into when looking for repositories. */
const PRUNE_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'dist', 'build', '.next', 'coverage', 'vendor', 'target', '.venv', 'venv', '__pycache__']);

/** How deep to search for repositories below a directory. */
const REPO_SEARCH_DEPTH = 3;

/** How many repositories one sweep will report. */
const REPO_SEARCH_LIMIT = 40;

/**
 * The branch a piece of work is based on.
 *
 * Three sources, in order: what the caller asked for, the configured
 * `baseBranch`, then the repository's own default branch.
 *
 * The order is written with its own parentheses on purpose. The expression this
 * replaced was `text(args?.base) ?? config.baseBranch !== '' ? config.baseBranch : ...`,
 * which JavaScript parses as `(text(args?.base) ?? (config.baseBranch !== '')) ? ...`
 * — `??` binds tighter than `?:`. So an explicitly-passed `base` was discarded, the
 * configured `baseBranch` was used instead, and since that defaults to `''` the
 * result was an empty base: `finish` handed the GitHub client `base: ''` and the
 * pull request was skipped with "base must be a non-empty string", which left the
 * pull request unopened and every later `finish` failing the same way.
 *
 * @param {object} args - the action's arguments; `base` wins when present.
 * @param {object} config - resolved plugin config.
 * @param {string} repoDir - repository to ask for its default branch.
 * @returns {Promise<string>} a branch name, never empty.
 */
export async function resolveBaseBranch(args, config, repoDir) {
  const explicit = text(args?.base);
  if (explicit !== undefined) return explicit;
  if (config.baseBranch !== '') return config.baseBranch;
  return (await git.defaultBranchOf(repoDir)) ?? 'main';
}

/**
 * A value with every `undefined`-valued key removed, recursively.
 *
 * The tools layer requires a result that is lossless JSON, and `undefined` is
 * not JSON: one undefined field fails the entire call and the model sees an
 * error instead of a result. The git helpers return optional fields as
 * `undefined` by design — `ahead` is genuinely unknown without an upstream —
 * so the conversion belongs here, at the boundary, and nowhere else.
 */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map((entry) => stripUndefined(entry));
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = stripUndefined(entry);
  }
  return out;
}

/** Successful result, with every optional field resolved to present or absent. */
function ok(action, fields) {
  return stripUndefined({ action, ok: true, ...fields });
}

/** Failed result, in the shape the renderer and the output schema both expect. */
function fail(action, code, message, hint) {
  return stripUndefined({ action, ok: false, error: { code, message, hint } });
}

/**
 * The next step for a credential failure, which depends on which credential is
 * missing.
 *
 * `GH_TOKEN` leads whenever the tool is absent, because it is the option that
 * needs nothing installed — the GitHub CLI is the alternative, not the workflow.
 * When `gh` is present and merely logged out, logging in to it is the shortest
 * fix and there is nothing to install, so that case is unchanged.
 *
 * @param {{error?: string}} available - the client's availability envelope.
 * @returns {string}
 */
function credentialAdvice(available) {
  const error = String(available?.error ?? '');
  if (/ENOENT|not be started/iu.test(error)) {
    return 'Set GH_TOKEN (or GITHUB_TOKEN) in the environment the Harness runs in — that needs nothing installed. Or install the GitHub CLI and run `gh auth login`.';
  }
  return 'Run `gh auth login`, or set GH_TOKEN.';
}

/** Text, or undefined when there is nothing meaningful. */
function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The repository a call is about: an explicit argument, else the reference directory. */
async function locateRepo(args, config, reference) {
  const explicit = text(args?.repo);
  if (explicit !== undefined) {
    const dir = isAbsolute(explicit) ? explicit : resolvePath(reference, explicit);
    if (!existsSync(dir)) {
      return { error: fail('status', 'repo-missing', 'No such path: ' + dir) };
    }
    // `toplevel` accepts a file path too, so a caller can name a changed file
    // rather than its repository — which is exactly what a tool handed a file
    // list has.
    const root = await git.toplevel(dir);
    if (root === undefined) {
      return { error: fail('status', 'not-a-repo', 'No git repository contains ' + dir) };
    }
    return { repoDir: root };
  }
  const root = await git.toplevel(reference);
  if (root === undefined) {
    return { missing: true };
  }
  return { repoDir: root };
}

/**
 * Every git repository at or below a directory, breadth-first and bounded.
 *
 * Used for the workspace sweep, where the honest answer to "is anything at
 * risk" needs to cover repositories the caller never named. Bounded because a
 * sweep that walks a whole home directory is a hang, not a report.
 *
 * Every path is realpath'd before it is returned, because `git rev-parse
 * --show-toplevel` realpaths too. On this platform `/var/folders/...` is
 * `/private/var/folders/...` and `/tmp` is `/private/tmp`, so a directory found
 * by walking and a directory named by git are **the same repository under two
 * strings** — and a caller that keys anything by those strings sees two
 * repositories, commits one, and leaves the other dirty.
 */
export function discoverRepos(root, options = {}) {
  const depth = options.depth ?? REPO_SEARCH_DEPTH;
  const limit = options.limit ?? REPO_SEARCH_LIMIT;
  const found = [];
  const seen = new Set();
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.name === '.git')) {
      const real = realpathOf(current.dir);
      if (!seen.has(real)) {
        seen.add(real);
        found.push(real);
      }
      continue;
    }
    if (current.depth >= depth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (PRUNE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return found;
}

/** A realpath, or the path itself when it cannot be resolved. */
function realpathOf(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** One repository's full state. */
export async function repoReport(repoDir, config, sessionId, options = {}) {
  const repoState = await git.repoState(repoDir, { timeoutMs: config.timeoutMs, signal: options.signal });
  if (repoState.ok !== true) {
    return { ...repoState, path: repoDir, ok: false, error: repoState.error ?? { code: 'state-failed', message: 'Could not read repository state' } };
  }
  const report = { ...repoState, path: repoDir, verdict: undefined };
  // A remote can carry a credential in its userinfo — `https://user:token@host/repo.git`
  // is a valid remote and a secret in plain sight — and this report is handed to a model
  // and lands in the session log. `describeRemote` drops the userinfo by construction, so
  // every caller of this report (`status`, and the sweep that reports many repositories)
  // shows the host and the path, which is what makes the line useful, and never the secret.
  if (Array.isArray(report.remotes)) {
    report.remotes = report.remotes.map((remote) => (
      remote !== null && typeof remote === 'object' && typeof remote.url === 'string'
        ? { ...remote, url: describeRemote(remote.url) }
        : remote
    ));
  }
  if (repoState.dirty === true) {
    report.changed = await git.changedPaths(repoDir, { timeoutMs: config.timeoutMs, signal: options.signal });
  }
  if (typeof repoState.ahead !== 'number') {
    const base = await resolveBaseBranch({}, config, repoDir);
    const sync = await git.computeSync(repoDir, 'origin/' + base, { timeoutMs: config.timeoutMs, signal: options.signal });
    if (sync !== undefined) {
      report.ahead = sync.ahead;
      report.behind = sync.behind;
      report.base = sync.base;
    }
  }
  const last = await git.run(repoDir, ['log', '-1', '--format=%h %s'], { timeoutMs: config.timeoutMs, signal: options.signal });
  if (last.ok && text(last.stdout) !== undefined) report.lastCommit = text(last.stdout);
  return report;
}

/**
 * The worktrees of a repository, as git reports them.
 *
 * Reporting only, and deliberately nothing more: an unreadable listing is an
 * empty report, and nothing here decides anything. Whatever creates or removes a
 * worktree owns that question; `status` shows only what exists.
 */
async function worktreeReport(repoDir, config, options = {}) {
  return (await git.listWorktrees(repoDir, { timeoutMs: config.timeoutMs, signal: options.signal })) ?? [];
}

/**
 * `status` — the state of a repository, or of every repository below a directory.
 *
 * Never mutates anything. This is the action a caller uses to answer "is any
 * work at risk", so it has to work in a repository that is mid-rebase, in a
 * worktree, or in a directory that merely contains repositories.
 */
export async function status(args, context) {
  const { config, sessionId, reference } = context;
  const signal = context.signal;
  const repoArg = text(args?.repo);

  if (args?.sweep === true && repoArg === undefined) {
    const roots = discoverRepos(reference);
    const repos = [];
    for (const dir of roots) {
      repos.push(await repoReport(dir, config, sessionId, { signal }));
    }
    const trees = [];
    for (const dir of roots) {
      for (const tree of await worktreeReport(dir, config, { signal, reference })) trees.push(tree);
    }
    return ok('status', { path: reference, repos, worktrees: trees });
  }

  const located = await locateRepo(args, config, reference);
  if (located.error !== undefined) return located.error;
  if (located.missing === true) {
    const roots = discoverRepos(reference);
    if (roots.length === 0) {
      return ok('status', { path: reference, repos: [] });
    }
    const repos = [];
    for (const dir of roots) repos.push(await repoReport(dir, config, sessionId, { signal }));
    return ok('status', { path: reference, repos });
  }

  const repoDir = located.repoDir;
  const repo = await repoReport(repoDir, config, sessionId, { signal });
  const trees = await worktreeReport(repoDir, config, { signal, reference });
  const fields = { path: repoDir, repo, worktrees: trees };

  if (args?.pull === true) {
    const remote = await git.remoteUrlFor(repoDir, 'origin');
    const parsed = remote !== undefined ? parseRemote(remote, config.githubHost) : undefined;
    if (parsed !== undefined && repo.branch !== undefined) {
      const client = createGithubClient({ host: config.githubHost, timeoutMs: config.timeoutMs });
      const found = await client.findPull({ ...parsed, head: repo.branch, signal });
      if (found.ok && found.pull !== undefined) {
        fields.pull = found.pull;
      } else if (found.ok !== true) {
        // A lookup that failed is not the same answer as "there is no pull
        // request", and reporting both as silence is how a machine with no
        // GitHub credential looked like a repository with nothing open.
        fields.pullError = {
          code: found.code ?? 'unknown',
          message: found.message ?? found.error ?? 'the pull request lookup failed',
        };
      }
    }
  }

  // A push failure is keyed on the *main* repository root — the doors that push
  // record it against the repository, not against the task worktree the push
  // stood in — while a status asked from inside a worktree reports the worktree
  // as its root. The second lookup is what makes the two meet; it costs a git
  // call only when something is recorded at all, which is the rare case.
  const session = state.readSession(sessionId, { stateRoot: config.stateRoot });
  let failure = session.pushFailures[repo.repoRoot ?? repoDir];
  if (failure === undefined && Object.keys(session.pushFailures).length > 0) {
    failure = session.pushFailures[await mainRepoRootOf(repoDir)];
  }
  if (failure !== undefined) {
    fields.pushFailure = { error: failure.error, attempts: failure.attempts, nextAttemptAt: failure.nextAttemptAt };
  }
  return ok('status', fields);
}

/**
 * `save` — commit the work this session did here.
 *
 * With no `paths`, the default is the files the session actually changed in this
 * repository — read from the same record the turn sync uses, intersected with what
 * is dirty now. Committing "everything dirty" is deliberately not available: that
 * is how another agent's half-finished edit gets published under this session's
 * name. Anything dirty that the session did not touch is reported, not swept in.
 *
 * The message defaults to what the commit contains, so the log says something true
 * without the caller having to think of anything.
 */
export async function save(args, context) {
  const { config, sessionId, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, reference, 'save');
  if (dir.error !== undefined) return dir.error;
  const repoDir = dir.repoDir;

  const explicit = Array.isArray(args?.paths)
    ? args.paths.filter((entry) => typeof entry === 'string' && entry !== '')
    : undefined;
  const dirty = await git.changedPaths(repoDir, { timeoutMs: config.timeoutMs, signal });

  let wanted = explicit ?? [];
  if (explicit === undefined) {
    const root = (await git.toplevel(repoDir)) ?? repoDir;
    const recorded = new Set(pathsOf(sessionId, root, { stateRoot: config.stateRoot })
      .filter((path) => isAbsolute(path) && isInside(root, path))
      .map((path) => relative(root, path).replace(/\/+$/u, '')));
    wanted = dirty.map((path) => path.replace(/\/+$/u, '')).filter((path) => recorded.has(path));
    if (wanted.length === 0) {
      return ok('save', {
        path: repoDir,
        committed: false,
        branch: dir.branch,
        detail: dirty.length === 0
          ? 'nothing to save: the working tree is clean'
          : 'nothing to save: this session changed none of the ' + String(dirty.length) + ' dirty path(s) here',
        leftBehind: dirty,
        notes: dirty.length === 0 ? [] : ['pass `paths` to name files explicitly if they are yours'],
      });
    }
  }
  if (wanted.length === 0) return ok('save', { path: repoDir, committed: false, branch: dir.branch, detail: 'no paths were given' });

  const claimed = new Set(wanted.map((path) => path.replace(/\/+$/u, '')));
  const leftBehind = explicit === undefined ? dirty.filter((path) => !claimed.has(path.replace(/\/+$/u, ''))) : [];
  const message = text(args?.message) ?? turnSubject(undefined, wanted);
  const committed = await git.commit(repoDir, message, { paths: wanted, timeoutMs: config.timeoutMs, signal });
  if (committed.ok !== true) {
    if (isNothingToCommit(committed.error)) {
      return ok('save', { path: repoDir, committed: false, branch: dir.branch, detail: 'nothing to commit: those paths match no change' });
    }
    return fail('save', committed.code ?? 'commit-failed', committed.error ?? 'Could not commit');
  }

  const fields = {
    path: repoDir,
    committed: true,
    sha: committed.sha,
    branch: dir.branch,
    subject: message.split('\n')[0],
    paths: wanted,
    leftBehind,
  };
  if (leftBehind.length > 0) {
    fields.notes = ['left ' + String(leftBehind.length) + ' unrecorded changed path(s) alone (' + leftBehind.slice(0, 3).join(', ')
      + '): pass `paths` if they are yours, or action "publish" after saving them elsewhere'];
  }
  return ok('save', fields);
}

/**
 * Whether a commit failed only because there was nothing to commit.
 *
 * Matched on git's wording because the underlying helper reports this as a
 * message rather than a code. "Nothing to commit" is not a failure of the
 * operation — it is the answer — so treating it as one would teach a session
 * that a clean repository is a broken tool.
 */
export function isNothingToCommit(error) {
  if (typeof error !== 'string') return false;
  return /nothing to commit|no changes added to commit|nothing added to commit/iu.test(error);
}

/**
 * Whether a directory is the given directory or sits inside it.
 *
 * Both sides are realpath'd because `reference` may be the caller's unresolved
 * form while the registry holds git's realpath — `/tmp/x` against
 * `/private/tmp/x` is one directory on this platform.
 */
function isInside(candidate, reference) {
  const child = realpathOf(reference);
  const parent = realpathOf(candidate);
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/**
 * The main repository root that owns a working directory.
 *
 * `git worktree list` reports the main working tree first, always, so its first
 * entry is the identity every registry lookup must use. Deriving it from
 * `--git-common-dir` does not work: that path ends in `/.git`, and asking git
 * for the toplevel of a `.git` directory yields nothing. Inside a linked
 * worktree the difference matters — the worktree is where the caller stands, and
 * the main root is what the session's state is keyed by.
 */
async function mainRepoRootOf(workingDir) {
  // Falling back to the working directory is the safe answer here: it is what the
  // caller passed, and every caller treats it as a hint rather than a decision.
  const trees = (await git.listWorktrees(workingDir)) ?? [];
  const first = trees[0];
  if (first !== undefined && typeof first.path === 'string' && first.path !== '') return first.path;
  return workingDir;
}

/**
 * The directory a mutating action works in: the repository the caller named.
 *
 * The main repository root comes back with it because that is the key session
 * state is stored under — a push failure is recorded against the repository, not
 * against the directory a caller happened to stand in.
 */
async function resolveTargetDir(args, config, reference, action) {
  const located = await locateRepo(args, config, reference);
  if (located.error !== undefined) return { error: { ...located.error, action } };
  if (located.missing === true) {
    return { error: fail(action, 'not-a-repo', 'No git repository at ' + reference) };
  }
  const repoDir = located.repoDir;
  const mainRepoDir = await mainRepoRootOf(repoDir);
  const branch = await git.currentBranch(repoDir);
  return { repoDir, mainRepoDir, branch };
}

/**
 * `push` — push a branch, refusing the branches that would rewrite shared work.
 *
 * The refusal is the feature. A session that pushes to main is the reason this
 * plugin has a guard at all; a session that pushes to its own task branch is
 * the behaviour that keeps work safe.
 */
async function pushBranch(repoDir, config, sessionId, options = {}, repoRoot) {
  // `repoRoot` is the state key. Inside a worktree `repoDir` is the worktree, and
  // state keyed on it would never match the entry the session registered.
  const stateKey = repoRoot ?? repoDir;
  const branch = await git.currentBranch(repoDir);
  if (branch === undefined) {
    return { ok: false, pushed: false, error: 'Detached HEAD: nothing to push' };
  }
  if (isProtectedBranch(config, branch) && options.allowProtected !== true) {
    return {
      ok: false,
      pushed: false,
      branch,
      code: 'protected-branch',
      error: 'Refusing to push ' + branch + ': it is a protected branch (' + protectedList(config) + ')',
      hint: 'Open a pull request instead, or pass allowProtected: true to override for this call.',
    };
  }
  // A repository with no `origin` has nowhere to push, and git's own answer —
  // "'origin' does not appear to be a git repository" — reads like a broken
  // remote rather than a repository that has none. Asked before the attempt, so
  // nothing is recorded as a push failure for a repository that cannot push at
  // all, and the automatic sync skips it entirely (see `syncRepo`).
  const remote = text(options.remote) ?? 'origin';
  if (await git.remoteUrlFor(repoDir, remote) === undefined) {
    return {
      ok: false,
      pushed: false,
      branch,
      code: 'no-remote',
      error: 'Refusing to push ' + branch + ': this repository has no ' + remote + ' remote',
      hint: 'Add one in a terminal (`git remote add origin <url>`), or leave the work local — the commits are in this repository either way, and nothing is lost.',
    };
  }
  const hasUpstream = (await git.upstreamRef(repoDir, branch, { timeoutMs: config.timeoutMs, signal: options.signal })) !== undefined;
  // No setUpstream override: `git.push` points the branch at itself when it has
  // no upstream *or* when it tracks something else. That second case is the
  // important one — a branch cut from the base inherits `origin/<base>` as its
  // upstream, so forcing `setUpstream:false` here would leave the branch
  // reporting sync against the base it was cut from instead of its own remote.
  const result = await git.push(repoDir, {
    timeoutMs: config.timeoutMs,
    signal: options.signal,
    remote,
    forceWithLease: options.forceWithLease === true,
  });
  if (result.ok !== true) {
    // Whether the backoff is on disk decides what the next attempt does, so it is
    // reported rather than assumed: `persisted: false` means nothing is holding
    // the next push back, and a caller that says "backing off" would be describing
    // a schedule that does not exist.
    // The record is what `status` prints as the automatic push's failure, so the
    // credential half is explained where it is written down; the same sentence
    // travels as `hint` for the callers that report the failure rather than
    // store it, and each channel prints it once.
    const hint = git.credentialHint(result.error) ?? result.hint;
    const recorded = state.recordPushFailure(sessionId, stateKey, git.explainCredentialFailure(result.error ?? 'push failed'), { stateRoot: config.stateRoot });
    const backoffRecorded = recorded.persisted === true;
    return {
      ok: false,
      pushed: false,
      branch,
      remote,
      error: (result.error ?? 'push failed')
        + (backoffRecorded ? '' : ' (and the backoff could not be recorded, so the next attempt is not held back)'),
      hint,
      backoffRecorded,
    };
  }
  // The other direction: a push that succeeded while a previous failure record
  // survived will be held back by that record until it expires.
  const cleared = state.clearPushFailure(sessionId, stateKey, { stateRoot: config.stateRoot });
  return {
    ok: true,
    pushed: result.pushed !== false,
    branch,
    remote: result.remote ?? remote,
    setUpstream: result.setUpstream === true || !hasUpstream,
    ...(cleared === true ? {} : { backoffCleared: false }),
  };
}

export async function publish(args, context) {
  const { config, sessionId, reference } = context;
  const dir = await resolveTargetDir(args, config, reference, 'publish');
  if (dir.error !== undefined) return dir.error;
  const result = await pushBranch(dir.repoDir, config, sessionId, {
    signal: context.signal,
    allowProtected: args?.allowProtected === true,
    forceWithLease: args?.forceWithLease === true,
    remote: text(args?.remote),
  }, dir.mainRepoDir);
  if (result.ok !== true) {
    return fail('publish', result.code ?? 'push-failed', result.error ?? 'push failed', result.hint);
  }
  const fields = { path: dir.repoDir, branch: result.branch, remote: result.remote, pushed: result.pushed, setUpstream: result.setUpstream };
  if (result.backoffCleared === false) {
    fields.notes = ['the push succeeded, but a previous failure record could not be cleared, so a later push may be held back until it expires'];
  }
  return ok('publish', fields);
}

/**
 * `sync` — fetch, then move the safe direction only.
 *
 * Fast-forward or nothing: a merge or a rebase started on someone else's behalf
 * is a conflict handed to a model with no context for it. When the fast-forward
 * is impossible the result says so and names the divergence, and the decision
 * stays with a human.
 */
export async function sync(args, context) {
  const { config, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, reference, 'sync');
  if (dir.error !== undefined) return dir.error;
  const repoDir = dir.repoDir;

  const remote = text(args?.remote) ?? 'origin';
  const fetched = await git.fetch(repoDir, remote, { timeoutMs: Math.max(config.timeoutMs, 30000), signal });
  if (fetched.ok !== true) {
    // Reading a remote needs the same credential a push does as soon as the
    // repository is not public, and git says the same thing about it: the read
    // door explains it in the words the push doors use, because this is where a
    // first run on a machine with no credential gets stuck.
    const error = fetched.error ?? ('Could not fetch ' + remote);
    return fail('sync', 'fetch-failed', error, git.credentialHint(error));
  }

  const branch = dir.branch;
  const base = await resolveBaseBranch(args, config, repoDir);
  const baseRef = remote + '/' + base;

  // One comparison for every branch, the trunk included. The earlier split — a
  // task branch compared, the base branch fast-forwarded blind — made `merge: true`
  // a silent no-op on the trunk: the caller asked for a merge, the code took the
  // fast-forward path, and the result said `ok` while upstream's commits never
  // arrived.
  const compared = await git.computeSync(repoDir, baseRef, { timeoutMs: config.timeoutMs, signal });
  if (compared === undefined) {
    return fail('sync', 'no-base', 'Could not compare with ' + baseRef);
  }

  if (compared.behind === 0) {
    return ok('sync', { path: repoDir, base, remote, fastForwarded: false, detail: 'up to date with ' + base });
  }

  // Nothing of this branch's own to lose: the safe direction, and the only one.
  if (compared.ahead === 0) {
    const moved = await git.fastForward(repoDir, baseRef, { timeoutMs: config.timeoutMs, signal });
    if (moved.ok === true && moved.moved === true) {
      return ok('sync', { path: repoDir, base, remote, fastForwarded: true, from: moved.from, to: moved.to });
    }
    return fail('sync', 'fast-forward-failed', moved.error ?? 'Could not fast-forward');
  }

  // Diverged. The caller picks the history shape or nothing happens: a rebase or a
  // merge started for somebody who did not ask for one is a conflict handed to a
  // caller with no context for it.
  if (args?.rebase === true) {
    const rebased = await git.rebase(repoDir, baseRef, { timeoutMs: Math.max(config.timeoutMs, 60000), signal });
    if (rebased.ok !== true) {
      const paths = await git.conflictedPaths(repoDir, { timeoutMs: config.timeoutMs, signal });
      await git.rebaseAbort(repoDir, { timeoutMs: config.timeoutMs, signal });
      if (paths.length === 0) {
        return fail('sync', 'rebase-failed', rebased.error ?? 'git rebase failed',
          'The rebase was aborted and the branch is exactly where it was.');
      }
      return fail('sync', 'rebase-conflict',
        'Rebasing ' + String(branch ?? 'HEAD') + ' onto ' + baseRef + ' stopped on a conflict in ' + paths.slice(0, 5).join(', '),
        'The rebase was aborted, so the branch is where it was. Resolve it in a terminal (`git rebase ' + baseRef + '`) — this tool has no conflict editor.');
    }
    const rebasedTo = await git.revParse(repoDir, 'HEAD', { timeoutMs: config.timeoutMs, signal });
    const upstream = await git.upstreamRef(repoDir, branch, { timeoutMs: config.timeoutMs, signal });
    const fields = { path: repoDir, base, remote, rebased: true, to: rebasedTo };
    if (upstream !== undefined) {
      fields.notes = ['the rebase rewrote commits that were already on ' + upstream
        + ', so publishing this branch needs action "publish" with `forceWithLease: true`'];
    }
    return ok('sync', fields);
  }
  if (args?.merge === true) {
    const before = await git.revParse(repoDir, 'HEAD', { timeoutMs: config.timeoutMs, signal });
    const merged = await git.merge(repoDir, baseRef, { timeoutMs: Math.max(config.timeoutMs, 60000), signal });
    if (merged.ok !== true) {
      const paths = await git.conflictedPaths(repoDir, { timeoutMs: config.timeoutMs, signal });
      await git.mergeAbort(repoDir, { timeoutMs: config.timeoutMs, signal });
      if (paths.length === 0) {
        // git refused for a reason that is not a conflict — unrelated histories,
        // a hook, a dirty tree. git's own sentence is the one that helps, and
        // calling it a conflict sends the caller looking for the wrong thing.
        return fail('sync', 'merge-failed', merged.error ?? 'git merge failed',
          'The merge was aborted and the branch is exactly where it was.');
      }
      return fail('sync', 'merge-conflict',
        'Merging ' + baseRef + ' into ' + String(branch ?? 'HEAD') + ' stopped on a conflict' + (paths.length > 0 ? ' in ' + paths.slice(0, 5).join(', ') : ''),
        'The merge was aborted, so the branch is where it was. Resolve it deliberately in a terminal (`git merge ' + baseRef + '`), or use action "sync" with `rebase: true`.');
    }
    const after = await git.revParse(repoDir, 'HEAD', { timeoutMs: config.timeoutMs, signal });
    return ok('sync', { path: repoDir, base, remote, merged: true, from: before, to: after });
  }

  return ok('sync', {
    path: repoDir,
    base,
    remote,
    fastForwarded: false,
    detail: 'branch has diverged from ' + base + ' (' + compared.ahead + ' ahead, ' + compared.behind + ' behind) — run action "sync" with `rebase: true` to replay this branch onto ' + baseRef,
  });
}
/**
 * A remote URL with its credentials removed, for a message a caller will read.
 *
 * `https://user:token@host/org/repo.git` is a valid git remote and a secret in
 * plain sight, and this error is handed to the model and lands in the session
 * log. The URL is printed without its userinfo: the host and the path are what
 * make the message useful, and neither is secret. The userinfo is dropped by
 * construction rather than by a pattern, so no credential shape can slip past a
 * regex that does not know it — that is why there is no second credential regex
 * here. github.mjs redacts the shapes it knows about with its own helper, which
 * is private to that module.
 *
 * A scp-like remote (`git@host:org/repo`) cannot carry a password, so it is
 * printed as it is. An https URL that cannot be parsed is not printed at all:
 * an unparseable string is exactly where an unanticipated credential hides.
 *
 * @param {string} url - the configured origin URL.
 * @returns {string} a URL safe to put in an error.
 */
function describeRemote(url) {
  const raw = String(url ?? '');
  if (!raw.includes('://')) return raw;
  try {
    const parsed = new URL(raw.replace(/^git\+/u, ''));
    if (parsed.username === '' && parsed.password === '') return raw;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '(a remote URL that could not be shown without its credentials)';
  }
}

/**
 * The GitHub coordinates of a repository's origin, or a failure envelope.
 *
 * The action is a parameter because this helper is called by pr, merge, finish,
 * prune and the automatic close, and the envelope it returns is handed straight
 * back to the caller. Hard-coding `pr` here made action "merge" report itself as
 * a pull-request call.
 */
async function githubCoords(repoDir, config, action = 'pr') {
  const remote = await git.remoteUrlFor(repoDir, 'origin');
  if (remote === undefined) {
    return { error: fail(action, 'no-remote', 'No origin remote configured') };
  }
  const parsed = parseRemote(remote, config.githubHost);
  if (parsed === undefined) {
    return { error: fail(action, 'not-github', 'Origin is not a ' + config.githubHost + ' remote: ' + describeRemote(remote)) };
  }
  return { coords: parsed, client: createGithubClient({ host: config.githubHost, timeoutMs: config.timeoutMs }) };
}

/**
 * The commit a local branch points at, or undefined when it cannot be read.
 *
 * Deleting a branch needs this. "A merged pull request was found for this name"
 * is not enough — the branch may have moved since, and the whole point of reading
 * the tip is to notice that. Undefined is returned for a branch that does not
 * exist *and* for one that could not be read, and both mean the same thing to a
 * caller: there is nothing here it may delete.
 */
async function branchTip(repoDir, branch, options = {}) {
  if (typeof branch !== 'string' || branch.trim() === '') return undefined;
  const out = await git.run(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch.trim()], {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (out.ok !== true) return undefined;
  const sha = String(out.stdout).trim();
  return isCommitId(sha) ? sha : undefined;
}

/**
 * Record a remote-branch delete, including the outcome that is not a deletion.
 *
 * The client answers `{ok: true, deleted: false, code: 'already-absent'}` when
 * the endpoint reports the reference does not exist: the caller's goal holds, but
 * nothing was deleted. Collapsing that to `remoteDeleted: false` — which every
 * caller here used to do — loses the only thing worth saying, that there was
 * nothing left to clean up, and leaves a reader unable to tell it from a delete
 * that failed. Both halves are written the same way at every call site.
 *
 * @param {object} record - the result record to write into.
 * @param {string} field - the boolean field this caller reports the delete in.
 * @param {{ok?: boolean, deleted?: boolean, code?: string}} deleted - the client's answer.
 * @returns {object} the same record, for chaining.
 */
function noteRemoteDelete(record, field, deleted) {
  record[field] = deleted.ok === true && deleted.deleted !== false;
  if (deleted.code === 'already-absent') record.remoteAbsent = true;
  return record;
}

/**
 * The commit a remote branch points at, asked of the remote itself.
 *
 * `ok: false` and `sha: undefined` are different answers on purpose: the first is
 * "the remote could not be asked", the second is "the remote does not have that
 * ref". Both refuse a deletion, but only the second is the state the caller was
 * trying to reach.
 */
async function remoteBranchTip(repoDir, branch, options = {}) {
  const out = await git.run(repoDir, ['ls-remote', '--heads', 'origin', 'refs/heads/' + branch], {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (out.ok !== true) return { ok: false };
  const first = String(out.stdout).trim().split('\n')[0] ?? '';
  const sha = first.trim().split(/\s+/u)[0] ?? '';
  return { ok: true, sha: isCommitId(sha) ? sha : undefined };
}

/**
 * `pr` — open a pull request, or return the one already open.
 *
 * Idempotent on purpose: a session that calls this twice must not fail the
 * second time, because a failure it cannot read as "already done" teaches it to
 * reach for `gh` instead — the exact drift this plugin removes.
 */
export async function pr(args, context) {
  const { config, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, reference, 'pr');
  if (dir.error !== undefined) return dir.error;
  const repoDir = dir.repoDir;

  const coords = await githubCoords(repoDir, config);
  if (coords.error !== undefined) return coords.error;
  const { client } = coords;

  const available = await client.isAvailable();
  if (available.ok !== true) {
    return fail('pr', available.code ?? 'no-credentials', available.error ?? 'No GitHub credentials available', credentialAdvice(available));
  }

  const branch = await git.currentBranch(repoDir);
  const base = await resolveBaseBranch(args, config, repoDir);
  if (branch === undefined) return fail('pr', 'detached', 'Detached HEAD: there is no branch to open a pull request from');
  if (branch === base) {
    return fail('pr', 'same-branch', 'The current branch is ' + base + ' itself, so there is nothing to compare', 'Commit the work to a branch of its own first, then open the pull request from that branch.');
  }

  const ahead = await git.aheadOf(repoDir, 'origin/' + base, { timeoutMs: config.timeoutMs, signal });
  if (ahead === 0) {
    return fail('pr', 'no-commits-between', 'No commits between origin/' + base + ' and ' + branch + ' — push first, or commit something', 'Call action "finish", which commits, pushes and then opens the pull request.');
  }

  const opened = await client.upsertPull({
    ...coords.coords,
    head: branch,
    base,
    title: text(args?.title) ?? (await defaultTitle(repoDir, config, signal)) ?? branch,
    body: text(args?.body) ?? defaultBody(base, branch),
    draft: typeof args?.draft === 'boolean' ? args.draft : config.prDraft,
    signal,
  });
  if (opened.ok !== true) {
    return fail('pr', opened.code ?? 'pr-failed', opened.error ?? 'Could not open a pull request');
  }
  const fields = {
    path: repoDir,
    created: opened.created === true,
    number: opened.number,
    url: opened.url,
    state: opened.state,
    draft: opened.draft,
    branch,
    base,
    title: opened.title,
  };
  if (opened.updated === true) fields.notes = ['pull request body updated from the commits on this branch'];
  return ok('pr', fields);
}

/** The first line of the newest commit, which is the honest default title. */
async function defaultTitle(repoDir, config, signal) {
  const log = await git.run(repoDir, ['log', '-1', '--format=%s'], { timeoutMs: config.timeoutMs, signal });
  return log.ok ? text(log.stdout) : undefined;
}

/** A body that lists what the branch adds, so a reviewer has the shape up front. */
function defaultBody(base, branch) {
  return [
    'Opened by DSH from branch `' + branch + '`.',
    '',
    'The work was committed and pushed automatically as it was made.',
    '',
    'Compare against `' + base + '` for the full diff.',
  ].join('\n');
}

/** `merge` — merge a pull request, then delete the remote branch only when it is proved merged. */
export async function merge(args, context) {
  const { config, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, reference, 'merge');
  if (dir.error !== undefined) return dir.error;

  // Only a merge that keeps the ancestry is performed. A squash or a rebase
  // rewrites the branch's commits, so afterwards nothing local can prove the
  // branch was merged: the cleanup that follows — prune, and the close at the
  // turn boundary — has to ask GitHub every time, and without credentials, a
  // network and a github.com remote the branch looks like unmerged work forever
  // while the automatic push can put it back on the remote. Refused here, before
  // the API is called, so the answer does not depend on the remote either.
  const method = ['squash', 'merge', 'rebase'].includes(args?.method) ? args.method : 'merge';
  if (method !== 'merge') {
    return fail(
      'merge',
      'method-refused',
      'Refusing a ' + method + ' merge: it rewrites the branch\'s commits, so nothing local can prove the branch was merged afterwards, and every cleanup that follows would have to ask GitHub instead. Without credentials, a network or a github.com remote the branch then looks like unmerged work forever, and the automatic push can put it back on the remote. The tool merges, which keeps the ancestry and needs no permission to clean up.',
      'Omit the method argument — it defaults to merge — or pass method: "merge". To squash anyway, do it in the GitHub UI and then remove the branch here by naming it: action "prune" with branches: ["<branch>"].',
    );
  }
  const repoDir = dir.repoDir;

  const coords = await githubCoords(repoDir, config, 'merge');
  if (coords.error !== undefined) return coords.error;
  const { client } = coords;

  const branch = await git.currentBranch(repoDir);
  const base = await resolveBaseBranch(args, config, repoDir);
  const number = Number.isInteger(args?.number) ? args.number : undefined;
  let target = number;
  if (target === undefined) {
    if (branch === undefined) return fail('merge', 'no-target', 'Name a pull request number, or run this from its branch');
    const found = await client.findPull({ ...coords.coords, head: branch, signal });
    if (found.ok !== true || found.pull === undefined) {
      return fail('merge', 'no-pull', 'No open pull request for ' + branch);
    }
    target = found.pull.number;
  }

  // Which branch this pull request is from, asked *before* anything is merged.
  //
  // This action used to take the branch it happened to be standing on and delete
  // that branch's remote ref — whatever pull request number had been named. The
  // pull request number and the branch were never compared. Merging #42 while
  // standing in another task's checkout deleted that other task's remote branch;
  // from the main checkout it deleted origin/main, with no protected-branch check
  // on the way.
  // The branch a merge may clean up is the one the pull request came from, and
  // that is a fact about the pull request, not about the directory.
  const viewed = await client.viewPull({ ...coords.coords, number: target, signal });
  if (viewed.ok !== true) {
    return fail('merge', viewed.code ?? 'pull-unreadable', viewed.error ?? ('Could not read pull request #' + String(target)));
  }
  const mergedBranch = viewed.pull?.head;
  const prTip = viewed.pull?.headSha;
  if (mergedBranch === undefined) {
    return fail(
      'merge',
      'pull-head-unknown',
      'Pull request #' + String(target) + ' did not report the branch it is from, so there is no way to tell which branch merging it would then remove',
      'Merge it on GitHub, or retry — the branch it is from is what names what gets cleaned up.',
    );
  }
  if (viewed.pull?.base !== undefined && viewed.pull.base === mergedBranch) {
    return fail('merge', 'pull-head-is-base', 'Pull request #' + String(target) + ' is from ' + mergedBranch + ' into itself, which is not a merge');
  }

  // A real merge commit, not a squash.
  //
  // Squash rewrites the branch's commits into one commit with a new id, so the
  // branch's own commits are never ancestors of the base. Everything downstream
  // asks git that question: the turn sync pushes a task branch that looks ahead of
  // its base — and after a squash it always looks ahead — and `prune` refuses to
  // delete a branch that holds "commits of its own", which after a squash is every
  // merged branch. The merge strategy and the cleanup strategy contradicted each
  // other, and the visible symptom was task branches reappearing on the remote
  // every turn after being deleted.
  //
  // Preserving ancestry makes both of them correct with no extra state.
  const merged = await client.mergePull({
    ...coords.coords,
    number: target,
    method,
    signal,
  });
  // No exception for "the pull request is not open" any more: a 404 on the pull
  // request is a failure that names the missing pull request, and the old
  // `not-open` code this condition excused has no producer left in the client.
  // A condition nothing can reach is a branch nothing tests.
  if (merged.ok !== true) {
    return fail('merge', merged.code ?? 'merge-failed', merged.error ?? 'Could not merge');
  }

  const fields = {
    path: repoDir,
    number: target,
    merged: merged.merged === true,
    sha: merged.sha,
    method,
    mergedBranch,
  };

  if (merged.merged === true) {
    const notes = [];

    if (!isTaskBranch(config, mergedBranch) || mergedBranch === base) {
      // Outside the plugin's own prefix, or the base itself: not this action's to
      // remove. Saying so is the whole difference from the old behaviour, which
      // deleted whatever branch the caller happened to be standing on.
      fields.remoteKept = mergedBranch + ' is not a task branch (the prefix is ' + config.branchPrefix + '), so nothing was removed';
      fields.notes = ['the merge is recorded; ' + fields.remoteKept];
    } else if (!isCommitId(prTip)) {
      fields.notes = ['the merge is recorded, but GitHub did not report the commit it merged, so no remote branch was removed'];
    } else {
      // The remote ref goes only if it is the commit the pull request merged. The
      // API deletes whatever the ref is at that moment, so the question has to be
      // asked immediately before, and the answer has to be the merged commit.
      const remote = await remoteBranchTip(repoDir, mergedBranch, { timeoutMs: config.timeoutMs, signal });
      if (remote.ok !== true) {
        fields.remoteKept = 'the remote ref could not be read, so it was left alone';
      } else if (remote.sha === undefined) {
        fields.remoteAbsent = true;
      } else if (remote.sha !== prTip) {
        fields.remoteKept = 'the remote ref points at ' + remote.sha.slice(0, 12) + ', not at the merged commit ' + prTip.slice(0, 12);
      } else {
        const deleted = await client.deleteRemoteBranch({ ...coords.coords, branch: mergedBranch, signal });
        noteRemoteDelete(fields, 'remoteBranchDeleted', deleted);
      }

      // The local branch is never removed here. Deleting a branch by name from a
      // shared checkout can remove another session's branch, and a commit made
      // after the merge — with the push turned off, or backing off after a
      // failure — exists nowhere but here. A branch that has moved past the
      // merged commit is reported instead of tidied.
      const localTip = await branchTip(repoDir, mergedBranch, { timeoutMs: config.timeoutMs, signal });
      if (localTip !== undefined && localTip !== prTip) {
        fields.branchKept = mergedBranch + ' points at ' + localTip.slice(0, 12)
          + ', not at the merged commit ' + prTip.slice(0, 12) + ', so it holds work the merge did not cover';
      }
      notes.push('the local checkout was left alone: deleting a branch by name from a shared checkout can remove another session\'s branch');
    }

    if (notes.length > 0) fields.notes = notes;
  }
  return ok('merge', fields);
}

/**
 * `finish` — the invariant: no dirty tree, no unpushed commit, a pull request.
 *
 * This is the action that closes the loop this plugin was written for. It
 * performs each step that is still outstanding and reports which ones they
 * were, so a caller never has to reason about what state it left behind.
 */
export async function finish(args, context) {
  const { config, sessionId, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, reference, 'finish');
  if (dir.error !== undefined) return dir.error;
  const repoDir = dir.repoDir;
  const fields = { path: repoDir };
  const notes = [];

  const before = await git.repoState(repoDir, { timeoutMs: config.timeoutMs, signal });
  if (before.ok !== true) {
    return fail('finish', 'state-failed', before.error?.message ?? 'Could not read repository state');
  }
  if (before.rebaseInProgress === true || before.mergeInProgress === true) {
    return fail('finish', 'operation-in-progress', 'A merge or rebase is in progress', 'Resolve it, then finish again.');
  }

  if (before.dirty === true) {
    const message = text(args?.message) ?? turnSubject(undefined, await git.changedPaths(repoDir, { timeoutMs: config.timeoutMs, signal }));
    const committed = await git.commit(repoDir, message, { all: true, timeoutMs: config.timeoutMs, signal });
    if (committed.ok !== true && !isNothingToCommit(committed.error)) {
      return fail('finish', committed.code ?? 'commit-failed', committed.error ?? 'Could not commit');
    }
    fields.committed = committed.ok === true;
    fields.sha = committed.sha;
    fields.subject = message.split('\n')[0];
  } else {
    fields.committed = false;
  }

  const pushed = await pushBranch(repoDir, config, sessionId, { signal, allowProtected: args?.allowProtected === true }, dir.mainRepoDir);
  fields.pushed = pushed.pushed === true;
  fields.branch = pushed.branch ?? before.branch;
  fields.remote = pushed.remote;
  if (pushed.ok !== true) {
    notes.push(pushed.error ?? 'push failed');
    if (pushed.hint !== undefined) notes.push(pushed.hint);
  } else if (pushed.backoffCleared === false) {
    notes.push('the push succeeded, but a previous failure record could not be cleared, so a later push may be held back until it expires');
  }

  const branch = pushed.branch ?? before.branch;
  const base = await resolveBaseBranch(args, config, repoDir);

  if (args?.pr !== false && pushed.ok === true) {
    // Opening a pull request needs a GitHub remote, and `finish` is the action a
    // session actually calls. Asking the GitHub client directly — through the
    // same helper `pr` uses — keeps the reason in the same place as the action
    // that reports it, instead of a nested call whose failure envelope has to be
    // re-read and re-worded.
    const coords = await githubCoords(repoDir, config, 'finish');
    if (coords.error !== undefined) {
      fields.prSkipped = coords.error.error.message;
    } else {
      const result = await pr({ base, draft: args?.draft, title: args?.title, body: args?.body, repo: repoDir }, context);
      if (result.ok === true) {
        fields.pull = { number: result.number, url: result.url, state: result.state, draft: result.draft };
      } else {
        fields.prSkipped = result.error?.message ?? 'not opened';
        // The clue a first run needs, where the push hint already goes: the
        // reason a pull request could not be opened is usually a credential this
        // machine does not have yet, and the message alone does not say so.
        if (result.error?.hint !== undefined) notes.push(result.error.hint);
      }
    }
  } else if (pushed.ok !== true) {
    fields.prSkipped = 'the branch is not pushed yet';
  }

  if (notes.length > 0) fields.notes = notes;
  return ok('finish', fields);
}

/**
 * Delete a local branch, against a proof of the commit it points at.
 *
 * Callers are supposed to delete only what they have proved disposable — the
 * branch sweep removes a branch whose commits are all in the base, or one a
 * merged pull request covers — and the proof is an argument rather than a claim
 * made beside the call. `tip` is the commit the caller believes this branch
 * points at, it is required, and it is both checked and *used*:
 * `git update-ref -d <ref> <old>` refuses the delete if the branch moved in
 * between. A branch a worktree has checked out is refused outright, because
 * `update-ref` would leave that checkout with a broken HEAD.
 *
 * @param {string} repoRoot - the repository's top level.
 * @param {string} name - the branch name, without the `refs/heads/` prefix.
 * @param {object} gitOpts - signal and timeout for the git calls.
 * @param {{tip: string}} proof - the commit that was proved disposable.
 * @returns {Promise<{ok: boolean, absent?: boolean, code?: string, error?: string}>}
 *   `absent: true` means there was no such branch, which is not a failure: the
 *   caller's goal is that the branch is gone.
 */
async function deleteProvenBranch(repoRoot, name, gitOpts, proof) {
  const branch = typeof name === 'string' ? name.trim() : '';
  if (branch === '') return { ok: false, error: 'a branch name is required' };

  const tip = typeof proof?.tip === 'string' ? proof.tip.trim() : '';
  if (!isCommitId(tip)) {
    return {
      ok: false,
      code: 'no-proof',
      error: 'deleting ' + branch + ' requires the commit it is believed to point at',
    };
  }

  // Asked on every delete, and a listing that fails refuses the delete instead of
  // answering "no worktree has it".
  const trees = await git.listWorktrees(repoRoot, gitOpts);
  if (trees === undefined) {
    return {
      ok: false,
      code: 'worktree-list-failed',
      error: 'the worktree registrations of ' + repoRoot + ' could not be read, so it is not known whether ' + branch + ' is checked out',
    };
  }
  if (trees.some((entry) => entry.branch === branch)) {
    return { ok: false, code: 'checked-out', error: 'refusing to delete ' + branch + ': a worktree has it checked out' };
  }

  const head = await git.run(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], gitOpts);
  const sha = head.ok ? String(head.stdout).trim() : '';
  if (sha === '') return { ok: true, absent: true };
  if (sha !== tip) {
    return {
      ok: false,
      code: 'tip-moved',
      error: 'refusing to delete ' + branch + ': it points at ' + sha.slice(0, 12)
        + ', not at the commit that was proved disposable (' + tip.slice(0, 12) + ')',
    };
  }

  const deleted = await git.run(repoRoot, ['update-ref', '-d', 'refs/heads/' + branch, tip], gitOpts);
  if (deleted.ok !== true) return { ok: false, error: deleted.error ?? 'could not delete ' + branch };
  return { ok: true };
}

/**
 * Task branches this plugin left behind: under `branchPrefix`, checked out by no
 * worktree, and holding no commit the base does not already have.
 *
 * This is the branch half of `prune`, and the conditions are the whole argument
 * for deleting anything at all. A branch outside the prefix is not this plugin's
 * to remove; one a worktree has checked out is in use; and one that holds a
 * commit of its own is work, so it is reported and kept, never deleted. The
 * object name comes back with the branch in the same `for-each-ref` call, so the
 * name and the proof handed to the delete cannot disagree.
 *
 * @param {string} repoDir - repository to sweep.
 * @param {object} config - resolved plugin config.
 * @param {object} options - `{apply, baseRef, signal}`.
 * @returns {Promise<{ok: boolean, branches?: object[], error?: string}>}
 */
async function sweepTaskBranches(repoDir, config, options = {}) {
  const gitOpts = { timeoutMs: config.timeoutMs, signal: options.signal };
  const apply = options.apply === true;

  const trees = await git.listWorktrees(repoDir, gitOpts);
  if (trees === undefined) {
    return { ok: false, error: 'the worktree registrations of ' + repoDir + ' could not be read, so no branch was swept' };
  }
  const checkedOut = new Set(trees.map((entry) => entry.branch).filter((branch) => typeof branch === 'string'));

  // The object name comes back with the ref: it is the proof the delete needs,
  // and asking for it in the same call as the name means the two cannot disagree.
  const listed = await git.run(repoDir, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads'], gitOpts);
  if (listed.ok !== true) {
    return { ok: false, error: listed.error ?? 'the branches of ' + repoDir + ' could not be listed' };
  }

  const branches = [];
  for (const line of listed.stdout.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
    const split = line.indexOf(' ');
    const sha = split === -1 ? '' : line.slice(0, split);
    const name = split === -1 ? line : line.slice(split + 1);
    if (!isTaskBranch(config, name) || checkedOut.has(name)) continue;

    const unique = await git.run(repoDir, ['rev-list', '--count', 'refs/heads/' + name, '--not', options.baseRef ?? 'HEAD'], gitOpts);
    const ahead = unique.ok ? Number.parseInt(unique.stdout.trim(), 10) : Number.NaN;
    if (!(Number.isFinite(ahead) && ahead === 0)) {
      branches.push({
        branch: name,
        reason: 'no worktree, but it holds ' + (Number.isFinite(ahead) ? String(ahead) : 'some') + ' commit(s) of its own, so it is kept',
        kept: true,
      });
      continue;
    }
    const record = {
      branch: name,
      sha: sha === '' ? undefined : sha,
      reason: 'no worktree, and no commits of its own',
    };
    if (apply) {
      // The count above is the argument, the sha is the proof handed to the
      // delete, and the answer is reported: a branch this could not remove is not
      // a branch it removed.
      const gone = await deleteProvenBranch(repoDir, name, gitOpts, { tip: sha });
      record.deleted = gone.ok === true;
      if (gone.ok !== true) {
        record.error = gone.error;
        record.kept = true;
      }
    }
    branches.push(record);
  }
  return { ok: true, branches };
}

/**
 * `prune` — tidy up what this plugin left behind.
 *
 * Every other action refuses to delete things, and the guard denies the raw git
 * equivalents outright. That is right for a branch somebody may be using — but it
 * left the plugin unable to clean up after *itself*, which is how a failed
 * creation's orphan branch became permanent. This is the narrow door, and it
 * opens only onto the plugin's own leftovers: a branch under its own prefix that
 * no worktree has checked out and that holds no commit the base branch does not
 * already have. A branch with work of its own is reported, never deleted.
 *
 * Dry run by default. `apply: true` is the caller saying they have read the list.
 */
export async function prune(args, context) {
  const { config, reference } = context;
  const located = await locateRepo(args, config, reference);
  if (located.error !== undefined) return located.error;
  if (located.missing === true) {
    // The directory a session works in usually *contains* its repositories
    // rather than being one. status sweeps in exactly this case and prune did
    // not, so from a session's own working directory the reporting action
    // worked and the cleanup action answered "not-a-repo" -- there was no way
    // to clean up at all. A sweep prunes every repository below the reference
    // and reports one entry per repository.
    if (text(args?.repo) !== undefined) {
      return fail('prune', 'not-a-repo', 'No git repository at ' + reference);
    }
    const roots = discoverRepos(reference);
    if (roots.length === 0) {
      return fail('prune', 'not-a-repo', 'No git repository at ' + reference);
    }
    const repos = [];
    for (const dir of roots) {
      if (context.signal?.aborted === true) break;
      repos.push(await prune({ ...args, repo: dir }, context));
    }
    const orphans = repos.flatMap((entry) => (entry.branches ?? []).filter((branch) => branch.kept !== true));
    const namedRemoved = repos.flatMap((entry) => entry.namedBranches ?? []).filter((entry) => entry.removed === true);
    return ok('prune', {
      path: reference,
      swept: true,
      applied: args?.apply === true,
      repos,
      detail: String(repos.length) + ' repository(ies) swept: ' + String(orphans.length + namedRemoved.length)
        + ' orphaned branch(es)'
        + (args?.apply === true ? ' removed' : ' found; pass apply: true to remove them'),
    });
  }
  const repoDir = located.repoDir;
  const base = await resolveBaseBranch(args, config, repoDir);

  const apply = args?.apply === true;
  const result = await sweepTaskBranches(repoDir, config, {
    apply,
    baseRef: 'refs/heads/' + base,
    signal: context.signal,
  });
  if (result.ok !== true) {
    return fail('prune', 'prune-failed', result.error ?? 'Could not prune');
  }
  const removed = (result.branches ?? []).filter((entry) => entry.kept !== true);
  const kept = (result.branches ?? []).filter((entry) => entry.kept === true);

  // A swept branch loses its local ref. Whether the remote still has it is not
  // something the local rules can see, and saying nothing about it is how a task
  // branch stays on a remote forever while prune reports the repository clean.
  // Asked of the remote when a branch is actually removed; a check that cannot
  // run reports nothing rather than claiming the remote is clear.
  if (apply && removed.length > 0) {
    for (const entry of removed) {
      if (typeof entry.branch !== 'string' || entry.branch === '') continue;
      const listed = await git.run(repoDir, ['ls-remote', '--heads', 'origin', 'refs/heads/' + entry.branch], { timeoutMs: config.timeoutMs, signal: context.signal });
      if (listed.ok !== true) continue;
      if (listed.stdout.trim() !== '') entry.remoteKept = true;
    }
  }

  // A squash merge leaves a branch that no local rule can recognise: its content is in
  // the base, its commits are not, and it looks like unmerged work forever. The merge
  // record is the one proof git cannot hold, so it is the one thing worth asking GitHub
  // for — and the only reason `prune` touches the network at all.
  //
  // `merged: false`, a failed query, and a repository with no GitHub remote all mean the
  // same thing here: not proven, so the branch stays exactly as the local rule left it.
  // A branch is never deleted on the strength of a guess.
  const merged = [];
  if (args?.merged !== false) {
    const coords = await githubCoords(repoDir, config, 'prune');
    if (coords.error === undefined) {
      for (const entry of kept) {
        // The local rules kept this branch. The only thing that can still make it
        // disposable is a merged pull request that covers the commit it points at
        // *now*, so the tip is read here and handed over with the question.
        const tip = await branchTip(repoDir, entry.branch, { timeoutMs: config.timeoutMs, signal: context.signal });
        if (tip === undefined) continue;

        const found = await coords.client.findMergedPull({ ...coords.coords, head: entry.branch, tip, base, signal: context.signal });
        if (found.ok !== true) continue;
        if (found.merged !== true) {
          // The reused-slug case, spelled out where the branch is reported. Without
          // it this kept line is indistinguishable from "no pull request exists",
          // and the branch that a merge very nearly deleted reads as ordinary.
          if (found.reason === 'tip-moved') {
            entry.proof = describeProof(found);
            if (found.number !== undefined) entry.mergedPull = found.number;
          }
          continue;
        }

        const record = { branch: entry.branch, sha: tip, number: found.number, url: found.url };
        if (apply) {
          const local = await deleteProvenBranch(repoDir, entry.branch, { timeoutMs: config.timeoutMs, signal: context.signal }, { tip });
          record.deleted = local.ok === true;
          if (local.ok !== true) record.error = local.error;

          // The remote ref goes only when it points at the very commit the pull
          // request merged. The local proof says nothing about what the remote
          // holds, and a remote ref that has moved on holds commits that exist
          // nowhere else.
          const remote = await remoteBranchTip(repoDir, entry.branch, { timeoutMs: config.timeoutMs, signal: context.signal });
          if (remote.ok !== true) {
            record.remoteKept = 'the remote ref could not be read, so it was left alone';
          } else if (remote.sha === undefined) {
            record.remoteAbsent = true;
          } else if (remote.sha !== tip) {
            record.remoteKept = 'the remote ref points at ' + remote.sha.slice(0, 12) + ', not at the merged commit';
          } else {
            const deleted = await coords.client.deleteRemoteBranch({ ...coords.coords, branch: entry.branch, signal: context.signal });
            noteRemoteDelete(record, 'remoteDeleted', deleted);
          }
        }
        merged.push(record);
      }

      // The other half a merge leaves behind: a task branch that exists on the
      // remote with no local ref at all. Action merge deletes the branch it
      // merged, but a branch pushed again afterwards -- or one whose local ref
      // was already pruned -- has nothing local to explain why it is still
      // there, so no local rule can ever see it. Asked of the API, and swept on
      // the same proof as everything else: a pull request from it was merged.
      const listed = await coords.client.listRemoteBranches({ ...coords.coords, prefix: config.branchPrefix, signal: context.signal });
      if (listed.ok === true) {
        for (const branch of listed.branches ?? []) {
          // The endpoint behind this is git/matching-refs, which matches by
          // PREFIX: with a custom prefix that has no separator (`task`) it also
          // returns a user branch named `taskforce`. The namespace boundary is
          // re-applied here, where the answer is used, so a name the local rules
          // would never have called ours can never be swept as a plugin leftover.
          if (!isTaskBranch(config, branch)) continue;
          if (kept.some((entry) => entry.branch === branch) || merged.some((entry) => entry.branch === branch)) continue;

          // A local ref means the rules above already had their say about it.
          const local = await git.run(repoDir, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], { timeoutMs: config.timeoutMs, signal: context.signal });
          if (local.ok === true) continue;

          // There is no local ref, so the remote ref *is* the branch and its commit
          // is the only tip there is to prove anything about. Asked of the remote,
          // because a stale tracking ref is not evidence of where it points.
          const tip = await remoteBranchTip(repoDir, branch, { timeoutMs: config.timeoutMs, signal: context.signal });
          if (tip.ok !== true || tip.sha === undefined) continue;

          const found = await coords.client.findMergedPull({ ...coords.coords, head: branch, tip: tip.sha, base, signal: context.signal });
          if (found.ok !== true || found.merged !== true) continue;

          const record = { branch, sha: tip.sha, number: found.number, url: found.url, remoteOnly: true };
          if (apply) {
            // Asked again, immediately before the delete: the API removes whatever
            // the ref is at that moment, and this is the one deletion that cannot
            // pass the old value as a condition.
            const now = await remoteBranchTip(repoDir, branch, { timeoutMs: config.timeoutMs, signal: context.signal });
            if (now.ok !== true) {
              record.remoteKept = 'the remote ref could not be read again before deleting it';
            } else if (now.sha === undefined) {
              record.remoteAbsent = true;
            } else if (now.sha !== tip.sha) {
              record.remoteKept = 'the remote ref moved to ' + now.sha.slice(0, 12) + ' while this was being decided';
            } else {
              const deleted = await coords.client.deleteRemoteBranch({ ...coords.coords, branch, signal: context.signal });
              noteRemoteDelete(record, 'remoteDeleted', deleted);
            }
          }
          merged.push(record);
        }
      }
    }
  }

  // A branch the caller names by hand.
  //
  // Everything above removes only what it can *prove* disposable, and two real
  // leftovers cannot be proved locally: a squash merge leaves commits the base
  // never received, and a repository whose remote is gone cannot answer whether
  // a pull request was merged. That left such a branch removable by no path at
  // all -- raw git branch -D is denied by the guard, action "finish" never
  // removes a branch, and this action asked GitHub for a proof that no longer
  // existed. So the caller may name the branch. Two conditions still hold: the
  // name must be inside the configured prefix, and no worktree may have it
  // checked out. Nothing is removed unless apply is true.
  const named = [];
  if (Array.isArray(args?.branches)) {
    // The listing answers "is a worktree holding this branch", which is the whole
    // safety argument for a named deletion. Unknown is not an answer.
    const trees = await git.listWorktrees(repoDir, { timeoutMs: config.timeoutMs, signal: context.signal });
    if (trees === undefined) {
      return fail('prune', 'worktree-list-failed', 'The worktree registrations of ' + repoDir + ' could not be read, so no branch was removed');
    }
    const checkedOut = new Set(trees.map((entry) => entry.branch).filter((branch) => typeof branch === 'string'));
    for (const raw of args.branches) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (name === '') continue;
      if (!isTaskBranch(config, name)) {
        named.push({ branch: name, removed: false, error: 'not under the branch prefix ' + config.branchPrefix });
        continue;
      }
      if (checkedOut.has(name)) {
        named.push({ branch: name, removed: false, error: 'a worktree has it checked out' });
        continue;
      }
      const head = await git.run(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name], { timeoutMs: config.timeoutMs, signal: context.signal });
      const sha = head.ok === true ? head.stdout.trim() : undefined;
      if (!apply) {
        named.push(sha === undefined
          ? { branch: name, removed: false, local: false, wouldRemoveRemote: true, note: 'no local branch: the remote ref is what would be removed' }
          : { branch: name, removed: false, wouldRemove: true, sha });
        continue;
      }

      // The local branch may legitimately be gone already -- the sweep above can
      // have just removed it, or it was never here because the branch was only
      // ever pushed. Bailing out in that case is what left remote-only leftovers
      // unreachable, so this half is skipped and the remote ref is still swept.
      const entry = { branch: name, removed: false };
      if (sha !== undefined) {
        entry.sha = sha;
        // Naming the branch is the deliberate act; the sha read above is the proof,
        // and it is passed so git refuses the delete if the branch moves in between.
        const local = await deleteProvenBranch(repoDir, name, { timeoutMs: config.timeoutMs, signal: context.signal }, { tip: sha });
        entry.removed = local.ok === true;
        if (local.ok !== true) entry.error = local.error;
      } else {
        entry.local = false;
      }

      // The remote ref goes with it. Naming a branch is the deliberate act, and
      // a branch that is gone locally but still on the remote is only half
      // cleaned up: it returns as a stale ref on the next fetch, and the next
      // session to push that name puts it back.
      const coords = await githubCoords(repoDir, config);
      if (coords.error === undefined) {
        const remote = await coords.client.deleteRemoteBranch({ ...coords.coords, branch: name, signal: context.signal });
        noteRemoteDelete(entry, 'remoteDeleted', remote);
      } else {
        entry.remoteError = coords.error.error?.message ?? 'the GitHub remote could not be reached';
      }
      named.push(entry);
    }
  }

  const proven = new Set(merged.map((entry) => entry.branch));
  const notes = kept
    .filter((entry) => !proven.has(entry.branch))
    .map((entry) => entry.branch + ': ' + entry.reason + (typeof entry.proof === 'string' ? ' — ' + entry.proof : ''));
  for (const entry of removed) {
    if (entry.remoteKept === true) {
      notes.push(entry.branch + ': the local branch was removed, and the remote still has it — delete the remote ref deliberately, or let a merged pull request close it');
    }
  }
  for (const entry of named) {
    notes.push(entry.branch + ': ' + (entry.removed === true
      ? 'removed'
      : entry.wouldRemove === true ? 'named by the caller; rerun with apply: true to remove it' : String(entry.error ?? 'not removed')));
  }
  for (const entry of merged) {
    notes.push(entry.branch + ': pull request #' + String(entry.number ?? '?') + ' was merged, so the branch is not work'
      + (apply ? (entry.deleted === true ? ' — removed' : ' — could not be removed') : ' — rerun with apply: true to remove it'));
    if (typeof entry.remoteKept === 'string') notes.push(entry.branch + ': the remote ref was kept — ' + entry.remoteKept);
    if (entry.remoteAbsent === true) notes.push(entry.branch + ': the remote had no such ref');
  }

  return ok('prune', {
    path: repoDir,
    base,
    applied: apply,
    branches: result.branches ?? [],
    mergedBranches: merged,
    namedBranches: named,
    detail: removed.length + ' orphaned branch(es)'
      + (apply ? ' removed' : ' found; pass apply: true to remove them')
      + (merged.length > 0 ? '; ' + String(merged.length) + ' branch(es) proven merged by their pull request' : ''),
    notes,
  });
}

/** The action table, keyed by the names the tool and the guard both use. */
/**
 * Clone a repository.
 *
 * The one action that gets a repository rather than assuming one is already
 * there. Clones into `path`, or into the working directory's basename when no
 * path is given, and returns the state of the clone so the caller has the
 * branch, the remote and the path it landed in.
 */
export async function clone(args, context) {
  const { config, reference } = context;
  const signal = context.signal;
  const url = text(args?.url);
  if (url === undefined) {
    return fail('clone', 'missing-url', 'Clone needs a repository URL.',
      'Pass `url` — for example https://github.com/owner/repo.git, or git@github.com:owner/repo.git.');
  }

  // Where the clone lands. `path` is honoured as given; otherwise the URL's
  // last segment, minus a trailing `.git`, is the directory name.
  const pathArg = text(args?.path);
  const fallbackName = url.split('/').pop()?.replace(/\.git$/u, '') ?? 'repo';
  const target = pathArg !== undefined
    ? (isAbsolute(pathArg) ? pathArg : resolvePath(reference, pathArg))
    : resolvePath(reference, fallbackName);

  const parent = dirname(target);
  if (!existsSync(parent)) {
    return fail('clone', 'missing-parent', 'The directory to clone into does not exist: ' + parent,
      'Create it first, or pass `path` with a location whose parent exists.');
  }
  if (existsSync(target)) {
    return fail('clone', 'target-exists', 'Something is already at ' + target,
      'Pass a different `path`, or run action "status" on it if it is already a repository.');
  }

  const branch = text(args?.branch);
  const argv = ['clone'];
  if (branch !== undefined) argv.push('--branch', branch);
  argv.push(url, target);

  const result = await git.run(parent, argv, { timeoutMs: config.timeoutMs, signal, allowFailure: true });
  if (result.ok !== true) {
    const detail = String(result.stderr ?? '').trim() || String(result.error ?? '') || 'git clone failed';
    return fail('clone', 'clone-failed', detail,
      'Check the URL and that this machine can reach it. A private repository needs a credential on the machine.');
  }

  const report = await repoReport(target, config, context.sessionId, { signal });
  return ok('clone', { path: target, remote: url, repo: report });
}

/**
 * Create a new repository.
 *
 * The counterpart to `clone`: where `clone` gets an existing one, this makes an
 * empty one. `path` is where it lands — the working directory when omitted —
 * and `branch` names the initial branch, which git would otherwise call
 * `master`.
 */
export async function init(args, context) {
  const { config, reference } = context;
  const signal = context.signal;
  const pathArg = text(args?.path);
  const target = pathArg !== undefined
    ? (isAbsolute(pathArg) ? pathArg : resolvePath(reference, pathArg))
    : reference;

  // `git init` creates the directory itself when it does not exist, which is
  // the point of the action: making a repo where there was not one. Only the
  // parent has to be there.
  const parent = dirname(target);
  if (!existsSync(parent)) {
    return fail('init', 'missing-parent', 'The parent directory does not exist: ' + parent,
      'Create it first, or pass `path` with a location whose parent exists.');
  }
  if (existsSync(target) && await git.isRepo(target)) {
    return fail('init', 'already-repo', 'That is already a repository: ' + target,
      'Run action "status" on it instead.');
  }

  const branch = text(args?.branch);
  const argv = ['init'];
  if (branch !== undefined) argv.push('-b', branch);
  argv.push(target);

  // Run from the parent, not from `target` — the target does not exist yet, and
  // `git init <path>` creates it.
  const result = await git.run(parent, argv, { timeoutMs: config.timeoutMs, signal, allowFailure: true });
  if (result.ok !== true) {
    return fail('init', 'init-failed', String(result.stderr ?? '').trim() || String(result.error ?? '') || 'git init failed');
  }

  const report = await repoReport(target, config, context.sessionId, { signal });
  return ok('init', { path: target, repo: report });
}

export const ACTIONS = { clone, init, status, save, publish, sync, pr, merge, finish, prune };

/** Run one action by name, resolving config and turning any throw into an envelope. */
export async function runAction(name, args, context) {
  const handler = ACTIONS[name];
  if (handler === undefined) {
    return fail(name, 'unknown-action', 'Unknown action: ' + name, 'One of: ' + Object.keys(ACTIONS).join(', '));
  }
  const config = resolveConfig(context.config);
  try {
    return await handler(args ?? {}, { ...context, config });
  } catch (error) {
    return fail(name, 'action-threw', error?.message ?? String(error));
  }
}
