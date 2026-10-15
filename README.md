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

DSH had no git tool. Every session reached git through `bash`, invented its own
incantation, and stopped wherever it happened to stop. The residue was dirty
working trees and unpushed commits that nothing reported, because nothing was
looking.

Supplying better commands does not fix that — a command nobody runs is the
original bug. So this bundle contributes four things, and the last two are the
ones that change the outcome:

| Contribution | What it is |
|---|---|
| `ctx.tools.register()` | the `git` tool: `status`, `start`, `commit`, `push`, `sync`, `pr`, `merge`, `finish`, `prune` |
| `ctx.commands.register()` | `/git`, printing the same state to a human |
| `ctx.on('tools/pre-execute')` | a guard that redirects raw mutating git in `bash` at the tool that does it cleanly, and refuses the commands that discard work |
| `ctx.on('agent/turn-stopping')`, `ctx.on('session/event')`, `ctx.on('tools/pre-execute')` | the automatic sync: at a turn boundary, or a few seconds after a turn's edits stop when no boundary arrives, commit the touched repositories and push what is safe to push |

## The git tool

One tool, nine actions. The model sees the full description of each; this is the shape of
them.

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
| [`docs/guard.md`](docs/guard.md) | what raw git in `bash` is refused or asked about, and why there are no hooks |
| [`docs/worktrees.md`](docs/worktrees.md) | the task lifecycle, ownership and path identity, and the one action that removes things |
| [`docs/install.md`](docs/install.md) | a fresh machine, and `link:` versus GitHub installs |
| [`docs/testing.md`](docs/testing.md) | running the suite, its fixtures, and what CI does with it |

## Settings

| Field | Default | Meaning |
|---|---|---|
| `worktreeRoot` | *(derived)* | Where per-task worktrees live: `<session workspace>/.worktrees` when unset. Set an absolute path to put them elsewhere |
| `stateRoot` | `~/.dsh/state` | Where session ownership and push backoff are recorded |
| `branchPrefix` | `dsh/` | Task branch namespace; these are what automatic push may push |
| `baseBranch` | *(empty)* | Empty resolves `origin/HEAD`, then `main` |
| `protectedBranches` | `[main, master]` | The plugin's **own** list of branch names, matched literally against the checked-out branch — **not** GitHub's branch protection, which is never consulted. One list, two rules: never pushed automatically, and `autoWorktree` refuses an edit landing on one. A trunk named `trunk`/`develop` is not protected until it is listed here |
| `guardMode` | `redirect` | `off` \| `warn` \| `redirect` |
| `guardAsk` | `ask` | What to do with a command the guard cannot classify: `ask` \| `deny` \| `allow`. Set `deny` where nobody is at the approval prompt, so a turn fails fast with a reason instead of stalling |
| `guardTools` | `[bash, pwsh]` | Which tools the guard inspects — both shell tools the Harness ships. A tool not listed is not inspected |
| `autoWorktree` | `protected` | `protected` refuses an edit landing in a repository whose checked-out branch is in `protectedBranches`, and points at `action: "start"`. `off` never refuses. `always` refuses an edit to any repository this session has no worktree for — that is the worktrees-for-everything mode, and it is not this one. A branch with no commits yet is never protected, so a new project can write its first file |
| `turnCommit` | `true` | Commit each turn's changes |
| `turnCommitMessage` | *(empty)* | Empty generates `dsh: turn <N> — <paths>` when a turn boundary reported a number, and `dsh: <paths>` otherwise — which is always, for the boundary driven from the tools layer; `{turn}` and `{paths}` are substituted, and `{turn}` is empty when there is no number |
| `turnPush` | `true` | Push each turn when the branch is safe |
| `turnSyncScope` | `session` | `session` commits only repositories this session changed; `workspace` also scans for any dirty repository |
| `turnCommitMaxFiles` | `200` | Skip above this many changed paths |
| `turnSyncTimeoutMs` | `20000` | Budget for one end-of-turn sync. A sync that runs out of time is reported, not silent |
| `githubHost` | `github.com` | Set for GitHub Enterprise |
| `prDraft` | `false` | Open pull requests as drafts by default |
| `timeoutMs` | `30000` | Per-git-command deadline |

### Changing a setting

Two ways, and they compose. **Plugins → `dsh-git` → Configure** is the page: this
bundle ships a browser half (`lib/client.js`) that registers into the Plugins page's
`plugins.row.config` slot, and every field of the row's schema appears there with the
description the schema carries. A change made there is picked up on the next tool call
or turn boundary rather than at the next restart, because every field is `volatile()`.

The other way is this bundle's row in the profile's own patch layer,
`~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: dsh-git
  name: 'dsh-git'
  config:
    autoWorktree: protected
```

**Only the fields you name are applied.** Every other field keeps its default, so
the block above is a complete configuration. The row id is `dsh-git` — the same id
the bundle's own patch inserts. Restart the Harness to load it: a plugin's row
config is read when the plugin mounts, so an edit here is inert until then — unlike a
change made on the Configure page.

A page took two attempts, and the reasons are worth keeping. The first was removed
because a client half in the boot graph could take the front end down, and because the
row's settings namespace is served only for fields marked `volatile()`: a field without
it is a control that is silently *absent*, with nothing reporting why. This time the
`volatile()` is applied to every field in one place, so a field cannot be added without
it; the page renders an explanation instead of throwing when the Host serves it no
namespace; and [`test/client-half.test.mjs`](test/client-half.test.mjs) runs the real
bundle under node — registration, slot key, the write op it sends, and both states it
cannot fix — so the browser half is covered by CI rather than by opening a browser.

The two settings most worth changing, and the one most worth knowing how to turn off:

- **`worktreeRoot`** to put worktrees somewhere other than the default. Empty —
  the default, and what almost every deployment wants — derives the root from the
  session's own workspace (`<session workspace>/.worktrees`), which is inside the
  region a file sandbox permits writes to and outside every repository. Set an
  **absolute** path to move them; a relative one resolves against the Harness home.
  Wherever you point it, keep it outside every repository, or the worktree becomes
  a second copy of the tree inside the repository that created it.
- **`autoWorktree: off`** if you would rather nothing refused an edit. It defaults
  to `protected`: an edit landing in a repository checked out on a branch in
  `protectedBranches` is refused, and the refusal points at the `git` tool's
  `action: "start"`. Turn it off where working on `main` is the point and a second
  checkout is not wanted, or set `always` where isolation should hold for every
  branch — `always` is the worktrees-for-everything mode, `protected` is not.

### Running it as a plain git tool

Two settings, and the guard stays:

| Setting | Value | What it changes |
|---|---|---|
| `autoWorktree` | `off` | an edit into a repository on `main` is allowed, and no worktree is required |
| `turnCommit`, `turnPush` | `false` | nothing is committed or pushed unless a call asks for it |

What is left is an ordinary git interface — `status`, `commit`, `push`, `sync`, `pr`,
`merge` — with `guardMode` still at `redirect`, which is what keeps the tool the way
work gets done here: raw `git commit` in `bash` is refused and redirected at the tool,
so the plugin is still the path rather than an option. Turning `guardMode` off as well
is the one combination this bundle does not survive: bash becomes a valid way to work,
and everything it enforces becomes advice.

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

The suite builds real repositories — a bare origin and a clone — and drives the plugin's
own functions; nothing is mocked. It runs in CI on every push and pull request: ubuntu and
macOS, Node 22 and 24. What it covers, and why a new test must fail against the
pre-change library before it counts, is in [`docs/testing.md`](docs/testing.md).

