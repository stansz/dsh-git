/**
 * The automatic half: it has to run without anyone to run it.
 *
 * The plugin promises that the work a turn changed is committed and pushed at
 * the end of that turn. The registrations for the two events that would deliver
 * such a boundary are in lib/turn-commit.mjs and neither of them arrives in this
 * deployment — boundary.log holds 228 entries over four days and every one of
 * them was written by the tools-layer fallback. The fallback used to run the sync
 * at the START of the next tool call, throttled to once a minute, so a session
 * that ended a turn stopped there with its work uncommitted, and the commit it
 * eventually made said 'dsh: turn 0' — a number true of no turn.
 *
 * These cases drive the real registerTurnSync with a Host reduced to the parts
 * the plugin actually uses: a handler map, a logger, and an agent. The git, the
 * commit, the store and the timers are all real, and the timing assertions are
 * the point rather than an inconvenience.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as store from '../lib/session-files.mjs';
import { messageFor, registerTurnSync, syncRepo } from '../lib/turn-commit.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { git, makeCase } from './helpers.mjs';

/**
 * The quiet period these cases use.
 *
 * Half a second, not the four the plugin ships: long enough that a "nothing has
 * happened yet" assertion has real margin on a loaded machine — the suite runs
 * its files in parallel — and short enough that the positive assertions are
 * quick. Nothing here asserts that a commit happened *at* a moment; that would
 * be a test of the scheduler. It asserts the order: a tool call does not commit,
 * and the quiet afterwards does.
 */
const SETTLE_MS = 500;

/** Comfortably inside the quiet period, for the assertions that nothing ran yet. */
const STILL_BUSY_MS = 100;

/** The commit subject at HEAD. */
function headSubject(repoDir) {
  return git(repoDir, ['log', '-1', '--format=%s']);
}

/** What the body of HEAD says, for the trailer every automatic commit carries. */
function headBody(repoDir) {
  return git(repoDir, ['log', '-1', '--format=%b']);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for HEAD to change, and report what it became.
 *
 * The positive assertions poll rather than sleep a fixed amount, because the
 * commit is made by a timer the test does not own and the machine is running
 * eight other test files at the same time. A deadline is the honest assertion:
 * *this happened*, rather than *this happened within n milliseconds*.
 */
async function commitLands(repoDir, before, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const subject = headSubject(repoDir);
    if (subject !== before) return subject;
    if (Date.now() >= deadline) return subject;
    await wait(25);
  }
}

/**
 * A Host, reduced to what the plugin uses.
 *
 * `on` is the registration surface, `get` is the service lookup (undefined here:
 * this deployment has no workspace-changes summary for the recorder, which is
 * exactly why the sync falls back to the session's own touched-file store), and
 * the agent is the thing a notice has to reach.
 */
function fakeHost(c, options = {}) {
  const handlers = new Map();
  const injected = [];
  const woken = [];
  const warnings = [];
  const infos = [];
  const agent = {
    id: c.sessionId,
    inject: (message) => injected.push(message),
    followup: () => woken.push(Date.now()),
  };
  // The two optional services decide which source names the commit. With a
  // recorder, its per-turn file list is the precise one; without it the plugin
  // falls back to this session's own touched-file store. Both are exercised.
  const session = options.recorder === undefined
    ? { id: c.sessionId, header: { cwd: c.reference } }
    : {
      id: c.sessionId,
      header: { cwd: c.reference },
      seq: 1,
      eventAt: () => ({ type: 'workspace/changes' }),
    };
  const services = {
    sessions: { get: () => session },
    workspaceChanges: options.recorder === undefined
      ? undefined
      : { summary: () => ({ files: options.recorder.files.map((path) => ({ path })) }) },
  };
  const ctx = {
    on: (name, handler) => { handlers.set(name, handler); },
    logger: {
      info: (line) => infos.push(String(line)),
      warn: (line) => warnings.push(String(line)),
    },
    get: (name) => services[name],
  };
  const dispose = registerTurnSync(ctx, options.config ?? c.config, { settleMs: options.settleMs ?? SETTLE_MS });
  return {
    agent, injected, woken, warnings, infos, dispose,
    /** One tool call, as the tools layer delivers it. */
    toolCall: () => handlers.get('tools/pre-execute')?.({ agent }, () => undefined),
    /** The awaited turn close, if this deployment ever delivers it. */
    turnStopping: (turn) => handlers.get('agent/turn-stopping')?.({ agent, turn, signal: undefined }),
  };
}

/** A fixture with one uncommitted file the session is recorded as having written. */
function dirtyTurn(name) {
  const c = makeCase(name);
  const file = join(c.repoDir, 'written.txt');
  writeFileSync(file, 'written during a turn\n');
  assert.equal(store.record(c.sessionId, c.repoDir, file, { stateRoot: c.config.stateRoot }), true);
  return { c, file };
}

test('a tool call arms the turn close; the quiet after it is what commits', async (t) => {
  const { c, file } = dirtyTurn('boundary-settles');
  t.after(() => c.cleanup());
  const host = fakeHost(c);
  t.after(() => host.dispose());

  const before = headSubject(c.repoDir);
  host.toolCall();
  await wait(STILL_BUSY_MS);
  assert.equal(headSubject(c.repoDir), before, 'the tool call itself commits nothing — that is the whole point');

  const subject = await commitLands(c.repoDir, before);
  assert.notEqual(subject, before, 'the turn close fires by itself, with no further tool call');
  assert.equal(subject, 'dsh: written.txt', 'and it names what it contains instead of claiming a turn');
  assert.match(headBody(c.repoDir), /Assisted-by: DSH/u);
  assert.equal(git(c.repoDir, ['show', '--name-only', '--format=', 'HEAD']), 'written.txt');
  // The record is dropped by the sync itself, just after the commit it belongs
  // to becomes visible to another process — so this waits for it rather than
  // assuming it won a race it is not running.
  const deadline = Date.now() + 15000;
  while (store.pathsOf(c.sessionId, c.repoDir, { stateRoot: c.config.stateRoot }).length > 0 && Date.now() < deadline) {
    await wait(25);
  }
  assert.deepEqual(store.pathsOf(c.sessionId, c.repoDir, { stateRoot: c.config.stateRoot }), [], 'and the record is done with');
  assert.ok(file.length > 0);
});

test('a session that keeps calling tools never commits mid-turn', async (t) => {
  const { c } = dirtyTurn('boundary-busy');
  t.after(() => c.cleanup());
  const host = fakeHost(c);
  t.after(() => host.dispose());

  // A burst of tool calls, each of which pushes the quiet period out. The claim
  // is not "no commit happens quickly" — it is that the commit is a function of
  // the LAST call, so a session that keeps working is never committed halfway
  // through. The old boundary committed ~2 s after the first call of the burst,
  // which is what this notices.
  const before = headSubject(c.repoDir);
  for (let index = 0; index < 8; index += 1) {
    host.toolCall();
    await wait(400);
  }
  assert.equal(headSubject(c.repoDir), before, 'eight calls over three seconds, and the turn is still open');
  const subject = await commitLands(c.repoDir, before);
  assert.notEqual(subject, before, 'and the turn is closed once the calls really stop');
});

test('a turn close that arrives carries its own number', async (t) => {
  const { c } = dirtyTurn('boundary-real-event');
  t.after(() => c.cleanup());
  const host = fakeHost(c);
  t.after(() => host.dispose());

  const before = headSubject(c.repoDir);
  host.turnStopping(3);
  assert.equal(await commitLands(c.repoDir, before), 'dsh: turn 3 \u2014 written.txt', 'a real turn number is used when the Host supplies one');
});

test('the sync that runs is the sync that speaks', async (t) => {
  const { c } = dirtyTurn('boundary-notify');
  t.after(() => c.cleanup());
  // The automatic commit is switched off, so the tree is left dirty and the sync
  // has something it must report. Before this was fixed the path that actually
  // ran said it to a log file and to nobody else.
  const host = fakeHost(c, { config: { ...c.config, turnCommit: false } });
  t.after(() => host.dispose());

  host.toolCall();
  const deadline = Date.now() + 15000;
  while (host.injected.length === 0 && Date.now() < deadline) await wait(25);
  assert.equal(headSubject(c.repoDir), 'chore: the fixture repository', 'nothing was committed, as configured');
  assert.equal(host.injected.length, 1, 'the model is told, not just the Host log');
  assert.match(host.injected[0].content[0].text, /turnCommit: false/u);
  assert.equal(typeof host.injected[0].id, 'string', 'an inbox message needs a stable id');
  assert.equal(host.injected[0].source.kind, 'user');
  assert.equal(host.woken.length, 1, 'and the agent is woken, or the note waits for an unrelated prompt');
  assert.ok(host.warnings.length > 0, 'the Host log says so as well');
});

test('disposal runs the turn it was holding instead of dropping it', async (t) => {
  const { c, file } = dirtyTurn('boundary-dispose');
  t.after(() => c.cleanup());
  const host = fakeHost(c);

  const before = headSubject(c.repoDir);
  host.toolCall();
  host.dispose();
  assert.notEqual(await commitLands(c.repoDir, before), before, 'work the plugin was holding when it went away is still committed');
  // And say who did it. "The work got committed" is also true of a sync that was
  // already running and would have finished anyway; the point of draining is that
  // disposal itself runs what it was holding.
  const log = readFileSync(join(c.root, 'state', 'dsh-git', 'boundary.log'), 'utf8');
  assert.match(log, /dispose drained a pending turn sync/u);
  assert.match(log, /settled sync repos=1/u);
  assert.ok(existsSync(file) === false, 'the fixture file is in the commit, not the tree');
});

test('when the deployment has a recorder, its file list is what is committed', async (t) => {
  const c = makeCase('boundary-recorder');
  t.after(() => c.cleanup());
  const file = join(c.repoDir, 'from-recorder.txt');
  writeFileSync(file, 'reported by the recorder\n');
  // Deliberately NOT recorded in the session store: the only way this repository
  // can be reached is through the recorder's summary, which is the branch under
  // test.
  const host = fakeHost(c, { recorder: { files: [file] } });
  t.after(() => host.dispose());

  const before = headSubject(c.repoDir);
  host.toolCall();
  assert.equal(await commitLands(c.repoDir, before), 'dsh: from-recorder.txt');
});

test('an automatic commit with no turn reported is named by its contents', async (t) => {
  const c = makeCase('boundary-subject');
  t.after(() => c.cleanup());
  const file = join(c.repoDir, 'written.txt');
  writeFileSync(file, 'written\n');

  const synced = await syncRepo(c.repoDir, c.config, c.sessionId, [file], {});
  assert.equal(synced.committed, true);
  assert.equal(synced.subject, 'dsh: written.txt');
  assert.doesNotMatch(synced.subject, /turn 0/u);

  // A session whose turn the Host did report keeps the number it was given.
  writeFileSync(file, 'written again\n');
  const numbered = await syncRepo(c.repoDir, c.config, c.sessionId, [file], { turn: 12 });
  assert.equal(numbered.subject, 'dsh: turn 12 \u2014 written.txt');
});

test('a configured message template is not filled with the word undefined', () => {
  const config = resolveConfig({ turnCommitMessage: 'wip {turn}: {paths}' });
  assert.equal(messageFor(config, 4, ['a.mjs']).split('\n')[0], 'wip 4: a.mjs');
  assert.equal(messageFor(config, undefined, ['a.mjs']).split('\n')[0], 'wip : a.mjs');
});

test('the boundary that fires is recorded, whichever one it was', async (t) => {
  const { c } = dirtyTurn('boundary-diagnostics');
  t.after(() => c.cleanup());
  const host = fakeHost(c);
  t.after(() => host.dispose());

  const before = headSubject(c.repoDir);
  host.toolCall();
  host.turnStopping(2);
  await commitLands(c.repoDir, before);
  const log = readFileSync(join(c.root, 'state', 'dsh-git', 'boundary.log'), 'utf8');
  assert.match(log, /tools\/pre-execute/u);
  assert.match(log, /agent\/turn-stopping/u, 'a boundary that never arrives has to say so, or its silence is indistinguishable from an idle turn');
});
