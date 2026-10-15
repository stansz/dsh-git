/**
 * A3: `status` with `pull: true` reports a lookup that failed.
 *
 * The failure used to be indistinguishable from "there is no pull request":
 * both printed nothing, and the commonest reason for the failure is the one a
 * reader is asking about — no GitHub credential on this machine. Only the
 * transport is doubled here; the client, the action and the renderer are real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAction } from '../lib/actions.mjs';
import { render } from '../lib/render.mjs';
import { git, makeCase } from './helpers.mjs';

/**
 * Serve canned responses, with a token in the environment.
 *
 * The token matters for the control: without one the lookup fails before it is
 * sent, on a machine with no `gh` login, and the case would be measuring this
 * machine rather than the code. Only `globalThis.fetch` and the token are
 * doubles, as in test/render-result.test.mjs.
 */
function serve(routes) {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'ghp_' + 'a'.repeat(36);
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = String(options.method ?? 'GET').toUpperCase();
    const route = routes.find((entry) => href.includes(entry.match)
      && (entry.method === undefined || entry.method === method));
    if (route === undefined) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    restore() {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
    },
  };
}

test('A3: a failed pull lookup is reported with its reason', async (t) => {
  const c = makeCase('status-pull-failure');
  t.after(() => c.cleanup());
  git(c.repoDir, ['remote', 'set-url', 'origin', 'https://github.com/octo/repo.git']);
  const served = serve([{ match: '/pulls?', method: 'GET', status: 401, body: { message: 'Bad credentials' } }]);
  t.after(() => served.restore());

  const status = await runAction('status', { action: 'status', repo: c.repoDir, pull: true }, c.context());
  assert.equal(status.ok, true, 'status itself succeeded: ' + JSON.stringify(status.error ?? {}));
  assert.equal(status.pull, undefined, 'no pull request was found');
  assert.equal(typeof status.pullError?.code, 'string', 'the failure is reported rather than swallowed');
  assert.equal(typeof status.pullError?.message, 'string', 'and it carries a message');

  const text = render(status);
  assert.match(text, /pull request: not checked/u);
  assert.ok(text.includes(String(status.pullError.message)), 'the line names what went wrong');
});

test('A3 control: a lookup that succeeded and found nothing stays silent', async (t) => {
  const c = makeCase('status-pull-control');
  t.after(() => c.cleanup());
  git(c.repoDir, ['remote', 'set-url', 'origin', 'https://github.com/octo/repo.git']);
  const served = serve([{ match: '/pulls?', method: 'GET', status: 200, body: [] }]);
  t.after(() => served.restore());

  const status = await runAction('status', { action: 'status', repo: c.repoDir, pull: true }, c.context());
  assert.equal(status.ok, true);
  assert.equal(status.pullError, undefined, 'nothing failed, so nothing is reported');
  assert.doesNotMatch(render(status), /pull request:/u);
});
