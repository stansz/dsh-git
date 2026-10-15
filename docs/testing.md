# Tests

How to run the suite, the real fixtures it builds, what CI does with it, and the rule
that a new test must fail against the pre-change library. Part of
[dsh-git](../README.md) — the overview, the settings and the requirements are there.

```bash
npm test
```

CI runs exactly this on every push and pull request — ubuntu and macOS on Node 22 and
24, with no `npm install` because the bundle's one dependency is loaded defensively and
the suite needs no third-party code. The matrix is the point rather than decoration: the
bug class this code keeps hitting is path identity, and that is what differs between
platforms, so a suite that only ever ran on one machine was measuring less than it looked
like.

`node --test` runs the `test/**/*.test.mjs` glob. Nothing is mocked: every case
builds a real repository with a real bare origin inside a workspace directory,
then drives the plugin's own exported functions — `runAction` for the tool
actions, `evaluateWorktree` through the listener `registerWorktreeGuard`
installs, `registerTurnSync` against a Host reduced to a handler map for the
automatic half, and the local primitives the actions rest on (`deleteBranch`,
`pruneWorktrees`, the pure merge-proof rule) — and asserts on real git state: worktree
registrations, the branch a worktree has checked out, refs in the bare origin,
the ownership marker beside a worktree, and the plugin's own state files.

Two rules the suite learned the hard way. Every case cleans its directory through a hook
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
