#!/usr/bin/env node
/**
 * The whole cycle, on a real repository with a real remote, with no network and
 * no credentials.
 *
 * Everything this bundle promises is a property of a sequence of git operations,
 * and none of it is provable by reading the code: that a worktree lands on a task
 * branch cut from the base, that the branch can be pushed and set upstream, that
 * a second finish is a no-op instead of an error, that a dirty worktree is
 * refused rather than discarded, and that the guard sends a raw commit at the
 * tool while leaving a raw status alone.
 *
 * The remote is a local bare repository, so the test runs on a plane: pushes,
 * upstream tracking and ahead/behind are all exercised through real git against
 * a real transport, while the GitHub API half is stubbed at its boundary.
 *
 *   node scripts/e2e.mjs
 *
 * Exits non-zero at the first broken promise, naming which one it was.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { runTurnSync, pushDecision, messageFor, registerTurnSync } from '../lib/turn-commit.mjs';
import { removeWorktree, createWorktree, pruneWorktrees } from '../lib/worktrees.mjs';
import { record, targetPath, safeSessionId } from '../lib/session-files.mjs';
import { evaluate } from '../lib/guard.mjs';

const SESSION = 'e2e-session';
const failures = [];
let passed = 0;

/** Run a git command, returning stdout, or throwing with the output. */
function run(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...options });
}

/** Assert one property, printing the outcome either way. */
function check(description, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log('PASS ' + description);
    return true;
  }
  failures.push(description + (detail !== '' ? ' — ' + detail : ''));
  console.log('FAIL ' + description + (detail !== '' ? ' — ' + detail : ''));
  return false;
}

/** Assert an action's envelope, returning its value when it succeeded. */
function expectOk(description, value) {
  if (check(description, value?.ok === true, value?.error?.message ?? 'not ok')) return value;
  return undefined;
}

// Realpath the scratch root immediately: `os.tmpdir()` returns the unresolved
// form on this platform, and the plugin realpaths everything it compares. A test
// that mixes the two forms would be testing its own scratch directory rather
// than the plugin — and would pass or fail depending on where tmpdir points.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-e2e-')));
const originDir = join(root, 'origin.git');
const workDir = join(root, 'work');
const worktreeRoot = join(root, 'worktrees');
const stateRoot = join(root, 'state');

// A repository whose default branch exists on the remote, which is the state
// every real repository is in and the state the branch-cutting logic depends on.
run(root, ['init', '-q', '--bare', '--initial-branch=main', originDir]);
run(root, ['clone', '-q', originDir, workDir]);
run(workDir, ['config', 'user.email', 'e2e@example.com']);
run(workDir, ['config', 'user.name', 'dsh-git e2e']);
writeFileSync(join(workDir, 'app.txt'), 'first\n', 'utf8');
run(workDir, ['add', '-A']);
run(workDir, ['commit', '-qm', 'initial commit']);
run(workDir, ['push', '-q', '-u', 'origin', 'main']);
run(workDir, ['remote', 'set-head', 'origin', 'main']);

const config = resolveConfig({ worktreeRoot, stateRoot });
const context = { config, reference: workDir, sessionId: SESSION, signal: new AbortController().signal };

/** Run one action as the tool would. */
function act(name, args) {
  return runAction(name, args, context);
}

console.log('--- status on a clean repository ---');
const clean = expectOk('status reports a clean repository', await act('status', {}));
if (clean !== undefined) {
  check('status names the main branch', clean.repo?.branch === 'main', 'got ' + String(clean.repo?.branch));
  check('status reports nothing ahead or behind', (clean.repo?.ahead ?? 0) === 0 && (clean.repo?.behind ?? 0) === 0,
    'ahead=' + String(clean.repo?.ahead) + ' behind=' + String(clean.repo?.behind));
  check('status lists the main checkout as a worktree', (clean.worktrees ?? []).some((tree) => tree.path !== undefined));
}

console.log('\n--- start: a worktree per task ---');
const started = expectOk('start creates a worktree', await act('start', { slug: 'add-feature', task: 'Add a feature' }));
let worktree;
if (started !== undefined) {
  worktree = started.worktree;
  check('the branch carries the task prefix', String(started.branch).startsWith('dsh/'), 'got ' + String(started.branch));
  check('the worktree exists on disk', existsSync(worktree), 'missing ' + String(worktree));
  check('the worktree is outside the repository', !realpathSync(worktree).startsWith(realpathSync(workDir) + '/'), worktree);
  check('the worktree is registered by git', run(workDir, ['worktree', 'list', '--porcelain']).includes(worktree.replace('/private', '')) || run(workDir, ['worktree', 'list', '--porcelain']).includes(worktree), 'not listed');
  check('the worktree started from origin/main', run(worktree, ['rev-parse', 'HEAD']) === run(workDir, ['rev-parse', 'origin/main']));
}

const again = expectOk('start reuses the worktree it already owns', await act('start', { slug: 'add-feature' }));
check('the second start returned the same path', again?.worktree === worktree, String(again?.worktree) + ' vs ' + String(worktree));
check('the second start reported reuse', again?.reused === true, 'reused=' + String(again?.reused));

console.log('\n--- work, then commit in the worktree ---');
writeFileSync(join(worktree, 'app.txt'), 'first\nsecond\n', 'utf8');
const committed = expectOk('commit commits the named path', await act('commit', {
  repo: worktree,
  paths: ['app.txt'],
  message: 'feat: add a second line',
}));
if (committed !== undefined) {
  check('the commit reports a sha', typeof committed.sha === 'string' && committed.sha.length >= 7, String(committed.sha));
  check('the commit reports the branch', String(committed.branch).startsWith('dsh/'), String(committed.branch));
  check('the main checkout is untouched by the worktree commit',
    run(workDir, ['status', '--porcelain']).trim() === '', run(workDir, ['status', '--porcelain']));
}

const nothing = expectOk('committing again reports nothing to commit', await act('commit', { repo: worktree, paths: ['app.txt'] }));
check('nothing-to-commit is not an error', nothing?.committed === false, 'committed=' + String(nothing?.committed));

console.log('\n--- push, and the idempotency that keeps a session off raw git ---');
const pushed = expectOk('push publishes the task branch', await act('push', { repo: worktree }));
if (pushed !== undefined) {
  check('push set the upstream', pushed.setUpstream === true, 'setUpstream=' + String(pushed.setUpstream));
  check('the branch exists on the remote', run(originDir, ['rev-parse', '--verify', 'refs/heads/' + String(pushed.branch)]).trim().length > 0);
}
const pushedAgain = expectOk('pushing twice is not an error', await act('push', { repo: worktree }));
check('the second push reports nothing pushed', pushedAgain?.pushed === false, 'pushed=' + String(pushedAgain?.pushed));

console.log('\n--- sync fast-forwards and never merges ---');
// Advance main from a SECOND clone, so the task branch is genuinely behind its
// base rather than diverged from it. Advancing it from the main checkout would
// make the two branches siblings, and a fast-forward would correctly refuse —
// which would test the refusal instead of the thing being asserted here.
const otherDir = join(root, 'other');
run(root, ['clone', '-q', originDir, otherDir]);
run(otherDir, ['config', 'user.email', 'e2e@example.com']);
run(otherDir, ['config', 'user.name', 'dsh-git e2e other']);
writeFileSync(join(otherDir, 'other.txt'), 'other\n', 'utf8');
run(otherDir, ['add', '-A']);
run(otherDir, ['commit', '-qm', 'chore: advance main']);
run(otherDir, ['push', '-q', 'origin', 'main']);

// Start a fresh worktree for this check. The first one already carries a commit
// of its own, which makes it diverged from main rather than behind it, and a
// fast-forward must refuse a diverged branch — a different assertion, covered
// below. This one is created at the CURRENT origin/main so it starts level, and
// main is advanced afterwards; otherwise it would already be up to date and
// there would be nothing to fast-forward.
const ffStart = expectOk('start a worktree with no commits of its own', await act('start', { repo: workDir, slug: 'sync-check' }));
const ffWorktree = ffStart?.worktree;
let synced;
if (ffWorktree !== undefined) {
  // The worktree is level with main right now. The commit that makes it BEHIND
  // has to land after this point: a worktree created from an already-advanced
  // origin/main would be level and there would be nothing to fast-forward, and
  // one created before the FIRST advance would have been behind already.
  const levelWith = run(ffWorktree, ['rev-parse', 'HEAD']);
  check('the new worktree starts level with main', levelWith === run(workDir, ['rev-parse', 'origin/main']), levelWith);
  check('it has no commits of its own', run(ffWorktree, ['log', '--oneline', 'main..HEAD']).trim() === '', run(ffWorktree, ['log', '--oneline', 'main..HEAD']));

  run(otherDir, ['checkout', '-q', 'main']);
  writeFileSync(join(otherDir, 'later.txt'), 'later\n', 'utf8');
  run(otherDir, ['add', '-A']);
  run(otherDir, ['commit', '-qm', 'chore: advance main again']);
  run(otherDir, ['push', '-q', 'origin', 'main']);

  synced = expectOk('sync catches a behind branch up', await act('sync', { repo: ffWorktree }));
  if (synced !== undefined) {
    check('sync fast-forwarded rather than merged', synced.fastForwarded === true, 'detail=' + String(synced.detail));
    check('the task branch now has the new main commit', existsSync(join(ffWorktree, 'later.txt')));
    check('no merge commit was created', run(ffWorktree, ['log', '--merges', '--oneline']).trim() === '', run(ffWorktree, ['log', '--merges', '--oneline']));
    check('the fast-forward moved the branch', run(ffWorktree, ['rev-parse', 'HEAD']) === run(ffWorktree, ['rev-parse', 'origin/main']));
  }
}

console.log('\n--- a diverged branch is reported, never merged for you ---');
const divergedDir = join(root, 'diverged');
run(root, ['clone', '-q', originDir, divergedDir]);
run(divergedDir, ['config', 'user.email', 'e2e@example.com']);
run(divergedDir, ['config', 'user.name', 'dsh-git e2e diverged']);
run(divergedDir, ['checkout', '-q', '-b', 'dsh/diverged-check']);
writeFileSync(join(divergedDir, 'mine.txt'), 'mine\n', 'utf8');
run(divergedDir, ['add', '-A']);
run(divergedDir, ['commit', '-qm', 'feat: my own work']);
run(otherDir, ['checkout', '-q', 'main']);
writeFileSync(join(otherDir, 'theirs.txt'), 'theirs\n', 'utf8');
run(otherDir, ['add', '-A']);
run(otherDir, ['commit', '-qm', 'chore: someone else advanced main']);
run(otherDir, ['push', '-q', 'origin', 'main']);
const diverged = expectOk('sync succeeds on a diverged branch', await act('sync', { repo: divergedDir }));
if (diverged !== undefined) {
  check('sync refused to fast-forward a diverged branch', diverged.fastForwarded === false, 'detail=' + String(diverged.detail));
  check('sync explained the divergence', String(diverged.detail).includes('diverged'), String(diverged.detail));
  check('sync did not merge', run(divergedDir, ['log', '--merges', '--oneline']).trim() === '', run(divergedDir, ['log', '--merges', '--oneline']));
  check('the diverged work is untouched', run(divergedDir, ['log', '-1', '--format=%s']).includes('my own work'), run(divergedDir, ['log', '-1', '--format=%s']));
}

console.log('\n--- the automatic turn sync ---');
writeFileSync(join(worktree, 'auto.txt'), 'written by a turn\n', 'utf8');
const sync = await runTurnSync({
  config,
  cwd: worktree,
  turn: 7,
  sessionId: SESSION,
  readPaths: () => ['auto.txt'],
});
const auto = (sync.repos ?? []).find((entry) => entry.repo === worktree);
check('the turn sync found the worktree', auto !== undefined, JSON.stringify(sync.repos?.map((entry) => entry.repo)));
check('the turn sync committed the change', auto?.committed === true, JSON.stringify(auto?.notes));
check('the turn sync pushed it', auto?.pushed === true, JSON.stringify(auto?.notes));
check('the worktree is clean afterwards', run(worktree, ['status', '--porcelain']).trim() === '', run(worktree, ['status', '--porcelain']));
if (auto?.sha !== undefined) {
  const subject = run(worktree, ['log', '-1', '--format=%s']);
  check('the commit message names the turn', subject.includes('turn 7'), subject);
  const body = run(worktree, ['log', '-1', '--format=%b']);
  check('the commit body carries the trailer', body.includes('Assisted-by: DSH'), body.trim());
}
check('the turn sync is level with the remote afterwards',
  run(worktree, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).trim() === '0\t0',
  run(worktree, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']));

const second = await runTurnSync({ config, cwd: worktree, turn: 8, sessionId: SESSION, readPaths: () => [] });
const secondAuto = (second.repos ?? []).find((entry) => entry.repo === worktree);
check('a turn that changed nothing makes no commit', secondAuto?.committed === false, JSON.stringify(secondAuto));

console.log('\n--- the turn sync is wired to both boundaries, and runs once per turn ---');
// The sync is registered on `agent/turn-stopping` and on `session/event`
// `turn/end`, because an agent-scoped event that never reaches a plugin listener
// fails completely silently — no error, no warning, and no commit, which is the
// exact failure this bundle exists to remove. Whichever boundary arrives first
// must win for that turn and the other must be a no-op; a double run would race
// itself on the same index.
const listeners = new Map();
const wireRepo = join(root, 'wire');
const stubCtx = {
  on: (name, handler) => { listeners.set(name, handler); return () => {}; },
  // The session's working directory is where the sync looks, so the stub has to
  // report one. Without it `sessionCwd` falls back to the process directory and
  // the sync finds a different repository, or none.
  get: (name) => (name === 'sessions'
    ? { get: () => ({ id: 'wire-session', cwd: wireRepo }) }
    : undefined),
  logger: { info: () => {}, warn: () => {} },
};
const disposeWire = registerTurnSync(stubCtx, config);
check('both boundaries are registered',
  listeners.has('agent/turn-stopping') && listeners.has('session/event'),
  [...listeners.keys()].join(', '));
if (listeners.has('agent/turn-stopping') && listeners.has('session/event')) {
  run(root, ['clone', '-q', originDir, wireRepo]);
  run(wireRepo, ['config', 'user.email', 'e2e@example.com']);
  run(wireRepo, ['config', 'user.name', 'dsh-git e2e wire']);
  writeFileSync(join(wireRepo, 'wire.txt'), 'wired\n', 'utf8');
  // The session's own record is what makes the repository its to commit. In a
  // live Host the tools layer writes this when the edit is dispatched; here it
  // is written directly, which is the same fact arriving by a shorter road.
  record('wire-session', wireRepo, join(wireRepo, 'wire.txt'), { stateRoot: config.stateRoot });
  const before = Number(run(wireRepo, ['rev-list', '--count', 'HEAD']).trim());

  const agent = { id: 'wire-session' };
  listeners.get('agent/turn-stopping')({ agent, turn: 42, signal: new AbortController().signal });
  listeners.get('session/event')({ id: 'wire-session' }, { type: 'turn/end', data: { turn: 42 } });
  await new Promise((settle) => setTimeout(settle, 3000));

  const after = Number(run(wireRepo, ['rev-list', '--count', 'HEAD']).trim());
  check('the turn sync ran exactly once for one turn',
    after - before === 1, 'commits added: ' + String(after - before));

  // A different turn must still run: deduplication is per turn, not once ever.
  writeFileSync(join(wireRepo, 'wire2.txt'), 'wired again\n', 'utf8');
  record('wire-session', wireRepo, join(wireRepo, 'wire2.txt'), { stateRoot: config.stateRoot });
  listeners.get('session/event')({ id: 'wire-session' }, { type: 'turn/end', data: { turn: 43 } });
  await new Promise((settle) => setTimeout(settle, 3000));
  const later = Number(run(wireRepo, ['rev-list', '--count', 'HEAD']).trim());
  check('a later turn still syncs', later - before === 2, 'commits added: ' + String(later - before));
  check('the later commit names its own turn', run(wireRepo, ['log', '-1', '--format=%s']).includes('turn 43'), run(wireRepo, ['log', '-1', '--format=%s']));
  disposeWire();
}

console.log('\n--- a protected branch is committed but never pushed ---');
run(workDir, ['checkout', '-q', 'main']);
writeFileSync(join(workDir, 'app.txt'), 'first\nchanged on main\n', 'utf8');
const protectedRun = await runTurnSync({ config, cwd: workDir, turn: 9, sessionId: 'other-session', readPaths: () => ['app.txt'] });
const onMain = (protectedRun.repos ?? []).find((entry) => entry.repo === workDir);
check('the turn sync still committed on main', onMain?.committed === true, JSON.stringify(onMain?.notes));
check('the turn sync did not push main', onMain?.pushed !== true, JSON.stringify(onMain));
check('it said why main was not pushed', (onMain?.notes ?? []).some((note) => note.includes('protected')), JSON.stringify(onMain?.notes));
const decision = pushDecision(config, 'main', []);
check('pushDecision refuses a protected branch', decision.allowed === false, JSON.stringify(decision));

console.log('\n--- one session never commits another session\'s work (the Agent Team case) ---');
// Several sessions sharing a checkout is what an Agent Team is. The old fallback
// committed every dirty repository under the working directory, which meant a
// lead's turn end swept up a teammate's half-finished edits under the lead's
// turn number. These assertions are the reason the session record exists.
const shared = join(root, 'shared');
run(root, ['clone', '-q', originDir, shared]);
run(shared, ['config', 'user.email', 'e2e@example.com']);
run(shared, ['config', 'user.name', 'dsh-git e2e shared']);

/** Both sessions share the checkout but keep separate records. */
const coordinator = { stateRoot, cwd: shared };
const teammate = { stateRoot: join(root, 'state-b'), cwd: shared };
const countCommits = () => Number(run(shared, ['rev-list', '--count', 'HEAD']).trim());

// The teammate edits a file. Only the teammate's record knows about it.
const teammateFile = join(shared, 'teammate-work.txt');
writeFileSync(teammateFile, 'half finished\n', 'utf8');
record('session-teammate', shared, teammateFile, { stateRoot: teammate.stateRoot });

// The coordinator's turn ends. It changed nothing in this repository, so it must
// commit nothing — the dirty tree belongs to the teammate.
const beforeCoordinator = countCommits();
const coordinatorRun = await runTurnSync({
  config: resolveConfig({ worktreeRoot, stateRoot: coordinator.stateRoot }),
  cwd: shared,
  turn: 100,
  sessionId: 'session-coordinator',
  readPaths: () => undefined,
});
check('the coordinator committed nothing in a repository only the teammate touched',
  countCommits() === beforeCoordinator,
  'commits added: ' + String(countCommits() - beforeCoordinator));
check('the coordinator reported no repository of its own',
  (coordinatorRun.repos ?? []).length === 0,
  JSON.stringify(coordinatorRun.repos?.map((entry) => entry.repo)));
check('the teammate\'s file is still uncommitted after the coordinator\'s turn',
  run(shared, ['status', '--porcelain']).includes('teammate-work.txt'),
  run(shared, ['status', '--porcelain']));

// Now the teammate's own turn ends, and it does commit its work.
const teammateRun = await runTurnSync({
  config: resolveConfig({ worktreeRoot, stateRoot: teammate.stateRoot, turnSyncScope: 'session' }),
  cwd: shared,
  turn: 101,
  sessionId: 'session-teammate',
  readPaths: () => undefined,
});
const teammateResult = (teammateRun.repos ?? []).find((entry) => entry.repo === shared);
check('the teammate committed its own work', teammateResult?.committed === true, JSON.stringify(teammateResult?.notes));
check('the shared tree is clean once its owner has committed',
  run(shared, ['status', '--porcelain']).trim() === '', run(shared, ['status', '--porcelain']));
check('the commit names the teammate\'s file',
  run(shared, ['log', '-1', '--format=%s']).includes('teammate-work.txt'), run(shared, ['log', '-1', '--format=%s']));

console.log('\n--- the scan is still available, and still reports what it does not touch ---');
// `workspace` restores the old behaviour for a single session working alone.
// It is opt-in because it cannot tell whose work is whose.
writeFileSync(join(shared, 'unnamed.txt'), 'nobody recorded this\n', 'utf8');
const unnamedRun = await runTurnSync({
  config: resolveConfig({ worktreeRoot, stateRoot: join(root, 'state-c') }),
  cwd: shared,
  turn: 102,
  sessionId: 'session-nobody',
  readPaths: () => undefined,
});
check('the default scope leaves an unrecorded repository alone',
  (unnamedRun.repos ?? []).length === 0, JSON.stringify(unnamedRun.repos?.map((entry) => entry.repo)));
check('the default scope is reported in the result', unnamedRun.scope === 'session', String(unnamedRun.scope));
check('the unrecorded file is still uncommitted', run(shared, ['status', '--porcelain']).includes('unnamed.txt'));

const sweepRun = await runTurnSync({
  config: resolveConfig({ worktreeRoot, stateRoot: join(root, 'state-c'), turnSyncScope: 'workspace' }),
  cwd: shared,
  turn: 103,
  sessionId: 'session-nobody',
  readPaths: () => undefined,
});
check('the workspace scope still commits a dirty repository',
  (sweepRun.repos ?? []).some((entry) => entry.repo === shared && entry.committed === true),
  JSON.stringify(sweepRun.repos));
check('the workspace scope reports itself', sweepRun.scope === 'workspace', String(sweepRun.scope));

console.log('\n--- a failed creation leaves nothing behind ---');
// `git worktree add -b` creates the branch BEFORE it populates the worktree, so a
// failure at that point leaves a branch with no worktree. The orphan then refuses
// the next attempt with "a branch named X already exists", which names the wrong
// cause — and the plugin's own guard denies `git branch -D`, so unless the plugin
// cleans up after itself the leftover is permanent.
const leakRepo = join(root, 'leak');
run(root, ['clone', '-q', originDir, leakRepo]);
run(leakRepo, ['config', 'user.email', 'e2e@example.com']);
run(leakRepo, ['config', 'user.name', 'dsh-git e2e leak']);
const branchesOf = (dir) => run(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  .split('\n').map((line) => line.trim()).filter((line) => line !== '');
check('the repository starts with one branch', branchesOf(leakRepo).length === 1, branchesOf(leakRepo).join(', '));

// `/dev/null/...` is a path git cannot create, so the add fails after the branch.
const leaked = await createWorktree(leakRepo, {
  worktreeRoot: '/dev/null/nope',
  branchPrefix: 'dsh/',
  slug: 'leaky',
  timeoutMs: 15000,
});
check('creation fails when the worktree path is impossible', leaked.ok === false, JSON.stringify(leaked));
check('the failure left no orphaned branch behind',
  !branchesOf(leakRepo).some((name) => name.startsWith('dsh/')), branchesOf(leakRepo).join(', '));

console.log('\n--- prune removes the plugin\'s own leftovers, and only those ---');
run(leakRepo, ['branch', 'dsh/orphan']);
const dry = await pruneWorktrees(leakRepo, { branchPrefix: 'dsh/', baseRef: 'refs/heads/main', timeoutMs: 15000 });
check('the dry run reports the orphan', (dry.branches ?? []).some((entry) => entry.branch === 'dsh/orphan'), JSON.stringify(dry.branches));
check('the dry run did not delete it', branchesOf(leakRepo).includes('dsh/orphan'), branchesOf(leakRepo).join(', '));

const applied = await pruneWorktrees(leakRepo, { branchPrefix: 'dsh/', baseRef: 'refs/heads/main', apply: true, timeoutMs: 15000 });
check('apply removes the orphan', !branchesOf(leakRepo).includes('dsh/orphan'), branchesOf(leakRepo).join(', '));
check('apply reported what it removed', (applied.branches ?? []).some((entry) => entry.branch === 'dsh/orphan'), JSON.stringify(applied.branches));

// The whole safety argument for that deletion: a branch holding a commit the base
// does not have must be kept. Deleting it would be exactly the data loss the
// guard's `git branch -D` denial exists to prevent.
writeFileSync(join(leakRepo, 'work.txt'), 'unmerged\n', 'utf8');
run(leakRepo, ['checkout', '-q', '-b', 'dsh/with-work']);
run(leakRepo, ['add', '-A']);
run(leakRepo, ['commit', '-qm', 'feat: work of its own']);
run(leakRepo, ['checkout', '-q', 'main']);
const kept = await pruneWorktrees(leakRepo, { branchPrefix: 'dsh/', baseRef: 'refs/heads/main', apply: true, timeoutMs: 15000 });
check('a branch holding its own commit is kept', branchesOf(leakRepo).includes('dsh/with-work'), branchesOf(leakRepo).join(', '));
check('the kept branch is reported as kept', (kept.branches ?? []).some((entry) => entry.branch === 'dsh/with-work' && entry.kept === true), JSON.stringify(kept.branches));
check('a branch outside the prefix is never considered', branchesOf(leakRepo).includes('main'), branchesOf(leakRepo).join(', '));

console.log('\n--- the recorder only records real edits ---');
check('write records its target', targetPath({ name: 'write', arguments: { file_path: '/x/y.mjs' } }) === '/x/y.mjs');
check('edit records its target', targetPath({ name: 'edit', arguments: { file_path: '/x/y.mjs' } }) === '/x/y.mjs');
check('bash is not a file edit', targetPath({ name: 'bash', arguments: { command: 'echo hi > /x/y.mjs' } }) === undefined);
check('read is not a file edit', targetPath({ name: 'read', arguments: { file_path: '/x/y.mjs' } }) === undefined);
check('a malformed call is not an edit', targetPath({ name: 'write', arguments: null }) === undefined);
check('a path-less write is not an edit', targetPath({ name: 'write', arguments: {} }) === undefined);
check('a session id cannot escape the store',
  !safeSessionId('../../etc/passwd').includes('/'), safeSessionId('../../etc/passwd'));

console.log('\n--- the original worktree can be closed out ---');
writeFileSync(join(worktree, 'unfinished.txt'), 'not ready\n', 'utf8');
const removeDirty = await runAction('finish', { cleanup: true }, { config, reference: worktree, sessionId: SESSION });
check('finish committed what was uncommitted before closing the worktree', removeDirty.committed === true, JSON.stringify(removeDirty.notes));
check('finish pushed it', removeDirty.pushed === true, JSON.stringify(removeDirty.notes));
check('finish removed the worktree once nothing was left uncommitted', removeDirty.worktreeRemoved === true, JSON.stringify(removeDirty));
check('the work survived the worktree: it is in the branch history', run(workDir, ['log', '--all', '--format=%s']).includes('turn 7') || run(workDir, ['log', '--all', '--format=%s']).includes('dsh:'), 'not found in history');
check('the worktree directory is gone', !existsSync(worktree), String(worktree));

console.log('\n--- a genuinely dirty worktree is refused, never discarded ---');
// `finish` makes its worktree clean before closing it, which is the whole point
// of finish. The refusal has to be asserted against a worktree that still holds
// work, which is what `removeWorktree` is for — the path a caller reaches when
// cleanup is requested without finishing first.
const leftOver = expectOk('start a worktree to leave dirty', await act('start', { repo: workDir, slug: 'leave-dirty' }));
if (leftOver !== undefined) {
  writeFileSync(join(leftOver.worktree, 'not-ready.txt'), 'work in progress\n', 'utf8');
  const refused = await removeWorktree(workDir, leftOver.worktree, { timeoutMs: config.timeoutMs });
  check('removal is refused for a dirty worktree', refused.ok === false && refused.removed === false, JSON.stringify(refused));
  check('the refusal names the uncommitted file', (refused.dirty ?? []).some((path) => path.includes('not-ready.txt')), JSON.stringify(refused.dirty));
  check('the uncommitted work survived the refusal', existsSync(join(leftOver.worktree, 'not-ready.txt')));
}

console.log('\n--- finish is a no-op when there is nothing left to do ---');
// The main checkout has been level and untouched since the protected-branch
// check, but only after that check reaches its own steady state — and it holds
// the commit that check made. Ask for the state first, then assert finish agrees
// rather than assuming what it should find.
const mainState = await act('status', { repo: workDir });
const mainWasDirty = mainState.repo?.dirty === true;
const finished = expectOk('finish succeeds on a clean branch', await act('finish', { repo: workDir, pr: false }));
if (finished !== undefined) {
  check('finish commits only what was dirty, and nothing when nothing was',
    finished.committed === mainWasDirty, 'dirty before=' + String(mainWasDirty) + ' committed=' + String(finished.committed));
}
const finishedAgain = expectOk('a second finish has nothing to do', await act('finish', { repo: workDir, pr: false }));
check('the second finish committed nothing', finishedAgain?.committed === false, 'committed=' + String(finishedAgain?.committed));

// A worktree that finish already removed is gone, so naming it again is a
// failure with a reason rather than a crash or a silent success — the model has
// to be able to read "that directory no longer exists" and move on.
const gone = await runAction('finish', { repo: worktree, pr: false }, { config, reference: workDir, sessionId: SESSION });
check('finishing a removed worktree fails cleanly', gone.ok === false && typeof gone.error?.code === 'string', JSON.stringify(gone.error));

console.log('\n--- the guard sends raw git at the tool ---');
const rawCommit = evaluate({ name: 'bash', arguments: { command: 'git commit -m x' }, signal: new AbortController().signal }, config);
check('a raw commit is gated', rawCommit.kind === 'ask', rawCommit.kind);
check('the gate names the commit action', /commit/u.test(rawCommit.reason ?? ''), String(rawCommit.reason).slice(0, 80));
const rawStatus = evaluate({ name: 'bash', arguments: { command: 'git status' }, signal: new AbortController().signal }, config);
check('a raw status is allowed', rawStatus.kind === 'allow', rawStatus.kind);
const rawForce = evaluate({ name: 'bash', arguments: { command: 'git push --force' }, signal: new AbortController().signal }, config);
check('a raw force-push is denied', rawForce.kind === 'deny', rawForce.kind);

console.log('\n--- no repository means no crash ---');
const emptyDir = join(root, 'empty');
mkdirSync(emptyDir, { recursive: true });
const noRepo = await runAction('status', {}, { config, reference: emptyDir, sessionId: SESSION });
check('status in a directory with no repository succeeds', noRepo.ok === true, JSON.stringify(noRepo.error));
check('status reports no repositories', (noRepo.repos ?? []).length === 0, JSON.stringify(noRepo.repos));
const startNoRepo = await runAction('start', {}, { config, reference: emptyDir, sessionId: SESSION });
check('start in a directory with no repository fails cleanly', startNoRepo.ok === false && startNoRepo.error?.code === 'not-a-repo', JSON.stringify(startNoRepo));

console.log('\n--- the configured message template is honoured ---');
const templated = messageFor(resolveConfig({ turnCommitMessage: 'task {turn}: {paths}' }), 3, ['a.txt', 'b.txt']);
check('the template substitutes turn and paths', templated.startsWith('task 3: a.txt, b.txt'), templated);

// Leave the scratch tree exactly as it was found, including the worktree admin
// files that a bare `rm -rf` would leave behind.
try {
  run(workDir, ['worktree', 'remove', '--force', worktree]);
} catch {
  /* the worktree may already be gone; the scratch tree is removed below */
}
rmSync(root, { recursive: true, force: true });

console.log('\n' + String(passed) + ' passed, ' + String(failures.length) + ' failed');
if (failures.length > 0) {
  console.error('\n' + failures.join('\n'));
  process.exit(1);
}
console.log('The full cycle works: worktree, commit, push, sync, automatic turn sync, protected-branch refusal, and the guard.');
