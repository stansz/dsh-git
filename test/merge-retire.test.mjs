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

  // The tip is the caller's proof that this branch is exactly what the pull
  // request merged. Action merge has it from the API; here it is read the same
  // way, from the branch.
  const tip = git(worktree, ['rev-parse', 'HEAD']);
  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, entry, { tip });
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

test('a merge that did not report its commit leaves the branch where it is', async (t) => {
  const c = makeCase('merge-retire-no-tip');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'unreported-merge' }, c.context());
  mkdirSync(join(started.worktree, 'src'), { recursive: true });
  writeFileSync(join(started.worktree, 'src', 'work.txt'), 'the work\n');
  git(started.worktree, ['add', '-A']);
  git(started.worktree, ['-c', 'user.email=x@y.z', '-c', 'user.name=x', 'commit', '-m', 'feat: the work']);
  const tip = git(started.worktree, ['rev-parse', 'HEAD']);
  const entry = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees[0];

  // No tip: the pull request is merged, and that is all that is known. The
  // worktree is clean so it goes, and the branch — the only thing naming that
  // commit — stays. An absent proof is a refusal, never a weaker deletion.
  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, entry);
  assert.equal(record.removed, true);
  assert.equal(record.branchRemoved, undefined);
  assert.match(String(record.branchKept), /was not reported/u);
  assert.equal(git(c.repoDir, ['rev-parse', 'refs/heads/' + entry.branch]), tip);
});

test('a record pointing at something that is not a worktree is refused', async (t) => {
  const c = makeCase('merge-retire-foreign');
  t.after(() => c.cleanup());
  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, { path: join(c.root, 'nowhere'), branch: 'dsh/nowhere' });
  assert.equal(record.removed, false);
  assert.match(String(record.error), /not a worktree/u);
});

test('a squash or a rebase merge is refused before the API is asked', async (t) => {
  const c = makeCase('merge-refuse-method');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'would-squash' }, c.context());

  for (const method of ['squash', 'rebase']) {
    const refused = await runAction('merge', { action: 'merge', repo: started.worktree, method }, c.context());
    assert.equal(refused.ok, false, method + ' must not be performed');
    // The remote here is not GitHub at all, so a refusal that had come from the
    // API would carry a different code: this one proves the tool never asked.
    assert.equal(refused.error.code, 'method-refused');
    assert.match(refused.error.message, new RegExp(method, 'u'));
    assert.match(String(refused.error.hint), /defaults to merge|method: "merge"/u);
  }
  assert.equal(existsSync(started.worktree), true, 'the task is untouched');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 1);
});
