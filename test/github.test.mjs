/**
 * The GitHub flows, against a local stand-in for the REST API.
 *
 * The stand-in does not return canned JSON for a merge. It merges the real head
 * branch into the real base branch of the bare origin that git itself is pushing
 * to, so after a merge the assertions can ask git — not the fake — whether the
 * work landed. What is faked is the network, not the workflow.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  action,
  branches,
  commitAll,
  config,
  currentBranch,
  fakeGh,
  fixture,
  githubFixture,
  githubServer,
  git,
  gitOk,
  pathWith,
  sessionId,
  shaOf,
  tempDir,
  writeFiles,
  cleanupTemps,
} from './support.mjs';

after(cleanupTemps);

/**
 * A GitHub fixture plus the API stand-in, wired to one session.
 *
 * t.after restores globalThis.fetch, so a test that leaves the fetch monkey
 * patched cannot affect the next one.
 */
function githubTest(t, options = {}) {
  const fx = githubFixture(options);
  const server = githubServer({
    repos: [{ owner: fx.owner, repo: fx.repo, dir: fx.bare, host: fx.host }],
    token: options.serverToken,
    login: options.login,
  });
  t.after(() => server.restore());
  const cfg = { ...config(), githubHost: fx.host, ...(options.config ?? {}) };
  const sid = sessionId();
  const run = (name, args = {}) => action(name, { repo: fx.work, ...args }, { config: cfg, reference: fx.work, sessionId: sid });
  return { fx, server, cfg, sid, run };
}

/** A task branch with one commit, pushed to the origin. */
async function taskBranch(g, name = 'dsh/task', files = { 'task.txt': 'task' }, message = 'do the task') {
  gitOk(g.fx.work, ['checkout', '-q', '-b', name]);
  writeFiles(g.fx.work, files);
  commitAll(g.fx.work, message);
  gitOk(g.fx.work, ['push', '-q', '-u', 'origin', name]);
  return shaOf(g.fx.work);
}

/** Open the pull request for the current branch. */
async function openPull(g, args = {}) {
  const result = await g.run('pr', args);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

/* ================================================================== */
describe('pr', () => {
  test('opens a pull request for the pushed branch and reports it', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const result = await openPull(g);
    assert.equal(result.created, true);
    assert.equal(result.number, 1);
    assert.equal(result.state, 'open');
    assert.equal(result.draft, false);
    assert.equal(result.branch, 'dsh/task');
    assert.equal(result.base, 'main');
    assert.equal(result.title, 'do the task');
    assert.match(result.url, /^https:\/\/github\.com\/dsh-test\/fixture-\d+\/pull\/1$/);
    assert.equal(g.server.pulls.length, 1);
    const post = g.server.calls.find((call) => call.method === 'POST');
    assert.equal(post.body.head, 'dsh/task');
    assert.equal(post.body.base, 'main');
    assert.equal(post.body.title, 'do the task');
    assert.match(post.authorization, /^Bearer /);
    assert.match(post.accept, /application\/vnd\.github\+json/);
  });

  test('a second call returns the same pull request instead of opening another', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const first = await openPull(g);
    const second = await openPull(g);
    assert.equal(second.created, false);
    assert.equal(second.number, first.number);
    assert.equal(g.server.pulls.length, 1);
    const posts = g.server.calls.filter((call) => call.method === 'POST');
    assert.equal(posts.length, 1);
  });

  test('a new title updates the open pull request', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    await openPull(g);
    const updated = await openPull(g, { title: 'a better title' });
    assert.equal(updated.created, false);
    assert.equal(updated.title, 'a better title');
    assert.equal(g.server.pulls[0].title, 'a better title');
  });

  test('honours draft and body', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const result = await openPull(g, { draft: true, body: 'custom body' });
    assert.equal(result.draft, true);
    assert.equal(g.server.pulls[0].draft, true);
    assert.equal(g.server.pulls[0].body, 'custom body');
  });

  test('refuses a branch that is the base branch, before asking GitHub', async (t) => {
    const g = githubTest(t);
    const result = await g.run('pr');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'same-branch');
    assert.equal(g.server.calls.filter((call) => call.method === 'POST').length, 0);
  });

  test('refuses when there is nothing between the base and the branch', async (t) => {
    const g = githubTest(t);
    gitOk(g.fx.work, ['checkout', '-q', '-b', 'dsh/empty']);
    gitOk(g.fx.work, ['push', '-q', '-u', 'origin', 'dsh/empty']);
    const result = await g.run('pr');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'no-commits-between');
    assert.match(result.error.hint, /action "finish"/);
  });

  test('names a remote that is not a GitHub remote, and a missing one', async () => {
    const local = fixture();
    const plain = await action('pr', { repo: local.work }, { config: { ...config(), githubHost: 'github.com' }, reference: local.work });
    assert.equal(plain.ok, false);
    assert.equal(plain.error.code, 'not-github');
    const bareRepo = tempDir();
    gitOk(bareRepo, ['init', '--quiet', '-b', 'main']);
    gitOk(bareRepo, ['config', 'user.name', 'Tests']);
    gitOk(bareRepo, ['config', 'user.email', 'tests@example.invalid']);
    writeFiles(bareRepo, { 'a.txt': 'a' });
    commitAll(bareRepo, 'a');
    const noRemote = await action('pr', { repo: bareRepo }, { config: config(), reference: bareRepo });
    assert.equal(noRemote.ok, false);
    assert.equal(noRemote.error.code, 'no-remote');
  });
});

/* ================================================================== */
describe('merge', () => {
  test('merges the pull request for the current branch and deletes the merged remote branch', async (t) => {
    const g = githubTest(t);
    const taskSha = await taskBranch(g);
    const opened = await openPull(g);
    const result = await g.run('merge');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.merged, true);
    assert.equal(result.number, opened.number);
    assert.equal(result.method, 'merge');
    assert.equal(result.mergedBranch, 'dsh/task');
    assert.equal(result.remoteBranchDeleted, true);
    assert.equal(result.baseFetched, true);
    // The merge is real: main in the bare origin contains the task commit, and
    // origin/main in the working clone was fetched afterwards.
    assert.equal(git(g.fx.bare, ['merge-base', '--is-ancestor', taskSha, 'main']).ok, true);
    assert.equal(gitOk(g.fx.work, ['rev-parse', 'origin/main']), gitOk(g.fx.bare, ['rev-parse', 'main']));
    assert.equal(git(g.fx.bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/dsh/task']).ok, false);
    // The local branch is never removed by a merge.
    assert.equal(branches(g.fx.work).includes('dsh/task'), true);
    assert.equal(g.server.pulls[0].merged_at != null, true);
  });

  test('merges a named pull request from another branch checkout', async (t) => {
    const g = githubTest(t);
    const taskSha = await taskBranch(g);
    const opened = await openPull(g);
    gitOk(g.fx.work, ['checkout', '-q', 'main']);
    const result = await g.run('merge', { number: opened.number });
    assert.equal(result.ok, true);
    assert.equal(result.mergedBranch, 'dsh/task');
    assert.equal(result.remoteBranchDeleted, true);
    const mergedTip = gitOk(g.fx.bare, ['rev-parse', 'main']);
    assert.equal(git(g.fx.bare, ['merge-base', '--is-ancestor', taskSha, 'main']).ok, true);
    assert.equal(gitOk(g.fx.work, ['rev-parse', 'origin/main']), mergedTip);
  });

  test('a pull request from a branch outside the plugin prefix is merged but its branch is kept', async (t) => {
    const g = githubTest(t);
    await taskBranch(g, 'feature/mine', { 'feature.txt': 'feature' }, 'feature work');
    await openPull(g);
    const result = await g.run('merge');
    assert.equal(result.ok, true);
    assert.equal(result.merged, true);
    assert.equal(result.mergedBranch, 'feature/mine');
    assert.match(result.remoteKept, /not a task branch/);
    assert.equal(git(g.fx.bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/mine']).ok, true);
  });

  test('keeps the local branch when it moved past the merged commit, and says why', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const opened = await openPull(g);
    const merged = await g.run('merge');
    assert.equal(merged.ok, true);
    // A commit after the merge exists only locally: deleting the branch would
    // delete the only copy of that work.
    writeFiles(g.fx.work, { 'after.txt': 'after' });
    commitAll(g.fx.work, 'work after the merge');
    const result = await g.run('merge', { number: opened.number });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-mergeable');
    // Ask the branch report through prune instead: the branch tip is reported.
    gitOk(g.fx.work, ['checkout', '-q', 'main']);
    const prune = await g.run('prune');
    const entry = prune.branches.find((branch) => branch.branch === 'dsh/task');
    assert.ok(entry !== undefined);
    assert.equal(entry.kept, true);
    assert.match(entry.reason, /commit\(s\) of its own/);
  });

  test('refuses a squash merge before touching the API', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    await openPull(g);
    const result = await g.run('merge', { method: 'squash' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'method-refused');
    assert.equal(g.server.calls.filter((call) => call.method === 'PUT').length, 0);
  });

  test('there is no pull request to merge means exactly that', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const result = await g.run('merge');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'no-pull');
  });

  test('a pull request GitHub refuses to merge is reported as not mergeable', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    await openPull(g);
    g.server.force('PUT', '/repos/', 405, { message: 'Pull Request is not mergeable' });
    const result = await g.run('merge');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-mergeable');
    assert.equal(g.server.pulls[0].state, 'open');
  });

  test('a merge that GitHub cannot find is a not-found, not a silent success', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const result = await g.run('merge', { number: 99 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-found');
    assert.match(result.error.message, /404/);
    assert.match(result.error.message, /pulls\/99/);
  });
});

/* ================================================================== */
describe('finish', () => {
  test('commits, pushes and opens the pull request in one call', async (t) => {
    const g = githubTest(t);
    gitOk(g.fx.work, ['checkout', '-q', '-b', 'dsh/finish']);
    writeFiles(g.fx.work, { 'done.txt': 'done' });
    const result = await g.run('finish');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.equal(result.branch, 'dsh/finish');
    assert.equal(result.pull.number, 1);
    assert.equal(result.pull.state, 'open');
    assert.equal(g.server.pulls.length, 1);
    assert.equal(gitOk(g.fx.work, ['status', '--porcelain']), '');
    assert.equal(gitOk(g.fx.bare, ['rev-parse', 'refs/heads/dsh/finish']), shaOf(g.fx.work));
  });

  test('a second finish reuses the pull request and reports nothing left to do', async (t) => {
    const g = githubTest(t);
    gitOk(g.fx.work, ['checkout', '-q', '-b', 'dsh/finish']);
    writeFiles(g.fx.work, { 'done.txt': 'done' });
    await g.run('finish');
    const again = await g.run('finish');
    assert.equal(again.ok, true);
    assert.equal(again.committed, false);
    assert.equal(again.pushed, false);
    assert.equal(again.pull.number, 1);
    assert.equal(g.server.pulls.length, 1);
  });

  test('a failed pull request leaves the commit and push done, and names the skip', async (t) => {
    const g = githubTest(t);
    gitOk(g.fx.work, ['checkout', '-q', '-b', 'dsh/finish']);
    writeFiles(g.fx.work, { 'done.txt': 'done' });
    g.server.force('POST', '/repos/', 403, { message: 'Resource not accessible by integration' });
    const result = await g.run('finish');
    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.equal(result.pull, undefined);
    assert.equal(typeof result.prSkipped, 'string');
    assert.equal(gitOk(g.fx.work, ['status', '--porcelain']), '');
  });
});

/* ================================================================== */
describe('status with pull', () => {
  test('reports the open pull request for the current branch', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const opened = await openPull(g);
    const result = await g.run('status', { pull: true });
    assert.equal(result.ok, true);
    assert.equal(result.pull.number, opened.number);
    assert.equal(result.pull.state, 'open');
  });

  test('a failed pull request lookup is reported, not reported as nothing open', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    g.server.force('GET', '/repos/', 403, { message: 'Forbidden' });
    const result = await g.run('status', { pull: true });
    assert.equal(result.ok, true);
    assert.equal(result.pull, undefined);
    assert.equal(result.pullError.code, 'auth');
    assert.match(result.pullError.message, /Forbidden/);
  });
});

/* ================================================================== */
describe('prune after a merge', () => {
  /**
   * Merge the branch through the stand-in, then go back to main.
   *
   * Deliberately no 'merge --ff-only origin/main': the merge action fetches
   * origin/main but does not move the local base, so the branch still holds a
   * commit main does not — which is exactly the state in which the local rules
   * keep a branch and the merged pull request is the only proof it is done.
   */
  async function mergeAndReturn(g) {
    const opened = await openPull(g);
    const merged = await g.run('merge');
    assert.equal(merged.ok, true);
    gitOk(g.fx.work, ['checkout', '-q', 'main']);
    return opened;
  }

  test('a dry run names the branch proven merged, and apply removes it', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const opened = await mergeAndReturn(g);
    const dry = await g.run('prune');
    assert.equal(dry.ok, true);
    assert.equal(dry.applied, false);
    assert.equal(dry.detail, 'to remove: 1 branch proven merged by its pull request — pass apply: true');
    assert.equal(dry.mergedBranches.length, 1);
    assert.equal(dry.mergedBranches[0].branch, 'dsh/task');
    assert.equal(dry.mergedBranches[0].number, opened.number);
    assert.equal(branches(g.fx.work).includes('dsh/task'), true);
    const applied = await g.run('prune', { apply: true });
    assert.equal(applied.ok, true);
    assert.equal(applied.detail, 'removed 1 branch proven merged by its pull request');
    assert.equal(branches(g.fx.work).includes('dsh/task'), false);
    assert.deepEqual(branches(g.fx.work), ['main']);
  });

  test('a branch that moved after its merge is kept, with the proof spelled out', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    await openPull(g);
    const merged = await g.run('merge');
    assert.equal(merged.ok, true);
    writeFiles(g.fx.work, { 'after.txt': 'after' });
    commitAll(g.fx.work, 'commit after the merge');
    gitOk(g.fx.work, ['checkout', '-q', 'main']);
    const dry = await g.run('prune');
    assert.equal(dry.ok, true);
    assert.match(dry.detail, /nothing to remove/);
    assert.equal(dry.mergedBranches.length, 0);
    const entry = dry.branches.find((branch) => branch.branch === 'dsh/task');
    assert.equal(entry.kept, true);
    assert.match(entry.proof, /merged .* but it merged/);
    assert.equal(branches(g.fx.work).includes('dsh/task'), true);
  });

  test('a merged branch that exists only on the remote is swept from the remote', async (t) => {
    const g = githubTest(t);
    await taskBranch(g);
    const opened = await openPull(g);
    const merged = await g.run('merge');
    assert.equal(merged.ok, true);
    // Put the branch back on the remote, then lose the local ref: only the
    // remote names it, and only the merged pull request proves it disposable.
    gitOk(g.fx.work, ['push', '-q', 'origin', 'dsh/task']);
    gitOk(g.fx.work, ['checkout', '-q', 'main']);
    gitOk(g.fx.work, ['branch', '-D', 'dsh/task']);
    assert.equal(git(g.fx.bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/dsh/task']).ok, true);
    const dry = await g.run('prune');
    assert.equal(dry.ok, true);
    assert.equal(dry.mergedBranches.length, 1);
    assert.equal(dry.mergedBranches[0].remoteOnly, true);
    assert.equal(dry.mergedBranches[0].number, opened.number);
    const applied = await g.run('prune', { apply: true });
    assert.equal(applied.ok, true);
    assert.equal(git(g.fx.bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/dsh/task']).ok, false);
  });

  test('a branch named by the caller is removed locally and on the remote', async (t) => {
    const g = githubTest(t);
    gitOk(g.fx.work, ['checkout', '-q', '-b', 'dsh/named']);
    writeFiles(g.fx.work, { 'named.txt': 'named' });
    commitAll(g.fx.work, 'named work');
    gitOk(g.fx.work, ['push', '-q', '-u', 'origin', 'dsh/named']);
    gitOk(g.fx.work, ['checkout', '-q', 'main']);
    const result = await g.run('prune', { branches: ['dsh/named'], apply: true });
    assert.equal(result.ok, true);
    const entry = result.namedBranches.find((branch) => branch.branch === 'dsh/named');
    assert.equal(entry.removed, true);
    assert.equal(entry.remoteDeleted, true);
    assert.equal(branches(g.fx.work).includes('dsh/named'), false);
    assert.equal(git(g.fx.bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/dsh/named']).ok, false);
  });
});

/* ================================================================== */
describe('credentials', () => {
  test('falls back to the token gh prints when no environment token is set', async (t) => {
    const serverToken = 'gh-cli-token';
    const dir = tempDir();
    fakeGh(dir, { token: serverToken });
    const server = githubServer({ repos: [], token: serverToken });
    t.after(() => server.restore());
    const { createGithubClient } = await import('../lib/github.mjs');
    const client = createGithubClient({
      host: 'github.com',
      env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, PATH: pathWith(dir) },
    });
    const available = await client.isAvailable();
    assert.equal(available.ok, true, JSON.stringify(available));
    assert.equal(available.login, 'dsh-test-user');
  });

  test('no environment token and a gh that is not logged in is a named no-credentials answer', async (t) => {
    const dir = tempDir();
    fakeGh(dir, { fail: true });
    const { createGithubClient } = await import('../lib/github.mjs');
    // A host of its own: the token and probe memos are keyed per host, and this
    // case must not read a result another test cached.
    const client = createGithubClient({
      host: 'enterprise.example.test',
      env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, PATH: pathWith(dir) },
    });
    const available = await client.isAvailable();
    assert.equal(available.ok, false);
    assert.equal(available.code, 'no-credentials');
    assert.match(available.error, /GH_TOKEN and GITHUB_TOKEN are unset/);
    assert.match(available.error, /not logged in/);
  });
});
