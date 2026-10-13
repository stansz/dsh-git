/**
 * D20: the result renderer says what actually happened.
 *
 * A merge records the worktrees it retires in `worktreesClosed` — one record per
 * worktree, with whether the worktree and its branch went — but the renderer
 * printed only the singular worktreeRemoved/worktreeKept booleans, which a merge
 * never sets. A retired worktree was therefore invisible in the text a model
 * reads. This file drives the real retirement on a real worktree, renders the
 * envelope a merge produces from that record, and pins the pull-request half
 * through the real client with only the transport doubled.
 *
 * The GitHub half of action "merge" cannot run in this suite: there is no
 * repository to ask about and no credentials, the same constraint
 * test/merge-retire.test.mjs documents. The envelope below carries the fields
 * that action really sets, read from lib/actions.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { retireMergedWorktree, runAction } from '../lib/actions.mjs';
import { createGithubClient } from '../lib/github.mjs';
import { render } from '../lib/render.mjs';
import * as state from '../lib/state.mjs';
import { git, makeCase } from './helpers.mjs';

/**
 * Serve canned responses for the endpoints these cases call.
 *
 * Only `globalThis.fetch` and the token are doubles: the request the plugin
 * builds, the status mapping and every envelope are the real code.
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

/** Commit a file in a worktree and return the commit the branch now points at. */
function commitWork(worktree, name) {
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'src', name), 'the work\n');
  git(worktree, ['add', '-A']);
  git(worktree, ['-c', 'user.email=suite@example.invalid', '-c', 'user.name=dsh-git suite', 'commit', '-m', 'feat: ' + name]);
  return git(worktree, ['rev-parse', 'HEAD']);
}

test('D20: a merge shows the worktree it retired, from the record the action sets', async (t) => {
  const c = makeCase('render-merge-retire');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'rendered-task' }, c.context());
  const tip = commitWork(started.worktree, 'work.txt');
  const entry = state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).worktrees[0];
  const record = await retireMergedWorktree(c.repoDir, c.config, c.sessionId, entry, { tip });
  assert.equal(record.removed, true, 'the fixture really retired a worktree');

  // The fields action "merge" sets after a real merge, with the real record above.
  const text = render({
    action: 'merge',
    ok: true,
    merged: true,
    number: 7,
    method: 'merge',
    mergedBranch: entry.branch,
    sha: tip,
    remoteKept: 'the remote ref could not be read, so it was left alone',
    worktreesClosed: [record],
  });
  assert.match(text, /^OK {2}merged #7/u);
  assert.ok(text.includes('branch ' + entry.branch), 'the branch the pull request came from is printed');
  assert.ok(text.includes('worktree removed: ' + entry.path), 'the retired worktree must be visible, not silent');
  assert.ok(text.includes('and its branch ' + entry.branch), 'and so must the branch that went with it');
  assert.ok(text.includes('remote branch kept — the remote ref could not be read'), 'a field the action sets is printed');
  assert.doesNotMatch(text, /already merged or closed/u);

  // The other half of the same field: a retirement that was refused keeps its work.
  const kept = render({
    action: 'merge',
    ok: true,
    merged: true,
    number: 8,
    method: 'merge',
    worktreesClosed: [{ path: '/w/dsh/kept', branch: 'dsh/kept', removed: false, error: 'it has uncommitted changes' }],
  });
  assert.ok(kept.includes('worktree kept: /w/dsh/kept — it has uncommitted changes'), 'a refused retirement is printed too');
});

test('D20: a merge failure renders what GitHub said, and a non-merge claims no state', async (t) => {
  const served = serve([
    { match: '/pulls/7/merge', method: 'PUT', status: 404, body: { message: 'Not Found' } },
  ]);
  t.after(() => served.restore());
  const client = createGithubClient({ host: 'github.com' });
  const missing = await client.mergePull({ owner: 'octo', repo: 'repo', number: 7, method: 'merge' });

  // Action "merge" wraps a client failure as fail('merge', code, message); these
  // are the values the real client just produced for a 404.
  const failed = render({ action: 'merge', ok: false, error: { code: missing.code, message: missing.message } });
  assert.match(failed, /^FAIL {2}merge \(not-found\)/u);
  assert.ok(failed.includes('no pull request #7'), 'the rendered failure names what is missing');
  assert.doesNotMatch(failed, /already merged/u);

  // An ok result that merged nothing says only that, instead of naming a state
  // nothing established.
  const nothing = render({ action: 'merge', ok: true, merged: false, number: 7 });
  assert.match(nothing, /no merge was performed/u);
  assert.doesNotMatch(nothing, /already merged or closed/u);
});

test('D20: a pull request result names its title, and a real finish renders its steps', async (t) => {
  const c = makeCase('render-finish');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'finish-task' }, c.context());
  // Leave the work uncommitted: finish is the action that commits it.
  mkdirSync(join(started.worktree, 'src'), { recursive: true });
  writeFileSync(join(started.worktree, 'src', 'finish.txt'), 'the work\n');
  const finished = await runAction('finish', { action: 'finish', repo: started.worktree, cleanup: true }, c.context());
  assert.equal(finished.ok, true, 'the real finish ran: ' + JSON.stringify(finished.error ?? {}));
  const text = render(finished);
  assert.match(text, /^OK {2}finish/u);
  assert.match(text, /committed/u);
  assert.match(text, /pushed/u);
  assert.match(text, /no pull request: /u, 'the origin is a bare directory, so the GitHub half is skipped');
  assert.match(text, /worktree removed/u, 'cleanup: true removes the worktree it just pushed');

  // The pr title: the real client, with only the transport doubled. Before the
  // fix the summary dropped the title, so the line the renderer prints was never
  // set by anybody.
  const served = serve([
    { match: '/pulls?', method: 'GET', status: 200, body: [] },
    {
      match: '/pulls',
      method: 'POST',
      status: 201,
      body: {
        number: 12,
        html_url: 'https://github.com/octo/repo/pull/12',
        state: 'open',
        draft: false,
        title: 'feat: a titled pull request',
      },
    },
  ]);
  t.after(() => served.restore());
  const client = createGithubClient({ host: 'github.com' });
  const opened = await client.upsertPull({
    owner: 'octo',
    repo: 'repo',
    head: 'dsh/task',
    base: 'main',
    title: 'feat: a titled pull request',
  });
  assert.equal(opened.ok, true, 'the create ran: ' + JSON.stringify(opened.error ?? {}));
  assert.equal(opened.title, 'feat: a titled pull request', 'the client reports the title the API returned');
  const prText = render({
    action: 'pr',
    ok: true,
    created: true,
    number: opened.number,
    url: opened.url,
    state: opened.state,
    draft: opened.draft,
    title: opened.title,
    branch: 'dsh/task',
    base: 'main',
  });
  assert.ok(prText.includes('feat: a titled pull request'), 'the rendered pr result names the pull request');
  assert.ok(prText.includes('dsh/task -> main'), 'and the branches it points between');
});
