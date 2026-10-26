# Documentation map

`product-spec.md` decides **what** gets built. Everything else in this folder decides
**how**. Where they disagree on a requirement the spec wins; where they disagree on the
way something is built, the design doc wins.

Design documents are kept in two languages: English is the canonical text (`*.md`),
Korean is a maintained mirror (`*.ko.md`) — same convention as the repository root
README. When a design changes, both files change **in the same PR as the code**.
`plans/` and `spikes/` are records of what happened and are not mirrored
([#27](https://github.com/ijun17/centralu/issues/27)). Nor is `generated/`: it is written by a script
from the code, in English only, and a test fails when it is out of date.

Current state: **M2 done, dogfooding** — [what M2 actually produced](plans/m2-result.md),
[what release still needs](plans/beta-release-checklist.md).

## Design

| Document | What is in it | Read first |
|---|---|---|
| [domain-model.md](domain-model.md) | The vocabulary: every concept a newcomer meets (project, session and its roles, approval, app, view, keeper, host, swap, …), how they relate, the session state machine, the process tree, the main flows, and where each is stored and defined | — |
| [generated/schema.md](generated/schema.md) | The store's tables and columns, generated from a real store by `pnpm docs:schema` (English only) | domain-model |
| [generated/method-rights.md](generated/method-rights.md) | What the limited credential may call, method by method (#1405), generated from the host's table by `pnpm docs:rights` (English only) | security-boundaries |
| [product-spec.md](product-spec.md) | The spec: requirements (FR-1–22), screens (focus view, grid, project screen), roadmap, risks | — |
| [architecture.md](architecture.md) | Axes of change, layers, dependency rules, design patterns, process topology; the keeper, switching builds and applying an update (§4.1–4.5, including a keeper that cannot move: §4.4) | product-spec §6 |
| [folder-structure.md](folder-structure.md) | How the monorepo is split, and where code for a given change goes | architecture |
| [tech-stack.md](tech-stack.md) | Library choices with the reasoning, and the list of things not to reach for | architecture |
| [platform-abstraction.md](platform-abstraction.md) | The Platform port — how web development turns into a Tauri app. Implementation matrix and the lint rules that enforce it | architecture |
| [protocol.md](protocol.md) | UI ↔ agent host messages: schemas and versioning rules | architecture |
| [agent-host.md](agent-host.md) | Inside the Node sidecar: AgentAdapter, how to add a new tool, and the rule for store migrations | protocol |
| [themes.md](themes.md) | Themes: choosing (mode, a theme per side, accent), the theme file format and its schema, live editing, the urgency-order check, what app views receive | tech-stack |
| [design-system.md](design-system.md) | The rules every screen is drawn by: colour (brightness is importance, white only for what waits), the corner scale and its guard, lines, type, icons, the top bar's capsules, the conversation, waiting cards, motion, states, and which shared component to use | themes |
| [ux-writing.md](ux-writing.md) | The words on screen (**draft**, to be settled with the owner; English only until then): the rules the app already follows, with its own strings, and the open questions | design-system |
| [apps.md](apps.md) | Apps (M4): the manifest, where apps live, trust, lifecycle, the one call path, inline and pinned views and what is standard, the build loop, attaching to sessions, the broker | agent-host |
| [state-management.md](state-management.md) | Front-end state: event → store → selector, persistence and restore | architecture, protocol |
| [releasing.md](releasing.md) | How a version reaches users: npm package layout, CI, publish procedure | — |
| [commit-conventions.md](commit-conventions.md) | Conventional Commit format, allowed types, and commit boundaries | — |
| [usability.md](usability.md) | How the screen is judged: the goal, the principles and decisions (the discoverable path first, focus, IME), what a pull request that changes the screen shows, the methods in brief, and what is not measured yet | ux-metrics |

## Record of what was measured

These are not plans to follow; they are what happened, kept because the reasoning in
them is what later decisions rest on.

| Document | What is in it |
|---|---|
| [spikes/m0-findings.md](spikes/m0-findings.md) | M0: permission override, events, Codex, topology — all four held up |
| [spikes/2026-10-memory-heavy-store.md](spikes/2026-10-memory-heavy-store.md) | What the window costs in memory against a store shaped like the owner's (#364): WebKit and Chromium, idle, grid, switching, streaming, before and after #393; the optimisation targets |
| [spikes/2026-10-thin-shell-tcc.md](spikes/2026-10-thin-shell-tcc.md) | Where macOS attaches Screen Recording and Accessibility (#440): the responsible process, a nested shell losing Screen Recording, the Dock and menu bar of each layout |
| [spikes/2026-10-linux-keeper.md](spikes/2026-10-linux-keeper.md) | The keeper run for real on Linux (WSL2 Ubuntu 24.04): #350's cause (procps-ng 4.0.4's `kill`), the keeper scripts, handoff and the #387 sweep, what happens when the AppImage's mount goes, and what is left before it can be the default |
| [tool-cost.md](tool-cost.md) | What Centralu's MCP tools cost a session (#513): how to run `pnpm measure:tools` and read it, and the baseline: resident tokens per session kind on Claude and Codex, cache rebuilds per event, tool selection and first-try arguments, result growth; and the orchestrator's rare commands resident, deferred or behind `centralu_run` (#512); and ordinary sessions' instructions to use Centralu's tools first (#564). A record, so not mirrored in Korean |
| [ux-metrics.md](ux-metrics.md) | What core tasks cost in keyboard and mouse operations (#518): the Keystroke-Level Model and Fitts's law with their values and sources, where the M's go, how to write a task and read the numbers, budgets, and the baseline with what it shows. English only |
| [stored-shapes.md](stored-shapes.md) | Every shape another build reads back (#384): settings rows, JSON columns, data-folder files, app manifests, theme files, the lines between processes and the host ↔ UI payloads; for each its owner, its parser (`file:line`) and what an added field, a removed field and a broken value do today, with the rules they are held to and what an older-host-on-a-newer-store e2e would take. A record of the code, so English only |
| [runtime-lessons.md](runtime-lessons.md) | The process runtime's trial-and-error record: every rule learned about starting, supervising, handing over, updating and stopping the window, shell, keeper, host, agents, terminals and remote `serve` on each OS, the test that guards it, and the work list of rules no test guards yet. A record like plans/ and spikes/, so not mirrored in Korean |
| [plans/m1-plan.md](plans/m1-plan.md) · [m1-result.md](plans/m1-result.md) | M1 plan and result: gates, measured performance, decisions made mid-implementation |
| [plans/m1.5-plan.md](plans/m1.5-plan.md) · [m1.5-result.md](plans/m1.5-result.md) | Always-on operation and a verification protocol; the 5 defects measurement caught |
| [plans/m2-plan.md](plans/m2-plan.md) · [m2-result.md](plans/m2-result.md) | M2 plan (revised after independent review) and result: the release build passing, 5 more measured defects, how to start dogfooding |
| [plans/beta-release-checklist.md](plans/beta-release-checklist.md) | What blocks a public release. §2 is the signing and quarantine measurement that made npm the distribution channel |
| [plans/remote-hub.md](plans/remote-hub.md) | Remote mode as linked hosts (#82): the shape, routing, versions, what phase 1 built; phase 3 (installing, starting, updating and removing a remote over ssh) and probe 4 (where the hub's ssh lives across a hub swap) in §10, measured on Windows and WSL with the scripts in [spikes/2026-10-remote-install/](spikes/2026-10-remote-install/) |
| [plans/remote-keeper.md](plans/remote-keeper.md) | A keeper on linked machines so an update keeps what runs there instead of waiting for idle (#1614, decided 2026-10-26): what survives under each option (a headless keeper, a rolling handover, a Node holder on Windows), what was measured on a linked Windows PC (pseudoconsoles and piped agents across a host's end and an ssh session's), the keeper's own update apart from the host's, updates at once that resume the turns they end where nothing can be kept, Windows specifics, the release change, compatibility, and the steps |
| [plans/root-apps.md](plans/root-apps.md) | A project whose folder has `centralu.app.json` is an app (#1141, decided 2026-10-18): the root app's key, what is kept when the manifest goes, moving user-folder apps into projects, which sessions get its tools |
| [plans/mailbox.md](plans/mailbox.md) | One durable mailbox in the host for sessions, apps and the person, where a thread is a task (#1347, proposed 2026-10-20): the model and store, delivery and waking per tool and state (§7), one turn one thread (§6), the security boundaries (§9), what reports, app notices, the queue's watch, #1324's watches and the task ledger become (§8), the Inbox and task board (§10), linked machines as one mailbox per host with store-and-forward (§11), and the slices (§12) |
| [plans/acp-adapter.md](plans/acp-adapter.md) | A generic Agent Client Protocol adapter with Cursor CLI as its first tool (#59, #1476, proposed 2026-10-26): the frames measured from Cursor 2026.10.22 and OpenCode 1.19.4, one process per session, why `authenticate` is never called, load over resume, the update table, approvals answered once with the rule kept here, input queued by the host, context share and compaction, Centralu's tools through the stdio bridge, the capability list, tests replayed from recordings (#1498), no SDK at runtime, the pull requests and the open questions |
| [plans/antigravity-adapter.md](plans/antigravity-adapter.md) | Superseded (#59): the `agy -p` adapter design, kept as a record of what `agy` 1.4.7 was measured to do; Antigravity runs on Google's ACP agent through the ACP adapter instead |
| [plans/antigravity-acp.md](plans/antigravity-acp.md) | Antigravity through Google's ACP agent on the ACP adapter (#59, proposed 2026-10-27, replacing the `agy -p` design): the owner's decisions, what the macOS spike of agent 1.4.3 found and what each finding asks of the adapter, the pinned install (sha256, atomic, progress, cancel, every OS), one `GEMINI_HOME` of Centralu's, the token in the agent's own store (the macOS Keychain where usable, otherwise a file the agent can read), the sign-in over ACP `authenticate` with a `BROWSER` helper, field names, the edit's two ids, questions as question cards, every tool's setup in one shape, what needs the live check, the tests |
| [plans/thin-shell.md](plans/thin-shell.md) | A fixed, standalone shell that holds macOS permissions and starts the keeper from signed content, so updates stop asking for permissions (#440, #220). Decided 2026-10-07 |
| [plans/os-layer.md](plans/os-layer.md) | The OS layer (#1599, proposed 2026-10-26): where the Windows unit tests' time goes, measured per file; what the layer is and which OS semantics it owns; the lint rule and its shrinking allowlist; how the Windows job's tests are picked from the same rule; the order in which the host's areas move behind it; the open questions |
| [plans/session-core.md](plans/session-core.md) | The shared session core (#1654, proposed 2026-10-27): the Claude, Codex and ACP adapters measured side by side; the concepts computed more than once and which copy is right; what the core owns and what stays per tool; the seam; processes through `Os` (OS layer step 3c); recorded frames testing the core once and each tool apart; the pull requests; Antigravity on it; the open questions |
| [plans/runtime-unification.md](plans/runtime-unification.md) | The process runtime redesigned in steps (owner, 2026-10-08): one topology (launcher → keeper → host) on macOS, Linux, Windows and remotes, one OS layer, one start plan, content everywhere; the ordered steps, how they interleave with remote phases 3–4 and the Windows keeper (#14), and the definition of done. Gated by [runtime-lessons.md](runtime-lessons.md) |

## Writing these

- Change the design, fix the document **in the same PR as the code.** If the document
  and the code disagree, the document is the one that is wrong.
- Every "decision" table carries its reasoning. A decision with no reasoning behind it is
  a decision to revisit.
- Comments and docs record **why**, not what — especially anything learned by measuring,
  which is kept with the number that was measured.
