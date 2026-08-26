# Documentation map

`product-spec.md` decides **what** gets built. Everything else in this folder decides
**how**. Where they disagree on a requirement the spec wins; where they disagree on the
way something is built, the design doc wins.

Design documents are kept in two languages: English is the canonical text (`*.md`),
Korean is a maintained mirror (`*.ko.md`) — same convention as the repository root
README. When a design changes, both files change **in the same PR as the code**.
`plans/` and `spikes/` are records of what happened and are not mirrored
([#27](https://github.com/ijun17/centralu/issues/27)).

Current state: **M2 done, dogfooding** — [what M2 actually produced](plans/m2-result.md),
[what release still needs](plans/beta-release-checklist.md).

## Design

| Document | What is in it | Read first |
|---|---|---|
| [product-spec.md](product-spec.md) | The spec: requirements (FR-1–21), screens, roadmap, risks | — |
| [architecture.md](architecture.md) | Axes of change, layers, dependency rules, design patterns, process topology | product-spec §6 |
| [folder-structure.md](folder-structure.md) | How the monorepo is split, and where code for a given change goes | architecture |
| [tech-stack.md](tech-stack.md) | Library choices with the reasoning, and the list of things not to reach for | architecture |
| [platform-abstraction.md](platform-abstraction.md) | The Platform port — how web development turns into a Tauri app. Implementation matrix and the lint rules that enforce it | architecture |
| [protocol.md](protocol.md) | UI ↔ agent host messages: schemas and versioning rules | architecture |
| [agent-host.md](agent-host.md) | Inside the Node sidecar: AgentAdapter, and how to add a new tool | protocol |
| [state-management.md](state-management.md) | Front-end state: event → store → selector, persistence and restore | architecture, protocol |
| [releasing.md](releasing.md) | How a version reaches users: npm package layout, CI, publish procedure | — |

## Record of what was measured

These are not plans to follow; they are what happened, kept because the reasoning in
them is what later decisions rest on.

| Document | What is in it |
|---|---|
| [spikes/m0-findings.md](spikes/m0-findings.md) | M0: permission override, events, Codex, topology — all four held up |
| [plans/m1-plan.md](plans/m1-plan.md) · [m1-result.md](plans/m1-result.md) | M1 plan and result: gates, measured performance, decisions made mid-implementation |
| [plans/m1.5-plan.md](plans/m1.5-plan.md) · [m1.5-result.md](plans/m1.5-result.md) | Always-on operation and a verification protocol; the 5 defects measurement caught |
| [plans/m2-plan.md](plans/m2-plan.md) · [m2-result.md](plans/m2-result.md) | M2 plan (revised after independent review) and result: the release build passing, 5 more measured defects, how to start dogfooding |
| [plans/beta-release-checklist.md](plans/beta-release-checklist.md) | What blocks a public release. §2 is the signing and quarantine measurement that made npm the distribution channel |

## Writing these

- Change the design, fix the document **in the same PR as the code.** If the document
  and the code disagree, the document is the one that is wrong.
- Every "decision" table carries its reasoning. A decision with no reasoning behind it is
  a decision to revisit.
- Comments and docs record **why**, not what — especially anything learned by measuring,
  which is kept with the number that was measured.
