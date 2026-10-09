/**
 * The worktree guard, driven the way the Host drives it.
 *
 * registerWorktreeGuard() is given a minimal context that captures the
 * listener it registers, and that listener is then called with the same
 * ToolExecution shape the file tools produce. The repository, its branch and its
 * worktrees are real; only the Cordis context is a stand-in, because the Host is
 * not part of this package.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { registerWorktreeGuard } from '../lib/worktree-guard.mjs';
import { makeCase } from './helpers.mjs';

/**
 * Capture the listener registerWorktreeGuard installs, the way ctx.on would.
 *
 * The execution carries the agent, because that is what identifies the session
 * that owns a worktree — the Host always supplies it, and without it the guard
 * answers "allow" for a reason that has nothing to do with the path under test.
 */
function listenerFor(config, cwd, sessionId) {
  const listeners = [];
  const ctx = {
    on(event, handler) {
      if (event === 'tools/pre-execute') listeners.push(handler);
    },
    logger: { info() {} },
  };
  registerWorktreeGuard(ctx, config, { cwdOf: () => cwd });
  assert.equal(listeners.length, 1, 'the guard registers one pre-execute listener');
  const next = async () => ({ kind: 'allow' });
  const exec = (name, filePath) => ({ name, arguments: { file_path: filePath }, agent: { id: sessionId } });
  return (name, filePath) => listeners[0](exec(name, filePath), next);
}

test('the guard refuses an edit to a protected branch, whatever shape the path takes', async (t) => {
  const c = makeCase('guard');
  t.after(() => c.cleanup());
  const decide = listenerFor(c.config, c.reference, c.sessionId);

  // A directory that exists: refused.
  const existing = await decide('write', join(c.repoDir, 'NOTES.md'));
  assert.equal(existing.kind, 'deny');
  assert.match(existing.reason, /protected branch "main"/u);

  // A directory that does not exist yet. The caller is still aiming at the same
  // repository on the same branch, and this is exactly how a session writes a
  // new file into a new folder — the guard has to resolve the repository from
  // the nearest directory that does exist.
  const newSubdir = await decide('write', join(c.repoDir, 'src', 'deep', 'file.txt'));
  assert.equal(newSubdir.kind, 'deny', 'a path under a directory that does not exist yet is still gated');

  // A file directly in a new subdirectory of the repository root.
  const newFileInNewDir = await decide('write', join(c.repoDir, 'brand-new', 'file.txt'));
  assert.equal(newFileInNewDir.kind, 'deny');

  // The edit tool takes the same argument name and is gated the same way.
  const edited = await decide('edit', join(c.repoDir, 'brand-new', 'file.txt'));
  assert.equal(edited.kind, 'deny');

  // A path outside every repository is not this rule's business.
  const outside = await decide('write', join(c.root, 'loose-note.txt'));
  assert.equal(outside.kind, 'allow');
});

test('the guard allows work in the session own worktree, and on a branch that is not protected', async (t) => {
  const c = makeCase('guard-allow');
  t.after(() => c.cleanup());
  const decide = listenerFor(c.config, c.reference, c.sessionId);

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'work' }, c.context());
  assert.equal(started.ok, true);
  const inside = await decide('write', join(started.worktree, 'src', 'new', 'file.txt'));
  assert.equal(inside.kind, 'allow', 'the destination action "start" returned is never refused');

  // A repository on a branch that is not protected is left alone: the rule is
  // about keeping main clean, not about worktrees for their own sake.
  mkdirSync(join(c.root, 'other'), { recursive: true });
  const { execFileSync } = await import('node:child_process');
  const other = join(c.root, 'other');
  execFileSync('git', ['init', '--initial-branch=feature', other], { encoding: 'utf8' });
  const allowed = await decide('write', join(other, 'notes', 'file.txt'));
  assert.equal(allowed.kind, 'allow');

  // autoWorktree off means never refuse, whatever the repository is.
  const off = listenerFor({ ...c.config, autoWorktree: 'off' }, c.reference, c.sessionId);
  assert.equal((await off('write', join(c.repoDir, 'NOTES.md'))).kind, 'allow');
});
