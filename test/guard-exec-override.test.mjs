/**
 * D31: a read command that tells git to run a program.
 *
 * The guard classifies a command line. A read is allowed because reading is
 * safe, but git reads by running things: `GIT_EXTERNAL_DIFF` is executed by
 * `git diff`, `GIT_PAGER` and `PAGER` by a paging command, `-c core.hooksPath=<dir>`
 * installs a hook that runs on the next ref update, `-c alias.x='!...'` runs a
 * shell command, `include.path` pulls in a config file that can name any of
 * them, and `--exec-path=<dir>` or `--upload-pack=<program>` choose the
 * program git runs. A line the tables call read-only can therefore carry raw
 * git that this guard exists to refuse.
 *
 * These cases pin three things: the measured overrides ask, never allow; an
 * unrelated `-c` or environment assignment stays a plain allow; and a mutation
 * behind an override is still refused rather than merely asked. The last test
 * drives real git to show the premise: the programs really run.
 *
 * The reason must be its own. "Git run through a wrapper" would be false, because
 * nothing is wrapped; git is being told what to run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
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

/** Run git with extra environment, for the premise test. */
function gitEnv(cwd, args, extraEnv) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  }).trim();
}

/**
 * Run git with the pager variables cleared, unless the case sets them itself, so
 * the machine's own GIT_PAGER cannot decide the answer. `git var GIT_PAGER` is
 * git's own answer to "which program would you run", and it needs no terminal.
 */
function gitEnvNoPager(cwd, args, extraEnv) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv };
  for (const key of ['GIT_PAGER', 'PAGER', 'GIT_PAGER_IN_USE']) {
    if (!(key in extraEnv)) delete env[key];
  }
  return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
}

/** An executable that records that git ran it. */
function fakeProgram(path, marker) {
  writeFileSync(path, '#!/bin/sh\nprintf ran > ' + marker + '\n');
  chmodSync(path, 0o755);
}

/** The measured lines, each with the name its reason must carry. */
const OVERRIDES = [
  ["git -c core.pager='sh -c evil' log", /core\.pager/u],
  ["GIT_PAGER='sh -c evil' git log", /GIT_PAGER/u],
  ["PAGER='sh -c evil' git log", /PAGER/u],
  ['GIT_EXTERNAL_DIFF=/tmp/evil git diff', /GIT_EXTERNAL_DIFF/u],
  ['git --exec-path=/tmp/evil status', /--exec-path/u],
  ['git -c include.path=/tmp/evil.gitconfig log', /include\.path/u],
  ["git -c alias.zz='!rm -rf /tmp/pwn' zz", /alias\.zz/u],
  ['git --config-env=core.pager=PAGER log', /core\.pager/u],
  ['git --config-env core.pager=PAGER log', /core\.pager/u],
  ['git fetch --upload-pack=/tmp/evil origin', /--upload-pack/u],
  ['git -c core.hooksPath=/tmp/h log', /core\.hooksPath/u],
];

test('D31: a read that tells git to run a program asks, and says what git was told to run', () => {
  for (const [command, named] of OVERRIDES) {
    const decision = decide(command);
    assert.equal(decision.kind, 'ask', command + ' must be asked about, not allowed as a read');
    assert.match(decision.reason, named, command + ' must name what git was told to run');
    assert.match(decision.reason, /action "status"/u, command + ' must still point at the git tool');
    assert.doesNotMatch(decision.reason, /run through/u, command + ' is not wrapped, so that text would be false');
  }
});

test('D31: guardAsk decides the override case too, and the reason keeps the name', () => {
  for (const [command, named] of OVERRIDES) {
    const decision = decide(command, { guardAsk: 'deny' });
    assert.equal(decision.kind, 'deny', command + ' is refused when nobody is there to answer');
    assert.match(decision.reason, named, command + ' must still name what would run');
    assert.match(decision.reason, /guardAsk/u, command + ' must say which setting refused it');
    assert.doesNotMatch(decision.reason, /run through/u);
  }
  assert.equal(decide('git -c core.pager=evil log', { guardAsk: 'allow' }).kind, 'allow');
});

test('D31: an unrelated -c or environment assignment is not an override', () => {
  const plain = [
    'git status',
    'git log --oneline -5',
    'git diff HEAD',
    'git show --stat HEAD',
    'git worktree list',
    'git fetch origin',
    'git rev-parse --show-toplevel',
    'git --no-pager log',
    'git -C /somewhere status',
    'git config --get user.name',
    'git -c user.name=x log',
    'git -c advice.detachedHead=false log',
    'GIT_DIR=/x git status',
    'GIT_WORK_TREE=/x git status',
  ];
  for (const command of plain) {
    assert.equal(kindOf(command), 'allow', command + ' is an ordinary read');
  }
  // The same shape with a key that names a program is not: the KEY decides.
  assert.equal(kindOf('git -c core.pager=evil log'), 'ask');
  assert.equal(kindOf("GIT_PAGER='sh -c evil' git log"), 'ask');
});

test('D31: an override never softens a refusal into a question', () => {
  const refusals = [
    ['git -c core.pager=less commit -am x', 'a commit'],
    ['git -c core.hooksPath=/tmp/h tag v9', 'a tag creation'],
    ['GIT_PAGER=less git reset --hard', 'a destructive reset'],
    ['git --exec-path=/tmp/evil push origin main', 'a push to a protected branch'],
    ['git -c core.pager=less stash', 'a stash save'],
  ];
  for (const [command, what] of refusals) {
    assert.equal(kindOf(command), 'deny', command + ' is ' + what + ', and the override must not downgrade it');
  }
  // The read form of the same override is the one that asks.
  assert.equal(kindOf('git -c core.pager=less log'), 'ask');
  assert.equal(kindOf('git -c core.hooksPath=/tmp/h log'), 'ask');
});

test('D31: real git confirms the premise, part one: the override really runs a program', (t) => {
  const c = makeCase('guard-exec-override');
  t.after(() => c.cleanup());

  // `GIT_EXTERNAL_DIFF`: a plain `git diff` executes the program it names.
  const diffMarker = join(c.root, 'diff-ran.txt');
  const diffScript = join(c.root, 'fake-diff.sh');
  fakeProgram(diffScript, diffMarker);
  writeFileSync(join(c.repoDir, 'README.md'), '# changed\n');
  git(c.repoDir, ['diff']);
  assert.equal(exists(diffMarker), false, 'without the override a plain diff runs nothing else');
  gitEnv(c.repoDir, ['diff'], { GIT_EXTERNAL_DIFF: diffScript });
  assert.equal(exists(diffMarker), true, 'with it, the program runs during the read');
  assert.equal(kindOf('GIT_EXTERNAL_DIFF=' + diffScript + ' git diff'), 'ask');

  // `--exec-path=<dir>`: a non-builtin subcommand is looked up there and run.
  const lfsMarker = join(c.root, 'lfs-ran.txt');
  const execDir = join(c.root, 'execpath');
  mkdirSync(execDir, { recursive: true });
  fakeProgram(join(execDir, 'git-lfs'), lfsMarker);
  gitEnv(c.repoDir, ['--exec-path=' + execDir, 'lfs', 'version'], {});
  assert.equal(exists(lfsMarker), true, 'git ran the program from the directory named by --exec-path');
  assert.equal(kindOf('git --exec-path=' + execDir + ' lfs version'), 'ask');
  // The bare form only prints the path (measured), and resolves no subcommand.
  assert.equal(kindOf('git --exec-path'), 'ask', 'nothing was inspected, so it is asked about as unknown');
});

test('D31: real git confirms the premise, part two: a hook directory and a config from the environment', (t) => {
  const c = makeCase('guard-exec-override-hooks');
  t.after(() => c.cleanup());

  // `-c core.hooksPath=<dir>`: the named hook directory is used for a ref update.
  const hookMarker = join(c.root, 'hook-ran.txt');
  const hooksDir = join(c.root, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  fakeProgram(join(hooksDir, 'reference-transaction'), hookMarker);
  gitEnv(c.repoDir, ['-c', 'core.hooksPath=' + hooksDir, 'tag', 'v9'], {});
  assert.equal(exists(hookMarker), true, 'the reference-transaction hook ran for the ref update');
  // The tag half is refused by the mutation rules; the read half asks.
  assert.equal(kindOf('git -c core.hooksPath=' + hooksDir + ' tag v9'), 'deny');
  assert.equal(kindOf('git -c core.hooksPath=' + hooksDir + ' log'), 'ask');

  // `--config-env=<key>=<ENVVAR>` really sets a config value from the environment.
  const fromEnv = gitEnv(c.repoDir, ['--config-env=core.pager=PAGER', 'config', '--get', 'core.pager'], { PAGER: '/tmp/x' });
  assert.equal(fromEnv, '/tmp/x', 'git took core.pager from the environment variable');
  assert.equal(kindOf('git --config-env=core.pager=PAGER log'), 'ask');

  // `GIT_CONFIG_GLOBAL` injects a whole config file, which can name a pager.
  const injected = join(c.root, 'injected.gitconfig');
  writeFileSync(injected, '[core]\n\tpager = /tmp/evil\n');
  const injectedValue = gitEnv(c.repoDir, ['config', '--get', 'core.pager'], { GIT_CONFIG_GLOBAL: injected });
  assert.equal(injectedValue, '/tmp/evil', 'git read the pager from the injected config file');
  assert.equal(kindOf('GIT_CONFIG_GLOBAL=' + injected + ' git log'), 'ask');
});

test('D40: a pager override names git --no-pager as the way out, and the others do not', () => {
  // Any program-naming override asks, and that verdict is right: the guard
  // cannot tell `cat` from a malicious program. A pager is the one case with a
  // way out that needs no approval at all.
  const pagerCases = [
    ["GIT_PAGER='sh -c evil' git log", /GIT_PAGER/u],
    ['GIT_PAGER=cat git log -1', /GIT_PAGER/u],
    ["git -c core.pager='sh -c evil' log", /core\.pager/u],
    ['git -c pager.log=evil log', /pager\.log/u],
    ['git --config-env=core.pager=PAGER log', /core\.pager/u],
  ];
  for (const [command, mechanism] of pagerCases) {
    const decision = decide(command);
    assert.equal(decision.kind, 'ask', command + ' still asks: a program cannot be told apart from a safe one');
    assert.match(decision.reason, /git --no-pager/u, command + ' must name the alternative that needs no approval');
    assert.match(decision.reason, mechanism, command + ' must still name the mechanism');
  }
  // The alternative is real: it is the same read, and the guard already allows it.
  assert.equal(kindOf('git --no-pager log'), 'allow');
  assert.equal(kindOf('git --no-pager log -1'), 'allow');
  assert.equal(kindOf('git --no-pager diff HEAD'), 'allow');
  // A non-pager override gets no pager advice: `--no-pager` cannot stop an
  // external diff driver, an editor, a hook or an alias shell command, so the
  // sentence would be advice that does not solve the problem.
  for (const command of [
    'GIT_EXTERNAL_DIFF=/tmp/evil git diff',
    'GIT_EDITOR=/tmp/evil git log',
    "git -c alias.zz='!rm -rf /tmp/pwn' zz",
    'git --exec-path=/tmp/evil status',
  ]) {
    const decision = decide(command);
    assert.equal(decision.kind, 'ask', command);
    assert.doesNotMatch(decision.reason, /--no-pager/u, command + ' must not be given advice that does not apply');
  }
  // And a mutation behind a pager override is still a refusal, not a question.
  const commit = decide('GIT_PAGER=cat git commit -am x');
  assert.equal(commit.kind, 'deny', 'a pager override must not soften a mutation');
  assert.doesNotMatch(commit.reason, /--no-pager/u, 'a refusal names the replacement action, not a pager hint');
});

test('D43: PAGER is the pager git runs, and the guard treats it like GIT_PAGER', (t) => {
  const c = makeCase('guard-pager-chain');
  t.after(() => c.cleanup());

  // The premise, measured without a terminal (which the pager itself needs):
  // git var GIT_PAGER is git's own answer to "which program would you run", and
  // it resolves the whole chain in the documented order.
  assert.equal(
    gitEnvNoPager(c.repoDir, ['var', 'GIT_PAGER'], { PAGER: '/tmp/from-pager' }),
    '/tmp/from-pager',
    'git takes the pager program from PAGER',
  );
  assert.equal(
    gitEnvNoPager(c.repoDir, ['-c', 'core.pager=/tmp/from-config', 'var', 'GIT_PAGER'], { PAGER: '/tmp/from-pager' }),
    '/tmp/from-config',
    'core.pager outranks PAGER',
  );
  assert.equal(
    gitEnvNoPager(c.repoDir, ['var', 'GIT_PAGER'], { PAGER: '/tmp/from-pager', GIT_PAGER: '/tmp/from-git-pager' }),
    '/tmp/from-git-pager',
    'GIT_PAGER outranks PAGER',
  );

  // The name the guard used to wave through now asks, and the reason says which
  // variable it is asking about rather than naming the other spelling.
  const evil = decide("PAGER='sh -c evil' git log");
  assert.equal(evil.kind, 'ask', 'PAGER names a program git runs, so a read carrying it asks');
  assert.match(evil.reason, /the program in PAGER/u, 'the reason names PAGER itself');
  assert.doesNotMatch(evil.reason, /GIT_PAGER/u, 'and not the other spelling of the same door');
  assert.match(evil.reason, /git --no-pager/u, 'a pager override names the way out that needs no approval');

  // The cost is the idiom, and it is paid deliberately: these ask too, and the
  // reason carries the one replacement that does not.
  for (const command of ['PAGER=cat git log -1', 'PAGER= git log']) {
    const decision = decide(command);
    assert.equal(decision.kind, 'ask', command + ' asks now; --no-pager is the free alternative');
    assert.match(decision.reason, /git --no-pager/u, command + ' must say how to avoid the question');
  }
  assert.equal(kindOf('git --no-pager log'), 'allow', 'the alternative is real and already allowed');

  // No softening: a mutation behind PAGER is still refused, with no pager hint.
  const commit = decide('PAGER=cat git commit -am x');
  assert.equal(commit.kind, 'deny', 'a pager override must not turn a refusal into a question');
  assert.doesNotMatch(commit.reason, /--no-pager/u, 'a refusal names the replacement action, not a pager hint');

  // Only the exact name counts: an unrelated assignment stays an ordinary read,
  // and the config-key door is unchanged.
  assert.equal(kindOf('PAGERLESS=1 git log'), 'allow', 'a longer name is a different variable');
  assert.equal(kindOf('git -c pager.log=evil log'), 'ask', 'the config-key door is unchanged');
});
