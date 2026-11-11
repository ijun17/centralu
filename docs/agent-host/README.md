# Agent Host — the Node sidecar design

A standalone Node process. In dev the developer starts it directly (`pnpm host`); in the packaged app the keeper (`centralu-keeper`, [lifecycle/keeper.md](lifecycle/keeper.md)) spawns and watches it, and in `pnpm app:dev` the Tauri app does. **It has to behave the same whether or not a UI is there** — the UI can be closed and reopened many times (reconnecting) and the host keeps its sessions.

## The files

| File | What it holds |
|---|---|
| [host-process.md](host-process.md) | The host's internal structure; stdout carries the handshake only; how processes start on Windows, and Claude's and Codex's processes |
| [tool-profiles.md](tool-profiles.md) | Who gets Centralu's own tools: the profiles, their size, the Assistant's rare commands, Centralu's features first |
| [delegation/](delegation/README.md) | `ask_project`, `start_agent` and `agent_session`: asking another project, starting agents, their workspaces, reports and deletion |
| [assistant/](assistant/README.md) | The Assistant's own commands: handoff, sessions outside a project, making a project, what the window does |
| [context-compaction.md](context-compaction.md) | When agents compact: one context share, compacting at a break, `compact_self`, telling a growing session |
| [adapters/](adapters/README.md) | The AgentAdapter contract, Claude's query options, adding a tool, the vendor drift checks |
| [lifecycle/](lifecycle/README.md) | Session lifecycle and reconnection: how the host starts, the keeper, the front door, updates, a new agent CLI, turn endings and mail |
| [remote/](remote/README.md) | Remote mode: `centralu serve`, the hub's links, installing and updating a machine, the link's states |
| [store-migrations.md](store-migrations.md) | The store (dev-services), migration steps (expand, then contract), the stored shapes another build reads |
| [usage.md](usage.md) | Usage and limits, and usage over time |
| [prompt-cache.md](prompt-cache.md) | The prompt cache: what is counted, and why a rebuild happened |
| [importing-sessions.md](importing-sessions.md) | Importing previous sessions: official APIs only, older tool versions, cleaning up, the identity of an imported session |
