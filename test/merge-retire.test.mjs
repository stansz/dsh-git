/**
 * Retiring a merged task, at the moment of the merge.
 *
 * Action \`merge\` calls retireMergedWorktree() as soon as the pull request is
 * merged, because that is the one moment the fact is free: a squash leaves
 * nothing local that can prove the branch was merged, so a later \`prune\` has to
 * ask GitHub again — on a machine that may have no credentials, no network and
 * no github.com remote.
 *
 * The GitHub half of a merge cannot run in this suite, so what is pinned here is
 * the half that removes things, driven against real repositories, real worktrees
 * and the plugin's own state file. The refusal matters as much as the removal:
 * nothing that holds work may be discarded to tidy up after a merge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { retireMergedWorktree, runAction } from '../lib/actions.mjs';
import * as state from '../lib/state.mjs';
import { git, localBranches, makeCase, worktreePaths } from './helpers.mjs';

test('a merged task is retired: worktree, session record and branch', async (t) => {
  const c = makeCase('merge-retire');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'merged-task' }, c.context());
  const worktree = started.worktree;
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'work.txt'), 'the work\n');
  git(worktree, ['add', '-A']);
  git(worktree, ['-c', 'user.email=x@y.z', '-c', 'user.name=x', 'commit', '-m', 'feat: the work']);

  const entry = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees[0];
  assert.equal(entry.path, worktree);

  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, entry);
  assert.equal(record.removed, true);
  assert.equal(record.branchRemoved, true, 'the branch goes only because the worktree did');
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(worktree + '.owned.json'), false, 'the ownership marker does not outlive it');
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir], 'no registration is left behind');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 0);
  assert.ok(!localBranches(c.repoDir).includes('dsh/merged-task'));
});

test('a worktree holding uncommitted work is refused, and its branch with it', async (t) => {
  const c = makeCase('merge-retire-dirty');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'unfinished' }, c.context());
  const worktree = started.worktree;
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'unsaved.txt'), 'not committed\n');

  const entry = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees[0];
  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, entry);
  assert.equal(record.removed, false, 'a merge never discards uncommitted work');
  assert.match(String(record.error), /uncommitted change/u);
  assert.ok(Array.isArray(record.dirty) && record.dirty.length > 0);
  assert.equal(existsSync(join(worktree, 'src', 'unsaved.txt')), true, 'the work is exactly where it was');
  assert.ok(localBranches(c.repoDir).includes('dsh/unfinished'), 'and the branch holding it survives');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 1, 'the session still owns it');
});

test('a merge that could not happen retires nothing', async (t) => {
  const c = makeCase('merge-retire-not-github');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'not-merged' }, c.context());
  const merged = await runAction('merge', { action: 'merge', repo: started.worktree }, c.context());
  assert.equal(merged.ok, false);
  assert.equal(merged.error.code, 'not-github');
  assert.equal(existsSync(started.worktree), true, 'the task is untouched when the merge did not happen');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 1);
});

test('a record pointing at something that is not a worktree is refused', async (t) => {
  const c = makeCase('merge-retire-foreign');
  t.after(() => c.cleanup());
  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, { path: join(c.root, 'nowhere'), branch: 'dsh/nowhere' });
  assert.equal(record.removed, false);
  assert.match(String(record.error), /not a worktree/u);
});
