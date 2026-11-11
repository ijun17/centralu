# The work list, and statements found out of date

## Statements found out of date while collecting this

Not fixed here; each belongs to the pull request that next touches its document.

- thin-shell.md §10.2 ("An unpinned shell" row), releasing.md "The macOS shell" and security-boundaries/signed-content.md
  say releases start their keeper directly until shell v1 is pinned; #450 pinned it.
- `links/tunnel.ts` says the first ssh "falls back to `~/.centralu/bin/centralu` on exit 127"; the fallback is decided
  on the remote (RE3).

## The work list: UNGUARDED rules

Every rule above that no test guards. A module is not replaced until the rows naming it have a test that fails with the
rule broken (CONTRIBUTING.md: disable the fix, watch the test fail). "Plan step" is the step of
[plans/runtime-unification.md](../plans/runtime-unification.md) §6 the row gates.

| # | Rule | Module | Platforms | Plan step |
|---|---|---|---|---|
| 1 | ST3: the dev flag becomes `CC_DEV` in the host's environment | `window/sidecar/launch.rs` | all | 7 |
| 2 | ST4: the legacy folder move runs before `create_dir_all` in the window | `window/sidecar/link.rs` | all | 7 |
| 4 | ST11: `leave_app_folder()` runs before anything is started | `window/lib.rs` | Windows | 7 |
| 5 | ST13: no console window (CREATE_NO_WINDOW, not `detached`; `windowsHide` is guarded) | `keeper/host_proc.rs`, `host/adapters/local-process.ts`, `host/apps/external/app-process.ts` | Windows | 2 |
| 10 | PA11: `taskkill` and PowerShell by System32 path | `host/os/kill-tree.ts` | Windows | 8 |
| 13 | PA14: a keeper-started codex goes through command resolution | `host/adapters/codex/index.ts` | Windows | 9 |
| 14 | PA15: a child's environment keeps `SystemRoot` | `host/` spawn sites | Windows | 9 |
| 29 | LK7: the socket path length is checked before bind | `keeper/keeper/server/start.rs` | macOS, Linux | 2 |
| 33 | SU6: a host group stop ends with KILL to the group | `keeper/host_proc.rs` | macOS, Linux | 2 |
| 35 | SU8: the window reaps every child | `window/os_integration.rs` | all | 7 |
| 36 | KL3: `stopGroup` never fires at our own group | `host/os/kill-tree.ts` | macOS, Linux | 8 |
| 37 | KL6: strays measured again before the kill; the `systemd --user` subreaper | `host/dev-services/strays.ts` | macOS, Linux | 8 |
| 38 | KL8: no HUP on Windows when closing a terminal | `host/dev-services/terminal.ts` | Windows | 8 |
| 39 | KL9: the terminal's `disposeAll` kills every tree | `host/dev-services/terminal.ts` | macOS, Linux | 8 |
| 40 | KL14: codex gets EOF before any signal | `host/adapters/codex/client.ts` | all | 8 |
| 41 | KL19: exit reported after stdout's end for the host's own processes | `host/adapters/local-process.ts` | all | 8 |
| 48 | SW12: a failed store open releases the file | `host/dev-services/store.ts` | Windows | 9 |
| 49 | SW13: migrations log on stderr | `host/dev-services/store.ts` | all | — |
| 56 | FI5 on the direct path: the AppImage's variables still reach the host the window starts itself | `window/sidecar/launch.rs` | Linux | 4b |
| 57 | TC2: the responsible process (manual probe, per shell version and major macOS) | `window/shell/` | macOS | 6 |
| 58 | TC3: a nested shell loses Screen Recording (manual) | `window/shell/` | macOS | 6 |
| 59 | HD13: a running keeper whose executable was unlinked keeps answering | `scripts/` | macOS, Linux | — |
| 59 | TC4: no extended attributes copied with the shell | `window/shell/install.rs` | macOS | 6 |
| 60 | TC6: `open` bounded at 15 s | `window/shell/start.rs` | macOS | 6 |
| 61 | TC7: a keeper exiting 3 while another answers counts as ready | `shell/run.rs` | macOS | 6 |
| 62 | TC15: one shell fallback lasts the window's life | `window/sidecar/link.rs` (`KeeperLink`) | macOS | 7 |
| 63 | TC17: trash without an automation prompt | `window/os_integration.rs` | macOS | — |
| 64 | UP1: the custom Quit item (Rust side) | `window/quit.rs` | macOS | 7 |
| 65 | UP2: the exit gate | `window/lib.rs` | all | 7 |
| 66 | UP3: under a keeper quitting only detaches | `window/sidecar/mod.rs` | all | 7 |
| 67 | UP5: relaunch through `request_restart` | `window/lib.rs` | macOS | 7 |
| 68 | UP6: the window refuses a relaunch an old keeper cannot hold | `window/sidecar/` | macOS, Linux | 7 |
| 69 | UP8: "Restart completely" starts a keeper of the window's build | `window/sidecar/link.rs` | macOS, Linux | 7 |
| 70 | UP9: `switch` names the keeper inside the bundle | `window/sidecar/link.rs` | macOS, Linux | 7 |
| 71 | RE8: `serve --stop` on Windows, in CI | `packaging/npm/centralu/bin/serve.mjs` | Windows | 10 |
| 72 | RE9: the hub's ssh in the host's process group | `host/links/tunnel.ts` | macOS, Linux | 10 |
| 73 | RE10: no `ControlMaster`/`ControlPersist` options | `host/links/tunnel.ts` | macOS, Linux | 10 |
| 74 | RE11: the port race retry | `host/links/tunnel.ts` | all | 10 |
| 75 | RE13: nothing deleted on a Windows remote before the switch | remote installer (phase 3 step 4) | Windows | 10 |
