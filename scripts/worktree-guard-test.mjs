#!/usr/bin/env node
/**
 * Worktree enforcement, exercised against real repositories.
 *
 * The rule is the interesting part and it has two directions, so both are
 * asserted with equal weight. A rule that fires when it should is the feature; a
 * rule that fires when it should not is the reason people switch a guard off, and
 * a switched-off guard protects nothing. Most of what follows is the second kind.
 *
 * The state is real — actual repositories on actual branches — because the
 * decision depends on what branch a repository is on and whether a worktree
 * exists on disk, and neither can be faked convincingly.
 *
 *   node scripts/worktree-guard-test.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateWorktree, decideWorktree, editTarget, hasOwnWorktree, ownedWorktreePath } from '../lib/worktree-guard.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { createWorktree } from '../lib/worktrees.mjs';
import * as state from '../lib/state.mjs';

const SESSION = 'worktree-guard-session';
const failures = [];
let passed = 0;

function check(description, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log('PASS ' + description);
    return true;
  }
  failures.push(description + (detail !== '' ? ' — ' + detail : ''));
  console.log('FAIL ' + description + (detail !== '' ? ' — ' + detail : ''));
  return false;
}

const run = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-wtg-')));
const repo = join(root, 'work');
const stateRoot = join(root, 'state');
run(root, ['init', '-q', '-b', 'main', repo]);
run(repo, ['config', 'user.email', 'wtg@example.com']);
run(repo, ['config', 'user.name', 'dsh-git worktree guard test']);
writeFileSync(join(repo, 'app.txt'), 'a\n', 'utf8');
run(repo, ['add', '-A']);
run(repo, ['commit', '-qm', 'initial']);

/** A fake tool call, as the tools layer presents it. */
const call = (name, path) => ({ name, arguments: { file_path: path }, agent: { id: SESSION } });
const configFor = (autoWorktree, extra = {}) => resolveConfig({ worktreeRoot: join(root, 'worktrees'), stateRoot, autoWorktree, ...extra });

try {
  console.log('--- the target of a call is read from the right place ---');
  check('write names a file', editTarget(call('write', join(repo, 'app.txt'))) === join(repo, 'app.txt'));
  check('edit names a file', editTarget(call('edit', join(repo, 'app.txt'))) === join(repo, 'app.txt'));
  check('str_replace_editor names a file', editTarget(call('str_replace_editor', join(repo, 'app.txt'))) === join(repo, 'app.txt'));
  check('read is not an edit', editTarget(call('read', join(repo, 'app.txt'))) === undefined);
  check('bash is not an edit', editTarget({ name: 'bash', arguments: { command: 'echo x > f' }, agent: { id: SESSION } }) === undefined);
  check('a path-less write is not an edit', editTarget({ name: 'write', arguments: {}, agent: { id: SESSION } }) === undefined);

  console.log('\n--- autoWorktree: off never refuses (the shipped default) ---');
  const off = configFor('off');
  check('off allows an edit on main', (await evaluateWorktree(call('write', join(repo, 'app.txt')), off, { cwd: repo })).kind === 'allow');
  const offForced = decideWorktree({ repoRoot: repo, branch: 'main', owned: false, protectedBranch: true }, off);
  check('off allows even a protected-branch edit with no worktree', offForced.kind === 'allow', offForced.kind);

  console.log('\n--- protected: refuses main, and only main ---');
  const guarded = configFor('protected');
  const onMain = await evaluateWorktree(call('write', join(repo, 'app.txt')), guarded, { cwd: repo });
  check('an edit on main is refused', onMain.kind === 'deny', onMain.kind);
  check('the refusal names the branch', String(onMain.reason).includes('main'), String(onMain.reason).slice(0, 90));
  check('the refusal names the action to run instead', String(onMain.reason).includes('action "start"'), String(onMain.reason).slice(-90));
  check('the refusal shows a short reason to the user', typeof onMain.displayReason === 'string' && onMain.displayReason.length < 120, onMain.displayReason);

  // A feature branch is already isolated. Refusing here is the failure mode that
  // teaches a caller to work around the rule instead of with it.
  run(repo, ['checkout', '-q', '-b', 'feature/scratch']);
  const onFeature = await evaluateWorktree(call('write', join(repo, 'app.txt')), guarded, { cwd: repo });
  check('an edit on a non-protected branch is allowed', onFeature.kind === 'allow', onFeature.kind);
  run(repo, ['checkout', '-q', 'main']);

  console.log('\n--- a configured protected branch is honoured, not hardcoded ---');
  run(repo, ['branch', '-m', 'trunk']);
  const onTrunkDefault = await evaluateWorktree(call('write', join(repo, 'app.txt')), configFor('protected'), { cwd: repo });
  check('a branch outside the protected list is allowed', onTrunkDefault.kind === 'allow', onTrunkDefault.kind);
  const onTrunkProtected = await evaluateWorktree(call('write', join(repo, 'app.txt')), configFor('protected', { protectedBranches: ['trunk'] }), { cwd: repo });
  check('the same branch is refused once configured as protected', onTrunkProtected.kind === 'deny', onTrunkProtected.kind);
  run(repo, ['branch', '-m', 'main']);

  console.log('\n--- a session worktree makes protected irrelevant ---');
  const made = await createWorktree(repo, {
    worktreeRoot: join(root, 'worktrees'), branchPrefix: 'dsh/', slug: 'task', baseBranch: 'main', timeoutMs: 15000,
  });
  check('the worktree was created', made.ok === true, JSON.stringify(made));
  state.addWorktree(SESSION, { repo: 'work', repoRoot: repo, path: made.path, branch: made.branch, slug: made.slug, createdAt: new Date().toISOString() }, { stateRoot });
  check('the session is recorded as owning it', hasOwnWorktree(SESSION, repo, guarded) === true);
  check('and the path it owns is the one that was created', ownedWorktreePath(SESSION, repo, guarded) === made.path, String(ownedWorktreePath(SESSION, repo, guarded)));

  const insideMain = await evaluateWorktree(call('write', join(repo, 'app.txt')), guarded, { cwd: repo });
  check('an edit to the main checkout is still refused while the worktree exists', insideMain.kind === 'deny', insideMain.kind);
  const insideWorktree = await evaluateWorktree(call('write', join(made.path, 'app.txt')), guarded, { cwd: repo });
  check('an edit inside the worktree is allowed', insideWorktree.kind === 'allow', insideWorktree.kind);

  console.log('\n--- a worktree that no longer exists does not count as isolation ---');
  rmSync(made.path, { recursive: true, force: true });
  check('the registry still has the entry', state.readSession(SESSION, { stateRoot }).worktrees.length > 0);
  check('but the session is not treated as isolated', hasOwnWorktree(SESSION, repo, guarded) === false);
  const vanished = await evaluateWorktree(call('write', join(repo, 'app.txt')), guarded, { cwd: repo });
  check('so an edit to main is refused again', vanished.kind === 'deny', vanished.kind);
  run(repo, ['worktree', 'prune']);

  console.log('\n--- always: every repository needs a worktree, not just protected ones ---');
  const always = configFor('always');
  const anyBranch = await evaluateWorktree(call('write', join(repo, 'app.txt')), always, { cwd: repo });
  check('a write with no worktree is refused on main', anyBranch.kind === 'deny', anyBranch.kind);
  run(repo, ['checkout', '-q', '-b', 'feature/second']);
  const featureAlways = await evaluateWorktree(call('write', join(repo, 'app.txt')), always, { cwd: repo });
  check('and refused on a feature branch too, unlike protected', featureAlways.kind === 'deny', featureAlways.kind);
  run(repo, ['checkout', '-q', 'main']);

  console.log('\n--- a relative path resolves against the session, not the process ---');
  const relativeConfig = configFor('protected');
  check('the initial checkout is the main one', run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main');
  const relative = await evaluateWorktree({ name: 'write', arguments: { file_path: 'app.txt' }, agent: { id: SESSION } }, relativeConfig, { cwd: repo });
  check('a relative path inside the repository is resolved and refused', relative.kind === 'deny', relative.kind);
  const outside = await evaluateWorktree(call('write', join(root, 'not-a-repo.txt')), relativeConfig, { cwd: repo });
  check('a path outside any repository is allowed', outside.kind === 'allow', outside.kind);

  console.log('\n--- fail-soft: a guard that throws must not block unrelated work ---');
  check('no session id means no opinion', (await evaluateWorktree({ name: 'write', arguments: { file_path: join(repo, 'app.txt') } }, relativeConfig, { cwd: repo })).kind === 'allow');
  check('a null snapshot means no opinion', decideWorktree(null, relativeConfig).kind === 'allow');
  check('a snapshot with no repository means no opinion', decideWorktree({ repoRoot: '', branch: 'main' }, relativeConfig).kind === 'allow');
  check('a protected branch with no worktree is refused',
    decideWorktree({ repoRoot: repo, branch: 'main', insideOwned: false, protectedBranch: true }, relativeConfig).kind === 'deny');

  console.log('\n--- the rule is pure, so it can be reasoned about directly ---');
  check('being inside the owned worktree wins over protected',
    decideWorktree({ repoRoot: repo, branch: 'main', insideOwned: true, protectedBranch: true }, relativeConfig).kind === 'allow');
  check('owning a worktree but editing OUTSIDE it is still refused',
    decideWorktree({ repoRoot: repo, branch: 'main', owned: true, insideOwned: false, protectedBranch: true }, relativeConfig).kind === 'deny');
  check('always refuses an unprotected branch with no worktree',
    decideWorktree({ repoRoot: repo, branch: 'feature/x', insideOwned: false, protectedBranch: false }, always).kind === 'deny');
  check('protected allows an unprotected branch with no worktree',
    decideWorktree({ repoRoot: repo, branch: 'feature/x', insideOwned: false, protectedBranch: false }, relativeConfig).kind === 'allow');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('\n' + String(passed) + ' passed, ' + String(failures.length) + ' failed');
if (failures.length > 0) {
  console.error('\n' + failures.join('\n'));
  process.exit(1);
}
console.log('Worktree enforcement refuses what it should, stays out of the way otherwise, and creates nothing.');
