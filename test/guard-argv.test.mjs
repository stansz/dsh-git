/**
 * The bash guard's argv parse — D9 and D10, and the read/write split they fix.
 *
 * evaluate() is the function the Host calls on every bash tool call, so these
 * cases drive it exactly as it is driven there: a ToolExecution with a command,
 * and the resolved configuration. The command text is the whole input, which is
 * why a table that mistakes an option VALUE for a flag turns a forced clean into
 * a read and a tag creation into a deletion.
 *
 * D9: the classifier used to match every token of the argument list. The forms
 * in the first tests below were measured against the pre-change library as
 * ALLOWED mutating commands; the false denials in the same family are pinned
 * beside them. The last test drives real git to show that the premise is what
 * git itself does with those command lines.
 *
 * D10: thirteen subcommands were filtered out of both the mutating and the
 * unknown path, so their mutating forms were silently allowed — including
 * `git config --add core.hooksPath <dir>`, whose hook runs on the next git
 * command and therefore outside this guard entirely. They keep every read form
 * they had; their mutating forms are refused, with a reason that says the tool
 * has no action for the operation and names `guardMode` as the escape hatch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveConfig } from '../lib/config.mjs';
import { evaluate } from '../lib/guard.mjs';
import { exists, git, makeCase } from './helpers.mjs';

const config = resolveConfig({});

/** The verdict for a command line, as the pre-execute hook would compute it. */
function decide(command, overrides) {
  const settings = overrides === undefined ? config : resolveConfig(overrides);
  return evaluate({ name: 'bash', arguments: { command } }, settings);
}

/** Just the kind. */
function kindOf(command) {
  return decide(command).kind;
}

test('D9: the six forms the pre-change guard allowed are gated', () => {
  const gated = [
    'git clean -fenode_modules -d', // -f plus the attached value of -e
    'git stash push -m list', // a save whose message is "list"
    'git worktree add -b list ../wt', // the new branch is named "list"
    'git bundle create verify --all', // the output file is named verify
    'git submodule deinit --force status', // the submodule path is named status
    'git branch --edit-description', // writes the branch description
  ];
  for (const command of gated) {
    assert.equal(kindOf(command), 'deny', command + ' must not read as a read');
  }
});

test('D9: the mirrored false denials are classified on their real flags', () => {
  const tag = decide("git tag -m '--delete' v1");
  assert.equal(tag.kind, 'deny', 'a tag creation is still refused');
  assert.match(tag.reason, /creation in bash is gated/u, 'a tag whose MESSAGE is --delete is a creation');
  assert.doesNotMatch(tag.reason, /deleting a tag/u, 'and not a deletion');

  const stash = decide('git stash push -m drop');
  assert.equal(stash.kind, 'deny');
  assert.match(stash.reason, /is gated/u, 'a stash SAVE is gated, not denied as a drop');
  assert.doesNotMatch(stash.reason, /drop/u, 'the message is not the verb');

  const push = decide('git push -o -f origin main');
  assert.equal(push.kind, 'deny', 'a raw push is still refused');
  assert.match(push.reason, /protected branch/u, 'the decision comes from the real target, main');
  assert.doesNotMatch(push.reason, /overwrites remote history/u, '-f is the value of -o, so this is not a force push');

  const long = decide('git push -o --force origin main');
  assert.equal(long.kind, 'deny');
  assert.match(long.reason, /protected branch/u);
  assert.doesNotMatch(long.reason, /overwrites remote history/u);
});

test('D9: the same defect in the shapes an independent verifier measured', () => {
  const gated = [
    'git tag -m --list v1',
    'git tag -m -l v1',
    'git tag -m -d v2',
    'git tag v1 -m --list',
    'git tag -- v1',
    'git branch -- foo',
    'git stash push -m show',
    'git stash push list',
    'git bundle create list-heads --all',
    'git worktree add list ../wt',
    'git config alias.zz --get',
    'git config core.hooksPath /tmp/h --add',
    'git clean -e --dry-run -f -d',
    'git clean -e -n -f -d',
    'git symbolic-ref -m "-d" HEAD refs/heads/x',
  ];
  for (const command of gated) {
    assert.equal(kindOf(command), 'deny', command + ' mutates and must be gated');
  }
  // `git tag -m -d v2` and `git tag -m --list v1` are the same action as a
  // creation, decided by a letter inside a message.
  assert.match(decide('git tag -m -d v2').reason, /creation in bash is gated/u);
  assert.match(decide('git tag -m --list v1').reason, /creation in bash is gated/u);
  // `git submodule status --force deinit` is a usage error in git 2.54 with
  // nothing deinitialised (measured), so the guard leaves the form alone; the
  // mutating spelling, `git submodule deinit --force status`, is gated above.
  assert.equal(kindOf('git submodule status --force deinit'), 'allow');
});

test('D9: a value spelled exactly like the dry-run flag does not make a forced clean a dry run', () => {
  // `-e --dry-run` makes "--dry-run" the EXCLUDE PATTERN. There is no dry run
  // at all: the clean is forced. The old scan matched the token wherever it
  // appeared, which is the shape worth remembering — the value is spelled
  // exactly like the flag that would have excused the command.
  assert.equal(kindOf('git clean -e --dry-run -f -d'), 'deny');
  assert.equal(kindOf('git clean -e -n -f -d'), 'deny');
  assert.equal(kindOf('git clean --exclude --dry-run -fd'), 'deny');
  assert.match(decide('git clean -e --dry-run -f -d').reason, /clean/u);
  // The real dry run, with the same option carrying a value, still reads.
  assert.equal(kindOf('git clean -n -e node_modules -d'), 'allow');
});

test('D9: a value option inside a short cluster, and the same letters as real flags', () => {
  // `-am --list`: -a, then -m takes the following token as the message.
  const spaced = decide('git tag -am --list v1');
  assert.equal(spaced.kind, 'deny');
  assert.match(spaced.reason, /creation in bash is gated/u);
  // `-m-d`: the message is the attached "-d".
  const attached = decide('git tag -m-d v1');
  assert.equal(attached.kind, 'deny');
  assert.match(attached.reason, /creation in bash is gated/u);
  // The same cluster letters as genuine flags are still genuine flags.
  const deleted = decide('git tag -ad v1');
  assert.equal(deleted.kind, 'deny');
  assert.match(deleted.reason, /deleting a tag/u);
});

test('D10: every measured mutating form of a subcommand the tool has no action for denies', () => {
  const mutating = [
    'git config --add core.hooksPath /tmp/h',
    'git config set core.hooksPath /tmp/h',
    'git remote set-url origin https://example.invalid/x.git',
    'git reflog delete HEAD@{1}',
    'git notes remove HEAD',
    'git submodule add https://example.invalid/s.git sub',
    'git submodule update --init',
    'git gc',
    'git gc --prune=now',
    'git repack -ad',
    'git maintenance run',
    'git lfs push origin main',
    'git sparse-checkout set src',
    'git send-email --to someone@example.invalid',
    'git tag v1.0',
    'git format-patch HEAD~1',
    'git notes add -m note HEAD',
  ];
  for (const command of mutating) {
    assert.equal(kindOf(command), 'deny', command + ' changes the repository and must be gated');
  }
});

test('D10: the read forms stay allowed, and the mutations beside them still deny', () => {
  const reads = [
    'git tag',
    'git tag -l',
    'git tag --list',
    'git tag -v v1',
    'git tag --verify v1',
    'git tag -n5',
    'git tag --merged HEAD',
    'git remote',
    'git remote -v',
    'git remote show origin',
    'git remote get-url origin',
    'git config --get user.email',
    'git config --list',
    'git config -l',
    'git config get user.email',
    'git config list',
    'git config user.email',
    'git reflog',
    'git reflog show HEAD',
    'git reflog exists HEAD',
    'git notes list',
    'git notes show HEAD',
    'git notes get-ref',
    'git submodule status',
    'git submodule summary',
    'git sparse-checkout list',
    'git gc --dry-run',
    'git lfs ls-files',
    'git lfs env',
    'git lfs status',
    'git lfs version',
    'git format-patch --stdout HEAD~1',
    'git send-email --dump-aliases',
  ];
  for (const command of reads) {
    assert.equal(kindOf(command), 'allow', command + ' reads and must not be gated');
  }
  // The subcommands whose mutations were dropped are not now read wholesale.
  for (const command of ['git tag v1.0', 'git gc', 'git lfs push origin main', 'git sparse-checkout set src']) {
    assert.equal(kindOf(command), 'deny', command + ' is the mutating form of a read subcommand');
  }
});

test('D10: the refusal says the tool has no action for it, and names guardMode', () => {
  const cases = [
    ['config', 'git config --add core.hooksPath /tmp/h'],
    ['remote', 'git remote set-url origin https://example.invalid/x.git'],
    ['notes', 'git notes remove HEAD'],
    ['reflog', 'git reflog delete HEAD@{1}'],
    ['submodule', 'git submodule add https://example.invalid/s.git sub'],
    ['gc', 'git gc'],
    ['repack', 'git repack -ad'],
    ['maintenance', 'git maintenance run'],
    ['lfs', 'git lfs push origin main'],
    ['sparse-checkout', 'git sparse-checkout set src'],
    ['tag', 'git tag v1.0'],
    ['format-patch', 'git format-patch HEAD~1'],
    ['send-email', 'git send-email --to someone@example.invalid'],
  ];
  for (const [subcommand, command] of cases) {
    const decision = decide(command);
    assert.equal(decision.kind, 'deny', command);
    assert.match(decision.reason, new RegExp('has no `' + subcommand + '` action'), command + ' must not pretend the tool can do it');
    assert.match(decision.reason, /guardMode/u, command + ' must name the deliberate escape hatch');
    assert.match(decision.reason, /action "/u, command + ' must still name an action the tool has');
  }
  // The security case says why it matters: a hooks path runs on the next command.
  const configDecision = decide('git config --add core.hooksPath /tmp/h');
  assert.match(configDecision.reason, /core.hooksPath/u);
  assert.match(configDecision.reason, /bypasses this guard/u);
});

test('D10: an unclassifiable form of these subcommands still asks, and guardAsk decides it', () => {
  for (const command of [
    'git remote frobnicate',
    'git notes frobnicate',
    'git reflog frobnicate',
    'git submodule foreach echo',
    'git something-nobody-has-classified',
  ]) {
    assert.equal(kindOf(command), 'ask', command + ' is not a form the tables resolve, so a person decides');
  }

  const denied = decide('git remote frobnicate', { guardAsk: 'deny' });
  assert.equal(denied.kind, 'deny', 'an unattended deployment refuses instead of stalling');
  assert.match(denied.reason, /guardAsk/u);
  assert.equal(decide('git remote frobnicate', { guardAsk: 'allow' }).kind, 'allow');

  // The policy is only about the unclassifiable case: reads read, and mutations
  // are refused whatever the setting says.
  assert.equal(decide('git tag', { guardAsk: 'deny' }).kind, 'allow');
  assert.equal(decide('git gc', { guardAsk: 'allow' }).kind, 'deny');
});

test('D9: real git confirms the premises — a value is a value', (t) => {
  const c = makeCase('guard-argv-premise');
  t.after(() => c.cleanup());

  // `git clean -fenode_modules -d` is a FORCED clean. The attached value of -e
  // is "node_modules", so nothing is held back: the untracked file goes, the
  // excluded directory stays.
  mkdirSync(join(c.repoDir, 'node_modules'), { recursive: true });
  writeFileSync(join(c.repoDir, 'node_modules', 'keep.txt'), 'kept\n');
  writeFileSync(join(c.repoDir, 'scratch.txt'), 'gone\n');
  git(c.repoDir, ['clean', '-fenode_modules', '-d']);
  assert.equal(exists(join(c.repoDir, 'scratch.txt')), false, 'the forced clean really deleted the untracked file');
  assert.equal(exists(join(c.repoDir, 'node_modules', 'keep.txt')), true, 'and -e really excluded node_modules');
  assert.equal(kindOf('git clean -fenode_modules -d'), 'deny');

  // `git tag -m '--delete' v1` creates a tag whose MESSAGE is "--delete".
  git(c.repoDir, ['tag', '-m', '--delete', 'v1']);
  assert.equal(git(c.repoDir, ['tag', '-l', 'v1']), 'v1');
  assert.match(git(c.repoDir, ['cat-file', '-p', 'v1']), /--delete/u);
  assert.equal(kindOf("git tag -m '--delete' v1"), 'deny');

  // The attached spelling is the same thing: the message is "-d".
  git(c.repoDir, ['tag', '-m-d', 'v2']);
  assert.match(git(c.repoDir, ['cat-file', '-p', 'v2']), /-d/u);
  assert.equal(kindOf('git tag -m-d v2'), 'deny');

  // `git push -o -f origin main` is NOT a force push. git consumes -f as the
  // value of -o, so the non-fast-forward update is refused and the remote does
  // not move. That is why the guard refuses it as a push to a protected branch
  // rather than as a force push.
  git(c.originDir, ['config', 'receive.advertisePushOptions', 'true']);
  const remoteBefore = git(c.originDir, ['rev-parse', 'refs/heads/main']);
  writeFileSync(join(c.repoDir, 'rewritten.txt'), 'x\n');
  git(c.repoDir, ['add', 'rewritten.txt']);
  git(c.repoDir, ['commit', '--amend', '-m', 'chore: rewritten']);
  assert.notEqual(git(c.repoDir, ['rev-parse', 'HEAD']), remoteBefore, 'the local history really moved');
  assert.throws(() => git(c.repoDir, ['push', '-o', '-f', 'origin', 'main']), 'git refuses the non-fast-forward update');
  assert.equal(git(c.originDir, ['rev-parse', 'refs/heads/main']), remoteBefore, 'the remote ref did not move');
  assert.equal(kindOf('git push -o -f origin main'), 'deny');
});
