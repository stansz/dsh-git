/**
 * A2: a push that failed for want of a credential says what to do about it.
 *
 * git reports this in prose and exits 128 — `fatal: could not read Username for
 * 'https://github.com': terminal prompts disabled` on a machine with no
 * credential helper, `Authentication failed` when one was presented and
 * refused, `Permission denied (publickey)` for an SSH key the server would not
 * take — and the plugin used to pass that sentence through unchanged. It
 * reaches a person in two places: as the note a turn ends with, and as the
 * record `status` prints for the automatic push. Both carry the fix now.
 *
 * The fixture points a task worktree at an HTTPS remote and removes every
 * credential git could find on this machine — the system gitconfig is where
 * the macOS keychain helper lives, and `HOME` becomes an empty directory — so
 * git fails before it opens a connection: no network, no login, and the same
 * words on every runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as gitLib from '../lib/git.mjs';
import { runAction } from '../lib/actions.mjs';
import { render } from '../lib/render.mjs';
import * as state from '../lib/state.mjs';
import { git, makeCase } from './helpers.mjs';

/** Take the machine's credentials away for the duration of one case. */
function withoutCredentials(c, t) {
  const home = join(c.root, 'home');
  mkdirSync(home, { recursive: true });
  const saved = { HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.GIT_CONFIG_NOSYSTEM;
  });
}

/** A task worktree whose origin needs a credential this machine does not have. */
async function credentiallessWorktree(c, slug) {
  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug }, c.context());
  assert.equal(started.ok, true, 'the fixture made a worktree: ' + JSON.stringify(started.error ?? {}));
  git(started.worktree, ['remote', 'set-url', 'origin', 'https://github.com/octo/repo.git']);
  return started;
}

/** The one failure this session recorded, whatever key it was filed under. */
function recorded(c) {
  const failures = Object.values(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).pushFailures);
  assert.equal(failures.length, 1, 'the failed push was recorded');
  return failures[0];
}

test('A2: the push failure names the fix, as a hint and in the record status prints', async (t) => {
  const c = makeCase('push-credential-hint');
  t.after(() => c.cleanup());
  const started = await credentiallessWorktree(c, 'no-credential');
  withoutCredentials(c, t);

  const pushed = await runAction('push', { action: 'push', repo: started.worktree }, c.context());
  assert.equal(pushed.ok, false, 'the push cannot succeed without a credential');
  assert.equal(pushed.error.code, 'push-failed');
  assert.match(String(pushed.error.message), /could not read Username|Authentication failed|Permission denied/u,
    'git own words are still the message');
  assert.match(String(pushed.error.hint ?? ''), /gh auth setup-git/u, 'the hint names the fix');

  assert.match(String(recorded(c).error), /gh auth setup-git/u, 'the record keeps the fix, because status prints the record');

  const status = await runAction('status', { action: 'status', repo: started.worktree }, c.context());
  assert.equal(status.ok, true, 'status ran: ' + JSON.stringify(status.error ?? {}));
  assert.match(render(status), /auto-push failing: [\s\S]*gh auth setup-git/u, 'and status says it too');
});

test('A2: a status asked in the worktree that failed to push finds the record', async (t) => {
  // The record is keyed on the main repository root — the doors that push file
  // it against the repository — while a status asked from inside a worktree
  // reports the worktree as its root, so the two used to miss each other and
  // the failure was invisible exactly where it had just happened.
  const c = makeCase('push-credential-record-root');
  t.after(() => c.cleanup());
  const started = await credentiallessWorktree(c, 'record-root');
  withoutCredentials(c, t);

  const pushed = await runAction('push', { action: 'push', repo: started.worktree }, c.context());
  assert.equal(pushed.ok, false);
  recorded(c);

  const inWorktree = await runAction('status', { action: 'status', repo: started.worktree }, c.context());
  assert.ok(inWorktree.pushFailure !== undefined, 'the worktree that failed to push must show it');
  assert.match(String(inWorktree.pushFailure.error), /gh auth setup-git/u);

  const inRepo = await runAction('status', { action: 'status', repo: c.repoDir }, c.context());
  assert.ok(inRepo.pushFailure !== undefined, 'and so must the repository it belongs to');
});

test('A2: the commit door reports the same hint', async (t) => {
  const c = makeCase('push-credential-hint-commit');
  t.after(() => c.cleanup());
  const started = await credentiallessWorktree(c, 'no-credential-commit');
  writeFileSync(join(started.worktree, 'work.txt'), 'the work\n');
  withoutCredentials(c, t);

  const committed = await runAction('commit', { action: 'commit', repo: started.worktree, push: true }, c.context());
  assert.equal(committed.ok, true, 'the commit itself succeeded: ' + JSON.stringify(committed.error ?? {}));
  assert.equal(committed.pushed, false, 'the push did not');
  assert.match((committed.notes ?? []).join('\n'), /gh auth setup-git/u, 'the notes name the fix');
});

test('A2: the sentence is added only when the failure is about a credential', () => {
  const cases = [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: Authentication failed for 'https://github.com/octo/repo.git/'",
    'git@github.com: Permission denied (publickey).',
    'remote: Invalid username or token. Password authentication is not supported for Git operations.',
  ];
  for (const text of cases) {
    assert.match(String(gitLib.credentialHint(text) ?? ''), /gh auth setup-git/u, 'a credential failure is explained: ' + text);
    assert.match(gitLib.explainCredentialFailure(text), /gh auth setup-git/u);
  }

  const network = 'fatal: unable to access https://github.com/octo/repo.git/: Could not resolve host: github.com';
  assert.equal(gitLib.credentialHint(network), undefined, 'a network failure is not a credential failure');
  assert.equal(gitLib.explainCredentialFailure(network), network, 'and it is passed through untouched');
  assert.equal(gitLib.explainCredentialFailure(''), '');
});
