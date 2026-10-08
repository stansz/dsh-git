#!/usr/bin/env node
/**
 * Prune must tell scratch apart from work.
 *
 * The worktree root can end up inside the repository, and everything under it is the
 * plugin's own scratch — yet the turn sync used to stage it. So a merged task branch
 * could carry a `dsh: turn N` commit whose entire content is a fixture directory.
 * "Holds commits of its own" counted those, which kept the branch forever and kept
 * the sync pushing it back to the remote after every merge.
 *
 * Both directions are asserted, because this rule decides whether to destroy a
 * branch: one whose only extra commits touch the scratch is removable, and one with a
 * single real file is not. The second assertion is the one that matters — `prune`
 * deleting a branch that holds work would be the worst bug this plugin could have.
 *
 *   node scripts/prune-test.mjs
 *
 * Runs anywhere: no network, no credentials.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';

const failures = [];
let assertions = 0;
const check = (condition, message) => { assertions += 1; if (!condition) failures.push(message); };

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-prune-')));
const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-prune-home-')));
const previousHome = process.env.DSH_HOME;

const gitIn = (dir, args) => execFileSync(
  'git',
  ['-c', 'user.email=prune-test@example.invalid', '-c', 'user.name=prune-test',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

try {
  process.env.DSH_HOME = home;

  const repo = join(workspace, 'repo');
  mkdirSync(repo, { recursive: true });
  gitIn(repo, ['init']);
  writeFileSync(join(repo, 'a.txt'), 'a\n', 'utf8');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'first']);

  // A branch whose only extra commit is scratch — what a merged branch looked like
  // after the turn sync staged a suite's fixture worktree.
  gitIn(repo, ['checkout', '-q', '-b', 'dsh/junk']);
  mkdirSync(join(repo, '.worktrees', 'dsh-git-check-abc123'), { recursive: true });
  writeFileSync(join(repo, '.worktrees', 'dsh-git-check-abc123', 'fixture.txt'), 'x\n', 'utf8');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'dsh: turn 9']);

  // A branch with real work on it: prune must never touch this one.
  gitIn(repo, ['checkout', '-q', 'main']);
  gitIn(repo, ['checkout', '-q', '-b', 'dsh/real']);
  writeFileSync(join(repo, 'real.txt'), 'real\n', 'utf8');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'real work']);
  gitIn(repo, ['checkout', '-q', 'main']);

  const config = resolveConfig({ worktreeRoot: join(workspace, '.worktrees'), stateRoot: join(workspace, 'state') });
  const context = { config, reference: workspace, sessionId: 'prune-test' };

  const dry = await runAction('prune', { repo }, context);
  check(dry.ok === true, 'prune failed: ' + JSON.stringify(dry.error ?? dry));

  const byBranch = new Map((dry.branches ?? []).map((entry) => [entry.branch, entry]));
  const junk = byBranch.get('dsh/junk');
  const real = byBranch.get('dsh/real');

  check(junk !== undefined, 'the scratch-only branch must be reported at all');
  check(junk?.kept !== true, 'a branch whose only extra commits are scratch must be removable, got: ' + JSON.stringify(junk));
  check(/scratch/u.test(junk?.reason ?? ''), 'the reason must name the scratch, got: ' + JSON.stringify(junk?.reason));

  check(real !== undefined, 'the branch with real work must be reported');
  check(real?.kept === true, 'a branch with real work must be kept, got: ' + JSON.stringify(real));
  check(gitIn(repo, ['branch', '--list', 'dsh/junk']).trim() !== '', 'a dry run must not delete a branch');

  const applied = await runAction('prune', { repo, apply: true }, context);
  check(applied.ok === true, 'prune apply failed: ' + JSON.stringify(applied.error ?? applied));

  const left = gitIn(repo, ['branch', '--format=%(refname:short)']);
  check(!left.split('\n').includes('dsh/junk'), 'the scratch-only branch must be gone after apply, still have: ' + JSON.stringify(left));
  check(left.split('\n').includes('dsh/real'), 'the branch with real work must survive apply, got: ' + JSON.stringify(left));
  // 3. A squash merge leaves a branch that no local rule can recognise: the content is
  //    in the base, the commits are not. With a GitHub remote and a merge on record,
  //    prune removes it — and only it. The API is stubbed at `fetch`, the seam `send`
  //    uses, so this stays a test that needs no network.
  gitIn(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  gitIn(repo, ['checkout', '-q', '-b', 'dsh/squashed']);
  writeFileSync(join(repo, 'squashed.txt'), 'squashed\n', 'utf8');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'work that was squashed']);
  gitIn(repo, ['checkout', '-q', 'main']);

  const asked = [];
  const realFetch = globalThis.fetch;
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'prune-test-token';
  globalThis.fetch = async (url) => {
    const target = String(url);
    asked.push(target);
    // Only `dsh/squashed` has a merged pull request on record.
    const merged = target.includes(encodeURIComponent('example:dsh/squashed'));
    return {
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify(merged
        ? [{ number: 42, html_url: 'https://github.com/example/repo/pull/42', merged_at: '2026-10-07T00:00:00Z' }]
        : []),
    };
  };

  try {
    const viaGithub = await runAction('prune', { repo, apply: true }, context);
    check(viaGithub.ok === true, 'prune with GitHub failed: ' + JSON.stringify(viaGithub.error ?? viaGithub));
    check(asked.length > 0, 'prune must have asked GitHub about the branches it kept');

    const after = gitIn(repo, ['branch', '--format=%(refname:short)']);
    check(!after.split('\n').includes('dsh/squashed'), 'a branch with a merged pull request must be removed, still have: ' + JSON.stringify(after));
    check(after.split('\n').includes('dsh/real'), 'a branch with no merge on record must survive, got: ' + JSON.stringify(after));
  } finally {
    globalThis.fetch = realFetch;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  }
} catch (error) {
  failures.push('fixture failed: ' + String(error && error.message ? error.message : error));
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('prune-test: ' + String(failures.length) + ' failure(s)');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('prune-test: OK - ' + String(assertions) + ' assertions; scratch-only commits are not work, and a branch holding work is never deleted');
