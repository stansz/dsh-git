/**
 * A credential embedded in a remote URL is not reported.
 *
 * `https://user:token@host/repo.git` is a valid remote and a secret in plain sight. The
 * plugin writes its own messages through `describeRemote`, which drops the userinfo by
 * construction — but `status` reported the remote URL as git gave it, and a tool result
 * goes to the model and into the session log. Measured before the fix: the token was in
 * `status.repo.remotes[].url` and nowhere a human would see it, which is the worst of both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAction } from '../lib/actions.mjs';
import { git, makeCase } from './helpers.mjs';

const SECRET = 'sekrit-token-abc123';

test('a credential in a remote URL is not reported to the model', async (t) => {
  const c = makeCase('status-remote-secret');
  t.after(() => c.cleanup());
  git(c.repoDir, ['remote', 'set-url', 'origin', 'https://user:' + SECRET + '@github.com/octo/repo.git']);

  const status = await runAction('status', { action: 'status', repo: c.repoDir }, c.context());
  assert.equal(status.ok, true, 'status ran: ' + JSON.stringify(status.error ?? {}));
  const remotes = status.repo?.remotes ?? [];
  assert.equal(remotes.length, 1, 'the fixture has one remote');
  assert.equal(String(remotes[0].url).includes(SECRET), false, 'the secret is not in the result');
  assert.equal(String(remotes[0].url).includes('user:'), false, 'nor the username that carried it');
  assert.match(String(remotes[0].url), /github\.com\/octo\/repo\.git/u, 'the host and path survive: they are what make the line useful');

  const swept = await runAction('status', { action: 'status', sweep: true }, c.context());
  assert.equal(swept.ok, true, 'the sweep ran: ' + JSON.stringify(swept.error ?? {}));
  assert.ok(Array.isArray(swept.repos) && swept.repos.length > 0, 'the sweep found the fixture repository');
  assert.equal(JSON.stringify(swept.repos).includes(SECRET), false, 'and the sweep redacts it too');
});
