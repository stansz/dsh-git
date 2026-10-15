/**
 * Plain mode: one switch.
 *
 * The point of this file is that plain mode is *one* setting. The four behaviours it
 * covers used to be four settings somebody had to find and set together — and one of
 * them, an empty `protectedBranches`, could not be expressed at all: `[]` fell back to
 * `["main","master"]` in silence, so "protect nothing" required a placeholder branch
 * name. Both halves are pinned here, and the guard is pinned too, because it is the one
 * thing plain mode deliberately does not touch: without the guard the tool becomes an
 * option rather than the path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { isProtectedBranch, resolveConfig } from '../lib/config.mjs';
import { evaluate } from '../lib/guard.mjs';
import { syncRepo } from '../lib/turn-commit.mjs';
import { git, makeCase } from './helpers.mjs';

test('plain mode is one setting, and it wins over the individual ones', () => {
  const plain = resolveConfig({ plainMode: true, autoWorktree: 'always', turnCommit: true, turnPush: true, protectedBranches: ['main'] });
  assert.equal(plain.autoWorktree, 'off');
  assert.equal(plain.turnCommit, false);
  assert.equal(plain.turnPush, false);
  assert.deepEqual(plain.protectedBranches, []);
  assert.equal(plain.guardMode, 'redirect', 'the guard is deliberately not part of plain mode');

  const ordinary = resolveConfig({ plainMode: false, autoWorktree: 'protected' });
  assert.equal(ordinary.autoWorktree, 'protected', 'off is off, and the defaults come back');
  assert.deepEqual(ordinary.protectedBranches, ['main', 'master']);
});

test('an empty protected list protects nothing, and a malformed one still falls back', () => {
  const none = resolveConfig({ protectedBranches: [] });
  assert.deepEqual(none.protectedBranches, [], '[] means what it says');
  assert.equal(isProtectedBranch(none, 'main'), false, 'so main is not protected');
  assert.deepEqual(resolveConfig({ protectedBranches: ['', '  '] }).protectedBranches, ['main', 'master'],
    'a list of blanks is a typo, not a request: it still falls back to the default');
  assert.deepEqual(resolveConfig({ protectedBranches: ['release'] }).protectedBranches, ['release']);
});

test('plain mode: the tool pushes main without the per-call flag', async (t) => {
  const c = makeCase('plain-mode-push');
  t.after(() => c.cleanup());
  writeFileSync(join(c.repoDir, 'second.txt'), 'second\n');
  git(c.repoDir, ['add', 'second.txt']);
  git(c.repoDir, ['-c', 'user.email=suite@example.invalid', '-c', 'user.name=suite', 'commit', '-m', 'second']);

  const context = { ...c.context(), config: resolveConfig({ ...c.config, plainMode: true }) };
  const pushed = await runAction('push', { action: 'push', repo: c.repoDir }, context);
  assert.equal(pushed.ok, true, 'plain mode pushes main: ' + JSON.stringify(pushed.error ?? {}));
  assert.equal(pushed.pushed, true);
  assert.equal(git(c.originDir, ['rev-parse', '--short', 'main']), git(c.repoDir, ['rev-parse', '--short', 'HEAD']),
    'the remote really moved');
});

test('plain mode: a dirty tree is left alone, and the sync does not report it', async (t) => {
  const c = makeCase('plain-mode-sync');
  t.after(() => c.cleanup());
  const file = join(c.repoDir, 'dirty.txt');
  writeFileSync(file, 'left alone\n');

  const result = await syncRepo(c.repoDir, resolveConfig({ ...c.config, plainMode: true }), c.sessionId, [file]);
  assert.equal(result.committed, false, 'nothing is committed automatically');
  assert.equal(result.pushed, false);
  assert.deepEqual(result.notes, [], 'a configured off-switch is not a skip to report');
});

test('plain mode leaves the guard exactly where it was', () => {
  const config = resolveConfig({ plainMode: true });
  assert.equal(evaluate({ name: 'bash', arguments: { command: 'git push origin main' } }, config).kind, 'deny');
  assert.equal(evaluate({ name: 'bash', arguments: { command: 'git commit -am x' } }, config).kind, 'deny');
  assert.equal(evaluate({ name: 'bash', arguments: { command: 'git status' } }, config).kind, 'allow');
});
