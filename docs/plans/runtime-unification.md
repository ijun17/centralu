# One process runtime on every platform: target and path

> **Status: proposed, 2026-10-08.** The owner decided on 2026-10-08 that the process runtime gets a full redesign,
> delivered in targeted steps: each step replaces one module wholesale with the target design, and the end result is the
> architecture as it would be written from scratch. The precondition is that every lesson already paid for is written
> down and guarded by a test: [../runtime-lessons.md](../runtime-lessons.md), whose work list (75 rules) this plan
> schedules. Refs #14, #82, #440.

## 1. Why

How a host starts has grown sixteen rows ([agent-host.md](../agent-host.md) §4.0): a pinned shell on a macOS release,
its fallback to the keeper beside the window, the keeper inside the window's executable in debug, Linux direct with an
opt-in keeper, Windows direct, `centralu --keeper` for old keepers, and `centralu serve` on remotes with no keeper at
all. Each row is a different process tree with different stop, update and crash behaviour, and each was right when it
was added. The cost now:

- **Every rule exists two or three times.** Stopping an agent's helpers is written in the keeper (Rust, process
  groups, kqueue/pidfd), in the host for the keeperless path (TypeScript, `ps` walks, `taskkill`, a CIM walk on
  Windows) and in the app runtime. A fix lands in one and the others keep the bug (#435 had to be fixed twice).
- **What a person gets depends on their OS.** An update keeps agents running on macOS, stops them on Linux and Windows
  and on every remote. Linux has had a keeper since #280 that nobody runs (#350 was found only when #458 ran it).
- **Platform checks were spread through the code**: about 180 `cfg` sites in the Rust crates and `process.platform`
  reads in a dozen host modules before #459 and #460 started pulling them into one place.

The target is one topology, one OS layer and one start plan, everywhere.

## 2. Where it stands (main after 0.1.0-beta.13)

| | macOS release | macOS debug | Linux | Windows | Remote (`serve`) |
|---|---|---|---|---|---|
| Who starts the keeper | the pinned shell, via LaunchServices | the window, in its own executable (opt-in) | the window, opt-in (`CC_USE_KEEPER=1`) | no keeper | no keeper |
| Where the host runs from | `<data>/content/<v>/host` (verified) | source | `<data>/hosts/<key>` or the bundle | the installed copy's bundle | `<data>/remote/versions/<v>/…` (phase 3) or npm's folder |
| An update keeps agents | yes (handoff + swap) | — | no | no | no |
| Children owned by | the keeper | the window's host | the host | the host | the host |

Already done towards this plan: one `StartMode` decision (`start_plan.rs`, #459); OS checks in the host confined to
platform modules by lint (`local/platform-checks`, #460); the keeper's stop path made safe on Linux and a
`keeper e2e (linux)` CI job (#458); the compatibility paths' removal scheduled for 0.1.0-beta.16 (#461). In progress:
splitting `keeper/src/host_proc.rs` by OS, and remote phase 3 (installer, update, rollback; remote-hub.md §10).

## 3. The target

### 3.1 One topology

```
launcher ──starts──▶ keeper ──starts──▶ host ──asks the keeper──▶ agents · terminals · commands
(per platform)        (centralu-keeper,   (node, from the          (each contained: its own session
                      from verified       same content)            or Job Object; held by the keeper)
                      content)
   window ──attach (local channel)──▶ keeper ◀── front door (one loopback port + token) ◀── webview, bridges, app views, hubs
```

Everywhere, a host has exactly one parent, the keeper, and every long-lived child is held by the keeper. What differs
per platform is only the **launcher**, the thing that starts a keeper when none answers:

| Platform | Launcher | Why it differs |
|---|---|---|
| macOS release | the pinned shell, opened by the window through LaunchServices; it verifies, copies, starts the keeper and exits ([thin-shell.md](thin-shell.md)) | permissions attach to the app that started the tree (lessons TC1–TC3) |
| macOS with no usable shell, Linux, Windows | the window: it verifies and copies the content it carries, starts the keeper from the copy and attaches | no code-hash permissions to hold (thin-shell.md §8) |
| Remote | `centralu serve --detach` (setsid; WMI on Windows; a WMI-created `wsl.exe` for WSL), started by the hub over ssh; the same keeper in a headless mode | it has to outlive the ssh session (RE6–RE8) |
| Development (`pnpm dev`, e2e, `pnpm app:dev`) | `pnpm host`, or the window running the keeper in its own executable | nothing to hold, nothing to verify; `tauri dev` builds only the window (ST6) |

The direct path (the window or `serve` as the host's parent) survives only for development, the browser and
`CC_HOST_CMD`. A release never takes it.

### 3.2 Content, the same on every OS

Every keeper and host a release runs come from `<data>/content/<version>/{centralu-keeper, host/,
content-manifest.json, content-manifest.json.sig}`, verified and copied exactly as [thin-shell.md](thin-shell.md) §4
and §10.3 describe, by whichever launcher starts the keeper and by the keeper itself on a handoff. On macOS that is what
the shell does today. On Linux it is also what keeps the keeper off the AppImage's mount (FI4); on Windows it is what
keeps the running files out of the folder the next install replaces (FI11); on a remote it is owner decision 6 of
remote-hub.md §10.9 (sign the host folders) arriving with the remote keeper.

The manifest is signed per platform by the release (today macOS only). The downgrade floor, the reuse rule, the
`in-use` refusal and the cleanup are the ones the keeper already has (FI7, FI9, FI2). A remote's install keeps its
npm layout (remote-hub.md §10.1); its keeper is handed the version folder's content root and its manifest.

### 3.3 The OS layer

All platform branches of the runtime live in one place per language:

- **Rust**: `keeper/src/os/` with `mod.rs` (the operations, platform-free types), `unix.rs` (what macOS and Linux
  share), `macos.rs`, `linux.rs`, `windows.rs`. `start_plan`'s `Os::current` stays the one place that asks which OS
  this is for a *decision*; `os/` is where the *mechanism* is.
- **TypeScript**: `host/os.ts` and the platform modules `local/platform-checks` names (#460).

| Operation | macOS | Linux | Windows |
|---|---|---|---|
| Contain a child and its helpers | its own session (`setsid`) | its own session | a Job Object per child, with the child created suspended, assigned, then resumed |
| Stop a contained tree | group TERM, grace, group KILL (`kill(2)` only, SU4) | the same | `TerminateJobObject`; the polite step is stdin EOF (SU5) |
| Sweep helpers after a child exits | group TERM/KILL, never a reused number (CH9) | the same | the Job's remaining processes (replaces the CIM creation-time walk, KL12) |
| Watch the exit of a process you did not start | kqueue `NOTE_EXITSTATUS`, statuses from the outgoing keeper for zombies (CH10) | pidfd, `/proc/<pid>/stat` | a duplicated process handle: any holder can wait on it and read the exit code |
| Window–keeper and host–keeper channel | unix socket, `0600` under umask 077, peer uid (LK8) | the same, `SO_PEERCRED` | a named pipe with a DACL for the user's SID only and `FILE_FLAG_FIRST_PIPE_INSTANCE`, peer checked by `GetNamedPipeClientProcessId` and its token |
| Pass every handle to the next keeper | `SCM_RIGHTS` over a socketpair at descriptor 3, batches that wait for room (HD2) | the same | `DuplicateHandle` into the incoming keeper (opened with `PROCESS_DUP_HANDLE`); sockets through `WSADuplicateSocket` |
| One keeper per data folder | `flock` on `keeper.lock`, the open file description handed over (HD10) | the same | `LockFileEx` (released on death); how the lock crosses a handoff is measured first (§5) |
| Start detached | `setsid`, stdin `/dev/null` (ST8) | the same | `DETACHED_PROCESS \| CREATE_NEW_PROCESS_GROUP \| CREATE_BREAKAWAY_FROM_JOB`, no console (ST12, ST13) |
| A terminal | `openpty`, `TIOCSCTTY`, drained into a ring (CH2) | the same | ConPTY; whether a pseudo console survives a keeper handoff is measured first (§5) |
| Replace files a process runs from | unlink and rename; never overwrite in place (HD13) | the same | rename aside; delete only what nothing runs; move a working directory out first (ST11, FI11) |

The shell crate is macOS-only by definition and stays outside this rule; the window's own OS integration (menus,
traffic lights, trash, `code`) is not runtime and stays where it is.

### 3.4 One start plan

`start_plan::plan` (#459) stays the one decision, with fewer modes:

| Mode | When |
|---|---|
| `Attach` | a keeper answers |
| `ThroughShell` | a macOS release with a pinned shell |
| `Keeper` | every other release: the window verifies and copies its content and starts the keeper from the copy (absorbs `KeeperBeside`) |
| `KeeperInProcess` | a debug window that opts into the keeper |
| `Direct` | development, the browser, `CC_HOST_CMD` |

`KeeperInWindowExe` and the `centralu --keeper` rows go with #461. `serve --detach` asks the same plan with
`Who::Serve`. A test (like `tooling/platform-checks.test.ts` for TypeScript) fails when a start site decides anything
the plan does not.

### 3.5 Update and handoff, one flow

1. **Install** the new version beside the running one: npm and `centralu install` (macOS: `/Applications`; Windows: a
   `.new` folder swapped in by rename; Linux: the new AppImage); on a remote, the hub's installer (remote-hub.md §10.2).
   Nothing running is touched.
2. **Relaunch** the window (`request_restart`, `relaunching` announced, UP4–UP6). A remote has no window: the hub sends
   the switch.
3. **Switch**: the new window (or hub) names its content. The running keeper verifies and copies it into
   `<data>/content/<new>/` (refusals: `content`, `downgrade`, `copy`, `in-use`, `no-content`) and hands itself over to
   the keeper in that copy (§4.4 of architecture.md, every rule of lessons §9).
4. The new keeper **swaps the host** blue-green (architecture.md §4.2, lessons §8), raises the floor once it serves, and
   cleans content no one runs.
5. A keeper that cannot move (an old sender's bug, HD12) leaves the host switched and offers "Restart completely".

On a refusal nothing running changes. The flow is the same on every OS; only step 1's file operations and the handle
passing in step 3 come from the OS layer.

### 3.6 How Linux and Windows reach the keeper

**Linux** needs no new primitives. What blocks it is in [spikes/2026-10-linux-keeper.md](../spikes/2026-10-linux-keeper.md)
§7: the keeper must run from a copy, not the AppImage's mount (step 4); the real window has never run it on a Linux
desktop (manual, then `CC_USE_KEEPER` defaults on); a desktop session's `systemd --user` reaper and
`KillUserProcesses` (manual). The `keeper e2e (linux)` job (#458) is the guard.

**Windows** needs the OS layer's Windows half (step 9): a Job Object per child, a named pipe channel, `DuplicateHandle`
handoff, `LockFileEx`, ConPTY held by the keeper, and a `keeper e2e (windows)` job. Until it ships, Windows keeps the
direct path, now as a `StartMode` row with a reason, not a scattered default.

**Remotes** get the keeper in a headless mode (no window rules: no attach grace, no idle exit while agents run), started
by `serve --detach` (step 10; remote-hub.md §10.9 decision 5).

## 4. What does not change

The front door, the token and HTTP secret rules, the child service's protocol and tags, the swap's phases and the store
rules, the shell's command line and pinned bytes (a new shell version is a separate, deliberate decision), the
manifest format and keys, and the protocol between window and host. The redesign replaces how these are hosted, not
what they say.

## 5. Measurements before the Windows steps

Each is a probe in `docs/spikes/`, run on the owner's Windows 11 laptop, before step 9 starts.

| # | Question | Why it matters |
|---|---|---|
| W1 | Does a `LockFileEx` lock held through a handle duplicated into another process survive the locking process's exit? | The no-gap lock handoff (HD10). If not: a named mutex or the pipe's first-instance flag carries single-instance across the commit |
| W2 | Can a ConPTY pseudo console be resized and kept by a process other than the one that created it? | A terminal surviving a keeper handoff (CH2). If not: a small per-terminal holder process, or terminals restart on a Windows handoff |
| W3 | Does a keeper started by the npm launcher (inside libuv's job) break away with `CREATE_BREAKAWAY_FROM_JOB`? | The keeper must not die with the launcher's console (ST12) |
| W4 | Is a Job Object's process list enough to find an agent's helpers, including ones started with breakaway? | Replaces KL12's creation-time walk |
| W5 | How long does a Windows handoff take with 4 agents, 2 terminals and 7 app views, at a sweep of state sizes? | TE1; the macOS failure was size-dependent |

## 6. Steps

Each step replaces one module wholesale behind the tests that guard its lessons. **A step starts by adding the tests for
its rows of the [work list](../runtime-lessons.md#the-work-list-unguarded-rules)** (each failing with the rule
broken), and lands when those and every existing test of the lessons it names pass. Steps 2 and 3 can run in parallel.
Estimates are agent work.

| Step | Module replaced | Replaced by | Gated by (lessons; work-list rows) | Estimate |
|---|---|---|---|---|
| 0 | (done or in progress) | one `StartMode` (#459), platform-check lint (#460), `kill(2)` and the Linux CI job (#458), compat removal scheduled (#461), `host_proc.rs` split by OS (in progress) | ST1, SU4 | — |
| 1 | — | this document; a Rust platform-check test (a `cfg(target_os = …)`, `cfg(unix)` or `cfg(windows)` outside `keeper/src/os/` and `start_plan` fails CI, with today's sites as an allow-list that only shrinks) | — | 0.5 day |
| 2 | the OS branches of `keeper/src/host_proc.rs`, `keeper/sys.rs`, `children/proc.rs`, `handoff/wire.rs` | `keeper/src/os/{mod,unix,macos,linux}.rs` (Windows: compile-only stubs); the supervisor's spawn, stop and probe call it | ST8, ST13, PA11, LK1, LK7, LK8, SU1–SU7, CH1–CH4, CH9, CH10, HD2–HD5; rows 3, 5, 10, 29–34, 42, 43, 50 | 3–4 days |
| 3 | the host's process lifecycle: `host/main.ts` start and shutdown, `env-path.ts`, `instance-lock.ts`, `transport/server.ts`'s listen and close | `host/lifecycle/` (start sequence as data: log, PATH, lock, store, server, children; shutdown as the reverse, every close run once) | ST16, PA1–PA13, HO1–HO15, LK2–LK5, SW15; rows 6–9, 11, 12, 15–28 | 3–4 days |
| 4 | where a Linux keeper and host run from (`source::Copies` for `hosts/`, the window's keeper start) | content on Linux: the release signs a `linux-<arch>` manifest, the window verifies and copies into `<data>/content/<v>/`, the keeper runs and hands over from there and closes the AppImage descriptors it inherited; `<data>/hosts/` retired for content keepers | FI1–FI7, FI9, ST15, HD13; rows 55, 56 | 2–3 days |
| 4b | the Linux default | `StartMode::Keeper` on Linux releases, after a manual run of the real window on a Linux desktop (spike §7 items 2–3) | ST15, UP3–UP9 | 1 day + manual |
| 5 | `keeper/handoff/` and `keeper/swap.rs` | the same protocol on the OS layer's handle passing (`os::pass_handles`), the freeze as one state machine for host reader, relays and child table | HD1–HD13, SW1–SW6, FI2, TE1; rows 47, 51–54 | 3–5 days |
| 6 | the window's `src/shell/` (install, open, wait) | `launcher/macos.rs` behind the plan's `ThroughShell`: same table tests; the shell crate's bytes untouched | TC1–TC16; rows 57–61 | 1–2 days |
| 7 | `window/sidecar.rs` and the quit/relaunch code in `window/lib.rs` | `window/launcher/`: attach or start through the plan, verify and copy content for `Keeper` (shared with the shell's verifier), relaunch and quit; no direct supervision in a release | ST2–ST4, ST11, TC15, UP1–UP9; rows 1, 2, 4, 35, 62, 64–70 | 2–3 days |
| 8 | the host's own child spawning: `dev-services/kill-tree.ts`, the direct paths of `terminal.ts`, `commands.ts`, `adapters/local-process.ts`, `keeper/held-children.ts`' fallback | one `ChildService` interface the host always calls; implemented by the keeper's `children.sock`, and in development by an in-process service with the same semantics | KL1–KL20, CH5–CH15; rows 36–41, 44–46 | 3–4 days |
| 9 | Windows: no keeper | `keeper/src/os/windows.rs` (§3.3), `keeper e2e (windows)` CI, `StartMode::Keeper` on Windows | §5 W1–W5 first; ST12–ST14, PA7–PA15, SU5, KL11–KL18, FI11, FI12; rows 13, 14, 48 | 6–10 days |
| 10 | `centralu serve` without a keeper | the headless keeper on remotes, started by `serve --detach`; `serve --stop` asks the keeper; the update is a switch to the installed version's content | RE1–RE14, SW8; rows 71–75 | 3–5 days |
| 11 | compatibility paths | removed in 0.1.0-beta.16, row by row (#461) | ST7, HD6 | 1–2 days |
| 12 | `StartMode::Direct` in releases | gone: releases have `Attach`, `ThroughShell`, `Keeper` only; the Rust allow-list of step 1 is empty | all | 0.5 day |

About 30–45 agent days in all, of which step 9 is the largest and the least certain.

### 6.1 How it interleaves

- **Remote phase 3** (remote-hub.md §10.10) is being built in parallel. Its steps 3–4 touch `serve.mjs`, `links/**`
  and `tunnel.ts`; runtime steps 2, 4, 5, 6 and 7 do not, step 3 touches `main.ts` (the stop RPC of #462): it lands
  after phase 3 step 4 or rebases on it. The lint TODO for `centralu.mjs`, `serve.mjs` and `links/**` (#460) closes
  after phase 3 step 4.
- **Remote keeper** (phase 3 step 6, owner decision 5) is step 10 and needs steps 4 and 5: a keeper from content and a
  handoff on the OS layer. Signing the Linux and Windows host folders (decision 6) arrives with step 4.
- **Phase 4** (hosts across machines) is routing and does not depend on this plan; it gains from step 10 (a remote's
  agents survive its update).
- **The Windows keeper (#14)** is step 9, after steps 2, 5 and 8 have put every mechanism behind the OS layer, so the
  Windows half is an implementation of known operations, not a second design.
- **The thin shell (#440)**: step 6 of thin-shell.md (keeper e2e through the shell on CI; the manual probe before each
  shell version) stays its own; step 6 here never changes the shell's bytes. Shell v2 (with the new icon, thin-shell.md
  §8) is independent.
- **#461**: step 11 is pinned to 0.1.0-beta.16, whatever else has landed.

## 7. Definition of done

The redesign is complete when all of these hold:

1. **One topology on all three OSes**: on a release on macOS, Linux and Windows, `ps` shows keeper →
   host → children with neither the window nor a launcher as a parent, every child held by the keeper; an update keeps
   agents running on all three (checked by the keeper e2e jobs, one per OS).
2. **Platform branches only in the OS layer**: `cfg(target_os …)`, `cfg(unix)`, `cfg(windows)` appear in runtime Rust
   only under `keeper/src/os/` and in `start_plan`'s `Os::current`; `process.platform` only in the modules
   `local/platform-checks` names, with no TODO entries left. Both are enforced by tests.
3. **Every start goes through `StartMode`**, including `serve --detach`; a release has no `Direct` row.
4. **Every UNGUARDED lesson is guarded**: the work list of runtime-lessons.md is empty, or each remaining row says
   why it can only be manual and which release checklist runs it.
5. **Compatibility paths removed on schedule** (#461), and the snapshot and child-table fields required.
6. **One content model**: every release keeper and host runs from verified `<data>/content/<version>/`; `<data>/hosts/`
   and running from a bundle or an AppImage mount are gone.
7. **One children implementation**: the host spawns no long-lived child itself in a release; `kill-tree.ts`'s
   process-tree walking is gone.
8. **Remotes run the same keeper** in headless mode, updated by the same switch.
9. **The documents say so**: agent-host.md §4.0 has one row per platform and launcher; architecture.md §4 describes
   the topology above; runtime-lessons.md is updated in each step's pull request.

## 8. For the owner to decide

| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | Content on Linux and Windows: signed and verified, or only copied? | sign per platform and verify as on macOS · copy without verifying | **Sign and verify**: one code path, and it is remote-hub.md decision 6; the cost is a manifest per platform in the release |
| 2 | A Windows keeper's terminals across a handoff, if W2 says a pseudo console cannot move | a holder process per terminal · terminals restart on a Windows keeper update | Decide after W2; restarting terminals costs less to build and only a keeper update triggers it |
| 3 | When the Linux keeper becomes the default | after step 4 and a manual desktop run · after step 5 as well | **After step 4b**: the stop path and the CI job exist (#458), the copy is the remaining blocker |
| 4 | The development launcher | keep `KeeperInProcess` and `Direct` for development · always a keeper in development too | **Keep both**: development has nothing to hold, and `tauri dev` rebuilds only the window |
