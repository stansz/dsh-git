/**
 * A task branch is a branch inside the namespace, not a branch whose name begins
 * with the same letters.
 *
 * The rule is written down in two modules: isInsideBranchPrefix in worktrees.mjs
 * (the sweep, the merge retire and the named prune) and isTaskBranch in
 * config.mjs (the automatic push decision). With a configured prefix of task, a
 * plain startsWith claimed a user branch named taskforce in both; the push half
 * is what this file exists for, and the last case pins both copies against the
 * rule as a table so they cannot drift apart again.
 *
 * The worktrees copy is reached through a namespace import and compared only
 * when that revision exports it: it lands with the same batch of work as this
 * rule, so a checkout that predates it has one copy and no drift to check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isTaskBranch, resolveConfig } from '../lib/config.mjs';
import { pushDecision } from '../lib/turn-commit.mjs';
import * as worktrees from '../lib/worktrees.mjs';

/**
 * The rule, written out: a name is inside a prefix when the prefix, with its
 * trailing slashes gone, is a whole leading path segment of the name.
 */
function rule(name, prefix) {
  let trimmed = typeof prefix === 'string' ? prefix : '';
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return typeof name === 'string' && name !== '' && trimmed !== '' && name.startsWith(trimmed + '/');
}

test('a prefix without a slash does not claim a user branch that starts with it', () => {
  const config = resolveConfig({ branchPrefix: 'task' });
  assert.equal(config.branchPrefix, 'task', 'the case configured the prefix');

  assert.equal(isTaskBranch(config, 'taskforce'), false, 'taskforce is a user branch, not a task branch');
  assert.equal(isTaskBranch(config, 'taskforce/one'), false, 'nor is anything under it');
  assert.equal(isTaskBranch(config, 'task/one'), true, 'task/one is inside the namespace');
  assert.equal(isTaskBranch(config, 'task'), false, 'the prefix alone is not a branch inside it');
  assert.equal(isTaskBranch(config, 'main'), false);
});

test('the default namespace still claims its own branches, and only its own', () => {
  const config = resolveConfig({});
  assert.equal(config.branchPrefix, 'dsh/', 'the default prefix keeps its slash');
  assert.equal(isTaskBranch(config, 'dsh/fix-the-thing'), true);
  assert.equal(isTaskBranch(config, 'dsh'), false);
  assert.equal(isTaskBranch(config, 'dshx/one'), false);
  assert.equal(isTaskBranch(config, 'main'), false);
  // A trailing slash is how people write a prefix, not part of the rule.
  assert.equal(isTaskBranch(resolveConfig({ branchPrefix: 'dsh' }), 'dsh/one'), true);
  assert.equal(isTaskBranch(resolveConfig({ branchPrefix: 'dsh/' }), 'dsh/one'), true);
});

test('a nested prefix is a namespace too', () => {
  const config = resolveConfig({ branchPrefix: 'agent/task' });
  assert.equal(isTaskBranch(config, 'agent/task/one'), true);
  assert.equal(isTaskBranch(config, 'agent/taskforce'), false);
  assert.equal(isTaskBranch(config, 'agent/task'), false);
  assert.equal(isTaskBranch(config, 'agent'), false);
});

test('an empty prefix is an empty namespace, not a wildcard', () => {
  // resolveConfig refuses to set an empty prefix, so this is the shape a hand
  // built config could still have; every branch has to answer no.
  assert.equal(isTaskBranch({ branchPrefix: '' }, 'main'), false);
  assert.equal(isTaskBranch({ branchPrefix: '/' }, 'main'), false);
  assert.equal(isTaskBranch({}, 'main'), false);
  assert.equal(isTaskBranch(undefined, 'main'), false);
  assert.equal(isTaskBranch({ branchPrefix: 'task' }, undefined), false);
  assert.equal(isTaskBranch({ branchPrefix: 'task' }, ''), false);
});

test('the automatic push decision refuses the user branch the old rule would have pushed', () => {
  const config = resolveConfig({ branchPrefix: 'task' });

  const user = pushDecision(config, 'taskforce', []);
  assert.equal(user.allowed, false, 'taskforce must not be auto-pushed');
  assert.match(user.reason, /not a task branch/u);

  const own = pushDecision(config, 'task/one', []);
  assert.equal(own.allowed, true, 'a real task branch is still safe to push');
  assert.equal(own.reason, 'task branch');

  // The two other answers the push rule gives are unchanged: the branch of a
  // worktree this session owns is safe whatever its name, and a protected branch
  // is refused whatever the prefix says.
  assert.equal(pushDecision(config, 'feature', ['feature']).allowed, true);
  assert.equal(pushDecision(config, 'main', []).allowed, false);
});

test('every copy of the rule answers the same thing for every name', (t) => {
  const prefixes = ['dsh/', 'dsh', 'task', 'task/', 'agent/task', 'agent/task/', '/', ''];
  const names = [
    'dsh/one', 'dshx', 'dshx/one', 'dsh', 'task/one', 'taskforce', 'taskforce/one', 'task',
    'agent/task/x', 'agent/taskforce', 'agent/tas', 'agent', 'main', 'other/x', '', undefined,
  ];
  const shared = typeof worktrees.isInsideBranchPrefix === 'function' ? worktrees.isInsideBranchPrefix : undefined;
  if (shared === undefined) {
    t.diagnostic('this revision does not export worktrees.isInsideBranchPrefix; the config copy was compared to the rule as written here');
  }
  for (const prefix of prefixes) {
    const config = { branchPrefix: prefix };
    for (const name of names) {
      const expected = rule(name, prefix);
      assert.equal(
        isTaskBranch(config, name),
        expected,
        'config.isTaskBranch disagrees with the rule for prefix "' + prefix + '" and name "' + String(name) + '"',
      );
      if (shared !== undefined) {
        assert.equal(
          shared(name, prefix),
          expected,
          'worktrees.isInsideBranchPrefix disagrees with the rule for prefix "' + prefix + '" and name "' + String(name) + '"',
        );
      }
    }
  }
});
