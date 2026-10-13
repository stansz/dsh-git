/**
 * What a worktree path has to BE, not merely resolve to.
 *
 * The guard resolves where a write lands before it decides, so an owned path is
 * only useful if it is the worktree itself. `git worktree move` and a plain
 * `rm -rf` both leave the session record naming a directory that is no longer
 * the session's checkout, and that path can be filled with something that
 * resolves into another worktree of the same repository — another session's
 * work, which an edit spelled at the "owned" path then writes into.
 *
 * `git worktree list` makes this hard to see: it prints the REAL path of every
 * registration, so the session's registration arrives wearing the path of
 * whatever its checkout directory now resolves to, on the branch from its admin
 * directory. These cases build that state with real git, drive the real
 * `evaluateWorktree`, and read the real filesystem — including where a write
 * would really land.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';
import * as state from '../lib/state.mjs';
import { evaluateWorktree } from '../lib/worktree-guard.mjs';
import { git, makeCase } from './helpers.mjs';

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
  return worktree;
}

/** A second worktree of the same repository, made by plain git: not this session's. */
function foreignWorktree(c, name, branch) {
  const dir = join(c.root, name);
  git(c.repoDir, ['worktree', 'add', '-b', branch, dir]);
  assert.ok(existsSync(join(dir, '.git')), 'the foreign worktree is a real checkout');
  return dir;
}

/** What a directory's checkout is on, asked of git in that directory. */
function checkoutBranch(dir) {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

test('the owned path swapped for a symlink into another worktree is refused', async (t) => {
  const c = makeCase('swap-foreign');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'focus-one');
  const foreign = foreignWorktree(c, 'foreign-wt', 'foreign-task');

  // Controls: the session owns its own worktree, not the foreign checkout.
  const mine = await evaluateWorktree(writeCall(c.sessionId, join(worktree, 'mine.txt')), config, { cwd: c.reference });
  assert.equal(mine.kind, 'allow');
  const direct = await evaluateWorktree(writeCall(c.sessionId, join(foreign, 'direct.txt')), config, { cwd: c.reference });
  assert.equal(direct.kind, 'deny', 'the session does not own the foreign worktree');

  // The swap: the owned checkout is deleted, and its recorded path becomes a
  // link to the foreign worktree. git still has the registration — and, because
  // it prints realpaths, it now prints the FOREIGN path for it.
  rmSync(worktree, { recursive: true, force: true });
  symlinkSync(foreign, worktree, 'dir');
  assert.equal(lstatSync(worktree).isSymbolicLink(), true, 'the owned path is a symlink now');
  assert.equal(realpathSync(worktree), realpathSync(foreign), 'and it resolves into the foreign worktree');
  assert.equal(state.readSession(c.sessionId, { stateRoot: config.stateRoot }).worktrees[0].path, worktree, 'the record still names it');
  assert.match(
    git(c.repoDir, ['worktree', 'list', '--porcelain']),
    /branch refs\/heads\/dsh\/focus-one/u,
    'git still lists the session registration',
  );

  const swapped = join(worktree, 'landed-new.txt');
  const decision = await evaluateWorktree(writeCall(c.sessionId, swapped), config, { cwd: c.reference });
  assert.equal(decision.kind, 'deny', 'resolving into a worktree this session does not own is not ownership');
  assert.ok(!existsSync(join(foreign, 'landed-new.txt')), 'nothing was written into the foreign worktree');
  assert.equal(git(foreign, ['status', '--porcelain']), '', 'and its checkout is untouched');

  // The control: had the guard allowed it, this is where the write would land —
  // the foreign checkout. Removed again, so the case leaves no trace.
  writeFileSync(swapped, 'written through the swapped path\n');
  assert.equal(git(foreign, ['status', '--porcelain']), '?? landed-new.txt', 'the path really does land in the foreign worktree');
  rmSync(join(foreign, 'landed-new.txt'), { force: true });
  assert.equal(git(foreign, ['status', '--porcelain']), '', 'and the foreign checkout is clean again');
});

test('a copy of another checkout planted at the owned path is refused too', async (t) => {
  const c = makeCase('swap-copy');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'copied-task');
  const foreign = foreignWorktree(c, 'foreign-wt', 'foreign-task');

  // No symlink this time: the owned checkout is deleted and replaced by a real
  // directory that is a copy of the foreign one, carrying its .git file. The
  // path IS a worktree directory and git still registers the session's worktree
  // at it; the only thing wrong is that the checkout there belongs to another
  // registration, on another branch. A check that only asked "is this a real
  // directory" would pass it.
  rmSync(worktree, { recursive: true, force: true });
  cpSync(foreign, worktree, { recursive: true });
  assert.equal(lstatSync(worktree).isSymbolicLink(), false, 'the owned path is a real directory');
  assert.ok(existsSync(join(worktree, '.git')), 'and carries a .git entry');
  assert.equal(checkoutBranch(worktree), 'foreign-task', 'the checkout there belongs to the foreign worktree');

  const decision = await evaluateWorktree(writeCall(c.sessionId, join(worktree, 'planted.txt')), config, { cwd: c.reference });
  assert.equal(decision.kind, 'deny', 'the checkout at the owned path is not the worktree the registration describes');
  assert.ok(!existsSync(join(worktree, 'planted.txt')), 'nothing was written');
  assert.equal(git(foreign, ['status', '--porcelain']), '', 'the foreign checkout is untouched');
});

test('a symlink at the recorded path that resolves into the session own worktree is allowed', async (t) => {
  const c = makeCase('swap-own');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'own-task');

  // git moves the checkout; the record still names the old path, and a link is
  // left in its place — pointing at the session's OWN worktree this time.
  const moved = join(c.root, 'moved-here');
  git(c.repoDir, ['worktree', 'move', '-f', '-f', worktree, moved]);
  symlinkSync(moved, worktree, 'dir');

  // Allowed, deliberately: the guard's question is where the write LANDS, and
  // this one lands inside a worktree this session still owns — the branch git
  // moved is the identity. Only a write that would leave that worktree (into
  // main, or into somebody else's checkout) is refused.
  const through = join(worktree, 'through-link.txt');
  const decision = await evaluateWorktree(writeCall(c.sessionId, through), config, { cwd: c.reference });
  assert.equal(decision.kind, 'allow', 'the write really lands in the session worktree');

  writeFileSync(through, 'lands in the moved worktree\n');
  assert.ok(existsSync(join(moved, 'through-link.txt')), 'the write landed in the moved worktree');
  assert.equal(checkoutBranch(moved), 'dsh/own-task');
  assert.ok(!existsSync(join(c.repoDir, 'through-link.txt')), 'and not in the main checkout');
});

test('the D36 cases hold: moved worktree allow, old path to main deny, main deny', async (t) => {
  const c = makeCase('d36-intact');
  t.after(() => c.cleanup());
  const config = configWith(c, 'always');
  const worktree = await startWorktree(c, config, 'kept-task');

  const moved = join(c.root, 'moved-here');
  git(c.repoDir, ['worktree', 'move', '-f', '-f', worktree, moved]);

  const atNew = await evaluateWorktree(writeCall(c.sessionId, join(moved, 'new-path.js')), config, { cwd: c.reference });
  assert.equal(atNew.kind, 'allow', 'a moved worktree is owned at its new path');

  symlinkSync(c.repoDir, worktree, 'dir');
  const atOld = await evaluateWorktree(writeCall(c.sessionId, join(worktree, 'old-path.js')), config, { cwd: c.reference });
  assert.equal(atOld.kind, 'deny', 'the old path resolves into the main checkout');

  const inMain = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'main-file.js')), config, { cwd: c.reference });
  assert.equal(inMain.kind, 'deny', 'the main checkout is never a worktree');
});
