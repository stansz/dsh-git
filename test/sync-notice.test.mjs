/**
 * One notice per sync run, not one per request.
 *
 * Folding is right: a request that arrives while a sync is running is covered by
 * the follow-up run instead of starting a second one. But the report used to
 * live on the promise each caller received, and every folded request is handed
 * the same run's promise — so a run covering three requests woke the model three
 * times with the same notice, on top of the settle's own: four notices for two
 * runs. The notices are this plugin's user interface, and four wakes for two runs
 * is junk.
 *
 * These cases drive the real registerTurnSync with a fake Host that captures the
 * notices and a real repository. The sync under test is the real runTurnSync,
 * called through an instrument that can hold the first run open, so "several
 * requests land during one in-flight sync" is a fact rather than a hope about
 * timing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { record } from '../lib/session-files.mjs';
import { registerTurnSync, runTurnSync } from '../lib/turn-commit.mjs';
import { makeCase } from './helpers.mjs';

/** The quiet period these cases use: short, because the counts are what is tested. */
const SETTLE_MS = 200;

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
 * The real sync, wrapped so a case can see it and hold it.
 *
 * The wrapper calls the real runTurnSync and records runs and concurrency. With
 * `holdFirst`, the first run stays in flight until the case releases it, which is
 * how "these requests landed during one in-flight sync" is made deterministic.
 */
function heldSync(options = {}) {
  const observed = { runs: 0, active: 0, maxActive: 0 };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const run = async (context) => {
    observed.runs += 1;
    const index = observed.runs;
    observed.active += 1;
    observed.maxActive = Math.max(observed.maxActive, observed.active);
    try {
      if (index === 1 && options.holdFirst === true) await held;
      return await runTurnSync(context);
    } finally {
      observed.active -= 1;
    }
  };
  return { observed, run, releaseFirstRun: release };
}

/**
 * A Host, reduced to what the plugin uses, that captures the notices.
 *
 * With no workspace-changes recorder there is no turn summary to wait for, so a
 * run starts as soon as its trigger fires.
 */
function fakeHost(c, options) {
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
  const dispose = registerTurnSync(ctx, options.config, {
    settleMs: SETTLE_MS,
    runSync: options.runSync,
  });
  return {
    agent, injected, woken, warnings, dispose,
    toolCall: () => handlers.get('tools/pre-execute')?.({ agent }, () => undefined),
    turnStopping: (turn) => handlers.get('agent/turn-stopping')?.({ agent, turn, signal: undefined }),
  };
}

/**
 * A case whose repository is dirty, recorded, and never committed.
 *
 * The commit is skipped by the file-count limit, so every run finds work it must
 * report — the condition the duplicate notices were measured in — and the record
 * is never dropped, because nothing is ever committed. This rode on
 * `turnCommit: false` until that notice was made quiet: a configured off-switch is
 * the configured outcome, not a skip to report, and saying it every turn is the
 * noise the setting exists to avoid.
 */
function noticeCase(name) {
  const c = makeCase(name);
  for (const name of ['written.txt', 'written-too.txt']) {
    const file = join(c.repoDir, name);
    writeFileSync(file, 'written during a turn\n');
    assert.equal(record(c.sessionId, c.repoDir, file, { stateRoot: c.config.stateRoot }), true);
  }
  return { c, config: { ...c.config, turnCommitMaxFiles: 1 } };
}

test('one trigger produces one notice', async (t) => {
  const { c, config } = noticeCase('sync-notice-one');
  // One hook, and it disposes before it removes the case: node runs after hooks
  // in registration order, so a bare cleanup registered first would race the sync
  // this case starts.
  let host;
  t.after(async () => {
    await host?.dispose();
    c.cleanup();
  });
  const { observed, run } = heldSync();
  host = fakeHost(c, { config, runSync: run });

  host.toolCall();
  assert.equal(await until(() => host.injected.length >= 1), true, 'the settled run reported something');
  // No second notice is coming; give one time to arrive if it were.
  await wait(500);

  assert.equal(observed.runs, 1, 'one trigger, one run');
  assert.equal(observed.maxActive, 1, 'and one run at a time');
  assert.equal(host.injected.length, 1, 'one notice, not one per listener and one per run');
  assert.equal(host.woken.length, 1, 'the agent is woken once, for the one notice');
  assert.match(host.injected[0].content[0].text, /above the limit/u, 'and it is the run\'s own report');
  assert.equal(host.injected[0].source.kind, 'user', 'an inbox message still carries its producer');
});

test('three requests folded into one run produce one notice per run', async (t) => {
  const { c, config } = noticeCase('sync-notice-fold');
  let host;
  t.after(async () => {
    releaseFirstRun();
    await host?.dispose();
    c.cleanup();
  });
  const { observed, run, releaseFirstRun } = heldSync({ holdFirst: true });
  host = fakeHost(c, { config, runSync: run });

  // Trigger one: a tool call, and the quiet period it arms.
  host.toolCall();
  assert.equal(await until(() => observed.runs >= 1), true, 'the first run is in flight');

  // Three turn boundaries land while it is still running. They fold into exactly
  // one follow-up run, which is what D32 established.
  host.turnStopping(1);
  host.turnStopping(2);
  host.turnStopping(3);
  releaseFirstRun();

  assert.equal(await until(() => observed.runs >= 2 && host.injected.length >= 2), true, 'both runs finished and reported');
  // Any per-request copy of the folded run's report would have arrived by now.
  await wait(500);

  assert.equal(observed.runs, 2, 'three folded requests are one follow-up run, not three');
  assert.equal(observed.maxActive, 1, 'and it never ran beside the first');
  assert.equal(host.injected.length, 2, 'one notice per run: two runs, two notices — not four');
  assert.equal(host.woken.length, 2, 'and one wake per notice');
  for (const message of host.injected) {
    assert.match(message.content[0].text, /above the limit/u, 'each notice is a run\'s own report');
  }
});
