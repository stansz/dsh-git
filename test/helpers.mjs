/**
 * Real fixtures for the dsh-git suite.
 *
 * There is no mocking here on purpose. Every case builds a real repository with
 * real git — a bare origin and a clone of it — inside a real workspace
 * directory, then drives the plugin's own exported functions
 * (`runAction`, `evaluateWorktree`, `syncRepo`) exactly as the Host does.
 * Assertions read real git state: `worktree list`, refs in the bare origin, the
 * branch a worktree has checked out, and the plugin's own state files.
 *
 * The layout is the deployment's, not a temporary one:
 *
 *   <workspace>/<case>/app          the repository the session works in
 *   <workspace>/<case>/origin.git   its remote
 *   <workspace>/<case>/.worktrees   where action "start" puts task worktrees
 *   <workspace>/<case>/state        the plugin's session state for this case
 *
 * The workspace is the directory the suite runs in when that directory is not
 * itself a repository — which is what a session workspace is. Running the suite
 * from inside the bundle (a repository) would put a second copy of that tree
 * inside it, so the root moves to the repository's parent instead. That is the
 * one decision in this file, and it is made for the reason the plugin itself
 * documents for `worktreeRoot`.
 *
 * `stateRoot` points inside the case directory rather than at the machine's real
 * Harness home: the code, the file format and the reads are the real ones, but a
 * test run must not add session records to a live deployment's state.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { resolveConfig } from '../lib/config.mjs';

// Each case removes its own directory; this takes the empty root with it, so a
// run leaves nothing behind in the workspace it borrowed. `rmdir` rather than a
// recursive delete on purpose: a directory that still holds something is a case
// that failed to clean up, and deleting it here would hide exactly that.
process.on('exit', () => {
  try {
    rmdirSync(join(workspaceRoot(), '.dsh-git-tests'));
  } catch {
    /* never created, or not empty */
  }
});

/** A directory that is not itself a repository: the fixture workspace. */
export function workspaceRoot() {
  const configured = process.env.DSH_GIT_TEST_ROOT;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
  const cwd = process.cwd();
  const toplevel = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  return toplevel === undefined ? cwd : dirname(toplevel);
}

/** What one case owns: its directory, its repositories and its config. */
export function makeCase(name) {
  const root = join(workspaceRoot(), '.dsh-git-tests', name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const repoDir = join(root, 'app');
  const originDir = join(root, 'origin.git');
  git(root, ['init', '--bare', '--initial-branch=main', originDir]);
  git(root, ['clone', originDir, repoDir]);
  git(repoDir, ['config', 'user.email', 'suite@example.invalid']);
  git(repoDir, ['config', 'user.name', 'dsh-git suite']);
  writeFileSync(join(repoDir, 'README.md'), '# fixture\n\nreal repository for the dsh-git suite\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-m', 'chore: the fixture repository']);
  git(repoDir, ['push', '-u', 'origin', 'main']);
  git(repoDir, ['remote', 'set-head', 'origin', '-a']);

  return {
    name,
    root,
    repoDir,
    originDir,
    // The session's working directory: the workspace that contains the repository.
    reference: root,
    sessionId: 'session-' + randomUUID(),
    config: resolveConfig({
      worktreeRoot: join(root, '.worktrees'),
      stateRoot: join(root, 'state'),
      autoWorktree: 'protected',
      turnPush: true,
    }),
    context(overrides = {}) {
      return { config: this.config, reference: this.reference, sessionId: this.sessionId, ...overrides };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run git for real, in a directory, and return trimmed stdout. */
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

/** Run git, returning undefined instead of throwing. */
export function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

/** The branches a repository has, by full ref name. */
export function localBranches(repoDir) {
  return git(repoDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean).sort();
}

/** The branches the bare origin has, by full ref name. */
export function remoteBranches(originDir) {
  return git(originDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean).sort();
}

/** The worktrees git has registered, main checkout first. */
export function worktreePaths(repoDir) {
  return git(repoDir, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/** The paths a commit touched, relative to the repository. */
export function commitPaths(repoDir, rev) {
  return git(repoDir, ['show', '--name-only', '--format=', rev]).split('\n').filter(Boolean);
}

/** Whether a path exists. */
export function exists(path) {
  return existsSync(path);
}
