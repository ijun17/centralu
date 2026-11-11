# Remote mode, phase 1: `centralu serve` (#82)

The app can work with a project on another machine (an SSH server, later a laptop). That machine runs its own,
independent host: its own store, its own agent CLI sign-ins, its own files and terminals (#82, decision 1). In phase 1
the person installs and starts that host by hand; the app reaches it through an SSH local forward. Nothing listens on
a public interface on either end: the remote host binds 127.0.0.1, and so does the forward on the person's computer.
The app installing the host over SSH is phase 3, after its lifecycle contract is written (#82, decision 4).

**On the remote machine:**

1. Install Node 22.14 or later, then `npm i -g centralu`. On Linux the platform package carries the bundled host
   unpacked beside the AppImage (`host/`, [releasing.md](../../releasing.md)), so running it needs no display, no FUSE and
   no desktop libraries.
2. Install Claude Code and/or Codex there and sign in (`claude`, then `/login`; `codex login`). The host uses that
   machine's sign-ins, never the client's.
3. Run `centralu serve`. It stays in the foreground and logs to stderr (and to `~/.centralu/host.log`, as always).
   The line to look for is `[centralu serve] listening on 127.0.0.1:17175 …`.
4. Keep it running: `centralu serve --detach` (below), which the app also runs over ssh when it finds no host
   there, or whatever you already use: tmux, `nohup`, a `systemd --user` unit (below), which also starts it at boot.
   An update path and uninstall come with the installer in phase 3.

```ini
# ~/.config/systemd/user/centralu.service
[Unit]
Description=Centralu host (centralu serve)

[Service]
# The launcher serve keeps up to date, so the unit does not depend on npm's PATH
ExecStart=%h/.centralu/bin/centralu serve
# SIGTERM to the launcher only; it passes one to the host, which stops its own agents first
KillMode=mixed
TimeoutStopSec=30
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now centralu`, and once,
`loginctl enable-linger $USER`, so the host keeps running after you log out. Run the first `centralu serve` by hand:
that is what writes `~/.centralu/bin/centralu`. `centralu serve --autostart on` (below) writes and enables a unit like
this one for you.

**The commands:**

| Command | What it does |
|---|---|
| `centralu serve` | Starts the host in the foreground on `127.0.0.1:<port>`. Exit code: the host's own (0 after a clean stop) |
| `centralu serve --port <n>` | The same, on that port. The port is recorded, and the next `serve` without a flag uses it |
| `centralu serve --detach [--port <n>]` | Starts `serve` outside this session and returns once its host answers a hello (below). Prints one JSON line. A host already running is reported, not started twice |
| `centralu serve --detach --from <hub>` | The same; `<hub>` is the name of the computer whose link asks (letters, digits, `.`, `_`, `-`), written with the ssh client's address to the host's `host.lock`, so a second Centralu refused on this folder names that link (#1223). A hub always sends it: every `serve` from 0.1.0-beta.45 on takes it (#1143) |
| `centralu serve --stop` | Asks the running host to stop (`host.stop`), waits until it has, and prints one JSON line. A start in progress (#2150: `--detach` and the launcher each keep a record in `<data>/serve-starting/<pid>.json` while they start a host) is waited for first and its host stopped once up, rather than answered with "not running" and left to come up after the stop. A host that has held host.lock for 10 s with its start still named is stopped, answering or not (one hung before it listened, #1903, is ended): one that is up ends its start within a moment; a record of a dead process, or older than 120 s, counts for nothing. The whole stop ends within 45 s (`STOP_BUDGET_MS`, inside the window's 60 s): when the wait has used its share, a start whose launcher serve.pid names is ended, the launcher and its host, and any other is answered `starting: true` with nothing stopped or marked. Not covered: a `--detach` killed after its launcher started and before that launcher wrote its record, a moment of process start-up |
| `centralu serve --connection` | Prints one JSON line and exits (below). Creates `serve.json` if there is none yet. It carries the limited credential and lists the full ones, never their values (#1405) |
| `centralu serve --connection --pair <label>` | The same, with a new full credential for `<label>` (`token`, and its id as `credential`), printed once and kept as its SHA-256 only; it replaces `<label>`'s earlier one. A hub runs it at each link as `hub:<its name>-<key>`, the key being 8 hex characters of the hub's own random id (#1405) |
| `centralu serve --connection --pair-key <label> <public key> [--key-paired]` | A hub's key pairing (#1711, [plans/key-pairing.md](../../plans/key-pairing.md) §4.2): writes a key entry for `<label>` with the hub's Ed25519 public key (one per label; another key gets a new id), then asks the running host to sign for it. When it signs, or when nothing listens and nothing holds the folder and the installed host takes key hellos, the line carries `hostKey` and `keyId` and lists `pairKey` in `takes`, and no credential; with `--key-paired` the label's verifier entry is removed then. Otherwise it pairs by verifier as `--pair` does. A key the host would refuse (a small-order one) is an error, and nothing is written. Not in `--help`: only a hub runs it |
| `centralu serve --revoke <id>` | Withdraws one full credential or key entry; its next hello is refused, and a socket already open with it is closed within a second. Prints one JSON line, `{ v, revoked, id }` (#1405) |
| `centralu serve --rotate-token` | Draws a new key and withdraws every full credential and key entry, keeping the port. A running serve keeps its old key until it restarts: the limited credential `--connection` prints from the new key works once it has, and `--pair-key` reports the key the running host signs with (#1711) |
| `centralu serve --autostart on\|off\|status` | Starts this machine's host at boot, stops doing that, or says whether it does (below). Never starts or stops a host now. Prints one JSON line |
| `centralu serve --help` | The above |

`--connection` answers the one question the client asks over `ssh -T -o BatchMode=yes <target> …`:

```json
{"v":1,"port":17175,"limited":"ccl1:…","others":[],"version":"0.1.0-beta.11","protocolVersion":1,"dataDir":"/home/me/.centralu","hostRunning":true}
```

| Field | Meaning |
|---|---|
| `v` | The shape of this line. A client that does not know the number says which side to update |
| `port` | Where the host listens on the remote's loopback: the port the last `serve` listened on, else 17175 |
| `token`, `credential` | With `--pair` only (#1405): a full credential made for the asker, and its id, which the host proves under (`prove.credential`). An older remote prints `token` always, its one token |
| `limited` | The limited credential (#1405): everyday calls only. Absent from an older remote, and from one whose installed host predates verifiers |
| `hostKey`, `keyId` | With `--pair-key` only, on a key pairing (#1711): the Ed25519 public key the host signs its proof with, and the id of the hub's key entry, which the hub names in `prove.key`. Never beside `token` |
| `others` | The full credentials the folder holds besides the one just paired, as `{ id, label, created }` (#1405), and its key entries besides the one just paired, with their `publicKey` (#1711). Absent from an older remote |
| `version`, `protocolVersion` | The running host's when `hostRunning`, read from its `hello_ok`; otherwise the installed package's (`host/bundle-info.json`). They differ after an `npm i -g` the host was not restarted for |
| `dataDir` | The data folder the host owns |
| `hostRunning` | A host holding this token answered a hello on `port` just now. A TCP connect alone does not count |
| `proof` | `true` on every line from 0.1.0-beta.45 on, whose hosts all answer a `prove` (#838). The hub then asks the host to prove it holds the token before sending the hello, so a program another account put on the forward's local port never sees the token. Taken from the installed build, not from what answers on the port. A host still running from before the update refuses the proof: the link says the machine runs an older host than the one installed and asks for a restart there. Absent from an older remote, which gets the hello as before |
| `takes` | Additive (#1223): the options this `serve` takes that an older one refuses, today `["from", "window", "pair"]`, and `pairKey` on a line `--pair-key` made a key pairing on (#1711). A hub reads `pair` from it (#1405); it sends `--from` whatever the list says, since every serve it supports takes it (#1143) |
| `autostart` | Additive: `{ on, how, linger }`. `how` is what this machine starts its host at boot with (`systemd`, a scheduled `task`), null where it offers nothing; `on` whether `--autostart on` wrote that entry; `linger` (systemd) whether the user's manager starts at boot or only at login. Read from `<data>/autostart.json`, the mark `--autostart` keeps, so no link start asks systemd or Task Scheduler |
| `install` | Additive (the line stays `v: 1`): `{ managed, current, previous, node }`. `managed` is whether the managed launcher of an install the app made over ssh ran this command ([plans/remote-hub.md](../../plans/remote-hub.md) §10.1); `current` and `previous` are that install's pointer files as `{ version, node }` (null when absent or not two plain words); `node` is the Node that answered |

stdout carries that line and nothing else; anything to explain goes to stderr. If the command is not found (exit 127),
the SSH shell's PATH lacks npm's global folder (nvm, fnm, volta and `~/.npm-global` set it only in interactive
shells): use `~/.centralu/bin/centralu`, which `serve` and `--connection` keep pointing at this install and this Node
by absolute path. Those paths are versioned under nvm and Homebrew, so after a Node upgrade the launcher fails until
`centralu serve` (or `--connection`) runs once from an interactive shell and rewrites it.
On Windows it is `centralu.cmd`, written in UTF-8; cmd.exe reads a batch file in the console's code page, so the file
switches the console to UTF-8 (`chcp 65001`) before the line with the paths, or a profile folder named in Korean
(code page 949) sent node to a path that was not there (#849, `launcher-cmd.test.ts`). The code page it had is put back
on that same line, ahead of node: cmd.exe has read the whole line by then, and a Ctrl+C that ends the batch job cannot
skip the restore.

| Decision | Why |
|---|---|
| A launcher starts the bundled host on the system Node; no keeper | The same `resources/host` the app runs, so a remote host is not a second build to keep working. The keeper exists to swap builds under a window and to hold agents across restarts; a headless host needs neither yet |
| Bound to 127.0.0.1 only, reached through an SSH local forward | SSH already authenticates the person and encrypts the link. A public port would need TLS and a login of our own, and every scanner on the internet would find it |
| `<data folder>/serve.json` holds the host's key and the full credentials' SHA-256s, never a full credential (#1405); mode 0600 from the first byte, narrowed back if it drifts | A full credential is the key to every RPC on that machine. It is printed once, to whoever paired for it (`--pair`), and the file a process of the user can read gives only the limited credential. The host's ready line, which carries its key, is read by the launcher and never passed on |
| The token reaches the host as the first line on its stdin (#538), not `--token` and not `CC_HOST_TOKEN` | Any user on the machine can read another's command line (`ps`), and every process of the same user can read a process's start environment for as long as it runs, deleted or not (#502). The host's stdin is a pipe to the launcher anyway (`--watch-parent`) |
| The key and port are generated once and kept; a hub's full credential is made at each link | The client keeps its credential in memory and reconnects without an SSH round trip; it pairs again (`--connection --pair`) when a hello is refused, or when five redials of the same forward (about 6 s) reach no host: a detached host that died leaves `ssh -N` up, and only the connection line says to start one again (`LINK_REDIALS`, #1143) |
| Default port 17175 | Below every OS's ephemeral range and below the host's per-app view origins (20000–32767, `views/origin-ports.ts`) |
| A recorded or default port another program holds moves to the next free one above it (up to 19 more, below 20000) and is recorded; `--port` is used as given | One Windows laptop linked twice, its Windows side and a WSL distro, had both hosts on 17175: WSL2 relays the distro's loopback ports to Windows (`wslrelay.exe`), so the second could not start (#482). Inside WSL, the ports Windows listens on count as taken too (`netstat.exe` through interop): a host there on such a port would be unreachable, because the hub's forward ends on Windows' loopback. `--connection` reports the port the host got |
| The host gets its own process group and `--watch-parent` | Ctrl+C reaches the launcher, which passes one SIGINT to the host alone, and the host stops its agents in order. Killing the launcher, even with SIGKILL, closes the host's stdin and takes it down: it is never left running unsupervised (`tooling/launcher-serve.test.ts`) |
| A signal during startup is held until the host can shut down | Before the host attaches its handlers the kernel's default applies and ends it on the spot. Measured: a SIGINT passed on as soon as the ready line was read killed the host every time. Now it shuts down cleanly once started; a second signal while starting exits at once (`lifecycle/endings.ts`, `holdSignals`) |
| A second signal forces the exit only when it comes 1 s or more after the first; SIGHUP shuts down like SIGINT and SIGTERM | A person pressing Ctrl+C again, while starting or while shutting down, gets the host gone at once (exit 1); a shutdown is also bounded at 10 s (`lifecycle/shutdown.ts`). One request often arrives as two: Ctrl+C reaches the launcher, which forwards a SIGINT, and the terminal may deliver its own; a closing terminal sends SIGHUP right after SIGINT. Within `REPEAT_AFTER_MS` (1 s, `lifecycle/endings.ts`) the second is the same request and changes nothing, so it cannot cut the shutdown it asked for short (owner, 2026-10-12, #504). Without a listener SIGHUP's default ended the host with no shutdown at all |
| A second `serve`, or any other host on the same data folder, is refused | The ownership lock (`instance-lock.ts`) is the authority. `serve` first asks the port it recorded, so a serve already up is named with its port; for any other owner the host's lock message is followed by a line naming the pid and, when `host.lock` says, who started it. The host's own message names a serve host's link and what stopping it costs (#1223): on a linked Windows machine the desktop window used to be told to close a window that did not exist |
| Except on Windows, where a `serve` in the person's sign-in takes the folder over from a host in a network logon, once that host has nothing running (#1224) | The host the hub's ssh started before anyone signed in cannot open the user's Credential Manager vault. The sign-in task's `serve` (at sign-in, or from `--detach`) asks it `host.stop { ifIdle: true }` every 30 s: the host checks its own idle rule (no turn, approval, question, background work, terminal or command) and the calls in flight, and stops in the same step, taking no new call from its yes on, so a turn cannot slip in between. Then this serve starts its own host on the same port and token; the hub's link drops and reconnects by its backoff; past its redials (about 6 s) it reads the connection line, and a `serve --detach` it runs then is kept by the folder's lock from making a second host on it (`serve-detach.mjs`). It waits 30 minutes at most, and says `waiting`, then `gave_up`, to the host (`host.handover`), which the hub's row shows. A host that does not say its logon (older) is never moved |
| No `DISPLAY` / `WAYLAND_DISPLAY` in the host's environment | Nothing it starts can open a window or a keyring dialog nobody would see; a tool that would ask falls back to its file store or fails with a message in the log |
| Windows: no own group, no forwarding | `detached` means a new console there; the host shares the launcher's console and gets Ctrl+C itself. Not exercised yet |

**Keeping it running without a session: `--detach` and `--stop`** ([plans/remote-hub.md](../../plans/remote-hub.md) §10.4).
The hub runs `centralu serve --detach` over ssh when it finds no host running ([hub-links.md](hub-links.md)), and a person can run it too.
It starts the same `serve` as a launcher outside the session that asked, then returns once that launcher's host
answers a hello, so the caller can connect at once:

| Where | How it is started | Why (measured, remote-hub.md §10.4) |
|---|---|---|
| Linux, macOS | A new session (`setsid`) with no terminal and no stdio; reparented to init once `--detach` exits | Nothing of the ssh session's process group or terminal reaches it (`tooling/launcher-serve.test.ts` kills the whole group and the host still answers) |
| Windows, someone signed in | The data folder's scheduled task (`Centralu host (<user>)`, the one `--autostart` writes), registered without its trigger when it is not there, and registered again when its action or its principal is not what this serve would write (a launcher that moved, a task another account wrote under the name), keeping a trigger only when the task was this user's; then started with `Start-ScheduledTask` (#1224). `detach.how` is `task` | Its principal is `Interactive`, so it runs in the person's own session with their sign-in's token, also when asked from an ssh session. Measured on a linked Windows 11 PC (2026-10-19): started from the hub's ssh logon it ran in session 1, interactive logon, medium integrity, and saw the user's Credential Manager entries; the ssh logon's own processes ran in session 0, network logon, and saw none (`cmdkey /list`: `* NONE *`) |
| Windows, nobody signed in (no Explorer outside session 0 whose owner has this account's SID; matched by SID, since an ssh logon on a PC in a workgroup says `USERDOMAIN=WORKGROUP` where WMI names the PC, #1223), the task's host not answering in 20 s, or `CENTRALU_SIGNIN_TASK=off` | `Win32_Process.Create` through WMI (`Invoke-CimMethod`), from Windows PowerShell 5.1 by full path | Windows' OpenSSH ends every process of a session with it, `Start-Process` included; a process WMI creates is not in the session. It keeps the caller's network logon: Git there cannot use the credentials saved in Windows, and the host says so (`hello_ok.logon`) |
| WSL (`WSL_DISTRO_NAME` set and interop on) | The same WMI call, from `powershell.exe` reached through the drive WSL mounts, creating `wsl.exe -d <distro> -u <user> --cd <folder> --exec <node> <centralu.mjs> serve …` | WSL stops a distro about 15 s after its last `wsl.exe` client exits; this `wsl.exe` is one for as long as the host runs. On the test laptop a WMI-created `wsl.exe` later hung without running anything (remote-hub.md §10.4); that is reported as `wmi_blocked`, and the hub runs the host link-bound |

A process WMI creates gets the account's default environment, not the session's, so what the launcher needs from the
`--detach` that started it travels in one internal argument (`--detached-child=<base64 JSON>`): the log file, and
`CC_DATA_DIR`, `CENTRALU_HOST_ENTRY` and `CENTRALU_MANAGED` when set, and `CENTRALU_STARTED_FROM` (the `--from` hub and the
ssh client's address the `--detach` saw, for `host.lock`, #1223). Never the token, which stays in `serve.json`.
The launcher writes `<data>/serve.log` (its own lines and the host's stderr until the host is ready; `host.log` has
the rest, so it stops growing; the three earlier starts' are kept as `serve.log.1` to `serve.log.3`, so the log of
the first of the at most three starts a hub makes by itself is still there, #1143) and `<data>/serve.pid`
(`{ pid, hostPid, port }`, removed when it exits). Its first line says how it was started and, on Windows, why not in
the sign-in (`started in the background through WMI: no Windows sign-in of this user was found (none of the 2 Explorers
in desktop sessions is this account's)`, or `the sign-in task failed: <reason>`, or that the task's host did not answer);
the reason travels in the same internal argument. A start through the task leaves one line of its own, written by
`--detach`, since the task's `serve` writes no `serve.log` (#1223); when that host does not answer, the line is removed
before the WMI start, so `serve.log.1` keeps the start before and a WMI start that never ran still shows as no
`serve.log`. A `serve.log` that cannot be moved aside is removed for the same reason.

`--detach` prints the connection line with `hostRunning: true` and `detach: { ok: true, how, already }`, or
`{ "v": 1, "detach": { "ok": false, "how", "reason", "message" } }`. `reason` is `wmi_blocked` when WMI refused, or
created a process that never ran (no `serve.log` within 10 s, or the process gone first); `exited` and `timeout`
(30 s) quote the end of `serve.log`. **A blocked start is said in one sentence naming the likely cause**: Microsoft
Defender's attack surface reduction rule "Block process creations originating from PSExec and WMI commands", off by
default and turned on by some managed machines. The hub then runs the host bound to its link ([hub-links.md](hub-links.md)).

**A Node below the floor is refused before any host starts** (#699). The floor is `engines.node` of the npm package
(22.14.0), read by `bin/node-floor.mjs` and nowhere restated. The bundled better-sqlite3 declares Node-API 10, which
Node has from 22.14.0; under 22.12.0 (measured on Windows and on macOS) the module loads and then crashes on its first
`new Database`, with an access violation (exit 3221225477) or SIGSEGV, before the host writes a line. `centralu serve`
(foreground) and `--detach` therefore print one sentence on stderr that names the Node found, the floor and the two ways
out (update Node, or link the machine from a Centralu window, which installs a Node of its own there), and exit 1; they
download nothing. `--detach` also answers in its JSON line with `reason: "node_too_old"` and the `node` and `floor`
it found, which the hub reads ([hub-links.md](hub-links.md)). `--connection`, `--stop`, `--rotate-token` and `--autostart` start no host and keep
working, so the hub can still read `install.node` from a machine whose Node is too old.

`--stop` asks the running host to stop over its own socket with the token (`host.stop`, [protocol.md](../../protocol.md)
§3), then waits up to 30 s for the port to close and the host's pid (from `host.lock`) to end. Only the host does its
shutdown that way on Windows: killing the WMI-started launcher ended the host 143 ms later with no "shutting down"
line (remote-hub.md §10.4), because the host sits in libuv's kill-on-close job object. Only for a host that does not go (one
from before `host.stop`, a shutdown that hangs): SIGTERM to the launcher on posix, which passes it on, and on Windows
ending the host, said in the answer (`how: "ended"`). It signals only the pids `serve.pid` and `host.lock` name, and
only while the two agree and the host answered with this folder's token. It prints
`{ "v": 1, "stop": { "ok", "wasRunning", "how"?, "message"? } }`. A host refuses `host.stop` unless `serve` started
it (`CC_SERVE=1`): the app's host is stopped by the app.

**The managed launcher** (remote-hub.md §10.1, S8). An install the hub makes over ssh (phase 3's next step) has its own
launcher at `<data>/remote/bin/centralu` (`centralu.cmd`), whose text never changes (`managedLauncherScript` in
`serve.mjs`): it reads `<data>/remote/current` ("<centralu version> <node version>", two plain words or it refuses)
at every start and runs that version's `centralu.mjs` on that version's pinned Node with `CENTRALU_MANAGED=1`. A
`serve` that sees `CENTRALU_MANAGED=1` leaves `<data>/bin/centralu` to an npm install on the same machine, and drops
the variable from the host's environment.

**Starting at boot: `--autostart`** ([plans/remote-hub.md](../../plans/remote-hub.md) §10.4, owner decision 4: offered per
machine, off by default; the hub's switch is [install-and-update.md](install-and-update.md)). `centralu serve --autostart on` writes an entry that starts `serve`
when the machine starts, `off` removes it, `status` asks systemd or Task Scheduler and corrects the mark. Neither starts
nor stops a host now. The entry runs the launcher the hub's lookup would find (the managed launcher, else
`<data>/bin/centralu`) and carries `CC_DATA_DIR` when it is set; one entry per data folder (any but `~/.centralu` gets a
suffix from its path).

| Where | The entry | What it does not do |
|---|---|---|
| Linux with systemd | `~/.config/systemd/user/centralu-serve.service`, as above but `Restart=on-failure` bounded to five starts in five minutes; `daemon-reload`, `enable` (never `--now`: a second serve beside the running one would fail and be restarted), then `loginctl --no-ask-password enable-linger` | Where lingering needs an administrator, it starts at login, not boot; the answer says to run `sudo loginctl enable-linger $USER`. `off` leaves lingering as it is |
| Windows | A scheduled task "Centralu host (<user>)" for this user at their sign-in (`Interactive`, no administrator, no stored password), running `serve` in a hidden Windows PowerShell window, on battery too, with no time limit (Task Scheduler's default ends a task after 72 hours). `off` keeps the task and takes only its trigger: `--detach` starts the host in the person's sign-in through it (#1224). `remove` (uninstall) removes it. The user is in the name because Task Scheduler's root folder is one list for every account, and an administrator's ssh logon sees the others' tasks; an earlier version's "Centralu host" of this user is removed | Starts at sign-in, not before it (with automatic sign-in, that is boot) |
| WSL (interop on) | The same task, "Centralu host (WSL <distro>)", registered through `powershell.exe` on the Windows side; it runs `wsl.exe -d <distro> -u <user> --cd ~ --exec <launcher> serve`, which holds the distro for as long as the host runs | A unit inside the distro would never run: WSL stops a distro with no Windows client |
| macOS, Linux without systemd, WSL without interop | None: one sentence says so | — |

It prints `{ "v": 1, "autostart": { "ok", "on", "how", "linger", "message"? } }`. The task's PowerShell travels to
`powershell.exe` as `-EncodedCommand` on a command line of its own (CreateProcess, 32,767 characters), never through
ssh. None of the entries has been created on a real machine yet (remote-hub.md §10.10, step 6).

**App views of this host, shown on a hub.** The hub's window never loads an address of this host: the hub asks
`apps.viewDocument` for an open instance (its app, its origin method and the app's raw `resources/read` answer) and
serves the view from its own door and its own per-app origin ports ([plans/remote-hub.md](../../plans/remote-hub.md) §11). This host
binds nothing for it, and its HTTP secret stays here. The other end, the host that links to this one, is [hub-links.md](hub-links.md).

A host refuses a client of another protocol with `version_mismatch` and close code 4002. The message names both numbers
and which side is older, so the person knows whether to update the app or the remote ([protocol.md](../../protocol.md) §1).
