# M0 spike results (2026-08-15)

> Conclusion: **every design premise holds. No architecture change needed, M1 can proceed.**
> Verification code: `spike/` (throwaway — to be deleted once M1 implementation starts)

Verification environment: Claude Code 2.1.223 / Agent SDK 0.3.231 / Codex CLI 0.147.0 / Node 26.
Both CLIs were verified with global auto-approve on (Claude: `defaultMode: bypassPermissions`, Codex: `approval_policy = "never"` + `danger-full-access`) — exactly the worst-case condition product spec §2 was worried about.

## A. Permission override — ✅ holds on both

| | Claude (Agent SDK) | Codex (app-server) |
|---|---|---|
| Per-session override | `options.permissionMode: 'default'` + a `canUseTool` callback | `thread/start` params `approvalPolicy: 'untrusted'` |
| Beats global bypass? | **Yes** — Write and Bash(curl) approval requests arrived at the callback | **Yes** — the `item/commandExecution/requestApproval` server request arrived |
| Approval → execution completes | executed after an allow response | executed after a `decision: 'accept'` response, file creation confirmed |

**Warnings (essential when implementing the adapter):**
- Claude: putting a bare tool name in `allowedTools` (`['Bash']`) **shadows** canUseTool and the callback never fires (SDK warning `CAN_USE_TOOL_SHADOWED` observed). The adapter does not use allowedTools.
- Claude: safe commands (`echo` etc.) are auto-approved by the sandbox, so there is no approval request at all — from the app's point of view an advantage (less needless approval noise). "No approval request arrived = a bug" is not true.
- Claude: user hooks and plugins are loaded into SDK sessions too (hook_started observed; the OMC hook and an osascript notification ran). A policy for user hooks in Centralu sessions is needed → an M1 design item (suppress them, or leave them alone).
- Codex: the approval response decisions are `accept | acceptForSession | acceptWithExecpolicyAmendment | applyNetworkPolicyAmendment | decline | cancel`. `acceptForSession` corresponds exactly to FR-3's "always allow (session)".

## B. Event collection — ✅ everything needed came through

| Information needed (FR) | Claude | Codex |
|---|---|---|
| Streaming deltas (FR-3) | `includePartialMessages: true` → `stream_event` | `item/agentMessage/delta` |
| Tool calls (FR-3) | `tool_use` blocks in assistant messages | `item/started`·`completed` (type: commandExecution etc., includes command and cwd) |
| Turn complete (FR-12) | the `result` message | `turn/completed` |
| usage/cost (FR-9) | `result.usage`, `modelUsage` (per-model tokens + `costUSD`) | `thread/tokenUsage/updated` (cumulative per turn) |
| Context (FR-14) | `modelUsage.contextWindow` (200k) + per-turn input tokens | tokenUsage total + the context window from config |
| **Limits (FR-9 limited)** | `rate_limit_event`: status·**resetsAt**·rateLimitType(five_hour) | `account/rateLimits/updated`: **usedPercent 21%·windowDurationMins 10080 (weekly!)·resetsAt** |
| Session title (FR-18) | `listSessions()`/`getSessionInfo()` — the summary field (auto-generated) | the `thread/name/updated` notification + `thread/name/set` |
| resume (FR-10) | `options.resume: sessionId` — confirmed it remembers the earlier conversation | the `thread/resume` method exists (not executed, schema confirmed) |
| Compaction marker (FR-14) | — (not confirmed) | the `thread/compacted` notification |

**Bonus findings:**
- Claude's `listSessions()` returns a **machine-wide** session list (title, last modified, firstPrompt) — usable for displaying externally-run sessions (FR-9's "whole machine" philosophy).
- Codex has `account/usage/read` and `AccountTokenUsageDailyBucket` — **on the Codex side weekly usage may be queryable through the API**. Investigate this path before FR-9's log parsing.
- Codex `turn/diff/updated` — the protocol gives per-turn diffs directly (usable for FR-4's live updating).
- Codex has a rich set of extras: `thread/fork`, `turn/steer`, `review/start` and others.

## C. Codex protocol stability (the C4 risk) — better than expected

- `codex app-server generate-ts` / `generate-json-schema` — **an official type generator is built in**. When building the adapter, generate and commit per-version bindings so protocol changes are detected immediately from the diff.
- Transport: stdio, newline-delimited JSON, lightweight JSON-RPC without a `jsonrpc` field (`{id, method, params}` / `{id, result}`).
- Handshake: `initialize` → the `initialized` notification. Still marked "[experimental]" — keep the snapshot tests (the existing plan).

## D. Topology (dev web development) — ✅ E2E succeeded

Browser → localhost WS (token auth) → mini host → Agent SDK → streaming deltas → rendered on screen, all the way through ("BROWSER_E2E_OK", $0.016). Verified automatically with Playwright — the E2E test strategy was proven along with it.

## E. File checkpoints (the FR-2 recovery path) — feasibility confirmed

Confirmed that per-session copies of file versions are left at `~/.claude/file-history/<sessionId>/<hash>@v<N>`. But the format is **unofficial** — the primary recovery path stays as planned (capture pre-change content from the adapter's tool_call event), with file-history to be reconsidered as a secondary (M2).

## To reflect in the design (for reference during implementation, no document changes)

1. ClaudeAdapter: do not use allowedTools, do use includePartialMessages, decide the policy on loading user hooks.
2. CodexAdapter: map the 6 approval decisions (`acceptForSession` → "always allow, session"), fold the binding generator into CI.
3. FR-9: for Codex investigate `account/usage/read` first → fall back to log parsing (for Claude, log parsing is settled).
4. Room to add `usedPercent` and `windowMins` fields to the protocol's `limit_reached` event (since Codex provides them).
