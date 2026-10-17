# The automatic half

What runs by itself: the commit and the push at a turn boundary, the quiet-period
timer under them when no boundary arrives, what they decline, and what they report.
Part of [dsh-git](../README.md) — the overview, the settings and the requirements are
there.

## The two automatic behaviours

**Turn commit.** At the end of a turn, each repository this session recorded work in
is committed. *Which* repositories, and *which* paths inside them, is decided in three
steps:

1. the shipped `@deepseek-ai/dsh-workspace-changes` recorder's file list for that
   turn, reconciled to repositories, when the recorder can serve it;
2. this session's own touched-path record, which the tools layer writes on every
   mutating file operation — always consulted, never a last resort;
3. a scan for dirty repositories — **only** when `turnSyncScope: 'workspace'`.

Within a repository the commit is the **intersection** of two lists: the paths this
session recorded, and the paths that are actually dirty. Everything else dirty is left
where it is and named in the notice. Committing everything dirty was the earlier rule,
and it published work nobody had chosen to publish: another agent's half-finished edit
in the same checkout rode into this session's commit and its push. A path left behind is
named until its owner commits it — visible and unattributed beats published and
misattributed.

A path list that survives the intersection is committed under the configured message:
`dsh: turn <N> — <paths>`, or `dsh: <paths>` when no turn number was reported, or
`dsh: automatic commit` when there are no paths to name. The body carries
`Assisted-by: DSH`. Above `turnCommitMaxFiles` changed paths the commit is skipped
and the repository is reported instead.

**When it runs.** Three triggers, one sync at a time:

- `agent/turn-stopping` — the awaited, agent-scoped turn close, which carries the turn
  number and the agent's own abort signal;
- `session/event` carrying `turn/end` — the same work reached from the session log,
  because a listener that never receives the first event would fail silently;
- the quiet period — every tool call arms a timer, and four seconds after the session's
  edits stop the sync runs on its own, with no further tool call needed. A session in an
  unbroken burst of tool calls is still committed every minute, which is the ceiling
  under the timer.

Whichever of the two boundaries arrives first wins for that (session, turn) and the
other is a no-op. A trigger that lands while a sync is already running folds into
exactly one follow-up run — deferred, never dropped, and never two runs over one
checkout racing the same index and the same ref.

**Turn push.** The commit is pushed when the branch is safe to push: a task branch
under `branchPrefix`, or — when nothing is protected — the branch in use. A branch
named in `protectedBranches` is never pushed automatically. A branch whose work is
already in `origin/<base>` is not pushed either — that is what a merged task branch
looks like, and pushing it is how a branch a merge had just removed came back on the
remote.

What is never done: pushing a protected branch, pushing a branch the base already
contains, committing during a merge, rebase or cherry-pick, committing a detached
HEAD, committing more paths than `turnCommitMaxFiles`, or pushing a repository that
has no `origin` remote at all. That last one is not a failure — it is the shape of a
repository with nowhere to push to — so it is skipped in silence rather than reported:
a project started before it has a remote gets no notice and no backoff, and `status`
still shows the branch and its commits. Action `publish` asked for by hand says so
directly instead (`no-remote`, with the `git remote add origin <url>` that fixes it).

## When the automatic sync cannot finish

The turn sync is built so that declining to commit is never quiet — with two exceptions,
and both are deliberate. `turnCommit: false` leaves the tree alone *by configuration*,
and `turnPush: false` leaves the commits local *by configuration*. A configured outcome
is not a skip to report, and naming the same tree every turn is the noise that trains a
reader to skip the message that matters; `status` still shows it dirty and still shows
the ahead count.

Everything else a sync declines, refuses or fails produces a message the **model** reads
— not only a Host log line. Every boundary reports this, including the quiet-period run
that does most of the committing:

```
dsh-git could not finish syncing your working tree:
  - app: skipped the automatic commit: 340 of this session's changed paths, above the limit of 200
Run the git tool with action "status" to see the current state, and action "save" or action "publish" to finish the work by hand.
```

A repository this session never recorded is *left* alone: with the default
`turnSyncScope: "session"` the sync touches only repositories this session recorded,
because committing somebody else's work in progress is worse than leaving it. What used
to be silent is said — and "dirty" is not the only shape that matters, because a clean
repository can hold commits that exist nowhere else:

```
dsh-git left 2 repositories alone:
  - other-repo (/workspace/other-repo): dirty and never recorded by this session, so it was left uncommitted (turnSyncScope: "session")
  - side-project (/workspace/side-project): has 1 unpushed commit(s) and was never recorded by this session, so it was left unpushed (turnSyncScope: "session")
This session never recorded work there, so committing it could commit another session's work in progress. Commit it by hand with the git tool (action "save") if it is yours, push it with action "publish" if it only needs sending, and leave it alone if it is not.
Run the git tool with action "status" to see the current state, and action "save" or action "publish" to finish the work by hand.
```

Two cases earn a line: a dirty tree, and a branch **ahead of its upstream**. The second
exists because the guard lets `merge`, `revert`, `cherry-pick`, `apply` and `am` run in
bash, and each can create a commit that leaves no dirty path behind. A branch with no
upstream is not reported: it is unpublished by configuration, not unpushed, and nothing
here can say where it would go.

A repository that is dirty but that *some* session has recorded work in is not reported
at all — it is a live sibling's work in progress, and `status` still shows it. Work
written through `bash` is the case the left-alone report exists for: the recorder only
sees the file tools, so a repository changed that way and never touched again is exactly
the one the sync has to mention rather than quietly skip.

Paths left behind inside a repository this session *did* commit are reported after the
commit lands:

```
dsh-git could not finish syncing your working tree:
  - app: left 3 unrecorded changed path(s) alone (a.mjs, b.mjs, c.mjs): commit them with the git tool (action "save" with `paths`) if they are yours.
Run the git tool with action "status" to see the current state, and action "save" or action "publish" to finish the work by hand.
```

A push that failed is reported the same way — in git's own words, plus the next step
when there is one. The same text is what `status` prints for the automatic push, because
it is written into the failure record rather than added when it is displayed:

```
dsh-git could not finish syncing your working tree:
  - app: push failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled — git could not authenticate to the remote: this machine has no working credential for it. Use an SSH remote, or set a credential helper for HTTPS — on macOS `git config --global credential.helper osxkeychain`, on Linux `libsecret` or `cache` — and authenticate once in a terminal; neither needs anything installed. The GitHub CLI is optional here: if it is present, `gh auth setup-git` does the helper half. (attempt 1)
Run the git tool with action "status" to see the current state, and action "save" or action "publish" to finish the work by hand.
```

Credential-shaped failures — `could not read Username`, `terminal prompts disabled`,
`Authentication failed`, `Invalid username or token`, `Permission denied (publickey)` —
get that extra sentence; a rejected push names the fetch/rebase route and an unreachable
remote names the network. Anything else is passed through exactly as git wrote it. A push
held back after earlier failures says so, with the attempt count.

Reaching the model takes two steps, and both are deliberate: `agent.inject()`
puts the text in its context, but does **not** wake it, so `agent.followup()` then
starts the turn that reads it. Injection alone would leave the note waiting in
the inbox until the user happened to say something, which is indistinguishable
from never sending it.

A *successful* sync announces nothing. Saying "committed and pushed" every turn
is noise, and noise is how a real message gets skipped.

## Git hooks

The plugin commits through ordinary `git commit` and does not pass `--no-verify`,
so every hook the repository has installed — `pre-commit`, `commit-msg`,
`post-commit`, and a global `core.hooksPath` — runs on automatic commits too.

That matters most for `post-commit`, which runs after the commit exists and can do
anything. A `post-commit` that pushes `HEAD` bypasses this sync's decisions, including
the protected-branch rule: installed globally, it pushes `main` on every automatic
commit. If you install a global `core.hooksPath`, check what its `post-commit` does
first.

A hook that refuses a commit is reported as a skip, not worked around: a rejecting
hook is a policy, and stepping over it silently would be worse.

## How to see the automatic commit work

Make an edit in a repository and stop. A few seconds later `git log` shows a commit
whose subject starts `dsh: ` and names the files it contains, with `Assisted-by: DSH`
in the body — or `dsh: turn <N> — <files>` when a real turn boundary supplied a
number. A few seconds of quiet is what runs the sync; a real turn boundary does the
same work immediately, and a tool call only re-arms the timer. On a protected branch the
commit lands and the push is refused with a reason; on a `dsh/` branch both happen. `git status` inside the plugin's own repository is the fastest
check, and `/git` prints the same state in the composer.

## Running several sessions at once

Agent Teams puts several sessions in one filesystem, and this plugin is designed
for that rather than around it.

**Give each teammate its own checkout where you can.** A linked worktree per task is
the cleanest isolation, and this bundle does not create one: creating, tracking and
retiring them belongs to the separate `dsh-git-worktrees` bundle. With that installed,
a teammate works in its own worktree, commits and pushes its own `dsh/<slug>` branch,
and integration becomes a real pull-request merge.

Nothing breaks without one either, because of `turnSyncScope: 'session'` — a
teammate's uncommitted work in the shared checkout is simply not committed by anyone
else, and `status` reports it until its owner commits it.

**The guard redirects the everyday flow in `bash`.** The answer in a team is the tool,
not a prompt: every refusal names the action that does the same job. (`guardMode: 'warn'`
allows everything instead, so it is not a team setting; see [guard.md](guard.md).)

**Session state is written under a lock, one sync runs at a time.** Two OS processes
writing one session file used to lose records — an entire process's worth in the measured
case — so every read-modify-write now takes an advisory lock (exclusive create, a two
second deadline, and a ten second staleness break so a killed writer cannot wedge it; a
lock that cannot be taken reports failure rather than writing unsynchronised). The
automatic sync is serialized per session for the same reason: its triggers — the quiet
period, the ceiling and the two turn boundaries — can land in the same window, and two
runs over one checkout race the same index and the same ref. A trigger that arrives
during a run folds into exactly one follow-up, never dropped.
