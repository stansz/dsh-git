# The guard

What raw git in `bash` is refused, redirected or asked about; the overrides that
would let a read run a program of the caller's choosing; and why this deployment
has no git hooks. Part of [dsh-git](../README.md) — the overview, the settings and
the requirements are there.

Raw `git` in `bash` is classified three ways. Detection is **best-effort, not a
security boundary** — an obfuscated command can still get through, and that is
documented in `lib/guard.mjs` rather than papered over.

| Class | Decision |
|---|---|
| read-only (`status`, `diff`, `log`, `rev-list`, `diff-tree`, `branch -l`, `tag -l`, `remote -v`, `clean -n`, `worktree list`, `fetch`) | allow. A plain `fetch` reads; `--prune`, `--all`, `--tags`, a force flag or a refspec with a destination *writes refs* and is gated like a mutation |
| mutating (`commit`, `add`, `push`, `pull`, `merge`, `checkout`, `stash`, `branch <name>`, …) | deny, with a reason naming the action to use instead |
| destructive (`reset`, `clean` without `-n`, `push --force`, `branch -D`, `filter-branch`, `worktree remove --force`, `reflog expire`, …) | deny |

The class is decided from a parsed command line, not from the text of its tokens. A
value belongs to its option whatever it looks like, `--` ends the options, and the
verb is the first operand: `git clean -fenodeModules -d` is a forced clean and not a
dry run, `git tag -m '--delete' v1` creates a tag whose *message* is `--delete`, and
`git push -o -f origin main` is a push to a protected branch rather than a force
push, because git consumed `-f` as the value of `-o`. The same parse is why
`git worktree add -b list ../wt` and `git stash push -m list` are the mutations they
are, and why a read form does not become a mutation because a value happens to spell
one.

A mutating subcommand the tool has no action for is denied too, rather than waved
through because no action replaces it: `git config --add core.hooksPath …`,
`git remote set-url`, `git reflog delete`, `git tag v1.0`, `git gc`,
`git repack`, `git maintenance run`, `git submodule add`,
`git sparse-checkout set`, `git notes remove`, `git lfs push`,
`git send-email`, `git format-patch`. Each reason says so plainly — the tool cannot
make that change for you, and `guardMode` (`warn` or `off`) is the deliberate escape
hatch. The read forms stay allowed: `git tag -l`, `git remote -v`,
`git config --get`, `git reflog`, `git submodule status`,
`git sparse-checkout list`. `git config` writing `core.hooksPath` is the sharpest of
them: hooks run on the *next* git command, so what would be executing is somebody
else's program, with the guard watching the wrong process.

A read can still be *told to run something*, and that is asked about rather than allowed:
an environment prefix naming `GIT_PAGER`, `PAGER`, `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`,
`GIT_EDITOR` and their siblings; a global `-c` or `--config-env` whose config **key**
carries a program (`core.pager`, `core.hooksPath`, `diff.external`, `alias.*`, …); or
`--exec-path`/`--upload-pack`. The reason names the mechanism — "the program in
`GIT_PAGER`" — rather than the wrapper text, which would be false: nothing is wrapped.
An override can never downgrade a refusal, so the same flag on a mutation still denies.
`PAGER`, the generic variable, is treated exactly like `GIT_PAGER`: it is the last link in
git's pager chain, so a read that sets it can be telling git to run a program. `PAGER=cat`
is a habit, and the habit has a free replacement — `git --no-pager <command>` is the same
read, is already allowed, and the pager reasons say so. The cost is real and paid
deliberately: `PAGER=cat git log` now asks, like the `GIT_PAGER` spelling always has.

A dry run reads whatever else it names — `git push --dry-run origin main`, `-n`,
`--force --dry-run` — because nothing is sent. Git's last-flag-wins applies, so
`git push --dry-run --no-dry-run` really pushes and is denied.

`deny` outranks `ask` anywhere in one command line, so `git status && git reset
--hard` is refused whole. `ask` is what is left for a subcommand the guard cannot
classify: refusing an operation nobody understands would block work for no stated
reason.

That last verdict is the only one that needs a person, so `guardAsk` decides what
happens when there is nobody to ask. The default, `ask`, waits for an answer —
right when somebody is watching, and a stalled turn when nobody is. `deny`
refuses the command with the reason attached, so an unattended session fails fast
and learns which action to call instead. `allow` accepts it.

`guardMode: off` disables the guard entirely; `warn` classifies and then allows
everything, which makes it a diagnostic for seeing what a session reaches for —
not a safer setting, because it drops the destructive denials with the rest.

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
