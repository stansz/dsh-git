#!/usr/bin/env node
/**
 * The worktree root has to be a directory the agent can actually write to.
 *
 * `worktreeRoot` used to default to `$DSH_HOME/worktrees`. A Harness file sandbox
 * writes only inside the session workspace, so that default produced a guard that
 * refused an edit and then pointed at a directory that could not be written to.
 * With `autoWorktree: protected` that is every edit, which makes the plugin
 * unusable rather than merely awkward.
 *
 * The default is now derived from the session's own workspace. Three directions are
 * asserted: derived when unset, honoured when set, and — end to end through the
 * `start` action — actually created under the derived root.
 *
 *   node scripts/worktree-root-test.mjs
 *
 * Runs anywhere: no network, no credentials. Paths are realpath'd because that is
 * the bug class this code keeps hitting — on macOS `/var/folders` is
 * `/private/var/folders`, and a string comparison between them is always false.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig, worktreeRootFor } from '../lib/config.mjs';

const failures = [];
let assertions = 0;
const check = (condition, message) => { assertions += 1; if (!condition) failures.push(message); };

const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-home-')));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-workspace-')));
const previousHome = process.env.DSH_HOME;

const gitIn = (dir, args) => execFileSync(
  'git',
  ['-c', 'user.email=worktree-root-test@example.invalid', '-c', 'user.name=worktree-root-test',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

try {
  // The Harness home is deliberately a directory a sandbox would not allow writes to.
  process.env.DSH_HOME = home;
  const config = resolveConfig({});

  // 1. unset: derived from the session workspace, never from $DSH_HOME.
  const derived = worktreeRootFor(config, workspace);
  check(derived === join(workspace, '.worktrees'), 'unset worktreeRoot must derive from the session workspace, got ' + derived);
  check(!derived.startsWith(home), 'derived root must not sit under $DSH_HOME (' + home + '), got ' + derived);

  // 2. set: an explicit value still wins.
  const explicitRoot = join(workspace, 'elsewhere');
  const explicit = worktreeRootFor(resolveConfig({ worktreeRoot: explicitRoot }), workspace);
  check(explicit === explicitRoot, 'an explicit worktreeRoot must win, got ' + explicit);

  // 3. end to end: the `start` action creates the worktree under the derived root.
  const repo = join(workspace, 'repo');
  const origin = join(workspace, 'origin.git');
  mkdirSync(repo, { recursive: true });
  gitIn(workspace, ['init', '--bare', origin]);
  gitIn(repo, ['init']);
  writeFileSync(join(repo, 'a.txt'), 'a');
  gitIn(repo, ['add', 'a.txt']);
  gitIn(repo, ['commit', '-m', 'first']);
  gitIn(repo, ['remote', 'add', 'origin', origin]);
  gitIn(repo, ['push', '-u', 'origin', 'main']);

  const started = await runAction('start', { slug: 'root-check', repo }, { config, reference: workspace, sessionId: 'worktree-root-test' });
  check(started.ok === true, 'start failed: ' + JSON.stringify(started.error ?? started));
  const created = started.ok === true ? String(started.worktree ?? '') : '';
  check(created !== '', 'start returned no worktree path');
  check(
    created.startsWith(join(workspace, '.worktrees')),
    'the worktree must be created under <session workspace>/.worktrees, got ' + created,
  );
  check(!created.startsWith(home), 'the worktree must not be created under $DSH_HOME, got ' + created);
} catch (error) {
  failures.push('fixture failed: ' + String(error && error.message ? error.message : error));
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('worktree-root-test: ' + String(failures.length) + ' failure(s)');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('worktree-root-test: OK - ' + String(assertions) + ' assertions; the worktree root lands inside the session workspace by default');
