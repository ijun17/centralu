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

- **The AgentPort implementation stays single** — dev and prod use the same WS client. Tauri's role is not communication but **process supervision** (spawn, crash detection, restart). We do not build a stdio relay (double serialisation via Rust).
- Security: an arbitrary port + a handshake with a token generated at startup, bound to loopback only.
- In dev mode, git/fs/store are provided by the `dev-services` module inside agent-host (implemented in Node). At the Tauri migration only these switch to Rust (invoke), and **the ports stay the same** (C2). The order and method of the migration is in [platform-abstraction.md](platform-abstraction.md) §5.
- This structure is what lets M0~M1 be developed in a browser with hot reload and no Rust toolchain, and run E2E with Playwright.

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
