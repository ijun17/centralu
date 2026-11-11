# Finding and launching programs

**PA1. A GUI app does not inherit the login shell's PATH.**
Happened: an app opened from Finder gets `/usr/bin:/bin:/usr/sbin:/sbin`; the packaged app could not find `node`
(m2-f0-bundling.md trap 4), and on the first dogfooding day claude and codex showed as not installed (8f5f42eb). A
fixed Homebrew list missed nvm, mise and volta. Dev mode inherits the terminal's PATH and hides all of it.
Rule: anything that looks up node, claude, codex or git in a tree started by the GUI or launchd asks the person's
interactive login shell once (`$SHELL -ilc`, a marked line only, merged after the inherited PATH, static folders as
the fallback). Changes touching PATH are checked in the packaged app.
Guard: `host/env-path.test.ts` "a tool only the login shell knows is found from a bare PATH (PA1)" and
`keeper/os/unix.rs` `the_node_the_login_shell_names_is_found_whatever_else_it_prints`, both against a shell the test
writes, so they assert on CI too; `host/env-path.test.ts` "finds a tool the shell knows even from the GUI app's meager
PATH" and `keeper/host_proc.rs` `finds_the_node_this_shell_knows` against the machine's real shell (early returns on
CI). *Changed by step 3.*
Platforms: macOS, Linux.

**PA2. The login-shell probe is bounded and cannot be stopped by a terminal.**
Happened: some shells ignore SIGTERM, and a hung probe meant the host never became ready (cfe32262). Under a
controlling terminal (the npm launcher runs the AppImage attached to one) an interactive bash in its own process group
is stopped by SIGTTOU, so the keeper's probe waited out 5 s every time (measured, #458).
Rule: both probes run the shell in a session of its own and kill its whole group at the bound: the host's 3 s, the
keeper's 5 s (longer since a miss there starts no host at all; `PROBE_TIMEOUT` in `os/unix.rs`). The host's: `SIGKILL`, stdin ignored, `TERM=dumb`, `CI=1`, the marked line trimmed, any failure falls
back. Killing the host's shell alone left what its config had started running (#428).
Guard: `host/env-path.test.ts` "a shell that never answers is cut off at the bound and the fallback is used (PA2)",
"a shell that ignores SIGTERM is still cut off at the bound: the probe is killed, not asked (PA2)" and "a shell stopped
by its terminal (SIGTTOU, SIGSTOP) is cut off too (PA2)"; `keeper/os/unix.rs`
`a_shell_that_never_answers_is_cut_off_at_the_bound` and `a_shell_that_job_control_would_stop_still_answers` (fails
when the probe runs in a group of its own instead of a session); `host/env-path.test.ts` "a shell cut off at the bound
takes what it started with it". *Changed by step 3.*
Platforms: macOS, Linux. *Changed by #458, #428.*

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
Guard: `host/env-path.test.ts` "falls back to the folders Windows installers write to, not unix ones";
`host/env-path.test.ts` "Windows runs no probe at all, even with a SHELL that could run (PA6)". *Changed by step 3.*
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
folder"; `keeper/os/windows.rs` `the_tree_is_ended_by_the_system32_taskkill` (the keeper's `taskkill`). The System32
paths for `taskkill` and PowerShell in `kill-tree.ts` are **UNGUARDED**.
Platforms: Windows.

**PA12. The packaged host hands the Claude SDK the CLI it found.**
Happened: bundling the host broke the SDK's lookup of its own native binary, so every session creation failed in the
packaged app (47c010f3).
Rule: always pass `pathToClaudeCodeExecutable`; a shim becomes its `.js` entry or `.exe`.
Guard: `host/adapters/claude/windows-start.test.ts` "off Windows the path found on PATH is started as it is";
`host/tool-launch.test.ts` "a .js behind the npm shim is handed over as the .js, never the .cmd" and "an .exe behind the
shim is handed over as the .exe" (`toolExecutable` now looks up with the platform it is given). *Changed by step 3.*
Platforms: all.

**PA13. The dev host is started directly, never through a wrapper.**
Happened: killing the pnpm wrapper left the host orphaned holding its port (M1.5 defect 1, three hosts); on Windows
`.bin/tsx` is an sh script `CreateProcessW` cannot start.
Rule: start Node with tsx's loader (`--import …/tsx/dist/loader.mjs`, unix: the host is then the one process started) or Node with tsx's `cli.mjs` (Windows) directly, in a process
group of its own.
Guard: `keeper/host_proc.rs` `the_dev_host_is_started_directly_never_through_a_package_manager`;
`keeper/host_proc.rs` `a_host_leads_a_process_group_of_its_own`; `scripts/keeper-integration.mjs` check "stop ends the
host and the keeper even with background mode on". *Changed by step 3.*
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
