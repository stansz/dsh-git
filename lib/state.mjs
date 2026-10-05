/**
 * dsh-git — what this session remembers about its git work.
 *
 * Two things have to survive a Host restart, and neither can live in a module
 * variable: which worktrees this session owns (so a later run can clean up after
 * itself, and knows not to touch anybody else's), and which pushes failed (so a
 * transient network error is retried with backoff instead of being retried
 * forever, or worse, never).
 *
 * The file is the truth. Nothing is cached in memory between calls, on purpose:
 * a cached map and a restarted Host produce a tool that confidently reports
 * ownership it no longer has, and the failure mode of that is deleting work.
 *
 * Every function here is fail-soft. An unreadable, corrupt, hand-edited, or
 * unwritable state file costs the retry schedule or an ownership line — never
 * an exception across a module boundary, because a plugin that throws while
 * reporting state takes the whole tool call down with it.
 *
 * Session ids come from outside this module, so they are escaped before they
 * become a filename: a session id of `../../etc/passwd` has to land inside the
 * state directory, not three levels above it.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Characters a session id may keep; everything else is percent-encoded. */
const UNSAFE_ID_CHARS = /[^A-Za-z0-9._-]/gu;
/** Longest escaped id kept before a digest takes over, well under the 255-byte limit. */
const ID_MAX = 120;
/** Push backoff: one minute, five, fifteen, then hourly. */
const BACKOFF_SECONDS = [60, 300, 900, 3600];
/** How much of a push error is worth storing. */
const ERROR_CLIP = 500;

/**
 * A session id made safe to use as one filename.
 *
 * The id may contain a path separator, a parent reference, a quote, or a
 * character the filesystem refuses; the escaped form contains none of them, so
 * the file it names is always a direct child of the sessions directory. The
 * escaping is injective — `%` is itself escaped — so two sessions can never
 * share one state file. An id that escapes to nothing, or to something that is
 * only dots, falls back to a digest of the original, deterministically, so the
 * same session always finds the same file.
 *
 * @param {string} id - the session id, as given.
 * @returns {string} a filename-safe, non-empty id: `[A-Za-z0-9._%-]`, never
 *   starting with `.` and never ending with `.`.
 */
export function safeSessionId(id) {
  const raw = id === undefined || id === null ? '' : String(id);
  let encoded = raw.replace(UNSAFE_ID_CHARS, percentEncode);
  if (encoded.length > ID_MAX) encoded = encoded.slice(0, 100) + '-' + digest(raw);
  // Leading and trailing dots are the two forms Windows refuses and the two
  // forms that read as path structure; both are escaped rather than dropped, so
  // the mapping stays one-to-one.
  encoded = encoded.replace(/^\.+/u, (dots) => '%2E'.repeat(dots.length));
  encoded = encoded.replace(/\.+$/u, (dots) => '%2E'.repeat(dots.length));
  return encoded === '' ? 'session-' + digest(raw) : encoded;
}

/**
 * The state file for one session.
 *
 * `<stateRoot>/dsh-git/sessions/<safeSessionId>.json`, with `stateRoot`
 * defaulting to `~/.dsh/state`.
 *
 * @param {string} sessionId - the session id, escaped before use.
 * @param {object} [opts]
 * @param {string} [opts.stateRoot] - override the state root, for tests and for
 *   a harness whose home is not `~/.dsh`.
 * @returns {string} an absolute path. Nothing is created here; a session that
 *   never writes has no file.
 */
export function statePath(sessionId, opts = {}) {
  const root = stateRootOf(opts);
  const dir = join(root, 'dsh-git', 'sessions');
  const candidate = join(dir, safeSessionId(sessionId) + '.json');
  // Insurance, not parsing: whatever the escaping does, the result is a direct
  // child of the sessions directory or it is not used.
  return dirname(candidate) === dir ? candidate : join(dir, digest(String(sessionId ?? '')) + '.json');
}

/**
 * Read one session's remembered state.
 *
 * A missing file, unreadable file, truncated JSON, or a file whose contents are
 * not an object all produce the same empty state: the caller gets a usable
 * object with no worktrees and no push failures, and no exception. Fields of the
 * wrong type inside an otherwise valid file are dropped rather than trusted,
 * because this file can be edited by hand.
 *
 * @param {string} sessionId - the session id.
 * @param {object} [opts] - `{stateRoot}`.
 * @returns {{sessionId: string, worktrees: {repo: string, repoRoot: string,
 *   path: string, branch: string, slug: string, createdAt: string}[],
 *   pushFailures: Object<string, {attempts: number, nextAttemptAt: string}>,
 *   updatedAt: string|null}} `updatedAt` is null when there is no readable file.
 */
export function readSession(sessionId, opts = {}) {
  const empty = emptyState(sessionId);
  let text;
  try {
    text = readFileSync(statePath(sessionId, opts), 'utf8');
  } catch {
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

  return {
    sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId !== ''
      ? parsed.sessionId
      : empty.sessionId,
    worktrees: normalizeWorktrees(parsed.worktrees),
    pushFailures: normalizePushFailures(parsed.pushFailures),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
  };
}

/**
 * Write one session's state.
 *
 * Written to a temporary file and renamed into place, so a crash mid-write
 * leaves the previous state intact instead of half a JSON document — the exact
 * failure a Host restart would hit. Absent top-level fields are taken from the
 * file on disk rather than replaced by empty ones, so a partial update (just a
 * push failure, say) cannot erase the worktree list; an explicitly empty array
 * still clears it.
 *
 * @param {string} sessionId - the session id.
 * @param {object} state - the state to store; `updatedAt` is always re-stamped.
 * @param {object} [opts] - `{stateRoot}`.
 * @returns {boolean} true when the file is on disk; false when the directory
 *   cannot be created or written. The caller continues either way — an
 *   unwritable state directory is not a reason to fail a task.
 */
export function writeSession(sessionId, state, opts = {}) {
  const previous = readSession(sessionId, opts);
  const given = state !== null && typeof state === 'object' ? state : {};
  const next = {
    sessionId: typeof given.sessionId === 'string' && given.sessionId !== '' ? given.sessionId : previous.sessionId,
    worktrees: Array.isArray(given.worktrees) ? normalizeWorktrees(given.worktrees) : previous.worktrees,
    pushFailures: isPlainObject(given.pushFailures)
      ? normalizePushFailures(given.pushFailures)
      : previous.pushFailures,
    updatedAt: new Date().toISOString(),
  };

  const path = statePath(sessionId, opts);
  const temporary = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may never have been created; nothing to clean up.
    }
    return false;
  }
}

/**
 * Record a worktree this session owns.
 *
 * Re-adding the same worktree replaces its entry instead of duplicating it, and
 * an entry for the same repository and branch at a different path is treated as
 * stale: git allows one worktree per branch, so the older record cannot still be
 * true. That is what makes this idempotent across a Host restart.
 *
 * @param {string} sessionId - the session id.
 * @param {{repo?: string, repoRoot?: string, path: string, branch?: string,
 *   slug?: string, createdAt?: string}} entry - the worktree to remember.
 * @param {object} [opts] - `{stateRoot}`.
 * @returns {boolean} false when the entry has no path, or when the state file
 *   could not be written; true when it is recorded (or already was).
 */
export function addWorktree(sessionId, entry, opts = {}) {
  const record = normalizeWorktree(entry);
  if (record === undefined) return false;
  const state = readSession(sessionId, opts);
  // Identity is the PATH. A repository legitimately has several worktrees in one
  // session — that is what a worktree is for — so a bare same-repository match
  // would treat the second task's worktree as an update of the first, silently
  // forget the first, and leave it on disk as an unowned directory that cleanup
  // then refuses to touch.
  const index = state.worktrees.findIndex((existing) => samePath(existing.path, record.path));
  if (index === -1) state.worktrees.push(record);
  else state.worktrees[index] = record;
  return writeSession(sessionId, state, opts);
}

/**
 * Forget a worktree this session owned.
 *
 * Matching is by `repoRoot`, realpath-aware, because `/tmp/x` and
 * `/private/tmp/x` are one repository on macOS and a string comparison would
 * leave the entry behind forever. `opts.path` and `opts.slug` narrow the match
 * further when one repository has several worktrees in the session.
 *
 * @param {string} sessionId - the session id.
 * @param {string} repoRoot - the repository whose worktree entries to drop.
 * @param {object} [opts]
 * @param {string} [opts.path] - drop only this worktree path.
 * @param {string} [opts.slug] - drop only this slug.
 * @param {string} [opts.stateRoot] - override the state root.
 * @returns {boolean} true when nothing matched (already forgotten is the same
 *   outcome) or the update was written; false when the arguments identify
 *   nothing or the state file could not be written.
 */
export function removeWorktree(sessionId, repoRoot, opts = {}) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const wanted = typeof repoRoot === 'string' ? repoRoot.trim() : '';
  const path = typeof options.path === 'string' && options.path !== '' ? options.path : undefined;
  const slug = typeof options.slug === 'string' && options.slug !== '' ? options.slug : undefined;
  if (wanted === '' && path === undefined) return false;

  const state = readSession(sessionId, options);
  const kept = state.worktrees.filter((entry) => {
    if (slug !== undefined && entry.slug !== slug) return true;
    if (path !== undefined && !samePath(entry.path, path)) return true;
    return wanted !== '' && !samePath(entry.repoRoot, wanted) && entry.repoRoot !== wanted;
  });
  if (kept.length === state.worktrees.length) return true;
  state.worktrees = kept;
  return writeSession(sessionId, state, options);
}

/**
 * Record a failed push and when it may be tried again.
 *
 * Backoff is per repository: 60s, then 5 minutes, 15 minutes, and an hour
 * thereafter. A failed push is usually a network or credential problem, and
 * retrying it in a loop both burns the agent's turn and can lock an account out.
 *
 * @param {string} sessionId - the session id.
 * @param {string} repoRoot - the repository whose push failed.
 * @param {string} error - git's message, kept for the next report.
 * @param {object} [opts]
 * @param {string} [opts.stateRoot] - override the state root.
 * @param {number} [opts.now] - current time in ms, for deterministic tests.
 * @returns {{attempts: number, nextAttemptAt: string}} the schedule this call
 *   computed. When the state file cannot be written the schedule is still
 *   returned but not remembered, and `shouldRetryPush` will answer true.
 */
export function recordPushFailure(sessionId, repoRoot, error, opts = {}) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const key = pushKey(repoRoot);
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  if (key === undefined) return { attempts: 0, nextAttemptAt: new Date(nowMs).toISOString() };

  const state = readSession(sessionId, options);
  const previous = state.pushFailures[key];
  const attempts = previous !== undefined && Number.isFinite(previous.attempts) && previous.attempts > 0
    ? previous.attempts + 1
    : 1;
  const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
  const nextAttemptAt = new Date(nowMs + delay * 1000).toISOString();
  state.pushFailures[key] = {
    attempts,
    error: clip(String(error ?? '')),
    lastAttemptAt: new Date(nowMs).toISOString(),
    nextAttemptAt,
  };
  writeSession(sessionId, state, options);
  return { attempts, nextAttemptAt };
}

/**
 * Whether a push may be attempted again.
 *
 * Answers true when nothing has failed for this repository, when the backoff
 * window has passed, or when the stored record cannot be understood — the
 * fail-open direction, because a corrupt state file must not silently stop
 * pushing forever. A `now` that cannot be parsed is also treated as "retry", for
 * the same reason.
 *
 * @param {string} sessionId - the session id.
 * @param {string} repoRoot - the repository to ask about.
 * @param {Date|string|number} [now] - the time to judge by; defaults to now.
 * @param {object} [opts] - `{stateRoot}`.
 * @returns {boolean} true when the caller should try the push again.
 */
export function shouldRetryPush(sessionId, repoRoot, now, opts = {}) {
  const key = pushKey(repoRoot);
  if (key === undefined) return true;
  const state = readSession(sessionId, opts);
  const entry = state.pushFailures[key];
  if (entry === undefined) return true;

  const at = parseTime(now);
  if (at === undefined) return true;
  const next = Date.parse(entry.nextAttemptAt);
  if (Number.isNaN(next)) return true;
  return at >= next;
}

/**
 * Forget a repository's push failure, after a push finally succeeded.
 *
 * @param {string} sessionId - the session id.
 * @param {string} repoRoot - the repository whose record to drop.
 * @param {object} [opts] - `{stateRoot}`.
 * @returns {boolean} true when there was nothing to clear or the update was
 *   written; false when the repository could not be identified or the state
 *   file could not be written.
 */
export function clearPushFailure(sessionId, repoRoot, opts = {}) {
  const key = pushKey(repoRoot);
  if (key === undefined) return false;
  const state = readSession(sessionId, opts);
  if (state.pushFailures[key] === undefined) return true;
  delete state.pushFailures[key];
  return writeSession(sessionId, state, opts);
}

/** The state root: the caller's override, else `~/.dsh/state`. */
function stateRootOf(opts) {
  const configured = opts !== null && typeof opts === 'object' ? opts.stateRoot : undefined;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
  return join(homedir(), '.dsh', 'state');
}

/** The empty state for a session: usable, and honest about knowing nothing. */
function emptyState(sessionId) {
  return {
    sessionId: sessionId === undefined || sessionId === null ? '' : String(sessionId),
    worktrees: [],
    pushFailures: {},
    updatedAt: null,
  };
}

/** A stored worktree entry with exactly the documented fields, or undefined. */
function normalizeWorktree(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  if (typeof entry.path !== 'string' || entry.path === '') return undefined;
  return {
    repo: text(entry.repo),
    repoRoot: text(entry.repoRoot),
    path: entry.path,
    branch: text(entry.branch),
    slug: text(entry.slug),
    createdAt: typeof entry.createdAt === 'string' && entry.createdAt !== ''
      ? entry.createdAt
      : new Date().toISOString(),
  };
}

/** Every usable worktree entry of a stored list. */
function normalizeWorktrees(list) {
  if (!Array.isArray(list)) return [];
  const entries = [];
  for (const value of list) {
    const entry = normalizeWorktree(value);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** Push-failure records, keyed by repository, with unusable ones dropped. */
function normalizePushFailures(value) {
  if (!isPlainObject(value)) return {};
  const failures = {};
  for (const [key, record] of Object.entries(value)) {
    if (key === '' || !isPlainObject(record)) continue;
    const attempts = Number.isFinite(record.attempts) && record.attempts > 0 ? Math.floor(record.attempts) : 1;
    const nextAttemptAt = typeof record.nextAttemptAt === 'string' ? record.nextAttemptAt : '';
    const stored = { attempts, nextAttemptAt };
    if (typeof record.error === 'string' && record.error !== '') stored.error = clip(record.error);
    if (typeof record.lastAttemptAt === 'string' && record.lastAttemptAt !== '') stored.lastAttemptAt = record.lastAttemptAt;
    failures[key] = stored;
  }
  return failures;
}

/** Whether a value is a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A string field, or '' — never undefined, so a stored record has a fixed shape. */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/** The push-failure key for a repository: absolute and realpath'd. */
function pushKey(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') return undefined;
  return sameFsPathString(resolve(repoRoot.trim()));
}

/** Realpath when the path exists, the path as given when it does not. */
function sameFsPathString(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether two paths name the same directory, realpath-aware. */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const first = sameFsPathString(resolve(left));
  const second = sameFsPathString(resolve(right));
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

/** Parse a time from a Date, an ISO string, or epoch milliseconds. */
function parseTime(value) {
  if (value === undefined || value === null) return Date.now();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Percent-encode one character as its UTF-8 bytes. */
function percentEncode(character) {
  let out = '';
  for (const byte of Buffer.from(character, 'utf8')) {
    out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** A short, stable digest of a string. */
function digest(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** Keep a stored error to a size a tool result can carry. */
function clip(value) {
  const message = String(value ?? '');
  return message.length <= ERROR_CLIP ? message : message.slice(0, ERROR_CLIP) + '… (truncated)';
}
