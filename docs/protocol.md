# Protocol — the shared language of the UI and the Agent Host

`packages/protocol` is the bottom layer package, with 0 dependencies. **Nothing can cross a process boundary in a type that is not here.**

## 1. Transport layer

- WebSocket, 1 text frame = 1 JSON message.
- Handshake immediately after connecting: `{ kind: 'hello', token, protocolVersion, afterSeq?, streamEpoch? }` → on mismatch, close immediately (with an error code). The token is generated when the host starts; in dev it is passed through an environment variable.
- Two kinds, by direction: **RPC** (request/response, UI→host) and the **event stream** (host→UI, one-way push).

```ts
// envelope
type Rpc     = { kind: 'rpc';   id: string; method: string; params: unknown }
type RpcRes  = { kind: 'res';   id: string; ok: true; result: unknown }
             | { kind: 'res';   id: string; ok: false; error: ProtocolError }
type Push    = { kind: 'event'; seq: number; sessionId?: string; event: NormalizedEvent }
```

- `seq` increases within one host lifetime, identified by `streamEpoch`. A reconnect includes both `afterSeq` and the epoch received in `hello_ok`. Protocol 1 clients without an epoch can still connect; a positive cursor without a matching epoch requires a snapshot, never replay from an unrelated lifetime.
- The host retains 2,000 events in an O(1) append ring. An expired/future cursor, a different/missing epoch for a positive cursor, or a replay exceeding the outbound byte budget produces `hello_ok { resyncRequired: true, currentSeq, streamEpoch }` **without partial replay**. The client resets its cursor to that watermark and reloads snapshots. The complete replay burst (including WebSocket framing) is budgeted before acknowledgement so oversized history cannot cause an endless reconnect loop.
- Clients become ready only after authenticated `hello_ok`, suppress duplicate event sequence numbers, and cancel obsolete handshake/reconnect timers. Sent calls whose responses were lost have an **unknown outcome** and are rejected, not automatically replayed. Inspect authoritative host state before retrying a mutation.
- Per connection, the host defaults to a 10-second handshake deadline, 32 MiB incoming frames/outbound buffering and 64 in-flight RPCs; at most 128 sockets are admitted. The client admits at most 256 pending calls and 32 MiB of queued frames. Oversized live responses/events disconnect that observer rather than blocking host execution. These are transport bounds, not a total process-memory quota.
- Ownership is local: a dedicated SQLite database holds a lifetime `BEGIN EXCLUSIVE` transaction in DELETE journal mode; `host.lock` is diagnostic metadata. Legacy live PID locks are respected, and process death releases the SQLite lock. This is not a distributed lease, network-filesystem support, or multi-host failover.
- Remote UI, host discovery/installation and multi-host client storage remain separate product decisions in [#82](https://github.com/ijun17/centralu/issues/82). These recovery contracts do not introduce remote mode.

## 2. NormalizedEvent (product spec §6.2, made concrete)

The **canonical union lives in `packages/protocol/src/events.ts`** — every field, every
default, and the reasoning comments. This list is the map, grouped by what the event is
for; the golden-fixture test (`protocol.test.ts`) fails the moment a type exists in the
schema without appearing here-adjacent fixtures, so the schema cannot quietly outgrow
its own examples.

```ts
type NormalizedEvent =
  // conversation content (persisted via seq except where noted)
  | { type: 'message_delta';    sessionId, role, text }         // streaming body
  | { type: 'reasoning_delta';  sessionId, text?, estTokens? }  // #58: codex gives summary text; claude only a token estimate
  | { type: 'user_message';     sessionId, seq, text, from? }   // human input, or another session's instruction (FR-11)
  | { type: 'tool_call';        sessionId, callId, summary: ToolSummary }
  | { type: 'tool_result';      sessionId, callId, ok, summary }
  | { type: 'message_image';    sessionId, mime, data, path?, note? }  // #40; note explains display failures
  | { type: 'compaction';       sessionId, failed, reason?, before?, after? }  // FR-14 marker
  // in-turn progress (display-only, never persisted)
  | { type: 'activity';         sessionId, activity|null }      // compacting / reviewing
  | { type: 'plan_update';      sessionId, steps: {text, status}[] }  // #58: codex turn/plan/updated snapshot
  | { type: 'tool_output_delta';sessionId, callId, text }       // #58: live command output tail
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
| agents | `createSession, send, respondApproval, interrupt, resumeSession, deleteSession` | product spec §6.2 |
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
  code: 'adapter_crashed' | 'tool_not_installed' | 'not_logged_in'
      | 'session_not_found' | 'rate_limited' | 'version_mismatch' | 'internal'
  message: string          // a human-readable explanation (must be displayable in the UI as is)
  retryable: boolean
  data?: unknown           // extra information per code (rate_limited → resumeAt etc.)
}
```

- code is a closed set. The UI branches on code and only displays message. Branching on string matching is forbidden.
- An adapter's raw errors (SDK exceptions, process exit codes) are converted into this shape inside the host.
