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

## Forcing a worktree

Everything above *asks*. `autoWorktree` is the only setting that **refuses**, and
it exists because the moment that decides where work lands is a file edit — a
model that reads "work in a worktree" and then edits `main` has followed the
instruction as far as it understood it.

| Mode | An edit is refused when |
|---|---|
| `off` *(default)* | never — the tool description and the git guard are the whole story |
| `protected` | the target repository is on a protected branch and the edit is not already inside this session's worktree |
| `always` | the target repository has no worktree for this session, on any branch |

Turn it on when you want isolation to be structural rather than advisory. Leave it
off while you are still forming the habit — a rule that fires before you expect it
is a rule you route around.

**What it does not do:** create the worktree for you. It refuses and names
`action "start"`. A guard that created one as a side effect would leave a worktree
behind for every abandoned edit and teach the caller nothing about why the write
stopped.

**What it never touches:** an edit already inside your worktree, a non-protected
branch under `protected`, a path outside any repository, and a shell command —
reading a shell command well enough to know whether it writes a file is the same
unbounded problem the git guard already documents as best-effort.

## Worktrees

One task, one worktree, at `~/.dsh/worktrees/<repo>/<slug>` on branch
`dsh/<slug>` cut from `origin/<base>`. Outside every repository on purpose:
nothing to add to `.gitignore`, and no second copy of the tree for editors and
watchers to index and for test globs to match twice.

The root is the `worktreeRoot` setting. If your harness restricts file writes to the
session workspace, set it to a path **inside** that workspace — otherwise the guard
refuses an edit and points at a directory the agent cannot write to. See
[Changing a setting](#changing-a-setting).

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
| `guardTools` | `[bash, pwsh]` | Which tools the guard inspects — both shell tools the Harness ships. A tool not listed is not inspected |
| `autoWorktree` | `off` | `off` never refuses an edit. `protected` refuses an edit to a repository on a protected branch. `always` refuses an edit to any repository this session has no worktree for |
| `turnCommit` | `true` | Commit each turn's changes |
| `turnCommitMessage` | *(empty)* | Empty generates `dsh: turn <N> — <paths>`; `{turn}` and `{paths}` are substituted |
| `turnPush` | `true` | Push each turn when the branch is safe |
| `turnSyncScope` | `session` | `session` commits only repositories this session changed; `workspace` also scans for any dirty repository |
| `turnCommitMaxFiles` | `200` | Skip above this many changed paths |
| `turnSyncTimeoutMs` | `20000` | Budget for one end-of-turn sync. A sync that runs out of time is reported, not silent |
| `githubHost` | `github.com` | Set for GitHub Enterprise |
| `prDraft` | `false` | Open pull requests as drafts by default |
| `timeoutMs` | `30000` | Per-git-command deadline |

### Changing a setting

There is **no Configure page**. One needed a client half registering into the boot
graph, and a client half there could take the front end down — that work was built
and then removed, deliberately. A setting is changed by overriding this bundle's
row in the profile's own patch layer, `~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: dsh-git
  name: 'dsh-git'
  config:
    autoWorktree: protected
```

**Only the fields you name are applied.** Every other field keeps its default, so
the block above is a complete configuration. The row id is `dsh-git` — the same id
the bundle's own patch inserts. Restart the Harness to load it: a plugin's row
config is read when the plugin mounts, so an edit here is inert until then.

The two settings most worth changing:

- **`autoWorktree: protected`** if you would rather work never landed on `main` at
  all. From then on an edit to a repository on a protected branch is refused, and
  the refusal points at the `git` tool's `action: "start"`.
- **`worktreeRoot`** if your deployment's file sandbox only writes inside the
  session workspace — the Harness ships one that does. Worktrees default to
  `~/.dsh/worktrees`, which is *outside* that workspace, and the result is a guard
  that refuses your edit and points at a directory the agent cannot write to. Point
  `worktreeRoot` at a directory inside the workspace instead.

## Install it on another machine

The bundle is built to install anywhere, and the portability contract is asserted
rather than described — `scripts/portability-check.mjs`, run in CI:

- **It follows the deployment's home.** `$DSH_HOME` decides, then
  `$DSH_PROFILE_DIR`'s parent, then `~/.dsh` — the same resolution the shipped
  `@deepseek-ai/dsh-home-paths` uses. A machine that moves its Harness home does
  not get git state written to the old one.
- **No machine path is baked in.** No absolute imports, no `file://` imports, no
  authoring-machine home, no `app.asar` reference.
- **Every file it imports ships.** `package.json`'s `files` allowlist is checked
  against the actual import graph, so a published install cannot be missing a
  module the working tree happened to have.
- **It loads with nothing installed.** The one declared dependency is
  `@deepseek-ai/schemastery`, and it is loaded through `createRequire` probes
  rather than a static import, so the plugin mounts and works without it.

Install on another Harness the way this profile already installs another bundle:

```bash
# The profile directory is the install target, not a global prefix:
mkdir -p ~/.dsh/profiles/<name> && cd ~/.dsh/profiles/<name>
pnpm add github:stansz/dsh-git
```

**Pin it if you want reproducibility.** An unpinned `github:` spec follows the
default branch, so a fresh install on another machine gets whatever is newest at
that moment. To freeze a known-good state, name the ref:

```bash
pnpm add github:stansz/dsh-git#v0.1.0
```

Then make the profile load the bundle — one line in its own `package.json`:

```json
"dsh": { "profile": { "bundles": ["…", "dsh-git"] } }
```

`plugin_manager` with `install_bundle` does the dependency and the bundle-list
entry together and is what to prefer when it is available. The row inside the
package needs no editing: it names `dsh-git`, which resolves from the profile's
`node_modules` once the dependency is installed.

Finally, set that machine's guard mode and worktree root by overriding this
bundle's row in the profile's own patch layer — the same place every other row is
configured. There is no Configure page in this version, and no client half: that
work was built and then removed, because a client half in the boot graph could
take the front end down. Until the row is overridden, every setting keeps its
default.

Nothing here is machine-specific: `git` and the optional `gh` are the only
external tools, authentication comes from that machine's own credential helper,
and every path resolves against that deployment's own `$DSH_HOME`.

### `link:` or GitHub?

They fail in opposite directions, and the failure has the same symptom — "my edit
did nothing" — which is why this is worth deciding once rather than
rediscovering on each machine:

| Install | Reads the code from | A source edit takes effect | Fails when |
|---|---|---|---|
| `link:<path>` | your working tree | on plugin reload or Harness restart | the path is gone — a fresh machine cannot reproduce it, and an absolute path makes the profile non-portable |
| `github:…` | the profile's `node_modules`, a frozen copy | **never** — not on reload, not on restart | you edit the checkout and forget the profile is reading a copy from somewhere else |

**Use `link:` for development.** It is the only install where editing the source
does anything at all. A `github:` install writes a copy into the profile's
`node_modules`, and no amount of restarting makes that copy follow your editor —
it keeps whatever the last install resolved.

**Use `github:` for every other machine.** There is nothing to edit there, and a
pinned ref (`#v0.1.0`) is the only version of "this is what I tested" that a second
machine can reproduce.

The trap is a profile that mixes them, because it looks uniform and is not: one
`link:` bundle updates when you edit it and the next quietly does not. If you
edit a bundle and a restart shows no change, check how that bundle is installed
before looking for a bug in the code.

Neither install reloads a changed module by itself — the running Host keeps the
module it loaded. Restarting the Harness is the reliable way to see an edit; the
expensive mistake is to edit, see no change, and go hunting for a defect that is
not there.

The entire `dsh.*` custom-work set in this workspace uses absolute `link:` paths,
recorded as Known trap #1 in `docs/WHAT-WE-BUILT.md` — a fresh machine must use
Git installs instead. That trap is about *deployment*. It is not an argument
against `link:` while you are the one doing the developing.

**Requirements:** see [Requirements](#requirements) below — git on `PATH`, Node 18+
for global `fetch`, and `gh` only as an optional token source.

## Verify it

```bash
node scripts/guard-test.mjs        # the guard's classification table — 187 assertions
node scripts/portability-check.mjs # the portability contract, 55 assertions
node scripts/worktree-guard-test.mjs # worktree enforcement, both directions — 36 assertions
node scripts/notice-test.mjs      # the sync notice: a unique id, a source, and no false alarm on a clean repo
node scripts/workflow-check.mjs   # this repo's CI file is valid and every step does something
node scripts/check.mjs            # every tool result is lossless JSON and matches its schema
node scripts/e2e.mjs              # the whole cycle against a throwaway repo + local bare origin
```

All seven run in CI on every push and pull request — see
[verify.yml](.github/workflows/verify.yml) — across **ubuntu and macOS** on Node
20 and 22, and all four jobs are green.

The matrix is the point. The verification behind this bundle was done on one
machine: macOS, git 2.54, `/private` symlinks. And the bug class this code keeps
hitting is path identity, which is *exactly* what differs between platforms —
ubuntu has no `/private` prefix, so the same realpath logic takes a different
branch there. CI runs on git 2.55.0 against a local 2.54, which also covers the
`--porcelain=v2` and `worktree list --porcelain` output this code parses.

CI found two real defects on its first run, both of them *in the verification
rather than the plugin*:

1. One harness line used the run's global failure count for its PASS/FAIL label,
   so a single failure printed every later line as FAIL and buried the cause.
2. The `Config` check asserted that `@deepseek-ai/schemastery` must resolve — but
   CI has no `node_modules`, and the plugin loads without it *by design*, because
   a `link:` install does not hoist a bundle's dependencies. All four jobs went
   red describing correct behaviour as a defect.

Both states are now asserted: absent is a pass with the tool still registered,
present is a pass with the schema resolved, and one job installs the dependency
so the resolved-schema path is exercised too.

None of the suites need the network or a credential: `e2e.mjs` clones a local
bare repository, so pushes, upstream tracking and ahead/behind are exercised
through real git and a real transport without a token in sight.

## When the automatic sync cannot finish

The turn sync is built so that declining to commit is never quiet. A skip, a
refused push, a timeout and an unexpected failure all produce a message the
**model** reads — not only a Host log line:

```
dsh-git could not finish syncing your working tree:
  - dsh-git: skipped the automatic commit: 340 changed paths, above the limit of 200
Run the git tool with action "status" to see the current state, and action
"commit" or action "push" to finish the work by hand.
```

Reaching the model takes two steps, and both are deliberate: `agent.inject()`
puts the text in its context, but does **not** wake it, so `agent.followup()` then
starts the turn that reads it. Injection alone would leave the note waiting in
the inbox until the user happened to say something, which is indistinguishable
from never sending it.

A *successful* sync announces nothing. Saying "committed and pushed" every turn
is noise, and noise is how a real message gets skipped.

## Git hooks

The plugin commits through ordinary `git commit` and does **not** pass
`--no-verify`, so every hook that repository has installed runs on automatic
commits too — `pre-commit`, `commit-msg`, `post-commit`, and a global
`core.hooksPath`, if one is set.

That matters most for `post-commit`, because it runs *after* the commit exists
and can do anything. This workspace used to have five of them — one per bundle —
each exactly this:

```
<repo>/.git/hooks/post-commit:
    #!/bin/sh
    git push origin HEAD
```

A hook like that pushes on every commit, **including automatic turn commits**, and
it bypasses everything in this plugin's push path. They were removed on
2026-10-05, superseded by the turn sync, which decides *whether* a branch may be
pushed instead of pushing whatever `HEAD` happens to be. Backed up under
`.dsh-hooks-removed/` in this workspace.

A global `core.hooksPath` pointing at such a hook would put it back in every
repository at once.

The specific hazard: `action "push"` refuses a protected branch, but a
`post-commit` hook that pushes `HEAD` does not know what branch it is on. A hook
like the one above, installed globally, pushes `main` on every automatic commit —
exactly the outcome the protected-branch rule exists to prevent. If you install a
global `core.hooksPath`, check what its `post-commit` does first.

Hooks are also deliberately allowed to fail the commit. When one does, the sync
reports it like any other skip rather than working around it: a hook that rejects
a commit is a policy, and stepping over it silently would be worse.

## Cleaning up

`prune` is the one action that deletes, and it is narrow on purpose. Everything
else here refuses to remove things because a branch or worktree may be in use —
which is right, but it left the plugin unable to tidy up after *itself*.

```
git prune              # dry run: what is left behind
git prune apply: true  # remove it
```

It removes a worktree registration whose directory is gone, and a branch under
`branchPrefix` that **no worktree has checked out and that holds no commit the
base branch does not already have**. A branch with work of its own is reported
and kept. That is the whole safety argument, and it is worth stating plainly:
deleting a branch is what the guard denies `git branch -D` for, so this door
opens only onto the plugin's own leftovers.

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

