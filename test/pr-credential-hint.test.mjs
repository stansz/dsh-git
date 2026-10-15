/**
 * B3: the advice fits the missing credential.
 *
 * The pull-request door said "Run `gh auth login`" whatever was missing, which is
 * useless on a machine that has no `gh` at all — the first thing that machine
 * needs is the install. The token chain already distinguishes the two cases in
 * its message, so the advice does too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { git, makeCase } from './helpers.mjs';

/** Point the case at a GitHub remote and take the machine's token away. */
function credentialless(c, t, pathValue) {
  git(c.repoDir, ['remote', 'set-url', 'origin', 'https://github.com/octo/repo.git']);
  const home = join(c.root, 'home');
  mkdirSync(home, { recursive: true });
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  process.env.PATH = pathValue;
  process.env.HOME = home;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('B3: with no gh installed, the advice is to install it', async (t) => {
  const c = makeCase('pr-gh-missing');
  t.after(() => c.cleanup());
  credentialless(c, t, '/usr/bin:/bin');

  const opened = await runAction('pr', { action: 'pr', repo: c.repoDir }, c.context());
  assert.equal(opened.ok, false);
  assert.equal(opened.error.code, 'no-credentials');
  assert.match(String(opened.error.message), /ENOENT|not be started/u, 'the token chain could not run gh at all');
  assert.match(String(opened.error.hint ?? ''), /Install the GitHub CLI/u, 'so the advice is the install');
  assert.ok(String(opened.error.hint ?? '').includes('GH_TOKEN'), 'and it names the no-install route');
});

test('B3 control: with gh installed but logged out, the advice is to log in', async (t) => {
  const c = makeCase('pr-gh-logged-out');
  t.after(() => c.cleanup());
  const bin = join(c.root, 'shim', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'printf "%s\\n" "no oauth token found for github.com" >&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  credentialless(c, t, bin + ':' + String(process.env.PATH ?? ''));

  const opened = await runAction('pr', { action: 'pr', repo: c.repoDir }, c.context());
  assert.equal(opened.ok, false);
  assert.equal(opened.error.code, 'no-credentials');
  assert.match(String(opened.error.message), /no oauth token found/u, 'gh ran and answered');
  assert.match(String(opened.error.hint ?? ''), /Run `gh auth login`/u, 'the advice is to log in');
  assert.doesNotMatch(String(opened.error.hint ?? ''), /Install the GitHub CLI/u, 'and not to install what is already there');
});
