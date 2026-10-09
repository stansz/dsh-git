/**
 * Closing one task must not disturb another, and a cleanup that cannot happen
 * must say so instead of reporting success by silence.
 *
 * Two tasks of the same repository is the shape an Agent Team produces, and the
 * session's state keys worktrees per repository, so this is where a removal that
 * is too broad shows up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { runAction } from '../lib/actions.mjs';
import * as state from '../lib/state.mjs';
import { makeCase } from './helpers.mjs';

test('finish --cleanup closes the task it names and leaves its sibling alone', async (t) => {
  const c = makeCase('cleanup-siblings');
  t.after(() => c.cleanup());

  const first = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'first-task' }, c.context());
  const second = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'second-task' }, c.context());
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 2);

  const finished = await runAction('finish', { action: 'finish', repo: first.worktree, cleanup: true }, c.context());
  assert.equal(finished.worktreeRemoved, true);
  assert.ok(!existsSync(first.worktree), 'the finished task is gone');

  // The other task is still open: its directory, its registration and the
  // session record that says this session owns it.
  assert.ok(existsSync(second.worktree), 'the other task is still on disk');
  const recorded = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot });
  assert.equal(recorded.worktrees.length, 1, 'only the finished task left the session record');
  assert.equal(recorded.worktrees[0].path, second.worktree);

  // And the session can still close it, which is the point of the record.
  const also = await runAction('finish', { action: 'finish', repo: second.worktree, cleanup: true }, c.context());
  assert.equal(also.worktreeRemoved, true);
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 0);
});

test('finish --cleanup from the main checkout says there is nothing to remove', async (t) => {
  const c = makeCase('cleanup-main');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'open-task' }, c.context());
  assert.equal(started.ok, true);

  // The caller named the repository, not the worktree. There is no worktree to
  // close, and the result has to carry that rather than look like a success.
  const finished = await runAction('finish', { action: 'finish', repo: c.repoDir, cleanup: true }, c.context());
  assert.equal(finished.ok, true);
  assert.notEqual(finished.worktreeRemoved, true);
  assert.equal(finished.worktreeKept, true);
  assert.ok(Array.isArray(finished.notes) && finished.notes.some((note) => /worktree/u.test(note)), 'the result names the reason cleanup did nothing');
  assert.ok(existsSync(started.worktree), 'the open task was not touched');
});
