/**
 * The loop the tool description tells an agent to run, end to end, on a real
 * repository: start a task worktree, work in the path it returns, commit, push,
 * close the task with finish, and clean up the branch with prune.
 *
 * Every step goes through runAction(), the same function the Host's git tool
 * calls, against real git. The assertions read the repository afterwards:
 * worktree registrations, the branch a worktree has checked out, refs in the
 * bare origin, the ownership marker beside the worktree, and the plugin's own
 * session state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import * as state from '../lib/state.mjs';
import { commitPaths, git, localBranches, makeCase, remoteBranches, worktreePaths } from './helpers.mjs';

test('start, work, commit, push, finish --cleanup leaves nothing behind', async (t) => {
  const c = makeCase('workflow');
  t.after(() => c.cleanup());

  // 1. A task gets its own worktree, cut from the remote base branch.
  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'add-greeting' }, c.context());
  assert.equal(started.ok, true);
  assert.equal(started.branch, 'dsh/add-greeting');
  assert.equal(started.base, 'origin/main');
  const worktree = started.worktree;
  assert.equal(worktree, join(c.root, '.worktrees', 'app', 'add-greeting'));
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir, worktree], 'git has the worktree registered');
  assert.equal(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'dsh/add-greeting');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 1);

  // 2. Asking again returns the same worktree. A second one for one task is the
  //    leftover the prune rules exist to catch, so it must never be created.
  const again = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'add-greeting' }, c.context());
  assert.equal(again.reused, true);
  assert.equal(again.worktree, worktree);
  assert.equal(worktreePaths(c.repoDir).length, 2, 'still exactly one task worktree');

  // 3. The session works in the path it was handed.
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'greeting.txt'), 'hello from a worktree\n');

  // 4. commit names exactly the paths it was given.
  const committed = await runAction('commit', { action: 'commit', repo: worktree, message: 'feat: add a greeting', paths: ['src/greeting.txt'] }, c.context());
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.paths, ['src/greeting.txt']);
  assert.equal(git(worktree, ['log', '-1', '--format=%s']), 'feat: add a greeting');
  assert.deepEqual(commitPaths(worktree, 'HEAD'), ['src/greeting.txt']);

  // 5. push reaches the remote.
  const pushed = await runAction('push', { action: 'push', repo: worktree }, c.context());
  assert.equal(pushed.pushed, true);
  assert.ok(remoteBranches(c.originDir).includes('dsh/add-greeting'), 'the branch is on the remote');

  // 6. finish closes the task. The worktree is named in 'repo' because that is
  //    the path action "start" returned and the one the session worked in.
  const finished = await runAction('finish', { action: 'finish', repo: worktree, cleanup: true }, c.context());
  assert.equal(finished.ok, true);
  assert.equal(finished.worktreeRemoved, true, 'cleanup removes the worktree the caller named');
  assert.ok(!existsSync(worktree), 'the worktree directory is gone');
  assert.ok(!existsSync(join(c.root, '.worktrees', 'app', 'add-greeting.owned.json')), 'the ownership marker is gone');
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir], 'no registration is left behind');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 0, 'the session no longer claims it');

  // 7. The freed branch holds a commit of its own, so prune reports it and does
  //    not delete it. Work is never deleted on a guess.
  const pruned = await runAction('prune', { action: 'prune', repo: c.repoDir, apply: true }, c.context());
  const kept = (pruned.branches ?? []).find((entry) => entry.branch === 'dsh/add-greeting');
  assert.ok(kept, 'prune reports the branch left behind');
  assert.equal(kept.kept, true);
  assert.match(kept.reason, /holds 1 commit\(s\) of its own/u);
  assert.ok(localBranches(c.repoDir).includes('dsh/add-greeting'), 'the branch with work survives');

  // 8. The deliberate act — naming the branch — removes it locally, and the
  //    remote half is reported rather than assumed.
  const named = await runAction('prune', { action: 'prune', repo: c.repoDir, branches: ['dsh/add-greeting'], apply: true }, c.context());
  const removed = (named.namedBranches ?? []).find((entry) => entry.branch === 'dsh/add-greeting');
  assert.equal(removed.removed, true);
  assert.ok(!localBranches(c.repoDir).includes('dsh/add-greeting'), 'the local branch is gone');
  assert.ok(removed.remoteError !== undefined, 'the remote half is reported when it cannot be reached');

  // 9. Nothing of the task is left anywhere.
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir]);
  assert.equal(localBranches(c.repoDir).filter((name) => name.startsWith('dsh/')).length, 0);
});
