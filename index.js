/**
 * dsh-git — one consistent way to use git and GitHub from DSH.
 *
 * The problem this exists to solve was never a missing command. DSH had no git
 * tool at all, so every session reached git through `bash`, invented its own
 * incantation, and stopped wherever it happened to stop. The residue was dirty
 * working trees and unpushed commits that nothing reported, because nothing was
 * looking.
 *
 * So this bundle contributes four things, and the last two are the ones that
 * matter:
 *
 *   ctx.tools.register()            the `git` tool: status, start, commit,
 *                                   push, sync, pr, merge, finish
 *   ctx.commands.register()         /git, printing the same state to a human
 *   ctx.on('tools/pre-execute')     a guard that redirects raw mutating git
 *                                   in bash at the tool that does it cleanly,
 *                                   and refuses the commands that discard work
 *   ctx.on('tools/pre-execute')     worktree enforcement: with autoWorktree set,
 *                                   a file edit aimed at a protected branch is
 *                                   refused and pointed at action "start"
 *   ctx.on('agent/turn-stopping')   the automatic sync: at the end of every
 *                                   turn that changed files, commit them and
 *                                   push whatever is safe to push
 *
 * The third and fourth are deliberately not opt-in behaviours an agent has to
 * remember. An operation that must be remembered is the original bug.
 *
 * Every dependency is a `node:` builtin except `@deepseek-ai/schemastery`, which
 * is loaded defensively because a `link:` install does not hoist a bundle's
 * dependencies and a static import would take the plugin down at activation.
 */

import { createGitTool, sessionDirectory } from './lib/tool.mjs';
import { buildConfig, resolveConfig, DEFAULT_CONFIG } from './lib/config.mjs';
import { runAction } from './lib/actions.mjs';
import { evaluate } from './lib/guard.mjs';
import { render, summarize } from './lib/render.mjs';
import { registerTurnSync } from './lib/turn-commit.mjs';
import { registerSessionFiles } from './lib/session-files.mjs';
import { registerWorktreeGuard } from './lib/worktree-guard.mjs';
import { toplevel } from './lib/git.mjs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'git';

/** The services this plugin contributes to. */
export const inject = ['tools', 'commands'];

/** Settings surfaced on Plugins → DSH Git → Configure. */
export const Config = buildConfig();

/** The command-line tokens `/git` understands, mapped to the tool's arguments. */
const COMMAND_ACTIONS = new Set(['status', 'start', 'commit', 'push', 'sync', 'pr', 'merge', 'finish', 'prune']);

/**
 * Turn `/git <tokens>` into tool arguments.
 *
 * Deliberately small: the command is a way to see state, not a second tool
 * surface that can drift from the first. Anything it does not recognise is
 * treated as a repository path, which is the useful reading of a bare argument.
 */
export function parseCommandInput(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '');
  const args = { action: 'status' };
  for (const token of tokens) {
    if (COMMAND_ACTIONS.has(token)) {
      args.action = token;
      continue;
    }
    if (token === 'sweep' || token === '--sweep') {
      args.sweep = true;
      continue;
    }
    if (token === 'pull' || token === '--pull') {
      args.pull = true;
      continue;
    }
    if (args.repo === undefined) args.repo = token;
  }
  return args;
}

/**
 * Register everything this bundle contributes.
 *
 * Each registration is an effect owned by this context, so unloading the row
 * removes the tool, the command, the guard and the turn listener together — a
 * half-unloaded plugin would keep committing in the background, which is worse
 * than either state.
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register(createGitTool(ctx, config)), 'git tool registration');

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'git',
        description: 'Show the git state: branch, ahead/behind, changed paths, worktrees, and the open pull request. `/git sweep` covers every repository under the working directory.',
        input: { hint: '[status|sweep] [path]' },
        handler: async (invocation) => {
          try {
            const args = parseCommandInput(invocation?.rawInput);
            const value = await runAction(args.action, args, {
              config: resolveConfig(config),
              reference: commandDirectory(ctx, invocation),
              sessionId: String(invocation?.agent?.id ?? 'unknown'),
              signal: invocation?.signal,
            });
            const headline = summarize(value);
            return {
              kind: value.ok === true ? 'success' : 'error',
              text: args.action === 'status' && value.ok === true ? render(value) : headline + '\n\n' + render(value),
            };
          } catch (error) {
            return { kind: 'error', text: 'git: ' + String(error?.message ?? error) };
          }
        },
      }),
    'git command registration',
  );

  // Enforcement first, then the recorder. Order matters and this is the reason:
  // the recorder decides which repositories the turn end may commit, so a path
  // that was refused must not have been recorded — otherwise the turn sync would
  // commit a repository the session never actually changed.
  registerWorktreeGuard(ctx, resolveConfig(config), { cwdOf: (agent) => sessionCwd(ctx, agent) });
  registerGuard(ctx, config);
  registerTurnSync(ctx, config);

  // Record which files this session changes, so the turn-end commit knows which
  // repositories are its own. Without this the turn end has to guess, and the
  // only guess available — every dirty repository under the working directory —
  // commits a teammate session's work in progress under this session's turn
  // number once several sessions share a checkout.
  registerSessionFiles(ctx, resolveConfig(config), async (path, { agent }) => {
    const cwd = (() => {
      try {
        const session = ctx.get?.('sessions')?.get?.(agent?.id);
        const value = session?.cwd ?? session?.meta?.cwd;
        if (typeof value === 'string' && value !== '') return value;
      } catch {
        /* fall through */
      }
      return process.cwd();
    })();
    const absolute = isAbsolute(path) ? path : resolvePath(cwd, path);
    const repoRoot = await toplevel(absolute);
    if (repoRoot === undefined) return undefined;
    return { repoRoot, path: absolute };
  });
}

/** The working directory of one agent's session, else the process directory. */
function sessionCwd(ctx, agent) {
  try {
    const session = ctx.get?.('sessions')?.get?.(agent?.id);
    const cwd = session?.cwd ?? session?.meta?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    /* fall through */
  }
  return process.cwd();
}

/** The directory a composer invocation is about: the agent's session, else the process. */
function commandDirectory(ctx, invocation) {
  try {
    const session = ctx.get?.('sessions')?.get?.(invocation?.agent?.id);
    const cwd = session?.cwd ?? session?.meta?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    /* fall through */
  }
  return process.cwd();
}

/**
 * The guard.
 *
 * A `tools/pre-execute` listener rather than `ctx.tools.guard()`, and that is
 * forced rather than stylistic: a guard is synchronous and can only deny, while
 * this decision has to be able to ask the user and to explain which action to
 * use instead. Asking is also what makes the guard tolerable — a hard denial on
 * every `git commit` is a guard users switch off, and a switch-off guard protects
 * nothing.
 *
 * The classification itself lives in `lib/guard.mjs` as a pure function, because
 * a decision that cannot be tested apart from the Host is a decision nobody
 * tests. Everything here is the Host wiring around it.
 */
function registerGuard(ctx, config) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const resolved = resolveConfig(config);
    if (resolved.guardMode === 'off') return next();

    let decision;
    try {
      decision = evaluate(exec, resolved);
    } catch {
      // A guard that throws must not break every tool call: fall through to the
      // normal path and let the tool itself decide.
      return next();
    }

    if (decision.kind === 'allow') return next();
    if (decision.kind === 'deny') {
      return { kind: 'deny', reason: decision.reason, info: { name: 'dsh-git-guard', code: 'raw-git-blocked' } };
    }
    return { kind: 'ask', reason: decision.reason, displayReason: { en: decision.displayReason } };
  });
}

/** Exported for the self-check, which asserts the defaults the plugin ships with. */
export { DEFAULT_CONFIG };
