# Remote mode, phase 1: the hub's links (#82)

The other half of [serve.md](serve.md): the host a window is attached to (the **hub**) links to the `centralu serve` hosts of other
machines and shows their sessions and projects as its own ([plans/remote-hub.md](../../plans/remote-hub.md); the protocol
side is [protocol.md](../../protocol.md) §6). Hosts talk only to hosts: the window still talks to one host, and each machine
stays the one writer of its own store. The code is `packages/agent-host/src/links/`.

**The pieces, as `main.ts` wires them.**

| Piece | File | What it does |
|---|---|---|
| Registry | `stored.ts`, store v46 `linked_machines` | The machines the person linked: id, name, ssh target, remote shell, the `slot` for folding numbers, the version pair accepted |
| Transport | `tunnel.ts` (`SshTunnel`) | Asks the remote for its connection line over ssh, then holds an ssh local forward |
| Link | `linked-machine-connection.ts`, `linked-machine-ops.ts` (`LinkedMachine`) | One per machine: transport, version check, client, backoff, status, the hidden-session set, the mirror's updates; and what the person asks of it (install, update, rollback, uninstall, autostart, activity) |
| Links | `links-registry.ts` (`Links`), `link-deps.ts`; `links.ts` re-exports them | Every link of this hub, added and removed with the registry, and the ssh hosts and probe |
| Client | `remote-client.ts` | The hub's WebSocket to the remote host: hello, cursor and epoch, calls, events, terminal frames |
| Router | `router.ts`, `routes.ts` | In front of `HostServer.onRpc`: sends a call to the machine its ids name, merges lists, answers the rest locally |
| Qualifier | `qualifier.ts`, `machine-ids.ts` | `<machine>.<id>` on the way in, stripped on the way out; numbers folded per slot |
| Mirror | `stored.ts`, store v46 `machine_headers` | Each machine's sessions and projects as last listed, for when it cannot be reached |
| Installer | `install.ts`, `registry.ts`, `remote-install.mjs` | `machines.install`: preflight, the pinned Node and the npm packages on the remote, checked against the release's pin and the registry's signed metadata ([install-and-update.md](install-and-update.md)) |
| Update | `update.ts` | `machines.update`, `machines.rollback`, `machines.uninstall`: stop the remote's host, switch its pointers, start and check, or put back ([install-and-update.md](install-and-update.md)) |
| Dev build | `dev-build.ts`, `remote-dev.ts` | `pnpm remote-dev <machine> --ref <commit> --repo <path>` (#1036): a dev build of the host made there from a commit, marked `source: { kind: 'dev' }`, swapped in by the update's steps ([plans/remote-hub.md](../../plans/remote-hub.md) §10.11). A command on the hub, no RPC |
| Autostart | `autostart.ts` | `machines.autostart`: `centralu serve --autostart` there, through the lookup (below) |
| Ssh config, probe | `ssh-config.ts`, `probe.ts` | `machines.sshHosts`: the hosts of this computer's `~/.ssh/config`; `machines.probe`: what runs at one of them, before it is linked (below) |

The three choke points of remote-hub.md §5 are where it sits: the router is the `onRpc` the server calls, a link puts
the remote's events into `server.broadcast` (so they get the hub's own `seq` and replay) and its terminal frames into
the same lane as local ones. A host with no linked machine routes every call to its own handler, as before.

**How long a forwarded call waits (#2170).** The router waits for a linked machine as long as the window waits for its own host: one table in
`packages/protocol/src/call-budget.ts` (`callBudgetMs`, 30 s; 180 s for a call that can revive a session; the host's 10 minutes plus one
for a git write; the person's answer plus the app's own bound for `apps.invoke`), read by `RpcClient` and by the router, whose
`call(method, params, timeoutMs)` hands it to `RemoteClient`. Only a call a window started (the router's `ctx` is set) gets its table
bound. A call the hub made itself (the Assistant's flows, an agent's call, the linked views, `host.*`, `hub.*`, the first lists) keeps the
client's 200 s: no window waits on it, and a delete on a linked machine can outlast 30 s. No frame carries a budget, so an older hub keeps the flat 200 s and an older window its own table; each side reads its own build's.

**The transport.** Two ssh commands, the person's own `ssh`, keys and `~/.ssh/config`:

```
ssh -T -o BatchMode=yes -o ConnectTimeout=15 -- <target> <connection command>
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o GatewayPorts=no -L 127.0.0.1:<port>:127.0.0.1:<port> -- <target>
```

`ConnectTimeout` only bounds the connection, so each asking ssh also has a deadline and a bound on its output
(`SshTunnel.run`): 60 s for the connection line, 120 s for starting the host (`serve --detach` waits up to 30 s for the host itself, and its own message is the better reason), 30 minutes for one installer, updater or
autostart step (the managed Windows install downloads about 30 MB of Node inside one step, which a slow link needs
minutes for). Past its deadline, or once stdout is longer than 1 MiB, the ssh is stopped and the call rejects. Of stderr
only the end is kept: 64 KiB for an asking ssh, 16 KiB for the forward, whose ssh lives as long as the link and carries
a link-bound host's log. Output is decoded as a stream, so a character split between two chunks stays whole. The
machine probe and `ssh -G` run through the same runner with their own deadlines (`runSsh`, `links/ssh-run.ts`). Every
ssh this host stops, at a deadline, at a forward that did not come up or at `close()`, gets SIGTERM and, 2 s later,
SIGKILL if it is still there (`endChild`).

**A machine with no host running is started** (remote-hub.md §10.9, decision 7). When the connection line says
`hostRunning: false`, the link goes to `starting`, runs `centralu serve --detach` through the same lookup as the
connection command ([serve.md](serve.md)), writes `[links] <machine>: no Centralu host is running there; starting one` and how it
went to `host.log`, and opens again. Nobody is asked: adding the machine was the consent (remote-hub.md §3.2). The row
keeps `hostStarted: { how, at, note }`. Where the remote answers `wmi_blocked`, the link falls back to a
**link-bound** host: from then on the forward's ssh runs `centralu serve` (found the same way) as its remote command
instead of `-N`, and the link reads the connection line until that host answers. It lives as long as the link
(Windows' OpenSSH ends the session's processes, and on posix the launcher takes the hangup as a stop), and the row
says so. A start that fails (Centralu too old for `--detach`, the host exiting while it starts) is `not_running`
with the reason, retried with the backoff.

**What the link does not start by itself** (#1143, owner decision 2026-10-19). Adding the machine is consent to start a
host that crashed or is missing, not one the person stopped:

- **The person's stop is remembered there.** `centralu serve --stop` writes `<data>/stopped.json` (`by: stop`), and
  so does a host that the desktop app's keeper stops for good when the person quits Centralu on that machine (Quit
  completely, or the last window closing with background mode off: `by: quit`, `lifecycle/stopped-mark.ts`). The
  desktop app shares the data folder with `serve` (`dataRoot()`); on Windows its window uses the folder's serve host
  (`--window`), which closing the window leaves running, so there is no quit to mark there. Every host that starts in
  the folder removes the mark: a start, by whoever, is the person's again. `--connection` reports it as
  `stopped: { by, at }` while no host runs. The hub's own stop (an update, a rollback, an uninstall) runs `serve --stop`
  with `CENTRALU_STOP_BY=hub` and leaves no mark.
- **That the system was ending is recorded beside it** (#1397, `lifecycle/system-end.ts`): `<data>/system-end.json`
  (`{"v":1,"at":…}`), written by the host when it is told the system is ending (a shutdown, restart or sign-out), and
  nothing else: any other ending leaves no file. Told by the control line `{"op":"system-ending"}` on the host's stdin, from
  the window or the keeper that hears the end (`{"op":"system-ending","cancelled":true}` removes it), or on Linux by
  systemd: every leave, whichever way it began (a signal, the parent's pipe, a keeper's stop, `host.stop`, the window's
  stop line, a crash), first asks `systemctl is-system-running` and `systemctl --user is-system-running` (`os.ts`
  `systemStoppingQueries`), and `Shutdown` waits for the answer before it stops anything: the first `stopping` answers, at
  most a second in all, and the queries still running are ended then or as the host exits, however it exits. Elsewhere
  there is nothing to ask, and the leave begins at once as before. A notice the host outlives by 2 minutes is called off
  (the system did not go). The next host takes the file once
  it holds the lock (read and removed, before `stopped.json` is cleared); with it, the turns the last host lost are the
  system's ([../lifecycle/turn-endings-and-mail.md](../lifecycle/turn-endings-and-mail.md), `shutdown`). A host killed with no notice writes nothing, so the next start knows nothing and guesses
  nothing. Separate from `stopped.json`, which keeps its meaning for a hub.
  **Who says it** (#1970). Measured on Windows 11 (a host log over a month of restarts started by `shutdown.exe`, the Windows Update
  notifier and TrustedInstaller): a `centralu serve` host wrote no line at a restart, so it was ended with no notice. It has no console or
  window, and Node does not map `CTRL_LOGOFF_EVENT` or `CTRL_SHUTDOWN_EVENT` (libuv `src/win/signal.c`; Windows sends them only to
  services), so only a process with a window hears the end, and the window says it:
  - **Windows**: the main window is subclassed (`SetWindowSubclass`, `sidecar/ending.rs`) and passes every message on unchanged. `WM_QUERYENDSESSION`
    (the question) becomes the line, `WM_ENDSESSION` with `wParam` FALSE (another program refused) the `cancelled` one; a Restart Manager's
    request to close (`ENDSESSION_CLOSEAPP`) is neither. In direct mode the line goes on the host's stdin. With `serve --window` the host is
    no child of the window, so the line goes to the launcher, which passes it on over the host's socket as `host.systemEnding { cancelled? }`
    (`serve-window.mjs`, with the window's full credential: a limited one is refused, since a false end would relabel a real crash as the system's; never through a link). A launcher older than the host sends it with the limited credential and is refused (the host logs why), so while versions are mixed the notice is lost. A sign-out (`ENDSESSION_LOGOFF`) is not passed on to a serve host in a network logon, which a sign-out does not end.
  - **macOS**: the window observes `NSWorkspaceWillPowerOffNotification` (a shutdown, a restart and a log out; there is no notice for one
    being called off, so the host's 2 minutes do that) and writes the line itself in direct mode or sends the keeper `system_ending` (a
    window's only) under one. The keeper, which launchd stops with the host and the agents, handles SIGTERM itself (`os::on_system_stop`):
    from pid 1 (`si_pid`, `os::is_system_stop`) it writes the line to the host and then dies by the signal as before; from any other
    process (its own restart, a person's `kill`) it dies at once, as before, with no line. The host may be told after its own SIGTERM began its leave; it still
    writes until it exits.
  - **Linux**: the host asks systemd itself, above.
- **The link starts at most three hosts there within 10 minutes** (`RESTARTS`), and then none until the person's Start,
  however long it waits: the limit is kept, not read off the starts again as they age out. A start at the person's
  Start counts too, so a Start whose hosts stop before they answer is not repeated for good, and so does a host that
  was started and never answered (`serve --detach` says `exited` or `timeout`: one that crashes at boot). A start
  where nothing could be started (ssh, no Centralu there, WMI refusing) is not counted: it is `not_running` with its
  reason, on the backoff, as before. A host that answered its hello and
  then stopped again at once used to reset the backoff at every hello and was started again about every 10 s for
  good. Now the backoff, and the limit, start over only once a host has stayed up 60 s (`STABLE_MS`).
- **Either way the row is `stopped`**, with `error` saying which, and the link starts nothing until the person's Start
  (the row's button, `machines.reconnect`) or the Assistant's `reconnect_machine` with the person's card. It still
  reads the line on its backoff, so a host the person starts there is connected to; the row stays `stopped` while it
  does, and the reason is kept while the machine cannot be reached (`startHeldBack`, until a host runs there or a
  start goes through). The card is asked on that reason, not on the row's status of the moment, and without it the
  Assistant's reconnect only opens the link (`reconnect { start: false }`). A Start pressed while the machine cannot
  be reached is spent, not kept for whenever it comes back. The `stopped` sentence after the limit ends with what the
  last start said when its host never answered. A machine whose Centralu predates the
  mark says no `stopped`, and is started as before, within the same limit.

**A machine whose Node is below the floor is switched to the hub's own** (#699). Before it starts a host, the link
reads `install.node` from the connection line; a machine that is not on a managed install and runs a Node below the
floor ([serve.md](serve.md)) is installed on first, with the same `machines.install` path as a person's click: the pinned Node of
`remote-runtime.json`, checked against its SHA-256, and the hub's version from the registry. The same happens when
`--detach` answers `node_too_old`, or when it quotes a host that exited with 3221225477, `-1073741819` or SIGSEGV (a
launcher from before the floor existed). The link then opens again and finds the managed launcher first. The row says
so once, in `hostStarted.note`: "Centralu installed its own Node 24.21.0 on Box, because the Node on Box (22.12.0) is
older than 22.14.0, the oldest Centralu runs on." It is tried **once** until the link next connects: a host that still
fails on the Node the hub installed is reported as it is. Where the hub may not install (a development build, which is
not published; a machine that runs a command of the person's own; no installer), the row is `not_running` with the
floor named and a request to update Node there.

The connection command depends on the remote's shell (`MachineInfo.shell`), because `ssh <target> <command>` hands the
command to whatever login shell the remote account has:

| Shell | The connection command | Measured on |
|---|---|---|
| `posix` | `sh -c 'd="${CC_DATA_DIR:-$HOME/.centralu}"; m="$d/remote/bin/centralu"; if [ -x "$m" ]; then exec "$m" serve --connection; elif command -v centralu …; then exec centralu …; elif [ -x "$d/bin/centralu" ]; then exec …; else echo CENTRALU-NOT-FOUND; exit 127; fi'` | the fake ssh of `tunnel.test.ts`; the order by a real `sh` there |
| `powershell` | `powershell -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>` of the same lookup (`<data>\remote\bin\centralu.cmd`, then `Get-Command centralu.cmd` (the `.cmd` shim, never the bare name: PowerShell would pick the `.ps1`, which the default `Restricted` execution policy blocks, #688), then `<data>\bin\centralu.cmd`, the launcher `serve` keeps; `<data>` is `CC_DATA_DIR` there, else `%USERPROFILE%\.centralu`) | Windows 11, OpenSSH, PowerShell 5.1 (before the managed launcher was added) |
| `wsl` | The same PowerShell wrapper around `wsl.exe -d '<distro>' -- bash -lc 'echo <base64> \| base64 -d \| bash -l'`, the script being the POSIX lookup with `/mnt/*` taken off PATH | Ubuntu 24.04 in WSL2 on that laptop |

The managed launcher the installer writes ([serve.md](serve.md), "The managed launcher") comes first, so a machine with both an npm install and one the hub
made runs the version the hub installed; a phase 1 machine finds `centralu` as before.

A machine can name its own command in place of `centralu` (`MachineInfo.command`): a source checkout, a data folder
other than `~/.centralu`. It runs as given, with no fallback.

| Decision | Why |
|---|---|
| The fallback to the launcher is decided on the remote, in one command, and "not found" is a word on stdout | Exit codes do not survive Windows: OpenSSH runs the command under PowerShell, which turns any failure into 1. Measured: a 127 from WSL or from PowerShell itself arrived as 1, and a missing command inside WSL arrived as 0 |
| Everything but plain words crosses PowerShell as base64 | PowerShell 5.1 re-parses quotes, and mangles a double quote passed to a native program; base64 is letters, digits, `+`, `/` and `=`, which no layer touches |
| A WSL lookup takes `/mnt/*` off PATH | WSL appends Windows' PATH, and Windows' npm folder has a `centralu` shim: measured, `command -v centralu` in the distro named `/mnt/c/Users/<me>/AppData/Roaming/npm/centralu`, the Windows install |
| The WSL forward runs `wsl.exe -d <distro> --exec sleep infinity` instead of `-N` | WSL stops a distro about 15 s after its last `wsl.exe` client exits, and its services with it. Measured: `centralu serve` under a systemd unit was stopped 19 s after it started, with no client attached; a forward to Windows' sshd alone never holds the distro |
| Both ends of the forward bind 127.0.0.1, `GatewayPorts=no` | Nothing on either machine's network can use the link |
| The same port number on both ends when it is free here, another one otherwise | The number reads the same in both machines' logs. Nothing depends on it since phase 2: the hub serves a linked machine's app views on its own port (remote-hub.md §11). Two machines on the default 17175 cannot both have it |
| `BatchMode=yes` everywhere | A password or host-key prompt nobody can answer would hang the link. The person sets the keys up once, as for any ssh use |
| The token is not stored; it is asked over ssh at every link start | It is the key to every RPC on that machine. One ssh round trip per start (measured 2.1 to 4.3 s to connected on a LAN) is cheap |
| The ssh processes are children of the hub host, behind the `Tunnel` interface | Probe 4 of remote-hub.md §10.6 (2026-10-08) measured the alternatives across real hub swaps: the link is away about 1.1 s per swap as it is, 0.8 s with OpenSSH `ControlPersist` (which leaves a forward behind per swap and outlives "Quit completely"), and would be about 0.14 s as a keeper child. The remote's agents never notice a hub swap, so it stays here |
