# dsh-git

One consistent way for DSH to use git and GitHub, and the automation that makes
"nothing was left uncommitted" true without a model remembering it.

A third-party bundle for DeepSeek Harness. MIT licensed — see [LICENSE](LICENSE).
Not an official DeepSeek package.

```bash
# run in the profile directory — the install target, not a global prefix
pnpm add github:stansz/dsh-git
```

Every setting has a working default, so it mounts and does something useful with no
configuration at all. The two worth changing are in
[Changing a setting](#changing-a-setting).

## Why this exists

Raw `git` through `bash` was inconsistent: sessions left work uncommitted and
unpushed, and nothing reported it. This bundle contributes four things, and the
last two are the ones that fix it:

| Contribution | What it is |
|---|---|
| `ctx.tools.register()` | the `git` tool: `clone`, `init`, `fetch`, `branch`, `checkout`, `stash`, `status`, `start`, `commit`, `push`, `sync`, `pr`, `merge`, `finish`, `prune` |
| `ctx.commands.register()` | `/git`, printing the same state to a human |
| `ctx.on('tools/pre-execute')` | a guard that refuses the raw `git` commands that discard work — `reset --hard`, `clean`, a force push, a history rewrite — and allows every read and ordinary write, so normal git and GitHub work still runs |
| `ctx.on('agent/turn-stopping')`, `ctx.on('session/event')`, `ctx.on('tools/pre-execute')` | the automatic sync: at a turn boundary, or a few seconds after a turn's edits stop when no boundary arrives, commit the touched repositories and push what is safe to push |

## The git tool

One tool, fifteen actions. The model sees the full description of each; this is the shape
of them.

- **`clone`** — clone a repository from a URL. `path` is where it lands, `branch`
  checks out a branch at clone time. Returns the state of the clone.
- **`init`** — create a new empty repository. `path` is where it lands, `branch`
  names the initial branch.
- **`fetch`** — fetch from the remote without merging. `remote` defaults to `origin`.
- **`branch`** — list, create, or delete branches. With `name` and `delete: true`,
  removes one (pass `apply: true` to actually delete).
- **`checkout`** — switch to a branch. `create: true` makes it if it does not exist.
  Refuses to switch away from uncommitted work.
- **`stash`** — shelve work in progress. `pop: true` restores it, `list: true` shows
  the stack.
- **`status`** — the state of a repository, or of every repository under a directory:
  branch, ahead/behind, changed paths, worktrees, any open pull request. Reads only.
- **`start`** — create the worktree for this task (branch `<prefix><slug>`, cut from
  `origin/<base>`) and return its path; reuses the one this session already owns.
- **`commit`** — stage the named paths and commit them; with no paths, stage everything.
  `push: true` pushes in the same call.
- **`push`** — push the current branch. Refuses a protected branch unless
  `allowProtected` is true.
- **`sync`** — fetch origin, then fast-forward only: the branch onto its base when it is
  behind and has no commits of its own, or the base branch itself. Never merges or rebases.
- **`pr`** — open a pull request, or return the one already open for this branch. Never
  opens a second one.
- **`merge`** — merge a pull request by number, or the one open for the current branch,
  then remove the branch it came from and retire this session's worktree for it.
- **`finish`** — the closing move for a unit of work: commit anything dirty, push, open or
  reuse the pull request, and report. `cleanup: true` removes the worktree afterwards, and
  only when the branch is on the remote and the worktree holds nothing uncommitted.
- **`prune`** — dry-run then remove what this tool left behind. `apply: true` removes; a
  branch holding work is reported, never deleted.

`/git` prints the same state to a human.

## Documentation

This file is the overview. The detail lives beside it:

| File | What is in it |
|---|---|
| [`docs/turn-sync.md`](docs/turn-sync.md) | the automatic half: what is committed and pushed, when it declines, and how to watch it |
| [`docs/guard.md`](docs/guard.md) | what raw git in `bash` is refused (only what discards work), and why there are no hooks |
| [`docs/worktrees.md`](docs/worktrees.md) | the task lifecycle, ownership and path identity, and the one action that removes things |
| [`docs/install.md`](docs/install.md) | a fresh machine, and `link:` versus GitHub installs |
| [`docs/testing.md`](docs/testing.md) | the tests: what the three that matter are, and why the old suite is gone |

## Settings

One switch is worth knowing. Everything else is there for the plugin's own internals
and rarely needs touching.

| Field | Default | Meaning |
|---|---|---|
| **`worktrees`** | `false` | **The switch for worktree mode.** `true` refuses an edit landing on a protected branch and points at `action: "start"`, so work goes into a worktree on a task branch. `false` is regular mode — edit anywhere, no worktree required. Sets `autoWorktree` and `protectedBranches` together; a named key beside it wins |
| `worktreeRoot` | *(derived)* | Where per-task worktrees live: `<session workspace>/.worktrees` when unset. Set an absolute path to put them elsewhere |
| `stateRoot` | `~/.dsh/state` | Where session ownership and push backoff are recorded |
| `branchPrefix` | `dsh/` | Task branch namespace; these are what automatic push may push |
| `baseBranch` | *(empty)* | Empty resolves `origin/HEAD`, then `main` |
| `protectedBranches` | `[]` | The plugin's own list of branch names, matched literally against the checked-out branch. Never pushed automatically, and `autoWorktree` refuses an edit landing on one. An explicit `[]` lets a `push` to `main` through without `allowProtected`. `worktrees: true` sets this to `[main, master]` |
| `autoWorktree` | `off` | `off` never refuses an edit. `protected` refuses one landing on a protected branch. `always` refuses one landing outside a worktree. `worktrees: true` sets `protected` |
| `guardMode` | `redirect` | `off` \| `warn` \| `redirect`. `redirect` refuses only the commands that discard work; an ordinary read or write runs |
| `guardAsk` | `ask` | What to do with a command that discards work but is hidden in a wrapper (`xargs git push --force`): `ask` \| `deny` \| `allow`. Unclassifiable git that does not peek a destructive command is allowed |
| `guardTools` | `[bash, pwsh]` | Which tools the guard inspects |
| `turnCommit` | `true` | Commit each turn's changes |
| `turnCommitMessage` | *(empty)* | Empty generates `dsh: turn <N> — <paths>`, or `dsh: <paths>` with no turn number. `{turn}` and `{paths}` are substituted |
| `turnPush` | `true` | Push each turn when the branch is safe |
| `turnSyncScope` | `session` | `session` commits only repositories this session changed; `workspace` also scans for any dirty repository |
| `turnCommitMaxFiles` | `200` | Skip above this many changed paths |
| `turnSyncTimeoutMs` | `20000` | Budget for one end-of-turn sync |
| `githubHost` | `github.com` | Set for GitHub Enterprise |
| `prDraft` | `false` | Open pull requests as drafts by default |
| `timeoutMs` | `30000` | Per-git-command deadline |

`plainMode` is the older switch and is equivalent to `worktrees: false` plus
`turnCommit: false` and `turnPush: false`. Prefer `worktrees` unless you also want
the automatic sync off.

### Changing a setting

Override this bundle's row in the profile's patch layer,
`~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: dsh-git
  name: 'dsh-git'
  config:
    worktrees: true
```

Only the fields you name are applied; every other field keeps its default. The row id
is `dsh-git`. Restart the Harness to load it — a plugin's row config is read when the
plugin mounts.

There is also a Configure page (Plugins → dsh-git → Configure) with one control: the
`worktrees` toggle. It writes only that key, so it cannot leave anything else behind.
The file above is still the way to change every other setting.

## Authentication

Nothing is stored here. `git` runs with `HOME` and `PATH` preserved, so the
machine's own credential helper resolves credentials — on this machine that is
`osxkeychain` from the system gitconfig. GitHub API calls use
`GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token --hostname <host>` — the first two need
nothing installed — read lazily,
never logged, never written to disk, and redacted from every error. Neither half is
interactive: prompting is off (`GIT_TERMINAL_PROMPT=0`, no askpass), so nothing can block on
a question with nobody to answer it — and a credential embedded in a remote URL is dropped
wherever a remote is reported, so `status` shows the host and the path, never the userinfo.

The two halves share nothing, and a fresh machine usually has only one of them:
reading a public repository needs no credential at all, so a new machine looks
healthy until its first push, and `GH_TOKEN` never helps a push. A push **or a
fetch** that fails for want of a credential is reported with the fix: a fetch states
it as `next:`, while for a push the note the turn ends with and the record `status`
prints both name a credential helper, an SSH remote, or — when the GitHub CLI is
present — `gh auth setup-git`. A
*failure* is not remembered: the chain is asked again on the next
call, so `gh auth login` in a terminal is picked up without restarting the Harness.
[`docs/install.md`](docs/install.md#authentication-on-a-new-machine) is the
checklist for a machine that has never logged in.

GitHub is talked to over REST rather than through `gh`, because structured
status codes beat matching error prose — and because
[`gh pr merge --delete-branch`](https://github.com/cli/cli/issues/14537) does
local branch cleanup in the *current* directory's repository, matching the branch
by name only, which can delete an unrelated worktree's unpushed commits.

## Requirements

git on `PATH`. `gh` is optional and only used as a token source; without it, set
`GH_TOKEN`. Node 18+ for global `fetch`. No npm dependencies — `lib/*.mjs` import
only `node:` builtins, and `@deepseek-ai/schemastery` is loaded defensively so a
`link:` install cannot take the plugin down at activation.

On the Harness side it declares `tools`, `commands` and `sessions` in `inject`, so
a Harness without those leaves the row pending rather than half-mounting it. It
reaches for `agents` and `workspaceChanges` defensively — a build without them
still works, with a less precise commit subject — and registers on
`tools/pre-execute` and `agent/turn-stopping`.

## Tests

```bash
npm test
```

The test directory is not present in this checkout — the old suite tested internal
modules rather than the behaviour the plugin promises. CI is disabled (the workflow
trigger is `workflow_dispatch` only). What to test if the suite is ever restored is in
[`docs/testing.md`](docs/testing.md).

