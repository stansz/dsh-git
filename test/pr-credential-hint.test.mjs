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
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { git, makeCase } from './helpers.mjs';

/**
 * A PATH whose `git` works and whose `gh` cannot be found — whatever the machine
 * or the CI runner happens to ship.
 *
 * Setting PATH to `/usr/bin:/bin` was the first version of this, and it was wrong:
 * GitHub's ubuntu runners install `gh` at `/usr/bin/gh`, so the case measured the
 * runner instead of the code and failed there while passing here. A directory with
 * only symlinks to the binaries the action needs cannot leak a `gh` from anywhere.
 */
function pathWithoutGh(c) {
  const bin = join(c.root, 'bin-without-gh');
  mkdirSync(bin, { recursive: true });
  for (const name of ['git', 'sh']) {
    const found = String(process.env.PATH ?? '').split(':')
      .map((dir) => join(dir, name))
      .find((candidate) => existsSync(candidate));
    if (found !== undefined) symlinkSync(found, join(bin, name));
  }
  return bin;
}

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

test('B3: with no gh installed, the advice leads with the route that needs no install', async (t) => {
  const c = makeCase('pr-gh-missing');
  t.after(() => c.cleanup());
  credentialless(c, t, pathWithoutGh(c));
  assert.equal(existsSync(join(c.root, 'bin-without-gh', 'git')), true, 'the controlled PATH really holds git');

  const opened = await runAction('pr', { action: 'pr', repo: c.repoDir }, c.context());
  assert.equal(opened.ok, false);
  assert.equal(opened.error.code, 'no-credentials');
  assert.match(String(opened.error.message), /ENOENT|not be started/u, 'the token chain could not run gh at all');
  const hint = String(opened.error.hint ?? '');
  assert.match(hint, /GH_TOKEN/u, 'the advice names the option that needs nothing installed');
  assert.match(hint, /install the GitHub CLI/iu, 'and the install, as the alternative');
  assert.ok(hint.indexOf('GH_TOKEN') < hint.search(/install the GitHub CLI/iu),
    'the install-free option leads: this plugin does not make the GitHub CLI the workflow');
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
  assert.doesNotMatch(String(opened.error.hint ?? ''), /install the GitHub CLI/iu, 'and not to install what is already there');
});
