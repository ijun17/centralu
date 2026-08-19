# Folder structure and package split

A pnpm workspaces monorepo. Package boundary = dependency rule boundary = the unit lint enforces.

## 1. The whole structure

```
centralu/
├─ README.md                    # introduction (for users). The Korean edition is README.ko.md
├─ CONTRIBUTING.md              # how to run development, verification, CLA
├─ docs/                        # the spec (product-spec.md) + design documents (this folder)
│  └─ README.md                 # documentation map
├─ package.json                 # workspace root (script hub)
├─ pnpm-workspace.yaml
│
├─ apps/
│  ├─ web/                      # web entry point for development (Vite)
│  │  ├─ index.html
│  │  └─ src/main.tsx           # injects createWebPlatform() — the only place ① that knows an implementation
│  └─ desktop/                  # Tauri entry point (created after M1)
│     ├─ src/main.tsx           # injects createTauriPlatform() — the only place ②
│     └─ src-tauri/             # Rust: supervisor, git2, rusqlite, OS integration
│        ├─ Cargo.toml
│        └─ src/
│
├─ packages/
│  ├─ protocol/                 # the shared language: event and command schemas (zod). 0 dependencies
│  │  └─ src/
│  │     ├─ events.ts           # the NormalizedEvent family
│  │     ├─ commands.ts         # request/response RPC
│  │     ├─ entities.ts         # shared types such as SessionState, Capability
│  │     └─ version.ts
│  │
│  ├─ core/                     # pure domain. No IO, no React
│  │  └─ src/
│  │     ├─ session/            # state machine (transition table), session reducer
│  │     ├─ inbox/              # ordering and urgency rules (all pure functions)
│  │     ├─ unread/             # read rules (FR-16)
│  │     ├─ approval/           # always-allow rule matching, in-place approval policy
│  │     └─ usage/              # weekly aggregation (the calculation, not the parser)
│  │
│  ├─ platform/                 # the firewall for C1/C2
│  │  └─ src/
│  │     ├─ ports/              # interfaces only. The only subpath ui may import
│  │     │  ├─ agent.ts  git.ts  fs.ts  store.ts  usage.ts  system.ts
│  │     │  └─ platform.ts      # the Platform facade + PlatformCapabilities
│  │     ├─ web/                # browser implementation (WS/HTTP → agent-host)
│  │     ├─ tauri/              # Tauri implementation (invoke/event) — after M1
│  │     └─ mock/               # in-memory implementation for tests and stories
│  │
│  ├─ ui/                       # the whole React app (except the entry point)
│  │  └─ src/
│  │     ├─ app/                # root component, routing (view switching), PlatformProvider
│  │     ├─ features/           # vertical split by feature (§2 below)
│  │     │  ├─ inbox/  session/  approval/  sidebar/
│  │     │  ├─ git/  file-tree/  code-viewer/
│  │     │  └─ usage/  settings/  onboarding/
│  │     ├─ components/         # feature-agnostic shared (Button, Kbd, VirtualList…)
│  │     ├─ store/              # zustand store + selectors (reducers are imported from core)
│  │     └─ styles/
│  │
│  └─ agent-host/               # the Node process (no browser code)
│     └─ src/
│        ├─ main.ts             # CLI entry (--port, --token)
│        ├─ transport/          # WS server, session handshake
│        ├─ adapters/           # claude/, codex/ + the common adapter contract
│        ├─ dev-services/       # dev-only: git, fs, store (sqlite), watcher
│        ├─ usage/              # incremental parser for ~/.claude, ~/.codex logs
│        └─ mcp/                # MCP server for the orchestrator (M3)
│
├─ e2e/                         # Playwright (apps/web + platform/mock combination)
└─ tooling/                     # eslint config, dependency-cruiser rules, shared tsconfig
```

## 2. Rules inside ui/features (the vertical split)

Each feature folder is self-contained:

```
features/inbox/
├─ InboxView.tsx        # the screen
├─ components/          # sub-components for this feature only
├─ hooks.ts             # hooks for this feature only (combinations of store selectors)
└─ index.ts             # the public surface (barrel) — other features import only through here
```

- Direct imports between features go through `index.ts` only. Deep-path imports are forbidden (enforced by lint).
- If two features want the same logic, that logic **moves down** into core or components. Horizontal dependencies between features are not increased.
- State attached to the screen goes in the store; only component-local state (text being typed etc.) uses useState.

## 3. "Where the code goes", per extension scenario

| What you want to do | What you touch | What you must not touch |
|---|---|---|
| Add an agent tool (Gemini etc.) | `agent-host/adapters/gemini/` + a capability declaration | ui, core (because events are normalised) |
| Add a new kind of event | `protocol/events.ts` → core reducer → the consuming feature | other features |
| Move git from Node to Rust (C2) | new `platform/tauri/git.ts` + `src-tauri` | ports/git.ts (the interface is unchanged), ui |
| Add a new screen | `ui/features/<new>/` | platform, agent-host |
| Change how OS notifications work | `platform/{web,tauri}/system.ts` | ui (it is behind SystemPort) |
| Change session state rules | `core/session/` (+ transition table tests) | if statements in ui — there should not have been any |

## 4. Why a monorepo (and why this size)

- ui and agent-host have to share protocol **as the same types** — in separate repos version drift starts immediately.
- 5 packages is not too much for solo development: each boundary gets build isolation through tsconfig `references` and becomes the unit for lint rules. Split the same thing into folders under one src/ instead and the boundaries become convention, and convention collapses in front of a deadline.
- A build orchestrator like Turborepo is **not added now** — pnpm scripts are enough at this scale. Add it when the build gets slow (YAGNI).
