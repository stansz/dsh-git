# Tests

How to run the suite and what it covers. Part of [dsh-git](../README.md).

```bash
npm test
```

CI is currently disabled — the workflow trigger in `.github/workflows/test.yml` is
`workflow_dispatch` only, so nothing runs on push or pull request. Re-enable it by
restoring the `on:` block.

`node --test` runs the `test/**/*.test.mjs` glob. Nothing is mocked: every case
builds a real repository with a real bare origin inside a workspace directory,
then drives the plugin's own exported functions — `runAction` for the tool
actions, `evaluateWorktree` through the listener `registerWorktreeGuard`
installs, `registerTurnSync` against a Host reduced to a handler map for the
automatic half, and the local primitives the actions rest on (`deleteBranch`,
`pruneWorktrees`, the pure merge-proof rule) — and asserts on real git state: worktree
registrations, the branch a worktree has checked out, refs in the bare origin,
the ownership marker beside a worktree, and the plugin's own state files.

A third rule is about any variable a case changes. A case that takes the machine's
credentials away, or takes a tool off `PATH`, is measuring the *runner* as much as the
code, and two CI-only failures have come from exactly that: a fixture that had been
passing on this machine's global git identity and failed on every runner, and a case that
set `PATH=/usr/bin:/bin` to hide `gh` — which GitHub's ubuntu images install at
`/usr/bin/gh`, so it passed here and failed there, while macOS passed either way. Control
the variable completely (a directory of symlinks to the binaries the case really needs),
and prove it locally by running the case with the excluded thing placed first in `PATH`.

Two older rules the suite learned the hard way. Every case cleans its directory through a hook
that awaits disposal first: a bare cleanup registered *before* the plugin's host is
disposed deletes a directory the sync is still writing, which throws, leaves the case on
disk, and makes the exit sweep refuse a root that is not empty — that is how scratch used
to survive a green run. And timing bounds are relative to the machine rather than
absolute: a case that asserts "this did not take two seconds" with a fixed millisecond
bound fails when three suites share the CPU, which says nothing about the plugin.

Run it from a session workspace: a directory that contains your repositories and
is not itself one. The suite takes its root from the working directory and moves
to the repository's parent when that directory is a repository, because a worktree
root inside a repository is the second copy of the tree this bundle warns about.
`DSH_GIT_TEST_ROOT` overrides the location. Every case owns
`<root>/.dsh-git-tests/<case>` and removes it when it ends, and the shared root
goes with the last case — including when the only thing left in it is Finder
metadata. `stateRoot` is pointed inside the case, so a test run never writes to
a live deployment's state.
