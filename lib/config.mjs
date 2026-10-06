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
import { basename, dirname, isAbsolute, join } from 'node:path';

/**
 * The Harness home this deployment actually uses.
 *
 * `$DSH_HOME` first, then the parent of `$DSH_PROFILE_DIR` — the profile always
 * lives at `<home>/profiles/<name>`, so that derives the home even when the
 * variable is absent — then `~/.dsh`. This mirrors what the shipped
 * `@deepseek-ai/dsh-home-paths` package resolves.
 *
 * Resolved per call rather than captured at import, because the environment is
 * what decides and a deployment or a test may set it after this module loads.
 */
export function dshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (configured !== '') return expandHome(configured);
  const profileDir = typeof env?.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : '';
  if (profileDir !== '' && isAbsolute(profileDir)) {
    // `<home>/profiles/<name>` — two levels up, and the intermediate segment has
    // to be `profiles`, or a profile directory somewhere unexpected would make
    // this invent a home that is not one. One level up is the *profiles*
    // directory, which would put every worktree in the wrong place.
    const profiles = dirname(profileDir);
    if (basename(profiles) === 'profiles') {
      const home = dirname(profiles);
      if (home !== '' && home !== '/' && home !== profiles) return home;
    }
  }
  return join(homedir(), '.dsh');
}

/**
 * Every setting, at the value that makes the plugin's guarantees true.
 *
 * The two path fields are `null` here on purpose and resolved per call by
 * `resolveConfig`: capturing `dshHome()` at import would freeze the Harness home
 * of whichever process loaded the module, so a deployment that sets `$DSH_HOME`
 * — or a test that proves the plugin follows it — would silently get the
 * authoring machine's home instead. Everything else is a genuine constant.
 */
export const DEFAULT_CONFIG = {
  worktreeRoot: null,
  stateRoot: null,
  branchPrefix: 'dsh/',
  baseBranch: '',
  protectedBranches: ['main', 'master'],
  guardMode: 'redirect',
  // Both shell tools the Harness ships, not just the POSIX one: a guard that
  // covers `bash` and not `pwsh` is a guard with a documented way around it on
  // the platform where leaving it open matters most. An unknown name here is
  // harmless — the guard only inspects tools it is told about — but naming a tool
  // that does not exist advertises coverage that is not there.
  guardTools: ['bash', 'pwsh'],
  // Off by default, so enforcement is something a deployment chooses rather than
  // something an upgrade starts doing to the person who installed it.
  autoWorktree: 'off',
  turnCommit: true,
  turnCommitMessage: '',
  turnPush: true,
  turnCommitMaxFiles: 200,
  turnSyncScope: 'session',
  turnSyncTimeoutMs: 20000,
  githubHost: 'github.com',
  prDraft: false,
  timeoutMs: 30000,
};

/** The enum values each constrained field accepts. */
const ENUMS = {
  guardMode: ['off', 'warn', 'redirect'],
  autoWorktree: ['off', 'protected', 'always'],
  turnSyncScope: ['session', 'workspace'],
};

/**
 * Load schemastery from whichever root can see it.
 *
 * A `link:` install does not hoist a bundle's dependencies, so resolving from
 * this module is not enough on its own; the profile and the process directory
 * are probed too. Returns undefined rather than throwing, because a row with no
 * schema still works — every setting keeps its default.
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
      return 'Tool names the guard inspects. Defaults to both shell tools the Harness ships (bash and pwsh) — a guard covering only bash leaves the other as a way around it.';
    case 'autoWorktree':
      return 'Whether a file edit is refused when it lands outside a worktree. off: never refuse (the tool and the git guard still redirect). protected: refuse an edit to a repository on a protected branch, and point at action "start". always: refuse any edit to a repository this session has no worktree for.';
    case 'turnCommit':
      return 'Commit the paths a turn changed, at the end of that turn. This is what stops work being left uncommitted when a session forgets.';
    case 'turnCommitMessage':
      return 'Commit message for automatic turn commits. Empty generates "dsh: turn <N> — <changed paths>". `{turn}` and `{paths}` are substituted when present.';
    case 'turnPush':
      return 'Also push at the end of a turn, when the branch is safe to push (a task worktree, or a branch under the prefix) and is not protected. A commit that exists only on this disk is still unsynced work.';
    case 'turnSyncScope':
      return 'Which repositories the automatic turn commit may touch. session: only repositories this session actually changed, which is what keeps one session from committing another session\'s work in progress when several share a checkout. workspace: every dirty repository under the working directory.';
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
      // The schema's own defaults are resolved here rather than read from
      // DEFAULT_CONFIG, where those two fields are `null` by design. The
      // Resolving them here means a machine with a moved `$DSH_HOME` gets the
      // path this deployment actually uses, rather than a stale literal.
      worktreeRoot: z.string().default(join(dshHome(), 'worktrees')).description(describe('worktreeRoot')),
      stateRoot: z.string().default(join(dshHome(), 'state')).description(describe('stateRoot')),
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
      turnSyncScope: z.union([z.const('session'), z.const('workspace')]).default(DEFAULT_CONFIG.turnSyncScope).description(describe('turnSyncScope')),
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

  // Resolved now, not at import: the environment decides the Harness home, and
  // it is read at the moment a config is actually needed.
  const home = dshHome();
  for (const key of ['worktreeRoot', 'stateRoot']) {
    const value = text(input[key]);
    const fallback = join(home, key === 'worktreeRoot' ? 'worktrees' : 'state');
    config[key] = value === undefined ? fallback : expandHome(value);
    if (!isAbsolute(config[key])) config[key] = join(home, config[key]);
  }

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

  const turnSyncScope = oneOf('turnSyncScope', input.turnSyncScope);
  if (turnSyncScope !== undefined) config.turnSyncScope = turnSyncScope;

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
