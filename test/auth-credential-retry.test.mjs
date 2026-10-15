/**
 * A1: a credential failure is not remembered for the process.
 *
 * The token chain is `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token`. Only a
 * success is memoized, and the `gh` fallback keys its memo on the host alone —
 * so remembering a failure meant the flow a new machine invites (read the
 * error, run `gh auth login` in a terminal, ask again) kept answering
 * `no-credentials` until the Harness restarted.
 *
 * The `gh` in these cases is real: a shell script on `PATH` that fails until a
 * marker file appears, invoked by the shipped `execFile('gh', ['auth',
 * 'token', …])` path. Only the transport is doubled, the way
 * test/http-outcomes.test.mjs doubles it, so nothing here needs the network or
 * this machine's own login.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGithubClient } from '../lib/github.mjs';
import { makeCase } from './helpers.mjs';

/** The doubled transport: `GET /user` and a count of what it saw. */
function serveUser(login) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url).endsWith('/user')) {
      return new Response(JSON.stringify({ login }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-oauth-scopes': 'repo' },
      });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    fetchCalls: () => calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/** A `gh` on PATH that fails until `ready` exists, logging each invocation. */
function ghShim(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(dir, 'calls.log');
  const ready = join(dir, 'ready');
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> ' + JSON.stringify(calls),
    'if [ -f ' + JSON.stringify(ready) + ' ]; then',
    '  printf "%s\\n" "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    '  exit 0',
    'fi',
    'printf "%s\\n" "no oauth token found for github.com" >&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin, calls, ready };
}

/** No token in the environment: the shim is the only thing that can answer. */
function envFor(c, shim) {
  const home = join(c.root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    HOME: home,
    PATH: shim.bin + ':' + String(process.env.PATH ?? ''),
  };
}

test('A1: a token failure is asked again, so a login that happens later is seen', async (t) => {
  const c = makeCase('auth-retry');
  t.after(() => c.cleanup());
  const shim = ghShim(join(c.root, 'shim'));
  const served = serveUser('probe');
  t.after(() => served.restore());

  const client = createGithubClient({ host: 'github.com', timeoutMs: 10000, env: envFor(c, shim) });
  const first = await client.isAvailable();
  assert.equal(first.ok, false, 'no gh login yet: ' + JSON.stringify(first));
  assert.equal(first.code, 'no-credentials');
  assert.equal(served.fetchCalls(), 0, 'no request is made without a token');

  // The login a fresh machine is told to do, done while the process is running.
  writeFileSync(shim.ready, 'logged in\n');
  const second = await client.isAvailable();
  assert.equal(second.ok, true, 'the login is visible without a restart: ' + JSON.stringify(second));
  assert.equal(second.login, 'probe');
  assert.equal(served.fetchCalls(), 1, 'the transport is reached once the token exists');
  assert.equal(readFileSync(shim.calls, 'utf8').trim().split('\n').length, 2, 'gh was asked once per state, not once per process');
});

test('A1 control: a working credential is still resolved once, not once per call', async (t) => {
  const c = makeCase('auth-memo-control');
  t.after(() => c.cleanup());
  const shim = ghShim(join(c.root, 'shim'));
  writeFileSync(shim.ready, 'already logged in\n');
  const served = serveUser('probe');
  t.after(() => served.restore());

  // A host of its own: the memo is per host, and this case is about the success
  // that must still be remembered.
  const client = createGithubClient({ host: 'ghe.example.test', timeoutMs: 10000, env: envFor(c, shim) });
  const first = await client.isAvailable();
  const second = await client.isAvailable();
  assert.equal(first.ok, true, 'the shim answers: ' + JSON.stringify(first));
  assert.equal(second.ok, true);
  assert.equal(readFileSync(shim.calls, 'utf8').trim().split('\n').length, 1, 'a working token is read once');
  assert.equal(served.fetchCalls(), 1, 'and the probe is not repeated either');
});
