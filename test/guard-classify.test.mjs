/**
 * The bash guard's classification table.
 *
 * evaluate() is the function the Host calls on every shell tool call, so these
 * cases drive it exactly as it is driven there: a ToolExecution with a command,
 * and the resolved configuration. The command *text* is the whole input, which
 * is why this suite is the natural place to pin the three verdicts — a table
 * that quietly loses a read-only subcommand turns a read into a prompt, and a
 * table that quietly gains one turns a mutation into a silent pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../lib/config.mjs';
import { evaluate } from '../lib/guard.mjs';

const config = resolveConfig({});

/** The verdict for a command line, as the pre-execute hook would compute it. */
function verdict(command) {
  return evaluate({ name: 'bash', arguments: { command } }, config).kind;
}

test('read-only git is allowed, including the plumbing a session asks for', () => {
  const reads = [
    'git status',
    'git diff HEAD',
    'git log --oneline -5',
    'git show --stat HEAD',
    'git worktree list',
    'git fetch origin',
    'git rev-parse --show-toplevel',
    'git for-each-ref --format=%(refname)',
    'git rev-list --count main..HEAD',
    'git rev-list --left-right --count origin/main...HEAD',
    'git diff-tree --no-commit-id --name-only -r HEAD',
    'git diff-index --name-only HEAD',
    'git diff-files --name-only',
    'git show-branch --list',
    'git verify-tag v1.0.0',
    'git var GIT_AUTHOR_IDENT',
    'git annotate -L 1,5 lib/guard.mjs',
    'git patch-id --stable',
  ];
  for (const command of reads) {
    assert.equal(verdict(command), 'allow', command + ' must not be gated');
  }
});

test('mutating git is refused, and names the tool action instead', () => {
  const mutating = ['git commit -am x', 'git add -A', 'git push origin main', 'git checkout -b x', 'git stash', 'git pull', 'git merge other'];
  for (const command of mutating) {
    const decision = evaluate({ name: 'bash', arguments: { command } }, config);
    assert.equal(decision.kind, 'deny', command + ' must be refused, not offered for approval');
    assert.match(String(decision.displayReason), /git tool|action/u, command + ' must name the replacement');
  }
});

test('the commands that discard work are denied', () => {
  for (const command of ['git reset --hard', 'git clean -fd', 'git push --force origin main', 'git branch -D dsh/x', 'git filter-branch --all', 'git reflog expire --expire=now --all']) {
    assert.equal(verdict(command), 'deny', command + ' must be denied');
  }
});

test('a denial anywhere refuses the whole command line', () => {
  assert.equal(verdict('git status && git reset --hard'), 'deny');
  assert.equal(verdict('git status; git commit -m x'), 'deny');
  assert.equal(verdict('git -C /somewhere push --force'), 'deny');
});

test('a subcommand the table cannot classify is asked about, never denied', () => {
  assert.equal(verdict('git something-nobody-has-classified'), 'ask');
  assert.equal(verdict('echo hello'), 'allow');
  assert.equal(verdict('git status') === 'allow' && verdict('ls -la') === 'allow', true);
});
