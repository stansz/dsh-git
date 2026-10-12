/**
 * The suite's own footprint.
 *
 * A run borrows the workspace it runs in, and the README says it leaves nothing
 * behind. The one thing that quietly broke that was Finder metadata: macOS
 * writes a `.DS_Store` into a directory nobody opened, and a cleanup that
 * insisted on a truly empty directory left the root sitting there — a directory
 * in the workspace that looks exactly like the leak the rule exists to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { removeScratchRoot, workspaceRoot } from './helpers.mjs';

test('a root holding only Finder metadata is removed', (t) => {
  const root = join(workspaceRoot(), '.dsh-git-tests-cleanup-probe');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.DS_Store'), 'metadata');
  assert.equal(removeScratchRoot(root), true);
  assert.equal(existsSync(root), false);
});

test('a root still holding a case directory is left alone', (t) => {
  const root = join(workspaceRoot(), '.dsh-git-tests-cleanup-probe-kept');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'a-case'), { recursive: true });
  writeFileSync(join(root, '.DS_Store'), 'metadata');
  assert.equal(removeScratchRoot(root), false);
  assert.equal(existsSync(root), true, 'a case that failed to clean up has to stay visible');
});

test('a root that was never created is not an error', () => {
  const root = join(workspaceRoot(), '.dsh-git-tests-never-created');
  assert.equal(removeScratchRoot(root), true);
});
