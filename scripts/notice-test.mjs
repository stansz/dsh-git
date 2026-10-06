#!/usr/bin/env node
/**
 * A sync notice must never be able to break the session it reports on.
 *
 * notifyAgent() tells the model that a turn sync did not finish, using
 * agent.inject(). That call is not ephemeral: it lands in the session log as an
 * agent/inbox/spliced row, and the inbox fold keys pending messages by id.
 *
 *   if (ids.has(message.id)) throw new Error(message.id + ' is already pending');
 *
 * So two notices pending at once without an id both key on undefined, the fold
 * throws, the projection fails, and the whole session becomes unloadable - not
 * just the note. That is not hypothetical: it is what happened to a real session
 * on this machine, at seq 1896 and 1901.
 *
 * This suite exists because adding source alone was shipped as the fix, and it
 * was not one: an id-less message still collides. Both fields are asserted here,
 * and the identity invariant is asserted the way the fold asserts it.
 *
 *   node scripts/notice-test.mjs
 *
 * Exits non-zero, naming the payload that would have corrupted a session.
 */

import { attentionText, notifyAgent } from '../lib/turn-commit.mjs';

const failures = [];
let assertions = 0;

const check = (condition, message) => {
  assertions += 1;
  if (!condition) failures.push(message);
};

/** One sync that could not finish, shaped like the real thing. */
const result = {
  repos: [{ repo: '/tmp/example/dsh-git', notes: ['not pushed: main is a protected branch'] }],
};

/** An agent that records exactly what would have been written to a session log. */
function recordingAgent() {
  const injected = [];
  let woke = 0;
  return {
    injected,
    wokeNow: () => woke,
    agent: {
      inject: (message) => { injected.push(message); },
      followup: () => { woke += 1; },
    },
  };
}

const ctx = { logger: { warn: () => {} } };

// Two turns that both failed to push. Both notices stay pending in the same
// inbox, which is the state that corrupted the real session.
const recorder = recordingAgent();
notifyAgent(ctx, recorder.agent, result);
notifyAgent(ctx, recorder.agent, result);

check(recorder.injected.length === 2, 'expected two notices, got ' + String(recorder.injected.length));

const expectedText = attentionText(result);

for (const [index, message] of recorder.injected.entries()) {
  const at = 'notice ' + String(index + 1);
  check(
    typeof message.id === 'string' && message.id !== '',
    at + ': no message id, so the inbox fold would reject it as a duplicate pending message',
  );
  check(message.role === 'user', at + ': role must be user, got ' + JSON.stringify(message.role));
  check(
    message.source !== null && typeof message.source === 'object' && message.source.kind === 'user',
    at + ': source.kind must be user, got ' + JSON.stringify(message.source),
  );
  check(Array.isArray(message.content) && message.content.length > 0, at + ': no content');
  const text = Array.isArray(message.content) ? message.content[0] && message.content[0].text : undefined;
  check(typeof text === 'string' && text.trim() !== '', at + ': content carries no text');
  check(text === expectedText, at + ': text is not what attentionText() produces');
}

// The invariant the fold enforces, asserted the way the fold asserts it: every
// pending message must carry its own identity.
const ids = new Set(recorder.injected.map((message) => message.id));
check(
  ids.size === recorder.injected.length,
  'two pending notices share an id (' + String(ids.size) + ' unique of ' + String(recorder.injected.length) +
    '), which fails the projection and takes the whole session with it',
);

// The notice still has to reach the model, and wake it.
check(recorder.wokeNow() === 2, 'followup() was not called once per notice; the note would sit unread');
const firstText =
  recorder.injected[0] && recorder.injected[0].content && recorder.injected[0].content[0] &&
  recorder.injected[0].content[0].text;
check(
  typeof firstText === 'string' && firstText.includes('could not finish syncing'),
  'the notice no longer says what happened',
);

if (failures.length > 0) {
  console.error('notice-test: ' + String(failures.length) + ' failure(s)');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log(
  'notice-test: OK - ' + String(assertions) + ' assertions; every sync notice carries a unique id and a source',
);
