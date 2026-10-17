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
│  └─ desktop/                  # Tauri entry point
│     ├─ src/main.tsx           # injects createTauriPlatform() — the only place ②
│     ├─ content-verify/        # Rust, no Tauri: verifies and copies signed content (thin shell, #440)
│     └─ src-tauri/             # Rust: supervisor, git2, rusqlite, OS integration
│        ├─ Cargo.toml          # the workspace: this app package, keeper/ and shell/
│        ├─ src/                # the window (Tauri); src/bin/centralu-keeper.rs is the keeper's main;
│        │                      #   src/shell/ installs the shell and starts the keeper through it (macOS)
│        ├─ keeper/             # crate centralu-keeper-core: keeper and host supervisor, no Tauri (#440)
│        │                      #   src/keeper/server/: the control socket (start, host, windows, switch);
│        │                      #   src/keeper/children/: the child service (child, reactor, requests, stop,
│        │                      #   snapshot, buffer); src/keeper/accept.rs: what all three accept loops share
│        └─ shell/              # crate centralu-shell: the macOS shell that holds permissions; verifies
│                               #   content, copies it, starts the keeper, exits. Built once per shell
│                               #   version and pinned in packaging/shell/shell.lock (plans/thin-shell.md).
│                               #   A macOS release carries it in Contents/Resources/shell/ and the signed
│                               #   content in Contents/Resources/content/ (scripts/bundle-stage.mts)
│
├─ packages/
│  ├─ protocol/                 # the shared language: event and command schemas (zod, its only dependency)
│  │  └─ src/
│  │     ├─ events.ts           # the NormalizedEvent family
│  │     ├─ commands.ts         # request/response RPC (RpcMethods), spread from commands/methods/; re-exports commands/
│  │     ├─ commands/           # the shapes its methods carry: sessions (SessionInfo), projects, files; methods/
│  │     │                      #   holds the methods by concept: sessions, orchestrator, projects, terminal, apps,
│  │     │                      #   host, settings
│  │     ├─ entities.ts         # shared types such as SessionState, ApprovalDetail, UpdateStatus: re-exports entities/
│  │     ├─ entities/           # one module per concept: ids, sessions, grid, apps, tools, approvals, usage,
│  │     │                      #   git, errors, updates, preferences
│  │     ├─ envelope.ts         # the WS frames, PROTOCOL_VERSION
│  │     ├─ tolerant.ts         # parseTolerant: how a client reads another build's answer (protocol.md §4)
│  │     ├─ session-state.ts    # the session state machine's rules, run by both core and the host
│  │     ├─ theme.ts  machines.ts  handoff.ts  paths.ts  semver.ts  always-allow.ts  app-*.ts …
│  │     └─ schema/schema.sql   # the store's DDL, in one place (agent-host.md §5)
│  │
│  ├─ core/                     # pure domain. No IO, no React
│  │  └─ src/
│  │     ├─ session/            # session reducer (the transition rules are protocol's session-state.ts)
│  │     ├─ inbox/              # ordering and urgency rules (all pure functions)
│  │     ├─ grid/               # grid panels, spans and layout
│  │     ├─ git/                # the commit graph's lanes
│  │     ├─ notify/             # which events raise an OS notification
│  │     ├─ clock/              # the clock the label ages read
│  │     ├─ unread/             # read rules (FR-16)
│  │     ├─ approval/           # always-allow rule matching, in-place approval policy
│  │     ├─ machines/           # linked machines: away rows, link errors in words, the version prompt
│  │     └─ usage/              # prompt cache arithmetic: hit rate, a window's name (agent-host.md §6.1)
│  │
│  ├─ platform/                 # the firewall for C1/C2
│  │  └─ src/
│  │     ├─ ports/              # interfaces only, one file per concept (#874). The only subpath ui may import
│  │     │  ├─ agents.ts  projects.ts  fs.ts  git.ts  history.ts  preferences.ts  terminal.ts
│  │     │  ├─ apps.ts  lifecycle.ts  machines.ts  system.ts (+ PlatformCapabilities)  common.ts
│  │     │  └─ index.ts         # the Platform facade
│  │     ├─ engine.ts           # facts about the web engine, so ui never asks (frame drag coordinates)
│  │     ├─ web/                # browser implementation (WS → agent-host; rpc-client.ts)
│  │     ├─ tauri/              # desktop implementation: the web one over the keeper's front door, plus the
│  │     │                      #   shell's invoke/event (notifications, the build bar, switching hosts)
│  │     └─ mock/               # in-memory implementation for tests and stories
│  │                            #   index.ts: MockPlatform composes one module per concept (sessions.ts, apps.ts,
│  │                            #   projects.ts, updates.ts…) and keeps every field tests reach; demo.ts seeds a scene
│  │
│  ├─ ui/                       # the whole React app (except the entry point)
│  │  └─ src/
│  │     ├─ app/                # root component, routing (view switching), PlatformProvider
│  │     ├─ features/           # vertical split by feature (§2 below)
│  │     │  ├─ inbox/  session/  approval/  notices/  sidebar/  grid/  palette/
│  │     │  ├─ git/  files/  viewer/  evidence/  project/
│  │     │  ├─ orchestrator/     # the orchestrator's screen and proposals
│  │     │  ├─ app-frame/  pinned-app/  app-share/   # external apps' views and their sharing
│  │     │  ├─ machines/         # machine tags, adding a folder on a linked machine
│  │     │  └─ usage/  settings/  onboarding/
│  │     ├─ components/         # feature-agnostic shared (Button, Kbd, VirtualList…)
│  │     ├─ store/              # zustand store + selectors (reducers are imported from core)
│  │     │                      #   store.ts builds the one store out of these parts (#428):
│  │     │  └─ state.ts (the types: `AppState` is the intersection of the per-concept types in state/)
│  │     │     state/ (one type per concept: connection, projects, sessions, conversation, layout, grid, layers, notifications, machines, preferences, apps, appViews, navigation, orchestrator)
│  │     │     historyPages.ts (history pages merged with the screen)
│  │     │     screens.ts (which screen is on)  appKeys.ts (how an app and its views are named)
│  │     │     sessionList.ts (the sessions it holds: host lists merged in, events held for one not yet listed)
│  │     │     apps.ts (external apps: the list, pinned and in-conversation views, their actions)
│  │     │     events/ (`dispatchEvent` in index.ts, one handler file per event family)
│  │     │     projects.ts (projects, their git summary and commands)  patch.ts (helpers for writing state)
│  │     │     sessions/ (a session's actions: focus, send, answers, process, lifecycle, handoff)
│  │     │     connection.ts (attaching to the host, reconnect recovery, the workspace snapshot)
│  │     │     history.ts (reading a conversation's history pages and a launch card's steps)
│  │     │     updates.ts (Centralu's update and the agent CLIs' versions)  machines.ts (linked machines)
│  │     │     orchestrator.ts (the orchestrator and its proposals)
│  │     │     layout.ts (how the window is arranged)  navigation.ts (which screen, back and forward)
│  │     │     selectors.ts (derived state)  transcript.ts (a conversation's rows)  layers.ts (open layers)
│  │     │     navHistory.ts  panelLayout.ts  foldGroups.ts  reloadBudget.ts  viewReconnect.ts  app-catalog.ts
│  │     └─ styles/
│  │
│  └─ agent-host/               # the Node process (no browser code)
│     └─ src/
│        ├─ main.ts             # CLI entry (--port, --token, --db, --standby)
│        ├─ lifecycle/          # a start's steps, the readiness gate, shutdown and endings
│        ├─ transport/          # WS server, session handshake, the event log
│        ├─ adapters/           # claude/, codex/ + the common adapter contract (contract.ts); each tool's usage
│        │                      #   reader (usage.ts) and the orchestrator's MCP server (claude/orchestrator-mcp.ts,
│        │                      #   codex/orchestrator-bridge.mjs)
│        │                      #   each tool's index.ts is the adapter, session.ts its session, with the session's
│        │                      #   parts beside it (#850): claude/ session-cards, session-servers, permissions, sdk-query,
│        │                      #   refresh-race, tracked-input, schedule-look;
│        │                      #   codex/ server-requests, thread-servers, child-threads, slash-commands,
│        │                      #   launch-config, thread-open, turns, background-resume. codex/normalize.ts maps notifications, with what it reads beside
│        │                      #   it: items, approvals, thread-settings, token-readings, child-tracker,
│        │                      #   known-notifications. claude/normalize.ts maps messages, one family per file:
│        │                      #   cli-messages, model-messages, turn-ending. contract.ts re-exports contract/: orchestrator,
│        │                      #   session-apps, process. Shared by both: tool-result, file-changes, images, plan,
│        │                      #   token-usage, tool-titles, retry-activity, session-kit, subagent-steps,
│        │                      #   history-events (#843)
│        ├─ sessions/           # SessionManager (manager.ts) and the parts moved out of it (#428): child-ownership, delegation-flow (start_agent in start-agent-flow, what it reaches of the manager in delegation-host), ask-project-flow, handoff-flow, handoff-record, external-conversations, session-record, tool-queries, app-sessions, app-messages, session-trash, host-cards, card-rest, delegated-cards, interruptions, sleep, turn-answer, linked-reports, orchestrator-seat, restart-policy, worktree-sessions, transcript-view, orchestrator-proposals, queued-requests, routed-cards, handoff-children, child-reports, interruption-watch, launch-records, merge-checks, project-creation, updates-asked, project-consents, ui-preferences, session-app-wiring, session-tools, handoff-notes, session-start, session-events; the session apps (session-apps, app-access, app-agents, app-builder, app-guide); the orchestrator tools' runner (orchestrator-tools) and the parts moved out of it (#850): tool-definitions, tool-seats, tool-answers, tool-profiles
│        ├─ apps/external/      # external apps (apps.md): runtime.ts is the one door (ExternalApps); the parts moved out of it (#850): runtime-types, app-entry, app-lifecycle, app-calls, change-reflector, app-check, app-folders, error-log, app-start-env (an app's start environment and secrets), app-resources (its resources and home view); and placement, folder-walk, discovery, manifest, desk/broker, capabilities, runs, handover/imports/versions
│        ├─ views/              # app views: the view host, its CSP, the proxy page
│        ├─ links/              # linked machines (#82): links.ts is the door (re-exports); one machine's connection and its operations, the registry of links, the remote client, install and update over ssh
│        ├─ dev-services/       # despite the name, the prod path (agent-host.md §5): git, fs, store (sqlite),
│        │                      #   the watcher, terminals and commands
│        │  └─ store/           # what `Store` (store.ts) is made of; it opens the file, runs migrations and passes each call on
│        │     ├─ migrations/   # the step list, in files by version range; index.ts holds the rule a new step follows
│        │     ├─ migrate-runner.ts  reader-gate.ts   # what `Store` extends: the runner (and `Store.inspect`), the min-reader gate
│        │     ├─ projects.ts  sessions.ts  grid.ts  messages.ts  handoff-markers.ts  trash.ts
│        │     ├─ settings.ts  permissions.ts  app-runs.ts  child-ownership.ts  linked-machines.ts
│        │     └─ search-index.ts  vacuum.ts   # shared by the steps and the tables above; vacuum.ts also runs an owed VACUUM
│        └─ keeper/             # the keeper's child service: agents and ptys spawned there, re-attach (#280)
│
├─ e2e/                         # Playwright (apps/web + platform/mock combination); perf-memory.mts and seed-store.mts
│                               #   measure against a seeded heavy store (fixtures/heavy-store.ts)
│  └─ ux/                       # task cost in keyboard and mouse operations: `pnpm ux` (ux-metrics.md)
├─ .centralu/apps/              # project apps committed with this repository (apps.md §2): project-board
└─ tooling/                     # eslint config, dependency-cruiser rules, shared tsconfig
```

## 2. Rules inside ui/features (the vertical split)

Each feature folder holds its screens and what only they use:

```
features/inbox/
├─ Inbox.tsx            # the screen
└─ inboxKeys.ts         # what only this feature uses (here: its keys), tested beside it
```

- A feature imports another feature's file directly (`../grid/drop.js`). There are no barrel files and no lint rule
  on paths between features; what the lint enforces is the layer rule (ui reaches the outside only through
  `@cc/platform`'s ports, [architecture.md](architecture.md) §2).
- If two features want the same logic, that logic **moves down** into core or components. Horizontal dependencies between features are not increased.
- State attached to the screen goes in the store; only component-local state (text being typed etc.) uses useState.

## 3. "Where the code goes", per extension scenario

| What you want to do | What you touch | What you must not touch |
|---|---|---|
| Add an agent tool (Gemini etc.) | `agent-host/adapters/gemini/` + a capability declaration | ui, core (because events are normalised) |
| Add a new kind of event | `protocol/events.ts` → core reducer → the consuming feature | other features |
| Move git from Node to Rust (C2, on hold: [agent-host.md](agent-host.md) §5) | a git implementation in `platform/tauri/` + `src-tauri` | ports/git.ts (the interface is unchanged), ui |
| Add a new screen | `ui/features/<new>/` | platform, agent-host |
| Change how OS notifications work | the `SystemPort` implementation in `platform/{web,tauri}/index.ts` (when to notify is `core/notify/`) | ui (it is behind SystemPort) |
| Change session state rules | `core/session/` (+ transition table tests) | if statements in ui — there should not have been any |

## 4. Why a monorepo (and why this size)

- ui and agent-host have to share protocol **as the same types** — in separate repos version drift starts immediately.
- 5 packages is not too much for solo development: each boundary gets build isolation through tsconfig `references` and becomes the unit for lint rules. Split the same thing into folders under one src/ instead and the boundaries become convention, and convention collapses in front of a deadline.
- A build orchestrator like Turborepo is **not added now** — pnpm scripts are enough at this scale. Add it when the build gets slow (YAGNI).
