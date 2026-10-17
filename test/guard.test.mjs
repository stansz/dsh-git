/**
 * The guard: the documented policy, checked against the classifier.
 *
 * The guard is a pure function of a tool call and a configuration, so these
 * tests need no repository. They are written as the policy tables in
 * docs/guard.md read: the everyday flow is redirected at the tool action that
 * does the same job, work-discarding commands are refused, and everything else —
 * setup, maintenance, reads, dry runs — runs.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../lib/guard.mjs';

const BASE = {
  guardMode: 'redirect',
  guardAsk: 'ask',
  guardTools: ['bash', 'pwsh'],
  protectedBranches: [],
};

/** The verdict for one shell command. */
function verdict(command, overrides = {}) {
  return evaluate({ name: 'bash', arguments: { command } }, { ...BASE, ...overrides });
}

/** Assert that a command is redirected, naming the action that does the job. */
function redirected(command, action, overrides) {
  const result = verdict(command, overrides);
  assert.equal(result.kind, 'deny', command + ' should be denied, got ' + result.kind);
  assert.match(result.reason, new RegExp('action "' + action + '"'), command + ': ' + result.reason);
  return result;
}

/** Assert that a command is refused, and the reason says what is lost. */
function refused(command, overrides) {
  const result = verdict(command, overrides);
  assert.equal(result.kind, 'deny', command + ' should be denied, got ' + result.kind);
  assert.ok(result.reason.length > 40, command + ': the refusal should explain itself: ' + result.reason);
  return result;
}

/** Assert that a command runs untouched. */
function allowed(command, overrides) {
  const result = verdict(command, overrides);
  assert.equal(result.kind, 'allow', command + ' should be allowed, got ' + result.reason);
  return result;
}

/* ================================================================== */
describe('reads and ordinary commands run', () => {
  for (const command of [
    'git status',
    'git status --short',
    'git log --oneline -5',
    'git diff',
    'git diff --staged',
    'git show HEAD',
    'git remote -v',
    'git branch --list',
    'git branch --show-current',
    'git rev-parse HEAD',
    'git --version',
    'git stash list',
  ]) {
    test(command, () => allowed(command));
  }

  test('non-git commands are not the guard business', () => {
    allowed('ls -la');
    allowed('npm test');
    allowed('node --test');
    allowed('echo "git commit -m x"');
  });
});

/* ================================================================== */
describe('the everyday flow is redirected at the tool', () => {
  test('add and commit point at save', () => {
    redirected('git add -A', 'save');
    redirected('git add file.txt', 'save');
    redirected('git commit -m "x"', 'save');
    redirected('git commit -am "x"', 'save');
  });

  test('push points at publish', () => {
    redirected('git push', 'publish');
    redirected('git push -u origin task/x', 'publish');
    redirected('git push origin main', 'publish');
  });

  test('pull and fetch point at sync', () => {
    redirected('git pull', 'sync');
    redirected('git pull --rebase', 'sync');
    redirected('git fetch', 'sync');
    redirected('git fetch --prune origin', 'sync');
  });

  test('rebase points at sync with rebase: true', () => {
    const result = redirected('git rebase origin/main', 'sync');
    assert.match(result.reason, /rebase: true/);
  });

  test('the redirect explains the same outcome, not just a denial', () => {
    const result = verdict('git commit -m "x"');
    assert.match(result.reason, /session changed|paths/);
  });
});

/* ================================================================== */
describe('work-discarding commands are refused', () => {
  test('a hard reset and its relatives', () => {
    refused('git reset --hard');
    refused('git reset --hard HEAD~3');
    refused('git reset --merge');
    refused('git reset --keep');
  });

  test('clean deletes untracked work; a dry run does not', () => {
    refused('git clean -fd');
    refused('git clean -xdf');
    allowed('git clean -n');
    allowed('git clean --dry-run');
  });

  test('a force push overwrites published history', () => {
    refused('git push --force');
    refused('git push --force-with-lease');
    refused('git push -f origin main');
    refused('git push origin +main');
    refused('git push --delete origin task');
    refused('git push --mirror origin');
  });

  test('a force branch delete loses unmerged commits', () => {
    refused('git branch -D task');
    allowed('git branch -d task');
  });

  test('checkout and restore over paths discard uncommitted edits', () => {
    refused('git checkout -- file.txt');
    refused('git switch -- file.txt');
    refused('git restore file.txt');
    allowed('git restore --staged file.txt');
    allowed('git checkout -b new-branch');
  });

  test('dropping a stash deletes work that exists nowhere else', () => {
    refused('git stash drop');
    refused('git stash clear');
    allowed('git stash');
    allowed('git stash pop');
  });

  test('re-pointing a tag rewrites what a release means', () => {
    refused('git tag -f v1.0');
    allowed('git tag v1.0');
    allowed('git tag -d v1.0');
  });

  test('history rewrites are refused', () => {
    refused('git filter-branch --all');
    refused('git update-ref refs/heads/x HEAD');
    refused('git reflog expire --expire=now --all');
  });

  test('object deletion with a short horizon is refused', () => {
    refused('git gc --prune=now');
    refused('git prune');
    allowed('git gc');
    allowed('git repack -ad');
    allowed('git prune -n');
    allowed('git prune --dry-run');
  });
});

/* ================================================================== */
describe('setup and maintenance run', () => {
  for (const command of [
    'git config credential.helper osxkeychain',
    'git config user.name "Someone"',
    'git remote set-url origin git@github.com:o/r.git',
    'git remote add upstream https://github.com/o/r.git',
    'git tag v1.0',
    'git stash',
    'git stash pop',
    'git checkout -b task',
    'git checkout task',
    'git merge origin/main',
    'git clone https://github.com/o/r.git',
    'git worktree add ../other task',
    'git submodule update --init',
    'git lfs install',
    'git cherry-pick abc123',
  ]) {
    test(command, () => allowed(command));
  }

  test('an override never downgrades a refusal', () => {
    allowed('GIT_PAGER=cat git log');
    allowed('git -c core.pager=less log');
    refused('git -c core.pager=less reset --hard');
  });
});

/* ================================================================== */
describe('dry runs run', () => {
  test('push --dry-run sends nothing', () => {
    allowed('git push --dry-run origin main');
    allowed('git push -n origin main');
  });

  test('the last dry-run flag decides', () => {
    refused('git push --dry-run --no-dry-run origin main');
  });
});

/* ================================================================== */
describe('wrappers', () => {
  test('a trusted shell is inspected', () => {
    refused('bash -c "git reset --hard"');
    redirected('bash -c "git commit -m x"', 'save');
  });

  test('a wrapper whose inner text peeked work loss is refused', () => {
    refused('xargs git push --force');
    refused('sh -c "git reset --hard"');
    refused('find . -name x -exec git clean -fd {} ;');
  });

  test('a harmless wrapper is allowed', () => {
    allowed('xargs git status');
    allowed('env git status');
  });

  test('guardAsk: allow accepts even the peeked case', () => {
    allowed('xargs git push --force', { guardAsk: 'allow' });
    allowed('sh -c "git reset --hard"', { guardAsk: 'allow' });
  });
});

/* ================================================================== */
describe('modes and tool coverage', () => {
  test('off and warn allow everything, by definition', () => {
    allowed('git reset --hard', { guardMode: 'off' });
    allowed('git reset --hard', { guardMode: 'warn' });
    allowed('git commit -m x', { guardMode: 'warn' });
  });

  test('only the tools the configuration names are inspected', () => {
    assert.equal(evaluate({ name: 'pwsh', arguments: { command: 'git commit -m x' } }, BASE).kind, 'deny');
    assert.equal(
      evaluate({ name: 'pwsh', arguments: { command: 'git commit -m x' } }, { ...BASE, guardTools: ['bash'] }).kind,
      'allow',
    );
    assert.equal(
      evaluate({ name: 'write', arguments: { command: 'git commit -m x' } }, BASE).kind,
      'allow',
    );
  });

  test('a protected branch is named when a raw push targets it', () => {
    const result = refused('git push origin main', { protectedBranches: ['main'] });
    assert.match(result.reason, /protected branch main/);
    const normal = verdict('git push origin main', { protectedBranches: [] });
    assert.equal(normal.kind, 'deny');
    assert.doesNotMatch(normal.reason, /protected branch main/);
  });

  test('malformed calls are allowed rather than crashing the guard', () => {
    assert.equal(evaluate(undefined, BASE).kind, 'allow');
    assert.equal(evaluate({ name: 'bash' }, BASE).kind, 'allow');
    assert.equal(evaluate({ name: 'bash', arguments: {} }, BASE).kind, 'allow');
    assert.equal(evaluate({ name: 'bash', arguments: { command: '' } }, BASE).kind, 'allow');
    assert.equal(evaluate({ name: 'bash', arguments: { command: 42 } }, BASE).kind, 'allow');
    assert.equal(evaluate({ name: 'bash', arguments: { command: 'git commit' } }, null).kind, 'deny');
  });
});

/* ================================================================== */
describe('several commands in one line', () => {
  test('one gated command poisons the line', () => {
    refused('git status && git commit -m x');
    refused('git status; git reset --hard');
    refused('git log | head -3; git clean -fd');
  });

  test('a line with no gated command runs', () => {
    allowed('git status && git log --oneline -3');
    allowed('git fetch --dry-run && git status');
  });
});
