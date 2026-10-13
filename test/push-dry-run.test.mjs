/**
 * D38: a push dry run writes nothing, so it reads.
 *
 * `git push --dry-run` (and its short spelling `-n`) does everything except
 * send. The guard already treats that shape as a read elsewhere: `git clean -n`,
 * `git fetch --dry-run` and `git gc --dry-run`. A push dry run was refused and
 * told to use the git tool instead, which is a hangup for a command that cannot
 * change anything.
 *
 * A real push stays refused, force or not. The one spelling that must NOT be
 * excused is `--no-dry-run` after a dry run: git's last flag wins, and that
 * command really pushes. The last test measures that against a bare remote.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveConfig } from '../lib/config.mjs';
import { evaluate } from '../lib/guard.mjs';
import { git, makeCase } from './helpers.mjs';

const config = resolveConfig({});

/** The verdict for a command line, as the pre-execute hook would compute it. */
function decide(command) {
  return evaluate({ name: 'bash', arguments: { command } }, config);
}

/** Just the kind. */
function kindOf(command) {
  return decide(command).kind;
}

/**
 * Run git and return stdout AND stderr together. helpers.git returns stdout
 * only, and a push reports on stderr, which is exactly the output the dry-run
 * case has to read to show it considered the update.
 */
function gitOutput(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + String(result.stderr).trim());
  return (result.stdout || '') + (result.stderr || '');
}

test('D38: a dry-run push reads, whatever else it names', () => {
  const dryRuns = [
    'git push --dry-run origin main',
    'git push --dry-run',
    'git push -n origin main',
    'git push -n',
    'git push --dry-run --force origin main',
    'git push --dry-run --delete origin main',
    'git push --dry-run --mirror',
    'git push --no-dry-run --dry-run origin main',
    'git push --dry-run --no-dry-run --dry-run origin main',
  ];
  for (const command of dryRuns) {
    assert.equal(kindOf(command), 'allow', command + ' sends nothing, so it must not be gated');
  }
  // The previews that already read for the same reason stay reads.
  for (const command of ['git clean -n', 'git fetch --dry-run origin', 'git gc --dry-run']) {
    assert.equal(kindOf(command), 'allow', command + ' is the same kind of preview');
  }
  // And the real form of each of those is still gated.
  for (const command of ['git clean -fd', 'git fetch --prune origin', 'git gc']) {
    assert.equal(kindOf(command), 'deny', command + ' changes the repository');
  }
});

test('D38: every real push is still refused, and the negation is not excused', () => {
  const refusals = [
    ['git push origin main', /protected branch/u],
    ['git push', /action "push"/u],
    ['git push --force origin main', /overwrites remote history/u],
    ['git push --delete origin main', /removes remote refs/u],
    ['git push --mirror', /removes remote refs/u],
    ['git push --no-dry-run origin main', /protected branch/u],
    ['git push --dry-run --no-dry-run origin main', /protected branch/u],
    ['git push -n --no-dry-run origin main', /protected branch/u],
  ];
  for (const [command, named] of refusals) {
    const decision = decide(command);
    assert.equal(decision.kind, 'deny', command + ' reaches the remote and must be refused');
    assert.match(decision.reason, named, command + ' must keep its own reason, not a dry-run pass');
  }
  // The dry run of the same force push is the one that reads: nothing is sent.
  assert.equal(kindOf('git push --dry-run --force origin main'), 'allow');
});

test('D38: real git proves the premise — a dry-run push leaves the remote exactly where it was', (t) => {
  const c = makeCase('push-dry-run');
  t.after(() => c.cleanup());

  // A commit the remote does not have.
  writeFileSync(join(c.repoDir, 'README.md'), '# fixture, second commit\n');
  git(c.repoDir, ['add', 'README.md']);
  git(c.repoDir, ['commit', '-m', 'second commit, unpushed']);
  const remoteBefore = git(c.originDir, ['rev-parse', 'refs/heads/main']);
  const local = git(c.repoDir, ['rev-parse', 'HEAD']);
  assert.notEqual(local, remoteBefore, 'the fixture really has an unpushed commit');

  // The dry run reports the update it would make and changes nothing.
  const preview = gitOutput(c.repoDir, ['push', '--dry-run', 'origin', 'main']);
  assert.match(preview, new RegExp(local.slice(0, 7)), 'the dry run reports the commit it would send');
  assert.equal(git(c.originDir, ['rev-parse', 'refs/heads/main']), remoteBefore, 'the remote ref did not move');
  assert.equal(kindOf('git push --dry-run origin main'), 'allow');

  // -n is the same flag, and a negation BEFORE a dry run leaves it a dry run.
  const dashN = gitOutput(c.repoDir, ['push', '-n', 'origin', 'main']);
  assert.match(dashN, new RegExp(local.slice(0, 7)), 'the short spelling reports the same update');
  assert.equal(git(c.originDir, ['rev-parse', 'refs/heads/main']), remoteBefore, 'and writes nothing either');
  git(c.repoDir, ['push', '--no-dry-run', '--dry-run', 'origin', 'main']);
  assert.equal(git(c.originDir, ['rev-parse', 'refs/heads/main']), remoteBefore, 'the last flag says dry run');

  // --no-dry-run AFTER a dry run is a real push: the last flag wins, and the
  // guard must not excuse it with the dry-run flag in front of it.
  git(c.repoDir, ['push', '--dry-run', '--no-dry-run', 'origin', 'main']);
  assert.equal(git(c.originDir, ['rev-parse', 'refs/heads/main']), local, 'the real push moved the remote');
  assert.equal(kindOf('git push --dry-run --no-dry-run origin main'), 'deny');

  // A last dry run after a negation is a dry run again, measured the same way.
  writeFileSync(join(c.repoDir, 'README.md'), '# fixture, third commit\n');
  git(c.repoDir, ['add', 'README.md']);
  git(c.repoDir, ['commit', '-m', 'third commit, unpushed']);
  const beforeThird = git(c.originDir, ['rev-parse', 'refs/heads/main']);
  assert.notEqual(git(c.repoDir, ['rev-parse', 'HEAD']), beforeThird, 'there is something to push again');
  git(c.repoDir, ['push', '--dry-run', '--no-dry-run', '--dry-run', 'origin', 'main']);
  assert.equal(git(c.originDir, ['rev-parse', 'refs/heads/main']), beforeThird, 'the last flag is a dry run');
  assert.equal(kindOf('git push --dry-run --no-dry-run --dry-run origin main'), 'allow');

  // The plain push the guard refuses is the one that would move it.
  assert.equal(kindOf('git push origin main'), 'deny');
  assert.equal(kindOf('git push --force origin main'), 'deny');
});
