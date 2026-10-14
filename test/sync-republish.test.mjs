/**
 * D44: a merged branch is not published again.
 *
 * Action "merge" deletes the remote branch it merged, and the next fetch prunes
 * the tracking ref that recorded it. "No upstream" then reads exactly like
 * "never published", which is how a branch a merge had just removed came back on
 * the remote: the sync pushed it again. The rule under test is the question every
 * other path asks before it deletes anything — is this branch's work already in
 * the base? — asked where the push is decided, and answered from refs on disk.
 *
 * The cases that must not change are here beside it: a branch whose only copy is
 * local is still published, because that is what the automatic push is for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { syncRepo } from '../lib/turn-commit.mjs';
import { git, makeCase, remoteBranches, tryGit } from './helpers.mjs';

/** A task branch with one commit of its own, published to the fixture origin. */
function publishTask(c, branch, file) {
  git(c.repoDir, ['checkout', '-q', '-b', branch]);
  writeFileSync(join(c.repoDir, file), branch + '\n');
  git(c.repoDir, ['add', file]);
  git(c.repoDir, ['commit', '-m', 'work on ' + branch]);
  git(c.repoDir, ['push', '-q', '-u', 'origin', branch]);
}

test('D44: the branch a merge removed is not published again by the next sync', async (t) => {
  const c = makeCase('d44-merged');
  t.after(() => c.cleanup());

  publishTask(c, 'dsh/task', 'task.txt');
  git(c.repoDir, ['checkout', '-q', 'main']);
  // The merge a pull request performs, and the remote cleanup action "merge" does.
  git(c.repoDir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from dsh/task', 'dsh/task']);
  git(c.repoDir, ['push', '-q', 'origin', 'main']);
  git(c.repoDir, ['push', '-q', 'origin', '--delete', 'dsh/task']);
  // Any fetch that prunes — action "sync" does — takes the tracking ref with it.
  git(c.repoDir, ['fetch', '-q', '--prune', 'origin']);
  git(c.repoDir, ['checkout', '-q', 'dsh/task']);

  assert.equal(remoteBranches(c.originDir).includes('dsh/task'), false, 'the merge removed the remote ref');
  assert.equal(
    tryGit(c.repoDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    undefined,
    'and the prune removed the tracking ref, so nothing local says it was ever published',
  );

  const synced = await syncRepo(c.repoDir, c.config, c.sessionId, [], { turn: 3 });
  assert.equal(synced.pushed, false, 'the sync must not push a branch the base already contains');
  assert.equal(synced.containedInBase, 'main', 'and it says which base contains it');
  assert.equal(
    remoteBranches(c.originDir).includes('dsh/task'),
    false,
    'the branch the merge removed stayed removed',
  );
});

test('D44: a branch whose only copy is local is still published', async (t) => {
  const c = makeCase('d44-unpublished');
  t.after(() => c.cleanup());

  publishTask(c, 'dsh/only-here', 'only.txt');
  // The remote ref goes while the commits are nowhere else: nothing merged them
  // and no base contains them, so losing them here would lose the work.
  git(c.repoDir, ['push', '-q', 'origin', '--delete', 'dsh/only-here']);
  git(c.repoDir, ['fetch', '-q', '--prune', 'origin']);
  assert.equal(
    tryGit(c.repoDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    undefined,
  );

  const synced = await syncRepo(c.repoDir, c.config, c.sessionId, [], { turn: 3 });
  assert.equal(synced.pushed, true, 'unpublished work is what the automatic push is for');
  assert.equal(synced.containedInBase, undefined, 'nothing contains it');
  assert.equal(remoteBranches(c.originDir).includes('dsh/only-here'), true, 'the commits are on the remote again');
});

test('D44: a branch with nothing of its own is not published either', async (t) => {
  const c = makeCase('d44-empty');
  t.after(() => c.cleanup());

  // A worktree branch cut from the base with no commits: there is nothing in it
  // to publish, and a push would put an empty branch on the remote.
  git(c.repoDir, ['checkout', '-q', '-b', 'dsh/nothing-yet']);
  const synced = await syncRepo(c.repoDir, c.config, c.sessionId, [], { turn: 3 });
  assert.equal(synced.pushed, false, 'there is nothing of its own to publish');
  assert.equal(synced.containedInBase, 'main');
  assert.equal(remoteBranches(c.originDir).includes('dsh/nothing-yet'), false, 'no empty branch on the remote');
});
