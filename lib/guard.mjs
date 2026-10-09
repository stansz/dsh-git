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
]);

/**
 * Git subcommands that can change the repository. A mutating invocation asks
 * the user and names the `git` tool action that replaces it.
 *
 * @type {ReadonlySet<string>}
 */
// Gated only where the tool has an action that does the same job.
//
// A gate over a capability the tool does not have manufactures a decision for the
// user with no correct answer: `git tag` was gated while the tool cannot create
// tags, so the advice amounted to "we do not do that" and the only real options
// were approving a raw command or being blocked. Commands the tool does not cover
// are left alone instead — tag, notes, remote, config, submodule, reflog,
// format-patch, send-email, gc, maintenance, repack, lfs, sparse-checkout.
//
// `reflog expire` is still destructive and still denies: that list is separate.
/**
 * Subcommands the guard deliberately does not police.
 *
 * The tool has no action for any of these, so gating them produces a prompt
 * whose answer is "the tool cannot do that" — a decision for the user with no
 * correct answer, which is worse than no gate at all. They are left to the
 * agent, and `evaluate` skips them on both the mutating and the unknown path.
 */
export const NOT_POLICED_SUBCOMMANDS = readonlySet('NOT_POLICED_SUBCOMMANDS', [
  'tag', 'notes', 'remote', 'config', 'submodule', 'reflog', 'format-patch',
  'send-email', 'gc', 'maintenance', 'repack', 'lfs', 'sparse-checkout',
]);

export const MUTATING_SUBCOMMANDS = readonlySet('MUTATING_SUBCOMMANDS', [
  'add', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'cherry-pick',
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

/**
 * Whether any of these exact options is present: `--list`, `--dry-run`.
 *
 * @param {string[]} args
 * @param {string[]} names
 * @returns {boolean}
 */
function hasOption(args, names) {
  return args.some((token) => names.includes(token));
}

/**
 * Whether a long option is present, with or without a value: `--prune`,
 * `--prune=now`, `--force-with-lease=origin/main`.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {boolean}
 */
function hasLongOption(args, name) {
  return args.some((token) => token === name || token.startsWith(name + '='));
}

/**
 * Whether a short flag is present, alone or clustered: `-f` in `-fd`, `-D` for
 * `-d`, `-n` in `-n5`. `--force` is not a short flag and is never matched here.
 *
 * @param {string[]} args
 * @param {string} letters - one or more flag letters, case-insensitively.
 * @returns {boolean}
 */
function hasShortFlag(args, letters) {
  const wanted = letters.toLowerCase();
  return args.some((token) => token.startsWith('-') && !token.startsWith('--') && token.length > 1
    && [...token.slice(1).toLowerCase()].some((char) => wanted.includes(char)));
}

/**
 * Whether a short flag appears with exactly this case: `-D` is not `-d`, and on
 * `git branch` that difference is a forced delete versus a checked one.
 *
 * @param {string[]} args
 * @param {string} letter
 * @returns {boolean}
 */
function hasShortFlagExact(args, letter) {
  return args.some((token) => token.startsWith('-') && !token.startsWith('--') && token.slice(1).includes(letter));
}

/**
 * Positional arguments: the tokens that are not options.
 *
 * @param {string[]} args
 * @param {string[]} valueOptions - options whose following token is a value.
 * @returns {string[]}
 */
function positionals(args, valueOptions = []) {
  const found = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.startsWith('-')) {
      if (!token.includes('=') && valueOptions.includes(token)) index += 1;
      continue;
    }
    found.push(token);
  }
  return found;
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
 * `git branch --contains HEAD`, and a bare `git branch`.
 *
 * @param {string[]} args
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyBranch(args) {
  const flags = [];
  if (hasShortFlag(args, 'd') || hasOption(args, ['--delete'])) {
    if (hasShortFlagExact(args, 'D')) flags.push('force');
    return { class: COMMAND_CLASSES.DESTRUCTIVE, riskFlags: [...flags, 'delete-branch'] };
  }
  if (hasLongOption(args, '--move') || hasLongOption(args, '--copy') || hasLongOption(args, '--set-upstream-to')
    || hasLongOption(args, '--unset-upstream') || hasLongOption(args, '--force')
    || hasShortFlag(args, BRANCH_MUTATION_FLAGS)) {
    if (hasLongOption(args, '--set-upstream-to') || hasLongOption(args, '--unset-upstream') || hasShortFlag(args, 'u')) {
      flags.push('set-upstream');
    }
    return { class: COMMAND_CLASSES.MUTATING, riskFlags: flags };
  }
  if (hasLongOption(args, '--list') || hasLongOption(args, '--contains') || hasLongOption(args, '--merged')
    || hasLongOption(args, '--no-merged') || hasOption(args, ['--all', '--remotes', '--verbose', '--show-current'])
    || hasLongOption(args, '--points-at') || hasLongOption(args, '--format')
    || hasShortFlag(args, BRANCH_READ_FLAGS)) {
    return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  }
  // `git branch` alone lists branches; `git branch newthing` creates one.
  return positionals(args).length === 0
    ? { class: COMMAND_CLASSES.READ, riskFlags: [] }
    : { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
}

/**
 * Classify a piece of a `git tag` invocation.
 *
 * `git tag` and `git tag -l` list and stay allowed; a positional name creates a
 * tag; `-d`/`--delete` removes one.
 *
 * @param {string[]} args
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyTag(args) {
  if (hasShortFlag(args, 'd') || hasOption(args, ['--delete'])) {
    const force = hasShortFlag(args, 'f') || hasLongOption(args, '--force');
    return { class: COMMAND_CLASSES.DESTRUCTIVE, riskFlags: [force ? 'force' : 'delete-tag'] };
  }
  if (hasOption(args, ['--list']) || hasShortFlag(args, 'ln')) {
    return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  }
  const named = positionals(args, ['-m', '--message', '-F', '--file']).length > 0;
  if (!named && !hasShortFlag(args, 'asfm') && !hasOption(args, ['--annotate', '--sign', '--message', '--file', '--force'])) {
    return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  }
  return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
}

/**
 * Classify a piece of a `git remote` invocation.
 *
 * `git remote`, `-v` and `show` read; add, remove, rename and set-url write.
 *
 * @param {string[]} args
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyRemote(args) {
  if (args.length === 0 || hasOption(args, ['-v', '--verbose', 'show', 'get-url'])) {
    return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  }
  if (hasOption(args, ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'])) {
    return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
  }
  return { class: COMMAND_CLASSES.UNKNOWN, riskFlags: [] };
}

/**
 * Classify a piece of a `git config` invocation.
 *
 * A read verb (`--get`, `--get-all`, `--list`, `-l`) is read. A write verb or a
 * `key value` pair is mutating. `git config <key>` alone reads one value, which
 * is the query form and stays allowed.
 *
 * @param {string[]} args
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyConfig(args) {
  const writes = hasOption(args, ['--add', '--unset', '--unset-all', '--replace-all',
    '--rename-section', '--remove-section', '--edit', '-e', 'set']);
  const reads = hasOption(args, ['--get', '--get-all', '--get-regexp', '--get-urlmatch',
    '--list', '-l', '--show-origin', '--show-scope', '--name-only']);
  if (writes) return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
  if (reads) return { class: COMMAND_CLASSES.READ, riskFlags: [] };
  const named = positionals(args, ['-f', '--file', '--type', '-t', '--default']);
  if (named.length >= 2) return { class: COMMAND_CLASSES.MUTATING, riskFlags: [] };
  if (named.length === 1) return { class: COMMAND_CLASSES.READ, riskFlags: [] };
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
function classifyFetch(args) {
  const flags = [];
  if (args.some((token) => token.startsWith('+') || token.includes(':'))) flags.push('refspec-write');
  if (hasOption(args, ['--all', '--prune', '--tags', '-p', '--mirror', '--set-upstream'])) flags.push('writes-refs');
  if (hasLongOption(args, '--force') || hasShortFlag(args, 'f')) flags.push('force');
  return {
    class: flags.length > 0 ? COMMAND_CLASSES.MUTATING : COMMAND_CLASSES.READ,
    riskFlags: flags,
  };
}

/**
 * Classify a piece of a `git push` invocation.
 *
 * Force, delete and mirror forms discard or remove remote work and deny. A
 * plain push, including `--dry-run`, asks: it is the operation the `git` tool
 * owns, and the tool's push is the one that refuses a protected branch.
 *
 * @param {string[]} args
 * @param {string[]} protectedBranches
 * @returns {{class: string, riskFlags: string[]}}
 */
function classifyPush(args, protectedBranches) {
  const flags = [];
  if (hasLongOption(args, '--force') || hasLongOption(args, '--force-with-lease')
    || hasLongOption(args, '--force-if-includes') || hasShortFlag(args, 'f')
    || args.some((token) => token.startsWith('+'))) {
    flags.push('force');
  }
  if (hasOption(args, ['-d']) || hasLongOption(args, '--delete') || hasLongOption(args, '--mirror')
    || args.some((token) => token.startsWith(':'))) {
    flags.push('delete-branch');
  }
  if (hasLongOption(args, '--mirror')) flags.push('mirror');
  const targets = pushTargets(args);
  if (protectedBranches.some((branch) => targets.includes(branch))) flags.push('protected-branch');
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
function pushTargets(args) {
  const named = positionals(args, ['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
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
  const resolved = resolveSubcommand(tokens, start + 1);
  // `git --version`, `git -C /repo` and `git` alone resolve no subcommand: they
  // are reported as unknown, never as read, because nothing was inspected.
  if (resolved === undefined) return { class: COMMAND_CLASSES.UNKNOWN };

  const subcommand = resolved.subcommand;
  const args = beforeDoubleDash(tokens.slice(resolved.index + 1));
  const hadDoubleDash = tokens.slice(resolved.index + 1).includes('--');
  const branches = Array.isArray(protectedBranches) ? protectedBranches : [];
  const verdict = classifySubcommand(subcommand, args, hadDoubleDash, branches);
  if (verdict.class === COMMAND_CLASSES.UNKNOWN) return { class: COMMAND_CLASSES.UNKNOWN };
  const result = { class: verdict.class, subcommand };
  if (verdict.riskFlags !== undefined && verdict.riskFlags.length > 0) result.riskFlags = verdict.riskFlags;
  return result;
}

/**
 * The per-subcommand rules, once the effective subcommand is known.
 *
 * @param {string} subcommand
 * @param {string[]} args - tokens after the subcommand, before any `--` tail.
 * @param {boolean} hadDoubleDash - whether a bare `--` followed the subcommand.
 * @param {string[]} protectedBranches
 * @returns {{class: string, riskFlags?: string[]}}
 */
function classifySubcommand(subcommand, args, hadDoubleDash, protectedBranches) {
  const read = () => ({ class: COMMAND_CLASSES.READ, riskFlags: [] });
  const ask = (riskFlags = []) => ({ class: COMMAND_CLASSES.MUTATING, riskFlags });
  const deny = (riskFlags = []) => ({ class: COMMAND_CLASSES.DESTRUCTIVE, riskFlags });
  const unknown = () => ({ class: COMMAND_CLASSES.UNKNOWN, riskFlags: [] });

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
      return read();

    /* Always mutating. */
    case 'add':
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
    case 'format-patch':
    case 'send-email':
    case 'maintenance':
    case 'prune':
    case 'repack':
      return ask();

    case 'push':
      return classifyPush(args, protectedBranches);
    case 'fetch':
      return classifyFetch(args);
    case 'branch':
      return classifyBranch(args);
    case 'tag':
      return classifyTag(args);
    case 'remote':
      return classifyRemote(args);
    case 'config':
      return classifyConfig(args);
    case 'stash':
      if (hasOption(args, ['drop', 'clear'])) return deny();
      if (hasOption(args, ['list', 'show'])) return read();
      // Bare `git stash` saves a stash, which is a write: only list and show read.
      return ask();
    case 'reflog':
      if (hasOption(args, ['expire'])) return deny();
      if (hasOption(args, ['delete'])) return ask();
      if (args.length === 0 || args[0].startsWith('-') || hasOption(args, ['show'])) return read();
      return unknown();
    case 'notes':
      if (hasOption(args, ['prune'])) return deny();
      if (args.length === 0 || hasOption(args, ['list', 'show'])) return read();
      if (hasOption(args, ['add', 'append', 'copy', 'edit', 'remove'])) return ask();
      return unknown();
    case 'worktree':
      if (args.length === 0 || hasOption(args, ['list'])) return read();
      if (hasOption(args, ['remove'])) {
        return hasLongOption(args, '--force') || hasShortFlag(args, 'f') ? deny(['force']) : ask();
      }
      if (hasOption(args, ['add', 'move', 'repair', 'lock', 'unlock', 'prune'])) return ask();
      return unknown();
    case 'submodule':
      if (args.length === 0 || hasOption(args, ['status', 'summary'])) return read();
      if (hasOption(args, ['deinit']) && (hasLongOption(args, '--force') || hasShortFlag(args, 'f'))) return deny(['force']);
      if (hasOption(args, ['add', 'update', 'init', 'deinit', 'sync', 'set-url', 'set-branch', 'absorbgitdirs'])) return ask();
      // `git submodule foreach <cmd>` runs an arbitrary command in every
      // submodule, so it is not resolvable here.
      return unknown();

    case 'reset': {
      const riskFlags = hasLongOption(args, '--hard') ? ['hard']
        : hasLongOption(args, '--soft') ? ['soft'] : ['mixed'];
      return deny(riskFlags);
    }
    case 'clean':
      // `-n`/`--dry-run` prints what would go and removes nothing.
      if (hasLongOption(args, '--dry-run') || hasShortFlag(args, 'n')) return read();
      return deny(['no-dry-run', ...(hasLongOption(args, '--force') || hasShortFlag(args, 'f') ? ['force'] : [])]);

    case 'gc':
      if (args.some((token) => GC_PRUNE_NOW.test(token)) || hasLongOption(args, '--aggressive')) {
        return deny(args.some((token) => GC_PRUNE_NOW.test(token)) ? ['prune-now'] : ['aggressive']);
      }
      return ask();

    case 'update-ref':
    case 'filter-branch':
    case 'filter-repo':
    case 'checkout-index':
    case 'reset-index':
      return deny();

    case 'symbolic-ref': {
      if (hasOption(args, ['-d', '--delete'])) return deny();
      const named = positionals(args);
      if (named.length >= 2) return deny();
      if (named.length === 1) return read();
      return unknown();
    }

    case 'replace':
      return hasOption(args, ['-l', '--list']) ? read() : deny();

    case 'rerere':
      if (hasOption(args, ['forget'])) return deny();
      if (hasOption(args, ['gc', 'clear'])) return ask();
      return read();

    case 'lfs':
      return hasOption(args, ['ls-files', 'env', 'status']) ? read() : ask();

    case 'sparse-checkout':
      return hasOption(args, ['list']) ? read() : ask();

    case 'checkout':
    case 'switch': {
      const riskFlags = [];
      if (hasOption(args, ['-b', '-B', '-c', '-C', '--orphan', '--track', '-t', '--create', '--force-create'])) {
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
      return unknown();
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
 * reasons below may only name these, and the self-check asserts it.
 */
const TOOL_ACTIONS = readonlySet('TOOL_ACTIONS', ['status', 'start', 'commit', 'push', 'sync', 'pr', 'merge', 'finish', 'prune']);

/** Why a mutating command is gated and which action replaces it, per subcommand. */
const MUTATING_REASONS = Object.freeze({
  add: {
    reason: 'Raw `git add` in bash is gated. Use the git tool instead: action "commit" with `paths: [...]` stages exactly those paths and commits them with a message. Nothing is left staged-but-uncommitted. Next: run action "commit" with the paths you meant to add.',
    displayReason: 'Use the git tool: action "commit" with paths stages them and commits.',
  },
  commit: {
    reason: 'Raw `git commit` in bash is gated. Use the git tool instead: action "commit" with `paths: [...]` stages exactly those paths and commits with a message. That keeps this repo clean and pushed at turn end without sweeping in other sessions\' changes.',
    displayReason: 'Use the git tool: action "commit" stages exactly the paths you name.',
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
    reason: 'Raw `git checkout` in bash is gated. Use the git tool instead: action "start" creates or reuses the task worktree and its own branch, off the configured base, so work happens off the protected branch without switching this checkout under another session. Next: run action "start".',
    displayReason: 'Use the git tool: action "start" opens a task worktree on its own branch.',
  },
  switch: {
    reason: 'Raw `git switch` in bash is gated. Use the git tool instead: action "start" creates or reuses the task worktree and its own branch, off the configured base, so work happens off the protected branch without switching this checkout under another session. Next: run action "start".',
    displayReason: 'Use the git tool: action "start" opens a task worktree on its own branch.',
  },
  restore: {
    reason: 'Raw `git restore` in bash is gated: it overwrites uncommitted edits, and no git-tool action can recover them. To keep a change, record it with action "commit"; to work on another branch, action "start" leaves this worktree as it is. Next: run action "commit" for the paths worth keeping.',
    displayReason: 'Gated: restore discards uncommitted edits. Keep them with action "commit".',
  },
  stash: {
    reason: 'Raw `git stash` in bash is gated. Use the git tool instead: action "commit" with `paths: [...]` records the change on this worktree\'s branch, where it is pushed at turn end. A stash lives on this disk only, so the session that stashes is the session that loses the work. Next: run action "commit".',
    displayReason: 'Use the git tool: action "commit" keeps the change on this branch.',
  },
  branch: {
    reason: 'Raw `git branch` in bash is gated when it creates, renames, copies or re-points a branch. Use the git tool instead: action "start" creates the task worktree and its branch together, and action "finish" closes them out once the commits are pushed. Next: run action "start".',
    displayReason: 'Use the git tool: action "start" creates the worktree and its branch.',
  },
  tag: {
    reason: 'Raw `git tag` creation in bash is gated. The git tool publishes branches, not tags: action "push" publishes the commits and action "pr" opens the pull request. A tag made here is not pushed, so the release exists on one machine only. Next: run action "push".',
    displayReason: 'Use the git tool: action "push" for the commits; tag releases on GitHub.',
  },
  remote: {
    reason: 'Raw `git remote` mutation in bash is gated. The git tool resolves the origin remote itself, and a hand-edited remote silently changes what action "push" and action "sync" talk to. Change the remote deliberately, then run action "status" to confirm what the tool sees.',
    displayReason: 'Use the git tool: action "status" shows the remote a push would use.',
  },
  worktree: {
    reason: 'Raw `git worktree` mutation in bash is gated. Use the git tool instead: action "start" creates the task worktree under the configured root and locks it to this session; action "finish" removes it only after its commits are pushed. A hand-made worktree is one nothing later cleans up. Next: run action "start".',
    displayReason: 'Use the git tool: action "start" creates the worktree, "finish" removes it.',
  },
  submodule: {
    reason: 'Raw `git submodule` mutation in bash is gated. The git tool has no submodule action, and an update rewrites gitlink paths that action "commit" would then stage by accident. Make the change deliberately, then run action "status" to confirm which paths moved.',
    displayReason: 'Gated: change the submodule deliberately, then run action "status".',
  },
  config: {
    reason: 'Raw `git config` write in bash is gated. The git tool reads the repository configuration itself, and a hand-written value can change the identity action "commit" records or the branch action "push" targets. Change the setting in the file it lives in, then run action "status" to confirm the state the tool sees.',
    displayReason: 'Gated: change config deliberately, then confirm with action "status".',
  },
  notes: {
    reason: 'Raw `git notes` mutation in bash is gated. The git tool does not push notes, so a note written here stays on this disk. Put the information in the message action "commit" writes instead, where it travels with the pushed commit. Next: run action "commit".',
    displayReason: 'Use the git tool: action "commit" carries the message; notes are not pushed.',
  },
  reflog: {
    reason: 'Raw `git reflog delete` in bash is gated: it removes the record that lets a lost commit be recovered, and no git-tool action restores it. Leave the reflog alone; action "status" reports how far this branch is from its upstream. Next: run action "status".',
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
    reason: 'Raw `git format-patch` in bash is gated: it writes .patch files into the worktree, which is the dirty tree this plugin removes. Share the branch instead: action "push" publishes it and action "pr" opens the pull request. Next: run action "push".',
    displayReason: 'Use the git tool: action "push" publishes the branch; action "pr" opens it.',
  },
  'send-email': {
    reason: 'Raw `git send-email` in bash is gated. Share the branch instead: action "push" publishes it and action "pr" opens the pull request, where review and CI happen and the outcome is recorded. Next: run action "pr".',
    displayReason: 'Use the git tool: action "push" then action "pr" instead of emailing patches.',
  },
  gc: {
    reason: 'Raw `git gc` in bash is gated. The git tool keeps the repository healthy as part of action "sync" and action "finish", and git collects unreachable objects on its own schedule. A hand-run gc can race a worktree another session owns. Next: run action "finish" when this turn\'s work is done.',
    displayReason: 'Gated: action "finish" commits and pushes; git collects objects itself.',
  },
  maintenance: {
    reason: 'Raw `git maintenance` in bash is gated. The git tool keeps the repository healthy as part of action "sync" and action "finish", and scheduled maintenance is the repository\'s own business. Next: run action "finish" when this turn\'s work is done.',
    displayReason: 'Gated: action "finish" commits and pushes; maintenance is scheduled.',
  },
  prune: {
    reason: 'Raw `git prune` in bash is gated: unreachable objects may be the only copy of work another session still holds in a worktree. The git tool keeps the repository healthy through action "sync" and action "finish". Next: run action "finish" when this turn\'s work is done.',
    displayReason: 'Gated: pruning can delete objects another worktree still needs.',
  },
  repack: {
    reason: 'Raw `git repack` in bash is gated: it rewrites the object store while other worktrees and sessions may be reading it. The git tool keeps the repository healthy through action "sync" and action "finish". Next: run action "finish" when this turn\'s work is done.',
    displayReason: 'Gated: repacking races other worktrees; use action "finish".',
  },
  fetch: {
    reason: 'Raw `git fetch` that writes refs in bash is gated. Use the git tool instead: action "sync" fetches origin and fast-forwards this branch, and action "status" reports ahead/behind without writing anything. Next: run action "sync".',
    displayReason: 'Use the git tool: action "sync" fetches and fast-forwards this branch.',
  },
  lfs: {
    reason: 'Raw `git lfs` in bash is gated: it rewrites .gitattributes and the smudge filters that action "commit" and action "push" then work through. Set LFS up deliberately in the repository, then run action "status" to confirm what changed. Next: run action "status".',
    displayReason: 'Gated: set LFS up deliberately, then run action "status".',
  },
  'sparse-checkout': {
    reason: 'Raw `git sparse-checkout` in bash is gated: narrowing the sparse set removes working-tree files that action "commit" would then stage as deletions. Change it deliberately, then run action "status" to confirm the tree is what the tool sees. Next: run action "status".',
    displayReason: 'Gated: change the sparse set deliberately, then run action "status".',
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
 * @param {string[]} protectedBranches
 * @returns {{reason: string, displayReason: string}}
 */
function protectedPushReason(protectedBranches) {
  const named = protectedBranches[0];
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
    const name = Array.isArray(invocation.tokens) && invocation.tokens.length > 0
      ? commandName(invocation.tokens[0])
      : 'a wrapper';
    const wrapperFlag = flags.find((flag) => typeof flag === 'string' && flag.startsWith('uninspectable:'));
    const wrapper = wrapperFlag === undefined ? 'a wrapper' : wrapperFlag.slice('uninspectable:'.length);
    if (name.startsWith('git') && name !== 'git' && !name.includes('/')) return adjacentProgramReason(name);
    return uninspectableReason(invocation, wrapper);
  }

  // Mutating.
  if (subcommand === 'push' && flags.includes('protected-branch')) return protectedPushReason(protectedBranches);
  if ((subcommand === 'checkout' || subcommand === 'switch') && flags.includes('discard')) return discardCheckoutReason();
  if (subcommand === 'branch' && flags.includes('set-upstream')) {
    return {
      reason: 'Raw `git branch -u` sets an upstream by hand. The git tool does that itself: action "push" sets the upstream on the first push of a task branch and refuses a protected branch. Next: run action "push".',
      displayReason: 'Use the git tool: action "push" sets the upstream when it publishes.',
    };
  }
  // A coverage guard, not a fallback anyone should reach: every member of
  // MUTATING_SUBCOMMANDS has an entry above, and the self-check asserts it.
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
 * three fields matter: `guardMode`, `guardTools` and `protectedBranches`.
 *
 * Order of precedence, which is the whole policy:
 *   - a tool that is not in `guardTools` allows;
 *   - `guardMode` `off` and `warn` allow (the caller logs; it can still call
 *     `findGitInvocations` for the classification);
 *   - a command with no git invocation allows;
 *   - one destructive invocation anywhere denies the whole command line, so
 *     `git status && git reset --hard` is a denial, not an approval;
 *   - otherwise one mutating or uninspectable invocation asks;
 *   - an all-read command line allows.
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

  // A subcommand the tool has no action for is not gated at all: asking would
  // force a decision between approving raw git and being blocked, with the advice
  // reduced to "not supported". Destructive ones are still denied above.
  const policed = invocations.filter((item) => !NOT_POLICED_SUBCOMMANDS.has(item.subcommand));

  // Mutating git in bash is refused, not offered for approval.
  //
  // Asking was the original design — "a hard denial on every git commit is a guard
  // users switch off" — but it made the guard advisory: the request gets approved
  // and the raw command runs anyway, which is the thing the guard exists to stop.
  // When using the tool is the requirement, refusing is the only version of this
  // that holds. The escape hatch is a setting (`guardMode: 'warn'` or `'off'`),
  // deliberately not the default behaviour.
  const mutating = policed.find((item) => item.class === COMMAND_CLASSES.MUTATING);
  if (mutating !== undefined) return decide('deny', mutating, settings);

  // An unrecognised subcommand is still only asked about: refusing a command whose
  // effect cannot be classified would block work nobody understands, and every
  // workflow command this plugin owns is classified above.
  const unknown = policed.find((item) => item.class === COMMAND_CLASSES.UNKNOWN);
  if (unknown !== undefined) return decide('ask', unknown, settings);

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
