/**
 * The end-of-turn sync: what makes "nothing gets forgotten" true without
 * trusting a model to remember.
 *
 * Every other part of this plugin is an operation a caller may or may not use.
 * This part runs by itself, at the boundary of every turn that changed a file,
 * and it exists because the failure being fixed was never a missing command —
 * it was a command nobody ran. A plugin that only supplies better commands
 * reproduces that failure with better commands.
 *
 * Five constraints shape the implementation, and each comes from something
 * verified against this Harness rather than assumed:
 *
 *   1. `agent/turn-stopping` is a serial, awaited event, and the shipped
 *      `@deepseek-ai/dsh-workspace-changes` recorder already uses it to write its
 *      per-turn snapshot inside that chain. So this handler never does its work
 *      inline: it registers the work and returns. The user's turn closes on
 *      time, and the recorder is not delayed behind a commit, a fetch, or a
 *      network push.
 *
 *   2. The turn's changed-file list is read from the recorder's own
 *      `workspace/changes` event, captured when the recorder appends it, rather
 *      than guessed through a sequence number this plugin cannot compute. When
 *      that list is present it decides which repositories were touched, so a
 *      turn that edited one repository never commits another one, however dirty
 *      that other repository happens to be.
 *
 *   3. When the list is not available — the recorder is not mounted, the event
 *      has not landed yet, or a Host restarted mid-turn — the fallback is a
 *      bounded scan for repositories with a dirty working tree. That fallback is
 *      deliberately the blunt instrument: the first promise of this plugin is
 *      that no work is left uncommitted, and it outranks the preference for
 *      committing only what the turn touched. The commit message names the turn,
 *      so the result stays attributable either way.
 *
 *   4. Within a touched repository, everything dirty is committed. Narrowing the
 *      commit to files the turn edited would leave a file the turn edited and a
 *      file it did not, both uncommitted, with no later turn likely to notice.
 *
 *   5. One sync runs per session at a time. The automatic half has several
 *      triggers — a quiet period, the ceiling under it, and the two turn
 *      boundaries — and any two of them can land in the same window. Two runs
 *      over one worktree race on the same index and the same ref: the second
 *      commit meets the first one's lock and the second push is rejected. So a
 *      trigger that arrives while a sync is running is folded into exactly one
 *      follow-up run. It is deferred, never dropped.
 *
 * What is never done here: pushing a protected branch, pushing a branch that is
 * neither a task branch nor the branch of a worktree this session owns, or
 * committing during a merge, a rebase or a cherry-pick.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import * as git from './git.mjs';
import * as state from './state.mjs';
import { resolveConfig } from './config.mjs';
import { isProtectedBranch, isTaskBranch } from './config.mjs';
import { turnSubject } from './render.mjs';
import { discoverRepos, isNothingToCommit, closeLandedWorktrees, closeMergedWorktrees } from './actions.mjs';
import { reposOf, pathsOf, forgetRepo } from './session-files.mjs';

/** How long to wait for the turn's changed-file list before falling back. */
const SUMMARY_WAIT_MS = 2000;

/** How often to re-check for the list while waiting for the recorder to finish. */
const SUMMARY_POLL_MS = 100;

/**
 * How long a session must be quiet before its turn is treated as over.
 *
 * The unit of the automatic half. Long enough that the edits of one turn arrive
 * as one commit, short enough that the commit follows the answer while the user
 * is still looking at it. A session that keeps calling tools never reaches it; a
 * session that stops reaches it once, with no further tool call needed.
 */
const SETTLE_MS = 4000;

/**
 * The longest a busy session may go between automatic syncs.
 *
 * The quiet period is the trigger; this is the floor under it. A session in an
 * unbroken burst of tool calls never reaches a quiet period, and "no quiet period
 * yet" must not mean "nothing committed for an hour" — a crash would take all of
 * it. This is the throttle the tools boundary used to run on alone, kept as a
 * ceiling now that it is no longer the trigger.
 */
const SYNC_CEILING_MS = 60000;

/**
 * Append one line about a boundary firing.
 *
 * This exists because the failure being fixed was silent: a turn boundary that
 * never arrives is indistinguishable from a turn that had nothing to do, and
 * there was no way to tell which from outside the Host. Anything written here is
 * diagnostics only, and it never throws into a turn.
 */
function noteBoundary(stateRoot, line) {
  try {
    const dir = join(stateRoot, 'dsh-git');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'boundary.log'), new Date().toISOString() + ' ' + line + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* diagnostics are never worth failing a turn over */
  }
}

/** The trailer that makes an automatic commit identifiable after the fact. */
export const TRAILER = 'Assisted-by: DSH';

/**
 * Turn-end work accepted and not finished, so disposal can wait for it rather
 * than orphan it. A request folded into a follow-up counts from the moment it is
 * accepted, because that is work disposal still has to wait for; it is not a
 * gate, and it never was one.
 */
const inflight = new Set();

/** How many turn-end syncs are still running or still owed a run. Exported for diagnostics; nothing in the plugin reads it yet. */
export function inflightCount() {
  return inflight.size;
}

/** Wait for a value to appear, up to a deadline. Returns undefined when it does not. */
async function waitFor(read, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? SUMMARY_WAIT_MS);
  const signal = options.signal;
  for (;;) {
    if (signal?.aborted === true) return undefined;
    let value;
    try {
      value = read();
    } catch {
      value = undefined;
    }
    if (value !== undefined && value !== null) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((settle) => setTimeout(settle, options.pollMs ?? SUMMARY_POLL_MS));
  }
}

/** Whether a path sits inside a repository's working tree. */
function insideRepo(repoDir, absolute) {
  const rel = relative(repoDir, absolute);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** A realpath, or the path itself when it cannot be resolved. */
function realpathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The caller's signal, with its own deadline when it has none. */
function withDeadline(signal, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  if (signal === undefined || signal === null) return deadline;
  try {
    return AbortSignal.any([signal, deadline]);
  } catch {
    return deadline;
  }
}

/**
 * The repositories a turn touched.
 *
 * Three sources, in order of precision:
 *
 *   1. The paths the shipped turn recorder captured, reconciled to repositories.
 *   2. This session's own touched-path record, consulted when the recorder's
 *      list is unavailable. It covers edits made through the file tools, so a
 *      session that is the only one working is still fully covered.
 *   3. A scan of the working directory for repositories with something to
 *      commit — only when `turnSyncScope` is `workspace`.
 *
 * Worktrees this session owns are always in scope. A worktree exists so that
 * work the main checkout cannot see still gets committed and pushed, and it is
 * unambiguously this session's.
 *
 * The scan is not the default because it cannot tell this session's work from
 * another session's. Once several sessions share a checkout — which is what an
 * Agent Team is — committing every dirty repository under the working directory
 * commits a teammate's work in progress under this session's turn number. So by
 * default a repository the session never touched is left alone. It is not
 * silently ignored either: the turn-end result says so, and `status` keeps
 * reporting it.
 */
async function touchedRepos(cwd, paths, config, options = {}) {
  const found = new Map();

  for (const entry of state.readSession(options.sessionId, { stateRoot: config.stateRoot }).worktrees) {
    if (existsSync(entry.path)) found.set(entry.path, true);
  }

  if (paths !== undefined && paths.length > 0) {
    const roots = await Promise.all(paths.map((path) => {
      const absolute = isAbsolute(path) ? path : resolvePath(cwd, path);
      // `toplevel` accepts a file path, because that is the case it has to
      // serve: the input is a list of changed files, not directories.
      return git.toplevel(absolute);
    }));
    for (const root of roots) {
      if (root !== undefined) found.set(root, true);
    }
    // Deliberately no early return. The recorder announces its summary once per
    // turn, at the turn's END, and the sync now runs while a turn is still going —
    // so the newest summary it can offer is the previous turn's. Returning here
    // made that stale list the whole answer, and a repository this turn changed
    // and last turn did not was dropped from the commit entirely.
  }

  // The session's own record, always consulted, and never as a last resort.
  const recorded = reposOf(options.sessionId, { stateRoot: config.stateRoot });
  for (const repoRoot of recorded) {
    if (existsSync(repoRoot)) found.set(repoRoot, true);
  }

  // The working directory itself is in scope only when this session recorded
  // work in it. Adding it unconditionally would reinstate exactly the bug this
  // narrowing removes: a shared checkout is dirty because somebody else is
  // working in it, and this session would commit their work under its own turn.
  const own = await git.toplevel(cwd);
  if (own !== undefined && recorded.includes(own)) found.set(own, true);

  if (config.turnSyncScope === 'workspace') {
    for (const dir of discoverRepos(cwd)) {
      if (found.has(dir)) continue;
      const repoState = await git.repoState(dir, { timeoutMs: config.timeoutMs, signal: options.signal });
      if (repoState.ok === true && repoState.dirty === true) found.set(dir, true);
    }
  }

  return [...found.keys()];
}

/** The commit message for one turn commit: configured template, else generated. */
export function messageFor(config, turn, paths) {
  const template = typeof config.turnCommitMessage === 'string' ? config.turnCommitMessage.trim() : '';
  const generated = turnSubject(turn, paths);
  const body = template === ''
    ? generated
    : template
      .replace(/\{turn\}/gu, Number.isInteger(turn) ? String(turn) : '')
      .replace(/\{paths\}/gu, paths.join(', '));
  return body + '\n\n' + TRAILER;
}

/**
 * Whether a branch may be pushed automatically.
 *
 * The asymmetry is the whole point of the plugin: committing is always safe and
 * is what stops work being lost, while pushing is safe only onto a branch that
 * exists for this session's own work. A turn commit on a protected branch is
 * committed and reported unpushed, never pushed.
 */
export function pushDecision(config, branch, ownedBranches) {
  if (branch === undefined) return { allowed: false, reason: 'detached HEAD' };
  if (isProtectedBranch(config, branch)) {
    return { allowed: false, reason: branch + ' is a protected branch' };
  }
  if (isTaskBranch(config, branch) || ownedBranches.includes(branch)) {
    return { allowed: true, reason: 'task branch' };
  }
  return { allowed: false, reason: branch + ' is not a task branch or an owned worktree branch' };
}

/**
 * Sync one repository: commit everything dirty, then push when the branch is
 * one automatic push may touch.
 *
 * Returns a record of what happened, including why nothing happened — a sync
 * that quietly declined is indistinguishable from one that found nothing to do,
 * and that silence is the failure this plugin exists to end.
 */
export async function syncRepo(repoDir, config, sessionId, paths, options = {}) {
  const signal = options.signal;
  const timeoutMs = config.timeoutMs;
  const notes = [];
  // Only a turn the Host actually reported is a turn. The automatic boundary in
  // this deployment has no number to give — it is driven from the tools layer,
  // which never knew one — and defaulting to 0 put "dsh: turn 0" on every
  // automatic commit ever made here, a number true of no turn at all.
  const turn = Number.isInteger(options.turn) ? options.turn : undefined;

  const before = await git.repoState(repoDir, { timeoutMs, signal });
  if (before.ok !== true) {
    return { repo: repoDir, committed: false, pushed: false, notes: [before.error?.message ?? 'could not read repository state'] };
  }
  if (before.rebaseInProgress === true || before.mergeInProgress === true || before.cherryPickInProgress === true) {
    return {
      repo: repoDir,
      committed: false,
      pushed: false,
      notes: ['a merge, rebase or cherry-pick is in progress, so the automatic commit is paused'],
    };
  }
  if (before.detached === true) {
    return { repo: repoDir, committed: false, pushed: false, notes: ['detached HEAD, so the automatic commit is skipped'] };
  }

  const result = { repo: repoDir, branch: before.branch, committed: false, pushed: false, notes };

  if (before.dirty === true && config.turnCommit === false) {
    // The setting is documented, so it has to do something. Committing nothing
    // and leaving the tree alone is what "turnCommit: false" means; the tree is
    // named so the state is not silent.
    notes.push('the automatic commit is off (turnCommit: false), so this tree is left uncommitted');
    return result;
  }
  if (before.dirty === true) {
    const count = before.changeCount ?? 0;
    if (count > config.turnCommitMaxFiles) {
      notes.push('skipped the automatic commit: ' + String(count) + ' changed paths, above the limit of ' + String(config.turnCommitMaxFiles));
      return result;
    }
    const message = messageFor(config, turn, paths);
    // `git.commit` with `all` stages every dirty path itself, untracked
    // included. Staging separately would be a second `git add` racing the first,
    // and `git.stagePaths` takes an explicit path list rather than an "all" flag.
    const committed = await git.commit(repoDir, message, { all: true, timeoutMs, signal });
    if (committed.ok === true) {
      result.committed = true;
      result.sha = committed.sha;
      result.subject = message.split('\n')[0];
      // The record has done its job for this repository: the work is in a commit
      // now, so its rows are dropped rather than left to grow until the cap
      // starts deciding what a later turn still remembers. Only here — on a
      // commit that really landed — never on a skip or a failure, because those
      // leave the work uncommitted and the record is the only thing that still
      // knows about it.
      forgetRepo(sessionId, repoDir, { stateRoot: config.stateRoot });
    } else if (isNothingToCommit(committed.error) !== true) {
      notes.push('could not commit: ' + String(committed.error ?? 'unknown error'));
      return result;
    }
  }

  const after = await git.repoState(repoDir, { timeoutMs, signal });
  const branch = after.ok === true ? after.branch : before.branch;
  result.branch = branch;

  if (config.turnPush !== true) {
    // Pushing is off by configuration, so an unpushed commit is the configured
    // outcome rather than a skip to report. Saying it every committing turn is
    // the noise that trains a reader to skip the message that matters; status
    // and /git still show the ahead count.
    return result;
  }

  const session = state.readSession(sessionId, { stateRoot: config.stateRoot });
  const ownedBranches = session.worktrees.map((entry) => entry.branch).filter((entry) => typeof entry === 'string');
  const decision = pushDecision(config, branch, ownedBranches);
  if (decision.allowed !== true) {
    // Only real unpushed work earns an interruption. A protected branch with
    // nothing ahead of its upstream is this plugin's ordinary steady state —
    // sessions work on `main` — so warning every turn there is noise, and
    // noise is how a warning that matters gets skipped. An absent `ahead`
    // means there is no upstream to compare against, which is work that is
    // certainly not on a remote, so that case still speaks up.
    // Only a turn that has just committed earns the interruption. Unpushed
    // commits on a protected branch are this plugin's ordinary steady state --
    // it is what every local commit on main looks like -- and repeating the same
    // note on every later turn wakes the model over state that has not changed.
    // A *failed* push is still reported unconditionally below, because that one
    // is new information. status keeps reporting the rest, so silence here hides
    // nothing.
    if (result.committed === true) {
      notes.push('not pushed: ' + decision.reason);
    }
    return result;
  }

  const upstream = await git.run(repoDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeoutMs, signal });
  const upstreamRef = upstream.ok ? String(upstream.stdout).trim() : '';
  // Only "level with the remote" when the upstream is this branch's own remote
  // ref. A task branch created by `git worktree add` tracks `origin/<base>`, so
  // an ahead count against that ref says nothing about whether the branch itself
  // has been pushed — and skipping on it would leave every new task branch
  // permanently unpushed.
  const tracksItself = upstreamRef === 'origin/' + String(branch);
  if (tracksItself) {
    const counts = await git.run(repoDir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { timeoutMs, signal });
    if (counts.ok) {
      const [, aheadText] = String(counts.stdout).trim().split(/\s+/u);
      const ahead = Number.parseInt(aheadText ?? '', 10);
      if (Number.isFinite(ahead) && ahead === 0) return result;
    }
  }

  if (state.shouldRetryPush(sessionId, repoDir, new Date(), { stateRoot: config.stateRoot }) !== true) {
    const failure = state.readSession(sessionId, { stateRoot: config.stateRoot }).pushFailures[repoDir];
    notes.push('push still backing off after ' + String(failure?.attempts ?? 0) + ' failure(s): ' + String(failure?.error ?? 'unknown'));
    return result;
  }

  const pushed = await git.push(repoDir, { timeoutMs, signal });
  if (pushed.ok === true) {
    result.pushed = pushed.pushed !== false;
    result.remote = pushed.remote ?? 'origin';
    state.clearPushFailure(sessionId, repoDir, { stateRoot: config.stateRoot });
  } else {
    const recorded = state.recordPushFailure(sessionId, repoDir, pushed.error ?? 'push failed', { stateRoot: config.stateRoot });
    notes.push('push failed: ' + String(pushed.error ?? 'unknown error') + ' (attempt ' + String(recorded.attempts) + ')');
  }
  return result;
}

/**
 * The body of one turn-end sync.
 *
 * Exported so the tests drive the real thing rather than a copy of it: a
 * sync that is only exercised through a live session is a sync nobody tests.
 */
export async function runTurnSync(context) {
  const config = resolveConfig(context.config);
  // Realpath the working directory before anything compares paths against it.
  // `git rev-parse --show-toplevel` realpaths, and on this platform `/tmp` is
  // `/private/tmp` and `/var/folders/...` is `/private/var/folders/...`, so a
  // session whose working directory is the unresolved form would resolve every
  // changed file to a repository that never matches the one git names — and the
  // sync would find nothing to do while the tree stayed dirty.
  const cwd = realpathOf(typeof context.cwd === 'string' && context.cwd !== '' ? context.cwd : process.cwd());
  const signal = withDeadline(context.signal, config.turnSyncTimeoutMs);

  // What this session remembers about worktrees that are no longer there is
  // forgotten before anything is decided. A recorded worktree whose directory is
  // gone is a retired task, not a repository to sync and not a failure to report
  // — reporting it was the "could not read repository state" notice, and leaving
  // it in the file made every later turn read it again. Its push backoff goes
  // with it, in the same write: a backoff keyed by a directory that no longer
  // exists can never be consulted, and one outlived the worktree it belonged to
  // in this deployment's own state file.
  //
  // The rule is the filesystem at this moment (state.forgetVanished): a path that
  // still exists keeps its record, so a worktree that is merely mid-removal is
  // never dropped — git deletes the working tree last, and only a path that is
  // already gone is forgotten. Nothing here is noted to the model: a retired
  // worktree is the normal end of a task, and the notice channel is for work that
  // is still uncommitted.
  const forgotten = state.forgetVanished(context.sessionId, { stateRoot: config.stateRoot });

  const paths = context.readPaths !== undefined
    ? await waitFor(context.readPaths, {
      timeoutMs: Math.min(SUMMARY_WAIT_MS, config.turnSyncTimeoutMs),
      signal,
    })
    : undefined;

  const repos = await touchedRepos(cwd, paths, config, { sessionId: context.sessionId, signal });
  const results = [];
  for (const repoDir of repos) {
    if (signal.aborted) {
      results.push({ repo: repoDir, committed: false, pushed: false, notes: ['cancelled before finishing'] });
      continue;
    }
    // Which paths to mention in the commit body, from the best source available:
    // the per-turn recorder, else this session's own record for the repository.
    //
    // Note what this does NOT do: narrow what is committed. Within a repository
    // the session has established as its own, everything dirty is committed —
    // leaving a file the turn touched and a file it did not, both uncommitted,
    // is the failure this exists to prevent, and no later turn is likely to
    // notice either of them. Deciding *which repositories* are the session's is
    // the job of `touchedRepos` above, and that decision is the precise one.
    const fromRecorder = (paths !== undefined && paths.length > 0)
      ? paths.filter((path) => insideRepo(repoDir, isAbsolute(path) ? path : resolvePath(cwd, path)))
      : [];
    // A list that mentions nothing in this repository is a list from another
    // turn, not a turn that changed nothing here — the recorder is always one
    // turn behind while the turn is still running. Falling back to this session's
    // own record is what keeps the subject attributable: with the stale list
    // trusted, a commit that contained six files was named "dsh: automatic
    // commit" and said nothing about any of them.
    const named = fromRecorder.length > 0
      ? fromRecorder
      : pathsOf(context.sessionId, repoDir, { stateRoot: config.stateRoot });
    results.push(await syncRepo(repoDir, config, context.sessionId, named, { signal, turn: context.turn }));
  }
  // A worktree whose pull request was merged is finished work, and nothing used
  // to close it unless the session remembered to call "finish". This is the
  // automatic half: the same proof prune uses, run at the end of a turn, so a
  // completed task tidies itself up instead of waiting to be noticed.
  const closed = [];
  const roots = new Set();
  for (const repoDir of repos) {
    if (signal.aborted) break;
    // `listWorktrees` answers undefined when git cannot run, which is not an empty
    // list: reading `.length` off it threw a TypeError out of the whole sync, and
    // the model was told about a property of undefined instead of about the
    // repository it could not read.
    const trees = (await git.listWorktrees(repoDir, { timeoutMs: config.timeoutMs, signal })) ?? [];
    const mainRoot = trees.length > 0 ? trees[0].path : repoDir;
    if (roots.has(mainRoot)) continue;
    roots.add(mainRoot);
    for (const entry of await closeLandedWorktrees(mainRoot, config, context.sessionId, { signal })) closed.push(entry);
  }

  return {
    ok: true,
    cwd,
    turn: context.turn,
    usedFileList: paths !== undefined && paths.length > 0,
    scope: config.turnSyncScope,
    repos: results,
    closed,
    // Records this run found pointing at directories that are gone, and dropped.
    // A caller that reports the sync can say so; `needsAttention` deliberately
    // does not look here, because a retired worktree is not unfinished work.
    forgotten,
  };
}

/** One line describing what a sync did, for the Host log. */
export function summarizeSync(result) {
  const repos = result?.repos ?? [];
  const committed = repos.filter((entry) => entry.committed === true).length;
  const pushed = repos.filter((entry) => entry.pushed === true).length;
  const notes = repos.flatMap((entry) => entry.notes ?? []);
  const parts = [];
  if (committed > 0) parts.push(String(committed) + ' committed');
  if (pushed > 0) parts.push(String(pushed) + ' pushed');
  const closed = (result?.closed ?? []).length;
  if (closed > 0) parts.push(String(closed) + ' worktree(s) closed');
  if (notes.length > 0) parts.push(notes.join('; '));
  return parts.join(' — ');
}

/**
 * A one-at-a-time gate for the automatic sync, keyed by session.
 *
 * The automatic sync has more than one trigger — the quiet-period timer, the
 * ceiling under it, and the two turn boundaries — and each of them used to start
 * its own run the moment it fired. Two runs for one session then raced on the
 * same worktree: the second `git commit` met the first one's index lock, and the
 * second `git push` was rejected because the first had not finished moving the
 * ref. The `inflight` set is not a gate: it exists so disposal can wait for work
 * that is running, and waiting is not excluding.
 *
 * So a request either starts now, or folds into exactly one follow-up run that
 * starts when the current one ends. Folded is not dropped: every request gets a
 * promise that settles with the run covering it, and a session with a follow-up
 * waiting stays busy until that follow-up has run — which is what keeps disposal
 * waiting for it too.
 *
 * The chain is bounded on purpose. Requests that arrive during the follow-up fold
 * into the next one instead of appending, so a session that keeps asking can
 * never build a queue longer than the single run it is owed.
 */
function createSyncGate() {
  /** sessionId -> { running: boolean, next: undefined | { run, promise, resolve, reject } } */
  const sessions = new Map();

  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { running: false, next: undefined };
      sessions.set(sessionId, state);
    }
    return state;
  };

  /** Start one run; when it settles, start the single follow-up if one is waiting. */
  const startRun = (sessionId, state, run) => {
    state.running = true;
    let result;
    try {
      result = Promise.resolve(run());
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.finally(() => {
      const followUp = state.next;
      state.next = undefined;
      if (followUp === undefined) {
        state.running = false;
        return;
      }
      // The follow-up takes over the session's one slot, so `running` stays true
      // across the handover and no request can slip in between the two.
      const followRun = startRun(sessionId, state, followUp.run);
      followRun.then(followUp.resolve, followUp.reject);
    });
  };

  return (sessionId, run) => {
    const state = stateOf(sessionId);
    if (state.running === true) {
      if (state.next !== undefined) return state.next.promise;
      const followUp = { run };
      followUp.promise = new Promise((resolve, reject) => {
        followUp.resolve = resolve;
        followUp.reject = reject;
      });
      state.next = followUp;
      return followUp.promise;
    }
    return startRun(sessionId, state, run);
  };
}

/**
 * Register the turn-end sync.
 *
 * Two boundaries, not one, and the duplication is deliberate.
 *
 * `agent/turn-stopping` is the correct hook: it is awaited, it is where the
 * shipped `@deepseek-ai/dsh-workspace-changes` recorder writes this turn's
 * snapshot, and it is dispatched per agent. But it is an agent-scoped event, and
 * a plugin whose listener never reaches it fails **silently** — there is no
 * error, no warning, and no commit, which is exactly the failure mode this
 * bundle exists to remove. A guarantee that depends on one event name resolving
 * in every profile is not a guarantee.
 *
 * So the same work is also registered on `session/event`, where a `turn/end`
 * event carries the same turn number. Whichever boundary arrives first wins for
 * that (session, turn); the other is a no-op. Both are cheap — the losing one
 * only compares two values.
 *
 * The handlers register their work and return. `agent/turn-stopping` is awaited
 * and the user's turn closes at that boundary, so waiting there would put a
 * commit, a fetch and a network push between the user and the end of their turn.
 * The promise is tracked so disposal can account for work already underway
 * instead of orphaning a push.
 */
export function registerTurnSync(ctx, rowConfig, options = {}) {
  /** How long a quiet session waits before its turn is treated as over. */
  const settleMs = Number.isFinite(options.settleMs) && options.settleMs >= 0 ? options.settleMs : SETTLE_MS;
  /** How long a busy session may go between syncs. Injectable so a test can. */
  const ceilingMs = Number.isFinite(options.ceilingMs) && options.ceilingMs > 0 ? options.ceilingMs : SYNC_CEILING_MS;
  /**
   * The sync itself, injectable so a test can count and slow the real one.
   *
   * It defaults to `runTurnSync`, and a wrapper passed here is expected to call
   * it: this is a seam for observing the real work, not a replacement for it.
   */
  const runSync = typeof options.runSync === 'function' ? options.runSync : runTurnSync;
  /** One sync at a time per session, with the single follow-up a folded request is owed. */
  const gate = createSyncGate();

  /** The last (session, turn) already handed to the sync, so two boundaries do not both run it. */
  const handled = new Map();

  /** The state root for diagnostics, or undefined when the config cannot be read. */
  const stateRootOf = () => {
    try {
      return resolveConfig(rowConfig).stateRoot;
    } catch {
      return undefined;
    }
  };

  const claim = (sessionId, turn) => {
    const key = sessionId + '#' + String(turn);
    if (handled.get(sessionId) === key) return false;
    handled.set(sessionId, key);
    return true;
  };

  const start = ({ sessionId, agent, turn, signal }) => {
    const subject = agent ?? liveAgent(ctx, sessionId);
    // Built at the boundary, run when the gate allows it: a boundary that lands
    // while another sync is running waits its turn, and still commits what *this*
    // boundary knew about rather than whatever the later moment happens to say.
    const context = {
      config: rowConfig,
      cwd: sessionCwd(ctx, subject),
      turn,
      sessionId,
      signal,
      // Read once, synchronously, before returning: at this point the recorder
      // has either finished this turn's summary or it never will, so waiting
      // longer only delays work that has already been decided. Undefined when
      // there is no recorder at all, so nothing waits for one that is not coming.
      readPaths: pathsSource(ctx, subject),
    };
    const work = gate(sessionId, () => runSync(context)).then((result) => {
      const summary = summarizeSync(result);
      if (summary !== '') ctx.logger?.info?.('dsh-git turn sync: ' + summary);
      // A sync that declined to commit is the exact failure this plugin exists
      // to prevent, so it cannot be a log line only. See `notifyAgent`.
      if (needsAttention(result)) notifyAgent(ctx, subject, result);
      return result;
    }).catch((error) => {
      const message = 'dsh-git turn sync failed: ' + String(error?.message ?? error);
      ctx.logger?.warn?.(message);
      // An unexpected throw is the worst case: work may be uncommitted and
      // nothing else will say so.
      notifyAgent(ctx, subject, { repos: [{ repo: '', committed: false, pushed: false, notes: [message] }] });
      return undefined;
    }).finally(() => {
      inflight.delete(work);
    });

    inflight.add(work);
    return undefined;
  };

  // Boundary one: the awaited, agent-scoped turn close. It carries the turn
  // number and the agent's own abort signal.
  ctx.on('agent/turn-stopping', (payload) => {
    const sessionId = String(payload?.agent?.id ?? payload?.agent?.session ?? 'unknown');
    // Recorded because this deployment does not deliver it: without a line here,
    // a boundary that never arrives is indistinguishable from a turn with
    // nothing to do, which is exactly the silence boundary three was added for.
    noteBoundary(stateRootOf(), 'agent/turn-stopping session=' + sessionId + ' turn=' + String(payload?.turn));
    if (!claim(sessionId, payload?.turn)) return undefined;
    return start({ sessionId, agent: payload?.agent, turn: payload?.turn, signal: payload?.signal });
  });

  // Boundary two: the session log itself. `turn/end` carries the same turn
  // number, so this is the same work reached by the other road. It carries no
  // agent, which is why `start` resolves one from the session id.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    const sessionId = String(session?.id ?? session?.agent?.id ?? 'unknown');
    const turn = event?.data?.turn;
    noteBoundary(stateRootOf(), 'session/event turn/end session=' + sessionId + ' turn=' + String(turn));
    if (!claim(sessionId, turn)) return;
    return start({ sessionId, agent: session?.agent, turn, signal: undefined });
  });

  // Boundary three: the tools layer, which this row demonstrably receives.
  //
  // How that was established, and what it corrects. The first reading of this
  // deployment was that boundaries one and two never arrive, because the plugin's
  // own diagnostic file holds nothing but lines written by the handler below. That
  // inference was wrong: boundary.log is written *only* by this handler, so its
  // silence about the other two proves nothing about them. The Host's session log
  // does carry them — nineteen `turn/end` events in one Lead session — and a
  // teammate that wrote one file and ended its turn had it committed seven seconds
  // later, with no tool call in between, under the message "dsh: turn 1". A turn
  // number is something only the real boundaries can supply.
  //
  // What was actually wrong is this handler's timing, and it is why those commits
  // are everywhere in the history: it ran at the START of the next tool call, at
  // most once a minute, so in a long turn it was the *fallback* that committed —
  // mid-turn, up to a minute after the edits, several times over, and always under
  // a turn number it never had. Eight such commits landed in one two-hour turn
  // while this was being written, and not one of them was a turn.
  //
  // So the tool call now only ARMS a timer: when the session has been quiet for
  // `settleMs` its edits have stopped, and the sync runs on its own. The ceiling
  // below is the floor under that — a session in an unbroken burst of tool calls
  // is still committed periodically. When a real boundary arrives it does the same
  // work immediately, and whichever of them runs second finds nothing to do.
  //
  // Fire-and-forget: a tool call is never delayed by a commit, a push, or a
  // GitHub query.
  const pendingSettle = new Map();

  /** When each session last ran an automatic sync, for the ceiling above. */
  const lastSyncAt = new Map();

  /** Drop a session's armed timer, if it has one. */
  const clearSettle = (sessionId) => {
    const existing = pendingSettle.get(sessionId);
    if (existing === undefined) return false;
    clearTimeout(existing.timer);
    pendingSettle.delete(sessionId);
    return true;
  };

  /**
   * One settled turn: the sync, the report, and the worktree close that follows.
   *
   * This is the path that actually runs, so this is the path that has to speak.
   * It used to log and write boundary.log while the notification lived on the two
   * boundaries that never arrive — which made "reported, not silent" true of the
   * boundary that never fires and false of the one that does.
   */
  const settle = ({ sessionId, agent }) => {
    let config;
    try {
      config = resolveConfig(rowConfig);
    } catch {
      return undefined;
    }
    const cwd = sessionCwd(ctx, agent);
    // The ceiling measures from when a sync was asked for, not from when it got
    // its turn: a session that has asked is not overdue a second time because the
    // first sync was still running. The 60s ceiling keeps the meaning it had.
    lastSyncAt.set(sessionId, Date.now());
    const context = {
      config: rowConfig,
      cwd,
      turn: undefined,
      sessionId,
      signal: undefined,
      readPaths: pathsSource(ctx, agent),
    };
    const work = gate(sessionId, () => {
      // Written when a run really starts, not when it was asked for. With a gate
      // those are two different moments, and this line is how an overlap is seen
      // from outside the process: two of them before a completion is exactly the
      // race this gate exists to prevent.
      noteBoundary(config.stateRoot, 'settled session=' + sessionId + ' cwd=' + cwd);
      return (async () => {
        const result = await runSync(context);
        const summary = summarizeSync(result);
        if (summary !== '') ctx.logger?.info?.('dsh-git settled sync: ' + summary);
        if (needsAttention(result)) notifyAgent(ctx, agent ?? liveAgent(ctx, sessionId), result);
        // Marker-driven close as well: it needs no session id, so it still runs
        // when the state lookup above found nothing.
        const closed = await closeMergedWorktrees(config, { reference: cwd, sessionId });
        noteBoundary(config.stateRoot, 'settled sync repos=' + (result?.repos ?? []).length + ' closed=' + closed.length + ' summary=' + summary);
        return result;
      })().catch((error) => {
        const message = 'dsh-git settled sync failed: ' + String(error?.message ?? error);
        ctx.logger?.warn?.(message);
        noteBoundary(config.stateRoot, 'settled sync threw: ' + String(error?.message ?? error));
        // An unexpected throw is the worst case: work may be uncommitted and this
        // is the only thing that will ever say so.
        notifyAgent(ctx, agent ?? liveAgent(ctx, sessionId), {
          repos: [{ repo: '', committed: false, pushed: false, notes: [message] }],
        });
        return undefined;
      });
    }).finally(() => {
      inflight.delete(work);
    });
    inflight.add(work);
    return work;
  };

  /** Arm, or re-arm, the timer that ends a turn once the session goes quiet. */
  const armSettle = (sessionId, agent, stateRoot) => {
    clearSettle(sessionId);
    const timer = setTimeout(() => {
      pendingSettle.delete(sessionId);
      void settle({ sessionId, agent });
    }, settleMs);
    // Never hold the process open for a commit, and never keep a stale session
    // alive: the timer is a convenience, not a reason for the Host to stay up.
    timer.unref?.();
    pendingSettle.set(sessionId, { timer, agent, stateRoot });
  };

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const config = resolveConfig(rowConfig);
      const sessionId = String(exec?.agent?.id ?? exec?.agent?.session ?? 'unknown');
      const now = Date.now();
      // The first call of a session starts the clock rather than tripping the
      // ceiling: a session is not overdue before it has done anything.
      if (lastSyncAt.has(sessionId) !== true) lastSyncAt.set(sessionId, now);

      if (now - lastSyncAt.get(sessionId) >= ceilingMs) {
        // Busy for a full interval: commit now rather than wait for a quiet period
        // that may not come. The quiet period is the better trigger, not the only
        // one allowed.
        noteBoundary(config.stateRoot, 'tools/pre-execute (ceiling) session=' + sessionId + ' cwd=' + sessionCwd(ctx, exec?.agent));
        clearSettle(sessionId);
        void settle({ sessionId, agent: exec?.agent });
      } else {
        // One line per settle cycle rather than one per tool call: the log records
        // boundaries, and the boundary is where the quiet begins.
        if (pendingSettle.has(sessionId) !== true) {
          noteBoundary(config.stateRoot, 'tools/pre-execute session=' + sessionId + ' cwd=' + sessionCwd(ctx, exec?.agent));
        }
        armSettle(sessionId, exec?.agent, config.stateRoot);
      }
    } catch {
      /* a boundary that cannot run must not block the tool call it rode in on */
    }
    return next();
  });

  return () => {
    handled.clear();
    // A timer still armed is a turn whose work has not been synced yet. Clearing
    // it is right — this plugin no longer exists to run it — but dropping the work
    // is not, so the sync is started first and the log says so. Whether it
    // finishes is up to the Host; whether it was attempted is not.
    const pending = [...pendingSettle.entries()];
    pendingSettle.clear();
    const drained = [];
    for (const [sessionId, entry] of pending) {
      clearTimeout(entry.timer);
      noteBoundary(entry.stateRoot, 'dispose drained a pending turn sync for ' + sessionId);
      drained.push(settle({ sessionId, agent: entry.agent }));
    }
    // Handed back rather than dropped on the floor, and including the syncs that
    // were already running: a sync writes into the state directory it was given,
    // so a caller about to remove that directory has to be able to wait for all of
    // them. Cordis ignores the value; a test does not.
    return Promise.allSettled([...drained, ...inflight]);
  };
}

/**
 * Whether a turn sync needs the model's attention.
 *
 * A clean commit-and-push needs none: saying "committed and pushed" every turn
 * is noise that trains a reader to skip the message, which is how a real one gets
 * missed. A *skip* is the opposite — the work is still uncommitted and, without
 * this, nothing on the model-facing side ever says so.
 */
export function needsAttention(result) {
  const repos = Array.isArray(result?.repos) ? result.repos : [];
  return repos.some((entry) => (entry.notes ?? []).length > 0);
}

/** The lines a model should read about a sync that did not fully succeed. */
export function attentionText(result) {
  const lines = ['dsh-git could not finish syncing your working tree:'];
  for (const entry of result?.repos ?? []) {
    const notes = entry.notes ?? [];
    if (notes.length === 0) continue;
    const repo = String(entry.repo ?? '').split('/').slice(-1)[0] || entry.repo;
    for (const note of notes) lines.push('  - ' + repo + ': ' + note);
  }
  lines.push('Run the git tool with action "status" to see the current state, and action "commit" or action "push" to finish the work by hand.');
  return lines.join('\n');
}

/**
 * Make sure the model finds out.
 *
 * Both halves are needed, and leaving either out reproduces the silence:
 *
 *   - `agent.inject()` puts the text in the agent's context, but it does **not**
 *     wake the agent. Alone, the note can sit in the inbox until the user
 *     happens to say something — which is indistinguishable from never.
 *   - `agent.followup()` wakes the agent, so the note is read on its own turn
 *     rather than at the next unrelated prompt.
 *
 * Inject is called first so the context is queued before the turn that reads it.
 *
 * Both `id` and `source` are **required**, and neither is decorative. `inject()`
 * lands in the session log as an `agent/inbox/spliced` row whose `inserted`
 * entries are messages, and every message must carry a stable `id` plus a
 * producer-owned `source.kind`.
 *
 *   - No `source`: the durable message fails format validation.
 *   - No `id`: every notice collides on the same `undefined` identity, and the
 *     inbox fold rejects the second one with `message "undefined" is already
 *     pending`. Two notices pending at once is enough to make the whole session
 *     fail to load — not just the note.
 *
 * `source` is named `user` because that is the identity every other inbox row in
 * the log already carries.
 *
 * Everything here is best-effort: a sync that cannot reach the agent has still
 * left the repository in whatever state it is in, and that is recorded in the
 * Host log.
 */
export function notifyAgent(ctx, agent, result) {
  const text = attentionText(result);
  try {
    agent?.inject?.({
      id: randomUUID(),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    });
  } catch {
    /* an agent that cannot take context is not a reason to lose the log line */
  }
  try {
    agent?.followup?.();
  } catch {
    /* waking is an optimisation over waiting; the injected text is durable */
  }
  ctx.logger?.warn?.('dsh-git left work uncommitted: ' + text.replace(/\n\s*/gu, ' '));
}

/** The live agent for a session id, for the boundary that carries no agent. */
function liveAgent(ctx, sessionId) {
  try {
    return ctx.get?.('agents')?.get?.(sessionId);
  } catch {
    return undefined;
  }
}

/** The session's working directory, from the live session when it is reachable. */
function liveSession(ctx, agent) {
  try {
    return ctx.get?.('sessions')?.get?.(agent?.id);
  } catch {
    return undefined;
  }
}

function sessionCwd(ctx, agent) {
  const session = liveSession(ctx, agent);
  const cwd = session?.header?.cwd ?? session?.cwd ?? session?.meta?.cwd;
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  return process.cwd();
}

/**
 * The sequence number of the newest `workspace/changes` event in a session.
 *
 * The recorder stores each summary under the sequence of the event that
 * announced it, and the event itself carries only the turn number, so the
 * sequence has to be read from the log. `session.seq` is the log length without
 * materializing an array and `session.eventAt(seq)` reads one event, so the scan
 * walks backwards from the end and stops at the first match — normally the first
 * look. Returns undefined when the session cannot be read, which sends the
 * caller to the scan fallback rather than to a wrong summary.
 */
export function latestChangesSeq(session) {
  if (session === undefined || session === null) return undefined;
  const length = Number(session.seq);
  if (!Number.isFinite(length) || length <= 0) return undefined;
  if (typeof session.eventAt !== 'function') return undefined;
  for (let seq = length; seq > 0; seq -= 1) {
    let event;
    try {
      event = session.eventAt(seq);
    } catch {
      return undefined;
    }
    if (event !== undefined && event.type === 'workspace/changes') return seq;
  }
  return undefined;
}

/**
 * The recorder's reader, or undefined when this deployment has no recorder.
 *
 * The difference matters and is not a style choice. `readPaths` being present is
 * what makes the sync wait for the turn's summary, and that wait is two seconds
 * per automatic commit. With no recorder to wait for it is two seconds spent to
 * learn nothing — and with a quiet-period boundary, it is two seconds between the
 * turn going quiet and its commit landing.
 */
function pathsSource(ctx, agent) {
  const session = liveSession(ctx, agent);
  const changes = ctx.get?.('workspaceChanges');
  if (session === undefined || changes === undefined || typeof changes.summary !== 'function') return undefined;
  return () => pathsFromRecorder(ctx, agent);
}

/** The turn's changed paths, read from the recorder for this turn. */
function pathsFromRecorder(ctx, agent) {
  const session = liveSession(ctx, agent);
  const changes = ctx.get?.('workspaceChanges');
  if (session === undefined || changes === undefined || typeof changes.summary !== 'function') return undefined;
  const seq = latestChangesSeq(session);
  if (seq === undefined) return undefined;
  try {
    const summary = changes.summary(String(session.id ?? agent?.id ?? ''), seq);
    if (summary === undefined || !Array.isArray(summary.files)) return undefined;
    return summary.files.map((file) => file.path).filter((path) => typeof path === 'string');
  } catch {
    return undefined;
  }
}
