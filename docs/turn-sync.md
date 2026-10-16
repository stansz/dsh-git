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
`agent/turn-stopping` where the deployment delivers it — runs the sync immediately.
The timer covers the case where it does not.

`turnSyncScope: 'session'` (the default) commits only repositories this session
touched. `workspace` scans for any dirty repository under the working directory —
use it for a single session working alone. Within a repository the session has
established as its own, everything dirty is committed.

**Turn push.** The commit is pushed when the branch is safe to push: a task branch
under `branchPrefix`, or the branch of a worktree this session owns. `main` and
`master` are never pushed automatically. A branch whose work is already in
`origin/<base>` is not pushed either — that is what a merged task branch looks like.

What is never done: pushing a protected branch, pushing a branch the base already
contains, committing during a merge, rebase or cherry-pick, committing more paths
than `turnCommitMaxFiles`, or pushing a repository that has no `origin` remote at
all. That last one is not a failure — it is the shape of a repository with nowhere
to push to — so it is skipped in silence rather than reported: a project started
before it has a remote gets no notice and no backoff, and `status` still shows the
branch and its commits. Action `push` asked for by hand says so directly instead
(`no-remote`, with the `git remote add origin <url>` that fixes it).

## When the automatic sync cannot finish

The turn sync is built so that declining to commit is never quiet — with one exception,
and it is deliberate: `turnCommit: false` leaves the tree alone *by configuration*, and so
says nothing. A configured outcome is not a skip to report, and naming the same tree every
turn is the noise that trains a reader to skip the message that matters; `status` still shows
it dirty. A skip,
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

**The guard refuses only git in `bash` that discards work.** A team hits that
rarely now: `fetch`, `pull`, `push`, `commit`, `rebase`, `config` and `remote` all
run, so a session can repair its own remote, credential or diverged branch without
a prompt and without the tool needing an action for it. What is still refused
names the loss and, where one exists, the ordinary way through.
`guardMode: 'warn'` classifies and allows instead, which is useful for seeing what
sessions reach for — but it drops the destructive denials too, so it is a
diagnostic, not a team setting.

**Session state is written under a lock, one sync runs at a time.** Two OS processes
writing one session file used to lose records — an entire process's worth in the measured
case — so every read-modify-write now takes an advisory lock (exclusive create, a two
second deadline, and a ten second staleness break so a killed writer cannot wedge it; a
lock that cannot be taken reports failure rather than writing unsynchronised). The
automatic sync is serialized per session for the same reason: its triggers — the quiet
period, the ceiling and the two turn boundaries — can land in the same window, and two
runs over one worktree race the same index and the same ref. A trigger that arrives
during a run folds into exactly one follow-up, never dropped.
