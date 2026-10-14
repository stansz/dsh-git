/**
 * The successful-push leg of `finish --cleanup`, and the rules beside it.
 *
 * This is a deletion path, and the rule it implements is the one that keeps a
 * worktree whose commits exist nowhere else: the worktree goes only after the
 * push that publishes its commits has landed. Batch 1 pinned the refusal side (a
 * failed or unattempted push keeps the worktree and says why); the success side
 * — commit, push really succeeds, and only then does the worktree go — was left
 * open. It is pinned here from real state: the ref in the bare origin, the
 * registration, the ownership marker, the session record and the directory.
 *
 * The neighbours are pinned beside it because they are the same decision from
 * the other sides: a push that was never attempted keeps the worktree; a dirty
 * worktree is committed rather than refused, so its work reaches the remote
 * before anything is removed; and a worktree in the middle of a conflict refuses
 * the whole action and stays exactly where it is.
 *
 * Nothing here is doubled: a real repository, a real bare origin, a real
 * worktree, real commits and real git. The file lives beside test/cleanup.test.mjs
 * rather than inside it because that file is about one task not disturbing
 * another; this one is about the publication rule that gates the removal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import * as state from '../lib/state.mjs';
import { git, makeCase, tryGit, worktreePaths } from './helpers.mjs';

/** The session's record for one worktree path, or undefined. */
function recordFor(c, path) {
  const session = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot });
  return session.worktrees.find((entry) => entry.path === path);
}

/** Write a file, stage it, commit it, and return the commit the branch now has. */
function commitFile(worktree, relative, contents, message) {
  const full = join(worktree, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  git(worktree, ['add', relative]);
  git(worktree, ['-c', 'user.email=suite@example.invalid', '-c', 'user.name=dsh-git suite', 'commit', '-m', message]);
  return git(worktree, ['rev-parse', 'HEAD']);
}

test('finish --cleanup removes the worktree only after its commit is on the origin', async (t) => {
  const c = makeCase('finish-cleanup-published');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'published-task' }, c.context());
  assert.equal(started.ok, true, 'start: ' + JSON.stringify(started.error ?? {}));
  const worktree = started.worktree;
  const branch = started.branch;
  assert.equal(typeof branch, 'string', 'start names the branch it created');
  const sha = commitFile(worktree, 'src/published.txt', 'the published work\n', 'feat: the published work');

  // Before the finish: nothing is on the origin, and the session owns the worktree.
  assert.equal(tryGit(c.originDir, ['rev-parse', '--verify', 'refs/heads/' + branch]), undefined, 'the branch is not on the origin yet');
  assert.ok(recordFor(c, worktree), 'the session records the worktree before the finish');

  const finished = await runAction('finish', { action: 'finish', repo: worktree, cleanup: true }, c.context());
  assert.equal(finished.ok, true, 'finish: ' + JSON.stringify(finished.error ?? {}));
  assert.equal(finished.pushed, true, 'the push ran and succeeded');

  // Real state: the commit is on the bare origin, and it is the commit made here.
  assert.equal(git(c.originDir, ['rev-parse', 'refs/heads/' + branch]), sha, 'the pushed ref is this commit');
  assert.deepEqual(
    git(c.originDir, ['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean),
    ['src/published.txt'],
    'and it carries the file that was committed',
  );

  // Only then did the worktree go: the directory, its registration, its marker
  // and the session record that owned it.
  assert.equal(finished.worktreeRemoved, true, 'the result says the worktree was removed');
  assert.equal(existsSync(worktree), false, 'the worktree directory is gone');
  assert.equal(existsSync(worktree + '.owned.json'), false, 'the ownership marker went with it');
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir], 'git no longer registers it');
  assert.equal(recordFor(c, worktree), undefined, 'and the session no longer records it');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 0);
});

test('finish --cleanup keeps the worktree when the push was never attempted', async (t) => {
  const c = makeCase('finish-cleanup-unpushed');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'kept-task' }, c.context());
  const worktree = started.worktree;
  const branch = started.branch;
  commitFile(worktree, 'src/kept.txt', 'work that exists only here\n', 'feat: work only this machine has');

  // The push is refused before it is attempted: this task's branch is protected
  // for this call. Nothing about the worktree's own state changes.
  const config = { ...c.config, protectedBranches: ['main', branch] };
  const finished = await runAction('finish', { action: 'finish', repo: worktree, cleanup: true }, { ...c.context(), config });

  assert.equal(finished.ok, true);
  assert.notEqual(finished.worktreeRemoved, true, 'nothing may be removed while the commit is unpublished');
  assert.equal(finished.worktreeKept, true, 'a commit that exists nowhere else keeps the worktree');
  assert.ok(
    Array.isArray(finished.notes) && finished.notes.some((note) => /not on origin/u.test(note)),
    'the result names why: ' + JSON.stringify(finished.notes ?? []),
  );
  assert.equal(tryGit(c.originDir, ['rev-parse', '--verify', 'refs/heads/' + branch]), undefined, 'nothing was published');
  assert.ok(existsSync(worktree), 'the worktree is exactly where it was');
  assert.ok(existsSync(join(worktree, 'src', 'kept.txt')), 'and so is the work in it');
  assert.ok(recordFor(c, worktree), 'the session still owns it');
});

test('finish --cleanup commits a dirty worktree, publishes it, and only then closes it', async (t) => {
  const c = makeCase('finish-cleanup-dirty');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'dirty-task' }, c.context());
  const worktree = started.worktree;
  const branch = started.branch;
  // A tracked change and an untracked file. finish stages both — its rule is "no
  // dirty tree" — so a dirty worktree is work to commit, not a refusal, and the
  // removal still waits for the push.
  writeFileSync(join(worktree, 'README.md'), '# changed in the worktree\n');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'untracked.txt'), 'never staged by hand\n');

  const finished = await runAction('finish', { action: 'finish', repo: worktree, cleanup: true }, c.context());
  assert.equal(finished.ok, true, 'finish: ' + JSON.stringify(finished.error ?? {}));
  assert.equal(finished.committed, true, 'the dirty tree was committed, not refused');
  assert.equal(finished.pushed, true);
  assert.equal(finished.worktreeRemoved, true, 'and the worktree went only after the push');

  const pushedSha = git(c.originDir, ['rev-parse', 'refs/heads/' + branch]);
  assert.equal(pushedSha, finished.sha, 'the pushed ref is the commit finish made');
  assert.deepEqual(
    git(c.originDir, ['show', '--name-only', '--format=', pushedSha]).split('\n').filter(Boolean).sort(),
    ['README.md', 'src/untracked.txt'],
    'both changes are in the published commit',
  );
  assert.equal(existsSync(worktree), false);
  assert.equal(recordFor(c, worktree), undefined);
});

test('finish --cleanup refuses while a conflict is in progress and keeps the worktree', async (t) => {
  const c = makeCase('finish-cleanup-conflict');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'conflicted-task' }, c.context());
  const worktree = started.worktree;
  const branch = started.branch;
  commitFile(worktree, 'README.md', '# the worktree version\n', 'feat: the worktree version');

  // The base moves in a conflicting way and the worktree merges it: a real
  // conflict, in a real worktree.
  writeFileSync(join(c.repoDir, 'README.md'), '# the base version\n');
  git(c.repoDir, ['add', 'README.md']);
  git(c.repoDir, ['commit', '-m', 'chore: the base moves']);
  assert.throws(
    () => git(worktree, ['-c', 'user.email=suite@example.invalid', '-c', 'user.name=dsh-git suite', 'merge', 'main']),
    'the merge really conflicts',
  );
  assert.match(readFileSync(join(worktree, 'README.md'), 'utf8'), /<<<<<<</u, 'the conflict is on disk');

  const finished = await runAction('finish', { action: 'finish', repo: worktree, cleanup: true }, c.context());
  assert.equal(finished.ok, false, 'a worktree in a conflict is not finished');
  assert.equal(finished.error.code, 'operation-in-progress', 'and the reason is the operation, not the cleanup');
  assert.ok(existsSync(worktree), 'the worktree is exactly where it was');
  assert.ok(recordFor(c, worktree), 'the session still owns it');
  assert.equal(tryGit(c.originDir, ['rev-parse', '--verify', 'refs/heads/' + branch]), undefined, 'and nothing was pushed');
  assert.match(git(worktree, ['rev-parse', '--verify', 'MERGE_HEAD']), /^[0-9a-f]{40}$/u, 'the merge is still in progress, to be resolved');
});
