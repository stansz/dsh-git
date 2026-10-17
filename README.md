# dsh-git

One consistent way for DSH to use git and GitHub, and the automation that makes
"nothing was left uncommitted" true without a model remembering it.

A third-party bundle for DeepSeek Harness. MIT licensed — see [LICENSE](LICENSE).
Not an official DeepSeek package.

```bash
# run in the profile directory — the install target, not a global prefix
pnpm add github:stansz/dsh-git-core   # the shared library, first
pnpm add github:stansz/dsh-git
```

Every setting has a working default, so it mounts and does something useful with no
configuration at all. The ones worth changing are in
[Changing a setting](#changing-a-setting).

## Three packages, three repositories

| Package | Repository | What it is |
|---|---|---|
| `dsh-git-core` | github.com/stansz/dsh-git-core | The shared library: one place a git command is run, one state store, one recorder of the files a session changes. It registers no tool, no command and no listener. |
| `dsh-git` (this one) | github.com/stansz/dsh-git | The `git` tool, `/git`, the guard that redirects raw git in the shell, and the automatic commit and push at the turn boundary. |
| [`dsh-git-worktrees`](https://github.com/stansz/dsh-git-worktrees) | github.com/stansz/dsh-git-worktrees | One git worktree per task: the `worktree` tool (`start`, `list`, `remove`) and the guard that refuses a file edit landing in a repository sitting on a protected branch. |

**Install the core first.** `dsh-git-core` is a library, not a plugin — it registers
nothing, so it contributes no row. It is still installable because the installer only
treats a package as a bundle when it declares `dsh.bundle.patch`, and its patch is
deliberately empty: one `[]`, no rows. Installing it is what puts it in the profile's
`node_modules`, which is where the other two bundles look for it.

A `link:` install does not hoist a bundle's dependencies, so a bare
`import 'dsh-git-core/git.mjs'` cannot resolve from a checkout beside the profile.
Each bundle loads the core through `lib/core-loader.mjs` instead, which probes the
sibling directory next to the bundle, `$DSH_PROFILE_DIR/node_modules`, and the working
directory. When none of them has it, the plugin fails at activation with a sentence
that names what is missing — `dsh-git-core is not installed: could not load git.mjs …
Install the dsh-git-core bundle beside this one` — rather than a bare
`ERR_MODULE_NOT_FOUND`.

**Core plus `dsh-git` is the minimum** for the everyday flow: the tool, the guard and
the automatic commit and push. `dsh-git-worktrees` is a separate bundle with its own
settings (`worktreeRoot`, `autoWorktree`, `worktrees`); none of its settings exist on
this bundle's row, and installing it is a choice, not a dependency.

## Why this exists

Raw `git` through `bash` was inconsistent: sessions left work uncommitted and
unpushed, and nothing reported it. This bundle contributes four things, and the
last two are the ones that fix it:

| Contribution | What it is |
|---|---|
| `ctx.tools.register()` | the `git` tool: `clone`, `init`, `status`, `save`, `publish`, `sync`, `pr`, `merge`, `finish`, `prune` |
| `ctx.commands.register()` | `/git`, printing the same state to a human |
| `ctx.on('tools/pre-execute')` | a guard that redirects the everyday flow in `bash` (and `pwsh`) at the tool that does it consistently, and refuses the commands that discard work |
| `ctx.on('agent/turn-stopping')`, `ctx.on('session/event')`, `ctx.on('tools/pre-execute')` | the automatic sync: at a turn boundary, or a few seconds after a turn's edits stop when no boundary arrives, commit the paths this session recorded and push what is safe to push |

The last two are deliberately not opt-in behaviours an agent has to remember.
An operation that must be remembered is the original bug.

## The git tool

One tool, ten actions. The model sees the full description of each; this is the shape
of them.

- **`clone`** — clone a repository from a URL. `path` is where it lands, `branch`
  checks out a branch at clone time. Returns the state of the clone.
- **`init`** — create a new empty repository. `path` is where it lands, `branch`
  names the initial branch.
- **`status`** — the state of a repository, or of every repository under a directory:
  branch, ahead/behind, changed paths, worktrees, any open pull request. Reads only.
- **`save`** — commit the work this session did here. With no `paths`, it commits
  exactly the files this session changed in this repository and reports the rest, so
  nothing of another session's is swept in. `paths` names files explicitly, `message`
  overrides the generated subject.
- **`publish`** — push the current branch, setting the upstream on the first push and
  refusing a protected branch unless `allowProtected` is true. `forceWithLease: true`
  replaces this branch's own remote ref after a rebase — git refuses it if the remote
  moved since the last fetch.
- **`sync`** — fetch and bring the base in. With nothing else it fast-forwards when
  this branch has no commits of its own, and reports the divergence when it has.
  `rebase: true` replays this branch onto the base; `merge: true` merges the base in.
  A conflict aborts whichever ran, changes nothing, and names the paths.
- **`pr`** — open a pull request, or return the one already open for this branch. Never
  opens a second one.
- **`merge`** — merge the pull request by number, or the one open for the current branch,
  then delete the remote branch it came from when that ref still points at the merged commit.
- **`finish`** — the closing move for a unit of work: save anything dirty, publish, open or
  reuse the pull request, and report.
- **`prune`** — dry-run then remove what this tool left behind: task branches that no
  worktree holds and that carry no commit of their own, plus branches a merged pull request
  proves disposable. `apply: true` removes; a branch holding work is reported, never deleted.

`/git` prints the same state to a human.

## The guard

Raw git in the shell is inspected before it runs, for the agent's tool calls only —
it is a `tools/pre-execute` listener on `bash` and `pwsh`, so your own terminal is
never touched by it. Three outcomes, and the middle one is the one this bundle exists
for:

- **The everyday flow is redirected.** `git add`, `commit`, `push`, `pull`,
  `fetch` and `rebase` are refused, each naming the action that does the same job:
  `save`, `publish`, `sync` (and `sync` with `rebase: true` for a replay). That is
  what makes the same work happen the same way every turn.
- **Work-loss is refused.** `reset --hard`/`--merge`/`--keep`, `clean`, a force
  push, `branch -D`, `checkout -- <paths>`, `restore`, `stash drop`, and the history
  rewrites. Each says what is lost.
- **Everything else runs.** `config`, `remote`, `tag`, `stash`, `branch`,
  `checkout`, `merge`, `clone`, `worktree`, reads and the rest. Setup and
  maintenance are not the daily flow, and a guard that denies them is a wall — the
  one that hurt most was `git config credential.helper`, the repair path for a machine
  that cannot push. A dry run (`fetch --dry-run`, `push --dry-run`, `clean -n`) sends
  nothing and runs.

Detection is best-effort and not a security boundary; it reads the command line's
tokens and does not expand variables or run anything. `guardMode: warn` allows
everything, destructive commands included. The full policy, the refusal list and the
wrapper case are in [`docs/guard.md`](docs/guard.md).

## The automatic half

The outcome this bundle is named for is delivered here, and it does not depend on
which commands a session used to write the files.

When a turn boundary arrives — `agent/turn-stopping`, or a `session/event` carrying
`turn/end` — the sync runs. When neither does, every tool call arms a settle timer:
four seconds of quiet and the sync runs on its own, and a session in an unbroken
burst of tool calls is still synced at least once a minute.

In each repository this session recorded work in, it commits **only the paths this
session recorded, intersected with what is actually dirty**. Anything else dirty is
left where it is and named in the report instead of being swept into this session's
commit. The commit subject says what the commit contains —
`dsh: turn 3 — a.mjs, b.mjs`, or `dsh: a.mjs` when there was no turn number — and
the body carries `Assisted-by: DSH`.

The commit is pushed when the branch is safe to push: one under `branchPrefix`, or
the branch in use when nothing is protected. A protected branch is never pushed
automatically, and a branch whose work is already in the base is not pushed either.
A skip, a refused push or a failure is written into the model's context and wakes it,
so a sync that declined to commit is never silent.

Detail, including the exact notices: [`docs/turn-sync.md`](docs/turn-sync.md).

## Documentation

This file is the overview. The detail lives beside it:

| File | What is in it |
|---|---|
| [`docs/turn-sync.md`](docs/turn-sync.md) | the automatic half: what is committed and pushed, when it declines, and how to watch it |
| [`docs/guard.md`](docs/guard.md) | what raw git in `bash` is refused or allowed, and what git hooks mean for automatic commits |
| [`docs/install.md`](docs/install.md) | a fresh machine: three packages, the order they install in, and `link:` versus GitHub installs |

## Settings

Every setting has a working default; these are the ones worth knowing.

| Field | Default | Meaning |
|---|---|---|
| `stateRoot` | `~/.dsh/state` | Where session state is recorded: the repositories this session touched, and the push backoff |
| `branchPrefix` | `dsh/` | Task branch namespace; these are what automatic push may push, and what `prune` may remove |
| `baseBranch` | *(empty)* | Empty resolves `origin/HEAD`, then `main` |
| `protectedBranches` | `[]` | The plugin's own list of branch names, matched literally against the checked-out branch. Never pushed automatically. An explicit `[]` lets a `publish` to `main` through without `allowProtected` |
| `guardMode` | `redirect` | `off` \| `warn` \| `redirect`. `redirect` is the policy above; `warn` classifies and then allows everything, destructive commands included, and reports nothing |
| `guardAsk` | `ask` | The one command the guard cannot classify — a wrapper whose inner text peeked a work-loss command. `ask` and `deny` both refuse it; `allow` accepts it |
| `guardTools` | `[bash, pwsh]` | Which tools the guard inspects |
| `plainMode` | `false` | Shorthand for the tool without the automation: turns `turnCommit` and `turnPush` off and protects nothing. A named key beside it wins |
| `turnCommit` | `true` | Commit each turn's recorded paths |
| `turnCommitMessage` | *(empty)* | Empty generates `dsh: turn <N> — <paths>`, or `dsh: <paths>` with no turn number. `{turn}` and `{paths}` are substituted |
| `turnPush` | `true` | Push each turn when the branch is safe |
| `turnSyncScope` | `session` | `session` touches only repositories this session recorded work in; `workspace` also scans for any dirty repository |
| `turnCommitMaxFiles` | `200` | Skip above this many changed paths and report the repository instead |
| `turnSyncTimeoutMs` | `20000` | Budget for one end-of-turn sync |
| `githubHost` | `github.com` | Set for GitHub Enterprise |
| `prDraft` | `false` | Open pull requests as drafts by default |
| `timeoutMs` | `30000` | Per-git-command deadline |

The worktree settings — `worktreeRoot`, `autoWorktree`, `worktrees` — belong to the
`dsh-git-worktrees` bundle and are not fields of this one.

### Changing a setting

Override this bundle's row in the profile's patch layer,
`~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: dsh-git
  name: 'dsh-git'
  config:
    protectedBranches: [main, release]
```

Only the fields you name are applied; every other field keeps its default. The row id
is `dsh-git`. Restart the Harness to load it — a plugin's row config is read when the
plugin mounts.

A row that carries a setting the schema no longer declares can fail at mount. The two
that used to live here are `worktreeRoot` and `worktrees`; they belong to
`dsh-git-worktrees` now, so remove them from this bundle's row rather than leaving
them behind. [`docs/install.md`](docs/install.md#a-setting-the-schema-no-longer-declares)
has the exact symptom and fix.

There is no Configure page: the one that existed wrote a single toggle into this
hand-maintained file, with values nobody asked for, and its effect arrived at the next
start anyway. The patch layer above is how a setting is changed.

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
by name only, which can delete an unrelated checkout's unpushed commits.

## Requirements

git on `PATH`. `gh` is optional and only used as a token source; without it, set
`GH_TOKEN`. Node 18+ for global `fetch`. The one package dependency is
`dsh-git-core`, resolved at runtime through `lib/core-loader.mjs`;
`@deepseek-ai/schemastery` is declared but loaded through `createRequire` probes, so
a profile that cannot resolve it still mounts with every setting at its default.

On the Harness side it declares `tools`, `commands` and `sessions` in `inject`, so
a Harness without those leaves the row pending rather than half-mounting it. It
reaches for `agents` and `workspaceChanges` defensively — a build without them
still works, with a less precise idea of which files a turn changed — and registers on
`tools/pre-execute`, `agent/turn-stopping` and `session/event`.
