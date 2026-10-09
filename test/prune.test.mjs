/**
 * What prune may remove, and what it must never remove.
 *
 * These are the rules that decide whether a finished task leaves a branch
 * behind forever, so each case builds the real leftover with real git and then
 * asks the action what it would do — and, with apply, does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import * as state from '../lib/state.mjs';
import { git, localBranches, makeCase, remoteBranches, worktreePaths } from './helpers.mjs';

test('a branch with no work of its own is swept, and the remote ref it leaves is named', async (t) => {
  const c = makeCase('prune-orphan');
  t.after(() => c.cleanup());

  // The leftover a killed creation leaves: a task branch, no worktree, nothing
  // of its own, already pushed.
  git(c.repoDir, ['branch', 'dsh/orphan', 'origin/main']);
  git(c.repoDir, ['push', 'origin', 'dsh/orphan']);
  assert.ok(remoteBranches(c.originDir).includes('dsh/orphan'));

  const dry = await runAction('prune', { action: 'prune', repo: c.repoDir }, c.context());
  const found = (dry.branches ?? []).find((entry) => entry.branch === 'dsh/orphan');
  assert.ok(found, 'the dry run reports the orphan');
  assert.equal(dry.applied, false);
  assert.ok(localBranches(c.repoDir).includes('dsh/orphan'), 'a dry run removes nothing');

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, apply: true }, c.context());
  assert.ok(!localBranches(c.repoDir).includes('dsh/orphan'), 'the local branch is gone');
  assert.ok(remoteBranches(c.originDir).includes('dsh/orphan'), 'the remote ref is still there - that is the fact to report');

  const entry = (applied.branches ?? []).find((branch) => branch.branch === 'dsh/orphan');
  assert.equal(entry.remoteKept, true, 'the surviving remote ref is reported, not left silent');
  assert.ok((applied.notes ?? []).some((note) => note.includes('dsh/orphan')), 'and it is named in the notes');
});

test('a branch that holds work is reported and kept', async (t) => {
  const c = makeCase('prune-kept');
  t.after(() => c.cleanup());

  // A real commit on a real branch, not checked out anywhere.
  const tree = git(c.repoDir, ['rev-parse', 'HEAD^{tree}']);
  const sha = execFileSync('git', ['commit-tree', tree, '-p', 'HEAD', '-m', 'work of its own'], { cwd: c.repoDir, encoding: 'utf8' }).trim();
  git(c.repoDir, ['branch', 'dsh/mine', sha]);

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, apply: true }, c.context());
  const entry = (applied.branches ?? []).find((branch) => branch.branch === 'dsh/mine');
  assert.ok(entry, 'the branch is reported');
  assert.equal(entry.kept, true);
  assert.match(entry.reason, /holds 1 commit\(s\) of its own/u);
  assert.ok(localBranches(c.repoDir).includes('dsh/mine'), 'it is never deleted');
});

test('an abandoned worktree whose directory is gone loses its registration, marker and session record', async (t) => {
  const c = makeCase('prune-abandoned');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'abandoned' }, c.context());
  assert.equal(started.ok, true);
  const worktree = started.worktree;
  const marker = worktree + '.owned.json';
  assert.ok(existsSync(marker));

  // The directory disappears without git being told - a deleted checkout, a
  // killed process, a cleaned machine.
  rmSync(worktree, { recursive: true, force: true });

  const dry = await runAction('prune', { action: 'prune', repo: c.repoDir }, c.context());
  assert.ok((dry.worktrees ?? []).some((entry) => entry.path === worktree), 'the stale registration is listed');

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, apply: true }, c.context());
  assert.ok((applied.worktrees ?? []).some((entry) => entry.path === worktree), 'and removed');
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir], 'git no longer registers it');
  assert.ok(!existsSync(marker), 'the ownership marker does not outlive it');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 0, 'nor does the session record');
});

test('a worktree the caller names is removed together with the branch it frees', async (t) => {
  const c = makeCase('prune-named');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'walked-away' }, c.context());
  assert.equal(started.ok, true);

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['walked-away'], apply: true }, c.context());
  const entry = (applied.namedWorktrees ?? []).find((tree) => tree.path === started.worktree);
  assert.equal(entry.removed, true);
  assert.equal(entry.branchRemoved, true, 'the branch it freed held nothing, so it goes too');
  assert.ok(!existsSync(started.worktree));
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir]);
  assert.ok(!localBranches(c.repoDir).includes('dsh/walked-away'));
});
