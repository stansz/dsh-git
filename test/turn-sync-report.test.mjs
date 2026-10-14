/**
 * The settled sync has to speak, and it must not wait two seconds to do it.
 *
 * Two silences, measured live:
 *
 *   - D29. A settled sync spent 2024-2118 ms between its "settled session" line
 *     and its "settled sync" line, all of it SUMMARY_WAIT_MS waited out for a
 *     per-turn recorder summary that never arrives. The reader was present and
 *     the recorder service was present; the answer was not.
 *   - D26. Under the shipped `turnSyncScope: 'session'`, a dirty repository this
 *     session never recorded was neither committed nor mentioned. Files written
 *     through `bash` are never recorded, so work can sit uncommitted in a
 *     repository the sync looked at and skipped, with nothing to say so.
 *   - D16 (the caller half). A push failure whose backoff could not be stored was
 *     still reported as "(attempt N)", which reads as a scheduled retry. When the
 *     write does not persist, `shouldRetryPush` answers true and the next sync
 *     tries again immediately — so the notice has to say the failure was not
 *     recorded, not promise a backoff that is not on disk.
 *
 * Every case drives the real `registerTurnSync`/`runTurnSync` against real
 * repositories, and asserts what the sync says, and how long it takes, rather
 * than re-implementing either.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAction } from '../lib/actions.mjs';
import { record } from '../lib/session-files.mjs';
import * as state from '../lib/state.mjs';
import { attentionText, needsAttention, registerTurnSync, runTurnSync, summarizeSync } from '../lib/turn-commit.mjs';
import { git, makeCase } from './helpers.mjs';

/** The quiet period these cases use: short, because the reports are what is tested. */
const SETTLE_MS = 200;

/**
 * How much longer the silent-recorder settle may take than the same settle with
 * no recorder to wait for at all.
 *
 * Relative on purpose. An absolute bound measured the machine rather than the
 * plugin: under three concurrent suites the same path took 1601–2437 ms against
 * a 1500 ms bound while the two-second wait was provably unreachable, so the
 * case failed on a busy machine and passed on an idle one. A regressed wait is a
 * 2000 ms step change, which a baseline measured on the same machine cannot
 * absorb.
 */
const WAIT_MARGIN_MS = 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `read` is true. Returns whether it became true before the deadline. */
async function until(read, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (read()) return true;
    if (Date.now() >= deadline) return false;
    await wait(20);
  }
}

/** The commit subject at HEAD. */
function headSubject(repoDir) {
  return git(repoDir, ['log', '-1', '--format=%s']);
}

/** The plugin's own diagnostics file for a case. */
const boundaryLog = (c) => join(c.root, 'state', 'dsh-git', 'boundary.log');

/**
 * How long the settled sync took, from its "settled session" line to its
 * "settled sync" line — the exact interval D29 was measured as.
 *
 * Undefined until a settle has completed. The lines carry ISO timestamps, so the
 * measurement is the plugin's own, not the test's.
 */
function settledElapsedMs(c) {
  let text = '';
  try {
    text = readFileSync(boundaryLog(c), 'utf8');
  } catch {
    return undefined;
  }
  let startedAt;
  for (const line of text.split('\n')) {
    const match = /^(\S+) settled (session|sync repos)=/u.exec(line);
    if (match === null) continue;
    if (match[2] === 'session') startedAt = Date.parse(match[1]);
    else if (startedAt !== undefined) return Date.parse(match[1]) - startedAt;
  }
  return undefined;
}

/**
 * A Host, reduced to what the plugin uses, with a recorder that can be told how
 * to behave.
 *
 *   recorder: undefined          no recorder service at all (no wait is armed)
 *   recorder: 'silent'           present, its log has an announcement, and it can
 *                                never serve that announcement's summary — the
 *                                shape a Host restart leaves behind
 *   recorder: {files, afterMs}   present, and it answers with `files` once
 *                                `afterMs` has passed (immediately by default)
 */
function fakeHost(c, options = {}) {
  const handlers = new Map();
  const injected = [];
  const woken = [];
  const warnings = [];
  const infos = [];
  const agent = {
    id: c.sessionId,
    inject: (message) => injected.push(message),
    followup: () => woken.push(Date.now()),
  };
  const recorder = options.recorder;
  const session = recorder === undefined
    ? { id: c.sessionId, header: { cwd: c.reference } }
    : { id: c.sessionId, header: { cwd: c.reference }, seq: 4, eventAt: () => ({ type: 'workspace/changes' }) };
  const openedAt = Date.now();
  const changes = recorder === undefined ? undefined : {
    summary: () => {
      if (recorder === 'silent') return undefined;
      if (Date.now() - openedAt < (recorder.afterMs ?? 0)) return undefined;
      return { files: (recorder.files ?? []).map((path) => ({ path })) };
    },
  };
  const services = { sessions: { get: () => session }, workspaceChanges: changes };
  const ctx = {
    on: (name, handler) => { handlers.set(name, handler); },
    logger: { info: (line) => infos.push(String(line)), warn: (line) => warnings.push(String(line)) },
    get: (name) => services[name],
  };
  const dispose = registerTurnSync(ctx, options.config ?? c.config, { settleMs: options.settleMs ?? SETTLE_MS });
  return {
    agent, injected, woken, warnings, infos, dispose,
    toolCall: () => handlers.get('tools/pre-execute')?.({ agent }, () => undefined),
    turnStopping: (turn) => handlers.get('agent/turn-stopping')?.({ agent, turn, signal: undefined }),
  };
}

/** A second real repository under the case root, dirty and never recorded. */
function otherRepo(c) {
  const dir = join(c.root, 'other');
  git(c.root, ['clone', c.originDir, dir]);
  writeFileSync(join(dir, 'theirs.txt'), 'written without the file tools\n');
  return dir;
}

test('a settled sync does not spend the two-second wait on a recorder that cannot answer', async (t) => {
  // Two settles, back to back on this machine: the baseline has no readPaths at
  // all, so the wait is unreachable by construction, and the other has a recorder
  // that cannot answer — the D29 case. Comparing them is what makes the
  // assertion about the plugin instead of about the load on the machine.
  const baselineCase = makeCase('report-silent-recorder-baseline');
  const silentCase = makeCase('report-silent-recorder');
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.dispose();
    baselineCase.cleanup();
    silentCase.cleanup();
  });

  /** One recorded turn, one tool call, and the interval the settle really took. */
  const settleOnce = async (c, options) => {
    const file = join(c.repoDir, 'written.txt');
    writeFileSync(file, 'written during a turn\n');
    assert.equal(record(c.sessionId, c.repoDir, file, { stateRoot: c.config.stateRoot }), true);
    const host = fakeHost(c, options);
    hosts.push(host);
    host.toolCall();
    assert.equal(await until(() => settledElapsedMs(c) !== undefined), true, 'the settled sync really ran');
    return settledElapsedMs(c);
  };

  const baseline = await settleOnce(baselineCase, {});
  const elapsed = await settleOnce(silentCase, { recorder: 'silent' });

  assert.equal(headSubject(silentCase.repoDir), 'dsh: written.txt', 'and the work is still committed, as before');
  assert.ok(
    elapsed < baseline + WAIT_MARGIN_MS,
    'the wait is not spent on an answer that is not coming: ' + String(elapsed)
      + 'ms against a baseline of ' + String(baseline) + 'ms',
  );
});

test('a recorder that answers late is still waited for at a turn boundary', async (t) => {
  const c = makeCase('report-late-recorder');
  const reported = join(c.repoDir, 'from-recorder.txt');
  writeFileSync(reported, 'reported by the recorder\n');
  // Deliberately NOT recorded in the session store: the recorder's list is the
  // only thing that can put this repository in scope at all.
  const host = fakeHost(c, { recorder: { files: [reported], afterMs: 400 } });
  t.after(async () => {
    await host.dispose();
    c.cleanup();
  });

  const before = headSubject(c.repoDir);
  host.turnStopping(3);
  assert.equal(await until(() => headSubject(c.repoDir) !== before), true, 'the boundary sync ran and committed');
  assert.equal(headSubject(c.repoDir), 'dsh: turn 3 \u2014 from-recorder.txt', 'named by the recorder list that arrived after the boundary');
});

test('a dirty repository this session never recorded is reported and left uncommitted', async (t) => {
  const c = makeCase('report-left-alone');
  // The case has to go, or the suite's own root sweep finds a directory that is
  // not empty and refuses to remove the root — which is how three cases from this
  // file ended up left in the workspace after every run.
  t.after(() => c.cleanup());
  const config = { ...c.config, turnPush: false };
  // The session's own repository: recorded, dirty, and committed by the sync.
  const mine = join(c.repoDir, 'mine.txt');
  writeFileSync(mine, 'this session wrote it\n');
  assert.equal(record(c.sessionId, c.repoDir, mine, { stateRoot: c.config.stateRoot }), true);
  const other = otherRepo(c);

  const synced = await runTurnSync({ config, cwd: c.root, sessionId: c.sessionId, turn: undefined });

  const committed = synced.repos.find((entry) => entry.repo === c.repoDir);
  assert.equal(committed?.committed, true, 'the session\'s own work is committed, as always');
  assert.equal(synced.repos.some((entry) => entry.repo === other), false, 'the untouched repository is not synced');
  assert.equal(synced.leftAlone.length, 1, 'and the sync names it as left alone');
  assert.equal(synced.leftAlone[0].repo, other);
  assert.equal(synced.leftAlone[0].changed, 1, 'with how much is sitting there');
  assert.match(synced.leftAlone[0].notes.join(' '), /never recorded by this session/u);
  assert.equal(git(other, ['status', '--porcelain']), '?? theirs.txt', 'the control: it is still uncommitted');
  assert.equal(headSubject(other), 'chore: the fixture repository', 'and nothing was committed in it');
  assert.equal(needsAttention(synced), true, 'the sync speaks about it');
  assert.match(attentionText(synced), /left 1 dirty repository uncommitted/u);
  assert.match(attentionText(synced), /other/u);
  assert.match(summarizeSync(synced), /1 left alone \(other\)/u);
});

test('the workspace scope has nothing left alone, because it commits every dirty repository', async (t) => {
  const c = makeCase('report-workspace-scope');
  t.after(() => c.cleanup());
  const config = { ...c.config, turnSyncScope: 'workspace', turnPush: false };
  const other = otherRepo(c);

  const synced = await runTurnSync({ config, cwd: c.root, sessionId: c.sessionId, turn: undefined });

  assert.deepEqual(synced.leftAlone, [], 'nothing is skipped when every dirty repository is in scope');
  const entry = synced.repos.find((candidate) => candidate.repo === other);
  assert.equal(entry?.committed, true, 'the sweep commits it, which the session scope deliberately does not do');
  assert.equal(git(other, ['status', '--porcelain']), '');
});

test('the settled sync tells the model about work it left alone', async (t) => {
  const c = makeCase('report-settled-notice');
  const config = { ...c.config, turnPush: false };
  const other = otherRepo(c);
  const host = fakeHost(c, { config });
  t.after(async () => {
    await host.dispose();
    c.cleanup();
  });

  host.toolCall();
  assert.equal(await until(() => host.injected.length > 0), true, 'the settled sync reported something');
  assert.equal(host.injected.length, 1, 'one notice, not one per repository');
  assert.match(host.injected[0].content[0].text, /left 1 dirty repository uncommitted/u);
  assert.match(host.injected[0].content[0].text, /other/u);
  assert.equal(git(other, ['status', '--porcelain']), '?? theirs.txt', 'and the work is still uncommitted: it was named, not committed');
});

/**
 * A task worktree with work to commit, and a remote that is not there.
 *
 * The worktree is on a `dsh/` branch, so the automatic push is allowed and
 * really runs; pointing the remote at a path that does not exist makes it fail
 * the way a real unreachable remote does.
 */
async function pushFailsCase(name, slug) {
  const c = makeCase(name);
  const started = await runAction('start', { action: 'start', repo: c.repoDir, slug }, c.context());
  assert.equal(started.ok, true, 'action "start" created the task worktree');
  const worktree = started.worktree;
  const file = join(worktree, 'work.txt');
  writeFileSync(file, 'work to commit and push\n');
  assert.equal(record(c.sessionId, worktree, file, { stateRoot: c.config.stateRoot }), true);
  git(worktree, ['remote', 'set-url', 'origin', join(c.root, 'no-such-origin.git')]);
  return { c, worktree };
}

test('a push failure whose backoff could not be recorded does not promise a scheduled attempt', async (t) => {
  const { c, worktree } = await pushFailsCase('push-unrecorded', 'unrecorded');
  const config = c.config;
  // The state file's directory cannot be written. Reads still work, so the
  // session's worktree stays in scope and the sync really runs and really pushes;
  // what cannot happen is storing the backoff — and because nothing lands on
  // disk, `shouldRetryPush` will answer true and the next sync retries at once.
  const sessions = join(config.stateRoot, 'dsh-git', 'sessions');
  // The write bit comes back before anything tries to remove this case, and this
  // hook is registered before the chmod that takes it away. A case left read-only
  // cannot be removed by a later run — not even by rm -rf — so a failure between
  // the chmod and the hook that used to undo it left a case that poisoned the
  // next run in that root with ENOTEMPTY.
  t.after(() => {
    try {
      chmodSync(sessions, 0o700);
    } catch {
      /* the case is already gone */
    }
  });
  chmodSync(sessions, 0o500);
  const host = fakeHost(c, { config });
  t.after(async () => {
    await host.dispose();
    c.cleanup();
  });

  host.toolCall();
  assert.equal(await until(() => host.injected.length > 0), true, 'the settled sync reported the failed push');
  const notice = host.injected[0].content[0].text;
  assert.match(notice, /push failed: /u, 'the push failure is still named');
  assert.match(notice, /could not be recorded/u, 'and the notice says the backoff was not stored');
  assert.doesNotMatch(notice, /\(attempt \d+\)/u, 'it must not promise an attempt that was not scheduled');
  assert.equal(git(worktree, ['log', '-1', '--format=%s']), 'dsh: work.txt', 'the commit still landed');
});

test('a recorded push failure still reads as the scheduled attempt it is', async (t) => {
  const { c, worktree } = await pushFailsCase('push-recorded', 'recorded');
  t.after(() => c.cleanup());

  const synced = await runTurnSync({ config: c.config, cwd: c.root, sessionId: c.sessionId, turn: undefined });
  const entry = synced.repos.find((candidate) => candidate.repo === worktree);
  const note = (entry?.notes ?? []).join('; ');
  assert.match(note, /push failed: /u);
  assert.match(note, /\(attempt 1\)/u, 'the documented message shape is unchanged when the backoff is on disk');
  assert.doesNotMatch(note, /could not be recorded/u);
  assert.match(attentionText(synced), /\(attempt 1\)/u, 'and that is what the model reads');
  assert.equal(state.readSession(c.sessionId, { stateRoot: c.config.stateRoot }).pushFailures[worktree]?.attempts, 1, 'the backoff really is recorded');
  assert.equal(state.shouldRetryPush(c.sessionId, worktree, new Date(), { stateRoot: c.config.stateRoot }), false, 'and it really holds the next attempt back');
});
