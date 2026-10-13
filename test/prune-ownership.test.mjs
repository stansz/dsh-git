/**
 * What a named prune may remove: only what this plugin owns.
 *
 * `prune {worktrees: [...]}` used to remove whatever the caller named, marker or
 * no marker: a plain-git worktree vanished from a repository this tool had never
 * touched. These cases pin the two layers of the fix with real repositories and
 * real git: `removeWorktree` refuses a worktree with no ownership marker unless
 * the caller explicitly allows a foreign removal, and the named prune path
 * reports such a worktree instead of removing it — in the dry run too — with
 * `force: true` as the one deliberate door.
 *
 * The separate sweep for a registration whose directory is gone is deliberately
 * not ownership-gated: there is no working tree left to lose, and gating it
 * would bring back a dead entry nothing can clear. The dead-registration case
 * below pins that, so a later edit cannot gate it by accident.
 *
 * Every assertion reads real state: `git worktree list`, the marker file beside
 * a worktree, and whether a registration is still locked. Nothing here reads a
 * log line to decide whether a worktree survived.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { removeWorktree } from '../lib/worktrees.mjs';
import { git, localBranches, makeCase, worktreePaths } from './helpers.mjs';

/**
 * A worktree made with plain git, the way another tool or a person makes one:
 * registered, on disk, and with no ownership marker beside it.
 */
function foreignWorktree(c, name) {
  const path = join(c.root, '.worktrees', 'app', name);
  git(c.repoDir, ['worktree', 'add', '-b', name, path]);
  return realpathSync(path);
}

/** The ownership marker dsh-git writes beside a worktree it created. */
function markerOf(worktree) {
  return worktree + '.owned.json';
}

/**
 * Whether git reports the worktree at `path` as locked. Read from git's own
 * listing, so it is the registration's real state and not a file this test
 * guesses at.
 */
function isLocked(repoDir, path) {
  const wanted = 'worktree ' + path;
  for (const block of git(repoDir, ['worktree', 'list', '--porcelain']).split('\n\n')) {
    const lines = block.split('\n');
    if (!lines.includes(wanted)) continue;
    return lines.some((line) => line === 'locked' || line.startsWith('locked '));
  }
  return false;
}

test('a foreign worktree survives a named prune and the result says it is not owned', async (t) => {
  const c = makeCase('prune-ownership-live');
  t.after(() => c.cleanup());

  const foreign = foreignWorktree(c, 'foreign-task');
  assert.ok(existsSync(foreign), 'the fixture worktree exists');
  assert.ok(worktreePaths(c.repoDir).includes(foreign), 'and git registers it');

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['foreign-task'], apply: true }, c.context());

  assert.ok(existsSync(foreign), 'the directory is still on disk');
  assert.ok(worktreePaths(c.repoDir).includes(foreign), 'its registration is still there');
  assert.ok(localBranches(c.repoDir).includes('foreign-task'), 'its branch was not touched');
  assert.ok(!existsSync(markerOf(foreign)), 'and no marker was written to claim it');

  const entry = (applied.namedWorktrees ?? []).find((tree) => tree.path === foreign);
  assert.ok(entry, 'the named worktree is reported');
  assert.equal(entry.owned, false, 'the result says the plugin does not own it');
  assert.equal(entry.removed, false, 'and that it was not removed');
  assert.match(String(entry.error), /force/u, 'and names the way to remove it anyway');
});

test('the dry run reports the foreign worktree, promises nothing, and unlocks nothing', async (t) => {
  const c = makeCase('prune-ownership-dry');
  t.after(() => c.cleanup());

  const foreign = foreignWorktree(c, 'foreign-task');
  // Locked on purpose: a report that quietly took the lock off would let the next
  // git prune drop the registration, which is the disappearance this fixes.
  git(c.repoDir, ['worktree', 'lock', '--reason', 'suite', foreign]);

  const dry = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['foreign-task'] }, c.context());

  assert.ok(existsSync(foreign), 'the directory survives the dry run');
  assert.ok(worktreePaths(c.repoDir).includes(foreign), 'the registration survives');
  assert.equal(isLocked(c.repoDir, foreign), true, 'and the lock was not taken off');

  const entry = (dry.namedWorktrees ?? []).find((tree) => tree.path === foreign);
  assert.ok(entry, 'the dry run reports the named worktree');
  assert.equal(entry.owned, false, 'as not owned');
  assert.equal(entry.removed, false);
  assert.equal(entry.wouldRemove, false, 'and does not promise a removal it will not perform');
  assert.equal(entry.requiresForce, true, 'it says force is what that would take');
});

test('force removes the foreign worktree and the result says it was forced', async (t) => {
  const c = makeCase('prune-ownership-force');
  t.after(() => c.cleanup());

  const foreign = foreignWorktree(c, 'foreign-task');

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['foreign-task'], apply: true, force: true }, c.context());

  const entry = (applied.namedWorktrees ?? []).find((tree) => tree.path === foreign);
  assert.ok(entry, 'the named worktree is reported');
  assert.equal(entry.owned, false, 'still reported as not owned');
  assert.equal(entry.removed, true, 'but force removed it');
  assert.equal(entry.forced, true, 'and the result says it was forced');

  assert.ok(!existsSync(foreign), 'the directory is gone');
  assert.ok(!worktreePaths(c.repoDir).includes(foreign), 'and so is the registration');
  assert.ok(localBranches(c.repoDir).includes('foreign-task'), 'its branch is outside the plugin prefix, so it stays');
});

test('a worktree this plugin created is still removed by a default named prune', async (t) => {
  const c = makeCase('prune-ownership-ours');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'walked-away' }, c.context());
  assert.equal(started.ok, true);
  assert.ok(existsSync(markerOf(started.worktree)), 'the marker beside it is what makes it ours');

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['walked-away'], apply: true }, c.context());

  const entry = (applied.namedWorktrees ?? []).find((tree) => tree.path === started.worktree);
  assert.ok(entry, 'the worktree is reported');
  assert.equal(entry.owned, true, 'the plugin owns it');
  assert.equal(entry.removed, true, 'and no force was needed to remove it');
  assert.equal(entry.forced, undefined, 'nothing was forced');
  assert.equal(entry.branchRemoved, true, 'the branch it freed held nothing, so it went with it');

  assert.ok(!existsSync(started.worktree), 'the directory is gone');
  assert.ok(!existsSync(markerOf(started.worktree)), 'the marker does not outlive it');
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir], 'git no longer registers it');
  assert.ok(!localBranches(c.repoDir).includes('dsh/walked-away'));
});

test('the sweep still clears a dead locked registration, even when the caller names it', async (t) => {
  const c = makeCase('prune-ownership-dead');
  t.after(() => c.cleanup());

  const foreign = foreignWorktree(c, 'foreign-dead');
  git(c.repoDir, ['worktree', 'lock', '--reason', 'suite', foreign]);
  // The directory goes by hand; the registration and its lock do not.
  rmSync(foreign, { recursive: true, force: true });
  assert.equal(isLocked(c.repoDir, foreign), true, 'the fixture registration is locked');

  // Deliberate and pinned: a registration whose directory is gone holds no work,
  // so the sweep clears it — a foreign lock included — with no force, and naming
  // it does not change that. A future edit must not gate this sweep: that would
  // bring back a dead entry nothing can clear.
  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['foreign-dead'], apply: true }, c.context());

  assert.ok(!worktreePaths(c.repoDir).includes(foreign), 'the dead registration is cleared without force');
  assert.ok(!existsSync(foreign), 'and there is no directory to leave behind');

  const swept = (applied.worktrees ?? []).find((tree) => tree.path === foreign);
  assert.ok(swept, 'the sweep reports the registration it cleared');

  // The named entry does not answer "no such worktree" about one this same call
  // just cleared — the sweep's entry is what it reports.
  const named = (applied.namedWorktrees ?? []).find((tree) => tree.path === foreign);
  assert.ok(named, 'the named entry names the registration');
  assert.equal(named.removed, true, 'as removed');
  assert.equal(named.swept, true, 'by the sweep in this same call');
});

test('an unnamed foreign live worktree survives the sweep', async (t) => {
  const c = makeCase('prune-ownership-unnamed');
  t.after(() => c.cleanup());

  const foreign = foreignWorktree(c, 'foreign-task');

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, apply: true }, c.context());

  assert.ok(existsSync(foreign), 'the sweep only drops registrations whose directory is gone');
  assert.ok(worktreePaths(c.repoDir).includes(foreign), 'so a live foreign worktree is still registered');
  assert.ok(!(applied.worktrees ?? []).some((entry) => entry.path === foreign), 'and it is not reported as stale');
});

test('a dirty foreign worktree is refused, and force does not override uncommitted changes', async (t) => {
  const c = makeCase('prune-ownership-dirty');
  t.after(() => c.cleanup());

  const foreign = foreignWorktree(c, 'foreign-dirty');
  writeFileSync(join(foreign, 'wip.txt'), 'uncommitted work\n');

  const applied = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['foreign-dirty'], apply: true }, c.context());
  const refused = (applied.namedWorktrees ?? []).find((tree) => tree.path === foreign);
  assert.equal(refused.removed, false, 'the dirty worktree is not removed');
  assert.ok((refused.dirty ?? []).includes('wip.txt'), 'and the uncommitted file is named');
  assert.ok(existsSync(foreign) && worktreePaths(c.repoDir).includes(foreign));

  const forced = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: ['foreign-dirty'], apply: true, force: true }, c.context());
  const kept = (forced.namedWorktrees ?? []).find((tree) => tree.path === foreign);
  assert.equal(kept.removed, false, 'force overrides ownership, never uncommitted changes');
  assert.ok((kept.dirty ?? []).includes('wip.txt'), 'and still names the file');
  assert.ok(existsSync(foreign), 'the worktree is exactly where it was');
});

test('removeWorktree itself refuses an unowned worktree unless the caller allows it', async (t) => {
  const c = makeCase('prune-ownership-layer1');
  t.after(() => c.cleanup());

  // Layer 1, asked directly: the named path above refuses before this call, so
  // the refusal branch would otherwise never be exercised.
  const foreign = foreignWorktree(c, 'foreign-task');
  const refused = await removeWorktree(c.repoDir, foreign, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.removed, false);
  assert.equal(refused.code, 'not-owned');
  assert.equal(refused.owned, false);
  assert.ok(existsSync(foreign) && worktreePaths(c.repoDir).includes(foreign), 'nothing was removed');

  // The explicit opt-in is the only way past it, and it is what prune's force maps to.
  const allowed = await removeWorktree(c.repoDir, foreign, { allowForeign: true });
  assert.equal(allowed.removed, true);
  assert.ok(!existsSync(foreign));

  // The dead-registration branch takes the same answer: a direct call does not
  // unlock a foreign registration whose directory is gone.
  const dead = foreignWorktree(c, 'foreign-dead');
  git(c.repoDir, ['worktree', 'lock', '--reason', 'suite', dead]);
  rmSync(dead, { recursive: true, force: true });

  const deadRefused = await removeWorktree(c.repoDir, dead, {});
  assert.equal(deadRefused.ok, false);
  assert.equal(deadRefused.code, 'not-owned');
  assert.equal(isLocked(c.repoDir, dead), true, 'the lock is still on');
  assert.ok(worktreePaths(c.repoDir).includes(dead), 'and the registration is still there');
});

test('the main checkout is refused with and without force', async (t) => {
  const c = makeCase('prune-ownership-main');
  t.after(() => c.cleanup());

  const plain = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: [c.repoDir], apply: true }, c.context());
  const refused = (plain.namedWorktrees ?? []).find((tree) => tree.path === c.repoDir);
  assert.ok(refused, 'the main checkout is reported');
  assert.equal(refused.removed, false, 'and not removed');
  assert.match(String(refused.error), /main working tree/u, 'with the reason that says so');

  const forced = await runAction('prune', { action: 'prune', repo: c.repoDir, worktrees: [c.repoDir], apply: true, force: true }, c.context());
  const still = (forced.namedWorktrees ?? []).find((tree) => tree.path === c.repoDir);
  assert.ok(still, 'force does not make the main checkout disappear from the report');
  assert.equal(still.removed, false, 'force is not a licence to delete the checkout the session works in');
  assert.match(String(still.error), /main working tree/u);

  assert.ok(existsSync(c.repoDir), 'the checkout is still on disk');
  assert.deepEqual(worktreePaths(c.repoDir), [c.repoDir], 'and still the only worktree git knows');
});
