/**
 * The `git` tool: the model-facing half of the bundle.
 *
 * One tool with eight actions rather than eight tools, for two reasons. A
 * catalog entry costs a schema in every request, and these eight share almost
 * all of theirs — repository, base, and remote are the same three arguments in
 * every action that takes arguments. And an agent looking for "how do I get this
 * work onto GitHub" finds one entry that lists finish, pr and push together,
 * instead of guessing which of eight near-identical names to open.
 *
 * Two properties of the definition are load-bearing:
 *
 *   - `isConcurrencySafe` is false. Two agents must never mutate one repository
 *     or one worktree at the same time, and the scheduler is the only place that
 *     can be enforced. Read-only status is the one case where the cost is real,
 *     and it is worth paying: a status that races a commit reports a state that
 *     never existed.
 *
 *   - The output schema is permissive on purpose. A strict schema that rejects a
 *     real result turns a working operation into a failure the model cannot read,
 *     which is how a session ends up back in raw git. The schema is therefore
 *     declared for the shape the model sees, and the self-check asserts it
 *     against real results rather than the other way round.
 */

import { resolveConfig } from './config.mjs';
import { runAction } from './actions.mjs';
import { render } from './render.mjs';

/** The actions the tool exposes, in the order the description introduces them. */
export const ACTION_NAMES = ['status', 'start', 'commit', 'push', 'sync', 'pr', 'merge', 'finish', 'prune'];

/** What each action is for, used in the description and the parameter enum. */
export const ACTION_SUMMARY = {
  status: 'report the state of a repository, or of every repository under a directory: branch, ahead/behind, changed paths, worktrees, and any open pull request. Reads only.',
  start: 'create the worktree for this task (branch <prefix><slug>, cut from origin/<base>) and return its path. Reusing the one this session already owns. Work in the returned path.',
  commit: 'stage the named paths and commit them. With no paths, stage everything. `push: true` pushes in the same call.',
  push: 'push the current branch. Refuses a protected branch unless `allowProtected` is true.',
  sync: 'fetch origin, then fast-forward only: the branch onto its base when the branch is behind and has no commits of its own, or the base branch itself. Never merges or rebases.',
  pr: 'open a pull request, or return the one already open for this branch. Never opens a second one.',
  merge: 'merge a pull request by number, or the one open for the current branch, then delete the remote branch.',
  finish: 'the closing move for a unit of work: commit anything dirty, push, open or reuse the pull request, and report. `cleanup: true` removes the worktree afterwards, and only when it holds nothing unmerged.',
  prune: 'dry-run then remove what this tool left behind: worktree registrations whose directory is gone, and task branches with no worktree and no commits of their own. A branch holding work is reported, never deleted. Pass `apply: true` to remove. With no repo it sweeps every repository under the working directory. Name branches with `branches` to remove one whose merge cannot be proven (a squash merge, or a remote that is gone).',
};

const DESCRIPTION = [
  'Run a git operation consistently and leave the repository clean and pushed.',
  '',
  'This is the supported way to use git. Work in an isolated worktree per task with action "start", call "finish" when the task is done, and use "status" to see whether anything is left uncommitted or unpushed. Changes are also committed and pushed automatically at the end of each turn that changes files, so this tool is for doing git deliberately rather than for rescuing work.',
  '',
  ...ACTION_NAMES.map((name) => '- ' + name + ': ' + ACTION_SUMMARY[name]),
].join('\n');

/**
 * The outcome shapes, as one permissive object.
 *
 * Every field is optional and additional properties are allowed: the value here
 * is documentation for the model and a floor under the renderer, not a contract
 * that can turn a real result into an error.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    action: { type: 'string', description: 'Which action produced this result.' },
    ok: { type: 'boolean', description: 'False when nothing was done; the error field says why.' },
    error: {
      type: 'object',
      additionalProperties: true,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        hint: { type: 'string', description: 'The next thing to try.' },
      },
    },
    path: { type: 'string', description: 'The directory this result is about.' },
    worktree: { type: 'string', description: 'The worktree path to work in, from action "start".' },
    branch: { type: 'string' },
    base: { type: 'string' },
    slug: { type: 'string' },
    reused: { type: 'boolean', description: 'True when an existing worktree was returned rather than created.' },
    committed: { type: 'boolean' },
    sha: { type: 'string' },
    subject: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' }, description: 'The paths the commit contains.' },
    pushed: { type: 'boolean' },
    remote: { type: 'string' },
    setUpstream: { type: 'boolean' },
    fastForwarded: { type: 'boolean' },
    from: { type: 'string' },
    to: { type: 'string' },
    detail: { type: 'string' },
    base: { type: 'string' },
    created: { type: 'boolean' },
    number: { type: 'integer' },
    url: { type: 'string' },
    state: { type: 'string' },
    draft: { type: 'boolean' },
    title: { type: 'string' },
    merged: { type: 'boolean' },
    mergedBranches: { type: 'array', items: { type: 'object', additionalProperties: true } },
    method: { type: 'string' },
    remoteBranchDeleted: { type: 'boolean' },
    worktreeRemoved: { type: 'boolean' },
    worktreeKept: { type: 'boolean', description: 'True when a worktree still held work that is not merged, so it was left in place.' },
    prSkipped: { type: 'string', description: 'Why no pull request was opened.' },
    applied: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } },
    repo: { type: 'object', additionalProperties: true, description: 'One repository\'s state, from action "status".' },
    repos: { type: 'array', items: { type: 'object', additionalProperties: true } },
    worktrees: { type: 'array', items: { type: 'object', additionalProperties: true } },
    branches: { type: 'array', items: { type: 'object', additionalProperties: true } },
    pull: { type: 'object', additionalProperties: true },
    pushFailure: {
      type: 'object',
      additionalProperties: true,
      properties: {
        error: { type: 'string' },
        attempts: { type: 'integer' },
        nextAttemptAt: { type: 'string' },
      },
    },
  },
};

/** The tool parameters, shared by the definition and the command's help text. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ACTION_NAMES,
      description: ACTION_NAMES.map((name) => name + ': ' + ACTION_SUMMARY[name]).join('\n'),
    },
    repo: {
      type: 'string',
      description: 'The repository or any directory inside it. An absolute path, or one relative to the session working directory. Omit to use the working directory, or to sweep every repository under it.',
    },
    slug: {
      type: 'string',
      description: 'Short name for this task, used for the worktree directory and the branch. Defaults to "task".',
    },
    task: {
      type: 'string',
      description: 'A description of the task, slugified when slug is not given.',
    },
    base: {
      type: 'string',
      description: 'The branch to cut from or compare against. Defaults to origin/HEAD, then main.',
    },
    message: {
      type: 'string',
      description: 'Commit message. A subject line is enough; a configured template applies to automatic commits instead.',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exactly which paths to stage and commit, relative to the repository. Naming them keeps other sessions\' uncommitted work out of the commit.',
    },
    all: {
      type: 'boolean',
      description: 'Stage every change, not only the named paths. Defaults to true only when paths is omitted.',
    },
    allowProtected: {
      type: 'boolean',
      description: 'Permit this one call on a protected branch. Deliberate acts only; automatic pushes never do this.',
    },
    sweep: {
      type: 'boolean',
      description: 'With status, report every repository under the working directory rather than one.',
    },
    apply: {
      type: 'boolean',
      description: 'With prune, actually remove what the dry run listed. Without it nothing is deleted.',
    },
    branches: {
      type: 'array',
      items: { type: 'string' },
      description: 'With prune, name the leftover branches to remove. Use it for a branch that cannot be proven disposable: a squash merge leaves commits the base never received, and a repository whose remote is gone cannot say whether its pull request was merged. Only a name under the configured branch prefix is accepted, a branch a worktree has checked out is refused, and nothing is removed without apply: true.',
    },
    pull: {
      type: 'boolean',
      description: 'With status, also fetch the open pull request for the current branch.',
    },
    title: { type: 'string', description: 'Pull request title. Defaults to the newest commit subject.' },
    body: { type: 'string', description: 'Pull request body. Defaults to a summary naming the branch and base.' },
    draft: { type: 'boolean', description: 'Open the pull request as a draft. Defaults to the prDraft setting.' },
    pr: { type: 'boolean', description: 'With finish, set false to commit and push without opening a pull request.' },
    cleanup: {
      type: 'boolean',
      description: 'With finish, remove the worktree afterwards. Refused when the worktree still holds uncommitted or unmerged work.',
    },
    number: { type: 'integer', description: 'With merge, the pull request number to merge.' },
    method: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'With merge, how to merge. Defaults to squash.' },
  },
  required: ['action'],
};

/**
 * The session's working directory.
 *
 * A turn's repository is relative to where the session works, not to wherever
 * the Host process happens to have been started. The process directory is the
 * fallback, and in this deployment the two differ, so it is a real fallback and
 * not a formality.
 */
export function sessionDirectory(ctx, exec) {
  try {
    const sessions = ctx.get?.('sessions');
    const agent = exec?.agent;
    const session = sessions?.get?.(agent?.id);
    const cwd = session?.header?.cwd ?? session?.cwd ?? session?.meta?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    /* fall through */
  }
  return process.cwd();
}

/** Build the tool definition, bound to this row's raw config. */
export function createGitTool(ctx, rowConfig) {
  return {
    name: 'git',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: render(value) }],
    },
    async execute(args, exec) {
      const config = resolveConfig(rowConfig);
      return runAction(String(args?.action ?? ''), args, {
        config,
        reference: sessionDirectory(ctx, exec),
        sessionId: String(exec?.agent?.id ?? 'unknown'),
        signal: exec?.signal,
      });
    },
    presentCall(args) {
      const action = String(args?.action ?? 'git');
      const which = typeof args?.repo === 'string' && args.repo !== '' ? args.repo : undefined;
      return {
        card: 'generic',
        title: 'git ' + action + (which !== undefined ? ': ' + which : ''),
        kind: action === 'status' ? 'read' : 'execute',
        rawInput: args,
      };
    },
    // Exclusive on purpose: two agents must never mutate one repository or one
    // worktree at the same time, and this is the only place that can enforce it.
    isConcurrencySafe() {
      return false;
    },
    timeoutMs: 180000,
  };
}
