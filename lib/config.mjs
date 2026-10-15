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
  // This plugin's own list of branch names, matched literally against the checked-out
  // branch. It is NOT GitHub or GitLab branch protection: that is a server-side rule
  // this plugin never asks about, so enabling it there changes nothing here — and a
  // trunk named `trunk`, `develop` or anything else is not protected until it is listed.
  //
  // Empty by default. A non-empty list drives two rules at once: automatic push never
  // pushes a listed branch, and autoWorktree refuses an edit landing in a repository
  // sitting on one. With the guard refusing raw `git push`, a protected `main` left a
  // task branch as the only pushable place -- which is what made worktrees mandatory
  // rather than optional. List a branch here when you want it protected.
  protectedBranches: [],
  guardMode: 'redirect',
  // What to do with a git command the guard cannot classify. The default asks,
  // because that decision belongs to whoever is watching — but a deployment with
  // nobody at the approval prompt wants `deny`, so an unclassifiable command
  // fails fast with a reason instead of holding the turn open until the tool
  // times out. `allow` accepts it, for a session that has its own reasons.
  guardAsk: 'ask',
  // Both shell tools the Harness ships, not just the POSIX one: a guard that
  // covers `bash` and not `pwsh` is a guard with a documented way around it on
  // the platform where leaving it open matters most. An unknown name here is
  // harmless — the guard only inspects tools it is told about — but naming a tool
  // that does not exist advertises coverage that is not there.
  guardTools: ['bash', 'pwsh'],
  // Off by default. Enforcement is available (`protected`, `always`) but never
  // imposed, because the guard already makes the tool the way work gets done
  // (`guardMode: redirect`). An edit is not the place to make that decision for you.
  // `protected` refuses an edit to a repository on a protected branch and points at
  // action "start"; `always` requires a worktree for any repository this session
  // changes. A branch with no commits yet is never protected.
  plainMode: false,
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
  guardAsk: ['ask', 'deny', 'allow'],
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
      return 'Directory holding per-task worktrees. Each task gets <worktreeRoot>/<repo>/<slug>. Empty — the default — resolves to <session workspace>/.worktrees: inside the session workspace, where a file sandbox permits writes, and outside every repository, so there is nothing to add to .gitignore and no second copy of the tree for editors and watchers to index.';
    case 'stateRoot':
      return 'Directory holding this plugin\'s per-session state (which worktrees a session owns, and which pushes are failing). Session state is the only thing written here; it never holds credentials.';
    case 'branchPrefix':
      return 'Prefix for the branch created for a task worktree. Branches under this prefix are the ones automatic push considers safe to push.';
    case 'baseBranch':
      return 'Branch a task worktree is cut from. Empty resolves origin/HEAD, falling back to main.';
    case 'protectedBranches':
      return 'This plugin\'s own list of branch names, matched literally against the checked-out branch — not GitHub or GitLab branch protection, which is a server-side rule this plugin never consults. One list drives two rules: automatic push never pushes one of these (a turn commit on one still commits, and reports the branch as unpushed instead), and autoWorktree refuses an edit landing in a repository sitting on one. A trunk named anything else — trunk, develop, production, or a renamed default branch — is not protected until the name is added here, and the match is exact. An explicit empty list protects nothing, which is how a push to main works without the per-call allowProtected flag; a list of blanks is treated as a mistake and falls back to the default.';
    case 'guardMode':
      return 'How to treat raw mutating git run through bash. off: no guard. warn: allow and classify. redirect: refuse a mutating command and deny the commands that discard work. A refused command names the git tool action that does it cleanly.';
    case 'guardAsk':
      return 'What to do with a git command the guard cannot classify. ask: leave it to a person, the default. deny: refuse it, for a deployment where nobody is at the approval prompt — a turn then fails fast with a reason instead of stalling until the tool times out. allow: accept it.';
    case 'guardTools':
      return 'Tool names the guard inspects. Defaults to both shell tools the Harness ships (bash and pwsh) — a guard covering only bash leaves the other as a way around it.';
    case 'plainMode':
      return 'A shorthand for the four settings it covers — autoWorktree, turnCommit, turnPush, protectedBranches — applied only where the caller has not already named a value. An explicit key beside this switch wins, so `plainMode: true` with `turnCommit: true` means "plain except for turn commits". The guard is not affected: raw git in bash is still refused and redirected at the tool, which is what keeps this plugin the way work gets done.';
    case 'autoWorktree':
      return 'Whether a file edit is refused when it lands outside a worktree. protected (the default): refuse an edit to a repository on a protected branch, and point at action "start". off: never refuse (the tool and the git guard still redirect). always: refuse any edit to a repository this session has no worktree for. A branch with no commits yet is never protected: `git init -b main` reports the name `main` before `main` exists, there is no history to keep clean, and no worktree can be cut from an unborn HEAD.';
    case 'turnCommit':
      return 'Commit the paths a turn changed: at the turn boundary when one arrives, and otherwise a few seconds after a turn\'s edits stop. This is what stops work being left uncommitted when a session forgets.';
    case 'turnCommitMessage':
      return 'Commit message for automatic turn commits. Empty generates "dsh: turn <N> — <changed paths>", or "dsh: <changed paths>" when the Host reported no turn number — which is what the boundary driven from the tools layer always does, having never had a number, so the message says nothing rather than claiming a turn that did not exist. `{turn}` and `{paths}` are substituted, and `{turn}` becomes empty when there is no number.';
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
 * Every setting, as a builder over the schema library.
 *
 * A table rather than one long `z.object({...})`, because of how a Configure page
 * fails. Declaring `Config` is what makes a row configurable — the Host serves its
 * settings namespace and the Web UI renders the page against it — and `volatile()`
 * on a field is what makes a saved value re-read instead of frozen at load. A field
 * *without* it is silent: the namespace is still served, the page still mounts, and
 * that one control is simply absent, with nothing reporting why. `buildConfig`
 * applies `volatile()` to every entry, so a field cannot be added without it, and
 * `test/config-schema.test.mjs` checks the table against `DEFAULT_CONFIG` so a
 * setting cannot be added without a schema field either.
 *
 * Field descriptions are the user-facing documentation for each setting, so they are
 * written for someone deciding a value, not for a maintainer, and they are the text
 * the page shows beside each control.
 */
const SCHEMA_FIELDS = {
  // `worktreeRoot` defaults to empty, which means "derive it from the session
  // workspace" (see `worktreeRootFor`). A literal path here would pin every
  // deployment to the authoring machine's layout, and would put worktrees where a
  // file sandbox does not allow writes. `stateRoot` is the Harness home's business,
  // so its default is still resolved at schema build time: a machine with a moved
  // `$DSH_HOME` then gets the path it actually uses rather than a stale literal.
  worktreeRoot: (z) => z.string().default('').description(describe('worktreeRoot')),
  stateRoot: (z) => z.string().default(join(dshHome(), 'state')).description(describe('stateRoot')),
  branchPrefix: (z) => z.string().default(DEFAULT_CONFIG.branchPrefix).description(describe('branchPrefix')),
  baseBranch: (z) => z.string().default(DEFAULT_CONFIG.baseBranch).description(describe('baseBranch')),
  protectedBranches: (z) => z.array(z.string()).default([...DEFAULT_CONFIG.protectedBranches]).description(describe('protectedBranches')),
  guardMode: (z) => z.union([z.const('off'), z.const('warn'), z.const('redirect')]).default(DEFAULT_CONFIG.guardMode).description(describe('guardMode')),
  guardAsk: (z) => z.union([z.const('ask'), z.const('deny'), z.const('allow')]).default(DEFAULT_CONFIG.guardAsk).description(describe('guardAsk')),
  guardTools: (z) => z.array(z.string()).default([...DEFAULT_CONFIG.guardTools]).description(describe('guardTools')),
  plainMode: (z) => z.boolean().default(DEFAULT_CONFIG.plainMode).description(describe('plainMode')),
  autoWorktree: (z) => z.union([z.const('off'), z.const('protected'), z.const('always')]).default(DEFAULT_CONFIG.autoWorktree).description(describe('autoWorktree')),
  turnCommit: (z) => z.boolean().default(DEFAULT_CONFIG.turnCommit).description(describe('turnCommit')),
  turnCommitMessage: (z) => z.string().default(DEFAULT_CONFIG.turnCommitMessage).description(describe('turnCommitMessage')),
  turnPush: (z) => z.boolean().default(DEFAULT_CONFIG.turnPush).description(describe('turnPush')),
  turnCommitMaxFiles: (z) => z.number().default(DEFAULT_CONFIG.turnCommitMaxFiles).description(describe('turnCommitMaxFiles')),
  turnSyncScope: (z) => z.union([z.const('session'), z.const('workspace')]).default(DEFAULT_CONFIG.turnSyncScope).description(describe('turnSyncScope')),
  turnSyncTimeoutMs: (z) => z.number().default(DEFAULT_CONFIG.turnSyncTimeoutMs).description(describe('turnSyncTimeoutMs')),
  githubHost: (z) => z.string().default(DEFAULT_CONFIG.githubHost).description(describe('githubHost')),
  prDraft: (z) => z.boolean().default(DEFAULT_CONFIG.prDraft).description(describe('prDraft')),
  timeoutMs: (z) => z.number().default(DEFAULT_CONFIG.timeoutMs).description(describe('timeoutMs')),
};

/** The settings keys, in the order the schema declares them. */
export const SETTINGS_KEYS = Object.freeze(Object.keys(SCHEMA_FIELDS));

/**
 * Build the Config export, or undefined when schemastery is unreachable.
 *
 * `volatile()` is applied here, to every field, rather than remembered per field —
 * see `SCHEMA_FIELDS` for the failure that prevents.
 */
export function buildConfig() {
  const z = loadSchema();
  if (z === undefined) return undefined;
  try {
    const shape = {};
    for (const key of SETTINGS_KEYS) shape[key] = SCHEMA_FIELDS[key](z).volatile();
    return z.object(shape);
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

/**
 * The protected-branch list, where an explicitly empty array means what it says.
 *
 * `strings()` treats an empty result as "nothing usable was given" and lets the caller
 * fall back to the default. That is right for a typo — `[""]` is a mistake — and wrong
 * for `[]`, which is a coherent request to protect nothing and the only way to make
 * `main` pushable through the tool without passing `allowProtected` on every call. So
 * the two are told apart: an array that is empty stays empty, and one whose entries are
 * all blank still falls back.
 */
function protectedBranchesFrom(value) {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const kept = value.map((entry) => text(entry)).filter((entry) => entry !== undefined);
  return kept.length > 0 ? kept : undefined;
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
/**
 * Where worktrees live for one session.
 *
 * An unset `worktreeRoot` resolves against the session's own workspace rather
 * than the Harness home. Worktrees are where edits have to happen, and a Harness
 * file sandbox writes only inside the session workspace — so the old default
 * under `$DSH_HOME` refused the edit and then pointed the agent at a directory it
 * was not allowed to write to.
 *
 * `<workspace>/.worktrees` keeps the other property the layout was chosen for:
 * outside every *repository*, so there is nothing to add to `.gitignore` and no
 * second copy of the tree for editors, watchers and test globs to match twice.
 *
 * @param {object} config - a resolved config; `worktreeRoot` may be null.
 * @param {string} reference - the session's reference directory.
 * @returns {string} the worktree root for this session.
 */
export function worktreeRootFor(config, reference) {
  const configured = text(config?.worktreeRoot);
  if (configured !== undefined) return configured;
  const base = text(reference);
  return join(base === undefined ? process.cwd() : base, '.worktrees');
}

export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULT_CONFIG, protectedBranches: [...DEFAULT_CONFIG.protectedBranches], guardTools: [...DEFAULT_CONFIG.guardTools] };

  // Resolved now, not at import: the environment decides the Harness home, and
  // it is read at the moment a config is actually needed.
  const home = dshHome();

  // `worktreeRoot` is deliberately left unset here instead of being resolved
  // against `$DSH_HOME`. Its default is derived from the session's own workspace
  // at the call site — see `worktreeRootFor` — because worktrees are where edits
  // happen and a Harness file sandbox writes only inside the session workspace.
  // Resolving it against the Harness home put every worktree outside the one
  // place an agent may write, so the worktree guard refused an edit and then
  // pointed at a directory that could not be written to.
  const worktreeRoot = text(input.worktreeRoot);
  config.worktreeRoot = worktreeRoot === undefined ? null : expandHome(worktreeRoot);
  if (config.worktreeRoot !== null && !isAbsolute(config.worktreeRoot)) {
    config.worktreeRoot = join(home, config.worktreeRoot);
  }

  // Session state really is the Harness home's business, so this one keeps it.
  const stateRoot = text(input.stateRoot);
  config.stateRoot = stateRoot === undefined ? join(home, 'state') : expandHome(stateRoot);
  if (!isAbsolute(config.stateRoot)) config.stateRoot = join(home, config.stateRoot);

  const branchPrefix = text(input.branchPrefix);
  if (branchPrefix !== undefined) config.branchPrefix = branchPrefix;

  const baseBranch = typeof input.baseBranch === 'string' ? input.baseBranch.trim() : undefined;
  if (baseBranch !== undefined) config.baseBranch = baseBranch;

  const protectedBranches = protectedBranchesFrom(input.protectedBranches);
  if (protectedBranches !== undefined) config.protectedBranches = protectedBranches;

  const guardMode = oneOf('guardMode', input.guardMode);
  if (guardMode !== undefined) config.guardMode = guardMode;

  const guardAsk = oneOf('guardAsk', input.guardAsk);
  if (guardAsk !== undefined) config.guardAsk = guardAsk;

  const guardTools = strings(input.guardTools);
  if (guardTools !== undefined) config.guardTools = guardTools;

  const autoWorktree = oneOf('autoWorktree', input.autoWorktree);
  if (autoWorktree !== undefined) config.autoWorktree = autoWorktree;

  for (const key of ['plainMode', 'turnCommit', 'turnPush', 'prDraft']) {
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

  // A named key always wins over this switch. `plainMode: true` is a shorthand for
  // the four settings below, applied only where the caller has not already said
  // otherwise — an explicit `turnCommit: true` beside `plainMode: true` means the
  // caller wants the tool plain except for turn commits, and that is a reasonable
  // thing to ask for. `guardMode` is deliberately left alone in every case: the
  // guard is what makes this plugin the path rather than an option.
  if (config.plainMode === true) {
    if (input.autoWorktree === undefined) config.autoWorktree = 'off';
    if (input.turnCommit === undefined) config.turnCommit = false;
    if (input.turnPush === undefined) config.turnPush = false;
    if (input.protectedBranches === undefined) config.protectedBranches = [];
  }

  return config;
}

/** Whether a branch is one automatic push must never push to. */
export function isProtectedBranch(config, branch) {
  const name = text(branch);
  if (name === undefined) return true;
  return config.protectedBranches.includes(name);
}

/**
 * Whether a branch is this plugin's own task branch, and so safe to push.
 *
 * The branch has to sit inside the namespace as a whole path segment: with the
 * default `dsh/`, `dsh/x` is a task branch and `dshx` is not; with a configured
 * `task`, `task/one` is and a user branch named `taskforce` is not. A plain
 * `startsWith` said yes to `taskforce` — and this function is the automatic push
 * decision, so a custom prefix with no slash had the plugin auto-pushing somebody
 * else's branch.
 *
 * `isInsideBranchPrefix` in `worktrees.mjs` is the same rule, and the sweep, the
 * merge retire and the named prune all use it. This module deliberately imports
 * nothing from the bundle — it is the bottom of the dependency graph, and a
 * config module reaching up into the worktree layer is how a load-order cycle
 * starts — so the check is repeated here rather than imported, and
 * `test/branch-prefix.test.mjs` drives both functions over the same names, which
 * is what keeps the two from drifting apart unnoticed.
 */
export function isTaskBranch(config, branch) {
  const name = text(branch);
  if (name === undefined) return false;
  const prefix = typeof config?.branchPrefix === 'string' ? config.branchPrefix.replace(/\/+$/u, '') : '';
  // An empty prefix is a namespace with nothing in it, not a wildcard: the old
  // `startsWith('')` answered true for every branch in the repository.
  if (prefix === '') return false;
  return name.startsWith(prefix + '/');
}

/** The protected-branch list as it appears in a message. */
export function protectedList(config) {
  return config.protectedBranches.join(', ');
}
