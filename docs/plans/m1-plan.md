# M1 execution plan — "the control loop turning from day one"

- Reference documents: [product-spec.md](../product-spec.md) §8 M1, [architecture.md](../architecture.md), [m0-findings.md](../spikes/m0-findings.md)
- How it runs: phases in sequence. Each task has **completion criteria (including how it is verified)**, and a `[loopable]` mark means machine judgement is possible and it is safe to delegate to a ralph-style loop.
- **Human confirmation happens exactly once, at the end, at G5** (user's decision, 2026-08-15). The intermediate gates (G0/G2/G3) are replaced by automatic verification: G0 and G2 are judged by lint and tests, and the G3 real-session smoke is run by the agent itself (haiku, small amounts). Where an intermediate judgement is needed, pick the default and record it in findings/plan. The risk of finding out late is mitigated by committing per task — if a problem is found at G5, trace back by that commit.
- Outside M1 scope (not done): the Codex adapter, git panel detail, file tree, code viewer, attachments, restore on restart (M1.5), the usage dashboard, the orchestrator, Tauri.

## M0 items to apply (constraints common to all tasks)

1. ClaudeAdapter: do not use `allowedTools` (it shadows canUseTool), do use `includePartialMessages: true`.
2. Auto-approval of safe commands is correct behaviour — the absence of an approval request is not treated as an error.
3. The 6 Codex approval decisions are reflected in the protocol design up front (so that M2 only adds the adapter).
4. The `limit_reached` event includes `usedPercent?` and `windowMins?` fields (Codex provides them).
5. In T3-2, check whether loading user hooks and plugins in SDK sessions can be suppressed, then decide the policy (default direction: suppress).

---

## Phase 0 — monorepo scaffold

**T0-1. pnpm workspace + package skeleton** — exactly as folder-structure.md: `packages/{protocol,core,platform,ui,agent-host}`, `apps/web`, `tooling/`, `e2e/`. tsconfig project references, Vitest, Prettier.
Done when: `pnpm -r build && pnpm -r test` passes (1 placeholder per package).

**T0-2. Boundary enforcement** — eslint flat + eslint-plugin-boundaries + no-restricted-imports/globals (rules forbidding fetch, WebSocket and `@tauri-apps/*`), dependency-cruiser configuration.
Done when: **a fixture containing deliberately violating code is confirmed by a test to produce a lint error** (evidence that the rule actually works). `[loopable]`

**Gate G0** (automatic): commit the scaffold. dependency-cruiser confirms 0 structural rule violations.

## Phase 1 — protocol

**T1-1. Envelope + event schemas** — Rpc/RpcRes/Push(seq), all NormalizedEvent kinds, ApprovalDetail (3 kinds), ProtocolError, SessionState. zod v4, discriminated union + the ignore-unknown rule. Per protocol.md + M0 item 4.
Done when: type inference matches the schema, golden fixture tests pass. `[loopable]`

**T1-2. store schema DDL** — `schema.sql` v1: projects/sessions(archived,last_read_seq)/messages/approval_rules/workspace.
Done when: a test applies the migration with better-sqlite3. `[loopable]`

## Phase 2 — core (the pure domain, the product's brain)

**T2-1. Session state machine** — the FR-12 transition table (idle/working/waiting_approval/waiting_input/limited/error), event→transition mapping, illegal transition handling.
Done when: exhaustive transition tests (every legal transition + representative illegal ones). `[loopable]`

**T2-2. Inbox rules** — urgency ordering (approval→error→awaiting response), ascending by wait start within the same urgency, unread first (FR-15/16).
Done when: property tests on the ordering. `[loopable]`

**T2-3. Read rules** — last_read_seq comparison, a function judging the mark-read conditions (scroll reaches latest ∥ focused for 3s) (FR-16).
Done when: unit tests. `[loopable]`

**T2-4. Approval policy** — judging in-place banner approval (based on ApprovalDetail.kind), always-allow rule matching (patterns + the lookup for the match preview), scope (session/project) (FR-3).
Done when: unit tests (including cases where a pattern is misapplied). `[loopable]`

**T2-5. Reducer** — applyEvent(state, NormalizedEvent) → state update. Pure functions for the derived selectors (inbox, counters, unread, concurrent sessions).
Done when: event sequence replay tests (reusing the recorded spike fixtures). `[loopable]`

**Gate G2** (automatic): core coverage + a test verifying that the transition table corresponds 1:1 with the FR-12 table (transcribing the spec's states and transitions into test cases).

## Phase 3 — agent-host (minimal)

**T3-1. transport** — ws server, token handshake, event-log (assigning seq, ring buffer, afterSeq replay, resync_required), RPC routing.
Done when: a reconnection scenario test (connect → N events → disconnect → reconnect with afterSeq → receive what was missed). `[loopable]`

**T3-2. ClaudeAdapter** — reflecting the M0 constraints. SDK events → NormalizedEvent conversion (deltas, tool_use summaries, approval_request (structured ApprovalDetail), turn_complete, usage, rate_limit→limit_reached, session_title), the canUseTool↔respondApproval bridge, interrupt, confirming and applying the user hook suppression policy.
Done when: contract tests (spike dump fixtures → event snapshots) + **one real session smoke** (haiku, one approval round trip). The smoke is run automatically by the agent.

**T3-3. Session manager + minimal dev-services** — session lifecycle (create, archive, dispose), store (sqlite write-through: session metadata, messages, read position), git status summary (branch and change count only — for the sidebar), project registration validation (directory exists).
Done when: RPC integration tests (with an in-memory adapter mock). `[loopable]`

**Gate G3** (automatic): a real session E2E smoke with a mini CLI client (the spike's d-host approach). The agent runs it and leaves the result log in the commit.

## Phase 4 — platform

**T4-1. Define the ports** — Platform/AgentPort/GitPort/StorePort/SystemPort/capabilities. Ports unused in M1 (fs/usage) are defined only.
Done when: type check passes + importable from ui. `[loopable]`

**T4-2. web implementation + mock implementation** — web: a WS RPC client (reconnect + backoff, ~50 lines written here) + port mapping. mock: a full in-memory implementation + scenario scripts (N sessions, an approval request generator — for Playwright).
Done when: web has integration tests against the host, and mock shares the contract tests (the same test suite run against both implementations). `[loopable]`

## Phase 5 — ui + apps/web (the control loop completed)

Build order = the order of the usage loop. For each task, a Playwright scenario on the mock platform is part of the completion criteria.

**T5-1. Shell** — Vite + Tailwind v4 + PlatformProvider + zustand wiring (dispatchEvent→core reducer), start subscribing to events. Dark/light.
Done when: an integration test showing mock events reaching the store.

**T5-2. Project registration + sidebar** — directory picker (falling back to path entry in web dev), project/session tree, 5 status dots + unread dot, branch and change count (FR-1).
Done when: Playwright — register → shown in the sidebar → status dot updates.

**T5-3. Focus view: conversation** — virtual list (@tanstack/react-virtual), streaming delta append, tool call cards (collapse policy: read-oriented collapsed / changes expanded), input box (multiline), interrupt button (part of FR-3).
Done when: Playwright — mock streaming renders; 60fps checked by eye only (precise measurement in M1.5).

**T5-4. Approval UI** — approval card y/n/a (+⌥a scope), the global banner (branching between in-place approval and "needs review" — using the core judgement), the approval queue auto-advancing (FR-3).
Done when: Playwright — a 3-in-a-row approval scenario (1 banner approval, 1 jump approval, 1 always-allow → confirm the rule was saved).

**T5-5. Inbox + status display** — ⌘I inbox (ordering from core), Enter to jump → handle → automatically next, `d` archive, split global counters, the "go to the next waiting item" shortcut, elapsed wait time (parts of FR-12/15/17/20).
Done when: Playwright — **the control loop scenario**: 5 waiting items (2 approvals + 3 responses) → handle them all with the keyboard alone → "inbox empty".

**T5-6. Read/unread + automatic names + concurrent session warning** — read-marking wiring (core judgement), sidebar weight/dot, listSessions summary→session name, fixed on manual change, the inline warning in the creation dialog (FR-16/18/2).
Done when: 1 Playwright scenario each.

**Gate G5 (final, cannot be judged by machine)**: **a real-world smoke** — register 2 actual projects, run 3 real Claude sessions concurrently (including work that triggers approvals), and the user turns the §1.3 loop themselves. The criterion: "is this better than 3 terminal tabs". The complaints that come out of this become the M1.5 backlog.

## Phase 6 — closing out

**T6-1. Tidy the E2E regression suite** — consolidate the Playwright scenarios into e2e/, CI script (`pnpm verify` = lint+depcruise+test+e2e). `[loopable]`
**T6-2. First idle performance measurement** — CPU sampling with 4 sessions idle; fix only conspicuous violations (polling, excessive re-renders). Precise tuning is M3.
**T6-3. Spike cleanup** — delete `spike/` (keep the findings document), add how to run development to the README.

---

## Execution notes

- The commit unit = the task unit. The test in a task's completion criteria has to be in the commit (no fake completion — placeholder and skipped tests count as incomplete).
- The loop completion condition for a `[loopable]` task is always the same: "`pnpm verify` passes".
- Tasks within a phase can run in parallel except where an ordering dependency is stated (e.g. T2-1~T2-4 are mutually independent).
- Verification needing real SDK calls (the T3-2 smoke, G3) is not put in a loop but run once by the agent (cost control). Only G5 is run by a human.
