/**
 * The enforcement default, and the case that had to be fixed before it could move.
 *
 * `autoWorktree` defaulted to `off`: enforcement was something a deployment chose.
 * It defaults to `protected` now, because a guard nobody switches on is the failure
 * this bundle exists to end — and the guard beside it already refuses by default
 * (`guardMode: redirect`). Two things are pinned here:
 *
 *   - the default really is `protected`, resolved from an empty config;
 *   - it is usable, which is what the second case is about. `git init -b main`
 *     reports the branch name `main` before `main` exists, and reading that name as
 *     protected refused the first file of every new project with a remedy that could
 *     not run: `action "start"` cannot cut a worktree from an unborn HEAD.
 *
 * Both cases fail against the library this change replaces, which is the point: the
 * first because the old default was `off`, the second because the old rule read a
 * branch name that had no commits behind it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { evaluateWorktree } from '../lib/worktree-guard.mjs';
import { git, makeCase, tryGit } from './helpers.mjs';

/** The pending tool call the Host hands to the pre-execute listener. */
function writeCall(sessionId, filePath) {
  return { name: 'write', arguments: { file_path: filePath }, agent: { id: sessionId } };
}

/** The case's config with nothing said about enforcement, so the default decides. */
function defaultConfig(c) {
  return resolveConfig({ worktreeRoot: join(c.root, '.worktrees'), stateRoot: join(c.root, 'state') });
}

/**
 * The same config with the mode stated, so a case can be about the rule rather than
 * about the default: the unborn-branch case below has to fail against the library
 * this change replaces for its OWN reason, not because that library defaulted to off.
 */
function protectedConfig(c) {
  return resolveConfig({ worktreeRoot: join(c.root, '.worktrees'), stateRoot: join(c.root, 'state'), autoWorktree: 'protected' });
}

test('autoWorktree defaults to protected', () => {
  const config = resolveConfig({});
  assert.equal(config.autoWorktree, 'protected', 'enforcement is the default, not a setting somebody has to find');
});

test('the default refuses an edit into a repository on main, and the step it names works', async (t) => {
  const c = makeCase('default-protected');
  t.after(() => c.cleanup());
  const config = defaultConfig(c);

  const refused = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'edit.js')), config, { cwd: c.reference });
  assert.equal(refused.kind, 'deny', 'main is protected, and the default protects it');
  assert.match(refused.reason, /action "start"/u, 'and the refusal names the step that unblocks it');

  // A refusal whose remedy does not run is a dead end, so the remedy is part of the case.
  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'first-task' }, c.context({ config }));
  assert.equal(started.ok, true, 'action "start" is what the refusal named, and it works');
  const inWorktree = await evaluateWorktree(writeCall(c.sessionId, join(started.worktree, 'src', 'edit.js')), config, { cwd: c.reference });
  assert.equal(inWorktree.kind, 'allow', 'and the edit is allowed where the refusal pointed');
});

test('a branch with no commits is not protected: a new project can write its first file', async (t) => {
  const c = makeCase('unborn-branch');
  t.after(() => c.cleanup());
  const config = protectedConfig(c);

  // A repository created and not yet committed to: `main` is a name, not a branch.
  const fresh = join(c.root, 'fresh');
  mkdirSync(fresh, { recursive: true });
  git(fresh, ['init', '-q', '-b', 'main']);
  assert.equal(git(fresh, ['symbolic-ref', '--short', 'HEAD']), 'main', 'the unborn branch reports its name');
  assert.equal(tryGit(fresh, ['rev-parse', '-q', '--verify', 'HEAD']), undefined, 'and holds no commit');

  const decision = await evaluateWorktree(writeCall(c.sessionId, join(fresh, 'src', 'first.js')), config, { cwd: c.reference });
  assert.equal(decision.kind, 'allow', 'no history to protect, and no worktree can be cut from an unborn HEAD');

  // What the old rule told the caller to do here could not be done, which is why it was a dead end.
  const started = await runAction('start', { action: 'start', repo: fresh, slug: 'first' }, c.context({ config }));
  assert.equal(started.ok, false, 'action "start" cannot create a worktree before the first commit');
  assert.match(String(started.error?.message ?? ''), /base branch/u, 'and says which fact stopped it');

  // With a commit, the protection is real again.
  writeFileSync(join(fresh, 'README.md'), '# fresh\n');
  git(fresh, ['add', '.']);
  git(fresh, ['-c', 'user.email=suite@example.invalid', '-c', 'user.name=dsh-git suite', 'commit', '-qm', 'the first commit']);
  const after = await evaluateWorktree(writeCall(c.sessionId, join(fresh, 'src', 'second.js')), config, { cwd: c.reference });
  assert.equal(after.kind, 'deny', 'a commit on main makes the rule apply again');
});

test('protection is a literal name match on this plugin\'s own list', async (t) => {
  const c = makeCase('protected-is-a-name-list');
  t.after(() => c.cleanup());
  const config = protectedConfig(c);

  // This case pins behaviour rather than a fix: it passes against the library this
  // change replaces too. It is here because the wording around "protected" invites a
  // reader to hear GitHub's branch protection, or "worktrees always" — and both are
  // wrong. Rename the trunk: still `main` nowhere, so nothing refuses the edit.
  git(c.repoDir, ['branch', '-m', 'trunk']);
  const onTrunk = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'edit.js')), config, { cwd: c.reference });
  assert.equal(onTrunk.kind, 'allow', 'a trunk named trunk is not in protectedBranches, so nothing refuses the edit');

  // Listing the name is the whole fix, and it is a local list: no server setting is read.
  const listed = resolveConfig({
    worktreeRoot: join(c.root, '.worktrees'),
    stateRoot: join(c.root, 'state'),
    autoWorktree: 'protected',
    protectedBranches: ['trunk'],
  });
  const denied = await evaluateWorktree(writeCall(c.sessionId, join(c.repoDir, 'src', 'edit.js')), listed, { cwd: c.reference });
  assert.equal(denied.kind, 'deny', 'once the name is listed, the same edit is refused');
  assert.match(denied.displayReason, /on "trunk"/u, 'and the refusal names the branch it matched');
});
