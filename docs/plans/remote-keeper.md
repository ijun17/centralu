# A keeper on linked machines: updates that keep what runs there (#1614)

> **Status: decided (owner, 2026-10-26, §12), being built from step 1.** The root fix for #1614: an update of a linked
> machine switches at once and keeps what runs there, as an update on the Mac does, instead of waiting for a moment when
> nothing runs (#1399, #1508, #1579). It is runtime-unification steps 9 and 10 ([runtime-unification.md](runtime-unification.md)),
> ordered so that a linked machine gets them first. The Windows part was measured on a linked Windows 11 PC on
> 2026-10-26 (§3); nothing was measured on Linux or WSL for this document.
>
> **Short version.**
> 1. **The keeper on remotes, headless** (option A, §4.1): `serve` starts `centralu-keeper` instead of the host, the
>    keeper holds the agents, terminals and project commands, and an update is the keeper's blue-green host swap. Turns
>    in flight, background tasks inside the agent CLIs, terminals and commands all survive.
> 2. **Nothing waits for idle** (owner, §12 decision 3). Where a swap cannot keep what runs (a remote without a keeper,
>    the first update into one, a host that needs a newer keeper, the keeper's own replacement on Windows), the update
>    goes ahead at once and the sessions whose turns it ended are continued once afterwards (§5.1); terminals and
>    project commands close. This ends #1614's wait on every remote before any keeper ships (step 2).
> 3. **Not a rolling handover at turn boundaries** (option B, §4.2): it keeps only turns in flight, never terminals or
>    commands (they have no turn boundary, which is what held the second machine in #1614), needs two hosts writing one
>    store for as long as the longest turn, and gives the Windows desktop nothing.
> 4. **The keeper's own update is separate from the host's** (§5): a host swap needs only a keeper that speaks its
>    host API. On Linux the keeper also hands itself over at once (measured in
>    [spikes/2026-10-linux-keeper.md](../spikes/2026-10-linux-keeper.md) §5). On Windows, until a handoff exists there, a
>    keeper of an older build stays, shown on the machine's row, and is replaced when that costs nothing or the person
>    chooses to.
> 5. **Windows: the same Rust keeper as the desktop, first without its handoff** (owner, decision 1; §6). Measured here: a
>    pseudoconsole's program ends with the process that created it, so that process has to be the keeper; a process WMI
>    starts from the hub's ssh session holds a pseudoconsole and a piped agent across the end of a host and of that ssh
>    session, and a next host reattaches to both with their state.
> 6. **Linux first** (steps 1, 3 to 5): the keeper exists there and only needs a place in the host-only package and a
>    headless mode. **Windows next** (steps 6 to 8), which is what the owner's two linked machines run.

## 1. What happens today, and why it waits

An update of a linked machine (`links/update.ts`, [agent-host.md](../agent-host.md) §4.8 "Updating, rolling back and
uninstalling") installs the new version beside the running one, then `HostControl.beforeStop` waits, then `serve
--stop` stops the host, the pointers switch, `serve --detach` starts the new version and a hello from it ends the update.
`serve --stop` ends everything the host started: no remote runs a keeper ([remote-hub.md](remote-hub.md) §10.4), so
an agent CLI, a terminal's shell and a Run command are the host's children, and on Windows the host's work job
(`lifecycle/work-job.ts`, #1067) ends them with it.

The wait exists only because of that: wait for no turn (#1399), and when the hub follows its own version with no one's
click (#1508), also for no open terminal or command, giving up after `OPEN_WORK_WAIT_MS` (#1579). On 2026-10-26 (#1614)
one linked Windows machine stayed in `wait_idle` for over an hour with 3 to 6 sessions in a turn at every reading,
because agents started from the hub kept working there; the other stayed in `wait_open` behind one open terminal and
gave up after 30 minutes. A longer wait, more retries or pausing the work sent there all still end the work or depend
on luck. The fix is to keep what runs.

**What the Mac keeps, and how** (agent-host.md §4.1 to §4.4, architecture.md §4.2 to §4.4). The keeper is the host's
parent and holds every long-lived child on `children.sock`: an agent's pipes with a lossless 64 MiB stdout buffer, a
pty drained into a 256 KiB ring, a command's pipes. A swap starts the new host in standby, drains the old one (new
calls refused, running calls cut with a retryable error, then `stopServices('detach')`, which releases the held
children without signalling them), activates the new one behind the same front-door port and token, and the new host
lists the keeper's children and reattaches: a live agent through `resumeSession` with its turn still running (measured
for claude and codex, agent-host.md §4.3), terminals and commands under their ids with the ring replayed. What does not
survive even there: app processes and in-process servers (restarted by the new host), a Centralu tool call in flight
(cut with a retryable error), and open app views older than ten minutes (§4.2's handover record).

## 2. What has to survive, and what each piece lives in

| Work | Lives in | Survives a host swap when |
|---|---|---|
| A turn in flight | the agent CLI's process (claude, `codex app-server`) and its stdin/stdout | the CLI's process and both ends of its pipes outlive the host |
| Background tasks (claude's background Bash, a codex command still running) | children of the CLI, in its group (posix) or tree (Windows) | the CLI survives and nothing sweeps its group or job |
| A terminal | a shell under a pty (posix) or a pseudoconsole (Windows) | the pty master or the pseudoconsole outlives the host |
| A project command (Run) | a shell or program on pipes | as an agent |
| An open Centralu tool call | the host | never: cut by the drain, retryable (§1) |
| App processes, in-process MCP servers | the host | never: restarted by the new host, as on the Mac |

So whatever outlives the host has to hold pipes, ptys and pseudoconsoles. That is the keeper's children service, or
something that does its job.

## 3. Measured on a linked Windows 11 PC (2026-10-26)

Node 22.23.4 and node-pty 1.1.0 (the version the host bundles, with its `conpty.dll` and `OpenConsole.exe`), each in a
temporary folder; no Centralu data folder was opened. The probes are small Node scripts: a "host" that starts children
in a given way, a "holder" that owns one PowerShell under a pseudoconsole and one piped agent stand-in (it answers each
line with its pid and a counter) and serves them on a named pipe, and a driver that ends the host with
`taskkill /F` (a crash, the hardest case) or a clean exit. The local runs (P1 to P4) ran inside an outer job that stayed
open throughout, so they show what the parent's own exit does and nothing else. The ssh runs (P5, P6) used that PC's
own OpenSSH with a key: a network logon in session 0, which is what a hub's link gets. A managed remote runs the
pinned Node 24 (`packaging/remote-runtime.json`), not 22: what P1 and P2 show is libuv's job, which both majors set up
the same way as far as known, but step 6 measures again on the pinned Node.

| # | Started how | After the parent ends |
|---|---|---|
| P1 | Node `spawn`, pipes, not detached | **Ends**, on a clean exit and on a kill: libuv puts the child in its job with `KILL_ON_JOB_CLOSE` |
| P2 | Node `spawn`, pipes, `detached: true` | Runs, but its next write to stdout fails with `EPIPE`: an agent CLI would lose its turn's output or exit |
| P3 | node-pty (ConPTY), the program a Node ticker | **Ends**, on a clean exit and on a kill: closing the pseudoconsole ends what runs in it |
| P4 | A holder started `detached` by host A; host A killed; host B attaches over the named pipe | **All kept**: the same shell pid, a variable set through host A read back through host B, the agent's pid the same and its counter at 2, a resize from host B applied |
| P5 | The same, host A run inside an ssh session, the session then closed | **Holder, shell and agent gone** with the session: OpenSSH on Windows ends the session's processes (remote-hub.md §10.4, RE7) |
| P6 | The holder created through WMI (`Win32_Process.Create`) by host A inside an ssh session; the session closed; host B run in a second ssh session | **All kept**, as P4: shell `KEPT=kept-42` with its pid, agent counter continuing, resize applied. A pseudoconsole works in session 0 under a network logon |

Also seen:

- **The ConPTY node-pty ships waits for an answer to its first query.** It writes `ESC [ c` (a device-attributes
  query) and runs nothing until the terminal answers: a program under it printed nothing for 2.5 s, and at once after
  the holder wrote `ESC [ ? 61 ; 1 c`. Today the window's terminal answers through the host. Whoever holds a
  pseudoconsole must pass that query to an attached host, and answer it itself when none is attached, or a terminal
  started in the moment of a swap never starts.
- **Footprint.** The Node holder with node-pty loaded: 75 MB working set; each pseudoconsole adds an `OpenConsole.exe`
  of 11 MB; the PowerShell in it 77 MB. The Rust keeper's executable is 2.4 MB (linux spike §6); its resident size on
  Windows is not known until it exists.
- **How often the keeper changes.** Across the 20 releases from 0.1.0-beta.21 to beta.40 (13 days), 10 had a commit
  under `apps/desktop/src-tauri/keeper/` (12 commits: fixes to the swap, handoff and children service such as #893 and
  #971, the token's delivery #1100 and #1430, the window's refusal message #1400, a settings file #1048, a test #1285),
  and the host changed in all 20. So "update the keeper only when it changed"
  still means half of the updates: the keeper's own update needs its own rule (§5).
- **Not measured here:** the sign-in task path (#1224). Nobody was signed in on that PC, and a task whose principal is
  `Interactive` does not run without a sign-in (Task Scheduler reported it `Ready` right after `Start-ScheduledTask`,
  and the action never ran). Neither did anything about the Rust keeper on Windows, which does not exist yet.

The probe scripts were throwaway and are not kept; every process they started was ended and checked gone.

## 4. Options

### 4.1 A. The keeper on remotes, headless (recommended)

`centralu serve` starts `centralu-keeper` in a headless mode, which starts the host and holds its children exactly as on
the Mac; an update is the keeper's host swap to the version `current` names.

| | Linux and WSL | Windows |
|---|---|---|
| Turns in flight | kept (the swap of agent-host.md §4.2 and the reattach of §4.3, as measured on macOS and in `keeper e2e (linux)`) | kept, once the Windows keeper exists (§6); P4 and P6 show the OS allows it |
| Background tasks | kept with their CLI: a detach sends nothing, so nothing sweeps the group | kept with their CLI, in its job |
| Terminals | kept (pty in the keeper, ring replayed) | kept (pseudoconsole in the keeper, P4, P6) |
| Project commands | kept | kept |
| Link to the hub | the front door keeps the port and token, so the ssh forward stays up and the hub's client reconnects to the same port in the drain's gap | the same |
| Cost | a headless mode, the keeper in the host-only package, `serve` starting it (steps 1, 3 to 5): 4 to 6 agent days | the Windows half of the keeper (runtime-unification step 9) without its handoff: 6 to 9 agent days, the largest and least certain part |
| What breaks | WSL with WMI blocked (`wmi_blocked`, remote-hub.md §10.4) runs a link-bound host, and a link-bound keeper ends with the link like that host does: no gain there, no loss. `KillUserProcesses=yes` ends a keeper started without linger, as it ends the host today | a keeper started from inside the ssh session would die with it (P5): only `serve --detach`'s WMI or sign-in-task start may start it, never the host (whose work job allows no breakaway) |

Every rule the keeper already has comes along: one keeper per data folder, restarts by the five-failures rule, the
drain, the standby check that refuses a store only a newer build reads before anything is stopped, mixed versions of
keeper and host (agent-host.md §4.2), and the same keeper on the Windows desktop later (#14), which is the plan's end
state anyway (runtime-unification §7, items 1 and 8).

### 4.2 B. A rolling handover at turn boundaries (not recommended)

The new host starts beside the old one and takes each session over when its turn ends; the old host keeps the
running ones and exits when it has none.

- **Keeps turns in flight only.** A terminal or a command has no turn boundary: it is ended or it keeps the old host
  alive indefinitely. #1614's second machine waited on exactly one open terminal. Background tasks outlive their turn,
  so taking a session over at its turn's end ends them, or has to wait for them too.
- **Two hosts own one data folder for as long as the longest turn**, which can be hours (an orchestrator with delegated
  sessions). Today one host owns the store (`host.lock`, `Store.migrate()`), and the expand-then-contract rule only lets
  the previous build *read* while a swap is under way. Two writers for hours, the new host's heavy and breaking steps
  postponed until the old one ends, and two event streams for the hub to merge are each a new design.
- **The hub's link carries one host per machine.** It would route each session to one of two remote hosts on one
  forward, a new routing layer on both sides.
- **The idle sessions gain nothing over today**: taking one over means a new CLI on the stored conversation, which a
  restart already does.
- **Cost**: large changes to the host, the store and the links, nothing reusable for the Windows desktop, and it still
  ends terminals and commands.

### 4.3 C. A Node holder on Windows, grown from the pty broker (not chosen: owner, decision 1)

The host on Windows already starts a Node process that owns node-pty, the terminal broker (`dev-services/pty-broker.mjs`,
#1067), and ends it with itself. Instead, `serve` would start such a holder outside the host's job, it would hold
agents and commands too and speak the keeper's `children.sock` protocol on a named pipe, and the next host would
reattach as it does to the keeper. P4 and P6 are exactly this, and it works.

- **For it**: soonest on Windows (2 to 4 agent days); node-pty's ConPTY is already the one the host uses (#849); the host's
  child-service client needs only another socket path; no Rust on Windows.
- **Against it**: a second implementation of the children service (buffers, whole lines, exit after drain, the sweeps),
  which is the problem runtime-unification §1 exists to remove; Node has no Job Object API, so a job per child costs a
  PowerShell per spawn (0.3 to 0.8 s, as the work job measured) or a native addon per architecture; 75 MB resident for
  as long as the machine runs; it gives the host swap nothing (the host would still be stopped and started, and the link
  dropped, with no front door); and the Windows desktop still needs the Rust keeper (#14).

### 4.4 Also considered

- **Detached children the next host adopts, with no holder.** P2: the child lives, its pipes do not. Named pipes the
  child opens itself would need every agent CLI to cooperate.
- **Waiting smarter** (pausing what the hub sends, retrying more): ends the work or depends on luck (#1614).
- **Moving the keeper's job into the launcher (`serve`'s Node process)**: option C under another name.

## 5. The keeper's own update, apart from the host's

A host swap needs a keeper that speaks the host's API, not the newest keeper. So:

- **The keeper reports what it offers a host as one number** (`keeper.hostApi` in its `status`, and in the connection
  line, §8): the child socket, the stdin control lines and the swap together. It is not the `protocol: 1` the child
  socket's and `attach`'s first lines already carry, which says how a connection is framed. It is raised only when a host
  needs something an older keeper lacks. The host's `bundle-info.json` carries the lowest it accepts (`needsKeeper`). A
  test pins both with their history, as `PROTOCOL_VERSION` is pinned, so a raise is a decision in a pull request and not
  a side effect.
- **The keeper serves older hosts**, so a rollback swaps to the previous host without touching the keeper. This is a new
  rule, not one that exists: agent-host.md §4.2's mixed-version table covers only how the token is delivered. Step 5
  adds it with a test that runs the previous release's host under the new keeper.
- **Linux and WSL**: when the new version's keeper is another build, the swap is a `switch` with `keeper`, which hands
  the keeper over first and then swaps the host (agent-host.md §4.4; measured on Linux in the spike's §5: host,
  terminal and dev server kept their pids, the front door and an open WebSocket survived). Everything is kept.
- **Windows, until it has a handoff** (step 8): the host swap keeps everything and the keeper stays on its build
  ("lags"). The machine's row in Settings → Machines says so (owner, decision 2; not the sidebar). Nothing waits for
  the keeper's replacement (decision 3). It is replaced:
  - when that costs nothing: at a connect or a follow tick where the keeper's `stop { ifIdle }` (§8) says nothing runs,
    checked once and never waited on;
  - when the person chooses Update on that row, which replaces it at once by §5.1;
  - when a host needs a newer keeper than the one running (below), by §5.1;
  - at a reboot or `serve --stop`, like any process.
- **A host that needs a newer keeper than the one running**, and **the first update into a keeper** (from a version
  whose `serve` starts no keeper), cannot keep what runs: the old keeper or the old host owns the children. They go
  ahead at once by §5.1. From then on, swaps keep everything.

### 5.1 Where a swap cannot keep what runs: at once, then resume (owner, decision 3)

The cases: a remote whose `serve` has no keeper (every remote today, and WSL with WMI blocked), the first update into
a keeper, a host that needs a newer keeper, and the keeper's own replacement on Windows. In each, the update stops and
starts at once, as `when: 'now'` does today, and continues afterwards the turns it ended, the way sessions are taken up
again when a linked machine comes back after a network drop ("<machine> is back — resuming N sessions"). Terminals
and project commands cannot be continued: they close, as they do today when the person presses Update.

1. **Before the stop** the hub reads the machine's sessions in a turn (`host.activity`, as `beforeStop` does now, but
   once and without waiting) and writes their ids to `<data>/remote/resume.json` there, `{ v: 1, update, ids, at }`,
   through the same `remote-install.mjs` step that writes the pointers. `update` is an id of this update.
2. **The new host reads it at start**, before it lists sessions, and deletes it: a file older than ten minutes is
   ignored, as the views' handover record is (agent-host.md §4.2). For each id whose session the start finds cut
   (`interruption: 'quit'`, set because it was working with no process), it withholds the quit notice to the asker
   (`quitNotices`, agent-host.md §4.6.2), and once it serves sends that session the one Continue sentence Centralu
   already uses ("Continue where you stopped. Check what already happened before repeating a step."), as Centralu's
   note, not as the person's message. The session's report owed, if any, stays owed and the continued turn settles it.
3. **Once.** The file is deleted before anything is sent, so a host that restarts again sends nothing more. A session
   that is not `quit` at that start (the person stopped it before the stop, which sets no interruption; it was written
   to meanwhile; it was archived or deleted) is not continued. A session the person stopped is never continued.
4. **The window** shows the existing "<machine> is back — resuming N sessions" when its machine's resync finds them,
   as it does after a network drop (`recoverMachine`); nothing new is drawn.
5. **An older new version** (a rollback to a host from before this file) ignores it: the turns stay cut with their
   "stopped" mark and Continue, as today. The hub deletes a file still there at its next connect.

This replaces `beforeStop`'s wait everywhere: `wait_idle`, `wait_open`, `wait_unread` and `OPEN_WORK_WAIT_MS` go, and
`when` stops mattering. Following the hub (#1508) then updates a busy machine at once too.

## 6. Windows specifics

**No keeper today.** The window runs the host directly (`StartMode::Direct`, agent-host.md §4.0), and a remote's `serve`
runs it under the launcher. The keeper crate is `cfg(unix)` throughout: its reactor is `poll(2)`, its sockets unix
sockets, its lock `flock`, its handoff `SCM_RIGHTS`. The OS layer (`keeper/src/os/`, runtime-unification §3.3) names the
Windows operation for each; `os/windows.rs` today has only the window's direct path (stop by closing stdin, `taskkill /T`).

**What step 6 builds, in the OS layer, and nothing of the handoff:**

| Operation | Windows |
|---|---|
| Channels (`keeper.sock`, `children.sock`) | named pipes, per data folder (`\\.\pipe\centralu-<hash of the data folder>-keeper`, `-children`), a DACL for the user's SID only, `FILE_FLAG_FIRST_PIPE_INSTANCE` on the first, the peer's pid from `GetNamedPipeClientProcessId` |
| One keeper per data folder | `LockFileEx` on `keeper.lock`, released by the OS however the keeper ends |
| Reactor | a reader thread per pipe end instead of `poll(2)` (dozens of children, not thousands); the buffers and their rules unchanged |
| Contain a child | a Job Object per child: created suspended, assigned, resumed (runtime-unification §3.3), the handle held only by the keeper. Agents and commands: the job ends them with the keeper, as the work job does with the host today. Terminals: no `KILL_ON_JOB_CLOSE`, so what a person starts in one outlives a crash (#1067), while closing a terminal still ends its tree (`TerminateJobObject`) |
| A terminal | ConPTY through the `conpty.dll` and `OpenConsole.exe` the host package already carries for node-pty (#849), so no `conhost.exe` is left per terminal; the device-attributes query answered while no host is attached (§3) |
| Stop a host | closing its stdin, then `taskkill /T` (exists) |
| Who starts it | the launcher (`serve`), as its one child where the host is today, with no console (ST13). It needs no breakaway: the launcher itself is created outside the ssh session (WMI or the sign-in task) and stays the keeper's parent (§8), so the keeper lives as long as the host does today |

**How processes outlive the host** (P1 to P6, #1067). libuv's job ends a Node child with its parent (P1); the host's
work job allows no breakaway, so nothing the host starts after joining can outlive it; a pseudoconsole's program ends
with the process that created it (P3). So the keeper must be started by the launcher, never by the host, and must create
every pseudoconsole and pipe itself. Killing the launcher still kills the keeper without its shutdown (RE8, libuv's
job), as it kills the host today, so `serve --stop` asks the keeper first, as it asks the host now. Under a keeper the host joins no work job (already so in `work-job.ts`). Handle
inheritance plays no part: the keeper creates each child with only that child's ends inheritable
(`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), so no child holds another's pipe open, and a host gets its streams over the
named pipe, not by inheritance.

**A network logon or an interactive one.** A process keeps the logon it was created in. Created by WMI from the hub's
ssh, the keeper and all it holds run in session 0 under a network logon (P6), without the user's credential vault
(#1224); created by the sign-in task, in the person's session. Nothing can move a running process from one to the
other, so the hand-over from a network-logon keeper to the sign-in task's (remote-hub.md §10.4) still waits until
nothing runs, as now. That wait is rare (once per sign-in) and is not the update's.

**The scheduled task.** The task's action runs the managed launcher, which starts the keeper; the task's settings stay
(`ExecutionTimeLimit` zero, `IgnoreNew`). Whether Task Scheduler ends a task's processes when the task is stopped is
no different for a keeper than for today's host, which the launcher also starts; it is measured in step 6 on a
signed-in PC with runtime-unification's W3, and was not measurable here (§3).

**Administrator rights.** None needed: per-user named pipes, Job Objects over one's own processes, `LockFileEx`, and a
per-user task (`Limited`). An administrator's ssh logon carries the full token (remote-hub.md §10.9c), so a keeper WMI
starts from it runs elevated, as today's host does, and so does everything it holds. Whether a medium-integrity window
(`serve --window` in the person's session) may open the pipes of a keeper created at high integrity is measured in
step 7.

**A handoff on Windows** (step 8) needs W1 (the lock across processes) and W2 (whether a pseudoconsole can be kept by a
process other than its creator: its in and out pipes can be duplicated, its resize and close go through a handle the
API does not expose). Neither is on the path of a host swap, which is why the steps keep it last.

## 7. The release change

- **The keeper is a plain file beside `host/`** in each host-only package, named exactly in its `files`
  (`hostPackageFiles`, `scripts/host-package.mts`): `@centralu/host-linux-x64` and `-linux-arm64` ship
  `files: ["host", "centralu-keeper"]` from step 1; `@centralu/host-win32-x64` ships `files: ["host"]` until step 7
  adds `"centralu-keeper.exe"` there. The release stages it into `packaging/npm/host-<platform>/`, where `.gitignore`
  covers it as it covers `host/`, so a second run finds the tree clean. On the remote it lands at
  `<data>/remote/versions/<v>/node_modules/@centralu/host-<platform>/centralu-keeper`, so it runs from a plain folder of
  the hub's install and never from an AppImage's mount (linux spike §6). About 1 MB more per package packed. The
  platform packages keep their own copy for the window.
- **Built by the job that builds that platform's package**, from the same commit. linux-x64 and linux-arm64 already
  compile the keeper for their AppImage, and the host-only package takes the copy that AppImage carries (the bytes the
  platform package ships, not cargo's). win32-x64 compiles it once step 6 makes the crate build on Windows.
- **Checked before publishing, by one check.** `hostPackageProblems` (`scripts/host-package.mts`, a pure function)
  requires `files` to be exactly the list above and the keeper beside `host/`, and refuses any other entry in the
  package folder. The Linux keeper itself has one check, `keeperProblems` (`scripts/host-package.mts`), which
  `release-npm.mts` runs on the AppImage's copy and `hostPackageProblems` on the staged package's. It reads the file's
  own bytes (`scripts/elf.mts`), so it runs on any machine, a test on Windows included, with no `file`, `ldd` or
  `readelf`: an ELF executable (type `EXEC` or `DYN`) for the platform's machine (`0x3e`, `0xb7`), with its exec bit,
  linking by name (`DT_NEEDED`) nothing beyond the C runtime (glibc's libraries, the dynamic loader, `libgcc_s`). That
  is an allow-list rather than a list of window libraries, so a window library that would come in through another
  library is refused too, with no `ldd` to follow it. And it asks, in its version needs (`DT_VERNEED`, what
  `readelf -V` lists), for no glibc newer than `MIN_GLIBC` (`links/install.ts`), the floor a remote's preflight checks
  before an install: the build machine's glibc sets that number, so a runner moved to a newer distribution fails the
  release instead of a 22.04 remote. The macOS bundle's keeper, which no host-only package carries, keeps its own
  check in `release-npm.mts` (`checkMacKeeperExe`: `file` and `otool`). For step 7, the Windows keeper's check reads
  the PE header (machine `0x8664`, a subsystem that opens no console window) and its import table (no
  `WebView2Loader.dll`, nothing of the window). Tests (`tooling/host-package.test.ts`, `tooling/elf.test.ts`) run the
  check against stand-in packages with the keeper missing, not an ELF, not an executable, for the other machine,
  without its exec bit, linking a window library directly or through another library, and asking for glibc 2.35.
- **Trust** stays remote-hub.md §10.3: the hub checks the package's registry signature and sends its `integrity`, and
  the remote refuses a tarball that does not match, so the keeper's bytes are checked exactly as the host's are.
  Signing host folders, the keeper included (owner decision 6 of §10.9; runtime-unification decision 1), stays open and
  is not needed for this. No Windows code signing exists (releasing.md "Unsigned: SmartScreen"); a file `tar.exe`
  unpacks from a `curl.exe` download has no mark of the web, so SmartScreen does not judge it. Defender may scan it at
  its first start and delay that start; not measured, and step 7 measures it.
- **Pruning keeps what still runs.** On Windows a running executable cannot be deleted and a recursive removal of a
  folder holding one stops half done (RE13). After a swap more than the keeper runs from older versions: a lagging
  keeper's own folder, and each kept Codex session's bridge, which runs as that version's Node on that version's host
  folder (`adapters/bridge-path.ts`) until the session's app-server ends. So the keeper writes
  `<data>/remote/in-use.json` (the versions and Nodes it and every held child run from) whenever that set changes, and
  `prune`, a plain `.mjs` run over ssh, keeps whatever it names besides `current` and `previous`; the next prune after
  they are gone removes them.

## 8. On the remote and on the hub

**On the remote** (`serve` and its modules, and the keeper's headless mode):

| | Change |
|---|---|
| Who runs what | `serve` (and `--detach`, `--window`), when the version's package has a keeper and `CENTRALU_KEEPER` is not `off`, starts the keeper headless where it starts the host today, and stays its parent exactly as it is the host's parent now. So the systemd unit, the WMI-created `wsl.exe` that holds a WSL distro, and the sign-in task keep the process they hold, and `serve.pid` gains `keeperPid` beside `pid`, `hostPid` and `port`. With no keeper file, or `off`, the host as now |
| What `serve` hands the keeper | the port and token `serve.json` keeps (the token on stdin, as the host gets it now), the pinned Node's path (the keeper takes it instead of looking for a Node on PATH, `host_proc/node.rs`), the host folder of `current`, and what `serve` passes the host today about who started it (`CC_SERVE`, `--from`'s name for `host.lock`), which the keeper passes on to each host it starts. Today the keeper opens its front door on port 0 with a fresh token (`keeper/server/start.rs`); headless, it takes both, so the hub's cached token and `--connection` keep working and the forward does not move |
| Headless mode | no attach grace and no idle exit: a remote keeper lives until stopped, the machine reboots or it crashes, as a remote host does today; logs to `<data>/keeper.log`. `--detach` returns when the keeper's host answers, as now |
| Stopping, and stopping when idle | Today `host.stop` and `host.stop { ifIdle }` are wired only in a host `serve` started without a keeper (`main.ts`, `startedByServe && !underKeeper`); under a keeper the RPC answers that the host cannot tell. Headless, the keeper takes the request: `stop { ifIdle }` on its control channel asks its host over the stdin control lines whether anything runs and refuses every new call from that answer on (the host's existing stop gate), then stops everything. `serve --stop`, the sign-in hand-over (`serve-handover.mjs`) and §5's idle replacement of a lagging keeper all use it |
| `--connection` | additive `keeper: { pid, build, hostApi, lags }` and `"switch"` in `takes` |
| `--switch` (new) | asks the keeper to swap to the version `current` names (with a keeper handoff where §5 allows) and returns when the swap has ended, the old host back or the new one serving: `{ v: 1, switch: { ok, version, keeper, message? } }` |

**`--switch` and #1405.** The keeper refuses `switch` and `upgrade` to every peer that is not a window
(`window_peer.rs`): they start code of the caller's choosing with the front door's token. A headless keeper has no
window, so `--switch` is a new control op, `swap_current`, that names no code: the keeper reads `current` and swaps only
to a folder under `<data>/remote/versions/` with an `install.json`. That is still a deliberate exception to #1405: any
process of this user, an agent included, can rewrite `current` and ask. What it gains is little: on a remote the token
already sits in `serve.json`, readable by that same process, and rewriting `current` then `serve --stop` and `--detach`
already starts that code today. The owner accepted the exception (decision 4), limited to the local `serve --switch`:
`swap_current` is taken on the control channel only, never over the front door's limited token, and is written into
security-boundaries.md in step 4.

**On the hub** (`links/update.ts`, `linked-machine-ops.ts`): the update takes the swap path when the machine's line has
`switch` in `takes`, a running keeper, and `keeper.hostApi` at or above the new host's `needsKeeper`:

1. Install beside (unchanged).
2. Hold (unchanged): the link starts no `serve --detach` of its own until the end, so nothing starts the old version
   in the drain's gap.
3. Pointers: `previous` = the old `current`, `current` = the new one (as now, but before the swap, since the keeper reads
   `current`).
4. `serve --switch`, which answers when the keeper's swap has ended. The old host serves until the new one is in
   standby with its store checked, so a new host refused there (a store only a newer build reads, a broken build)
   changes nothing that runs. A new host that fails after the drain is rolled back by the keeper itself, which starts
   the old build again; that host reattaches the children, which the keeper kept. Either way the hub then puts the
   pointers back, as `putBack` does now, without stopping anything.
5. Check: a hello whose `build.version` is the target, on the same forward, within 30 s of `--switch`'s answer (the
   front door can hold a connection for 45 s during a swap, so the check starts after the swap, not with it). A new
   host that serves but does not answer as the target is swapped back the same way: pointers back, `--switch` again.
6. Prune (keeping what still runs, §7), lift the hold.

No `beforeStop` and no stop on that path. Every case the swap cannot keep (an older `serve`, no keeper, a keeper below
the floor, the first update into a keeper) is §5.1's: at once, then resume. Following the hub (#1508) gains nothing
new: it calls the same update. Rollback is the same swap towards `previous`; to a version from before the keeper it is
§5.1's stop and start. `pnpm remote-dev` (§10.11) keeps its stop path: its store copy needs no host running, and the
keeper's swap has no pause between the old host's drain and the new one's activation to take it in.

## 9. Compatibility and rollback

| Hub | Remote | What happens |
|---|---|---|
| older | with a keeper | The hub knows no `--switch`: it runs `beforeStop`, `serve --stop` (which stops the keeper and everything) and `serve --detach`, exactly as today. Nothing is better, nothing worse |
| newer | without a keeper (older `serve`, or `CENTRALU_KEEPER=off`) | No `switch` in `takes`: §5.1, at once, then resume. A remote from before `resume.json` ignores it, so its cut turns keep their "stopped" mark and Continue, as after any restart today |
| newer | keeper, below the new host's floor | §5.1; the new `serve` then starts the newer keeper |
| newer | keeper, WSL with WMI blocked (link-bound) | §5.1: the keeper is the link's child and ends with it |

A host under a newer keeper is a pair step 5 makes supported (§5). A remote rolled back to a version from before the
keeper runs as today. Turning the keeper off on one machine is `CENTRALU_KEEPER=off` in the environment `serve` starts
with, read by `serve`, so that machine updates by §5.1; its use is a rollback of this design for that machine, not a
setting.

## 10. Steps, each a pull request with its tests

| Step | What | Tests that fail without it | Real-machine checks |
|---|---|---|---|
| 0 | This document | — | — |
| 1 | Linux: the keeper as a plain file beside `host/` in `@centralu/host-linux-x64` and `-linux-arm64` (§7). The release takes it from the AppImage it ships; `hostPackageProblems` requires it and checks it by reading the file, with no `file` or `ldd`: an ELF executable for the platform's machine, with its exec bit, linking no GUI library. Nothing starts it yet | `tooling/host-package.test.ts`: a Linux host package without the keeper, with one for the other machine, with one that is not an executable, without its exec bit, or linking webkit2gtk is refused; `files` must name it; the Windows package still ships `host/` only | none: nothing runs it yet. At the first release after it, the host package's tarball lists the keeper with its exec bit |
| 2 | Hub and host: §5.1 on every remote. The wait goes (`beforeStop`'s readings, `wait_idle`, `wait_open`, `wait_unread`, `OPEN_WORK_WAIT_MS`); the hub writes `resume.json` before the stop; the new host continues each listed session once | host: a turn ended by an update is continued once (one Continue, sent as Centralu's note, the quit notice withheld, the file gone, a second start sends nothing); a session the person stopped is not continued; one written to meanwhile, archived or deleted is not; a file older than ten minutes is ignored. Hub (`update.test.ts`, `linked-machine-ops.test.ts`): an update with turns running and a terminal open stops at once and writes the ids of the sessions in a turn; following the hub does the same with no card | a linked Windows PC and WSL: an update with a claude turn and a codex turn running and a terminal open; both turns continue once on the new version, the terminal closes, the window shows "<machine> is back — resuming 2 sessions" |
| 3 | Linux: the headless keeper taking `serve`'s port, token, Node and `CC_SERVE`; `serve` starts it and stays its parent; `--connection` reports it; `--stop` and the sign-in hand-over ask its `stop { ifIdle }`; a dev build (remote-hub.md §10.11), which bundles the host only, takes the keeper of the release it is built on | the keeper crate's `idle_decision` keeps a headless keeper with no window; a headless keeper serves on the given port with the given token; its `stop { ifIdle }` refuses while a turn runs and refuses a call after its yes; `serve` tests choose the keeper when the file is there and `CENTRALU_KEEPER` is not off; `keeper-integration.mjs` gains a headless scenario run by `keeper e2e (linux)` | a Linux arm64 server and WSL: `serve --detach`, ssh closed, the keeper and host still serving; WSL's distro held by the WMI-created `wsl.exe` as before |
| 4 | Hub: the swap path of §8; `serve --switch` and the keeper's `swap_current` op; #1405's exception written into security-boundaries.md | the keeper refuses `swap_current` to a folder outside `<data>/remote/versions/` or without `install.json`, refuses it over the front door's limited token, and still refuses `switch` to a non-window; `update.test.ts`: with `switch` in `takes` and the floor met, nothing is stopped and the hold is lifted at the end; without either, §5.1; a refused or failed switch puts the pointers back and stops nothing; a new host that does not answer as the target is swapped back | a Linux arm64 server and WSL: an update with a claude turn in a tool call, a codex turn, an open terminal running a counter and a Run command; each kept, the counter continuous, the turn finishing on the new host |
| 5 | The keeper's own update (§5): `keeper.hostApi`, `needsKeeper`, the pin test, older hosts under a newer keeper, the handoff on Linux at a switch, the lag where there is none and its line on the machine's row, the replacement when it costs nothing or the person chooses Update, `in-use.json` and prune keeping what runs | the pin test fails on an unrecorded raise; the previous release's host runs under the new keeper; a host with a higher floor takes §5.1; prune keeps the versions and Nodes `in-use.json` names; the row's line appears and leaves with a short transition, and with none under reduced motion | a Linux arm64 server: an update across a keeper build change keeps a turn and a terminal |
| 6 | Windows: the keeper's OS layer without the handoff (§6), runtime-unification step 9 minus W1, W2, W5; W3 and W4 measured first; a `keeper e2e (windows)` CI job | the keeper crate's tests on `windows-latest`: one keeper per folder, a child in its own job ended with its helpers, a pseudoconsole's shell surviving a host's kill and reattached with its ring, the device-attributes query answered with no host attached; `keeper-integration.mjs` and `keeper-children-integration.mjs --no-claude --no-codex` on that runner | a signed-in Windows 11 PC and one with nobody signed in: started by the sign-in task and by WMI from ssh; W3 there |
| 7 | Windows: the keeper in `@centralu/host-win32-x64` with the PE checks; `serve` on Windows starts it (WMI and sign-in task); `serve --window` attaches through its front door | `hostPackageProblems` on a PE stand-in (missing, wrong machine, a window DLL imported); `serve-windows` tests choose the keeper; the window's start plan attaches to a remote keeper's door (`serve_window::choose`) | a linked Windows PC: an update with turns, a terminal and a Run command running, from the hub, by the person's Update and by following the hub; an administrator's ssh account; the window on that PC while its keeper swaps |
| 8 | Windows: the keeper's handoff (W1, W2, W5; runtime-unification step 5 on the OS layer), ending the lag | the handoff script on `windows-latest` | a linked Windows PC: an update across a keeper build change keeps a turn and a terminal |

Step 2 needs no keeper and ends #1614's wait on every remote; steps 3 to 5 and step 6 can run in parallel. Each step
updates agent-host.md (§4.0's table, §4.7, §4.8's update table), remote-hub.md §10.4 and §10.5, and runtime-lessons.md
for the rules it guards, in its own pull request. The Windows desktop (#14) takes the keeper from step 6 on through
`start_plan`, as runtime-unification step 9 says; that is not part of this plan.

## 11. What the person sees

- **Settings → Machines, a machine updated on the swap path:** the steps of the install, then `switch` and `check`, as
  the row shows them now. The row's status stays `updating` only while no host answers, which is the drain's gap (not
  measured on a remote).
- **Sessions on that machine:** a turn in flight goes on; a Centralu tool call caught in the gap returns the existing
  retryable error and the agent calls again. Terminals keep their scrollback (the ring) and their shell.
- **Where a swap cannot keep what runs (§5.1):** the update goes at once, with no waiting step on the row. The sessions
  it cut carry the existing "stopped" mark only until their one Continue starts them again, and the window shows the
  existing "<machine> is back — resuming N sessions". Terminals and project commands there close.
- **New: an outdated keeper on Windows** (step 5, decision 2): one line on that machine's row in Settings → Machines,
  never in the sidebar, saying its keeper is from an older version and is replaced when nothing runs there or by
  Update. Its wording is proposed in step 5's pull request. It appears and leaves with a short transition, and with
  none under reduced motion (the owner's rule for every visible change).

## 12. Decided (owner, 2026-10-26)

Recorded on #1614.

1. **Windows uses the same Rust keeper as the desktop** (option A), not a Node holder (option C), so there is one thing
   to maintain.
2. **An outdated keeper is shown on the machine's row in Settings → Machines**, not in the sidebar.
3. **Nothing waits for idle.** Where a swap cannot keep what runs (a host that needs a newer keeper on Windows, the
   keeper's own update there, the first update into a keeper, and so every remote without a keeper), the update goes
   ahead at once and the sessions whose turns it ended are resumed afterwards, the way a linked machine's sessions are
   resumed when it comes back after a network drop. Terminals and project commands cannot be resumed and close (§5.1).
4. **The exception to #1405 is accepted:** a headless keeper takes `serve --switch`, so the hub's automatic update needs
   no window. The request comes from the hub over ssh, which already has full access to that machine. It is limited to
   the local `serve --switch` on that machine and is not open to the limited WebSocket token (§8).
