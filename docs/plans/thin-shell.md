# A fixed shell that holds macOS permissions: plan

> **Status: decided by the owner on 2026-10-07 (§9). Steps 1–3 built (§10).** Replaces the shape first proposed on #440
> (shell = window + keeper). The measurements behind every choice here are in
> [spikes/2026-10-thin-shell-tcc.md](../spikes/2026-10-thin-shell-tcc.md).

## 1. Why

Centralu is ad-hoc signed. macOS identifies an ad-hoc app by the cdhash of the build, so every update, and every
local build, is a new app to it: Screen Recording, Accessibility and folder access stop applying to agents' tools
until the person removes the old entry and grants again (#220). Updates ship several times a week; each one
costing a trip to System Settings makes updating the thing people avoid.

Goal: **an update never asks for permissions again**, without depending on an Apple Developer ID. Non-goals:
smaller downloads, UI-only updates (possible later, §8), and Windows and Linux, which have no such permission
model.

## 2. The shape

```
/Applications/Centralu.app                 the window: Dock, menus, UI. Replaced on every update, as today.
   │  opens through LaunchServices (not as its child)
   ▼
<data>/shell/Centralu.app                  the shell: LSUIElement, no window, bytes fixed across releases.
   │  verifies the content's signature,    Permissions attach here, and only here.
   │  copies it, spawns the keeper, exits
   ▼
keeper → host → agent CLIs → their tools   all judged as the shell; all replaceable in any release
```

Three facts from the measurement fix this shape:

1. macOS judges a process by the app that **started its tree** (the responsible process). Grants follow the keeper
   and everything below it through content replacements, keeper handoffs and the shell's own exit.
2. The shell **cannot live inside the window's bundle**: nested there, Screen Recording follows the outer bundle,
   so a window update loses it. Standalone, launched by the window through LaunchServices, it keeps both grants.
3. The window must be a regular app of its own for the menu bar and shortcuts; then the Dock shows one icon, and a
   pinned icon survives the bundle being replaced.

## 3. The shell

**Does only this:**

1. Receive the content location from the window (an argument to the LaunchServices open).
2. Verify the content's signed manifest with the public keys built into the shell (§4).
3. Copy the verified files into `<data>/content/<version>/`, verify the copy, mark it read-only.
4. Refuse a version lower than the highest it has started, unless the window asked for an explicit rollback.
5. Spawn the keeper from the copy, wait for its ready line, exit.

It has no UI, no network, no settings and no knowledge of the host. It does not stay resident: the measurement
shows the grant holds after the shell exits (§9 decision 2 keeps the option).

**Where it lives.** `<data>/shell/Centralu.app`, so `~/.centralu/shell/` for a release and `~/.centralu-dev/shell/`
for development. A hidden folder keeps it out of Spotlight and Launchpad. Bundle id `app.centralu.agent`, display
name **"Centralu"**: that name is what the permission prompt and the System Settings list show.

**No Dock icon, so nothing to linger.** The shell is `LSUIElement`; the Dock icon and its running dot belong to the
window app alone, and go away when the window quits, as today (seen in the spike: one icon, one dot, the shell
never appears).

**How it gets there.** The window carries the shell's bytes in `Contents/Resources/shell/` (only as a source for
copying; it is never run from there). On start the window compares the installed shell's version with the one it
carries and copies the shell out when it is missing or older. A newer installed shell is left alone.

**Bytes that do not change.** A rebuild of the same source does not promise the same bytes, and different bytes
are a new app to macOS. So the shell is built **once per shell version**, published as a release asset, and recorded
in `packaging/shell/shell.lock` (version, sha256, cdhash). The release workflow downloads that artifact instead of
building it and fails if the hash differs. Shell versions are rare and each one is a deliberate decision: it costs
every user one more trip to System Settings.

**Written in Rust**, in the workspace, with no Tauri and no AppKit run loop: a background-only binary with an
`Info.plist`. Its whole dependency list is an ed25519 verifier and a hash.

**No run loop is needed (decided in step 3, 2026-10-08).** "Not responding" (the red label in Activity Monitor, the
spinning cursor) is the window server's verdict on a process that is *connected to it* and does not handle its
events; a process that never connects cannot get it (Apple DTS:
[developer.apple.com/forums/thread/777284](https://developer.apple.com/forums/thread/777284), and TN2083 on
daemons and agents not linking AppKit). The shell links only `libSystem` and `libiconv` (`otool -L`; no AppKit,
CoreGraphics or SkyLight), so it has no way to open that connection, and `LSUIElement` keeps it out of the Dock.
LaunchServices also expects an app it launched to check in, which a plain executable never does; whether that
shows anywhere for a background-only app was not observed here. The linkage is checked on every build (`scripts/shell-integration.mts` in CI, the shell
release workflow). Not measured through LaunchServices in step 3, because that launch can raise permission
prompts on the machine running it; the manual check before each shell version (§10 step 6,
[releasing.md](../releasing.md)) looks at `lsappinfo` and Activity Monitor while the shell waits for a keeper.
If a later macOS shows it as not responding, the fix is a run loop on the main thread with the work on another,
which is a new shell version.

## 4. Verified content

Running code from outside a signed bundle with the app's permissions needs a reason to trust that code.

- **Manifest.** Each release writes `content-manifest.json`: the app version, the platform, the minimum shell
  version, and the sha256 of every file the keeper and the host need (the keeper executable, `main.mjs`, native
  modules, `schema.sql`, the bridge, the app template). The release workflow signs it with plain ed25519 over the
  manifest's exact bytes (§9 decision 8) using a key held only in the release environment's secrets, behind the
  same approval as the npm token. The formats (written by `scripts/content-manifest.mts`, read by
  `apps/desktop/content-verify`):

  | File | Shape |
  |---|---|
  | `content-manifest.json` | `{ "format": 1, "appVersion", "platform", "minShellVersion", "files": [{ "path", "size", "sha256", "executable" }] }`, two-space JSON with a trailing newline, files sorted by the UTF-8 bytes of their path. `platform` is Node's `process.platform-process.arch` (`darwin-arm64`), `sha256` 64 lowercase hex characters. A path is relative and `/`-separated with no empty, `.` or `..` component, no `\`, no control character; no two paths differ only in ASCII case. Unknown fields are ignored; a change an older verifier must not ignore bumps `format`, which it refuses |
  | `content-manifest.json.sig` | `{ "format": 1, "algorithm": "ed25519", "keyId", "signature", "comment" }`. `signature` is the base64 of the 64-byte signature over the manifest file's exact bytes, nothing prepended, checked with `verify_strict` before the manifest is parsed. `comment` is for people and verifies nothing |
  | Key id | The first 8 bytes of SHA-256 over the raw 32-byte public key, 16 lowercase hex characters. It selects which built-in key to check with; an id that is not built in is refused. Trust comes from the key being compiled in, not from the id |

  Both files sit at the top of the content folder and are copied with it, so the keeper can verify its own folder
  again on a handoff.
- **Keys.** The shell carries the current and the next public key, so the signing key can rotate without a
  shell version. They are in `packaging/shell/keys.json`; the private keys exist only as the `npm-publish`
  environment secrets `CONTENT_SIGNING_KEY` and `CONTENT_SIGNING_KEY_NEXT`, generated straight into GitHub on
  2026-10-07 and never written to disk. Dry runs sign with a throwaway key. A key fetched at run time would not do: whoever can change the content could change that key too.
- **Copy, then run the copy.** The shell verifies the signature, copies, hashes the copy again and only then
  spawns from it. Nothing runs from the window bundle directly.
- **Handoff.** On an update the running keeper (already verified) verifies and copies the new content itself with
  the same code and keys, then hands off as it does today. The shell is not involved, which is why its own code
  can stay this small.

What this protects, stated plainly: a release can only run code the project signed; a partly written or
corrupted update is refused instead of half-running; a file dropped into Centralu's folders does not inherit the
person's grants. What it does not: code running as the same user can already reach the permissions through the
agent CLIs and `node` that the keeper starts from the person's `PATH`, which is the product working as intended.
This design does not widen that, and does not pretend to close it.

## 5. The keeper becomes its own executable

Today the keeper is the window's binary started with `--keeper`. With the window and the shell apart, the keeper
is a separate executable (`centralu-keeper`) in the content. The socket, the protocol with the window, the
children service, the self-handoff and the host swap do not change. The keeper's host copies
(`<data>/hosts/<key>`, `source::Copies`) move under the verified content folder.

Development (`pnpm app:dev`, debug builds) keeps starting the keeper directly; there is nothing to hold
permissions for, and a dev shell would be one more thing to rebuild.

## 6. Update flow

1. npm installs the new version; `centralu install` replaces `/Applications/Centralu.app` as today.
2. The window relaunches (`apply_update_relaunch`), finds the keeper running, and asks it to take over the new
   content.
3. The keeper verifies and copies the new content, hands off to the new keeper, and the host swaps as today.
4. No permission prompt. The shell only runs again when the keeper is not running (first start, after a
   reboot, after "Quit completely").

A content whose minimum shell version is higher than the installed shell asks the window to install the newer
shell it carries; that is the one case that asks for permissions again, and the window says so before it happens.

**If the shell is missing or refuses the content** (verification failed, a shell older than the content needs that
could not be replaced), the window starts the keeper itself, as a debug build does, and shows why. Agents keep
working; only the permissions fall back to the window's identity. Nothing unverified is ever started *by the shell*.

### 6.1 Replacing the shell

The shell is pinned, not frozen. Replacing it is part of the design from the start:

- The shell's `Info.plist` carries its **shell version**; the window carries the shell it ships in
  `Contents/Resources/shell/` together with that version, and the manifest names the minimum shell version the
  content needs.
- The window installs a carried shell when none is installed or the carried version is higher: it copies to
  `<data>/shell/.Centralu.app.new`, verifies the copy against `shell.lock`, renames the old one aside, renames the
  new one in, and removes the old one once the new shell has started a keeper. A failed step leaves the old shell
  in place.
- The running keeper is not disturbed: the new shell only matters the next time a keeper has to be started, or at
  once if the content requires it (then the keeper hands off through the new shell).
- `shell.lock` keeps one entry per shell version (version, sha256, cdhash, release asset URL), so the release
  workflow ships exactly the bytes recorded for the version it names, and a new version is a reviewed change to
  that file.

## 7. Versions

| Version | Where | Changes when |
|---|---|---|
| Shell version (`shell 1`) | the shell's `Info.plist`, `shell.lock` | the shell's own code changes (rare, deliberate) |
| App version (`0.1.0-beta.N`) | the window, the manifest | every release |
| Minimum shell version | the manifest | the window–shell or shell–keeper contract changes |

About shows both: "Centralu 0.1.0-beta.13 (shell 1)".

## 8. Later, and going back

- **UI-only updates** and **smaller downloads** become possible once the window loads the UI from verified content
  rather than embedding it. Not part of this plan.
- **With a Developer ID**, macOS identifies the window by team and bundle id, and the shell is no longer needed for
  permissions. The window keeps the option to start the keeper itself (as in development), so going back is a
  switch, and the verification stays as defence in depth.
- **Windows and Linux get no shell**: neither identifies apps by code hash for permissions, so there is nothing for
  a shell to hold, and on Windows an unsigned program copying executables into AppData and running them looks like
  a malware dropper to Defender. What they share: the keeper as its own executable (§5), the signed manifest and
  `<data>/content/<version>/`. Only *who starts the keeper* differs (the shell on a macOS release, the window
  everywhere else), the same switch development and a future Developer ID use. Windows has no keeper yet (it is
  built on Unix sockets, descriptor passing, process groups and `flock`; the Windows counterparts are named pipes,
  `DuplicateHandle`, Job Objects and `LockFileEx`), so there the window keeps starting the host until it has one.

## 9. Decisions (owner, 2026-10-07)

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | The name people see in the permission prompt and in System Settings | **"Centralu"** (bundle id `app.centralu.agent`) | That is the app they think they are granting. The prompt in the spike read "Centralu Agent Exp.app", which is accurate and confusing |
| 2 | Shell lifetime | **Exit once the keeper is ready** | Measured: grants hold after the shell exits. No extra process, and no Dock icon or dot either way (`LSUIElement`). If a later macOS ties grants to a live parent, staying resident is a small change |
| 3 | Shell location | **`<data>/shell/`** | Hidden from Spotlight and Launchpad, removed with the data folder, separate for dev and release |
| 4 | Build the shell once and pin it | **Yes, and replaceable** (§6.1) | Rebuilds are not byte-identical by promise; one stray rebuild would reset every user's permissions. A deliberate new shell version must still be able to ship |
| 5 | Migration | Ask once, after the first release with the shell, with a note in the update | Existing grants belong to the window's old cdhash; the shell is a new app to macOS |
| 6 | Windows and Linux | **No shell; share the keeper split, the manifest and the content folder** (§8) | No code-hash permissions there; Windows needs a keeper first |
| 7 | Signing keys | **Generated into the release environment's secrets** (§4) | Same approval gate as the npm token |
| 8 | Signature format (maintainer, 2026-10-08, #445) | **Plain ed25519 over the manifest's exact bytes, in a small JSON `.sig`; key id = SHA-256 prefix of the public key** (§4), not minisign | Minisign prehashes with BLAKE2b, signs a second "trusted comment" and keeps random key ids in minisign key files; the keys were generated as plain ed25519 (PKCS#8) straight into the release environment, and the shell's whole dependency list is meant to be one ed25519 check and one hash. Nobody needs the minisign tool: `tsx scripts/content-manifest.mts verify <dir>` reads these files |

## 10. Work, in pull requests

| Step | Estimate (agent work) |
|---|---|
| 1. The keeper as its own executable; the window starts it by path; host copies under the content folder | 1 day |
| 2. Manifest writing and ed25519 signing in the release workflow; a verifier shared by shell and keeper | 1–2 days |
| 3. The shell: verify, copy, spawn, exit; built once, `shell.lock`, CI hash check | 1–2 days |
| 4. The window installs or upgrades the shell and starts the keeper through it; refusal messages | 1 day |
| 5. Keeper handoff verifies and copies new content | 0.5–1 day |
| 6. Tests: keeper e2e through the shell on CI; the spike's probe as a manual packaged-app check run before each shell version | 1 day |

Every step lands behind the current behaviour until step 4 switches release builds over, so main keeps
shipping in between.

Status: steps 1 and 2 are merged (#444, #445; the host copies have not moved under the content folder yet, §5).
Step 3 is §10.1. Steps 4 to 6 are open.

### 10.1 Step 3 as built (2026-10-08)

The shell is `apps/desktop/src-tauri/shell` (crate `centralu-shell`), a member of the app's Cargo workspace but
not a default member, so app builds never build it. What the plan left open, and how it was settled:

| Question | Choice | Why |
|---|---|---|
| The command line | `centralu-shell --content <dir> --data-dir <dir> [--bundle-path <path>] [--nonce <id>] [--rollback]`; absolute paths, no `..`, every flag once, nothing else | LaunchServices starts it with `/` as its folder and launchd's environment, so everything is an argument. `--bundle-path` is passed on to the keeper for its build record |
| How the window learns the result | Exit code, one line on stderr, a `[shell]` line in `<data>/keeper.log`, and `<data>/shell-status.json` (`format` 1) carrying the window's nonce | A shell opened through LaunchServices is not the window's child: its exit code and stderr reach no one. The status file is replaced whole (temporary name, rename) and `0600` |
| Exit codes and status reasons | `0` started (or a keeper already answered), `2` `usage`, `10` `content`, `11` `shell-too-old`, `12` `downgrade`, `13` `copy`, `14` `keeper-start`, `15` `keeper-exited`, `16` `keeper-timeout` | One reason per thing the window says differently: `content` is "this build is not what was signed", `shell-too-old` is the one case that installs a newer shell (§6), `downgrade` asks about a rollback |
| "Ready" | The keeper answers `status` on `<data>/keeper.sock` (`client::alive`, the window's own test), within 25 s; a keeper that exits with "already running" while another answers counts as ready | The keeper's stdout goes to `keeper.log`, as when the window starts it, so a ready line would need a second channel. A keeper that never answers is killed, so the window's fallback start is not kept waiting on its lock |
| A keeper already answering | Exit 0 at once, nothing verified, copied or started | The window only opens the shell when no keeper answers; this is the race where one appeared meanwhile |
| How the keeper is started | `keeper::exe::Start` from `centralu-keeper-core`, the same code the window's `sidecar.rs` now uses: same arguments, own session, output to `keeper.log`; `--host-source` is the copy's `host/` | What the shell starts is what the window would have started, from another place. The keeper crate adds `serde` and `libc` to the shell and nothing new |
| `<data>/content/` | `<version>/` (the read-only verified copy with its manifest and signature), `highest-started` (the downgrade floor), and briefly `.<version>.partial-*` while copying | One folder per app version; the floor lives beside what it guards |
| The same version already copied | Verified where it is (`verify_in_place`) and reused if its manifest bytes equal the source's; otherwise removed and copied again | A restart after a reboot should not copy hundreds of megabytes again, and must not trust a folder anyone of the user's could have edited |
| The downgrade floor | Raised only after the keeper answered; `--rollback` sets it to the version rolled back to; an unreadable floor is logged and replaced, not a refusal | A failed start must not lock the person out of the version they had; a rollback must survive the next reboot |
| The data folder | The window's: the shell refuses a missing one and never creates or migrates it; a `--content` under `<data>/content/` is refused | Migration rules in pinned bytes could never change. The copy is removed and redone when it does not verify, which must never reach the source |
| Usage descriptions | Camera, microphone, Bluetooth, contacts, calendars, reminders, photos, speech recognition, Apple Events, protected folders, network volumes, removable volumes, local network | macOS asks the responsible app (the shell) and ends the asking process when its description is missing; adding one later is a new shell version |
| The icon | `icons/icon.icns` as it is when the shell version is built | Shown next to "Centralu" in System Settings; a later icon change reaches it only with a new shell version |
| Test keys | One extra key only behind the `test-key` feature, refused at compile time without `debug_assertions` | The integration test needs a shell that trusts a throwaway key; the shell people install trusts keys.json alone (security-boundaries.md "Signed content") |

Left for later steps: the window opening the shell and reading `shell-status.json` (step 4), removing old
`<data>/content/<version>/` folders and leftover `.partial-*` folders (the keeper, step 5), and moving the
keeper's host copies (`<data>/hosts/`) under the content folder (§5). `fetchPinned` (`scripts/shell-bundle.mts`)
checks a downloaded shell against `shell.lock`; the release starts using it when the window carries the shell.
