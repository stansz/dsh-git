/**
 * What makes a worktree this session's own.
 *
 * The guard used to answer that from the session record plus `existsSync`. A
 * record is a claim, not a fact: `git worktree move` leaves it pointing at a
 * directory git no longer has as a worktree, and that path can then be recreated
 * as anything at all — including a symlink to the main checkout, which is how an
 * edit spelled inside the "worktree" was written into main, while an edit inside
 * the worktree git really moved was refused.
 *
 * So ownership has to come from git. These cases create the worktree with the
 * real `start` action, move or remove it with real git commands, drive
 * `evaluateWorktree` with a real agent id and cwd, and read the real filesystem
 * afterwards — including what happens to a file written at a path the guard
 * refused.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';
import * as state from '../lib/state.mjs';
import { evaluateWorktree } from '../lib/worktree-guard.mjs';
import { git, makeCase, worktreePaths } from './helpers.mjs';

/** The pending tool call the Host hands to the pre-execute listener. */
function writeCall(sessionId, filePath) {
  return { name: 'write', arguments: { file_path: filePath }, agent: { id: sessionId } };
}

/** The case's own layout and session, under a different enforcement mode. */
function configWith(c, autoWorktree) {
  return resolveConfig({
    worktreeRoot: join(c.root, '.worktrees'),
    stateRoot: join(c.root, 'state'),
    autoWorktree,
    turnPush: true,
  });
}

/** A worktree this session really owns, created by the real "start" action. */
async function startWorktree(c, config, slug) {
  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug }, c.context({ config }));
  assert.equal(started.ok, true, 'action "start" created a worktree');
  const worktree = started.worktree;
  assert.ok(existsSync(worktree), 'the worktree directory is really on disk');
  assert.equal(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'dsh/' + slug, 'and is on its task branch');
  return worktree;
}

/** Move a worktree the way a user or a script does: through git itself. */
function moveWorktree(repoDir, from, to) {
  git(repoDir, ['worktree', 'move', '-f', '-f', from, to]);
  assert.ok(existsSync(to), 'git moved the checkout to ' + to);
  assert.ok(!existsSync(from), 'and the old directory is gone');
  return to;
}

/** The write really landed in the main checkout: the fact the refusal rests on. */
function assertLandedInMain(c, name) {
  assert.ok(existsSync(join(c.repoDir, name)), 'the file is a main-checkout file');
  assert.ok(
    git(c.repoDir, ['status', '--porcelain']).split('\n').includes('?? ' + name),
    'and git in the main checkout sees it as untracked',
  );
  rmSync(join(c.repoDir, name), { force: true });
}

test('a worktree git moved is still the session worktree, at its new path', async (t) => {
  const c = makeCase('moved-worktree');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'moved-task');

  const moved = moveWorktree(c.repoDir, worktree, join(c.root, 'moved-here'));

  // git only knows the new path; the session record still names the old one.
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir, moved], 'git has the worktree at its new path only');
  const recorded = state.readSession(c.sessionId, { stateRoot: config.stateRoot }).worktrees;
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].path, worktree, 'the record still points at the path git moved away from');

  // The session can still edit the worktree it owns — at the path git reports.
  const decision = await evaluateWorktree(writeCall(c.sessionId, join(moved, 'src', 'new-file.js')), config, { cwd: c.reference });
  assert.equal(decision.kind, 'allow', 'a moved worktree is still this session\'s worktree');

  // And the write really goes to the moved checkout, on the task branch.
  mkdirSync(join(moved, 'src'), { recursive: true });
  writeFileSync(join(moved, 'src', 'new-file.js'), 'lands in the moved worktree\n');
  assert.ok(existsSync(join(moved, 'src', 'new-file.js')), 'the write landed in the moved worktree');
  assert.equal(git(moved, ['rev-parse', '--abbrev-ref', 'HEAD']), 'dsh/moved-task');
});

test('the recorded path recreated as a symlink to main is refused, and writing there lands in main', async (t) => {
  const c = makeCase('moved-swap');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'swap-task');

  const moved = moveWorktree(c.repoDir, worktree, join(c.root, 'moved-here'));
  // Somebody recreates the path the record still names as a link to the main
  // checkout. The recorded path exists again, which is all the old check asked.
  symlinkSync(c.repoDir, worktree, 'dir');

  const swap = join(worktree, 'post-move-swap.txt');
  const decision = await evaluateWorktree(writeCall(c.sessionId, swap), config, { cwd: c.reference });
  assert.equal(decision.kind, 'deny', 'the path only looks like the worktree; it resolves into main');

  // What really happens to a file written there: it becomes a main-checkout
  // file. That is exactly why the refusal has to stand.
  writeFileSync(swap, 'written through the recreated recorded path\n');
  assertLandedInMain(c, 'post-move-swap.txt');

  // The worktree git moved is still editable in the same state.
  const inside = await evaluateWorktree(writeCall(c.sessionId, join(moved, 'src', 'still-mine.js')), config, { cwd: c.reference });
  assert.equal(inside.kind, 'allow', 'the moved worktree is not collateral damage');
});

test('a recorded path git no longer has is not a worktree, even when something is there', async (t) => {
  const c = makeCase('removed-worktree-swap');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'removed-task');

  // Removed properly - nothing to lose, no committed work - and then the path
  // recreated by hand, which is the same substitution one step simpler.
  git(c.repoDir, ['worktree', 'remove', '-f', '-f', worktree]);
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir], 'git has no worktree there any more');
  symlinkSync(c.repoDir, worktree, 'dir');

  const decision = await evaluateWorktree(writeCall(c.sessionId, join(worktree, 'after-remove.txt')), config, { cwd: c.reference });
  assert.equal(decision.kind, 'deny');
  writeFileSync(join(worktree, 'after-remove.txt'), 'x\n');
  assertLandedInMain(c, 'after-remove.txt');

  // Nothing in the record is a worktree any more, so the main checkout is
  // refused like any repository the session has no worktree for.
  const inMain = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'later.js')), config, { cwd: c.reference });
  assert.equal(inMain.kind, 'deny');
});

test('the ordinary cases stay: inside the worktree allow, main deny, a link out deny', async (t) => {
  const c = makeCase('identity-ordinary');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'ordinary-task');

  const inside = await evaluateWorktree(writeCall(c.sessionId, join(worktree, 'src', 'new-file.js')), config, { cwd: c.reference });
  assert.equal(inside.kind, 'allow');

  const inMain = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'sneaky.js')), config, { cwd: c.reference });
  assert.equal(inMain.kind, 'deny');

  // A link inside the worktree pointing at main: spelled inside, written
  // outside, so the verdict follows the landing path.
  symlinkSync(c.repoDir, join(worktree, 'escape'), 'dir');
  const escaped = await evaluateWorktree(writeCall(c.sessionId, join(worktree, 'escape', 'escaped.txt')), config, { cwd: c.reference });
  assert.equal(escaped.kind, 'deny');
  writeFileSync(join(worktree, 'escape', 'escaped.txt'), 'x\n');
  assertLandedInMain(c, 'escaped.txt');
});

test('a session with two worktrees can edit both after one is moved', async (t) => {
  const c = makeCase('two-worktrees');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const first = await startWorktree(c, config, 'first-task');
  const second = await startWorktree(c, config, 'second-task');
  assert.equal(worktreePaths(c.repoDir).length, 3, 'the main checkout and two task worktrees');

  const movedFirst = moveWorktree(c.repoDir, first, join(c.root, 'first-moved'));

  const inMoved = await evaluateWorktree(writeCall(c.sessionId, join(movedFirst, 'a.js')), config, { cwd: c.reference });
  assert.equal(inMoved.kind, 'allow', 'the moved worktree is still this session\'s');
  const inSecond = await evaluateWorktree(writeCall(c.sessionId, join(second, 'b.js')), config, { cwd: c.reference });
  assert.equal(inSecond.kind, 'allow', 'the untouched worktree is unaffected');
  const inMain = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'c.js')), config, { cwd: c.reference });
  assert.equal(inMain.kind, 'deny', 'the main checkout is still not a worktree');
});
