/**
 * Configuration for dsh-git: defaults, schema, and the one place a raw row
 * config becomes a resolved config.
 *
 * Two things here are load-bearing and easy to get wrong.
 *
 * First, the schema is resolved defensively. `@deepseek-ai/schemastery` is a
 * declared dependency, but under a `link:` install a bundle's dependencies are
 * not hoisted, so a static `import` would take the whole plugin down at
 * activation — the exact trap recorded against other bundles in this profile.
 * Every root that could legitimately see the package is probed, and if none
 * can, the plugin runs with no schema and every value at its default rather
 * than failing to mount.
 *
 * Second, every default here is chosen so that the plugin's guarantees hold
 * with no configuration at all. Turn commits and turn pushes are on, the guard
 * redirects rather than blocks, and the worktree root is outside every
 * repository. A default that has to be switched on to help is a default that
 * silently does nothing, which is the failure this plugin exists to remove.
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Every setting, at the value that makes the plugin's guarantees true.
 *
 * Exported so tests and the resolver share one source of truth: a default
 * stated twice eventually disagrees with itself.
 */
export const DEFAULT_CONFIG = {
  worktreeRoot: join(homedir(), '.dsh', 'worktrees'),
  stateRoot: join(homedir(), '.dsh', 'state'),
  branchPrefix: 'dsh/',
  baseBranch: '',
  protectedBranches: ['main', 'master'],
  guardMode: 'redirect',
  guardTools: ['bash'],
  autoWorktree: 'protected',
  turnCommit: true,
  turnCommitMessage: '',
  turnPush: true,
  turnCommitMaxFiles: 200,
  turnSyncTimeoutMs: 20000,
  githubHost: 'github.com',
  prDraft: false,
  timeoutMs: 30000,
};

/** The enum values each constrained field accepts. */
const ENUMS = {
  guardMode: ['off', 'warn', 'redirect'],
  autoWorktree: ['off', 'protected', 'always'],
};

/**
 * Load schemastery from whichever root can see it.
 *
 * A `link:` install does not hoist a bundle's dependencies, so resolving from
 * this module is not enough on its own; the profile and the process directory
 * are probed too. Returns undefined rather than throwing, because a row with no
 * schema still works — it just has no Configure page.
 */
export function loadSchema() {
  const roots = [
    import.meta.url,
    process.env.DSH_PROFILE_DIR !== undefined ? join(process.env.DSH_PROFILE_DIR, 'index.js') : undefined,
    join(process.cwd(), 'index.js'),
  ];
  for (const root of roots) {
    if (root === undefined) continue;
    try {
      const loaded = createRequire(root)('@deepseek-ai/schemastery');
      const schema = loaded?.default ?? loaded;
      if (schema !== undefined) return schema;
    } catch {
      /* not resolvable from this root; try the next one */
    }
  }
  return undefined;
}

/** The shape of one entry in `DEFAULT_CONFIG`, for schema generation. */
function describe(key) {
  switch (key) {
    case 'worktreeRoot':
      return 'Directory holding per-task worktrees. Each task gets <worktreeRoot>/<repo>/<slug>. Outside every repository on purpose: nothing to add to .gitignore and no second copy of the tree for editors and watchers to index.';
    case 'stateRoot':
      return 'Directory holding this plugin\'s per-session state (which worktrees a session owns, and which pushes are failing). Session state is the only thing written here; it never holds credentials.';
    case 'branchPrefix':
      return 'Prefix for the branch created for a task worktree. Branches under this prefix are the ones automatic push considers safe to push.';
    case 'baseBranch':
      return 'Branch a task worktree is cut from. Empty resolves origin/HEAD, falling back to main.';
    case 'protectedBranches':
      return 'Branches automatic push never pushes to. A turn commit on one of these still commits, and reports the branch as unpushed instead of pushing it.';
    case 'guardMode':
      return 'How to treat raw mutating git run through bash. off: no guard. warn: allow and classify. redirect: ask before a mutating command, always deny the commands that discard work.';
    case 'guardTools':
      return 'Tool names the guard inspects. Default is bash, the only tool that can run git.';
    case 'autoWorktree':
      return 'When to create a task worktree automatically. off: only when asked. protected: when a write targets a repository sitting on a protected branch. always: on the first write to any repository.';
    case 'turnCommit':
      return 'Commit the paths a turn changed, at the end of that turn. This is what stops work being left uncommitted when a session forgets.';
    case 'turnCommitMessage':
      return 'Commit message for automatic turn commits. Empty generates "dsh: turn <N> — <changed paths>". `{turn}` and `{paths}` are substituted when present.';
    case 'turnPush':
      return 'Also push at the end of a turn, when the branch is safe to push (a task worktree, or a branch under the prefix) and is not protected. A commit that exists only on this disk is still unsynced work.';
    case 'turnCommitMaxFiles':
      return 'Skip the automatic commit above this many changed paths, and report the repository instead. Guards against a runaway turn committing thousands of files under a generated message.';
    case 'turnSyncTimeoutMs':
      return 'Budget for one end-of-turn sync, in milliseconds. The turn boundary is never held open for it; this bounds the work it can do after the boundary.';
    case 'githubHost':
      return 'GitHub host used for the REST API and for matching remotes. Change it for a GitHub Enterprise install.';
    case 'prDraft':
      return 'Open pull requests as drafts by default. Finished work passes draft: false explicitly.';
    case 'timeoutMs':
      return 'Deadline for one git command, in milliseconds.';
    default:
      return '';
  }
}

/**
 * Build the Config export, or undefined when schemastery is unreachable.
 *
 * Field descriptions are the user-facing documentation for each setting, so
 * they are written for someone deciding a value, not for a maintainer.
 */
export function buildConfig() {
  const z = loadSchema();
  if (z === undefined) return undefined;
  try {
    return z.object({
      worktreeRoot: z.string().default(DEFAULT_CONFIG.worktreeRoot).description(describe('worktreeRoot')),
      stateRoot: z.string().default(DEFAULT_CONFIG.stateRoot).description(describe('stateRoot')),
      branchPrefix: z.string().default(DEFAULT_CONFIG.branchPrefix).description(describe('branchPrefix')),
      baseBranch: z.string().default(DEFAULT_CONFIG.baseBranch).description(describe('baseBranch')),
      protectedBranches: z.array(z.string()).default([...DEFAULT_CONFIG.protectedBranches]).description(describe('protectedBranches')),
      guardMode: z.union([z.const('off'), z.const('warn'), z.const('redirect')]).default(DEFAULT_CONFIG.guardMode).description(describe('guardMode')),
      guardTools: z.array(z.string()).default([...DEFAULT_CONFIG.guardTools]).description(describe('guardTools')),
      autoWorktree: z.union([z.const('off'), z.const('protected'), z.const('always')]).default(DEFAULT_CONFIG.autoWorktree).description(describe('autoWorktree')),
      turnCommit: z.boolean().default(DEFAULT_CONFIG.turnCommit).description(describe('turnCommit')),
      turnCommitMessage: z.string().default(DEFAULT_CONFIG.turnCommitMessage).description(describe('turnCommitMessage')),
      turnPush: z.boolean().default(DEFAULT_CONFIG.turnPush).description(describe('turnPush')),
      turnCommitMaxFiles: z.number().default(DEFAULT_CONFIG.turnCommitMaxFiles).description(describe('turnCommitMaxFiles')),
      turnSyncTimeoutMs: z.number().default(DEFAULT_CONFIG.turnSyncTimeoutMs).description(describe('turnSyncTimeoutMs')),
      githubHost: z.string().default(DEFAULT_CONFIG.githubHost).description(describe('githubHost')),
      prDraft: z.boolean().default(DEFAULT_CONFIG.prDraft).description(describe('prDraft')),
      timeoutMs: z.number().default(DEFAULT_CONFIG.timeoutMs).description(describe('timeoutMs')),
    });
  } catch {
    return undefined;
  }
}

/** Expand a leading `~`, and resolve nothing else: a relative path stays relative. */
function expandHome(value) {
  const text = String(value);
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

/** A trimmed non-empty string, or undefined. */
function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A finite positive number, or undefined. */
function positive(value) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** One of the allowed enum values, or undefined. */
function oneOf(key, value) {
  return ENUMS[key].includes(value) ? value : undefined;
}

/** A string array with blanks removed, or undefined when nothing survives. */
function strings(value) {
  if (!Array.isArray(value)) return undefined;
  const kept = value.map((entry) => text(entry)).filter((entry) => entry !== undefined);
  return kept.length > 0 ? kept : undefined;
}

/**
 * A raw row config as a resolved config.
 *
 * Unknown keys are dropped and a malformed value falls back to its default, so
 * a hand-edited patch can never leave the plugin half-configured — the failure
 * mode is "this one setting is at its default", which is always a working
 * configuration.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULT_CONFIG, protectedBranches: [...DEFAULT_CONFIG.protectedBranches], guardTools: [...DEFAULT_CONFIG.guardTools] };

  for (const key of ['worktreeRoot', 'stateRoot']) {
    const value = text(input[key]);
    if (value !== undefined) config[key] = expandHome(value);
  }
  if (!isAbsolute(config.worktreeRoot)) config.worktreeRoot = join(homedir(), config.worktreeRoot);
  if (!isAbsolute(config.stateRoot)) config.stateRoot = join(homedir(), config.stateRoot);

  const branchPrefix = text(input.branchPrefix);
  if (branchPrefix !== undefined) config.branchPrefix = branchPrefix;

  const baseBranch = typeof input.baseBranch === 'string' ? input.baseBranch.trim() : undefined;
  if (baseBranch !== undefined) config.baseBranch = baseBranch;

  const protectedBranches = strings(input.protectedBranches);
  if (protectedBranches !== undefined) config.protectedBranches = protectedBranches;

  const guardMode = oneOf('guardMode', input.guardMode);
  if (guardMode !== undefined) config.guardMode = guardMode;

  const guardTools = strings(input.guardTools);
  if (guardTools !== undefined) config.guardTools = guardTools;

  const autoWorktree = oneOf('autoWorktree', input.autoWorktree);
  if (autoWorktree !== undefined) config.autoWorktree = autoWorktree;

  for (const key of ['turnCommit', 'turnPush', 'prDraft']) {
    if (typeof input[key] === 'boolean') config[key] = input[key];
  }

  const turnCommitMessage = typeof input.turnCommitMessage === 'string' ? input.turnCommitMessage : undefined;
  if (turnCommitMessage !== undefined) config.turnCommitMessage = turnCommitMessage;

  const turnCommitMaxFiles = positive(input.turnCommitMaxFiles);
  if (turnCommitMaxFiles !== undefined) config.turnCommitMaxFiles = turnCommitMaxFiles;

  const turnSyncTimeoutMs = positive(input.turnSyncTimeoutMs);
  if (turnSyncTimeoutMs !== undefined) config.turnSyncTimeoutMs = turnSyncTimeoutMs;

  const timeoutMs = positive(input.timeoutMs);
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  const githubHost = text(input.githubHost);
  if (githubHost !== undefined) config.githubHost = githubHost;

  return config;
}

/** Whether a branch is one automatic push must never push to. */
export function isProtectedBranch(config, branch) {
  const name = text(branch);
  if (name === undefined) return true;
  return config.protectedBranches.includes(name);
}

/** Whether a branch is this plugin's own task branch, and so safe to push. */
export function isTaskBranch(config, branch) {
  const name = text(branch);
  if (name === undefined) return false;
  return name.startsWith(config.branchPrefix);
}

/** The protected-branch list as it appears in a message. */
export function protectedList(config) {
  return config.protectedBranches.join(', ');
}
