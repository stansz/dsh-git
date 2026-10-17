/**
 * Documentation against the code it describes.
 *
 * The rules are mechanical: action names, settings keys and their defaults,
 * parameter names, result fields, identifiers and relative links must all be
 * things that exist. A doc that drifts from the product is worse than no doc,
 * because it is read as fact.
 *
 * The three repositories are checked together when they sit side by side (the
 * authoring layout and the CI checkout both do). A checkout that holds only
 * dsh-git still runs the dsh-git checks; the cross-repository ones skip rather
 * than fail on a missing sibling.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { REPO_ROOT, WORKSPACE } from './support.mjs';

const REPOS = ['dsh-git', 'dsh-git-core', 'dsh-git-worktrees'];

/** Where a repository lives, or undefined when this checkout does not hold it. */
function rootOf(repo) {
  if (repo === 'dsh-git') return REPO_ROOT;
  const path = join(WORKSPACE, repo);
  return existsSync(path) ? path : undefined;
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === '.DS_Store') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Markdown files in one repository. */
function markdown(repo) {
  const root = rootOf(repo);
  if (root === undefined) return [];
  return walk(root).filter((path) => path.endsWith('.md'));
}

/** Source files in one repository. */
function sources(repo) {
  const root = rootOf(repo);
  if (root === undefined) return [];
  return walk(root).filter((path) => /\.(mjs|js)$/u.test(path));
}

function parseArray(text, name) {
  const match = new RegExp('export const ' + name + ' = \\[([^\\]]*)\\]', 's').exec(text);
  return match === null ? [] : [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function parseDefaults(text) {
  const start = text.indexOf('export const DEFAULT_CONFIG = {');
  const end = text.indexOf('};', start);
  const body = text.slice(start, end);
  const out = {};
  for (const match of body.matchAll(/^  (\w+): (.*?),?$/gm)) {
    const raw = match[2].replace(/,$/, '').trim();
    let value = raw;
    if (raw === 'null') value = null;
    else if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (/^-?\d+$/.test(raw)) value = Number(raw);
    else if (/^'([^']*)'$/.test(raw)) value = raw.slice(1, -1);
    else if (raw === '[]') value = [];
    else if (raw === "['bash', 'pwsh']") value = ['bash', 'pwsh'];
    else if (raw === "['main', 'master']") value = ['main', 'master'];
    out[match[1]] = value;
  }
  return out;
}

const gitRoot = REPO_ROOT;
const gitTool = read(join(gitRoot, 'lib/tool.mjs'));
const gitConfig = read(join(gitRoot, 'lib/config.mjs'));
const gitReadme = read(join(gitRoot, 'README.md'));
const gitActions = parseArray(gitTool, 'ACTION_NAMES');
const gitDefaults = parseDefaults(gitConfig);
const gitSettings = Object.keys(gitDefaults);

const worktreesRoot = rootOf('dsh-git-worktrees');
const worktreesTool = worktreesRoot === undefined ? '' : read(join(worktreesRoot, 'lib/tool.mjs'));
const worktreesConfig = worktreesRoot === undefined ? '' : read(join(worktreesRoot, 'lib/config.mjs'));
const worktreesReadme = worktreesRoot === undefined ? '' : read(join(worktreesRoot, 'README.md'));
const worktreesActions = parseArray(worktreesTool, 'ACTION_NAMES');
const worktreesDefaults = parseDefaults(worktreesConfig);
const worktreesSettings = Object.keys(worktreesDefaults);
const worktreesSkip = worktreesRoot === undefined ? 'dsh-git-worktrees is not checked out beside dsh-git' : false;

const docText = REPOS.map(markdown).flat().map(read).join('\n');
const codeText = REPOS.map(sources).flat().map(read).join('\n');

/* ================================================================== */
describe('action names', () => {
  test('the README tool section lists exactly the actions the tool declares', () => {
    const section = gitReadme.slice(gitReadme.indexOf('## The git tool'), gitReadme.indexOf('## The guard'));
    const documented = [...section.matchAll(/- \*\*`([a-z]+)`\*\*/g)].map((match) => match[1]);
    assert.deepEqual(documented, gitActions);
    assert.equal(gitActions.length, 10);
  });

  test('the /git command accepts exactly the tool actions', () => {
    const index = read(join(gitRoot, 'index.js'));
    const match = /COMMAND_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(index);
    const actions = match === null ? [] : [...match[1].matchAll(/'([a-z]+)'/g)].map((entry) => entry[1]);
    assert.deepEqual(actions, gitActions);
  });

  test('every action the guard redirects at is a real action', () => {
    const guardSource = read(join(gitRoot, 'lib/guard.mjs'));
    const match = /TOOL_ACTIONS = readonlySet\('TOOL_ACTIONS', \[([^\]]*)\]\)/.exec(guardSource);
    assert.ok(match !== null);
    const actions = [...match[1].matchAll(/'([a-z]+)'/g)].map((entry) => entry[1]);
    assert.deepEqual(actions, gitActions);
  });

  test('the worktrees README lists exactly its tool actions', { skip: worktreesSkip }, () => {
    const section = worktreesReadme.slice(worktreesReadme.indexOf('## The tool'), worktreesReadme.indexOf('## Settings'));
    const documented = [...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((match) => match[1]);
    assert.deepEqual(documented, worktreesActions);
  });
});

/* ================================================================== */
describe('settings', () => {
  function tableRows(text, heading, endHeading) {
    const start = text.indexOf(heading);
    const end = text.indexOf(endHeading, start);
    const section = text.slice(start, end < 0 ? undefined : end);
    return [...section.matchAll(/^\| `([A-Za-z]+)` \| ([^|]+?) \|/gm)].map((match) => ({ key: match[1], def: match[2].trim() }));
  }

  test('the README settings table covers every setting and nothing else', () => {
    const rows = tableRows(gitReadme, '## Settings', '### Changing a setting');
    assert.deepEqual(rows.map((row) => row.key).sort(), gitSettings.slice().sort());
  });

  test('every documented default is the code default', () => {
    const show = (value) => (value === null ? 'null' : Array.isArray(value) ? '[' + value.join(',') + ']' : String(value));
    for (const row of tableRows(gitReadme, '## Settings', '### Changing a setting')) {
      const expected = gitDefaults[row.key];
      const doc = row.def.replace(/`/g, '');
      if (row.key === 'stateRoot') {
        assert.ok(doc.includes('$DSH_HOME/state') && doc.includes('~/.dsh/state'), 'stateRoot: ' + doc);
      } else if (row.key === 'turnCommitMessage' || row.key === 'baseBranch') {
        assert.ok(doc.includes('empty'), row.key + ': ' + doc);
      } else {
        const wanted = show(expected);
        const ok = doc === wanted || (Array.isArray(expected) && doc.replace(/\s/g, '') === wanted.replace(/\s/g, ''));
        assert.ok(ok, row.key + ': code=' + wanted + ' doc=' + doc);
      }
    }
  });

  test('every setting is described in its schema field', () => {
    const listed = new Set([...gitConfig.matchAll(/^  ([A-Za-z]+): \(z\) =>/gm)].map((match) => match[1]));
    assert.deepEqual([...listed].sort(), gitSettings.slice().sort());
  });

  test('the worktrees README settings table matches its config', { skip: worktreesSkip }, () => {
    const rows = tableRows(worktreesReadme, '## Settings', '## The edit guard');
    assert.deepEqual(rows.map((row) => row.key).sort(), worktreesSettings.slice().sort());
  });
});

/* ================================================================== */
describe('tool parameters', () => {
  function parameterKeys(text) {
    const start = text.indexOf('const PARAMETERS = {');
    const body = text.slice(start, text.indexOf('required:', start));
    return [...body.matchAll(/^    (\w+): \{/gm)].map((match) => match[1]);
  }

  test('the eleven documented parameters exist and the description names them', () => {
    const keys = parameterKeys(gitTool);
    assert.equal(keys.length, 22);
    const documented = ['repo', 'url', 'path', 'branch', 'base', 'remote', 'rebase', 'merge', 'paths', 'message', 'allowProtected', 'forceWithLease', 'sweep', 'pull', 'title', 'body', 'draft', 'pr', 'number', 'apply', 'branches'];
    assert.deepEqual(documented.filter((key) => !keys.includes(key)), []);
  });

  test('the worktrees parameter list matches its tool', { skip: worktreesSkip }, () => {
    const keys = parameterKeys(worktreesTool);
    assert.deepEqual(keys, ['action', 'repo', 'base', 'slug', 'task', 'apply', 'force']);
  });
});

/* ================================================================== */
describe('result fields and identifiers', () => {
  test('every result field named in a doc exists in the product code', () => {
    const fields = ['baseFetched', 'mergedBranches', 'remoteKept', 'remoteAbsent', 'branchKept', 'pullError', 'pushFailure', 'reused', 'recorded', 'dryRun', 'owned'];
    for (const field of fields) {
      if (docText.includes('`' + field + '`')) {
        assert.ok(codeText.includes(field), 'documented result field does not exist in code: ' + field);
      }
    }
    assert.ok(codeText.includes('baseFetched'));
  });

  test('every code identifier named in a doc exists', () => {
    const allowed = new Set([
      'ERR_MODULE_NOT_FOUND', 'HOME', 'PATH', 'HEAD', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_PAGER',
      'PAGER', 'GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_EDITOR', 'LICENSE',
      'plugin_manager', 'install_bundle',
    ]);
    const bad = [];
    for (const repo of REPOS) {
      for (const path of markdown(repo)) {
        for (const match of read(path).matchAll(/`([A-Za-z][A-Za-z0-9_]{1,})`/g)) {
          const token = match[1];
          if (!/[A-Z_]/.test(token.slice(1))) continue;
          if (allowed.has(token)) continue;
          if (!codeText.includes(token)) bad.push(relative(WORKSPACE, path) + ': ' + token);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  test('every relative link and heading anchor resolves', () => {
    const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-');
    const bad = [];
    for (const repo of REPOS) {
      for (const path of markdown(repo)) {
        for (const match of read(path).matchAll(/\]\(([^)]+)\)/g)) {
          const raw = match[1].trim();
          if (/^https?:/u.test(raw) || raw.startsWith('mailto:')) continue;
          const [target, anchor] = raw.split('#');
          const resolved = target === undefined || target === '' ? path : resolve(dirname(path), target);
          if (!existsSync(resolved)) {
            bad.push(relative(WORKSPACE, path) + ' -> ' + raw);
            continue;
          }
          if (anchor !== undefined) {
            const headings = [...read(resolved).matchAll(/^#{1,6} (.+)$/gm)].map((heading) => slug(heading[1]));
            if (!headings.includes(anchor.toLowerCase())) bad.push(relative(WORKSPACE, path) + ' -> ' + raw + ' (missing anchor)');
          }
        }
      }
    }
    assert.deepEqual(bad, []);
  });
});

/* ================================================================== */
describe('the docs match recent behaviour', () => {
  test('guard.md states that plain git prune is refused while a dry run reads', () => {
    const guard = read(join(gitRoot, 'docs/guard.md'));
    assert.match(guard, /git prune/);
    assert.match(guard, /prune -n/);
  });

  test('turn-sync.md documents the clean-but-unpushed report', () => {
    const turn = read(join(gitRoot, 'docs/turn-sync.md'));
    assert.match(turn, /unpushed commit\(s\)/);
    assert.match(turn, /ahead of its upstream/);
  });

  test('the merge fetch and its baseFetched field are documented', () => {
    assert.match(docText, /baseFetched/);
  });

  test('no doc quotes the old prune wording or claims boundary.log', () => {
    assert.doesNotMatch(docText, /orphaned branch\(es\)/);
    assert.doesNotMatch(docText, /boundary\.log/);
  });

  test('no doc claims the project is untested', () => {
    assert.doesNotMatch(docText, /no test suite|there are no tests|not tested/iu);
  });
});

/* ================================================================== */
describe('packaging', () => {
  test('every shipped file list names only files that exist, and ships the patch', () => {
    for (const repo of REPOS) {
      const root = rootOf(repo);
      if (root === undefined) continue;
      const pkg = JSON.parse(read(join(root, 'package.json')));
      assert.ok(Array.isArray(pkg.files), repo + ': package.json has no files list');
      for (const entry of pkg.files) {
        assert.ok(existsSync(join(root, entry)), repo + ': files entry does not exist: ' + entry);
      }
      assert.ok(pkg.files.includes('cordis.patch.yml'), repo + ': the bundle patch is not shipped');
    }
  });

  test('every repository can run its tests with node --test', () => {
    for (const repo of REPOS) {
      const root = rootOf(repo);
      if (root === undefined) continue;
      const pkg = JSON.parse(read(join(root, 'package.json')));
      assert.equal(pkg.scripts?.test, 'node --test', repo + ': package.json scripts.test');
      assert.match(read(join(root, 'README.md')), /node --test/, repo + ': README does not say how to run the tests');
    }
  });
});
