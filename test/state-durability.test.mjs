/**
 * State that survives.
 *
 * Three things this file pins, all of them about what happens when the state
 * layer is not having a good day.
 *
 * D16: a write that failed has to say so. A mutation that is not on disk must
 * not be reported as done — a push backoff that was never persisted will not
 * delay the next attempt, and a worktree "dropped" from a file nobody could read
 * is still in the file.
 *
 * D17: two OS processes on one session file must not lose each other's records.
 * The case below spawns two real node processes that add records at the same
 * time, which is the only way to see this: inside one process every
 * read-modify-write is already one synchronous stretch.
 *
 * D18: the touched-file store names files a session is editing, so it is
 * created private — 0700 for the directory, 0600 for the log.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as sessionFiles from '../lib/session-files.mjs';
import * as state from '../lib/state.mjs';
import { makeCase } from './helpers.mjs';

/** The modes the touched store is created with; restated because D18 is about them. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** How many ownership records each process adds in the race case. */
const RECORDS_PER_PROCESS = 300;

/** How long a spawned worker may run before the case gives up on it. */
const WORKER_TIMEOUT_MS = 120000;

/** The lock deadline the library documents, plus room for retries. */
const LOCK_DEADLINE_MS = 2000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The worker both race processes run.
 *
 * It is generated into the case directory at run time because it has to import
 * the library under test from wherever the test itself was loaded — the worktree
 * or a pre-change scratch — and because this suite owns exactly one test file.
 * The barrier is what makes the race real: both processes announce themselves and
 * wait for the other, then start adding records in the same window.
 */
const WORKER_SOURCE = [
  "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  'import * as state from ' + JSON.stringify(new URL('../lib/state.mjs', import.meta.url).href) + ';',
  '',
  'const [stateRoot, sessionId, tag, base, countText, barrier] = process.argv.slice(2);',
  'const count = Number(countText);',
  'const nap = (ms) => {',
  '  try {',
  '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
  '  } catch {',
  '    /* the wait below is bounded by its own deadline either way */',
  '  }',
  '};',
  'mkdirSync(barrier, { recursive: true });',
  "writeFileSync(join(barrier, tag + '.ready'), String(process.pid) + '\\n');",
  'const deadline = Date.now() + 20000;',
  "while (!existsSync(join(barrier, 'one.ready')) || !existsSync(join(barrier, 'two.ready'))) {",
  "  if (Date.now() >= deadline) { process.stderr.write('barrier timed out\\n'); process.exit(3); }",
  '  nap(2);',
  '}',
  'let written = 0;',
  'let retried = 0;',
  'for (let index = 0; index < count; index += 1) {',
  "  const path = join(base, tag + '-worktree-' + String(index));",
  "  const entry = { path, repoRoot: base, branch: 'dsh/' + tag, slug: tag };",
  '  // A lock deadline can expire under a loaded machine; that is the deadline',
  '  // doing its job, not a lost record. This case is about loss, so the record',
  '  // gets further chances before it is called lost. The pre-change library never',
  '  // returns false here, so the retry cannot hide the race being tested.',
  '  let ok = false;',
  '  for (let attempt = 0; attempt < 20 && !ok; attempt += 1) {',
  '    if (attempt > 0) { retried += 1; nap(50); }',
  '    ok = state.addWorktree(sessionId, entry, { stateRoot }) === true;',
  '  }',
  '  if (ok) written += 1;',
  '}',
  'const seen = state.readSession(sessionId, { stateRoot }).worktrees.length;',
  "process.stdout.write(JSON.stringify({ tag, count, written, retried, seen }) + '\\n');",
].join('\n');

/** Spawn one worker process and resolve with its exit code and its output. */
function runWorker(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('a worker did not finish in time'));
    }, WORKER_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('a state root that cannot be written reports every mutation as unpersisted', (t) => {
  const c = makeCase('state-durability-blocked');
  t.after(() => c.cleanup());
  const stateRoot = join(c.root, 'state');
  mkdirSync(stateRoot, { recursive: true });
  // A file where the sessions directory has to go: every mkdir and write under
  // it fails with ENOTDIR, which is a state root that cannot be written at all.
  writeFileSync(join(stateRoot, 'dsh-git'), 'a file, not the directory the state needs\n');

  assert.equal(state.writeSession(c.sessionId, { worktrees: [] }, { stateRoot }), false, 'the write reports the failure');
  assert.equal(
    state.addWorktree(c.sessionId, { path: join(c.root, 'nowhere') }, { stateRoot }),
    false,
    'an ownership record is not reported as added',
  );
  // Both of these read an empty state and answer "nothing to do". With a state
  // root that cannot be written that answer is a false success, and the caller
  // acts on it: the push backoff stays unrecorded and the worktree stays listed
  // in a file nobody can read.
  assert.equal(state.clearPushFailure(c.sessionId, c.repoDir, { stateRoot }), false, 'a clear that did not happen is not success');
  assert.equal(state.removeWorktree(c.sessionId, c.repoDir, { stateRoot }), false, 'nor is a drop');
  const failure = state.recordPushFailure(c.sessionId, c.repoDir, 'error: failed to push some refs', { stateRoot });
  assert.equal(failure.persisted, false, 'a backoff that cannot be written says so');
  assert.equal(failure.attempts, 1, 'and still reports how many consecutive failures this was');
  const vanished = state.forgetVanished(c.sessionId, { stateRoot });
  assert.equal(vanished.persisted, false, 'a cleanup that did not stick is not reported as done');
  assert.equal(existsSync(join(stateRoot, 'dsh-git', 'sessions')), false, 'and nothing was written anywhere');
});

test('a state file that cannot be read is not a completed drop', (t) => {
  const c = makeCase('state-durability-unreadable');
  const stateRoot = join(c.root, 'state');
  t.after(() => c.cleanup());
  const worktree = join(c.root, 'app-worktree');

  assert.equal(
    state.addWorktree(c.sessionId, { path: worktree, repoRoot: c.repoDir, branch: 'dsh/x', slug: 'x' }, { stateRoot }),
    true,
  );
  const recorded = state.recordPushFailure(c.sessionId, c.repoDir, 'error: failed to push some refs', { stateRoot });

  const file = state.statePath(c.sessionId, { stateRoot });
  chmodSync(file, 0o000);
  let blocked = false;
  try {
    readFileSync(file, 'utf8');
  } catch {
    blocked = true;
  }
  assert.equal(blocked, true, 'chmod 000 has to make the file unreadable; this case cannot run as root');
  t.after(() => {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* already restored below, or the case is gone */
    }
  });

  assert.equal(
    state.removeWorktree(c.sessionId, c.repoDir, { path: worktree, stateRoot }),
    false,
    'a drop that could not be proved is not reported as done',
  );
  assert.equal(state.clearPushFailure(c.sessionId, c.repoDir, { stateRoot }), false, 'nor is a cleared backoff');

  chmodSync(file, 0o600);
  assert.equal(
    state.removeWorktree(c.sessionId, c.repoDir, { path: worktree, stateRoot }),
    true,
    'and once the file is readable the same call really drops it',
  );
  assert.equal(state.readSession(c.sessionId, { stateRoot }).worktrees.length, 0);
  assert.equal(state.clearPushFailure(c.sessionId, c.repoDir, { stateRoot }), true);
  assert.deepEqual(state.readSession(c.sessionId, { stateRoot }).pushFailures, {});
  assert.equal(recorded.persisted, true, 'the backoff was written while the file was readable');
});

test('two processes adding records to one session file keep every record', async (t) => {
  const c = makeCase('state-durability-race');
  t.after(() => c.cleanup());
  const stateRoot = join(c.root, 'state');
  const barrier = join(c.root, 'barrier');
  const base = join(c.root, 'worktrees');
  const script = join(c.root, 'state-worker.mjs');
  writeFileSync(script, WORKER_SOURCE, 'utf8');

  const args = (tag) => [stateRoot, c.sessionId, tag, base, String(RECORDS_PER_PROCESS), barrier];
  // Both are spawned before either is awaited, and the barrier makes them start
  // their loops in the same window. This is the race: no amount of in-process
  // ordering helps, because these are two operating-system processes.
  const [one, two] = await Promise.all([runWorker(script, args('one')), runWorker(script, args('two'))]);

  assert.equal(one.code, 0, 'the first process finished: ' + one.stderr);
  assert.equal(two.code, 0, 'the second process finished: ' + two.stderr);
  const first = JSON.parse(one.stdout.trim().split('\n').pop());
  const second = JSON.parse(two.stdout.trim().split('\n').pop());
  assert.equal(first.written, RECORDS_PER_PROCESS, 'every record from the first process was accepted');
  assert.equal(second.written, RECORDS_PER_PROCESS, 'every record from the second process was accepted');
  t.diagnostic('race: first wrote ' + String(first.written) + ' with ' + String(first.retried)
    + ' lock retries, second wrote ' + String(second.written) + ' with ' + String(second.retried));

  const stored = state.readSession(c.sessionId, { stateRoot });
  const paths = new Set(stored.worktrees.map((entry) => entry.path));
  const missing = [];
  for (const tag of ['one', 'two']) {
    for (let index = 0; index < RECORDS_PER_PROCESS; index += 1) {
      const path = join(base, tag + '-worktree-' + String(index));
      if (!paths.has(path)) missing.push(path);
    }
  }
  assert.equal(
    stored.worktrees.length,
    RECORDS_PER_PROCESS * 2,
    'the file holds both processes records: ' + String(stored.worktrees.length) + ' of ' + String(RECORDS_PER_PROCESS * 2)
      + ' (first process saw ' + String(first.seen) + ', second saw ' + String(second.seen)
      + '; missing ' + String(missing.length) + ')',
  );
  assert.deepEqual(missing, [], 'no record from either process was lost');
});

test('a lock a killed writer left behind is broken, not waited on forever', (t) => {
  const c = makeCase('state-durability-stale-lock');
  t.after(() => c.cleanup());
  const stateRoot = join(c.root, 'state');
  const lock = state.statePath(c.sessionId, { stateRoot }) + '.lock';
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, '999999\n', 'utf8');
  const longAgo = new Date(Date.now() - 60000);
  utimesSync(lock, longAgo, longAgo);

  const started = Date.now();
  assert.equal(
    state.addWorktree(c.sessionId, { path: join(c.root, 'after-the-crash') }, { stateRoot }),
    true,
    'the abandoned lock is broken and the record is written',
  );
  // Faster than the deadline it declined to wait out — the same claim as before,
  // expressed against the deadline rather than against an absolute second, which
  // a loaded machine can spend on its own.
  assert.ok(Date.now() - started < LOCK_DEADLINE_MS - 500, 'and it did not wait out the deadline first');
  assert.equal(existsSync(lock), false, 'the abandoned lock is gone');
});

test('a lock that cannot be taken inside the deadline reports failure and leaves the file alone', (t) => {
  const c = makeCase('state-durability-lock-deadline');
  t.after(() => c.cleanup());
  const stateRoot = join(c.root, 'state');
  assert.equal(state.addWorktree(c.sessionId, { path: join(c.root, 'kept') }, { stateRoot }), true);
  const path = state.statePath(c.sessionId, { stateRoot });
  const before = readFileSync(path, 'utf8');
  const lock = path + '.lock';
  // A lock that is fresh, so it is not treated as a crashed writer's.
  writeFileSync(lock, String(process.pid) + '\n', 'utf8');
  t.after(() => {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  });

  const started = Date.now();
  assert.equal(
    state.addWorktree(c.sessionId, { path: join(c.root, 'lost') }, { stateRoot }),
    false,
    'the writer gives up rather than writing unsynchronised',
  );
  assert.ok(Date.now() - started >= LOCK_DEADLINE_MS - 500, 'it waited the documented deadline before giving up');
  assert.equal(readFileSync(path, 'utf8'), before, 'and the state file is untouched');
  assert.equal(state.readSession(c.sessionId, { stateRoot }).worktrees.length, 1, 'the earlier record is intact');
});

test('the touched-file store is created private', (t) => {
  const c = makeCase('state-durability-modes');
  t.after(() => c.cleanup());
  const stateRoot = join(c.root, 'state');
  assert.equal(sessionFiles.record(c.sessionId, c.repoDir, join(c.repoDir, 'a.txt'), { stateRoot }), true);

  const file = sessionFiles.indexPath(c.sessionId, { stateRoot });
  const modeOf = (path) => statSync(path).mode & 0o777;
  assert.equal(modeOf(dirname(file)), DIR_MODE, 'the touched directory is private');
  assert.equal(modeOf(file), FILE_MODE, 'the record file is private');
  assert.equal(modeOf(join(stateRoot, 'dsh-git')), DIR_MODE, 'and so is the directory above it');
});
