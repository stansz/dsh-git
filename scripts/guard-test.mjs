#!/usr/bin/env node
/**
 * The guard's classification table, asserted directly.
 *
 * The guard decides whether a `bash` call may run raw git, and every wrong
 * answer has a cost in a different direction. Too permissive and the behaviour
 * this bundle exists to stop comes back. Too strict and the user switches the
 * guard off, which protects nothing — so the read-only commands that merely look
 * dangerous are asserted as loudly as the destructive ones that are.
 *
 * `evaluate` is a pure function precisely so this file can exist: a decision
 * reachable only through a live Host is a decision nobody tests.
 *
 *   node scripts/guard-test.mjs
 */

import { evaluate, findGitInvocations, MUTATING_SUBCOMMANDS, DESTRUCTIVE_SUBCOMMANDS } from '../lib/guard.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { ACTIONS } from '../lib/actions.mjs';

const failures = [];
let passed = 0;

/** A `bash` execution as the tools layer presents it. */
const bash = (command) => ({ name: 'bash', arguments: { command }, signal: new AbortController().signal });

/**
 * Assert one command's decision.
 *
 * `ask` and `deny` are both "blocked" from the model's point of view, so the
 * kind is asserted exactly rather than loosely: a destructive command reaching
 * `ask` would let a user approve away work other sessions hold in a worktree.
 */
function expect(kind, command, note = '') {
  const decision = evaluate(bash(command), resolveConfig({}));
  const label = (kind + '  ' + command + (note !== '' ? '   (' + note + ')' : '')).padEnd(62);
  if (decision.kind !== kind) {
    failures.push('expected ' + kind + ' but got ' + decision.kind + ' for: ' + command);
    console.log('FAIL ' + label + ' -> ' + decision.kind);
    return;
  }
  if (kind !== 'allow') {
    if (typeof decision.reason !== 'string' || decision.reason.trim() === '') {
      failures.push(kind + ' with no reason for: ' + command);
      console.log('FAIL ' + label + ' -> no reason');
      return;
    }
    if (typeof decision.displayReason !== 'string' || decision.displayReason.trim() === '') {
      failures.push(kind + ' with no displayReason for: ' + command);
      console.log('FAIL ' + label + ' -> no displayReason');
      return;
    }
  }
  passed += 1;
  console.log('PASS ' + label + ' -> ' + decision.kind);
}

console.log('--- read-only: must be allowed, including the ones that look destructive ---');
for (const command of [
  'git status',
  'git status --porcelain',
  'git log --oneline -5',
  'git diff --stat',
  'git show HEAD',
  'git branch -l',
  'git branch --list',
  'git branch -v',
  'git branch -a',
  'git tag -l',
  'git tag',
  'git remote -v',
  'git remote show origin',
  'git clean -n',
  'git clean --dry-run',
  'git worktree list',
  'git stash list',
  'git stash show',
  'git reflog',
  'git rev-parse --abbrev-ref HEAD',
  'git config --get user.email',
  'git ls-files',
  'git blame README.md',
  'git fetch --dry-run',
  'git describe --tags',
  // No tool action exists for these, so gating them would produce a prompt whose
  // answer is "not supported" — worse than leaving the command alone.
  'git tag v1.2.3',
  'git tag -a v1 -m x',
  'git remote add origin https://example.invalid/r.git',
  'git config user.email x@example.invalid',
  'git submodule update --init',
  'git gc --auto',
  'git notes add -m x',
  'git lfs pull',
]) expect('allow', command);

console.log('\n--- mutating: must ask, and the reason must name the replacement ---');
for (const command of [
  'git commit -m "x"',
  'git add -A',
  'git add .',
  'git push',
  'git push -u origin feature/x',
  'git checkout main',
  'git switch -c thing',
  'git merge main',
  'git stash',
  'git branch newthing',
  'git mv a.txt b.txt',
  'git restore .',
  'git pull',
  'git cherry-pick abc123',
  'git worktree add ../x',
]) expect('ask', command);

console.log('\n--- destructive: must deny, and no reason may point at a replacement that does not exist ---');
for (const command of [
  'git reset --hard HEAD~1',
  'git reset --soft HEAD~1',
  'git reset',
  'git clean -fd',
  'git clean -xdf',
  'git push --force',
  'git push -f origin main',
  'git push --force-with-lease',
  'git push --mirror',
  'git push --delete origin old',
  'git branch -D feature',
  'git branch -d feature',
  'git tag -d v1',
  'git filter-branch --tree-filter true HEAD',
  'git worktree remove --force /tmp/wt',
  'git reflog expire --expire=now --all',
  'git update-ref refs/heads/main HEAD~1',
  'git stash drop',
  'git stash clear',
]) expect('deny', command);

console.log('\n--- ordering: a deny anywhere outranks an ask anywhere ---');
expect('deny', 'git status && git reset --hard', 'read then destructive');
expect('deny', 'git push; git clean -fd', 'mutating then destructive');
expect('ask', 'git status && git push', 'read then mutating');

console.log('\n--- wrappers and environment forms ---');
expect('ask', 'cd /tmp && git commit -m x', 'chained after cd');
expect('ask', 'sudo git push', 'sudo stripped');
expect('allow', 'git -C /repo status', '-C before subcommand');
expect('ask', 'git -C /repo commit -m x', '-C before subcommand');
expect('deny', 'git -C /repo reset --hard', '-C before destructive');
expect('ask', 'git -c user.name=x commit -m y', '-c before subcommand');
expect('ask', 'git --git-dir=/r/.git push', '--git-dir before subcommand');
expect('deny', 'bash -c "git push --force"', 'bash -c unwrapped');
expect('ask', 'bash -c "git commit -m x"', 'bash -c unwrapped');
expect('ask', 'sh -c "git commit -m x"', 'sh -c is not reliably inspectable');
expect('ask', 'eval "git reset --hard"', 'eval is not reliably inspectable');
expect('ask', 'xargs git push', 'xargs is not reliably inspectable');
// `push` is the operation the git tool owns and the one whose tool form refuses
// a protected branch, so every push form asks or denies. A dry run is harmless
// on its own, but exempting it would open the gap the guard exists to close:
// `--dry-run --force` reads identically at a glance.
expect('ask', 'git push --dry-run', 'the push form the tool owns, dry run or not');
expect('deny', 'git push --dry-run --force', 'a destructive flag outranks the dry run');
expect('deny', 'git push --delete origin main', 'deleting a remote branch');

console.log('\n--- data is not a command ---');
expect('allow', 'echo "git push --force"', 'quoted text, not an invocation');
expect('allow', 'printf "run git reset --hard"', 'quoted text, not an invocation');
expect('allow', 'cat <<EOF\ngit push --force\nEOF', 'here-document body');
expect('allow', 'grep -r "git reset" .', 'a search pattern');
expect('allow', 'ls -la', 'not git at all');
expect('allow', 'npm run build', 'not git at all');
expect('allow', 'echo "git commit"', 'quoted text');

console.log('\n--- configuration changes the answer, not the classification ---');
const off = evaluate(bash('git reset --hard'), resolveConfig({ guardMode: 'off' }));
if (off.kind !== 'allow') { failures.push('guardMode off did not allow a destructive command'); console.log('FAIL guardMode off -> ' + off.kind); } else { passed += 1; console.log('PASS guardMode off -> allow'); }

const warn = evaluate(bash('git reset --hard'), resolveConfig({ guardMode: 'warn' }));
if (warn.kind !== 'allow') { failures.push('guardMode warn did not allow a destructive command'); console.log('FAIL guardMode warn -> ' + warn.kind); } else { passed += 1; console.log('PASS guardMode warn -> allow'); }

const otherTool = evaluate({ name: 'read', arguments: {} }, resolveConfig({}));
if (otherTool.kind !== 'allow') { failures.push('a non-guarded tool was not allowed'); console.log('FAIL non-guarded tool -> ' + otherTool.kind); } else { passed += 1; console.log('PASS a non-guarded tool -> allow'); }

const customTools = evaluate(bash('git reset --hard'), resolveConfig({ guardTools: ['shell'] }));
if (customTools.kind !== 'allow') { failures.push('guardTools did not limit which tools are guarded'); console.log('FAIL guardTools -> ' + customTools.kind); } else { passed += 1; console.log('PASS guardTools narrows the guard -> allow'); }

console.log('\n--- the classification is inspectable, not just a decision ---');
const found = findGitInvocations('git status && git push --force');
if (found.length !== 2) {
  failures.push('findGitInvocations found ' + String(found.length) + ' invocations in a two-command line');
  console.log('FAIL findGitInvocations -> ' + String(found.length));
} else {
  passed += 1;
  console.log('PASS findGitInvocations -> ' + found.map((entry) => entry.class + ':' + String(entry.subcommand)).join(', '));
}

console.log('\n--- the reason actually points somewhere useful ---');
const commitDecision = evaluate(bash('git commit -m x'), resolveConfig({}));
if (!/commit/u.test(commitDecision.reason)) {
  failures.push('the commit reason does not name the commit action: ' + commitDecision.reason);
  console.log('FAIL commit reason -> ' + commitDecision.reason);
} else {
  passed += 1;
  console.log('PASS commit reason -> ' + commitDecision.reason.slice(0, 120));
}
const resetDecision = evaluate(bash('git reset --hard'), resolveConfig({}));
if (resetDecision.reason.trim() === '') {
  failures.push('the reset reason is empty');
} else {
  passed += 1;
  console.log('PASS reset reason -> ' + resetDecision.reason.slice(0, 120));
}

// The reason is only useful if the action it names exists. This is the drift
// check the guard module cannot make for itself: it is written before the tool
// is, and a reason that says `action "cleanup"` would send the model at a
// command that does not exist — worse than no message at all.
console.log('\n--- every action a reason names is a real action ---');
const realActions = new Set(Object.keys(ACTIONS));
for (const command of [...MUTATING_SUBCOMMANDS, ...DESTRUCTIVE_SUBCOMMANDS]) {
  const decision = evaluate(bash('git ' + command), resolveConfig({}));
  if (decision.kind === 'allow') continue;
  for (const match of String(decision.reason ?? '').matchAll(/action "([a-z-]+)"/gu)) {
    const named = match[1];
    if (!realActions.has(named)) {
      failures.push('the reason for `git ' + command + '` names action "' + named + '", which does not exist');
      console.log('FAIL ' + command + ' -> names "' + named + '"');
    } else {
      passed += 1;
      console.log('PASS ' + command + ' -> names "' + named + '"');
    }
  }
}

// `merge` is the case that caught a real agent. Its next step used to point at
// `sync`, which only fast-forwards and cannot join a diverged branch — so the
// advice named a path that could not finish the job, and the agent concluded no
// action existed and used raw git instead. The path is asserted now.
console.log('\n--- the merge advice names a path that can finish the job ---');
const mergeDecision = evaluate(bash('git merge main'), resolveConfig({}));
const mergeReason = String(mergeDecision.reason ?? '');
if (!(/action "push"/u.test(mergeReason) && /action "pr"/u.test(mergeReason) && /action "merge"/u.test(mergeReason))) {
  failures.push('the merge reason does not name the push -> pr -> merge path: ' + mergeReason);
  console.log('FAIL merge advice -> ' + mergeReason);
} else {
  passed += 1;
  console.log('PASS merge advice -> names push, pr and merge');
}

console.log('\n' + String(passed) + ' passed, ' + String(failures.length) + ' failed');
if (failures.length > 0) {
  console.error('\n' + failures.join('\n'));
  process.exit(1);
}
console.log('The guard allows reads, asks before mutations, and denies anything that discards work.');
