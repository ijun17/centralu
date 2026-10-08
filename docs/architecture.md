# Architecture

> There is one goal: **when an expected change arrives, make there be one place to fix.**

## 1. Axes of change — the changes this design has to survive

Large changes were **expected** in this project from the start. The architecture was designed against this list, and a new decision that makes any of these axes harder is a wrong decision.

| # | Expected change | When | Isolating device |
|---|---|---|---|
| C1 | Runtime environment: **browser (web development) → Tauri** | after M1 | Platform ports (→ [platform-abstraction.md](platform-abstraction.md)) |
| C2 | Service implementations move: git/store etc. **Node (dev) → Rust (prod)** | at the Tauri migration, gradually per service | Port interfaces fixed, only implementations swapped |
| C3 | New agent tools: Gemini CLI etc. | v2 | AgentAdapter + capability (→ [agent-host.md](agent-host.md)) |
| C4 | Codex protocol version changes | any time | Isolation inside the adapter + anti-corruption layer |
| C5 | Screen structure changes (inbox evolving, the v2 grid etc.) | any time | Pure domain core + derived-state selectors |
| C6 | Protocol evolution (new events) | any time | Schema version rules (→ [protocol.md](protocol.md)) |

## 2. Layers and dependency rules

```
┌────────────────────────────────────────────────────────┐
│  apps  (assembly: web / desktop entry points,          │
│         the only place an implementation is chosen)    │
├────────────────────────────────────────────────────────┤
│  ui        React screens, components, hooks            │
├──────────────┬─────────────────────────────────────────┤
│  core        │  platform (port interfaces + impls)     │
│  pure domain │   ports/ ← what ui sees                 │
│  (no IO)     │   web/ tauri/ mock/ ← only apps know    │
├──────────────┴─────────────────────────────────────────┤
│  protocol   message and event schemas (zod)            │
│             — everyone's shared language               │
└────────────────────────────────────────────────────────┘
   agent-host (separate Node process) ──→ shares protocol only
```

**Dependency rules (a violation is a lint error, not a review comment):**

| Package | May depend on | Absolutely forbidden |
|---|---|---|
| `ui` | core, platform**/ports**, protocol, React | platform/web, platform/tauri, `@tauri-apps/*`, using fetch/WebSocket directly |
| `core` | protocol | React, DOM, all IO (pure TS only) |
| `platform/ports` | protocol | implementation code |
| `platform/web` `platform/tauri` | ports, protocol | ui, core |
| `agent-host` | protocol, external SDKs | ui, core, platform |
| `apps/*` | everything (it does the assembly) | — |

The heart of it: **the only place that knows an implementation is the apps entry point.** Everything else knows only interfaces and schemas.

## 3. The design patterns used — where, and why

Patterns are not decoration, they are defences against the axes of change (C1~C6). Which axis each pattern blocks is stated.

| Pattern | Where it applies | Axis it blocks |
|---|---|---|
| **Ports and adapters (hexagonal)** | `platform/ports` is the UI's only outside world. Implementations are web/tauri | C1, C2 |
| **Facade** | One `Platform` object provides the bundle of ports (`platform.git`, `platform.agents` …) | C1 |
| **Dependency injection** | Platform created at bootstrap → injected through one React Context. No global singletons | C1, testing |
| **Adapter** | `ClaudeAdapter`/`CodexAdapter` convert per-tool differences into `NormalizedEvent` | C3, C4 |
| **Anti-corruption layer** | External SDK types **may not take one step** outside the adapter. Converted immediately into protocol types | C4 |
| **Explicit state machine** | Session state (FR-12) is a pure function defined by a transition table. Inferring state with if statements in the UI is forbidden | C5, correctness |
| **Event-driven (pub-sub)** | The adapter → app direction is a one-way event stream. No polling (product spec §7.1) | C6, performance |
| **CQRS-lite** | Separate the path of commands (calling a port method) from state updates (receiving an event → reducer). Minimise optimistic reflection of commands | C5, C6 |
| **Repository** | Persistence sits behind `StorePort`. Only the implementation knows the SQLite schema | C2 |
| **Derived state (selectors)** | The inbox, counters and ordering are not stored but **computed** from session state. Storing them is the root of synchronisation bugs | C5 |
| **Strategy** | Policy branches — the card collapse policy, judging in-place banner approval (per tool kind) — are data (a settings table) | C5 |

Forbidden anti-patterns: global mutable singletons, IO directly in UI components, business logic inside event handlers (→ move it to core), stored derived state.

## 4. Process topology — minimise the difference between dev and prod

**Decision: communication with the Agent Host is a localhost WebSocket in both dev and prod.**

```
[dev machine: browser]                   [production: Tauri]

Vite dev server                        Tauri app (Rust)
   │                                      │ spawn·watch·restart (supervisor)
Browser (ui)                              │ git2/rusqlite/notify/shortcuts (Tauri invoke)
   │  WebSocket ws://127.0.0.1:PORT    Webview (ui)
   ▼                                      │  WebSocket ws://127.0.0.1:PORT (identical!)
agent-host (node, run standalone)         ▼
   ├─ adapters (claude, codex)         agent-host (node, sidecar)
   ├─ dev-services (git/fs/store/usage)   ├─ adapters (claude, codex)
   └─ mcp server                          ├─ usage parser · mcp server
                                          └─ (dev-services replaced by Rust)
```

- **The AgentPort implementation stays single** — dev and prod use the same WS client. Tauri's role is not communication but **process supervision** (spawn, crash detection, restart) — in the packaged app through the keeper (§4.1). We do not build a stdio relay (double serialisation via Rust).
- Security: an arbitrary port + a handshake with a token generated at startup, bound to loopback only. Browser/WebView clients must also come from the explicit dev/Tauri origin allowlist; native clients without an `Origin` header still need the token, and literal `Origin: null` is rejected.
- In dev mode, git/fs/store are provided by the `dev-services` module inside agent-host (implemented in Node). At the Tauri migration only these switch to Rust (invoke), and **the ports stay the same** (C2). The order and method of the migration is in [platform-abstraction.md](platform-abstraction.md) §5.
- This structure is what lets M0~M1 be developed in a browser with hot reload and no Rust toolchain, and run E2E with Playwright.

### 4.1 The keeper: the host outlives the window (#280, option C step 1)

In the packaged app the Tauri app is no longer the host's parent. The host is held by the **keeper**: its own
executable, `centralu-keeper`, shipped next to the window's (`Contents/MacOS/` on macOS, `usr/bin/` in the AppImage)
and started detached from the app into its own session.

```
Tauri app (window)  ──attach──▶  keeper (centralu-keeper, own session)
   │                 unix socket     │ launch · watch · restart · swap
   │                 <data>/keeper.sock, 0600
   │                                 │
   └── WebSocket ──▶ front door ─────┼─ bytes ─▶ agent-host (node, from <data>/hosts/<build>/)
       ws://127.0.0.1:DOOR           │               │
       (one port and token per       │               │ <data>/children.sock, 0600
        keeper)                      │               ▼   spawn · attach · signal (§4.3)
                                     └─ holds ─▶ claude · codex app-server · terminals · commands
                                                 (each in its own session)
```

| Decision | Why |
|---|---|
| The keeper is its own executable, `centralu-keeper`, linking no Tauri and no webview (#440) | Until 0.1.0-beta.11 it was the window's executable in a mode (`centralu --keeper`), chosen so macOS would attribute privacy permissions to Centralu. Measured since: macOS judges a process by the app that started its tree (the responsible process, [spikes/2026-10-thin-shell-tcc.md](spikes/2026-10-thin-shell-tcc.md)), not by the file it runs, so a keeper the window starts is the window's either way. A separate executable is what lets a later step start the keeper from verified content outside the bundle ([plans/thin-shell.md](plans/thin-shell.md) §5). Its code is the crate `apps/desktop/src-tauri/keeper` (`centralu-keeper-core`, no Tauri dependency), and the binary is a target of the app package, so `tauri build` bundles it next to the window's with no extra step. Measured in a release bundle (macOS arm64, 2026-10-08): `centralu-keeper` is 0.8 MB and links only `libSystem` and `libiconv`; the window's `centralu` is 5.4 MB and links WebKit and AppKit. Tauri signs it ad hoc like the window, and `codesign --verify --deep --strict` on the bundle covers it. |
| The window's executable still answers `--keeper`, by `exec`ing the keeper next to it | Keepers already installed hand over by starting the new build's *window* executable as `centralu --keeper --take-over-fd 3 ...`, and an older window starts its keeper the same way. `exec` keeps the pid (the outgoing keeper waits on that child), the arguments, the environment and every descriptor not marked close-on-exec, so the handoff channel at descriptor 3 and `keeper.log` on stdout and stderr reach `centralu-keeper` unchanged; the channel's close-on-exec flag is cleared once more before the `exec`. With no keeper beside it, the window's executable runs the keeper itself. |
| Not on Windows | The keeper is built on unix sockets, descriptor passing and `flock`. Tauri leaves a binary out of the bundle when its required feature (`keeper-exe`) is not among the build's features, and `tauri.windows.conf.json` names none. |
| A debug window runs the keeper in its own executable | `tauri dev` and `cargo run` build only the binary they run, so a `centralu-keeper` in `target/debug` may be older code than the window, and two binaries of one build are linked in no fixed order, so file times cannot tell. A debug window that opts into the keeper (`CC_USE_KEEPER=1`) starts itself with `--keeper` and `CC_KEEPER_IN_PROCESS=1`, as before #440. |
| The app launches it detached (`setsid`, stdin `/dev/null`) | Quitting, crashing or replacing the app sends it nothing. launchd and `SMAppService` are later options, not step 1. |
| The host is tied to the keeper (`--watch-parent` on the keeper's pipe) | A keeper that dies, however it dies, still takes its host with it: there is never an unowned host. |
| Every host runs from a per-build copy, `<data>/hosts/<commit>/` | A rebuild or update rewrites the bundle; a host running from it read the Codex bridge, `schema.sql` and `app-template/` on demand and could mix two builds (2026-10-03). Once a host is up, the copies it does not run from are removed, except one a launch or a swap is still making or about to start: those are claimed until a host runs from them, and the cleanup reads which copy the host runs from when it runs, not when the ready line set it off (a cleanup once deleted the copy a swap had just made, #368). |
| Background mode is a setting, off by default | Off: the last window detaching stops the keeper and host, as quitting always did. On: they keep running, and a relaunched app re-attaches. The quit question follows it: off, its one button is "Quit completely" (quitting stops everything anyway); on, "Quit" closes the window and "Quit completely" stops the keeper, the host and every agent, terminal and running command. The label read "Quit and stop agents" until #387, which undersold what stops. |
| An unwatched keeper in background mode exits after 30 minutes with no window and no activity | Something has to end a host nobody is watching. Activity (a working or waiting session, a terminal, a command run) is the host's own report on its stdout; the keeper parses nothing else. A running turn or a waiting approval keeps it alive however long that takes. |
| A window of another build attaches to the running host and offers to switch | The keeper knows both builds, its own included. Switching moves the keeper to the window's build (§4.4) and then runs the blue-green swap of §4.2; the window confirms first only when something can be lost. A window started by "Apply now" switches by itself when nothing can be, and only to a newer build (§4.5). |
| Debug builds (`pnpm app:dev`) keep the direct path | The app is the host's parent there, exactly as before. `CC_USE_KEEPER=1` opts a debug build in. Non-unix targets have no keeper yet. Every case, per platform, is in [agent-host.md](agent-host.md) §4.0, decided in one place (`start_plan`). |

The keeper also holds the host's long-lived children (§4.3), so a host restart or swap no longer ends them. The
control socket, its protocol and its trust rule are in [agent-host.md](agent-host.md) §4.1 and
[security-boundaries.md](security-boundaries.md).

### 4.2 The front door and the blue-green swap (#280, option C step 3)

Clients never learn a host's own port. The keeper listens on one loopback port for its whole life, the **front
door**, and relays every connection byte for byte to whichever host is current. The webview, a browser and every
Codex orchestrator bridge connect there.

| Decision | Why |
|---|---|
| A byte relay, not a WebSocket proxy | The keeper parses no protocol (#280): a relay of bytes cannot be broken by a change to the host's frames, and the HTTP door for app views rides it unchanged. |
| The keeper owns the token and hands it to every host (`CC_HOST_TOKEN`) | The host keeps checking `hello` and the browser's `Origin` itself; the token and the port stay the same across restarts and swaps, so a client never has to be told again. Measured hazard it removes: a Codex bridge gets its address and token once, when its thread starts, and a running codex keeps that bridge, so a host on a new port or token silently cut every bridge. |
| While no host is ready, a new connection is held (up to 45 s), not refused | A client that reconnects at once lands on the next host as soon as it is up, instead of failing and backing off. Measured: a client cut by a swap was greeted by the new host 84–86 ms later. |
| A relay whose peer refuses its bytes for 30 s ends (#392) | Writes are blocking. A peer that stopped reading (a stopped bridge, a hung client) held its relay thread and descriptors until the next swap, and blocked every keeper handoff, since a freeze waits for each relay to finish its copy. A live client reads within that; the bridge reconnects on its next call. |
| The Codex bridge is given the front door | Its environment is read once; only an address that outlives the host survives a swap. The bridge fails the calls waiting on a socket that closed and reconnects on the next call. |
| App views are addressed through the front door too, with an HTTP secret derived from the keeper's token | The iframe keeps its address; the next host behind the door must accept it. Open view instances are handed to the next host in a planned ending ([agent-host.md](agent-host.md) §4.2), and the window asks for a view's address again after a resync, reloading it only if the address changed. |

`switch` is a **blue-green swap** (`keeper/swap.rs`):

1. The keeper starts host B from the new build's per-build copy with `--standby`. B loads its bundle, finds its
   tools, reads the store without writing to it, refuses a store past what it can read, reports, and waits. It takes
   no lock, runs no migration and attaches to nothing. Host A keeps serving.
2. No report within 60 s, or B exits: B is stopped and its copy removed. A was never touched.
3. The front door holds new connections; A is told to **drain**: it refuses new RPCs and tool calls, gives the
   running ones up to 10 s, cuts the rest with an error the model can retry, detaches, flushes and closes the store,
   lets go of the #278 lock and exits.
4. B is told to activate: it takes the lock, runs only expand migrations (heavy and breaking steps run after it is
   ready, [agent-host.md](agent-host.md) §5.1), starts, listens and reports ready.
5. The front door points at B and closes what was still relayed to A; clients reconnect to the same address and
   resync on B's new stream epoch. A's copy is removed.

| Decision | Why |
|---|---|
| Drain bound 10 s, then cut with a retryable error | Only calls the host serves itself need to drain: orchestrator tools took at most 0.2 s and app tools at most 5.6 s in a real store. Bash and subagents run inside the agent's process, which outlives the host. Draining every tool was never an option (p99 78 s, max 4.5 h). |
| B checks itself before A drains, and migrates only after | A failed check costs nothing: A is untouched. Expand-only steps during the swap keep the store readable by A's build. |
| If B fails after A drained, A's build is started again | A has exited and released the lock, so it cannot resume; its build is known good and still reads the store, and its copy is kept until the swap succeeds. Retrying B was the alternative, but the build that just failed is the less likely one to start. The window shows the failure and that the previous build serves again; the person can retry. |
| Every phase is pushed to attached windows (`view.swap`) | The window shows progress and a failure's reason, and asks before switching only when something can be lost: a session working or waiting, a terminal or a command. |
| The swap's detach hands agents, terminals and commands over | They are the keeper's children (§4.3), so A lets go of them and B re-attaches in its normal startup: a running turn goes on across the swap. The host reports `keepsAgents: true` only when it has the keeper's child service; one without it still stops its children, and the window says so. |


### 4.3 The keeper holds agents, terminals and commands (#280, option C step 2)

The host no longer spawns its long-lived children itself. Under the keeper, claude, codex app-server, terminals and
project commands (dev servers) are spawned **by the keeper**, over a second user-only socket,
`<data>/children.sock`. A host that crashes, restarts or is swapped out releases its connections, and the children
keep running; the next host lists them and re-attaches mid-turn. App MCP processes stay with the host and restart
with it (owner decision 2).

| Decision | Why |
|---|---|
| Every child runs in its own session (`setsid`) | Outside the keeper's and every host's process group, so a host's exit or group kill cannot reach it. Before, claude and codex shared the host's group. |
| The keeper owns each pty (`openpty`, `setsid`, `TIOCSCTTY`) | node-pty keeps the master in the host, so a host that went away took the screen and, with SIGHUP, the shell. |
| A pty is drained continuously into a 256 KiB ring, replayed to the next host | A pty child cannot finish exiting while its output is unread (measured in #280: bash stuck in `?Es` for over 5 s). The ring is the same 256 KiB a terminal's scrollback keeps. |
| An agent's stdout is buffered losslessly (up to 64 MiB, then the child waits) and handed over in whole lines | It is a protocol; a dropped byte breaks a frame. Claude was measured buffering 60 s with stdout unread. One codex `thread/resume` answer was 23 MB on one line, hence the size. A host that dies loses at most what was already in its socket; the next host starts on a line boundary. |
| No connection closing ever signals a child, closes its stdin or closes its pty | That is what lets a host leave without its agents. The Agent SDK kills its process when its owner exits; that kill is a keeper request, and a leaving host never sends it. |
| Exits are watched with kqueue `NOTE_EXIT \| NOTE_EXITSTATUS` (macOS), pidfd (Linux) | They report a non-child's exit (and, on macOS, its status), which a keeper that took the children over from another keeper (§4.4) needs. |
| One thread owns every descriptor | The child table is plain data plus raw descriptors, so a keeper handoff (§4.4) freezes it between two passes, serialises it and passes the descriptors to the next keeper over `SCM_RIGHTS`. |

**Leaving has two modes.** *Stop* is the old ending: sessions, terminals and commands stop with the host. It is
every ending without a keeper, and under one the keeper asks for it (`stop` on the child socket) when it is stopping
for good: "Quit completely", "Restart completely", the last window closing with background mode off, idle exit. Whatever the host
could not stop, the keeper ends itself afterwards (stdin EOF and SIGHUP, then TERM, then KILL). *Detach* is every
other ending under a keeper: a crash, a restart, a swap's drain, the keeper's pipe closing. Nothing is sent to the
tools: no deny for a waiting approval, no EOF, no signal.

**Re-attach** happens in the next host's startup. Each child carries a tag the host wrote when it asked for it
(which session, terminal or command run); the keeper stores it and parses nothing in it.

| Kind | How the next host takes it over |
|---|---|
| claude | A new `query()` whose `spawnClaudeCodeProcess` returns the kept process. Measured: its re-`initialize` re-delivers a pending approval at once and the rest of a running turn arrives through it. |
| codex app-server | The same stdio. The second `initialize` is rejected ("Already initialized") harmlessly; `thread/resume` re-sends a pending approval under the same request id, and the running turn comes from the resume's turns or, since the resume asks for none (#342), from `thread/turns/list`. |
| terminal, command run | Same id or run id; the keeper's replayed ring becomes the scrollback or log. A run that ended while no host was attached comes back with its exit code. |

A session with a kept process keeps its live state through the startup reset, and the transcript catch-up is skipped
for it (the buffered output would be recorded twice). A call to one of the host's own in-process tools (orchestrator,
app proxy) that was in flight when the old host died is never answered; the adopting adapter fails it out loud and
interrupts the turn, which was measured to release it. The detail is in [agent-host.md](agent-host.md) §4.3.

### 4.4 The keeper hands itself over (#280, option C step 4)

A keeper update must cut nothing: not the host, not a turn in progress, not a terminal or a dev server, not a client's
connection. `exec` would keep the pid and the descriptors on macOS and Linux but has no Windows equivalent, so the
direction is the same on every OS: **start the new keeper, pass it every handle, and let the old one exit**
(`keeper/handoff/`).

```
keeper A (running build)                           keeper B (new build, from its own bundle)
 1  starts B: centralu-keeper --keeper            ──▶  hello
            --take-over-fd 3
 2  freezes: accepts nothing, parks every relay,
    pauses the host's stdout, freezes the child table,
    stops copying and removing host copies
 3  state + buffers + descriptors (SCM_RIGHTS)    ──▶  4  rebuilds everything, no I/O; proves it holds the lock
 6  commit point, on ready: reaps, sends commit   ◀──  5  ready
    and exits without touching anything           ──▶  7  starts all I/O, adopts the host, serves;
                                                          then swaps the host, if the switch asked for it
```

**What is passed:** `keeper.lock` (the same open file description, so the `flock` never has a gap), `keeper.sock`'s
and `children.sock`'s listeners, the front door's listener and its token, the host's stdin and stdout, every child's
pipes or pty master, every connection on the child socket, both sockets of every relayed front-door connection, every
attached window's connection, and as data: every buffer with its absolute offsets, half-read requests, unsent events,
tags, pids, exit statuses, the build records, settings, idle clocks and the last swap.

**What survives and what reconnects.** Nothing reconnects. The host is the same process; it never notices, since its
pipes and its child-socket connections are the same sockets, now held by B. A WebSocket through the front door, an
app view's traffic and a Codex bridge's connection are the same TCP connections, pumped by B. An attached window keeps
its control connection and hears B's next status on it. Connections waiting in a listen queue are accepted by B. The
only thing turned away is a control request other than `status` that arrives in the instant of the freeze: it is
answered "try again", and the app's retry reaches B.

| Decision | Why |
|---|---|
| B is the new build's keeper executable **inside its bundle**, the path the attaching window names (`centralu-keeper` beside its own executable, `keeper::exe`), never a copy | It is the file the person installed, signed with the bundle. A window or keeper from before #440 names or starts the window's executable instead, which turns into the `centralu-keeper` beside it (§4.1), so every pairing of old and new ends in the same B; `scripts/keeper-handoff-integration.mjs --old-keeper` runs that against a real 0.1.0-beta.11 executable. Replacing the bundle later does not disturb B: `tauri build` deletes the old `.app` and writes a new one (`bundle_project`, tauri-bundler 2.10), and `centralu install` does `rmSync` then `ditto`, so the running executable's file is unlinked, not overwritten, and keeps running (the integration script deletes and rewrites keeper A's executable under it, and A goes on serving and hands over). An in-place overwrite is not something to rely on: a probe that overwrote a running keeper's file in place saw it keep answering for the 3 s it watched, its code being resident, but any page not yet loaded would come from the new file. Nothing in the tree overwrites in place. |
| The channel is a `socketpair` end at B's descriptor 3, not a socket file | It has no path, so no other process can connect at all (stronger than `0600`), and there is nothing to clean up. B still checks the peer's uid. |
| A **freezes** rather than drains | A byte A read but did not deliver would be lost with A (the #280 measurement's rule: the outgoing keeper must not read ahead, or must forward what it read). Frozen, A reads nothing more; everything it holds is in the snapshot. A relay is stopped between two copies, the host's reader between two lines, the child table between two passes. |
| The commit point is A receiving `ready` | Before it, any failure (B not starting, B failing to rebuild, B dying, a timeout) rolls A back: it kills B and thaws, and since it closed nothing (the snapshot holds duplicates) and read nothing, it carries on exactly where it stopped. After it, A never resumes. B treats a channel that closes after `ready` without `commit` as A having died: it takes over if A is gone, since it holds the only copy of everything, and exits if A is still there. |
| B rebuilds everything before `ready`, but starts no reader or writer until `commit` | A rolled-back A must be the only reader of every child and socket. |
| A stops copying and removing host copies at the freeze, after any copy or cleanup in progress | B may copy and clean `<data>/hosts/` as soon as it commits, while A is still on its way out; a cleanup A started before could otherwise remove the copy B's swap just made (#368). A rolled-back A carries on and cleans at its host's next ready line. |
| A rollback says how B ended, when B exited | When B exits before `ready`, the channel just ends, and the read error said only "failed to fill whole buffer". A waits up to 2 s for B's exit status and reports that (exit code, or the signal that killed it); B's own explanation, if it gave one, is in the keeper log, which both write to (#368). |
| A reaps at the commit and passes the statuses on | B is not the children's parent. kqueue `NOTE_EXIT \| NOTE_EXITSTATUS` gives a non-child's status (measured in #280), but registering on a child that is already a zombie fails with `ESRCH` (measured 2026-10-04, Darwin 27), so the statuses of children that exited during the freeze come from A. After A exits, launchd (or init) reaps. On Linux a pidfd tells B a non-child has gone; the status is read from `/proc/<pid>/stat` while the zombie lasts and is otherwise unknown (no non-parent status before `PIDFD_GET_INFO`, Linux 6.15). |
| "Switch to this build" moves the keeper first, then the new keeper swaps the host, in one action | Moving the keeper costs nothing, so it needs no question of its own, and a full update ends with keeper, host and app on one build. Keeper first means every exchange across builds is read by the newer side: B reads A's snapshot, B supervises A's host, B drains A's host and starts its own build's host. Swapping the host first would have the old keeper drive a newer host. |
| A failed handoff still lets the host switch run | The host switch is what the person asked for; the old keeper can do it, as in step 3 (it already did in beta.10: `move_keeper` falls through to the host swap on any rolled-back handoff). Keeper↔host traffic across builds is lines and child tags the keeper does not interpret, so an older keeper supervising a newer host is the step-3 case, not a new one. |
| Once the host runs the window's build, a keeper that stayed behind is a note, not a failure (#387) | The fix for a handoff that fails lives in the **sending** keeper, and in an update the sender is the old, running build, which the update cannot change: beta.10's keeper fails on macOS with "Message too long" (the row below) on every try once its state is large. Offering "Switch to this build" again only repeated the failure, and the second try read "Could not switch builds" although the window already ran against its own build's host. So when the host is on the window's build, the keeper is not, and the last swap to this build says why the keeper stayed (`keeperStaysBehind`, `switch-plan.ts`), the bar says "Running this build. The background keeper moves to it the next time it restarts." and offers **Restart completely**, never the switch, and a window does not switch by itself again either. "Could not switch builds" stays for a swap whose host did not reach the build. |
| "Restart completely" stops the keeper and the window starts one of its own build | It is the keeper's `stop`, the one "Quit completely" uses, so it stops what that stops (the host, every agent process, terminal and running command, said in its confirmation), but the window stays: its attach loop sees the keeper exit and launches a keeper from its own executable with its own host, then reattaches. Conversations resume through the store. The alternative, waiting for the keeper's next idle exit or quit, leaves the fixed keeper unused for days in background mode. |
| A descriptor batch that finds no room waits for it, up to 30 s | On macOS a `sendmsg` carrying descriptors on a stream socket fails at once with `EMSGSIZE` instead of blocking when the 8 KiB send buffer (`net.local.stream.sendspace`) has less room than the batch; Linux blocks. Whether it happens depends on the exact number of bytes before each batch, so a large enough state hit it in the field (4 agents, 2 terminals, 7 app views, relayed connections; 2026-10-05) while small test states never did. A batch carries one byte, so a failed attempt sent nothing and the retry cannot duplicate or split it. The bound only matters for an incoming keeper that is alive but not reading (one that died fails the send at once); everything is frozen meanwhile, so rolling back beats waiting forever. `wire.rs` sweeps the bytes before the descriptors across three buffers' worth. |
| The snapshot format is versioned and only grows | The outgoing keeper is the older build in an update, so the newer keeper reads the older format. A keeper from before step 4 cannot hand itself over: the first update to a step-4 build swaps only the host. |

Measured with `scripts/keeper-handoff-integration.mjs` (macOS, debug build, a claude turn and a codex turn in their
tool calls, a terminal printing every 50 ms, a dev server printing every 100 ms): the handoff took 0.5–0.8 s beyond the
test's 1.5 s hold, the same host and child pids carried on, the counters were continuous, and every tool call was
recorded once. A handoff killed before the commit left A serving everything.

Unverified: which identity macOS holds responsible for a keeper started by a keeper (B inherits A's responsible
process, the app that launched A); any of this on Linux end to end (the unit tests ran in Docker); Windows, which has
no keeper (`DuplicateHandle` would be its way to pass handles).

### 4.5 Applying an update: one click, or by itself when idle (#352)

§4.1–4.4 made an update cut nothing, but applying one took three steps: install, quit and reopen the window, press
"Switch to this build". "Apply now" does all of it from the update line:

```
window (old build)                  keeper (old)                        window (new build)
 1 host installed the update:
   npm i -g centralu@<v>, centralu install (the bundle is replaced on disk)
 2 relaunch_info: the bundle on disk holds another build → "Apply now"
 3 relaunching  ─────────────────▶  holds for 60 s with no window,
                                    whatever background mode says
 4 request_restart: the old window detaches and exits; Tauri runs the same executable path again
                                                                       5 attaches ◀── relaunched: true
                                                                       6 nothing can be lost → switch
                                    7 keeper handoff (§4.4), then the host swap (§4.2)
```

| Decision | Why |
|---|---|
| The relaunch is Tauri's `request_restart` of the same executable path | `centralu install` replaces the bundle (`rmSync`, then `ditto`), so the path the running process was started from now names the new build's executable; `tauri::process::restart` (2.11.5) reads the executable's name from the bundle's new `Info.plist` and runs it. `request_restart` rather than `restart`, because a command runs on the main thread, where `restart` skips the exit events and with them the detach. |
| "Apply now" is offered only when the build on disk differs from the window's (`relaunch_info`) | Under `pnpm app:open` the window runs the build output, which the update does not touch, and a relaunch would start the same build: the line keeps saying "restart", with the reason in its tooltip. `pnpm app:dev` and the other direct-mode builds have no keeper, so a relaunch would stop every agent; they keep "restart" too. |
| The app announces the relaunch to the keeper (`relaunching`) instead of relying on background mode | With background mode off (the default) the old window closing was "the last window left" and stopped everything, the update's whole point lost to a setting about quitting. The grace is 60 s (at most 300 s): the relaunch takes seconds, and a keeper with background mode off should not outlive a relaunch that failed by much. If no window attaches in time, the idle rule applies as if nothing had been announced. Peer-uid checked like every op. |
| A keeper too old to know `relaunching` is acceptable only with background mode on | With it on, a window closing never stopped anything; with it off, relaunching would cut every turn, so the app refuses and says why. |
| The keeper tells the next window it is the relaunched one (`relaunched` in the attach answer) | The window needs to know it came from "Apply now" to switch without a click; the keeper is the one party that saw both windows. The next attach spends the grace, so a window opened by hand later is not mistaken for it. |
| The relaunched window switches by itself only when `switchPlan` says nothing can be lost; otherwise it opens the question at once | Pressing "Apply now" is consent to the relaunch, not to cutting a slow orchestrator call; the person just pressed it, so the question is asked now rather than left on the bar. |
| "Apply updates automatically when idle" (off by default): the host installs as soon as a check finds a newer version; the window relaunches when idle | Installing is safe while agents work (the keeper and every host run from their own copies). Applying waits for the host's one idle rule (`hostBusy`, `agent-host/src/idle.ts`, reported to the keeper and from it to the window): no session working, waiting for an approval or a question, or running background work, no terminal, no command. A session whose turn has finished (`waiting_input`) is idle; it counted as busy until 2026-10-05, which kept every session that had ever answered in the way. Unknown counts as busy. And no keystroke in a text field for 20 s: a relaunch under someone's fingers reads as a crash. A window with the setting on also switches by itself when idle, and waits instead of asking when something can be lost. |
| A window switches by itself only forward: its build must be newer than the host's and, when the keeper is behind, the keeper's (`isNewerBuild`, `platform/src/tauri/switch-plan.ts`) | Before this, "another build" was enough, so opening an older build's window (a backed-up app, an older local build) with the automatic mode on would quietly downgrade the keeper and the host. Newer means a higher app version (semver, prereleases included), and on equal versions a later `builtAt`. What cannot be ordered (no version on either side, equal versions without both build times, a host run from source) is not newer, so nothing happens by itself. Going back stays a button press: the bar says "This window is an older build (…) than the one running (…)" and offers "Switch back to this build". |
| Never from a window that already runs the installed version, and once per window | The relaunched window still sees the old host's `restart_required`; without the check it would relaunch into itself forever. A failure stays on the line or the bar, never retried in a loop. |

Not exercised: a real update in the packaged app; which identity macOS holds responsible for a window relaunched by a
window (Tauri spawns the executable directly, not through LaunchServices); an open terminal counts as busy even when its
shell sits at a prompt, so the automatic mode waits for every terminal to close.

## 5. Data flow (summary — detail in [state-management.md](state-management.md))

```
user input ──→ port method (command)
                    │
agent-host / tauri ─┴─→ NormalizedEvent stream
                            │ (protocol zod validation)
                    core reducer (pure function)
                            │
                    zustand store (session and project state)
                            │
                    selectors (inbox, counters, unread — all derived)
                            │
                    React views (only the focus view fully renders)
```

## 6. Test strategy (different per layer)

| Target | Method | Why |
|---|---|---|
| core (state machine, inbox ordering, read rules) | Vitest unit tests, coverage first priority | Pure functions, so they are cheap, and this is the product's brain |
| protocol | Schema golden tests (sample messages per version, frozen) | Prevents C6 regressions |
| adapters | Contract tests: replay recorded SDK/protocol responses → verify NormalizedEvent | C4. Possible in CI without a real CLI |
| ui | Playwright on the core flows only (web dev mode + mock platform) | The bonus of developing in a browser |
| dependency rules | eslint-plugin-boundaries + dependency-cruiser in CI | Enforce §2 by machine, not by document |
| keeper (§4.1–4.4) | The real binary and host, driven by `scripts/keeper-*integration.mjs`; in CI on macOS without models ([agent-host.md](agent-host.md) §4.1) | Startup order, adoption and handoff only fail with real processes: #329's crash on every restart that held a terminal passed every unit and e2e test (#348) |

## 7. The connection to M0

The M0 spike (product spec §8) is **one vertical slice** through this structure: `agent-host` (1 ClaudeAdapter, WS transport) + `protocol` (a minimal event schema) + a single-page UI connecting from the browser. It confirms that §4's topology and the permission override premise actually hold, and then the rest is filled in.


## Appendix. The three-lane layout (M2.5 rearrangement)

The tabs (conversation/files/git/viewer) were stripped out and replaced by three lanes.

```
┌──────┬────────────────────────┬─────────┐
│ obs. │ operate                │ evidence│
│ 240  │ variable               │ 340     │
│ sess.│ conversation           │ changed │
│ list │                        │ filetree│
└──────┴────────────────────────┴─────────┘
              ↑ clicking a file overlays these two
```

### Why not tabs

Tabs are a device for grouping **things that substitute for one another**. But git status is not a
screen that replaces the conversation, it is the **evidence** for what the conversation claims.
When an agent says "I changed three files", this is where you check that, so it has to sit alongside.
Grouping non-substitutes under tabs is what produced dogfooding's "where do I look at git, files, the viewer?"

### Inside the right-hand panel: two tabs, git / files

```
┌─ alpha   main        › ─┐   ← press the branch for the switch screen
│ [git] files            │
├────────────────────────┤
│ changed 3        wide  │
│ M src/a.ts             │
│ A src/b.ts             │   ← press for a diff in the overlay
│ ─ push 2               │
│ [commit message ] c  p │
├────────────────────────┤
│ history                │
│ ● fixed inbox ordering │   ← press for the commit in the overlay
│ ○ add session delete ·m│
└────────────────────────┘
```

The git tab puts **two different questions** above and below: above is "what has changed now",
below is "how did we get here". Commit and push have to work in a narrow space too —
if the flow of checking and immediately finishing gets broken, you end up leaving for the terminal.

No graph lines are drawn in the history. Drawing lines at 340px leaves no room for the title,
and what you actually want to know is 'what landed when'. Only merges are marked.

### When collapsed: it does not disappear, a strip remains

Collapse the panel and a 32px vertical strip remains. Closing it without knowing `⌘B`
still has to leave a visible way back, and the strip keeps the changed file count so that even
collapsed you can read "something changed". Gone and collapsed are different things.

### The viewer is a wide overlay

The viewer's main use in this app is effectively 'checking the diff an agent made', and a diff cannot
be read at 340px. But taking the conversation's place means having to find your way back afterwards.
Reading code is a deep but **short** act, so covering and then sweeping it away with esc is the right
mechanism — sweep it away and the conversation is exactly where it was, scroll position included.

The overlay covers **only the centre and the right.** Covering the left as well means missing another
session calling for me while I read code. That is covering the instruments in a control tower.

### Shortcut changes

| Before | After |
|---|---|
| `⌘⇧1~4` switch tab | `⌘B` collapse/expand the evidence panel |
| (none) | `esc` sweep the overlay away |

`⌘1~9` jump project, `⌘I` inbox, `⌘K` palette, `⌘⇧A` next waiting item are unchanged.
