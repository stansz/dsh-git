/**
 * status has to be honest about which worktrees this plugin created.
 *
 * The marker beside a worktree is what every destructive path consults before it
 * touches anything, and it is also what the report renders as "ours". A report
 * that denies ownership of the plugin's own worktrees teaches a session to leave
 * them alone, which is how they become permanent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { makeCase } from './helpers.mjs';

test('status marks the worktree action start created as owned, and a foreign one as not', async (t) => {
  const c = makeCase('status-owned');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'ours' }, c.context());
  assert.equal(started.ok, true);

  // A worktree this plugin did not create, made with plain git.
  const foreign = join(c.root, '.worktrees', 'app', 'foreign');
  execFileSync('git', ['worktree', 'add', foreign, '-b', 'dsh/foreign'], { cwd: c.repoDir, encoding: 'utf8' });

  const report = await runAction('status', { action: 'status', repo: c.repoDir }, c.context());
  assert.equal(report.ok, true);
  const ours = (report.worktrees ?? []).find((entry) => entry.path === started.worktree);
  const theirs = (report.worktrees ?? []).find((entry) => entry.path === foreign);
  assert.ok(ours && theirs, 'both worktrees are reported');
  assert.equal(ours.owned, true, 'the worktree the plugin created is ours');
  assert.equal(theirs.owned, false, 'a worktree the plugin did not create is not ours');
});
