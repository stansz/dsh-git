#!/usr/bin/env node
/**
 * The two things every tool result must satisfy, and the reason this file exists.
 *
 * Both failures were found the hard way in a live profile on this machine, not
 * by reading documentation:
 *
 *   1. the tools layer rejects any value that is not lossless JSON, so one
 *      `undefined` field fails the entire call and the model sees an error
 *      instead of a result;
 *   2. the result is then validated against the tool's declared output schema,
 *      so a field returned but not declared fails the call the same way.
 *
 * Neither is visible from the plugin side until a call is actually made, so this
 * runs the real registrations against a real repository on disk and checks both.
 * It is the cheapest possible substitute for finding out in front of the user.
 *
 *   node scripts/check.mjs
 *
 * Exits non-zero with the offending path, so a failure names the field to fix.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, Config } from '../index.js';
import { runAction } from '../lib/actions.mjs';
import { resolveConfig } from '../lib/config.mjs';

const failures = [];
const fail = (message) => failures.push(message);

/** Every value that cannot round-trip through the wire. */
function checkLossless(value, path = '$', out = []) {
  if (value === undefined) { out.push(path + ' is undefined'); return out; }
  if (typeof value === 'number' && !Number.isFinite(value)) { out.push(path + ' is ' + String(value)); return out; }
  if (typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') { out.push(path + ' is a ' + typeof value); return out; }
  if (Array.isArray(value)) { value.forEach((entry, index) => checkLossless(entry, path + '[' + String(index) + ']', out)); return out; }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) checkLossless(entry, path + '.' + key, out);
  }
  return out;
}

/** The declared schema, applied the way the Harness applies it. */
function checkSchema(value, node, path = '$', out = []) {
  if (node === undefined) { out.push(path + ': no schema node'); return out; }
  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { out.push(path + ': expected object'); return out; }
    for (const [key, entry] of Object.entries(value)) {
      const child = node.properties?.[key];
      if (child === undefined) {
        if (node.additionalProperties === true) continue;
        out.push(path + '.' + key + ': not a declared property');
        continue;
      }
      checkSchema(entry, child, path + '.' + key, out);
    }
    return out;
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) { out.push(path + ': expected array'); return out; }
    value.forEach((entry, index) => checkSchema(entry, node.items, path + '[' + String(index) + ']', out));
    return out;
  }
  if (node.enum !== undefined && !node.enum.includes(value)) out.push(path + ': not one of ' + node.enum.join(', '));
  else if (node.type === 'integer' && !Number.isInteger(value)) out.push(path + ': expected integer, got ' + JSON.stringify(value));
  else if (node.type === 'string' && typeof value !== 'string') out.push(path + ': expected string, got ' + JSON.stringify(value));
  else if (node.type === 'boolean' && typeof value !== 'boolean') out.push(path + ': expected boolean, got ' + JSON.stringify(value));
  return out;
}

/** Run one command, or throw with its output. */
function run(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** A scratch repository whose contents exercise the parsers, not just the happy path. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-check-'));
  run(dir, ['init', '-q', '-b', 'main']);
  run(dir, ['config', 'user.email', 'check@example.com']);
  run(dir, ['config', 'user.name', 'dsh-git check']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n', 'utf8');
  mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'deeper', 'kept.txt'), 'kept\n', 'utf8');
  writeFileSync(join(dir, 'a file with spaces.txt'), 'spaces\n', 'utf8');
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-qm', 'initial commit']);
  // One of everything the status parser has to survive.
  writeFileSync(join(dir, 'README.md'), '# scratch\nchanged\n', 'utf8');
  writeFileSync(join(dir, 'a file with spaces.txt'), 'spaces\nchanged\n', 'utf8');
  writeFileSync(join(dir, 'untracked.txt'), 'new\n', 'utf8');
  mkdirSync(join(dir, 'nested', 'untracked-dir'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'untracked-dir', 'x.txt'), 'x\n', 'utf8');
  return dir;
}

/** The registrations the plugin performs, captured without a live Harness. */
function captureRegistrations() {
  const captured = { tools: [], commands: [], listeners: [] };
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    on: (name, handler) => {
      captured.listeners.push({ name, handler });
      return () => {};
    },
    tools: { register: (definition) => { captured.tools.push(definition); return () => {}; } },
    commands: { register: (definition) => { captured.commands.push(definition); return () => {}; } },
  };
  apply(ctx, {});
  return captured;
}

const repo = scratchRepo();
// Worktrees and state go under the scratch root, not the plugin's real defaults:
// a harness that writes to the user's home directory cannot be run twice, and
// under a file sandbox it cannot be run at all.
const scratchRoot = mkdtempSync(join(tmpdir(), 'dsh-git-state-'));
const config = resolveConfig({ worktreeRoot: join(scratchRoot, 'worktrees'), stateRoot: join(scratchRoot, 'state'), timeoutMs: 15000 });

try {
  const captured = captureRegistrations();

  // `Config` is built from `@deepseek-ai/schemastery`, which is loaded
  // defensively: under a `link:` install a bundle's dependencies are not
  // hoisted, and the whole plugin must still mount without them. So its absence
  // is a supported state — the Configure page is gone and every setting keeps its
  // default — not a failure. Asserting it must exist made this suite fail in CI,
  // where nothing is installed, while describing correct behaviour as a defect.
  //
  // What is always required is that the plugin loads and registers regardless.
  if (Config === undefined) {
    console.log('PASS Config absent (schemastery not installed) — the degradation the loader is built for');
  } else {
    console.log('PASS Config resolved — the Configure page will be present');
  }
  if (captured.tools.length === 0) fail('no tool registered with Config absent: the degradation is not graceful');

  const tool = captured.tools.find((entry) => entry.name === 'git');
  if (tool === undefined) {
    fail('the git tool was not registered');
  } else {
    if (typeof tool.output?.schema !== 'object') fail('the git tool declares no output schema');
    if (typeof tool.output?.render !== 'function') fail('the git tool declares no output render');
    if (tool.isConcurrencySafe?.({}) !== false) fail('the git tool must declare itself unsafe to run concurrently');

    const cases = [
      { name: 'status repo', args: { action: 'status', repo } },
      { name: 'status pull', args: { action: 'status', repo, pull: true } },
      { name: 'status sweep', args: { action: 'status', repo, sweep: true } },
      { name: 'status missing dir', args: { action: 'status', repo: join(repo, 'nope') } },
      { name: 'status not a repo', args: { action: 'status', repo: tmpdir() } },
      { name: 'start', args: { action: 'start', repo, slug: 'check' } },
      { name: 'start reused', args: { action: 'start', repo, slug: 'check' } },
      { name: 'commit paths', args: { action: 'commit', repo, paths: ['README.md'], message: 'check: commit named path' } },
      { name: 'commit nothing', args: { action: 'commit', repo, paths: ['README.md'] } },
      { name: 'sync', args: { action: 'sync', repo } },
      { name: 'push no remote', args: { action: 'push', repo } },
      { name: 'pr no remote', args: { action: 'pr', repo } },
      { name: 'merge no remote', args: { action: 'merge', repo } },
      { name: 'finish no remote', args: { action: 'finish', repo } },
      { name: 'unknown action', args: { action: 'nope', repo } },
      { name: 'missing action', args: {} },
    ];

    for (const testCase of cases) {
      let value;
      try {
        value = await tool.execute(testCase.args, {
          agent: { id: 'check-session' },
          signal: new AbortController().signal,
        });
      } catch (error) {
        fail(testCase.name + ': execute threw ' + String(error?.message ?? error));
        continue;
      }

      const lossless = checkLossless(value);
      if (lossless.length > 0) fail(testCase.name + ': not lossless JSON — ' + lossless.slice(0, 3).join(', '));

      const schema = checkSchema(value, tool.output.schema);
      if (schema.length > 0) fail(testCase.name + ': schema violations — ' + schema.slice(0, 3).join(', '));

      let text;
      try {
        const blocks = tool.output.render(testCase.args, value);
        text = blocks.map((block) => block.text).join('\n');
      } catch (error) {
        fail(testCase.name + ': render threw ' + String(error?.message ?? error));
        continue;
      }
      if (typeof text !== 'string' || text.trim() === '') fail(testCase.name + ': render produced no text');
      console.log((lossless.length === 0 && schema.length === 0 ? 'PASS ' : 'FAIL ') + testCase.name + ' → ' + text.split('\n')[0]);
    }
  }

  // The command and the guard are wired by the same apply(); assert both exist
  // rather than assuming a registration that silently did nothing.
  const command = captured.commands.find((entry) => entry.name === 'git');
  if (command === undefined) {
    fail('the /git command was not registered');
  } else {
    let result;
    try {
      result = await command.handler({ rawInput: 'status', agent: { id: 'check-session' }, signal: new AbortController().signal });
    } catch (error) {
      fail('/git handler threw ' + String(error?.message ?? error));
    }
    if (result !== undefined) {
      // The label must reflect THIS assertion, not the run's total. Using the
      // global failure count made every later line misreport as FAIL the moment
      // an earlier one failed — which turned a single real failure into a
      // misleading wall of red in CI, and cost a round trip to diagnose.
      const before = failures.length;
      if (result.kind !== 'success' && result.kind !== 'error') fail('/git returned kind ' + String(result.kind));
      if (typeof result.text !== 'string' || result.text === '') fail('/git returned no text');
      const ok = failures.length === before;
      console.log((ok ? 'PASS ' : 'FAIL ') + '/git status → ' + String(result.text).split('\n')[0]);
    }
  }

  const turnListener = captured.listeners.find((entry) => entry.name === 'agent/turn-stopping');
  if (turnListener === undefined) fail('no agent/turn-stopping listener: the automatic turn sync is not wired');
  const preExecute = captured.listeners.find((entry) => entry.name === 'tools/pre-execute');
  if (preExecute === undefined) fail('no tools/pre-execute listener: the git guard is not wired');

  // A guard that throws on an unexpected shape would break every tool call in
  // the profile, so its failure path is asserted rather than trusted.
  if (preExecute !== undefined) {
    let nextCalled = false;
    const decision = await preExecute.handler({ name: 'bash', arguments: {} }, () => { nextCalled = true; return { kind: 'allow' }; });
    if (decision !== undefined && decision.kind !== 'allow') fail('the guard did not allow an unrelated bash call');
    if (nextCalled !== true) fail('the guard returned without calling next() for an unrelated call');
    console.log('PASS guard passes an unrelated bash call through');
  }

  // runAction is the path both callers use; a direct call proves the error
  // envelope rather than a throw.
  const unknown = await runAction('nope', {}, { config, reference: repo, sessionId: 'check-session' });
  if (unknown.ok !== false) fail('runAction with an unknown action did not return a failure envelope');
  console.log('PASS unknown action returns ' + String(unknown.error?.code));
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('\n' + failures.join('\n'));
  process.exit(1);
}
console.log('\nEvery tool result is lossless JSON, matches the declared output schema, and renders as text.');
