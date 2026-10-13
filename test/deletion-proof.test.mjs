/**
 * What may be deleted, and what has to survive it.
 *
 * Every deletion in this plugin goes through one of two doors: deleteBranch()
 * for a local ref, and the sweep inside pruneWorktrees(). Both used to be
 * unconditional once a caller had decided, and the callers were the only place
 * the reasoning lived — so a caller that got it wrong, or a listing that failed
 * and read as "nothing is registered", deleted work that existed nowhere else.
 *
 * These cases drive the real functions against real repositories, real
 * worktrees and real commits. The assertions read real git state: the refs, the
 * worktree registrations, and the objects that are still reachable afterwards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { retireMergedWorktree, runAction } from '../lib/actions.mjs';
import { listWorktrees } from '../lib/git.mjs';
import * as state from '../lib/state.mjs';
import { deleteBranch, pruneWorktrees } from '../lib/worktrees.mjs';
import { git, localBranches, makeCase, tryGit } from './helpers.mjs';

/** The commit a local branch points at, or undefined when there is no such branch. */
function ref(repoDir, branch) {
  return tryGit(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]);
}

/** Commit one file in a repository, and return the new commit id. */
function commitFile(repoDir, name, message) {
  const path = join(repoDir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, message + '\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

/** A branch cut from the base with one commit of its own, leaving the base checked out. */
function branchWith(c, branch, name, message) {
  git(c.repoDir, ['checkout', '-b', branch]);
  const sha = commitFile(c.repoDir, name, message);
  git(c.repoDir, ['checkout', 'main']);
  return sha;
}

/** One more commit on an existing branch, leaving the base checked out. */
function commitAgain(c, branch, name, message) {
  git(c.repoDir, ['checkout', branch]);
  const sha = commitFile(c.repoDir, name, message);
  git(c.repoDir, ['checkout', 'main']);
  return sha;
}

/**
 * Serve the pull-request list from memory, over the real client.
 *
 * Only the transport and the credential are doubled. The request the plugin
 * builds, the parsing, the verdict, and everything git does are the real code,
 * and the payload is the shape GitHub returns rather than a simplified one. A
 * suite cannot call the real API here: there is no repository to ask about, and
 * deleting refs on somebody's real repository is not a test. The real API is
 * exercised against the real repository outside this suite.
 */
function servePulls(payload) {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  const calls = [];
  process.env.GH_TOKEN = 'ghp_' + 'a'.repeat(36);
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    const served = href.includes('/pulls?');
    return new Response(JSON.stringify(served ? payload : { message: 'Not Found' }), {
      status: served ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
    },
  };
}

const MERGED_PULL_SHA = '4d'.repeat(20);

test('deleting a branch needs the commit it is believed to point at', async (t) => {
  const c = makeCase('delete-no-proof');
  t.after(() => c.cleanup());
  const tip = branchWith(c, 'dsh/unproven', 'src/unproven.txt', 'feat: unreviewed work');

  for (const proof of [undefined, null, {}, { tip: '' }, { tip: 'the branch' }]) {
    const refused = await deleteBranch(c.repoDir, 'dsh/unproven', {}, proof);
    assert.equal(refused.ok, false, 'a deletion without a commit to compare against is refused');
    assert.equal(refused.code, 'no-proof');
  }
  assert.equal(ref(c.repoDir, 'dsh/unproven'), tip, 'and the branch is exactly where it was');
});

test('a branch that moved past the proven commit is refused, and its commit survives', async (t) => {
  const c = makeCase('delete-tip-moved');
  t.after(() => c.cleanup());
  const merged = branchWith(c, 'dsh/moved-on', 'src/merged.txt', 'feat: the part that was merged');
  const newer = commitAgain(c, 'dsh/moved-on', 'src/not-merged.txt', 'feat: committed after the merge');

  const refused = await deleteBranch(c.repoDir, 'dsh/moved-on', {}, { tip: merged });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'tip-moved');
  assert.match(refused.error, /points at/u);
  assert.equal(ref(c.repoDir, 'dsh/moved-on'), newer, 'the newer commit is still named by the branch');
  assert.equal(tryGit(c.repoDir, ['cat-file', '-t', newer]), 'commit');
});

test('a branch a worktree has checked out is refused, whatever the proof says', async (t) => {
  const c = makeCase('delete-checked-out');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'live-task' }, c.context());
  const tip = git(started.worktree, ['rev-parse', 'HEAD']);

  const refused = await deleteBranch(c.repoDir, started.branch, {}, { tip });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'checked-out');
  assert.equal(ref(c.repoDir, started.branch), tip);
  assert.equal(existsSync(started.worktree), true);
});

test('the proven commit is the one that goes', async (t) => {
  const c = makeCase('delete-proven');
  t.after(() => c.cleanup());
  const tip = branchWith(c, 'dsh/finished', 'src/finished.txt', 'feat: finished and merged');

  const gone = await deleteBranch(c.repoDir, 'dsh/finished', {}, { tip });
  assert.equal(gone.ok, true);
  assert.ok(!localBranches(c.repoDir).includes('dsh/finished'));
  assert.equal(tryGit(c.repoDir, ['cat-file', '-t', tip]), 'commit', 'the object is not rewritten, only unreferenced');

  const absent = await deleteBranch(c.repoDir, 'dsh/never-existed', {}, { tip });
  assert.equal(absent.ok, true, 'a branch that is already gone is the state the caller wanted');
  assert.equal(absent.absent, true);
});

test('an unreadable worktree listing stops a deletion instead of reading as none', async (t) => {
  const c = makeCase('delete-list-failed');
  t.after(() => c.cleanup());
  const plain = join(c.root, 'plain-directory');
  mkdirSync(plain, { recursive: true });

  assert.equal(await listWorktrees(plain), undefined, 'unknown is undefined, never an empty list');

  const refused = await deleteBranch(plain, 'main', {}, { tip: 'a'.repeat(40) });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'worktree-list-failed');

  const swept = await pruneWorktrees(plain, { apply: true, branchPrefix: 'dsh/', baseRef: 'refs/heads/main' });
  assert.equal(swept.ok, false, 'a sweep that cannot see the worktrees does not sweep');
  assert.match(String(swept.error), /could not be read/u);
  assert.deepEqual(swept.entries, []);
});

test('retiring a merged task keeps a branch that moved past the merge', async (t) => {
  const c = makeCase('retire-tip-moved');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'merged-then-more' }, c.context());
  const merged = commitFile(started.worktree, 'src/merged.txt', 'feat: the part the pull request covers');
  const newer = commitFile(started.worktree, 'src/unpushed.txt', 'feat: committed after the merge, never pushed');
  const entry = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees[0];

  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, entry, { tip: merged });
  assert.equal(record.removed, true, 'the worktree really was clean, so it goes');
  assert.equal(record.branchRemoved, undefined, 'and the branch does not');
  assert.match(String(record.branchKept), /points at/u);
  assert.equal(existsSync(started.worktree), false);
  assert.equal(ref(c.repoDir, started.branch), newer, 'the commit the merge did not cover is still named by a branch');
  assert.equal(tryGit(c.repoDir, ['cat-file', '-t', newer]), 'commit');
});

test('retiring a merged task removes the branch when the tip is what merged', async (t) => {
  const c = makeCase('retire-exact-tip');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'merged-exactly' }, c.context());
  const tip = commitFile(started.worktree, 'src/merged.txt', 'feat: everything in the pull request');
  const entry = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees[0];

  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, entry, { tip });
  assert.equal(record.removed, true);
  assert.equal(record.branchRemoved, true);
  assert.ok(!localBranches(c.repoDir).includes(started.branch));
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees.length, 0);
});

/** The pull request that a reused slug is up against: merged, and from this name. */
function mergedPull(headSha) {
  return [{
    number: 8,
    html_url: 'https://github.com/stansz/dsh-git/pull/8',
    state: 'closed',
    merged_at: '2026-10-12T21:00:00Z',
    merge_commit_sha: 'c0'.repeat(20),
    head: { ref: 'dsh/refuse-ancestry-loss', sha: headSha },
    base: { ref: 'main' },
  }];
}

/** A repository whose origin looks like GitHub, with a local-only task branch on it. */
function reusedSlugCase(name) {
  const c = makeCase(name);
  const tip = branchWith(c, 'dsh/refuse-ancestry-loss', 'src/new-task.txt', 'feat: a new task wearing a merged name');
  git(c.repoDir, ['remote', 'set-url', 'origin', 'https://github.com/stansz/dsh-git.git']);
  return { c, tip };
}

test('prune keeps a task branch whose merged pull request covers a different commit', async (t) => {
  const { c, tip } = reusedSlugCase('prune-reused-slug');
  t.after(() => c.cleanup());
  const api = servePulls(mergedPull(MERGED_PULL_SHA));
  t.after(() => api.restore());

  const swept = await runAction('prune', { action: 'prune', repo: c.repoDir, apply: true }, c.context());
  assert.equal(swept.ok, true);
  assert.equal(ref(c.repoDir, 'dsh/refuse-ancestry-loss'), tip, 'the new task survives a name a merged pull request also has');
  assert.deepEqual(swept.mergedBranches, [], 'nothing was proven disposable');

  const entry = (swept.branches ?? []).find((row) => row.branch === 'dsh/refuse-ancestry-loss');
  assert.equal(entry.kept, true);
  assert.match(String(entry.proof), /not covered/u, 'and the report says why, not just that it stayed');
  assert.equal(entry.mergedPull, 8);
  assert.ok(api.calls.some((href) => href.includes('state=closed')), 'the question really was asked');
});

test('prune still recognises the branch that really is that pull request', async (t) => {
  const { c, tip } = reusedSlugCase('prune-exact-tip');
  t.after(() => c.cleanup());
  const api = servePulls(mergedPull(tip));
  t.after(() => api.restore());

  const swept = await runAction('prune', { action: 'prune', repo: c.repoDir }, c.context());
  assert.equal(swept.ok, true);
  assert.equal(swept.mergedBranches.length, 1, 'the commit the pull request merged is proven, so it would be swept');
  assert.equal(swept.mergedBranches[0].branch, 'dsh/refuse-ancestry-loss');
  assert.equal(swept.mergedBranches[0].sha, tip);
  assert.equal(swept.mergedBranches[0].number, 8);
  assert.equal(ref(c.repoDir, 'dsh/refuse-ancestry-loss'), tip, 'a dry run removes nothing');
  const asked = api.calls.find((href) => href.includes('/pulls?'));
  assert.match(asked, /base=main/u, 'the page is narrowed to the base this cleanup is about');
  assert.match(asked, /sort=updated/u);
});

test('a branch whose commits live in a real directory named like the scratch root is work', async (t) => {
  const c = makeCase('prune-tracked-scratch-name');
  t.after(() => c.cleanup());

  // The worktree root is <case>/.worktrees, outside the repository, but the
  // repository has a real tracked directory of that name. The sweep drops
  // that basename at any depth on the assumption it is the plugin's scratch,
  // which turned this branch's only commit into "no commits of its own" and
  // deleted the branch. A directory the base branch tracks is content.
  commitFile(c.repoDir, '.worktrees/real/keep.txt', 'chore: a real directory named like the scratch root');
  git(c.repoDir, ['push', 'origin', 'main']);
  const tip = branchWith(c, 'dsh/inside-a-real-directory', '.worktrees/real/more.txt', 'feat: work that lives under that name');

  const swept = await runAction('prune', { action: 'prune', repo: c.repoDir, apply: true }, c.context());
  assert.equal(swept.ok, true);
  assert.equal(ref(c.repoDir, 'dsh/inside-a-real-directory'), tip, 'the branch still holds its only commit');
  const entry = (swept.branches ?? []).find((row) => row.branch === 'dsh/inside-a-real-directory');
  assert.equal(entry.kept, true);
});
