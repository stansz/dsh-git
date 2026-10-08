#!/usr/bin/env node
/**
 * The plugin's scratch must never be committable.
 *
 * The worktree root defaults to `<session workspace>/.worktrees`. That is usually
 * outside the repository, but a session can treat a repository as its workspace, and
 * then the root sits *inside* the working tree. Everything under it is the plugin's
 * own scratch, yet `git status` reports it as untracked content and the turn sync
 * stages everything `git status` reports.
 *
 * That is how fixture worktrees left by a test suite became `dsh: turn N` commits on
 * task branches, and how eight fixture files reached `main` through a squash merge.
 *
 * So `createWorktree` writes the root into the repository's `.git/info/exclude` —
 * per-clone, untracked, invisible to `.gitignore` and to the user's diffs.
 *
 * Both directions are asserted: the rule appears when the root is inside the
 * repository, and *nothing* is written when it is outside. A rule that is always
 * installed would be a rule that silently ignores somebody's real directory.
 *
 *   node scripts/scratch-exclude-test.mjs
 *
 * Runs anywhere: no network, no credentials.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';

const failures = [];
let assertions = 0;
const check = (condition, message) => { assertions += 1; if (!condition) failures.push(message); };

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-exclude-')));
const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-exclude-home-')));
const previousHome = process.env.DSH_HOME;

const gitIn = (dir, args) => execFileSync(
  'git',
  ['-c', 'user.email=scratch-exclude-test@example.invalid', '-c', 'user.name=scratch-exclude-test',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
const status = (dir) => gitIn(dir, ['status', '--porcelain']);
const excludeFile = (dir) => {
  const raw = gitIn(dir, ['rev-parse', '--git-common-dir']).trim();
  return join(raw.startsWith('/') ? raw : join(dir, raw), 'info', 'exclude');
};

const makeRepo = (name) => {
  const dir = join(workspace, name);
  mkdirSync(dir, { recursive: true });
  gitIn(dir, ['init']);
  writeFileSync(join(dir, 'a.txt'), 'a\n', 'utf8');
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-qm', 'first']);
  return dir;
};

try {
  process.env.DSH_HOME = home;

  // 1. The root is inside the repository — the case that put junk in main.
  const inside = makeRepo('inside');
  const insideRoot = join(inside, '.worktrees');
  const config = resolveConfig({ worktreeRoot: insideRoot, stateRoot: join(workspace, 'state') });

  const started = await runAction('start', { slug: 'scratch', repo: inside }, { config, reference: workspace, sessionId: 'scratch-exclude-test' });
  check(started.ok === true, 'start failed: ' + JSON.stringify(started.error ?? started));

  const file = excludeFile(inside);
  const written = existsSync(file) ? readFileSync(file, 'utf8') : '';
  check(
    written.split('\n').some((line) => line.trim() === '/.worktrees/'),
    'the exclude file must carry the anchored directory pattern, got: ' + JSON.stringify(written),
  );

  const dirty = status(inside);
  check(
    !dirty.split('\n').some((line) => line.includes('.worktrees')),
    'git status must not report the scratch root, got: ' + JSON.stringify(dirty),
  );

  // The control: an ordinary new file is still visible. A rule that hid everything
  // would pass the assertion above and be useless.
  writeFileSync(join(inside, 'real-work.txt'), 'content\n', 'utf8');
  check(
    status(inside).includes('real-work.txt'),
    'an ordinary new file must still be reported by git status',
  );

  // 2. The root is outside the repository — nothing may be written.
  const outside = makeRepo('outside');
  const outsideConfig = resolveConfig({ worktreeRoot: join(workspace, 'elsewhere'), stateRoot: join(workspace, 'state') });
  const startedOutside = await runAction('start', { slug: 'scratch', repo: outside }, { config: outsideConfig, reference: workspace, sessionId: 'scratch-exclude-test' });
  check(startedOutside.ok === true, 'start with an outside root failed: ' + JSON.stringify(startedOutside.error ?? startedOutside));

  const outsideFile = excludeFile(outside);
  const outsideWritten = existsSync(outsideFile) ? readFileSync(outsideFile, 'utf8') : '';
  check(
    !outsideWritten.includes('.worktrees'),
    'a root outside the repository must not install an exclude rule, got: ' + JSON.stringify(outsideWritten),
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
  console.error('scratch-exclude-test: ' + String(failures.length) + ' failure(s)');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('scratch-exclude-test: OK - ' + String(assertions) + ' assertions; the scratch root is excluded inside a repository, and untouched outside one');
