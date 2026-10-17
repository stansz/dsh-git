# Installing on another machine

Three packages and the order they go in, the difference between a `link:` install (this
machine's checkouts) and a GitHub install (any machine), and the two traps that cost a
restart to find. Part of [dsh-git](../README.md) — the overview, the settings and the
requirements are there.

## The three packages

| Package | Repository | What it contributes |
|---|---|---|
| `dsh-git-core` | github.com/stansz/dsh-git-core | The shared library: one place a git command is run, one state store, one recorder of the files a session changes. No tool, no command, no listener, no rows. |
| `dsh-git` | github.com/stansz/dsh-git | The `git` tool, `/git`, the guard on raw git in the shell, and the automatic commit and push. |
| `dsh-git-worktrees` | github.com/stansz/dsh-git-worktrees | The `worktree` tool and the guard that refuses a file edit landing in a repository on a protected branch. Optional. |

**Install the core first.** `dsh-git-core` is a library, not a plugin: it registers
nothing, so its bundle patch is deliberately empty — one `[]` and no rows. It is still
installable because the installer only recognises a package as a bundle when it declares
`dsh.bundle.patch`, and that is what makes installing it put the package in the
profile's `node_modules`, where the other two bundles look for it.

**A plugin bundle installed without the core fails at activation**, with a message that
names the missing core rather than a bare `ERR_MODULE_NOT_FOUND`:

```
Error: dsh-git-core is not installed: could not load git.mjs from any of 4 locations.
Install the dsh-git-core bundle beside this one. Tried: …
```

**A `link:` install does not hoist a bundle's dependencies.** Node resolves a bare
`import 'dsh-git-core/git.mjs'` from the importing file's real path — this workspace,
not the profile's `node_modules` — so the plugin would fail to load even with the core
installed. Each bundle avoids that with `lib/core-loader.mjs`, which probes the sibling
checkout, the profile's `node_modules` and the working directory; the `dsh-git-core`
README lists the exact order. When none of them has it, the error above is what the row
fails with — a sentence that names what to install, which is the point of probing
rather than importing.

`@deepseek-ai/schemastery` gets the same defensive treatment through `createRequire`
probes over the module, the profile and the working directory. A profile that cannot
resolve it still mounts, with every setting at its default.

**The minimum for the everyday flow is `dsh-git-core` plus `dsh-git`** — the tool, the
guard, and the automatic commit and push. `dsh-git-worktrees` is a separate bundle with
its own settings (`worktreeRoot`, `autoWorktree`, `worktrees`); if you install it, it
needs the core too.

## Install

```bash
# The profile directory is the install target, not a global prefix:
mkdir -p ~/.dsh/profiles/<name> && cd ~/.dsh/profiles/<name>
pnpm add github:stansz/dsh-git-core          # the library, first
pnpm add github:stansz/dsh-git               # the git tool, guard and turn sync
pnpm add github:stansz/dsh-git-worktrees     # optional: one worktree per task
```

Then list the bundles in that profile's own `package.json`, core first:

```json
"dsh": { "profile": { "bundles": ["…", "dsh-git-core", "dsh-git"] } }
```

`plugin_manager` with `install_bundle` does the dependency and the bundle-list entry
together and is what to prefer when it is available. The row inside the package needs no
editing: it names `dsh-git`, which resolves from the profile's `node_modules` once the
dependency is installed.

**What an unpinned install gets you.** `github:stansz/dsh-git` follows the default
branch, so a fresh install on another machine gets whatever `main` is at that moment.
That is the right default for a second machine of your own, and it is why installing this
needs no release step. An install that already exists does **not** follow along by
itself: the resolved commit is written into that profile's `pnpm-lock.yaml`, and
`pnpm install` keeps it. To move that machine to the current `main`, run
`pnpm update dsh-git` there and restart the Harness. To freeze a state instead, pin a
ref after `#` — a branch, a tag or a commit sha all work:

```bash
pnpm add github:stansz/dsh-git#7bcd905     # any commit, frozen
```

## Enabling a row that is disabled in the profile patch

A bundle can insert its row disabled, and a profile can turn one off. Either way, the row
is enabled by naming its id in the profile's own patch layer,
`~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: dsh-git
  disabled: false
```

The row keeps the name and the contents it came from in the bundle layer; the profile
entry only turns it on, so nothing has to be restated. `disabled: true` in the same
place turns one off. Either change is read when the plugin mounts, so it needs a restart.

This bundle's own patch inserts its row enabled, so there is nothing to switch on after a
normal install.

## A setting the schema no longer declares

This one is a mount failure rather than a warning, and the symptom is a bundle that looks
broken at startup. A row in the profile patch that carries settings the bundle's schema
does not declare can fail when the plugin mounts. In this workspace the shape that does
it is the `dsh-git` row, left over from when worktrees were part of this bundle:

```yaml
- id: dsh-git
  name: 'dsh-git'
  config:
    worktreeRoot: /path/to/checkouts   # removed from this bundle's schema
    worktrees: false                   # removed from this bundle's schema
    turnSyncScope: workspace
```

`worktreeRoot` and `worktrees` are fields of `dsh-git-worktrees` now, not of
`dsh-git`. The fix is to delete them from the `dsh-git` row and, if you use that
bundle, declare them on its row instead:

```yaml
- id: dsh-git
  name: 'dsh-git'
  config:
    turnSyncScope: workspace
- id: dsh-git-worktrees
  name: 'dsh-git-worktrees'
  config:
    worktreeRoot: /path/to/checkouts
    autoWorktree: protected
```

Every other setting of this bundle is listed in the README, and each one is declared in
`lib/config.mjs`; a name that is not there is a name to remove, not to keep.

## Nothing here is machine-specific

- **It follows the deployment's home.** `$DSH_HOME` decides, then
  `$DSH_PROFILE_DIR`'s parent, then `~/.dsh` — the same resolution the shipped
  `@deepseek-ai/dsh-home-paths` uses. A machine that moves its Harness home does
  not get git state written to the old one.
- **No machine path is baked in.** No static absolute imports, no baked `file://` path,
  no authoring-machine home, no `app.asar` reference. The core is found at runtime by
  the probes above.
- **Every file it imports ships.** `package.json`'s `files` allowlist names
  `index.js`, `lib/`, `locale/`, `docs/`, `cordis.patch.yml`, `icon.svg`,
  `LICENSE` and `README.md`, and every import is a `node:` builtin, a relative path
  inside the package, or the core resolved through `lib/core-loader.mjs`.

Nothing here is machine-specific: `git` and the optional `gh` are the only
external tools, authentication comes from that machine's own credential helper,
and every path resolves against that deployment's own `$DSH_HOME`.

## Authentication on a new machine

Two independent credentials, and reading needs neither of them — which is why a fresh
machine looks healthy right up to its first push:

- **Reading needs nothing.** `git fetch`, and so this plugin's `sync`, works on a
  public repository with no credential at all.
- **Writing needs that machine's own git credential.** This plugin passes `HOME`
  and `PATH` through to git, and disables prompting (`GIT_TERMINAL_PROMPT=0`, and no
  askpass), because a question with nobody to answer it would hang the call. Set one
  up in a terminal before working here, by either route — neither needs an install:
  - **An SSH remote.** A key that is loaded and accepted; `ssh -T git@github.com`
    says so. No credential helper and no prompt.
  - **A credential helper, for an HTTPS remote.** macOS ships `osxkeychain`
    already; Linux has `libsecret` (GNOME) or `cache`; `store` writes a plaintext
    file and is the last resort. Configure one and authenticate once in a terminal,
    because a tool call here cannot prompt.
- **Pull requests and merges need a GitHub token**, a different credential that does
  not help a push: `GH_TOKEN` or `GITHUB_TOKEN` in the Harness's environment — no
  install needed. `status` with `pull: true` reports a lookup that failed rather
  than showing nothing, so a missing token is visible where a person looks.

**The GitHub CLI is optional, and nothing here requires it.** When it is installed,
`gh auth setup-git` writes the HTTPS helper configuration for you, `gh auth login`
stores the token the chain's last step reads, and `gh auth status` shows that login.
When it is not, the advice leads with `GH_TOKEN` and names the install second — the
failure the token chain reports already says which of the two is missing. After
`gh auth login` there is nothing to restart: a credential failure is not remembered,
so the next call asks again.

Every route keeps the secret somewhere — a key file, the operating system's store,
or whatever launches the Harness — and none of them is stored by this plugin, which
reads a credential only while a git or API call needs one.

## `link:` or GitHub?

They fail in opposite directions, and the failure has the same symptom — "my edit
did nothing" — which is why this is worth deciding once rather than
rediscovering on each machine:

| Install | Reads the code from | A source edit takes effect | Fails when |
|---|---|---|---|
| `link:<path>` | your working tree | on plugin reload or Harness restart | the path is gone — a fresh machine cannot reproduce it, and an absolute path makes the profile non-portable |
| `github:…` | the profile's `node_modules`, a frozen copy | **never** — not on reload, not on restart | you edit the checkout and forget the profile is reading a copy from somewhere else |

**Use `link:` for development.** It is the only install where editing the source
does anything at all. A `github:` install writes a copy into the profile's
`node_modules`, and no amount of restarting makes that copy follow your editor —
it keeps whatever the last install resolved.

**Use `github:` for every other machine.** There is nothing to edit there, and a
pinned ref (`#7bcd905`) is the only version of "this is what I tested" that a second
machine can reproduce.

The trap is a profile that mixes them, because it looks uniform and is not: one
`link:` bundle updates when you edit it and the next quietly does not. If you
edit a bundle and a restart shows no change, check how that bundle is installed
before looking for a bug in the code.

Neither install reloads a changed module by itself — the running Host keeps the
module it loaded. Restarting the Harness is the reliable way to see an edit; the
expensive mistake is to edit, see no change, and go hunting for a defect that is
not there.

The entire `dsh.*` custom-work set in this workspace uses absolute `link:` paths,
recorded as Known trap #1 in the workspace's `docs/WHAT-WE-BUILT.md`
(`../../docs/WHAT-WE-BUILT.md` from here) — a fresh machine must use
Git installs instead. That trap is about *deployment*. It is not an argument
against `link:` while you are the one doing the developing.

**Requirements:** see [Requirements](../README.md#requirements) — git on `PATH`, Node 18+
for global `fetch`, and `gh` only as an optional token source.
