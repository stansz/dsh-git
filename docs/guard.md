# The guard

What raw git in `bash` is refused or allowed, and what git hooks mean for the
automatic commit. Part of [dsh-git](../README.md) — the overview, the settings and
the requirements are there.

The guard has **two rules**, and the first is the one the plugin exists for:

1. **The everyday flow goes through the tool.** `git add`, `commit`, `push`, `pull`,
   `fetch` and `rebase` in `bash` are refused, each naming the action that does the
   same job — `save`, `publish`, `sync` (`sync` with `rebase: true` for a replay).
   That is what makes the same work happen the same way every turn, instead of a
   fresh incantation each time.
2. **Work is never discarded.** `reset --hard`, `clean`, a force push, `branch -D`,
   `checkout -- <paths>`, `stash drop` and the history rewrites are refused.

Everything else runs. Setup and maintenance — `config`, `remote`, `tag`, `stash`,
`branch`, `worktree`, `gc`, `submodule`, `lfs` — are deliberately **not** gated: they
are not the daily flow, and denying them is how a guard becomes a wall.
`git config credential.helper` is the repair path for a machine that cannot push,
and it has no tool action to point at.

The guard sees **the agent's tool calls only** — it is a `tools/pre-execute` listener
on `bash` (and `pwsh`), so your own terminal is never affected by it. It is not a
security boundary and never was (`gh`, `curl` and `node` reach the same API), so it
does not pretend to be one.

Detection is **best-effort, not a security boundary** — an obfuscated command can
still get through, and that is documented in `lib/guard.mjs` rather than papered
over. The guard grades **`git`** only.

| Command | Verdict |
|---|---|
| `git status`, `git log`, `git --version`, `git remote -v`, `git diff` | allow |
| `git add -A`, `git commit -m "x"`, `git push`, `git push -u origin task/x` | deny → `save`, `publish` |
| `git pull`, `git fetch --prune origin`, `git rebase origin/main` | deny → `sync` (`rebase: true` to replay) |
| `git config credential.helper …`, `git remote set-url …`, `git tag v1.0`, `git stash`, `git checkout -b x` | allow |
| `git reset --hard`, `git clean -fd`, `git push --force`, `git branch -D` | deny |
| `git checkout -- <paths>`, `git restore <paths>`, `git stash drop` | deny |
| `git filter-branch`, `git update-ref`, `git tag -f` | deny |

| Class | Decision |
|---|---|
| read-only | allow |
| the everyday flow (`add`, `commit`, `push`, `pull`, `fetch`, `rebase`) | deny, naming `save`, `publish` or `sync` |
| every other write (`config`, `remote`, `tag`, `stash`, `branch`, `checkout`, `merge`, `clone`, `worktree`, …) | allow |
| destructive (the list below) | deny |

## What is refused

Only a form that overwrites uncommitted work, deletes untracked work, or rewrites
history other clones are built on:

- `git reset --hard`, `git reset --merge`, `git reset --keep`. `--soft`,
  `--mixed` and a path-scoped reset leave the files alone and run.
- `git clean` without `-n`/`--dry-run`. `git clean -n` prints and runs.
- `git push --force`, `--force-with-lease`, `-f`, a `+refspec`, `--delete`,
  `--mirror`. A rejected push is not a dead end, but the recovery goes through the
  tool rather than around the guard: action `sync` brings the base in (with
  `rebase: true` when the branch has to be replayed), then action `publish`
  replaces this branch's own remote ref with `forceWithLease: true`.
- `git branch -D` (force delete). `git branch -d` runs, because git itself
  refuses to delete an unmerged branch.
- `git tag -f` (re-point an existing tag). Creating a tag and `git tag -d` run.
- `git checkout -- <paths>` and `git switch -- <paths>`; `git restore`, except
  `git restore --staged`, which only unstages.
- `git stash drop`, `git stash clear`; `git stash`, `pop`, `list` run.
- history rewrites: `git filter-branch`, `git filter-repo`, `git update-ref`,
  `git symbolic-ref` writes, `git replace` (other than `-l`), `git reflog expire`,
  `git reset-index`, `git checkout-index`.
- `git worktree remove --force`, `git submodule deinit --force`,
  `git gc --prune=now`. Plain `git prune` and plain `git gc` run — they are
  classified as ordinary writes, even though both delete unreachable objects.

Each refusal says what is lost, not just "no", and names the ordinary way through
where one exists.

## Overrides and dry runs

A read may still be *told to run something*: an environment prefix naming `GIT_PAGER`,
`PAGER`, `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_EDITOR` and their
siblings; a global `-c` or `--config-env` whose config **key** carries a program
(`core.pager`, `core.hooksPath`, `diff.external`, `alias.*`, `credential.helper`, …);
or `--exec-path`/`--upload-pack`. These are **allowed**, deliberately: `credential.helper`
and the pager live in exactly this syntax, so refusing the syntax refuses normal setup.
An override never downgrades a refusal — the same flag on a destructive command still
denies. The guard is honest about the consequence: a program git is told to run is not
something this module inspects.

A dry run sends nothing and runs — `git push --dry-run origin main`, `-n`,
`git clean -n`, `git gc --dry-run`. Git's last-flag-wins applies, so
`git push --dry-run --no-dry-run` really pushes and is denied.

## Wrappers

Git hidden inside `xargs`, `sh -c`, `zsh -c`, `eval`, `env`, `find -exec`, or a
git-adjacent program such as `gitk` cannot be classified. If the inner text **peeked**
a command that discards work, the whole line is refused — that is the one denial worth
keeping reachable through a wrapper. Otherwise it runs, because refusing a command whose
effect cannot be read blocks work nobody can explain.

`guardAsk` decides that single case: `deny` and `ask` both refuse it, `allow`
accepts even that.

## Modes

`guardMode: off` disables the guard entirely; `warn` runs the same classification
and then allows everything, destructive commands included. Nothing reports the
classification today, so `warn` is not a diagnostic you can read — treat it as the
guard switched off. `redirect` is the default and the policy above.

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
pushed instead of pushing whatever `HEAD` happens to be.

A global `core.hooksPath` pointing at such a hook would put it back in every
repository at once.

The specific hazard: `action "publish"` refuses a protected branch, but a
`post-commit` hook that pushes `HEAD` does not know what branch it is on. A hook
like the one above, installed globally, pushes `main` on every automatic commit —
exactly the outcome the protected-branch rule exists to prevent. If you install a
global `core.hooksPath`, check what its `post-commit` does first.

Hooks are also deliberately allowed to fail the commit. When one does, the sync
reports it like any other skip rather than working around it: a hook that rejects
a commit is a policy, and stepping over it silently would be worse.
