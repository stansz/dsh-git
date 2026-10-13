/**
 * The rule that decides whether a branch may be deleted.
 *
 * This is the one decision in the plugin that cannot be undone, and it used to
 * be made on a branch *name*: any merged pull request whose head branch matched
 * was proof enough. Reusing a slug is the normal flow — start a task, merge it,
 * start another task with the same name — so the second task inherited the first
 * task's proof, and its newest commit was deleted by a sweep nobody asked to be
 * destructive.
 *
 * The rule is pure: pull requests in, verdict out. That is what makes it
 * testable here rather than only through a live API. The payloads below are the
 * fields GitHub really sends, and the cases are the ones that decide whether
 * work survives.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeProof, isCommitId, normalizePull, normalizePulls, proveMergedPull } from '../lib/merge-proof.mjs';

const MERGED_SHA = '4d'.repeat(20);
const MOVED_SHA = '9e'.repeat(20);
const MERGE_COMMIT = 'c0'.repeat(20);
const BRANCH = 'dsh/refuse-ancestry-loss';

/** One element of the pull-request list response, in the shape GitHub sends it. */
function pull(overrides = {}) {
  return {
    number: 8,
    html_url: 'https://github.com/stansz/dsh-git/pull/8',
    state: 'closed',
    merged_at: '2026-10-12T21:00:00Z',
    merge_commit_sha: MERGE_COMMIT,
    title: 'merge: refuse the methods that destroy the ancestry',
    head: { ref: BRANCH, sha: MERGED_SHA },
    base: { ref: 'main' },
    ...overrides,
  };
}

test('a merged pull request proves the branch only when it merged this very commit', () => {
  const verdict = proveMergedPull(normalizePulls([pull()]), { branch: BRANCH, tip: MERGED_SHA, base: 'main' });
  assert.equal(verdict.proven, true);
  assert.equal(verdict.number, 8);
  assert.equal(verdict.headSha, MERGED_SHA);
  assert.equal(verdict.mergeCommitSha, MERGE_COMMIT);
  assert.match(describeProof(verdict), /covers this commit/u);
});

test('a branch that moved after its merge is not proven disposable', () => {
  const verdict = proveMergedPull(normalizePulls([pull()]), { branch: BRANCH, tip: MOVED_SHA, base: 'main' });
  assert.equal(verdict.proven, false, 'the commit that is here now was never merged');
  assert.equal(verdict.reason, 'tip-moved');
  assert.equal(verdict.number, 8, 'the pull request it refused to accept is named');
  assert.equal(verdict.headSha, MERGED_SHA);
  assert.match(describeProof(verdict), /not covered/u);
});

test('a tip is required, and a name alone proves nothing', () => {
  for (const tip of [undefined, null, '', '   ', 'HEAD', 'main', MERGED_SHA.slice(0, 12)]) {
    const verdict = proveMergedPull(normalizePulls([pull()]), { branch: BRANCH, tip });
    assert.equal(verdict.proven, false, 'tip ' + JSON.stringify(tip) + ' must not prove anything');
    assert.equal(verdict.reason, 'no-tip');
  }
  assert.equal(isCommitId(MERGED_SHA), true);
  assert.equal(isCommitId('f'.repeat(64)), true, 'a SHA-256 repository is not excluded');
  assert.equal(isCommitId(MERGED_SHA.toUpperCase()), false);
  assert.equal(isCommitId('4d'.repeat(19)), false);
});

test('a merge into another base is not proof for the base being cleaned up', () => {
  const onto = pull({ base: { ref: 'release/1.x' } });
  const verdict = proveMergedPull(normalizePulls([onto]), { branch: BRANCH, tip: MERGED_SHA, base: 'main' });
  assert.equal(verdict.proven, false);
  assert.equal(verdict.reason, 'base-mismatch');
  assert.match(describeProof(verdict), /landed in release\/1\.x/u);
  assert.equal(proveMergedPull(normalizePulls([onto]), { branch: BRANCH, tip: MERGED_SHA }).proven, true, 'with no base named, the caller is not asking about one');
});

test('an unmerged request, a request from another branch, and an empty answer', () => {
  const closedUnmerged = pull({ merged_at: null });
  assert.equal(proveMergedPull(normalizePulls([closedUnmerged]), { branch: BRANCH, tip: MERGED_SHA }).reason, 'not-merged');
  const otherBranch = pull({ head: { ref: 'dsh/something-else', sha: MERGED_SHA } });
  assert.equal(proveMergedPull(normalizePulls([otherBranch]), { branch: BRANCH, tip: MERGED_SHA }).reason, 'no-pull');
  assert.equal(proveMergedPull([], { branch: BRANCH, tip: MERGED_SHA }).reason, 'no-pull');
  assert.equal(proveMergedPull([], {}).reason, 'no-branch');
  for (const verdict of [proveMergedPull([], { branch: BRANCH, tip: MERGED_SHA }), proveMergedPull([], {})]) {
    assert.equal(verdict.proven, false);
    assert.ok(describeProof(verdict).length > 0, 'every verdict can be said in a sentence');
  }
});

test('the page is read in the order it arrives, newest first', () => {
  const older = pull({ number: 4, merged_at: '2026-01-01T00:00:00Z' });
  const newer = pull({ number: 9, merged_at: '2026-10-12T21:00:00Z' });
  const verdict = proveMergedPull(normalizePulls([newer, older]), { branch: BRANCH, tip: MERGED_SHA, base: 'main' });
  assert.equal(verdict.number, 9, 'the most recent merge that covers this commit is the one reported');
});

test('only the fields a deletion may rest on survive normalization', () => {
  const normalized = normalizePull(pull({ body: 'x'.repeat(200), user: { login: 'someone' }, draft: true }));
  assert.deepEqual(Object.keys(normalized).sort(), ['base', 'head', 'headSha', 'mergeCommitSha', 'mergedAt', 'number', 'url']);
  assert.equal(normalizePull({ number: 1, merged_at: '2026-01-01T00:00:00Z' }), undefined, 'a request with no readable head is not a request');
  assert.equal(normalizePull(null), undefined);
  assert.deepEqual(normalizePulls({ message: 'Not Found' }), [], 'an error body is not a list');
  assert.equal(normalizePull(pull({ merged_at: null })).mergedAt, undefined);
});
