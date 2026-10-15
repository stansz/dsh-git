/**
 * The browser half, checked without a browser.
 *
 * `lib/client.js` is a plain-JS loader bundle: it calls `window.__ModuleLoader__.load`
 * at import time and takes React from the loader's module table. This file supplies
 * both, so the real registration and the real component run under node — the same
 * approach dsh-brave-search's client smoke test takes, and the only way to check a
 * Configure page in CI, where there is no browser and no profile.
 *
 * Four things are asserted that a browser check would not catch until it was too late:
 * the module id and slot key the loader matches on, that the page's field list equals
 * the Host's settings keys, that a change writes the op shape the Host expects, and
 * that both of the states this page cannot fix — no form served, a read-only form —
 * render an explanation instead of throwing. A component that throws blanks its slot
 * entry, which is what the previous attempt at this page did.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SETTINGS_KEYS } from '../lib/config.mjs';

/** Minimal React: createElement plus the two hooks the page uses. */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
};

/** Capture the loader registration instead of running a browser. */
let registered;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      registered = definition;
    },
  },
};

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
await import('data:text/javascript,' + encodeURIComponent(source));

assert.ok(registered, 'the bundle did not call window.__ModuleLoader__.load');
const client = registered.factory((request) => {
  assert.equal(request, 'react', 'unexpected module request: ' + request);
  return React;
});

/** A `form` prop shaped like the one the Plugins page passes. */
function makeForm(values, options = {}) {
  const writes = [];
  return {
    writes,
    form: {
      state: {
        status: 'ready',
        revision: options.revision ?? 7,
        writable: options.writable !== false,
        base: options.base ?? {},
        user: options.user ?? {},
        value: values,
      },
      mutate(ops, expectedRevision) {
        writes.push({ ops, expectedRevision });
        return Promise.resolve(true);
      },
    },
  };
}

/** Every element in a tree, depth first. */
function elements(node, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
    return found;
  }
  found.push(node);
  for (const child of node.children ?? []) elements(child, found);
  return found;
}

test('the bundle registers under the package name, into the row config slot', () => {
  assert.equal(registered.id, 'dsh-git', 'the module id must equal the package name');
  assert.equal(typeof client.apply, 'function', 'no apply export');
  assert.deepEqual(client.inject, ['slots']);

  const mounts = [];
  const ctx = {
    effect(factory) { return factory(); },
    slots: {
      inject(slotName, factory) { mounts.push({ slotName, registration: factory() }); return () => {}; },
      register(options, component) { return { options, component }; },
    },
  };
  client.apply(ctx);
  assert.equal(mounts.length, 1, 'expected exactly one slot injection');
  assert.equal(mounts[0].slotName, 'plugins.row.config');
  assert.equal(mounts[0].registration.options.key, 'dsh-git#dsh-git', 'the key is <package>#<row id>');
  assert.equal(mounts[0].registration.component, client.ConfigPage);
});

test('the page offers a control for every setting the Host declares', () => {
  assert.deepEqual([...client.FIELD_PATHS].sort(), [...SETTINGS_KEYS].sort(),
    'the form and the Config schema have drifted: a setting one side has and the other does not');
});

test('the summary names the two settings that change how the plugin behaves', () => {
  const summary = client.ConfigPage({ view: 'summary', form: makeForm({ autoWorktree: 'off', turnPush: false }).form });
  assert.match(summary.children.join(''), /worktrees: off/u);
  assert.match(summary.children.join(''), /auto-push: off/u);
  const missing = client.ConfigPage({ view: 'summary', form: undefined });
  assert.match(missing.children.join(''), /unavailable/u, 'a summary must not claim a state it cannot read');
});

test('the page renders one control per field, with the served values', () => {
  const page = client.ConfigPage({ view: 'page', form: makeForm({ autoWorktree: 'always', protectedBranches: ['main'], turnCommit: false }).form });
  const fields = elements(page).filter((node) => node.type === client.Field);
  assert.equal(fields.length, client.FIELD_PATHS.length, 'every field is rendered');
  const byPath = new Map(fields.map((node) => [node.props.field.path, node.props]));
  assert.equal(byPath.get('autoWorktree').value, 'always', 'the served value reaches the control');
  assert.deepEqual(byPath.get('protectedBranches').value, ['main']);
  assert.equal(byPath.get('turnCommit').value, false);
  assert.equal(byPath.get('worktreeRoot').value, '', 'a field with no value falls back to its default');
});

test('a change writes the op shape the Host expects, with the current revision', async () => {
  const target = makeForm({}, { revision: 11 });
  client.Field({ field: { path: 'autoWorktree', kind: 'select', options: [{ value: 'off', label: 'off' }] }, value: 'protected', disabled: false, onWrite: (value) => target.form.mutate([{ op: 'set', path: ['autoWorktree'], value }], target.form.state.revision) });
  const rendered = client.Field({ field: { path: 'autoWorktree', kind: 'select', options: [{ value: 'off', label: 'off' }] }, value: 'protected', disabled: false, onWrite: (value) => target.form.mutate([{ op: 'set', path: ['autoWorktree'], value }], target.form.state.revision) });
  const select = elements(rendered).find((node) => node.type === 'select');
  assert.ok(select, 'the select rendered');
  select.props.onChange({ target: { value: 'off' } });
  await Promise.resolve();
  assert.deepEqual(target.writes, [{ ops: [{ op: 'set', path: ['autoWorktree'], value: 'off' }], expectedRevision: 11 }]);

  // The page itself routes the same way, so the wiring is not only in this test.
  const pageTarget = makeForm({});
  const page = client.ConfigPage({ view: 'page', form: pageTarget.form });
  const pageField = elements(page).find((node) => node.type === client.Field && node.props.field.path === 'turnPush');
  pageField.props.onWrite(false);
  await Promise.resolve();
  assert.deepEqual(pageTarget.writes[0].ops, [{ op: 'set', path: ['turnPush'], value: false }]);
});

test('a form the Host never served explains itself instead of rendering nothing', () => {
  const page = client.ConfigPage({ view: 'page', form: undefined });
  const alert = elements(page).find((node) => node.props?.role === 'alert');
  assert.ok(alert, 'the page must say what is wrong');
  const text = elements(page).map((node) => (typeof node === 'string' ? node : (node.children ?? []).filter((c) => typeof c === 'string').join(''))).join(' ');
  assert.match(text, /settings namespace/u, 'it names the cause');
  assert.match(text, /cordis\.patch\.yml/u, 'and the way to change the settings meanwhile');
  assert.equal(elements(page).filter((node) => node.type === client.Field).length, 0, 'no controls without a form');
});

test('a read-only form disables every control and says why', () => {
  const page = client.ConfigPage({ view: 'page', form: makeForm({}, { writable: false }).form });
  const fields = elements(page).filter((node) => node.type === client.Field);
  assert.ok(fields.length > 0, 'the fields still render');
  assert.ok(fields.every((node) => node.props.disabled === true), 'every control is disabled');
  const text = elements(page).filter((node) => node.type === 'p').map((node) => node.children.join('')).join(' ');
  assert.match(text, /Read-only here/u);
});
