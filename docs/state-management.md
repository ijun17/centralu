# State management — from event to screen

The principle: **state flows one way, and anything derivable is not stored.**

## 1. The whole flow

```
NormalizedEvent (received over WS, zod validation done)
      │
      ▼
core reducer (pure function — the only place state changes)
  applySessionEvent(sessionState, event) → newSessionState
      │
      ▼
zustand store (slices: projects / sessions / messages / usage / settings)
      │                                    │
      ▼                                    ▼
selectors (all derived)                persistence (write-through → StorePort, debounced)
  inbox list and ordering (FR-15)
  global counters "2 approvals · 3 awaiting" (FR-12)
  unread (FR-16)
  concurrent sessions, file conflicts (FR-2)
      │
      ▼
React components (only the focus view subscribes to messages, the rest get summaries)
```

The command direction is the reverse: component → store action → port method. Actions **do not update optimistically** — a state change must come back as an event and pass through the reducer (CQRS-lite). The only exception is the input box's local state.

## 2. Store design (zustand)

```ts
// A single store, split into slices. Reducers are imported from core — the store only does the wiring
interface AppStore {
  projects: Record<ProjectId, Project>
  sessions: Record<SessionId, SessionMeta>       // summary: state, title, read position etc.
  messages: Record<SessionId, MessageWindow>     // ⚠ only the focused session is fully loaded (§4)
  focus: { sessionId: SessionId | null; tab: Tab }
  // actions
  dispatchEvent(e: NormalizedEvent): void        // → calls the core reducer
  sendMessage(sessionId, input): Promise<void>   // → platform.agents.send
  …
}
```

- **Why zustand**: events arrive outside the React render cycle (in a WS callback). zustand allows `store.setState` from outside React, and lets the subscription unit be sliced by selector to control re-renders. (See tech-stack.md)
- Session state transitions must pass through the transition table in `core/session`. An illegal transition (e.g. an `idle → waiting_approval` that a `state_change` claims) throws in dev mode and is logged and ignored in prod. But **`approval_request`/`question_request`, which are facts sent by the host, are the exception** — if an approval request genuinely exists and the table blocks it, it never appears in the inbox or the badge and the agent is blocked forever (measured). These two transition to `waiting_approval` from any state.

## 3. Derived state rules (half the bugs are stopped here)

The do-not-store list — the following **must not exist as fields** and must be selectors:

| Derived value | Computed from | Reasoning |
|---|---|---|
| Inbox list and order | sessions' state + when the wait started + unread | Storing it means synchronising on every state change → ghost item bugs |
| Global counters | 〃 | 〃 |
| Unread or not | `lastMessageSeq > lastReadSeq` | It is just a comparison of two numbers |
| Project aggregate badge | the states of the sessions in it | 〃 |
| "N concurrent sessions" | the number of active sessions with the same cwd | 〃 |

Selectors are implemented as memoised wrappers around pure functions in `core`. Because the ordering and urgency rules live in core, the unit tests run without React.

## 4. Message windowing (how the §7.1 memory target is met)

- We do not hold every message of a session in memory. **Focused session**: the most recent N (200 by default) + page-loading from StorePort when scrolling up. **Unfocused sessions**: no messages at all, only a summary (last line, seq, state).
- When focus is lost, that session's messages are trimmed to the window size.
- A streaming `message_delta` is appended to the last message — only that row re-renders, without recreating list items (including the virtual list's measure recalculation).

## 5. Persistence and restore (FR-10)

- **Writing**: write-through after applying an event. Messages are appended in batches (500ms debounce); session metadata and workspace on every change. There is no such concept as "save on exit" — crash safety comes for free.
- **Restore order**: ① load the workspace + session metadata from the store → show the sidebar and inbox immediately (read-only) → ② connect to the host → ③ attempt resume per session → on success switch to active, on failure show the "view the record + new session" card. That the UI does not need the host to come up is the key to the 3-second cold start target.
- The relationship between event reconnection (`afterSeq`) and restore is in [agent-host.md](agent-host.md) §4.

## 6. Where settings live

- Shortcuts, notification policy, card collapse policy, approval banner policy and so on are **data** (the strategy table of the strategy pattern). A `settings` slice + store persistence.
- The policy judgement functions live in core (`shouldCollapseCard(tool, settings)`, `canApproveInBanner(detail, settings)`) and the UI only consumes the result. Changing a policy is a data change, not a component edit.
