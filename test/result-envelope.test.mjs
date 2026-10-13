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
import { createGitTool } from '../lib/tool.mjs';
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

test('the declared output schema is permissive, so it cannot reject a real result', () => {
  // lib/tool.mjs documents this schema as a floor rather than a contract. A
  // required field, or a closed object, would turn a real result into an error
  // the model cannot read — the failure mode the shape exists to prevent.
  const tool = createGitTool({ get: () => undefined }, {});
  const walk = (node, where) => {
    if (node === null || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.notEqual(node.additionalProperties, false, where + ' allows additional properties');
      assert.equal(node.required, undefined, where + ' requires nothing');
      for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, where + '.' + key);
    }
    if (node.type === 'array' && node.items !== undefined) walk(node.items, where + '[]');
  };
  walk(tool.output.schema, 'output');
});
