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
- The host keeps recent events in a ring buffer (+ the store). If afterSeq is outside the buffer it sends `resync_required` and the UI reloads the snapshot.

## 2. NormalizedEvent (product spec §6.2, made concrete)

```ts
type NormalizedEvent =
  | { type: 'message_delta';    sessionId, role, text }         // streaming body
  | { type: 'tool_call';        sessionId, callId, tool, summary: ToolSummary }
  | { type: 'tool_result';      sessionId, callId, ok, summary }
  | { type: 'approval_request'; sessionId, requestId, detail: ApprovalDetail }
  | { type: 'approval_resolved';sessionId, requestId, decision }
  | { type: 'turn_complete';    sessionId }
  | { type: 'state_change';     sessionId, state: SessionState, reason? }
  | { type: 'usage_update';     sessionId, tokens: TokenUsage }
  | { type: 'context_update';   sessionId, used, window, exactness: 'exact'|'estimate' }
  | { type: 'limit_reached';    sessionId, resumeAt?: string }
  | { type: 'session_title';    sessionId, title }
  | { type: 'files_touched';    sessionId, paths: string[] }    // for FR-2 conflict detection, FR-5 highlighting
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
| agents | `createSession, send, respondApproval, interrupt, archiveSession, resumeSession` | product spec §6.2 |
| git (dev) | `git.status, git.log, git.branches, git.diff, git.checkout` | in prod the same contract via Tauri invoke |
| fs (dev) | `fs.listDir, fs.readFile, fs.watchProject` | 〃 |
| store (dev) | `store.loadWorkspace, store.saveWorkspace, store.appendMessages, …` | 〃 |
| usage | `usage.weekly(range)` | resident in the host |

The request and response types of the git/fs/store RPCs are **1:1 with the port interfaces**. Deliberate duplication — the port is the original contract, and RPC and Tauri invoke are just two carriers of that contract.

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
