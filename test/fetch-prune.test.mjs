/**
 * The plugin's own fetch cleans up after the plugin's own merges.
 *
 * Retiring a merged task branch deletes it on the remote and removes the local
 * branch, but `refs/remotes/origin/dsh/<slug>` stayed, because the fetch never
 * pruned. Every merged task branch added one and nothing removed them — a
 * hand-run `git fetch --prune` is rightly gated by the guard, so a session could
 * not tidy them either — and the checkout this plugin runs in had seventeen
 * tracking refs for branches that exist nowhere.
 *
 * These cases drive the real fetch path and read real refs: a branch is created
 * and pushed, deleted on the bare origin with real git, and the plugin's own
 * fetch is what has to notice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAction } from '../lib/actions.mjs';
import * as gitLib from '../lib/git.mjs';
import { git as run, makeCase } from './helpers.mjs';

/** The refs this repository tracks for origin, by full name. */
function trackingRefs(repoDir) {
  return run(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']).split('\n').filter(Boolean);
}

/** The local branches, by full name. */
function localRefs(repoDir) {
  return run(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n').filter(Boolean);
}

/** Create and push a branch, then come back to the branch the fixture was on. */
function pushBranch(c, name) {
  run(c.repoDir, ['checkout', '-b', name]);
  run(c.repoDir, ['push', '-u', 'origin', name]);
  run(c.repoDir, ['checkout', 'main']);
}

/** Delete a branch on the bare origin, as the merge action does once it merges. */
function deleteOnOrigin(c, name) {
  run(c.originDir, ['branch', '-D', name]);
}

test('the sync path prunes the tracking ref of a branch deleted on the remote', async (t) => {
  const c = makeCase('fetch-prune-sync');
  t.after(() => c.cleanup());

  pushBranch(c, 'dsh/gone');
  assert.ok(trackingRefs(c.repoDir).includes('refs/remotes/origin/dsh/gone'), 'the pushed branch has a tracking ref');

  deleteOnOrigin(c, 'dsh/gone');
  assert.ok(
    trackingRefs(c.repoDir).includes('refs/remotes/origin/dsh/gone'),
    'deleting it on the remote does not touch the local tracking ref by itself — that is the defect',
  );

  const synced = await runAction('sync', { action: 'sync', repo: c.repoDir }, c.context());
  assert.equal(synced.ok, true, 'the plugin fetch path ran: ' + JSON.stringify(synced.error ?? {}));
  assert.equal(synced.base, 'main', 'and still resolved the base branch it fast-forwards against');

  const refs = trackingRefs(c.repoDir);
  assert.equal(refs.includes('refs/remotes/origin/dsh/gone'), false, 'the ref of a branch that is gone everywhere is gone too: ' + refs.join(' '));
  assert.ok(refs.includes('refs/remotes/origin/main'), 'and the ref that still exists on the remote was not collateral');
  assert.ok(localRefs(c.repoDir).includes('refs/heads/dsh/gone'), 'a prune of remote-tracking refs does not delete local branches');
});

test('a branch that still exists on the remote survives the same fetch', async (t) => {
  const c = makeCase('fetch-prune-live');
  t.after(() => c.cleanup());

  pushBranch(c, 'dsh/live');
  pushBranch(c, 'dsh/gone');
  deleteOnOrigin(c, 'dsh/gone');
  // A local branch with no remote counterpart is not a tracking ref at all.
  run(c.repoDir, ['branch', 'local-only']);

  const before = trackingRefs(c.repoDir);
  assert.ok(before.includes('refs/remotes/origin/dsh/live'), 'the live branch has a tracking ref');
  assert.ok(before.includes('refs/remotes/origin/dsh/gone'), 'and the deleted one still has its stale ref');

  const fetched = await gitLib.fetch(c.repoDir, 'origin');
  assert.equal(fetched.ok, true, 'the plugin fetch succeeded: ' + String(fetched.error ?? ''));

  const refs = trackingRefs(c.repoDir);
  assert.ok(refs.includes('refs/remotes/origin/dsh/live'), 'a branch that is still on the remote keeps its ref: ' + refs.join(' '));
  assert.ok(refs.includes('refs/remotes/origin/main'), 'as does the branch every task branch is based on');
  assert.equal(refs.includes('refs/remotes/origin/dsh/gone'), false, 'and only the ref whose branch is gone is removed');

  const locals = localRefs(c.repoDir);
  assert.ok(locals.includes('refs/heads/local-only'), 'a local branch with no remote counterpart is untouched');
  assert.ok(locals.includes('refs/heads/dsh/live'), 'and so is the local branch behind a live tracking ref');
  assert.ok(locals.includes('refs/heads/main'), 'and the base branch itself');
});
