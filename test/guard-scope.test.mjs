/**
 * What the guard does not cover, as a characterisation.
 *
 * The guard grades `git` invocations, so the same work through another program is
 * outside it. This case passes on both sides of the change that added the paragraph
 * to `docs/guard.md` on purpose: there is no defect to fix, only a limit to state,
 * and a test is how the statement stays true. If a `gh` table is ever added to the
 * guard, this is the case that fails — and the paragraph that needs rewriting with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../lib/guard.mjs';
import { resolveConfig } from '../lib/config.mjs';

const config = resolveConfig({});

/** The verdict for a command line, as the pre-execute hook would compute it. */
function verdict(command) {
  return evaluate({ name: 'bash', arguments: { command } }, config).kind;
}

test('the guard grades git, and nothing else that reaches the same place', () => {
  for (const command of [
    'git push origin main',
    'git push origin dsh/task',
    'git commit -am "x"',
    'git fetch --prune origin',
    'git config --global credential.helper osxkeychain',
    'git remote add origin https://github.com/octo/repo.git',
  ]) {
    assert.equal(verdict(command), 'deny', command + ' is gated');
  }
  assert.equal(verdict('git init -b main .'), 'ask', 'an unclassifiable subcommand asks instead');
  assert.equal(verdict('git status'), 'allow', 'a read is allowed');

  for (const command of [
    'gh pr merge 12 --merge --delete-branch',
    'gh repo delete octo/repo --yes',
    'gh api -X DELETE /repos/octo/repo/git/refs/heads/main',
    'gh pr create --fill',
    "bash -c 'gh repo delete octo/repo --yes'",
    'curl -X DELETE -H "Authorization: Bearer x" https://api.github.com/repos/octo/repo',
    'node -e "fetch(process.env.API)"',
  ]) {
    assert.equal(verdict(command), 'allow', command + ' is outside the guard — the limit docs/guard.md states');
  }
});
