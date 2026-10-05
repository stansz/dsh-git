#!/usr/bin/env node
/**
 * The workflow file, checked by the same suites the workflow runs.
 *
 * YAML is easy to get subtly wrong in ways nothing catches until a push: a
 * mistyped runner label, a step naming a script that does not exist, a `run:`
 * that only fails inside Actions. Every one of those is a red run that costs a
 * round trip, and a red run nobody trusts is worse than no CI at all.
 *
 * There is no YAML parser in this repository or in the profile, and adding a
 * dependency to lint one file would defeat the point of having no dependencies.
 * So this checks the structure that actually breaks GitHub Actions, and it
 * checks the semantics that matter more than syntax: that every script the
 * workflow invokes exists and is executable, and that the claims it makes about
 * the repository are still true.
 *
 *   node scripts/workflow-check.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const workflowPath = join(root, '.github', 'workflows', 'verify.yml');

const failures = [];
let passed = 0;

/** Assert one property, printing the outcome either way. */
function check(description, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log('PASS ' + description);
    return true;
  }
  failures.push(description + (detail !== '' ? ' — ' + detail : ''));
  console.log('FAIL ' + description + (detail !== '' ? ' — ' + detail : ''));
  return false;
}

if (!existsSync(workflowPath)) {
  console.error('no workflow at ' + workflowPath);
  process.exit(1);
}

const text = readFileSync(workflowPath, 'utf8');
const lines = text.split('\n');

/** The indentation of a line, in spaces. */
const indentOf = (line) => line.match(/^ */)[0].length;

// YAML forbids tab indentation outright, and an editor inserting one is the
// classic way a workflow stops parsing with a message that points elsewhere.
check('no tab characters (YAML rejects tab indentation)', !text.includes('\t'));

// Every trigger this repository actually needs.
check('runs on push to main', /^on:/m.test(text) && /branches:\s*\[main\]/u.test(text));
check('runs on pull requests', /pull_request:/u.test(text));
check('can be run by hand', /workflow_dispatch:/u.test(text));

// Least privilege: the workflow reads the repository and needs nothing else.
check('declares read-only permissions', /permissions:/u.test(text) && /contents:\s*read/u.test(text));

// A runner label typo produces "no runner matching labels", which is a slow
// failure. Only labels this project has verified are allowed. The expression is
// captured to end of line because `${{ matrix.os }}` contains spaces — a
// non-greedy word match stops at `${{` and reports a false failure.
const runners = [...text.matchAll(/runs-on:\s*(.+)/gu)].map((match) => match[1].trim());
check('the runner expression is the matrix',
  runners.length === 1 && runners[0].includes('matrix.os'), runners.join(', '));
const osEntries = [...text.matchAll(/^\s*os:\s*\[([^\]]+)\]/gmu)].map((match) => match[1]);
check('the operating systems are real runner labels',
  osEntries.length === 1 && osEntries[0].split(',').every((os) => ['ubuntu-latest', 'macos-latest', 'windows-latest'].includes(os.trim())),
  osEntries.join(' | '));

// A matrix that does not include ubuntu would silently stop testing the
// non-symlinked path case, which is the single most valuable thing CI adds here.
check('ubuntu is in the matrix (the non-/private path case)', osEntries.some((entry) => entry.includes('ubuntu')));
check('macos is in the matrix (the same machine the plugin was built on)', osEntries.some((entry) => entry.includes('macos')));

// Every script the workflow runs must exist, or the step fails on the runner
// instead of here.
const scripts = [...text.matchAll(/node\s+(scripts\/[A-Za-z0-9._-]+\.mjs)/gu)].map((match) => match[1]);
check('the workflow runs at least one script', scripts.length > 0, String(scripts.length));
for (const script of new Set(scripts)) {
  const path = join(root, script);
  check('script exists: ' + script, existsSync(path) && statSync(path).isFile());
}
check('the workflow runs the guard suite', scripts.includes('scripts/guard-test.mjs'));
check('the workflow runs the tool-contract check', scripts.includes('scripts/check.mjs'));
check('the workflow runs the end-to-end suite', scripts.includes('scripts/e2e.mjs'));

// The claims the workflow's own comments make about this repository. If one of
// these stops being true the comment is misleading, and a workflow that lies
// about what it verifies is worse than a short one.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(manifest.dependencies ?? {}).filter((name) => name !== '@deepseek-ai/schemastery');
check('the workflow\'s "no dependencies to install" claim holds', runtimeDeps.length === 0, runtimeDeps.join(', '));
check('there is no build step to run', manifest.scripts === undefined || manifest.scripts.build === undefined);

// The suites must not need the network or a token. `e2e.mjs` clones a local bare
// repository, which is what makes a credential-free CI run possible at all.
const e2e = readFileSync(join(root, 'scripts', 'e2e.mjs'), 'utf8');
check('the end-to-end suite uses a local remote, not github.com', !/https:\/\/github\.com/u.test(e2e));
check('the end-to-end suite reads no token', !/gh auth token|GH_TOKEN|GITHUB_TOKEN/u.test(e2e));

// Both branches of the defensive dependency load need a job. Without the
// install the plugin must still register and run; with it the Config schema must
// resolve. A matrix that only ever tests one of those has a blind spot either way.
check('one job installs the declared dependency (the schema path)',
  /npm install[^\n]*@deepseek-ai\/schemastery/u.test(text));
check('the dependency install is narrowed to a single job',
  /if:\s*matrix\.os == 'ubuntu-latest' && matrix\.node == '22'/u.test(text));

// A `run:` step with no body is *valid* YAML — it becomes a no-op step — so this
// cannot fail the build without crying wolf on a legal file. It is still worth
// naming, because a step that runs nothing while showing a green check is the
// most expensive kind of green: it looks like coverage and is not.
//
// Each `run:` key is followed by the rest of the step, so the body — if any — is
// the next line that is neither blank, nor a comment, nor the next step. A block
// step (`run: |`) puts it on the following line at a deeper indent; an inline
// step (`run: node x.mjs`) has it on the same line as the key.
const runKeys = [];
for (let index = 0; index < lines.length; index += 1) {
  if (/^ *run:[ |]/u.test(lines[index])) runKeys.push(index);
}
let runNumber = 0;
for (const keyLine of runKeys) {
  runNumber += 1;
  const label = 'run step ' + String(runNumber) + ' has a body';
  const inline = /^ *run: *\S/u.test(lines[keyLine]);
  if (inline) {
    check(label, true);
    continue;
  }
  let body = false;
  const keyIndent = indentOf(lines[keyLine]);
  for (let index = keyLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    body = indentOf(line) > keyIndent;
    break;
  }
  check(label, body, 'the step at line ' + String(keyLine + 1) + ' runs nothing, so its green check means nothing');
}
check('the workflow has run steps at all', runNumber > 0, String(runNumber));

console.log('\n' + String(passed) + ' passed, ' + String(failures.length) + ' failed');
if (failures.length > 0) {
  console.error('\n' + failures.join('\n'));
  process.exit(1);
}
console.log('The workflow is structurally valid and every suite it runs exists.');
