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
    'git check-ref-format --branch dsh/x',
    'git fsck --no-progress',
    'git archive HEAD',
    'git bundle list-heads base.bundle',
    'git bundle verify base.bundle',
    'git hash-object README.md',
    'git bisect log',
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

test('the readers that write in one form are gated in that form', () => {
  const writes = [
    'git bundle create base.bundle main',
    'git bundle unbundle base.bundle',
    'git hash-object -w README.md',
    'git fsck --lost-found',
    'git bisect start',
    'git bisect bad',
  ];
  for (const command of writes) {
    assert.equal(verdict(command), 'deny', command + ' writes, so it is refused rather than read');
  }
  // The read form of the same subcommand is not caught by the same rule.
  assert.equal(verdict('git bisect log'), 'allow');
  assert.equal(verdict('git bundle verify base.bundle'), 'allow');
  assert.equal(verdict('git hash-object README.md'), 'allow');
});

test('guardAsk decides what happens to a command the guard cannot classify', () => {
  const command = 'git something-nobody-has-classified';
  const decide = (guardAsk) => evaluate({ name: 'bash', arguments: { command } }, resolveConfig({ guardAsk }));

  assert.equal(decide(undefined).kind, 'ask', 'the default leaves the decision to a person');
  assert.equal(decide('allow').kind, 'allow');

  const denied = decide('deny');
  assert.equal(denied.kind, 'deny', 'an unattended deployment refuses instead of stalling');
  assert.match(denied.reason, /guardAsk/u, 'and says which setting refused it');
  assert.match(String(denied.displayReason), /deny/u);

  // A malformed value is not a way to relax the guard.
  assert.equal(decide('yes-please').kind, 'ask');

  // The policy is only about the unclassifiable case: reads still read, and what
  // discards work is refused whatever it says.
  for (const guardAsk of ['ask', 'deny', 'allow']) {
    const config = resolveConfig({ guardAsk });
    const kindOf = (cmd) => evaluate({ name: 'bash', arguments: { command: cmd } }, config).kind;
    assert.equal(kindOf('git status'), 'allow');
    assert.equal(kindOf('git commit -am x'), 'deny');
    assert.equal(kindOf('git reset --hard'), 'deny');
  }
});
