/**
 * A retired worktree must not outlive itself in the session file.
 *
 * Two records in that file name a worktree's directory: the ownership record,
 * and the push backoff the turn sync writes when a push from inside the worktree
 * fails. Retiring the worktree used to drop only the first, so a live state file
 * kept a backoff entry for a worktree a merge had already removed — and a record
 * whose directory was gone was read again on every turn. The turn sync then
 * treats a recorded worktree that is not on disk as nothing to sync: it drops
 * the record and its backoff and says nothing to the model about it.
 *
 * Everything here is real: real repositories, the real start/prune/retire
 * paths, the real registerTurnSync with a Host reduced to what the plugin uses,
 * and assertions read from the real state file rather than from a log line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { retireMergedWorktree, runAction } from '../lib/actions.mjs';
import * as state from '../lib/state.mjs';
import { registerTurnSync, runTurnSync } from '../lib/turn-commit.mjs';
import { git, makeCase, worktreePaths } from './helpers.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The worktree paths this session still remembers. */
function worktreeRecords(c) {
  return state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.map((entry) => entry.path);
}

/** The paths a push backoff is recorded against. */
function pushFailureKeys(c) {
  return Object.keys(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).pushFailures);
}

/**
 * A Host, reduced to what the plugin uses: the registration surface, a logger,
 * and the agent a notice has to reach. Lifted from turn-boundary.test.mjs, with
 * the same meaning: the sync under test is the real one.
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
  const session = { id: c.sessionId, header: { cwd: c.reference } };
  const ctx = {
    on: (name, handler) => { handlers.set(name, handler); },
    logger: {
      info: (line) => infos.push(String(line)),
      warn: (line) => warnings.push(String(line)),
    },
    get: (name) => (name === 'sessions' ? { get: () => session } : undefined),
  };
  const dispose = registerTurnSync(ctx, options.config ?? c.config, {
    settleMs: options.settleMs ?? 400,
    ceilingMs: options.ceilingMs ?? 60000,
  });
  return {
    injected, woken, warnings, infos, dispose,
    /** One tool call, as the tools layer delivers it. */
    toolCall: () => handlers.get('tools/pre-execute')?.({ agent }, () => undefined),
  };
}

test('the merge close drops the worktree record and the push backoff recorded against it', async (t) => {
  const c = makeCase('stale-records-merge');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'retired-task' }, c.context());
  assert.equal(started.ok, true);
  const worktree = started.worktree;

  // The live shape: the automatic sync pushed from inside the worktree and the
  // push failed, so the backoff is keyed by the worktree's own path.
  state.recordPushFailure(c.sessionId, worktree, 'error: failed to push some refs to \'origin\'', { stateRoot: c.config.stateRoot });
  assert.ok(pushFailureKeys(c).includes(worktree), 'the fixture records a backoff against the worktree');

  const entry = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.find((tree) => tree.path === worktree);
  assert.ok(entry, 'and the session owns the worktree');
  const tip = git(worktree, ['rev-parse', 'HEAD']);

  // The merge path: the pull request's commit is known, so the task is retired
  // now rather than at some later prune.
  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, entry, { tip });
  assert.equal(record.removed, true, 'the clean worktree is retired');

  assert.ok(!existsSync(worktree), 'the directory is gone');
  assert.ok(!worktreePaths(c.repoDir).includes(worktree), 'and git no longer registers it');
  assert.deepEqual(worktreeRecords(c), [], 'the session record goes with it');
  assert.ok(!pushFailureKeys(c).includes(worktree), 'and so does the backoff keyed by its path');
});

test('the named prune path drops the record and the backoff too', async (t) => {
  const c = makeCase('stale-records-prune');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'pruned-task' }, c.context());
  assert.equal(started.ok, true);
  state.recordPushFailure(c.sessionId, started.worktree, 'error: failed to push some refs to \'origin\'', { stateRoot: c.config.stateRoot });
  assert.ok(pushFailureKeys(c).includes(started.worktree));

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['pruned-task'], apply: true }, c.context());
  const entry = (applied.namedWorktrees ?? []).find((tree) => tree.path === started.worktree);
  assert.equal(entry.removed, true, 'the plugin\'s own worktree is removed');

  assert.deepEqual(worktreeRecords(c), [], 'the record does not outlive the worktree');
  assert.ok(!pushFailureKeys(c).includes(started.worktree), 'nor does the backoff');
});

test('the sync forgets a recorded worktree whose directory is gone, and says nothing to the model', async (t) => {
  const c = makeCase('stale-records-sync');
  const host = fakeHost(c, { settleMs: 400 });
  t.after(async () => {
    await host.dispose();
    c.cleanup();
  });

  // A record for a worktree that is not there — retired by hand, by an earlier
  // merge, or with a machine that was cleaned. Nothing of it is on disk, which is
  // the whole reason it must not be synced and must not be reported.
  const vanished = join(c.root, '.worktrees', 'app', 'vanished-task');
  assert.equal(state.addWorktree(c.sessionId, {
    repo: 'app',
    repoRoot: c.repoDir,
    path: vanished,
    branch: 'dsh/vanished-task',
    slug: 'vanished-task',
  }, { stateRoot: c.config.stateRoot }), true);
  state.recordPushFailure(c.sessionId, vanished, 'error: failed to push some refs to \'origin\'', { stateRoot: c.config.stateRoot });
  // The other half of the live shape: a backoff whose worktree was already
  // forgotten — the directory, branch and remote ref all deleted by an earlier
  // cleanup — so no retire path will ever run for it again. The sync is the only
  // thing left that can notice it is dead weight.
  const orphanBackoff = join(c.root, '.worktrees', 'app', 'fetch-prune');
  state.recordPushFailure(c.sessionId, orphanBackoff, 'error: failed to push some refs to \'origin\'', { stateRoot: c.config.stateRoot });
  assert.ok(worktreeRecords(c).includes(vanished), 'the dead record is in the file to start with');
  assert.ok(pushFailureKeys(c).includes(vanished), 'and so is its backoff');
  assert.ok(pushFailureKeys(c).includes(orphanBackoff), 'and a backoff whose worktree is already long gone');

  // Wait for the settled sync to finish the whole run, not just the part that
  // drops the record: the boundary log line is written after the sync and the
  // marker-driven close, so it is the completion signal.
  const boundaryLog = join(c.root, 'state', 'dsh-git', 'boundary.log');
  const settledRan = () => existsSync(boundaryLog) && /settled sync repos=/u.test(readFileSync(boundaryLog, 'utf8'));
  host.toolCall();
  const deadline = Date.now() + 8000;
  while (!(settledRan() && !worktreeRecords(c).includes(vanished)) && Date.now() < deadline) await wait(25);

  assert.ok(settledRan(), 'the settled sync really ran');
  assert.ok(!worktreeRecords(c).includes(vanished), 'and it dropped the dead record');
  assert.ok(!pushFailureKeys(c).includes(vanished), 'and its backoff with it');
  assert.ok(!pushFailureKeys(c).includes(orphanBackoff), 'and the backoff with no worktree left to belong to');
  assert.equal(host.injected.length, 0, 'and the model is not told about a retired worktree');
  assert.equal(host.woken.length, 0, 'nor woken for one');
  assert.ok(host.warnings.every((line) => !line.includes('could not read repository state')), 'nor is it logged as a failure to read');
});

test('a worktree that is still on disk keeps its record and its backoff', async (t) => {
  const c = makeCase('stale-records-live');
  t.after(() => c.cleanup());

  // The other side of the rule: the filesystem at the moment of the check decides.
  // A directory that is still there — including one whose removal has started but
  // not finished — keeps its record, so a live worktree is never forgotten.
  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'live-task' }, c.context());
  assert.equal(started.ok, true);
  state.recordPushFailure(c.sessionId, started.worktree, 'error: failed to push some refs to \'origin\'', { stateRoot: c.config.stateRoot });

  const synced = await runTurnSync({ config: c.config, cwd: c.root, sessionId: c.sessionId, turn: undefined });

  assert.ok(worktreeRecords(c).includes(started.worktree), 'the live worktree is still remembered');
  assert.ok(pushFailureKeys(c).includes(started.worktree), 'and its backoff is untouched');
  assert.deepEqual(synced.forgotten?.worktrees ?? [], [], 'nothing was forgotten');
  assert.ok(existsSync(started.worktree), 'the directory is exactly where it was');
});
