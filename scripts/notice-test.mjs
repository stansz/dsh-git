#!/usr/bin/env node
/**
 * A sync notice must never break the session it reports on, and must never cry
 * wolf about a repository that is fine.
 *
 * Two defects live here, both found in a live profile rather than by reading:
 *
 *   1. notifyAgent() injected a message with no id. The call is durable
 *      session-log content, and the inbox fold keys pending messages by id, so
 *      two notices pending at once both keyed on undefined and the fold threw -
 *      which made the whole session unloadable, not just the note. Adding
 *      source alone shipped as the fix and was not one.
 *
 *   2. syncRepo() reported "not pushed: main is a protected branch" even when
 *      the branch was clean and level with its upstream, because the protected
 *      branch path had no equivalent of the ahead > 0 guard the turnPush path
 *      already had. Every turn on a spotless repository raised an alarm.
 *
 * Both directions of (2) are asserted: silence when there is nothing to push,
 * and an alarm when there really is.
 *
 *   node scripts/notice-test.mjs
 *
 * Runs anywhere: no network, no credentials. The repository it builds is local.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConfig } from '../lib/config.mjs';
import { attentionText, notifyAgent, syncRepo } from '../lib/turn-commit.mjs';

const failures = [];
let assertions = 0;

const check = (condition, message) => {
  assertions += 1;
  if (!condition) failures.push(message);
};

/* ------------------------------------------------------------------ *
 * 1. What notifyAgent() writes into the session log
 * ------------------------------------------------------------------ */

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

const ids = new Set(recorder.injected.map((message) => message.id));
check(
  ids.size === recorder.injected.length,
  'two pending notices share an id (' + String(ids.size) + ' unique of ' + String(recorder.injected.length) +
    '), which fails the projection and takes the whole session with it',
);

check(recorder.wokeNow() === 2, 'followup() was not called once per notice; the note would sit unread');

/* ------------------------------------------------------------------ *
 * 2. When the notice is allowed to speak
 * ------------------------------------------------------------------ */

const gitIn = (dir, args) => execFileSync(
  'git',
  ['-c', 'user.email=notice-test@example.invalid', '-c', 'user.name=notice-test',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

const root = mkdtempSync(join(tmpdir(), 'dsh-git-notice-'));
const home = join(root, 'home');
const repo = join(root, 'repo');
const origin = join(root, 'origin.git');
const previousHome = process.env.DSH_HOME;

try {
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  // Keep the plugin's session state out of the real profile.
  process.env.DSH_HOME = home;

  gitIn(repo, ['init']);
  gitIn(root, ['init', '--bare', origin]);
  writeFileSync(join(repo, 'a.txt'), 'a');
  gitIn(repo, ['add', 'a.txt']);
  gitIn(repo, ['commit', '-m', 'first']);
  gitIn(repo, ['remote', 'add', 'origin', origin]);
  gitIn(repo, ['push', '-u', 'origin', 'main']);

  const config = resolveConfig({});
  const sessionId = 'notice-test-session';

  // Clean, level with its upstream, on a protected branch: the steady state.
  const quiet = await syncRepo(repo, config, sessionId, [], { turn: 1 });
  check(
    Array.isArray(quiet.notes) && quiet.notes.length === 0,
    'a clean protected branch level with its upstream raised an alarm: ' + JSON.stringify(quiet.notes),
  );

  // One genuinely unpushed commit on the same branch: it must still speak up.
  gitIn(repo, ['commit', '--allow-empty', '-m', 'work that is not on the remote']);
  const loud = await syncRepo(repo, config, sessionId, [], { turn: 2 });
  check(
    Array.isArray(loud.notes) && loud.notes.some((note) => note.includes('not pushed')),
    'a real unpushed commit on a protected branch raised no alarm: ' + JSON.stringify(loud.notes),
  );
} catch (error) {
  failures.push('the local repository fixture failed: ' + String(error && error.message ? error.message : error));
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error('notice-test: ' + String(failures.length) + ' failure(s)');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log(
  'notice-test: OK - ' + String(assertions) +
    ' assertions; every notice carries a unique id and a source, and speaks only when work is really unpushed',
);
