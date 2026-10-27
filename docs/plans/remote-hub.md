# Remote mode as linked hosts: design draft

> **Status: decided by the owner on 2026-10-05 (§9), recorded on #82.** It replaces the "multi-host client" shape decided on 2026-10-03
> (decision 1 on #82) with linked hosts, after the owner asked on 2026-10-05 why the UI should
> hold several hosts at all. Phase 3 (installing and updating remotes) and probe 4 are designed in §10 (2026-10-08);
> the owner decided its open questions the same day (§10.9). Phase 2's app views through the hub are designed and built
> in §11 (2026-10-11); the owner decided its questions the same day (§11.7). Phase 4 (the orchestrator and Centralu
> tools across machines) is planned in §12 (2026-10-12); the owner decided its step 4 on 2026-10-18 (§12.5, #550), and
> it is built (§12.7).

## 1. The shape

Every machine runs **one host**, as today: it owns that machine's SQLite store, agents, files,
terminals and tool logins. **Hosts talk only to hosts.** The UI talks only to the host on the
machine it runs on.

```
  UI ── (today's connection) ── host on the Mac ══ SSH ══ host on the Ubuntu server
                                     ║
                                     ╚════ LAN / SSH ════ host on the Windows laptop
```

- **One writer per store.** No store is ever opened by two processes, so SQLite needs nothing
  new: the ownership lock and the swap rules hold as they are.
- **No replication.** Each host stays authoritative for its own data. Another host only reads it
  live through the link, and keeps a headers-only mirror for when the link is down (§5).
- **Symmetric peers.** There is no special "hub" machine. The host a UI is attached to acts as the
  hub for that UI. Opening Centralu on the laptop makes the laptop's host the hub.

### Why not the two earlier shapes

| | A: one window, one host | B: the UI holds several hosts (decided 10-03) | **C: linked hosts (this draft)** |
|---|---|---|---|
| UI change | Small (point the connection elsewhere) | Large: the 6.3k-line store assumes one platform throughout | Small to medium: the UI still sees one host |
| Local and remote side by side | Only in two windows; separate inboxes | Yes | Yes |
| Orchestrator, `read_session`, `ask_project`, apps across machines | No | No (they live in a host) | **Possible**, because the hub is a host |
| Works in the browser build | Yes | Needs a tunnel outside the shell | Yes: the host runs ssh |
| Where the person's state lives | Per host | Must move to the client | Already on the hub host |

## 2. The link

- **One connection per pair, used in both directions.** A WebSocket is full duplex, so once one
  side has connected, both sides can send requests over it. Whichever side *can* reach the other
  opens it: the Mac reaches the Ubuntu server over SSH, but the server cannot reach a Mac behind a
  home router.
- **Transport.** Phase 1: the person's own `ssh` with a local forward to the remote host's
  loopback port (`-L 127.0.0.1:<free>:127.0.0.1:<port>`, `BatchMode=yes`,
  `ExitOnForwardFailure=yes`, `ServerAliveInterval`). The remote host listens on loopback only;
  nothing is opened to the internet. With an overlay network such as Tailscale, every pair can
  reach each other directly; that is the person's choice, not something Centralu ships.
- **Where the ssh process lives.** A child of the hub host, as phase 1 built it. Probe 4 (§10.6) measured the two
  candidates against it across real blue-green hub swaps: the link is away about 1.1 s per swap as it is, 0.8 s with
  OpenSSH `ControlPersist` (which also leaks a forward per swap and outlives "Quit completely"), and would be about
  0.14 s as a keeper child. Not worth a keeper protocol change while the remote's own agents never notice a hub swap.
- **Identity.** Each host gets a stable machine id and name. Each direction authenticates with its
  own token. The remote's token and port come from `centralu serve --connection` over ssh and stay
  stable across restarts.

## 3. Rules that keep a mesh simple

1. **A host only exports its own data.** It never re-exports what it sees from another host. Each
   pair is a direct link; there is no relaying, so there are no loops and no duplicates however
   the machines are connected.
2. **Permissions per direction, decided by the side that connects** (owner, 2026-10-05). Being
   able to open an SSH connection to a machine already shows the person owns it, so the consent is
   given **once, on the connecting side**, when the link is added. The connecting side controls the
   other. The reverse direction (the remote host asking the connecting machine for something) is
   **off by default**, and only the connecting side can turn it on for that link. A compromised
   server must not be able to reach the Mac by default.
3. **Machine-qualified ids.** Remote ids are shown to the hub's UI as `<machine>.<id>`. The
   protocol's id pattern already allows `.` after the first character, and every parser in the UI
   splits on `/` or `:`, so the prefix passes unchanged. Per-host counters (`term-N`, `run-N`,
   approval rule integers, pids) need the prefix too.
4. **One orchestrator, apps from every machine.** A remote host's orchestrator and coordinators are
   not shown on the hub; the hub has one orchestrator. A remote host's **user-folder apps are
   shown** (owner, 2026-10-05), grouped by machine (in "Your apps" with a machine badge since #734) and qualified by it (`_user/<appId>` collides
   across machines otherwise). They run on their own machine; their views need the proxy of
   phase 2, so in phase 1 they are listed and their tools work, and their views say they open in a
   later version. Phase 2 (§11) opens their views, named by their machine where no project can
   say it (§11.4).

## 4. Versions: align before connecting (owner, 2026-10-05)

When a link connects and the two sides run different versions, Centralu asks to bring the older
side up to the newer one, and does not connect until they match or the person declines.

- **The hub is older:** the existing one-click update and seamless switch.
- **The remote is older:** update it over ssh (the installer/updater, phase 3).
- **The question says what stops.** On a remote without a keeper (Linux today, until the keeper is the Linux
  default: runtime-unification step 4b), an update cuts running agents; the prompt names them.
- **One side updates later:** the link stays up and the prompt comes again; the tolerant parsing
  rule (#339) covers the moment in between.
- **Dev builds** (not on npm): no "newer" to compare; connect when `protocolVersion` matches, with
  a warning.
- **Same channel:** versions are compared within one release channel.
- **Today `server.ts` closes the socket on any protocol mismatch.** The handshake must instead
  report both versions so the prompt can be shown.

## 5. Routing (measured on main, 2026-10-05)

The host has three choke points, all wired in `packages/agent-host/src/main.ts`: requests
(`HostServer.onRpc`), events (`server.broadcast`) and terminal output (`pushTerminal`). A router
in front of them can forward to a remote without touching the 6.5k-line session manager.

**Requests:** 146 RPC methods.

| How it routes | Count | Notes |
|---|---|---|
| By session id | 28 | send, approve, answer, interrupt, messages, archive (`trash.*`)… |
| By project id | 34 | createSession, git, fs, terminals, commands… |
| By app | 27 | four keyed by opaque host values the hub must remember (view instance, question, import token) |
| By terminal / run id | 4 | ids are per-host counters |
| Merge across hosts | 14 | `sessions.list`, `projects.list`, search, `trash.list`… (approval rule ids and pids collide) |
| Hub only | 26 | layout, grid, prefs, themes, updates, orchestrator, skills |
| Internal callbacks, never routed | 4 | a remote's own Codex bridge talks to its own host |
| Needs a machine parameter | 9 | `projects.add`, `agents.models/detect/capabilities/versions/usage`… (additive optional `machine`); since joined by `projects.create` and `projects.createPreview` (#515): a new project's folder is made by the host of its machine, in that machine's `~/Centralu` by default (`%USERPROFILE%\Centralu` on Windows), which only that host can name in its own path terms |

**Events:** 46 session-scoped and per-machine types get their ids rewritten and are re-broadcast
into the hub's own event log under hub sequence numbers. Hub-only events from a remote
(`update_status`, `themes_changed`, built-in app state) are dropped. Inbox, counts, notifications
and the dock badge are computed in the UI from session state, so they work once session events
are routed.

**Recovery.** The UI rebuilds its session list from `sessions.list` after every reconnect and
wakes sessions that were live. So the hub must:

1. answer for an unreachable machine from a **headers-only mirror** in its own store (additive
   migration), keeping the last-known `live` value plus an "unreachable" mark, so the UI neither
   drops those sessions nor tries to wake them;
2. keep **one cursor and epoch per remote** itself;
3. send a **per-machine resync** event (new, additive) when a remote answers "resync", with a
   UI-side recovery scoped to that machine.

**One source for "is this machine there" (#1611).** The mark of point 1 is a fact about one answer: the hub also gives
it when the link is up and its call for that list failed, and a window can take such an answer after the machine's
resync (its start-up lists, a reconnect to the hub) or fail to finish the resync. A window that read the mark as the
machine's state showed a project dimmed "Not connected" while `machines.list` said `connected`, because nothing read the
list again until the next connect. So the window derives away from the machine's status alone (the badge, the dimming
and the tooltip read the same `machineAway`), and a machine whose resync was not whole, or whose rows still carry the
mark while it is connected, is read again at the next word the hub says about it, not on a timer. The hub's answers are
unchanged, so an older window keeps what it had, and an older hub needs nothing.

## 6. What is tied to a machine

| Thing | Phase 1 | Later |
|---|---|---|
| Sessions, approvals, questions, inbox | Routed | |
| Terminals and command runs | Routed (frames relayed; every keystroke is one RPC, latency to be measured) | |
| Grid panels holding remote sessions | Needs a table or column: `grid_layout.session_id` references the local `sessions` table | |
| Reveal in Finder, open in IDE | Off for remote projects | Done (phase 2): "Open in VS Code" (the project's sidebar menu, the diff, the viewer, the file tree's row menu) opens the file, folder or project on that machine through a `vscode://vscode-remote/ssh-remote+<target><path>` link, the path being the project root the remote reported (`ProjectInfo.path`) joined with the project-relative one. A Windows (PowerShell) machine gets `/C:/...`; a WSL machine gets nothing, as Remote-SSH reaches the Windows side and not the distro. Reveal and trash stay off |
| File tree, diff, search | Off for remote projects | Routed (paths are project-relative already) |
| App views | Off for remote projects | **Built (§11):** the hub serves them from its own door with the machine's document, and its apps stand on the grid (§11.8) |
| Attachments | Work: saved and read on the same machine as the session | Upload through the hub |
| Usage gauges | Hub machine only | Done (phase 2): the top bar shows this computer's donuts, then each linked machine's behind its name (`agents.usage {machine}`, `agents.detect {machine}`). A machine that is not connected shows its state and is not asked; it is asked when its link comes back, and every connected machine on the 5-minute refresh. A machine with no session running no longer shows a blank meter (#726): when it is logged in to the same account as the hub (fingerprints compared, `agents.account`) the hub's own limits stand for it, labelled "Same account as this computer"; otherwise its host reads them with a short-lived probe session, or the one-line reason is shown |
| Orchestrator and Centralu tools (`list_sessions`, `read_session`, `recall`, `ask_project`) | Local only, documented | Phase 4 (§12): the orchestrator's `list_sessions`, `read_session` and `recall` reach every machine (built, §12.3), and it directs them (`send_to_session` with `reportBack`, `update_session_settings`, `create_session`, `create_project` with a machine; built, §12.4); `ask_project` across machines is built (§12.6), and in reverse, a machine's session asking the hub's projects behind the hub's switch and card (built, §12.7) |
| Attaching a hub app to a remote session | No | The app process and the session are on different machines |

## 7. Phases

1. **Linked sessions.** `centralu serve` on the remote (in progress), the link (ssh, per-remote
   client with reconnect/epoch, token), the router for sessions, approvals, terminals and project
   lists, the headers mirror, machine grouping in the sidebar, the new-session dialog per machine,
   grid panels for remote sessions, version check with the prompt (hub-side update only).
2. **Working on remote projects.** Files, diff, search fan-out, app views through the hub,
   attachments upload, per-machine usage, Remote-SSH links.
3. **Installing and updating remotes.** Install over ssh (bundled host plus a pinned Node, no npm
   or sudo), update and rollback (needed by §4), supervision without a session (keeper on Linux,
   after runtime-unification step 4b), uninstall. Designed in §10.
4. **Hosts across machines.** Orchestrator and Centralu tools through the router, `ask_project`
   across machines, the reverse direction with consent. Planned in §12.

## 8. Probes before building

| # | Question | How |
|---|---|---|
| 1 | Do machine-prefixed ids survive end to end? | A toy router with an `m1.` prefix in front of a second host; drive create, send, approve, terminal and archive through the real UI |
| 2 | Does the UI keep a mirrored unreachable machine's sessions and leave them asleep? | Same rig; drop the second host; reconnect the UI |
| 3 | Is the hub fast enough as a relay? | Streaming deltas, terminal typing and a large diff over a real SSH link to the Ubuntu server; watch the 64 MiB slow-reader cut |
| 4 | Where should the ssh process live? | Keeper child vs `ControlPersist` across a blue-green hub swap: does the link survive, how long to reconnect. **Run 2026-10-08, §10.6** |
| 5 | How does a version mismatch behave? | Two builds with different `protocolVersion`; what the handshake reports |

### 8.1 Results (2026-10-05)

**Probe 1 holds.** Rig: two hosts as separate processes on temporary data folders
(`e2e/fixtures/linked-host-main.ts`: the real store, session manager, RPC handler, terminals, server
and router, with a scripted agent instead of a model), the hub linked to the other as `m1` over
loopback, the real web UI on the hub (`e2e/linked-hosts*.spec.ts`, Chromium and WebKit, 4 of 4
passed). Through the UI: the remote project shows in the sidebar, a session is created in it
(`m1.<uuid>`), a message streams back, an approval card is answered, a question is answered, a
terminal runs `echo` on the remote (`m1.term-1`), and the session goes to the session archive. What broke or
answered for the wrong machine:

| Where | What happened | Fix |
|---|---|---|
| `messages.load` | Stored payloads are the events themselves and carry the remote's unprefixed `sessionId` | The router rewrites `payload.sessionId`, `from`, `fromSessionId`, project ids in payloads |
| `grid.set` | A remote session panel was dropped: the hub keeps only sessions it knows, and `grid_layout.session_id` references its own `sessions` table | A column for remote panels (§6), kept while the machine is linked |
| `agents.detect`, `agents.models`, `agents.capabilities`, `agents.usage`, `agents.versions` | The new-session dialog and the session header ask without a machine, so the hub's own CLIs answered for a remote project | The optional `machine` parameter (§5); the UI passes it (next PR) |
| `fs.listDir`, `fs.watch`, `agents.listExternalSessions` | Routed by project and worked, so the file tree of a remote project already opens | Kept routed; only `fs.resolve` (a path for this computer's OS) is refused |
| Session row, terminal surface, approval and question ids | Passed unchanged: test ids like `session-row-m1.<uuid>` and `terminal-surface-m1.term-1`; request ids are per session and travel with the routed session id | None |
| The scripted agent | Archiving with "also delete the conversation" needs `deleteExternalConversation` | Test double only |

Approval rule ids, the one number the UI hands back, are folded into negative numbers per machine
(`links/machine-ids.ts`), so an older UI can never delete a local rule with a remote rule's id.

**Probe 2 holds.** Same rig: the remote host is killed, the hub's link goes to `unreachable`, the page's
socket is dropped and reconnects. The session stays listed from the hub's headers mirror with
`live: true` and `unreachable: true`, and the page sends no `agents.resumeSession` (counted at the
socket for 1.5 s after reconnecting). What the UI does with `machine_resync` when the machine comes
back is the next PR.

**Probe 5, measured.** A client hello with another protocol gets one `res` frame and close 4002:

```
{"kind":"res","id":"0","ok":false,"error":{"code":"version_mismatch","message":"Protocol version mismatch: Centralu 0.1.0-beta.11 speaks protocol 1, the app speaks protocol 2. The host is older: update Centralu where the host runs (npm i -g centralu), then restart it.","retryable":false}}
```

Same protocol with different versions connects, and `hello_ok.build.version` names the remote's (the link no longer waits for the person to accept the pair, #689: it connects and offers the update).
So the hub needs nothing new from the handshake: `centralu serve --connection` already reports the
running host's `version` and `protocolVersion` (read from its `hello_ok`, or from that refusal), so
the hub compares before it opens the socket and holds the link at `versions_differ` with both sides
and the older one named. The refusal now also carries `data: { protocolVersion, version }`, so a
4002 after a remote restart is read without parsing the sentence. The sentence says "the app" for
the client, which reads oddly when the client is a hub; left as it is, since the hub shows its own.

**Probe 3 holds.** The Ubuntu server did not answer on port 22 that day; the owner's Windows 11 laptop on the
LAN stood in, with two remote hosts: `centralu serve` of main inside WSL2 (Ubuntu 24.04) and of beta.10 on Windows
itself, each on a temporary data folder. A hub on the Mac (the e2e harness host with the real router, links and
`SshTunnel`) linked to both over the real `ssh` at once; numbers are in [agent-host.md](../agent-host.md) §4.8. In
short: connected in 2–4 s, an RPC through the hub 5–22 ms at the median, a keystroke echoed in 8–31 ms, terminal
output relayed as fast as the remote produced it (6.3 MB at 7.5–15 MB/s from WSL; Windows' ConPTY is slow by itself,
10.0 s through the hub against 9.5 s straight), a 0.5 MB diff in 240–365 ms. The 64 MiB slow-reader cut was not
reached. The laptop went to sleep in the middle of one run: both links went to `unreachable` with ssh's own reason
and came back by themselves once it woke. Model streaming was not measured (no live model in these probes).

What a Windows remote taught, all now in `links/tunnel.ts`:

| Finding | Consequence |
|---|---|
| Windows OpenSSH runs the remote command under PowerShell 5.1, which re-parses quotes and mangles a double quote passed to a native program | A per-machine `shell` (`posix`, `powershell`, `wsl`); anything not a plain word crosses as base64 (`-EncodedCommand`, and a base64 script piped to `bash -l` inside WSL) |
| Exit codes do not survive: a 127 arrived as 1, a missing command inside WSL as 0 | The fallback to `~/.centralu/bin/centralu` is decided on the remote in one command, and "not found" is the word `CENTRALU-NOT-FOUND` on stdout |
| WSL appends Windows' PATH, and `command -v centralu` in the distro named Windows' npm shim, the owner's Windows install | The WSL lookup takes `/mnt/*` off PATH. **That shim ran once during the probe** (with `serve --connection`, before the filter existed); it printed nothing and exited 0 |
| WSL stops a distro about 15 s after its last `wsl.exe` client exits, and its services with it: `centralu serve` under systemd was stopped 19 s after it started; a `setsid nohup` one died with the ssh session that started it | The WSL forward runs `wsl.exe -d <distro> --exec sleep infinity` instead of `-N`, so the link holds the distro while it is up |
| WSL2 forwards the distro's 127.0.0.1 to Windows' 127.0.0.1 | One forward to Windows' sshd reaches a host inside WSL, as the owner said |
| ssh prints `** WARNING` lines about key exchange, PowerShell wraps errors in CLIXML, a Node crash ends with `Node.js v22.x` | The reason shown to the person skips the warnings and the Node line. Of the CLIXML only the header and the progress records go: what a command wrote to stderr after the header and the text of PowerShell's error records are read, without the lines that say where in the script it was (5.1's `At line:` and `+` lines, 7's ConciseView gutter) and without terminal colour (#1081) |
| Windows needs Python and build tools for a source install (`better-sqlite3` has no prebuild for Node 24 there) | Not ours to install on the owner's laptop; the Windows host ran the published beta.10 bundle through main's `serve` launcher (`CENTRALU_HOST_ENTRY`). Phase 3's bundled install avoids it |

A machine can name the command to run in place of `centralu` (`MachineInfo.command`); the probes used it to reach
source checkouts with temporary data folders.

**Probe 4: run on 2026-10-08, §10.6.** The ssh processes stay children of the hub host and end with it; the next host
opens its own links, about 1 s after it serves.

### 8.2 What phase 1 built, host side

`packages/agent-host/src/links/` and `main.ts`: the registry and the headers mirror in the hub's store (v46, expand
only, with a column for grid panels of remote sessions), `SshTunnel` with the three shells, a link per machine with
backoff, version check (§4) and the hidden-session rule (§3.4), the `RemoteClient` (a port of the UI's client: same
cursor and epoch rules, fails fast while away, reports refusals, never answers a request), and the router with a
route for each of the 151 methods (146 plus the five `machines.*`). The protocol gained only additions: `machines.*`,
`machine_status`, `machine_resync`, a `machine` field on rows and an optional `machine` parameter on ten per-machine
calls, `unreachable` on mirrored rows, and data on the version refusal ([protocol.md](../protocol.md) §6).

### 8.3 What phase 1 built, window side

`packages/ui`, `packages/platform` and `@cc/core`'s `machines.ts`: the sidebar grouped by machine (this computer first; one list with a machine badge on each linked machine's project and app since #734),
Settings → Machines (add, remove, reconnect, the last error as what to do), the version prompt (§4: the hub through its
own update, the remote by the exact `npm i -g centralu@<version>` in phase 1, "connect anyway" on one protocol only),
away rows dimmed and never woken, `machine_resync` handled by a recovery scoped to that machine, the per-machine
questions passed with `machine`, and remote sessions named by machine in the inbox, notices, notifications and the
session header (so in the grid and where approvals are answered). Remote apps are listed per machine and say their
views open in a later version (phase 2 opened them, §11). Details: [agent-host.md](../agent-host.md) §4.8, [state-management.md](../state-management.md) §7.

### 8.4 Adding a machine from the ssh config (#514, owner, 2026-10-12)

Linking a machine used to mean typing an ssh target and choosing a shell. The Add machine dialog now lists the hosts
of the hub computer's `~/.ssh/config`, as VS Code's Remote-SSH does: the host reads the config the way OpenSSH reads
it (`Include`, several patterns per `Host`, `Match` blocks left out with a note) and resolves each alias with
`ssh -G`, never opening a key (`machines.sshHosts`). Picking one runs one BatchMode ssh that tells a Unix shell from
Windows, and on Windows which shell answers ssh and which WSL distros exist (`machines.probe`), so the dialog offers
"Windows", "WSL (Ubuntu)" or "Linux or macOS" with a name, and confirming links it. What is already linked through an
alias is marked and not offered again; typing a target stays, for a host not in the config and for a probe that
cannot tell. The probe is short and shell-neutral (one `-EncodedCommand` line of about 1,640 characters, far under
cmd.exe's 8,191, §10.9a). Measured on the Windows 11 PC of §10.9a over Tailscale: it answered in 1.15 s with cmd.exe as
the shell and Ubuntu as the default distro. Details: [agent-host.md](../agent-host.md) §4.8.

## 9. Decisions (owner, 2026-10-05)

Restored as decided; #410 dropped this section by mistake while §2 and the status line still pointed here.

1. **Linked hosts (C)** instead of the UI holding several hosts (B). Replaces decision 1 of
   2026-10-03 on #82.
2. **The remote orchestrator is hidden; remote user-folder apps are shown** (§3.4).
3. **Consent on the connecting side; the reverse direction off by default**, turned on only by the
   connecting side (§3.2).
4. **Any device can be the hub.**
5. **Versions are aligned before connecting**, asking the person, as in §4.
6. **Phase order: 1 → 3 → 2.** Phase 1 updates only the hub side and expects a manual
   `npm i -g centralu` on the remote; phase 3 (install and update over ssh) comes before phase 2.
7. **Where the ssh process lives** is decided by probe 4. Run on 2026-10-08: it stays a child of the hub host (§10.6).

## 10. Phase 3: installing and updating remotes (design, 2026-10-08)

> **Status: decided (owner, 2026-10-08), being built** (§10.10). Measured on the owner's Windows 11 laptop (Windows
> itself and WSL2 Ubuntu 24.04) from a MacBook on the same Wi-Fi, with the published 0.1.0-beta.12 packages. What is
> settled here and why is §10.8; what the owner decided is §10.9. The probe scripts are in
> [spikes/2026-10-remote-install/](../spikes/2026-10-remote-install/).

Phase 1 asks the person to install Node and `npm i -g centralu` on the remote, run `centralu serve` and keep it running
themselves (agent-host.md §4.7), and the version prompt can only print the command to run there. Phase 3 lets the hub
do all of it over the same ssh: install, start, update, roll back, uninstall, with nothing on the remote but a shell,
`tar` and a way to download.

### 10.1 What is installed, and where

Everything lives in the remote's own data folder, beside the store it serves (`~/.centralu`, `%USERPROFILE%\.centralu`,
or `CC_DATA_DIR`):

```
<data>/remote/
  node/v24.21.0/                      the pinned Node, pruned (§10.2); shared by every version that pins it
  versions/0.1.0-beta.13/
    node_modules/centralu/            the npm shim package: bin/centralu.mjs, serve.mjs (and serve-*.mjs), platform.mjs
    node_modules/@centralu/host-linux-x64/host/   the bundled host, the host-only package (step 5);
                                      versions published before it: @centralu/linux-x64/host/
                                      (Windows: …/win32-x64/Centralu/resources/host/)
    install.json                      version, Node version, both integrities, when, by which hub
  current                             one line: "<centralu version> <node version>"
  previous                            the same, for the version before (the rollback target)
  bin/centralu   (centralu.cmd)       the launcher: reads `current`, runs that Node on that centralu.mjs
  .partial-*/                         a download or unpack in progress; removed when it fails or by the next run
  install.lock                        one installer at a time
```

The two packages are unpacked in npm's own layout, so `centralu.mjs` finds `@centralu/<platform>` with the same
`require.resolve` it uses after `npm i -g`, and `centralu serve` runs unchanged (measured: `serve --connection` and
`serve` ran from exactly this layout on both systems). The AppImage and `centralu.exe` are deleted after unpacking: a
remote runs the host only.

**The launcher's content never changes.** It reads `current` at every start, so switching versions is one file
replaced by a rename, atomic on both systems (measured on Windows: Node's `renameSync` over an existing file replaces
it). A launcher rewritten per version would have to be replaced while `cmd.exe` may be reading it, and cmd reads a
batch file by offset as it runs. It lives in `<data>/remote/bin/`, not `<data>/bin/`: an npm install on the same
machine rewrites `<data>/bin/centralu` every time its `serve` runs (agent-host.md §4.7), and the two must not fight
over one file. The managed launcher sets `CENTRALU_MANAGED=1`, and a `serve` that sees it leaves `<data>/bin/` alone.

**The hub's lookup** (`connectionCommand`, `links/tunnel.ts`) tries the managed launcher first, then `centralu` on
PATH, then `<data>/bin/centralu`, so a machine with both runs the version the hub installed, and a phase 1 machine
works as before.

### 10.2 How it is installed

| Step | posix / WSL | Windows (PowerShell 5.1) |
|---|---|---|
| 0. Preflight | `uname -sm`, `getconf GNU_LIBC_VERSION`, free space, `curl` or `wget`, `tar`, `gzip`, `sha256sum` | `$env:PROCESSOR_ARCHITECTURE`, OS build, free space, `tar.exe`, `curl.exe` |
| 1. Node (a shell script from the hub) | download `node-v<N>-linux-<arch>.tar.gz`, `sha256sum` against the hash the hub sends, `tar -xzf` into a `.partial` folder, rename | download the `.zip` with `curl.exe` (or `Invoke-WebRequest`), `Get-FileHash` against the hash the hub sends, `tar.exe -xf` into a `.partial` folder, rename |
| 2. Centralu (a Node script from the hub, run on the pinned Node) | fetch both tarballs, check each against the `integrity` the hub sends, unpack with `tar` into a `.partial` folder, prune, write `install.json`, rename into `versions/<v>/` | the same |
| 3. Start | §10.4 | §10.4 |

- **What travels from the hub is the installer itself.** Step 1 is a short script per shell, sent the way
  `links/tunnel.ts` already sends commands (base64 through `-EncodedCommand`, or to `bash` inside WSL); step 2 is one
  `.mjs` from the hub's host bundle, run on the Node step 1 placed. The remote's old install never decides how the new
  one is installed: the newer side brings the rules, as it brings the version.
- **Unpacking uses the system's `tar`.** Linux has it; Windows has `tar.exe` (bsdtar, which also reads `.zip`) since
  Windows 10 1803. Measured: the Node zip unpacked in 1.4 s with `tar.exe` and in 20.6 s with `Expand-Archive`.
  *Built (step 3) without the `Expand-Archive` fallback*: step 2 needs `tar` for the npm tarballs too, so a Windows
  without `tar.exe` is refused by the preflight instead (S7).
- **Node is pruned to what the host runs**: `include/` (67 MB) and npm and corepack (19 MB) are removed, which takes
  the Linux folder from 208 to 122 MB. It is not put on PATH, so the person's own tools keep finding theirs. What runs
  on it: the host, the Codex bridge (`process.execPath`, `adapters/codex`), and on Windows the `.js` entry of an
  npm-installed agent CLI, which `tool-launch.ts` starts through the host's own Node rather than through `cmd.exe`.
- **The native modules are not tied to one Node.** better-sqlite3 13 is built on node-addon-api and node-pty on
  Node-API, so any Node 22.14 or later loads the published bundles (the floor is Node-API 10, #699; better-sqlite3's own `engines` says only `>=22`, and 22.12.0 crashes, §10.9b). Measured on Node 24.21.0
  (ABI 137, Node-API 10): better-sqlite3 opened a database (SQLite 3.53.4), and node-pty spawned a shell through ConPTY
  on Windows and a pty in WSL. Pinning Node is about having one at all, and the same one everywhere.
- **glibc 2.34 or later on Linux.** Both native modules in `@centralu/linux-x64` reference `GLIBC_2.34` symbols
  (read from the published package): Ubuntu 22.04, Debian 12, RHEL 9, Amazon Linux 2023 and later. The preflight says
  so in one sentence on an older system instead of the host failing at its first `require`. musl (Alpine) is not
  supported: the bundles carry no musl build of node-pty.
- **Sizes and times on the laptop** (§10.7): about 12 s on Windows (a 6 MB package) and 16 s in WSL, where the Linux
  package's 81 MB AppImage costs 9 of those seconds and is thrown away. A host-only package would be 4 MB (owner
  decision 2, §10.9). *Built (step 5)*: `@centralu/host-<platform>`, 3.7 MB packed; the installer falls back to the
  platform package for versions published before it.
- **A dev hub installs nothing by itself**: its version is not on npm. It shows the command to install the latest
  release there, as phase 1 does, and `MachineInfo.command` keeps reaching a source checkout.

### 10.3 Trust: what the remote checks

| What | Checked against | Where that value comes from |
|---|---|---|
| The two npm tarballs | `dist.integrity` (sha512), on the remote, with the pinned Node's `crypto` (measured on both systems) | The hub reads the registry's metadata for that exact version over TLS and checks its `dist.signatures` with the registry's published keys, as `npm audit signatures` does, then sends the integrity to the remote |
| The Node archive | A SHA-256 pinned in the Centralu release | `packaging/remote-runtime.json` holds the version and the hash per platform, taken from that version's `SHASUMS256.txt` after its signature checked with the releaser's key (`scripts/node-pin.mjs`, key from `nodejs/release-keys` at a pinned commit). The release checks the pin against the signed list again before it builds, and the host bundle carries it as `remote-runtime.json` beside `main.mjs`; the hub sends the one for the remote's platform ([releasing.md](../releasing.md) "The Node remotes run") |
| The host folder's own signature | Not checked yet | `content-manifest.json` is signed for macOS only (thin-shell.md §4). Owner decision 6 |

What this gives: the remote runs exactly the bytes `npm i -g centralu@<v>` would have installed and the Node the
release named, and a corrupted or swapped download is refused before it is unpacked. The remote never trusts a hash
it fetched from the same place as the file: a `SHASUMS256.txt` downloaded beside the archive only catches corruption.
What it does not add: whoever can publish to npm as Centralu can still ship a host, exactly as for every npm user today.

### 10.4 Keeping it running without a session

What was measured about processes started over ssh:

| Started how | After the ssh session ends |
|---|---|
| Windows: `Start-Process` inside the session | **Dead.** Windows' OpenSSH ends the session's processes with it |
| Windows: `Win32_Process.Create` through WMI (`Invoke-CimMethod`) | **Alive**: it served through all of probe 4 (three runs, 13 hub swaps), about 15 minutes |
| WSL: `setsid nohup` inside the distro | Alive while the distro runs, but WSL stops the distro about 15 s after its last `wsl.exe` client (phase 1), and empties `/tmp` with it (a probe install there was gone by the next session) |
| WSL: `wsl.exe -d <distro> --exec <launcher> serve`, itself created through WMI | **Alive**, and it holds the distro: still serving 88 s after every other client had gone; ending that `wsl.exe` ended the host. **Not reproduced later the same day** (building step 2): on the same laptop, every WMI-created `wsl.exe` hung without running anything in the distro (it started a second `wsl.exe` and waited), with and without `CurrentDirectory`, `-u`, `--cd` or the Store's full path, with the distro running or stopped, while a WMI-created `wsl.exe --list` and `powershell.exe` worked. Why is not known. `serve --detach` reports it as `wmi_blocked`, ends what it created, and the hub falls back to the link-bound host |
| Linux: `setsid nohup` | Alive (systemd-logind's `KillUserProcesses` is off by default on Ubuntu and Debian); not measured on a real server, the Ubuntu one no longer exists |

From that, **one primitive: `centralu serve --detach`** starts the host outside the session and returns once it
answers (measured 0.5 s on Windows and 0.8 s in WSL from start to `hostRunning`). posix: `setsid` and a double fork.
Windows: WMI process creation of the launcher. WSL: WMI process creation of `wsl.exe -d <distro> --exec <launcher>
serve`, so the host and the distro live as one. The link uses it whenever the connection line says
`hostRunning: false` (today `not_running` only retries), and after an update. A remote host then lives until it is
stopped, the machine reboots or it crashes, and the next link after a reboot starts it again (owner decisions 3, 4, 7).

**Stopping it in order needs the host's cooperation on Windows.** Measured: killing the WMI-started launcher ended
the host 143 ms later with no "shutting down" line in `host.log`. The launcher's child sits in libuv's
kill-on-close job object (the reason `platform.mjs` starts the app detached), so the host never runs its shutdown and
its agents are killed with it. `centralu serve --stop` therefore asks the running host to stop over its own
WebSocket with the token from `serve.json` (an additive RPC), waits for the port to close, and only then ends the
process. On posix, SIGTERM to the launcher stays the stop (agent-host.md §4.7).

**In the person's Windows sign-in when someone is signed in (#1224, 2026-10-19).** A host WMI creates from the hub's
ssh session keeps that session's logon: a key login is a network logon without the password, so DPAPI cannot unlock
the user's vault there, Git Credential Manager can neither use nor save a sign-in, an administrator's token is the
full one (§10.9c), and what the host opens for the person lands in session 0. Measured on a linked Windows 11 PC: the
host's children saw `cmdkey /list` empty while the profile held 46 credential files. A scheduled task whose principal
is `Interactive`, started with `Start-ScheduledTask` from that same ssh session, ran in session 1 with an interactive
logon at medium integrity and saw the user's entries. So `serve --detach` on Windows first looks for this user's
Explorer outside session 0; with one, it registers the data folder's task without a trigger (the one `--autostart on`
gives an `AtLogOn` trigger; a task with no trigger reads as autostart off) and starts it. WMI stays the start when
nobody is signed in, and the host then says which logon it runs in (`hello_ok.logon`), which the machine's row turns
into one sentence. `CENTRALU_SIGNIN_TASK=off` leaves the task out. **The hand-over**: when the person later signs in
(the task's trigger, with autostart on) or a `--detach` starts the task while such a network-logon host still holds the
folder, the task's `serve` waits until that host has nothing running a person would lose, stops it in order and starts
its own. The check and the stop are one call the host decides in one step (`host.stop { ifIdle }`, which from its yes on
refuses every new call), so a turn the hub starts cannot slip in between, as it could over two calls. It waits 30
minutes at most, then gives up until the next sign-in or start, and the machine's row says it waits, then that it gave
up (`host.handover`). Waiting rather than asking: without a keeper on Windows a stop ends what runs, and an idle host
loses nothing.

**Boot autostart is separate and optional.** Linux: the `systemd --user` unit of agent-host.md §4.7, written by the
hub, plus `loginctl enable-linger`, which some distributions allow a user and others refuse without an administrator.
Windows: a per-user scheduled task at logon (no administrator needed; not created on the test laptop, so not
measured). WSL needs that Windows task too, since nothing inside a stopped distro runs. The rest of phase 3 needs none
of these. Built as `centralu serve --autostart`, which the hub runs over ssh (§10.10, step 6).

**The keeper on a remote** is what would let an update leave agents running (§4). Today it cannot run there: the Linux
package carries the host unpacked but the keeper only inside the AppImage (read from the published package), its idle
rules end it when no window attaches, and the keeper is still opt-in on Linux (#350 is fixed by #458; what is left is
running the real window on a Linux desktop, [spikes/2026-10-linux-keeper.md](../spikes/2026-10-linux-keeper.md) §7).
The AppImage problem itself (a keeper running from a FUSE mount that disappears with the window) does not arise for a
host-only install, where the keeper would be a plain file beside `host/`; it links no GUI library, which the release
already checks (`checkKeeperExe`). So a remote keeper is a release change plus a headless mode, after
runtime-unification step 4b (owner decision 5). Windows has no keeper at all.

### 10.5 Update, rollback and uninstall

**Update** (the remote is older, §4), after the person confirms the prompt, which names what stops: the remote's
working, waiting and asking sessions, its terminals and its command runs (the `hostBusy` rule, asked of the remote
through an additive call, since the hub's mirror knows sessions but not terminals).

1. Install the new version beside the running one (§10.2). The running host is not touched; a failure leaves at most
   a `.partial` folder.
2. **Wait until no session there is in a turn** (#1399; the person can stop the wait, or choose to stop the turns): a remote
   has no keeper to hand agents over, so the person's update does not end a turn on its own. The person's `now`, and every
   update nobody approved (following the hub, #1508), do not wait (owner, 2026-10-26, #1618): the turns they end are
   continued once by the next host, from the ids the stopping host writes as it stops (`host.stop { forUpdate }`,
   agent-host.md §4.8, "Continuing the turns an update cut"), and terminals and project commands close. Once a reading has succeeded the wait goes
   on through failed readings (a busy or dropped remote fails them too) and ends only on a successful reading of none, taken
   twice; a machine never read successfully is not waited for. Then stop the running host in order
   (`serve --stop`, §10.4). Without a keeper this ends its agents; their sessions resume on the new host through the stored
   external ids, as after any restart. A turn that begins in the seconds between the last reading and the stop is lost; the
   reading is taken twice for that, and `host.stop { ifIdle }` (the drain, `lifecycle/stop-gate.ts`) would close it for good
   but counts terminals and commands too.
3. Write `previous` (the old line), then replace `current` (the new line), each by rename.
4. Start the new version (`serve --detach`) and wait for a hello whose `build.version` is the new one, at most 30 s.
5. If it does not come: put the old line back in `current`, start the old version, and report the end of the new
   host's `host.log`. One step back is safe by the store rule: migrations only expand while the previous build may
   still be serving (agent-host.md §5.1).
6. On success, remove every version that is neither `current` nor `previous`, and every Node no kept version uses.

**Rollback** is the same switch in the other direction, offered while `previous` exists. Two steps back is not
offered: a store migrated twice may no longer be readable by it, and that host would refuse to start with the
"written by a newer Centralu" sentence anyway. After a rollback the remote is older than the hub again, so §4's prompt
returns; "connect anyway" (one protocol) is how the person keeps working until a fixed version exists.

**On Windows a running version cannot be deleted** (measured: removing the running `node.exe` was refused), which is
why nothing is deleted before the switch and step 6 runs only after the old host is gone. Renaming the folder of a
running `node.exe` was allowed, but the design never needs it.

**Uninstall** stops the host, removes the autostart if the hub wrote one, `<data>/remote/` and the managed launcher,
and keeps the data (the store, `serve.json`, logs), as `centralu uninstall` keeps conversation history. An npm install
on the same machine is not touched. The machine stays linked until the person removes it.

**What the hub knows** comes from the remote, not from a list the hub keeps: the connection line gains an additive
`install` field (`{ managed, current, previous, node }`; the line stays `v: 1`, and `parseConnectionLine` already
ignores fields it does not know), and when nothing is found, the preflight of §10.2 says what could be installed. The
hub keeps the last answer with the machine for Settings → Machines, and asks again at every link start, which it does
anyway.

### 10.6 Probe 4: where the hub's ssh lives across a hub swap

**Rig** ([probe4-swap.mjs](../spikes/2026-10-remote-install/probe4-swap.mjs)): the released beta.12 keeper and host
from `@centralu/darwin-arm64`, on the Mac with a temporary `CC_DATA_DIR`, linked through the front door
(`machines.add`) to a `centralu serve` on the laptop's Windows (installed as in §10.2 on Node 24.21.0, started through
WMI) over the real `ssh` and Wi-Fi. The keeper swaps the host between two builds (the same host under two commits).
Each swap is timed from the `switch` request: the old host drained (the front door closed the probe's connection), the
new host serving (a hello through the front door), and the link up (the new host's `machines.list` says `connected`).
"Link away" runs from the door closing to the link being up: how long the hub's window shows the machine as away.

| Where ssh lives | Swaps | Door closed | New host serving | Link up | Link away | What survives the swap |
|---|---|---|---|---|---|---|
| **Child of the hub host (phase 1)** | 5 | +341–354 ms | +448–462 ms | +1463–1711 ms, median 1496 | **1115–1358 ms, median 1148** | Nothing: the new host opens its own ssh, on the same local port 17175 |
| OpenSSH `ControlMaster=auto`, `ControlPersist=300` | 5, then 3 | +342–382 ms | +454–489 ms | +1076–1410 ms, medians 1110 and 1362 | **728–1066 ms, medians 758 and 980** | The master, and every forward: after 3 swaps it listened on 5 ports, and each new host got another local port |
| Keeper child (estimated, not built) | — | as above | as above | serving + 24–30 ms (median of a hello, `sessions.list` and `projects.list` over a forward left up; 10 tries per run) | **about 140 ms** | The forward and its local port |

What else was seen:

- **With `ControlPersist` the master leaves the keeper's process tree.** OpenSSH backgrounds it with `daemon()`, into
  a session and process group of its own, so the keeper's group stop never reaches it: it was still running after the
  keeper's `stop` ("Quit completely") until the probe sent `ssh -O exit`. Every forward a host asks for stays on the
  master after that host is gone, so the local port moves with each swap and the same-port property app views rely on
  (agent-host.md §4.7) is lost from the first swap on. It saves the TCP connect and authentication (about 0.3 s here),
  not the remote's PowerShell start and `--connection`, which dominate. Windows' OpenSSH, which a Windows hub would
  use, does not support multiplexing (not measured here).
- **The status quo cleans up after itself**: in every run no ssh outlived its host, and none was left after the
  keeper's `stop`.
- **The remote does not notice a hub swap.** One remote host served all 13 swaps without a restart; its sessions and
  agents are its own children and never depend on the link. Only the hub's view of them is away for about a second,
  then `machine_resync` refreshes it. (No live model ran in this probe.)

**Decision (settled by the probe, as decision 7 said): the ssh stays a child of the hub host.** A keeper child would
cut a one-second gap to a tenth of a second, at the cost of the keeper spawning and handing over a kind of process it
does not hold today and the host adopting a tunnel by its tag, on macOS releases and opt-in Linux only.
`ControlPersist` gains less than that, leaks forwards, outlives "Quit completely" and does not exist for Windows hubs.
Revisit only if the second shows up as a problem; the cheaper fix then is in the window (not dimming a machine during
the first seconds after its hub restarted), not in the transport.

### 10.7 Install measurements (2026-10-08)

Scripts: [install-probe.ps1](../spikes/2026-10-remote-install/install-probe.ps1) and
[install-probe.sh](../spikes/2026-10-remote-install/install-probe.sh), sent by
[run-probe.mjs](../spikes/2026-10-remote-install/run-probe.mjs) the way `tunnel.ts` sends commands. Everything ran in
a temporary folder with a temporary `CC_DATA_DIR` and was removed afterwards. Node 24.21.0, Centralu 0.1.0-beta.12.

| Step | Windows 11 (PowerShell 5.1, x64) | WSL2 Ubuntu 24.04 (glibc 2.39) |
|---|---|---|
| Node download | `.zip`, 37.6 MB: 3.7 s with `curl.exe`, 3.5 s with `Invoke-WebRequest` | `.tar.gz`, 58.1 MB: 5.2–5.5 s including its SHA-256 check (`.tar.xz`, 31.9 MB: 3.0 s plus 1.9 s to unpack, but it needs `xz`) |
| SHA-256 check | 0.4 s (`Get-FileHash`) | in the line above (`sha256sum -c`) |
| Unpack Node | 1.4 s with `tar.exe` (20.6 s with `Expand-Archive`); 102 MB | 1.1–1.2 s; 208 MB (`bin/node` 121, `include` 67, npm and corepack 19) |
| First `node --version` | 2.5 s (a new executable's first start) | 4–6 ms |
| `centralu` shim, 22 KB, integrity checked | 0.7 s | 0.2–0.4 s |
| `@centralu/<platform>`, integrity checked and unpacked | 6.2 MB: 1.5 s | 88.0 MB: 9.2 s (AppImage 81 MB, host 12 MB; the host alone is 4.0 MB as `.tar.gz`) |
| Native modules on the pinned Node | 1.3 s: SQLite 3.53.4, a ConPTY spawn | 0.04 s: SQLite 3.53.4, a pty spawn |
| `serve --connection`, nothing running | 0.12 s | 0.06 s |
| `serve` to `hostRunning: true` | 0.53–0.56 s | 0.83 s |
| Folder | 118 MB | 300 MB (122 MB pruned and without the AppImage) |

### 10.8 Decisions settled here

| # | Decision | Why |
|---|---|---|
| S1 | Install into `<data>/remote/`: side-by-side `versions/<v>/`, a shared `node/v<N>/`, and `current`/`previous` pointer files | One place to remove; two versions for rollback; the pointer switches by one rename on both systems (a symlink would be a junction on Windows, which cannot be replaced atomically) |
| S2 | The remote downloads the npm tarballs `npm i -g` uses, and Node from nodejs.org; no npm, sudo or compiler | The phase 1 packages already carry the host for Linux and Windows; measured end to end on both with nothing but the system's `tar` and `curl` |
| S3 | Package integrity from the registry's signed metadata, read by the hub; Node's SHA-256 pinned in the release | The remote checks against values that did not travel with the file (§10.3) |
| S4 | The installer comes from the hub: a script per shell for Node, then one `.mjs` on the pinned Node | The newer side knows the newer layout; everything after Node is written once instead of once per shell |
| S5 | Unpack with the system's `tar`; `Expand-Archive` only as a fallback | 1.4 s against 20.6 s for the Node zip, and no tar reader of our own |
| S6 | Prune Node to the binary and its licence; delete the AppImage and `centralu.exe` after unpacking | 208 → 122 MB for Node on Linux; a remote uses neither npm, the headers nor the window |
| S7 | The preflight refuses glibc below 2.34, musl, an unpublished arch, a missing `tar` or downloader, too little space, each in one sentence | The published native modules need glibc 2.34; a refusal before downloading beats a host that dies at its first `require` |
| S8 | The managed launcher reads `current`, never changes, and lives in `<data>/remote/bin/`; the hub's lookup tries it first | No rewrite of a `.cmd` that may be running; no fight with an npm install's launcher in `<data>/bin/` |
| S9 | `centralu serve --detach` (setsid; WMI on Windows; a WMI-created `wsl.exe --exec` for WSL) is how the hub starts a host | The only measured ways a host outlives the ssh session on each platform |
| S10 | `centralu serve --stop` asks the host to stop over its own socket before ending the process | Measured: killing the launcher on Windows kills the host without its shutdown |
| S11 | Update: install beside, stop, switch, start, check the version that answers, roll back on failure; keep current and previous | Nothing serving is touched until the new version is complete; the store rule makes one step back safe |
| S12 | What is installed is read from the remote (`install` in the connection line), not tracked by the hub | The remote is the one writer of its own state, as it is of its store; a change made there by hand is never contradicted |
| S13 | Uninstall keeps the remote's data | As `centralu uninstall` does; deleting conversations is a separate, explicit act |
| S14 | The hub's ssh stays a child of the hub host | Probe 4 (§10.6) |
| S15 | A dev hub does not install; it shows the command for the latest release | Its build is not on npm; `MachineInfo.command` covers source checkouts |

### 10.9 Decided (owner, 2026-10-08)

The owner took every recommendation of the design. Each line keeps the question, what was decided, and why.

| # | Question | Decided | Why |
|---|---|---|---|
| 1 | Which Node the remote pins | **Node 24 LTS**, one exact version (24.21.0 at first) in `packaging/remote-runtime.json`, and CI runs the host's tests on it beside the jobs on 22 | Supported to April 2028, and measured working with beta.12's bundles (§10.2). 22 LTS ends in April 2027, so pinning it would force a Node change on every remote within six months. The app's own host keeps running on whatever Node 22.14 or later the person has, so CI keeps 22 too |
| 2 | Host-only npm packages | **The existing platform packages first**; `@centralu/host-<platform>` (about 4 MB) later, in a release change, which the installer prefers for the versions that have one | The platform packages already carry the host and work for every published version; the cost is Linux downloading 88 MB to keep 12, which a host-only package removes without blocking anything now |
| 3 | How a Windows (and WSL) remote host outlives the link | **Started detached through WMI** (`serve --detach`); when WMI process creation is blocked, the hub says so and **falls back to a link-bound host** that runs while the link is up | WMI was the only measured start that survives the ssh session on Windows, and leaves nothing behind (no task, no service). Some managed machines block it (Defender's attack surface reduction rule for PSExec and WMI commands, off by default); the link-bound start still works there, only without outliving the link. A scheduled task is the opt-in of 4 |
| 4 | Start the remote host at boot | **Offered per machine, off by default** (a systemd user unit and linger on Linux; a per-user scheduled task on Windows and for WSL) | After a reboot the next link starts the host anyway (7); autostart matters only for agents that should run with no hub around, and linger may need an administrator |
| 5 | A keeper on Linux remotes | **Right after phase 3's first four steps and runtime-unification step 4b** (#350 itself is fixed, #458) | Without it §4's prompt says "this stops N agents" on every Linux update. Windows stays without one |
| 6 | Sign the Linux and Windows host folders | **npm's integrity and registry signatures now; signing comes with the Linux keeper (5)** | Integrity checked on the remote plus registry signatures checked by the hub is what every npm user gets today; signing pays off once a Linux keeper starts from verified content as the macOS one does |
| 7 | Start a remote host the link finds not running | **Automatically**, and say so in the machine's row and in `host.log` | Adding the machine was the consent (§3.2); asking each time would turn every reboot of the remote into a prompt |

### 10.9b A Node below the floor (#699, 2026-10-15)

A Windows 11 PC on Node 22.12.0 never connected: `centralu serve` started the host, which exited with 3221225477
(`0xC0000005`) before its migration line. The bundled better-sqlite3 13 is built with `NAPI_VERSION=10`; Node-API 10 came
with Node 22.14.0, and under an older Node the module loads and crashes on `new Database`. Measured with the published
`@centralu/win32-x64` host and portable Node zips: 22.14.0, 22.23.3 and 24.21.0 open a database; 22.13.1, 22.13.0,
22.12.0, 22.0.0 and 20.19.0 crash. The same module crashes on macOS (arm64) under 22.12.0 (SIGSEGV) and works under 22.14.0,
so the floor is one for every platform. Rebuilding with `NAPI_VERSION=9` does not work as it is (its `StatementIterator`
setup fails on every Node), so a lower floor would mean patching and building the module ourselves on four platforms.
Option 4 of the question to the owner was taken: **keep the floor at 22.14.0, and do not make the person fix it**.

| # | Decided | Why |
|---|---|---|
| 1 | The floor is `engines.node` of the npm package (`>=22.14.0`), read by the launcher (`bin/node-floor.mjs`) and, from the bundle's copy `centralu-package.json`, by the hub (`links/install.ts` `nodeFloor()`). The root and `agent-host` `engines` equal it (`tooling/engines.test.ts`) | One number; npm itself warns on an install under it |
| 2 | `centralu serve` and `--detach` refuse a Node below it in one sentence (the Node found, the floor, update Node or link the machine from a Centralu window) before any host starts, and download nothing | A CLI that fetches a runtime on its own is a new download path, with none of the hub's checks (§10.3) |
| 3 | The hub switches a below-floor machine to the managed install by itself (on the connection line's `install.node`, on `node_too_old`, or on a start that exited with 3221225477 or SIGSEGV) and says so once in the row; it is tried once until the link next connects | Adding the machine was the consent (decision 7); the install is the one a person's click runs, SHA-256 checked. Looping on a host that still fails would hide the real cause |
| 4 | Not switched, but named in a sentence with the floor: a development hub (its version is not published), a machine running a command of the person's own, a hub with no installer | There is nothing to install, or the person chose what runs there |

The app's own host is held to the same floor: the keeper (`host_proc/node.rs` `min_node()`) reads the same `package.json` with `include_str!` at compile time, and refuses a system Node below it with a sentence that names the floor, the Node found and the upgrade command.

### 10.9a Real run on a Windows 11 PC (2026-10-11)

Hub built from main on a temporary data folder, the PC over ssh (cmd.exe default shell, WSL Ubuntu): install on WSL
(beta.13, 6 s), update WSL to beta.14 (25 s), install on Windows beside it (beta.14, 5 s; the two hosts on 17175 and
17176, #482), rollback WSL to beta.13 (19 s), uninstall both (host stopped, `<data>/remote/` removed, data kept). Two
defects found and fixed in the same pull request: the cmd.exe line above, and every rollback timing out, because the
check waited for a hello on the link and the link does not open to a host older than the hub (§4); the check is now
met by the version the connection line read from the running host. WSL still does not start through WMI there
either (the link-bound fallback ran).

### 10.9c An administrator's ssh on a Windows machine (#702)

During the #14 real-use check a remote terminal's title read `Administrator: …powershell.exe`: Windows OpenSSH gives
an account in the Administrators group a full, elevated token for a network logon, with no UAC split, so the host the
hub started, every agent and every tool call there ran as an administrator. On Windows that is the default for most
single-user machines. The host now asks once at startup (`whoami /groups`: an integrity level of High or System; root
elsewhere, `elevation.ts`) and says so in every `hello_ok` (`elevated`, additive); the hub keeps it on the row
(`MachineInfo.elevated`) and Settings → Machines says one sentence: agents there run with administrator rights, and
linking through a standard account with its own ssh key avoids it. Not a refusal. **Before linking a Windows machine**:
link it through a standard (non-administrator) account if its agents should not run elevated; the account needs its
own key in its `~/.ssh/authorized_keys` (an administrator's key goes in `administrators_authorized_keys` instead).

### 10.10 Work, in pull requests

| Step | What | Estimate (agent work) |
|---|---|---|
| 1 | The release records the pinned Node (version and SHA-256 per platform, from a signature-checked `SHASUMS256.txt`) as `remote-runtime.json` in the host bundle; CI runs the host's tests on that Node too. **Done** | 0.5–1 day |
| 2 | `serve --detach` and `serve --stop` (setsid, WMI, WSL through WMI; the additive stop RPC), the `install` field in the connection line, the managed-launcher rules in `serve.mjs`; the link starts a host it finds not running. **Done**: `host.stop`, `MachineStatus` `starting` and `MachineInfo.hostStarted` (additive), the link-bound fallback when WMI is blocked ([agent-host.md](../agent-host.md) §4.7, §4.8) | 1.5–2 days |
| 3 | The installer: preflight and Node per shell, the `.mjs` step, registry metadata and signatures on the hub, the layout and pointer files, the lookup order in `tunnel.ts`; tested with a fake ssh and a local registry fixture, then by hand on the laptop's Windows and WSL. **Done** as `machines.install` (additive), [agent-host.md](../agent-host.md) §4.8; the posix scripts run for real in the tests, the Windows and WSL ones are checked as built but **not yet run on a Windows machine** (choices below) | 2–3 days |
| 4 | Update, rollback and uninstall as `machines.*` calls (additive) with progress in `machine_status`; the version prompt's "Update <machine>" naming what stops; Settings → Machines rows. **Done** as `machines.update`, `machines.rollback`, `machines.uninstall` and `machines.activity` (with the remote's `host.activity`), `MachineInfo.install`, `MachineInfo.operation` and the status `updating` (all additive), [agent-host.md](../agent-host.md) §4.8 (choices below); the posix path runs for real in the tests, the Windows and WSL paths **not yet run on a Windows machine** | 2–3 days |
| 5 | (Owner decision 2) Host-only packages in the release. **Done**: `@centralu/host-linux-x64`, `-linux-arm64` and `-win32-x64` (`host/` only, 3.7 MB packed against 88 MB for the Linux platform package), published by each platform's release job before its platform package; the installer prefers them and falls back to the platform package when the registry has none at that version; the shim's `serve` finds the host in either ([releasing.md](../releasing.md) "Host-only packages"). The release itself is **not yet rehearsed** with them (choices below) | 1 day |
| 6 | (Owner decisions 4, 5) Boot autostart; the remote keeper after #350. **Partly done**: boot autostart, as `centralu serve --autostart on\|off\|status` and `machines.autostart`, with `MachineInfo.autostart` and the connection line's `autostart` (all additive), [agent-host.md](../agent-host.md) §4.7, §4.8 (choices below); the unit, the task and every command are tested against fakes, **not yet run by a real Linux boot or a real Windows Task Scheduler**. The remote keeper is still open | 1 day; 3–5 days |

Steps 1 to 4 are phase 3 as §4 needs it, about 6–9 days; each lands behind phase 1's manual path, which keeps working.

**Choices made building step 3** (within §10.1–§10.3):

- **The preflight reports, the hub decides.** The script per shell prints facts on one line (`CENTRALU-PREFLIGHT
  os=… arch=… glibc=… musl=… freeKb=… tar=… gzip=… fetch=… sha=…`) and `preflight()` in `install.ts` turns them into a
  platform or one sentence, so every refusal is tested on any machine. Space asked for: 600 MB on Linux, 300 MB on
  Windows (the peak of §10.7 with room).
- **Three ssh commands**: preflight, Node, Centralu. The hub reads and checks the registry metadata between the first
  two, so a refused machine or a bad signature downloads nothing. Each answers a `CENTRALU-INSTALL` word; the hub
  writes the sentences (exit codes do not survive Windows, §4.8 of agent-host.md).
- **The `.mjs` travels gzipped in base64 inside its step's script**, written to `<data>/remote/.install-<pid>.mjs` and
  removed after. A Windows step that does not fit cmd.exe's 8,191-character line (Windows OpenSSH's default shell, when
  no `DefaultShell` is set) goes as a short reader on the command line and the script on ssh's stdin (`RemoteCommand`
  in `tunnel.ts`); a test holds every inline command to 7,900. Found on the first run against a Windows 11 PC with the
  default shell (2026-10-11): the installer's step, about 18,700 characters as one `-EncodedCommand`, was refused with
  "The command line is too long." (the laptop used before had PowerShell as its `DefaultShell`).
- **Registry signatures**: the version document `/<name>/<version>` and the keys at `/-/npm/v1/keys`, over TLS; a
  signature counts only from a published key that has not expired, over `<name>@<version>:<integrity>`. Checked
  against the live registry for 0.1.0-beta.13 while building. The tarball must come from the registry's own origin.
- **The launcher text comes from the installed version's `serve.mjs`** (`managedLauncherScript`), written only when
  there is none. **Pointers** are written to a temporary file and renamed over; `previous` before `current`.
- **The data folder is `CC_DATA_DIR` there, else `~/.centralu`**, in the lookup, the scripts and the `.mjs` alike.
- **Install also switches `current`** and prunes to current and previous; the running host keeps running from what is
  now `previous`, so nothing in use is removed. Step 4 wraps this in stop, switch, start and check.
- **On Windows the `.mjs` runs `%SystemRoot%\System32\tar.exe` by its full path**: a GNU tar earlier on PATH (Git's)
  reads `C:` in an archive path as a remote host.

**Choices made building step 5** (owner decision 2):

- **Names and shape**: `@centralu/host-<platform>` for the platforms the Node pin serves, `host/` at the top on every
  platform (Windows included, where the platform package has it under `Centralu\resources\`), `os` and `cpu` as the
  platform package's. Under the `@centralu` scope, so nobody else can publish the name.
- **The shim does not pin them.** An npm install already has the host in its platform package; pinning both would
  download it twice. The installer asks for its own exact version, and a release publishes both packages of a
  platform from one build, so the host-only package and the shim of one version always come from one commit.
- **Fallback only on "not published"**: the registry's 404 for the package or the version (`NotPublished`,
  `registry.ts`). A bad signature, or a registry that does not answer, refuses as before rather than trying the
  other package. So a hub keeps installing versions published before step 5, and a tampered host-only package is
  never quietly replaced by the larger one.
- **The shim finds either** (`findHostEntry`, `platform.mjs`): the platform package first, then the host-only one.
  Only shims from step 5 on know the second, and only versions from step 5 on have one, so the two always meet.
- **Published first in its job, and re-runs skip what this commit already published** (releasing.md "When a job
  fails halfway"): a new package name is the likeliest publish to be refused, and refused first it leaves nothing of
  that platform on the registry.

**Choices made building step 4** (within §10.5):

- **The update's install does not switch** (`activate: false`), and writes no launcher when there is none yet: until
  the running host is stopped, the lookup must still find the Centralu that runs, so `serve --stop` is that version's
  own. Step 3's `machines.install` keeps switching at once, for a machine where nothing runs.
- **The later steps reuse `remote-install.mjs`** (`action: 'pointers'` and `'prune'`), run on the Node of a version that
  is there, so the pointer rules (rename over, `previous` before `current`, `install.lock`) live in one file.
  Uninstall is a shell script instead: on Windows the Node that would run the `.mjs` is one of the files to remove.
- **The link is held from the stop to the check**: no reconnect, no start of a host of its own, Reconnect included.
  Without it the link's automatic start (decision 7) could start the old version between the stop and the switch.
- **The check is the link's own hello**: the link opens again, and only a hello whose `build.version` is the target ends
  it; a host of another version answering in time counts as a failure.
- **Rollback clears `previous`** rather than swapping the two: the version it left stays on disk (nothing is pruned), so
  the next update finds it and downloads nothing, and "Roll back" is never offered towards the newer version or two
  steps back.
- **A failed first update over an npm install** puts back no pointer and removes the launcher, so the lookup finds the
  npm install again.
- **What stops is the remote's own count** (`host.activity`, the `hostBusy` rule counted). A remote predating it is said
  as "anything running"; no remote has a keeper yet, so the prompt always says the agents stop.
- **Uninstall keeps the autostart question for step 6**: nothing writes one yet, so there is none to remove. (Step 6
  now removes it: below.)

**Choices made building step 6, boot autostart** (within §10.4 and owner decision 4):

- **The remote writes its own entry.** The hub runs `centralu serve --autostart on|off|status` through the lookup, and
  the Centralu found there writes, removes or reads the entry; the hub keeps nothing (S12). Only the lookup crosses ssh,
  as short as `--connection`'s, so it fits cmd.exe's 8,191 characters (#489); the scheduled task's PowerShell, which is
  long, is built and run there, on a command line of its own.
- **What the entry runs is the launcher of the lookup**: the managed launcher when the hub installed Centralu there (it
  reads `current`, so an update or rollback needs no new entry), else the launcher `serve` keeps for an npm install.
- **Linux**: a `systemd --user` unit (`centralu-serve.service`) running `serve` in the foreground, `KillMode=mixed`,
  `Restart=on-failure` bounded to five starts in five minutes, enabled for `default.target`; then `loginctl
  --no-ask-password enable-linger`. Where lingering is refused the switch stays on and the row says it starts at login
  until an administrator runs `sudo loginctl enable-linger $USER`. Lingering is never turned off again: other things may
  rely on it.
- **Windows and WSL**: a scheduled task for this user at their sign-in (`Interactive`, no administrator, no stored
  password), running `serve` in a hidden PowerShell window with no time limit and on battery too. Not `--detach`: a task
  is not an ssh session, and it needs no WMI (decision 3). For WSL the task runs `wsl.exe -d <distro> -u <user> --exec
  <launcher> serve`, which holds the distro while the host runs. One task per data folder, so a laptop linked as
  Windows and as WSL gets two. Starting before sign-in would need an administrator or a stored password, so it is not
  offered; with automatic sign-in, sign-in is boot.
- **Nothing offered** on macOS, a Linux without systemd, or WSL without interop: the row shows no switch.
- **On and off never start or stop a host.** The link has already started one; the entry is for the next boot. `on`
  does not `enable --now`: a second `serve` beside the running one would fail and be restarted.
- **The connection line says it** (`autostart: { on, how, linger }`) from a mark `--autostart` keeps in the data folder
  (`autostart.json`), so no link start asks systemd or Task Scheduler. `--autostart status` asks them and corrects the
  mark.
- **Uninstall removes the entry** after the stop and before `<data>/remote/` goes, through `serve --autostart remove`
  (`off` of a serve from before it; since #1224 `off` keeps the Windows task without its trigger); it
  refuses to go on when the entry would not go. A version older than `--autostart` is passed by: it cannot have written
  one from here. Not covered: an entry written by a newer version, then a rollback past `--autostart`, then an uninstall
  leaves the entry (it then runs a launcher that is gone, which fails at boot and does nothing else).

### 10.11 A dev build of the host on a linked machine (#1036)

A linked machine runs released hosts only: `machines.install` and `update` install from npm, and a hub on a local
build hands remotes its base release. Trying an unreleased host change on Windows took a whole beta. Design 1 of the
issue, the smallest, puts a dev build on the machine from one git commit, with nothing new crossing the link:

    pnpm remote-dev <machine> --ref <commit> --repo <working copy there> [--allow-dirty]

- **A maintainer's command on the hub, not an RPC** (`packages/agent-host/scripts/remote-dev.mts`, `links/remote-dev.ts`).
  It finds the machine in the hub's store (read only: id, name or ssh target), resolves `--ref` in the hub's working
  copy to all 40 digits, and reaches the machine over the link's own ssh. Agents and linked machines gain nothing.
- **Checked before anything stops** (`devBuild` in `remote-install.mjs`, run there on the Node `current` runs on):
  the hub installed a release there (a dev build needs one to go back to); the working copy's HEAD is exactly that
  commit (it is checked, never checked out: the person's working copy is not changed); it has no uncommitted changes
  unless `--allow-dirty`; its `PROTOCOL_VERSION` is the one of the working copy the command runs from (the hub's own);
  the Node there is not below its `engines.node` floor; its dependencies are installed. Each refusal is one sentence
  (`failure` in install.ts). git there is the one on that machine's PATH, as the maintainer runs it in that working
  copy; `remote-install.mjs` runs on its own Node and cannot use the host's `runGit`.
- **Built there by the working copy's own bundler**, on that Node: `bundle.mjs` with `CC_BUNDLE_OUT` writes the host
  straight into `<data>/remote/versions/<base>.local.N/node_modules/@centralu/host-<platform>/host/`, beside the
  launcher package copied from the working copy with `<base>.local.N` stamped into its `package.json` (the version the
  host reports, through `CC_HOST_SOURCE`, so neither `brand.ts` nor anything else in the working copy is touched;
  `stampLocalVersion` is not needed). `N` is the next free number for that base. The build's output goes to
  `<data>/remote/dev-build.log`; a failed build leaves nothing.
- **Marked as dev**: `install.json` gains `source: { kind: 'dev', commit, dirty }`; the connection line's `install`
  carries it (`installInfo` in serve-install.mjs), `InstalledVersion.source` (additive) brings it to `machine_status`,
  and the row says "a dev build of <commit>".
- **Swapped by the update's own steps** (`switchRemote` in update.ts): stop, switch, start, a hello from
  `<base>.local.N` within 30 s, or the old pointers back and the old version started again with the end of its log.
- **The store is copied before the dev build first opens it.** A dev build runs on the machine's real data folder, and
  its migrations may raise the store's `min_reader_version` past what the release reads (a `breaksOlderReaders` step);
  the release would then refuse to start (`StoreTooNewError`) and the machine would have no host. So once the old host
  is stopped, before the switch, `store.db` and its `-wal`/`-shm` are copied to `<data>/remote/store-backup/<version
  that left it>/` (`storeBackup` in remote-install.mjs). A dev build that does not answer (it died, or a heavy
  migration took longer than 30 s) is stopped and the copy is put back before the old version starts again. Leaving a
  dev build later (`machines.rollback`, or `machines.update` to its release), the release is started on the store as
  the dev build left it first; only if it does not answer is the copy put back and the release started once more, and
  the result's `note` says that what was done on the dev build since is not in the store. A copy goes when its version
  is pruned. Only the store is copied: a dev build that writes elsewhere in the data folder in a way the release cannot
  read is not undone, and the copy needs as much free space as the store.
- **The way back is the release**: `previous` is the release it replaced, and a dev build over a dev build keeps that
  release (the earlier dev build is pruned, with its copy). `machines.rollback` returns to it, and `machines.update`
  now takes `<base>.local.N` to `<base>` (it refused it as a downgrade); a remote on `<base>.local.N` is ranked as
  `<base>`, so the hub on `<base>` is not offered an update (§4). Going back is safe only as far as the copy reaches:
  what the dev build did to the store is kept when the release reads it, and dropped when it does not.
- **The hub's links are held** (`swap-hold.ts`): a link that finds no host running starts one itself (decision 7),
  which mid-swap would be the old version. Before stopping anything the command writes `<data>/remote/hold.json` there
  (`{ until, by }`, ten minutes on the hub's clock); a link asks for it before it starts a host and, while it holds,
  says `updating` and asks again every few seconds. The command lifts it when it is done, whatever happened; one it
  could not lift lapses. Not an RPC: the command cannot reach the hub's host. A hub from before the hold does not ask,
  and may still start the old version mid-swap, which the swap then answers by putting the old version back. A
  machine where WMI is blocked (link-bound hosts, decision 3) cannot be checked from the command and is refused at the
  start step.
- **Limits**: the machine needs the repository and its build tools (pnpm install done there); a stable base
  (`x.y.z` with no prerelease) is refused, since `<base>.local.N` is SemVer only on a prerelease. The Mac stays on
  `pnpm local-update` (its keeper runs signed content only). Design 2 (a CI artifact per commit, streamed and hashed by
  the hub) is later.

## 11. Phase 2: app views through the hub (design and build, 2026-10-11)

> **Status: built, the owner decided §11.7 on 2026-10-11.** Before this, every app-view call naming another machine's
> project or session was refused (`noRemote` in `links/routes.ts`), and the window said those views open "in a later
> version".

### 11.1 What stood in the way

A view is two nested frames ([apps.md](../apps.md)). The outer one is the host's proxy page at
`http://127.0.0.1:<host port>/<secret>/views/<instance>/`; for an app that asks for its own origin, the inner one is
`http://127.0.0.1:<that app's port>/<derived secret>/views/<instance>/view`, a port from the host's port book
(`views/origin-ports.ts`, 20000–32767, fixed per app and never reused). A linked machine's addresses name that
machine's ports, which the hub's window cannot reach: the ssh forward carries the host port only, and opening one more
forward per origin port needs either a new ssh session per app (seconds each) or OpenSSH multiplexing, which Windows'
OpenSSH does not have and probe 4 turned down (§10.6).

There is a second, deeper reason not to forward the machine's origin ports at all: **browser storage lives in the
window that renders the view, the hub's.** The machine's port book keeps its apps apart from each other, not from the
hub's: the machine's `notes` app on its port 23456 and the hub's `board` app on the hub's port 23456 would render under
the same origin, `http://127.0.0.1:23456`, in the one WebKit that holds both, and share localStorage and IndexedDB.
Isolation per app holds only if the port comes from the book of the host whose window shows it.

### 11.2 The design: the hub serves the view, the machine hands over the document

The instance stays where it was opened: on the machine whose app it is, holding that app from idling, exactly as
today. Only the serving moves.

| Step | Where | What |
|---|---|---|
| Open | the machine | `apps.openView` (or an agent's call, for a view in a conversation) opens the instance there. Its id reaches the window qualified, `<machine>.<id>` (§3.3), from the answer, the `app_view` event and `apps.inlineViews` / `apps.inlineReopen` |
| Address | the hub | `apps.viewFrame` stays on the hub. Its ViewHost sees the qualified id and asks the machine `apps.viewDocument { instanceId }` (new, additive): the app, the resource URI, the origin method the app's manifest asks for, and the app's `resources/read` answer **as is** |
| Proxy page | the hub | Served from the hub's own door, under the hub's own secret, at `/views/<machine>.<id>/`. CSP, sandbox, `allow`, drag relay: the hub's code applied to the machine's raw document, the same code as for its own views |
| Per-app origin | the hub | A port from **the hub's** book, keyed `<machine>.<the machine's own key>`: `m1.<project>/<app>`, or `m1._user/<app>` for a user-folder app, apart from every key of the hub's own (`_user/<app>`, `<project>/<app>`) |
| Calls | the machine | `apps.invoke`, `apps.readResource`, `apps.viewMessage`, `apps.closeView` go to the machine the instance (or project, or conversation) names (route kind `view`) |

So the hub rewrites nothing in a URL: no address the machine made ever reaches the window. The machine binds no port
for a view the hub serves, and its HTTP secret never leaves it.

### 11.3 Security

- **Loopback only, behind a secret, as before.** The address is the hub's own door (`127.0.0.1`, its per-run or
  keeper-derived secret), and the per-app origin server the hub's (`127.0.0.1`, its HMAC-derived secret per key). The
  link itself carries only RPCs the hub already makes with the machine's token.
- **Nothing that decides a view's reach is taken as finished text.** The machine answers the app's raw resource; the
  hub reads the view out of it (`viewDocumentFromResource`) and builds the CSP itself, so loopback in a declared domain
  is dropped by the hub's rule (`csp.ts`) whatever the machine's build does. The one thing taken from the machine is
  which origin method the manifest asks for, which the hub takes from its own apps' manifests as well.
- **The instance decides the app,** as everywhere (#93, #94). The hub checks the app the window claims against the
  machine's answer, and the machine's answer against the id it was asked by: a project of another machine (`m2.…` asked
  through `m1`) is "not open", so a machine cannot put its view under another machine's origin.
- **One call reaches one machine.** A view call naming two machines, or a machine and the hub (a pinned view of `m1`
  sending to a conversation on this computer), is refused (`AcrossMachinesError`): the instance and the conversation
  would live on two hosts, and neither could check the other.
- **The direction is unchanged** (§3.2): the hub asks, the machine answers. A machine still cannot call the hub.

### 11.4 A linked machine's user-folder app

A project app's id already names its machine (`m1.<project>`). A user-folder app's is null, so whatever opens one names
the machine: `apps.openView { appId, projectId: null, machine }` (additive, the same optional `MachineId` as the ten
per-machine questions of §5). In the window, a pinned view and `focusedApp` carry `machine`, and its key is
`<machine>:_user/<app>`, the sidebar row's key since phase 1. After that, its calls are named by the qualified instance.
A view in a machine's conversation needs nothing new: the instance names the machine.

The pinned view's side panels (runs, secrets, versions, builder) and Restart were left out for such an app at first:
their calls named an app by project and id alone, and would have answered for this computer's app of the same id.
§11.9 gives them the same `machine`.

### 11.5 Lifecycle

- **Link drop.** The machine notices nothing; its instances stay open. While the link is away, a new address fails at
  once and says to retry (`MachineUnreachableError`), the proxy page is a 404, and an open view's calls fail like any
  call to that machine. A view already loaded keeps running: its document needs nothing more from the link.
- **Hub swap.** The hub holds nothing per remote view but a 15-second, 64-entry cache of documents it just read (three
  reads per load become one). The address is the front door's port and the keeper-derived secret, so the next hub
  serves the same address by asking the machine again, about a second after it serves (§10.6). The per-app port comes
  from the hub's store, so it is the same too.
- **Machine restart.** Its instances are gone (no keeper on a remote yet, §10.4): the view gets "not open" and the
  window's existing failure path, as for the hub's own views after a restart without a hand-over.
- **A machine from before this.** It answers "Unknown method" to `apps.viewDocument`; the window says to update
  Centralu there (§4 normally aligns versions first; "connect anyway" is the case this covers).
- **A removed machine.** An id whose prefix names no link reaches the hub's own handler, where it is never open.

### 11.6 What was measured and tested

No live link was measured for this step: the RPC through the hub is 5–22 ms at the median (§8.1), and a view load
costs one `apps.viewDocument` within the cache window. Tested: `links/linked-views.test.ts` (two real ViewHosts with the
real router and qualifier between them: the hub's door and CSP, four apps named `board` on two machines getting four
origins, the machine's answer checked, a hub that never gave the address out serving it, away, older and unlinked
machines), `links/router.test.ts` (each view call and the `machine` parameter), `app-home-view.test.ts`
(`apps.viewDocument` against a real app process), the window's keys and status (`app-catalog.test.ts`,
`store-apps.test.ts`), and e2e on the linked-hosts rig (`e2e/fixtures/linked-hosts-ui-scenarios.ts`).

### 11.7 Decided (owner, 2026-10-11)

| # | Question | Decided | Why |
|---|---|---|---|
| 1 | Another machine's user-folder apps: open their pinned views now? | **Yes, with an optional `machine` on the opening call and in the window's pinned-app identity** (§11.4) | The rest follows from the qualified instance; the side panels waited until their calls could name the machine (§11.9) |
| 2 | Grid panels of another machine's apps | **Next, in a separate pull request** (built: §11.8) | The hub keeps an app panel only while it knows the app's project (`setGridView`), which a linked machine's it does not; a remote session's panel already has its own column (v46) |
| 3 | A machine removed and another linked under the same name | **Keeps the old origins, and with them the old browser storage: accepted** | The key is `<machine id>.<app key>`, and a machine id comes from its name (`newMachineId`). This is the same trade-off already made for a local app deleted and made again under the same id: same key, same origin. The ports never go to a different key, so no other app ever reads it |

### 11.8 Grid panels of another machine's apps (2026-10-11)

Owner decision 2 of §11.7. An app panel on the grid is `{ kind: 'app', projectId, appId, span? }` (#288), kept by the hub
in `grid_layout`, and the hub's `setGridView` kept one only while its project was in the hub's own `projects` table, which
a linked machine's project never is. Its view is already the hub's (§11.2), so only the panel's place had to change.

- **Naming the machine.** A project app's qualified id names it. A user-folder app gets an optional `machine` on its
  panel (additive in `GridPanel`), and its key is `app:<machine>:_user/<app>`, the sidebar row's key with `app:` in front
  (`appKeyOf` in `@cc/core` now takes the machine, and `parseAppKey` reads it back). The grid's view of such an app
  carries the machine and opens it there (`ensureGridAppView`, `apps.openView { machine }`).
- **What the hub keeps** (`setGridView` in the manager): another machine's project app while the mirror knows its
  project (`Links.projectMachine`), and a machine's user-folder app while that machine is linked (`Links.linked`). A
  panel naming a machine nobody linked, or a project the mirror never heard of, is dropped, as an unknown session is.
  `listGridView` asks the same of the store, so a panel whose project left the machine's list stops showing without the
  layout losing its place; removing the machine removes its panels.
- **Where it is stored** (store v47, expand only): two nullable columns, `remote_app_id` and `app_machine`, with `app_id`
  left NULL, as v46 did for sessions with `remote_session_id`. A host from before v47 reads app rows only where `app_id`
  is set, so it never takes a machine's `notes` for its own; rewriting the layout, it drops those rows, which loses a
  panel, not the layout.
- **Not changed here:** the side panels of a machine's user-folder app (§11.4), then waiting on the owner's answer (§11.9).

Tested: `links/stored.test.ts` (kept and dropped by machine and mirror, and the query of a v46 host), `links/links.test.ts`
(through `grid.set` and `grid.get` on a real link, and removing the machine), `core/grid/panels.test.ts`,
`ui/features/grid/drop.test.ts`, and the linked-hosts e2e in Chromium and WebKit (a project app and both `notes`
dragged onto the grid, each with its own view, back in place after a reload).

### 11.9 A machine's user-folder app gets its panels and Restart (owner, 2026-10-12)

The owner's answer to the question §11.4 left open: yes. The calls behind the pinned view's panels take the same
optional `machine` as `apps.openView` (additive): `apps.runs`, `apps.permissions`, `apps.forgetPermission`, `apps.usage`
(the Runs panel), `apps.setSecret` (Secrets), `apps.versions`, `apps.restoreVersion` (Versions), `apps.builder`,
`apps.createBuilder`, `apps.askBuilder`, `apps.errors`, `apps.sendError` (the builder and the error tail) and
`apps.restart`. With no project and a `machine`, the hub sends the call to that machine without the parameter, where it
is its own user-folder app; without `machine` it stays the hub's, as before; with a project, the project names the
machine (route `app` in `links/routes.ts`). `apps.askBuilder` may also name the view it came from: it routes as a view
call, and an instance of one machine with a `machine` of another is refused. The rows of `apps.runs` come back
qualified (`projectId`, `callerSessionId`, `sessionId`), so the panel's link reaches the agent session on that machine.
So do the `denied.projectId` of an `apps.errors` bundle (the screen compares it with its own app's qualified project) and the
`importedAs` of an `agents.listExternalSessions` row (the session the new-session dialog jumps to; `externalId` is the tool's
own id and stays as it is).

In the window, every one of those calls passes the machine of a machine's user-folder app (`userAppMachine`), the
pinned view shows all its panels, and Restart restarts it there. Remove was left out of this step: `apps.remove` named no
machine, and would have removed this computer's app of the same id (§11.10 adds it).

Tested: `links/router.test.ts` (each call sent by `machine`, the hub's own without it, the runs qualified, a builder
asked from a view naming one machine), `store-apps.test.ts` (Restart passes the machine), and the linked-hosts e2e in
Chromium and WebKit (the machine's `notes` lists its own runs and asks that machine for its versions; this computer's
`notes` lists none of them).

### 11.10 Removing a machine's user-folder app (owner, 2026-10-12)

The owner allowed removing another machine's user-folder app from Settings → Apps. `apps.remove` takes the same optional
`machine` (additive) and routes like the panels' calls (§11.9): with no project and a `machine`, the call goes to that
machine without the parameter and removes its own app there; without `machine` it is this computer's, as before; a
machine nobody linked removes nothing anywhere. That machine broadcasts `external_apps_changed`, which reaches the window
through the link, and the window reads the merged list again: the app's pinned view closes as any vanished app's does
(machine-aware since §11.4), and its grid panel stops showing (`visibleGridPanels`, keyed by machine since §11.8).

Settings → Apps did not list a machine's user-folder apps at all before this: they now stand in a group per machine
under its name, and the question before Remove names the machine and says this computer's apps are not touched.

Tested: `links/router.test.ts` (removed on the named machine only, the hub's own without `machine`, an unlinked machine
refused), `store-apps.test.ts` (the window passes the machine), and the linked-hosts e2e in Chromium and WebKit: with both
`notes` on the grid and in pinned views, removing the machine's from Settings moves that machine's folder away and leaves
this computer's folder, row, pinned view and grid panel as they were, while the machine's row, view and panel go.

## 12. Phase 4: the orchestrator and Centralu tools across machines (plan, 2026-10-12)

> **Status: built; steps 1, 2 and 3 (§12.3, §12.4, §12.6), and step 4 (§12.7).** Steps 1 to 3 follow from decisions already made (§9:
> the hub's one orchestrator, consent on the connecting side). Step 4, the reverse direction, follows the owner's answers in §12.5
> (2026-10-18, #550).

Phase 1 left the orchestrator and the Centralu tools local (§6): the hub's orchestrator lists, reads, searches and
directs only the hub's own sessions, and an ordinary session's `ask_project` reaches only the hub's projects. Phase 4
takes them across the links.

### 12.1 What holds throughout

- **One orchestrator** (§3.4, decision 2): a linked machine's orchestrator and coordinators stay hidden, from the hub's
  window and from the hub's orchestrator alike. A machine never shows another its orchestrator's conversation.
- **The hub asks, the machine answers** (§3.2, decision 3). The hub's orchestrator acting on a linked machine is the
  connecting side controlling the other, consented to when the link was added. Nothing in steps 1 to 3 lets a machine
  call the hub; step 4 lets it ask the hub's projects, and nothing else (§12.7).
- **A host answers only about itself** (§3.1): a machine never relays another machine's sessions, so a hub with
  several links asks each one, and nothing loops.
- **What a machine says is someone else's words.** A worker's text already reaches the orchestrator fenced (#121): a
  preview or a snippet is JSON-quoted on one line, so it cannot pose as a line of ours. A machine is one step further
  away (a compromised server must not reach the Mac, §3.2), so the hub fences everything a machine hands its
  orchestrator: names on one line, ids of the id shape, each line of a conversation one line.
- **The orchestrator's tools keep their words.** Their descriptions ride in every orchestrator request (11,798 of the
  12,000 characters `RESIDENT_BUDGET_CHARS` allows, #513); the results name the machine, and the descriptions stay.
  Step 2 added one optional parameter, `create_project`'s `machine` (11,862 on Claude, 11,914 on Codex).

### 12.2 Steps

| Step | What | Needs from the owner |
|---|---|---|
| 1 | **Read.** The hub's orchestrator's `list_sessions`, `read_session` and `recall` include every linked machine. Each machine answers for its own sessions through three host-to-host calls (additive): `host.sessions`, `host.readSession`, `host.recall`, made by the orchestrator's own code there, over the same view the hub's window has (everything but its orchestrator and coordinators). The hub qualifies the ids, names the machine on each row and hit, lists an unreachable machine's sessions from the headers mirror marked as not reachable, and says which machines it could not search (decided on #82, 2026-10-03: a host that is off says so instead of returning nothing). `send_to_session` and the other acting tools refuse a linked machine's session with a reason, until step 2. **Built** (§12.3) | Nothing |
| 2 | **Direct.** `send_to_session`, `update_session_settings` and `create_session` reach a linked machine's sessions and projects through the router, and `create_project` takes a machine. `reportBack` across machines: the hub already relays the machine's events into its own log, qualified; the manager watches those for the end of the turn it waits on. The instruction is recorded on the machine as sent by the hub's orchestrator (`agents.send` gains an optional `from`, additive), so the machine's conversation says who sent it. The machine's session keeps its own approval settings, and its cards reach the hub's window as every remote card does. **Built** (§12.4) | Nothing (decision 3) |
| 3 | **`ask_project` to a linked machine's project.** An ordinary session on the hub asks a project on another machine: the consent card for the pair names the machine; the delegated session runs on that machine, its own logins and folder, under `normal`, as an ordinary visible session there; the answer comes back fenced as today. Paths in the answer name that machine's files, so none is opened to the asking session: they are listed as the machine's, and the person reaches them through the file tree or "Open in VS Code" (phase 2). A session on a machine asking a project on that same machine already works there, its card routed to the hub's window. **Built** (§12.6) | Nothing new, unless the owner wants a cross-machine ask to need more than the pair's card (§12.5, question 4) |
| 4 | **The reverse direction** (decision 3: off by default, only the connecting side turns it on). A machine's sessions reach the hub: what they may do is §12.5. Mechanically: a per-link switch on the hub (Settings → Machines, stored in the hub's registry, additive), the hub's end of the link answering an allowlist of requests from the machine (until then `RemoteClient` never answered one), and the machine naming the hub to its sessions. **Built** (§12.7) | Decided (§12.5, 2026-10-18) |

Not in phase 4: attaching one machine's app to a session on another (§6: the app process and the session would live on
two hosts), and `delete_worktree_session` across machines (a worktree manager is a seat on its own project's machine,
and its tools stay there).

### 12.3 Step 1, as built (2026-10-12)

- **On the machine.** `SessionManager.hostReader()` is the orchestrator's `listSessions`, `readSession` and `recall`
  over the hub's view: no calling session (nothing to leave out as "itself"), and orchestrator and coordinator
  sessions out of scope, so `host.readSession` refuses one by id as "not a session this machine shares". A read is
  capped at 200 lines and a search at 50 hits per call, five times the tools' defaults, so one call cannot ask a
  machine for its whole store.
- **On the hub** (`links/linked-sessions.ts`, wired in `main.ts` as `useLinkedReader`). One call per machine, in
  parallel, each bounded by the link's call timeout; a list or a search waits at most 4 s for each machine (`LOOKUP_MS`,
  #984) and treats one past it as away. A machine that is away contributes its mirrored sessions with
  "not reachable right now" (list) or its name under "Not searched" (recall), and is not asked; one that predates step
  1 answers "Unknown method" and is named as needing Centralu updated there. The central orchestrator reads through
  it, and since #984 so does an ordinary session of a trusted project, which sees only a machine's ordinary sessions
  that the headers mirror holds (not an app's; a project there nobody trusted is marked) (`readerFacts`); a lead keeps
  its members.
- **Hits from several machines** are taken in turns, one from each machine's own ranked list (`takeInTurns`): ranks
  from two stores do not compare, and appending would let the first list fill the limit before the others are heard.
- **Text.** A row is `- <name> [m1.<id>] · project <project> on <machine> · <tool> · <state>`, with `· <why>` when the
  row is only what the hub last knew; a hit's heading is `[<project> on <machine>]`. The hub drops a row or hit whose
  id is not id-shaped, puts every name on one line, and JSON-quotes any conversation line that is not already one
  line. `trustedJsonText` now also escapes U+2028 and U+2029, which `JSON.stringify` leaves as they are.
- **Acting is refused with a reason**: `send_to_session`, `update_session_settings` and `delete_worktree_session` on a
  machine's session say it is on that machine and can be read, not directed, until step 2 (§12.4 sends the first two there; `delete_worktree_session` is a manager's, and a manager sees only its own machine).
- **No tool's words changed**, so the orchestrator's resident cost (#513) is as it was.

Tested: `links/links.test.ts` (two real hosts linked: list, read at the end and around a recall hit, the machine's
orchestrator and coordinator neither listed, found nor read, sending refused, the caps swept across 200 lines and 50
hits, the machine away), `links/linked-sessions.test.ts` (a machine answering forged names, ids and lines, an older
machine, `takeInTurns` at every limit). No live model read through it, and no real ssh link.

### 12.4 Step 2, as built (2026-10-12)

- **`send_to_session`** to a machine's session goes to that machine as `host.send { sessionId, text, from: { name } }`
  (additive): the machine delivers it as its own orchestrator's instruction, recorded as sent by `<orchestrator> on <this
  computer's host name>`, to a session a hub is shown and no other (its orchestrator and coordinators refuse). It
  stays an instruction, not someone else's words (#120): the hub holds the machine's token and could send the same
  text as the person, so marking it a relay would only hide the words from a worktree manager it was meant for. The
  machine records the sender as `_hub-orchestrator`, an id no host makes; the windows show only its name.
- **`reportBack`** across machines: the hub's links already relay the machine's events, qualified, to its windows;
  `main.ts` also hands them to `SessionManager.observeLinked`, which watches the sessions the orchestrator asked about.
  The watch starts before the send (the machine's first events can reach the hub before its answer) and is put back
  if the send fails. It reads nothing until the machine's `user_message` of that instruction (from the hub's
  orchestrator, the same text): a link relays one machine's events in order, so a turn end before it is an earlier
  turn's that was still on its way (#1082). A record that never comes (lost in a host swap there) stops being waited for once the send has answered, which comes after it on the same link. A turn ends as it does here (#166): `turn_complete`, `error`, `limit_reached`, or a state out of
  work once the turn was seen working, so the session waking before its turn is not its end. The report is the same
  message as for this computer's sessions (`deliverReport`), its project named with the machine (`api on Ubuntu box`,
  from the headers mirror) and its last words read with `host.readSession`.
- **`update_session_settings`** goes through the router as the window's own `agents.updateSettings` does, and the hub
  sends `settings_changed` with the qualified id, so no change happens without a trace (#30).
- **`create_session`** finds a project on the machines by its name or qualified id (`projects.list` of each reachable
  machine) and creates the session there through the router (`agents.createSession`, `normal`, the project's default
  tool, then `sessions.rename`); the first instruction goes as `send_to_session` does. One name on more than one
  machine, this computer included, is refused with each project's id and machine rather than guessed.
- **`create_project`** takes `machine` (a linked machine's name or id; this computer when absent). The card is the same
  card, raised in the orchestrator's session on this computer, with the path that machine would make
  (`projects.createPreview` there) and the machine named: `ApprovalDetail` `project_create` gains `machine`
  (additive), and the card and its question say "on <machine>". On Create, that machine makes and registers it
  (`projects.create` there); nothing is made on either computer before the answer.

Tested: `links/links.test.ts` (two real hosts: sending with and without a report, the report once and after the turn,
the sender's name there, a worktree manager there getting the words as an instruction, settings and their event,
creating a session by id and by name and the refusal of a shared name, creating a project after the card, an unknown
machine), `links/linked-sessions.test.ts` (the report's rules against a stand-in machine: waking is not an end, an
error says so, one report, none unasked, none after a failed send), `core/approval/approval.test.ts` and
`e2e/project-cards.spec.ts` (the card and its question naming the machine). No live model, no real ssh link.

### 12.5 Step 4 and one question on step 3: decided (owner, 2026-10-18, #550)

The owner took **(a)** for question 1 and the recommendations for questions 2 to 4, with one addition: once a pair is
approved, its sessions act on their own, and later asks in that pair need no card until the person withdraws the
consent. As built in §12.7. The questions as they were asked:

1. **What may a machine's sessions do on the hub once the switch is on?** (a) only `ask_project` into the hub's
   projects, each pair behind the hub's consent card, which stands in the hub's window; (b) (a) plus reading the hub's
   sessions (`read_session`, `recall` over the hub's projects); (c) everything the hub's orchestrator may do there,
   in reverse. Recommendation: **(a)**. It serves the case that needs the reverse (a session on a server asking the
   laptop's project for something only the laptop has), and the person approves each pair where they are looking. (b)
   hands the hub's conversations to a machine the plan already treats as the less trusted side; (c) makes the
   server a second orchestrator, which decision 2 rules out.
2. **Where the switch lives and what turning it on says.** Recommendation: a per-machine switch in Settings →
   Machines, off by default, its question naming what it allows ("Sessions on <machine> may ask this computer's
   projects to do work; each pair asks you first") and stored with the machine, so removing the machine removes it.
3. **Several hubs linked to one machine** (decision 4: any device can be the hub). A machine's session would see each
   hub that turned the switch on. Recommendation: each such hub appears to the machine's sessions by the hub's own
   name, and a hub whose link is down is "not reachable" there, as a machine is here.
4. **A cross-machine `ask_project` (step 3): is the pair's card enough?** Recommendation: **yes**, with the machine
   named on the card. The work then runs on that machine under its own logins and credits; the card is where the
   person sees that.

### 12.6 Step 3, as built (#700)

`ask_project` finds the projects of every linked machine, and gives the task to one of their ordinary sessions (agent-host.md
§1.2.4 has the lookup rules and the choices). An agent on the hub had been told "No project named …" for a project
that existed on a linked machine and listed only this computer's.

- **Lookup.** A unique bare name works; `<machine>/<name>` or a qualified id always does; the same name on two machines
  is refused with both listed; a machine that is not connected is named, with its projects from the headers mirror.
  The "other projects" list says which machine each is on once a machine is linked.
- **Delivery.** `host.send` (step 2's call), waited on through the machine's relayed events and answered with the
  session's last words (`host.readSession`). No new host-to-host call and no store change.
- **Consent.** The card names the machine; the answer "always" is read as once and nothing is remembered. Remembering
  needs a store step (`project_consents` has foreign keys to `projects`), which this does not take (§12.5, question 4
  stays open for a remembered form).
- **Races.** The machine's sessions are read again after the card is answered and nothing is sent into a turn the person
  started there meanwhile; a project list that takes over 4 s counts the machine as away for that call; a link that drops
  after the task was sent ends the wait with a sentence (`machine_status`), since the turn's end can no longer be seen.
- **Not built**: `ifBusy` (a note or a queue into a busy session there), the caller answering the machine's cards
  (`asking`; they stand in the hub's window and the call reports the wait), and stopping the machine's turn when the
  call is cancelled.
- **`find_apps` is unchanged.** It lists apps another project shares, and attaching one needs the app process and the
  session on one machine (§6, Attaching a hub app to a remote session).

Tested: `links/links.test.ts` (two real hosts: by bare name, `machine/name`, the machine's name, qualified id; the
card naming the machine and "always" read as once; the same name on two machines; the machine down, from the
mirror and unseen; a session waiting on an approval there, then asked again), `sessions/ask-project.test.ts`
(`matchProjects`), `core/approval/approval.test.ts` and `e2e/fixtures/ask-project.ts` (the card). No live model, no real
ssh link, no Windows machine.

### 12.7 Step 4, the reverse direction, as built (#550)

A linked machine's session asks a project of the hub, as it would ask one of its own machine: `ask_project` with the
hub's project by its name, `<hub>/<name>` or a qualified id. Nothing else of the hub is reachable from the machine.

- **The switch** (question 2). Per machine in Settings → Machines, off by default, stored on the machine's row
  (`linked_machines.asks`, store v60) so removing the machine removes it, and a machine linked again under the same id
  starts with it off. Turning it on asks once and says what it allows (core's `asksRow`): ask_project into this
  computer's projects and nothing else, a card for each pair's first ask, no card after it until withdrawn. Turning it off
  does not ask, refuses the next call at once and forgets every pair approved for that machine: turning it on again is a
  new consent. While it is on, the row lists the approved pairs (`machines.askConsents`), each with Withdraw.
- **The link carries it.** The hub tells the machine who it is at every connect and when the switch moves
  (`host.hubOffer { hub: { id, name }, on }`, additive). The hub's id is its own, made once and kept in its store
  (`hub.selfId`, `hub-` and 8 hex digits). The machine calls it back on that connection only (`HostServer.call`: an
  `rpc` frame from the host, answered with `res`; `call.cancel` withdraws one; protocol.md §1), never on another and
  never at an address of the hub's choosing.
- **The allowlist** (question 1, option (a)). The hub's `RemoteClient` answers a call from the machine only through the
  handler its link gives it (`reverseCalls`, links/reverse-calls.ts): `hub.projects` and `hub.askProject`, and anything
  else is "Unknown method". Each call is refused unless the machine's switch is on, read when the call comes. The
  machine is the link's own, never what the call says. At most 16 calls run at once; a withdrawn call or a dropped
  link aborts the call's work.
- **The pair's card** (the owner's addition). The card is the hub's, raised in the hub's session that would get the
  task, so only the hub's windows can answer it. It is raised whatever that session's preset: `auto` there does not
  answer it (`alwaysAsk`), since `auto` is that session's own, not a consent for another machine to reach it. (start_agent
  on another computer asked the same way until #1273, where an `auto` caller's start goes unasked to a machine that
  takes `auto` from it: that is this computer's session acting on another computer, not another machine reaching this
  one.) Turning the switch off closes a card still standing. It names the machine and the asking session there (`ProjectAccess.from
  .machine`, `.session`, additive). Approving it is remembered for the pair (that session of that machine, this
  project; `machine_ask_consents`, store v60) until withdrawn in Settings → Machines, the switch going off, or the
  machine or project being removed; a remembered pair passes with no card. Deny is not remembered. The switch and the
  project are read again once the card is answered, and once more when the session is awake to take the task (a wake
  or a deferred restart takes seconds).
- **What runs** (`MachineAsks`, sessions/machine-asks.ts). An existing ordinary session of the project, chosen as an ask
  here chooses one (#614); never created, never an app's or a builder's; one busy with a turn gets nothing (no note or
  queue from another machine, as §12.6 the other way). The task is framed as from that session on that machine
  (`MACHINE_ASKER`, never the person and never an orchestrator), and the session works on it one level below the asker
  (the depth the machine sends, kept until the turn ends, #867), so it cannot ask on. The call waits up to
  `ASK_WAIT_MS` and then says "still working"; a call with no task waits again. The answer goes back cut to size; its
  paths are the hub's files, listed and none opened on the machine.
- **Several hubs** (question 3). Each hub that offered appears to the machine's sessions by its own name; one whose
  connection is gone stays listed as "not reachable right now", with the projects it last listed, until it offers again
  or the machine's host restarts (the machine keeps the hubs in memory only). A hub that said off is forgotten at once.
- **Older builds.** A machine from before it answers the offer "Unknown method": the hub's row says to update it there,
  while the switch is on. A hub from before it never offers, so the machine's sessions never see it, and its link drops
  a call from the machine unanswered. A hub that offered but lacks a call is named as needing an update.

Not built: the asking session answering the hub session's own cards (they stand in the hub's window, and the call says
it waits), and stopping the hub's turn when the machine's call is cancelled after the task went in (a card still
standing is withdrawn). The machine's caller losing trust while the hub's card stands does not withdraw that card: the
machine reads its gates before it asks, the hub reads its own after.

Tested: `links/reverse-asks.test.ts` (real hosts: off by default and a call that comes anyway refused, the card naming
the machine and the session, an approved pair with no card, withdrawing, another session of the machine as another
pair, the switch off forgetting the pairs and refusing an approval given after it, a cancelled call withdrawing the
card, a call that runs out of time closing the card, the switch going off closing a standing card, a hub session under
`auto` still asked, removing the machine, a busy session, two hubs by name and one away, a machine and a hub from
before it), `transport/server.test.ts`
and `links/remote-client.test.ts` (the calls on the socket), `dev-services/store-machine-asks.test.ts` (the switch and
pairs, removed with the machine by an older build and with the project), `e2e/machine-asks.spec.ts` (the switch
off for a new machine, its question, the pairs withdrawn, off forgetting them; the card naming the machine and the
session there, Allow and Deny only), `core/approval/approval.test.ts` and `core/machines/machines.test.ts` (the
words). No live model, no real ssh link.
