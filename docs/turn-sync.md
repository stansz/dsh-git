# The automatic half

What runs by itself: the commit and the push at a turn boundary, the quiet-period
timer under them when no boundary arrives, what they decline, and what they report.
Part of [dsh-git](../README.md) — the overview, the settings and the requirements are
there.

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

**When it runs.** Every tool call arms a settle timer. When the session has been
quiet for a few seconds its edits have stopped, and the sync runs on its own, with
no further tool call needed. A session in an unbroken burst of tool calls is still
committed every minute, so nothing is ever more than a minute away from a commit.

The Host's own turn end — `session/event` carrying `turn/end`, and
`agent/turn-stopping` where the deployment delivers it — is the primary hook and
runs the same sync immediately. The timer covers the case where it does not, and
whichever of the two runs second finds nothing to do. This is worth stating
plainly, because the first reading of this deployment had it backwards: the
plugin's own `boundary.log` records only the tools-layer fallback, which is not
evidence about the other two boundaries at all. The Host's session log carries
`turn/end` for every session.

What *was* wrong was the fallback's timing and its message. It ran at the start of
the next tool call, at most once a minute, so in a long turn it was the fallback
that committed — mid-turn, up to a minute after the edits, several times over —
and it always named the commit after a turn number it never had. Eight such
commits landed in a single two-hour turn, and not one of them was a turn. The
message now names what the commit contains; a turn number appears only when the
Host really reported one.

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

A branch whose work is already in `origin/<base>` is not pushed either. That is what a
merged task branch looks like: action `merge` deletes the remote branch it merged, the
next fetch prunes the tracking ref that recorded it, and "no upstream" then reads exactly
like "never published" — which is how a branch a merge had just removed came back on the
remote. The question is asked of refs on disk (no round trip, no API), and only a positive
answer skips the push: commits the base does not have are published as before, which is what
keeps a worktree's only copy of its work off the floor.

What is never done: pushing a protected branch, pushing a branch the base already
contains, committing during a merge, rebase or cherry-pick, or committing more paths
than `turnCommitMaxFiles`.

## When the automatic sync cannot finish

The turn sync is built so that declining to commit is never quiet. A skip, a
refused push, a timeout and an unexpected failure all produce a message the
**model** reads — not only a Host log line. Every boundary reports this, including
the tools-layer one that does most of the committing. It used to write its
failures to a log file and to nobody else, which made "reported, not silent" true
of the hooks that do the least work and false of the one that does the most:

```
dsh-git could not finish syncing your working tree:
  - dsh-git: skipped the automatic commit: 340 changed paths, above the limit of 200
Run the git tool with action "status" to see the current state, and action
"commit" or action "push" to finish the work by hand.
```

Declining to commit is not the only thing it reports. A repository that is dirty but
that this session never changed is *left* uncommitted on purpose: with the default
`turnSyncScope: "session"` the sync touches only repositories this session recorded,
because committing somebody else's work in progress is worse than leaving it. What used
to be silent is now said:

```
dsh-git could not finish syncing your working tree:
dsh-git left 1 dirty repository uncommitted:
  - other-repo (/workspace/other-repo): dirty and never recorded by this session, so it was left uncommitted (turnSyncScope: "session")
This session never recorded work there, so committing it could commit another session's work in progress. Commit it by hand with the git tool (action "commit") if it is yours, and leave it alone if it is not.
Run the git tool with action "status" to see the current state, and action "commit" or action "push" to finish the work by hand.
```

Work written through `bash` is the case this exists for: the recorder only sees the file
tools, so a repository changed that way and never touched again is exactly the one the
sync has to mention rather than quietly skip.

A push that failed is reported the same way, with git's own words and — when a
credential is what was missing — the sentence that says what to do about it. The
same text is what `status` prints for the automatic push, because it is written
into the failure record rather than added when it is displayed:

```
dsh-git could not finish syncing your working tree:
  - app: push failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled — git could not authenticate to the remote: this machine has no working credential for it. Run `gh auth setup-git` to let the gh CLI provide one, set a credential helper (on macOS that is `git config --global credential.helper osxkeychain`), or use an SSH remote. (attempt 1)
```

Only the credential-shaped failures get the extra sentence — `could not read
Username`, `Authentication failed`, `Permission denied (publickey)` — and a network
failure is passed through exactly as git wrote it.

Reaching the model takes two steps, and both are deliberate: `agent.inject()`
puts the text in its context, but does **not** wake it, so `agent.followup()` then
starts the turn that reads it. Injection alone would leave the note waiting in
the inbox until the user happened to say something, which is indistinguishable
from never sending it.

A *successful* sync announces nothing. Saying "committed and pushed" every turn
is noise, and noise is how a real message gets skipped.

## How to see the automatic commit work

Make an edit in a repository and stop. A few seconds later `git log` shows a commit
whose subject starts `dsh: ` and names the files it contains, with
`Assisted-by: DSH` in the body — or `dsh: turn <N> — <files>` when a real turn
boundary supplied a number. Ending the turn is not what triggers it, and neither
is the next tool call. On a protected branch the commit lands and the push is
refused with a reason; on a `dsh/` worktree branch both happen. `git status` inside the plugin's own
repository is the fastest check, and `/git` prints the same state in the composer.

The automatic commit is deliberately not narrowed to the files a turn edited.
Narrowing it would leave one file the turn touched and one it did not, both
uncommitted, with no later turn likely to notice — and "nothing left
uncommitted" is the promise this bundle exists to keep. The commit subject names
the files, so the result stays attributable without claiming a turn that may not
have existed.

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

**The guard refuses mutating git in `bash`.** A team hits that often, and the
answer is the tool rather than a prompt: every refusal names the action that does
the same job. `guardMode: 'warn'` classifies and allows instead, which is useful
for seeing what sessions reach for — but it drops the destructive denials too, so
it is a diagnostic, not a team setting.

**Session state is written under a lock, one sync runs at a time.** Two OS processes
writing one session file used to lose records — an entire process's worth in the measured
case — so every read-modify-write now takes an advisory lock (exclusive create, a two
second deadline, and a ten second staleness break so a killed writer cannot wedge it; a
lock that cannot be taken reports failure rather than writing unsynchronised). The
automatic sync is serialized per session for the same reason: its triggers — the quiet
period, the ceiling and the two turn boundaries — can land in the same window, and two
runs over one worktree race the same index and the same ref. A trigger that arrives
during a run folds into exactly one follow-up, never dropped.
