/**
 * D15: the HTTP outcomes, told apart.
 *
 * Two statuses were being read as facts they do not carry. A 404 from the merge
 * endpoint was reported as "already merged or closed", which is a different fact
 * from "there is no such pull request" and leads to a different action; a 422
 * from the ref delete was collapsed into "the branch was absent" without saying
 * so. Both are pinned here against the real client, with only the transport and
 * the credential doubled — the request the plugin builds, the status mapping and
 * the whole envelope are the real code, the same arrangement
 * test/deletion-proof.test.mjs uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGithubClient } from '../lib/github.mjs';

/**
 * Serve canned responses for the endpoints these cases call.
 *
 * Only `globalThis.fetch` and the token are doubles. A 204 carries no body, and
 * an unmatched path answers 404 with the shape GitHub uses, so a case that asks
 * the wrong endpoint fails instead of passing by accident.
 */
function serve(routes) {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'ghp_' + 'a'.repeat(36);
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = String(options.method ?? 'GET').toUpperCase();
    calls.push(method + ' ' + href);
    const route = routes.find((entry) => href.includes(entry.match)
      && (entry.method === undefined || entry.method === method));
    if (route === undefined) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (route.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
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

const COORDS = { owner: 'octo', repo: 'repo' };

test('D15: a 404 on the merge endpoint is a missing pull request, not an already-merged one', async (t) => {
  const served = serve([
    { match: '/pulls/7/merge', method: 'PUT', status: 404, body: { message: 'Not Found' } },
    { match: '/pulls/8/merge', method: 'PUT', status: 405, body: { message: 'Pull Request is not mergeable' } },
    { match: '/pulls/9/merge', method: 'PUT', status: 409, body: { message: 'Head branch was modified' } },
    { match: '/pulls/10/merge', method: 'PUT', status: 200, body: { merged: true, sha: 'a'.repeat(40) } },
  ]);
  t.after(() => served.restore());
  const client = createGithubClient({ host: 'github.com' });

  const missing = await client.mergePull({ ...COORDS, number: 7, method: 'merge' });
  assert.equal(missing.ok, false, 'a pull request that is not there is not a merge that happened');
  assert.equal(missing.code, 'not-found', 'it carries the mapped HTTP code');
  assert.notEqual(missing.code, 'not-open', 'the old code claimed a state nothing had established');
  assert.equal(missing.status, 404, 'the status stays on the record');
  assert.match(String(missing.message), /no pull request #7/u, 'the message names what is missing');
  assert.match(String(missing.message), /octo\/repo/u, 'and which repository was asked');
  assert.match(String(missing.error), /HTTP 404/u, 'the HTTP fact is still in the error line');

  // The statuses that do mean what they say keep their code and behaviour.
  const notMergeable = await client.mergePull({ ...COORDS, number: 8, method: 'merge' });
  assert.equal(notMergeable.code, 'not-mergeable', '405 still means not mergeable, where an already-merged pull request lands');
  assert.match(String(notMergeable.message), /not mergeable/u);

  const headChanged = await client.mergePull({ ...COORDS, number: 9, method: 'merge' });
  assert.equal(headChanged.code, 'head-changed', '409 still means the head moved');

  const merged = await client.mergePull({ ...COORDS, number: 10, method: 'merge' });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, true);
  assert.equal(merged.sha, 'a'.repeat(40), 'the success path is unchanged');
  assert.deepEqual(served.calls.filter((call) => call.includes('/merge')), [
    'PUT https://api.github.com/repos/octo/repo/pulls/7/merge',
    'PUT https://api.github.com/repos/octo/repo/pulls/8/merge',
    'PUT https://api.github.com/repos/octo/repo/pulls/9/merge',
    'PUT https://api.github.com/repos/octo/repo/pulls/10/merge',
  ]);
});

test('D15: a 422 on the ref delete names the already-absent outcome, and the success path is unchanged', async (t) => {
  const served = serve([
    { match: '/git/refs/heads/dsh/task', method: 'DELETE', status: 422, body: { message: 'Reference does not exist' } },
    { match: '/git/refs/heads/dsh/old', method: 'DELETE', status: 204 },
    { match: '/git/refs/heads/dsh/locked', method: 'DELETE', status: 403, body: { message: 'Resource not accessible by integration' } },
  ]);
  t.after(() => served.restore());
  const client = createGithubClient({ host: 'github.com' });

  const absent = await client.deleteRemoteBranch({ ...COORDS, branch: 'dsh/task' });
  assert.equal(absent.ok, true, 'a branch that is already gone is the state the caller asked for');
  assert.equal(absent.deleted, false);
  assert.equal(absent.code, 'already-absent', 'the outcome is named instead of assumed away');
  assert.equal(absent.status, 422, 'the status is on the record');
  assert.equal(absent.message, 'Reference does not exist', 'the API own message is carried');

  const deleted = await client.deleteRemoteBranch({ ...COORDS, branch: 'dsh/old' });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.code, undefined, 'a deletion that happened needs no qualifier');

  const locked = await client.deleteRemoteBranch({ ...COORDS, branch: 'dsh/locked' });
  assert.equal(locked.ok, false, 'a refusal is still a failure');
  assert.equal(locked.code, 'auth', '403 without a rate-limit header stays an auth failure');

  // The DELETE path is the branch as a ref: its slashes stay structural.
  assert.deepEqual(served.calls, [
    'DELETE https://api.github.com/repos/octo/repo/git/refs/heads/dsh/task',
    'DELETE https://api.github.com/repos/octo/repo/git/refs/heads/dsh/old',
    'DELETE https://api.github.com/repos/octo/repo/git/refs/heads/dsh/locked',
  ]);
});
