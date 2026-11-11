# Who holds the host: the keeper (#280, option C step 1)

In the packaged app the host's parent is the keeper (`centralu-keeper`, an executable of its own next to the
window's, #440; [architecture.md](../../architecture.md) §4.1), not the app. The keeper launches the host with
`--port 0 --watch-parent --db <data>/store.db` and `CC_DATA_DIR=<data>`, keeps its stdin pipe, and restarts
it by the rules the app used before: five consecutive failures, a 30 s stable-uptime reset, and an
immediate stop on a lock conflict or a store only a newer build can read (`host_proc/` in the
`apps/desktop/src-tauri/keeper` crate, shared by the keeper and the app's direct path: the logic every OS shares in
`mod.rs`, the process mechanism that differs by OS in the keeper crate's OS layer `src/os/`, finding Node in `node.rs`). If the keeper dies, the host sees EOF on that pipe and shuts down.

**Who starts the keeper.** The window, when no keeper answers on `<data>/keeper.sock`. A macOS release first
asks the shell ([plans/thin-shell.md](../../plans/thin-shell.md) §6, §10.2; `src/shell/` in the window): it installs or
upgrades `<data>/shell/Centralu.app` from the shell it carries, opens it through LaunchServices
(`/usr/bin/open -n -g -a <shell> --args --content <bundle>/Contents/Resources/content --data-dir <data>
--bundle-path <bundle> --nonce <n>`), and waits up to 45 s for `<data>/shell-status.json` with that nonce. The
shell verifies the signed content, copies it to `<data>/content/<version>/` and starts `centralu-keeper` from
there with the same command line the window would use (`keeper::exe::Start`), so the keeper and everything under
it are judged by macOS as the shell. If the shell refuses or does not report, the window starts the keeper itself
from its own bundle, as every other build does, for the rest of its life, and keeps the reason for `host_build`
(`shell`): a release shows it in the build bar, a build whose shell is unpinned (a local `pnpm app`, a
rehearsal) only writes it to `keeper.log` as a `[window]` line, and never installs or opens that shell.
Debug builds, `CC_KEEPER_HOST_SOURCE`, Linux and Windows start the keeper (or the host) directly, as before ([start.md](start.md)).

**Per-build copies.** Before each launch the keeper copies the bundle's `resources/host` folder to
`<data>/hosts/<key>/` (temporary folder, then rename) and runs `main.mjs` from there. The key is the commit
stamped into `bundle-info.json`; a `-dirty` or `unknown` build gets its build time appended, so two different
dirty builds never share a copy. Once a host is ready, the copies it does not run from are removed, except those a
launch holds (`source::Copies`): a launch holds its copy until the keeper records it as the running host's. Copying
and cleaning take one lock, and the cleanup reads which copy the host runs from, and which it will run next, when it
runs. Without the hold, the cleanup a newly ready host set off could delete the copy a launch had just made ("Cannot find
module .../hosts/<key>/main.mjs", #368). A complete copy is used even when the folder it came from is gone (an app bundle an update replaced).

A keeper the shell started (its own executable in `<data>/content/<version>/`) makes no copies: its hosts run from
the verified copy's `host/` folder, which is read-only and was checked against the signed manifest
([plans/thin-shell.md](../../plans/thin-shell.md) §5, §10.3). The same lock holds those `content/<version>` folders, and
the cleanup removes every version no claim holds, that is not the keeper's own and that no host runs from or will run
from next, plus `.partial-*` folders a copy that died left behind.

**Where it came from.** The keeper keeps, for the running host, `{ commit, builtAt, version,
protocolVersion, bundlePath, hostDir, copyDir }`, returns it on the control socket, writes it to
`<data>/keeper.json` (no token), and passes it to the host as `CC_HOST_SOURCE`. The host adds it to every
`hello_ok` as `build` ([protocol.md](../../protocol.md) §1), with the commit always its own compiled-in one.

**Control socket.** `<data>/keeper.sock`, created `0600` under `umask 077`; every connection's peer uid must
be the keeper's own. Newline-delimited JSON, one request per connection except `attach`:

| request | answer |
|---|---|
| `{"op":"status"}` | `{"ok":true,"view":…}` — host state, the front door's port and a credential ([front-door.md](front-door.md): the token for a Centralu window, the limited credential for any other process, and `view.rights` says which, #1405), build source, background mode, attached windows, activity, and the keeper's own build (`keeper.build`, since step 4; a window counts a keeper without one as another build, which only "Restart completely" moves, #461). The current or last swap (`swap`) and `keepsAgents` went in #1895 step 4 PR 4; every window build since step 3 reads both as optional |
| `{"op":"attach","protocol":1,"build":…}` | `{"ok":true,"view":…,"sameBuild":bool,"keeperSameBuild":bool}`, then `{"event":"status","view":…}` on every change for as long as the connection is open. An open attach connection is what "a window is attached" means; its closing is the detach. A keeper of an earlier build also answers `relaunched`, which this build's window no longer reads (#1895 step 4, PR 3) |
| `{"op":"system_ending","cancelled":bool?}` | a window's only (#1970): `{"ok":true}` once the host has been written the `system-ending` line (`cancelled`: that it is not after all); `{"ok":false}` when no host is up |
| `{"op":"stop"}` | stops the host and the keeper ("Quit completely", and "Restart completely", after which the window starts a keeper of its own build) |
| `{"op":"switch",…}` / `{"op":"upgrade",…}` | `{"ok":false,"error":"gone: …"}` to anyone, saying to quit Centralu completely and open it again (#1895 step 4 PR 4; an earlier window offers no "Restart completely" for a keeper on another build that serves its host). No window sends them since PR 3; a window of an earlier build shows the refusal. Until PR 4 they were a blue-green swap of the host to another build and a handoff of the keeper to that build's keeper ([A keeper runs one build](#a-keeper-runs-one-build-1895-step-4-pr-4)) |
| `{"op":"restart"}` | Retry after the host gave up |
| `{"op":"settings"}` / `{"op":"set_background","on":bool}` | background mode, kept in `<data>/keeper-settings.json` |

A window that does not take a status push within 5 s (it stopped reading) is closed by the keeper, which is its
detach; the window then attaches again. A window the keeper closed itself may only be stalled (suspended, in a debugger,
its reader blocked), so its detach does not stop the keeper even when it was the last one and background mode is
off: for 5 minutes (`REATTACH_GRACE`) the keeper waits for a window, the next
attach spends that, and if none comes the idle rule applies as usual. Each window has a writer thread of its own
(`server/push.rs`): a change only queues the new view, a view still waiting is replaced by a newer one, and the
attach answer is queued first and never replaced. (Pushes that were blocking writes under the keeper's state lock let a window that stopped reading hold every
push, request and host status for up to 5 s at each change.)

**The legacy folder.** Before anything creates the default data folder, the app and the keeper move the
pre-rename folder to the new name by the same rule as `data-dir.ts`: the host leaves a legacy folder alone once
the new one exists, so creating `~/.centralu` first (for `keeper.log` or the socket) would strand the data.

**One keeper per data folder.** `flock` on `<data>/keeper.lock`, released by the OS however the keeper ends.
A second keeper whose predecessor answers on the socket exits with code 3 and starts no host; one whose
predecessor holds the lock but does not answer (on its way out) waits up to 15 s for it.

**Descriptors.** A keeper started from Finder or launchd gets a soft descriptor limit of 256, which a few dozen
relays and attached streams used up. It raises its soft limit to 10,240 (or the hard limit) as it starts; what it
starts (hosts, agents, terminals, commands) gets the limit from before back, so a `select`-based program is never
handed a descriptor past 1,024. When an `accept` still fails for want of one, each of its two listeners (`keeper.sock` and
the front door) is left alone for 100 ms and the failure is logged once every 10 s with a count,
instead of the loop coming straight back to the waiting connection (one core and thousands of log lines a second on
Linux; macOS drops the connection instead), and a thread the OS refuses for a connection closes that connection
rather than aborting the keeper (`keeper/accept.rs`, #840 item 3). A front-door relay holds one descriptor per
socket (its table shares the relay's sockets instead of duplicating them, which made four per relay), and the door
relays at most 1,024 connections at once: one past that is closed as it is accepted, logged once per run, so a
client connecting in a loop cannot run the keeper out of descriptors (`front_door.rs`, `MAX_RELAYS`).

**When it ends.** `idle_decision` in `keeper/mod.rs`: with a window attached, never. While a window it closed
itself may still come back (`REATTACH_GRACE`, below), not yet, in either mode. With background mode off, when the last window detaches. With it on, after 30 minutes with no window and no activity reported by the
host (a working or waiting session, a terminal, a command run). A keeper no window attached to within 60 s of
starting ends too: the app that launched it died first.

`scripts/keeper-integration.mjs` drives all of this with the real binary (`cargo build` into `/tmp`) and the
real bundled host against a temporary `CC_DATA_DIR`.

**In CI.** The `keeper e2e` job in `.github/workflows/build.yml` (macOS) builds the binary and the host once and runs
the parts of the two keeper scripts that need no model and no network: all of `keeper-integration.mjs` then the shell's
(`shell-integration.mts`). It exists
because none of this shows in unit tests or e2e: #329's `await` before the server existed crashed every host
restart that held a terminal (#348), and only a hand run of the keeper scripts noticed. The claude and codex
turns stay manual. Each script ends every process it started and everything those started, pass or fail, found
from one process table rather than by name (`scripts/keeper-test-processes.mjs`), and prints the end of
`keeper.log` and `host.log` when a check fails. The `keeper e2e (linux)` job runs the keeper crate's unit tests on
ubuntu-24.04.

## A keeper runs one build (#1895 step 4 PR 4)

A keeper runs the build it was started as, and its hosts, for its whole life: an update or a window of another build
is a stop ([updates.md](updates.md)), and the next window starts a keeper of its own build. `switch` and `upgrade` answer `gone` ([Who holds the host: the keeper](#who-holds-the-host-the-keeper-280-option-c-step-1)). A
`centralu-keeper` started with `--take-over-fd` (a keeper of an earlier build starts the keeper a window names when the
window switches it, and once an install has replaced the bundle that file is this build's) logs a line and exits with
code 7 before it binds anything; the sender reads that as its
handoff aborted, rolls back and serves on with its host. The host notices nothing of either.
