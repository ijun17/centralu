# Internal structure

```
agent-host/src/
├─ main.ts              # CLI (--port --token --db --watch-parent --memory; --standby refused), the wiring of the
│                       #   services, each start step marked against lifecycle/start.ts's START_ORDER
├─ lifecycle/           # the process's start and ending (runtime-unification.md step 3):
│                       #   launch-env (variables read once, deleted), start (the order as data,
│                       #   the final refusal), gate (nothing to a screen before the server),
│                       #   steps + shutdown (the ordered, run-once, bounded stop plan),
│                       #   endings (signals, the parent's pipe, crashes, host-errors.log)
├─ rpc.ts               # RPC method dispatch
├─ transport/
│  ├─ server.ts         # ws server, handshake, RPC routing
│  ├─ event-log.ts      # assigns seq, ring buffer, afterSeq replay (protocol §1)
│  └─ json-lines.ts     # newline-delimited JSON: split at \n only (never readline, which also splits at U+2028), pending requests (#428)
├─ adapters/
│  ├─ contract.ts       # AgentAdapter interface + capability types
│  ├─ contract/         # the contract's larger parts: Centralu tools, session apps, the tool's process,
│  │                    #   the tool's surface (what it offers, what the adapter limits, #270)
│  ├─ registry.ts       # the tool → adapter map
│  ├─ claude/           # based on the Claude Agent SDK (incl. centralu-mcp.ts)
│  └─ codex/            # app-server JSON-RPC client (written here, incl. the stdio bridge)
├─ sessions/            # SessionManager and the parts moved out of it: delegation, handoff, the session archive (`session-trash.ts`),
│                       #   Centralu tools, session apps (folder-structure.md §1)
├─ apps/external/       # external apps: manifest, discovery, runs, broker, capabilities (apps.md)
├─ views/               # app views: the view host, its CSP, the proxy page, drag relay
├─ links/               # linked machines (#82): links, the remote client, install and update over ssh
├─ dev-services/        # git/fs/store, terminals, commands (not dev-only — it is where messages live, store-migrations.md)
├─ keeper-control.ts    # the control lines on stdin, and the addresses that outlive a host (lifecycle/front-door.md); drain.ts: a stop's wait for calls
├─ keeper-link.ts       # what the host tells the keeper, and its own build
├─ view-handover.ts     # open app views across a stop for an update (#280 step 4)
├─ log-file.ts          # tees stderr to ~/.centralu/host.log (stdout is reserved, see below)
├─ env-path.ts          # PATH augmentation — a GUI app inherits no login-shell PATH
├─ stream-text.ts       # text read off a child's stream: a kept tail, lines, decoded as one stream (#428)
├─ timing.ts            # bounded waits (withTimeout, raceTimeout, raceBound, waitForEvent, waitForExit): each clears and unrefs its timer
├─ tool-launch.ts       # how a found tool is started (Windows .cmd shims, absolute paths)
├─ os.ts                # what differs between OSes, asked by name (architecture.md §2)
├─ data-dir.ts          # locating and migrating the data directory
├─ idle.ts              # the one rule for "is anything running a person would lose" (#352)
├─ updates.ts           # update checks, installing, "apply automatically when idle"; update-apply.ts: an agent's apply (#665)
├─ agent-versions.ts    # moving sessions to a newly installed agent CLI (#297); cli-version.ts finds the version
└─ themes.ts            # the themes folder (#312)
```

Usage parsing and the Assistant's MCP surface do **not** have their own directories:
per-account usage lives in `adapters/<tool>/usage.ts` (it is a per-tool question), and the
Centralu tools are defined once in `sessions/tool-definitions.ts`, run by
`sessions/centralu-tools.ts` (which re-exports every name, so most modules import from it) and exposed per
adapter — in-process for claude, over a stdio bridge for codex. Which seat is shown and may run
which tool is `sessions/tool-seats.ts`; the texts the answers are built from, `sessions/tool-answers.ts`.

**stdout is reserved.** `main.ts` prints exactly one line to it: the handshake the Tauri
supervisor parses for the port and auth token. Everything else goes to stderr, because that
is what `log-file.ts` tees to `~/.centralu/host.log` — and a `.app` launched from Finder has
no stdout destination at all, so a `console.log` here reaches nobody in production while
looking fine in a terminal. `no-console` in `eslint.config.js` enforces this everywhere in
the package except that one line.

**On Windows (#14)** the host runs on the direct path (there is no keeper), started by the app
with no console window; its children share that windowless console. Processes and folders differ
in five ways, each in one place:

| What | macOS and Linux | Windows | Where |
|---|---|---|---|
| Finding a tool | PATH, augmented from the login shell | PATH with PATHEXT, absolute entries only; npm/pnpm `.cmd` shims read for the `.js` or `.exe` they start, a shim that starts another (Yarn v1's global bin) followed up to three deep, and Node's own `npm.cmd`/`npx.cmd` (a different shape: variables, and a newer npm in the global prefix preferred) for their `npm-cli.js`/`npx-cli.js` | `env-path.ts`, `tool-launch.ts` |
| `git`, `gh`, an app's command | by name | by absolute path: given a bare name, Windows looks in the working directory (the project) first. Never a `.cmd` (Node refuses to spawn one): the `.exe` its shim starts, or the first `.exe` on PATH. An app's command given as a path is taken from the app's folder, with PATHEXT tried when it has no extension (#849) | `tool-launch.ts` `programPath`, `resolveCommand` |
| Ending a tree | process groups, TERM then KILL | one shot, in one order for every stop (`killTree`, `stopTree`, `processes.stop`): the process table is read while the tree is whole, the root is ended alone, then what the table showed under it, parents first, one `taskkill` after another (#2141, #2142; `taskkill /T` is only the fallback for a table that cannot be read); a pty's `kill()` gets no signal, and only when taskkill could not end the root: node-pty's own kill after it listed a console that was gone and killed the shell's pid 5 s later (#857). What an app left running after it ended is found by parent links and creation times and ended, parents before children (each parent alone, #2142). A run or git call (`processes.stop`) reads that table first, then ends its child alone and then what the table showed under it, parents first, one `taskkill` after another without holding the host's thread: a program `taskkill` ends reports success to an MSYS shell, so a parent still running could go on (#2141). Read after, the table would miss a grandchild whose parent Node ended with the child (#2142 review). The table comes from one PowerShell kept for the host's life (`os/process-table.ts`, #2178), started once the host is ready (`warmProcessTable`, main.ts) and asked over stdin; a tool or a test keeps none and reads in a PowerShell of its own; it reads every process's parent and creation time with one `NtQuerySystemInformation` call, declared at run time, so there is no native module. A read takes 2–4 ms (p99, 20 reads each with 0, 8 and 12 busy loops on 12 cores) where a PowerShell started for each read took 0.4–0.7 s, and 9–12 s with every core busy; the reader costs one resident process of about 80 MB working set, 65 MB private (measured again: `-NoLogo` changes nothing, a garbage collection after start saves 1 MB, and trimming the working set to 26 MB leaves the 65 MB committed; PowerShell 7 was not there to try). A reader that cannot answer (it would not start, or ended) leaves one read in a PowerShell of its own; a table that cannot be read within `STOP_LIST_MS` (3 s) leaves `taskkill /T` on the child, every root side by side. The stops a shutdown starts in one turn share one read; the host waits for them at most `STOPS_SETTLE_MS`, once (see the shutdown wait above). The keeper gives a Windows host that long and more after its polite request (stdin closed): `STOP_GRACE` is the host's whole shutdown bound, 10 s (`HOST_SHUTDOWN_BOUND`, the same number as `SHUTDOWN_BOUND_MS`, checked by `shutdown.test.ts`), and 2 s; on unix 3 s. A host at rest exits in well under a second, so only a slow quit is longer. Its sweep after the exit (unless `sweep: false`) finds what the child started after the table was read. What an MSYS program forks has an ended intermediate as its parent, so neither reaches it (a hook's `sleep`); it ends with the host's work job (`lifecycle/work-job.ts`, measured). `killTree` and `stopTree` return before the table is read, so the host's shutdown waits for the stops they started (`stopsSettled`, at most `STOPS_SETTLE_MS` = 9 s, under the host's own 10 s bound, before the server closes): a host that exited first left a terminal's hidden child running (#2141). A child that no step of its own ends (an ssh, a version probe, a setup script) stays in the host's group, so the supervisor's group signal reaches it, and a stop signals the members of its tree that stand in that group one by one (`StartOptions.contained`) | `os/kill-tree.ts`, `os/real.ts` |
| Terminal / Run button | login shell `-l` / `-lc` | `pwsh` or Windows PowerShell, `-NoLogo` / `cmd.exe /d /s /c`, on the ConPTY node-pty ships (`useConptyDll`, `conpty/` in the bundle): Windows' own left a `conhost.exe` per tab and command until the host exited (#849) | `dev-services/terminal.ts`, `dev-services/pty-slot.ts` `spawnPty`, `os.ts` `usesShippedConpty` |
| Watching the file tree | one watcher per expanded folder | one recursive watcher on the project's root: a watched folder, and every folder above it, cannot be renamed or moved (#849) | `dev-services/watch.ts`, `os.ts` `traitsFor().locksWatchedFolders` |

Quitting closes the host's stdin (it runs with `--watch-parent`, so EOF runs the same shutdown as
TERM) and ends its tree with `taskkill` only if it is still running after the grace period. A
worktree setup command runs under `cmd.exe`, so it reads `%CENTRALU_WORKTREE%`, not
`$CENTRALU_WORKTREE`.

**Its work ends with it; a terminal's does not (#1067).** Windows does not end a process's children when it ends. A
host that crashed or was ended left behind whatever its work had started through a program that is not Node: codex's
MCP servers, a dev server a Run command's PowerShell started, what a git hook started. libuv's own job lets a child's
children leave it silently, and what a ConPTY starts leaves it too. At start the host joins a job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway, and holds its only handle (`lifecycle/work-job.ts`, the `work
job` start step; one PowerShell, run while the store opens). From then on nothing it starts can leave: libuv's job ends
what can no longer leave it when the host ends, and the job's own flag ends the rest (the test reads the flag back).
Breakaway stays off because Git for Windows' sh asks for it, and a hook's children then outlived the host.

Terminals are the person's, not the host's work: what is started in one (`code .`, the browser `claude auth login`
opens) must outlive a host that crashes. They are started by a broker the host starts **before** it joins
(`dev-services/broker-pty.ts`, `pty-broker.mjs` beside the host): a Node process that owns node-pty and speaks one
JSON line per message over its stdin and stdout, behind a node-pty-shaped surface. It ends
with the host and its pseudoconsoles with it, so the shell ends as before, but what the shell started outside its
console stays. A quit still ends each terminal's tree as before. Run commands, agents, git and app servers stay in the
job. A broker that cannot start, or ends, leaves new terminals to start in the host. The host joins the job under a keeper too
(`lifecycle/work-job.ts`): the keeper holds none of its children any more (#1895 step 4), and a detached grandchild
of a dev server survived `taskkill /F` of a host that did not join (measured with `CC_KEEPER=1`). The host opens nothing for the person: "Open in IDE" and
`system.openUrl` are the window's. A host that cannot join (PowerShell refused, an outer job that forbids it) says so
in its log and runs as before.

**How a Claude process is started on Windows (#353).** Claude Code installed with npm is one
program, `node_modules\@anthropic-ai\claude-code\bin\claude.exe`, which npm's `claude.cmd` starts
and which the host starts directly since #307. That file is a second name (a hard link) of the
platform package's `claude.exe`. Windows lets a running program's names be renamed, and deleted
while another name remains, but never deletes the last name or writes over it. An npm update
deletes both names and creates new files; with a Centralu session running from `bin\claude.exe`
the second deletion is the last name and fails, and Claude Code's setup step (`install.cjs`) then
leaves npm's 500-byte placeholder behind: a text file named `.exe` that Windows calls a 16-bit
program. So, on Windows only (`adapters/claude/exe-link.ts`, `start-gate.ts`):

| Step | What happens | Why |
|---|---|---|
| Placeholder check | an `.exe` under 1 MB that does not start with `MZ` fails the session start, and `detect`, with the file, the cause and the fix (`node "<pkg>\install.cjs"`, or reinstall with no Claude Code running) | a spawn error would only say "16-bit program" |
| Placeholder repair (#1645) | before it fails, the host runs the package's own `install.cjs` beside the placeholder with its own Node, beside the host's loop (`execFile`: no shell, 30 s limit, nothing else, no download), then proves the result is the program: the size of the platform package's `claude.exe` it was copied from, or `claude.exe --version` exiting 0 when that package is not found (a copy cut short is large but not the program, and is refused). Once per package path per host start; starts that arrive meanwhile wait for the same run. A file a running Claude Code still holds stays a placeholder and the message says so (no process is stopped); a setup step that fails otherwise has its first error line in the message. Each step is a `[claude]` line on stderr | the person otherwise has to find a terminal, the path and the command, on a machine that may be remote. `install.cjs` is safe to re-run: on a placeholder it links the platform program over it, silently, exit 0 (measured on Claude Code 2.1.296); when the file is held it prints `Failed to place binary: EBUSY` and exits 1, the placeholder untouched |
| Hard link | the program is hard-linked into `<data>\tools\claude\<version>-<size>\claude.exe` (data = `CC_DATA_DIR`) and started from there; a copy when linking fails (`EXDEV`, `EPERM`); npm's path itself if both fail, with a log line | an npm update deletes both of npm's names for the program and creates new files there; Windows refuses to delete the last name of a running program, so with a session running from npm's name the update fails, and with one running from the link it succeeds (measured on NTFS); a link costs no disk |
| Link key | the version from npm's `package.json` next to the program plus its size; outside npm, size and modification time | free to read; `--version` would run npm's file, a content hash reads 250 MB per start; npm stamps every file with one time |
| Cleanup | a link folder goes when no session of this host runs from it and it is not the one new sessions use: at host start, when the installed version changes, when a session's process ends | removing a link never disturbs a process running from it; Windows refuses only the last name of a running program, and that folder goes on a later sweep |
| Spaced starts | Claude processes start one at a time, 1.5 s apart | the sign-in is a file with one refresher at a time; processes started together all refresh an expired token at once |
| Refresh race | a turn that ends with "another Claude Code process is refreshing it" is sent again once after 3 to 6 s, with a notice in the conversation; a second loss is reported | the CLI calls it transient; the other process has written the new token by then |
| Leaving | on quit the host waits up to 1.5 s for the Claude processes it closed to exit on their stdin EOF | a Node process takes its children with it when it exits, which could cut a refresh mid-write |

The retry runs on every platform (it costs nothing where the race never happens); the rest is
Windows only, because macOS and Linux replace a running program without complaint and macOS keeps
the sign-in in the keychain. Ending one session needs nothing extra: on Windows the SDK closes the
CLI's stdin and kills it only after 7 seconds. A process that is mid-turn when the host quits is
still ended with the host, as before. A Claude Code update installed while sessions run is picked
up by each session's next start; the old version's link goes once its last session ends.

**How a Codex process is started (#568).** `npm i -g @openai/codex` installs `bin/codex.js`, a Node wrapper that
finds the platform binary (`@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex`), starts it and stays alive only
to forward signals. Measured on codex-cli 0.160 (macOS arm64): an idle `codex app-server` started through the
wrapper is 44 MB of `node` plus 115 MB of binary; started directly, the 115 MB alone. So every Codex client the host
starts (a session's app-server, in the keeper or not, and the short-lived ones for usage, models, history, fork and
delete) starts the binary where the wrapper would find it (`adapters/codex/native.ts`): nested in the package
(npm), beside it (pnpm, hoisting installs), or the package's own `vendor/`. It sets what the wrapper sets,
`CODEX_MANAGED_BY_<NPM|PNPM|BUN>` and `CODEX_MANAGED_PACKAGE_ROOT`, which the binary reads for its update hint and
its install check; it finds `codex-path/rg` and `codex-resources` beside itself. Anything else (a Homebrew cask, a
binary on PATH, a wrapper whose platform package is missing, a platform the wrapper does not know) starts as found.
`CC_CODEX_NATIVE=0` starts the wrapper as before.

The one addition (#280): under the keeper (`CC_KEEPER=1`), the host also writes
`{"activity":{"busy":true|false}}` to stdout, once at start and whenever it changes
(`keeper-link.ts`). That is what the keeper's idle rule reads. Started any other way, the host
writes nothing but the ready line.
