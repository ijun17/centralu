# Remote mode as linked hosts: design draft

> **Status: decided by the owner on 2026-10-05 (§9), recorded on #82.** It replaces the "multi-host client" shape decided on 2026-10-03
> (decision 1 on #82) with linked hosts, after the owner asked on 2026-10-05 why the UI should
> hold several hosts at all.

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
- **Where the ssh process lives.** Open question (§9). Candidates: a keeper child (survives a
  hub swap; unix and keeper only), or OpenSSH `ControlMaster`/`ControlPersist` (survives any host
  restart, works in dev and on every unix). To be decided by a probe.
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
   shown** (owner, 2026-10-05), grouped by machine and qualified by it (`_user/<appId>` collides
   across machines otherwise). They run on their own machine; their views need the proxy of
   phase 2, so in phase 1 they are listed and their tools work, and their views say they open in a
   later version.

## 4. Versions: align before connecting (owner, 2026-10-05)

When a link connects and the two sides run different versions, Centralu asks to bring the older
side up to the newer one, and does not connect until they match or the person declines.

- **The hub is older:** the existing one-click update and seamless switch.
- **The remote is older:** update it over ssh (the installer/updater, phase 3).
- **The question says what stops.** On a remote without a keeper (Linux today, until #350), an
  update cuts running agents; the prompt names them.
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
| By session id | 28 | send, approve, answer, interrupt, messages, trash… |
| By project id | 34 | createSession, git, fs, terminals, commands… |
| By app | 27 | four keyed by opaque host values the hub must remember (view instance, question, import token) |
| By terminal / run id | 4 | ids are per-host counters |
| Merge across hosts | 14 | `sessions.list`, `projects.list`, search, trash… (approval rule ids and pids collide) |
| Hub only | 26 | layout, grid, prefs, themes, updates, orchestrator, skills |
| Internal callbacks, never routed | 4 | a remote's own Codex bridge talks to its own host |
| Needs a machine parameter | 9 | `projects.add`, `agents.models/detect/capabilities/versions/usage`… (additive optional `machine`) |

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

## 6. What is tied to a machine

| Thing | Phase 1 | Later |
|---|---|---|
| Sessions, approvals, questions, inbox | Routed | |
| Terminals and command runs | Routed (frames relayed; every keystroke is one RPC, latency to be measured) | |
| Grid panels holding remote sessions | Needs a table or column: `grid_layout.session_id` references the local `sessions` table | |
| Reveal in Finder, open in IDE | Off for remote projects | VS Code Remote-SSH links |
| File tree, diff, search | Off for remote projects | Routed (paths are project-relative already) |
| App views | Off for remote projects | View URLs carry the host's own port and per-app origin ports; needs a proxy through the hub |
| Attachments | Work: saved and read on the same machine as the session | Upload through the hub |
| Usage gauges | Hub machine only | Per machine (decision 5) |
| Orchestrator and Centralu tools (`list_sessions`, `read_session`, `recall`, `ask_project`) | Local only, documented | Through the router; `ask_project` across machines also has to handle the paths it hands back |
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
   after #350), uninstall.
4. **Hosts across machines.** Orchestrator and Centralu tools through the router, `ask_project`
   across machines, the reverse direction with consent.

## 8. Probes before building

| # | Question | How |
|---|---|---|
| 1 | Do machine-prefixed ids survive end to end? | A toy router with an `m1.` prefix in front of a second host; drive create, send, approve, terminal and trash through the real UI |
| 2 | Does the UI keep a mirrored unreachable machine's sessions and leave them asleep? | Same rig; drop the second host; reconnect the UI |
| 3 | Is the hub fast enough as a relay? | Streaming deltas, terminal typing and a large diff over a real SSH link to the Ubuntu server; watch the 64 MiB slow-reader cut |
| 4 | Where should the ssh process live? | Keeper child vs `ControlPersist` across a blue-green hub swap: does the link survive, how long to reconnect |
| 5 | How does a version mismatch behave? | Two builds with different `protocolVersion`; what the handshake reports |

### 8.1 Results (2026-10-05)

**Probe 1 holds.** Rig: two hosts as separate processes on temporary data folders
(`e2e/fixtures/linked-host-main.ts`: the real store, session manager, RPC handler, terminals, server
and router, with a scripted agent instead of a model), the hub linked to the other as `m1` over
loopback, the real web UI on the hub (`e2e/linked-hosts*.spec.ts`, Chromium and WebKit, 4 of 4
passed). Through the UI: the remote project shows in the sidebar, a session is created in it
(`m1.<uuid>`), a message streams back, an approval card is answered, a question is answered, a
terminal runs `echo` on the remote (`m1.term-1`), and the session goes to the trash. What broke or
answered for the wrong machine:

| Where | What happened | Fix |
|---|---|---|
| `messages.load` | Stored payloads are the events themselves and carry the remote's unprefixed `sessionId` | The router rewrites `payload.sessionId`, `from`, `fromSessionId`, project ids in payloads |
| `grid.set` | A remote session panel was dropped: the hub keeps only sessions it knows, and `grid_layout.session_id` references its own `sessions` table | A column for remote panels (§6), kept while the machine is linked |
| `agents.detect`, `agents.models`, `agents.capabilities`, `agents.usage`, `agents.versions` | The new-session dialog and the session header ask without a machine, so the hub's own CLIs answered for a remote project | The optional `machine` parameter (§5); the UI passes it (next PR) |
| `fs.listDir`, `fs.watch`, `agents.listExternalSessions` | Routed by project and worked, so the file tree of a remote project already opens | Kept routed; only `fs.resolve` (a path for this computer's OS) is refused |
| Session row, terminal surface, approval and question ids | Passed unchanged: test ids like `session-row-m1.<uuid>` and `terminal-surface-m1.term-1`; request ids are per session and travel with the routed session id | None |
| The scripted agent | Trashing with "also delete the conversation" needs `deleteExternalConversation` | Test double only |

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

Same protocol with different versions connects, and `hello_ok.build.version` names the remote's.
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
| ssh prints `** WARNING` lines about key exchange, PowerShell wraps errors in CLIXML, a Node crash ends with `Node.js v22.x` | The reason shown to the person skips all three |
| Windows needs Python and build tools for a source install (`better-sqlite3` has no prebuild for Node 24 there) | Not ours to install on the owner's laptop; the Windows host ran the published beta.10 bundle through main's `serve` launcher (`CENTRALU_HOST_ENTRY`). Phase 3's bundled install avoids it |

A machine can name the command to run in place of `centralu` (`MachineInfo.command`); the probes used it to reach
source checkouts with temporary data folders.

**Probe 4: not run.** The transport is behind an interface (`links/tunnel.ts`), tested with a fake `ssh` on PATH, so
the probe can move it (a keeper child or `ControlPersist`) without touching the router. Until then the ssh processes are
children of the hub host and end with it; the next host opens its own links (2–4 s).

### 8.2 What phase 1 built, host side

`packages/agent-host/src/links/` and `main.ts`: the registry and the headers mirror in the hub's store (v46, expand
only, with a column for grid panels of remote sessions), `SshTunnel` with the three shells, a link per machine with
backoff, version check (§4) and the hidden-session rule (§3.4), the `RemoteClient` (a port of the UI's client: same
cursor and epoch rules, fails fast while away, reports refusals, never answers a request), and the router with a
route for each of the 151 methods (146 plus the five `machines.*`). The protocol gained only additions: `machines.*`,
`machine_status`, `machine_resync`, a `machine` field on rows and an optional `machine` parameter on ten per-machine
calls, `unreachable` on mirrored rows, and data on the version refusal ([protocol.md](../protocol.md) §6).
