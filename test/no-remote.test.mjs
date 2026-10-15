/**
 * B2: a repository with no `origin` is not a push failure.
 *
 * The failure git reports for it — "'origin' does not appear to be a git
 * repository" — is the repository's shape, not work at risk. The automatic sync
 * used to report it every turn and record a backoff that retried for an hour at a
 * time, which is a nag for anyone starting a project that has nowhere to push to
 * yet; the explicit action now names the real reason instead of quoting git.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { syncRepo } from '../lib/turn-commit.mjs';
import * as state from '../lib/state.mjs';
import { git, makeCase } from './helpers.mjs';

/** A task worktree whose repository has had its only remote removed. */
async function localOnlyWorktree(c, slug) {
  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug }, c.context());
  assert.equal(started.ok, true, 'the fixture made a worktree: ' + JSON.stringify(started.error ?? {}));
  git(c.repoDir, ['remote', 'remove', 'origin']);
  return started;
}

function recordedFailures(c) {
  return Object.keys(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).pushFailures);
}

test('B2: push says the repository has no origin, and records no failure', async (t) => {
  const c = makeCase('no-remote-push');
  t.after(() => c.cleanup());
  const started = await localOnlyWorktree(c, 'local-only');

  const pushed = await runAction('push', { action: 'push', repo: started.worktree }, c.context());
  assert.equal(pushed.ok, false);
  assert.equal(pushed.error.code, 'no-remote', 'the reason is the missing remote, not git prose');
  assert.match(String(pushed.error.message), /no origin remote/u);
  assert.match(String(pushed.error.hint ?? ''), /git remote add origin/u, 'and the hint says how to add one');
  assert.deepEqual(recordedFailures(c), [], 'a repository that cannot push records no backoff');
});

test('B2: the automatic sync commits the work and says nothing about pushing', async (t) => {
  const c = makeCase('no-remote-sync');
  t.after(() => c.cleanup());
  const started = await localOnlyWorktree(c, 'local-work');
  const file = join(started.worktree, 'work.txt');
  writeFileSync(file, 'work that stays local\n');

  const synced = await syncRepo(started.worktree, c.config, c.sessionId, [file]);
  assert.equal(synced.committed, true, 'the automatic commit still happens: it is what stops work being lost');
  assert.equal(synced.pushed, false);
  assert.equal(synced.noRemote, true, 'the sync recognised there is nowhere to push');
  assert.deepEqual(synced.notes, [], 'and reported nothing, because nothing is wrong');
  assert.deepEqual(recordedFailures(c), [], 'and recorded no backoff against it');
});
