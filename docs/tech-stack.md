# Tech stack — library choices and the reasoning

The selection criteria are the product spec §7.1 (lightness) and the architecture's axes of change: **small runtime overhead, sitting in a replaceable position, actively maintained.** No "add it and see" dependencies — adding one requires adding a row to this document.

## 1. Front end (packages/ui, apps/web)

| Area | Choice | Reasoning | Alternatives rejected |
|---|---|---|---|
| Framework | **React 19 + TypeScript** | Settled in spec v0.4. Friendly to agent-driven development | SolidJS/Svelte (closed out in v0.4) |
| Build | **Vite** | The key tool for web dev mode, compatible with the official Tauri template | — |
| State | **zustand** | ~1KB, no boilerplate, subscribable from outside React (essential for event stream → store), selector-based re-render control | Redux Toolkit (heavy, too much ceremony), Jotai (unsuited to applying an event stream) |
| List virtualisation | **@tanstack/react-virtual** | Needed by the conversation stream, file tree and inbox alike (§7.1 60fps) | react-window (weak support for dynamic heights) |
| Markdown | **react-markdown** (remark) | Safe partial parsing mid-stream, plugin ecosystem | Parsing it ourselves (out of scope) |
| Code highlighting | **Shiki** (lazy-loaded, web worker) | Best accuracy; loading deferred until a code block appears | highlight.js (quality), Prism (maintenance) |
| Code viewer/diff | **CodeMirror 6** (read-only + merge view) | 1/10 the size of Monaco, virtual scrolling for large files built in, diff view officially supported | Monaco (several MB, the whole editor comes along — we only need a viewer) |
| Styling | **Tailwind CSS v4** | 0 runtime, easy to tokenise a dark theme | The CSS-in-JS family (runtime cost) |
| Headless UI | **Radix UI** (dialog, dropdown, tooltip only) | Accessibility and focus management for free, install only the primitives needed | A full component kit (design lock-in) |
| Icons | **lucide-react** | Fully tree-shakeable | — |
| Date/time | **the Intl API directly** + a small helper written here | No library needed at the level of "waiting 3 minutes" | dayjs/date-fns (unnecessary dependency) |
| WS client | **native WebSocket** + a reconnection wrapper written here (~50 lines) | The requirement is simple (reconnect + backoff + token), fewer dependencies | socket.io (protocol overhead) |

## 2. Schema and validation (packages/protocol)

| Area | Choice | Reasoning |
|---|---|---|
| Schema | **zod v4** | Type inference = runtime validation, single source. Validated only at the boundary (WS receipt, invoke response) to control the cost |

## 3. Agent Host (packages/agent-host — Node 22+)

| Area | Choice | Reasoning | Alternatives rejected |
|---|---|---|---|
| Claude integration | **@anthropic-ai/claude-agent-sdk** | Settled in the spec. Streaming, resume, canUseTool | PTY wrapping (rejected in the spec) |
| Codex integration | **a JSON-RPC client written here** (child_process + stdio) | `codex app-server` is thin JSON-RPC — easier to handle version changes (C4) than depending on an SDK | Third-party wrappers (unclear maintenance) |
| WS server | **ws** | The de facto standard, sufficient on its own | Fastify etc. (no HTTP server needed) |
| dev store | **better-sqlite3** | The synchronous API is the simplest and fastest at this scale. Dev-only, replaced by rusqlite in prod | node:sqlite (still experimental) |
| dev git | **a git CLI spawn wrapper written here** (parsing `--porcelain=v2`) | A temporary implementation to be replaced by git2 (Rust) in prod — the thinner, the easier to throw away | simple-git (adding a dependency to code we will throw away) |
| File watcher | **chokidar** | Dev-only, combined with debounce | — |
| MCP server | **@modelcontextprotocol/sdk** | The official SDK, for the orchestrator (FR-11) | Writing one (the cost of tracking the spec) |

## 4. The Tauri side (apps/desktop/src-tauri — after M1)

| Area | Choice | Reasoning |
|---|---|---|
| Shell | **Tauri 2.x** | Settled in the spec |
| git | the **git2** crate | Settled in the spec (FR-4), queries without spawning a process |
| Storage | **rusqlite** (bundled) | The prod implementation of StorePort |
| File watcher | the **notify** crate | Debounce at the app level |
| OS integration | tauri-plugin-notification / global-shortcut / dialog / opener | Official plugins first, write as little as possible |

## 5. Development tools

| Area | Choice | Reasoning |
|---|---|---|
| Monorepo | **pnpm workspaces** (alone) | Turbo/Nx unnecessary at this scale — when it gets slow, then |
| Testing | **Vitest** | Shares configuration with Vite; core/protocol/adapter contract tests |
| E2E | **Playwright** | Test web dev mode directly as the target |
| Lint | **ESLint (flat) + eslint-plugin-boundaries** | Enforce the layer rules by machine (architecture §2) — this is why it is ESLint and not Biome |
| Format | **Prettier** | To end the argument |
| Dependency graph verification | **dependency-cruiser** (CI) | A second line of defence on inter-package rules that boundaries cannot catch |

## 6. The forbidden list (to add one, you have to win on reasoning in this document)

- **Anything in the Electron family** — violates the premise of the spec
- **Monaco** — size. We do not put an editor in a viewer
- **moment/dayjs/date-fns** — Intl is enough
- **axios** — fetch is forbidden in the UI, let alone this
- **Redux + its middleware ecosystem** — zustand is enough, size and ceremony cost
- **CSS-in-JS runtimes** (emotion, styled-components) — violates §7.1
- **ORMs** (Prisma, Drizzle) — with 6 tables, a SQL file is enough for migrations
