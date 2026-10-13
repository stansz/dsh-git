/**
 * Worktree and prune hygiene: the leftovers a session is told it does not have
 * to think about.
 *
 * Four failures, each one that looked handled:
 *   - a creation that failed left its branch behind while the message said the
 *     branch was removed, so the next start with that slug met an orphan;
 *   - a credential-bearing remote URL on a non-GitHub host was printed into an
 *     error the model reads and the session log keeps;
 *   - a prune identified worktrees by directory name, so a second stale worktree
 *     with the same name was neither reported nor cleaned, and a branch named
 *     `taskforce` counted as a `task/...` leftover;
 *   - removing the last worktree for a repository left its now-empty directory
 *     behind under the worktree root.
 *
 * Real repositories, real git, the real action and prune paths, and assertions
 * on real state: branch lists, worktree registrations, marker files on disk, and
 * the bytes of the error a caller would actually receive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';
import * as state from '../lib/state.mjs';
import { pruneWorktrees } from '../lib/worktrees.mjs';
import { git, localBranches, makeCase, worktreePaths } from './helpers.mjs';

/** The marker action \"start\" writes beside a worktree it created. */
function writeOwnedMarker(worktree, branch) {
  writeFileSync(worktree + '.owned.json', JSON.stringify({
    repo: basename(join(worktree, '..')),
    path: worktree,
    branch,
    slug: basename(worktree),
  }) + '\n');
}

/**
 * A plain-git worktree under its own parent, so two of them can share the
 * directory name `dup` — which is the case a name-based prune cannot tell apart.
 */
function duplicateWorktree(c, parent, branch) {
  const parentDir = join(c.root, parent);
  mkdirSync(parentDir, { recursive: true });
  const path = join(parentDir, 'dup');
  git(c.repoDir, ['worktree', 'add', '-b', branch, path]);
  return realpathSync(path);
}

test('a failed start puts its branch back, so the slug can be used again', async (t) => {
  const c = makeCase('hygiene-rollback');
  t.after(() => c.cleanup());

  const worktree = join(c.config.worktreeRoot, 'app', 'orphan-trap');
  const marker = worktree + '.owned.json';
  // Block the marker write with a directory at the marker's own path: git makes
  // the worktree and the lock, the marker cannot be written, and the rollback has
  // to undo both. This is the failure path whose rollback call passed one
  // argument too few.
  mkdirSync(marker, { recursive: true });

  const first = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'orphan-trap' }, c.context());
  assert.equal(first.ok, false, 'the creation fails, as the blocked marker path intends');
  assert.ok(!existsSync(worktree), 'the half-made worktree is gone');
  assert.ok(!localBranches(c.repoDir).includes('dsh/orphan-trap'), 'and its branch does not outlive it');
  assert.match(String(first.error?.message ?? ''), /branch/u, 'the failure says what happened to the branch');

  rmSync(marker, { recursive: true, force: true });
  const second = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'orphan-trap' }, c.context());
  assert.equal(second.ok, true, 'the same slug works on the next attempt');
  assert.equal(second.branch, 'dsh/orphan-trap', 'with the branch it promised');
});

test('two stale worktrees with the same directory name are both reported and both cleaned', async (t) => {
  const c = makeCase('hygiene-duplicate-names');
  t.after(() => c.cleanup());

  const one = duplicateWorktree(c, 'one', 'dsh/dup-one');
  const second = duplicateWorktree(c, 'two', 'dsh/dup-two');
  writeFileSync(one + '.owned.json', '{}\n');
  writeFileSync(second + '.owned.json', '{}\n');
  // Both directories go by hand, so both registrations are stale and both
  // markers are left claiming a worktree that is no longer there.
  rmSync(one, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });

  const result = await pruneWorktrees(c.repoDir, { apply: true, branchPrefix: 'dsh/', baseRef: 'refs/heads/main' });

  const reported = (result.entries ?? []).map((entry) => entry.path);
  assert.ok(reported.includes(one), 'the first stale worktree is reported');
  assert.ok(reported.includes(second), 'and so is the second, which shares its directory name');
  assert.ok(!existsSync(one + '.owned.json'), 'the first marker is cleaned');
  assert.ok(!existsSync(second + '.owned.json'), 'and the second marker does not outlive its worktree either');
});

test('a user branch that merely starts with the prefix is not a task branch', async (t) => {
  const c = makeCase('hygiene-prefix');
  t.after(() => c.cleanup());

  // The configuration the defect needs: a prefix with no slash. `taskforce` is a
  // perfectly ordinary user branch that a plain `startsWith('task')` treats as one
  // of the plugin's own leftovers.
  const config = resolveConfig({ ...c.config, branchPrefix: 'task' });
  git(c.repoDir, ['branch', 'taskforce', 'main']);

  const swept = await pruneWorktrees(c.repoDir, { apply: true, branchPrefix: 'task', baseRef: 'refs/heads/main' });
  assert.ok(localBranches(c.repoDir).includes('taskforce'), 'the user branch survives the sweep');
  assert.ok(!(swept.branches ?? []).some((entry) => entry.branch === 'taskforce'), 'and is not reported as a task branch');

  // The same rule where a caller names a branch by hand.
  const named = await runAction('prune', { action: 'prune', repo: c.repoDir, branches: ['taskforce'], apply: true }, c.context({ config }));
  const entry = (named.namedBranches ?? [])[0];
  assert.equal(entry.removed, false, 'naming it does not make it a task branch either');
  assert.match(String(entry.error), /not under the branch prefix/u);
  assert.ok(localBranches(c.repoDir).includes('taskforce'));

  // A branch inside the namespace is still swept, so the boundary is a boundary
  // and not a withdrawal from the sweep.
  git(c.repoDir, ['branch', 'task/leftover', 'main']);
  await pruneWorktrees(c.repoDir, { apply: true, branchPrefix: 'task', baseRef: 'refs/heads/main' });
  assert.ok(!localBranches(c.repoDir).includes('task/leftover'), 'a branch under the prefix is still swept');
});

test('a bare name that matches two worktrees is refused, naming both', async (t) => {
  const c = makeCase('hygiene-ambiguous');
  t.after(() => c.cleanup());

  const one = duplicateWorktree(c, 'one', 'dsh/dup-one');
  const second = duplicateWorktree(c, 'two', 'dsh/dup-two');
  writeOwnedMarker(one, 'dsh/dup-one');
  writeOwnedMarker(second, 'dsh/dup-two');

  const refused = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['dup'], apply: true }, c.context());
  const entry = (refused.namedWorktrees ?? [])[0];
  assert.equal(entry.removed, false, 'a name that identifies two worktrees removes neither');
  assert.match(String(entry.error), /more than one worktree/u, 'and says why');
  assert.ok(String(entry.error).includes(one) && String(entry.error).includes(second), 'naming both candidates');
  assert.ok(existsSync(one) && existsSync(second), 'both checkouts are exactly where they were');
  assert.deepEqual([...worktreePaths(c.repoDir)].sort(), [c.repoDir, one, second].sort(), 'and both stay registered');

  // The full path names exactly one, and is still the way through.
  const removed = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: [second], apply: true }, c.context());
  const done = (removed.namedWorktrees ?? [])[0];
  assert.equal(done.removed, true, 'the full path removes the one it names');
  assert.ok(!existsSync(second), 'that worktree is gone');
  assert.ok(existsSync(one), 'and the other one is untouched');
});

test('the repository directory under the worktree root does not outlive the last worktree', async (t) => {
  const c = makeCase('hygiene-empty-parent');
  t.after(() => c.cleanup());

  const repoDir = join(c.config.worktreeRoot, 'app');
  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'last-task' }, c.context());
  assert.equal(started.ok, true);
  assert.ok(existsSync(repoDir), 'the layout puts the worktree under <worktreeRoot>/<repo>');

  const pruned = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['last-task'], apply: true }, c.context());
  assert.equal((pruned.namedWorktrees ?? [])[0].removed, true, 'the worktree is removed');
  assert.ok(!existsSync(started.worktree), 'the directory is gone');
  assert.ok(!existsSync(repoDir), 'and the directory it lived in does not stay behind');

  // Anything still in there is somebody's, so the directory stays.
  const second = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'kept-task' }, c.context());
  assert.equal(second.ok, true);
  const keep = join(repoDir, 'somebody-elses.txt');
  writeFileSync(keep, 'not the plugin\'s to delete\n');
  const removed = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['kept-task'], apply: true }, c.context());
  assert.equal((removed.namedWorktrees ?? [])[0].removed, true);
  assert.ok(existsSync(keep), 'the file is untouched');
  assert.ok(existsSync(repoDir), 'and the directory that holds it stays');

  // Finder metadata is not content: a directory holding only a .DS_Store is the
  // exact leftover the live deployment showed, and it goes.
  rmSync(keep, { force: true });
  const third = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'finder-task' }, c.context());
  assert.equal(third.ok, true);
  writeFileSync(join(repoDir, '.DS_Store'), 'finder metadata\n');
  await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['finder-task'], apply: true }, c.context());
  assert.ok(!existsSync(repoDir), 'a directory left holding only Finder metadata is removed');
});

test('start says when the worktree record could not be persisted, and a retry repairs it', async (t) => {
  const c = makeCase('hygiene-start-record');
  t.after(() => c.cleanup());

  // A state root that cannot hold a file at all: the path is a regular file, so
  // every write under it fails with ENOTDIR. The worktree itself is unaffected.
  const blocked = join(c.root, 'not-a-directory');
  writeFileSync(blocked, 'this path is a file, so no state file can live under it\n');
  const config = resolveConfig({ ...c.config, stateRoot: blocked });

  const created = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'unrecorded-task' }, c.context({ config }));
  assert.equal(created.ok, true, 'the worktree is created, because it does not depend on the state file');
  assert.equal(created.recorded, false, 'and the result says the session record was not written');
  assert.ok((created.notes ?? []).some((note) => /does not own it/u.test(note)), 'naming what that costs');
  assert.ok(existsSync(created.worktree), 'the worktree is real and usable');

  // Once the state directory can be written, the same slug re-adopts the
  // existing worktree instead of making a second one, and the record lands.
  const again = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'unrecorded-task' }, c.context());
  assert.equal(again.ok, true);
  assert.equal(again.reused, true, 'the existing worktree is re-adopted, not duplicated');
  assert.equal(again.worktree, created.worktree);
  assert.equal(again.recorded, true, 'and now it is recorded');
  const owned = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.map((entry) => entry.path);
  assert.ok(owned.includes(created.worktree), 'the session owns the worktree it made');
});

test('a push failure says when its backoff could not be recorded', async (t) => {
  const c = makeCase('hygiene-backoff-record');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'fail-task' }, c.context());
  assert.equal(started.ok, true);
  // A real push failure: the origin no longer resolves.
  git(c.repoDir, ['remote', 'set-url', 'origin', join(c.root, 'gone.git')]);
  // A state root nothing can be written under, so the backoff cannot be kept.
  const blocked = join(c.root, 'not-a-directory');
  writeFileSync(blocked, 'this path is a file, so no state file can live under it\n');
  const config = resolveConfig({ ...c.config, stateRoot: blocked });

  const failed = await runAction('push', { action: 'push', repo: started.worktree }, c.context({ config }));
  assert.equal(failed.ok, false, 'the push fails');
  const message = String(failed.error?.message ?? '');
  assert.match(message, /backoff could not be recorded/u, 'and the action reports that nothing is holding the next attempt back');
  assert.match(message, /not held back/u, 'in the words a reader can act on');
});

test('a push that succeeds says when a stale backoff could not be cleared', async (t) => {
  const c = makeCase('hygiene-backoff-clear');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'clear-task' }, c.context());
  assert.equal(started.ok, true);
  // A real backoff, keyed the way `push` clears it: the repository root.
  assert.equal(state.recordPushFailure(c.sessionId, c.repoDir, 'an earlier push failed', { stateRoot: c.config.stateRoot }).persisted, true);

  // The state file stays readable but cannot be rewritten, which is the case a
  // successful push meets when the record it wants to drop will not go.
  const sessions = join(c.config.stateRoot, 'dsh-git', 'sessions');
  chmodSync(sessions, 0o500);
  t.after(() => { try { chmodSync(sessions, 0o700); } catch { /* the case may already be gone */ } });

  const pushed = await runAction('push', { action: 'push', repo: started.worktree }, c.context());
  assert.equal(pushed.ok, true, 'the push really succeeds');
  assert.ok((pushed.notes ?? []).some((note) => /could not be cleared/u.test(note)), 'and the surviving record is reported, not assumed away');

  chmodSync(sessions, 0o700);
  const left = Object.keys(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).pushFailures);
  assert.equal(left.length, 1, 'the record really did survive, which is what was reported');
});
test('a credential-bearing origin URL is not echoed into the error', async (t) => {
  const c = makeCase('hygiene-remote-credentials');
  t.after(() => c.cleanup());

  // Deliberately not a GitHub-shaped token: the pattern github.mjs knows about
  // would redact `ghp_…` and prove nothing about the general case. This is the
  // credential a non-GitHub host hands out, and only dropping the URL's userinfo
  // by construction removes it.
  const token = 'glpat-' + 'b'.repeat(20);
  git(c.repoDir, ['remote', 'set-url', 'origin', 'https://oauth2:' + token + '@gitlab.example.invalid/team/app.git']);

  const result = await runAction('pr', { action: 'pr', repo: c.repoDir }, c.context());
  assert.equal(result.ok, false, 'a non-GitHub origin is refused');
  const message = String(result.error?.message ?? '');
  assert.ok(!message.includes(token), 'the token appears nowhere in the message');
  assert.ok(!message.includes('oauth2:'), 'nor does the userinfo');
  assert.match(message, /gitlab\.example\.invalid/u, 'the host is still named, so the message stays useful');
  assert.ok(!JSON.stringify(result).includes(token), 'and nowhere in the result the model receives');
});
