/**
 * Two triggers, one sync at a time.
 *
 * The automatic sync has more than one trigger: the quiet-period timer, the
 * ceiling under it, and the two turn boundaries. Each of them used to start its
 * own run the moment it fired, so two triggers landing in the same window ran
 * two syncs over one worktree — the second commit met the first one's index
 * lock, the second push was rejected, and the race reached the user as a
 * "dsh-git could not finish syncing your working tree" notice.
 *
 * These cases drive the real registerTurnSync with a real repository and a Host
 * reduced to the parts the plugin uses. The sync itself is the real runTurnSync,
 * reached through a wrapper that counts concurrent runs and then calls it — an
 * instrument, not a replacement. The overlap window is real as well: a
 * pre-commit hook in the fixture holds the first commit open, so "the first sync
 * is still running" is a fact a case waits for rather than a hope about
 * scheduling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { record } from '../lib/session-files.mjs';
import { registerTurnSync, runTurnSync } from '../lib/turn-commit.mjs';
import { git, makeCase } from './helpers.mjs';

/** The quiet period these cases use: short, because the order is what is tested. */
const SETTLE_MS = 200;

/** How long the fixture's pre-commit hook holds a commit open. */
const HOOK_SLEEP_SECONDS = 1.2;

/** The deadline for waiting on work a timer started. */
const WAIT_MS = 20000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `read` is true. Returns whether it became true before the deadline. */
async function until(read, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (read()) return true;
    if (Date.now() >= deadline) return false;
    await wait(20);
  }
}

/**
 * Hold every commit in this fixture open for a while.
 *
 * This is the overlap window, and it is real git: the hook runs for the fixed
 * and the unfixed library alike, so a case can wait for the first sync to be
 * inside its commit instead of guessing when it will be.
 */
function installSlowHook(c) {
  const markers = join(c.root, 'hook-markers.log');
  const hook = join(c.repoDir, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(
    hook,
    '#!/bin/sh\necho commit-start >> ' + JSON.stringify(markers) + '\nsleep ' + String(HOOK_SLEEP_SECONDS) + '\n',
    'utf8',
  );
  chmodSync(hook, 0o755);
  return markers;
}

/** One uncommitted file this session is recorded as having written. */
function dirtyTurn(c) {
  const file = join(c.repoDir, 'written.txt');
  writeFileSync(file, 'written during a turn\n');
  assert.equal(record(c.sessionId, c.repoDir, file, { stateRoot: c.config.stateRoot }), true);
  return file;
}

/**
 * The real sync, wrapped so a case can see it.
 *
 * The wrapper calls the real runTurnSync and only records: when a run starts,
 * when it ends, and how many were ever in flight at once.
 */
function countingSync() {
  const observed = { runs: 0, active: 0, maxActive: 0, startedAt: [], endedAt: [] };
  const run = async (context) => {
    const index = observed.runs;
    observed.runs += 1;
    observed.active += 1;
    observed.maxActive = Math.max(observed.maxActive, observed.active);
    observed.startedAt[index] = Date.now();
    try {
      return await runTurnSync(context);
    } finally {
      observed.active -= 1;
      observed.endedAt[index] = Date.now();
    }
  };
  return { observed, run };
}

/**
 * A Host, reduced to what the plugin uses.
 *
 * The service lookup answers for `sessions` only: with no workspace-changes
 * recorder there is no turn summary to wait for, so a sync starts as soon as its
 * trigger fires. That keeps the timing in this file about the gate rather than
 * about the two-second wait for a recorder that is not there.
 */
function fakeHost(c, options = {}) {
  const handlers = new Map();
  const injected = [];
  const woken = [];
  const warnings = [];
  const agent = {
    id: c.sessionId,
    inject: (message) => injected.push(message),
    followup: () => woken.push(Date.now()),
  };
  const session = { id: c.sessionId, header: { cwd: c.reference } };
  const ctx = {
    on: (name, handler) => { handlers.set(name, handler); },
    logger: { info: () => {}, warn: (line) => warnings.push(String(line)) },
    get: (name) => (name === 'sessions' ? { get: () => session } : undefined),
  };
  const dispose = registerTurnSync(ctx, options.config ?? c.config, {
    settleMs: options.settleMs ?? SETTLE_MS,
    ceilingMs: options.ceilingMs,
    runSync: options.runSync,
  });
  return {
    agent, injected, woken, warnings, dispose,
    toolCall: () => handlers.get('tools/pre-execute')?.({ agent }, () => undefined),
    turnStopping: (turn) => handlers.get('agent/turn-stopping')?.({ agent, turn, signal: undefined }),
  };
}

/**
 * The fixture's config, minus pushes.
 *
 * The fixture works on `main`, where the automatic push is refused and the
 * refusal itself speaks. Turning pushes off keeps every notice in this file
 * about the race and nothing else.
 */
function quietConfig(c) {
  return { ...c.config, turnPush: false };
}

/** The plugin's own diagnostics file for a case. */
const boundaryLog = (c) => join(c.root, 'state', 'dsh-git', 'boundary.log');

/** The log's sync start and finish lines, in the order they were written. */
function syncShape(c) {
  let text = '';
  try {
    text = readFileSync(boundaryLog(c), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => /settled (session|sync repos)=/u.test(line))
    .map((line) => (/settled session=/u.test(line) ? 'start' : 'end'));
}

/** The most syncs the log ever shows running at once. */
function maxConcurrent(shape) {
  let running = 0;
  let most = 0;
  for (const kind of shape) {
    running += kind === 'start' ? 1 : -1;
    most = Math.max(most, running);
  }
  return most;
}

/** What every overlap case asserts about the log, the notices and the counter. */
function assertSerialized(c, host, observed) {
  const shape = syncShape(c);
  assert.equal(maxConcurrent(shape), 1, 'the log must never show two syncs running at once: ' + shape.join(' '));
  assert.equal(shape.filter((kind) => kind === 'start').length, 2, 'both triggers ran a sync; folded is not dropped');
  assert.equal(shape.filter((kind) => kind === 'end').length, 2, 'and each run finished');
  assert.equal(host.injected.length, 0, 'no race means no "could not finish syncing" notice: ' + host.warnings.join(' | '));
  assert.equal(observed.runs, 2, 'the real sync ran twice: once per trigger, the second after the first');
  assert.equal(observed.maxActive, 1, 'and never two at the same time');
  assert.ok(observed.startedAt[1] >= observed.endedAt[0], 'the follow-up starts only after the first run finished');
  assert.equal(git(c.repoDir, ['status', '--porcelain=v1']), '', 'the work is in the commit rather than the tree');
}

test('two quiet-period triggers are one sync now and one after it', async (t) => {
  const c = makeCase('sync-lock-settle');
  t.after(() => c.cleanup());
  const markers = installSlowHook(c);
  dirtyTurn(c);
  const { observed, run } = countingSync();
  const host = fakeHost(c, { runSync: run, config: quietConfig(c) });
  t.after(async () => {
    await host.dispose();
    c.cleanup();
  });

  // Trigger one: a tool call, and the quiet period it arms.
  host.toolCall();
  assert.equal(await until(() => existsSync(markers)), true, 'the first sync reached the commit it holds open');

  // Trigger two: another tool call while that commit is still open.
  const secondTriggerAt = Date.now();
  host.toolCall();

  assert.equal(
    await until(() => syncShape(c).filter((kind) => kind === 'end').length >= 2),
    true,
    'both syncs finished: ' + syncShape(c).join(' '),
  );
  assertSerialized(c, host, observed);
  assert.ok(secondTriggerAt + SETTLE_MS < observed.endedAt[0], 'the second trigger really landed while the first sync was running');
  assert.equal(git(c.repoDir, ['log', '-1', '--format=%s']), 'dsh: written.txt', 'the automatic commit names what it contains');
});

test('the ceiling does not start a second sync on top of one that is running', async (t) => {
  const c = makeCase('sync-lock-ceiling');
  t.after(() => c.cleanup());
  const markers = installSlowHook(c);
  dirtyTurn(c);
  const { observed, run } = countingSync();
  // The quiet period is out of reach, so only the ceiling can trigger.
  const host = fakeHost(c, { runSync: run, settleMs: 60000, ceilingMs: 150, config: quietConfig(c) });
  t.after(async () => {
    await host.dispose();
    c.cleanup();
  });

  host.toolCall(); // the first call of a session starts the clock
  await wait(250); // the ceiling is now due
  host.toolCall(); // trigger one: the ceiling
  assert.equal(await until(() => existsSync(markers)), true, 'the ceiling sync reached the commit it holds open');

  await wait(250); // still inside the hook, and past the ceiling again
  const secondTriggerAt = Date.now();
  host.toolCall(); // trigger two: the ceiling again, while the first runs

  assert.equal(
    await until(() => syncShape(c).filter((kind) => kind === 'end').length >= 2),
    true,
    'both syncs finished: ' + syncShape(c).join(' '),
  );
  assertSerialized(c, host, observed);
  assert.ok(secondTriggerAt < observed.endedAt[0], 'the second trigger really landed while the first sync was running');
});

test('a turn boundary that arrives during a sync waits for it', async (t) => {
  const c = makeCase('sync-lock-boundary');
  t.after(() => c.cleanup());
  const markers = installSlowHook(c);
  dirtyTurn(c);
  const { observed, run } = countingSync();
  const host = fakeHost(c, { runSync: run, config: quietConfig(c) });
  t.after(async () => {
    await host.dispose();
    c.cleanup();
  });

  host.toolCall();
  assert.equal(await until(() => existsSync(markers)), true, 'the quiet-period sync reached the commit it holds open');

  const boundaryAt = Date.now();
  host.turnStopping(4);
  assert.equal(await until(() => observed.runs >= 2), true, 'the boundary ran a sync after the first, not beside it');
  assert.equal(observed.runs, 2, 'one sync for the quiet period, one for the boundary');
  assert.equal(observed.maxActive, 1, 'a boundary never overlaps a running sync');
  assert.ok(observed.startedAt[1] >= observed.endedAt[0], 'the boundary run starts only after the first ended');
  assert.ok(boundaryAt < observed.endedAt[0], 'the boundary really arrived while the first sync was running');
  assert.equal(host.injected.length, 0, 'and the deferred run has nothing to complain about: ' + host.warnings.join(' | '));
  assert.equal(git(c.repoDir, ['status', '--porcelain=v1']), '', 'the work is committed by the run that got there first');
});

test('disposal waits for the follow-up a running sync was owed', async (t) => {
  const c = makeCase('sync-lock-dispose');
  t.after(() => c.cleanup());
  const markers = installSlowHook(c);
  dirtyTurn(c);
  const { observed, run } = countingSync();
  const host = fakeHost(c, { runSync: run, config: quietConfig(c) });
  t.after(async () => {
    await host.dispose();
    c.cleanup();
  });

  host.toolCall();
  assert.equal(await until(() => existsSync(markers)), true, 'the first sync reached the commit it holds open');

  host.toolCall();
  await wait(SETTLE_MS + 250);
  assert.equal(observed.runs, 1, 'the second trigger has not started a run; it is waiting for the one in front of it');
  assert.equal(observed.active, 1, 'and only the first sync is running');

  await host.dispose();
  assert.equal(observed.runs, 2, 'disposal waited for the follow-up instead of returning over it');
  assert.equal(observed.maxActive, 1, 'still one at a time');
  assert.equal(git(c.repoDir, ['status', '--porcelain=v1']), '', 'the work is in the commit');

  // Disposal is what a teardown waits on: a run it did not wait for would write
  // this case's state directory back after it was removed.
  c.cleanup();
  await wait(250);
  assert.equal(existsSync(c.root), false, 'and nothing writes the case back after it is gone');
});
