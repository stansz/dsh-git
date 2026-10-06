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
 * Four constraints shape the implementation, and each comes from something
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
 * What is never done here: pushing a protected branch, pushing a branch that is
 * neither a task branch nor the branch of a worktree this session owns, or
 * committing during a merge, a rebase or a cherry-pick.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

import * as git from './git.mjs';
import * as state from './state.mjs';
import { resolveConfig } from './config.mjs';
import { isProtectedBranch, isTaskBranch } from './config.mjs';
import { turnSubject } from './render.mjs';
import { discoverRepos, isNothingToCommit } from './actions.mjs';
import { reposOf, pathsOf } from './session-files.mjs';

/** How long to wait for the turn's changed-file list before falling back. */
const SUMMARY_WAIT_MS = 2000;

/** How often to re-check for the list while waiting for the recorder to finish. */
const SUMMARY_POLL_MS = 100;

/** The trailer that makes an automatic commit identifiable after the fact. */
export const TRAILER = 'Assisted-by: DSH';

/** Turn-end work still running, so disposal can wait for it rather than orphan it. */
const inflight = new Set();

/** How many turn-end syncs are still running. Used by the self-check and disposal. */
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
    return [...found.keys()];
  }

  // The session's own record, which is what makes the fallback safe to keep.
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
    : template.replace(/\{turn\}/gu, String(turn)).replace(/\{paths\}/gu, paths.join(', '));
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
  const turn = options.turn ?? 0;

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
    } else if (isNothingToCommit(committed.error) !== true) {
      notes.push('could not commit: ' + String(committed.error ?? 'unknown error'));
      return result;
    }
  }

  const after = await git.repoState(repoDir, { timeoutMs, signal });
  const branch = after.ok === true ? after.branch : before.branch;
  result.branch = branch;

  if (config.turnPush !== true) {
    if (typeof after.ahead === 'number' && after.ahead > 0) {
      notes.push(String(after.ahead) + ' commit(s) left unpushed: turnPush is off');
    }
    return result;
  }

  const session = state.readSession(sessionId, { stateRoot: config.stateRoot });
  const ownedBranches = session.worktrees.map((entry) => entry.branch).filter((entry) => typeof entry === 'string');
  const decision = pushDecision(config, branch, ownedBranches);
  if (decision.allowed !== true) {
    notes.push('not pushed: ' + decision.reason);
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
 * Exported so the self-check drives the real thing rather than a copy of it: a
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
    const named = (paths !== undefined && paths.length > 0)
      ? paths.filter((path) => insideRepo(repoDir, isAbsolute(path) ? path : resolvePath(cwd, path)))
      : pathsOf(context.sessionId, repoDir, { stateRoot: config.stateRoot });
    results.push(await syncRepo(repoDir, config, context.sessionId, named, { signal, turn: context.turn }));
  }
  return {
    ok: true,
    cwd,
    turn: context.turn,
    usedFileList: paths !== undefined && paths.length > 0,
    scope: config.turnSyncScope,
    repos: results,
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
  if (notes.length > 0) parts.push(notes.join('; '));
  return parts.join(' — ');
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
export function registerTurnSync(ctx, rowConfig) {
  /** The last (session, turn) already handed to the sync, so two boundaries do not both run it. */
  const handled = new Map();

  const claim = (sessionId, turn) => {
    const key = sessionId + '#' + String(turn);
    if (handled.get(sessionId) === key) return false;
    handled.set(sessionId, key);
    return true;
  };

  const start = ({ sessionId, agent, turn, signal }) => {
    const subject = agent ?? liveAgent(ctx, sessionId);
    const work = runTurnSync({
      config: rowConfig,
      cwd: sessionCwd(ctx, subject),
      turn,
      sessionId,
      signal,
      // Read once, synchronously, before returning: at this point the recorder
      // has either finished this turn's summary or it never will, so waiting
      // longer only delays work that has already been decided.
      readPaths: () => pathsFromRecorder(ctx, subject),
    }).then((result) => {
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
    if (!claim(sessionId, turn)) return;
    return start({ sessionId, agent: session?.agent, turn, signal: undefined });
  });

  return () => {
    handled.clear();
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
  const cwd = session?.cwd ?? session?.meta?.cwd;
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
