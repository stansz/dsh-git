/**
 * Text rendering for every git-tool result.
 *
 * One function serves both callers — the `git` agent tool and the `/git`
 * command — so the two can never disagree about what a repository looks like.
 * The agent reads this text; the composer shows it. A second formatter would
 * eventually tell the two different stories about the same repository.
 *
 * Two rules shape the output, and both come from the failure this plugin
 * exists to prevent:
 *
 *   1. The first line is the state that matters — dirty, unpushed, or clean —
 *      not the command that ran. A model that has to read to the end to find
 *      out whether work is at risk will act on the wrong line.
 *   2. Anything the model must do next is printed as an exact value to use:
 *      a worktree path, a branch, a pull-request URL. Prose that describes a
 *      path gets retyped wrongly; a path on its own line gets copied.
 *
 * Output is bounded. A repository with four hundred changed files must not
 * push the state that provokes action out of the visible window.
 */

/** How many changed paths a state block lists before summarising the rest. */
const MAX_PATHS = 25;

/** How many worktrees a state block lists before summarising the rest. */
const MAX_WORKTREES = 12;

/** Paths listed in a commit subject, where the subject must stay one line. */
const MAX_SUBJECT_PATHS = 3;

/**
 * Which line a reader should act on, given a repo's state.
 *
 * Ordered by severity: work that exists only on this disk outranks work that is
 * merely uncommitted, because a lost disk loses both while an unpushed commit
 * survives a force-push and a pruned worktree.
 */
export function verdictFor(repo) {
  if (repo === undefined || repo === null) return 'unknown';
  if (repo.error !== undefined) return 'error';
  if (repo.dirty === true) return 'dirty';
  if (typeof repo.ahead === 'number' && repo.ahead > 0) return 'unpushed';
  if (typeof repo.behind === 'number' && repo.behind > 0) return 'behind';
  if (repo.detached === true) return 'detached';
  return 'clean';
}

/** The one-word marker a reader scans for. */
const VERDICT_LABEL = {
  clean: 'OK',
  dirty: 'DIRTY',
  unpushed: 'UNPUSHED',
  behind: 'BEHIND',
  detached: 'DETACHED',
  error: 'FAIL',
  unknown: 'UNKNOWN',
};

/** Which verdicts deserve a reader's attention. */
const NEEDS_ACTION = new Set(['dirty', 'unpushed', 'error', 'detached']);

/** `origin/dsh/thing` and `dsh/thing` are the same branch to a reader. */
function shortBranch(value) {
  if (typeof value !== 'string') return undefined;
  return value.replace(/^refs\/heads\//u, '').replace(/^refs\/remotes\//u, '');
}

/** A sync summary that reads the same whether or not there is an upstream. */
function syncText(repo) {
  const parts = [];
  if (typeof repo.ahead === 'number' && repo.ahead > 0) parts.push(repo.ahead + ' ahead');
  if (typeof repo.behind === 'number' && repo.behind > 0) parts.push(repo.behind + ' behind');
  if (parts.length === 0) {
    return repo.upstream === undefined ? 'no upstream' : 'in sync with ' + shortBranch(repo.upstream);
  }
  const of = repo.upstream !== undefined ? ' ' + shortBranch(repo.upstream) : repo.base !== undefined ? ' ' + shortBranch(repo.base) : '';
  return parts.join(', ') + of;
}

/** One repository's state as a block a reader can act on. */
export function renderRepo(repo, indent = '') {
  const lines = [];
  const label = VERDICT_LABEL[verdictFor(repo)] ?? 'UNKNOWN';
  const branch = shortBranch(repo.branch) ?? (repo.detached === true ? 'detached HEAD' : 'no branch');
  lines.push(indent + label + '  ' + branch + ' — ' + syncText(repo));
  if (repo.repoRoot !== undefined) lines.push(indent + '  at ' + repo.path);
  if (repo.dirty === true) {
    const changed = repo.changed ?? [];
    lines.push(indent + '  ' + String(repo.changeCount ?? changed.length) + ' changed path(s):');
    for (const path of changed.slice(0, MAX_PATHS)) lines.push(indent + '    ' + path);
    if (changed.length > MAX_PATHS) lines.push(indent + '    … ' + String(changed.length - MAX_PATHS) + ' more');
  }
  if (repo.rebaseInProgress === true) lines.push(indent + '  rebase in progress — automatic commit is paused');
  if (repo.mergeInProgress === true) lines.push(indent + '  merge in progress — automatic commit is paused');
  if (repo.cherryPickInProgress === true) lines.push(indent + '  cherry-pick in progress — automatic commit is paused');
  if (repo.lastCommit !== undefined) lines.push(indent + '  last commit ' + repo.lastCommit);
  if (repo.error !== undefined) lines.push(indent + '  ' + repo.error);
  return lines.join('\n');
}

/** One worktree as a line, with the marker that says whether it is ours. */
export function renderWorktree(tree, indent = '  ') {
  const where = tree.path;
  const branch = shortBranch(tree.branch) ?? (tree.detached === true ? 'detached' : '—');
  const marks = [];
  if (tree.owned === true) marks.push('ours');
  if (tree.locked === true) marks.push('locked');
  if (tree.prunable === true) marks.push('prunable');
  if (tree.dirty === true) marks.push('dirty');
  const suffix = marks.length > 0 ? '  [' + marks.join(', ') + ']' : '';
  return indent + where + '  ' + branch + suffix;
}

/** A pull request as the three facts a reader needs. */
export function renderPull(pull) {
  if (pull === undefined || pull === null) return undefined;
  const bits = ['#' + String(pull.number)];
  if (pull.state !== undefined) bits.push(String(pull.state));
  if (pull.draft === true) bits.push('draft');
  if (pull.mergeable !== undefined) bits.push(String(pull.mergeable));
  if (pull.url !== undefined) bits.push(String(pull.url));
  return bits.join('  ');
}

/**
 * The whole result, as text.
 *
 * The action determines which parts exist, so this reads the result rather than
 * re-deriving it: an operation that did not happen must not be described.
 */
export function render(value) {
  if (value === undefined || value === null) return 'dsh-git: no result';
  const lines = [];

  if (value.ok !== true) {
    lines.push('FAIL  ' + String(value.action) + (value.error?.code !== undefined ? ' (' + String(value.error.code) + ')' : ''));
    if (value.error?.message !== undefined) lines.push('  ' + String(value.error.message));
    if (value.error?.hint !== undefined) lines.push('  next: ' + String(value.error.hint));
    return lines.join('\n');
  }

  switch (value.action) {
    case 'status':
      lines.push(...renderStatus(value));
      break;
    case 'start':
      lines.push(...renderStart(value));
      break;
    case 'commit':
      lines.push(...renderCommit(value));
      break;
    case 'push':
      lines.push(...renderPush(value));
      break;
    case 'sync':
      lines.push(...renderSync(value));
      break;
    case 'pr':
      lines.push(...renderPr(value));
      break;
    case 'merge':
      lines.push(...renderMerge(value));
      break;
    case 'finish':
      lines.push(...renderFinish(value));
      break;
    case 'prune':
      lines.push(...renderPrune(value));
      break;
    default:
      lines.push('OK  ' + String(value.action));
      break;
  }

  if (value.notes !== undefined && value.notes.length > 0) {
    for (const note of value.notes) lines.push('note: ' + String(note));
  }
  return lines.join('\n');
}

function renderStatus(value) {
  const lines = [];
  if (value.repo !== undefined) {
    lines.push(renderRepo(value.repo, ''));
  } else if (value.repos !== undefined) {
    if (value.repos.length === 0) {
      lines.push('OK  no git repository here');
    } else {
      for (const repo of value.repos.slice(0, MAX_PATHS)) lines.push(renderRepo(repo, ''));
    }
  }
  if (value.worktrees !== undefined && value.worktrees.length > 0) {
    lines.push('worktrees:');
    for (const tree of value.worktrees.slice(0, MAX_WORKTREES)) lines.push(renderWorktree(tree));
    if (value.worktrees.length > MAX_WORKTREES) {
      lines.push('  … ' + String(value.worktrees.length - MAX_WORKTREES) + ' more');
    }
  }
  if (value.pull !== undefined) {
    const pull = renderPull(value.pull);
    if (pull !== undefined) lines.push('pull request: ' + pull);
  }
  if (value.pushFailure !== undefined) {
    lines.push('auto-push failing: ' + String(value.pushFailure.error ?? 'unknown') + ' (attempt ' + String(value.pushFailure.attempts ?? 1) + ')');
  }
  return lines;
}

function renderStart(value) {
  const lines = [];
  lines.push('OK  ' + (value.reused === true ? 'reusing worktree' : 'worktree ready'));
  if (value.worktree !== undefined) lines.push('  path: ' + String(value.worktree));
  lines.push('  branch: ' + String(value.branch ?? '—') + (value.base !== undefined ? '  from ' + String(value.base) : ''));
  lines.push('');
  lines.push('Work in ' + String(value.worktree) + ' from now on:');
  lines.push('  - pass workdir: "' + String(value.worktree) + '" to bash');
  lines.push('  - paths for read/write/edit are under that directory');
  lines.push('  - the main checkout is untouched until you open a pull request');
  return lines;
}

function renderCommit(value) {
  const lines = [];
  if (value.committed !== true) {
    lines.push('OK  nothing to commit' + (value.branch !== undefined ? ' on ' + shortBranch(value.branch) : ''));
    return lines;
  }
  lines.push('OK  committed ' + String(value.sha ?? '').slice(0, 9) + ' on ' + String(shortBranch(value.branch) ?? '—'));
  if (value.subject !== undefined) lines.push('  ' + String(value.subject));
  if (value.paths !== undefined && value.paths.length > 0) {
    lines.push('  ' + String(value.paths.length) + ' path(s):');
    for (const path of value.paths.slice(0, MAX_PATHS)) lines.push('    ' + path);
    if (value.paths.length > MAX_PATHS) lines.push('    … ' + String(value.paths.length - MAX_PATHS) + ' more');
  }
  return lines;
}

function renderPush(value) {
  const lines = [];
  if (value.pushed !== true) {
    lines.push('OK  nothing to push' + (value.branch !== undefined ? ' on ' + shortBranch(value.branch) : ''));
    return lines;
  }
  lines.push('OK  pushed ' + String(shortBranch(value.branch) ?? '—') + ' to ' + String(value.remote ?? 'origin'));
  if (value.setUpstream === true) lines.push('  upstream set for this branch');
  return lines;
}

function renderSync(value) {
  const lines = [];
  lines.push('OK  synced' + (value.base !== undefined ? ' with ' + shortBranch(value.base) : ''));
  if (value.fastForwarded === true) lines.push('  fast-forwarded ' + String(value.from ?? '') + ' -> ' + String(value.to ?? ''));
  else lines.push('  ' + String(value.detail ?? 'already up to date'));
  return lines;
}

function renderPr(value) {
  const lines = [];
  const pull = renderPull({
    number: value.number,
    state: value.state,
    draft: value.draft,
    mergeable: value.mergeable,
    url: value.url,
  });
  lines.push('OK  ' + (value.created === true ? 'opened pull request' : 'pull request already open'));
  if (pull !== undefined) lines.push('  ' + pull);
  if (value.title !== undefined) lines.push('  ' + String(value.title));
  return lines;
}

function renderMerge(value) {
  const lines = [];
  if (value.merged !== true) {
    lines.push('OK  already merged or closed');
    if (value.url !== undefined) lines.push('  ' + String(value.url));
    return lines;
  }
  lines.push('OK  merged #' + String(value.number ?? '') + ' (' + String(value.method ?? 'squash') + ')');
  if (value.sha !== undefined) lines.push('  merge commit ' + String(value.sha).slice(0, 9));
  if (value.remoteBranchDeleted === true) lines.push('  remote branch deleted');
  if (value.worktreeRemoved === true) lines.push('  worktree removed');
  if (value.worktreeKept === true) lines.push('  worktree kept — it still held work that was not merged');
  return lines;
}

function renderFinish(value) {
  const lines = [];
  lines.push('OK  finish');
  if (value.committed === true) lines.push('  committed ' + String(value.sha ?? '').slice(0, 9) + ' — ' + String(value.subject ?? ''));
  else lines.push('  nothing to commit');
  if (value.pushed === true) lines.push('  pushed ' + String(shortBranch(value.branch) ?? '—') + ' to ' + String(value.remote ?? 'origin'));
  else lines.push('  nothing to push');
  if (value.pull !== undefined) {
    const pull = renderPull(value.pull);
    if (pull !== undefined) lines.push('  pull request: ' + pull);
  } else if (value.prSkipped !== undefined) {
    lines.push('  no pull request: ' + String(value.prSkipped));
  }
  if (value.worktreeRemoved === true) lines.push('  worktree removed');
  if (value.worktreeKept === true) lines.push('  worktree kept — work in it is not merged yet');
  return lines;
}

/** What a prune found, or removed. */
function renderPrune(value) {
  const lines = [];
  lines.push('OK  prune ' + (value.applied === true ? 'applied' : '(dry run)'));
  const trees = value.worktrees ?? [];
  const branches = value.branches ?? [];
  if (trees.length === 0 && branches.length === 0) {
    lines.push('  nothing left behind');
    return lines;
  }
  for (const entry of trees) lines.push('  worktree ' + String(entry.path) + '  — ' + String(entry.reason ?? ''));
  for (const entry of branches) {
    lines.push('  branch ' + String(entry.branch) + '  — ' + String(entry.reason ?? ''));
  }
  if (value.applied !== true) lines.push('  pass apply: true to remove the entries above');
  return lines;
}

/** One line for a command result, for the composer's `/git` command. */
export function summarize(value) {
  if (value === undefined || value === null) return 'no result';
  if (value.ok !== true) return String(value.action) + ' failed: ' + String(value.error?.message ?? 'unknown error');
  if (value.action === 'status') {
    if (value.repo !== undefined) return verdictFor(value.repo);
    if (value.repos !== undefined) {
      const bad = value.repos.filter((repo) => NEEDS_ACTION.has(verdictFor(repo))).length;
      return String(value.repos.length) + ' repo(s), ' + String(bad) + ' needing action';
    }
  }
  return String(value.action) + ' ok';
}

/**
 * The commit subject for an automatic turn commit.
 *
 * The paths are the point: a reader of `git log` sees which turn touched what
 * without opening the commit. Kept to one line so `--oneline` stays a summary.
 */
export function turnSubject(turn, paths) {
  const names = (paths ?? []).map((path) => basenameOf(path));
  const shown = names.slice(0, MAX_SUBJECT_PATHS).join(', ');
  const more = names.length > MAX_SUBJECT_PATHS ? ' +' + String(names.length - MAX_SUBJECT_PATHS) : '';
  return 'dsh: turn ' + String(turn) + (shown === '' ? '' : ' — ' + shown + more);
}

/** The last segment of a path, on either separator. */
function basenameOf(path) {
  const text = String(path);
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut === -1 ? text : text.slice(cut + 1);
}
