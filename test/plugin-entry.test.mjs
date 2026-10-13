/**
 * The plugin's entry points, loaded the way the Host loads them.
 *
 * This file exists because of a real outage. A documentation pass reworded one
 * sentence in the git tool's description and put an unescaped apostrophe inside a
 * single-quoted string. `lib/tool.mjs` stopped parsing, `index.js` failed with it,
 * and the plugin did not load at all on the next restart: no git tool, no guard, no
 * automatic commit — while `npm test` reported 65 passing, because nothing in the
 * suite had ever imported either file. Every case drove `lib/actions.mjs`, which was
 * fine, and a module that does not parse is only visible to something that imports
 * it.
 *
 * So this case imports the real entry points and calls the real `apply()` against a
 * Host reduced to the four things it touches. It is the cheapest possible test and
 * it covers the one failure that takes the whole plugin down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';
import { ACTION_NAMES, createGitTool } from '../lib/tool.mjs';

/** A Host reduced to what `apply` registers into. */
function fakeHost() {
  const seen = { tools: [], commands: [], events: [], effects: [] };
  const ctx = {
    tools: { register: (definition) => { seen.tools.push(definition); return () => {}; } },
    commands: { register: (definition) => { seen.commands.push(definition); return () => {}; } },
    on: (name) => { seen.events.push(name); return () => {}; },
    effect: (fn, label) => {
      seen.effects.push(label);
      const disposer = fn();
      return () => { if (typeof disposer === 'function') disposer(); };
    },
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  };
  return { ctx, seen };
}

test('the plugin loads, and registers the tool, the command and every listener', () => {
  const { ctx, seen } = fakeHost();
  apply(ctx, {});

  const tool = seen.tools[0];
  assert.ok(tool !== undefined, 'the git tool is registered');
  assert.equal(tool.name, 'git');
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 200, 'the description is the real one, not a placeholder');
  assert.equal(tool.parameters.type, 'object');
  // Every action the tool advertises is described in the text the model reads.
  for (const action of ACTION_NAMES) {
    assert.ok(tool.description.includes('- ' + action + ':'), 'the description introduces ' + action);
  }

  const command = seen.commands[0];
  assert.ok(command !== undefined, 'the /git command is registered');
  assert.equal(command.name, 'git');
  assert.equal(typeof command.handler, 'function');

  for (const event of ['tools/pre-execute', 'agent/turn-stopping', 'session/event']) {
    assert.ok(seen.events.includes(event), 'something listens for ' + event);
  }
  assert.deepEqual(seen.effects, ['git tool registration', 'git command registration', 'turn sync registration']);
});

test('the tool definition is built without a Host, which is what breaks first', () => {
  const { ctx } = fakeHost();
  const tool = createGitTool(ctx, {});
  assert.equal(tool.name, 'git');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(tool.parameters.properties.action.enum.includes('prune'));
});
