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

In the packaged app the Tauri app is no longer the host's parent. The host is held by the **keeper**: the
same Centralu executable started as `centralu --keeper`, detached from the app into its own session.

```
Tauri app (window)  ──attach──▶  keeper (centralu --keeper, own session)
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
| The keeper is the app's own executable in a mode, not a second binary | One thing to sign and ship, and the same signature and bundle identifier, so macOS should attribute privacy permissions to Centralu rather than to a new program (#220). `main()` branches before the Tauri app is built, so keeper mode never opens a window or loads the webview. |
| The app launches it detached (`setsid`, stdin `/dev/null`) | Quitting, crashing or replacing the app sends it nothing. launchd and `SMAppService` are later options, not step 1. |
| The host is tied to the keeper (`--watch-parent` on the keeper's pipe) | A keeper that dies, however it dies, still takes its host with it: there is never an unowned host. |
| Every host runs from a per-build copy, `<data>/hosts/<commit>/` | A rebuild or update rewrites the bundle; a host running from it read the Codex bridge, `schema.sql` and `app-template/` on demand and could mix two builds (2026-10-03). Copies no host uses are removed once a host is up. |
| Background mode is a setting, off by default | Off: the last window detaching stops the keeper and host, as quitting always did. On: they keep running, and a relaunched app re-attaches. "Quit and stop agents" stops them either way. |
| An unwatched keeper in background mode exits after 30 minutes with no window and no activity | Something has to end a host nobody is watching. Activity (a working or waiting session, a terminal, a command run) is the host's own report on its stdout; the keeper parses nothing else. A running turn or a waiting approval keeps it alive however long that takes. |
| A window of another build attaches to the running host and offers to switch | The keeper knows both builds, its own included. Switching moves the keeper to the window's build (§4.4) and then runs the blue-green swap of §4.2; the window confirms first only when something can be lost. |
| Debug builds (`pnpm app:dev`) keep the direct path | The app is the host's parent there, exactly as before. `CC_USE_KEEPER=1` opts a debug build in. Non-unix targets have no keeper yet. |

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
for good: "Quit and stop agents", the last window closing with background mode off, idle exit. Whatever the host
could not stop, the keeper ends itself afterwards (stdin EOF and SIGHUP, then TERM, then KILL). *Detach* is every
other ending under a keeper: a crash, a restart, a swap's drain, the keeper's pipe closing. Nothing is sent to the
tools: no deny for a waiting approval, no EOF, no signal.

**Re-attach** happens in the next host's startup. Each child carries a tag the host wrote when it asked for it
(which session, terminal or command run); the keeper stores it and parses nothing in it.

| Kind | How the next host takes it over |
|---|---|
| claude | A new `query()` whose `spawnClaudeCodeProcess` returns the kept process. Measured: its re-`initialize` re-delivers a pending approval at once and the rest of a running turn arrives through it. |
| codex app-server | The same stdio. The second `initialize` is rejected ("Already initialized") harmlessly; `thread/resume` returns the running turn and re-sends a pending approval under the same request id. |
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
 1  starts B: centralu --keeper --take-over-fd 3  ──▶  hello
 2  freezes: accepts nothing, parks every relay,
    pauses the host's stdout, freezes the child table
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
| B is the new build's executable **inside its bundle**, the path the attaching app reports (`current_exe`), never a copy | The keeper is the app's own signed executable so macOS attributes it to Centralu (#220); a copy outside the bundle would be another program. Replacing the bundle later does not disturb B: `tauri build` deletes the old `.app` and writes a new one (`bundle_project`, tauri-bundler 2.10), and `centralu install` does `rmSync` then `ditto`, so the running executable's file is unlinked, not overwritten, and keeps running (the integration script deletes and rewrites keeper A's executable under it, and A goes on serving and hands over). An in-place overwrite is not something to rely on: a probe that overwrote a running keeper's file in place saw it keep answering for the 3 s it watched, its code being resident, but any page not yet loaded would come from the new file. Nothing in the tree overwrites in place. |
| The channel is a `socketpair` end at B's descriptor 3, not a socket file | It has no path, so no other process can connect at all (stronger than `0600`), and there is nothing to clean up. B still checks the peer's uid. |
| A **freezes** rather than drains | A byte A read but did not deliver would be lost with A (the #280 measurement's rule: the outgoing keeper must not read ahead, or must forward what it read). Frozen, A reads nothing more; everything it holds is in the snapshot. A relay is stopped between two copies, the host's reader between two lines, the child table between two passes. |
| The commit point is A receiving `ready` | Before it, any failure (B not starting, B failing to rebuild, B dying, a timeout) rolls A back: it kills B and thaws, and since it closed nothing (the snapshot holds duplicates) and read nothing, it carries on exactly where it stopped. After it, A never resumes. B treats a channel that closes after `ready` without `commit` as A having died: it takes over if A is gone, since it holds the only copy of everything, and exits if A is still there. |
| B rebuilds everything before `ready`, but starts no reader or writer until `commit` | A rolled-back A must be the only reader of every child and socket. |
| A reaps at the commit and passes the statuses on | B is not the children's parent. kqueue `NOTE_EXIT \| NOTE_EXITSTATUS` gives a non-child's status (measured in #280), but registering on a child that is already a zombie fails with `ESRCH` (measured 2026-10-04, Darwin 27), so the statuses of children that exited during the freeze come from A. After A exits, launchd (or init) reaps. On Linux a pidfd tells B a non-child has gone; the status is read from `/proc/<pid>/stat` while the zombie lasts and is otherwise unknown (no non-parent status before `PIDFD_GET_INFO`, Linux 6.15). |
| "Switch to this build" moves the keeper first, then the new keeper swaps the host, in one action | Moving the keeper costs nothing, so it needs no question of its own, and a full update ends with keeper, host and app on one build. Keeper first means every exchange across builds is read by the newer side: B reads A's snapshot, B supervises A's host, B drains A's host and starts its own build's host. Swapping the host first would have the old keeper drive a newer host. |
| A failed handoff still lets the host switch run | The host switch is what the person asked for; the old keeper can do it, as in step 3. The bar says the keeper stayed on the previous build and why, and keeps offering the switch. |
| The snapshot format is versioned and only grows | The outgoing keeper is the older build in an update, so the newer keeper reads the older format. A keeper from before step 4 cannot hand itself over: the first update to a step-4 build swaps only the host. |

Measured with `scripts/keeper-handoff-integration.mjs` (macOS, debug build, a claude turn and a codex turn in their
tool calls, a terminal printing every 50 ms, a dev server printing every 100 ms): the handoff took 0.5–0.8 s beyond the
test's 1.5 s hold, the same host and child pids carried on, the counters were continuous, and every tool call was
recorded once. A handoff killed before the commit left A serving everything.

Unverified: which identity macOS holds responsible for a keeper started by a keeper (B inherits A's responsible
process, the app that launched A); any of this on Linux end to end (the unit tests ran in Docker); Windows, which has
no keeper (`DuplicateHandle` would be its way to pass handles).

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
