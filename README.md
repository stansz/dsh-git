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
| `ctx.tools.register()` | the `git` tool: `clone`, `init`, `status`, `save`, `publish`, `sync`, `pr`, `merge`, `finish`, `prune` |
| `ctx.commands.register()` | `/git`, printing the same state to a human |
| `ctx.on('tools/pre-execute')` | a guard that redirects raw mutating git in `bash` at the tool that does it cleanly, and refuses the commands that discard work |
| `ctx.on('agent/turn-stopping')`, `ctx.on('session/event')`, `ctx.on('tools/pre-execute')` | the automatic sync: at a turn boundary, or a few seconds after a turn's edits stop when no boundary arrives, commit the touched repositories and push what is safe to push |

## The git tool

One tool, ten actions. The model sees the full description of each; this is the shape
of them.

- **`clone`** — clone a repository from a URL. `path` is where it lands, `branch`
  checks out a branch at clone time. Returns the state of the clone.
- **`init`** — create a new empty repository. `path` is where it lands, `branch`
  names the initial branch.
- **`status`** — the state of a repository, or of every repository under a directory:
  branch, ahead/behind, changed paths, worktrees, any open pull request. Reads only.
- **`save`** — commit the work this session did here. With no `paths`, it commits the
  files this session changed in this repository and reports the rest; `paths` names them
  explicitly and `message` overrides the generated subject.
- **`publish`** — push the current branch, setting the upstream on the first push and
  refusing a protected branch unless `allowProtected` is true. `forceWithLease: true`
  replaces this branch's own remote ref after a rebase.
- **`sync`** — fetch and bring the base in: fast-forward when the branch has no commits
  of its own, report the divergence when it has. `rebase: true` replays this branch onto
  the base; `merge: true` merges the base in. A conflict aborts and names the paths.
- **`pr`** — open a pull request, or return the one already open for this branch. Never
  opens a second one.
- **`merge`** — merge the pull request by number, or the one open for the current branch,
  then delete the remote branch it came from when that ref still points at the merged commit.
- **`finish`** — the closing move for a unit of work: save anything dirty, publish, open or
  reuse the pull request, and report.
- **`prune`** — dry-run then remove what this tool left behind: task branches that no
  worktree holds and that carry no commit of their own. `apply: true` removes; a branch
  holding work is reported, never deleted.

`/git` prints the same state to a human.

## Documentation

This file is the overview. The detail lives beside it:

| File | What is in it |
|---|---|
| [`docs/turn-sync.md`](docs/turn-sync.md) | the automatic half: what is committed and pushed, when it declines, and how to watch it |
| [`docs/guard.md`](docs/guard.md) | what raw git in `bash` is refused or asked about, and why there are no hooks |
| [`docs/install.md`](docs/install.md) | a fresh machine, and `link:` versus GitHub installs |
| [`docs/testing.md`](docs/testing.md) | the tests: what the three that matter are, and why the old suite is gone |

## Settings

Every setting has a working default; these are the ones worth knowing.

| Field | Default | Meaning |
|---|---|---|
| `stateRoot` | `~/.dsh/state` | Where session state is recorded: the repositories this session touched, and the push backoff |
| `branchPrefix` | `dsh/` | Task branch namespace; these are what automatic push may push, and what `prune` may remove |
| `baseBranch` | *(empty)* | Empty resolves `origin/HEAD`, then `main` |
| `protectedBranches` | `[]` | The plugin's own list of branch names, matched literally against the checked-out branch. Never pushed automatically. An explicit `[]` lets a `publish` to `main` through without `allowProtected` |
| `guardMode` | `redirect` | `off` \| `warn` \| `redirect` |
| `guardAsk` | `ask` | What to do with a command the guard cannot classify: `ask` \| `deny` \| `allow` |
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

`plainMode: true` is the shorthand for the tool without the automation: it turns
`turnCommit` and `turnPush` off and protects nothing, leaving the guard as the only
behaviour. A named key beside it wins.

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

