# Who starts what

**ST1. One decision for how the host starts.**
Happened: the choice was spread over `use_keeper()` and `shell_resources()` in `sidecar.rs`, `exe::exec_target`,
`debug_assertions` at several sites and five environment variables read where they were used (#459).
Rule: every start site asks `start_plan::plan` for a `StartMode`, a host and a reason; the environment,
`cfg!(target_os)` and `debug_assertions` are read only in `Env::current`, `Os::current` and `Build::current`. The table
of modes per platform is [agent-host/lifecycle/start.md](../agent-host/lifecycle/start.md).
Guard: `keeper/start_plan/tests.rs` `every_row_of_the_start_table`; `keeper/start_plan/tests.rs` `the_plan_is_the_code_it_replaced`.
Platforms: all. *Changed by #459.*

**ST2. Dev or release is never decided by whether a bundled host exists.**
Happened: `tauri dev`'s resource folder is `target/debug`, where a bundle stays after any release build; dev then ran a
stale bundled host without `CC_DEV`, on the release data folder.
Rule: a debug build runs the source host; a bundled host counts only in a release build where `resources/host/main.mjs`
exists.
Guard: `keeper/start_plan/tests.rs` `every_row_of_the_start_table` (the macOS debug row ignores a bundled host).
Platforms: all. *Changed by #459: was unguarded in `sidecar.rs`.*

**ST3. A dev host and a release host never share a data folder.**
Happened: two hosts on one `store.db` put their session lists out of sync; a test run created
`~/.centralu/orchestrator`, and that empty folder blocked the real data move (5bf2c429).
Rule: a dev start sets `CC_DEV=1`, which selects `~/.centralu-dev`; the host pins its folder for everything below it
through `CC_DATA_DIR`; tests always set `CC_DATA_DIR`.
Guard: `keeper/start_plan/tests.rs` `every_row_of_the_start_table` (the plan's dev flag); that the window turns the
flag into `CC_DEV` in the host's environment is **UNGUARDED**.
Platforms: all.

**ST4. The legacy data folder moves before anything creates the new one.**
Happened: on the first move, the one line explaining it went to a stderr nobody reads, and anything that created
`~/.centralu` first (a log, a socket) made the move impossible (6e0af69d).
Rule: `prepare_default_dir` runs before `create_dir_all(data)`, before `keeper.log` or a socket; the move is a rename,
only when the old folder exists and the new one does not, and a failed move leaves the old folder intact.
Guard: `keeper/keeper/mod.rs` `the_legacy_folder_is_moved_before_the_new_one_exists`;
`host/data-dir.test.ts` "moves everything whole (content unchanged) when only the old folder exists";
`host/data-dir.test.ts` "does not damage the old folder when the move fails". The call order in `sidecar/link.rs` is
**UNGUARDED**.
Platforms: all.

**ST5. The keeper is its own executable and links nothing graphical.**
Happened: until beta.11 the keeper was the window's executable in a mode; a separate `centralu-keeper` is what lets it
start from verified content outside the bundle (#440, #444). Measured: 0.8 MB, `libSystem` and `libiconv` only,
against 5.4 MB with WebKit and AppKit for the window.
Rule: the keeper crate depends on no Tauri, no webview and no GUI library; the release checks the linkage.
Guard: `tooling/keeper-executable.test.ts` "links the keeper crate and nothing of the window".
Platforms: macOS, Linux.

**ST6. A debug window runs the keeper inside its own executable.**
Happened: `tauri dev` and `cargo run` build only the binary they run, so a `centralu-keeper` in `target/debug` may be
older code, and the link order of two binaries is not fixed, so file times cannot tell (#444).
Rule: debug with `CC_USE_KEEPER=1` starts the window's own executable with `--keeper` and `CC_KEEPER_IN_PROCESS=1`;
release starts the `centralu-keeper` beside the window, and never runs the keeper in the window's executable (#461).
Guard: `keeper/keeper/exe.rs` `only_a_debug_window_that_asked_runs_the_keeper_in_its_own_executable`;
`keeper/start_plan/tests.rs` `every_row_of_the_start_table`.
Platforms: macOS, Linux. *Changed by #461.*

**ST7. `--keeper` is decided before anything graphical exists.**
Happened: keepers of beta.11 and earlier hand over by starting the new build's *window* executable as
`centralu --keeper --take-over-fd 3`; that process must never open a window (#444).
Rule: `main()` checks for `--keeper` first. Unless a debug window asked (ST6), it exits at once with 64, saying
nothing on descriptor 3, so such a keeper never hears `ready` and rolls back (#461; until then it `exec`ed the
`centralu-keeper` beside it). `centralu-keeper` accepts and ignores `--keeper`: shell v1, whose bytes are pinned, still
passes it.
Guard: `keeper/keeper/mod.rs` `only_the_keeper_flag_selects_keeper_mode`; `keeper/keeper/exe.rs`
`an_old_keeper_handing_over_to_the_window_executable_gets_no_hello`. Until #1895 step 4 PR 4 also
`keeper-handoff-integration.mjs`, and by hand its `--old-keeper` against a real 0.1.0-beta.11, which rolled back; the
script went with the handoff.
Platforms: macOS, Linux. *Changed by #461.*

**ST8. The keeper starts detached and outlives the window.**
Happened: the keeper's whole point is that quitting, crashing or replacing the window sends it nothing (#280).
Rule: the window starts the keeper in a session of its own (`setsid`), stdin `/dev/null`, output to `keeper.log`; the
host's life is tied to the keeper, never to the window.
Guard: `scripts/keeper-integration.mjs` check "killing the client leaves the keeper and the host running" (the script
starts the keeper detached itself); `keeper/os/unix.rs` `a_new_session_is_led_by_the_child` (`os::new_session`, which
the product's own start, `client::spawn_detached`, calls).
Platforms: macOS, Linux.

**ST9. A keeper nobody attaches to ends by itself.**
Happened: a window that dies between starting the keeper and attaching would leave a keeper nobody watches.
Rule: no attach within 60 s ends the keeper; a window the keeper closed itself is waited for up to 5 minutes
(`REATTACH_GRACE`; the announced relaunch's grace went with #1895 step 4 PR 3); background mode on, it idles out after 30
minutes with no window and no activity.
Guard: `keeper/keeper/mod.rs` `a_keeper_nobody_attached_to_ends_after_the_grace`; `keeper/keeper/mod.rs`
`a_window_expected_back_holds_a_keeper_with_background_off`.
Platforms: macOS, Linux.

**ST10. A process LaunchServices starts gets `/` and launchd's environment.**
Happened: the shell is opened through LaunchServices, not as the window's child, so nothing of the window's
environment or folder reaches it (thin-shell.md §10.1).
Rule: everything the shell needs is an argument, every path absolute with no `..`, every flag once; the data folder is
never read from the environment; an old `-psn_` argument is ignored.
Guard: `shell/args.rs` `reads_what_the_window_passes`; `shell/args.rs` `every_malformed_command_line_is_a_usage_refusal`;
`shell/args.rs` `an_old_process_serial_number_is_ignored`.
Platforms: macOS.

**ST11. On Windows, nothing keeps a working directory inside the app folder.**
Happened: File Explorer starts an executable in its own folder and the host inherits it; the update's rename of the
app folder then failed (measured on Windows 11, #456).
Rule: before starting anything, a working directory inside the executable's folder moves to the home folder; any other
one is kept (a sibling such as `Centralu.old-1` is outside). The npm launcher starts the app from the home folder too.
Guard: `window/lib.rs` `a_working_directory_inside_the_app_folder_moves_home`; `window/lib.rs`
`any_other_working_directory_is_kept`; `tooling/launcher-platform.test.ts` "runs from the home folder, not the folder
it was started in". That `leave_app_folder()` runs first in `run()` is **UNGUARDED**.
Platforms: Windows. *Changed by #456.*

**ST12. On Windows, the launcher starts the app detached and visible.**
Happened: libuv puts a Node process's plain children in a kill-on-close job object, so the app died with the launcher's
console; `windowsHide` (SW_HIDE) hid a GUI program's first window (#328).
Rule: `centralu.exe` is started detached, with the arguments untouched and without `windowsHide`.
Guard: `tooling/launcher-platform.test.ts` "detaches, so the app outlives the launcher and its console";
`tooling/launcher-platform.test.ts` "does not ask Windows to hide the window";
`tooling/launcher-platform.test.ts` "starts centralu.exe itself, with the arguments untouched".
Platforms: Windows.

**ST13. On Windows, no child ever flashes a console.**
Happened: `detached` means DETACHED_PROCESS on Windows, which leaves a process without a console, so every console
child it starts pops a visible window (e84cf872, #14); `code.cmd` through `cmd.exe` flashed one (74c739c6).
Rule: the release window is `windows_subsystem = "windows"`; the host is created with `CREATE_NO_WINDOW`; every child
the host starts has `windowsHide: true`; agent CLIs and app processes are not `detached` on Windows (they are elsewhere,
for their own process group).
Guard: the lint rule `guard/hidden-children` (`tooling/eslint-guards.js`; every
`child_process` call under `host/`, #983, which found seventeen without it). The host's `CREATE_NO_WINDOW` and the
agent CLIs and app processes not being `detached` on Windows are **UNGUARDED** (the Windows tests inject the OS and
check only the kill paths).
Platforms: Windows. *Changed by #983: `windowsHide` was unguarded.*

**ST14. Windows has no keeper, and the bundle says so.**
Happened: the keeper is built on unix sockets, descriptor passing, process groups and `flock`; Tauri would inherit the
`keeper-exe` feature into a Windows build unless overridden.
Rule: `tauri.windows.conf.json` sets `build.features` to `[]`; the start plan ignores `CC_USE_KEEPER` on Windows.
Guard: `tooling/keeper-executable.test.ts` "is bundled on macOS and Linux, and not on Windows";
`keeper/start_plan/tests.rs` `every_row_of_the_start_table`.
Platforms: Windows.

**ST15. Linux stays on the direct path.**
Happened: the AppImage mounts its files while some process holds them; a keeper running from a newer AppImage's mount
loses its own executable when that window quits ([files.md](files.md) FI4). The keeper had never run on Linux before #458.
Rule: a Linux window, release or debug, starts the host directly and ignores `CC_USE_KEEPER` (`Reason::LinuxDirect`,
#1895 step 4 PR 7; docs/plans/keeper-removal.md §2.4). Before its first host it stops a keeper an earlier build's
`CC_USE_KEEPER=1` window left on the data folder, whose host would hold the lock. The AppImage carries no keeper.
Guard: `keeper/start_plan/tests.rs` `every_row_of_the_start_table` (the Linux rows);
`keeper/keeper/client.rs` `a_keeper_answering_is_asked_to_stop_and_waited_for_until_it_is_gone` (its lock, not its
socket, which a keeper removes before its host has stopped); `tooling/keeper-executable.test.ts`
"is bundled on macOS, and not on Windows or Linux".
Platforms: Linux. *Changed by #458, #459.*

**ST16. Secrets travel on a pipe or in the environment, are read once and removed.**
Happened: `ps` shows every argument; a shell in a project should not hold the key to every RPC (85c5b37b, #390).
Rule: the token is never an argument, and since #538 not in the host's environment either: the keeper and
`centralu serve` write it as the first line on the host's stdin (an older host under a newer keeper still gets
`CC_HOST_TOKEN`). The host reads `CC_KEEPER`, `CC_HOST_SOURCE`, `CC_FRONT_DOOR`, `CC_HOST_TOKEN` and
`CC_HOST_TOKEN_ON_STDIN` once and deletes them from `process.env` before any child is spawned; app processes get no `CC_*` and
no `CENTRALU_*` except their own id and data folder; a detached remote launcher is given no token.
Guard: `tooling/launcher-serve.test.ts` "hands the token over on stdin, never in the environment or on the command
line"; `host/lifecycle/host-process.test.ts` "takes the token from the first line on stdin, and stdin still watches
the parent after it (#538)"; `keeper/host_proc/tests.rs` `the_token_is_the_first_line_on_the_hosts_stdin_and_never_printed`;
`keeper/keeper/server/tests.rs` `a_host_gets_the_token_on_stdin`;
`tooling/launcher-serve.test.ts` "carries only the data folder, the host entry and the managed mark to a detached
launcher, never the token"; `host/lifecycle/host-process.test.ts` "the first child the host spawns sees none of the
launcher's variables, the token least of all (ST16)" (a real host whose login-shell probe records its environment);
`host/lifecycle/start.test.ts` "are read once and taken out of the environment"; `host/apps/external/lifecycle.test.ts`
"receives its data folder (created for it) and only its declared secrets, never the host's own variables" (with the
launcher's `CENTRALU_MANAGED` and `CENTRALU_HOST_ENTRY` in the host's environment). *Changed by step 3.*
Platforms: all. *Changed by #462.*
