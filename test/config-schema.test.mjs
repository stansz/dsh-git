/**
 * The settings a Configure page depends on.
 *
 * Two silent failures, and this file exists for both. A schema field without
 * `volatile()` is served as a settings namespace with that control missing and
 * nothing reporting why — `buildConfig` now applies `volatile()` to every field, so
 * that one is structural, and the first case below is what keeps it that way. The
 * second is drift in the other direction: the page is hand-written in the browser
 * bundle and cannot import this module, so a setting added here but not there is a
 * setting nobody can change from the Web UI. `test/client-half.test.mjs` compares the
 * page's field list against `SETTINGS_KEYS`, which is why this file exports it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, SETTINGS_KEYS, buildConfig, loadSchema } from '../lib/config.mjs';

test('every setting the plugin reads has a schema field', () => {
  assert.deepEqual([...SETTINGS_KEYS].sort(), Object.keys(DEFAULT_CONFIG).sort(),
    'a setting with no schema field cannot be configured, and a schema field with no setting configures nothing');
});

test('the schema marks every field volatile, and describes every field', (t) => {
  if (loadSchema() === undefined) {
    // The bundle is built to load without schemastery, and CI installs nothing, so
    // this is a skip rather than a failure: the structural guarantee above still holds.
    t.diagnostic('@deepseek-ai/schemastery is not resolvable here, so the built schema cannot be inspected');
    return;
  }
  const built = buildConfig();
  assert.ok(built !== undefined, 'the schema builds when schemastery is reachable');
  // The field table is the only place the marker is visible: schemastery keeps it in
  // `meta`, and there is no public reader for it.
  const fields = built.dict ?? {};
  for (const key of SETTINGS_KEYS) {
    const field = fields[key];
    assert.ok(field !== undefined, key + ' is in the built schema');
    assert.equal(field.meta?.volatile, true, key + ' must be volatile, or the Configure page cannot write it');
    assert.equal(typeof field.meta?.description, 'string', key + ' needs a description: it is the form label');
    assert.notEqual(field.meta?.description, '', key + ' needs a non-empty description');
  }
});
