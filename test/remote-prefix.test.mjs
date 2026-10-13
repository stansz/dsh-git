/**
 * A listing from GitHub is a prefix match, so the namespace boundary has to be
 * re-applied where the answer is used.
 *
 * The local rules now require branchPrefix to end at a separator, but the
 * remote-only sweep does not get its list from git: it asks GitHub's
 * git/matching-refs endpoint, which returns every ref that STARTS WITH the
 * string. With a custom prefix that has no slash (task), that listing also
 * carries a user branch named taskforce - and the sweep deletes a listed branch
 * whose merged pull request covers its tip. So the boundary has to be checked
 * again before a listed name is considered, which is what this case pins.
 *
 * Only the transport and the credential are doubled, exactly as the other
 * GitHub cases in this suite do. The matching-refs answer has the shape the real
 * endpoint has, and the DELETE really removes the branch from the fixture's bare
 * origin, so "the user branch survives" is read from real refs rather than from
 * a call log.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { git, makeCase } from './helpers.mjs';

const OWNER = 'stansz';
const REPO = 'dsh-git';
const GITHUB_URL = 'https://github.com/' + OWNER + '/' + REPO + '.git';
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

/** A JSON response, the way the API sends one. */
const jsonResponse = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/**
 * Serve the three calls this path makes, over the real client.
 *
 * @param {object} c - the case, for its bare origin.
 * @param {{listed: string[], tip: string, merged: string[]}} options - the branch
 *   names the matching-refs endpoint returns, the commit they all point at, and
 *   which of them a merged pull request covers.
 */
function serveGithub(c, options) {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  const calls = [];
  process.env.GH_TOKEN = 'ghp_' + 'a'.repeat(36);
  globalThis.fetch = async (url, request = {}) => {
    const href = String(url);
    const method = String(request?.method ?? 'GET').toUpperCase();
    calls.push(method + ' ' + href);

    if (href.includes('/git/matching-refs/heads/')) {
      return jsonResponse(options.listed.map((name) => ({ ref: 'refs/heads/' + name, object: { sha: options.tip } })), 200);
    }
    if (method === 'DELETE' && href.includes('/git/refs/heads/')) {
      // The API removes the ref; here that is real git on the fixture's remote,
      // so the survival assertions below are about a ref that exists or does not.
      const branch = decodeURIComponent(href.slice(href.indexOf('/git/refs/heads/') + '/git/refs/heads/'.length));
      git(c.originDir, ['branch', '-D', branch]);
      return new Response(null, { status: 204 });
    }
    if (href.includes('/pulls?')) {
      const head = decodeURIComponent((/head=([^&]*)/u.exec(href)?.[1] ?? ''));
      const branch = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
      if (!options.merged.includes(branch)) return jsonResponse([], 200);
      return jsonResponse([{
        number: 8,
        html_url: GITHUB_URL.replace(/\.git$/u, '') + '/pull/8',
        state: 'closed',
        merged_at: '2026-10-12T21:00:00Z',
        merge_commit_sha: 'c0'.repeat(20),
        head: { ref: branch, sha: options.tip },
        base: { ref: 'main' },
      }], 200);
    }
    return jsonResponse({ message: 'Not Found' }, 404);
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

test('a custom prefix does not sweep a remote branch that only starts with it', async (t) => {
  const c = makeCase('remote-prefix-sweep');
  t.after(() => c.cleanup());
  const config = resolveConfig({ ...c.config, branchPrefix: 'task' });
  const tip = git(c.repoDir, ['rev-parse', 'HEAD']);

  // The branches live only on the remote: the remote-only sweep is the path
  // under test, and a local ref would send them down the local rules instead.
  git(c.originDir, ['branch', 'taskforce', tip]);
  git(c.originDir, ['branch', 'task/one', tip]);

  // Origin looks like GitHub to the plugin, while git itself is served the
  // fixture's bare repository by a real ssh wrapper. core.sshCommand is not URL
  // rewriting, which matters: git remote get-url expands url.insteadOf, so that
  // route would hide the GitHub URL from the plugin. This way the plugin parses
  // the GitHub URL and ls-remote still answers without leaving the machine.
  git(c.repoDir, ['remote', 'set-url', 'origin', 'ssh://git@github.com/' + OWNER + '/' + REPO + '.git']);
  const sshWrapper = join(c.root, 'ssh-wrapper.sh');
  writeFileSync(sshWrapper, '#!/bin/sh\nexec git-upload-pack ' + c.originDir + '\n', 'utf8');
  chmodSync(sshWrapper, 0o755);
  git(c.repoDir, ['config', 'core.sshCommand', sshWrapper]);
  const first = git(c.repoDir, ['ls-remote', '--heads', 'origin', 'refs/heads/taskforce']).trim().split(/\s+/u)[0];
  assert.equal(first, tip, 'the local remote still answers through the rewrite');

  const api = serveGithub(c, { listed: ['taskforce', 'task/one', 'main'], tip, merged: ['taskforce', 'task/one'] });
  t.after(() => api.restore());

  const swept = await runAction('prune', { action: 'prune', repo: c.repoDir, apply: true }, c.context({ config }));
  assert.equal(swept.ok, true, 'the sweep ran: ' + JSON.stringify(swept.error ?? {}));
  assert.deepEqual(
    (swept.mergedBranches ?? []).map((entry) => entry.branch),
    ['task/one'],
    'only the branch inside the namespace is a deletion candidate (deletes asked for: '
      + api.calls.filter((call) => call.startsWith('DELETE ')).join(', ') + ')',
  );
  assert.deepEqual(
    api.calls.filter((call) => call.startsWith('DELETE ')),
    ['DELETE ' + API + '/git/refs/heads/task/one'],
    'the delete is never requested for a name the boundary excludes',
  );

  const remoteHeads = git(c.originDir, ['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n');
  assert.ok(remoteHeads.includes('refs/heads/taskforce'), 'the merged user branch survives, with its remote ref untouched');
  assert.ok(!remoteHeads.includes('refs/heads/task/one'), 'and the branch that really was the plugin own is gone');
});
