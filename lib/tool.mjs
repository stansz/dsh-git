/**
 * The `git` tool: the model-facing half of the bundle.
 *
 * One tool with fifteen actions rather than fifteen tools, for two reasons. A
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
 *     declared for the shape the model sees rather than as a contract — nothing
 *     in it is required and every object it declares is open — and
 *     test/result-envelope.test.mjs asserts that permissiveness, so a later edit
 *     cannot quietly turn it into a schema that rejects a real result.
 */

import { resolveConfig } from './config.mjs';
import { runAction } from './actions.mjs';
import { render } from './render.mjs';

/** The actions the tool exposes, in the order the description introduces them. */
export const ACTION_NAMES = ['clone', 'init', 'status', 'save', 'publish', 'sync', 'pr', 'merge', 'finish', 'prune'];

/** What each action is for, used in the description and the parameter enum. */
export const ACTION_SUMMARY = {
  clone: 'clone a repository from a URL. `path` is where it lands, `branch` checks out a branch at clone time. Returns the state of the clone.',
  init: 'create a new empty repository. `path` is where it lands, `branch` names the initial branch.',
  status: 'report the state of a repository, or of every repository under a directory: branch, ahead/behind, changed paths, worktrees, and any open pull request. Reads only.',
  save: 'commit the work this session did here. With no `paths`, it commits exactly the files this session changed in this repository and reports the rest, so nothing of another session\'s is swept in. `paths` names files explicitly, `message` overrides the generated subject.',
  publish: 'push the current branch, setting the upstream on the first push and refusing a protected branch unless `allowProtected` is true. `forceWithLease: true` replaces this branch\'s own remote ref after a rebase — git refuses it if the remote moved since the last fetch.',
  sync: 'fetch and bring the base in. With nothing else it fast-forwards when this branch has no commits of its own, and reports the divergence when it has. `rebase: true` replays this branch onto the base; `merge: true` merges the base in. A conflict aborts whichever ran, changes nothing, and names the paths.',
  pr: 'open a pull request, or return the one already open for this branch. Never opens a second one.',
  merge: 'merge the pull request by number, or the one open for the current branch, then remove the branch it came from and retire this session\'s worktree for it.',
  finish: 'the closing move for a unit of work: save anything dirty, publish, open or reuse the pull request, and report. `cleanup: true` removes the worktree afterwards, and only when the branch is on the remote and the worktree holds nothing uncommitted.',
  prune: 'dry-run then remove what this tool left behind: worktree registrations whose directory is gone, and task branches with no worktree and no commits of their own. `apply: true` removes; a branch holding work is reported, never deleted.',
};
const DESCRIPTION = [
  'Run a git operation consistently and leave the repository clean and pushed.',
  '',
  'This is the supported way to use git. Work in an isolated worktree per task with action "start", call "finish" when the task is done, and use "status" to see whether anything is left uncommitted or unpushed. Changes are also committed and pushed automatically once the edits of a turn stop, so this tool is for doing git deliberately rather than for rescuing work.',
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
    worktreesClosed: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: 'The task worktrees retired as part of the call, from action "merge". Each names its path, whether it was removed, and whether its branch went with it.',
    },
    worktreesKept: {
      type: 'array',
      items: { type: 'string' },
      description: 'Worktrees deliberately left in place because their branch holds a commit the merge did not cover. The branch is kept with them.',
    },
    mergedBranch: {
      type: 'string',
      description: 'The head branch of the pull request that was merged. This is the branch a merge may clean up, whatever branch the caller was standing on.',
    },
    remoteKept: {
      type: 'string',
      description: 'Why a remote ref was left alone: it points at a different commit than the one that was proved merged, or the remote could not be read.',
    },
    remoteAbsent: {
      type: 'boolean',
      description: 'The remote had no such ref — the state the caller wanted, reached without deleting anything.',
    },
    branchKept: {
      type: 'string',
      description: 'Why a local branch was left in place, usually because it holds a commit the merge did not cover.',
    },
    branches: { type: 'array', items: { type: 'object', additionalProperties: true } },
    pull: { type: 'object', additionalProperties: true },
    pullError: {
      type: 'object',
      additionalProperties: true,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      description: 'Why the pull request lookup that `pull: true` asks for failed. Absent when it succeeded, and absent when the remote is not a GitHub repository.',
    },
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
      description: 'The repository or any directory inside it. Absolute, or relative to the session working directory. Omit for the working directory, or to sweep every repository under it with action "status".',
    },
    url: {
      type: 'string',
      description: 'With clone, the repository URL to clone.',
    },
    path: {
      type: 'string',
      description: 'With clone or init, where the repository lands.',
    },
    branch: {
      type: 'string',
      description: 'With clone, the branch to check out; with init, the initial branch name.',
    },
    base: {
      type: 'string',
      description: 'The branch to compare against, and what action "sync" fast-forwards or replays onto. Defaults to origin/HEAD, then main. A branch name means its origin/<name> when that ref exists.',
    },
    remote: {
      type: 'string',
      description: 'Which remote to fetch, push or compare against. Defaults to `origin` — set it for a fork, where the branch publishes to `origin` and the base lives on `upstream`.',
    },
    rebase: {
      type: 'boolean',
      description: 'With sync, replay this branch onto the base when it has diverged. A conflict aborts the rebase, changes nothing, and names the paths.',
    },
    merge: {
      type: 'boolean',
      description: 'With sync, merge the base into this branch when it has diverged. A conflict aborts the merge, changes nothing, and names the paths.',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'With save, exactly which files to commit, relative to the repository. Omit it to commit the files this session changed here.',
    },
    message: {
      type: 'string',
      description: 'With save, the commit message. Defaults to a subject naming what the commit contains.',
    },
    allowProtected: {
      type: 'boolean',
      description: 'With publish, permit this one call on a protected branch. Deliberate acts only; automatic pushes never do this.',
    },
    forceWithLease: {
      type: 'boolean',
      description: 'With publish, pass --force-with-lease: replace this branch\'s own remote ref after a rebase. Git refuses if the remote moved since the last fetch. The only force the tool uses, and only when asked for.',
    },
    sweep: {
      type: 'boolean',
      description: 'With status, report every repository under the working directory rather than one.',
    },
    pull: {
      type: 'boolean',
      description: 'With status, also fetch the open pull request for the current branch.',
    },
    title: { type: 'string', description: 'Pull request title. Defaults to the newest commit subject.' },
    body: { type: 'string', description: 'Pull request body. Defaults to a summary naming the branch and base.' },
    draft: { type: 'boolean', description: 'Open the pull request as a draft.' },
    pr: { type: 'boolean', description: 'With finish, set false to save and publish without opening a pull request.' },
    cleanup: { type: 'boolean', description: 'With finish, remove the worktree afterwards. Refused when it still holds uncommitted or unpushed work.' },
    number: { type: 'integer', description: 'With merge, the pull request number.' },
    apply: { type: 'boolean', description: 'With prune, actually remove what the dry run listed. Without it nothing is deleted.' },
    branches: { type: 'array', items: { type: 'string' }, description: 'With prune, name leftover branches to remove.' },
    worktrees: { type: 'array', items: { type: 'string' }, description: 'With prune, name leftover worktrees to remove, by path or directory name.' },
    force: { type: 'boolean', description: 'With prune, override the ownership refusal for a named worktree. It never overrides the refusal for uncommitted changes.' },
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
