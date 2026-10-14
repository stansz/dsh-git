# Worktrees, and cleaning up

The task lifecycle: where a worktree comes from, how one is recognised as this
session's, how two paths are compared, and the single action that removes anything.
Part of [dsh-git](../README.md) — the overview, the settings and the requirements are
there.

## Forcing a worktree

Everything the guard does *asks*. `autoWorktree` is the only setting that **refuses**, and
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

**Where a write lands, not how it is spelled.** The verdict follows the path through
its symlinks: a link inside the worktree that points at the main checkout makes that
write a write into main, so it is refused, while a new file whose path only passes
through a symlinked directory that resolves back inside the worktree is allowed. The
same question decides whether `always` thinks this session has a worktree here at
all — the edit has to land inside one of the paths the session registered, never on a
root that merely looks equal.

## Worktrees

One task, one worktree, at `<worktreeRoot>/<repo>/<slug>` on branch `dsh/<slug>`
cut from `origin/<base>`. Outside every repository on purpose:
nothing to add to `.gitignore`, and no second copy of the tree for editors and
watchers to index and for test globs to match twice.

The root is the `worktreeRoot` setting, and it is **derived from the session's own
workspace** unless you set it: `<session workspace>/.worktrees`. That default is
deliberate. Worktrees are where edits happen, and a Harness file sandbox writes only
inside the session workspace — so a root anywhere else produces a guard that refuses
an edit and then points at a directory the agent cannot write to. Set `worktreeRoot`
to move them, and keep the value outside every repository. See
[Changing a setting](../README.md#changing-a-setting).

- The worktree is locked while a session owns it.
- A branch checked out more than once is refused, never forced.
- Removal never uses `--force` on its own and never `rm -rf`. A dirty worktree
  is refused with the uncommitted paths named, and the lock goes back on.
- A live worktree this plugin did not create is never removed. Naming it is not
  permission: without an ownership marker beside it the removal is refused and the
  worktree reported — dirty or clean — unless the call says `force: true`. The one
  exception is a *registration* whose directory is already gone: it holds no work at
  all, so the sweep clears it and releases the lock, which is the only way such an
  entry ever disappears.
- A branch counts as this plugin's own only inside the `branchPrefix` namespace, and the
  prefix has to end at a separator: a prefix `task` never claims a user branch named
  `taskforce`. The rule governs the automatic push, the prune sweep and the remote-branch
  cleanup, not just the local delete — GitHub's own branch listing matches by prefix, so
  the boundary is re-applied where that listing is used.
- When a removal leaves the worktree's `<worktreeRoot>/<repo>/` directory holding nothing
  but Finder metadata, the directory goes with it. One that still holds anything stays.
- `finish --cleanup` closes the worktree only after committing what was in it *and*
  getting it onto the remote: a push that failed or was never attempted keeps the
  worktree and reports why, because a worktree with no published copy of its
  commits is the only place those commits exist.

## Cleaning up

`prune` is the one action that deletes, and it is narrow on purpose. Everything
else here refuses to remove things because a branch or worktree may be in use —
which is right, but it left the plugin unable to tidy up after *itself*.

```
git prune                                        # dry run: what is left behind
git prune apply: true                            # remove it
git prune repo: /path/to/checkout                # one repository, no sweep
git prune apply: true branches: [dsh/leftover]   # a branch no rule can prove dead
```

With no `repo`, it sweeps every repository under the working directory — the same
sweep `status` does, and the one this action used to fail with `not-a-repo`. That
mattered: a session's working directory usually *contains* its repositories
rather than being one, so the reporting action worked there and the cleanup
action was impossible, which is the "it cannot clean up after itself" failure in
its purest form.

It removes a worktree registration whose directory is gone, and a branch under
`branchPrefix` that **no worktree has checked out and that holds no commit the
base branch does not already have**. A branch with work of its own is reported
and kept. That is the whole safety argument, and it is worth stating plainly:
deleting a branch is what the guard denies `git branch -D` for, so this door
opens only onto the plugin's own leftovers.

**A merged pull request is a proof about a commit, not about a name.** A branch is
removed on the strength of one only when that pull request merged *the commit the
branch points at now* — the head sha the API reports, compared with the tip read
from the branch. Names get reused: `start fix-the-login-bug`, merge it, then
`start fix-the-login-bug` again for something else. The second task wears the
first task's name, and a rule that matched on the name alone deleted its newest
commit, silently, on a sweep that was only supposed to tidy up. Now that branch is
kept, and the report says a merged pull request exists for the name but covers a
different commit. The same rule guards the remote ref, which is deleted only when
it points at that same commit, and it guards the worktree close that every
automatic sync performs.

**Two leftovers cannot be proven disposable locally.** A squash merge rewrites a
branch's commits, so its content is in the base while its commits are not; and a
repository whose remote is gone cannot answer whether the pull request was
merged at all.

That is why `merge` performs only a merge that keeps the ancestry, and refuses a
squash or a rebase outright — before it touches the API, so the answer does not
depend on the remote either. It also retires the task as part of the merge: the
worktree, its session record and its branch, at the one moment the fact is in
hand — and only the pull request's *own* head branch, only when it carries
`branchPrefix`, and only when it points at the commit the merge covered. A merge
run from somewhere else used to delete the branch the caller happened to be
standing on, which from the main checkout is `origin/main`. A branch that has
moved past the merge holds work the pull request never contained, so it stays,
with the worktree, and the result says which commit was not covered. A squash performed by hand, in the GitHub UI, is the case this section is
about — nothing ran locally to record anything — so name it:

```
git prune apply: true branches: [dsh/prune-remote]
```

Naming it *is* the proof — no rule is guessing. Two conditions still hold: the
name must be under `branchPrefix`, and a branch a worktree has checked out is
refused. Without `apply: true` it is a dry run like everything else. The guard's
denial for raw `git branch -D` points here, because action `finish` closes a
worktree but never removes its branch.

**An abandoned worktree needs naming too.** The rule above only drops a
*registration* whose directory is already gone, so a worktree still sitting on
disk — the usual state of a task nobody closed — is invisible to it, and its
branch cannot be removed while it is checked out there. Name it:

```
git prune apply: true worktrees: [some-slug]
```

Naming a worktree is not permission to remove somebody else's. Ownership is the
marker this plugin writes beside a worktree it created: a worktree with no marker is
reported and left exactly as it stands — in the dry run and under `apply: true`
alike — with its dirty paths named if it has any, and nothing is unlocked on the way.
The deliberate door for the case a marker cannot answer (a plugin worktree whose
marker was deleted by hand, or one you have decided to clear yourself) is
`force: true`:

```
git prune apply: true worktrees: [some-slug] force: true
```

`force` overrides ownership and nothing else: the main checkout is still refused, a
dirty worktree is still refused with its files named, and a removal that happened
under it is reported as forced.

**A merged task closes itself.** Action `merge` retires the task the moment it
merges, and each automatic sync closes a worktree this session owns whose pull
request merged the commit that branch points at — the directory, the branch, and
the branch's remote ref when that ref is at the same commit. That is the automatic
half of this section, and the reason per-task isolation no longer accumulates: a
task that finished does not wait to be noticed, and a session that simply stops
does not leave a directory behind for a human to find.

The proof is the same one used everywhere else here — GitHub says a pull request
from that branch merged *this commit* — so nothing is removed on a guess. A branch
that has moved since its merge, a failed query, a repository with no remote, and a
dirty worktree all mean the same thing: leave it alone, and say which commit was
not covered.

A full path always works, and a directory name works when exactly one worktree has it:
an ambiguous name removes neither, and names both candidates, because removing the wrong
one is worse than a refusal. A dirty worktree is refused and its files
are named; the main checkout is never touched; and the branch the removal frees
is removed with it when it holds no commit of its own. Set `autoWorktree` to
`protected` or `always` and this is the closing move that keeps the isolation
from turning into a directory per abandoned task. A branch counts as this plugin's own
only when `branchPrefix` ends at a separator - the rule governs the whole namespace, not
just removals: the automatic push decision, the prune sweep and the remote-branch cleanup
all apply it - so a prefix `task` never claims a user branch named `taskforce`. When a removal
leaves the `<worktreeRoot>/<repo>/` directory
holding nothing but Finder metadata, the directory goes with it.

## Path identity, the bug class this code keeps hitting

`git` realpaths everything it reports. On macOS `/tmp` is `/private/tmp` and
`/var/folders/...` is `/private/var/folders/...`, so the same directory has two
spellings and a string comparison between them is always false. More than a dozen bugs
here were that class, and the sharp ones failed *silently* — a repository that looked
untouched, a worktree that looked unowned, a commit that looked unnecessary.

Two refinements came out of that history. A path's verdict follows **where the write
lands**: the deepest existing ancestor is realpath'd and the rest re-appended, so a
symlink inside a worktree pointing at the main checkout is a write into main and is
refused, while a new file whose path merely passes through a symlinked directory that
resolves back inside the worktree is allowed. And an owned path has to **be** the worktree
git registered — the final component is not followed, and the checkout there must be on
the branch that registration reports — because a path that has been replaced by a link (or
by a copy of another checkout) is not the session's worktree, however it is spelled.

The rule this settled on: realpath at every boundary, and key session state on
the **main repository root** (`git worktree list` reports it first), never on the
directory a caller happens to be standing in — inside a worktree those differ,
and the registry lookup then finds nothing.
