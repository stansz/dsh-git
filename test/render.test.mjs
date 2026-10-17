/**
 * What the model and the composer actually read.
 *
 * These tests drive the real actions and render their real results, because the
 * renderer's job is to describe what happened — a hand-built result object would
 * prove the formatter works on input the tool never produces. The first line
 * rule is the one worth pinning: the state that needs action comes first.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  action,
  branches,
  commitAll,
  config,
  fixture,
  githubFixture,
  githubServer,
  gitOk,
  sessionId,
  tempDir,
  writeFiles,
  cleanupTemps,
} from './support.mjs';
import { render, summarize, turnSubject as renderTurnSubject, verdictFor } from '../lib/render.mjs';
import { messageFor, TRAILER } from '../lib/turn-commit.mjs';

after(cleanupTemps);

function session(working, overrides = {}) {
  const cfg = { ...config(), ...overrides };
  const sid = sessionId();
  return {
    cfg,
    run: (name, args = {}) => action(name, { repo: working, ...args }, { config: cfg, reference: working, sessionId: sid }),
  };
}

/* ================================================================== */
describe('status', () => {
  test('a clean repository leads with OK and names the branch', async () => {
    const fx = fixture();
    const result = await action('status', { repo: fx.work }, { config: config(), reference: fx.work });
    const text = render(result);
    assert.match(text, /^OK {2}main — in sync with origin\/main/u);
    assert.match(text, /at \/.*\/work/u);
    assert.match(text, /worktrees:/u);
    assert.equal(verdictFor(result.repo), 'clean');
  });

  test('a dirty repository leads with DIRTY and lists the paths', async () => {
    const fx = fixture();
    writeFiles(fx.work, { 'changed.txt': 'changed' });
    const result = await action('status', { repo: fx.work }, { config: config(), reference: fx.work });
    const text = render(result);
    assert.match(text, /^DIRTY {2}main/u);
    assert.match(text, /1 changed path\(s\):/u);
    assert.match(text, /changed\.txt/u);
  });

  test('an unpushed commit leads with UNPUSHED and the count', async () => {
    const fx = fixture();
    writeFiles(fx.work, { 'local.txt': 'local' });
    commitAll(fx.work, 'local');
    const result = await action('status', { repo: fx.work }, { config: config(), reference: fx.work });
    const text = render(result);
    assert.match(text, /^UNPUSHED {2}main — 1 ahead origin\/main/u);
  });

  test('a sweep of several repositories renders each one', async () => {
    const root = tempDir();
    const first = fixture();
    const second = fixture();
    const one = await action('status', { repo: first.work }, { config: config(), reference: first.work });
    const sweep = await action('status', { sweep: true }, { config: config(), reference: root });
    assert.match(render(sweep), /no git repository here/);
    assert.match(render(one), /^OK {2}main/u);
    assert.match(summarize(sweep), /0 repo\(s\), 0 needing action/);
    assert.ok(branches(second.work).includes('main'));
    assert.match(summarize({ action: 'status', ok: true, repos: [{ dirty: true, branch: 'main' }] }), /1 repo\(s\), 1 needing action/);
  });
});

/* ================================================================== */
describe('save and publish', () => {
  test('a commit names the sha, the subject and the paths', async () => {
    const fx = fixture();
    const s = session(fx.work);
    writeFiles(fx.work, { 'a.txt': 'a' });
    const result = await s.run('save', { paths: ['a.txt'], message: 'add a' });
    const text = render(result);
    assert.match(text, /^OK {2}committed [0-9a-f]{9,} on main/u);
    assert.match(text, /add a/u);
    assert.match(text, /1 path\(s\):/u);
    assert.match(text, /a\.txt/u);
  });

  test('nothing to commit reads as an answer', async () => {
    const fx = fixture();
    const s = session(fx.work);
    assert.match(render(await s.run('save')), /^OK {2}nothing to commit on main/u);
  });

  test('a push names the branch and the remote, and says when it set the upstream', async () => {
    const fx = fixture();
    const s = session(fx.work);
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/task']);
    writeFiles(fx.work, { 'task.txt': 'task' });
    commitAll(fx.work, 'task');
    const text = render(await s.run('publish'));
    assert.match(text, /^OK {2}pushed dsh\/task to origin/u);
    assert.match(text, /upstream set for this branch/u);
    assert.match(render(await s.run('publish')), /^OK {2}nothing to push on dsh\/task/u);
  });
});

/* ================================================================== */
describe('sync and finish', () => {
  test('a fast-forward shows the movement', async () => {
    const fx = fixture();
    const peer = fx.parent + '/peer';
    gitOk(fx.parent, ['clone', '-q', fx.bare, peer]);
    gitOk(peer, ['config', 'user.name', 'Peer']);
    gitOk(peer, ['config', 'user.email', 'peer@example.invalid']);
    writeFiles(peer, { 'remote.txt': 'remote' });
    commitAll(peer, 'remote');
    gitOk(peer, ['push', '-q', 'origin', 'main']);
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/behind']);
    const text = render(await action('sync', { repo: fx.work }, { config: config(), reference: fx.work }));
    assert.match(text, /^OK {2}synced with main/u);
    assert.match(text, /fast-forwarded [0-9a-f]+ -> [0-9a-f]+/u);
  });

  test('a finished session shows the commit, the push and why no pull request was opened', async () => {
    const fx = fixture();
    const s = session(fx.work);
    writeFiles(fx.work, { 'done.txt': 'done' });
    const text = render(await s.run('finish'));
    assert.match(text, /^OK {2}finish/u);
    assert.match(text, /committed [0-9a-f]{9,} — /u);
    assert.match(text, /pushed main to origin/u);
    assert.match(text, /no pull request: Origin is not a github\.com remote/u);
  });

  test('a failure leads with FAIL, the code, the message and the next step', async () => {
    const dir = tempDir();
    const result = await action('save', {}, { config: config(), reference: dir });
    const text = render(result);
    assert.match(text, /^FAIL {2}save \(not-a-repo\)/u);
    assert.match(text, /No git repository at/u);
    assert.match(summarize(result), /^save failed: /u);
  });
});

/* ================================================================== */
describe('prune', () => {
  function pruneFixture() {
    const fx = fixture();
    gitOk(fx.work, ['branch', 'dsh/orphan']);
    return fx;
  }

  test('a dry run shows what would be removed', async () => {
    const fx = pruneFixture();
    const s = session(fx.work);
    const text = render(await s.run('prune'));
    assert.match(text, /^OK {2}prune \(dry run\)/u);
    assert.match(text, /to remove: 1 orphaned branch — pass apply: true/u);
    assert.match(text, /branch dsh\/orphan {2}— no worktree, and no commits of its own/u);
  });

  test('an applied run says what it removed', async () => {
    const fx = pruneFixture();
    const s = session(fx.work);
    const text = render(await s.run('prune', { apply: true }));
    assert.match(text, /^OK {2}prune applied/u);
    assert.match(text, /removed 1 orphaned branch/u);
    assert.equal(branches(fx.work).includes('dsh/orphan'), false);
  });

  test('a branch proven merged by its pull request is shown, not hidden', async (t) => {
    const fx = githubFixture();
    const server = githubServer({ repos: [{ owner: fx.owner, repo: fx.repo, dir: fx.bare, host: fx.host }] });
    t.after(() => server.restore());
    const s = session(fx.work, { githubHost: fx.host });
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/merged']);
    writeFiles(fx.work, { 'merged.txt': 'merged' });
    commitAll(fx.work, 'merged');
    gitOk(fx.work, ['push', '-q', '-u', 'origin', 'dsh/merged']);
    assert.equal((await s.run('pr')).ok, true);
    assert.equal((await s.run('merge')).ok, true);
    gitOk(fx.work, ['checkout', '-q', 'main']);
    const dry = render(await s.run('prune'));
    assert.match(dry, /to remove: 1 branch proven merged by its pull request/u);
    assert.match(dry, /pull request #1 was merged; pass apply: true to remove it/u);
    const applied = render(await s.run('prune', { apply: true }));
    assert.match(applied, /removed 1 branch proven merged by its pull request/u);
    assert.match(applied, /was merged; removed/u);
  });
});

/* ================================================================== */
describe('pull request rendering', () => {
  test('an opened pull request renders its number, URL and branches', async (t) => {
    const fx = githubFixture();
    const server = githubServer({ repos: [{ owner: fx.owner, repo: fx.repo, dir: fx.bare, host: fx.host }] });
    t.after(() => server.restore());
    const s = session(fx.work, { githubHost: fx.host });
    gitOk(fx.work, ['checkout', '-q', '-b', 'dsh/task']);
    writeFiles(fx.work, { 'task.txt': 'task' });
    commitAll(fx.work, 'the task');
    gitOk(fx.work, ['push', '-q', '-u', 'origin', 'dsh/task']);
    const text = render(await s.run('pr'));
    assert.match(text, /^OK {2}opened pull request/u);
    assert.match(text, /#1 {2}open {2}https:\/\/github\.com\//u);
    assert.match(text, /dsh\/task -> main/u);
    assert.match(render(await s.run('status', { pull: true })), /pull request: #1/u);
    assert.match(render(await s.run('merge')), /^OK {2}merged #1 \(merge\)/u);
  });
});

/* ================================================================== */
describe('turn subject', () => {
  test('names the paths, and never invents a turn number', () => {
    assert.equal(renderTurnSubject(undefined, ['a/b.txt']), 'dsh: b.txt');
    assert.equal(renderTurnSubject(undefined, ['a.txt', 'b.txt', 'c.txt', 'd.txt']), 'dsh: a.txt, b.txt, c.txt +1');
    assert.equal(renderTurnSubject(7, ['a.txt']), 'dsh: turn 7 — a.txt');
    assert.equal(renderTurnSubject(undefined, []), 'dsh: automatic commit');
  });

  test('a turn commit message is the subject plus the trailer', () => {
    const message = messageFor({ turnCommitMessage: '' }, undefined, ['a/b.txt']);
    assert.match(message, /^dsh: b\.txt/u);
    assert.ok(message.endsWith(TRAILER));
  });

  test('a configured template substitutes the turn and the paths', () => {
    const message = messageFor({ turnCommitMessage: 'turn {turn}: {paths}' }, 4, ['x/y.txt', 'z.txt']);
    assert.equal(message.split('\n')[0], 'turn 4: x/y.txt, z.txt');
    assert.ok(message.endsWith(TRAILER));
    const noTurn = messageFor({ turnCommitMessage: 'turn {turn} done' }, undefined, ['a.txt']);
    assert.equal(noTurn.split('\n')[0], 'turn  done');
  });
});
