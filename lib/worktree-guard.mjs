/**
 * Worktree enforcement: the half of "one worktree per task" that a description
 * cannot deliver.
 *
 * Every other part of this bundle asks. The tool description says to work in a
 * worktree, the guard redirects raw git at the tool, and the turn sync keeps
 * whatever happened committed. None of that stops the actual moment that decides
 * where the work lands: a file edit. A model that reads "work in a worktree" and
 * then edits `main` in place has followed the instruction as far as it understood
 * it, and the only thing that would have changed the outcome is a refusal.
 *
 * So this module refuses — narrowly, and only in the case the configuration
 * names:
 *
 *   off        never refuse; the description and the tool remain the whole story
 *   protected  refuse a write to a repository sitting on a protected branch
 *   always     refuse a write to any repository this session has no worktree for
 *
 * Two things are deliberately absent.
 *
 * It does not create the worktree for you. A guard that has a side effect on a
 * refused call is a guard that creates a worktree for every edit somebody
 * abandons, and the caller learns nothing about why the write stopped. The
 * refusal carries the exact action to run instead, which is one cheap step and a
 * better lesson.
 *
 * It does not fire on a branch that is already a task branch. A session working
 * in its own `dsh/...` worktree, or on any branch that is not protected, is
 * already isolated; gating that would make the rule feel arbitrary and teach the
 * caller to route around it.
 *
 * Only `node:` builtins and relative imports, and every function is fail-soft:
 * a check that cannot read the repository answers "allow", because a guard that
 * breaks unrelated tool calls is worse than a guard that misses one.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

import * as git from './git.mjs';
import * as state from './state.mjs';
import { isProtectedBranch } from './config.mjs';

/**
 * File tools whose target decides where work lands.
 *
 * The same set `session-files.mjs` records, for the same reason: these are the
 * calls that change a repository, and a rule about where changes land has to
 * cover exactly them.
 */
export const MUTATING_FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'notebook_edit', 'apply_patch']);

/** Argument names that carry a target path, across the file tools. */
const PATH_ARGUMENTS = ['file_path', 'path', 'filePath', 'notebook_path', 'target_file'];

/**
 * The file this call is about, or undefined when it is not a mutating file
 * operation.
 *
 * A shell command is NOT included, and that is a deliberate limit worth stating:
 * `bash` can write a file, and reading a shell command well enough to know
 * whether it will is the same unbounded problem the git guard already documents
 * as best-effort. Treating every shell call as a write would gate `git status`,
 * which is the one thing this bundle most wants a session doing freely.
 */
export function editTarget(exec) {
  const name = typeof exec?.name === 'string' ? exec.name : '';
  if (!MUTATING_FILE_TOOLS.has(name)) return undefined;
  const args = exec?.arguments;
  if (args === null || typeof args !== 'object') return undefined;
  for (const key of PATH_ARGUMENTS) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * The worktree this session owns for a repository, if any.
 *
 * Returning the path rather than a boolean, because the rule is not about
 * whether isolation exists — it is about whether *this edit* lands inside it.
 * A boolean said "the session has a worktree for this repository", which is true
 * while the caller edits the main checkout, and that would let the exact write
 * the rule exists to stop straight through.
 *
 * Presence of the registry entry is not enough either: a worktree somebody
 * deleted outside git leaves an entry pointing at a directory that is gone, and
 * treating that as isolated would report an edit as isolated while it lands in
 * the main checkout. The directory has to exist.
 */
export function ownedWorktreePath(sessionId, repoRoot, config) {
  const session = state.readSession(sessionId, { stateRoot: config.stateRoot });
  const entry = session.worktrees.find((candidate) => candidate.repoRoot === repoRoot && existsSync(candidate.path));
  return entry?.path;
}

/** Whether a session owns any usable worktree for a repository. */
export function hasOwnWorktree(sessionId, repoRoot, config) {
  return ownedWorktreePath(sessionId, repoRoot, config) !== undefined;
}

/**
 * The decision for one file edit.
 *
 * Split out from the git work so it can be tested directly: this is the part
 * with the rule in it, and a rule that can only be exercised through a live Host
 * is a rule nobody tests. `snapshot` carries what the caller already had to look
 * up — the repository root, the branch, and whether a worktree exists.
 *
 * @returns {{kind: 'allow'} | {kind: 'deny', reason: string, displayReason: string}}
 */
export function decideWorktree(snapshot, config, options = {}) {
  const mode = config?.autoWorktree ?? 'off';
  if (mode === 'off') return { kind: 'allow' };
  if (snapshot === null || typeof snapshot !== 'object') return { kind: 'allow' };
  const { repoRoot, branch, insideOwned, protectedBranch } = snapshot;
  if (typeof repoRoot !== 'string' || repoRoot === '') return { kind: 'allow' };

  const repoName = repoRoot.split('/').filter((part) => part !== '').pop() ?? repoRoot;
  const where = 'repository ' + repoName;
  const how = 'Run the git tool with action "start" (slug: something-short), then repeat this edit against the path it returns.';

  // The edit is already in the session's own worktree: that is the destination,
  // not a detour, so no mode refuses it.
  if (insideOwned === true) return { kind: 'allow' };

  if (mode === 'protected') {
    // Nothing to say about a branch that is not protected: the rule is about
    // keeping `main` clean, not about forcing a worktree for its own sake.
    if (protectedBranch !== true) return { kind: 'allow' };
    return {
      kind: 'deny',
      reason: 'This edit targets ' + where + ', which is on the protected branch "' + String(branch ?? '')
        + '". Changes there cannot be pushed and cannot be isolated from other sessions working in the same checkout. '
        + how,
      displayReason: 'Blocked: edit to ' + repoName + ' on "' + String(branch ?? '') + '" — start a worktree first',
    };
  }

  // `always`: any repository without a worktree, on any branch.
  return {
    kind: 'deny',
    reason: 'This edit targets ' + where + ', which this session has no worktree for'
      + (typeof branch === 'string' ? ' (it is on "' + branch + '")' : '')
      + '. autoWorktree is "always", so every repository this session changes gets its own worktree. '
      + how,
    displayReason: 'Blocked: edit to ' + repoName + ' with no worktree — start one first',
  };
}

/** Whether a path is the given directory or sits inside it, both realpath'd. */
function isInside(parent, child) {
  const from = realpathOr(parent);
  const to = realpathOr(child);
  const rel = relative(from, to);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** A realpath, or the path itself when it cannot be resolved. */
function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The rule, applied to a pending tool call.
 *
 * Resolves the target's repository and branch through git, which is why this is
 * asynchronous while `lib/guard.mjs` is not: that one classifies a string, this
 * one has to know the state of a repository.
 *
 * @returns {Promise<{kind: 'allow'} | {kind: 'deny', reason: string, displayReason: string}>}
 */
export async function evaluateWorktree(exec, config, options = {}) {
  if (config?.autoWorktree === 'off') return { kind: 'allow' };
  const target = editTarget(exec);
  if (target === undefined) return { kind: 'allow' };

  const sessionId = String(exec?.agent?.id ?? exec?.agent?.session ?? '');
  if (sessionId === '') return { kind: 'allow' };

  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd();
  const absolute = isAbsolute(target) ? target : resolvePath(cwd, target);

  const repoRoot = await git.toplevel(absolute);
  if (repoRoot === undefined) return { kind: 'allow' };

  const branch = await git.currentBranch(repoRoot);
  const ownedPath = ownedWorktreePath(sessionId, repoRoot, config);
  const snapshot = {
    repoRoot,
    branch,
    owned: ownedPath !== undefined,
    // The distinction the rule turns on: a worktree existing is not the same as
    // this edit being in it.
    insideOwned: ownedPath !== undefined && isInside(ownedPath, absolute),
    protectedBranch: branch !== undefined && isProtectedBranch(config, branch),
  };
  return decideWorktree(snapshot, config, options);
}

/**
 * Register the enforcement.
 *
 * Registered before the touched-file recorder so that a refused edit is never
 * recorded: the record decides what the turn end may commit, and a path that was
 * never written would make it commit a repository the session has not actually
 * changed.
 */
export function registerWorktreeGuard(ctx, rowConfig, options = {}) {
  const cwdOf = typeof options.cwdOf === 'function' ? options.cwdOf : () => process.cwd();

  ctx.on('tools/pre-execute', async (exec, next) => {
    let decision;
    try {
      decision = await evaluateWorktree(exec, rowConfig, { cwd: cwdOf(exec?.agent) });
    } catch {
      // A rule that cannot read the repository must not block an unrelated edit.
      return next();
    }
    if (decision.kind === 'allow') return next();
    ctx.logger?.info?.('dsh-git worktree guard denied an edit: ' + decision.reason);
    return {
      kind: 'deny',
      reason: decision.reason,
      displayReason: { en: decision.displayReason },
      info: { name: 'dsh-git-worktree', code: 'worktree-required' },
    };
  });
}
