/**
 * B1: the read door explains a credential failure too.
 *
 * A2 taught the push doors to say what to do when git reports a credential it
 * does not have; the same failure on the *read* path — action "sync", which is
 * the first thing a session runs, and the only door a private repository needs
 * before it needs a push — still arrived as git's sentence alone.
 *
 * The fixture points origin at a host this machine has no credential for at all,
 * and takes the machine's own away (no system gitconfig, an empty HOME), so git
 * fails before it opens a connection: no network, and the same words on every
 * runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { render } from '../lib/render.mjs';
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

test('B1: a fetch that failed for want of a credential carries the fix', async (t) => {
  const c = makeCase('sync-credential-hint');
  t.after(() => c.cleanup());
  git(c.repoDir, ['remote', 'set-url', 'origin', 'https://gitlab.com/someone/private.git']);
  withoutCredentials(c, t);

  const synced = await runAction('sync', { action: 'sync', repo: c.repoDir }, c.context());
  assert.equal(synced.ok, false, 'the fetch cannot succeed without a credential');
  assert.equal(synced.error.code, 'fetch-failed');
  assert.match(String(synced.error.message), /could not read Username|Authentication failed|Permission denied/u,
    'git own words are still the message');
  assert.match(String(synced.error.hint ?? ''), /gh auth setup-git/u, 'the read door names the fix');
  assert.match(render(synced), /next: .*gh auth setup-git/u, 'and a reader is shown it');
});

test('B1 control: a fetch failure that is not about a credential gets no sentence', async (t) => {
  const c = makeCase('sync-network-hint');
  t.after(() => c.cleanup());
  // A local path that is not a repository: git fails without ever looking for a
  // credential, so this is a failure the explanation must leave alone.
  git(c.repoDir, ['remote', 'set-url', 'origin', join(c.root, 'no-such-repo.git')]);

  const synced = await runAction('sync', { action: 'sync', repo: c.repoDir }, c.context());
  assert.equal(synced.ok, false);
  assert.equal(synced.error.code, 'fetch-failed');
  assert.equal(synced.error.hint, undefined, 'a failure that is not about a credential is passed through');
});
