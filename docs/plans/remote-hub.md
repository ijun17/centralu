# Remote mode as linked hosts: design draft

> **Status: decided by the owner on 2026-10-05 (§9), recorded on #82.** It replaces the "multi-host client" shape decided on 2026-10-03
> (decision 1 on #82) with linked hosts, after the owner asked on 2026-10-05 why the UI should
> hold several hosts at all. Phase 3 (installing and updating remotes) and probe 4 are designed in §10 (2026-10-08);
> the owner decided its open questions the same day (§10.9).

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
   after #350), uninstall. Designed in §10.
4. **Hosts across machines.** Orchestrator and Centralu tools through the router, `ask_project`
   across machines, the reverse direction with consent.

## 8. Probes before building

| # | Question | How |
|---|---|---|
| 1 | Do machine-prefixed ids survive end to end? | A toy router with an `m1.` prefix in front of a second host; drive create, send, approve, terminal and trash through the real UI |
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

`packages/ui`, `packages/platform` and `@cc/core`'s `machines.ts`: the sidebar grouped by machine (this computer first),
Settings → Machines (add, remove, reconnect, the last error as what to do), the version prompt (§4: the hub through its
own update, the remote by the exact `npm i -g centralu@<version>` in phase 1, "connect anyway" on one protocol only),
away rows dimmed and never woken, `machine_resync` handled by a recovery scoped to that machine, the per-machine
questions passed with `machine`, and remote sessions named by machine in the inbox, notices, notifications and the
session header (so in the grid and where approvals are answered). Remote apps are listed per machine and say their
views open in a later version. Details: [agent-host.md](../agent-host.md) §4.8, [state-management.md](../state-management.md) §7.

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
    node_modules/centralu/            the npm shim package: bin/centralu.mjs, serve.mjs, platform.mjs
    node_modules/@centralu/linux-x64/host/   the bundled host (Windows: …/win32-x64/Centralu/resources/host/)
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
  Windows 10 1803. Measured: the Node zip unpacked in 1.4 s with `tar.exe` and in 20.6 s with `Expand-Archive`, which
  stays as the fallback for an older Windows.
- **Node is pruned to what the host runs**: `include/` (67 MB) and npm and corepack (19 MB) are removed, which takes
  the Linux folder from 208 to 122 MB. It is not put on PATH, so the person's own tools keep finding theirs. What runs
  on it: the host, the Codex bridge (`process.execPath`, `adapters/codex`), and on Windows the `.js` entry of an
  npm-installed agent CLI, which `tool-launch.ts` starts through the host's own Node rather than through `cmd.exe`.
- **The native modules are not tied to one Node.** better-sqlite3 13 is built on node-addon-api and node-pty on
  Node-API, so any Node 22 or later loads the published bundles (better-sqlite3's own floor). Measured on Node 24.21.0
  (ABI 137, Node-API 10): better-sqlite3 opened a database (SQLite 3.53.4), and node-pty spawned a shell through ConPTY
  on Windows and a pty in WSL. Pinning Node is about having one at all, and the same one everywhere.
- **glibc 2.34 or later on Linux.** Both native modules in `@centralu/linux-x64` reference `GLIBC_2.34` symbols
  (read from the published package): Ubuntu 22.04, Debian 12, RHEL 9, Amazon Linux 2023 and later. The preflight says
  so in one sentence on an older system instead of the host failing at its first `require`. musl (Alpine) is not
  supported: the bundles carry no musl build of node-pty.
- **Sizes and times on the laptop** (§10.7): about 12 s on Windows (a 6 MB package) and 16 s in WSL, where the Linux
  package's 81 MB AppImage costs 9 of those seconds and is thrown away. A host-only package would be 4 MB (owner
  decision 2, §10.9).
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

**Boot autostart is separate and optional.** Linux: the `systemd --user` unit of agent-host.md §4.7, written by the
hub, plus `loginctl enable-linger`, which some distributions allow a user and others refuse without an administrator.
Windows: a per-user scheduled task at logon (no administrator needed; not created on the test laptop, so not
measured). WSL needs that Windows task too, since nothing inside a stopped distro runs. The rest of phase 3 needs none
of these.

**The keeper on a remote** is what would let an update leave agents running (§4). Today it cannot run there: the Linux
package carries the host unpacked but the keeper only inside the AppImage (read from the published package), its idle
rules end it when no window attaches, and #350 is open. The AppImage problem itself (a keeper running from a FUSE
mount that disappears with the window) does not arise for a host-only install, where the keeper would be a plain file
beside `host/`; it links no GUI library, which the release already checks (`checkKeeperExe`). So a remote keeper is a
release change plus a headless mode, after #350 (owner decision 5). Windows has no keeper at all.

### 10.5 Update, rollback and uninstall

**Update** (the remote is older, §4), after the person confirms the prompt, which names what stops: the remote's
working, waiting and asking sessions, its terminals and its command runs (the `hostBusy` rule, asked of the remote
through an additive call, since the hub's mirror knows sessions but not terminals).

1. Install the new version beside the running one (§10.2). The running host is not touched; a failure leaves at most
   a `.partial` folder.
2. Stop the running host in order (`serve --stop`, §10.4). Without a keeper this ends its agents; their sessions
   resume on the new host through the stored external ids, as after any restart, and a turn in progress is lost.
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
| 1 | Which Node the remote pins | **Node 24 LTS**, one exact version (24.21.0 at first) in `packaging/remote-runtime.json`, and CI runs the host's tests on it beside the jobs on 22 | Supported to April 2028, and measured working with beta.12's bundles (§10.2). 22 LTS ends in April 2027, so pinning it would force a Node change on every remote within six months. The app's own host keeps running on whatever Node 22 or later the person has, so CI keeps 22 too |
| 2 | Host-only npm packages | **The existing platform packages first**; `@centralu/host-<platform>` (about 4 MB) later, in a release change, which the installer prefers for the versions that have one | The platform packages already carry the host and work for every published version; the cost is Linux downloading 88 MB to keep 12, which a host-only package removes without blocking anything now |
| 3 | How a Windows (and WSL) remote host outlives the link | **Started detached through WMI** (`serve --detach`); when WMI process creation is blocked, the hub says so and **falls back to a link-bound host** that runs while the link is up | WMI was the only measured start that survives the ssh session on Windows, and leaves nothing behind (no task, no service). Some managed machines block it (Defender's attack surface reduction rule for PSExec and WMI commands, off by default); the link-bound start still works there, only without outliving the link. A scheduled task is the opt-in of 4 |
| 4 | Start the remote host at boot | **Offered per machine, off by default** (a systemd user unit and linger on Linux; a per-user scheduled task on Windows and for WSL) | After a reboot the next link starts the host anyway (7); autostart matters only for agents that should run with no hub around, and linger may need an administrator |
| 5 | A keeper on Linux remotes | **Right after phase 3's first four steps and #350** | Without it §4's prompt says "this stops N agents" on every Linux update. Windows stays without one |
| 6 | Sign the Linux and Windows host folders | **npm's integrity and registry signatures now; signing comes with the Linux keeper (5)** | Integrity checked on the remote plus registry signatures checked by the hub is what every npm user gets today; signing pays off once a Linux keeper starts from verified content as the macOS one does |
| 7 | Start a remote host the link finds not running | **Automatically**, and say so in the machine's row and in `host.log` | Adding the machine was the consent (§3.2); asking each time would turn every reboot of the remote into a prompt |

### 10.10 Work, in pull requests

| Step | What | Estimate (agent work) |
|---|---|---|
| 1 | The release records the pinned Node (version and SHA-256 per platform, from a signature-checked `SHASUMS256.txt`) as `remote-runtime.json` in the host bundle; CI runs the host's tests on that Node too. **Done** | 0.5–1 day |
| 2 | `serve --detach` and `serve --stop` (setsid, WMI, WSL through WMI; the additive stop RPC), the `install` field in the connection line, the managed-launcher rules in `serve.mjs`; the link starts a host it finds not running. **Done**: `host.stop`, `MachineStatus` `starting` and `MachineInfo.hostStarted` (additive), the link-bound fallback when WMI is blocked ([agent-host.md](../agent-host.md) §4.7, §4.8) | 1.5–2 days |
| 3 | The installer: preflight and Node per shell, the `.mjs` step, registry metadata and signatures on the hub, the layout and pointer files, the lookup order in `tunnel.ts`; tested with a fake ssh and a local registry fixture, then by hand on the laptop's Windows and WSL | 2–3 days |
| 4 | Update, rollback and uninstall as `machines.*` calls (additive) with progress in `machine_status`; the version prompt's "Update <machine>" naming what stops; Settings → Machines rows | 2–3 days |
| 5 | (Owner decision 2) Host-only packages in the release | 1 day |
| 6 | (Owner decisions 4, 5) Boot autostart; the remote keeper after #350 | 1 day; 3–5 days |

Steps 1 to 4 are phase 3 as §4 needs it, about 6–9 days; each lands behind phase 1's manual path, which keeps working.
