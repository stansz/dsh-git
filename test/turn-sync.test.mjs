/**
 * The automatic half: at the end of a turn that changed files, the plugin
 * commits and pushes what is safe to push.
 *
 * syncRepo() is the function the turn boundary calls for one repository, so
 * driving it directly tests the real behaviour against real git rather than a
 * re-implementation of the message format or the push rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { turnSubject } from '../lib/render.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { pushDecision, runTurnSync, syncRepo } from '../lib/turn-commit.mjs';
import * as store from '../lib/session-files.mjs';
import { commitPaths, git, makeCase, remoteBranches } from './helpers.mjs';

test('a turn that changed a file is committed and pushed from its own worktree', async (t) => {
  const c = makeCase('turn-sync');
  t.after(() => c.cleanup());

  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug: 'auto' }, c.context());
  assert.equal(started.ok, true);
  const worktree = started.worktree;

  // A real edit, then the turn ends without anyone calling commit.
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'auto.txt'), 'written during a turn\n');

  const synced = await syncRepo(worktree, c.config, c.sessionId, ['src/auto.txt'], { turn: 7 });
  assert.equal(synced.committed, true);
  assert.equal(synced.subject, 'dsh: turn 7 \u2014 auto.txt', 'the subject names the file, as the history does');
  assert.equal(synced.pushed, true, 'a task branch is safe to push');
  assert.ok(remoteBranches(c.originDir).includes('dsh/auto'), 'the commit is on the remote');

  // Exactly the file the turn changed, with the trailer the plugin documents.
  const head = git(worktree, ['log', '-1', '--format=%H']);
  assert.deepEqual(commitPaths(worktree, head), ['src/auto.txt']);
  assert.match(git(worktree, ['log', '-1', '--format=%b']), /Assisted-by: DSH/u);
});

test('a repository git cannot read is reported, not thrown about', async (t) => {
  const c = makeCase('turn-sync-unreadable');
  t.after(() => c.cleanup());

  // A path this session is recorded as having changed, which is not a repository:
  // git cannot run there, so `git worktree list` fails and the listing answers
  // undefined — which is not an empty list. Reading `.length` off it threw a
  // TypeError out of the whole sync, so the model was told about a property of
  // undefined instead of about the repository that could not be read, and the
  // worktree close never ran.
  const plain = join(c.root, 'plain-directory');
  mkdirSync(plain, { recursive: true });
  const file = join(plain, 'file.txt');
  writeFileSync(file, 'not in a repository\n');
  assert.equal(store.record(c.sessionId, plain, file, { stateRoot: c.config.stateRoot }), true);

  const synced = await runTurnSync({ config: c.config, cwd: c.root, sessionId: c.sessionId, turn: undefined });
  assert.equal(synced.ok, true, 'the sync finishes and reports');
  const entry = synced.repos.find((repo) => repo.repo === plain);
  assert.ok(entry !== undefined, 'the repository it could not read is named');
  assert.equal(entry.committed, false);
  assert.ok((entry.notes ?? []).length > 0, 'and the reason is in the report rather than in a throw');
});

test('a deliberate commit is not named after a turn', () => {
  // Action "commit" and action "finish" used to build "dsh: turn 0 — <paths>" and
  // then strip the prefix back out of the string with a replace. No turn is
  // involved in either of them, and one input — no paths at all — left the
  // stripped text saying "dsh: turn 0".
  assert.equal(turnSubject(undefined, []), 'dsh: automatic commit');
  assert.equal(turnSubject(undefined, ['src/a.mjs', 'b.mjs']), 'dsh: a.mjs, b.mjs');
});

test('the push rule refuses the branches that would rewrite shared work', () => {
  // The resolved configuration the Host hands the turn boundary.
  const config = resolveConfig({});
  assert.equal(pushDecision(config, 'main', []).allowed, false);
  assert.equal(pushDecision(config, 'master', []).allowed, false);
  assert.equal(pushDecision(config, 'feature', []).allowed, false);
  assert.equal(pushDecision(config, 'dsh/task', []).allowed, true);
  assert.equal(pushDecision(config, 'feature', ['feature']).allowed, true, 'the branch of a worktree this session owns is safe');
});
