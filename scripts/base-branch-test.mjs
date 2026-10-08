#!/usr/bin/env node
/**
 * The base branch has to be the branch that was asked for.
 *
 * `finish` skipped its pull request with "base must be a non-empty string (got \"\")",
 * which left the worktree un-closed and made every later `finish` fail the same way.
 * The cause was operator precedence, not logic:
 *
 *   text(args?.base) ?? config.baseBranch !== '' ? config.baseBranch : default()
 *
 * parses as `(text(args?.base) ?? (config.baseBranch !== '')) ? ... : ...`, because
 * `??` binds tighter than `?:`. An explicit `base` therefore selected the configured
 * branch instead, and the configured branch defaults to `''` — so the base handed to
 * the GitHub client was empty.
 *
 * Four actions carried that expression; they now call one helper. This asserts the
 * order the helper resolves, and that the worktree path really uses it.
 *
 *   node scripts/base-branch-test.mjs
 *
 * Runs anywhere: no network, no credentials.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBaseBranch, runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';

const failures = [];
let assertions = 0;
const check = (condition, message) => { assertions += 1; if (!condition) failures.push(message); };

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-base-')));
const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-base-home-')));
const previousHome = process.env.DSH_HOME;

const gitIn = (dir, args) => execFileSync(
  'git',
  ['-c', 'user.email=base-branch-test@example.invalid', '-c', 'user.name=base-branch-test',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

try {
  process.env.DSH_HOME = home;

  const repo = join(workspace, 'repo');
  mkdirSync(repo, { recursive: true });
  gitIn(repo, ['init']);
  writeFileSync(join(repo, 'a.txt'), 'a');
  gitIn(repo, ['add', 'a.txt']);
  gitIn(repo, ['commit', '-m', 'first']);
  gitIn(repo, ['checkout', '-b', 'topic']);
  writeFileSync(join(repo, 'b.txt'), 'b');
  gitIn(repo, ['add', 'b.txt']);
  gitIn(repo, ['commit', '-m', 'second']);
  gitIn(repo, ['checkout', 'main']);

  const empty = resolveConfig({});

  // 1. The regression. An explicit base must win, and must never be empty when the
  //    configured baseBranch is '' — that empty string is the whole bug.
  const explicit = await resolveBaseBranch({ base: 'topic' }, empty, repo);
  check(explicit === 'topic', 'an explicit base must win, got ' + JSON.stringify(explicit));
  check(explicit !== '', 'an explicit base must never resolve to the empty string');

  // 2. With no argument, the configured baseBranch is used.
  const configured = await resolveBaseBranch({}, resolveConfig({ baseBranch: 'topic' }), repo);
  check(configured === 'topic', 'a configured baseBranch must be used, got ' + JSON.stringify(configured));

  // 3. With neither, the repository's own default branch.
  const fallback = await resolveBaseBranch({}, empty, repo);
  check(fallback === 'main', 'the repository default must be the fallback, got ' + JSON.stringify(fallback));

  // 4. A blank argument is not a choice — it falls through like an absent one.
  const blank = await resolveBaseBranch({ base: '   ' }, empty, repo);
  check(blank === 'main', 'a blank base must fall through, got ' + JSON.stringify(blank));

  // 5. End to end: `start` cuts the worktree from the branch it was asked for, so the
  //    helper is not merely correct in isolation.
  const started = await runAction('start', { slug: 'base-probe', repo, base: 'topic' }, { config: empty, reference: workspace, sessionId: 'base-branch-test' });
  check(started.ok === true, 'start failed: ' + JSON.stringify(started.error ?? started));
  const created = started.ok === true ? String(started.worktree ?? '') : '';
  check(created !== '', 'start returned no worktree path');
  check(
    created !== '' && existsSync(join(created, 'b.txt')),
    'the worktree must be cut from `topic`, so b.txt must exist in ' + created,
  );
} catch (error) {
  failures.push('fixture failed: ' + String(error && error.message ? error.message : error));
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('base-branch-test: ' + String(failures.length) + ' failure(s)');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('base-branch-test: OK - ' + String(assertions) + ' assertions; the base branch resolves explicit > configured > repository default');
