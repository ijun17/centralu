# The process runtime: lessons already paid for

> Collected 2026-10-08 for the runtime redesign ([plans/runtime-unification.md](plans/runtime-unification.md)), at
> main after 0.1.0-beta.13 (#456–#463). Sources: the code comments of the window, the macOS shell, the keeper crate,
> the host's process code and the npm launcher; [agent-host.md](agent-host.md), [architecture.md](architecture.md) §4,
> [plans/](plans/) and [spikes/](spikes/); and the closed issues and pull requests they cite.

The process runtime is how the window, the macOS shell, the keeper, the host, the agent CLIs, terminals, commands and
a remote's `centralu serve` start, are supervised, hand over, update and stop, on macOS, Linux, Windows and remotes.
It is being redesigned in steps that each replace one module wholesale. This document is the precondition: every
rule below was learned by a failure or a measurement, and a new implementation is checked against it, not rediscovered.

**How to read an entry.**

- **Happened**: the failure or the measurement, with its issue, pull request or commit.
- **Rule**: an invariant stated so a new implementation can be checked against it.
- **Guard**: the test that fails when the rule is broken. **UNGUARDED** means nothing fails; every UNGUARDED rule is
  listed again in the [work list](#the-work-list-unguarded-rules) at the end, which is what has to be written before
  the module it concerns is replaced. *Manual* means a check done by hand (on a release, on another machine) that no
  CI job repeats.
- **Platforms**: where the rule applies.
- *Changed by #N* marks an entry that #458–#462 fixed, moved or newly guarded.

**Where the tests are.** Paths are shortened:

| Prefix | Folder |
|---|---|
| `keeper/` | `apps/desktop/src-tauri/keeper/src/` (crate `centralu-keeper-core`) |
| `window/` | `apps/desktop/src-tauri/src/` (the Tauri window) |
| `shell/` | `apps/desktop/src-tauri/shell/src/` (crate `centralu-shell`, the macOS shell) |
| `verify/` | `apps/desktop/content-verify/src/` (the verifier shared by shell and keeper) |
| `host/` | `packages/agent-host/src/` |
| `platform/` | `packages/platform/src/` |
| `tooling/`, `scripts/`, `e2e/` | as in the repository |

A Rust test is named by its function (`` `keeper/sys.rs` `a_second_lock_…` ``), a vitest or Playwright test by its
title in double quotes, and a check inside an integration script as `check "…"`. Every name below was checked with
`grep` against the tree at the commit that adds this file.

## Contents

1. [Who starts what](#1-who-starts-what) (ST)
2. [Finding and launching programs](#2-finding-and-launching-programs) (PA)
3. [The host process contract](#3-the-host-process-contract) (HO)
4. [One instance per data folder](#4-one-instance-per-data-folder) (LK)
5. [Supervising the host](#5-supervising-the-host) (SU)
6. [Stopping process trees](#6-stopping-process-trees) (KL)
7. [Children the keeper holds](#7-children-the-keeper-holds) (CH)
8. [Front door, swap and the store across builds](#8-front-door-swap-and-the-store-across-builds) (SW)
9. [The keeper handoff](#9-the-keeper-handoff) (HD)
10. [Files a running process depends on](#10-files-a-running-process-depends-on) (FI)
11. [macOS permissions and the shell](#11-macos-permissions-and-the-shell) (TC)
12. [Quit, relaunch and update](#12-quit-relaunch-and-update) (UP)
13. [Remotes: serve, ssh, PowerShell, WSL](#13-remotes-serve-ssh-powershell-wsl) (RE)
14. [How the runtime is tested](#14-how-the-runtime-is-tested) (TE)
15. [The work list: UNGUARDED rules](#the-work-list-unguarded-rules)

## 1. Who starts what

**ST1. One decision for how the host starts.**
Happened: the choice was spread over `use_keeper()` and `shell_resources()` in `sidecar.rs`, `exe::exec_target`,
`debug_assertions` at several sites and five environment variables read where they were used (#459).
Rule: every start site asks `start_plan::plan` for a `StartMode`, a host and a reason; the environment,
`cfg!(target_os)` and `debug_assertions` are read only in `Env::current`, `Os::current` and `Build::current`. The table
of modes per platform is [agent-host.md](agent-host.md) §4.0.
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
`host/data-dir.test.ts` "does not damage the old folder when the move fails". The call order in `sidecar.rs` is
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
release starts the `centralu-keeper` beside the window.
Guard: `keeper/keeper/exe.rs` `a_debug_window_keeps_the_keeper_in_its_own_executable`.
Platforms: macOS, Linux.

**ST7. `--keeper` is decided before anything graphical exists.**
Happened: keepers of beta.11 and earlier hand over by starting the new build's *window* executable as
`centralu --keeper --take-over-fd 3`; that process must never open a window (#444).
Rule: `main()` checks for `--keeper` first and then `exec`s the `centralu-keeper` beside it, keeping pid, arguments
and descriptor 3; `centralu-keeper` accepts and ignores `--keeper`. Scheduled for removal in 0.1.0-beta.16 (#461), when
`centralu --keeper` must exit with an error at once, still without a window.
Guard: `keeper/keeper/mod.rs` `only_the_keeper_flag_selects_keeper_mode`; `keeper/keeper/exe.rs`
`exec_keeps_the_arguments_and_the_handoff_descriptor`.
Platforms: macOS, Linux.

**ST8. The keeper starts detached and outlives the window.**
Happened: the keeper's whole point is that quitting, crashing or replacing the window sends it nothing (#280).
Rule: the window starts the keeper in a session of its own (`setsid`), stdin `/dev/null`, output to `keeper.log`; the
host's life is tied to the keeper, never to the window.
Guard: `scripts/keeper-integration.mjs` check "killing the client leaves the keeper and the host running" (the script
starts the keeper detached itself). That the product's own start (`client::spawn_detached`, `keeper::exe::Start`)
puts the keeper in a new session is **UNGUARDED**.
Platforms: macOS, Linux.

**ST9. A keeper nobody attaches to ends by itself.**
Happened: a window that dies between starting the keeper and attaching would leave a keeper nobody watches.
Rule: no attach within 60 s ends the keeper; an announced relaunch holds it up to 60 s (at most 300 s); background mode
on, it idles out after 30 minutes with no window and no activity.
Guard: `keeper/keeper/mod.rs` `a_keeper_nobody_attached_to_ends_after_the_grace`; `keeper/keeper/mod.rs`
`the_relaunch_grace_is_bounded`.
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
Guard: **UNGUARDED** (the Windows tests inject the OS and check only the kill paths).
Platforms: Windows.

**ST14. Windows has no keeper, and the bundle says so.**
Happened: the keeper is built on unix sockets, descriptor passing, process groups and `flock`; Tauri would inherit the
`keeper-exe` feature into a Windows build unless overridden.
Rule: `tauri.windows.conf.json` sets `build.features` to `[]`; the start plan ignores `CC_USE_KEEPER` on Windows.
Guard: `tooling/keeper-executable.test.ts` "is bundled on macOS and Linux, and not on Windows";
`keeper/start_plan/tests.rs` `every_row_of_the_start_table`.
Platforms: Windows.

**ST15. Linux stays on the direct path until the keeper runs from a copy.**
Happened: the AppImage mounts its files while some process holds them; a keeper running from a newer AppImage's mount
loses its own executable when that window quits (§10 FI4). The keeper had never run on Linux before #458.
Rule: a Linux release starts the host directly unless `CC_USE_KEEPER=1` (`Reason::KeeperOptIn`); the keeper becomes
the default only after it runs from `<data>/content/<version>/`.
Guard: `keeper/start_plan/tests.rs` `every_row_of_the_start_table`.
Platforms: Linux. *Changed by #458, #459.*

**ST16. Secrets travel in the environment, are read once and removed.**
Happened: `ps` shows every argument; a shell in a project should not hold the key to every RPC (85c5b37b, #390).
Rule: the token is never an argument. The host reads `CC_KEEPER`, `CC_HOST_SOURCE`, `CC_FRONT_DOOR` and
`CC_HOST_TOKEN` once and deletes them from `process.env` before any child is spawned; app processes get no `CC_*` and
no `CENTRALU_*` except their own id and data folder; a detached remote launcher is given no token.
Guard: `tooling/launcher-serve.test.ts` "passes the token in the environment, never on the command line";
`tooling/launcher-serve.test.ts` "carries only the data folder, the host entry and the managed mark to a detached
launcher, never the token"; `host/apps/external/lifecycle.test.ts` "receives its data folder (created for it) and only
its declared secrets, never the host's own variables". The deletion in `main.ts` and the `CENTRALU_*` stripping are
**UNGUARDED**.
Platforms: all. *Changed by #462.*

## 2. Finding and launching programs

**PA1. A GUI app does not inherit the login shell's PATH.**
Happened: an app opened from Finder gets `/usr/bin:/bin:/usr/sbin:/sbin`; the packaged app could not find `node`
(m2-f0-bundling.md trap 4), and on the first dogfooding day claude and codex showed as not installed (8f5f42eb). A
fixed Homebrew list missed nvm, mise and volta. Dev mode inherits the terminal's PATH and hides all of it.
Rule: anything that looks up node, claude, codex or git in a tree started by the GUI or launchd asks the person's
interactive login shell once (`$SHELL -ilc`, a marked line only, merged after the inherited PATH, static folders as
the fallback). Changes touching PATH are checked in the packaged app.
Guard: `host/env-path.test.ts` "finds a tool the shell knows even from the GUI app's meager PATH" (returns early when
the machine's shell finds nothing, so on CI it usually asserts nothing); `keeper/host_proc.rs`
`finds_the_node_this_shell_knows`. A probe that finds a tool on a bare PATH in CI is **UNGUARDED**.
Platforms: macOS, Linux.

**PA2. The login-shell probe is bounded and cannot be stopped by a terminal.**
Happened: some shells ignore SIGTERM, and a hung probe meant the host never became ready (cfe32262). Under a
controlling terminal (the npm launcher runs the AppImage attached to one) an interactive bash in its own process group
is stopped by SIGTTOU, so the keeper's probe waited out 5 s every time (measured, #458).
Rule: the host's probe: 3 s, `SIGKILL`, stdin ignored, `TERM=dumb`, `CI=1`, any failure falls back. The keeper's
probe: a session of its own, 5 s, then the group is killed.
Guard: **UNGUARDED** (nothing runs a hanging or terminal-stopped probe).
Platforms: macOS, Linux. *Changed by #458.*

**PA3. The probe runs once per process.**
Happened: every terminal created ran a login shell first, 1 to 4 s each (7a3149e4).
Rule: the probe result is memoized for the life of the host.
Guard: `host/dev-services/terminal.test.ts` "opening several in a row does not repeat the shell probe".
Platforms: macOS, Linux.

**PA4. The window finds `code` from a fixed list, not from a login shell.**
Happened: the GUI PATH has no `code` (#159); a login shell per click costs about a second.
Rule: look in the known install places, including the copy inside the VS Code bundle.
Guard: `window/ide.rs` `gui_path_still_finds_homebrew_code`; `window/ide.rs` `gui_path_finds_the_bundled_code_without_any_link`.
Platforms: macOS.

**PA5. The keeper finds Node and never remembers a miss.**
Happened: a failed lookup was cached, so installing Node and pressing Retry kept failing (#184).
Rule: a found Node is remembered, a missing one is asked again; on Windows, Node is looked for where its installers
put it and never in a relative PATH entry.
Guard: `keeper/host_proc.rs` `a_missing_node_is_not_remembered_but_a_found_one_is`; `keeper/host_proc.rs`
`looks_where_windows_installers_put_node`; `keeper/host_proc.rs` `a_relative_path_entry_is_never_searched`.
Platforms: all.

**PA6. Windows has no login shell to ask.**
Happened: a `SHELL` set on Windows is Git Bash's POSIX path, which cannot be run (#14).
Rule: no probe on Windows; the fallback folders are `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, `%LOCALAPPDATA%\Volta\bin`
and the profile's `.local\bin`, `.bun\bin`, `.cargo\bin`, `scoop\shims`.
Guard: `host/env-path.test.ts` "falls back to the folders Windows installers write to, not unix ones". The skip of
the probe itself is **UNGUARDED**.
Platforms: Windows.

**PA7. On Windows a tool is looked up by PATHEXT, folder by folder, in absolute entries only, whatever the case of
`Path`.**
Happened: `npm i -g` writes `claude` (an sh script), `claude.cmd` and `claude.ps1`; the bare-name lookup returned the
sh script and both CLIs showed as not installed. A relative PATH entry resolves against the working directory, which
may be a cloned repository. A copy of the environment keeps Windows' spelling `Path` (#14, e84cf872, 3c9c0469).
Rule: try each PATHEXT extension in each folder in order; skip relative entries; read `Path` and `PATHEXT` case-
insensitively.
Guard: `host/env-path.test.ts` "returns the .cmd, not the sh script npm writes beside it under the bare name";
`host/env-path.test.ts` "tries the PATHEXT extensions in order, folder by folder"; `host/env-path.test.ts` "never
searches a relative PATH entry, which would resolve against the working directory"; `host/env-path.test.ts` "reads
Path and Pathext whatever their case, as a copy of the Windows environment spells them".
Platforms: Windows.

**PA8. A merged PATH is compared as a list.**
Happened: the Windows runner's PATH repeats entries; a merge that added as many folders as there were duplicates kept
the same length and was taken for unchanged (d33c1a16).
Rule: compare element by element, deduplicate keeping order.
Guard: `host/env-path.test.ts` "a PATH with as many duplicates as new folders still gets the new folders, once each".
Platforms: all.

**PA9. A `.cmd` or `.bat` is never spawned; the program it names is.**
Happened: since the fix for CVE-2024-27980, Node refuses a `.cmd` without `shell: true` (EINVAL), and a shell would
read `%`, `^`, `&` and quotes in our JSON and prompt arguments as its own syntax (#307, e84cf872).
Rule: on Windows a `.cmd`/`.bat` is read; its first quoted `%dp0%`/`%~dp0` target that is not `node.exe` is started:
a `.js` through the host's own Node, an `.exe` directly. Never `shell: true`. A shim whose target is missing is left
as it is, so the error names the real file.
Guard: `host/tool-launch.test.ts` "npm: the .js entry, skipping the optional node.exe beside the shim";
`host/tool-launch.test.ts` "a .js behind an npm shim runs through the host's own Node, ahead of the tool's arguments";
`host/tool-launch.test.ts` "an .exe behind a shim is started directly"; `host/tool-launch.test.ts` "a shim whose
target is gone is left alone, so the spawn error names the real file"; `host/tool-launch.test.ts` "off Windows nothing
is rewritten".
Platforms: Windows.

**PA10. Node's own `npm.cmd` and `npx.cmd` are not shims.**
Happened: the in-app update ran `execFile('npm')`: ENOENT by name (libuv tries only `.com` and `.exe`), EINVAL by
path. Builds up to beta.12 failed every in-app update on Windows with "spawn npm ENOENT" (#456, f303259b).
Rule: follow `"%NODE_EXE%" "%X%" %*` and `SET "X=%~dp0..."`, prefer the npm in the global prefix as the batch file
does, and run npm as Node plus `npm-cli.js`. Every command the updater runs goes through the same resolution.
Guard: `host/tool-launch.test.ts` "npm.cmd starts npm-cli.js beside Node when the global prefix has no npm of its
own"; `host/tool-launch.test.ts` "after `npm i -g npm`, the npm in the global prefix, as the batch file itself would
choose"; `host/updates.test.ts` "npm runs as Node and npm-cli.js, never as a bare name or a .cmd";
`host/updates.test.ts` "npm i -g reaches npm-cli.js with its arguments as given" (runs on Windows only).
Platforms: Windows. *Changed by #456.*

**PA11. On Windows a bare name is looked up in the working directory first.**
Happened: Windows process creation searches the child's working directory before PATH; every git call runs in the
project, so a `git.exe` committed at a repository root would have run on the first status read (#14).
Rule: git, gh, app manifest commands, `taskkill` and PowerShell are started by absolute path (`%SystemRoot%\System32\…`
for the system tools).
Guard: `host/tool-launch.test.ts` "on Windows git is spawned by its absolute path, so a git.exe at a repository root
is never the one run"; `host/tool-launch.test.ts` "`node` becomes the absolute node.exe on PATH, never one in the app
folder". The System32 paths for `taskkill` and PowerShell (`kill-tree.ts`, `host_proc.rs`) are **UNGUARDED**.
Platforms: Windows.

**PA12. The packaged host hands the Claude SDK the CLI it found.**
Happened: bundling the host broke the SDK's lookup of its own native binary, so every session creation failed in the
packaged app (47c010f3).
Rule: always pass `pathToClaudeCodeExecutable`; a shim becomes its `.js` entry or `.exe`.
Guard: `host/adapters/claude/windows-start.test.ts` "off Windows the path found on PATH is started as it is". The shim
conversion (`toolExecutable`) is **UNGUARDED**.
Platforms: all.

**PA13. The dev host is started directly, never through a wrapper.**
Happened: killing the pnpm wrapper left the host orphaned holding its port (M1.5 defect 1, three hosts); on Windows
`.bin/tsx` is an sh script `CreateProcessW` cannot start.
Rule: start `node_modules/.bin/tsx` (unix) or Node with tsx's `cli.mjs` (Windows) directly, in a process group of its
own.
Guard: **UNGUARDED** in Rust; `scripts/keeper-integration.mjs` check "stop ends the host and the keeper even with
background mode on" covers the group stop only.
Platforms: all.

**PA14. A codex started by the keeper would hit the `.cmd` refusal on Windows.**
Happened: found while collecting this list: under the keeper, codex is spawned as `whichTool('codex') ?? 'codex'`
without `launchFor`; `CodexClient` applies it only when it spawns codex itself. Latent: Windows has no keeper.
Rule: every spawn, by the host or by the keeper on the host's behalf, goes through the same command resolution.
Guard: **UNGUARDED**.
Platforms: Windows (when it gets a keeper).

**PA15. A child Node on Windows needs `SystemRoot`.**
Happened: a child Node started with a scrubbed environment and no `SystemRoot` could not start (4fc4f9ff, #307).
Rule: an environment built for a child keeps `SystemRoot` (and the other variables Windows itself needs).
Guard: **UNGUARDED**.
Platforms: Windows.

## 3. The host process contract

**HO1. stdout carries the handshake and nothing else.**
Happened: the ready line carries the token, so stdout must never reach a file; the opposite failure also happened: a
migration announced itself on stdout and left no trace in a Finder-launched app.
Rule: stdout carries only protocol lines (`ready`; under a keeper `swap`, `activity`, `standby`, `drained`) and final
refusals; diagnostics go to stderr; the stderr copy to `host.log` never includes stdout; lint allows only
`console.error`/`warn` outside `main.ts`.
Guard: `host/log-file.test.ts` "teeStderrToFile does not touch stdout — the token goes out that way".
Platforms: all.

**HO2. A final refusal is written synchronously to stdout and stops the retries.**
Happened: a lock conflict went to stderr only; the supervisor reads stdout, so it retried six times and showed
"exited (code 1)" (#184, 71ffb7f9). A store too new to read (#292) is the same kind.
Rule: write the refusal with `writeSync` to fd 1 (stdout to a pipe is asynchronous on macOS and `process.exit`
follows) and to stderr, exit 1 with no ready line. The supervisor stops at "already using this data" and "written by a
newer Centralu"; those phrases are a contract.
Guard: `host/dev-services/instance-lock.test.ts` "a blocked host also writes the reason to stdout, and exits with 1";
`host/dev-services/store-min-reader.test.ts` "a host given a store it cannot read says so on stdout and exits with 1";
`keeper/host_proc.rs` `another_owner_of_the_data_is_reported_at_once`; `keeper/host_proc.rs`
`a_store_too_new_is_final_like_a_lock_conflict`.
Platforms: all.

**HO3. Logging starts before anything else.**
Happened: a Finder-launched app has stderr on `/dev/null`; a day was lost to codex's real error line landing nowhere
(15bff4fe), and the first data move's explanation was lost (6e0af69d).
Rule: the stderr copy to `<data>/host.log` starts as soon as the data folder is known, before PATH, the lock and the
store; the banner (build, Node, pid, db) is the first line.
Guard: `host/log-file.test.ts` "text written to stderr also remains in the file"; `host/log-file.test.ts` "the startup
banner states the build, DB, and pid on its own". The order in `main.ts` is **UNGUARDED**.
Platforms: all.

**HO4. Log rotation never keeps a closed descriptor number.**
Happened: after a failed rename the closed fd number stayed in use; the OS reissued it to the SQLite WAL, a pty or a
socket, and later log lines corrupted those (3492dd38). `host-errors.log` grew hundreds of MB a day.
Rule: the fd is cleared on close even when the rename fails; every log keeps one previous generation past 8 MiB; a
logging failure never throws.
Guard: `host/log-file.test.ts` "does not hold onto a dead fd when the rollover fails, and keeps writing to the same
file"; `host/log-file.test.ts` "rolls over and keeps only one prior generation once it overflows (does not silently eat
up the folder)". Rotation of `host-errors.log` in `main.ts` is **UNGUARDED**.
Platforms: all.

**HO5. One path to exit, and it is the full shutdown.**
Happened: an early SIGINT/SIGTERM handler released the lock and called `process.exit(0)`; handlers run in order, so
the real shutdown never ran: every quit orphaned claude and codex and skipped the WAL checkpoint (3492dd38).
Rule: the only signal handler that leads to exit is the shutdown; the lock is released in `process.on('exit')`.
Guard: `tooling/launcher-serve.test.ts` "serves on 127.0.0.1 with its token, reports itself in --connection, refuses a
second serve, and stops on SIGTERM" (POSIX).
Platforms: macOS, Linux.

**HO6. A signal during startup is held, not obeyed.**
Happened: until a listener exists the kernel default kills the process; Ctrl+C right after the ready line killed
`centralu serve`'s host every time, and 3 s later shut it down cleanly (#390, 8cf2dd28).
Rule: holding handlers are installed right after the lock is taken; the first signal runs the shutdown as soon as it
exists; a second one during startup exits at once with 1.
Guard: `tooling/launcher-serve.test.ts` "passes Ctrl+C (SIGINT) to the host, which shuts down cleanly". The second
signal is **UNGUARDED**.
Platforms: macOS, Linux.

**HO7. The host ends when its parent's pipe closes, and only when asked to watch it.**
Happened: an exit hook alone left an orphaned host holding its port when the parent was SIGKILLed (8cc60ff0); deciding
by "is stdin a TTY" made a host with stdin on `/dev/null` kill itself (M1.5 defect 4).
Rule: only a supervisor passes `--watch-parent`; then stdin `end`/`close`/`error` is "parent gone" and the host shuts
down (detach under a keeper's child service, otherwise stop). Without the flag stdin EOF means nothing. This is the
only parent-death signal on Windows.
Guard: `tooling/launcher-serve.test.ts` "takes the host down when the launcher itself is killed, instead of leaving
it unsupervised"; `scripts/keeper-integration.mjs` check "a SIGKILLed keeper takes its host with it". The no-flag half
is **UNGUARDED**.
Platforms: all.

**HO8. Shutdown order: ptys first, the store last, every close runs once.**
Happened: the supervisor allows 3 s before SIGKILL; pty children run in their own session, so a group kill cannot
reach them, and ptys disposed after `await mgr.disposeAll()` were never reached (3492dd38). When one step threw, the
store stayed open with its WAL unfolded, and on the signal path the host never exited (#396, bda7de5c).
Rule: in stop mode terminals and commands are disposed synchronously before any await; app processes stop in parallel
with sessions; the server closes last among services, then the store and the keeper connection; every close runs even
after a failure, the first error wins; `shutdown()` runs at most once and always ends with its log line and exit 0.
Guard: `host/shutdown.test.ts` "a close that throws does not skip the next one"; `host/shutdown.test.ts` "run when a
step threw, and the step's error is the one that comes out". The pty-first order and the run-once guard are
**UNGUARDED**.
Platforms: all (the setsid point is POSIX).

**HO9. Shutdown finishes within the supervisor's budget.**
Happened: a socket that connected but never said hello held `http.close()` open (5 s and counting, against 2 ms after
the fix); a peer that never answers a close frame makes `ws` wait 30 s (#82, 18541dcf).
Rule: close every socket, 250 ms grace, then terminate; `closeAllConnections()`; a second close is the same promise.
Guard: `host/transport/server.test.ts` "cuts a peer that never answers the close frame after the grace period";
`host/transport/server.test.ts` "does not wait for a half-sent HTTP request"; `host/transport/server.test.ts` "a second
close() is the same shutdown, not a new one". The never-authenticated socket is **UNGUARDED**.
Platforms: all.

**HO10. Rejections are survived; uncaught exceptions shut down in order.**
Happened: one rejection that leaked while adding a project killed the host and every unrelated session, and the
packaged app had no stderr to say why (df8ad446).
Rule: `unhandledRejection` is logged to stderr and `host-errors.log` and survived; `uncaughtException` is logged and
runs the normal shutdown.
Guard: **UNGUARDED**.
Platforms: all.

**HO11. Nothing is pushed to clients before the server exists.**
Happened: an adopted pty replays its output as soon as it is attached; an await added before the server was declared
(#329) made every host restart that held a terminal crash, five times, until the keeper gave up (#348, ea5a9611).
Only a hand run noticed.
Rule: early frames are dropped (services keep their own scrollback); broadcasts before listen are swallowed.
Guard: `scripts/keeper-children-integration.mjs` check "the keeper restarts a crashed host". No unit test:
**UNGUARDED** in vitest.
Platforms: macOS, Linux.

**HO12. The keeper's control lines reach only a host the keeper started.**
Happened: under the keeper, the host's stdin carries JSON control lines (#280 step 3); anyone else's stdin is not the
host's to read.
Rule: the control channel is attached only with `CC_KEEPER=1`; one object per line, anything else ignored, a buffer
past 64 KiB without a newline dropped; when the stream ends every waiter is rejected.
Guard: `host/swap-control.test.ts` "reads one JSON object per line, across chunk boundaries, and ignores anything
else"; `host/swap-control.test.ts` "a waiter is rejected when the keeper closes the pipe". The 64 KiB cap is
**UNGUARDED**.
Platforms: macOS, Linux.

**HO13. The host listens on loopback only, and a busy port is a sentence.**
Happened: a port conflict crashed the host because `ws` re-emits the HTTP server's error (m1-result.md).
Rule: listen on `127.0.0.1`; EADDRINUSE becomes a readable message and exit 1 with no ready line; `wss.on('error')`
is always attached.
Guard: **UNGUARDED** (the launcher test matches a log line, not the socket).
Platforms: all.

**HO14. A failed spawn fails one session, never the host.**
Happened: ENOENT (after an nvm switch, or codex removed) arrives as `error`; without a listener it is an uncaught
exception that kills the host and every live session.
Rule: every child has an `error` listener; the failure ends only its session and `onExit` fires once; EPIPE on a
child's stdin (git, an app's fd 3) is swallowed.
Guard: `host/adapters/codex/client.test.ts` "a nonexistent command fails only this session, without killing the
process". The EPIPE listeners (`git-exec.ts`, `app-process.ts`) are **UNGUARDED**.
Platforms: all.

**HO15. Detach or stop is decided by whether the keeper holds the children.**
Happened: under the keeper's child service a signal means a restart and the agents stay; without it, it is a stop
(#280 step 2).
Rule: on a signal the mode is detach only when held children exist; the keeper's `stop` forces stop; ssh links and
app processes always end with the host.
Guard: **UNGUARDED** at the `main.ts` level.
Platforms: all.

## 4. One instance per data folder

**LK1. One keeper per data folder, by `flock`, not a pid file.**
Happened: the kernel releases the lock on SIGKILL or a crash, so no stale lock is ever judged (#278).
Rule: a held lock with a socket that answers exits 3; a held lock with a silent socket retries up to 15 s, then exits 4.
Guard: `keeper/keeper/sys.rs` `a_second_lock_on_the_same_file_is_refused_until_the_first_is_dropped`;
`scripts/keeper-integration.mjs` check "a second keeper on the same folder defers to the first (exit 3)".
Platforms: macOS, Linux.

**LK2. One host per data folder, by a lock the OS releases.**
Happened: the check-then-write `host.lock` gave two owners when eight hosts started at once, and a second acquire in
the same process succeeded (#82, c1693343).
Rule: the host holds `BEGIN EXCLUSIVE` on `host-ownership.sqlite` (DELETE journal, `timeout: 0`) for its whole life;
busy or locked means held, any other error refuses the start; the handle stays reachable so garbage collection cannot
close it. Not valid on network file systems.
Guard: `host/dev-services/instance-lock.test.ts` "of hosts started at the same moment, exactly one owns the folder";
`host/dev-services/instance-lock.test.ts` "the operating system releases ownership when the owner is SIGKILLed — the
next host starts"; `host/dev-services/instance-lock.test.ts` "an ownership file that cannot be read refuses the start
instead of guessing". Keeping the handle from collection is **UNGUARDED**.
Platforms: all.

**LK3. A pid is not an identity.**
Happened: after a SIGKILL or a power loss, a pid in `host.lock` reused by an unrelated process blocked every start
with no window to close (#184). A Korean-locale writer and a C-locale reader read the same start time differently.
Rule: record pid and start time; same pid, other start time means reused; an unreadable start time blocks; `ps` runs
with `LC_ALL=C`; `kill(pid, 0)` failing with EPERM means alive.
Guard: `host/dev-services/instance-lock.test.ts` "even with a living pid, a different start time means the number was
reused by someone else — it is taken over"; `host/dev-services/instance-lock.test.ts` "blocked when that pid's current
start time cannot be read — stealing the lock when in doubt is the riskier choice". `LC_ALL=C` and EPERM are
**UNGUARDED**.
Platforms: macOS, Linux.

**LK4. On Windows a pid in `host.lock` refuses nothing.**
Happened: Windows has no start time and reuses pids quickly, so a stale file named a live, unrelated process and
refused every start while the real lock was free (979edf00, #14).
Rule: the legacy check is off on Windows; ownership is the SQLite lock alone.
Guard: `host/dev-services/instance-lock.test.ts` "on Windows a live pid left in host.lock does not refuse a host that
holds ownership".
Platforms: Windows.

**LK5. Release only your own lock.**
Rule: on release, unlink `host.lock` only if its pid is ours; the conflict message names the lock path.
Guard: `host/dev-services/instance-lock.test.ts` "never releases someone else's lock (that would defeat the point of
the block)".
Platforms: all.

**LK6. A stale socket belongs to whoever holds the lock.**
Rule: the lock holder removes and rebinds `keeper.sock`; a stopping keeper removes its socket before it stops
anything, so the next keeper waits on the lock, not on a dead socket.
Guard: `scripts/keeper-integration.mjs` check "a new keeper takes over the folder (stale socket and all)";
`scripts/keeper-integration.mjs` check "the socket is removed on the way out".
Platforms: macOS, Linux.

**LK7. A unix socket path is at most 104 bytes on macOS.**
Happened: tests use short `/tmp` paths on purpose; a long `CC_DATA_DIR` fails at bind with only a log line and exit 5.
Rule: check the socket path length before binding and say which folder is too deep.
Guard: **UNGUARDED** (no preflight exists).
Platforms: macOS (108 on Linux).

**LK8. The keeper's sockets are private from birth.**
Rule: sockets are created under umask 077 (no window before a chmod); every connection's peer uid must match.
Guard: `keeper/keeper/children/tests.rs` `the_socket_is_private_to_this_user`; `keeper/keeper/sys.rs`
`the_peer_of_our_own_socket_is_us`; `scripts/keeper-integration.mjs` check "the control socket is user-only (0600)".
Refusing a foreign uid is **UNGUARDED**.
Platforms: macOS, Linux.

## 5. Supervising the host

**SU1. A crash loop gives up, and some refusals are final.**
Rule: five consecutive failures give up; backoff 400 ms doubling to 5 s; 30 s of uptime resets the count; a deliberate
bounce is not counted; a lock conflict and a too-new store are not retried.
Guard: `keeper/host_proc.rs` `counts_consecutive_failures_and_gives_up_after_five`; `keeper/host_proc.rs`
`a_death_after_a_stable_run_starts_the_count_over`; `keeper/host_proc.rs` `backoff_doubles_and_stops_at_five_seconds`;
`keeper/host_proc.rs` `a_deliberate_bounce_starts_again_without_counting`.
Platforms: all.

**SU2. Retry after giving up starts one watcher, never two.**
Happened: Retry did not restart the host, then could start a second watcher (#184).
Rule: a supervisor that gave up can be claimed again, forgetting the old error and any failed Node lookup; nothing
restarts while the app is quitting.
Guard: `keeper/host_proc.rs` `a_supervisor_that_gave_up_can_be_claimed_again`; `keeper/host_proc.rs`
`no_restart_while_the_app_is_quitting`.
Platforms: all.

**SU3. Stopping the host: its pid first, a real grace, then the group.**
Happened: a 300 ms grace cut the WAL checkpoint short (1ecb7393); a group TERM first would hit codex directly, which
leaves its thread lock behind on SIGTERM (#57).
Rule: TERM the host's pid alone, wait 3 s, then TERM its group; on unix stdin stays open until the end so EOF does not
race TERM into a second shutdown.
Guard: **UNGUARDED** in Rust (only the integration stop checks touch it).
Platforms: macOS, Linux.

**SU4. Signals go through `kill(2)`, to a real pid or group only.**
Happened: `kill_group` ran `/bin/kill -TERM -<pid>`; procps-ng 4.0.3/4.0.4 (Ubuntu 24.04) read `-<pid>` as an option
and signalled the group named by the pid's first digit: `-130` became `kill(-1, SIGTERM)`, every process of the user,
on every quit of the direct path Linux runs (#350, fixed by #458).
Rule: call `kill(2)` directly; refuse 0, 1 and numbers past `i32::MAX`; never signal the caller's own group; never
shell out to `kill`.
Guard: `keeper/host_proc.rs` `kill_group_signals_the_group_the_pid_leads_and_nothing_else`; `keeper/host_proc.rs`
`signals_go_only_to_a_real_pid_or_group`.
Platforms: macOS, Linux. *Changed by #458.*

**SU5. On Windows the polite stop is closing stdin, and the kill is checked.**
Happened: Windows has no TERM; quitting stalled for the full grace, then hard-killed a host that never released its
lock (#307).
Rule: close the host's stdin, wait the grace, then `taskkill /T /F` only if the host is still running (an ended pid
may already be someone else's).
Guard: **UNGUARDED**.
Platforms: Windows.

**SU6. A host's group stop does not escalate.**
Happened: found while collecting this list: the group gets TERM only, then the leader alone gets KILL, so a stuck
grandchild in the group survives.
Rule: a group stop ends with KILL to the group, like the children's stop (CH8).
Guard: **UNGUARDED**.
Platforms: macOS, Linux.

**SU7. A host the keeper did not start is supervised by pid.**
Rule: a handed-over host is not the keeper's child: it is watched and waited on by pid; EPERM from `kill(pid, 0)`
means alive.
Guard: **UNGUARDED** in Rust; `scripts/keeper-handoff-integration.mjs` stops a foreign host at its end.
Platforms: macOS, Linux.

**SU8. The window reaps every child it starts.**
Happened: fire-and-forget children (alerts, `open`) left a zombie each (40d3565e).
Rule: every child the window spawns is waited on.
Guard: **UNGUARDED**.
Platforms: all.

## 6. Stopping process trees

These are the host's own rules for what it starts without a keeper (terminals, commands, app processes, and agents on
Windows and in debug builds). The keeper's equivalents are §7.

**KL1. Stop signals the tree, not the shell.**
Happened: node-pty's `kill()` signals one pid; commands run as `zsh -lc <cmd>`, so the shell died and the dev server
kept its port (63c27e84).
Rule: Stop signals the process group, TERM then KILL after 3 s.
Guard: `host/dev-services/commands.test.ts` "stop sends SIGTERM to the process group, and SIGKILL if it is still
alive after the grace period"; `host/dev-services/commands.test.ts` "no SIGKILL if it dies within the grace period —
a polite exit is honored".
Platforms: macOS, Linux.

**KL2. An interactive shell puts each job in its own group.**
Happened: a server started in a terminal tab had its own pgid; killing the shell's group missed it, and a server that
handles HUP survived quitting (d2993770).
Rule: walk `ps -A -o pid=,ppid=,pgid=` from the root and signal every group a descendant belongs to.
Guard: `host/dev-services/kill-tree.test.ts` "an interactive shell: a job with its own group is a target too";
`host/dev-services/kill-tree.test.ts` "follows all the way to a grandchild — a tree, not a list of children".
Platforms: macOS, Linux.

**KL3. Never our own group, init or group 0.**
Rule: our pgid and every pgid ≤ 1 are excluded from every shot.
Guard: `host/dev-services/kill-tree.test.ts` "never fires at our own group — killing ourselves during cleanup would
leave the rest behind"; `host/dev-services/kill-tree.test.ts` "init(1) and group 0 are never targets — this is where
the system itself could almost be fired at". The own-group return in `stopGroup` is **UNGUARDED**.
Platforms: macOS, Linux.

**KL4. A pid missing from `ps` is gone; fire nothing at it.**
Happened: the second shot assumed a pid missing from `ps` led its own group, which could SIGKILL whoever got the
recycled number (e7ea439a).
Rule: `ps` read and the root absent means no targets; fall back to `-root` only when `ps` itself failed; the same pid
in another group is someone else.
Guard: `host/dev-services/kill-tree.test.ts` "fires at nothing when ps was read but root is missing — this is where a
recycled pid could be hit"; `host/dev-services/kill-tree.test.ts` "the same pid in a different group is someone else
— a spot where the number was recycled in the meantime".
Platforms: macOS, Linux.

**KL5. The second shot aims at what the first shot saw.**
Happened: the root died on TERM, its children were reparented to init, a re-walk from the root found nothing and a
grandchild survived (#149, 65acb436).
Rule: the KILL targets the groups of whatever from the first list is still there with the same pid and pgid, plus
anything they started since.
Guard: `host/dev-services/kill-tree.test.ts` "even when the grandchild is in root's group (zsh -lc, an app process)
and the caller saw root end, it is hit by SIGKILL after the grace period";
`host/dev-services/kill-tree.test.ts` "even if root dies first, a surviving descendant in that group fires at the
whole group".
Platforms: macOS, Linux.

**KL6. What escaped the tree is shown, not killed.**
Happened: a dev server an agent started had ppid 1 and its own group; the VS Code Claude extension was SIGTERMed by
an early version (4a69b96f).
Rule: a stray is offered only when its cwd is inside a project, it has no tty, it is not under the host or a keeper
child, and its parent chain reaches init through other candidates; it is measured again right before the kill.
Guard: `host/dev-services/strays.test.ts` "picks only someone else's process running with no terminal in our
folder"; `host/dev-services/strays.test.ts` "a process a living app still holds is not on the list (VS Code
extensions)"; `host/dev-services/strays.test.ts` "never offers a child the keeper holds for this host, or what runs
under it". Measuring again before the kill is **UNGUARDED**; on a systemd desktop orphans go to the `systemd --user`
subreaper, not to pid 1, and the finder misses them: **UNGUARDED** (#14 audit).
Platforms: macOS, Linux.

**KL7. An agent's helpers end with it.**
Happened: only the CLI's pid was signalled; typescript-language-server and tsserver (one at 3.4 GB), MCP servers and
shells were reparented to launchd or init (#435, b1ffaca3).
Rule: the CLI leads a process group of its own; a stop signals that group only; after the CLI exits its group is swept
(TERM, KILL after the grace). On Windows: `taskkill /T /F`, and after exit the leftovers found by parent pid and
creation time.
Guard: `host/adapters/local-process.test.ts` "leads a process group of its own, not the host’s";
`host/adapters/local-process.test.ts` "a CLI that exits by itself does not leave its helper running";
`host/adapters/local-process.test.ts` "a stop is taskkill on its tree, and its exit collects what it left running";
`host/adapters/claude/local-spawn.test.ts` "spawns the CLI itself, and stopping it ends the helper the CLI leaves
behind".
Platforms: all.

**KL8. Closing a terminal takes the tree, then hangs up.**
Happened: `close()` sent SIGHUP to the shell only, and a job-control server that ignored HUP kept its port (#435).
Rule: `stopTree` while the shell is alive (the tree is only visible under it), then HUP; no HUP on Windows.
Guard: `host/dev-services/terminal.test.ts` "closing one also ends a server started from its shell that ignores the
hang-up". The Windows branch is **UNGUARDED**.
Platforms: all.

**KL9. Quitting kills every pty tree at once.**
Happened: dispose sent one HUP, and a server that handles HUP outlived quitting (d2993770).
Rule: dispose sends KILL to every live pty's tree with no grace.
Guard: `host/dev-services/commands.test.ts` "an app shutdown (disposeAll) sends SIGKILL to the group immediately —
there is no process to wait a grace period for". The terminal's `disposeAll` is **UNGUARDED**.
Platforms: macOS, Linux.

**KL10. A group whose leader exited is still swept.**
Happened: an app that exited cleanly left a helper in its group, which ignored TERM and was orphaned (9a8a56f0).
Rule: `stopGroup(pgid)` in two shots; safe because a pgid is not reused while it has members.
Guard: `host/apps/external/lifecycle.test.ts` "even a descendant left by an app that ended cleanly on its own is
collected — its entire group is ended".
Platforms: macOS, Linux.

**KL11. On Windows node-pty takes no signal, and there is one shot.**
Happened: `kill("SIGTERM")` throws on Windows; Stop, restart, project removal and shutdown did nothing, and a throw from
a pty that was not ready crashed the host (#14, 46e78012).
Rule: `taskkill /PID n /T /F`, then `kill()` with no argument, both failures swallowed; no second shot by pid (it may
be someone else's by then).
Guard: `host/dev-services/kill-tree.test.ts` "the tree goes with taskkill, and the pty is closed without a signal";
`host/dev-services/kill-tree.test.ts` "Stop is one forceful shot: no second shot by pid after the grace period".
Platforms: Windows.

**KL12. On Windows leftovers are found by parent and creation time.**
Happened: Windows has no groups, so a helper outlived its app; libuv's job object hides this for plain Node children
but not for detached or Python ones (285be4e9, #360).
Rule: list processes through CIM; take the dead root's children created inside its lifetime, and deeper children no
older than their parent; `taskkill` each, never ourselves, never throw.
Guard: `host/dev-services/kill-tree.test.ts` "a child created after the root was seen to end belongs to a later
holder of that number"; `host/apps/external/lifecycle.test.ts` "on Windows, a descendant started outside the app's job,
left by an app that ended on its own, is ended — no orphan is left behind".
Platforms: Windows.

**KL13. A replaced handle's late events are ignored.**
Happened: `restart()` killed the old pty; its exit arrived after the new pty took the slot and marked the terminal dead
(3492dd38); a replaced Claude handle's late crash killed the new one (#157).
Rule: events act only when they come from the current handle; dispose terminates the Claude process, and an error after
close is not a crash.
Guard: `host/dev-services/terminal.test.ts` "a late exit from the old shell does not overwrite the new shell";
`host/adapters/claude/index.test.ts` "does not raise a crash even when the stream ends with an exception after closing,
and terminates the process on close (#157)".
Platforms: all.

**KL14. Codex is closed with stdin EOF, not a signal.**
Happened: measured with codex-cli 0.147: EOF exits in 18 ms and removes `thread-writer-locks/<id>.lock`; SIGTERM
leaves it, and the thread stays locked (#57, df9651ee).
Rule: end stdin, wait up to 2 s, then KILL.
Guard: `host/adapters/codex/client.test.ts` "expected=true when we close it — does not report it as having died". That
EOF comes before any signal is **UNGUARDED**.
Platforms: all.

**KL15. On Windows closed Claude processes are given time to leave.**
Happened: libuv's job object kills children when the Node parent exits, possibly while Claude writes a refreshed token;
an idle claude left 0.6–0.9 s after its stdin closed (#353).
Rule: before the host exits, wait up to 1.5 s for the processes disposal closed.
Guard: `host/adapters/claude/windows-start.test.ts` "waits for the closed Claude processes to leave by themselves";
`host/adapters/claude/windows-start.test.ts` "never longer than its cap".
Platforms: Windows.

**KL16. App processes stop by closing their input, then their tree.**
Happened: closing only stdin did not end a Node app holding fd 3 or the Python SDK's read thread; three fixture apps
were found orphaned (9a8a56f0).
Rule: close stdin and fd 3 together, wait the grace, then stop the tree; `dispose` stops every process ever spawned,
including ones no entry holds.
Guard: `host/apps/external/lifecycle.test.ts` "closing stdin and fd 3 together lets even an app holding fd 3 open end
on its own within the grace period"; `host/apps/external/lifecycle.test.ts` "when the host exits (dispose), every
running app stops".
Platforms: all.

**KL17. Removing a project ends what runs in it.**
Happened: deleting a project left its terminals and Run-menu processes running until the app quit (#177, #201).
Guard: `host/project-delete-processes.test.ts` "a deleted project's terminals and executions end, and do not come back
when the same folder is re-added".
Platforms: all.

**KL18. On Windows a process holds its working directory.**
Happened: Windows refuses to move a folder that is some process's cwd (EBUSY); a process stops answering
`kill(pid, 0)` a few ms before it releases that handle (#360, #415).
Rule: stop the process and wait for its tree before moving or removing its folder.
Guard: `host/sessions/mcp-apps.test.ts` "removing a user-folder app drops it from the list and the orchestrator, and its
folder goes to app-trash" (catches EBUSY only on the Windows CI job).
Platforms: Windows.

**KL19. stderr is always read, and exit comes after the last output.**
Happened: a CLI whose stderr nobody reads blocks once the pipe is full; a reader saw the exit before the last line
(b1ffaca3).
Rule: stderr is read and its last 8 KB kept for crash messages; exit is reported on stdout's end or after 1 s.
Guard: `host/adapters/claude/local-spawn.test.ts` "a failure still carries the end of what the CLI wrote to stderr".
Exit-after-output for the host's own processes is **UNGUARDED**.
Platforms: all.

**KL20. On Windows the app's fd 3 is overlapped.**
Happened: on a plain pipe, Windows serializes I/O on the synchronous handle; the app's read blocked its own write and
every broker call timed out on the first Windows run (eeed2312).
Rule: `stdio: ['pipe', 'pipe', 'pipe', 'overlapped']`.
Guard: `host/apps/external/mediation.test.ts` "accepts a broker call carrying its own run id — a request never declared
is refused by the desk with a reason" (catches it only on the Windows CI job).
Platforms: Windows.

## 7. Children the keeper holds

**CH1. Every child runs in a session of its own.**
Happened: claude and codex shared the host's process group, so a host's exit or group kill reached them (#280).
Rule: `setsid` for every child; a pty child gets `TIOCSCTTY`; pid ≤ 1 is never signalled.
Guard: `keeper/keeper/children/proc.rs` `a_child_runs_in_a_session_of_its_own_and_its_exit_status_is_seen`;
`keeper/keeper/children/proc.rs` `only_known_signal_names_are_accepted`; `keeper/keeper/children/proc.rs`
`a_pty_child_sees_a_terminal_of_the_asked_size_and_follows_a_resize`.
Platforms: macOS, Linux.

**CH2. The keeper owns the pty and always drains it.**
Happened: node-pty kept the master in the host, so a host that went away took the screen and, with SIGHUP, the shell. A
pty child cannot finish exiting while its output is unread: bash stuck in `?Es` for over 5 s (#280).
Rule: the keeper opens the pty and drains it continuously into a 256 KiB ring, replayed to the next host; a slow reader
skips ahead instead of holding the child.
Guard: `keeper/keeper/children/tests.rs` `an_unwatched_pty_is_drained_so_its_child_can_exit`;
`keeper/keeper/children/buffer.rs` `a_slow_pty_reader_skips_ahead_instead_of_holding_the_child`.
Platforms: macOS, Linux.

**CH3. EIO from a pty master is end of file.**
Rule: a read returning EIO once every slave descriptor is closed ends the stream normally.
Guard: **UNGUARDED** (only implied by the pty tests).
Platforms: macOS, Linux.

**CH4. `openpty` does not set close-on-exec.**
Rule: set `FD_CLOEXEC` on both ends, or every later child inherits every pty.
Guard: **UNGUARDED**.
Platforms: macOS, Linux.

**CH5. An agent's stdout is a protocol: never drop a byte.**
Happened: claude was measured buffering 60 s with stdout unread; one codex `thread/resume` answer was 23 MB on one
line; Node's `readline` cut that line in two and the resume hung forever (448815d2).
Rule: buffer losslessly up to 64 MiB, then stop reading so the child blocks; hand over whole lines only; a lost
reader's half line goes whole to the next; only whole lines reach the child's stdin. Readers split on `\n` by hand.
Guard: `keeper/keeper/children/buffer.rs` `a_full_agent_stream_stops_reading_instead_of_dropping`;
`keeper/keeper/children/buffer.rs` `a_line_half_sent_to_a_lost_reader_is_sent_whole_to_the_next`;
`keeper/keeper/children/tests.rs` `half_a_line_from_a_host_that_died_never_reaches_the_child`;
`host/adapters/codex/client.test.ts` "a 24MB single-line response arrives intact".
Platforms: all.

**CH6. A long-lived process gives memory back.**
Happened: `Vec::drain` keeps capacity, so one 23 MB line pinned more than 32 MiB for days; the control-queue cap could
never fire (#392, #395, aab29764); exit records were never forgotten.
Rule: buffers shrink once mostly empty (1 MiB floor); the 8 MiB control-queue cap is checked whatever the flush did;
released children's exit records are dropped.
Guard: `keeper/keeper/children/buffer.rs` `a_burst_gives_its_memory_back_once_it_is_sent`;
`keeper/keeper/children/tests.rs` `a_control_queue_past_the_cap_is_dropped_while_the_socket_is_full`;
`host/keeper/agent-process.test.ts` "forgets an exit once the child is released (#392)".
Platforms: macOS, Linux.

**CH7. No connection closing ever signals a child.**
Happened: the Agent SDK kills its process when its owner exits; a host leaving for a restart must leave its agents
untouched (#280).
Rule: only an explicit request signals a child, closes its stdin or its pty; a detached handle ignores `kill()` and
`stdin.end()`; the SDK's exit hook is neutralised by a `process.once('exit')` registered at module load.
Guard: `keeper/keeper/children/tests.rs` `a_departing_host_does_not_end_the_child_and_the_next_host_gets_what_it_missed`;
`host/keeper/agent-process.test.ts` "sends no signal and no EOF once detached, and the process keeps running";
`host/adapters/codex/keeper.test.ts` "detaching sends no EOF and no signal, and denies nothing". The module-load exit
hook (`hostLeaving`) is **UNGUARDED**.
Platforms: macOS, Linux.

**CH8. The keeper's stop escalates in a fixed order.**
Rule: the host stops its own children first (up to 6 s); then stdin EOF for pipes and SIGHUP for ptys; TERM to the
group after 2 s; KILL 1 s later; then `children.sock` is removed.
Guard: `keeper/keeper/children/tests.rs` `stop_all_ends_pipes_and_ptys_the_host_left_running`;
`keeper/keeper/children/tests.rs` `asking_the_host_to_stop_waits_for_it_to_hang_up`;
`scripts/keeper-children-integration.mjs` check "the host stopped its children itself first".
Platforms: macOS, Linux.

**CH9. The keeper's agent sweep never hits a reused number.**
Happened: the keeper side of #435.
Rule: when a pipe child exits, TERM its group at once and KILL it after 2 s; never while any process holds that pid
(an unreaped zombie, a reuse); never pgid ≤ 1 or the keeper's own group; ptys are not swept; pending sweeps travel in
the handoff; `stop_all` kills leftover sweeps.
Guard: `keeper/keeper/children/tests.rs` `an_agents_helpers_do_not_outlive_it`; `keeper/keeper/children/tests.rs`
`a_helper_that_ignores_term_is_killed_and_nothing_outside_the_group_is_touched`; `keeper/keeper/children/tests.rs`
`stop_all_ends_the_helpers_of_agents_that_exited_during_the_stop`; `keeper/keeper/handoff/tests.rs`
`a_sweep_still_waiting_at_the_handoff_is_finished_by_the_next_keeper`.
Platforms: macOS, Linux.

**CH10. The exit of a process you did not start.**
Happened: after a handoff the keeper is not its children's parent. kqueue `NOTE_EXIT | NOTE_EXITSTATUS` reports a
non-child's status on macOS, but registering on a child that is already a zombie fails with ESRCH (Darwin 27,
2026-10-04); Linux has a pidfd, and no non-parent status before `PIDFD_GET_INFO` (6.15).
Rule: macOS: kqueue, polling plus the status the outgoing keeper reaped as the fallback; Linux: a pidfd per child and
`/proc/<pid>/stat` field 52 while the zombie lasts; elsewhere polling; `NOTE_EXIT` can fire before the zombie is
waitable, so the reap is retried.
Guard: `keeper/keeper/children/proc.rs` `the_exit_of_a_process_that_is_not_our_child_is_seen`;
`keeper/keeper/children/proc.rs` `a_status_from_the_outgoing_keeper_completes_a_polled_child`;
`keeper/keeper/children/proc.rs` `a_zombie_exit_status_is_read_from_proc_stat`.
Platforms: macOS, Linux.

**CH11. A graceful stdin close is a request, not a socket end.**
Rule: `stdin.end()` on a kept agent becomes the keeper's `close_stdin`, so codex can remove its lock (KL14).
Guard: `host/keeper/agent-process.test.ts` "ends stdin with a keeper close_stdin request, and reports the exit after
the output".
Platforms: macOS, Linux.

**CH12. Re-attaching across hosts and builds.**
Happened: measured 2026-10-04/05: claude's re-`initialize` re-delivers a pending approval; codex rejects a second
`initialize` with "Already initialized" and `thread/resume` re-sends approvals; an adopted app-server can deliver
answers meant for the previous host's requests; an in-process tool call in flight when the old host died is never
answered (#280, #342).
Rule: tags are opaque to the keeper and parsed by the host, unknown kinds left alone, tags without a version still read;
new ids never collide with kept ones; codex request ids carry a per-client prefix; the second `initialize` is ignored
only for an adopted process; a lost in-process call is failed out loud and the turn interrupted.
Guard: `host/keeper/held-children.test.ts` "leaves a child with a tag it does not read alone — a newer build may have
spawned it"; `host/dev-services/kept-ptys.test.ts` "keep their ids and replayed screen, and new ones never reuse a kept
id"; `host/adapters/codex/keeper.test.ts` "request ids carry a per-client prefix, so an answer meant for the old host
cannot resolve a new request"; `host/adapters/codex/keeper.test.ts` "adopts a running app-server: the second initialize
is shrugged off and the pending approval comes back"; `host/adapters/claude/keeper.test.ts` "a call to an in-process
tool lost with the old host is failed out loud and the turn released".
Platforms: macOS, Linux.

**CH13. Without a keeper the host owns its children.**
Rule: if connecting to `children.sock` or listing fails, the host spawns and stops its children itself (Windows, debug,
`centralu serve`).
Guard: **UNGUARDED** (the keeper tests are skipped on Windows, and nothing tests the fallback itself).
Platforms: all.

**CH14. A kept process pins the CLI it started with.**
Happened: the keeper can hold an agent process forever, so a session keeps running the CLI that was installed when it
started (#297).
Rule: an idle, quiet (60 s) session on an older CLI is restarted on the installed one; unknown on either side is not
older; versions are read without running npm's program.
Guard: `host/agent-versions.test.ts` "restarts a live, idle, quiet session that runs an older CLI";
`host/sessions/agent-versions-restart.test.ts` "stops the held child and spawns a new one from the installed CLI —
nothing is re-attached".
Platforms: all.

**CH15. A kept process reports its exit like node-pty, after its output.**
Rule: wait for the stream to end (at most 1 s), flush the decoder, report a signalled pty as `exitCode: 0` plus the
signal, report a lost keeper as SIGHUP, then release the child.
Guard: `host/keeper/agent-process.test.ts` "delivers output and exit like node-pty, then releases the record";
`host/keeper/agent-process.test.ts` "reports an exit when the keeper itself goes away, since the pipes went with it".
The signal shape and `KeeperPty`'s lost keeper are **UNGUARDED**.
Platforms: macOS, Linux.

## 8. Front door, swap and the store across builds

**SW1. What long-lived clients hold outlives every host.**
Happened: a restart that changed port or token left the UI "disconnected" (M1.5 defect 2, e5d43cd1); a Codex bridge
reads its address once per thread, so a new port or token silently cut every bridge.
Rule: the keeper's front door keeps one port and token for its life and hands the token to every host; bridges and app
views get the front door's address, derived HTTP secret included.
Guard: `scripts/keeper-integration.mjs` check "the host is given the front door’s token, so clients keep one token
across hosts"; `host/swap-control.test.ts` "under a keeper is the front door, which outlives this host, and not the
host’s own port"; `host/transport/server.test.ts` "is the same for every host given the same keeper token, differs per
token, is a valid secret and is not the token".
Platforms: macOS, Linux.

**SW2. A connection made while no host is ready is held.**
Happened: measured: a client cut by a swap was greeted by the new host 84–86 ms later.
Rule: hold new connections up to 45 s rather than refuse them.
Guard: `keeper/keeper/front_door.rs` `a_connection_made_while_no_host_is_ready_is_held_until_one_is`.
Platforms: macOS, Linux.

**SW3. A relay whose peer stops reading is let go.**
Happened: writes are blocking; a peer that stopped reading held its relay thread and blocked every handoff, since a
freeze waits for each relay (#392).
Rule: a 30 s write limit on both relay sockets.
Guard: `keeper/keeper/front_door.rs` `a_client_that_stops_reading_is_let_go`.
Platforms: macOS, Linux.

**SW4. The next host checks itself before the running one drains.**
Rule: a `--standby` host opens the store read-only, refuses a store it cannot read before anything stops, takes no lock,
migrates nothing, attaches nothing, and exits untouched if the keeper abandons the swap.
Guard: `host/swap-control.test.ts` "reports its schema check and waits for activate before it takes anything over";
`host/swap-control.test.ts` "refuses a store this build cannot read, before the running host is asked to drain";
`host/swap-control.test.ts` "exits without touching anything when the keeper abandons the swap".
Platforms: macOS, Linux.

**SW5. Draining is bounded by what was measured.**
Happened: measured 2026-10-04: orchestrator tools took at most 0.2 s and app tools at most 5.6 s over 88 calls; all
tool calls: p99 78 s, longest 4.5 h.
Rule: drain only calls the host serves itself, 10 s, then cut with a retryable error; release the lock even if detach
threw.
Guard: `host/drain.test.ts` "cuts a call still running at the bound with a retryable error, and does not wait for it";
`host/swap-control.test.ts` "a failing detach still lets go of the lock, or the next host could never start".
Platforms: macOS, Linux.

**SW6. A swap that fails falls back to the build that served.**
Rule: a standby failure leaves the running host untouched; a failure after the drain starts the old build again from
its kept copy, never retries the new one; a connection that read the old target is turned away by generation.
Guard: `keeper/keeper/swap.rs` `a_host_that_exits_before_standby_is_reported_in_its_own_words`;
`scripts/keeper-integration.mjs` check "the failure after the drain is reported, with the previous build started
again". The generation race is **UNGUARDED**.
Platforms: macOS, Linux.

**SW7. A host refuses a store from a newer build before writing anything.**
Happened: an older host opened a newer store silently; even running `schema.sql` would recreate, empty, a table the
newer build dropped (#292, b62f5b8f).
Rule: `min_reader_version` is checked before the WAL switch, `schema.sql` or any migration.
Guard: `host/dev-services/store-min-reader.test.ts` "a store a newer Centralu made unreadable to this host is refused,
naming both versions, and left untouched".
Platforms: all.

**SW8. Migrations expand first and contract a release later.**
Happened: of the first 40 steps, v13, v28 and v32 broke the previous build (2026-10-04), and the previous build is the
one still serving during a swap or a remote rollback.
Rule: every step declares `breaksOlderReaders` and `heavy`; drops and renames land one release after the code stopped
using what they remove; a breaking step raises `min_reader_version` before it runs. One step back is the only safe
rollback.
Guard: `host/dev-services/store-min-reader.test.ts` "every step declares whether it breaks older readers; v13, v28 and
v32 do, and v3, v11, v21 and v40 are heavy"; `host/dev-services/store-min-reader.test.ts` "applying a breaking step
raises the record to that step".
Platforms: all.

**SW9. During a swap only what the previous build can read runs.**
Rule: expand steps run at activation; heavy and breaking ones are written to `deferred_migrations` in the same commit
and run after the ready line, one commit at a time.
Guard: `host/dev-services/store-swap.test.ts` "runs the expand steps now and leaves a heavy step for after the swap";
`host/dev-services/store-swap.test.ts` "a breaking step waits too, and min_reader_version only rises once it runs";
`host/dev-services/store-swap.test.ts` "a swap stopped as it leaves a step for later still owes that step (#396)".
Platforms: macOS, Linux.

**SW10. A step commits whole, with its version.**
Happened: a start killed between two ALTERs of one step left the first column added, and the next start skipped the
step for good (#396, bda7de5c).
Rule: a step, its floor raise and its `user_version` bump are one transaction; VACUUM runs after the commit, owed
through a marker.
Guard: `host/dev-services/store-durability.test.ts` "a step that fails half way leaves neither its first change nor the
new version"; `host/dev-services/store-durability.test.ts` "the next open vacuums".
Platforms: all.

**SW11. The WAL is bounded and a checkpoint never waits.**
Happened: a 97 MB WAL next to a 91 MB database after a SIGKILL; 146 MB for days after a swap's VACUUM; a TRUNCATE
checkpoint blocked the event loop for the 5 s busy timeout, past the 3 s shutdown budget (1ecb7393).
Rule: set `synchronous=FULL`, `busy_timeout=5000`, `journal_size_limit`; checkpoint on open, after deferred steps and on
close, with `busy_timeout` 0.
Guard: `host/dev-services/store-durability.test.ts` "the settings a file store depends on are set by the store itself";
`host/dev-services/store-durability.test.ts` "a checkpoint with another connection reading reports it did not fold,
without waiting".
Platforms: all.

**SW12. A failed open releases the database file.**
Happened: on Windows an open file cannot be renamed or deleted, so a refused open kept `store.db` locked until the
process ended (#360).
Rule: the store closes its handle on any failure before rethrowing.
Guard: **UNGUARDED**.
Platforms: Windows.

**SW13. A long migration says so.**
Happened: beta.4 reworked a 151k-message store for over 10 s in silence; it looked frozen and the person quit.
Rule: log "migrated vA → vB (n steps, ms)" and the deferred steps to stderr.
Guard: **UNGUARDED**.
Platforms: all.

**SW14. A newer window must read an older host.**
Happened: a newer window crashed on an older host because results skipped the schema defaults (#337, #339).
Rule: every added payload field has a default and the client parses tolerantly.
Guard: `e2e/older-host.spec.ts` "a window on an older host draws its sessions and a conversation without crashing".
Platforms: all.

**SW15. A host names its build from its own code.**
Rule: the commit is the compiled-in one, never the keeper's record; a malformed record is ignored rather than failing
the start.
Guard: `host/keeper-link.test.ts` "keeps its own commit when the record names another"; `host/keeper-link.test.ts`
"starts with what it has when the record is unreadable".
Platforms: all.

**SW16. One idle rule.**
Happened: counting a finished turn (`waiting_input`) as busy kept every session that had ever answered in the way, and
idle exit and automatic updates never fired (f5894d37).
Rule: busy is a working or approval-waiting session, a pending question or background work, an open terminal or a
running command; unknown counts as busy.
Guard: `host/keeper-link.test.ts` "is not busy with a session whose turn finished and waits for the next message
(waiting_input)"; `host/keeper-link.test.ts` "is busy with an open terminal or a running command".
Platforms: all.

## 9. The keeper handoff

**HD1. Start the next keeper, pass every handle, let the old one exit.**
Happened: `exec` would keep the pid and descriptors on macOS and Linux but has no Windows equivalent, so the direction
is the same everywhere (#280 step 4).
Rule: A starts B with a `socketpair` end at B's descriptor 3 (no path, peer uid still checked); the lock's open file
description, every listener, every child's pipes or pty, every relayed connection and every attached window pass to B;
nothing reconnects; keeper first, then the host, so the newer side always reads the older side's state.
Guard: `scripts/keeper-handoff-integration.mjs` check "keeper B still holds every child"; `scripts/keeper-handoff-integration.mjs`
check "the keeper and the host both end on build C".
Platforms: macOS, Linux (Windows: `DuplicateHandle`, not built).

**HD2. A descriptor batch that finds no room waits for it.**
Happened: "Switch to this build" failed with "Message too long (os error 40)" with 4 agents, 2 terminals and 7 app
views: on macOS a `sendmsg` carrying descriptors on a stream socket fails at once with EMSGSIZE when the 8 KiB send
buffer has less room than the batch; about 8,000 bytes before a batch failed, 4,000 and 20,000 passed (#387,
9d66f03c). Linux blocks: the sweep passes there at 16 KiB and 208 KiB even with the retry disabled (#458).
Rule: EMSGSIZE, ENOBUFS and EAGAIN mean wait for room and retry, up to 30 s; a batch carries one byte, so a failed
attempt sent nothing; at most 64 descriptors per batch, after all bytes.
Guard: `keeper/keeper/handoff/wire.rs` `descriptors_wait_for_room_after_bytes_that_nearly_fill_the_buffer`;
`keeper/keeper/handoff/wire.rs` `descriptors_arrive_whatever_the_bytes_before_them` (every 256 bytes to three buffers'
worth, and each of the last 320); `keeper/keeper/handoff/wire.rs` `a_message_carries_its_header_blobs_and_working_descriptors`.
Platforms: macOS (Linux checked by the same sweep).

**HD3. A message sent just before the peer closed is still read.**
Happened: macOS refuses `SO_RCVTIMEO` with EINVAL once the peer has closed; A sends `commit` and exits at once, so B
lost the commit and the exit statuses in it (#387).
Rule: `recv` ignores EINVAL from setting its timeout.
Guard: `keeper/keeper/handoff/wire.rs` `a_message_sent_just_before_the_peer_closed_is_still_read`.
Platforms: macOS.

**HD4. Received descriptors are close-on-exec, and a truncated batch fails.**
Rule: Linux receives with `MSG_CMSG_CLOEXEC`; elsewhere `FD_CLOEXEC` is set on each descriptor after `recvmsg`;
`MSG_CTRUNC` is an error.
Guard: **UNGUARDED**.
Platforms: macOS, Linux.

**HD5. The channel survives `exec`, and nothing else inherits it.**
Happened: older keepers start the window executable, which `exec`s `centralu-keeper` (ST7).
Rule: `dup2` to descriptor 3 and clear `FD_CLOEXEC` before `exec`; clear it once more in `exe::exec`; the incoming
keeper sets close-on-exec on the channel at once.
Guard: `keeper/keeper/exe.rs` `exec_keeps_the_arguments_and_the_handoff_descriptor`;
`scripts/keeper-handoff-integration.mjs` check "keeper A is the process started as `centralu --keeper`".
Platforms: macOS, Linux.

**HD6. The snapshot only grows, and the newer side reads the older.**
Happened: the outgoing keeper is always the older build in an update.
Rule: `HANDOFF_PROTOCOL` is checked both ways; new snapshot and child-table fields have defaults. (#461 proposes
requiring them after beta.16, so an old snapshot rolls back instead.)
Guard: *Manual*: `scripts/keeper-handoff-integration.mjs --old-keeper` against a real 0.1.0-beta.11; no CI job runs an
old keeper: **UNGUARDED** in CI.
Platforms: macOS, Linux.

**HD7. A rollback says how the incoming keeper ended.**
Happened: when B exited before `ready` the read error said only "failed to fill whole buffer" (#368, #441).
Rule: on EOF, reset or broken pipe, wait up to 2 s for B's exit and report its code or signal.
Guard: `keeper/keeper/handoff/tests.rs` `an_incoming_keeper_that_exits_is_reported_by_how_it_exited`;
`keeper/keeper/handoff/tests.rs` `an_incoming_keeper_that_does_not_answer_is_reported_as_silent`.
Platforms: macOS, Linux.

**HD8. The outgoing keeper freezes; it never reads ahead.**
Happened: a byte A read but did not deliver would be lost with A (#280).
Rule: every reader stops between units (host lines, relay copies, child-table passes) and hands over what it holds;
packing duplicates descriptors so a rollback finds everything open; before `ready` any failure rolls back; after it A
never resumes and exits without running destructors; B starts no I/O until `commit`.
Guard: `keeper/host_proc.rs` `a_frozen_host_reader_hands_over_what_it_read_and_stops_between_lines`;
`keeper/keeper/front_door.rs` `a_relayed_connection_survives_a_handoff_of_the_door`; `keeper/keeper/handoff/tests.rs`
`a_child_table_handed_over_carries_on_with_no_line_lost_or_doubled`; `keeper/keeper/handoff/tests.rs`
`a_thawed_child_table_carries_on_as_if_nothing_happened`; `keeper/keeper/handoff/pack.rs`
`packing_duplicates_so_the_original_stays_usable`; `scripts/keeper-handoff-integration.mjs` check "the terminal counter
is continuous across the handoff".
Platforms: macOS, Linux.

**HD9. If A dies after `ready`, B takes over only if A is gone.**
Rule: B's failed wait for `commit` means: A alive, exit; A gone, take over (B holds the only copy of everything).
Guard: **UNGUARDED**.
Platforms: macOS, Linux.

**HD10. The lock passes with no gap.**
Rule: B gets the same open file description of `keeper.lock`, so `flock` is held throughout; B proves it with a
`try_lock` on the passed descriptor; the holder record is rewritten from offset 0 (the offset is shared).
Guard: `scripts/keeper-handoff-integration.mjs` check "a third keeper is turned away (B holds keeper.lock)";
`scripts/keeper-handoff-integration.mjs` check "keeper.lock records keeper B".
Platforms: macOS, Linux.

**HD11. A reaps at the commit and passes the statuses.**
Rule: A is still the parent; children that exited during the freeze are reaped by A and their statuses sent in
`commit` (kqueue on a zombie fails, CH10).
Guard: `keeper/keeper/handoff/tests.rs` `the_reaped_list_reads_back_as_written` (the format only); the behaviour is
**UNGUARDED**.
Platforms: macOS, Linux.

**HD12. A fix in the sending keeper cannot reach an update.**
Happened: the EMSGSIZE fix lives in the outgoing keeper, and in an update that is the old build, which still failed on
every try; the window kept offering "Switch to this build" (#391, dbe96997).
Rule: ask of every compatibility fix which side runs the code during an update. A failed handoff still lets the host
switch run; once the host is on the window's build, a keeper left behind is a note with "Restart completely", never a
retried switch.
Guard: `platform/tauri/switch-plan.test.ts` "reads the host on this build with the keeper left behind as running the
new version, not as a failure"; `platform/tauri/switch-plan.test.ts` "does not switch by itself again either". That the
keeper falls through to the host swap after a rolled-back handoff is **UNGUARDED** in the keeper crate.
Platforms: macOS, Linux.

**HD13. A running executable that is unlinked keeps running; one overwritten in place may not.**
Happened: `tauri build` deletes and rewrites the bundle; `centralu install` does `rmSync` then `ditto`. A probe that
overwrote a running keeper's file in place saw it answer for 3 s, but any page not yet loaded comes from the new file.
Rule: nothing overwrites a running executable in place; replace by unlink or rename.
Guard: `scripts/keeper-handoff-integration.mjs` check "keeper A keeps running and answering from its unlinked
executable".
Platforms: macOS, Linux.

## 10. Files a running process depends on

**FI1. A host never runs from files an update rewrites.**
Happened: a host running from the bundle read the Codex bridge, `schema.sql` and `app-template/` on demand and mixed two
builds (2026-10-03).
Rule: run from a per-build copy (`<data>/hosts/<key>`) or a verified `<data>/content/<version>/host`; copy through a
temporary folder and a rename, keep the executable bit (node-pty's spawn-helper: `posix_spawnp failed`); a dirty or
unknown commit gets its build time in the key.
Guard: `keeper/keeper/source.rs` `the_copy_survives_the_bundle_being_rewritten_and_keeps_the_exec_bit`;
`keeper/keeper/source.rs` `a_complete_copy_is_reused_and_a_half_one_is_replaced`; `keeper/keeper/source.rs`
`a_dirty_or_unknown_build_is_told_apart_by_its_build_time`.
Platforms: macOS, Linux.

**FI2. Copies and cleanups go through one lock.**
Happened: after a handoff, the cleanup set off by the adopted host's ready line deleted the copy a switch had just
renamed into place: "Cannot find module …/hosts/handoff-C/main.mjs" (#368, fixed by #441, 573be1e9; #325 had covered
only `.tmp-*`).
Rule: every copy and cleanup takes `source::Copies`; a claim holds a copy until a host runs from it or the swap gives
up; the cleanup reads what is in use when it runs; a frozen keeper neither copies nor cleans; temporary copies younger
than 10 minutes are left alone.
Guard: `keeper/keeper/source.rs` `a_copy_a_swap_holds_survives_the_cleanup_a_ready_host_sets_off`;
`keeper/keeper/source.rs` `a_claimed_copy_is_never_taken_by_a_concurrent_cleanup`; `keeper/keeper/source.rs`
`a_frozen_keeper_neither_copies_nor_cleans`; `keeper/keeper/source.rs` `the_freeze_waits_for_a_copy_in_progress`;
`keeper/keeper/server.rs` `the_folders_in_use_are_the_running_the_next_and_a_running_switchs_target`.
Platforms: macOS, Linux.

**FI3. A complete copy outlives the folder it came from.**
Happened: after a switch to a newer AppImage's build, the build's host folder lived in a mount that went away when that
window quit; `copy_into` checked the source before its own complete copy, so every later host restart failed and the
keeper gave up (measured in WSL, #458).
Rule: a complete copy is used first; the source is read only to make one.
Guard: `keeper/keeper/source.rs` `a_complete_copy_outlives_the_folder_it_came_from`.
Platforms: Linux. *Changed by #458.*

**FI4. Nothing long-lived runs from an AppImage mount.**
Happened: the type-2 runtime keeps the squashfs mounted while any process holds its keep-alive pipe or the mount's
descriptor; a keeper started by keeper A from a newer AppImage holds neither, so its mount went when that window quit,
and a debug keeper then died of SIGBUS when asked to stop, most likely at a page-in (#458, spikes/2026-10-linux-keeper.md
§6). The same holds for the host and every terminal.
Rule: the keeper and the host run from plain files under `<data>/content/<version>/`, copied out before a keeper starts
or a switch is asked; once nothing runs from the mount, inherited descriptors that are not the handoff channel are
closed.
Guard: **UNGUARDED** (not fixed yet).
Platforms: Linux.

**FI5. The AppImage's environment leaks into children.**
Happened: the AppRun sets GDK, GTK, `XDG_DATA_DIRS` and `APPDIR`, which reach terminals and agents (#14 audit).
Rule: a child's environment does not carry the AppImage runtime's variables.
Guard: **UNGUARDED** (not fixed).
Platforms: Linux.

**FI6. The Linux host ships unpacked.**
Happened: the host inside the AppImage needs FUSE, which servers often lack (#390).
Rule: Linux packages carry `host/` beside the AppImage; a remote never runs the AppImage.
Guard: `tooling/launcher-serve.test.ts` "finds the bundled host in each platform package".
Platforms: Linux.

**FI7. Only signed content runs with the person's grants.**
Happened: running code from outside a signed bundle with the app's permissions needs a reason to trust it (#440,
#445, #448, #451).
Rule: verify the ed25519 signature over the manifest's exact bytes before parsing; read each file once from an
`O_NOFOLLOW` descriptor; copy into a fresh folder, hash the copy, make it read-only and run only the copy; reuse a copy
only if it verifies in place with the same manifest bytes; refuse a source inside `<data>/content`; never replace a
folder something runs from (`in-use`).
Guard: `keeper/keeper/content/tests.rs` `content_changed_after_signing_is_refused_and_nothing_is_left_behind`;
`keeper/keeper/content/tests.rs` `content_signed_with_a_key_this_build_does_not_trust_is_refused`;
`keeper/keeper/content/tests.rs` `content_from_inside_the_content_folder_is_refused`;
`keeper/keeper/content/tests.rs` `a_version_folder_in_use_that_does_not_verify_is_refused_and_left_alone`;
`shell/run/tests.rs` `starts_the_keeper_from_the_verified_copy_with_the_windows_command_line`;
`shell/run/tests.rs` `a_second_start_of_the_same_version_uses_the_copy_once_it_verifies_again`.
Platforms: macOS (Linux and Windows to follow, plan step 4).

**FI8. A folder its owner cannot write cannot be renamed on macOS 14.**
Happened: #445 merged with CI red: macOS 14 refuses to rename a folder its owner cannot write, while macOS 27 (the
author's) refuses only across parents; fixed in #446 (879494f9).
Rule: rename the filled copy into place first, then `fchmod` it 0555 through a descriptor opened before the rename, then
list the top folder again and refuse anything unexpected.
Guard: `verify/copy.rs` `a_filled_copy_is_placed_and_then_made_read_only_in_any_parent`; `verify/copy.rs`
`something_added_to_the_top_folder_before_it_is_read_only_is_refused`.
Platforms: macOS.

**FI9. The downgrade floor rises only after a keeper served.**
Rule: `<data>/content/highest-started` is raised once the keeper answers (the shell) or serves (a handoff); a lower
version is refused unless the shell was asked for `--rollback`; an unreadable floor is logged and replaced, not a
refusal.
Guard: `shell/run/tests.rs` `an_older_version_than_one_that_ran_is_refused_unless_rolled_back_on_purpose`;
`shell/run/tests.rs` `an_unreadable_floor_does_not_stop_a_start`; `keeper/keeper/content/tests.rs`
`an_older_version_than_the_floor_is_refused_and_the_same_or_newer_is_not`.
Platforms: macOS.

**FI10. A test key cannot reach a release.**
Rule: the extra key exists only behind the `test-key` feature, which is a `compile_error!` without `debug_assertions`.
Guard: `shell/keys.rs` `a_build_without_the_test_feature_trusts_exactly_keys_json`; `keeper/keeper/keys.rs`
`a_build_without_the_test_feature_trusts_exactly_keys_json`; `tooling/shell-bundle.test.ts` "a test key exists only
behind the test-key feature, which a release build refuses to compile".
Platforms: macOS.

**FI11. On Windows a running program's files cannot be replaced.**
Happened: `npm i -g` hit EBUSY while the app ran from the package; Windows refuses to delete the last name of a running
program or to overwrite any of its names (#328, #353, #456).
Rule: run the app from a copy in `%LOCALAPPDATA%\Programs\Centralu`, install by assembling `.new` and swapping folders
by rename, keep the old one as `Centralu.old-*` until a later install sweeps it; the path the updater refreshes is the
launcher's.
Guard: `host/updates.test.ts` "is the path the launcher's install writes and its update refreshes, on every platform";
`tooling/launcher-platform.test.ts` "sweeps only the copies an earlier install renamed aside, nothing else in the shared
Programs folder"; `tooling/launcher-platform.test.ts` "names a running app as the reason Windows will not replace
files".
Platforms: Windows. *Changed by #456.*

**FI12. On Windows, Claude runs from Centralu's own link.**
Happened: the host started npm's `claude.exe`; an npm update could then neither delete nor overwrite it and left a
500-byte placeholder Windows calls a "16-bit program" (#353, c8020cee).
Rule: hard-link (or copy on EXDEV/EPERM) into `<data>\tools\claude\<version>-<size>\`, placed by rename; sweep links no
session uses; refuse a non-`MZ` `.exe` under 1 MB with the fix in the message.
Guard: `host/adapters/claude/exe-link.test.ts` "links npm's claude.exe under tools/claude/<version>-<size> and starts it
from there"; `host/adapters/claude/exe-link.test.ts` "a link Windows refuses to delete (a process still runs it) stays
for a later sweep, and the rest still go"; `host/adapters/claude/exe-link.test.ts` "is refused before a process starts,
naming the file and the fix".
Platforms: Windows.

**FI13. Native modules ship as files, not inside a single executable.**
Happened: Node SEA cannot embed better-sqlite3's `.node`, and injecting into a signed binary needs re-signing on macOS;
system Node was adopted and Bun compile put on hold (m2-f0-bundling.md "Decision (F-0a)").
Rule: native addons sit beside `main.mjs`; nothing is injected into a binary after signing; any Node 22 or later loads
the shipped modules (Node-API, measured on 24.21.0); remotes run a pinned Node.
Guard: `tooling/node-pin.test.ts` "is an exact 24.x release with a hash for every platform the installer serves";
`tooling/node-pin.test.ts` "CI runs the host’s tests on the pinned Node, on Linux and Windows, beside the jobs on 22".
Platforms: all. *Changed by #457.*

## 11. macOS permissions and the shell

**TC1. Whatever holds permissions keeps the same bytes.**
Happened: an ad-hoc signature's designated requirement is the cdhash, so every update and local build was a new app
and lost Screen Recording, Accessibility and folder grants (#220).
Rule: the shell is built once per shell version and pinned in `packaging/shell/shell.lock` (version, sha256, cdhash);
releases download it; a hash mismatch fails; the icon and usage descriptions are part of the pinned bytes.
Guard: `tooling/shell-bundle.test.ts` "a download whose sha256 is not the pinned one is refused and not written";
`tooling/shell-bundle.test.ts` "one shell version in src/lib.rs, Info.plist and its bundle version".
Platforms: macOS.

**TC2. macOS judges a process by the app that started its tree.**
Happened: measured on macOS 27 (spikes/2026-10-thin-shell-tcc.md, #440, #443): grants follow the responsible process
through content replacement, a keeper handoff and the shell's exit; a child of the window is judged as the window.
Rule: the grant holder is started by LaunchServices (`open -n -g -a <shell> --args …`), never as the window's child.
Guard: `window/shell/start/tests.rs` `opens_through_launch_services_without_activating` (the command only); the
permission behaviour is *Manual*, the spike's probe before each shell version: **UNGUARDED** in CI. Unmeasured: the
responsible process of a keeper started by a keeper, and of a window relaunched by Tauri.
Platforms: macOS.

**TC3. A shell nested in the window's bundle loses Screen Recording.**
Happened: nested in `Contents/Helpers`, Accessibility stayed but Screen Recording followed the outer bundle, so a window
update lost it (#440).
Rule: the shell lives at `<data>/shell/Centralu.app`; the window carries its bytes only as a copy source.
Guard: *Manual* (thin-shell.md §10.2 "Checked by hand"): **UNGUARDED** in CI.
Platforms: macOS.

**TC4. Quarantine and extended attributes do not follow the shell.**
Rule: the window copies file bytes and mode bits only: no extended attributes, no symlinks; the tree hash refuses
symlinks.
Guard: `window/shell/install/tests.rs` `the_tree_hash_is_the_one_the_release_staging_writes`. Not copying extended
attributes is **UNGUARDED**.
Platforms: macOS.

**TC5. A process LaunchServices started reports to nobody.**
Happened: the shell's exit code and stderr reach no one (thin-shell.md §10.1).
Rule: the shell reports in `<data>/shell-status.json`, replaced whole by rename, `0600`, `O_NOFOLLOW`, carrying the
window's nonce; a report with another nonce is not this start's; a refused command line still reports to the folder it
names, without creating it.
Guard: `shell/status.rs` `the_file_is_replaced_whole_and_private`; `window/shell/start/tests.rs`
`a_report_from_another_start_is_not_this_ones`; `shell/args.rs` `a_refused_command_line_still_names_where_to_report`;
`scripts/shell-integration.mts` check "the status carries the nonce the window passed".
Platforms: macOS.

**TC6. The window's wait for the shell is bounded.**
Rule: up to 45 s for the report (the shell waits 25 s for its keeper); a keeper that answers without a report counts as
started after 3 s; `open` failing falls back at once; `open` itself is bounded at 15 s.
Guard: `window/shell/start/tests.rs` `a_keeper_that_answers_without_a_report_counts_as_started_after_a_grace`;
`window/shell/start/tests.rs` `launch_services_failing_falls_back_at_once`; `window/shell/tests.rs`
`a_shell_that_never_reports_falls_back_visibly`. The 15 s bound on `open` is **UNGUARDED**.
Platforms: macOS.

**TC7. A keeper already answering means nothing else happens.**
Rule: the window opens no shell; a shell that finds one answering verifies, copies and starts nothing; a keeper that
exits "already running" while another answers counts as ready.
Guard: `window/shell/tests.rs` `a_keeper_answering_installs_and_opens_nothing`; `shell/run/tests.rs`
`a_keeper_already_answering_means_nothing_is_verified_copied_or_started`. The exit-3 race is **UNGUARDED**.
Platforms: macOS.

**TC8. A keeper the shell started that never answers is killed.**
Rule: so the window's fallback start is not stuck waiting on the lock.
Guard: `shell/run/tests.rs` `a_keeper_that_cannot_start_exits_or_never_answers_is_refused`.
Platforms: macOS.

**TC9. An unpinned shell is neither installed nor opened.**
Happened: opening a local build's shell costs a launch, and a build under `~/Desktop` asks for folder access in the
shell's name; installing it would put unpinned bytes where permissions attach.
Rule: log the reason and start the keeper directly; `CC_SHELL_UNPINNED=1` opens it by hand with a temporary data folder.
Guard: `window/shell/tests.rs` `a_local_build_does_not_install_or_open_its_unpinned_shell_and_only_logs_why`.
Platforms: macOS.

**TC10. Installing a shell never leaves none, and never goes down.**
Rule: never replace a higher installed version; at the same version replace only pinned over different bytes; copy to
`.new`, hash it, rename the old one aside, rename the new one in, rename back on failure; remove the old one only after
the new shell started a keeper; put the old one back when a window stopped between the renames.
Guard: `window/shell/install/tests.rs` `the_decision_table`; `window/shell/install/tests.rs`
`a_failure_at_any_step_leaves_the_installed_shell_in_place`; `window/shell/install/tests.rs`
`a_window_that_stopped_between_the_renames_gets_the_old_shell_back`; `window/shell/tests.rs`
`an_upgrade_removes_the_old_shell_only_after_the_new_one_started_a_keeper`.
Platforms: macOS.

**TC11. The shell's zip is reproducible.**
Happened: a file created under `/tmp` takes group `wheel` instead of `staff`, and that alone changed the hash.
Rule: set uid, gid and a fixed time on every file, then `ditto --norsrc --noextattr --noqtn --noacl`.
Guard: `tooling/shell-release-workflow.test.ts` "zips reproducibly: the same bundle zipped twice must give the same sha256".
Platforms: macOS.

**TC12. The shell links nothing graphical and needs no run loop.**
Happened: "Not responding" is the window server's verdict on a connected process that does not handle its events
(Apple DTS, thin-shell.md §3).
Rule: link only `libSystem` and `libiconv`; `LSUIElement`, so one Dock icon, the window's.
Guard: `scripts/shell-integration.mts` check "links libSystem and libiconv only: no AppKit, CoreGraphics or SkyLight, so no window
server connection".
Platforms: macOS.

**TC13. A missing usage description ends the process that asks.**
Rule: the shell declares every privacy class up front; adding one later is a new shell version.
Guard: `tooling/shell-bundle.test.ts` "declares a usage description for every privacy class that would otherwise end the
asking process".
Platforms: macOS.

**TC14. The shell never creates or migrates the data folder.**
Happened: migration rules in pinned bytes could never change.
Guard: `shell/run/tests.rs` `a_data_folder_that_does_not_exist_is_refused_and_not_created`.
Platforms: macOS.

**TC15. One shell fallback lasts for the window's life.**
Happened: retrying a slow failure would cost 45 s on every reconnect (thin-shell.md §10.2).
Rule: after a refusal or no report, the window starts keepers directly until it quits, with the reason in the build bar
when the shell is pinned.
Guard: `window/shell/tests.rs` `each_refusal_starts_the_keeper_directly_with_the_shells_reason_shown_in_a_release`
(one start); that it sticks across later starts (`KeeperLink`) is **UNGUARDED**.
Platforms: macOS.

**TC16. A keeper from content verifies the next content itself.**
Rule: only a keeper whose own executable is `<data>/content/<version>/centralu-keeper` verifies and copies the next
build before handing over; any other keeper hands over to the executable it is given.
Guard: `keeper/keeper/server.rs` `a_switch_takes_signed_content_only_from_a_keeper_in_verified_content`;
`scripts/keeper-content-integration.mts` check "refused: ${reason}" (run for `content` and `downgrade`).
Platforms: macOS.

**TC17. A tool started under Centralu asks in Centralu's name.**
Happened: the default trash goes through Finder by AppleScript, which raises an automation prompt and, if declined,
silently deletes nothing (5b05f2b3).
Rule: use APIs that need no new grant (`NSFileManager` for trash); never trigger a permission prompt by a side path.
Guard: **UNGUARDED**.
Platforms: macOS.

## 12. Quit, relaunch and update

**UP1. ⌘Q cannot be vetoed where Tauri reports it.**
Happened: tao implements no `applicationShouldTerminate:`, and wry emits `ExitRequested` only after the last window is
destroyed (read in the upstream source, 1eee9563).
Rule: replace the predefined Quit item with one that asks the webview; Dock Quit and logout still terminate at once (a
known gap).
Guard: `platform/tauri/startup.test.ts` "quits right away if there is nothing to ask (the startup or startup-failure
screen), and hands off to it if something is up". The Rust side is **UNGUARDED**.
Platforms: macOS.

**UP2. The exit gate.**
Happened: one mistyped ⌘W during work took down a whole session.
Rule: `CloseRequested` is prevented and asked; an `ExitRequested` without a code and without approval is blocked; one
with a code always passes (the updater's restart and our own exits); the approval flag is set before `exit()`.
Guard: **UNGUARDED**.
Platforms: all.

**UP3. Under a keeper, quitting only detaches.**
Rule: the window never stops the host or waits on it; background mode and the relaunch grace are the keeper's; in
direct mode the window kills its host on exit.
Guard: `window/sidecar.rs` `a_supervisor_that_never_started_reports_direct_mode` (direct mode); detach is **UNGUARDED**.
Platforms: all.

**UP4. "Apply now" only when a relaunch starts a different build.**
Happened: under `pnpm app:open` the window runs the build output, which the update does not touch; a half-replaced
bundle could start nothing (#352, 7c226b70).
Rule: offered only when the window is in a bundle, the build on disk is readable and differs; never in direct mode,
where the host is the window's child; never from a window already on the installed version; once per window.
Guard: `window/sidecar.rs` `apply_now_relaunches_only_into_a_different_build_on_disk`;
`packages/ui/src/features/settings/apply-update.test.ts` "does not loop: not from the relaunched window, not twice from
one window, not where a relaunch changes nothing".
Platforms: macOS, Linux.

**UP5. The relaunch is `request_restart` of the same path.**
Happened: a command runs on the main thread, where `restart` skips the exit events and with them the detach;
`centralu install` replaced the bundle, so the same path names the new executable (tauri 2.11.5).
Rule: set the approval, then `request_restart`.
Guard: **UNGUARDED**.
Platforms: macOS.

**UP6. The keeper is told before the window goes.**
Happened: with background mode off (the default), the old window closing was "the last window" and stopped
everything (#352).
Rule: announce `relaunching` (60 s, at most 300); the keeper tells the next window it is the relaunched one, once; a
keeper too old to know `relaunching` is acceptable only with background mode on, otherwise the window refuses.
Guard: `keeper/keeper/mod.rs` `an_announced_relaunch_holds_a_keeper_with_background_off`; `keeper/keeper/mod.rs`
`a_relaunch_nobody_came_back_from_falls_back_to_stopping`. The window's refusal is **UNGUARDED**.
Platforms: macOS, Linux.

**UP7. A window switches by itself only forward, and only when nothing is lost.**
Happened: opening an older window with the automatic mode on quietly downgraded keeper and host (#421, 5c5f60a3).
Rule: newer means a higher app version, then a later build time; what cannot be ordered is never newer; switch by
itself only when `hostBusy` says idle and nobody typed for 20 s.
Guard: `platform/tauri/switch-plan.test.ts` "only forward: a window of an older build never switches, asks or waits by
itself"; `platform/tauri/switch-plan.test.ts` "what cannot be ordered is never newer, either way";
`packages/ui/src/features/settings/apply-update.test.ts` "never applies while anything is running, and unknown counts
as running".
Platforms: macOS, Linux.

**UP8. "Restart completely" replaces a keeper that cannot move.**
Happened: #387's fix lives in the sending keeper (HD12).
Rule: it is the keeper's `stop`; the window stays, sees the keeper exit and starts one of its own build.
Guard: **UNGUARDED** in Rust (the window's attach loop); covered in `e2e/quit-dialog.spec.ts` for the dialog only.
Platforms: macOS, Linux.

**UP9. A switch names the keeper inside the bundle, never a copy.**
Rule: `switch` carries `keeper.exe` as the `centralu-keeper` beside the window's executable (none in debug); an older
keeper ignores the field and swaps only the host.
Guard: **UNGUARDED** on the window side.
Platforms: macOS, Linux.

**UP10. The code that runs an update is the old code.**
Happened: the launcher's semver compared prereleases as NaN (#42); the `/Applications` copy went stale (#52, a91df081);
the old keeper's handoff bug (#391); the old window's Windows updater (#456). Each time the fix shipped in a build the
broken one had to install first.
Rule: every update path has a manual escape that does not depend on the installed code; the window says when its copy
differs from the package.
Guard: `tooling/launcher-semver.test.ts` "sees the next prerelease (the exact failure that shipped)";
`tooling/launcher-semver.test.ts` "speaks up on the drift that actually happened".
Platforms: all.

**UP11. The npm launcher on Windows runs npm through the shell and refuses what it would interpret.**
Rule: the launcher's own `npm` call goes through the shell because npm is `npm.cmd` there, and refuses any argument the
shell would read as syntax; the host never does this (PA9, PA10).
Guard: `tooling/launcher-platform.test.ts` "runs npm through the shell, since npm is npm.cmd there";
`tooling/launcher-platform.test.ts` "refuses an argument the shell would interpret".
Platforms: Windows.

## 13. Remotes: serve, ssh, PowerShell, WSL

**RE1. ssh never waits for a person.**
Happened: a password or host-key prompt nobody can answer would hang the hub (#410).
Rule: `-T -o BatchMode=yes -o ConnectTimeout=15 -- <target>`; exit 255 is "ssh could not reach"; the forward uses
`ExitOnForwardFailure`, keep-alives and `-L 127.0.0.1:L:127.0.0.1:R`, up only once a TCP connect succeeds.
Guard: `host/links/tunnel.test.ts` "asks the remote for its connection line in batch mode, then forwards on loopback
only".
Platforms: all hubs (tests skip Windows hubs).

**RE2. A target can never be read as an option.**
Rule: refuse an empty target, one starting with `-` or containing whitespace; `--` always comes first.
Guard: `host/links/links.test.ts` "adds and removes a machine through the hub, and removing it takes its sessions and
panels away".
Platforms: all.

**RE3. The fallback is decided on the remote and reported as a word.**
Happened: nvm, fnm, volta and `~/.npm-global` put npm's folder on PATH only in interactive shells; Windows OpenSSH runs
the command under PowerShell, which turns any failure into 1, and a missing command can arrive as 0 (2026-10-05).
Rule: one remote command tries the managed launcher (`<data>/remote/bin/centralu`), then `centralu` on PATH, then
`~/.centralu/bin/centralu`, then prints `CENTRALU-NOT-FOUND`; the hub reads the word, not the exit code; POSIX runs
the lookup under `sh -c` (fish). The installer's steps answer `CENTRALU-PREFLIGHT` and `CENTRALU-INSTALL` words the
same way.
Guard: `host/links/tunnel.test.ts` "says Centralu is not installed when neither answers, whatever exit code the shell
passed on, and that ssh failed when it cannot connect"; `host/links/tunnel.test.ts` "a POSIX remote runs the lookup
under sh, so a login shell like fish runs it too; the person’s own command runs as given";
`host/links/tunnel.test.ts` "runs the managed launcher before centralu on PATH and before the launcher serve keeps
(plan §10.1)" (by a real `sh`); `host/links/tunnel.test.ts` "a Windows remote tries the managed launcher before
centralu on PATH too" (the decoded script only).
Platforms: all remotes. *Changed by phase 3 step 3.*

**RE4. Nothing but plain words crosses PowerShell.**
Happened: PowerShell 5.1 mangles double quotes passed to native programs (#410).
Rule: PowerShell remotes get `-EncodedCommand` (UTF-16LE base64); WSL gets a base64 script piped to `bash -l`; a
distro name must match `^[A-Za-z0-9._-]{1,64}$`; WMI is handed its command line and folder as base64.
Guard: `host/links/tunnel.test.ts` "nothing that is not base64 crosses PowerShell, so no quote is re-parsed on the
way"; `host/links/tunnel.test.ts` "refuses a WSL distro name that could break out of its quotes";
`tooling/launcher-serve.test.ts` "hands WMI the command line and folder as base64, so no quote reaches PowerShell".
Platforms: Windows and WSL remotes. *Changed by #462.*

**RE5. WSL appends Windows' PATH.**
Happened: `command -v centralu` inside WSL found and ran the Windows npm shim under `/mnt/c/…` (#410).
Rule: the WSL lookup removes `/mnt/*` from PATH.
Guard: `host/links/tunnel.test.ts` "reaches a Windows remote through PowerShell, and a WSL distro through wsl.exe,
decoded as the remote would".
Platforms: WSL.

**RE6. WSL stops an idle distro.**
Happened: WSL stops a distro, its services included, about 15 s after its last `wsl.exe` client (a systemd `serve` was
stopped at 19 s), and empties `/tmp` with it (#410, #455).
Rule: something holds a `wsl.exe` for as long as the host must live: the forward runs
`wsl.exe -d <distro> --exec sleep infinity`; a detached host is a WMI-created `wsl.exe -d <distro> --exec <launcher>
serve`; nothing is installed under `/tmp`.
Guard: `host/links/tunnel.test.ts` "reaches a Windows remote through PowerShell, and a WSL distro through wsl.exe,
decoded as the remote would"; `tooling/launcher-serve.test.ts` "detaches with setsid on posix, through WMI on Windows,
and through a WMI-created wsl.exe inside WSL".
Platforms: WSL. *Changed by #462.*

**RE7. Only some starts outlive the ssh session.**
Happened: measured (remote-hub.md §10.4): Windows OpenSSH ends `Start-Process` children with the session; a WMI
`Win32_Process.Create` survives (15 minutes, 13 hub swaps); POSIX survives with `setsid` and a double fork. Defender's
attack surface reduction rule can block WMI.
Rule: one primitive, `centralu serve --detach`; where WMI is blocked, the host runs in the forward's own session and
ends with the link, and the hub says so.
Guard: `tooling/launcher-serve.test.ts` "starts the host in the background and returns once it answers, then stops it in
order on request"; `tooling/launcher-serve.test.ts` "reports a start WMI refused as wmi_blocked";
`host/links/tunnel.test.ts` "where WMI is blocked, runs the host in the forward’s own session instead, and it ends with
the link".
Platforms: all remotes. *Changed by #462.*

**RE8. On Windows, killing the launcher kills the host without its shutdown.**
Happened: killing a WMI-started launcher ended the host 143 ms later with no "shutting down" line: the host sits in
libuv's kill-on-close job object, so its agents die with it (remote-hub.md §10.4).
Rule: `centralu serve --stop` asks the host to stop over its own WebSocket, waits for the port to close, and only then
ends the process; on POSIX, SIGTERM to the launcher.
Guard: `tooling/launcher-serve.test.ts` "starts the host in the background and returns once it answers, then stops it in
order on request" (POSIX); the Windows path is **UNGUARDED** in CI.
Platforms: Windows. *Changed by #462.*

**RE9. Closing a link ends every ssh it started, even mid-open.**
Happened: removing a machine while its link was opening left an `ssh -N` holding a port until the host exited (#410).
Rule: `close()` ends the asking ssh and the forward (TERM, KILL after 2 s); an `open()` closed midway starts nothing
more; ssh stays in the host's process group, so the host's group stop takes it.
Guard: `host/links/links.test.ts` "closes what the tunnel opened when the machine is removed while it was opening";
`host/links/tunnel.test.ts` "closing while the remote is still being asked ends that ssh, and starts no forward after
it". The group placement is **UNGUARDED**.
Platforms: all hubs.

**RE10. The hub's ssh stays the host's child; no ControlPersist.**
Happened: probe 4 (2026-10-08): OpenSSH daemonizes a `ControlPersist` master into its own session, out of the keeper's
tree; it outlived "Quit completely" and kept one forward per swap, so the local port moved each time. The status quo
leaves no ssh behind; the link is away about 1.1 s per hub swap.
Rule: no `ControlMaster`, `ControlPersist` or `ControlPath`; host keys stay the person's own `known_hosts`.
Guard: **UNGUARDED** (the test asserts the options present, not these absent).
Platforms: macOS and Linux hubs.

**RE11. The local port keeps the remote's number when it can.**
Rule: app view addresses carry the port, so use the same number when free, otherwise an OS-picked one; if ssh's bind
fails on the same number (taken in between), retry once on an OS-picked port.
Guard: `host/links/tunnel.test.ts` "uses the same port number here when it is free, and another one when it is taken".
The race retry is **UNGUARDED**.
Platforms: all.

**RE12. The managed launcher never changes; a pointer file does.**
Happened: `cmd.exe` reads a batch file by offset while it runs, so rewriting a running `.cmd` corrupts it; `renameSync`
over an existing file is atomic on Windows; a symlink would be a junction that cannot be replaced atomically; an npm
install's `serve` rewrites `<data>/bin/centralu` on every run (remote-hub.md §10.1).
Rule: `<data>/remote/bin/centralu` reads `current` at every start and sets `CENTRALU_MANAGED=1`; switching versions is
one rename; a managed `serve` leaves `<data>/bin/` alone.
Guard: `tooling/launcher-serve.test.ts` "runs the version current names on its Node, marked managed, and follows current
when it moves"; `tooling/launcher-serve.test.ts` "leaves <data>/bin/centralu alone under the managed launcher, and keeps
it otherwise"; `tooling/launcher-serve.test.ts` "reads current and previous as two plain words, and nothing that could
leave the install". The installer's side: `host/links/install.test.ts` "replaces current by a rename, never by writing
into the file the launcher reads"; `host/links/install.test.ts` "moves the old current to previous before current
changes"; the launcher written once: `host/links/install.test.ts` "keeps current and previous only: a third version
removes the first".
Platforms: all remotes. *Changed by #462 and phase 3 step 3.*

**RE13. A running version on Windows cannot be deleted.**
Happened: removing a running `node.exe` was refused; renaming its folder was allowed (remote-hub.md §10.5).
Rule: install beside, stop, switch, start, check the version that answers, and delete old versions only after the old
host is gone; keep `current` and `previous`. The installer (step 3) switches `current` and prunes to current and
previous only, so the version a running host uses becomes `previous` and stays; a folder that cannot be removed is
reported in `left`, never fatal.
Guard: keeping current and previous: `host/links/install.test.ts` "keeps current and previous only: a third version
removes the first". Stop before switch, and the Windows refusal itself: **UNGUARDED** (phase 3 step 4, not built).
Platforms: Windows remotes. *Changed by phase 3 step 3.*

**RE14. A refused token is asked again once.**
Rule: a 4001 or 4002 refusal re-reads the connection line once; a second refusal in a row is reported and backed off.
Guard: `host/links/links.test.ts` "a refused token asks the remote again once, then reports and backs off instead of
looping".
Platforms: all.

**RE15. A remote checks what it downloads against values that did not travel with it.**
Happened: designed and measured in remote-hub.md §10.3 and §10.7: a `SHASUMS256.txt` fetched beside the archive only
catches corruption, and the remote's old install must not decide how the new one is installed.
Rule: the Node archive's SHA-256 is the one the release pinned (`remote-runtime.json`), sent by the hub; each npm
tarball's sha512 is the `integrity` the hub read from version metadata whose registry signature it checked (a
published, unexpired key, over `<name>@<version>:<integrity>`); a mismatch stops before unpacking and leaves at most
nothing, and what ran before keeps running.
Guard: `host/links/install.test.ts` "refuses a Node archive whose SHA-256 is not the pinned one, and leaves nothing";
`host/links/install.test.ts` "refuses a package whose bytes are not what the signed metadata names, and keeps what
runs"; `host/links/registry.test.ts` "refuses metadata signed by a key the registry does not publish";
`host/links/registry.test.ts` "refuses a signature made with a key that has expired". The PowerShell Node step
(`Get-FileHash`) is checked as text only: `host/links/install.test.ts` "a Windows remote checks the Node zip with
Get-FileHash and unpacks it with System32 tar.exe".
Platforms: all remotes; the Windows path is not run in CI.

**RE16. Refuse a machine the published host cannot run on before downloading anything.**
Happened: both native modules in `@centralu/linux-x64` reference `GLIBC_2.34` symbols, and the bundles carry no musl
build of node-pty (remote-hub.md §10.2): installed anyway, the host would die at its first `require`.
Rule: the preflight refuses glibc below 2.34, musl, an architecture with no package, a missing `tar`, `gzip`,
downloader or SHA-256 tool, and too little space, each in one sentence, and the hub asks the registry nothing until it
passes.
Guard: `host/links/install.test.ts` "refuses, in one sentence each, what the published host cannot run on or the
install cannot do"; `host/links/install.test.ts` "refuses before downloading anything: an old glibc there, or registry
metadata whose signature fails".
Platforms: Linux and Windows remotes.

**RE17. Every installer step fits one Windows command line.**
Happened: CreateProcess takes 32,767 characters, and a WSL script is base64 inside UTF-16LE base64 (about 5.3
characters per byte of script).
Rule: the step-2 `.mjs` travels gzipped; every step's command stays under 30,000 characters in all three shells.
Guard: `host/links/install.test.ts` "fits one Windows command line in every shell, the installer itself included".
Platforms: Windows and WSL remotes.

## 14. How the runtime is tested

These are practices, not invariants of the code; they say how a replacement module is proven.

**TE1. A boundary gets a sweep, not one value.** The handoff failed only near 8,000 bytes before a batch (#387);
`wire.rs` sweeps three buffers' worth (HD2). Run buffers, batches, caps and limits from zero to a few times the limit,
and at the scale people reach (several agents, terminals and app views, a large store). CONTRIBUTING.md.

**TE2. CI starts a real keeper on each OS it ships on.** CI never started a keeper, so a host crash loop stayed green
(#329, #348); the `keeper e2e` job runs the keeper scripts on macOS (#349) and, since #458, on ubuntu-24.04
(`keeper e2e (linux)`). A Windows keeper needs its own job before it ships.

**TE3. Test processes are ended by recorded pid, never by name.** `scripts/keeper-test-processes.mjs` reads one process
table and ends every descendant and group of each recorded pid; the installed app, its keeper and host match the same
names (#349, AGENTS.md).

**TE4. The oldest supported OS is the one that fails.** #445 merged with CI red and failed only on macOS 14 (FI8). Do
not merge on red; keep the oldest supported macOS in CI.

**TE5. Wall-clock waits fail under load.** #368 collects them; Windows needed 3× limits, a process stops answering
`kill(pid, 0)` before it releases its working directory, and probes outlive the host and write into the workspace
(#415, #373, #437). Wait for an event, or give generous bounds.

**TE6. What only the packaged app does is checked in the packaged app.** PATH, bundling, native modules, TCC and a
handoff between two real builds have repeatedly gone unproven (#280: "mid-turn survival in the packaged app is still
unverified"). The pull request's **Not exercised** field names them.

**TE7. Fixtures that start processes start them inside `try`/`finally`** (#281).

**TE8. Linux's `sh` is dash**: job control needs `bash` in a fixture (#301).

## Statements found out of date while collecting this

Not fixed here; each belongs to the pull request that next touches its document.

- thin-shell.md §10.2 ("An unpinned shell" row), releasing.md "The macOS shell" and security-boundaries.md "Signed
  content" say releases start their keeper directly until shell v1 is pinned; #450 pinned it.
- architecture.md §4.1 says the keeper ships in the AppImage's `usr/bin/` without saying Linux uses it only with
  `CC_USE_KEEPER=1` (agent-host.md §4.0 has it right).
- `links/tunnel.ts` says the first ssh "falls back to `~/.centralu/bin/centralu` on exit 127"; the fallback is decided
  on the remote (RE3).

## The work list: UNGUARDED rules

Every rule above that no test guards. A module is not replaced until the rows naming it have a test that fails with the
rule broken (CONTRIBUTING.md: disable the fix, watch the test fail). "Plan step" is the step of
[plans/runtime-unification.md](plans/runtime-unification.md) §6 the row gates.

| # | Rule | Module | Platforms | Plan step |
|---|---|---|---|---|
| 1 | ST3: the dev flag becomes `CC_DEV` in the host's environment | `window/sidecar.rs` | all | 7 |
| 2 | ST4: the legacy folder move runs before `create_dir_all` in the window | `window/sidecar.rs` | all | 7 |
| 3 | ST8: the product's keeper start puts the keeper in a new session | `keeper/keeper/client.rs`, `exe.rs` | macOS, Linux | 2 |
| 4 | ST11: `leave_app_folder()` runs before anything is started | `window/lib.rs` | Windows | 7 |
| 5 | ST13: no console window (CREATE_NO_WINDOW, `windowsHide`, not `detached`) | `keeper/host_proc.rs`, `host/adapters/local-process.ts`, `host/apps/external/app-process.ts` | Windows | 2 |
| 6 | ST16: `main.ts` deletes the keeper's variables before any spawn; apps get no `CENTRALU_*` | `host/main.ts`, `host/apps/external/runtime.ts` | all | 3 |
| 7 | PA1: the login-shell probe finds a tool a bare PATH does not, in CI | `host/env-path.ts`, `keeper/host_proc.rs` | macOS, Linux | 3 |
| 8 | PA2: a hanging or terminal-stopped probe is bounded and falls back | `host/env-path.ts`, `keeper/host_proc.rs` | macOS, Linux | 3 |
| 9 | PA6: no probe on Windows | `host/env-path.ts` | Windows | 3 |
| 10 | PA11: `taskkill` and PowerShell by System32 path | `host/dev-services/kill-tree.ts`, `keeper/host_proc.rs` | Windows | 2 |
| 11 | PA12: a shim becomes the SDK's single executable path | `host/tool-launch.ts` | Windows | 3 |
| 12 | PA13: the dev host started directly, in its own group | `keeper/host_proc.rs` | all | 3 |
| 13 | PA14: a keeper-started codex goes through command resolution | `host/adapters/codex/index.ts` | Windows | 9 |
| 14 | PA15: a child's environment keeps `SystemRoot` | `host/` spawn sites | Windows | 9 |
| 15 | HO3: logging starts before PATH, lock and store | `host/main.ts` | all | 3 |
| 16 | HO4: `host-errors.log` rotates | `host/main.ts` | all | 3 |
| 17 | HO6: a second signal during startup exits at once | `host/main.ts` | macOS, Linux | 3 |
| 18 | HO7: without `--watch-parent`, stdin EOF is ignored | `host/main.ts` | all | 3 |
| 19 | HO8: ptys disposed before any await; `shutdown()` runs once | `host/main.ts` | all | 3 |
| 20 | HO9: a socket that never said hello does not hold close | `host/transport/server.ts` | all | 3 |
| 21 | HO10: rejections survived, uncaught exceptions shut down | `host/main.ts` | all | 3 |
| 22 | HO11: frames before the server exists are dropped (unit test) | `host/main.ts` | all | 3 |
| 23 | HO12: the control channel's 64 KiB line cap | `host/swap-control.ts` | macOS, Linux | 3 |
| 24 | HO13: loopback bind, EADDRINUSE sentence, `wss` error listener | `host/transport/server.ts` | all | 3 |
| 25 | HO14: EPIPE on a child's stdin is swallowed | `host/dev-services/git-exec.ts`, `host/apps/external/app-process.ts` | all | 3 |
| 26 | HO15: stop or detach chosen by held children | `host/main.ts` | all | 3 |
| 27 | LK2: the ownership handle is kept from garbage collection | `host/dev-services/instance-lock.ts` | all | 3 |
| 28 | LK3: `LC_ALL=C` for `ps`; EPERM means alive | `host/dev-services/instance-lock.ts` | macOS, Linux | 3 |
| 29 | LK7: the socket path length is checked before bind | `keeper/keeper/server.rs` | macOS, Linux | 2 |
| 30 | LK8: a connection from another uid is refused | `keeper/keeper/sys.rs` | macOS, Linux | 2 |
| 31 | SU3: host stop: pid TERM, 3 s, group; stdin held | `keeper/host_proc.rs` | macOS, Linux | 2 |
| 32 | SU5: Windows host stop: stdin EOF, grace, checked `taskkill` | `keeper/host_proc.rs` | Windows | 2 |
| 33 | SU6: a host group stop ends with KILL to the group | `keeper/host_proc.rs` | macOS, Linux | 2 |
| 34 | SU7: a foreign host is watched by pid, EPERM alive | `keeper/host_proc.rs` | macOS, Linux | 2 |
| 35 | SU8: the window reaps every child | `window/lib.rs` | all | 7 |
| 36 | KL3: `stopGroup` never fires at our own group | `host/dev-services/kill-tree.ts` | macOS, Linux | 8 |
| 37 | KL6: strays measured again before the kill; the `systemd --user` subreaper | `host/dev-services/strays.ts` | macOS, Linux | 8 |
| 38 | KL8: no HUP on Windows when closing a terminal | `host/dev-services/terminal.ts` | Windows | 8 |
| 39 | KL9: the terminal's `disposeAll` kills every tree | `host/dev-services/terminal.ts` | macOS, Linux | 8 |
| 40 | KL14: codex gets EOF before any signal | `host/adapters/codex/client.ts` | all | 8 |
| 41 | KL19: exit reported after stdout's end for the host's own processes | `host/adapters/local-process.ts` | all | 8 |
| 42 | CH3: EIO from a pty master is end of file | `keeper/keeper/children/mod.rs` | macOS, Linux | 2 |
| 43 | CH4: both pty ends close-on-exec | `keeper/keeper/children/proc.rs` | macOS, Linux | 2 |
| 44 | CH7: the SDK's exit hook cannot reach the keeper (`hostLeaving`) | `host/keeper/agent-process.ts` | macOS, Linux | 8 |
| 45 | CH13: without a keeper the host owns its children | `host/keeper/held-children.ts` | all | 8 |
| 46 | CH15: a signalled pty's exit shape; a lost keeper for `KeeperPty` | `host/keeper/keeper-pty.ts` | macOS, Linux | 8 |
| 47 | SW6: a connection that read the old target is turned away | `keeper/keeper/front_door.rs` | macOS, Linux | 5 |
| 48 | SW12: a failed store open releases the file | `host/dev-services/store.ts` | Windows | 9 |
| 49 | SW13: migrations log on stderr | `host/dev-services/store.ts` | all | — |
| 50 | HD4: received descriptors close-on-exec; truncation fails | `keeper/keeper/handoff/wire.rs` | macOS, Linux | 2 |
| 51 | HD6: a handoff from an older keeper, in CI | `scripts/keeper-handoff-integration.mjs` | macOS, Linux | 5 |
| 52 | HD9: B takes over after `ready` only if A is gone | `keeper/keeper/handoff/mod.rs` | macOS, Linux | 5 |
| 53 | HD11: A reaps at the commit and B completes those children | `keeper/keeper/handoff/mod.rs` | macOS, Linux | 5 |
| 54 | HD12: a rolled-back handoff still runs the host swap | `keeper/keeper/server.rs` | macOS, Linux | 5 |
| 55 | FI4: nothing long-lived runs from the AppImage mount | `keeper/keeper/source.rs`, the window's start | Linux | 4 |
| 56 | FI5: the AppImage's variables do not reach children | `host/` spawn sites | Linux | 4 |
| 57 | TC2: the responsible process (manual probe, per shell version and major macOS) | `window/shell/` | macOS | 6 |
| 58 | TC3: a nested shell loses Screen Recording (manual) | `window/shell/` | macOS | 6 |
| 59 | TC4: no extended attributes copied with the shell | `window/shell/install.rs` | macOS | 6 |
| 60 | TC6: `open` bounded at 15 s | `window/shell/start.rs` | macOS | 6 |
| 61 | TC7: a keeper exiting 3 while another answers counts as ready | `shell/run.rs` | macOS | 6 |
| 62 | TC15: one shell fallback lasts the window's life | `window/sidecar.rs` (`KeeperLink`) | macOS | 7 |
| 63 | TC17: trash without an automation prompt | `window/lib.rs` | macOS | — |
| 64 | UP1: the custom Quit item (Rust side) | `window/lib.rs` | macOS | 7 |
| 65 | UP2: the exit gate | `window/lib.rs` | all | 7 |
| 66 | UP3: under a keeper quitting only detaches | `window/sidecar.rs` | all | 7 |
| 67 | UP5: relaunch through `request_restart` | `window/lib.rs` | macOS | 7 |
| 68 | UP6: the window refuses a relaunch an old keeper cannot hold | `window/sidecar.rs` | macOS, Linux | 7 |
| 69 | UP8: "Restart completely" starts a keeper of the window's build | `window/sidecar.rs` | macOS, Linux | 7 |
| 70 | UP9: `switch` names the keeper inside the bundle | `window/sidecar.rs` | macOS, Linux | 7 |
| 71 | RE8: `serve --stop` on Windows, in CI | `packaging/npm/centralu/bin/serve.mjs` | Windows | 10 |
| 72 | RE9: the hub's ssh in the host's process group | `host/links/tunnel.ts` | macOS, Linux | 10 |
| 73 | RE10: no `ControlMaster`/`ControlPersist` options | `host/links/tunnel.ts` | macOS, Linux | 10 |
| 74 | RE11: the port race retry | `host/links/tunnel.ts` | all | 10 |
| 75 | RE13: nothing deleted on a Windows remote before the switch | remote installer (phase 3 step 4) | Windows | 10 |
