# dsh-git

One consistent way for DSH to use git and GitHub, and the automation that makes
"nothing was left uncommitted" true without a model remembering it.

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
| `ctx.tools.register()` | the `git` tool: `status`, `start`, `commit`, `push`, `sync`, `pr`, `merge`, `finish` |
| `ctx.commands.register()` | `/git`, printing the same state to a human |
| `ctx.on('tools/pre-execute')` | a guard that redirects raw mutating git in `bash` at the tool that does it cleanly, and refuses the commands that discard work |
| `ctx.on('agent/turn-stopping')` | the automatic sync: at the end of every turn that changed files, commit them and push what is safe to push |

## The two automatic behaviours

**Turn commit.** At the end of every turn that changed a file, each touched
repository is committed. *Which* repositories were touched is decided in three
steps, and the order matters:

1. the shipped `@deepseek-ai/dsh-workspace-changes` recorder's file list for that
   turn, reconciled to repositories;
2. this session's own touched-path record, which the tools layer writes on every
   mutating file operation;
3. a scan for dirty repositories — **only** when `turnSyncScope: 'workspace'`.

A worktree this session owns is always in scope.

The default is `turnSyncScope: 'session'`, and that choice is about more than
tidiness. Step 3 cannot tell whose work is whose. Once several sessions share a
checkout — which is what an Agent Team is — "every dirty repository under the
working directory" means the coordinator's turn end commits a teammate's
half-finished edits under the coordinator's turn number. Nothing is lost, but the
attribution is wrong and the commits are not the ones anybody asked for.

So a repository this session never touched is left alone. It is not silently
ignored: the turn result names what was in scope, and `status` keeps reporting
the rest. Set `turnSyncScope: 'workspace'` for a single session working alone and
you get the old, wider behaviour back.

Within a repository the session has established as its own, everything dirty is
committed. Narrowing that to the files the turn edited would leave one file the
turn touched and one it did not, both uncommitted, with no later turn likely to
notice either.

**Turn push.** The commit is then pushed, but only when the branch is one that is
safe to push: a task branch under `branchPrefix`, or the branch of a worktree
this session owns. `main` and `master` are never pushed automatically. A commit
made in a throwaway worktree that is never pushed is work that gets deleted with
the worktree, so for those branches pushing is not a convenience.

What is never done: pushing a protected branch, committing during a merge,
rebase or cherry-pick, or committing more paths than `turnCommitMaxFiles`.

## Worktrees

One task, one worktree, at `~/.dsh/worktrees/<repo>/<slug>` on branch
`dsh/<slug>` cut from `origin/<base>`. Outside every repository on purpose:
nothing to add to `.gitignore`, and no second copy of the tree for editors and
watchers to index and for test globs to match twice.

- The worktree is locked while a session owns it.
- A branch checked out more than once is refused, never forced.
- Removal never uses `--force` on its own and never `rm -rf`. A dirty worktree
  is refused with the uncommitted paths named, and the lock goes back on.
- A worktree this plugin did not create is never touched.
- `finish --cleanup` closes the worktree only after committing what was in it.

## Authentication

Nothing is stored here. `git` runs with `HOME` and `PATH` preserved, so the
machine's own credential helper resolves credentials — on this machine that is
`osxkeychain` from the system gitconfig. GitHub API calls use
`GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token --hostname <host>`, read lazily,
never logged, never written to disk, and redacted from every error.

GitHub is talked to over REST rather than through `gh`, because structured
status codes beat matching error prose — and because
[`gh pr merge --delete-branch`](https://github.com/cli/cli/issues/14537) does
local branch cleanup in the *current* directory's repository, matching the branch
by name only, which can delete an unrelated worktree's unpushed commits.

## The guard

Raw `git` in `bash` is classified three ways. Detection is **best-effort, not a
security boundary** — an obfuscated command can still get through, and that is
documented in `lib/guard.mjs` rather than papered over.

| Class | Decision |
|---|---|
| read-only (`status`, `diff`, `log`, `branch -l`, `tag -l`, `remote -v`, `clean -n`, `worktree list`, `fetch`) | allow |
| mutating (`commit`, `add`, `push`, `pull`, `merge`, `checkout`, `stash`, `branch <name>`, …) | ask, with a reason naming the action to use instead |
| destructive (`reset`, `clean` without `-n`, `push --force`, `branch -D`, `filter-branch`, `worktree remove --force`, `reflog expire`, …) | deny |

`deny` outranks `ask` anywhere in one command line. `guardMode: off` disables it,
`warn` classifies without blocking.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | Where per-task worktrees live |
| `stateRoot` | `~/.dsh/state` | Where session ownership and push backoff are recorded |
| `branchPrefix` | `dsh/` | Task branch namespace; these are what automatic push may push |
| `baseBranch` | *(empty)* | Empty resolves `origin/HEAD`, then `main` |
| `protectedBranches` | `[main, master]` | Never pushed automatically |
| `guardMode` | `redirect` | `off` \| `warn` \| `redirect` |
| `guardTools` | `[bash]` | Which tools the guard inspects |
| `autoWorktree` | `protected` | `off` \| `protected` \| `always` |
| `turnCommit` | `true` | Commit each turn's changes |
| `turnCommitMessage` | *(empty)* | Empty generates `dsh: turn <N> — <paths>`; `{turn}` and `{paths}` are substituted |
| `turnPush` | `true` | Push each turn when the branch is safe |
| `turnSyncScope` | `session` | `session` commits only repositories this session changed; `workspace` also scans for any dirty repository |
| `turnCommitMaxFiles` | `200` | Skip above this many changed paths |
| `turnSyncTimeoutMs` | `20000` | Budget for one end-of-turn sync |
| `githubHost` | `github.com` | Set for GitHub Enterprise |
| `prDraft` | `false` | Open pull requests as drafts by default |
| `timeoutMs` | `30000` | Per-git-command deadline |

## Verify it

```bash
node scripts/check.mjs      # every tool result is lossless JSON and matches its output schema
node scripts/guard-test.mjs # the guard's classification table, 187 assertions
node scripts/e2e.mjs        # the whole cycle against a throwaway repo + local bare origin
```

`e2e.mjs` needs no network and no credentials: it clones a local bare repository,
so pushes, upstream tracking and ahead/behind are exercised through real git and
a real transport.

## Requirements

git on `PATH`. `gh` is optional and only used as a token source; without it, set
`GH_TOKEN`. Node 18+ for global `fetch`. No npm dependencies — `lib/*.mjs` import
only `node:` builtins, and `@deepseek-ai/schemastery` is loaded defensively so a
`link:` install cannot take the plugin down at activation.

## How to see the automatic commit work

Make any edit in a repository and end the turn. `git log` shows a commit whose
subject starts `dsh: turn <N>` and whose body carries `Assisted-by: DSH`. On a
protected branch the commit lands and the push is refused with a reason; on a
`dsh/` worktree branch both happen. `git status` inside the plugin's own
repository is the fastest check, and `/git` prints the same state in the composer.

The automatic commit is deliberately not narrowed to the files a turn edited.
Narrowing it would leave one file the turn touched and one it did not, both
uncommitted, with no later turn likely to notice — and "nothing left
uncommitted" is the promise this bundle exists to keep. The commit subject names
the turn, so the result stays attributable.

## Running several sessions at once

Agent Teams puts several sessions in one filesystem, and this plugin is designed
for that rather than around it.

**Give each teammate its own worktree.** Because the session registry is keyed by
session id, each teammate gets its own automatically:

1. the coordinator calls `git start` with a per-teammate slug;
2. the task description carries the worktree's absolute path as the write scope;
3. each teammate works, commits and pushes its own `dsh/<slug>` branch;
4. integration becomes a real pull-request merge.

Isolation is what makes this safe: a teammate's tree is invisible to everyone
else's turn sync, so there is nothing for another session to sweep up. That is
more deterministic than the shared-filesystem model Agent Teams otherwise
assumes, not less.

Nothing breaks if you skip that step either, because of `turnSyncScope: 'session'`
— a teammate's uncommitted work in the shared checkout is simply not committed by
anyone else, and `status` reports it until its owner commits it.

**The guard asks before mutating git in `bash`.** A team hits that often. Set
`guardMode: 'warn'` while running a team to drop the prompts and keep the
destructive denials.

## Path identity, the bug class this code keeps hitting

`git` realpaths everything it reports. On macOS `/tmp` is `/private/tmp` and
`/var/folders/...` is `/private/var/folders/...`, so the same directory has two
spellings and a string comparison between them is always false. Four separate
bugs here were that one class, and every one of them failed *silently* — a
repository that looked untouched, a worktree that looked unowned, a commit that
looked unnecessary.

The rule this settled on: realpath at every boundary, and key session state on
the **main repository root** (`git worktree list` reports it first), never on the
directory a caller happens to be standing in — inside a worktree those differ,
and the registry lookup then finds nothing.

