# Tests

The suite runs with Node's built-in test runner. From the repository root:

```sh
node --test
```

No install step, no dependency, no network, and no GitHub token: a test that
needed a live account would only ever run on the machine of whoever has one.

## What the tests are allowed to fake

Real git is not faked. Every test builds a disposable repository with the real
git binary in the operating system's temporary directory, calls the action the
tool exposes, and then reads the repository back with git — a result that says
committed over a tree that is still dirty fails the test.

The GitHub API is faked, at the HTTP boundary, by replacing globalThis.fetch.
The stand-in is not a list of canned responses: a merge request really merges the
branch into the base in the bare repository the working clone pushes to, so the
test can ask git whether the work landed. The clone's remote URL is a real
github.com URL; a url.<path>.insteadOf rewrite sends git's own push, fetch and
ls-remote to that local bare repository, while the plugin's API client talks to
the stand-in. GH_TOKEN is pinned to a test value, so a machine's real login is
never read.

## What is covered

| File | What it pins |
|---|---|
| test/actions.test.mjs | The day-to-day flows against real repositories: init, clone, status, save, publish, sync (fast-forward, rebase, merge, conflicts aborted and named), finish, prune. Dirty trees, untracked files, protected branches, forceWithLease, and a failed push's backoff. |
| test/github.test.mjs | The GitHub flows: opening a pull request and re-opening the same one, merge by branch and by number, the remote branch deleted only when the merged commit matches, a branch outside the prefix kept, finish in one call, prune after a merge (including a branch that moved after it), status with pull: true, and the token chain GH_TOKEN, GITHUB_TOKEN, then gh. |
| test/guard.test.mjs | The policy in guard.md: the everyday flow redirected at save, publish and sync; work-discarding commands refused; setup and maintenance allowed; dry runs; wrappers; and the modes. Pure classifier tests — no repository needed. |
| test/render.test.mjs | What the model and the composer read: the first line is the state that needs action, a failure carries its code, message and next step, and a prune lists every branch it would remove. |
| test/turn-sync.test.mjs | The guarantee: a turn's recorded paths are committed and pushed, unrecorded work is reported and left alone, a protected branch is committed but not pushed, and a failed push backs off. |
| test/docs.test.mjs | Documentation against the code it describes: action names, settings and their defaults, parameters, result fields, identifiers and links, and that every repository ships its bundle patch. The cross-repository checks skip a sibling that is not checked out. |

## Requirements and limits

Node 22 or newer (the workflow uses 24) and git on PATH. The suite is POSIX: the
credential-chain tests put a shell script named gh on PATH. Windows is not
covered, because the shell guarantee the project makes is the POSIX one.

The guard tests check the classifier's policy, not a security boundary. The guard
is documented as best-effort — gh, curl and node reach the same API — and the
tests assert exactly the policy in guard.md, including its limits.

There is no live-GitHub test in the suite. The workflow the plugin performs is
tested end to end against real git refs; the merge is performed by the stand-in
rather than by GitHub. That trade keeps the suite runnable everywhere.

CI runs the same command from .github/workflows/test.yml, checking out
dsh-git-core and dsh-git-worktrees beside this repository so the sibling lookups
and the cross-repository doc checks have what they need.
