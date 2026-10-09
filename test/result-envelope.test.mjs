/**
 * Every action names itself in its result.
 *
 * The envelope is what a model reads to decide what happened, and the GitHub
 * error paths are the ones a repository without a github.com remote always
 * takes, so they are the ones worth pinning.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAction } from '../lib/actions.mjs';
import { makeCase } from './helpers.mjs';

test('pr and merge report their own action when the remote is not GitHub', async (t) => {
  const c = makeCase('result-envelope');
  t.after(() => c.cleanup());

  const pr = await runAction('pr', { action: 'pr', repo: c.repoDir }, c.context());
  assert.equal(pr.ok, false);
  assert.equal(pr.error.code, 'not-github');
  assert.equal(pr.action, 'pr');

  const merge = await runAction('merge', { action: 'merge', repo: c.repoDir }, c.context());
  assert.equal(merge.ok, false);
  assert.equal(merge.error.code, 'not-github');
  assert.equal(merge.action, 'merge', 'a merge result must not claim to be a pr result');

  const finish = await runAction('finish', { action: 'finish', repo: c.repoDir }, c.context());
  assert.equal(finish.action, 'finish');
});
