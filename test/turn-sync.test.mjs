/**
 * The automatic half: at the end of a turn that changed files, the plugin
 * commits and pushes what is safe to push.
 *
 * syncRepo() is the function the turn boundary calls for one repository, so
 * driving it directly tests the real behaviour against real git rather than a
 * re-implementation of the message format or the push rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { pushDecision, syncRepo } from '../lib/turn-commit.mjs';
import { commitPaths, git, makeCase, remoteBranches } from './helpers.mjs';

test('a turn that changed a file is committed and pushed from its own worktree', async (t) => {
  const c = makeCase('turn-sync');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'auto' }, c.context());
  assert.equal(started.ok, true);
  const worktree = started.worktree;

  // A real edit, then the turn ends without anyone calling commit.
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'auto.txt'), 'written during a turn\n');

  const synced = await syncRepo(worktree, c.config, c.sessionId, ['src/auto.txt'], { turn: 7 });
  assert.equal(synced.committed, true);
  assert.equal(synced.subject, 'dsh: turn 7 - src/auto.txt'.replace(' - ', ' \u2014 '));
  assert.equal(synced.pushed, true, 'a task branch is safe to push');
  assert.ok(remoteBranches(c.originDir).includes('dsh/auto'), 'the commit is on the remote');

  // Exactly the file the turn changed, with the trailer the plugin documents.
  const head = git(worktree, ['log', '-1', '--format=%H']);
  assert.deepEqual(commitPaths(worktree, head), ['src/auto.txt']);
  assert.match(git(worktree, ['log', '-1', '--format=%b']), /Assisted-by: DSH/u);
});

test('the push rule refuses the branches that would rewrite shared work', () => {
  const c = { branchPrefix: 'dsh/', protectedBranches: ['main', 'master'] };
  assert.equal(pushDecision(c, 'main', []).allowed, false);
  assert.equal(pushDecision(c, 'master', []).allowed, false);
  assert.equal(pushDecision(c, 'feature', []).allowed, false);
  assert.equal(pushDecision(c, 'dsh/task', []).allowed, true);
  assert.equal(pushDecision(c, 'feature', ['feature']).allowed, true, 'the branch of a worktree this session owns is safe');
});
