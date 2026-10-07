# Where macOS attaches privacy permissions, measured for a thin shell (2026-10-07)

> Measured for #440 and #220 on macOS 27.0 (Apple silicon), with the owner granting and looking at the screen.
> Centralu is ad-hoc signed, so macOS identifies it by the cdhash of each build and every update loses Screen
> Recording and Accessibility. The question: can a small, never-changing app hold the permissions while
> everything that changes (keeper, host, window) is replaced freely?
>
> **Short version.** Yes, with one constraint found on the way.
> 1. Permissions follow the **responsible process**: the app that started the process tree. A keeper started by a
>    fixed shell, and every grandchild under it, is judged as the shell, even when the keeper is an unbundled binary
>    replaced with other bytes, after a keeper hands off to a new keeper, and after the shell itself has exited.
> 2. Changing the shell's bytes loses both permissions; restoring the original bytes brings them back.
> 3. **The shell must not sit inside another app's bundle.** Nested in the window app, Accessibility stayed with the
>    shell but **Screen Recording followed the outer bundle**: replacing the outer bundle (inner bytes identical)
>    lost it, putting the old outer back restored it. A standalone shell launched by the window through
>    LaunchServices keeps both across window replacements.
> 4. A window app that is its own bundle and a regular app has a normal Dock icon, menu bar, shortcuts and ⌘Tab. A
>    Dock-pinned window app keeps working after the bundle is replaced by `rm` + `ditto`, with one icon. An accessory
>    (Dock-less) window has no menu bar, so it is not an option.

## 1. Method

Sources are in [2026-10-thin-shell-tcc/](2026-10-thin-shell-tcc/), built with `swiftc -O` and signed ad hoc
(`codesign --force -s -`), as Centralu is.

- **Shell**: an app bundle that spawns `content keeper <mode>` with `posix_spawn` (`shell.swift`; the standalone
  variant `shellD.swift` finds the keeper next to itself and is opened by the window app).
- **Content** (`content.swift.in`, built twice as tag A and tag B so the bytes differ): `keeper` spawns `probe` in a
  new session (`POSIX_SPAWN_SETSID`, as the keeper's children service does), or first hands off to `keeper2` and
  exits (as the keeper's self-handoff does).
- **Probe**, the stand-in for an agent's tool. It checks with effect, not only with the preflight calls:
  - Screen Recording: `SCShareableContent` must return the window list (denied: error -3801).
  - Accessibility: reading the Dock's `AXChildren` must succeed (denied: -25211 / -25204).
  - Also logged: `CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted` and the responsible pid
    (`responsibility_get_pid_responsible_for_pid`).
- Every launch goes through LaunchServices (`open -n`), as a person's click does. The **control** is the same probe
  started by launchd (`launchctl submit`), with no shell above it.

The permission prompts appeared under the shell's name (`ShellExp.app`, later `Centralu Agent Exp.app`), not the
unbundled binary that asked.

## 2. Results

### 2.1 A fixed shell, the keeper outside any bundle

| Case | Screen Recording | Accessibility | Responsible pid |
|---|---|---|---|
| Control: launchd starts the probe, no shell | denied | denied | itself |
| Shell → keeper (content A) → probe | allowed | allowed | the shell |
| Content replaced with B (other bytes) | allowed | allowed | the shell |
| Keeper hands off to keeper2 and exits | allowed | allowed | itself (shell already gone) |
| Shell exits before the probe starts | allowed | allowed | itself |
| **Flip:** a resource added to the shell, re-signed (new cdhash) | denied | denied | the shell |
| Original shell bytes put back | allowed | allowed | the shell |

The same held for a shell with `LSUIElement` (no Dock icon). After the shell is gone the API reports the
process as its own responsible pid, but the grant still applies: what TCC uses is fixed when the process tree is
spawned, not looked up through a live parent.

### 2.2 Where the window lives

| Layout | Dock | Menu bar | Permissions across a window update |
|---|---|---|---|
| Window as an accessory process under the shell | no icon of its own | **none**: the previous app's menus stay | n/a |
| Window as a regular app bundle under a Dock-less shell, shell at another path | the window's icon only; a pinned shell is a second icon | normal, shortcuts work | not measured (Dock rejected) |
| Same, window and shell with the **same bundle id** | still two icons (the Dock tells apps apart by path) | normal | n/a |
| Shell **nested** in the window bundle (`Contents/Helpers`), opened through LaunchServices | one icon | normal | Accessibility kept, **Screen Recording lost**; restored by putting the old outer bundle back |
| **Standalone shell, opened by the window through LaunchServices** | one icon; pinned icon survives `rm` + `ditto` of the window | normal | **both kept**, also across a keeper handoff |

## 3. What this decides

- The permission holder is a **standalone app bundle whose bytes never change between releases**, outside the
  window's bundle. It starts the keeper; the keeper starts everything else.
- The window stays `/Applications/Centralu.app`, a normal app the person pins, replaced on update as today.
- The keeper, the host and the UI can change in any release without asking for permissions again.
- Only a change to the shell itself asks again, so the shell holds as little as possible.

The plan built on this is [plans/thin-shell.md](../plans/thin-shell.md).

## 4. Not measured

- Other macOS versions. TCC's attribution rules are not documented; re-run this on each new major macOS
  (the probe and the table above are the test).
- Camera, microphone and protected folders (Desktop, Documents). Expected to follow the same responsible-process
  rule; not checked.
- A window launched at login or by a deep link while the shell is not running.
- Spotlight and Launchpad listing the shell as a second "Centralu".
