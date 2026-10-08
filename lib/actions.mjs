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
 * the model — which repository, which branch to cut from, whether a push is
 * safe, whether a worktree may be deleted — it is computed here from the
 * repository itself and stated in the result.
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import * as git from './git.mjs';
import * as worktrees from './worktrees.mjs';
import * as state from './state.mjs';
import { createGithubClient, parseRemote } from './github.mjs';
import { resolveConfig, isProtectedBranch, isTaskBranch, protectedList, worktreeRootFor } from './config.mjs';
import { turnSubject } from './render.mjs';

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
 * worktree un-closed and every later `finish` failing the same way.
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

/** One repository's full state, including which worktrees of it this session owns. */
export async function repoReport(repoDir, config, sessionId, options = {}) {
  const repoState = await git.repoState(repoDir, { timeoutMs: config.timeoutMs, signal: options.signal });
  if (repoState.ok !== true) {
    return { ...repoState, path: repoDir, ok: false, error: repoState.error ?? { code: 'state-failed', message: 'Could not read repository state' } };
  }
  const report = { ...repoState, path: repoDir, verdict: undefined };
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

/** The worktrees of a repository, marked with ownership and dirty state. */
async function worktreeReport(repoDir, config, options = {}) {
  const trees = await git.listWorktrees(repoDir, { timeoutMs: config.timeoutMs, signal: options.signal });
  // The root this session would create worktrees in, so ownership is judged
  // against the same directory the worktrees were actually made in.
  const root = worktreeRootFor(config, options.reference);
  const rows = [];
  for (const tree of trees) {
    const owned = worktrees.isOwnedWorktree(root, undefined, undefined, tree.path);
    rows.push({ ...tree, owned });
  }
  return rows;
}

/**
 * The worktree this session already owns for a repository, if any.
 *
 * Matching is by repository root *and* slug when a slug is given, because a
 * session legitimately works on more than one task in a repository. Matching on
 * the repository alone would answer "you already have a worktree" to a request
 * for a second one, and the second task would be pushed into the first task's
 * branch.
 */
function registeredWorktree(sessionId, repoDir, config, slug) {
  const session = state.readSession(sessionId, { stateRoot: config.stateRoot });
  const forRepo = session.worktrees.filter((entry) => entry.repoRoot === repoDir);
  if (slug !== undefined) return forRepo.find((entry) => entry.slug === slug);
  return forRepo[0];
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
      if (found.ok && found.pull !== undefined) fields.pull = found.pull;
    }
  }

  // Push failures are recorded against the main repository root, so a status
  // asked for from inside a worktree still finds the failure that belongs to the
  // repository it is part of.
  const session = state.readSession(sessionId, { stateRoot: config.stateRoot });
  const failure = session.pushFailures[repo.repoRoot ?? repoDir];
  if (failure !== undefined) {
    fields.pushFailure = { error: failure.error, attempts: failure.attempts, nextAttemptAt: failure.nextAttemptAt };
  }
  return ok('status', fields);
}

/**
 * `start` — a worktree for one task, or the one this session already has.
 *
 * Reuse is deliberate and is what makes the action safe to call on every task:
 * a second call for the same session and repository returns the worktree it
 * already owns rather than creating a second one and splitting the work.
 */
export async function start(args, context) {
  const { config, sessionId, reference } = context;
  const signal = context.signal;
  const located = await locateRepo(args, config, reference);
  if (located.error !== undefined) return located.error;
  if (located.missing === true) {
    return fail('start', 'not-a-repo', 'No git repository at ' + reference, 'Pass repo pointing at the repository, or create one first.');
  }
  const repoDir = located.repoDir;

  // The main repository root is what the session registry is keyed by. Creating
  // the worktree is the one operation that must run against a repository whose
  // identity is not the path the caller happens to be standing in.
  const mainRepoRoot = await mainRepoRootOf(repoDir);

  const requested = text(args?.slug) ?? text(args?.task) ?? 'task';
  const existing = registeredWorktree(sessionId, mainRepoRoot, config, requested);
  if (existing !== undefined && existsSync(existing.path)) {
    return ok('start', { path: mainRepoRoot, worktree: existing.path, branch: existing.branch, slug: existing.slug, reused: true });
  }

  const base = await resolveBaseBranch(args, config, mainRepoRoot);
  const created = await worktrees.createWorktree(mainRepoRoot, {
    worktreeRoot: worktreeRootFor(config, reference),
    branchPrefix: config.branchPrefix,
    slug: requested,
    baseBranch: base,
    signal,
    timeoutMs: config.timeoutMs,
  });
  if (created.ok !== true) {
    return fail('start', created.code ?? 'worktree-failed', created.error ?? 'Could not create a worktree', created.hint);
  }
  // Registered by PATH, not by slug and not by a bare repository match: the
  // session registry treats a same-repository entry as a replacement, so a
  // session legitimately working on two tasks at once would have its first
  // worktree silently forgotten and later left behind on disk. `addWorktree`
  // keys on the path first, which is the identity of a worktree.
  state.addWorktree(sessionId, {
    repo: mainRepoRoot.split('/').pop(),
    repoRoot: mainRepoRoot,
    path: created.path,
    branch: created.branch,
    slug: created.slug,
    createdAt: new Date().toISOString(),
  }, { stateRoot: config.stateRoot });

  return ok('start', {
    path: mainRepoRoot,
    worktree: created.path,
    branch: created.branch,
    slug: created.slug,
    base: created.base,
    reused: created.reused === true,
  });
}

/**
 * `commit` — stage exactly what was named, then commit.
 *
 * Naming paths is the default because the opposite — `add -A` — is how a
 * session sweeps up work another session or the user left uncommitted, which is
 * the incident this plugin is written after. Staging everything stays available
 * and stays explicit.
 */
export async function commit(args, context) {
  const { config, sessionId, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, sessionId, reference, 'commit');
  if (dir.error !== undefined) return dir.error;

  const paths = Array.isArray(args?.paths) ? args.paths.filter((entry) => typeof entry === 'string' && entry !== '') : undefined;
  const all = args?.all === true || (paths === undefined && args?.paths === undefined);

  // `git.commit` owns staging: with `all` it stages every dirty path itself,
  // including untracked ones, and with `paths` it stages exactly those. Staging
  // separately would be a second `git add` racing the first.
  const stagedPaths = paths ?? (await git.changedPaths(dir.repoDir, { timeoutMs: config.timeoutMs, signal }));
  const message = text(args?.message) ?? turnSubject(0, stagedPaths).replace('dsh: turn 0 — ', 'dsh: ');
  const committed = await git.commit(dir.repoDir, message, {
    all,
    paths: all ? undefined : paths,
    timeoutMs: config.timeoutMs,
    signal,
  });
  if (committed.ok !== true) {
    if (isNothingToCommit(committed.error)) {
      return ok('commit', { path: dir.repoDir, committed: false, branch: dir.branch });
    }
    return fail('commit', committed.code ?? 'commit-failed', committed.error ?? 'Could not commit');
  }

  const fields = {
    path: dir.repoDir,
    committed: true,
    sha: committed.sha,
    branch: dir.branch,
    subject: message.split('\n')[0],
    paths: (await git.run(dir.repoDir, ['show', '--name-only', '--format=', '-z', 'HEAD'], { timeoutMs: config.timeoutMs, signal })).stdout
      .split('\0')
      .filter((entry) => entry !== ''),
  };

  if (args?.push === true) {
    const pushed = await pushBranch(dir.repoDir, config, sessionId, { signal, allowProtected: args?.allowProtected === true }, dir.mainRepoDir);
    fields.pushed = pushed.pushed;
    fields.remote = pushed.remote;
    if (pushed.ok !== true) fields.notes = [pushed.error ?? 'push failed'];
  }
  return ok('commit', fields);
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
  const trees = await git.listWorktrees(workingDir);
  const first = trees[0];
  if (first !== undefined && typeof first.path === 'string' && first.path !== '') return first.path;
  return workingDir;
}

/** Resolve the directory a mutating action should work in: the named worktree, else the repo. */
async function resolveTargetDir(args, config, sessionId, reference, action) {
  const located = await locateRepo(args, config, reference);
  if (located.error !== undefined) return { error: { ...located.error, action } };
  if (located.missing === true) {
    return { error: fail(action, 'not-a-repo', 'No git repository at ' + reference) };
  }
  const workingDir = located.repoDir;
  const mainRepoRoot = await mainRepoRootOf(workingDir);
  const session = state.readSession(sessionId, { stateRoot: config.stateRoot });
  const owned = session.worktrees.filter((entry) => entry.repoRoot === mainRepoRoot && existsSync(entry.path));

  // The worktree the caller named, and nothing else. `reference` is inside an
  // owned worktree only when the caller actually asked for that worktree.
  //
  // The main checkout is deliberately NOT redirected into a worktree the session
  // happens to own: "finish" asked from the repository means the repository, and
  // falling back to an owned worktree would commit and push a different branch
  // than the caller named — silently, and in the wrong place. There is also no
  // "only one, so it must be that one" guess for the same reason.
  const chosen = owned.find((entry) => isInside(entry.path, reference));
  const target = chosen?.path ?? workingDir;
  const branch = await git.currentBranch(target);
  return { repoDir: target, mainRepoDir: mainRepoRoot, branch, worktree: chosen?.path };
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
  const upstream = await git.run(repoDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeoutMs: config.timeoutMs, signal: options.signal });
  const hasUpstream = upstream.ok && text(upstream.stdout) !== undefined;
  // No setUpstream override: `git.push` points the branch at itself when it has
  // no upstream *or* when it tracks something else. That second case is the
  // important one — `git worktree add` leaves a new task branch tracking
  // `origin/<base>`, so forcing `setUpstream:false` here would leave the branch
  // reporting sync against the base it was cut from instead of its own remote.
  const result = await git.push(repoDir, { timeoutMs: config.timeoutMs, signal: options.signal });
  if (result.ok !== true) {
    state.recordPushFailure(sessionId, stateKey, result.error ?? 'push failed', { stateRoot: config.stateRoot });
    return { ok: false, pushed: false, branch, remote: 'origin', error: result.error ?? 'push failed' };
  }
  state.clearPushFailure(sessionId, stateKey, { stateRoot: config.stateRoot });
  return {
    ok: true,
    pushed: result.pushed !== false,
    branch,
    remote: result.remote ?? 'origin',
    setUpstream: result.setUpstream === true || !hasUpstream,
  };
}

export async function push(args, context) {
  const { config, sessionId, reference } = context;
  const dir = await resolveTargetDir(args, config, sessionId, reference, 'push');
  if (dir.error !== undefined) return dir.error;
  const result = await pushBranch(dir.repoDir, config, sessionId, {
    signal: context.signal,
    allowProtected: args?.allowProtected === true,
  }, dir.mainRepoDir);
  if (result.ok !== true) {
    return fail('push', result.code ?? 'push-failed', result.error ?? 'push failed', result.hint);
  }
  return ok('push', { path: dir.repoDir, branch: result.branch, remote: result.remote, pushed: result.pushed, setUpstream: result.setUpstream });
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
  const { config, sessionId, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, sessionId, reference, 'sync');
  if (dir.error !== undefined) return dir.error;
  const repoDir = dir.repoDir;

  const fetched = await git.fetch(repoDir, 'origin', { timeoutMs: Math.max(config.timeoutMs, 30000), signal });
  if (fetched.ok !== true) {
    return fail('sync', 'fetch-failed', fetched.error ?? 'Could not fetch origin');
  }

  const branch = dir.branch;
  const base = await resolveBaseBranch(args, config, repoDir);
  const baseRef = 'origin/' + base;

  // On a task branch: bring the base in by fast-forward only when the branch has
  // no commits of its own to lose.
  if (branch !== undefined && branch !== base) {
    const sync = await git.computeSync(repoDir, baseRef, { timeoutMs: config.timeoutMs, signal });
    if (sync === undefined) {
      return fail('sync', 'no-base', 'Could not compare with ' + baseRef);
    }
    if (sync.behind > 0 && sync.ahead === 0) {
      const moved = await git.fastForward(repoDir, baseRef, { timeoutMs: config.timeoutMs, signal });
      if (moved.ok === true && moved.moved === true) {
        return ok('sync', { path: repoDir, base, fastForwarded: true, from: moved.from, to: moved.to });
      }
      return fail('sync', 'fast-forward-failed', moved.error ?? 'Could not fast-forward');
    }
    return ok('sync', {
      path: repoDir,
      base,
      fastForwarded: false,
      detail: sync.ahead > 0 && sync.behind > 0
        ? 'branch has diverged from ' + base + ' (' + sync.ahead + ' ahead, ' + sync.behind + ' behind) — rebase or merge it deliberately'
        : 'up to date with ' + base,
    });
  }

  // On the base branch itself: only a fast-forward, never a merge.
  const moved = await git.fastForward(repoDir, baseRef, { timeoutMs: config.timeoutMs, signal });
  if (moved.ok === true && moved.moved === true) {
    return ok('sync', { path: repoDir, base, fastForwarded: true, from: moved.from, to: moved.to });
  }
  return ok('sync', { path: repoDir, base, fastForwarded: false, detail: moved.error ?? 'up to date with ' + base });
}

/** The GitHub coordinates of a repository's origin, or a failure envelope. */
async function githubCoords(repoDir, config) {
  const remote = await git.remoteUrlFor(repoDir, 'origin');
  if (remote === undefined) {
    return { error: fail('pr', 'no-remote', 'No origin remote configured') };
  }
  const parsed = parseRemote(remote, config.githubHost);
  if (parsed === undefined) {
    return { error: fail('pr', 'not-github', 'Origin is not a ' + config.githubHost + ' remote: ' + remote) };
  }
  return { coords: parsed, client: createGithubClient({ host: config.githubHost, timeoutMs: config.timeoutMs }) };
}

/**
 * `pr` — open a pull request, or return the one already open.
 *
 * Idempotent on purpose: a session that calls this twice must not fail the
 * second time, because a failure it cannot read as "already done" teaches it to
 * reach for `gh` instead — the exact drift this plugin removes.
 */
export async function pr(args, context) {
  const { config, sessionId, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, sessionId, reference, 'pr');
  if (dir.error !== undefined) return dir.error;
  const repoDir = dir.repoDir;

  const coords = await githubCoords(repoDir, config);
  if (coords.error !== undefined) return coords.error;
  const { client } = coords;

  const available = await client.isAvailable();
  if (available.ok !== true) {
    return fail('pr', available.code ?? 'no-credentials', available.error ?? 'No GitHub credentials available', 'Run `gh auth login`, or set GH_TOKEN.');
  }

  const branch = await git.currentBranch(repoDir);
  const base = await resolveBaseBranch(args, config, repoDir);
  if (branch === undefined) return fail('pr', 'detached', 'Detached HEAD: there is no branch to open a pull request from');
  if (branch === base) {
    return fail('pr', 'same-branch', 'The current branch is ' + base + ' itself, so there is nothing to compare', 'Create a worktree with action "start" and commit there.');
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
    'Built and verified in an isolated worktree under `~/.dsh/worktrees`, then committed and pushed automatically.',
    '',
    'Compare against `' + base + '` for the full diff.',
  ].join('\n');
}

/** `merge` — merge a pull request, then clean up only what this plugin owns. */
export async function merge(args, context) {
  const { config, sessionId, reference } = context;
  const signal = context.signal;
  const dir = await resolveTargetDir(args, config, sessionId, reference, 'merge');
  if (dir.error !== undefined) return dir.error;
  const repoDir = dir.repoDir;

  const coords = await githubCoords(repoDir, config);
  if (coords.error !== undefined) return coords.error;
  const { client } = coords;

  const branch = await git.currentBranch(repoDir);
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
    method: ['squash', 'merge', 'rebase'].includes(args?.method) ? args.method : 'merge',
    signal,
  });
  if (merged.ok !== true && merged.code !== 'not-open') {
    return fail('merge', merged.code ?? 'merge-failed', merged.error ?? 'Could not merge');
  }

  const fields = {
    path: repoDir,
    number: target,
    merged: merged.merged === true,
    sha: merged.sha,
    method: args?.method ?? 'merge',
  };

  if (merged.merged === true) {
    if (branch !== undefined) {
      const deleted = await client.deleteRemoteBranch({ ...coords.coords, branch, signal });
      fields.remoteBranchDeleted = deleted.ok === true && deleted.deleted !== false;
    }
    fields.notes = ['the local checkout was left alone: deleting a branch by name from a shared checkout can remove another worktree\'s branch'];
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
  const dir = await resolveTargetDir(args, config, sessionId, reference, 'finish');
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
    const message = text(args?.message) ?? turnSubject(0, await git.changedPaths(repoDir, { timeoutMs: config.timeoutMs, signal })).replace('dsh: turn 0 — ', 'dsh: ');
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
  }

  const branch = pushed.branch ?? before.branch;
  const base = await resolveBaseBranch(args, config, repoDir);

  if (args?.pr !== false && pushed.ok === true) {
    // Opening a pull request needs a GitHub remote, and `finish` is the action a
    // session actually calls. Asking the GitHub client directly — through the
    // same helper `pr` uses — keeps the reason in the same place as the action
    // that reports it, instead of a nested call whose failure envelope has to be
    // re-read and re-worded.
    const coords = await githubCoords(repoDir, config);
    if (coords.error !== undefined) {
      fields.prSkipped = coords.error.error.message;
    } else {
      const result = await pr({ base, draft: args?.draft, title: args?.title, body: args?.body, repo: repoDir }, context);
      if (result.ok === true) {
        fields.pull = { number: result.number, url: result.url, state: result.state, draft: result.draft };
      } else {
        fields.prSkipped = result.error?.message ?? 'not opened';
      }
    }
  } else if (pushed.ok !== true) {
    fields.prSkipped = 'the branch is not pushed yet';
  }

  if (args?.cleanup === true && dir.worktree !== undefined) {
    // Removal runs from the main checkout, never from inside the worktree being
    // removed: git refuses to remove the worktree it is currently operating in,
    // and the refusal reads as "the worktree is dirty" when it is not.
    const from = dir.mainRepoDir ?? repoDir;
    const removed = await worktrees.removeWorktree(from, dir.worktree, { timeoutMs: config.timeoutMs });
    if (removed.ok === true && removed.removed === true) {
      fields.worktreeRemoved = true;
      state.removeWorktree(sessionId, from, { stateRoot: config.stateRoot });
    } else {
      fields.worktreeKept = true;
      notes.push(removed.error ?? 'worktree kept: it still holds uncommitted or unmerged work');
      if (Array.isArray(removed.dirty) && removed.dirty.length > 0) {
        notes.push('uncommitted there: ' + removed.dirty.slice(0, 10).join(', '));
      }
    }
  } else if (dir.worktree !== undefined) {
    fields.worktreeKept = true;
  }

  if (notes.length > 0) fields.notes = notes;
  return ok('finish', fields);
}

/**
 * `prune` — tidy up what this plugin left behind.
 *
 * Every other action refuses to delete things, and the guard denies the raw git
 * equivalents outright. That is right for branches and worktrees somebody may be
 * using — but it left the plugin unable to clean up after *itself*, which is how
 * a failed creation's orphan branch became permanent. This is the narrow door,
 * and it opens only onto the plugin's own leftovers: a worktree registration
 * whose directory is gone, and a branch under its own prefix that no worktree
 * has checked out and that holds no commit the base branch does not already
 * have. A branch with work of its own is reported, never deleted.
 *
 * Dry run by default. `apply: true` is the caller saying they have read the list.
 */
export async function prune(args, context) {
  const { config, reference } = context;
  const located = await locateRepo(args, config, reference);
  if (located.error !== undefined) return located.error;
  if (located.missing === true) {
    return fail('prune', 'not-a-repo', 'No git repository at ' + reference);
  }
  const repoDir = located.repoDir;
  const base = await resolveBaseBranch(args, config, repoDir);

  // Where the plugin's own scratch sits, as pathspecs relative to this repository.
  // Both shapes are needed. The worktree root itself when it is inside the
  // repository — and its directory name at the repository root in every case,
  // because a suite that runs the tool with no session derives the root from its
  // own working directory, which is how the same namespace ends up inside whatever
  // repository is being tested.
  const scratchPaths = [];
  const root = worktreeRootFor(config, reference);
  const inside = relative(repoDir, root);
  if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) scratchPaths.push(inside.split(sep).join('/'));
  const rootName = basename(root);
  if (rootName !== '' && rootName !== '.' && rootName !== '..' && !scratchPaths.includes(rootName)) scratchPaths.push(rootName);

  const result = await worktrees.pruneWorktrees(repoDir, {
    apply: args?.apply === true,
    branchPrefix: config.branchPrefix,
    baseRef: 'refs/heads/' + base,
    scratchPaths,
    timeoutMs: config.timeoutMs,
    signal: context.signal,
  });
  if (result.ok !== true) {
    return fail('prune', 'prune-failed', result.error ?? 'Could not prune');
  }
  const removed = (result.branches ?? []).filter((entry) => entry.kept !== true);
  const kept = (result.branches ?? []).filter((entry) => entry.kept === true);
  return ok('prune', {
    path: repoDir,
    base,
    applied: result.dryRun !== true,
    worktrees: result.entries ?? [],
    branches: result.branches ?? [],
    detail: removed.length + ' orphaned branch(es) and ' + (result.entries ?? []).length + ' stale worktree(s)'
      + (result.dryRun === true ? ' found; pass apply: true to remove them' : ' removed'),
    notes: kept.map((entry) => entry.branch + ': ' + entry.reason),
  });
}

/** The action table, keyed by the names the tool and the guard both use. */
export const ACTIONS = { status, start, commit, push, sync, pr, merge, finish, prune };

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
