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
| [product-spec.md](product-spec.md) | The spec: requirements (FR-1–22), screens (focus view, grid, project screen), roadmap, risks | — |
| [architecture.md](architecture.md) | Axes of change, layers, dependency rules, design patterns, process topology; the keeper, switching builds and applying an update (§4.1–4.5, including a keeper that cannot move: §4.4) | product-spec §6 |
| [folder-structure.md](folder-structure.md) | How the monorepo is split, and where code for a given change goes | architecture |
| [tech-stack.md](tech-stack.md) | Library choices with the reasoning, and the list of things not to reach for | architecture |
| [platform-abstraction.md](platform-abstraction.md) | The Platform port — how web development turns into a Tauri app. Implementation matrix and the lint rules that enforce it | architecture |
| [protocol.md](protocol.md) | UI ↔ agent host messages: schemas and versioning rules | architecture |
| [agent-host.md](agent-host.md) | Inside the Node sidecar: AgentAdapter, how to add a new tool, and the rule for store migrations | protocol |
| [themes.md](themes.md) | Themes: choosing (mode, a theme per side, accent), the theme file format and its schema, live editing, the urgency-order check, what app views receive | tech-stack |
| [apps.md](apps.md) | Apps (M4): the manifest, where apps live, trust, lifecycle, the one call path, inline and pinned views and what is standard, the build loop, attaching to sessions, the broker | agent-host |
| [state-management.md](state-management.md) | Front-end state: event → store → selector, persistence and restore | architecture, protocol |
| [releasing.md](releasing.md) | How a version reaches users: npm package layout, CI, publish procedure | — |
| [commit-conventions.md](commit-conventions.md) | Conventional Commit format, allowed types, and commit boundaries | — |

## Record of what was measured

These are not plans to follow; they are what happened, kept because the reasoning in
them is what later decisions rest on.

| Document | What is in it |
|---|---|
| [spikes/m0-findings.md](spikes/m0-findings.md) | M0: permission override, events, Codex, topology — all four held up |
| [spikes/2026-10-memory-heavy-store.md](spikes/2026-10-memory-heavy-store.md) | What the window costs in memory against a store shaped like the owner's (#364): WebKit and Chromium, idle, grid, switching, streaming, before and after #393; the optimisation targets |
| [spikes/2026-10-thin-shell-tcc.md](spikes/2026-10-thin-shell-tcc.md) | Where macOS attaches Screen Recording and Accessibility (#440): the responsible process, a nested shell losing Screen Recording, the Dock and menu bar of each layout |
| [plans/m1-plan.md](plans/m1-plan.md) · [m1-result.md](plans/m1-result.md) | M1 plan and result: gates, measured performance, decisions made mid-implementation |
| [plans/m1.5-plan.md](plans/m1.5-plan.md) · [m1.5-result.md](plans/m1.5-result.md) | Always-on operation and a verification protocol; the 5 defects measurement caught |
| [plans/m2-plan.md](plans/m2-plan.md) · [m2-result.md](plans/m2-result.md) | M2 plan (revised after independent review) and result: the release build passing, 5 more measured defects, how to start dogfooding |
| [plans/beta-release-checklist.md](plans/beta-release-checklist.md) | What blocks a public release. §2 is the signing and quarantine measurement that made npm the distribution channel |
| [plans/thin-shell.md](plans/thin-shell.md) | A fixed, standalone shell that holds macOS permissions and starts the keeper from signed content, so updates stop asking for permissions (#440, #220). Decided 2026-10-07 |

## Writing these

- Change the design, fix the document **in the same PR as the code.** If the document
  and the code disagree, the document is the one that is wrong.
- Every "decision" table carries its reasoning. A decision with no reasoning behind it is
  a decision to revisit.
- Comments and docs record **why**, not what — especially anything learned by measuring,
  which is kept with the number that was measured.
