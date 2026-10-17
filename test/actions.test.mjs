/**
 * The day-to-day flows, against real repositories.
 *
 * Every test here arranges a real repository with the real git command, calls
 * the tool action, and then checks the repository's actual state — not just the
 * result object. That split is deliberate: a result that says "committed" over a
 * tree that is still dirty is exactly the failure these tests exist to catch.
 */

import { after, describe, test } from 'node:test';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

import {
  action,
  branches,
  commitAll,
  config,
  currentBranch,
  fixture,
  git,
  gitOk,
  hasBranch,
  initRepo,
  lastSubject,
  readRepoFile,
  recordChange,
  repoHas,
  sessionId,
  shaOf,
  tempDir,
  writeFiles,
  cleanupTemps,
} from './support.mjs';

after(cleanupTemps);

/** One configuration + session across several calls, as a real session is. */
function testSession(working, overrides = {}) {
  const cfg = { ...config(), ...overrides };
  const sid = sessionId();
  return {
    cfg,
    sid,
    run(name, args = {}) {
      return action(name, { repo: working, ...args }, { config: cfg, reference: working, sessionId: sid });
    },
  };
}

/* ================================================================== */
describe('init', () => {
  test('creates a repository with the requested branch', async () => {
    const parent = tempDir();
    const target = parent + '/made-here';
    const result = await action('init', { path: target, branch: 'trunk' }, { config: config(), reference: parent });
    assert.equal(result.ok, true);
    assert.equal(result.path, target);
    assert.equal(result.repo.branch, 'trunk');
    assert.equal(gitOk(target, ['rev-parse', '--is-inside-work-tree']), 'true');
    assert.equal(gitOk(target, ['symbolic-ref', '--short', 'HEAD']), 'trunk');
  });

  test('initialises the reference directory when no path is given', async () => {
    const dir = tempDir();
    const result = await action('init', {}, { config: config(), reference: dir });
    assert.equal(result.ok, true);
    assert.equal(gitOk(dir, ['rev-parse', '--is-inside-work-tree']), 'true');
  });

  test('refuses a missing parent with a name anyone can act on', async () => {
    const parent = tempDir();
    const result = await action('init', { path: parent + '/nope/child' }, { config: config(), reference: parent });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'missing-parent');
    assert.match(result.error.message, /does not exist/);
  });

  test('a repository is not re-initialised', async () => {
    const fx = fixture();
    const result = await action('init', { path: fx.work }, { config: config(), reference: fx.parent });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'already-repo');
  });
});

/* ================================================================== */
describe('clone', () => {
  test('clones a repository to the directory the URL names', async () => {
    const fx = fixture();
    const parent = tempDir();
    const result = await action('clone', { url: fx.bare }, { config: config(), reference: parent });
    assert.equal(result.ok, true);
    assert.equal(result.path, parent + '/origin');
    assert.equal(result.repo.branch, 'main');
    assert.equal(gitOk(result.path, ['remote', 'get-url', 'origin']), fx.bare);
    assert.ok(repoHas(result.path, 'README.md'));
  });

  test('honours path and branch', async () => {
    const fx = fixture();
    gitOk(fx.seed, ['checkout', '-q', '-b', 'release']);
    writeFiles(fx.seed, { 'release.txt': 'yes' });
    commitAll(fx.seed, 'release work');
    gitOk(fx.seed, ['push', '-q', 'origin', 'release']);
    const parent = tempDir();
    const result = await action('clone', { url: fx.bare, path: parent + '/checkout', branch: 'release' }, { config: config(), reference: parent });
    assert.equal(result.ok, true);
    assert.equal(result.path, parent + '/checkout');
    assert.equal(currentBranch(result.path), 'release');
    assert.ok(repoHas(result.path, 'release.txt'));
  });

  test('names the missing pieces instead of guessing', async () => {
    const parent = tempDir();
    const configValue = config();
    const missingUrl = await action('clone', {}, { config: configValue, reference: parent });
    assert.equal(missingUrl.error.code, 'missing-url');
    const missingParent = await action('clone', { url: 'x', path: parent + '/gone/child' }, { config: configValue, reference: parent });
    assert.equal(missingParent.error.code, 'missing-parent');
    const existing = await action('clone', { url: parent + '/missing.git', path: parent }, { config: configValue, reference: parent });
    assert.equal(existing.error.code, 'target-exists');
  });
});

/* ================================================================== */
describe('status', () => {
  test('reports a clean repository, its branch and its worktrees', async () => {
    const fx = fixture();
    const result = await action('status', { repo: fx.work }, { config: config(), reference: fx.work });
    assert.equal(result.ok, true);
    assert.equal(result.repo.branch, 'main');
    assert.equal(result.repo.dirty, false);
    assert.equal(result.repo.changeCount, 0);
    assert.equal(result.repo.repoRoot, fx.work);
    assert.equal(result.repo.ahead, 0);
    assert.equal(result.repo.behind, 0);
    assert.equal(result.repo.defaultBranch, 'main');
    assert.equal(Array.isArray(result.worktrees), true);
    assert.equal(result.worktrees[0].path, fx.work);
  });

  test('reports every dirty path and how it is dirty', async () => {
    const fx = fixture();
    writeFiles(fx.work, { 'README.md': '# changed\n', 'new-file.txt': 'new' });
    gitOk(fx.work, ['add', 'new-file.txt']);
    const result = await action('status', { repo: fx.work }, { config: config(), reference: fx.work });
    assert.equal(result.ok, true);
    assert.equal(result.repo.dirty, true);
    assert.equal(result.repo.changeCount, 2);
    assert.equal(result.repo.staged, 1);
    assert.equal(result.repo.unstaged, 1);
    assert.equal(result.repo.untracked, 0);
  });

  test('reports a commit that has not been pushed as ahead', async () => {
    const fx = fixture();
    writeFiles(fx.work, { 'local.txt': 'local' });
    commitAll(fx.work, 'local only');
    const result = await action('status', { repo: fx.work }, { config: config(), reference: fx.work });
    assert.equal(result.repo.ahead, 1);
    assert.equal(result.repo.behind, 0);
    assert.equal(result.repo.upstream, 'origin/main');
  });

  test('sweeps every repository under the reference', async () => {
    const root = tempDir();
    const first = initRepo(root + '/first', { title: 'first' });
    const second = initRepo(root + '/second', { title: 'second' });
    gitOk(second, ['remote', 'add', 'origin', root + '/first']);
    gitOk(second, ['fetch', '-q', 'origin']);
    const result = await action('status', { sweep: true }, { config: config(), reference: root });
    assert.equal(result.ok, true);
    assert.equal(result.path, root);
    assert.equal(result.repos.length, 2);
    assert.deepEqual(result.repos.map((repo) => repo.repoRoot).sort(), [first, second].sort());
    assert.equal(result.repos.find((repo) => repo.repoRoot === first).branch, 'main');
    const swept = await action('status', {}, { config: config(), reference: root });
    assert.equal(swept.repos.length, 2);
  });

  test('an empty directory is an empty sweep, not an error', async () => {
    const dir = tempDir();
    const result = await action('status', { sweep: true }, { config: config(), reference: dir });
    assert.equal(result.ok, true);
    assert.deepEqual(result.repos, []);
  });

  test('a path inside the repository is resolved to its root', async () => {
    const fx = fixture();
    const nested = fx.work + '/deep/nested';
    writeFiles(fx.work, { 'deep/nested/file.txt': 'x' });
    const result = await action('status', { repo: nested }, { config: config(), reference: fx.work });
    assert.equal(result.ok, true);
    assert.equal(result.repo.repoRoot, fx.work);
    assert.equal(result.repo.untracked, 1);
  });
});

/* ================================================================== */
describe('save', () => {
  test('commits exactly the paths this session recorded and reports the rest', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'mine.txt': 'mine', 'theirs.txt': 'theirs' });
    const recorded = await recordChange(fx.work, 'mine.txt', { sessionId: session.sid, stateRoot: session.cfg.stateRoot });
    assert.equal(recorded, true);
    const result = await session.run('save');
    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.deepEqual(result.paths, ['mine.txt']);
    assert.deepEqual(result.leftBehind, ['theirs.txt']);
    assert.match(result.notes[0], /left 1 unrecorded changed path/);
    assert.equal(gitOk(fx.work, ['show', 'HEAD:mine.txt']), 'mine');
    assert.equal(git(fx.work, ['cat-file', '-e', 'HEAD:theirs.txt']).ok, false);
    assert.equal(gitOk(fx.work, ['status', '--porcelain', '--', 'theirs.txt']), '?? theirs.txt');
  });

  test('commits a new file in a brand-new directory when it is recorded', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'new-dir/new-file.txt': 'work' });
    await recordChange(fx.work, 'new-dir/new-file.txt', { sessionId: session.sid, stateRoot: session.cfg.stateRoot });
    const result = await session.run('save');
    assert.equal(result.committed, true);
    assert.deepEqual(result.paths, ['new-dir/new-file.txt']);
    assert.equal(gitOk(fx.work, ['show', 'HEAD:new-dir/new-file.txt']), 'work');
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '');
  });

  test('a write to a file in a directory that does not exist yet is recorded and committed', async () => {
    const fx = fixture();
    const cfg = config();
    const sid = sessionId();
    const listeners = [];
    const ctx = {
      on(event, listener) {
        if (event === 'tools/pre-execute') listeners.push(listener);
      },
    };
    const { registerSessionFiles } = await import('../lib/session-files.mjs');
    const { toplevel } = await import('../lib/git.mjs');
    // The recorder is what the Host asks before a file write, so its answer
    // decides whether the automatic commit can ever see the file. It resolves
    // the path while neither the file nor its directory exists.
    registerSessionFiles(ctx, cfg, async (path) => {
      const absolute = resolve(fx.work, path);
      const repoRoot = await toplevel(absolute);
      return repoRoot === undefined ? undefined : { repoRoot, path: absolute };
    });
    const exec = { name: 'write', arguments: { file_path: 'brand/new/dir/file.txt' }, agent: { id: sid } };
    for (const listener of listeners) await listener(exec, async () => {});
    writeFiles(fx.work, { 'brand/new/dir/file.txt': 'created in a new directory' });

    const result = await action('save', { repo: fx.work }, { config: cfg, reference: fx.work, sessionId: sid });
    assert.equal(result.committed, true, JSON.stringify(result));
    assert.deepEqual(result.paths, ['brand/new/dir/file.txt']);
    assert.equal(gitOk(fx.work, ['show', 'HEAD:brand/new/dir/file.txt']), 'created in a new directory');
  });

  test('explicit paths need no record and may include untracked files', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'a.txt': 'a', 'b.txt': 'b' });
    const result = await session.run('save', { paths: ['b.txt'], message: 'only b' });
    assert.equal(result.committed, true);
    assert.deepEqual(result.paths, ['b.txt']);
    assert.equal(result.subject, 'only b');
    assert.equal(lastSubject(fx.work), 'only b');
    assert.deepEqual(result.leftBehind, []);
    assert.equal(gitOk(fx.work, ['status', '--porcelain', '--', 'a.txt']), '?? a.txt');
  });

  test('a clean tree is an answer, not a failure', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    const result = await session.run('save');
    assert.equal(result.ok, true);
    assert.equal(result.committed, false);
    assert.match(result.detail, /nothing to save: the working tree is clean/);
  });

  test('dirty work this session did not record is reported, never swept in', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'someone-else.txt': 'wip' });
    const result = await session.run('save');
    assert.equal(result.ok, true);
    assert.equal(result.committed, false);
    assert.deepEqual(result.leftBehind, ['someone-else.txt']);
    assert.match(result.detail, /this session changed none of the 1 dirty path/);
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '?? someone-else.txt');
  });

  test('a directory that is not a repository is named, not guessed at', async () => {
    const dir = tempDir();
    const result = await action('save', {}, { config: config(), reference: dir });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-a-repo');
  });
});

/* ================================================================== */
describe('publish', () => {
  test('pushes a new branch, sets its upstream and says so', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/task']);
    writeFiles(fx.work, { 'task.txt': 'task' });
    commitAll(fx.work, 'task work');
    const result = await session.run('publish');
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(result.setUpstream, true);
    assert.equal(result.branch, 'dsh/task');
    assert.equal(gitOk(fx.work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), 'origin/dsh/task');
    assert.equal(gitOk(fx.bare, ['rev-parse', 'refs/heads/dsh/task']), shaOf(fx.work));
  });

  test('a second publish with nothing new reports pushed false, not an error', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'a.txt': 'a' });
    commitAll(fx.work, 'a');
    await session.run('publish');
    const again = await session.run('publish');
    assert.equal(again.ok, true);
    assert.equal(again.pushed, false);
  });

  test('refuses a protected branch unless the call explicitly overrides it', async () => {
    const fx = fixture();
    const session = testSession(fx.work, { protectedBranches: ['main'] });
    writeFiles(fx.work, { 'a.txt': 'a' });
    commitAll(fx.work, 'a');
    const refused = await session.run('publish');
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'protected-branch');
    assert.match(refused.error.message, /protected branch/);
    assert.match(refused.error.hint, /allowProtected/);
    assert.equal(git(fx.bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).ok, true);
    const pushed = await session.run('publish', { allowProtected: true });
    assert.equal(pushed.ok, true);
    assert.equal(pushed.pushed, true);
  });

  test('refuses a repository with no origin, and does not record it as a push failure', async () => {
    const repo = tempDir();
    initRepo(repo);
    const session = testSession(repo);
    writeFiles(repo, { 'a.txt': 'a' });
    commitAll(repo, 'a');
    const result = await session.run('publish');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'no-remote');
    assert.match(result.error.hint, /git remote add origin/);
    const status = await session.run('status');
    assert.equal(status.pushFailure, undefined);
  });

  test('replaces a rewritten remote ref only with forceWithLease', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/rewrite']);
    writeFiles(fx.work, { 'one.txt': 'one' });
    commitAll(fx.work, 'first version');
    await session.run('publish');
    writeFiles(fx.work, { 'one.txt': 'one, amended' });
    gitOk(fx.work, ['commit', '-q', '--amend', '-a', '-m', 'amended version']);
    const refused = await session.run('publish');
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'push-failed');
    assert.match(refused.error.message, /non-fast-forward|rejected|fetch first/i);
    const forced = await session.run('publish', { forceWithLease: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.pushed, true);
    assert.equal(gitOk(fx.bare, ['rev-parse', 'refs/heads/dsh/rewrite']), shaOf(fx.work));
  });

  test('records a failed push so the next automatic attempt backs off, and status shows it', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'a.txt': 'a' });
    commitAll(fx.work, 'a');
    gitOk(fx.work, ['remote', 'set-url', 'origin', fx.work + '/missing.git']);
    const failed = await session.run('publish');
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'push-failed');
    const status = await session.run('status');
    assert.ok(status.pushFailure !== undefined);
    assert.equal(status.pushFailure.attempts, 1);
    assert.ok(typeof status.pushFailure.nextAttemptAt === 'string');
  });
});

/* ================================================================== */
describe('sync', () => {
  /** Push a commit from a second clone, so the fixture is genuinely behind. */
  function advanceOrigin(fx, files, message) {
    const other = fx.parent + '/peer';
    if (git(fx.parent, ['rev-parse', '--verify', '--quiet', other]).ok === false) {
      if (git(other, ['rev-parse', '--is-inside-work-tree']).ok === false) {
        gitOk(fx.parent, ['clone', '-q', fx.bare, other]);
        gitOk(other, ['config', 'user.name', 'Peer']);
        gitOk(other, ['config', 'user.email', 'peer@example.invalid']);
      }
    }
    writeFiles(other, files);
    commitAll(other, message);
    gitOk(other, ['push', '-q', 'origin', 'main']);
    return other;
  }

  test('an up-to-date branch changes nothing', async () => {
    const fx = fixture();
    const result = await action('sync', { repo: fx.work }, { config: config(), reference: fx.work });
    assert.equal(result.ok, true);
    assert.equal(result.fastForwarded, false);
    assert.match(result.detail, /up to date with main/);
  });

  test('fast-forwards a branch that has no commits of its own', async () => {
    const fx = fixture();
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/behind']);
    const other = advanceOrigin(fx, { 'remote.txt': 'remote' }, 'remote work');
    const before = shaOf(fx.work);
    const result = await action('sync', { repo: fx.work }, { config: config(), reference: fx.work });
    assert.equal(result.ok, true);
    assert.equal(result.fastForwarded, true);
    assert.equal(result.from, before);
    assert.equal(result.to, shaOf(other));
    assert.equal(shaOf(fx.work), shaOf(other));
    assert.ok(repoHas(fx.work, 'remote.txt'));
  });

  test('a diverged branch is reported, not merged behind the caller', async () => {
    const fx = fixture();
    const other = advanceOrigin(fx, { 'remote.txt': 'remote' }, 'remote work');
    writeFiles(fx.work, { 'local.txt': 'local' });
    commitAll(fx.work, 'local work');
    const before = shaOf(fx.work);
    const result = await action('sync', { repo: fx.work }, { config: config(), reference: fx.work });
    assert.equal(result.ok, true);
    assert.equal(result.fastForwarded, false);
    assert.match(result.detail, /diverged from main/);
    assert.match(result.detail, /1 ahead, 1 behind/);
    assert.equal(shaOf(fx.work), before);
    assert.notEqual(shaOf(fx.work), shaOf(other));
  });

  test('rebase: true replays the branch onto the base, keeping it linear', async () => {
    const fx = fixture();
    advanceOrigin(fx, { 'remote.txt': 'remote' }, 'remote work');
    writeFiles(fx.work, { 'local.txt': 'local' });
    commitAll(fx.work, 'local work');
    const result = await action('sync', { repo: fx.work, rebase: true }, { config: config(), reference: fx.work });
    assert.equal(result.ok, true);
    assert.equal(result.rebased, true);
    assert.equal(result.base, 'main');
    assert.equal(gitOk(fx.work, ['rev-list', '--merges', '--count', 'HEAD^']), '0');
    assert.equal(lastSubject(fx.work), 'local work');
    assert.equal(gitOk(fx.work, ['rev-list', '--count', 'origin/main..HEAD']), '1');
    assert.ok(repoHas(fx.work, 'remote.txt'));
    assert.match(result.notes[0], /forceWithLease/);
  });

  test('a rebase conflict is aborted, nothing moves, and the path is named', async () => {
    const fx = fixture();
    writeFiles(fx.work, { 'shared.txt': 'base' });
    commitAll(fx.work, 'base shared');
    gitOk(fx.work, ['push', '-q', 'origin', 'main']);
    gitOk(fx.work, ['checkout', '-q', '-b', 'task']);
    writeFiles(fx.work, { 'shared.txt': 'local' });
    commitAll(fx.work, 'local edit');
    const other = fx.parent + '/peer';
    gitOk(fx.parent, ['clone', '-q', fx.bare, other]);
    gitOk(other, ['config', 'user.name', 'Peer']);
    gitOk(other, ['config', 'user.email', 'peer@example.invalid']);
    writeFiles(other, { 'shared.txt': 'remote' });
    commitAll(other, 'remote edit');
    gitOk(other, ['push', '-q', 'origin', 'main']);
    const before = shaOf(fx.work);
    const result = await action('sync', { repo: fx.work, rebase: true }, { config: config(), reference: fx.work });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'rebase-conflict');
    assert.match(result.error.message, /shared.txt/);
    assert.equal(shaOf(fx.work), before);
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '');
    assert.equal(git(fx.work, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']).ok, false);
  });

  test('merge: true makes a real merge commit', async () => {
    const fx = fixture();
    advanceOrigin(fx, { 'remote.txt': 'remote' }, 'remote work');
    writeFiles(fx.work, { 'local.txt': 'local' });
    commitAll(fx.work, 'local work');
    const before = shaOf(fx.work);
    const result = await action('sync', { repo: fx.work, merge: true }, { config: config(), reference: fx.work });
    assert.equal(result.ok, true);
    assert.equal(result.merged, true);
    assert.equal(result.from, before);
    assert.equal(result.to, shaOf(fx.work));
    assert.equal(gitOk(fx.work, ['rev-list', '--merges', '--count', 'HEAD']), '1');
    assert.equal(git(fx.work, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok, false);
  });

  test('a merge conflict is aborted and reported as a merge, not a rebase', async () => {
    const fx = fixture();
    writeFiles(fx.work, { 'shared.txt': 'base' });
    commitAll(fx.work, 'base shared');
    gitOk(fx.work, ['push', '-q', 'origin', 'main']);
    gitOk(fx.work, ['checkout', '-q', '-b', 'task']);
    writeFiles(fx.work, { 'shared.txt': 'local' });
    commitAll(fx.work, 'local edit');
    const other = fx.parent + '/peer';
    gitOk(fx.parent, ['clone', '-q', fx.bare, other]);
    gitOk(other, ['config', 'user.name', 'Peer']);
    gitOk(other, ['config', 'user.email', 'peer@example.invalid']);
    writeFiles(other, { 'shared.txt': 'remote' });
    commitAll(other, 'remote edit');
    gitOk(other, ['push', '-q', 'origin', 'main']);
    const before = shaOf(fx.work);
    const result = await action('sync', { repo: fx.work, merge: true }, { config: config(), reference: fx.work });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'merge-conflict');
    assert.equal(shaOf(fx.work), before);
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '');
  });

  test('an unreachable remote is a fetch failure that names the fix', async () => {
    const fx = fixture();
    gitOk(fx.work, ['remote', 'set-url', 'origin', fx.work + '/does-not-exist.git']);
    const result = await action('sync', { repo: fx.work }, { config: config(), reference: fx.work });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'fetch-failed');
    assert.equal(typeof result.error.message, 'string');
    assert.ok(result.error.message.length > 0);
  });
});

/* ================================================================== */
describe('finish without GitHub', () => {
  test('commits dirty work, pushes it and reports why no pull request was opened', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'done.txt': 'done' });
    const result = await session.run('finish');
    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.match(result.prSkipped, /not a github.com remote/);
    assert.equal(gitOk(fx.work, ['status', '--porcelain']), '');
    assert.equal(gitOk(fx.bare, ['rev-parse', 'refs/heads/main']), shaOf(fx.work));
  });

  test('a second finish finds nothing to commit and nothing to push', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'done.txt': 'done' });
    await session.run('finish');
    const again = await session.run('finish');
    assert.equal(again.ok, true);
    assert.equal(again.committed, false);
    assert.equal(again.pushed, false);
  });

  test('pr: false skips the pull request deliberately', async () => {
    const fx = fixture();
    const session = testSession(fx.work);
    writeFiles(fx.work, { 'done.txt': 'done' });
    const result = await session.run('finish', { pr: false });
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(result.pull, undefined);
    assert.equal(result.prSkipped, undefined);
  });
});

/* ================================================================== */
describe('prune', () => {
  /** Two branches the sweep may remove, one it must keep. */
  function pruneFixture() {
    const fx = fixture();
    gitOk(fx.work, ['branch', 'dsh/orphan']);
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/merged-by-ff']);
    writeFiles(fx.work, { 'merged.txt': 'merged' });
    commitAll(fx.work, 'work that reached main');
    gitOk(fx.work, ['checkout', '-q', 'main']);
    gitOk(fx.work, ['merge', '-q', '--ff-only', 'dsh/merged-by-ff']);
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/unmerged']);
    writeFiles(fx.work, { 'unmerged.txt': 'unmerged' });
    commitAll(fx.work, 'work only on this branch');
    gitOk(fx.work, ['checkout', '-q', 'main']);
    return fx;
  }

  test('a dry run reports what it would remove and removes nothing', async () => {
    const fx = pruneFixture();
    const session = testSession(fx.work);
    const result = await session.run('prune');
    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.equal(result.detail, 'to remove: 2 orphaned branches — pass apply: true');
    assert.deepEqual(result.branches.filter((entry) => entry.kept !== true).map((entry) => entry.branch).sort(), ['dsh/merged-by-ff', 'dsh/orphan']);
    const kept = result.branches.find((entry) => entry.branch === 'dsh/unmerged');
    assert.equal(kept.kept, true);
    assert.match(kept.reason, /holds 1 commit/);
    assert.equal(hasBranch(fx.work, 'dsh/orphan'), true);
    assert.equal(hasBranch(fx.work, 'dsh/merged-by-ff'), true);
  });

  test('apply removes the orphaned branches and keeps the branch holding work', async () => {
    const fx = pruneFixture();
    const session = testSession(fx.work);
    const result = await session.run('prune', { apply: true });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.detail, 'removed 2 orphaned branches');
    assert.equal(hasBranch(fx.work, 'dsh/orphan'), false);
    assert.equal(hasBranch(fx.work, 'dsh/merged-by-ff'), false);
    assert.equal(hasBranch(fx.work, 'dsh/unmerged'), true);
    assert.deepEqual(branches(fx.work).sort(), ['dsh/unmerged', 'main'].sort());
  });

  test('a branch checked out in a worktree is never removed', async () => {
    const fx = pruneFixture();
    const worktree = fx.parent + '/tree';
    gitOk(fx.work, ['worktree', 'add', '-q', worktree, 'dsh/merged-by-ff']);
    const session = testSession(fx.work);
    const result = await session.run('prune', { apply: true });
    assert.equal(result.ok, true);
    // The branch is inside the repository the whole action ran on, and it is
    // never even offered as a candidate: a worktree is a checkout somebody is
    // standing in, so the sweep does not touch it.
    assert.equal(result.branches.some((branch) => branch.branch === 'dsh/merged-by-ff'), false);
    assert.equal(hasBranch(fx.work, 'dsh/merged-by-ff'), true);
    // The orphan without a worktree is still swept in the same run.
    assert.equal(hasBranch(fx.work, 'dsh/orphan'), false);
  });

  test('named branches are honoured, and a dry run still only lists them', async () => {
    const fx = fixture();
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/mine']);
    writeFiles(fx.work, { 'mine.txt': 'mine' });
    commitAll(fx.work, 'work only here');
    gitOk(fx.work, ['checkout', '-q', 'main']);
    const session = testSession(fx.work);
    const dry = await session.run('prune', { branches: ['dsh/mine'] });
    assert.equal(dry.ok, true);
    const entry = dry.namedBranches.find((branch) => branch.branch === 'dsh/mine');
    assert.equal(entry.wouldRemove, true);
    assert.equal(hasBranch(fx.work, 'dsh/mine'), true);
    const outside = await session.run('prune', { branches: ['main'] });
    assert.match(outside.namedBranches[0].error, /not under the branch prefix/);
    const applied = await session.run('prune', { branches: ['dsh/mine'], apply: true });
    assert.equal(applied.ok, true);
    assert.equal(hasBranch(fx.work, 'dsh/mine'), false);
  });

  test('from a directory holding repositories, prune sweeps each one', async () => {
    const fx = pruneFixture();
    const second = fx.parent + '/second';
    initRepo(second);
    gitOk(second, ['branch', 'dsh/orphan']);
    const result = await action('prune', {}, { config: config(), reference: fx.parent });
    assert.equal(result.ok, true);
    assert.equal(result.swept, true);
    assert.ok(result.repos.length >= 2);
    assert.match(result.detail, new RegExp(String(result.repos.length) + ' repositories swept'));
    assert.equal(result.repos.some((repo) => repo.path === second), true);
  });

  test('a directory with no repositories is named as such', async () => {
    const dir = tempDir();
    const result = await action('prune', {}, { config: config(), reference: dir });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-a-repo');
  });
});
