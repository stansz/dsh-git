# Tests

How to run the suite and what it covers. Part of [dsh-git](../README.md).

```bash
npm test
```

## Current state

The test directory is **not present** in this checkout. It was removed because
the old suite (52 files, ~7,000 lines) tested internal modules and edge cases
rather than the behaviour the plugin promises, and made small changes slow. The
history is on `main` if the suite is ever wanted back.

CI is disabled: the workflow trigger in `.github/workflows/test.yml` is
`workflow_dispatch` only, so nothing runs on push or pull request. The jobs
themselves are intact — restoring the `on:` block re-enables them.

## If the suite is restored

Three tests are what actually matter, one per promise the plugin makes:

1. **Turn sync commits.** Edit a file in a repository, run the turn sync, assert a
   commit exists on the branch.
2. **Turn sync pushes.** The same, then assert the commit is on the remote.
3. **Prune removes only what is disposable.** A `dsh/*` branch holding a commit the
   base does not have is reported and kept; one with no commits of its own is removed
   by `apply: true`, and never on a dry run.

Anything beyond those three is plumbing. Plumbing tests are fine to have, but
they should not be the only thing on offer — the old suite proved `isTaskBranch`
correctly rejects `taskforce` while `main` was silently not being pushed, and
nothing caught it.

Run it from a session workspace: a directory that contains your repositories and
is not itself one. `DSH_GIT_TEST_ROOT` overrides the scratch location. Each case
owns its own directory under it and removes it when it ends.
