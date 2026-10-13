/**
 * Worktree enforcement, driven the way the Host drives it.
 *
 * The bug this file exists for is not in the rule — decideWorktree() reads a
 * snapshot and answers — it is in the wiring that builds the snapshot: the
 * session registry stores a worktree's MAIN root (`actions.mjs` records what
 * `start` was given), while the toplevel of an edit target inside a linked
 * worktree is the worktree path itself. So every case below calls
 * `evaluateWorktree` with a real agent id, a real cwd, and a real repository,
 * and the mode is `autoWorktree: 'always'` — the mode no test drove before.
 *
 * The two halves of the rule are pinned separately:
 *
 *   - which root decides "this session has a worktree for this repository";
 *   - where the write LANDS, once the symlinks on the way are followed.
 *
 * Fixtures are real repositories made by `makeCase`, the worktree is created by
 * the real `start` action, and every case is torn down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';
import * as state from '../lib/state.mjs';
import { evaluateWorktree, ownedWorktreePath } from '../lib/worktree-guard.mjs';
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

test("'always' allows a write inside the worktree the session started", async (t) => {
  const c = makeCase('always-owned-worktree');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'always-task');

  // The session edits the path action "start" handed it. Before the fix this was
  // denied with "start a worktree first" — for an edit in the worktree the
  // session already had.
  const target = join(worktree, 'src', 'new-file.js');
  const decision = await evaluateWorktree(writeCall(c.sessionId, target), config, { cwd: c.reference });
  assert.equal(decision.kind, 'allow', 'a write in the session worktree is the destination, not a detour');

  // The same call spelled relative to the worktree, which is how a session that
  // works there writes it.
  const relative = await evaluateWorktree(writeCall(c.sessionId, join('src', 'new-file.js')), config, { cwd: worktree });
  assert.equal(relative.kind, 'allow', 'a path relative to the worktree cwd is inside it too');

  // And the filesystem agrees about where an allowed write goes.
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(target, 'export const added = true;\n');
  assert.ok(existsSync(target), 'the file is in the worktree');
  assert.ok(!existsSync(join(c.repoDir, 'src', 'new-file.js')), 'and not in the main checkout');
});

test("'always' still denies a write in the main checkout", async (t) => {
  const c = makeCase('always-main-checkout');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  await startWorktree(c, config, 'main-denied');

  // The session owns a worktree for this repository, and that is exactly the
  // state that must not make a main-checkout edit look isolated.
  const decision = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'sneaky.js')), config, { cwd: c.reference });
  assert.equal(decision.kind, 'deny', 'the main checkout is not inside the worktree');
  assert.match(decision.reason, /no worktree/u);
  assert.match(decision.displayReason, /start one first/u);
});

test("'protected' is unchanged: main is refused, the session's worktree and other branches are not", async (t) => {
  const c = makeCase('protected-unchanged');
  t.after(() => c.cleanup());
  const config = configWith(c, 'protected');
  const worktree = await startWorktree(c, config, 'protected-task');

  // (a) The main checkout is on the protected branch.
  const inMain = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'main-edit.js')), config, { cwd: c.reference });
  assert.equal(inMain.kind, 'deny');
  assert.match(inMain.displayReason, /on "main"/u, 'the refusal names the protected branch, not a missing worktree');

  // (b) The session's own worktree, on its task branch: already isolated.
  const inWorktree = await evaluateWorktree(writeCall(c.sessionId, join(worktree, 'src', 'worktree-edit.js')), config, { cwd: c.reference });
  assert.equal(inWorktree.kind, 'allow');

  // (c) A repository on a branch that is not protected, with no worktree at all:
  //     the rule is about keeping main clean, not about forcing a worktree.
  git(c.repoDir, ['checkout', '-b', 'feature/not-protected']);
  const onFeature = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'feature-edit.js')), config, { cwd: c.reference });
  assert.equal(onFeature.kind, 'allow');
});

test('a symlink decides by where the write lands, not by how the path is spelled', async (t) => {
  const c = makeCase('symlink-landing');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'symlink-task');

  // (a) A link inside the worktree pointing at the main checkout. The path is
  //     spelled inside the worktree; the write lands in main, so it is refused.
  symlinkSync(c.repoDir, join(worktree, 'escape'), 'dir');
  const escaped = join(worktree, 'escape', 'landed-in-main.txt');
  const denied = await evaluateWorktree(writeCall(c.sessionId, escaped), config, { cwd: c.reference });
  assert.equal(denied.kind, 'deny', 'a write through the link is a write into the main checkout');

  // The real filesystem confirms which repository that path belongs to.
  writeFileSync(escaped, 'this really lands in main\n');
  assert.ok(existsSync(join(c.repoDir, 'landed-in-main.txt')), 'the file through the link is a main-checkout file');
  rmSync(join(c.repoDir, 'landed-in-main.txt'), { force: true });

  // (b) A symlinked ancestor that resolves INSIDE the worktree. The path is
  //     honest, the write lands in the worktree, so it is allowed.
  mkdirSync(join(worktree, 'real-src'), { recursive: true });
  symlinkSync(join(worktree, 'real-src'), join(worktree, 'src'), 'dir');
  const through = join(worktree, 'src', 'new-file.js');
  const allowed = await evaluateWorktree(writeCall(c.sessionId, through), config, { cwd: c.reference });
  assert.equal(allowed.kind, 'allow', 'the write really lands inside the owned worktree');
  writeFileSync(through, 'lands in the worktree\n');
  assert.ok(existsSync(join(worktree, 'real-src', 'new-file.js')), 'the write landed in the worktree');
  assert.ok(!existsSync(join(c.repoDir, 'src', 'new-file.js')), 'and not in the main checkout');

  // (c) The reverse spelling: a link in the main checkout pointing INTO the
  //     worktree. The path looks external, but the write lands in the session's
  //     worktree, so it is allowed — the verdict follows the landing path.
  symlinkSync(worktree, join(c.repoDir, 'into-worktree'), 'dir');
  const reversed = join(c.repoDir, 'into-worktree', 'from-main-link.js');
  const allowedReverse = await evaluateWorktree(writeCall(c.sessionId, reversed), config, { cwd: c.reference });
  assert.equal(allowedReverse.kind, 'allow', 'the write really lands inside the owned worktree');
  writeFileSync(reversed, 'lands in the worktree\n');
  assert.ok(existsSync(join(worktree, 'from-main-link.js')), 'and the filesystem agrees');
});

test('a worktree entry whose directory is gone is not a worktree', async (t) => {
  const c = makeCase('dead-worktree-entry');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'deleted-by-hand');

  // The checkout disappears without git or the session being told.
  rmSync(worktree, { recursive: true, force: true });
  const session = state.readSession(c.sessionId, { stateRoot: config.stateRoot });
  assert.equal(session.worktrees.length, 1, 'the registry entry is still there - that is the trap');
  assert.equal(session.worktrees[0].path, worktree);

  const mainRoot = worktreePaths(c.repoDir)[0];
  assert.equal(ownedWorktreePath(c.sessionId, mainRoot, config), undefined, 'a directory that is gone is not a worktree');

  // The main checkout is therefore not isolated by the dead entry, and a write
  // there is refused like any other main-checkout write.
  const decision = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'after-deletion.js')), config, { cwd: c.reference });
  assert.equal(decision.kind, 'deny');
});
