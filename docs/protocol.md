# Protocol — the shared language of the UI and the Agent Host

`packages/protocol` is the bottom layer package, with 0 dependencies. **Nothing can cross a process boundary in a type that is not here.**

## 1. Transport layer

- WebSocket, 1 text frame = 1 JSON message.
- Handshake immediately after connecting: `{ type: 'hello', token, protocolVersion }` → on mismatch, close immediately (with an error code). The token is generated when the host starts; in dev it is passed through an environment variable.
- Two kinds, by direction: **RPC** (request/response, UI→host) and the **event stream** (host→UI, one-way push).

```ts
// envelope
type Rpc     = { kind: 'rpc';   id: string; method: string; params: unknown }
type RpcRes  = { kind: 'res';   id: string; ok: true; result: unknown }
             | { kind: 'res';   id: string; ok: false; error: ProtocolError }
type Push    = { kind: 'event'; seq: number; sessionId?: string; event: NormalizedEvent }
```

- `seq` is a monotonically increasing number assigned by the host. On reconnect, `subscribe({ afterSeq })` replays what was missed — **the key device that stops a reconnect being a loss of state.**
- The host keeps recent events in a ring buffer (+ the store). If afterSeq is outside the buffer it sends `resync_required` and the UI reloads the snapshot: the session list, and the stored conversation of every session it holds one for (#173).
- A hello without `afterSeq` is a first contact. The host still replays its buffer, but the client does not pass those events on as new — they ended before this page attached, and the session list plus the stored conversation are its starting point. If the client had been talking to an earlier host (the desktop moved to a new port), it raises `resync_required` so the UI re-reads what it holds.
- An `afterSeq` above the host's `currentSeq` means the host restarted at the same address and numbers from 1 again (web and dev mode). The host answers `resyncRequired: true`, and the client drops its own `lastSeq` to the host's `currentSeq` so later reconnects ask from the new numbering.
- An RPC rejected with `connection_lost` may still have reached the host. The UI keeps a sent message pending and, once reconnected, checks the stored conversation before it gives the text back as unsent (#173).

## 2. NormalizedEvent (product spec §6.2, made concrete)

The **canonical union lives in `packages/protocol/src/events.ts`** — every field, every
default, and the reasoning comments. This list is the map, grouped by what the event is
for; the golden-fixture test (`protocol.test.ts`) fails the moment a type exists in the
schema without appearing here-adjacent fixtures, so the schema cannot quietly outgrow
its own examples.

```ts
type NormalizedEvent =
  // conversation content (persisted via seq except where noted)
  | { type: 'message_delta';    sessionId, role, text, messageId? }  // streaming body; messageId: which message it belongs to (#212)
  | { type: 'reasoning_delta';  sessionId, text?, estTokens? }  // #58: codex gives summary text; claude only a token estimate
  | { type: 'user_message';     sessionId, seq, text, from? }   // human input, or another session's instruction (FR-11)
  | { type: 'tool_call';        sessionId, callId, summary: ToolSummary, input? }  // input: the raw tool input (#221)
  | { type: 'tool_result';      sessionId, callId, ok, summary, output? }           // output: the whole result text (#221)
  | { type: 'message_image';    sessionId, mime, data, path?, note? }  // #40; note explains display failures
  | { type: 'compaction';       sessionId, failed, reason?, before?, after? }  // FR-14 marker
  // in-turn progress (display-only, never persisted)
  | { type: 'activity';         sessionId, activity|null }      // compacting / reviewing / retrying (codex reconnecting)
  | { type: 'plan_update';      sessionId, steps: {text, status}[] }  // #58: codex turn/plan/updated snapshot
  | { type: 'tool_output_delta';sessionId, callId, text }       // #58: live command output tail; #98: a subagent's steps, on the Agent call that spawned it
  // what a native subagent did — kept apart from the conversation (#222)
  | { type: 'subagent_event';   sessionId, parentCallId, step: SubagentStep, stepSeq? }  // step: a message_delta, reasoning_delta, tool_call or tool_result
  // things a person must answer
  | { type: 'approval_request'; sessionId, requestId, detail: ApprovalDetail }
  | { type: 'approval_resolved';sessionId, requestId, decision }
  | { type: 'question_request'; sessionId, requestId, questions: Question[] }  // AskUserQuestion
  | { type: 'question_resolved';sessionId, requestId }
  // session state and gauges
  | { type: 'turn_complete';    sessionId }
  | { type: 'state_change';     sessionId, state: SessionState, reason? }
  | { type: 'usage_update';     sessionId, tokens: TokenUsage }
  | { type: 'context_update';   sessionId, used, window, exactness: 'exact'|'estimate' }
  | { type: 'limit_reached';    sessionId, resumeAt?, usedPercent?, windowMins? }
  | { type: 'session_title';    sessionId, title, auto }        // auto=false: human-given, never overwritten
  | { type: 'settings_changed'; sessionId, model, effort, verbosity, serviceTier? }  // #30: a non-human hand changed settings
  | { type: 'files_touched';    sessionId, paths: string[] }    // FR-2 conflict detection, FR-5 highlighting
  | { type: 'history_synced';   sessionId, added }              // a conversation continued elsewhere was caught up
  | { type: 'session_deleted';  sessionId }
  // app-scoped (sessionId optional — not every fact belongs to a conversation)
  | { type: 'update_status';    status: UpdateStatus }          // #43
  | { type: 'fs_changed';       projectId, dirs: string[] }     // #34
  | { type: 'error';            sessionId?, error: ProtocolError }
```

**A tool call's `summary` is its card; `input` and `output` are its record, and they never leave the host**
([#221](https://github.com/ijun17/centralu/issues/221)). The adapter sends both: `summary` is what the card shows (a
command, a path, the first 300 characters of a Claude result or 2,000 of a Codex one), `input` is what the tool received
(a Write's content, an Edit's both sides, Codex's file changes with their diffs) and `output` is the whole text it
answered, images excluded (they are attachments, #40). The host stores the event as it came and strips `input` and
`output` from everything it sends — the event stream and the history pages (`messages.load`, `trash.read`) — so on this
wire the two fields are always absent. They are declared here because the stored payload is this event, and a reader of
the store that asks for them by name (`Store.loadMessages(…, { full: true })`) gets this shape. Why they stay behind:
[security-boundaries.md](security-boundaries.md#tool-output-in-the-store).

**A native subagent's steps are one wrapper kind, not the parent's events with a flag**
([#222](https://github.com/ijun17/centralu/issues/222)). Claude Code's `Agent` tool and Codex's `spawn_agent` run a
subagent whose text, reasoning, tool calls and results reach the host on the parent's stream. Each becomes a
`subagent_event` whose `step` is one of the parent's own shapes and whose `parentCallId` is the launching call: Claude's
`Agent` tool_use id (the subagent's `parent_tool_use_id`), Codex's `spawnAgent` collab item (whose `receiverThreadIds`
names the child thread). A subagent that launches its own tags that one's steps with its own launch call.

| Decision | Why |
|---|---|
| A wrapper kind, not a `parentCallId` on `tool_call` and the rest | A receiver that does not know a type ignores it (§4). With a field, every reader of `tool_call` would have to check it, and the first one that forgot would put a subagent's call back in the parent's conversation — the bug #98 removed. With a wrapper, the conversation, the state machine, unread and the turn logic skip it without a line each |
| `step` reuses the parent's shapes | The store keeps a step as it keeps the parent's rows, and the screen draws it with the same code (`messagesToChat`) |
| Each step is whole | Claude forwards a subagent's text a block at a time; Codex's child items are read when they complete. Nothing to stream, nothing to join |
| `stepSeq`, not `seq` | Its number among that launch's steps, set by the host when it stores the step. A `seq` would move the session's unread marker for something that is not the conversation |

On the wire a step's tool `input` and `output` are stripped like the parent's (`withoutToolRecord` looks inside the
wrapper). The steps are read back only by `messages.subagent`, which names one launch card; they are never in
`messages.load`. A running Claude agent's card still gets one line per step through `tool_output_delta`.

`ApprovalDetail` is **structured in advance by the adapter** so it carries what is needed to judge in-place banner approval (FR-3):

```ts
type ApprovalDetail =
  | { kind: 'command';   command: string; cwd: string }               // approvable from the banner
  | { kind: 'file_edit'; path: string; diffPreview: string; multi: boolean } // "needs review"
  | { kind: 'other';     raw: string }                                 // always "needs review"
```

The judgement logic (core/approval) decides from `kind` alone — a worked example of anti-corruption keeping the UI from needing to know per-tool raw formats.

## 3. RPC methods (summary)

| Group | Methods | Notes |
|---|---|---|
| agents | `createSession, send, respondApproval, interrupt, resumeSession, deleteSession` | product spec §6.2. `deleteSession` moves the session to the trash (FR-22) |
| trash | `trash.list, trash.read, trash.restore, trash.purge, trash.empty` | the way out of the trash (FR-22). The person's alone: no agent tool or app capability reaches it |
| messages | `messages.load, messages.subagent, messages.search` | a history page; one launch card's subagent steps, read when the person opens them (#222); search over what was said |
| git (dev) | `git.status, git.log, git.branches, git.diff, git.checkout` | in prod the same contract via Tauri invoke |
| fs (dev) | `fs.listDir, fs.readFile, fs.watchProject` | 〃 |
| store (dev) | `store.loadWorkspace, store.saveWorkspace, store.appendMessages, …` | 〃 |
| usage | `usage.weekly(range)` | resident in the host |

The request and response types of the git/fs/store RPCs are **1:1 with the port interfaces**. Deliberate duplication — the port is the original contract, and RPC and Tauri invoke are just two carriers of that contract.

## 3.1 How a path is spelled ([#47](https://github.com/ijun17/centralu/issues/47))

Two kinds of path cross this boundary, and they are not the same kind of thing.

| Kind | Examples | Encoding |
|---|---|---|
| **Project-relative** | the `rel` of every `fs` RPC, `FsEntry.path`, git's file paths, the path a message links to | **POSIX (`/`), always**, on every host and every platform |
| **Native** | `ProjectInfo.path` — a project's directory | the OS's own spelling, **never taken apart, never normalised** |

**Why relative paths are normalised.** `packages/ui` is not allowed to know which OS it is on
(see [platform-abstraction.md](platform-abstraction.md); it is enforced by `tooling/styles.test.ts`).
A relative path carrying a native separator would have to be read one way on Windows and another
way everywhere else — in the UI — which is exactly the branch that rule forbids. Git settles it
from the other side too: its own path format is POSIX on every platform and its output reaches the
screen unchanged, so any other choice would mean converting git's answers for nothing.

**Why absolute paths are not.** A project's directory is chosen by the OS folder picker and handed
straight back to the OS — a terminal's cwd, a process's cwd, the file manager. Nothing manipulates
it. Normalising it would be lossy for no gain: `C:\Users\me` has no POSIX spelling that Windows
will accept back.

**Where the conversion happens.** At the host's edge, where a relative path meets a real
filesystem, and nowhere else. `@cc/protocol`'s `wireSegments` · `wireBaseName` · `wireJoin` are the
only place the separator is written down; `osPathBaseName` is for the other kind. On macOS and
Linux the conversion is the identity, which is why getting it wrong cost nothing until it was
written down.

This does **not** make the app run on Windows ([#14](https://github.com/ijun17/centralu/issues/14)).
It is the prerequisite: one named assumption instead of twenty-one anonymous ones, so a Windows
build fails for reasons that are about Windows. `tooling/paths.test.ts` fails the build on a
twenty-second.

## 3.2 App documents ([#81](https://github.com/ijun17/centralu/issues/81))

Each app has one JSON document and an on/off flag. The `apps.*` RPCs and the
`app_state_changed` event carry that document as `unknown`, and nothing on the wire checks
it. The protocol carries the document without knowing what it means, which is why no app needs
an RPC of its own.

**The document's shape is still written down in one place.** An app has two halves, the host
half (its tools and observers) and the UI half (its rail and settings), and both read and write
the same document. The only package both halves may import is `@cc/protocol`, so the shape
goes there. For the control app that file is `control-app.ts`. No wire schema refers to it,
and no other protocol file imports it.

Written twice, the two copies drifted apart. The control app's host copy made `notifies`
required, but its UI copy wrote documents without that field. After a fresh install, one inline
reply in the rail was enough for the host to crash with `doc.notifies.push` of undefined on
every later notice.

Rules for an app document:

- **Every top-level field is optional.** Either half may write the document first, so any
  field can be missing. The side that reads a field supplies its default.
- **Declare it as a TypeScript type, not a zod schema.** Nothing validates the document, and
  a schema would suggest a check that never runs.
- **Do not name a vendor in it** (`tooling/boundaries.test.ts`). A tool is a `ToolName`.

This applies only to apps compiled into Centralu. M4's external apps keep their state in their
own process ([plans/apps-plan.md](plans/apps-plan.md)).

## 4. Schema and version rules (the C6 defence)

- Every message is defined by a zod schema and validated **only at the boundary** (once, on receipt. Re-validating internally is forbidden — performance).
- `protocolVersion` is a single integer. Compatibility rules:
  - **Additions are free** (a new event type, a new optional field) — the version does not change.
  - The receiver **must ignore event types and fields it does not know** (zod `passthrough` + a fallback case in the discriminated union).
  - Removing a field or changing its meaning = version increment = rejected at the handshake. **Avoid this wherever possible** — adding a new field and keeping the old one for one milestone is always cheaper.
- Golden tests: freeze sample message JSON per version as fixtures, and when the schema changes, CI verifies that the past fixtures still parse.

## 5. Error model

```ts
type ProtocolError = {
  code: 'adapter_crashed' | 'conversation_locked' | 'tool_not_installed' | 'not_logged_in'
      | 'session_not_found' | 'rate_limited' | 'version_mismatch' | 'internal'
  message: string          // a human-readable explanation (must be displayable in the UI as is)
  retryable: boolean
  data?: unknown           // extra information per code (rate_limited → resumeAt etc.)
}
```

- code is a closed set. The UI branches on code and only displays message. Branching on string matching is forbidden.
- An adapter's raw errors (SDK exceptions, process exit codes) are converted into this shape inside the host.
