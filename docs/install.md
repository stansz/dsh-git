# Installing on another machine

What a fresh machine needs, and the difference between a `link:` install (this
machine's checkouts) and a GitHub install (any machine). Part of
[dsh-git](../README.md) — the overview, the settings and the requirements are there.

The bundle is built to install anywhere:

- **It follows the deployment's home.** `$DSH_HOME` decides, then
  `$DSH_PROFILE_DIR`'s parent, then `~/.dsh` — the same resolution the shipped
  `@deepseek-ai/dsh-home-paths` uses. A machine that moves its Harness home does
  not get git state written to the old one.
- **No machine path is baked in.** No absolute imports, no `file://` imports, no
  authoring-machine home, no `app.asar` reference.
- **Every file it imports ships.** `package.json`'s `files` allowlist names
  `index.js`, `lib/`, `locale/` and `icon.svg` — the whole runtime — and every import
  in it is relative or a `node:` builtin, so an install carries what the entry points
  load.
- **It loads with nothing installed.** The one declared dependency is
  `@deepseek-ai/schemastery`, and it is loaded through `createRequire` probes
  rather than a static import, so the plugin mounts and works without it.

Install on another Harness the way this profile already installs another bundle:

```bash
# The profile directory is the install target, not a global prefix:
mkdir -p ~/.dsh/profiles/<name> && cd ~/.dsh/profiles/<name>
pnpm add github:stansz/dsh-git
```

**Pin it if you want reproducibility.** An unpinned `github:` spec follows the
default branch, so a fresh install on another machine gets whatever is newest at
that moment. To freeze a known-good state, name the ref:

```bash
pnpm add github:stansz/dsh-git#v0.1.0
```

Then make the profile load the bundle — one line in its own `package.json`:

```json
"dsh": { "profile": { "bundles": ["…", "dsh-git"] } }
```

`plugin_manager` with `install_bundle` does the dependency and the bundle-list
entry together and is what to prefer when it is available. The row inside the
package needs no editing: it names `dsh-git`, which resolves from the profile's
`node_modules` once the dependency is installed.

Finally, set that machine's guard mode and worktree root by overriding this
bundle's row in the profile's own patch layer — the same place every other row is
configured. There is no Configure page in this version, and no client half: that
work was built and then removed, because a client half in the boot graph could
take the front end down. Until the row is overridden, every setting keeps its
default.

Nothing here is machine-specific: `git` and the optional `gh` are the only
external tools, authentication comes from that machine's own credential helper,
and every path resolves against that deployment's own `$DSH_HOME`.

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
pinned ref (`#v0.1.0`) is the only version of "this is what I tested" that a second
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
recorded as Known trap #1 in `docs/WHAT-WE-BUILT.md` — a fresh machine must use
Git installs instead. That trap is about *deployment*. It is not an argument
against `link:` while you are the one doing the developing.

**Requirements:** see [Requirements](../README.md#requirements) — git on `PATH`, Node 18+
for global `fetch`, and `gh` only as an optional token source.
