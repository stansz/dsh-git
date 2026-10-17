/**
 * The automatic half, against real repositories.
 *
 * The plugin's central promise is not a command — it is a commit and a push that
 * happen by themselves at a turn boundary. That promise lives in two functions:
 * runTurnSync, the body of one boundary sync, and syncRepo, the per-repository
 * commit and push under it. Both are driven directly here, because a sync reachable
 * only through a live session is one nothing can run, and registerTurnSync needs a
 * Cordis context and real timers to reach the same function.
 *
 * Every test arranges a real repository with the real git command and then checks
 * the repository — not just the result object. A result that says "committed" over
 * a tree that is still dirty is exactly the failure these tests exist to catch.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  action,
  cleanupTemps,
  commitAll,
  config,
  fixture,
  git,
  gitOk,
  initRepo,
  lastSubject,
  recordChange,
  resolved,
  sessionId,
  shaOf,
  tempDir,
  writeFiles,
} from './support.mjs';
import {
  TRAILER,
  attentionText,
  messageFor,
  needsAttention,
  pushDecision,
  runTurnSync,
  summarizeSync,
  syncRepo,
} from '../lib/turn-commit.mjs';
import {
  clearPushFailure,
  readSession,
  recordPushFailure,
  shouldRetryPush,
} from '../lib/state.mjs';

after(cleanupTemps);

/* ------------------------------------------------------------------ */
/* Session and repository arrangements                                 */
/* ------------------------------------------------------------------ */

/** A resolved plugin configuration, with its own isolated state root. */
async function pluginConfig(overrides = {}) {
  return await resolved({ ...config(), ...overrides });
}

/**
 * One session: a resolved config, a session id, and a way to record file edits
 * with that same state root — which is exactly what the tools layer does.
 *
 * The raw config is kept beside the resolved one because the exported functions
 * differ: syncRepo takes a resolved config, while the action layer (used for
 * status) resolves whatever it is handed.
 */
async function testSession(overrides = {}) {
  const raw = { ...config(), ...overrides };
  const cfg = await resolved(raw);
  const sid = sessionId();
  return {
    raw,
    cfg,
    sid,
    /** Record file edits this session made, through the real recorder. */
    async record(repo, paths) {
      for (const path of [].concat(paths)) {
        const recorded = await recordChange(repo, path, { sessionId: sid, stateRoot: cfg.stateRoot });
        assert.equal(recorded, true, 'recording ' + path + ' failed');
      }
    },
  };
}

/** The full commit message git holds for HEAD. */
function headBody(repo) {
  return gitOk(repo, ['log', '-1', '--format=%B']);
}

/** Point origin at a path that is not a git repository, so a push must fail. */
function breakOrigin(fx) {
  gitOk(fx.work, ['remote', 'set-url', 'origin', fx.work + '/missing.git']);
}

/** Arrange a real conflicted merge: MERGE_HEAD exists and shared.txt is unmerged. */
function midMerge(fx) {
  writeFiles(fx.work, { 'shared.txt': 'base' });
  commitAll(fx.work, 'base shared');
  gitOk(fx.work, ['push', '-q', 'origin', 'main']);
  gitOk(fx.work, ['checkout', '-q', '-b', 'side']);
  writeFiles(fx.work, { 'shared.txt': 'side' });
  commitAll(fx.work, 'side edit');
  gitOk(fx.work, ['checkout', '-q', 'main']);
  writeFiles(fx.work, { 'shared.txt': 'main' });
  commitAll(fx.work, 'main edit');
  assert.equal(git(fx.work, ['merge', 'side']).ok, false, 'the fixture merge should conflict');
  assert.equal(git(fx.work, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok, true);
}

/** Arrange a real stopped rebase: REBASE_HEAD exists. */
function midRebase(fx) {
  writeFiles(fx.work, { 'shared.txt': 'base' });
  commitAll(fx.work, 'base shared');
  gitOk(fx.work, ['push', '-q', 'origin', 'main']);
  gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/work']);
  writeFiles(fx.work, { 'shared.txt': 'local' });
  commitAll(fx.work, 'local edit');
  const peer = fx.parent + '/peer';
  gitOk(fx.parent, ['clone', '-q', fx.bare, peer]);
  gitOk(peer, ['config', 'user.name', 'Peer']);
  gitOk(peer, ['config', 'user.email', 'peer@example.invalid']);
  writeFiles(peer, { 'shared.txt': 'remote' });
  commitAll(peer, 'remote edit');
  gitOk(peer, ['push', '-q', 'origin', 'main']);
  gitOk(fx.work, ['fetch', '-q', 'origin']);
  assert.equal(git(fx.work, ['rebase', 'origin/main']).ok, false, 'the fixture rebase should conflict');
  assert.equal(git(fx.work, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']).ok, true);
}

/* ================================================================== */
describe('syncRepo: the commit', () => {
  test('commits the recorded paths, reports the rest, and pushes', async () => {
    const fx = fixture();
    const session = await testSession();
    writeFiles(fx.work, { 'mine.txt': 'mine', 'theirs.txt': 'theirs' });

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['mine.txt']);

    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.equal(result.branch, 'main');
    assert.equal(result.remote, 'origin');
    assert.equal(result.subject, 'dsh: mine.txt');
    assert.equal(result.sha, shaOf(fx.work));
    assert.equal(shaOf(fx.bare, 'refs/heads/main'), shaOf(fx.work));
    assert.equal(gitOk(fx.work, ['show', 'HEAD:mine.txt']), 'mine');
    // The message is the generated subject plus the trailer, in the body.
    assert.equal(headBody(fx.work), 'dsh: mine.txt\n\n' + TRAILER);
    // The unrecorded path was not swept in, and is named instead.
    assert.equal(git(fx.work, ['cat-file', '-e', 'HEAD:theirs.txt']).ok, false);
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '?? theirs.txt');
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /left 1 unrecorded changed path\(s\) alone \(theirs\.txt\)/);
  });

  test('a clean repository is nothing to do, not a failure', async () => {
    const fx = fixture();
    const session = await testSession();

    const result = await syncRepo(fx.work, session.cfg, session.sid, []);

    assert.equal(result.committed, false);
    assert.equal(result.pushed, false);
    assert.equal(result.branch, 'main');
    assert.deepEqual(result.notes, []);
  });

  test('a new file in a brand-new untracked directory is committed', async () => {
    const fx = fixture();
    const session = await testSession();
    writeFiles(fx.work, { 'new-dir/new-file.txt': 'brand new' });

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['new-dir/new-file.txt']);

    // git status collapses the untracked directory to "new-dir/"; the commit has
    // to name the file for the recorded path to intersect with anything.
    assert.equal(result.committed, true);
    assert.equal(gitOk(fx.work, ['show', 'HEAD:new-dir/new-file.txt']), 'brand new');
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '');
  });

  test('turnCommit: false leaves the tree alone and says nothing', async () => {
    const fx = fixture();
    const session = await testSession({ turnCommit: false });
    writeFiles(fx.work, { 'a.txt': 'a' });
    const before = shaOf(fx.work);

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['a.txt']);

    assert.equal(result.committed, false);
    assert.equal(result.pushed, false);
    assert.deepEqual(result.notes, []);
    assert.equal(shaOf(fx.work), before);
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '?? a.txt');
  });

  test('above turnCommitMaxFiles the commit is skipped and reported', async () => {
    const fx = fixture();
    const session = await testSession({ turnCommitMaxFiles: 1 });
    writeFiles(fx.work, { 'a.txt': 'a', 'b.txt': 'b' });
    const before = shaOf(fx.work);

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['a.txt', 'b.txt']);

    assert.equal(result.committed, false);
    assert.equal(result.pushed, false);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /skipped the automatic commit: 2 of this session's changed paths, above the limit of 1/);
    assert.equal(shaOf(fx.work), before);
    const dirty = gitOk(fx.work, ['status', '--porcelain']);
    assert.match(dirty, /a\.txt/);
    assert.match(dirty, /b\.txt/);
  });
});

/* ================================================================== */
describe('syncRepo: what it declines', () => {
  test('a detached HEAD is skipped and named', async () => {
    const fx = fixture();
    const session = await testSession();
    gitOk(fx.work, ['checkout', '-q', '--detach']);
    writeFiles(fx.work, { 'x.txt': 'x' });
    const before = shaOf(fx.work);

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['x.txt']);

    assert.equal(result.committed, false);
    assert.deepEqual(result.notes, ['detached HEAD, so the automatic commit is skipped']);
    assert.equal(shaOf(fx.work), before);
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '?? x.txt');
  });

  test('a merge in progress pauses the automatic commit', async () => {
    const fx = fixture();
    const session = await testSession();
    midMerge(fx);
    const before = shaOf(fx.work);

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['shared.txt']);

    assert.equal(result.committed, false);
    assert.deepEqual(result.notes, ['a merge, rebase or cherry-pick is in progress, so the automatic commit is paused']);
    assert.equal(shaOf(fx.work), before);
    assert.match(gitOk(fx.work, ['status', '--porcelain']), /shared\.txt/);
  });

  test('a rebase in progress pauses the automatic commit', async () => {
    const fx = fixture();
    const session = await testSession();
    midRebase(fx);
    const before = shaOf(fx.work);

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['shared.txt']);

    assert.equal(result.committed, false);
    assert.deepEqual(result.notes, ['a merge, rebase or cherry-pick is in progress, so the automatic commit is paused']);
    assert.equal(shaOf(fx.work), before);
    assert.equal(git(fx.work, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']).ok, true);
  });

  test('a directory that is not a repository is reported, not thrown', async () => {
    const session = await testSession();

    const result = await syncRepo(tempDir(), session.cfg, session.sid, []);

    assert.equal(result.committed, false);
    assert.equal(result.pushed, false);
    assert.deepEqual(result.notes, ['could not read repository state']);
  });
});

/* ================================================================== */
describe('syncRepo: the push decision', () => {
  test('a protected branch is committed but never pushed, and says why', async () => {
    const fx = fixture();
    const session = await testSession({ protectedBranches: ['main'] });
    writeFiles(fx.work, { 'p.txt': 'p' });
    const bareBefore = shaOf(fx.bare, 'refs/heads/main');

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['p.txt']);

    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.deepEqual(result.notes, ['not pushed: main is a protected branch']);
    assert.equal(shaOf(fx.bare, 'refs/heads/main'), bareBefore);
    assert.equal(gitOk(fx.work, ['rev-list', '--count', 'origin/main..HEAD']), '1');
  });

  test('an unpushed protected branch earns no note when nothing was committed', async () => {
    const fx = fixture();
    const session = await testSession({ protectedBranches: ['main'] });

    const result = await syncRepo(fx.work, session.cfg, session.sid, []);

    // The branch is ahead of nothing and behind nothing: the ordinary steady
    // state of working on main is not an interruption.
    assert.equal(result.committed, false);
    assert.deepEqual(result.notes, []);
  });

  test('a task branch is pushed, with its upstream set', async () => {
    const fx = fixture();
    const session = await testSession();
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/task']);
    writeFiles(fx.work, { 't.txt': 't' });

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['t.txt']);

    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.equal(result.remote, 'origin');
    assert.equal(gitOk(fx.work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), 'origin/dsh/task');
    assert.equal(shaOf(fx.bare, 'refs/heads/dsh/task'), shaOf(fx.work));
  });

  test('a branch the base already contains is not published again', async () => {
    const fx = fixture();
    const session = await testSession();
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/merged', 'origin/main']);

    const result = await syncRepo(fx.work, session.cfg, session.sid, []);

    assert.equal(result.committed, false);
    assert.equal(result.pushed, false);
    assert.equal(result.containedInBase, 'main');
    assert.deepEqual(result.notes, []);
    assert.equal(git(fx.bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/dsh/merged']).ok, false);
  });

  test('a repository with no origin commits silently and pushes nowhere', async () => {
    const repo = initRepo(tempDir() + '/local', { title: 'local' });
    const session = await testSession();
    writeFiles(repo, { 'n.txt': 'n' });

    const result = await syncRepo(repo, session.cfg, session.sid, ['n.txt']);

    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.noRemote, true);
    assert.deepEqual(result.notes, []);
    assert.equal(gitOk(repo, ['show', 'HEAD:n.txt']), 'n');
  });

  test('turnPush: false commits locally and says nothing', async () => {
    const fx = fixture();
    const session = await testSession({ turnPush: false });
    writeFiles(fx.work, { 'local.txt': 'local' });
    const bareBefore = shaOf(fx.bare, 'refs/heads/main');

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['local.txt']);

    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.deepEqual(result.notes, []);
    assert.equal(shaOf(fx.bare, 'refs/heads/main'), bareBefore);
    assert.equal(gitOk(fx.work, ['rev-list', '--count', 'origin/main..HEAD']), '1');
  });
});

/* ================================================================== */
describe('messageFor', () => {
  test('names the turn and the paths, and marks the commit as assisted', async () => {
    const cfg = await pluginConfig();

    const message = messageFor(cfg, 3, ['src/a.mjs', 'b.txt']);

    assert.equal(message, 'dsh: turn 3 — a.mjs, b.txt\n\nAssisted-by: DSH');
    assert.equal(TRAILER, 'Assisted-by: DSH');
  });

  test('without a turn number it names the paths it contains', async () => {
    const cfg = await pluginConfig();

    assert.equal(messageFor(cfg, undefined, ['src/a.mjs', 'b.txt']), 'dsh: a.mjs, b.txt\n\nAssisted-by: DSH');
    // No paths and no turn is still an honest message, not an empty one.
    assert.equal(messageFor(cfg, undefined, []), 'dsh: automatic commit\n\nAssisted-by: DSH');
    assert.equal(messageFor(cfg, 0, []), 'dsh: turn 0\n\nAssisted-by: DSH');
  });

  test('the configured template owns the subject line', async () => {
    const cfg = await pluginConfig({ turnCommitMessage: 'turn {turn} touched {paths}' });

    const message = messageFor(cfg, 7, ['x.txt', 'y/z.txt']);

    assert.equal(message, 'turn 7 touched x.txt, y/z.txt\n\nAssisted-by: DSH');
    assert.ok(message.endsWith('\n\nAssisted-by: DSH'));
  });
});

/* ================================================================== */
describe('pushDecision', () => {
  test('the table: detached HEAD, protected, task branch, other branch', async () => {
    const plain = await pluginConfig();
    const guarded = await pluginConfig({ protectedBranches: ['main'] });

    assert.deepEqual(pushDecision(plain, undefined), { allowed: false, reason: 'detached HEAD' });
    assert.deepEqual(pushDecision(guarded, 'main'), { allowed: false, reason: 'main is a protected branch' });
    assert.deepEqual(pushDecision(guarded, 'feature'), { allowed: false, reason: 'feature is not a task branch' });
    assert.deepEqual(pushDecision(guarded, 'dsh/task'), { allowed: true, reason: 'task branch' });
    assert.deepEqual(pushDecision(plain, 'dsh/task'), { allowed: true, reason: 'task branch' });
    // A branch namespace is a whole path segment: dshx is not inside dsh/.
    assert.deepEqual(pushDecision(guarded, 'dshx'), { allowed: false, reason: 'dshx is not a task branch' });
    // With nothing protected, the branch in use is the branch the user chose.
    assert.deepEqual(pushDecision(plain, 'feature'), { allowed: true, reason: 'no protected branches configured' });
  });
});

/* ================================================================== */
describe('runTurnSync', () => {
  test('session scope commits the repository this session recorded and leaves the rest alone', async () => {
    const fx = fixture();
    const session = await testSession();
    const other = initRepo(fx.parent + '/other', { title: 'other' });
    writeFiles(fx.work, { 'mine.txt': 'mine' });
    writeFiles(other, { 'wip.txt': 'wip' });
    await session.record(fx.work, 'mine.txt');

    const result = await runTurnSync({ config: session.raw, cwd: fx.parent, sessionId: session.sid });

    assert.equal(result.ok, true);
    assert.equal(result.scope, 'session');
    assert.equal(result.usedFileList, false);
    assert.equal(result.repos.length, 1);
    assert.equal(result.repos[0].repo, fx.work);
    assert.equal(result.repos[0].committed, true);
    assert.equal(result.repos[0].subject, 'dsh: mine.txt');
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '');

    // A dirty repository this session never recorded is reported, never swept in.
    assert.equal(gitOk(other, ['status', '--porcelain']), '?? wip.txt');
    assert.equal(result.leftAlone.length, 1);
    assert.equal(result.leftAlone[0].repo, other);
    assert.equal(result.leftAlone[0].changed, 1);
    assert.match(result.leftAlone[0].notes[0], /dirty and never recorded by this session, so it was left uncommitted \(turnSyncScope: "session"\)/);
  });

  test('a recorder file list names the changed paths without a session record', async () => {
    const fx = fixture();
    const session = await testSession();
    writeFiles(fx.work, { 'reported.txt': 'from the turn recorder' });

    const result = await runTurnSync({
      config: session.raw,
      cwd: fx.work,
      sessionId: session.sid,
      readPaths: () => [fx.work + '/reported.txt'],
    });

    assert.equal(result.usedFileList, true);
    assert.equal(result.repos.length, 1);
    assert.equal(result.repos[0].committed, true);
    assert.equal(result.repos[0].subject, 'dsh: reported.txt');
    assert.equal(gitOk(fx.work, ['show', 'HEAD:reported.txt']), 'from the turn recorder');
  });

  test('a recorded file in a brand-new directory is committed at the turn boundary', async () => {
    const fx = fixture();
    const session = await testSession();
    writeFiles(fx.work, { 'new-dir/new-file.txt': 'brand new' });
    await session.record(fx.work, 'new-dir/new-file.txt');

    const result = await runTurnSync({ config: session.raw, cwd: fx.work, sessionId: session.sid });

    assert.equal(result.repos.length, 1);
    assert.equal(result.repos[0].committed, true);
    assert.equal(gitOk(fx.work, ['show', 'HEAD:new-dir/new-file.txt']), 'brand new');
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '');
  });

  test('leftAlone names a clean repository holding unpushed commits, and ignores one with no upstream', async () => {
    const fx = fixture();
    const session = await testSession();
    writeFiles(fx.work, { 'mine.txt': 'mine' });
    await session.record(fx.work, 'mine.txt');

    // A clean clone with one commit the remote does not have.
    const peer = fx.parent + '/peer';
    gitOk(fx.parent, ['clone', '-q', fx.bare, peer]);
    gitOk(peer, ['config', 'user.name', 'Peer']);
    gitOk(peer, ['config', 'user.email', 'peer@example.invalid']);
    writeFiles(peer, { 'peer.txt': 'peer' });
    commitAll(peer, 'peer work');

    // A clean local repository with commits and nowhere to publish them.
    const noUpstream = initRepo(fx.parent + '/no-upstream', { title: 'no upstream' });
    writeFiles(noUpstream, { 'local.txt': 'local' });
    commitAll(noUpstream, 'local only');

    const result = await runTurnSync({ config: session.raw, cwd: fx.parent, sessionId: session.sid });

    const left = new Map(result.leftAlone.map((entry) => [entry.repo, entry]));
    assert.equal(left.has(fx.work), false, 'the repository that was synced must not be reported left alone');
    assert.equal(left.has(fx.seed), false, 'a cleanly pushed repository is not left behind');
    assert.equal(left.has(noUpstream), false, 'a branch with no upstream is unpublished, not unpushed');
    assert.ok(left.has(peer), 'a clean repository ahead of its upstream holds work that is nowhere else');
    assert.equal(left.get(peer).ahead, 1);
    assert.match(left.get(peer).notes[0], /has 1 unpushed commit\(s\) and was never recorded by this session, so it was left unpushed/);
  });

  test('a turn number names the commit the boundary reported', async () => {
    const fx = fixture();
    const session = await testSession();
    writeFiles(fx.work, { 'turn-file.txt': 'x' });

    const result = await runTurnSync({
      config: session.raw,
      cwd: fx.work,
      sessionId: session.sid,
      turn: 5,
      readPaths: () => [fx.work + '/turn-file.txt'],
    });

    assert.equal(result.turn, 5);
    assert.equal(result.repos[0].subject, 'dsh: turn 5 — turn-file.txt');
    assert.equal(lastSubject(fx.work), 'dsh: turn 5 — turn-file.txt');
  });

  test('workspace scope commits repositories it finds by scanning, with no session record', async () => {
    const fx = fixture();
    const session = await testSession({ turnSyncScope: 'workspace' });
    writeFiles(fx.work, { 'work-a.txt': 'a' });
    const other = initRepo(fx.parent + '/other', { title: 'other' });
    writeFiles(other, { 'other-b.txt': 'b' });

    const result = await runTurnSync({ config: session.raw, cwd: fx.parent, sessionId: session.sid });

    assert.equal(result.scope, 'workspace');
    // A repository found only by the scan has no session record to intersect
    // with, so every dirty path in it is this turn's work.
    assert.equal(result.repos.length, 2);
    assert.deepEqual(result.leftAlone, []);
    const byRepo = new Map(result.repos.map((entry) => [entry.repo, entry]));
    for (const [repo, file, text] of [[fx.work, 'work-a.txt', 'a'], [other, 'other-b.txt', 'b']]) {
      const entry = byRepo.get(repo);
      assert.ok(entry !== undefined, repo + ' was not synced');
      assert.equal(entry.committed, true);
      assert.equal(entry.subject, 'dsh: ' + file);
      assert.equal(gitOk(repo, ['show', 'HEAD:' + file]), text);
      assert.equal(gitOk(repo, ['status', '--porcelain']), '');
    }
  });

  test('the same directory under session scope commits nothing and reports both repositories', async () => {
    const fx = fixture();
    const session = await testSession({ turnSyncScope: 'session' });
    const workBefore = shaOf(fx.work);
    writeFiles(fx.work, { 'work-a.txt': 'a' });
    const other = initRepo(fx.parent + '/other', { title: 'other' });
    const otherBefore = shaOf(other);
    writeFiles(other, { 'other-b.txt': 'b' });

    const result = await runTurnSync({ config: session.raw, cwd: fx.parent, sessionId: session.sid });

    assert.equal(result.scope, 'session');
    assert.deepEqual(result.repos, []);
    assert.equal(shaOf(fx.work), workBefore);
    assert.equal(shaOf(other), otherBefore);
    const left = new Map(result.leftAlone.map((entry) => [entry.repo, entry]));
    assert.equal(left.size, 2);
    for (const repo of [fx.work, other]) {
      assert.ok(left.has(repo), repo + ' was not reported');
      assert.equal(left.get(repo).changed, 1);
      assert.match(left.get(repo).notes[0], /dirty and never recorded by this session/);
      assert.match(gitOk(repo, ['status', '--porcelain']), /\?\? /);
    }
  });
});

/* ================================================================== */
describe('the push failure and its backoff', () => {
  test('a failed push is reported in git words, recorded, and shown by status', async () => {
    const fx = fixture();
    const session = await testSession();
    breakOrigin(fx);
    writeFiles(fx.work, { 'one.txt': 'one' });

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['one.txt']);

    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /^push failed: /);
    assert.match(result.notes[0], /\(attempt 1\)$/);

    const recorded = readSession(session.sid, { stateRoot: session.cfg.stateRoot }).pushFailures[fx.work];
    assert.ok(recorded !== undefined, 'the failed push was not recorded');
    assert.equal(recorded.attempts, 1);
    // The first failure backs off for a minute.
    assert.equal(Date.parse(recorded.nextAttemptAt) - Date.parse(recorded.lastAttemptAt), 60000);

    const status = await action('status', { repo: fx.work }, {
      config: session.raw,
      reference: fx.work,
      sessionId: session.sid,
    });
    assert.equal(status.pushFailure.attempts, 1);
    assert.equal(status.pushFailure.nextAttemptAt, recorded.nextAttemptAt);
    assert.match(status.pushFailure.error, /remote could not be reached/i);
  });

  test('the next sync backs off instead of retrying the failed push', async () => {
    const fx = fixture();
    const session = await testSession();
    breakOrigin(fx);
    writeFiles(fx.work, { 'one.txt': 'one' });
    await syncRepo(fx.work, session.cfg, session.sid, ['one.txt']);
    writeFiles(fx.work, { 'two.txt': 'two' });

    const result = await syncRepo(fx.work, session.cfg, session.sid, ['two.txt']);

    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /^push still backing off after 1 failure\(s\): /);
    // A skipped retry is not a new failure, so the attempt count did not move.
    const recorded = readSession(session.sid, { stateRoot: session.cfg.stateRoot }).pushFailures[fx.work];
    assert.equal(recorded.attempts, 1);
  });

  test('recordPushFailure schedules a growing backoff and shouldRetryPush honours it', async () => {
    const stateRoot = tempDir('dsh-git-state-');
    const repo = tempDir('dsh-git-repo-');
    const sid = 'backoff-session';
    const t0 = Date.parse('2026-01-02T03:04:05.000Z');

    const first = recordPushFailure(sid, repo, 'boom', { stateRoot, now: t0 });
    assert.equal(first.persisted, true);
    assert.equal(first.attempts, 1);
    assert.equal(first.nextAttemptAt, '2026-01-02T03:05:05.000Z');
    assert.equal(shouldRetryPush(sid, repo, new Date(t0 + 30000), { stateRoot }), false);
    assert.equal(shouldRetryPush(sid, repo, new Date(t0 + 61000), { stateRoot }), true);

    const second = recordPushFailure(sid, repo, 'boom again', { stateRoot, now: t0 + 61000 });
    assert.equal(second.attempts, 2);
    assert.equal(second.nextAttemptAt, '2026-01-02T03:10:06.000Z');
    assert.equal(shouldRetryPush(sid, repo, new Date(t0 + 61000 + 299000), { stateRoot }), false);
    assert.equal(shouldRetryPush(sid, repo, new Date(t0 + 61000 + 301000), { stateRoot }), true);

    assert.equal(clearPushFailure(sid, repo, { stateRoot }), true);
    assert.equal(shouldRetryPush(sid, repo, new Date(t0), { stateRoot }), true);
  });
});

/* ================================================================== */
describe('the model-facing report', () => {
  test('a clean sync needs no attention; a note or a left-alone repository does', () => {
    assert.equal(needsAttention({ repos: [{ repo: '/w/app', committed: true, pushed: true, notes: [] }], leftAlone: [] }), false);
    assert.equal(needsAttention({ repos: [], leftAlone: [] }), false);
    assert.equal(needsAttention(undefined), false);
    assert.equal(needsAttention({
      repos: [{ repo: '/w/app', committed: false, pushed: false, notes: ['skipped the automatic commit: 2 of this session\'s changed paths, above the limit of 1'] }],
    }), true);
    assert.equal(needsAttention({
      repos: [],
      leftAlone: [{ repo: '/w/other', changed: 1, notes: ['dirty and never recorded by this session, so it was left uncommitted (turnSyncScope: "session")'] }],
    }), true);
  });

  test('attentionText names each unfinished repository and what to do about it', () => {
    const text = attentionText({
      repos: [{
        repo: '/workspace/lib',
        committed: false,
        pushed: false,
        notes: ['skipped the automatic commit: 340 of this session\'s changed paths, above the limit of 200'],
      }],
      leftAlone: [
        { repo: '/workspace/other-repo', changed: 2, notes: ['dirty and never recorded by this session, so it was left uncommitted (turnSyncScope: "session")'] },
        { repo: '/workspace/side-project', ahead: 1, notes: ['has 1 unpushed commit(s) and was never recorded by this session, so it was left unpushed (turnSyncScope: "session")'] },
      ],
    });
    const lines = text.split('\n');
    assert.equal(lines[0], 'dsh-git could not finish syncing your working tree:');
    assert.ok(lines.includes('  - lib: skipped the automatic commit: 340 of this session\'s changed paths, above the limit of 200'));
    assert.ok(lines.includes('dsh-git left 2 repositories alone:'));
    assert.ok(lines.some((line) => line.startsWith('  - other-repo (/workspace/other-repo): dirty and never recorded')));
    assert.ok(lines.some((line) => line.startsWith('  - side-project (/workspace/side-project): has 1 unpushed commit(s)')));
    assert.ok(lines.some((line) => line.startsWith('This session never recorded work there')));
    assert.match(lines.at(-1), /Run the git tool with action "status"/);
  });

  test('one left-alone repository is singular, and a clean sync closes with the same advice', () => {
    const single = attentionText({
      repos: [],
      leftAlone: [{ repo: '/workspace/side-project', ahead: 1, notes: ['has 1 unpushed commit(s) and was never recorded by this session, so it was left unpushed (turnSyncScope: "session")'] }],
    });
    assert.match(single, /dsh-git left 1 repository alone:/);

    assert.equal(
      attentionText({ repos: [], leftAlone: [] }),
      'Run the git tool with action "status" to see the current state, and action "save" or action "publish" to finish the work by hand.',
    );
  });

  test('summarizeSync keeps the host log line to one line', () => {
    const result = {
      repos: [
        { repo: '/w/app', committed: true, pushed: true, notes: [] },
        { repo: '/w/lib', committed: false, pushed: false, notes: ['skipped the automatic commit: 340 of this session\'s changed paths, above the limit of 200'] },
      ],
      leftAlone: [
        { repo: '/w/other-repo', changed: 2, notes: [] },
        { repo: '/w/side-project', ahead: 1, notes: [] },
      ],
    };
    assert.equal(
      summarizeSync(result),
      '1 committed — 1 pushed — 2 left alone (other-repo, side-project) — skipped the automatic commit: 340 of this session\'s changed paths, above the limit of 200',
    );
    assert.equal(summarizeSync({ repos: [] }), '');
    assert.equal(summarizeSync(undefined), '');
  });
});
