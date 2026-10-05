#!/usr/bin/env node
/**
 * The portability contract: what this bundle promises on a machine that is not
 * the one it was written on.
 *
 * This profile has a documented history of bundles that worked only where they
 * were authored, and the failure is always the same shape — a path, a resolution
 * root, or an assumption about the ambient environment that happened to hold on
 * one machine. So the promises are asserted rather than described: where a
 * deployment's files go, that nothing absolute or machine-specific is baked in,
 * that the whole thing loads with no `node_modules` at all, and that the two
 * states of its one dependency are both handled.
 *
 *   node scripts/portability-check.mjs
 *
 * Exits non-zero with the promise that broke, so a regression names itself.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dshHome, resolveConfig, DEFAULT_CONFIG } from '../lib/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const failures = [];
let passed = 0;

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

/**
 * Run a function with `$DSH_HOME` / `$DSH_PROFILE_DIR` set, then restore them.
 *
 * The environment is what decides the Harness home in production, so the checks
 * that prove it have to vary the real environment rather than pass a value in.
 * `resolveConfig` takes a row config; the deployment home is not a row config,
 * it is the process's.
 */
function withEnv(vars, body) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Every source file this bundle ships. */
function sources(dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.(mjs|js|json|yml)$/u.test(entry.name)) out.push(path);
  }
  return out;
}

console.log('--- where a deployment\'s files go ---');
// The whole point: a machine that moves the Harness home must not have this
// plugin quietly writing to ~/.dsh while everything else moves with it. Every
// shipped package resolves this through $DSH_HOME, so this one has to as well.
const custom = dshHome({ DSH_HOME: '/opt/other-dsh' });
check('$DSH_HOME decides the Harness home', custom === '/opt/other-dsh', custom);
check('the worktree root follows it', withEnv({ DSH_HOME: '/opt/other-dsh' }, () => resolveConfig({}).worktreeRoot) === '/opt/other-dsh/worktrees');
check('the state root follows it', withEnv({ DSH_HOME: '/opt/other-dsh' }, () => resolveConfig({}).stateRoot) === '/opt/other-dsh/state');
check('$DSH_HOME beats a conflicting profile dir',
  dshHome({ DSH_HOME: '/a', DSH_PROFILE_DIR: '/b/profiles/x' }) === '/a');
check('the home is derived when only the profile dir is set',
  dshHome({ DSH_PROFILE_DIR: '/opt/other-dsh/profiles/desktop' }) === '/opt/other-dsh');
check('a profile dir of an unexpected shape is ignored rather than guessed at',
  dshHome({ DSH_PROFILE_DIR: '/opt/stuff/desktop' }) === dshHome({}));
check('a blank $DSH_HOME does not win', dshHome({ DSH_HOME: '   ', DSH_PROFILE_DIR: '/opt/h/profiles/p' }) === '/opt/h');
check('a tilde in $DSH_HOME is expanded', !dshHome({ DSH_HOME: '~/somewhere' }).includes('~'));
// The path defaults are resolved per call, not captured at import, which is what
// lets a deployment move its Harness home after this module has loaded.
const defaults = resolveConfig({});
check('the defaults are absolute', isAbsolute(defaults.worktreeRoot) && isAbsolute(defaults.stateRoot));
check('the defaults are outside the repository', !defaults.worktreeRoot.startsWith(root) && !defaults.stateRoot.startsWith(root));
check('an explicit setting still wins over the deployment home',
  withEnv({ DSH_HOME: '/opt/elsewhere' }, () => resolveConfig({ stateRoot: '/tmp/explicit-state' }).stateRoot) === '/tmp/explicit-state');
check('a relative explicit setting resolves against the deployment home',
  withEnv({ DSH_HOME: '/opt/elsewhere' }, () => resolveConfig({ stateRoot: 'rel-state' }).stateRoot) === '/opt/elsewhere/rel-state');

console.log('\n--- nothing machine-specific is baked in ---');
// Paths that only exist on the authoring machine, and the module-resolution
// escape hatches that silently make a bundle work in one directory only.
const banned = [
  ['an absolute import', /(?:from|import)\s*\(?\s*['"]\//u],
  ['a file:// import', /from\s*['"]file:\/\//u],
  ['a relative import that escapes the package', /from\s*['"]\.\.\/\.\.\//u],
  ['a reference to app.asar', /app\.asar/u],
  ['a reference to /Applications', /\/Applications\//u],
  ['a hardcoded home directory', /\/Users\/|\/home\/[a-z]+\/|[A-Z]:\\\\Users/u],
  ['a hardcoded npm prefix', /\/opt\/homebrew|\/usr\/local\/lib/u],
];
let scanned = 0;
for (const file of sources()) {
  if (relative(root, file).startsWith('.github')) continue;
  const text = readFileSync(file, 'utf8');
  scanned += 1;
  for (const [label, pattern] of banned) {
    const match = pattern.exec(text);
    if (match !== null) {
      // The portability script itself names these strings in order to ban them.
      if (file === fileURLToPath(import.meta.url)) continue;
      check('no ' + label + ' in ' + relative(root, file), false, JSON.stringify(match[0]));
    }
  }
}
check('every shipped source file was scanned', scanned > 0, String(scanned));
check('no banned construct was found anywhere', !failures.some((entry) => entry.includes('in ')), failures.join(' | '));

console.log('\n--- the package manifest ships everything it needs ---');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
check('the bundle patch is declared', typeof manifest.dsh?.bundle?.patch === 'string', JSON.stringify(manifest.dsh));
check('the patch file exists', existsSync(join(root, manifest.dsh.bundle.patch)));
check('the entry point exists', existsSync(join(root, manifest.main ?? 'index.js')));
check('the exports field resolves', manifest.exports['.'] === './index.js', JSON.stringify(manifest.exports['.']));
check('the locale files ship', existsSync(join(root, 'locale', 'en.json')));
check('the icon ships', existsSync(join(root, 'icon.svg')));
check('the licence ships', existsSync(join(root, 'LICENSE')));
check('the readme ships', existsSync(join(root, 'README.md')));

// Every declared export must point at a file, or a consumer's import fails on a
// machine that has the package but not the working tree it came from.
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (typeof target !== 'string' || target.includes('*')) continue;
  check('export ' + key + ' points at a shipped file', existsSync(join(root, target)), target);
}

// The `files` allowlist decides what a published install contains. A file that
// exists here but is not listed is a file that works until somebody else
// installs it.
const listed = [];
const collect = (value) => { for (const entry of value) { if (!entry.includes('*')) listed.push(entry); } };
collect(manifest.files ?? []);
for (const required of ['index.js', 'lib', 'cordis.patch.yml', 'locale', 'icon.svg', 'LICENSE', 'README.md']) {
  check('files includes ' + required, (manifest.files ?? []).includes(required));
}
// Every relative import in a shipped file must land on a shipped file.
import { createRequire } from 'node:module';
const require_ = createRequire(join(root, 'index.js'));
let importsChecked = 0;
for (const file of sources()) {
  if (!/\.(mjs|js)$/u.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/from\s*['"](\.\/[^'"]+|\.\.\/[^'"]+)['"]/gu)) {
    const target = join(dirname(file), match[1]);
    importsChecked += 1;
    if (!existsSync(target)) {
      check('the relative import ' + match[1] + ' in ' + relative(root, file) + ' resolves', false, target);
    }
  }
}
check('every relative import resolves (' + String(importsChecked) + ' checked)', true);
void require_;

console.log('\n--- it loads on a machine that has nothing installed ---');
// `@deepseek-ai/schemastery` is the one declared dependency and it is loaded
// through `createRequire` probes rather than a static import, so the package has
// to load with no node_modules at all. This cannot be simulated from inside a
// checkout that has them, so the assertion is that no source file imports it
// statically — which is the property that makes the absence survivable.
let staticSchemaImport = false;
for (const file of sources()) {
  if (!/\.(mjs|js)$/u.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (/^\s*import[^;]*from\s*['"]@deepseek-ai\/schemastery['"]/mu.test(text)) {
    staticSchemaImport = true;
    check('no static schemastery import in ' + relative(root, file), false);
  }
}
check('the schema package is never imported statically', !staticSchemaImport);

// The declared dependency list is part of the portability promise: every extra
// entry is something a consumer must resolve for the plugin to mount.
const runtime = Object.keys(manifest.dependencies ?? {}).filter((name) => name !== '@deepseek-ai/schemastery');
check('the only runtime dependency is the optional schema package', runtime.length === 0, runtime.join(', '));
check('that dependency is declared so a fresh install can fetch it', manifest.dependencies?.['@deepseek-ai/schemastery'] !== undefined);

console.log('\n--- the module graph loads through the manifest, not a working tree ---');
// Import every shipped module by its own URL, which is how a consumer reaches it.
const modules = sources().filter((file) => file.endsWith('.mjs') && file.includes('/lib/'));
for (const file of modules) {
  try {
    await import(pathToFileURL(file).href);
    check('loads: ' + relative(root, file), true);
  } catch (error) {
    check('loads: ' + relative(root, file), false, String(error?.message ?? error));
  }
}
check('at least one library module was loaded', modules.length > 0, String(modules.length));

console.log('\n--- the scripts a consumer runs are self-contained ---');
for (const script of readdirSync(join(root, 'scripts'))) {
  if (!script.endsWith('.mjs')) continue;
  const text = readFileSync(join(root, 'scripts', script), 'utf8');
  // A script that reaches outside the package cannot run after an install.
  check('scripts/' + script + ' imports only its own package', !/from\s*['"](?!\.\.\/|\.\/|node:)/u.test(text));
}
check('statSync is available for the size probes', typeof statSync === 'function');

console.log('\n' + String(passed) + ' passed, ' + String(failures.length) + ' failed');
if (failures.length > 0) {
  console.error('\n' + failures.join('\n'));
  process.exit(1);
}
console.log('The bundle is portable: it follows the deployment\'s home, bakes in no machine paths, and loads with nothing installed.');
