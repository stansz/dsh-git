/**
 * The push refusal has to name the branch the caller actually pushed to.
 *
 * `protectedPushReason` read `protectedBranches[0]`, so the moment a deployment
 * listed a second name the message named the wrong branch: with
 * `[main, master, trunk]`, a push to `trunk` was refused as a push to `main`.
 * A refusal that misidentifies what it is refusing teaches the reader to
 * distrust the rest of the reason.
 *
 * The name now travels on the risk flag. The first two cases fail against the
 * library this replaces as soon as the branch under test is not the first in the
 * list; the third is the control, and it passes in both because the ordinary
 * push-door reason mentions protected branches without being one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../lib/config.mjs';
import { evaluate } from '../lib/guard.mjs';

const config = resolveConfig({ protectedBranches: ['main', 'master', 'trunk'] });

/** The verdict for a command line, as the pre-execute hook would compute it. */
function decide(command) {
  return evaluate({ name: 'bash', arguments: { command } }, config);
}

test('a push to any protected name is refused by that name', () => {
  for (const branch of ['main', 'master', 'trunk']) {
    const decision = decide('git push origin ' + branch);
    assert.equal(decision.kind, 'deny', branch + ' is protected, so a raw push to it is refused');
    assert.match(decision.reason, new RegExp('protected branch ' + branch + '(?![a-z])', 'u'),
      'the reason names ' + branch + ', the branch that matched');
    assert.match(decision.displayReason, new RegExp('"' + branch + '"', 'u'),
      'and the short reason the UI shows names it too');
  }
  // The wrong-branch failure, stated on its own so it cannot hide behind a loop.
  const trunk = decide('git push origin trunk');
  assert.doesNotMatch(trunk.reason, /protected branch main/u, 'not the first name in the list');
});

test('a refspec destination is named as well as a positional branch', () => {
  const refspec = decide('git push origin HEAD:trunk');
  assert.equal(refspec.kind, 'deny');
  assert.match(refspec.reason, /protected branch trunk/u, 'the destination of the refspec is what matched');
});

test('a push that matches nothing protected is refused for its own reason', () => {
  const task = decide('git push origin dsh/task');
  assert.equal(task.kind, 'deny', 'a raw push in bash is gated whatever the branch');
  // The ordinary push-door reason explains that action "push" refuses a protected
  // branch — describing the tool, not this command — so the test asserts the
  // phrasing that claims THIS push is one, not the words "protected branch".
  assert.doesNotMatch(task.reason, /to the protected branch/u, 'it is not refused as a push to one');
  assert.match(task.reason, /action "push" pushes this worktree/u, 'it is the ordinary push-door reason');
  assert.match(task.displayReason, /Use the git tool/u);
});
