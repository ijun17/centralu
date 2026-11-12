# Removing the keeper's agent-holding and the live swap (#1895 step 4)

> **Status: PRs 1 to 5 and 7 built (PR 8 has no work left); PR 6 design, not built (it waits on releases).** The owner decided option C of #1895 (2026-11-03, confirmed 2026-11-06): agents are no
> longer held across an update on any machine, every update is stop-and-continue, and the supervisor role, credential
> issuance (#1405) and background mode stay, re-homed. This document is step 4. Step 3 (the macOS release app's host
> stops handing its children to the keeper, behind one switch, with a handover from a holding keeper, §6) ships
> first in a beta. No deletion lands before step 3 is in a beta and the `keeper-holding-last` tag exists.
> [remote-keeper.md](remote-keeper.md) §3 to §5.1 stay as measured background; its steps 3 to 8 are cancelled.

**Short version.**

1. **macOS keeps a small keeper:** shell, then `centralu-keeper`, then the host, as today. The keeper keeps
   supervision, the control socket with its window check (#1405), background mode with its idle exit, the front door
   and the per-build copies. It loses the children service, the blue-green swap, its own descriptor handoff, taking
   over a foreign host, and its content-verifying route to the next build (§2).
2. **An update ends the keeper too.** The window asks the keeper to stop the host for an update and exit, relaunches,
   and the new window opens the shell, which starts the new build's keeper from verified content. No keeper ever runs
   a host of another build, so the keeper/host version mix and the keeper's own update both go away (§2.3).
3. **Linux and Windows stay direct** (the window is the host's parent, as today). Linux's `CC_USE_KEEPER=1` opt-in
   and the keeper file in the Linux host packages go (§2.4).
4. **Eight pull requests** remove about 17,500 lines, each revertable alone (§4).

## 1. Facts the design stands on

All counts are `wc -l` on main at b5521dcc1. Test lines in Rust are approximate (from the first `#[cfg(test)]`).

- **The shell's command line is frozen.** The shell crate links `keeper::exe::Start` and starts exactly what the
  window would, and its bytes cannot change without every person granting permissions again
  ([thin-shell.md](thin-shell.md) §3). So whatever runs at `<data>/content/<version>/centralu-keeper` must keep that
  name and accept every argument `Start` passes (`--data-dir`, `--host-source`, `--bundle-path`, `--app-version`).
- **macOS permissions follow the process that started the tree.** Releases are ad-hoc signed
  (`signingIdentity "-"`), so each build is a new app to macOS. A host the window starts is judged as the window, and
  every update would ask for Screen Recording, Accessibility and folder access again (#220). Only a tree the shell
  starts keeps its grants ([thin-shell.md](thin-shell.md) §1, §10.2).
- **Background mode needs a process that outlives the window**, and a window that comes back needs the full token
  from it. `Supervisor::background` errors on the direct path today.
- **The window check of #1405 needs the kernel's peer pid** (`LOCAL_PEERPID`, `SO_PEERCRED`) and the executable
  behind it (`proc_pidpath`, `/proc/<pid>/exe`). Node exposes neither for a unix socket.
- **Supervision is already shared.** `host_proc::Supervisor` (five failures, 30 s stable reset, stop at once on a
  lock conflict or a newer store) is the same code under the keeper and on the direct path.
- **Stop-and-continue already exists** for `serve` hosts (#1626) and the desktop direct path (#1939):
  `host.stop {forUpdate}` and the stdin line `{"op":"stop","forUpdate":true}`, `update-resume.<uuid>.json`, and
  #1902's background tasks, cards, terminals and Run commands.

## 2. What goes and what stays

### 2.1 Where each kept role lives, and why

| Role | Lives after the removal | Why there |
|---|---|---|
| Host supervision (restart rules) | `host_proc::Supervisor`, run by the small keeper on macOS release and by the window on Windows, Linux and debug builds, as today. Remotes: the hub and `serve`, as today | Shared code that already serves both. The window cannot be the macOS host's parent (permissions). The host cannot restart itself after a crash |
| Credential issuance (#1405) | The small keeper's `keeper.sock`: `window_peer.rs` gives the token to a Centralu window only, `limited.rs` gives everything else the limited credential. Windows and Linux: the window holds the token from the ready line and no socket hands it out, as today. Remotes: `serve.json`, as today | The check needs the kernel's peer pid, which Rust has and Node lacks. A process that holds the host anyway is the natural issuer. Nothing moves, so nothing is re-reviewed |
| Background mode, idle exit | The small keeper: `idle_decision`, `stop_on_detach`, `keeper-settings.json`, the host's activity report (`keeper-link.ts`), all unchanged. Windows keeps `serve --window`. Linux keeps none | It is the only process that outlives the window and is in the shell's tree |
| macOS permission attribution | shell, then keeper, then host | The shell starts only `centralu-keeper` (§1) |
| The front door (one port and token per keeper life) | Stays in the small keeper | Not in the deletion list: it keeps the window's and the Codex bridge's address across a crash restart, and holds a new connection up to 45 s while the host comes back. 499 production lines. Its removal can be decided later on its own |
| Per-build copies, content cleanup | `source.rs`, minus the swap's claims | An install rewrites the app bundle while the host still runs, and the host reads the Codex bridge, `schema.sql` and `app-template/` by path on demand. The shell's fallback (`KeeperBeside`) still runs from `<data>/hosts/<key>/`, and old `content/<version>/` folders still need removing |
| `system_ending` (#1970), token on stdin (#538), one keeper per folder (`flock`), the legacy folder move | The small keeper, unchanged | Each has no tie to holding or swapping |
| Stopping for an update | `{"op":"stop","forUpdate":true}` on `keeper.sock`, which writes the host's stdin stop line, waits for the host (15 s, as `STOP_FOR_UPDATE_WAIT`), and then ends the keeper | One stop for every caller: "Apply now", the automatic apply, and a window of another build |

Rejected homes. **The window process:** it fails all three: permissions follow it, it cannot outlive itself for
background mode, and it has no peer to judge. **The host itself:** it cannot restart itself, it cannot judge a peer
without a native module, and a host started by the window again loses permissions.

### 2.2 File by file

**Keeper crate** (`apps/desktop/src-tauri/keeper/src/`, 19,380 lines).

| Part | Files | Lines | Fate |
|---|---|---|---|
| Children service | `keeper/children/*` (buffer, child, mod, reactor, requests, snapshot, stop, tests), `os/unix/children.rs` | 3,765 (≈1,820 tests) | Goes |
| Descriptor passing | `os/unix/handles.rs` | 176 | Goes (used only by the children service and the handoff). Went in PR 4 |
| Keeper handoff | `keeper/handoff/*` (mod, pack, wire, tests) | 1,587 | Goes. Went in PR 4 |
| Taking over a foreign host | `host_proc/handover.rs`, `host_proc/no_handover.rs`, `HostProc::Foreign` and `hand_over`/`adopt` in `host_proc/mod.rs` | 437 + ≈150 | Goes. Went in PR 4, with `os/unix/process.rs` (PR 2's watch of a handed-over host) |
| Blue-green swap | `keeper/swap.rs`, `keeper/server/switch.rs`, the swap tests in `server/tests.rs` | 1,051 + ≈250 | Goes. `switch` and `upgrade` answer `{"ok":false,"error":"gone"}` so an older window gets a reason |
| Content route to the next keeper | the verify-and-copy half of `keeper/content.rs` (`move_to_content` and its callers) and most of `content/tests.rs` | ≈300 + ≈450 | Goes. `Origin` and `own_origin` stay. The shell verifies and copies. Went in PR 4 (`Verifier::place`, the bundle-content copy and the `test-key` feature); the verifier's `check` and `diagnose` stay for the window's refusal text |
| Linux opt-in | `keeper/carried.rs` and its tests, `keeper/appimage.rs`, the `Keeper` and Linux `KeeperOptIn` rows of `start_plan` | 390 + 104 + ≈120 | Gone (§2.4, PR 7) |
| Exit-watch backends for held children | the kqueue and pidfd parts of `os/unix.rs` | ≈150 | Goes |
| Supervision | `host_proc/mod.rs` (minus the above), `node.rs`, `tests.rs` | ≈2,030 | Stays |
| Control socket, background mode, idle exit | `keeper/mod.rs` (`relaunch_state` and the relaunch grace go once nothing announces a relaunch), `accept.rs`, `client.rs`, `server/mod.rs`, `server/push.rs` (swap-phase rules go), `server/windows.rs`, `server/host.rs` (children lines go), `server/start.rs` (as built in PR 4, `--take-over-fd` exits at once with code 7, so the keeper that asked rolls back) | ≈2,400 | Stays, trimmed |
| Credentials | `window_peer.rs`, `limited.rs` | 366 | Stays |
| Front door | `front_door.rs` | 767 (268 tests) | Stays, minus its freeze and parking for a handoff (PR 4) |
| Per-build copies | `source.rs` | 995 | Stays, minus the swap's claims and the freeze (≈100). Launch claims stay (#368) |
| Start rules, OS layer | `start_plan.rs` and tests, `serve_window.rs` and tests, `platform_checks.rs`, `exe.rs`, `os/*` | ≈2,500 | Stays, trimmed |

**Window** (`apps/desktop/src-tauri/src/`, 3,566 lines in `sidecar/`, `shell/`, `refusal.rs`, `lib.rs`). Stays except:
`switch_build`, `upgrade` and `restart_keeper`'s swap half in `sidecar/link.rs`; `switch_host_build` in `lib.rs`; the
keeper half of `sidecar/relaunch.rs` becomes the same stop-for-update the direct half already makes (≈300 lines go).
The shell crate (1,185) and `refusal.rs` stay.

**Host** (`packages/agent-host/src/`).

| Part | Lines | Fate |
|---|---|---|
| `keeper/*` (children client, held child and children, keeper pty, agent process, tags, fake keeper) | 1,496 | Goes |
| `adoptKept`, `detachAll` (manager, terminals, commands), `keptSessions`, `handingOver`, the adapters' `detach()` (Claude, Codex session and client, ACP, mid-turn ledger), `shutdown.ts` detach mode, `strays.ts` rule 3, the `keptSessions` parameter of `child-ownership.ts` restores | ≈450 | Goes. Every ending becomes a stop or a stop for an update |
| Keeper-only tests: `keeper-reattach`, `sleep-keeper`, `kept-host.test-helpers`, `adapters/codex/keeper`, `adapters/claude/keeper`, `kept-ptys`, plus trims in `adopt-idle`, `host-leaving`, `lazy-resume`, `shutdown`, `work-job` | 1,330 + ≈300 | Goes |
| `swap-control.ts`: `standby`, `activate`, `drain`, `KEEPS_AGENTS_ACROSS_SWAP`, the `{swap:{keepsAgents}}` line | ≈180 of 265, test 202 | Went in PR 5; the file is `keeper-control.ts`. `ControlChannel` stays for `stop` and `system-ending` (its waiters went with the standby). `bridgeAddress` and `viewPort` stay with the front door. The `{swap:{…}}` start line stays as it is, for keepers and windows of earlier builds |
| `--standby`, `Store.inspect`, the `swap: true` open and its deferral of heavy and breaking steps | ≈110, `store-swap.test.ts` 163 | Went in PR 5. `--standby` is refused before the data folder. The open keeps running what `deferred_migrations` lists (§3.1) |
| Swap-named session tests: `background-tasks-swap`, `mail-turn-swap`, `swap-turn-lost` | 930 | Stay (PR 5 checked): they drive a restart or a stop for an update, not a swap, whatever their file names say |
| `view-handover.ts` and its test | 236 | Stays (owner decision 2): written on a stop for an update instead of a drain (PR 5) |
| `drain.ts` | 141 | Stays (the stop gate and `host.stop {ifIdle}` use `Drain`). The swap wording goes |
| `keeper-link.ts` (activity report) | 175 | Stays: the keeper's idle exit and the automatic apply read it |
| `underKeeper` in `launch-env.ts`, `main.ts`, `work-job.ts` | ≈40 | Goes where it means "holds children". `startedByServe` and `CC_STARTED_BY` stay |

**Platform and UI.** `switch-plan.ts` (437, test 433) keeps the shell-bar text, `isNewerBuild`, `shortBuild` and the
older-build text, and loses `SwapPhase`, `SwapView`, `switchPlan`, `swapProgressText`, `keeperStaysBehind`,
`swapRunning` and `KEEPER_LATER_TEXT` (≈250 + ≈250 tests). `relaunch-swap.ts` (51, test 170) goes. `build-bar.tsx`
(184) loses the swap progress. `apply-update.ts` changes its `restartsHost` rule (§3, behaviour 2). `RelaunchCheck.restartsHost`
becomes always true and then goes.

**e2e.** `relaunch.spec.ts` (120) is rewritten for stop-and-continue. `sidebar-host-swap.spec.ts` (90) loses its
first test. `control-updates.spec.ts` (220) loses the old-keeper refusal. `quit-dialog.spec.ts` and
`background.spec.ts` stay.

**Scripts and CI.** `keeper-children-integration.mjs` (219) went in PR 1, not PR 2: no host asks for children any
more, and its remaining direct-path checks moved to the `update` scenario of `keeper-integration-relaunch.mjs`
(registered in `keeper-integration.mjs`). `keeper-handoff-integration.mjs` (543),
`keeper-content-integration.mts` (353) and `keeper-integration-swap.mjs` (296) went in PR 4; the front-door checks of
the swap script moved to `keeper-integration-front-door.mjs`, which kills the host and checks that the next run is
behind the same port and token. `keeper-integration.mjs` with its harness, lifecycle, relaunch and front-door parts, `keeper-test-processes.mjs` and `shell-integration.mts` stay. The `keeper e2e`
job runs what stays. The `keeper e2e (linux)` job keeps only the crate's unit tests, since `host_proc` supervises the
Linux direct path. `host-package.mts` stops shipping and checking a keeper in `@centralu/host-linux-*`
(`hostPackageKeeper`, `keeperProblems`) and the two `package.json` files drop it. The paused branch for remote-keeper
step 3 is closed.

### 2.3 An update, and a window of another build

```
window (old)                      keeper (old)                         window (new)
 1 the host installed the update
 2 "Apply now", or idle with Automatic updates on
 3 stop {forUpdate} ───────────▶  host: stop for update (lists turns,
                                   ends children), waits ≤15 s, exits
 4 request_restart                 keeper exits
                                                                        5 opens the shell: verify, copy,
                                                                          start the new keeper from content
                                                                        6 new host continues the listed turns,
                                                                          reopens terminals and Run commands
```

A window that finds a keeper of another build (opened by hand, an older backup) offers the same stop behind the
confirmation it shows today when something would be lost, then starts its own keeper.

Considered instead: the old keeper stops its host and starts the next build's host behind the same front door, and
the keeper itself stays. That keeps the port and token across updates, which nobody needs, since the window
relaunches anyway and agents end with their host. It would keep the keeper's verify-and-copy route to the next
build's signed content (≈750 lines) and a keeper that lags its host by many releases (the keeper changed in 10 of 20
measured releases).

### 2.4 Linux release stays direct

Linux has no permission model to keep, so the shell's reason for the keeper does not apply. A Linux window runs from
its AppImage's mount, whose path changes at every launch, so the window check can accept only the window that started
the keeper ([security-boundaries/keeper.md](../security-boundaries/keeper.md)), and the keeper would
need its carried copy and AppImage code to outlive the mount. The Linux keeper never ran by default on a desktop. Moving
it there would add a path for a feature no Linux user has today. If background mode is ever wanted on Linux, the small
keeper is the place, from a known point.

## 3. Behaviour that changes

**[screen]** marks a change the person sees. Those are the owner's.

| # | What | Old | New |
|---|---|---|---|
| 1 | **[screen]** An update on macOS ("Apply now", automatic) | Turns, tool calls, background tasks, terminals and commands keep running. About 85 ms reconnect | Every running turn is stopped once and continued with Centralu's note. Terminals and Run commands reopen. A background task's loss is told to its session. A pending card closes and the agent asks again. Codex resume takes 7 to 13 s on large threads (step 3 already ships this, #1902) |
| 2 | **[screen]** Automatic updates on macOS | Apply by themselves when the keeper reports nothing busy | Proposed: the same rule, since a stop with nothing busy loses nothing. `autoApplyDecision`'s refusal for `restartsHost` changes. Owner question 3 |
| 3 | **[screen]** The build bar: a window of another build | "Switch to this build" / "Switch back to this build", then swap progress (standby, draining, switching) | A restart into this build: the same stop as an update, behind the existing loss confirmation. No progress phases. Wording: owner question 1. Built (PR 3): "Restart into this build" / "Go back to this build", and one line, "Restarting Centralu on this build…", while it runs |
| 4 | **[screen]** The host crashes (macOS) | The keeper restarts it in seconds, and agents, terminals and commands re-attach mid-turn | The keeper still restarts it by the same rules. Agents, terminals and commands end with it. A turn in flight ends with the stopped mark and Continue, as on Windows and Linux today. Crash turns are not continued by themselves: only a planned stop writes the list |
| 5 | **[screen]** The keeper is killed | The host ends with it. Held agents keep running in their own sessions, with no owner | The host ends with it, and its agents end with the host (the host watch). The window starts a new keeper. As 4 |
| 6 | **[screen]** Open app views across an update | Reopened under the same ids if at most ten minutes old (view handover) | Kept (owner decision 2): written on a stop for an update, read by the next host whoever starts it (PR 5). The address changes with the keeper, so each open view loads once more under its old id and card |
| 7 | The keeper's own update | A descriptor handoff: nothing reconnects | It ends at every update and the new window starts the new build's. The front door's port and token change at each update. A script holding the limited credential (`pnpm dev:live`) reads `keeper.sock` again, as after any keeper restart |
| 8 | The front door's port and token | Stable across host restarts, swaps and keeper handoffs | Stable across host restarts within one keeper's life only |
| 9 | "Quit and keep running", background mode, idle exit | The keeper keeps the host. It exits after 30 min with no window and no activity | Unchanged |
| 10 | Quit with background mode off, "Quit completely" | A plain stop: running turns end with the quit mark | Unchanged. Only an update continues turns. Owner question 4 |
| 11 | `host.stop` on quit | Refused to a host the app runs; the window stops it over stdin | Unchanged. `forUpdate` only for an update |
| 12 | Linked machines | No keeper on remotes. A Mac hub's update cut its links once and resumed them | Unchanged on remotes. A Mac hub's update now takes the host's full start instead of the swap's gap (Node, bundle, store open; ≈1 to 3 s estimated, not measured), so its link reconnects and its waits on remotes (`ask_project`) are cut once and retried, as on any hub. Remote-keeper's "outdated keeper" row (its decision 2) never ships |
| 13 | Linux with `CC_USE_KEEPER=1` | The keeper runs, from a carried copy | Ignored, with a line in the window's log; the host starts directly |
| 14 | Store migrations | Expand first, contract one release later; during a swap heavy and breaking steps wait until after the ready line | The expand-then-contract rule stays (§3.1). Heavy and breaking steps run at open on macOS too, as on every other machine today: an update gap grows by a heavy step's time when a release has one (v40: 1.9 s) |

### 3.1 Why the migration rule still applies

The "a step may not break the previous build" rule was written for the swap's rollback, but three readers of a newer
store remain without it:

1. **A person going back a release**, the reason [agent-host/store-migrations.md](../agent-host/store-migrations.md#migration-steps-expand-then-contract-292) gives first.
2. **A hub's automatic rollback of a linked machine.** When a new version does not say hello within 30 s, or a dev
   build cannot read the store, `links/update.ts` puts the previous version back on the store the new one may have
   migrated. That is the swap's reason, still alive on remotes.
3. **The restore point.** A build at `keeper-holding-last`, and step 3's beta, must still open a store a later build
   has migrated.

What goes is rule 5 (the swap's deferral) and the standby check (`Store.inspect`); both went in PR 5. Rules 1 to 4 and 6
stay. A store a swap left owing (`deferred_migrations` not empty) is still run by the next open, which already did that
for a host that died first (`store-migrations.test.ts`, "steps an earlier host swap left for later"). That reader stays
for good: deleting it would leave a step owed and never run.

## 4. The pull requests

Every PR after the doc lands only after the `keeper-holding-last` tag. Each one updates in the same PR the documents
for what it removes: agent-host/lifecycle/README.md, architecture.md §4.1 to §4.5, domain-model.md's keeper rows,
security-boundaries/README.md, runtime-lessons/README.md and the Korean mirrors. Line counts are estimates and include tests.

| PR | Deletes | Moves or changes | Must pass | Real-environment check | ≈ lines out |
|---|---|---|---|---|---|
| 1. Host: no held children | `agent-host/src/keeper/*`, `adoptKept`, `keptSessions`, detach mode, the adapters' `detach()`, `strays.ts` rule 3, keeper-only tests, `keeper-children-integration.mjs` (its remaining checks moved to the `update` scenario of `keeper-integration-relaunch.mjs`). Carries this doc | Every ending is a stop or a stop for an update | `pnpm verify`, `CI=1 pnpm e2e`, the Windows and macOS CI jobs | macOS packaged: kill the host mid-turn with a terminal open. The keeper restarts it, the turn shows stopped with Continue, and no agent CLI is left running (process table). Remote serve: an update from a hub still continues a turn | 3,900 |
| 2. Keeper: no children service (built) | `keeper/children/*`, `os/unix/children.rs`, the exit-watch backends but for one process, the children lines of `server/host.rs`, step 3's switch (§6). `keeper-children-integration.mjs` already went in PR 1. As built, the host's check of a beta.48 keeper's held children (`lifecycle/keeper-held.ts`, `keeper/children-client.ts`) stays: such a keeper swaps its host to this build under itself whatever this build's keeper does. It outlived PR 3 too: such a keeper starts its host from the bundle's paths, so a host that exits after the update (a crash) comes back as this build under it with no window involved. It goes with PR 6 | `children` answers an empty list. An incoming handoff whose snapshot carries a child table is refused (§6): the sending keeper rolls back and carries on. What the handoff needs to watch a handed-over host moves to `os/unix/process.rs` until PR 6; the commit stops carrying reaped statuses | `cargo test` of the crate on macOS and Linux, the `keeper e2e` job | macOS packaged: start, open a terminal, run a Run command, quit with background mode on and off | 4,100 |
| 3. Window: an update and another build are a stop (built) | the window's `switch`/`upgrade` calls, `switch_host_build`, the swap half of `switch-plan.ts`, `relaunch-swap.ts`, the build bar's progress, the start-up swap wait (#580), the relaunch grace and the keeper's `relaunching` op, the keeper half of the signed-content refusal (`refusal.rs`) | "Apply now" and the build bar call `stop {forUpdate}` and start their own keeper. `autoApplyDecision`. The owner's texts. `relaunch.spec.ts` rewritten. As built: "Apply now" is offered only by a keeper whose view says `stopsForUpdate`; another one (an earlier build, or a host it took over from one, whose stdin it does not hold) is restarted from the build bar first. The build bar's restart sends `stop {forUpdate}` to a keeper that can, a plain `stop`, always behind the loss confirmation, to one that cannot (the confirmation before `stop {forUpdate}` is asked only when the keeper does not say it is idle). It restarts by itself only with automatic updates on, an idle keeper that stops for an update, and a window newer than it. "Apply now" against a keeper whose host is not up says to wait for the host, not that the keeper is too old (review). `switch-plan.ts` keeps its name; `sidebar-host-swap.spec.ts` stays for PR 5; `keeper-held.ts` stays for PR 6 (row 2) | `pnpm verify`, `CI=1 E2E_BROWSER=webkit pnpm e2e`, the keeper relaunch script | macOS packaged: "Apply now" with a running turn, a terminal, a Run command and a pending card. An older build's window opened against a newer keeper, and the reverse | 1,400 |
| 4. Keeper: no swap, no handoff (built) | `keeper/swap.rs`, `server/switch.rs`, the swap tests, `keeper-integration-swap.mjs`, the swap's claims and freeze in `source.rs`, swap phases and the freeze in `server/push.rs`. As built it also takes the keeper half of PR 6: once no keeper switches, nothing gives or receives a handoff, so `keeper/handoff/*`, `os/unix/handles.rs`, `os/unix/process.rs`, `host_proc/handover.rs`, `no_handover.rs`, `HostProc::Foreign`, the front door's freeze and parking, the content route (`Verifier::place`, the bundle-content copy), the `test-key` feature, `keeper-handoff-integration.mjs` and `keeper-content-integration.mts` go here | `switch` and `upgrade` answer `gone: …`, saying to quit Centralu completely and open it again (review: a previous-release window offers "Restart completely" only when the host already runs its build, so the text must not lean on that button). `--take-over-fd` exits at once with code 7, which a sending keeper of an earlier build reads as an aborted handoff: it rolls back and serves on. The keeper's view drops `swap` and `keepsAgents` (every window build since step 3 reads both as optional). Any `swap` line of the host sets `host_stops_for_update` from its `stopsForUpdate` (the line keeps its name until PR 5). The handoff script's front-door checks move to `keeper-integration-front-door.mjs`. Closes #2083: the gap where the view says `done` before the host's `stopsForUpdate` line is read exists only after a swap | `cargo test`, `keeper e2e` | macOS packaged: a window of the previous release attaches to this keeper and presses "Switch back to this build": it shows the refusal text, and quitting completely and opening the installed app starts this build. A window of the previous release switches its own keeper to this build: this build's keeper exits, the previous keeper rolls back and its host serves on | 6,400 |
| 5. Host: no swap (built) | `standby`, `activate`, `drain` lines and `onDrain`, `Store.inspect`, the swap open and deferral (`swap: true`, `runDeferred`, `deferredSteps`), `store-swap.test.ts` and `store-migrations-swap.golden.json`, `refuseStandby` and its tests, `Shutdown.stopServices` and the leave's `handOver`, the start's `standby` phase, `SystemEndNotice.close`. `swap-control.ts` is renamed `keeper-control.ts`. The swap-named session tests stay (row above) | `--standby` logs a line and exits 1 before the data folder, the log or the lock, so a keeper of an earlier build that still swaps fails with its host untouched (that keeper's standby is also why a beta.48 keeper holding nothing now needs a quit to update). `activate` and `drain` get no answer: an earlier keeper that writes `drain` to a host of this build waits out its bound and signals it, a plain stop (the turns end as a quit's). The view handover is written by the stop for an update only (`stoppingForUpdate`, as the list of what it ends) and read at every start. `Drain` stays for `host.stop {ifIdle}`; its messages say restarting, not switching builds | `pnpm verify`; a store fixture with `deferred_migrations` owed is opened and run, and a step stopped part way stays owed; a real host started with `--standby` exits 1 and leaves no log, lock or store | macOS packaged: an update with an open app view in a conversation. Remote serve: a hub's update and rollback on a Linux and a Windows machine | ≈2,000 out, ≈770 in (built, documents included) |
| 6. Host: no check of a holding keeper | the host's `lifecycle/keeper-held.ts` and `keeper/children-client.ts` (row 2) and their tests. The keeper half of this row went in PR 4 | none. Lands no earlier than four releases after step 3's beta (as #461 did): a beta.48 keeper can still swap its host to this build under itself until then | `pnpm verify` | macOS packaged: an update from the `keeper-holding-last` build straight to this one, with a turn running (§5, risk 1) | 500 |
| 7. Linux: direct only (built) | `carried.rs`, `appimage.rs`, the Linux keeper rows of `start_plan` (`StartMode::Keeper`, `Reason::KeeperOptIn` and `NoShellHere`, `Os::signs_content`), the unsigned `Origin::Content` and its `signed` field, the keeper in `@centralu/host-linux-*` and its checks (`hostPackageKeeper`, `keeperProblems`, with `scripts/elf.mts` and its tests, which only they used), the AppImage's keeper and its release check (`tauri.linux.conf.json` clears `build.features`, as Windows'), the `from-a-copy` keeper scenario and the `keeper e2e (linux)` job's scripts step | `CC_USE_KEEPER` ignored on Linux, release and debug, with a log line. Before its first host a Linux window asks a keeper answering on the data folder's `keeper.sock` to stop and waits for it to go (risk 10; `os::stop_earlier_keeper`, `keeper::client::stop_and_wait`) | `cargo test` of both crates (start table, `stop_and_wait` against a keeper that removes its socket first and holds its lock while its host stops), `host-package.test.ts`, `keeper-executable.test.ts`, `keeper-integration.mjs` on macOS | Linux AppImage started with `CC_USE_KEEPER=1`, and over a keeper an earlier build left. A hub installing a host package on a linked Linux or WSL machine | ≈1,260 out, ≈230 in (code; built) |
| 8. The one-time handover | nothing of its own: step 3 built no separate module (§6). Its rule, `handoff::held_children_on_handoff`, went with PR 2's refusal and PR 4's removal of the handoff | none | — | — | 0 |

Total ≈17,800. The order keeps each PR revertable alone: 1 before 2 (a host that never asks makes the service dead
code), 3 before 4 (no window asks for a swap), 4 before 5 (no keeper sends standby or drain), 4 took the keeper's
handoff with the swap, its last caller, so 6 keeps only the host's check and its wait. PR 7 can land anywhere after 2. PR 8 has no work left (§6).

## 5. Risks

| Risk | What happens | Handled by |
|---|---|---|
| 1. A holding keeper still runs after the update to a build without the handoff (a person jumps from before step 3 straight past PR 6) | The new window finds a keeper of another build. Its `switch` would hand over to a keeper that no longer speaks the handoff channel | The window never sends `switch` after PR 3; it sends `stop {forUpdate}`. If an earlier window does switch its keeper to this build, this build's keeper exits at `--take-over-fd` (PR 4) and the sender rolls back. A keeper too old to know `forUpdate` gets a plain `stop` behind the loss confirmation: turns end with the stopped mark and Continue, nothing is orphaned. PR 6 waits four releases so most people pass through step 3's handover |
| 2. Agents left running with no owner | A holding keeper killed hard (`kill -9`, a crash) leaves its held agents in their own sessions, reparented to launchd or init | After PR 1 strays rule 3 is gone, so `strays.ts` offered them as leftovers and the person could stop them. Since #1898 the list offers only what carries the host's owner mark, which these agents predate: they are no longer offered (the owner's accepted trade-off, 2026-11-12) |
| 3. A store left locked | Ownership is an exclusive SQLite transaction that the OS releases however the holder dies, so only a live host holds it | A live old host is stopped by its keeper (risk 1). Otherwise the lock's message names who holds it, and "Restart completely" stops it. `host.lock`'s `by: 'keeper'` stays readable |
| 4. Two hosts on one store | Refused by the lock | Unchanged |
| 5. The shell starts a keeper with an argument it no longer takes | The keeper would exit and the window would fall back to the keeper beside it | `Start`'s arguments stay. A removed flag is ignored with a log line, not refused. `shell-integration.mts` stays in CI |
| 6. An older window attaches to a newer keeper, or the reverse | Fields of the keeper's view go (`swap`, `keepsAgents`) | Each window build reads them as optional (checked in PR 4: every window build since step 3). `switch` answers `gone` |
| 7. A deferred migration owed by an old swap | The step would never run | The open keeps running `deferred_migrations` (§3.1); a fixture test in PR 5 (built) |
| 8. Agent CLIs outlive their host on macOS | Without the keeper's group sweep they could stay after a crash | The host watch ends a CLI's group when the host goes, however it goes (#1654). PR 1's real check looks at the process table |
| 9. A remote's stop path breaks | `host.stop` is gated on `startedByServe && !underKeeper` | PR 1 keeps `startedByServe`. Remote serve checks in PR 1 and PR 5 |
| 10. A Linux person with `CC_USE_KEEPER=1` has an old keeper running | The direct host meets the old keeper's host on the lock | The Linux window asks a keeper answering on `keeper.sock` to stop before it starts (the same client), in PR 7 (built: plain `stop`, which a window that did not start the keeper may send) |
| 11. Rolling back to `keeper-holding-last` | Its keeper holds agents again | Supported: the store rule holds (§3.1), `keeper-settings.json` keeps its shape, and a stale `children.sock` is removed by that keeper at bind |

## 6. Step 3's switch and handover: one definition

So that the removal deletes the switch instead of leaving two paths:

- **The switch is one fact in the keeper, read at one site:** whether `server/start.rs` starts the children service
  and `server/host.rs` tells the host about it. Nothing in the host and nothing in `start_plan`: a host whose keeper
  offers no children service already spawns its own and stops them at every ending (agent-host/lifecycle/children.md), and the
  topology (shell, keeper, host) does not change. PR 2 deletes the fact with the service.
- **The handover from a holding keeper, as step 3 built it (#2055).** A host of 0.1.0-beta.48 or earlier cannot be told to
  stop for an update by its keeper (it takes the stdin stop line only from a window, and its drain hands the children over),
  so a holding keeper cannot end its turns as an update's. Step 3 therefore kept the existing handoff: an earlier build's
  window applying the update tells its keeper `relaunching`, the relaunched window switches it, and the keeper of step 3
  takes the child table over, its swapped host taking the children. That keeper keeps serving them until its next update,
  switch or quit. One rule, on the sending side of `handoff::give` (`held_children_on_handoff`), keeps holding from passing
  on: a keeper that holds children and whose host says `stopsForUpdate` never hands them on; asked to switch, it stops for
  an update and exits, and the window starts a keeper of its own build. It hands a child table on only while its host
  cannot stop for an update (an earlier build's host after a failed swap, or a host not up), and logs that.
  Whether the host can is what it said at its start (`{"swap":{...,"stopsForUpdate":true}}`), and a handoff does not
  pass `host_stops_for_update` on (`handoff/mod.rs`, the received state): a keeper that took children over with a host it
  adopted reads "cannot" until a new host starts. The transition's switch starts one (its swap), so that keeper stops
  instead at its next switch; after a handoff without a swap it hands the children on again at its next switch, and
  "Apply now" holds through the relaunch as with an earlier keeper, until its host restarts.
- **Step 4 and a handed child table: refused, not received.** Choice between keeping a path that receives a child table
  and stops it for N releases, or refusing such a handoff. Refused, from PR 2 on, because:
  1. After PR 3 no window sends `switch`, and a window names only its own build's keeper, so no keeper of PR 3 or later is
     ever the target of a handoff; between PR 2 and PR 3 the only sender with a child table is a step 3 keeper whose host
     cannot stop for an update, which is rare (a swap that failed after the transition).
  2. A received table could only be ended as a quit is: its host cannot list the turns for an update, so receiving
     would buy nothing over the refusal, and would keep the child-table code alive for N releases.
  3. Any table is refused, one with nothing running too: its descriptors include the sending host's connections to the
     children service, which taking the handoff would close under that host. The sender's own host swap still runs after
     the rollback, and the host's check let its standby through when nothing the keeper held ran (PR 2 as built; since
     PR 5 no host stands by, so that swap fails and the sender's host serves on).
  4. The refusal is the handoff's existing failure path: the sender rolls back and carries on with what it holds, the
     window shows the refusal and offers "Restart completely", and from PR 3 the window's `stop {forUpdate}`, or a plain
     `stop` behind the loss confirmation for a keeper that cannot (§5, risk 1), ends it. Nothing is orphaned.
- **The stop for an update is one keeper op** (`stop {forUpdate:true}`), shared by step 3 and by PR 3 onward.

If step 3 places the switch elsewhere, this section and the PRs that name it change before PR 1, not after.

As built, PR 4 removed the handoff whole: a keeper of PR 4 or later no longer receives one at all. A step 3 keeper
that tries to hand over to it sees it exit with code 7 (its `EXIT_ABORTED`) and keeps what it holds, as with the refusal above.

## 7. Open questions for the owner

1. **The build bar's restart into another build** (behaviour 3): the wording that replaces "Switch to this build" and
   "Switch back to this build", and whether the swap progress lines simply go.
2. **Open app views across an update** (behaviour 6): keep them (proposed, by moving the view handover to the stop for
   an update), or let them close and offer "open app".
3. **Automatic updates on macOS** (behaviour 2): apply by themselves when nothing is busy (proposed), or only on a
   click.
4. **Quit with a turn running** (behaviour 10): keep ending such turns with the stopped mark (proposed, as today), or
   continue them on the next open as an update does.
5. **Linux stays direct** (§2.4), with no background mode, and `CC_USE_KEEPER=1` goes.

Answered by the owner (recorded on #1895): 1, the swap progress goes and the wording is the implementer's (built in PR 3,
§3 row 3); 2, keep the open app views (PR 5); 3, apply by themselves when the keeper reports nothing busy (unchanged,
`autoApplyDecision`); 4, keep the stopped mark; 5, Linux stays direct (PR 7).
