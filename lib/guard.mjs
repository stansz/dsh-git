/**
 * dsh-git — the guard that inspects a pending `bash` call before it runs.
 *
 * The trap this exists to catch: a session that needs a git fact reaches for
 * `bash` and types raw git. Nothing then owns the result. The index is staged
 * but not committed, the commit is not pushed, a `reset --hard` discards edits
 * another session still holds in a worktree, and a force push overwrites work
 * someone else based commits on. The `git` tool exists so there is one owner of
 * every one of those operations; this module is the half that notices when the
 * raw command is about to run anyway and says which operation to use instead.
 *
 * Two decisions live here and they are different audiences:
 *
 *   reason        what the MODEL reads. It names the replacement action and
 *                 ends with the single next step, because a model that is only
 *                 told "no" reaches for raw git again.
 *   displayReason one English line for the approval prompt, so the person
 *                 deciding sees what is being replaced without jargon.
 *
 * The action names in those strings mirror `lib/actions.mjs` exactly — status,
 * start, commit, push, sync, pr, merge, finish. A denial that points at an
 * action the tool does not have is worse than no denial, so a drift between
 * those two files is a bug in the guard.
 *
 * Detection is BEST-EFFORT, not a security boundary. The input is a shell
 * command line and this module only reads its tokens; it does not expand
 * variables, evaluate substitutions, follow sourced scripts, or run anything.
 * A command built at runtime (`$CMD push`, `$(cat task.sh)`, `bash deploy.sh`,
 * a git alias, `time git push`) can still reach git unseen. That is the
 * deliberate direction of the error: a false denial stops work that was fine,
 * while a missed catch only leaves the turn-boundary commit and push to do
 * their job. Every skip below is documented with the false positive it exists
 * to prevent, and every wrapper that cannot be read is reported as `unknown`,
 * which asks rather than denies.
 *
 * The module is pure and synchronous on purpose. `evaluate` is called from a
 * `tools/pre-execute` waterfall listener, which must decide on the current
 * tick, and the tests call it directly with a plain object. There is no file
 * I/O, no network, no clock, no module-level mutable state, and no imports at
 * all.
 */

/**
 * The four verdicts a command line can earn.
 *
 * `unknown` is not a failure mode: it means the command mentions git in a form
 * the tables cannot resolve, so a human decides. It never becomes `destructive`
 * by guessing.
 *
 * @type {Readonly<{READ: 'read', MUTATING: 'mutating', DESTRUCTIVE: 'destructive', UNKNOWN: 'unknown'}>}
 */
export const COMMAND_CLASSES = Object.freeze({
  READ: 'read',
  MUTATING: 'mutating',
  DESTRUCTIVE: 'destructive',
  UNKNOWN: 'unknown',
});

/**
 * A Set whose mutating methods refuse, so a published table cannot be edited
 * at runtime by a caller that happens to hold the reference.
 *
 * @param {string} label - name used in the refusal message.
 * @param {string[]} values - the members.
 * @returns {ReadonlySet<string>}
 */
function readonlySet(label, values) {
  const set = new Set(values);
  const refuse = () => {
    throw new TypeError(label + ' is read-only');
  };
  set.add = refuse;
  set.delete = refuse;
  set.clear = refuse;
  return Object.freeze(set);
}

/**
 * Git subcommands that have a read-only form. A member here is not always read
 * (`branch -l` is read, `branch -D` is not): membership means the subcommand
 * can be read, and `classifyGitInvocation` decides the actual form from its
 * arguments.
 *
 * @type {ReadonlySet<string>}
 */
export const READ_SUBCOMMANDS = readonlySet('READ_SUBCOMMANDS', [
  'status', 'diff', 'log', 'show', 'branch', 'tag', 'remote', 'rev-parse',
  'ls-files', 'ls-tree', 'ls-remote', 'worktree', 'config', 'blame', 'shortlog',
  'describe', 'fetch', 'cat-file', 'show-ref', 'for-each-ref', 'name-rev',
  'merge-base', 'count-objects', 'check-ignore', 'check-attr', 'whatchanged',
  'reflog', 'notes', 'stash', 'submodule', 'verify-commit', 'cherry', 'grep',
  'help', 'version', 'lfs', 'replace', 'rerere', 'symbolic-ref',
  // Plumbing readers. Each one walks the object database, the index or the ref
  // store and prints; none of them writes to any of the three, on any flag. They
  // were absent, which cost a prompt for the shape a session reaches for most
  // when it wants to know what a branch contains — `rev-list --count` to see how
  // far ahead it is, `diff-tree` to see what a commit touched. A prompt for a
  // read is a prompt that teaches a session to route around the guard.
  'rev-list', 'diff-tree', 'diff-index', 'diff-files', 'show-branch',
  'patch-id', 'annotate', 'verify-pack', 'verify-tag', 'var', 'request-pull',
  // Readers with exactly one writing form, which classifySubcommand decides:
  // `bundle create`, `hash-object -w`, `fsck --lost-found`, `bisect start`.
  // Membership means the read form is recognised, never that every form reads.
  'check-ref-format', 'archive', 'fsck', 'hash-object', 'bundle', 'bisect',
]);

/**
 * Git subcommands that can change the repository. A mutating invocation is
 * refused and names the `git` tool action that replaces it — or, for the
 * subcommands the tool has no action for at all, says that plainly and names
 * `guardMode` as the one deliberate way through. The destructive forms deny
 * for their own reasons and are checked before this table.
 *
 * This table used to have an exemption list beside it: tag, notes, remote,
 * config, submodule, reflog, format-patch, send-email, gc, maintenance, repack,
 * lfs and sparse-checkout were filtered out of both the mutating and the unknown
 * path, on the argument that a gate whose advice is "the tool cannot do that" is
 * worse than no gate. That was wrong, and it was measurable: it silently allowed
 * `git config --add core.hooksPath <dir>` (the next git command then runs that
 * hook, outside this guard), `git remote set-url`, `git tag v1.0`, `git gc`,
 * `git repack -ad` and eight more. Those subcommands keep every read form they
 * had; their mutating forms are refused like any other mutation.
 *
 * @type {ReadonlySet<string>}
 */
export const MUTATING_SUBCOMMANDS = readonlySet('MUTATING_SUBCOMMANDS', [
  'add', 'clone', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'cherry-pick',
  'revert', 'mv', 'rm', 'checkout', 'switch', 'restore', 'stash', 'branch',
  'worktree', 'am', 'apply', 'prune',
]);

/**
 * Git subcommands that can discard work other sessions may still hold: they
 * deny, and their reasons explain what is lost rather than naming a
 * replacement, because no `git` tool action can undo them.
 *
 * @type {ReadonlySet<string>}
 */
export const DESTRUCTIVE_SUBCOMMANDS = readonlySet('DESTRUCTIVE_SUBCOMMANDS', [
  'reset', 'clean', 'push', 'branch', 'tag', 'worktree', 'update-ref',
  'symbolic-ref', 'filter-branch', 'filter-repo', 'gc', 'reflog', 'stash',
  'replace', 'rerere', 'notes', 'submodule', 'checkout-index', 'reset-index',
]);

/** How many `bash -c "..."` levels are unwrapped before the rest is opaque. */
const MAX_UNWRAP_DEPTH = 2;

/** Commands whose arguments are data. Their text is never a command to run. */
const DATA_CONSUMERS = readonlySet('DATA_CONSUMERS', [
  'echo', 'printf', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'sed',
]);

/** Shells whose `-c` string this module unwraps and trusts. */
const TRUSTED_SHELLS = readonlySet('TRUSTED_SHELLS', ['bash']);

/** Shells whose `-c` string is peeked at, then reported as uninspectable. */
const OPAQUE_SHELLS = readonlySet('OPAQUE_SHELLS', ['sh', 'zsh']);

/**
 * Matches a leading environment assignment: `GIT_DIR=/x`, `FOO=1`, `LANG=C`.
 * Does not match `--flag`, `/usr/bin/git`, or `k=v` anywhere but the front.
 */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Matches the git program by its last path segment: `git`, `/usr/bin/git`, `./git`. */
const GIT_PROGRAM = /(^|[\\/])git$/;

/** Matches the Windows form of the same program: `git.exe`, `C:\bin\git.exe`. */
const GIT_PROGRAM_EXE = /(^|[\\/])git\.exe$/i;

/**
 * Matches a here-document operator with its word: `<<EOF`, `<< EOF`, `<<-'EOF'`.
 * Anchored at the `<<`; the caller has already established it is outside quotes.
 */
const HEREDOC_OPERATOR = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/** Matches `--prune=now` / `--prune=all`, the two gc forms that delete objects. */
const GC_PRUNE_NOW = /^--prune=(now|all)$/;

/* ------------------------------------------------------------------ *
 * Splitting a command line into the pieces that actually run
 * ------------------------------------------------------------------ */

/**
 * The name a token resolves to as a program: its last path segment, without a
 * Windows `.exe`. `'/usr/bin/git'` -> `'git'`, `'C:\\bin\\GIT.EXE'` -> `'git'`.
 *
 * @param {string} token
 * @returns {string}
 */
function commandName(token) {
  const base = String(token).replace(/\\/g, '/').split('/').pop() ?? String(token);
  return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base;
}

/**
 * Split a command line on the shell separators that start a new command.
 *
 * Quotes are honoured, so `bash -c "git push"` stays one piece and
 * `echo "a && b"` stays one piece. A single `&` is a separator too, except in
 * the redirections `>&` and `&>`, where it is not: `git push 2>&1` is one
 * command, not two.
 *
 * @param {string} command
 * @returns {string[]} trimmed, non-empty pieces in source order.
 */
function splitShell(command) {
  const pieces = [];
  let current = '';
  let quote = '';
  const push = () => {
    if (current.trim() !== '') pieces.push(current.trim());
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote !== '') {
      current += char;
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    // A backslash outside quotes escapes the next character: `a\;b` is one word.
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    if (char === '\n' || char === ';') {
      push();
      continue;
    }
    if (char === '&') {
      if (command[index + 1] === '&') {
        push();
        index += 1;
        continue;
      }
      // `>&` and `&>` are redirections, not separators.
      if (command[index + 1] === '>' || current.endsWith('>')) {
        current += char;
        continue;
      }
      push();
      continue;
    }
    if (char === '|') {
      if (command[index + 1] === '|') index += 1;
      push();
      continue;
    }
    current += char;
  }
  push();
  return pieces;
}

/**
 * Split one piece into shell words, removing the quotes around a word.
 *
 * The result is what the tables classify: `bash -c 'git push'` yields the three
 * words `bash`, `-c`, `git push`, so the inner command survives as one token
 * exactly as the shell would hand it to `-c`.
 *
 * @param {string} piece
 * @returns {string[]}
 */
function tokenize(piece) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = '';
  for (let index = 0; index < piece.length; index += 1) {
    const char = piece[index];
    if (quote !== '') {
      if (char === quote) {
        quote = '';
        continue;
      }
      if (char === '\\' && quote === '"' && index + 1 < piece.length) {
        current += piece[index + 1];
        index += 1;
        started = true;
        continue;
      }
      current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\' && index + 1 < piece.length) {
      current += piece[index + 1];
      index += 1;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Sudo options that consume the next token: `sudo -u root git push`. */
const SUDO_VALUE_OPTIONS = readonlySet('SUDO_VALUE_OPTIONS', [
  '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
  '-C', '--close-from', '-r', '--role', '-t', '--type', '-U', '--other-user',
]);

/**
 * Drop a leading `sudo` and its options, so `sudo -u root git push` is the same
 * command as `git push` here.
 *
 * Sudo is not a git fact and not an obfuscation: it is how a command runs, and
 * leaving it in place would hide every git command a session runs with it.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
function stripSudo(tokens) {
  if (tokens.length === 0 || commandName(tokens[0]) !== 'sudo') return tokens;
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    const takesValue = !option.includes('=') && SUDO_VALUE_OPTIONS.has(option);
    index += takesValue ? 2 : 1;
  }
  return tokens.slice(index);
}

/**
 * Every piece of a command line as source text plus tokens, with here-document
 * bodies removed and a leading `sudo` stripped. No unwrapping: the callers
 * decide what to do with `bash -c`.
 *
 * @param {string} command
 * @returns {Array<{raw: string, tokens: string[]}>}
 */
function scanPieces(command) {
  const found = [];
  for (const piece of splitShell(stripHereDocs(command))) {
    const tokens = stripSudo(tokenize(piece));
    if (tokens.length === 0) continue;
    found.push({ raw: piece, tokens });
  }
  return found;
}

/**
 * Remove here-document bodies, keeping the lines that open them.
 *
 * The false positive this prevents: a script or a commit message that quotes
 * git output is data, and
 *
 *     cat > notes.md <<'EOF'
 *     git push --force
 *     EOF
 *
 * must not read as a force push. The opening line stays, because the command
 * that consumes the body (`cat`, `tee`) is a data consumer and is skipped later
 * anyway. Delimiters are only recognised outside quotes and must start with a
 * letter, so `echo "a << b"` and `$(( 1 << 2 ))` do not swallow the lines that
 * follow them.
 *
 * @param {string} command
 * @returns {string}
 */
function stripHereDocs(command) {
  const lines = command.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    kept.push(line);
    const delimiters = hereDocWords(line);
    for (const delimiter of delimiters) {
      index += 1;
      while (index < lines.length) {
        const body = delimiter.stripTabs ? lines[index].replace(/^\t+/, '') : lines[index];
        if (body === delimiter.word) break;
        index += 1;
      }
    }
  }
  return kept.join('\n');
}

/**
 * Here-document words opened on one line, read outside quotes.
 *
 * `<<-EOF` allows leading tabs on the terminator, which `stripTabs` records.
 *
 * @param {string} line
 * @returns {Array<{word: string, stripTabs: boolean}>}
 */
function hereDocWords(line) {
  const found = [];
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== '') {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"') index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '<' && line[index + 1] === '<' && line[index + 2] !== '<') {
      const match = HEREDOC_OPERATOR.exec(line.slice(index));
      if (match !== null) {
        found.push({ word: match[2], stripTabs: match[0].startsWith('<<-') });
        index += match[0].length - 1;
      }
    }
  }
  return found;
}

/**
 * The `-c` string of a shell invocation, or undefined when this is not one.
 *
 * Only a short option cluster counts (`-c`, `-lc`), so `bash --norc` is not
 * mistaken for one just because its spelling contains a `c`.
 *
 * @param {string[]} tokens
 * @returns {{name: string, inner: string}|undefined}
 */
function shellDashC(tokens) {
  if (tokens.length < 3) return undefined;
  const name = commandName(tokens[0]);
  if (!TRUSTED_SHELLS.has(name) && !OPAQUE_SHELLS.has(name)) return undefined;
  for (let index = 1; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (token.startsWith('-') && !token.startsWith('--') && token.includes('c')) {
      return { name, inner: tokens[index + 1] };
    }
    // The first non-option token is the script name; nothing after it is a -c string.
    if (!token.startsWith('-')) return undefined;
  }
  return undefined;
}

/**
 * Everything before the first bare `--`, which ends option parsing.
 *
 * The false positive this prevents: in `git log --oneline -- git` the trailing
 * `git` is a pathspec — a file or directory called `git` — not a second
 * command, and `mycmd -- git push --force` passes the whole tail as data.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
function beforeDoubleDash(tokens) {
  const index = tokens.indexOf('--');
  return index === -1 ? tokens : tokens.slice(0, index);
}

/**
 * Split a command line into the executable pieces the guard reasons about.
 *
 * Splits on `&&`, `||`, `;`, `|`, a lone `&`, and newlines; strips a leading
 * `sudo` (and `sudo -E`, `sudo -u X`); drops here-document bodies; trims
 * whitespace; drops empties. Unwraps `bash -c "<inner>"`, `sh -c` and `zsh -c`
 * recursively up to two levels by re-splitting the inner string, so a command
 * built out of several git calls comes back as several pieces.
 *
 * @param {string} command - the shell command a tool call is about to run.
 * @returns {Array<{raw: string, tokens: string[]}>} pieces in source order.
 */
export function splitCommands(command) {
  if (typeof command !== 'string') return [];
  return unwrapPieces(scanPieces(command), 0);
}

/**
 * Replace each shell `-c` piece with the pieces of its inner string.
 *
 * @param {Array<{raw: string, tokens: string[]}>} pieces
 * @param {number} depth - levels unwrapped so far.
 * @returns {Array<{raw: string, tokens: string[]}>}
 */
function unwrapPieces(pieces, depth) {
  if (depth >= MAX_UNWRAP_DEPTH) return pieces;
  const out = [];
  for (const piece of pieces) {
    const shell = shellDashC(piece.tokens);
    if (shell === undefined) {
      out.push(piece);
      continue;
    }
    out.push(...unwrapPieces(scanPieces(shell.inner), depth + 1));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Is this a git invocation, and which one
 * ------------------------------------------------------------------ */

/**
 * Whether a token list runs git.
 *
 * True when the first token after any leading `VAR=value` assignment is `git`
 * or a path whose last segment is `git` (`/usr/bin/git`, `git.exe`). So
 * `GIT_DIR=/x git status` is an invocation, while `mygit push` and a `git`
 * argument to another command are not.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
export function isGitInvocation(tokens) {
  if (!Array.isArray(tokens)) return false;
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(String(tokens[index]))) index += 1;
  if (index >= tokens.length) return false;
  const token = String(tokens[index]);
  return GIT_PROGRAM.test(token) || GIT_PROGRAM_EXE.test(token);
}

/** Global options that take a following value when written without `=`. */
const GIT_VALUE_OPTIONS = readonlySet('GIT_VALUE_OPTIONS', [
  '-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace',
]);

/** Global options that are self-contained: `--no-pager`, `-p`, `--bare`. */
const GIT_BOOLEAN_OPTIONS = readonlySet('GIT_BOOLEAN_OPTIONS', [
  '--no-pager', '-p', '--paginate', '--bare', '--literal-pathspecs',
  '--no-replace-objects', '-P', '--version', '--help',
]);

/** Global options whose joined form carries a value: `--git-dir=<p>`. */
const GIT_JOINED_OPTIONS = ['--git-dir=', '--work-tree=', '--exec-path=', '--namespace='];

/**
 * Environment assignments in the prefix that name a program git runs.
 *
 * A read command is not inert when one of these is set: `GIT_EXTERNAL_DIFF` is
 * executed by `git diff` (measured), `GIT_PAGER` by any paging command,
 * `GIT_SSH_COMMAND` by a fetch, and the editor variables by anything that opens
 * an editor. The line the guard reads as read-only is then free to run something
 * else, including raw git this guard would refuse.
 *
 * `GIT_SSH` is the older spelling of `GIT_SSH_COMMAND`. `GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_SYSTEM` and the `GIT_CONFIG_KEY_*` family inject config, which is
 * the same door as `-c include.path`.
 *
 * `PAGER` is the last link in git's pager chain — `GIT_PAGER`, then
 * `core.pager`, then `PAGER` — so it is the same door as `GIT_PAGER` under a
 * second name, and it is treated the same way. It was the one override left
 * out, on the argument that `PAGER=cat` is a habit; the habit has a free
 * replacement in `git --no-pager`, which is the same read, so the name does
 * not get an exception the other two links of its own chain do not get.
 *
 * @type {ReadonlySet<string>}
 */
const EXEC_ENV_ASSIGNMENTS = readonlySet('EXEC_ENV_ASSIGNMENTS', [
  'GIT_PAGER', 'PAGER', 'GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
]);

/** Environment assignments that inject one config key: `GIT_CONFIG_KEY_0`. */
const EXEC_ENV_PREFIXES = ['GIT_CONFIG_KEY_'];

/**
 * Config keys whose value is a program git runs.
 *
 * Keyed on the config KEY, never on `-c` itself: `git -c user.name=x log` is a
 * plain read and stays one. `core.hooksPath` is the sharpest of these — the hook
 * it names runs on the next ref update, so a read command can install code that
 * outlives it.
 *
 * @type {ReadonlySet<string>}
 */
const EXEC_CONFIG_KEYS = readonlySet('EXEC_CONFIG_KEYS', [
  'core.pager', 'core.editor', 'core.sshcommand', 'core.hookspath', 'core.fsmonitor',
  'core.askpass', 'core.gitproxy', 'sequence.editor', 'gpg.program',
  'diff.external', 'credential.helper', 'include.path',
]);

/**
 * Config keys of the same class, matched by shape rather than by name. Each one
 * names a program git runs, so a read command can carry it: `pager.log` for
 * one command, a filter driver for checkout or add, a diff driver, a tool
 * command, a credential helper for one URL, or the upload-pack a fetch runs.
 */
const EXEC_CONFIG_PATTERNS = [
  /^alias\./u,
  /^pager\./u,
  /^filter\..*\.(clean|smudge|process)$/u,
  /^diff\..*\.(command|textconv|external)$/u,
  /^tar\..*\.command$/u,
  /^mergetool\..*\.cmd$/u,
  /^difftool\..*\.cmd$/u,
  /^merge\..*\.driver$/u,
  /^credential\..*\.helper$/u,
  /^remote\..*\.(uploadpack|receivepack)$/u,
];

/** The risk flag that carries one code-execution override and its name. */
const EXEC_OVERRIDE_FLAG = 'exec-override:';

/**
 * Whether a config key names something git will execute. Config keys are
 * case-insensitive, so the comparison is too.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isExecConfigKey(key) {
  const lowered = String(key).toLowerCase();
  if (EXEC_CONFIG_KEYS.has(lowered)) return true;
  return EXEC_CONFIG_PATTERNS.some((pattern) => pattern.test(lowered));
}

/**
 * The key of a `key=value` config pair, or undefined when there is no key.
 *
 * @param {string} value
 * @returns {string|undefined}
 */
function configKeyOf(value) {
  const text = String(value);
  const at = text.indexOf('=');
  return at <= 0 ? undefined : text.slice(0, at);
}

/**
 * Every code-execution override in one git invocation: the environment prefix,
 * a global `-c`/`--config-env` whose key names a program, `--exec-path=<dir>`
 * and `--upload-pack`.
 *
 * The false positive this must not create: `git -c user.name=x log` and
 * `GIT_DIR=/x git status` are ordinary reads and stay ordinary reads. Only an
 * assignment that names a program, or a config key whose value is one, counts.
 *
 * @param {string[]} tokens - the full token list.
 * @param {number} start - the index of the `git` token, after any assignments.
 * @returns {string[]} the names of the overrides found, in source order.
 */
function execOverrides(tokens, start) {
  const found = [];
  const add = (name) => {
    if (!found.includes(name)) found.push(name);
  };
  for (let index = 0; index < start; index += 1) {
    const token = String(tokens[index]);
    const name = token.slice(0, token.indexOf('='));
    if (EXEC_ENV_ASSIGNMENTS.has(name) || EXEC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) add(name);
  }
  // The global region, walked the way resolveSubcommand walks it, so an option
  // that takes a value cannot hide the -c behind it.
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    if (token === '-c' || token === '--config-env') {
      const key = configKeyOf(tokens[index + 1]);
      if (key !== undefined && isExecConfigKey(key)) add(key);
      index += 1;
      continue;
    }
    if (token.startsWith('--config-env=')) {
      const key = configKeyOf(token.slice('--config-env='.length));
      if (key !== undefined && isExecConfigKey(key)) add(key);
      continue;
    }
    if (token.length > 2 && token.startsWith('-c') && token[1] === 'c') {
      const key = configKeyOf(token.slice(2));
      if (key !== undefined && isExecConfigKey(key)) add(key);
      continue;
    }
    if (token.startsWith('--exec-path=')) {
      // Measured: the joined form replaces the exec path, while a bare
      // `--exec-path` prints it and runs nothing, so only the joined form is one.
      add('--exec-path');
      continue;
    }
    if (GIT_JOINED_OPTIONS.some((prefix) => token.startsWith(prefix))) continue;
    if (GIT_BOOLEAN_OPTIONS.has(token)) continue;
    if (GIT_VALUE_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    break;
  }
  // `--upload-pack` is a subcommand option on fetch, push and ls-remote, so it is
  // looked for on the whole line; it always names a program git will run.
  for (const token of tokens) {
    const text = String(token);
    if (text === '--upload-pack' || text.startsWith('--upload-pack=')) add('--upload-pack');
  }
  return found;
}

/**
 * Find the subcommand token, skipping the global options that may precede it.
 *
 * The false positive this prevents: `git -C /repo status` and
 * `git -c user.name=x commit` are status and commit; without the skip they look
 * like unknown subcommands named `/repo` and `user.name=x` and get asked about.
 *
 * @param {string[]} tokens
 * @param {number} from - index just after the `git` token.
 * @returns {{subcommand: string, index: number}|undefined}
 */
function resolveSubcommand(tokens, from) {
  let index = from;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return undefined;
    if (GIT_JOINED_OPTIONS.some((prefix) => token.startsWith(prefix))) {
      index += 1;
      continue;
    }
    if (GIT_BOOLEAN_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (GIT_VALUE_OPTIONS.has(token)) {
      // `-c k=v` and `--git-dir <p>` take the next token; a bare `-c` at the end
      // resolves nothing.
      if (index + 1 >= tokens.length) return undefined;
      index += 2;
      continue;
    }
    if (token.startsWith('-')) return undefined;
    return { subcommand: token, index };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Reading a subcommand's arguments: options, their values, and the operands
 * ------------------------------------------------------------------ */

/**
 * The options that consume the token after them, per subcommand.
 *
 * The defect this table exists to fix: every helper below used to match any
 * token of the argument list, so a token that is really an option VALUE read as
 * a flag. `git clean -fenode_modules -d` (a forced clean) was read as
 * `--dry-run` because the attached `-e` value contains an `n`; `git tag -m
 * '--delete' v1` (a tag whose message is "--delete") was denied as a tag
 * deletion; `git submodule deinit --force status` was read as `git submodule
 * status`; and `git stash push -m list` was read as `git stash list`, a save
 * mistaken for a read.
 *
 * Short entries are letters, so a cluster splits: `-fenode_modules` is `-f`
 * plus the value of `-e`, and `-fd` is `-f -d`. Long entries are the option
 * name without its `=value`.
 *
 * An option that is not listed consumes nothing. That is the conservative
 * direction: a missed catch still leaves the turn-boundary commit and push to do
 * their job, while a false denial stops work that was fine. It also means an
 * option the table does not know cannot become a new way to hide the flag after
 * it — it simply is not known to take a value.
 *
 * `optionalLong` names the options git itself treats as having an OPTIONAL value
 * (the list filters on `git branch` and `git tag`). Measured against git 2.54:
 * `git tag --contains HEAD` consumes `HEAD`, while `git tag --merged -d v1`
 * does not consume `-d`, so `-d` is still a delete.
 *
 * `stopAtOperand` is for `git config`, measured to stop option parsing at the
 * first operand: `git config alias.zz --get` really WRITES alias.zz with the
 * literal value "--get" (checked against git 2.54), so a `--get` after a key is
 * a value and never a read verb.
 *
 * Options left out on purpose, and why the conservative default is still safe:
 * `--recurse-submodules` on fetch and push (git takes an optional value only in
 * the `=` form), `--prune` on `git gc` (git 2.54 rejects the space form), the
 * value options of subcommands whose classification reads no argument at all,
 * and every option of the always-mutating subcommands. `-n` on `git tag` is
 * conditional: `git tag -n 5` consumes the 5, while `git tag -n -d v1` does not
 * consume the `-d` (both measured on git 2.54). It is left as a boolean, and the
 * tag list and mutation checks run before the positional one, so every form
 * reaches the same verdict.
 *
 * @type {Readonly<Record<string, {short?: string, long?: string[], optionalLong?: string[], stopAtOperand?: boolean}>>}
 */
const SUBCOMMAND_VALUE_OPTIONS = Object.freeze({
  branch: { short: 'u', long: ['--set-upstream-to', '--format', '--sort'], optionalLong: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'] },
  bisect: { long: ['--term-new', '--term-bad', '--term-old', '--term-good'] },
  checkout: { short: 'bBcCt', long: ['--track', '--conflict'] },
  clean: { short: 'e', long: ['--exclude'] },
  config: { short: 'ft', long: ['--file', '--type', '--default', '--comment'], stopAtOperand: true },
  fetch: { short: 'oj', long: ['--depth', '--shallow-since', '--shallow-exclude', '--deepen', '--refmap', '--upload-pack', '--server-option', '--jobs', '--negotiation-tip', '--filter'] },
  'hash-object': { short: 't', long: ['--type', '--path'] },
  lfs: { long: ['--include', '--exclude', '--object-id'] },
  notes: { short: 'mFcC', long: ['--message', '--file', '--ref'] },
  push: { short: 'o', long: ['--push-option', '--receive-pack', '--exec', '--repo'] },
  reflog: { short: 'n', long: ['--expire', '--expire-unreachable', '--format', '--date', '--max-count'] },
  remote: { short: 'tm', long: ['--track', '--master', '--mirror'] },
  stash: { short: 'm', long: ['--message', '--pathspec-from-file'] },
  submodule: { short: 'b', long: ['--name', '--reference', '--depth', '--jobs'] },
  'symbolic-ref': { short: 'm', long: ['--message'] },
  switch: { short: 'cCt', long: ['--track', '--conflict'] },
  tag: { short: 'mFu', long: ['--message', '--file', '--local-user', '--format', '--sort', '--cleanup'], optionalLong: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'] },
  worktree: { short: 'bB', long: ['--reason', '--expire'] },
});

/**
 * Split the arguments after a subcommand into options and operands.
 *
 * A value option consumes `--opt=value`, `--opt value`, `-o value` and
 * `-ovalue`; a short cluster splits into its letters, and a letter that takes a
 * value takes the rest of the cluster as that value. A bare `--` ends option
 * parsing and everything after it is an operand — which is why `git tag -- v1`
 * is still a tag creation and `git branch -- foo` still creates a branch
 * (both measured against git 2.54).
 *
 * @param {string[]} args - tokens after the subcommand, including any `--` tail.
 * @param {{short?: string, long?: string[], optionalLong?: string[], stopAtOperand?: boolean}} [spec]
 * @returns {{options: Array<{token: string, name: string, value?: string}>, words: string[]}}
 */
function parseGitArgs(args, spec) {
  const short = spec?.short ?? '';
  const long = spec?.long ?? [];
  const optionalLong = spec?.optionalLong ?? [];
  const stopAtOperand = spec?.stopAtOperand === true;
  const options = [];
  const words = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (stopAtOperand && words.length > 0) {
      // git config stops looking for options at the first operand: a later
      // `--get` is the value of the key in front of it, not a read verb.
      words.push(token);
      index += 1;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      words.push(token);
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      let value = eq === -1 ? undefined : token.slice(eq + 1);
      const takesValue = long.includes(name) || optionalLong.includes(name);
      // An optional value is only consumed when it is not another option, which
      // is what git does with `--merged` and `--points-at`.
      if (value === undefined && takesValue && index + 1 < args.length
        && (!optionalLong.includes(name) || !String(args[index + 1]).startsWith('-'))) {
        value = args[index + 1];
        index += 1;
      }
      options.push({ token, name, value });
      index += 1;
      continue;
    }
    // A short cluster: `-fd` is two flags, `-fenode_modules` is `-f` plus the
    // value of `-e`, and a value option at the end of a cluster takes the next
    // token (`-m drop`).
    let rest = token.slice(1);
    let next = index + 1;
    while (rest.length > 0) {
      const letter = rest[0];
      rest = rest.slice(1);
      if (short.includes(letter)) {
        let value;
        if (rest.length > 0) value = rest;
        else if (next < args.length) {
          value = args[next];
          next += 1;
        }
        options.push({ token, name: '-' + letter, value });
        rest = '';
        break;
      }
      options.push({ token, name: '-' + letter, value: undefined });
    }
    index = next;
  }
  return { options, words };
}

/**
 * Whether one of these option names is present. A value is never an option, so a
 * flag spelled inside a message or a pathspec cannot match here.
 *
 * @param {{options: object[]}} parsed
 * @param {string[]} names - long names (`--list`) or single letters (`-v`).
 * @returns {boolean}
 */
function hasOption(parsed, names) {
  return parsed.options.some((option) => names.includes(option.name));
}

/**
 * Whether a long option is present, with or without an attached value:
 * `--prune`, `--prune=now`, `--force-with-lease=origin/main`.
 *
 * @param {{options: object[]}} parsed
 * @param {string} name
 * @returns {boolean}
 */
function hasLongOption(parsed, name) {
  return parsed.options.some((option) => option.name === name);
}

/**
 * Whether a short flag letter is present, alone or clustered: `-f` in `-fd`,
 * `-D` for `-d`, `-n` in `-n5`. `--force` is not a short flag and is never
 * matched here.
 *
 * @param {{options: object[]}} parsed
 * @param {string} letters - one or more flag letters, case-insensitively.
 * @returns {boolean}
 */
function hasShortFlag(parsed, letters) {
  const wanted = letters.toLowerCase();
  return parsed.options.some((option) => option.name.length === 2 && option.name[0] === '-'
    && wanted.includes(option.name[1].toLowerCase()));
}

/**
 * Whether a short flag appears with exactly this case: `-D` is not `-d`, and on
 * `git branch` that difference is a forced delete versus a checked one.
 *
 * @param {{options: object[]}} parsed
 * @param {string} letter
 * @returns {boolean}
 */
function hasShortFlagExact(parsed, letter) {
  return parsed.options.some((option) => option.name === '-' + letter);
}

/** Read-only flag letters on `git branch`: `-l`, `-a`, `-r`, `-v`, `-vv`. */
const BRANCH_READ_FLAGS = 'larv';
/** Mutation flag letters on `git branch`: delete, move, copy, set-upstream. */
const BRANCH_MUTATION_FLAGS = 'dmcu';

/**
 * Classify a piece of a `git branch` invocation.
 *
 * Read forms come first because they are the ones that must stay allowed:
 * `git branch -l`, `git branch --list`, `git branch -v`, `git branch -a`,
 * `git branch --contains HEAD`, and a bare `git branch`. A positional is an
 * operand whether or not a bare `--` came first: `git branch -- foo` creates
 * foo (measured against git 2.54), so it is not a read.
 *
 * `--edit-description` is a mutation: it writes the branch description into the
 * repository config, which no read form does.
 *
 * @param {{options: object[], words: string[]}} parsed
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyBranch(parsed) {
  const flags = [];
  if (hasShortFlag(parsed, 'd') || hasOption(parsed, ['--delete'])) {
    if (hasShortFlagExact(parsed, 'D')) flags.push('force');
    return { class: COMMAND_CLASSES.DESTRUCTIVE, riskFlags: [...flags, 'delete-branch'] };
  }
  if (hasLongOption(parsed, '--move') || hasLongOption(parsed, '--copy') || hasLongOption(parsed, '--set-upstream-to')
    || hasLongOption(parsed, '--unset-upstream') || hasLongOption(parsed, '--force')
    || hasLongOption(parsed, '--edit-description')
    || hasShortFlag(parsed, BRANCH_MUTATION_FLAGS)) {
    if (hasLongOption(parsed, '--set-upstream-to') || hasLongOption(parsed, '--unset-upstream') || hasShortFlag(parsed, 'u')) {
      flags.push('set-upstream');
    }
    return { class: COMMAND_CLASSES.MUTATING, riskFlags: flags };
  }
  if (hasLongOption(parsed, '--list') || hasLongOption(parsed, '--contains') || hasLongOption(parsed, '--merged')
    || hasLongOption(parsed, '--no-merged') || hasLongOption(parsed, '--no-contains')
    || hasOption(parsed, ['--all', '--remotes', '--verbose', '--show-current'])
    || hasLongOption(parsed, '--points-at') || hasLongOption(parsed, '--format')
    || hasShortFlag(parsed, BRANCH_READ_FLAGS)) {
    return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  }
  return parsed.words.length === 0
    ? { class: COMMAND_CLASSES.READ, riskFlags: [] }
    : { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
}

/**
 * Classify a piece of a `git tag` invocation.
 *
 * `git tag` and `git tag -l` list and stay allowed; a positional name creates
 * a tag; `-d`/`--delete` removes one.
 *
 * The list filters and `-v`/`--verify` are checked before the positional,
 * because `git tag -v v1` names a tag in order to verify it rather than create
 * one. And a message is never a flag: `git tag -m '--delete' v1` is a tag
 * creation whose message is "--delete", which is what git 2.54 does with it
 * (measured).
 *
 * @param {{options: object[], words: string[]}} parsed
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyTag(parsed) {
  if (hasShortFlag(parsed, 'd') || hasOption(parsed, ['--delete'])) {
    const force = hasShortFlag(parsed, 'f') || hasLongOption(parsed, '--force');
    return { class: COMMAND_CLASSES.DESTRUCTIVE, riskFlags: [force ? 'force' : 'delete-tag'] };
  }
  if (hasOption(parsed, ['--list']) || hasShortFlag(parsed, 'lnv')
    || hasLongOption(parsed, '--verify') || hasLongOption(parsed, '--contains')
    || hasLongOption(parsed, '--no-contains') || hasLongOption(parsed, '--merged')
    || hasLongOption(parsed, '--no-merged') || hasLongOption(parsed, '--points-at')
    || hasLongOption(parsed, '--format') || hasLongOption(parsed, '--sort')
    || hasLongOption(parsed, '--column') || hasLongOption(parsed, '--omit-empty')) {
    return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  }
  const named = parsed.words.length > 0;
  if (!named && !hasShortFlag(parsed, 'asfm') && !hasOption(parsed, ['--annotate', '--sign', '--message', '--file', '--force'])) {
    return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  }
  return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
}

/**
 * Classify a piece of a `git remote` invocation.
 *
 * `git remote` and `-v` read; `show` and `get-url` read about one remote;
 * add, remove, rename, set-url, set-head, set-branches, prune and update write.
 * The verb is the first operand, not any token: `git remote remove show` is a
 * removal, which the old scan for the word `show` anywhere answered as a read.
 *
 * @param {{options: object[], words: string[]}} parsed
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyRemote(parsed) {
  const verb = parsed.words[0];
  if (verb === undefined) return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  if (verb === 'show' || verb === 'get-url') return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  if (['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'].includes(verb)) {
    return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
  }
  return { class: COMMAND_CLASSES.UNKNOWN, riskFlags: [] };
}

/** The git 2.46 config verbs that read. */
const CONFIG_READ_VERBS = Object.freeze(['get', 'list']);
/** The git 2.46 config verbs that write. */
const CONFIG_WRITE_VERBS = Object.freeze(['set', 'unset', 'edit', 'rename-section', 'remove-section']);

/**
 * Classify a piece of a `git config` invocation.
 *
 * A read verb or flag (`--get`, `--list`, `-l`, `get`, `list`) reads; a write
 * verb or flag (`--add`, `--unset`, `set`, `edit`) writes; a `key value` pair
 * writes; and `git config <key>` alone reads one value, which stays allowed.
 *
 * `git config` stops parsing options at the first operand (measured on git
 * 2.54), so the position of a verb matters and a later token is a value:
 * `git config alias.zz --get` really WRITES alias.zz with the literal value
 * "--get". That is why the parsed operand list decides here, rather than a scan
 * for `--get` anywhere in the line.
 *
 * @param {{options: object[], words: string[]}} parsed
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyConfig(parsed) {
  const verb = parsed.words[0];
  if (CONFIG_WRITE_VERBS.includes(verb)) return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
  if (CONFIG_READ_VERBS.includes(verb)) return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  const writes = hasOption(parsed, ['--add', '--unset', '--unset-all', '--replace-all',
    '--rename-section', '--remove-section', '--edit', '-e']);
  const reads = hasOption(parsed, ['--get', '--get-all', '--get-regexp', '--get-urlmatch',
    '--list', '-l', '--show-origin', '--show-scope', '--name-only']);
  if (writes) return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
  if (reads) return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  if (parsed.words.length >= 2) return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
  if (parsed.words.length === 1) return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  return { class: COMMAND_CLASSES.UNKNOWN, riskFlags: [] };
}

/**
 * Classify a piece of a `git fetch` invocation.
 *
 * A plain fetch, `git fetch origin` and `git fetch --dry-run` read. `--all`,
 * `--prune`, `--tags`, a force flag and a refspec with an explicit destination
 * (`main:main`, `+main`) write refs and ask.
 *
 * @param {string[]} args
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyFetch(parsed) {
  const flags = [];
  // A refspec is an operand. It used to be scanned for anywhere in the argument
  // list, so the value of a value option containing a colon read as a refspec.
  if (parsed.words.some((token) => token.startsWith('+') || token.includes(':'))) flags.push('refspec-write');
  if (hasOption(parsed, ['--all', '--prune', '--tags', '-p', '--mirror', '--set-upstream'])) flags.push('writes-refs');
  if (hasLongOption(parsed, '--force') || hasShortFlag(parsed, 'f')) flags.push('force');
  return {
    class: flags.length > 0 ? COMMAND_CLASSES.MUTATING : COMMAND_CLASSES.READ,
    riskFlags: flags,
  };
}

/**
 * Classify a piece of a `git push` invocation.
 *
 * A dry run sends nothing and updates no ref, so it reads whatever else it
 * names. Measured against git 2.54: in a fixture with an unpushed commit,
 * `git push --dry-run origin main` printed the update it would make and left the
 * remote ref exactly where it was, and `-n` is the same flag. `--no-dry-run` is
 * git's negation and the LAST of the pair wins — `git push --dry-run
 * --no-dry-run origin main` really pushed (measured) — so the two are read in
 * order instead of being tested for presence.
 *
 * Force, delete and mirror forms discard or remove remote work and deny. A plain
 * push asks: it is the operation the `git` tool owns, and the tool's push is the
 * one that refuses a protected branch.
 *
 * @param {string[]} args
 * @param {string[]} protectedBranches
 * @returns {{class: string, riskFlags: string[]}}
 */
/**
 * The risk flag that carries a protected-branch push, and the branch it matched.
 *
 * The name travels with the flag because the refusal has to name the branch the
 * caller actually pushed to. The reason used to read `protectedBranches[0]`, which
 * was right only while a deployment listed one name: with `[main, master, trunk]`,
 * a push to `trunk` was refused as a push to `main`.
 */
const PROTECTED_BRANCH_FLAG = 'protected-branch:';

function classifyPush(parsed, protectedBranches) {
  // The last of --dry-run / -n / --no-dry-run decides. Presence alone is not
  // enough: a negation after a dry run is a real push, and excusing it would be
  // a hole the flag order opens.
  let dryRun = false;
  for (const option of parsed.options) {
    if (option.name === '--dry-run' || option.name === '-n') dryRun = true;
    else if (option.name === '--no-dry-run') dryRun = false;
  }
  if (dryRun) return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  const flags = [];
  // `-o -f` is a push option whose value is "-f", not a force push: git 2.54
  // consumes it as the value (measured on a non-fast-forward branch, which git
  // then refused to update). So the force test reads real options and real
  // `+refspec` operands only, never a value.
  if (hasLongOption(parsed, '--force') || hasLongOption(parsed, '--force-with-lease')
    || hasLongOption(parsed, '--force-if-includes') || hasShortFlag(parsed, 'f')
    || parsed.words.some((token) => token.startsWith('+'))) {
    flags.push('force');
  }
  if (hasOption(parsed, ['-d']) || hasLongOption(parsed, '--delete') || hasLongOption(parsed, '--mirror')
    || parsed.words.some((token) => token.startsWith(':'))) {
    flags.push('delete-branch');
  }
  if (hasLongOption(parsed, '--mirror')) flags.push('mirror');
  const targets = pushTargets(parsed);
  const protectedTarget = protectedBranches.find((branch) => targets.includes(branch));
  if (protectedTarget !== undefined) flags.push(PROTECTED_BRANCH_FLAG + protectedTarget);
  if (flags.includes('force') || flags.includes('delete-branch')) {
    return { class: COMMAND_CLASSES.DESTRUCTIVE, riskFlags: flags };
  }
  return { class: COMMAND_CLASSES.MUTATING, riskFlags: flags };
}

/**
 * The branch names a push would write: the refspec destinations and the branch
 * positional, with the remote name dropped.
 *
 * Used only to put a name from `protectedBranches` into the reason; a push the
 * guard cannot read the target of is still classified from its flags.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function pushTargets(parsed) {
  const named = parsed.words;
  const rest = named.length > 1 ? named.slice(1) : named;
  const targets = [];
  for (const token of rest) {
    const destination = token.includes(':') ? token.slice(token.indexOf(':') + 1) : token;
    if (destination !== '') targets.push(destination.replace(/^\+/, ''));
  }
  return targets;
}

/**
 * Classify one git invocation from its effective subcommand and arguments.
 *
 * The tables are explicit rather than clever: a rule that is not written here
 * falls through to `unknown`, which asks the user instead of denying.
 *
 * @param {string[]} tokens - the full token list, starting at the `git` token.
 * @param {string[]} [protectedBranches] - branches a push must not target.
 * @returns {{class: string, subcommand?: string, riskFlags?: string[]}}
 */
export function classifyGitInvocation(tokens, protectedBranches = []) {
  if (!isGitInvocation(tokens)) return { class: COMMAND_CLASSES.UNKNOWN };
  let start = 0;
  while (start < tokens.length && ENV_ASSIGNMENT.test(String(tokens[start]))) start += 1;
  const overrideFlags = execOverrides(tokens, start).map((name) => EXEC_OVERRIDE_FLAG + name);
  const resolved = resolveSubcommand(tokens, start + 1);
  // `git --version`, `git -C /repo` and `git` alone resolve no subcommand: they
  // are reported as unknown, never as read, because nothing was inspected. An
  // override is still named, because that is what git was told to run.
  if (resolved === undefined) {
    return overrideFlags.length > 0
      ? { class: COMMAND_CLASSES.UNKNOWN, riskFlags: overrideFlags }
      : { class: COMMAND_CLASSES.UNKNOWN };
  }

  const subcommand = resolved.subcommand;
  // The whole tail, a bare `--` included: the parser treats everything after it
  // as an operand, and `git tag -- v1` really does create a tag (measured), so
  // truncating there was a hole of the same family as reading a value as a flag.
  const args = tokens.slice(resolved.index + 1);
  const hadDoubleDash = args.includes('--');
  const branches = Array.isArray(protectedBranches) ? protectedBranches : [];
  const verdict = classifySubcommand(subcommand, args, hadDoubleDash, branches);
  // A read that also tells git to run a program is not a read this guard can
  // stand behind: it becomes unclassifiable, which asks. A mutation or a
  // destructive form keeps its verdict — an override must never downgrade a
  // refusal into a question.
  const downgraded = verdict.class === COMMAND_CLASSES.READ && overrideFlags.length > 0;
  if (verdict.class === COMMAND_CLASSES.UNKNOWN && overrideFlags.length === 0) return { class: COMMAND_CLASSES.UNKNOWN };
  const result = { class: downgraded ? COMMAND_CLASSES.UNKNOWN : verdict.class, subcommand };
  const flags = [...(verdict.riskFlags !== undefined ? verdict.riskFlags : []), ...overrideFlags];
  if (flags.length > 0) result.riskFlags = flags;
  return result;
}

/**
 * The per-subcommand rules, once the effective subcommand is known.
 *
 * @param {string} subcommand
 * @param {string[]} args - tokens after the subcommand, a bare `--` tail included.
 * @param {boolean} hadDoubleDash - whether a bare `--` followed the subcommand.
 * @param {string[]} protectedBranches
 * @returns {{class: string, riskFlags?: string[]}}
 */
function classifySubcommand(subcommand, args, hadDoubleDash, protectedBranches) {
  const read = () => ({ class: COMMAND_CLASSES.READ, riskFlags: [] });
  const ask = (riskFlags = []) => ({ class: COMMAND_CLASSES.MUTATING, riskFlags });
  const deny = (riskFlags = []) => ({ class: COMMAND_CLASSES.DESTRUCTIVE, riskFlags });
  const unknown = () => ({ class: COMMAND_CLASSES.UNKNOWN, riskFlags: [] });
  // One parse per invocation, from the value table for this subcommand. Every
  // rule below reads the parsed options and operands, never the raw token list,
  // so a token that is really an option value can no longer be read as a flag.
  const parsed = parseGitArgs(args, SUBCOMMAND_VALUE_OPTIONS[subcommand]);
  const verb = parsed.words.length > 0 ? parsed.words[0] : undefined;

  switch (subcommand) {
    /* Always read: a report or an object dump, never a write. */
    case 'status':
    case 'diff':
    case 'log':
    case 'show':
    case 'rev-parse':
    case 'ls-files':
    case 'ls-tree':
    case 'ls-remote':
    case 'blame':
    case 'shortlog':
    case 'describe':
    case 'cat-file':
    case 'show-ref':
    case 'for-each-ref':
    case 'name-rev':
    case 'merge-base':
    case 'count-objects':
    case 'check-ignore':
    case 'check-attr':
    case 'whatchanged':
    case 'verify-commit':
    case 'cherry':
    case 'grep':
    case 'help':
    case 'version':
    /* Plumbing readers: the object database, the index and the ref store, with
       no write path on any flag. Their absence cost a prompt for the shape a
       session reaches for most when it wants to know what a branch contains. */
    case 'rev-list':
    case 'diff-tree':
    case 'diff-index':
    case 'diff-files':
    case 'show-branch':
    case 'patch-id':
    case 'annotate':
    case 'verify-pack':
    case 'verify-tag':
    case 'var':
    case 'request-pull':
    case 'check-ref-format':
    case 'archive':
      return read();

    /* Readers that write in exactly one form. */
    case 'fsck':
      // A report either way; --lost-found also drops what it found into
      // .git/lost-found, which is a write.
      return hasLongOption(parsed, '--lost-found') ? ask() : read();
    case 'hash-object':
      // -w stores the object in the database. Without it this only prints the
      // hash of whatever it was handed.
      return hasShortFlag(parsed, 'w') ? ask() : read();
    case 'bundle':
      // The verb is the first operand, not any token: `git bundle create verify
      // --all` writes a bundle FILE called verify, and the old scan for the word
      // anywhere read that file name as the verb `verify` (measured: the file
      // appears, and a read was reported).
      if (verb === 'list-heads' || verb === 'verify') return read();
      if (verb === 'create' || verb === 'unbundle') return ask();
      return unknown();
    case 'bisect':
      if (verb === 'log' || verb === 'view' || verb === 'visualize') return read();
      // start/good/bad/reset write refs/bisect and move HEAD, and the tool has
      // no bisect action, so this is reported rather than pointed at one.
      return ask();

    /* Always mutating. */
    case 'add':
    case 'clone':
    case 'commit':
    case 'pull':
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'mv':
    case 'rm':
    case 'am':
    case 'apply':
    case 'maintenance':
    case 'prune':
    case 'repack':
      return ask();

    case 'format-patch':
      // `--stdout` prints the patches and leaves the worktree clean; without it
      // this writes .patch files into the tree, which is the dirty tree this
      // plugin removes.
      return hasLongOption(parsed, '--stdout') ? read() : ask();
    case 'send-email':
      // `--dump-aliases` prints the alias file and exits without sending mail.
      return hasLongOption(parsed, '--dump-aliases') ? read() : ask();

    case 'push':
      return classifyPush(parsed, protectedBranches);
    case 'fetch':
      return classifyFetch(parsed);
    case 'branch':
      return classifyBranch(parsed);
    case 'tag':
      return classifyTag(parsed);
    case 'remote':
      return classifyRemote(parsed);
    case 'config':
      return classifyConfig(parsed);
    case 'stash':
      // The verb is the first operand. `git stash push -m list` is a SAVE whose
      // message is "list"; reading the value as the verb made it a `stash list`,
      // and `git stash push -m drop` was denied as a drop.
      if (verb === 'drop' || verb === 'clear') return deny();
      if (verb === 'list' || verb === 'show') return read();
      // Bare `git stash` saves a stash, which is a write: only list and show read.
      return ask();
    case 'reflog':
      if (verb === 'expire') return deny();
      if (verb === 'delete') return ask();
      // `exists` is a read (git answers whether a ref has a reflog), and so is
      // an option-first invocation: the verb left out there is `show`, as in
      // `git reflog --format=%gd HEAD`.
      if (verb === undefined || verb === 'show' || verb === 'exists') return read();
      if (String(args[0]).startsWith('-')) return read();
      return unknown();
    case 'notes':
      if (verb === 'prune') return deny();
      // `get-ref` reads the ref the notes live under; it used to be asked about
      // because only list and show were named. `merge` writes notes refs, so it
      // is a mutation rather than an unclassifiable form.
      if (verb === undefined || verb === 'list' || verb === 'show' || verb === 'get-ref') return read();
      if (['add', 'append', 'copy', 'edit', 'remove', 'merge'].includes(verb)) return ask();
      return unknown();
    case 'worktree':
      // Verb first: `git worktree add list ../wt` creates a worktree at ../wt,
      // and the old scan for the word `list` read it as `git worktree list`.
      if (verb === undefined || verb === 'list') return read();
      if (verb === 'remove') {
        return hasLongOption(parsed, '--force') || hasShortFlag(parsed, 'f') ? deny(['force']) : ask();
      }
      if (['add', 'move', 'repair', 'lock', 'unlock', 'prune'].includes(verb)) return ask();
      return unknown();
    case 'submodule':
      // Verb first: `git submodule deinit --force status` deinitialises the
      // submodule at the path `status`, and the old scan for the word `status`
      // read it as a status report.
      if (verb === undefined || verb === 'status' || verb === 'summary') return read();
      if (verb === 'deinit' && (hasLongOption(parsed, '--force') || hasShortFlag(parsed, 'f'))) return deny(['force']);
      if (['add', 'update', 'init', 'deinit', 'sync', 'set-url', 'set-branch', 'absorbgitdirs'].includes(verb)) return ask();
      // `git submodule foreach <cmd>` runs an arbitrary command in every
      // submodule, so it is not resolvable here.
      return unknown();

    case 'reset': {
      const riskFlags = hasLongOption(parsed, '--hard') ? ['hard']
        : hasLongOption(parsed, '--soft') ? ['soft'] : ['mixed'];
      return deny(riskFlags);
    }
    case 'clean':
      // `-n`/`--dry-run` prints what would go and removes nothing.
      // `git clean -fenode_modules -d` is a FORCED clean: git reads that as `-f`
      // plus the value of `-e`, and the value contains an `n`, which is why the
      // old scan called it a dry run and allowed it.
      if (hasLongOption(parsed, '--dry-run') || hasShortFlag(parsed, 'n')) return read();
      return deny(['no-dry-run', ...(hasLongOption(parsed, '--force') || hasShortFlag(parsed, 'f') ? ['force'] : [])]);

    case 'gc':
      // `--dry-run` performs none of the work, so it reads. (git 2.54 rejects
      // the option outright, so nothing can run either way.)
      if (hasLongOption(parsed, '--dry-run')) return read();
      // Only real options count here: `--prune=now` is one, but a token that is
      // the VALUE of another option is not, which is what the parse guarantees.
      if (parsed.options.some((option) => GC_PRUNE_NOW.test(option.token)) || hasLongOption(parsed, '--aggressive')) {
        return deny(parsed.options.some((option) => GC_PRUNE_NOW.test(option.token)) ? ['prune-now'] : ['aggressive']);
      }
      return ask();

    case 'update-ref':
    case 'filter-branch':
    case 'filter-repo':
    case 'checkout-index':
    case 'reset-index':
      return deny();

    case 'symbolic-ref': {
      if (hasOption(parsed, ['-d', '--delete'])) return deny();
      const named = parsed.words;
      if (named.length >= 2) return deny();
      if (named.length === 1) return read();
      return unknown();
    }

    case 'replace':
      return hasOption(parsed, ['-l', '--list']) ? read() : deny();

    case 'rerere':
      if (verb === 'forget') return deny();
      if (verb === 'gc' || verb === 'clear') return ask();
      return read();

    case 'lfs':
      // `version` reads too, and the verb is the first operand.
      return ['ls-files', 'env', 'status', 'version'].includes(verb) ? read() : ask();

    case 'sparse-checkout':
      return verb === 'list' ? read() : ask();

    case 'checkout':
    case 'switch': {
      const riskFlags = [];
      if (hasOption(parsed, ['-b', '-B', '-c', '-C', '--orphan', '--track', '-t', '--create', '--force-create'])) {
        riskFlags.push('create');
      } else if (hadDoubleDash) {
        // `git checkout -- <paths>` overwrites working-tree edits.
        riskFlags.push('discard');
      }
      return ask(riskFlags);
    }
    case 'restore':
      return ask(['discard']);

    default:
      // The exported table is the fallback, so adding a subcommand to
      // READ_SUBCOMMANDS is enough to classify it. Every subcommand with a
      // mutating form has a case above and never reaches this point, which is
      // what makes the fallback safe: it can only ever see the plain readers.
      return READ_SUBCOMMANDS.has(subcommand) ? read() : unknown();
  }
}

/* ------------------------------------------------------------------ *
 * Finding every git invocation in a command line
 * ------------------------------------------------------------------ */

/**
 * Every git invocation in a command line, with the class of each.
 *
 * Non-execution contexts are skipped, because a false denial is worse than a
 * missed catch:
 *
 * - here-document bodies (`<<EOF ... EOF`): a script or message that quotes
 *   `git push --force` is data, not a command.
 * - everything after a bare `--`: `git log -- git` names a pathspec, and
 *   `mycmd -- git push` passes the tail as data.
 * - the arguments of `echo`, `printf`, `cat`, `grep`, `rg`, `head`, `tail`,
 *   `wc` and `sed`: `echo "git push"` prints text and runs nothing.
 *
 * Wrappers that cannot be read are reported as `unknown`, never guessed at:
 * `eval`, `sh -c`, `zsh -c`, `xargs git`, `find -exec git`, `env git`, and a
 * git-adjacent program such as `gitk` or `git-lfs`. Only `bash -c` is unwrapped
 * and trusted, matching `splitCommands`. The wrapper's inner text is still read
 * far enough to keep a read-only command allowed: `sh -c "git status"` runs a
 * status and is not worth an approval prompt.
 *
 * @param {string} command - the shell command a tool call is about to run.
 * @returns {Array<{raw: string, tokens: string[], class: string, subcommand?: string, riskFlags?: string[]}>}
 */
export function findGitInvocations(command) {
  if (typeof command !== 'string' || command.trim() === '') return [];
  const found = [];
  collectInvocations(command, 0, found);
  return found;
}

/**
 * Collect the invocations of every piece, recursing into `bash -c` strings.
 *
 * @param {string} text
 * @param {number} depth - `bash -c` levels unwrapped so far.
 * @param {Array<object>} out
 * @returns {void}
 */
function collectInvocations(text, depth, out) {
  if (depth > MAX_UNWRAP_DEPTH) return;
  for (const piece of scanPieces(text)) collectPiece(piece, depth, out);
}

/**
 * Classify one piece, or report it as uninspectable.
 *
 * @param {{raw: string, tokens: string[]}} piece
 * @param {number} depth
 * @param {Array<object>} out
 * @returns {void}
 */
function collectPiece(piece, depth, out) {
  const tokens = piece.tokens;
  // `echo`, `printf`, `cat`, ... never execute their arguments.
  if (DATA_CONSUMERS.has(commandName(tokens[0]))) return;

  const scan = beforeDoubleDash(tokens);
  if (scan.length === 0) return;

  if (isGitInvocation(scan)) {
    // The full token list goes to the classifier: it does its own `--`
    // truncation, and it needs the tail to see a form such as
    // `git checkout -- <paths>`, which discards edits.
    out.push(entry(piece.raw, tokens, classifyGitInvocation(tokens)));
    return;
  }

  const name = commandName(scan[0]);

  const shell = shellDashC(scan);
  if (shell !== undefined) {
    const inner = shell.inner;
    if (!mentionsGit(inner)) return;
    if (TRUSTED_SHELLS.has(shell.name) && depth + 1 <= MAX_UNWRAP_DEPTH) {
      collectInvocations(inner, depth + 1, out);
      return;
    }
    // `sh -c` and `zsh -c` are read only to decide whether the string is worth
    // asking about; the verdict is `unknown`, so a destructive-looking string is
    // never turned into a denial this module cannot prove. A string that
    // resolves to read-only git (`sh -c "git status"`) is left alone.
    const peeked = peekClass(inner, depth);
    if (peeked === COMMAND_CLASSES.READ) return;
    out.push(uninspectable(piece.raw, scan, shell.name + ' -c', peeked));
    return;
  }

  if (name === 'eval') {
    const inner = scan.slice(1).join(' ');
    if (!mentionsGit(inner)) return;
    const peeked = peekClass(inner, depth);
    if (peeked === COMMAND_CLASSES.READ) return;
    out.push(uninspectable(piece.raw, scan, 'eval', peeked));
    return;
  }

  if (name === 'xargs') {
    const inner = xargsCommand(scan.slice(1));
    if (!mentionsGit(inner)) return;
    const peeked = peekClass(inner, depth);
    if (peeked === COMMAND_CLASSES.READ) return;
    out.push(uninspectable(piece.raw, scan, 'xargs', peeked));
    return;
  }

  if (name === 'find') {
    const inner = execCommand(scan);
    if (inner === undefined || !mentionsGit(inner)) return;
    const peeked = peekClass(inner, depth);
    if (peeked === COMMAND_CLASSES.READ) return;
    out.push(uninspectable(piece.raw, scan, 'find -exec', peeked));
    return;
  }

  if (name === 'env') {
    const inner = envCommand(scan.slice(1));
    if (!mentionsGit(inner)) return;
    const peeked = peekClass(inner, depth);
    if (peeked === COMMAND_CLASSES.READ) return;
    out.push(uninspectable(piece.raw, scan, 'env', peeked));
    return;
  }

  // `gitk`, `git-lfs`, `git-cinnabar`: separate programs whose behaviour is not
  // in the tables, but which a reader would take for plain git.
  if (name.startsWith('git') && name !== 'git' && !name.includes('/')) {
    out.push(uninspectable(piece.raw, scan, name, COMMAND_CLASSES.UNKNOWN));
  }
}

/**
 * Build a `findGitInvocations` entry from a classification.
 *
 * @param {string} raw
 * @param {string[]} tokens
 * @param {{class: string, subcommand?: string, riskFlags?: string[]}} verdict
 * @returns {{raw: string, tokens: string[], class: string, subcommand?: string, riskFlags?: string[]}}
 */
function entry(raw, tokens, verdict) {
  const built = { raw, tokens, class: verdict.class };
  if (verdict.subcommand !== undefined) built.subcommand = verdict.subcommand;
  if (verdict.riskFlags !== undefined && verdict.riskFlags.length > 0) built.riskFlags = verdict.riskFlags;
  return built;
}

/**
 * An invocation that mentions git in a form this module will not classify.
 *
 * @param {string} raw
 * @param {string[]} tokens
 * @param {string} wrapper - what hid the command: `eval`, `sh -c`, `gitk`.
 * @param {string|undefined} peeked - the class the inner text resolved to, if any.
 * @returns {{raw: string, tokens: string[], class: string, riskFlags: string[]}}
 */
function uninspectable(raw, tokens, wrapper, peeked) {
  const riskFlags = ['uninspectable:' + wrapper];
  if (peeked === COMMAND_CLASSES.DESTRUCTIVE) riskFlags.push('destructive-looking');
  if (peeked === undefined) riskFlags.push('unresolved');
  return { raw, tokens, class: COMMAND_CLASSES.UNKNOWN, riskFlags };
}

/**
 * The class of whatever git the given text would run, worst first. Undefined
 * when nothing resolvable is in there.
 *
 * Used only to decide whether a wrapper is worth asking about; it never turns
 * into a denial.
 *
 * @param {string} text
 * @param {number} depth
 * @returns {string|undefined}
 */
function peekClass(text, depth) {
  const found = [];
  collectInvocations(text, depth + 1, found);
  if (found.length === 0) return undefined;
  if (found.some((item) => item.class === COMMAND_CLASSES.DESTRUCTIVE)) return COMMAND_CLASSES.DESTRUCTIVE;
  if (found.some((item) => item.class === COMMAND_CLASSES.MUTATING)) return COMMAND_CLASSES.MUTATING;
  if (found.some((item) => item.class === COMMAND_CLASSES.UNKNOWN)) return COMMAND_CLASSES.UNKNOWN;
  return COMMAND_CLASSES.READ;
}

/**
 * Matches a git program name anywhere in raw text: `git`, `git.exe`,
 * `/usr/bin/git`, `"git`. Not `mygit` and not `gitk`.
 */
const GIT_MENTION = /(^|[^A-Za-z0-9_.-])git(\.exe)?($|[^A-Za-z0-9_-])/i;

/**
 * Whether a piece of text contains a git program at all.
 *
 * The cheap gate before any wrapper is inspected: `sh -c "ls -la"` is not the
 * guard's business and must stay allowed. The test runs on the raw text rather
 * than on tokens, because a nested wrapper keeps its inner command inside one
 * quoted token — `bash -c "bash -c \"git push\""` has no `git` token of its own.
 *
 * @param {string} text
 * @returns {boolean}
 */
function mentionsGit(text) {
  return GIT_MENTION.test(String(text));
}

/** xargs options that consume the next token: `xargs -n 1 git push`. */
const XARGS_VALUE_OPTIONS = readonlySet('XARGS_VALUE_OPTIONS', [
  '-n', '--max-args', '-I', '--replace', '-P', '--max-procs', '-s', '--max-chars',
  '-L', '--max-lines', '-a', '--arg-file', '-E', '--eof', '-d', '--delimiter',
]);

/**
 * The command `xargs` would run, as text.
 *
 * @param {string[]} args - tokens after `xargs`.
 * @returns {string}
 */
function xargsCommand(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const option = args[index];
    index += !option.includes('=') && XARGS_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  return args.slice(index).join(' ');
}

/** env options that consume the next token: `env -u HOME git push`. */
const ENV_VALUE_OPTIONS = readonlySet('ENV_VALUE_OPTIONS', ['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);

/**
 * The command `env` would run, as text, with its own options and assignments
 * removed: `env -i GIT_DIR=/x git push` -> `git push`.
 *
 * @param {string[]} args - tokens after `env`.
 * @returns {string}
 */
function envCommand(args) {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (ENV_ASSIGNMENT.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      index += !token.includes('=') && ENV_VALUE_OPTIONS.has(token) ? 2 : 1;
      continue;
    }
    break;
  }
  return args.slice(index).join(' ');
}

/**
 * The command a `find -exec` branch would run, as text.
 *
 * The false positive this prevents: `find . -name '*.mjs' -exec wc -l {} ;`
 * runs no git at all, and the `{}`/`;` tail is not part of the command.
 *
 * @param {string[]} tokens
 * @returns {string|undefined}
 */
function execCommand(tokens) {
  const at = tokens.findIndex((token) => token === '-exec' || token === '-execdir' || token === '-ok');
  if (at === -1) return undefined;
  const tail = [];
  for (const token of tokens.slice(at + 1)) {
    if (token === ';' || token === '+' || token === '\\;') break;
    tail.push(token);
  }
  return tail.join(' ');
}

/* ------------------------------------------------------------------ *
 * The reasons: what the model reads, and what the user sees
 * ------------------------------------------------------------------ */

/**
 * Every action the `git` tool really has, mirroring `lib/actions.mjs`. The
 * reasons below may only name these, and test/guard-classify.test.mjs asserts it.
 */
const TOOL_ACTIONS = readonlySet('TOOL_ACTIONS', ['status', 'start', 'commit', 'push', 'sync', 'pr', 'merge', 'finish', 'prune']);

/**
 * The honest sentence for a mutating subcommand the `git` tool has no action
 * for. There is no replacement action to name, so the reason says that, and
 * names the one deliberate way through: the `guardMode` setting.
 *
 * @param {string} subcommand
 * @returns {string}
 */
function noToolActionNote(subcommand) {
  return 'The git tool has no `' + subcommand + '` action, so it cannot make this change for you; only the `guardMode` setting ("warn" or "off") allows it, and that is a deliberate deployment decision rather than a per-command approval.';
}

/**
 * Why a mutating command is gated and which action replaces it, per subcommand.
 *
 * Exported for the same reason `MUTATING_SUBCOMMANDS` is: the coverage guard
 * below is only worth having if something asserts it.
 */
export const MUTATING_REASONS = Object.freeze({
  clone: {
    reason: 'Raw `git clone` in bash is gated. Use the git tool instead: action "clone" with `url` (and optionally `path` and `branch`) clones the repository and reports its state in one call. Next: run action "clone" with the URL you meant to clone.',
    displayReason: 'Use the git tool: action "clone" clones a repository and reports its state.',
  },
  add: {
    reason: 'Raw `git add` in bash is gated. Use the git tool instead: action "commit" with `paths: [...]` stages exactly those paths and commits them with a message. Nothing is left staged-but-uncommitted. Next: run action "commit" with the paths you meant to add.',
    displayReason: 'Use the git tool: action "commit" with paths stages them and commits.',
  },
  commit: {
    reason: 'Raw `git commit` in bash is gated. Use the git tool instead: action "commit" with `paths: [...]` stages exactly those paths and commits with a message. That keeps this repo clean and pushed at turn end without sweeping in other sessions\' changes.',
    displayReason: 'Use the git tool: action "commit" stages exactly the paths you name.',
  },
  init: {
    reason: 'Raw `git init` in bash is gated. Use the git tool instead: action "init" creates a new repository at a path and names its initial branch. Next: run action "init".',
    displayReason: 'Use the git tool: action "init" creates a new repository.',
  },
  push: {
    reason: 'Raw `git push` in bash is gated. Use the git tool instead: action "push" pushes this worktree\'s branch, sets its upstream, and refuses a protected branch. That is what makes the commits reachable from the remote instead of leaving this machine the only copy. Next: run action "push".',
    displayReason: 'Use the git tool: action "push" publishes this branch, and refuses protected ones.',
  },
  pull: {
    reason: 'Raw `git pull` in bash is gated. Use the git tool instead: action "sync" fetches origin and fast-forwards this branch, and reports a diverged branch instead of leaving a half-finished merge in the worktree. Next: run action "sync".',
    displayReason: 'Use the git tool: action "sync" fetches and fast-forwards this branch.',
  },
  merge: {
    reason: 'Raw `git merge` in bash is gated. A finished branch lands through the tool: action "push" publishes the branch, action "pr" opens the pull request, and action "merge" lands it. action "sync" only fast-forwards, so it cannot join a diverged branch — do not offer it for this. Next: run action "push", then "pr", then "merge".',
    displayReason: 'Use the git tool: action "push", then "pr", then "merge" lands a finished branch.',
  },
  rebase: {
    reason: 'Raw `git rebase` in bash is gated. Use the git tool instead: action "sync" brings the base into this branch, and reports a diverged branch rather than rewriting commits. A hand-run rebase stops mid-way and leaves the worktree for the next session to untangle. Next: run action "sync".',
    displayReason: 'Use the git tool: action "sync" updates the base without rewriting history.',
  },
  'cherry-pick': {
    reason: 'Raw `git cherry-pick` in bash is gated. Use the git tool instead: action "sync" brings the base branch into this worktree, and a change from elsewhere belongs on its own task branch (action "start") so this history stays linear. Next: run action "sync".',
    displayReason: 'Use the git tool: action "sync" brings the base into this worktree.',
  },
  revert: {
    reason: 'Raw `git revert` in bash is gated. Use the git tool instead: action "commit" records the paths as they should now be, with a message that says what was undone, so the undo is an ordinary commit the tool can push. Next: run action "commit" with those paths.',
    displayReason: 'Use the git tool: action "commit" records the correction as a commit.',
  },
  mv: {
    reason: 'Raw `git mv` in bash is gated. Move the path with the file tools, then use the git tool: action "commit" with `paths: [...]` stages the rename and commits both sides of it. A half-run `git mv` leaves the index disagreeing with the worktree. Next: run action "commit" with both paths.',
    displayReason: 'Use the git tool: action "commit" stages the moved paths and commits.',
  },
  rm: {
    reason: 'Raw `git rm` in bash is gated. Delete the path with the file tools, then use the git tool: action "commit" with `paths: [...]` stages the deletion and commits it, so the removal is in the pushed history instead of only in this index. Next: run action "commit" with that path.',
    displayReason: 'Use the git tool: action "commit" stages the deletion and commits.',
  },
  checkout: {
    reason: 'Raw `git checkout` in bash is gated. Use the git tool instead: action "checkout" switches to a branch, and refuses to switch away from uncommitted work. Use action "start" when you want an isolated task worktree instead of switching this checkout. Next: run action "checkout".',
    displayReason: 'Use the git tool: action "checkout" switches branches safely.',
  },
  switch: {
    reason: 'Raw `git switch` in bash is gated. Use the git tool instead: action "checkout" switches to a branch, and refuses to switch away from uncommitted work. Use action "start" when you want an isolated task worktree instead. Next: run action "checkout".',
    displayReason: 'Use the git tool: action "checkout" switches branches safely.',
  },
  restore: {
    reason: 'Raw `git restore` in bash is gated: it overwrites uncommitted edits, and no git-tool action can recover them. To keep a change, record it with action "commit"; to work on another branch, action "start" leaves this worktree as it is. Next: run action "commit" for the paths worth keeping.',
    displayReason: 'Gated: restore discards uncommitted edits. Keep them with action "commit".',
  },
  stash: {
    reason: 'Raw `git stash` in bash is gated. Use the git tool instead: action "stash" shelves work in progress and clears the working tree; `pop: true` restores it, and `list: true` shows the stack. Next: run action "stash".',
    displayReason: 'Use the git tool: action "stash" shelves and restores work in progress.',
  },
  branch: {
    reason: 'Raw `git branch` in bash is gated when it creates, renames, copies or re-points a branch. Use the git tool instead: action "branch" lists, creates, or deletes branches. Next: run action "branch".',
    displayReason: 'Use the git tool: action "branch" lists, creates, or deletes branches.',
  },
  tag: {
    reason: 'Raw `git tag` creation in bash is gated. ' + noToolActionNote('tag') + ' Tag creation writes a new ref, and nothing the git tool does publishes it: action "push" publishes branch commits, so a release tagged here stays on this machine. Next: run action "status" to see the state the tool sees.',
    displayReason: 'Gated: the git tool cannot create tags. guardMode is the escape hatch.',
  },
  remote: {
    reason: 'Raw `git remote` mutation in bash is gated. ' + noToolActionNote('remote') + ' A hand-edited remote silently changes what action "push" and action "sync" talk to. Next: run action "status" to confirm the remote the tool sees.',
    displayReason: 'Gated: the git tool cannot edit remotes. guardMode is the escape hatch.',
  },
  worktree: {
    reason: 'Raw `git worktree` mutation in bash is gated. Use the git tool instead: action "start" creates the task worktree under the configured root and locks it to this session; action "finish" removes it only after its commits are pushed. A hand-made worktree is one nothing later cleans up. Next: run action "start".',
    displayReason: 'Use the git tool: action "start" creates the worktree, "finish" removes it.',
  },
  submodule: {
    reason: 'Raw `git submodule` mutation in bash is gated. ' + noToolActionNote('submodule') + ' An update rewrites gitlink paths that action "commit" would then stage by accident. Next: run action "status" to see which paths moved.',
    displayReason: 'Gated: no submodule action exists. guardMode is the escape hatch.',
  },
  config: {
    reason: 'Raw `git config` write in bash is gated. ' + noToolActionNote('config') + ' This is the one that matters most: `git config --add core.hooksPath <dir>` installs a hook directory that git executes on its next command, so it bypasses this guard completely. Other writes change the identity action "commit" records or the branch action "push" targets. Next: run action "status" to see the state the tool sees.',
    displayReason: 'Gated: a config write, including a core.hooksPath hook, runs outside the guard.',
  },
  notes: {
    reason: 'Raw `git notes` mutation in bash is gated. ' + noToolActionNote('notes') + ' Notes are not pushed by action "push", so a note written here stays on this disk. Next: run action "status" to see the state the tool sees.',
    displayReason: 'Gated: notes are not pushed by the tool. guardMode is the escape hatch.',
  },
  reflog: {
    reason: 'Raw `git reflog delete` in bash is gated. ' + noToolActionNote('reflog') + ' It removes the record that lets a lost commit be recovered, and no git-tool action restores it. Next: run action "status" to see how far this branch is from its upstream.',
    displayReason: 'Gated: deleting reflog entries removes recovery information.',
  },
  am: {
    reason: 'Raw `git am` in bash is gated. Use the git tool instead: action "commit" records the same change as an ordinary commit it can push. A mailbox applied by hand leaves the branch unpushed, and stops half-applied when a patch fails. Next: run action "commit" with the affected paths.',
    displayReason: 'Use the git tool: action "commit" records the change as a normal commit.',
  },
  apply: {
    reason: 'Raw `git apply` in bash is gated. Use the git tool instead: action "commit" records the change as an ordinary commit it can push, so the work ends in the pushed history instead of only in the working tree. Next: run action "commit" with the affected paths.',
    displayReason: 'Use the git tool: action "commit" records the change as a normal commit.',
  },
  'format-patch': {
    reason: 'Raw `git format-patch` in bash is gated: it writes .patch files into the worktree, which is the dirty tree this plugin removes. ' + noToolActionNote('format-patch') + ' Share the branch instead: action "push" publishes it and action "pr" opens the pull request. Next: run action "push".',
    displayReason: 'Gated: patches as files are not how this tool shares work.',
  },
  'send-email': {
    reason: 'Raw `git send-email` in bash is gated: it mails patches instead of publishing them. ' + noToolActionNote('send-email') + ' Share the branch instead: action "push" publishes it and action "pr" opens the pull request, where review and CI happen. Next: run action "pr".',
    displayReason: 'Gated: patches by mail are not how this tool shares work.',
  },
  gc: {
    reason: 'Raw `git gc` in bash is gated. ' + noToolActionNote('gc') + ' A hand-run gc can race a worktree another session owns, and git collects unreachable objects on its own schedule. Next: run action "finish" to commit and push the work of this turn.',
    displayReason: 'Gated: gc can race other worktrees. guardMode is the escape hatch.',
  },
  maintenance: {
    reason: 'Raw `git maintenance` in bash is gated. ' + noToolActionNote('maintenance') + ' Scheduled maintenance is a repository setting, and action "finish" commits and pushes the work of this turn. Next: run action "finish".',
    displayReason: 'Gated: maintenance is scheduled work. guardMode is the escape hatch.',
  },
  prune: {
    reason: 'Raw `git prune` in bash is gated: unreachable objects may be the only copy of work another session still holds in a worktree. The git tool keeps the repository healthy through action "sync" and action "finish". Next: run action "finish" when this turn\'s work is done.',
    displayReason: 'Gated: pruning can delete objects another worktree still needs.',
  },
  repack: {
    reason: 'Raw `git repack` in bash is gated. ' + noToolActionNote('repack') + ' Repacking rewrites the object store while other worktrees and sessions may be reading it. Next: run action "finish" when the work of this turn is done.',
    displayReason: 'Gated: repacking races other worktrees. guardMode is the escape hatch.',
  },
  fetch: {
    reason: 'Raw `git fetch` in bash is gated. Use the git tool instead: action "fetch" pulls the remote\'s state without merging; action "sync" does that and fast-forwards. Next: run action "fetch".',
    displayReason: 'Use the git tool: action "fetch" updates from the remote without merging.',
  },
  lfs: {
    reason: 'Raw `git lfs` in bash is gated. ' + noToolActionNote('lfs') + ' It rewrites .gitattributes and the smudge filters that action "commit" and action "push" then work through. Next: run action "status" to confirm what changed.',
    displayReason: 'Gated: LFS setup changes what commit and push read. guardMode is the escape hatch.',
  },
  'sparse-checkout': {
    reason: 'Raw `git sparse-checkout` in bash is gated. ' + noToolActionNote('sparse-checkout') + ' Narrowing the sparse set removes working-tree files that action "commit" would then stage as deletions. Next: run action "status" to confirm the tree is what the tool sees.',
    displayReason: 'Gated: a sparse set changes what commit stages. guardMode is the escape hatch.',
  },
});

/** Why a destructive command is denied. These name what is lost, not a replacement. */
const DESTRUCTIVE_REASONS = Object.freeze({
  reset: {
    reason: 'Raw `git reset` in bash is denied: it moves the branch, and `--hard` discards working-tree edits that other sessions and worktrees may still be holding, with no git-tool action to bring them back. Land the correction as a new commit instead. Next: run action "status" to see what would be lost.',
    displayReason: 'Denied: reset discards work other worktrees may hold. Run action "status".',
  },
  clean: {
    reason: 'Raw `git clean` in bash is denied: it deletes untracked files, including files another session or worktree created and has not committed yet, and nothing in git brings them back. Next: run action "status" to see what is untracked, then keep the work with action "commit".',
    displayReason: 'Denied: clean deletes untracked files other sessions may need.',
  },
  push: {
    reason: 'Raw `git push --force` in bash is denied: it overwrites remote history that other sessions and worktrees may have built on, and their commits become unreachable. There is no git-tool action that force-pushes. If the branch truly must be replaced, use the GitHub UI, where the old value stays recoverable; otherwise run action "push" with the new commits on top.',
    displayReason: 'Denied: force push overwrites others\' history. Use action "push" on top.',
  },
  'push-delete': {
    reason: 'Raw `git push --delete`/`--mirror` in bash is denied: it removes remote refs that other sessions and worktrees may still be based on, and the commits behind them become unreachable. No git-tool action deletes a remote branch. Delete it in the GitHub UI, where protection rules and the reflog still apply. Next: run action "sync" to line the local branch up.',
    displayReason: 'Denied: deleting remote refs breaks other worktrees. Use the GitHub UI.',
  },
  branch: {
    reason: 'Raw `git branch -d/-D` in bash is denied: it deletes a branch other sessions and worktrees may be checked out or basing work on, and unmerged commits on it are lost. Action "finish" closes a worktree but never removes its branch, so it is not the replacement this denial used to name. Action "prune" is the one door that removes a branch: it refuses any branch a worktree has checked out. Next: run action "prune" to see which branches it can prove disposable, and pass `branches: [...]` for one it cannot prove because the repository has no remote or the branch was squash-merged.',
    displayReason: 'Denied: branch deletion can drop work. Use action "prune".',
  },
  tag: {
    reason: 'Raw `git tag -d` in bash is denied: deleting a tag removes the only name for that release, and other clones and worktrees keep pointing at it. Tags are not what action "push" manages. Delete the release in the GitHub UI, where the deletion is recorded. Next: run action "status".',
    displayReason: 'Denied: tag deletion is not recoverable here. Do it in the GitHub UI.',
  },
  worktree: {
    reason: 'Raw `git worktree remove --force` in bash is denied: it deletes a worktree that may still hold uncommitted or unpushed work, and --force is exactly what a session reaches for when it has stopped checking. The git tool removes a worktree through action "finish", and only after its commits are pushed. Next: run action "status" to see what it still holds.',
    displayReason: 'Denied: forced worktree removal can drop unpushed work. Use action "finish".',
  },
  'update-ref': {
    reason: 'Raw `git update-ref` in bash is denied: it moves a ref directly, bypassing the checks action "commit" and action "push" apply, and any worktree another session owns keeps its stale HEAD. Next: make the change as a commit with action "commit", and let action "push" move the remote ref.',
    displayReason: 'Denied: update-ref moves refs behind the tool. Use action "commit".',
  },
  'symbolic-ref': {
    reason: 'Raw `git symbolic-ref` write in bash is denied: it re-points HEAD, which changes what action "status", action "commit" and action "push" consider the current branch, while another worktree may be reading it. Next: use action "start" to put the work on its own branch instead.',
    displayReason: 'Denied: re-pointing HEAD breaks other sessions. Use action "start".',
  },
  'filter-branch': {
    reason: 'Raw history rewriting in bash is denied: it replaces every commit id, breaks the branches other sessions and worktrees hold, and needs a force push to publish. There is no git-tool action that rewrites history. Next: run action "status" to see what is unpushed, then land the correction as a normal commit with action "commit".',
    displayReason: 'Denied: rewriting history breaks every other clone. Use action "commit".',
  },
  'filter-repo': {
    reason: 'Raw history rewriting in bash is denied: it replaces every commit id, breaks the branches other sessions and worktrees hold, and needs a force push to publish. There is no git-tool action that rewrites history. Next: run action "status" to see what is unpushed, then land the correction as a normal commit with action "commit".',
    displayReason: 'Denied: rewriting history breaks every other clone. Use action "commit".',
  },
  gc: {
    reason: 'Raw `git gc --prune=now/--aggressive` in bash is denied: it deletes unreachable objects immediately, including objects a worktree another session owns is still building on, instead of leaving them for git\'s own schedule. Next: run action "finish" to commit and push this turn\'s work; git collects objects on its own.',
    displayReason: 'Denied: pruning now can delete objects another worktree needs.',
  },
  reflog: {
    reason: 'Raw `git reflog expire` in bash is denied: the reflog is what lets a lost commit or a rewritten branch be recovered, and expiring it removes that for every worktree on this clone. No git-tool action brings it back. Next: run action "status" to see the current state instead.',
    displayReason: 'Denied: expiring the reflog removes the only recovery path.',
  },
  stash: {
    reason: 'Raw `git stash drop`/`clear` in bash is denied: it deletes saved work that exists nowhere else — no branch, no remote, no reflog anyone reads — and no git-tool action recovers it. Next: run action "status" to see what is already on the branch, and use action "commit" for work that should be kept.',
    displayReason: 'Denied: dropping a stash deletes work that exists nowhere else.',
  },
  replace: {
    reason: 'Raw `git replace` in bash is denied: it makes every read of an object return a different one, so action "status", action "commit" and action "push" would disagree with every other clone. No git-tool action uses replace refs. Next: run action "status" to see the real state of this repository.',
    displayReason: 'Denied: replace refs change what git reads. Use action "status".',
  },
  rerere: {
    reason: 'Raw `git rerere forget` in bash is denied: it removes the recorded conflict resolution, so the same conflict must be resolved again and a later replay of the merge can pick the wrong side. Next: run action "sync" to bring the base in through the tool, where conflicts are reported instead of replayed.',
    displayReason: 'Denied: forgetting a resolution makes the next replay wrong. Use action "sync".',
  },
  notes: {
    reason: 'Raw `git notes prune` in bash is denied: it deletes notes attached to unreachable commits, and notes are not pushed by action "push", so what it removes exists only on this disk. Next: run action "status" to see the repository state, and keep what matters in a commit with action "commit".',
    displayReason: 'Denied: pruning notes deletes text that is not pushed anywhere.',
  },
  submodule: {
    reason: 'Raw `git submodule deinit --force` in bash is denied: it removes the submodule\'s working tree and can discard commits made inside it that were never pushed from there. Next: run action "status" to see what this repository tracks, and commit the submodule\'s work deliberately before anything removes that tree.',
    displayReason: 'Denied: forced submodule deinit can drop unpushed work in it.',
  },
  'checkout-index': {
    reason: 'Raw `git checkout-index` in bash is denied: it copies index entries over working-tree files, discarding edits that no git-tool action can bring back. Next: run action "status" to see what is uncommitted; action "commit" is how edits are kept.',
    displayReason: 'Denied: checkout-index overwrites working-tree edits. Use action "commit".',
  },
  'reset-index': {
    reason: 'Raw index resetting in bash is denied: it discards staged content that may be the only copy of work another session staged in this worktree. Next: run action "status" to see the staged paths, then keep them with action "commit".',
    displayReason: 'Denied: resetting the index can drop the only copy of staged work.',
  },
});

/** The reason for a mutating command this table has no specific entry for. */
const GENERIC_MUTATING = Object.freeze({
  reason: 'Raw git mutation in bash is gated. Use the git tool instead: action "status" reports what this repository has, action "commit" records named paths, action "push" publishes the branch, and action "finish" does all three. Next: run action "status".',
  displayReason: 'Use the git tool: action "status", "commit", "push" or "finish".',
});

/** The fallback for a destructive command with no specific entry. */
const GENERIC_DESTRUCTIVE = Object.freeze({
  reason: 'Raw git that discards work in bash is denied: it can destroy commits or edits other sessions and worktrees still hold, and no git-tool action undoes it. Next: run action "status" to see what is at stake before doing anything else.',
  displayReason: 'Denied: this discards work other sessions may hold. Run action "status".',
});

/**
 * The replacement named for a push that targets a protected branch.
 *
 * @param {string} named - the branch that matched, carried by the flag rather
 *   than read off the front of the configured list.
 * @returns {{reason: string, displayReason: string}}
 */
function protectedPushReason(named) {
  return {
    reason: 'Raw `git push` to the protected branch ' + named + ' in bash is gated. Use the git tool instead: action "start" puts the work in a task worktree on its own branch, then action "push" publishes it. Pushing straight to ' + named + ' is the case this guard exists to stop. Next: run action "start".',
    displayReason: 'Gated: push to protected branch "' + named + '". Use action "start", then "push".',
  };
}

/**
 * The reason for a `git checkout -- <paths>` that would discard edits.
 *
 * @returns {{reason: string, displayReason: string}}
 */
function discardCheckoutReason() {
  return {
    reason: 'Raw `git checkout -- <paths>` in bash is gated: it overwrites uncommitted edits and no git-tool action can bring them back. If the edits are wanted, record them with action "commit"; if the goal is another branch, action "start" leaves this worktree alone. Next: run action "commit" for the edits worth keeping.',
    displayReason: 'Gated: this discards uncommitted edits. Keep them with action "commit" first.',
  };
}

/**
 * The reason for a git-adjacent program such as `gitk` or `git-lfs`, which is
 * not the `git` binary the tables describe.
 *
 * @param {string} name
 * @returns {{reason: string, displayReason: string}}
 */
function adjacentProgramReason(name) {
  return {
    reason: '`' + name + '` is a separate program, not the `git` binary, so its arguments cannot be checked here. The git tool covers the operations it knows: action "status" reports state, action "commit" records named paths, action "push" publishes, action "sync" fast-forwards, action "finish" does all of it. Next: call the git tool with the action you meant.',
    displayReason: 'Gated: `' + name + '` is not git. Use the git tool instead.',
  };
}

/**
 * The reason for git hidden inside a wrapper: `eval`, `sh -c`, `zsh -c`,
 * `xargs git`, `find -exec git`, `env git`. The class stays `unknown`, so a
 * destructive-looking string is asked about, never denied on a guess.
 *
 * @param {{riskFlags?: string[]}} invocation
 * @param {string} wrapper
 * @returns {{reason: string, displayReason: string}}
 */
function uninspectableReason(invocation, wrapper) {
  const flags = Array.isArray(invocation.riskFlags) ? invocation.riskFlags : [];
  const destructiveLooking = flags.includes('destructive-looking');
  const reason = destructiveLooking
    ? 'Git run through `' + wrapper + '` cannot be inspected, and the inner text mentions a command that discards work. A person has to decide this one: the git tool offers action "status" to read the repository, and action "commit", action "push", action "sync" and action "finish" for the operations it supports. Next: approve only if this exact command is intended, otherwise call the git tool.'
    : 'Git run through `' + wrapper + '` cannot be inspected: the guard cannot prove which command the wrapper executes. The git tool covers the real operations: action "status" reports state, action "commit" records named paths, action "push" publishes, action "sync" fast-forwards, action "finish" does all of it. Next: call the git tool with the action you meant.';
  return {
    reason,
    displayReason: 'Gated: git through `' + wrapper + '` cannot be inspected. Use the git tool.',
  };
}

/** The human phrase for one code-execution override, for the reason text. */
const EXEC_OVERRIDE_LABELS = Object.freeze({
  '--exec-path': 'every program in the directory named by --exec-path',
  '--upload-pack': 'the program named by --upload-pack',
});

/**
 * A readable name for what git was told to run.
 *
 * @param {string} name - the env variable or config key, or `--exec-path`.
 * @returns {string}
 */
function execOverrideLabel(name) {
  if (EXEC_OVERRIDE_LABELS[name] !== undefined) return EXEC_OVERRIDE_LABELS[name];
  if (name === name.toUpperCase()) return 'the program in ' + name;
  return 'the program named by the config key ' + name;
}

/**
 * Whether one override name is the pager: either environment variable
 * (`GIT_PAGER`, `PAGER`), or a config key that names a pager program
 * (`core.pager`, `pager.log`).
 *
 * The pager is the one override with a way out that needs no approval, because
 * git has a flag that turns it off for a single command. Nothing like that
 * exists for an external diff driver, an editor, a hook or an alias.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isPagerOverride(name) {
  const lowered = String(name).toLowerCase();
  return lowered === 'git_pager' || lowered === 'pager'
    || lowered === 'core.pager' || lowered.startsWith('pager.');
}

/**
 * The reason for a read command that also tells git to run something.
 *
 * Deliberately NOT the wrapper text: nothing here is wrapped. The command is a
 * git read the tables can classify, plus an override that makes git start a
 * program of the caller's choosing, so the guard cannot see what runs and the
 * approval would cover it.
 *
 * @param {{riskFlags?: string[]}} invocation
 * @returns {{reason: string, displayReason: string}}
 */
function execOverrideReason(invocation) {
  const flags = Array.isArray(invocation.riskFlags) ? invocation.riskFlags : [];
  const names = flags.filter((flag) => typeof flag === 'string' && flag.startsWith(EXEC_OVERRIDE_FLAG))
    .map((flag) => flag.slice(EXEC_OVERRIDE_FLAG.length));
  const labels = names.map((name) => execOverrideLabel(name));
  const named = labels.length > 1 ? labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1] : labels[0];
  // A pager override is the one case where the clean way out is a flag rather
  // than an approval: `git --no-pager <command>` is the same read with the
  // pager off for that one command, and the guard already allows it. Saying so
  // costs nothing and saves a session that only wanted the output from waiting
  // on a question. The other overrides get no such sentence, because
  // `--no-pager` cannot stop an external diff driver, an editor or a hook.
  const pagerAdvice = names.some((name) => isPagerOverride(name))
    ? ' If the point is only to read without a pager, `git --no-pager <command>` is the same read and is already allowed: it turns the pager off for that one command instead of naming a program for git to run.'
    : '';
  return {
    reason: 'This line looks like a read, but it also tells git to run ' + named + '. Nothing is wrapped here: git itself starts that program while the read runs, so the guard cannot see what it does, and the approval would cover it — including raw git that this guard exists to refuse.' + pagerAdvice + ' Next: call the git tool for the read (action "status" reports the repository), and make the override deliberately in a command that is not being classified as a read.',
    displayReason: 'Gated: this read tells git to run ' + named + '. Use the git tool.',
  };
}

/**
 * Whether a reason names at least one action the `git` tool really has.
 *
 * @param {string} reason
 * @returns {boolean}
 */
function namesToolAction(reason) {
  return [...TOOL_ACTIONS].some((action) => reason.includes('"') && reason.includes('action "' + action + '"'));
}

/**
 * The reason pair for one invocation, and the check that it names a real
 * replacement where a replacement exists.
 *
 * @param {{class: string, subcommand?: string, tokens?: string[], riskFlags?: string[]}} invocation
 * @param {object} config
 * @returns {{reason: string, displayReason: string}}
 */
function reasonFor(invocation, config) {
  const subcommand = invocation.subcommand ?? '';
  const flags = Array.isArray(invocation.riskFlags) ? invocation.riskFlags : [];
  const protectedBranches = Array.isArray(config?.protectedBranches) && config.protectedBranches.length > 0
    ? config.protectedBranches
    : ['main', 'master'];

  if (invocation.class === COMMAND_CLASSES.DESTRUCTIVE) {
    if (subcommand === 'push') {
      return flags.includes('force')
        ? DESTRUCTIVE_REASONS.push
        : flags.includes('delete-branch') || flags.includes('mirror')
          ? DESTRUCTIVE_REASONS['push-delete']
          : DESTRUCTIVE_REASONS.push;
    }
    return DESTRUCTIVE_REASONS[subcommand] ?? GENERIC_DESTRUCTIVE;
  }

  if (invocation.class === COMMAND_CLASSES.UNKNOWN) {
    // A code-execution override has its own reason: the wrapper text would be
    // false, because nothing is wrapped — git is being told what to run.
    if (flags.some((flag) => typeof flag === 'string' && flag.startsWith(EXEC_OVERRIDE_FLAG))) {
      return execOverrideReason(invocation);
    }
    const name = Array.isArray(invocation.tokens) && invocation.tokens.length > 0
      ? commandName(invocation.tokens[0])
      : 'a wrapper';
    const wrapperFlag = flags.find((flag) => typeof flag === 'string' && flag.startsWith('uninspectable:'));
    const wrapper = wrapperFlag === undefined ? 'a wrapper' : wrapperFlag.slice('uninspectable:'.length);
    if (name.startsWith('git') && name !== 'git' && !name.includes('/')) return adjacentProgramReason(name);
    return uninspectableReason(invocation, wrapper);
  }

  // Mutating.
  const protectedFlag = flags.find((flag) => typeof flag === 'string' && flag.startsWith(PROTECTED_BRANCH_FLAG));
  if (subcommand === 'push' && protectedFlag !== undefined) {
    return protectedPushReason(protectedFlag.slice(PROTECTED_BRANCH_FLAG.length));
  }
  if ((subcommand === 'checkout' || subcommand === 'switch') && flags.includes('discard')) return discardCheckoutReason();
  if (subcommand === 'branch' && flags.includes('set-upstream')) {
    return {
      reason: 'Raw `git branch -u` sets an upstream by hand. The git tool does that itself: action "push" sets the upstream on the first push of a task branch and refuses a protected branch. Next: run action "push".',
      displayReason: 'Use the git tool: action "push" sets the upstream when it publishes.',
    };
  }
  // A coverage guard, not a fallback anyone should reach: every member of
  // MUTATING_SUBCOMMANDS has an entry above, and test/guard-classify.test.mjs asserts it.
  const chosen = MUTATING_REASONS[subcommand] ?? GENERIC_MUTATING;
  return namesToolAction(chosen.reason) ? chosen : GENERIC_MUTATING;
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/**
 * Decide what happens to a pending tool call.
 *
 * Pure, synchronous, no I/O: the `tools/pre-execute` waterfall listener needs a
 * decision on the current tick, and the tests call this directly with a plain
 * object.
 *
 * `exec` is a DSH ToolExecution; the shell command is read from
 * `exec.arguments.command`. `config` is the resolved plugin config, of which
 * four fields matter: `guardMode`, `guardAsk`, `guardTools` and
 * `protectedBranches`.
 *
 * Order of precedence, which is the whole policy:
 *   - a tool that is not in `guardTools` allows;
 *   - `guardMode` `off` and `warn` allow (the caller logs; it can still call
 *     `findGitInvocations` for the classification);
 *   - a command with no git invocation allows;
 *   - one destructive invocation anywhere denies the whole command line, so
 *     `git status && git reset --hard` is a denial, not an approval;
 *   - a wrapper that peeked a destructive command denies the same way, unless
 *     `guardAsk` is `allow`;
 *   - everything else allows: reads, and every ordinary workflow write —
 *     fetch, pull, push, commit, add, checkout, branch, rebase, merge, clone,
 *     stash, config, remote and tag. The guard refuses what loses work; it is
 *     not a gate on normal git.
 *
 * A decision is rendered from the tokens alone, so a command aimed at another
 * directory (`git -C /repo push`, `--git-dir=/r/.git`) still gets a verdict;
 * the caller renders that verdict against whatever directory it guessed.
 *
 * @param {object} exec - the pending ToolExecution.
 * @param {object} config - resolved plugin config.
 * @returns {{kind: 'allow'} | {kind: 'ask'|'deny', reason: string, displayReason: string}}
 */
export function evaluate(exec, config) {
  const settings = config !== null && typeof config === 'object' ? config : {};
  const guardTools = Array.isArray(settings.guardTools) && settings.guardTools.length > 0
    ? settings.guardTools
    : ['bash'];
  if (!guardTools.includes(exec?.name)) return { kind: 'allow' };

  const command = exec?.arguments?.command;
  if (typeof command !== 'string' || command.trim() === '') return { kind: 'allow' };

  // Classified before the mode check: `warn` still lets the caller record what
  // would have been gated, which is the data the mode exists to produce.
  const invocations = findGitInvocations(command)
    .map((item) => enrichWithConfig(item, settings.protectedBranches));
  if (settings.guardMode === 'off' || settings.guardMode === 'warn') return { kind: 'allow' };
  if (invocations.length === 0) return { kind: 'allow' };

  const destructive = invocations.find((item) => item.class === COMMAND_CLASSES.DESTRUCTIVE);
  if (destructive !== undefined) return decide('deny', destructive, settings);

  // Every invocation is policed, including the subcommands the tool has no
  // action for. Holding those aside was the bug: their read forms return `read`
  // from the tables above, while their mutating forms are refused below with a
  // reason that says the tool cannot replace the operation and names `guardMode`
  // as the deliberate escape hatch.

  // Mutating git in bash is refused, not offered for approval.
  //
  // Asking was the original design — "a hard denial on every git commit is a guard
  // users switch off" — but it made the guard advisory: the request gets approved
  // and the raw command runs anyway, which is the thing the guard exists to stop.
  // When using the tool is the requirement, refusing is the only version of this
  // that holds. The escape hatch is a setting (`guardMode: 'warn'` or `'off'`),
  // deliberately not the default behaviour.
  const mutating = invocations.find((item) => item.class === COMMAND_CLASSES.MUTATING);
  if (mutating !== undefined) return decide('deny', mutating, settings);

  // An unrecognised subcommand is the one verdict that needs a person: refusing a
  // command whose effect cannot be classified would block work nobody
  // understands, and every workflow command this plugin owns is classified
  // above. `guardAsk` exists for the deployment where nobody is there to answer
  // — an approval prompt with no answerer holds the turn open until the tool
  // times out, which is worse than either an honest refusal or an honest pass.
  const unknown = invocations.find((item) => item.class === COMMAND_CLASSES.UNKNOWN);
  if (unknown !== undefined) {
    if (settings.guardAsk === 'allow') return { kind: 'allow' };
    if (settings.guardAsk === 'deny') {
      const chosen = reasonFor(unknown, settings);
      return {
        kind: 'deny',
        reason: chosen.reason + ' This deployment sets guardAsk: "deny", so a command the guard cannot classify is refused rather than left waiting for an approval nobody is there to give. Call the git tool with the action you meant, or set guardAsk: "ask" when a person is watching.',
        displayReason: 'Denied: unclassifiable git, and guardAsk is "deny"',
      };
    }
    return decide('ask', unknown, settings);
  }

  return { kind: 'allow' };
}

/**
 * Re-classify an invocation with the config the guard was given.
 *
 * `findGitInvocations` takes only a command line, because that is its contract
 * and the classification tables depend on nothing else. One verdict does depend
 * on config: a push to a branch named in `protectedBranches`. `evaluate` has
 * that list, so it merges the extra flags in here. Uninspectable entries are
 * left exactly as they are: their tokens are not a git invocation to re-read.
 *
 * @param {{class: string, tokens: string[], riskFlags?: string[]}} invocation
 * @param {string[]|undefined} protectedBranches
 * @returns {{class: string, tokens: string[], subcommand?: string, riskFlags?: string[]}}
 */
function enrichWithConfig(invocation, protectedBranches) {
  if (invocation.class === COMMAND_CLASSES.UNKNOWN) return invocation;
  const verdict = classifyGitInvocation(invocation.tokens, protectedBranches);
  if (verdict.class === COMMAND_CLASSES.UNKNOWN) return invocation;
  const flags = new Set([...(invocation.riskFlags ?? []), ...(verdict.riskFlags ?? [])]);
  const merged = { ...invocation, class: verdict.class };
  if (verdict.subcommand !== undefined) merged.subcommand = verdict.subcommand;
  if (flags.size > 0) merged.riskFlags = [...flags];
  return merged;
}

/**
 * Build the ask or deny result from the invocation that earned it.
 *
 * @param {'ask'|'deny'} kind
 * @param {object} invocation
 * @param {object} config
 * @returns {{kind: 'ask'|'deny', reason: string, displayReason: string}}
 */
function decide(kind, invocation, config) {
  const chosen = reasonFor(invocation, config);
  return { kind, reason: chosen.reason, displayReason: chosen.displayReason };
}
