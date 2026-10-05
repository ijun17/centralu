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

- We do not hold every message of a session in memory. **Focused session**: everything loaded so far, read a page at a time from StorePort when scrolling up. **Unfocused sessions**: a window of the most recent 50 rows (`WINDOW_SIZE`) beside the summary (last line, seq, state); opening one reads the rest back.
- When focus is lost, that session's messages are trimmed to the window size, and the history cursor moves to the top of what is kept.
- A session that is not on screen and keeps receiving events (a worker the orchestrator started, a session an app asked for, an unfocused grid panel) is trimmed the same way once it reaches twice the window (#392). It was never focused and then left, so the trim above never reached it. The focused session is never cut this way, even while the orchestrator, the grid or a pinned app covers it: the person comes back to it with the pages they loaded and their reading position.
- A streaming `message_delta` is appended to the last message — only that row re-renders, without recreating list items (including the virtual list's measure recalculation).
- **A launch card's subagent steps are outside the window** (#222). They are not in the conversation (`chat`) and are never paged with it: `subagentSteps[session][callId]` holds them once the person opens that card, read a page at a time from `messages.subagent`. A live `subagent_event` joins an opened card only once every earlier step is read, and touches nothing else — not the conversation, not the session's state, not unread. Whether the section is open lives in the store, not the card, because the virtual list detaches rows that scroll away and a card drawn again must come back as it was left.

## 5. Persistence and restore (FR-10)

- **Writing**: write-through after applying an event. Messages are appended in batches (500ms debounce); session metadata and workspace on every change. There is no such concept as "save on exit" — crash safety comes for free.
- **Restore order**: ① load the workspace + session metadata from the store → show the sidebar and inbox immediately (read-only) → ② connect to the host → ③ attempt resume per session → on success switch to active, on failure show the "view the record + new session" card. That the UI does not need the host to come up is the key to the 3-second cold start target.
- The relationship between event reconnection (`afterSeq`) and restore is in [agent-host.md](agent-host.md) §4.

## 6. Where settings live

- Shortcuts, notification policy, card collapse policy, approval banner policy and so on are **data** (the strategy table of the strategy pattern). A `settings` slice + store persistence.
- The policy judgement functions live in core (`shouldCollapseCard(tool, settings)`, `canApproveInBanner(detail, settings)`) and the UI only consumes the result. Changing a policy is a data change, not a component edit.

## 7. Linked machines (#82)

The hub lists another machine's sessions and projects with `machine` set (null for this computer) and their ids
qualified (`<machine>.<id>`, never parsed here). `machines` holds one `MachineInfo` per linked machine, replaced whole
by its `machine_status`.

- **Away is derived, not stored** (`isAway` in `@cc/core`): a row the hub answered from its mirror (`unreachable`),
  or a row of a machine whose link is not `connected`. An away row stays listed and dimmed, and `wake` refuses it:
  waking would only fail at the hub, and the machine's own resync does the waking once it is back. The reconnect
  recovery (`recoverAfterReconnect`) skips away sessions for the same reason.
- **`machine_resync {machineId}` runs a recovery scoped to that machine** (`recoverMachine`), not the global one:
  1. re-read `sessions.list` and `projects.list`, and replace **that machine's rows only**: a row of another machine or
     of this computer keeps its object (nothing re-renders, nothing the reducer derived is lost); a row the fresh list
     no longer has leaves (deleted there, or the machine was unlinked), with what it held cleared as
     `session_deleted` clears it (#163); a new one joins;
  2. re-read the history of every open conversation of that machine (the hub does not replay a remote's gap; the
     conversations are read again, as a host resync does for every one, #173);
  3. wake that machine's sessions that were live before and are not now (a remote host that restarted without a
     keeper), and none of any other machine.
- **Per-machine questions carry the machine**: the new-session dialog's `agents.detect`, the model and capability
  lists of a session's menu, a remote session's "older CLI" line (`machineAgentVersions[machine]`, read when its header
  first needs it and again on its resync), and `projects.add {path, machine}`.
