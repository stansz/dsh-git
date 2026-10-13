/**
 * The touched-file store, under the one condition that used to erase it.
 *
 * `lib/session-files.mjs` answers one question: at the end of a turn, which
 * repositories does this session have to commit? The answer is kept in a file
 * that only grows while a session works, and past MAX_BYTES a read used to
 * truncate that file to nothing — so a long session read back an empty store,
 * the turn end committed nothing, and nothing said so.
 *
 * These cases drive the real module against real files: real records through
 * `record()`, real reads through `reposOf()` and `pathsOf()`, and a real commit
 * through `syncRepo()`. Nothing here is mocked, because the defect is in the
 * file handling and a mock would have taken the file handling away with it.
 *
 * Each case gets the suite's own case directory and a scratch store directory
 * inside it, and both are removed at the end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { syncRepo } from '../lib/turn-commit.mjs';
// A namespace import rather than named imports, so that a checkout predating
// `forgetRepo` reports the missing function as a failing test instead of failing
// to load every test in this file with a SyntaxError.
import * as store from '../lib/session-files.mjs';
import { git, makeCase } from './helpers.mjs';

/** The module's cap, restated here because the boundary is what is under test. */
const MAX_BYTES = 1_000_000;

/** One row in the module's own one-JSON-object-per-line format. */
function row(repoRoot, path) {
  return JSON.stringify({ repoRoot, path });
}

/** Write a store by hand, in the format the module reads. */
function seedStore(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

/** The rows a store holds on disk, oldest first. */
function storeRows(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** A case whose scratch store lives inside it, both removed when the case ends. */
function scratchCase(t, name) {
  const c = makeCase(name);
  const scratch = join(c.root, 'scratch');
  t.after(() => {
    rmSync(scratch, { recursive: true, force: true });
    c.cleanup();
  });
  return { c, scratch, opts: { stateRoot: scratch } };
}

test('a read past the cap keeps the newest rows and drops the oldest, never the store', (t) => {
  const { c, opts } = scratchCase(t, 'session-files-trim');
  const file = store.indexPath(c.sessionId, opts);

  const oldest = '/repos/oldest';
  const middle = '/repos/middle';
  const newest = '/repos/newest';
  const newestPath = newest + '/final.txt';

  const lines = [];
  // The oldest rows sit at the front of the file, and more than MAX_BYTES of
  // rows follow them, so a trim that keeps the newest bytes cannot keep these.
  for (let index = 0; index < 5; index += 1) lines.push(row(oldest, oldest + '/old-' + String(index) + '.txt'));
  let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
  for (let index = 0; bytes <= MAX_BYTES + 200_000; index += 1) {
    const line = row(middle, middle + '/file-' + String(index).padStart(6, '0') + '.txt');
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  // The newest row goes last: the one record that has to survive the read.
  lines.push(row(newest, newestPath));
  seedStore(file, lines);
  assert.ok(statSync(file).size > MAX_BYTES, 'the fixture is over the cap, which is the condition under test');

  const repos = store.reposOf(c.sessionId, opts);
  assert.equal(repos[0], newest, 'the newest record is what the turn end reads first');
  assert.ok(repos.includes(middle), 'rows under the cap are not collateral damage');
  assert.equal(repos.includes(oldest), false, 'the rows that disappeared are the oldest ones');
  assert.deepEqual(store.pathsOf(c.sessionId, oldest, opts), [], 'nothing of the oldest repository is left');
  assert.deepEqual(store.pathsOf(c.sessionId, newest, opts), [newestPath], 'the newest record survives the read');

  // The trim is on disk, not just in the array this read returned: a second
  // read is a fresh read of the file.
  assert.ok(statSync(file).size <= MAX_BYTES, 'the store is trimmed to the cap');
  const persisted = storeRows(file);
  assert.ok(persisted.length > 0 && persisted.length < lines.length, 'the store shrank without being emptied');
  assert.deepEqual(persisted[persisted.length - 1], { repoRoot: newest, path: newestPath }, 'the newest row is the last row on disk');
  assert.equal(readFileSync(file, 'utf8').includes('/old-0.txt'), false, 'the oldest rows are gone from the file');
  assert.equal(store.reposOf(c.sessionId, opts)[0], newest, 'a second read still finds the newest record');
});

test('forgetRepo removes exactly one repository and keeps the others', (t) => {
  const { c, opts } = scratchCase(t, 'session-files-forget-repo');
  const file = store.indexPath(c.sessionId, opts);
  const alpha = '/repos/alpha';
  const beta = '/repos/beta';
  const gamma = '/repos/gamma';

  for (const repoRoot of [alpha, beta, gamma]) {
    assert.equal(store.record(c.sessionId, repoRoot, repoRoot + '/first.txt', opts), true);
    assert.equal(store.record(c.sessionId, repoRoot, repoRoot + '/second.txt', opts), true);
  }
  assert.deepEqual(store.reposOf(c.sessionId, opts), [gamma, beta, alpha], 'most recently touched first');

  assert.equal(store.forgetRepo(c.sessionId, beta, opts), true);
  assert.deepEqual(store.reposOf(c.sessionId, opts), [gamma, alpha], 'beta is the only repository forgotten');
  assert.deepEqual(store.pathsOf(c.sessionId, beta, opts), []);
  assert.deepEqual(store.pathsOf(c.sessionId, alpha, opts), [alpha + '/second.txt', alpha + '/first.txt']);
  assert.deepEqual(store.pathsOf(c.sessionId, gamma, opts), [gamma + '/second.txt', gamma + '/first.txt']);
  assert.equal(storeRows(file).some((entry) => entry.repoRoot === beta), false, 'no beta row is left on disk');
  assert.equal(storeRows(file).length, 4, 'the other repositories keep every row they had');

  // Forgetting a repository this session never touched is not an error, and it
  // changes nothing.
  const before = readFileSync(file, 'utf8');
  assert.equal(store.forgetRepo(c.sessionId, '/repos/never-recorded', opts), true);
  assert.equal(readFileSync(file, 'utf8'), before, 'a no-op forget leaves the store alone');

  // And a nonsensical call is refused rather than thrown.
  assert.equal(store.forgetRepo(c.sessionId, '', opts), false);
  assert.equal(store.forgetRepo('', beta, opts), false);
});

test('record, reposOf and pathsOf round-trip through the real store', (t) => {
  const { c, opts } = scratchCase(t, 'session-files-round-trip');
  const file = store.indexPath(c.sessionId, opts);
  const one = '/repos/one';
  const two = '/repos/two';

  assert.equal(store.record(c.sessionId, one, one + '/a.txt', opts), true);
  assert.equal(store.record(c.sessionId, one, one + '/a.txt', opts), true, 'the same file twice is two records');
  assert.equal(store.record(c.sessionId, two, two + '/b.txt', opts), true);

  assert.deepEqual(store.reposOf(c.sessionId, opts), [two, one], 'most recently touched first');
  assert.deepEqual(store.pathsOf(c.sessionId, one, opts), [one + '/a.txt'], 'a file recorded twice is one path');
  assert.deepEqual(store.pathsOf(c.sessionId, two, opts), [two + '/b.txt']);
  assert.equal(storeRows(file).length, 3, 'one line per record');

  // A session that never recorded anything reads as untouched rather than
  // throwing, and so does an unusable argument.
  assert.deepEqual(store.reposOf('session-never-recorded', opts), []);
  assert.deepEqual(store.pathsOf('session-never-recorded', one, opts), []);
  assert.equal(store.record(c.sessionId, one, '', opts), false);

  // A torn final line from an interrupted write is skipped, and the records
  // around it are not lost.
  appendFileSync(file, '{"repoRoot":"/repos/t', 'utf8');
  assert.deepEqual(store.pathsOf(c.sessionId, one, opts), [one + '/a.txt']);
  assert.deepEqual(store.reposOf(c.sessionId, opts), [two, one]);
});

test('a commit that really landed forgets its repository, a skipped one does not', async (t) => {
  const c = makeCase('session-files-after-commit');
  t.after(() => c.cleanup());
  const opts = { stateRoot: c.config.stateRoot };
  const touched = join(c.repoDir, 'touched.txt');

  writeFileSync(touched, 'a file the session touched\n');
  assert.equal(store.record(c.sessionId, c.repoDir, touched, opts), true);
  assert.deepEqual(store.reposOf(c.sessionId, opts), [c.repoDir], 'the turn end has work to commit');

  const synced = await syncRepo(c.repoDir, c.config, c.sessionId, ['touched.txt'], { turn: 4 });
  assert.equal(synced.committed, true, 'the automatic commit landed');
  assert.match(git(c.repoDir, ['log', '-1', '--format=%s']), /touched\.txt/u);
  assert.deepEqual(store.reposOf(c.sessionId, opts), [], 'the committed repository is forgotten');
  assert.deepEqual(store.pathsOf(c.sessionId, c.repoDir, opts), []);

  // The same record on a repository whose commit was skipped survives: the
  // store only shrinks when the work really is in a commit.
  writeFileSync(touched, 'changed again, with the automatic commit off\n');
  assert.equal(store.record(c.sessionId, c.repoDir, touched, opts), true);
  const skipped = await syncRepo(c.repoDir, { ...c.config, turnCommit: false }, c.sessionId, ['touched.txt'], { turn: 5 });
  assert.equal(skipped.committed, false, 'nothing was committed');
  assert.deepEqual(store.reposOf(c.sessionId, opts), [c.repoDir], 'a skipped commit leaves the record alone');
  assert.deepEqual(store.pathsOf(c.sessionId, c.repoDir, opts), [touched]);
});
