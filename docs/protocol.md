# Protocol — the shared language of the UI and the Agent Host

`packages/protocol` is the bottom layer package, with 0 dependencies. **Nothing can cross a process boundary in a type that is not here.**

## 1. Transport layer

- WebSocket, 1 text frame = 1 JSON message.
- Handshake immediately after connecting: `{ kind: 'hello', token, protocolVersion, afterSeq?, streamEpoch? }` → on a wrong token, close 4001; on a protocol mismatch, one `res` frame with `id: '0'` and `version_mismatch`, then close 4002. Its message names both numbers and which side is older ("Protocol version mismatch: Centralu 0.2.0 speaks protocol 3, the app speaks protocol 2. The app is older: …"), because with a remote host (`centralu serve`, [agent-host.md](agent-host.md) §4.7) the two are updated separately; on success `{ kind: 'hello_ok', protocolVersion, resyncRequired, currentSeq, streamEpoch, build? }`. The token is generated when the host starts; in dev it is passed through an environment variable.
- **The refusal carries the host's numbers as data** (#82): `error.data = { protocolVersion, version? }`, the host's own. A hub linking to this host (§6) shows the version prompt from them instead of parsing the sentence.
- `hello_ok.build` (#280) says which build the host is and where it came from: `{ commit, protocolVersion, version?, bundlePath?, copyDir? }`. Under the keeper a window of one build can be attached to a host of another, and this is how a client tells. The commit is the host's own compiled-in one; the rest is the keeper's record of the bundle it copied the host from ([agent-host.md](agent-host.md) §4.1). Optional: an older host sends none, and a host run from source sends `commit: 'dev'`.
- `hello_ok.elevated` (#702, additive) says the host runs with administrator rights: an elevated token on Windows (the
  integrity level `whoami /groups` lists is High or System), root elsewhere. A hub shows it on that machine's row
  (`MachineInfo.elevated`). Absent while the host has not found out (it asks once, in the background, at startup) and
  from a host that predates it.
- **The front door** (#280 step 3). Under the keeper a client never connects to a host's own port: it connects to the keeper's front door, `ws://127.0.0.1:<door>`, which relays the bytes to whichever host is current, and the token is the keeper's, handed to every host it starts (on the host's stdin, #538). Nothing in the frames changes: `hello`, the token check and the `Origin` rule are the host's as before. When the host is swapped, the connection through the door closes; reconnecting to the same address with the same token reaches the new host, whose `hello_ok` carries a new `streamEpoch`, so the client resyncs. A connection opened while no host is ready waits at the door (up to 45 s) rather than failing.
- **A Codex bridge's credential** (#382). `hello.token` may instead be one session's bridge credential (`ccb1:<sessionId>:<mac>`, an HMAC of the session id keyed by the token; `transport/bridge-token.ts`), which is what the Codex bridge is started with, since its environment is readable by any process of the same user ([security-boundaries.md](security-boundaries.md), "The front door"). That socket gets `hello_ok` and no replay, no events and no terminal frames after it. An RPC other than `orchestrator.tools`, `orchestrator.tool`, `apps.sessionTools` and `apps.sessionCall`, or one whose `sessionId` is not the credential's session, is answered `ok: false` (`internal`) without running. Under the keeper the key is the front door's token, so the credential works with every host behind the door.
- **A host draining for a swap** (#280 step 3) refuses new RPCs, and answers RPCs still running at its bound (10 s), with `internal` and `retryable: true`: a refused call never ran, and a cut one is stated in the message as possibly done, so the caller checks before it repeats. The code stays `internal` because a client drops a frame whose code it does not know.
- **A proof before the hello** (#838). A client may first send `{ kind: 'prove', nonce }` (base64url, 22–128 characters); the host answers `{ kind: 'proof', nonce, mac }`, the HMAC-SHA256 of `centralu host proof v1\0<nonce>` keyed by its token, and still expects a hello. Once per socket, before hello: a second one closes the socket (4001), and one after `hello_ok` is ignored, as a second hello is. The hub sends it to a linked machine whose connection line says `proof`, and sends the hello only if the mac is right: the forward's local port can be taken by another account on the hub, and the hello carries the token.
- **Nothing but hello goes out before `hello_ok`** (#82). The client reports `connected` and sends its queued calls, in the order they were made, only once `hello_ok` arrives; before that it ignores every other frame. A socket that opens but never answers is dropped after 10 seconds and retried, and the host closes a socket that has not sent a valid hello within 10 seconds (4001), or whose first frame is not a hello of at most 64 KiB (4001; more than that read from the socket before hello cuts it). A frame over 100 MiB closes the socket with 1009. Before #82 the client flushed its queue the moment the socket opened, so a refused handshake turned calls the host never ran into "connection lost, may have reached the host".
- Two kinds, by direction: **RPC** (request/response, UI→host) and the **event stream** (host→UI, one-way push).

```ts
// envelope
type Rpc     = { kind: 'rpc';   id: string; method: string; params: unknown }
type RpcRes  = { kind: 'res';   id: string; ok: true; result: unknown }
             | { kind: 'res';   id: string; ok: false; error: ProtocolError }
type Push    = { kind: 'event'; seq: number; sessionId?: string; event: NormalizedEvent }
```

- `seq` is a monotonically increasing number assigned by the host. On reconnect, `subscribe({ afterSeq })` replays what was missed — **the key device that stops a reconnect being a loss of state.**
- **A seq means something only in the host lifetime that assigned it** (#82). Every host process has a random `streamEpoch`, sent in `hello_ok`; a reconnect sends `afterSeq` together with that epoch. The host replays only for its own epoch: a cursor with another epoch, or a positive `afterSeq` with no epoch, gets `resyncRequired` and no events. The client also compares the epoch in `hello_ok` with the one its cursor came from and resyncs on a difference. This covers the case #173's `currentSeq` check could not see: a host that restarted at the same address and had already numbered past the old cursor used to hand out the tail of its own lifetime as "what was missed" (measured: a client holding A1..A3 received `A1, A2, A3, B4, B5`).
- The host keeps recent events in a ring buffer (+ the store). If afterSeq is outside the buffer it sends `resync_required` and the UI reloads the snapshot: the session list, and the stored conversation of every session it holds one for (#173).
- **The buffer is bounded by size as well as by count** (#392). It holds the last 2,000 events, and drops the oldest sooner once their serialised size passes the replay budget below: an image event carries its whole base64 image, so 2,000 of them could pin hundreds of MB. Nothing past the budget could be replayed anyway, so a client sees no difference: a cursor pushed out gets a resync either way. The newest event always stays, however large.
- **A replay is priced before it starts** (#82). The host adds up `hello_ok` and every replayed frame as bytes on the wire, WebSocket framing included, and if the total is over the replay budget (16 MiB) it answers `resyncRequired` with its `currentSeq` and sends no replay at all. Starting a replay and cutting it halfway would leave the client's cursor where it was, and every reconnect would ask for the same window again — a reconnect loop that never converges. On any resync the client moves its cursor to `currentSeq`, so the next reconnect starts from there.
- **Each event is handed on once** (#82). The host ignores a second hello on a socket that is already authenticated (it used to replay the window again), and the client drops every event whose seq is not above the last one it handed on.
- A hello without `afterSeq` or `streamEpoch` is a first contact. The host still replays its buffer, but the client does not pass those events on as new — they ended before this page attached, and the session list plus the stored conversation are its starting point (the client takes `hello_ok.currentSeq` as its cursor, and the duplicate filter drops the replay). If the client had been talking to an earlier host (the desktop moved to a new port), it raises `resync_required` so the UI re-reads what it holds. After the first `hello_ok` every reconnect carries a cursor, even `afterSeq: 0`.
- An `afterSeq` above the host's `currentSeq` means the host restarted at the same address and numbers from 1 again (web and dev mode). The host answers `resyncRequired: true`, and the client drops its own `lastSeq` to the host's `currentSeq` so later reconnects ask from the new numbering.
- An RPC rejected with `connection_lost` may still have reached the host. The UI keeps a sent message pending and, once reconnected, checks the stored conversation before it gives the text back as unsent (#173).
- **A call whose outcome is unknown is never sent again** (#82). Only a call that went out over an authenticated socket and lost its answer is rejected with `connection_lost`; its error says the host may or may not have done it and is not `retryable`, because retrying a rename, a send or a commit blindly could do it twice. A call that was still queued when the socket went away was never sent, and goes out after the next `hello_ok`.
- **Pending and outbound work is bounded** (#82); these bound what one connection can make either side hold, not process memory.
  - Client: at most 512 calls waiting at once and 64 MiB of unsent frames. A call over either bound is refused before it is queued, with `overloaded` and `retryable: true` — nothing was sent, so its outcome is certain.
  - Host: a socket whose undrained backlog is already over 64 MiB has stopped reading (a suspended WebView, a hung client) and is cut; it reconnects when it wakes and gets a replay or a resync. The host's agents never wait on a viewer. The rule is "already over", not "this frame would cross it", because single frames in the tens of megabytes are legitimate (a large diff, an image).
- **Shutdown has deadlines** (#82). The host's `close()` sends every socket a close frame, gives it 250 ms to answer, then cuts it, and drops plain HTTP connections outright; a second `close()` returns the same shutdown. Before, a peer that never answered the close frame held shutdown for `ws`'s 30 seconds, past the desktop supervisor's 3-second budget. The client's `close()` leaves no reconnect, handshake or call timer behind, and a call made after it fails at once with `connection_closed`.

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
  | { type: 'compaction';       sessionId, failed, reason?, before?, after? }  // FR-14 marker: claude compact_boundary, codex a completed contextCompaction item (#303)
  | { type: 'conversation_reset'; sessionId, trigger? }       // #304: the tool started a fresh conversation (Claude's /clear); a marker, and the gauge empties
  | { type: 'notice';           sessionId, level: 'info'|'warning'|'error', text, oncePerSession?,
      from?, label?, audience?: 'you'|'centralu', summary?, items?, hint? }  // #304: text the tool wants read, one line; #342: made readable
  // in-turn progress (display-only, never persisted)
  | { type: 'activity';         sessionId, activity|null }      // compacting / reviewing / retrying (codex reconnecting, claude api_retry)
  | { type: 'plan_update';      sessionId, steps: {text, status}[] }  // #58: codex turn/plan/updated, claude's TodoWrite or task list (#843), a snapshot
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
  | { type: 'usage_update';     sessionId, tokens: TokenUsage, request?: RequestInput }  // request: one model request's input, for the prompt cache (agent-host.md §6.1)
  | { type: 'context_update';   sessionId, used, window, exactness: 'exact'|'estimate' }
  | { type: 'limit_reached';    sessionId, resumeAt?, usedPercent?, windowMins? }
  | { type: 'session_title';    sessionId, title, auto }        // auto=false: human-given, never overwritten
  | { type: 'settings_changed'; sessionId, model, effort, verbosity, serviceTier?, permissionPreset?, by?, person? }  // #30: a non-human hand changed settings; by 'tool': the agent tool switched by itself (#304); person: a client called agents.updateSettings (#659)
  | { type: 'files_touched';    sessionId, paths: string[] }    // FR-2 conflict detection, FR-5 highlighting; once the change went through (#843)
  | { type: 'goal';             sessionId, goal: SessionGoal|null }  // the badge; codex announces it, claude's is read from the CLI's /goal replies and Stop hook feedback
  | { type: 'background_tasks'; sessionId, live: BackgroundTask[], ended?: BackgroundTask[], clearEnded? }  // #290: the live set (REPLACE) and what just ended
  | { type: 'agent_version';    sessionId, version }            // #297: the CLI version this process runs, once per process; kept as SessionInfo.agentVersion
  | { type: 'session_live';     sessionId, live, reason? }      // #568: the process ended because the session went to sleep (reason 'asleep'), or a resume brought it back
  | { type: 'interruption';     sessionId, interruption: Interruption|null }  // #698: why the last turn did not finish (network, quit, interrupted, reconnecting); kept as SessionInfo.interruption
  | { type: 'history_synced';   sessionId, added }              // a conversation continued elsewhere was caught up
  | { type: 'session_deleted';  sessionId }
  | { type: 'session_owner';    sessionId, askedBy|null, parentSessionId|null }  // #693: a handoff moved this child to the session that took over (a settled one too when the original goes, #738); the sidebar hangs it there. #1038: also the hub naming its session that started a linked machine's child (null once that session is gone)
  // app-scoped (sessionId optional — not every fact belongs to a conversation)
  | { type: 'update_status';    status: UpdateStatus }          // #43; autoApply (#352) defaults to false
  | { type: 'update_apply_request'; requestId }                 // #665: an agent's "Apply now"; each window answers with updates.answerApply
  | { type: 'update_apply_go';  requestId, ticket }             // #665: only the window holding ticket relaunches: updates.reportApply started, then the outcome
  | { type: 'agent_versions';   status: AgentVersions }         // #297: { installed: {tool: version|null}, autoApply (defaults to true), checkedAt }
  | { type: 'fs_changed';       projectId, dirs: string[] }     // #34
  | { type: 'themes_changed' }                                // #312: a file in <data>/themes changed — re-read themes.list
  | { type: 'orchestrator_proposals_changed' }                // #703: an MCP-server or skill proposal was saved, approved or dismissed — re-read agents.mcpProposals and agents.skillProposals
  | { type: 'machine_status';   machine: MachineInfo }          // #82: a linked machine's link changed state; the whole record (§6)
  | { type: 'machine_resync';   machineId }                     // #82: re-read that machine's sessions and projects, wake what died (§6)
  | { type: 'error';            sessionId?, error: ProtocolError }
```

**A tool call's `summary` is its card; `input` and `output` are its record, and they never leave the host**
([#221](https://github.com/ijun17/centralu/issues/221)). The adapter sends both: `summary` is what the card shows (a
command, a path, the first 2,000 characters of a result, the same for both tools), `input` is what the tool received
(a Write's content, an Edit's both sides, Codex's file changes with their diffs) and `output` is the whole text it
answered, images excluded (they are attachments, #40). The host stores the event as it came and strips `input` and
`output` from everything it sends — the event stream and the history pages (`messages.load`, `trash.read`) — so on this
wire the two fields are always absent. They are declared here because the stored payload is this event, and a reader of
the store that asks for them by name (`Store.loadMessages(…, { full: true })`) gets this shape. Why they stay behind:
[security-boundaries.md](security-boundaries.md#tool-output-in-the-store).

`ToolSummary.readOnly` is no longer set or read ([#428](https://github.com/ijun17/centralu/issues/428)). It was a
hint to collapse a read-only tool's card, but every card folds now, nothing on the screen read it, and the two adapters'
guesses had drifted apart (Codex called every `git` command read-only, `git push` included). The field stays in the
schema, optional, so events and stored records from older builds still parse; a reader must not rely on it.

`ToolSummary.centralu` marks a call to one of Centralu's own servers ([#730](https://github.com/ijun17/centralu/issues/730)):
`centralu` or an app's `app-<id>` (`app`), with the bare tool name, what the call did in words (`label`, "Started an
agent") and the session it names (`sessionId`). The adapter sets it because only it knows the server: Claude names the
server inside the tool name, but Codex names it apart, so the screen could not have told Codex's `start_agent` from
another server's tool of that name. For these calls the adapter titles the card by the argument a person follows the
call by (the job, the project asked, the text sent; else the words). `app-<x>` is only a name's shape (a repository's
`.mcp.json` may hold such a server), so each session keeps an app's mark only for an app attached to it
(`keepAttachedAppMarks`). A record an older host wrote has no mark; the screen then reads Claude's `mcp__centralu__…`
names, and `mcp__app-<id>__…` only for an app it knows (`centraluCallOf`); Codex's stay ordinary cards. The card links
the session the call's arguments name, or, for start_agent, ask_project and create_session only, the first `[id]` of
its answer (a list's first id is no one's). The card draws a marked call with Centralu's mark (an app's window icon and name for an app's tool),
the words, the title and a link to the session it names, on a stronger left edge; a session's preview reads
"<words>: <title>" (`toolCallLine`).

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

**What the agent tool tells its own user reaches the conversation as one line** ([#304](https://github.com/ijun17/centralu/issues/304)).
The #58 survey found the tools saying things Centralu dropped: Claude's `/clear` started a new conversation while the
screen carried on, a hook's block reason left a prompt unanswered with no word why, a Codex configuration warning
reached nobody. Three shapes carry them:

- `conversation_reset` is a marker, stored like `compaction`: the record keeps everything above it, the model knows none
  of it. The host and the UI empty the context gauge; the tool reports the new reading when the command's turn ends.
- `notice` is a marker too, in the tool's own words (`text`), with the tool's urgency folded into `level` (an unknown
  word from a newer host reads as `info`). `oncePerSession` marks text the tool repeats on every start: the host stores
  and sends it only if the session has no stored notice with the same text. Codex sends its configuration warning on
  every app-server start and every thread start or resume, twice each time (`configWarning`, then `warning`).
- A notice also says **who is speaking and what kind it is** (`from`, `label`: "Codex · config warning"), **who has to
  act** (`audience`: `you` for the person's own setup, `centralu` for how Centralu uses the tool; absent when the host
  cannot tell), and for a notice the host recognizes, a plain explanation (`summary`, with `items` one per line and a
  `hint`) that the screen shows first, with `text` one click away (#342). All six are optional: a notice stored before
  #342, or one the host cannot place, is drawn from `text` alone. An unknown `audience` word reads as absent.
- `settings_changed` with `by: 'tool'` is a switch the tool made by itself — Claude Code's refusal fallback, another
  Codex client changing the thread. A notice in the conversation says what and why; the event updates the model shown.
- Every saved `agents.updateSettings` is broadcast as `settings_changed` with the full snapshot, `permissionPreset` included (#659). The
  caller gets the answer too, but every other window, linked machine and the person's own window (when an agent made the call)
  learns the new values only from this event. `person: true` marks a client's call and updates the values shown without the "Orchestrator changed" toast
  (a flag, not a `by` word: a build without the word would fail to parse the frame and drop it). The orchestrator's own call
  sends `by: 'orchestrator'` in the RPC, also to a linked machine, and the change is broadcast as its own, so the toast stays.
- A per-project setting saved through RPC is announced with `projects_changed` (#719): `projects.setTrusted`, `projects.setCommands`,
  `projects.setWorktreeSetup`, `worktrees.setTrunk`, and the default tool and per-tool model and effort a session records. Every
  window re-reads the project list and takes the host's value of those fields (a listed row keeps its place and its `git`), so the
  ⋯ menu, the trust mark and the project's apps agree with the host. The hub forwards the event of a linked machine. It is sent when the saved value changed, not on every write; a window leaves a project alone while its own write to it is in flight and reads it again afterwards, and reads the list one at a time.

| Decision | Why |
|---|---|
| A notice is a stored marker, not a live toast | The person may not be looking when it arrives, and the reason a turn went unanswered must still be there when they come back. A toast would also interrupt for something that needs nothing from them |
| The tool's sentence as is | The same rule as an error marker: rewording it loses the cause |
| …with a plain explanation first, for the notices the host knows (#342) | The owner saw a `config.toml` warning and a deprecation addressed to Centralu one under the other, and they read as the same kind of problem. The explanation says whose it is; the tool's words stay on demand, so nothing is lost |
| The host writes the explanation, the screen only draws it | Recognizing a notice means knowing the tool's wording, which is adapter knowledge (`adapters/codex/notices.ts`). The UI stays tool-agnostic, and a stored notice reads the same in any later window |
| A notice addressed to Centralu stays in the conversation, marked `for Centralu` | The owner's decision (#342, 2026-10-05) over sending it to host.log: the person sees what the tool said, and the marker keeps it from looking like something they must fix |
| `oncePerSession` is decided by the host, against the store | The repetition crosses process lifetimes (every wake of a Codex session repeats it); only the store remembers across them |
| A `by: 'tool'` switch is recorded, not applied | The process already runs with the new value. The host takes only the fields that differ from what it launched, moves its launch record along (so it is not read as a change still to make), keeps a choice the person saved mid-turn, and leaves the project's remembered default alone. Without `by`, the event means the orchestrator, as before |
| Events a starting session sends are held until it is registered | A new session is registered only once its adapter answers, and Codex's `configWarning` arrives while `thread/start` is answered (measured). It used to go out unnumbered and unstored |

**An agent's background work is one level, not a pair of edges** ([#290](https://github.com/ijun17/centralu/issues/290)).
`background_tasks.live` is every task running behind the session after a change, and replaces the last one; `ended`
carries the tasks that just left, each with how it ended. A task is `BackgroundTask`:

```ts
type BackgroundTask = {
  id: string
  kind: 'agent' | 'shell' | 'mcp' | 'other'  // an unknown word reads as 'other'
  description: string
  parentCallId?: string    // the call that started it; for an agent, the key of its steps (#222)
  ambient?: boolean        // housekeeping the tool says is not activity — listed, never counted
  stopsWithTurn?: boolean  // what interrupting the turn does to it, as measured per tool; absent = not measured
  stoppable?: boolean      // agents.stopBackgroundTask can stop it alone
  timer?: boolean          // a timer the tool holds (Claude's /loop, scheduled prompts), not work: no report is held for it (#721)
  status: 'running' | 'completed' | 'failed' | 'stopped'
  summary?: string         // how it ended, in the tool's words
}
```

`SessionInfo.backgroundTasks` holds the running tasks and then the ended ones still listed (at most 10, until
`agents.clearBackgroundTasks`). It is live-only, like `goal`: the tool process holds these tasks. Host, UI reducer and
mock all move the list with one function, `applyBackgroundTasks`.

| Decision | Why |
|---|---|
| A level with REPLACE semantics, not started/ended pairs | Claude's own `background_tasks_changed` is a level for this reason (sdk.d.ts): a missed bookend cannot leave a task "running" forever. The endings ride along, because a level alone cannot say a task was stopped |
| `stopsWithTurn` per task, not per tool | The tools differ within themselves: Claude stops a subagent with the turn and leaves a shell running; Codex leaves a child agent running (measured, [agent-host.md](agent-host.md) §2). Stop has to say which |
| Absent means not measured | A task the adapter has not measured gets "may keep running" on screen, not a promise either way |
| Ended tasks stay until cleared | The 2026-10-04 incident: two subagents stopped with an interrupt and nothing on screen said so for four hours |
| `capabilities.backgroundTasks` beside the event | Silence from an adapter that cannot see background work is not "none running"; the idle check (#297) must tell the two apart |

`ApprovalDetail` is **structured in advance by the adapter** so it carries what is needed to judge in-place banner approval (FR-3):

```ts
type ApprovalDetail =
  | { kind: 'command';   command: string; cwd: string;
      reason?: string; network?: { host: string; protocol: string };  // #683: kept from the request,
      stdin?: boolean; unsandboxed?: boolean }                         // said on the card
  | { kind: 'file_edit'; path: string; diffPreview: string; multi: boolean;
      change?: 'add' | 'update' | 'delete' | 'move'; movePath?: string }
  | { kind: 'other';     raw: string }                                 // always "needs review"
```

The judgement logic (core/approval) decides from `kind` alone — a worked example of anti-corruption keeping the UI from needing to know per-tool raw formats.

## 3. RPC methods (summary)

| Group | Methods | Notes |
|---|---|---|
| agents | `createSession, send, respondApproval, interrupt, resumeSession, deleteSession` | product spec §6.2. `deleteSession` moves the session to the trash (FR-22) |
| background tasks | `agents.stopBackgroundTask, agents.clearBackgroundTasks` | #290: stop one task the adapter marked `stoppable` (its ending arrives as `background_tasks`); take the ended ones off the list |
| agent CLI versions | `agents.versions, agents.setAutoApplyVersions, agents.applyVersions` | #297: the installed CLIs (`force: false` answers from a reading under 30 s old — a window gaining focus); "move idle sessions to a newly installed agent CLI" (on by default); restart every idle session that runs an older CLI, answering `{ restarted, busy }`. A session's running version is `SessionInfo.agentVersion`, null without a process. All additive: a window on an older host gets no answer and shows nothing ([agent-host.md](agent-host.md) §4.6) |
| idle sessions asleep | `agents.sleepPolicy, agents.setSleepPolicy` | #568: "Put idle sessions to sleep after" `{ afterMinutes }`, 15 by default, null never. A session the host puts to sleep sends `session_live` (`live: false, reason: 'asleep'`), and every resume sends `live: true`. Additive: a window on an older host gets no answer and hides the setting ([agent-host.md](agent-host.md) §4.6.1) |
| trash | `trash.list, trash.read, trash.restore, trash.purge, trash.empty, trash.readRun, trash.purgeRuns` | the way out of the trash (FR-22). The person's alone: no agent tool or app capability reaches it. `trash.list` also carries the records of deleted app-agent sessions (`runs`, #378), read with `trash.readRun` and deleted with `trash.purgeRuns`, on the machine whose app ran (`machine`, as a trashed session's); `trash.empty` leaves them to the window |
| subagent steps | `subagents.usage, subagents.trash, trash.restoreSubagentSteps, trash.purgeSubagentSteps, messages.subagentTrashed` | #418: what each live session's subagent steps take (`{ sessions: SubagentStepsHeld[] }`: runs, steps, bytes, largest first); moving one session's steps to the trash while the session stays (answers `{ steps, bytes }` moved); putting them back, or deleting them for good. In the trash they are `trash.list`'s `subagentSteps` (`TrashedSubagentSteps[]`), their bytes in its total. `trash.empty` leaves them, as it leaves the run records (#378): the window deletes each entry it listed with `trash.purgeSubagentSteps { sessionId, upTo }`, `upTo` being the `deletedAt` it showed, so steps moved there after it read the trash stay. `messages.subagentTrashed { sessionId, parentCallId }` answers `{ steps }`, how many of one launch card's steps are in the trash, so the card says where they went. The person's alone, like the trash. Additive: a window on an older host gets no answer and shows none of it |
| messages | `messages.load, messages.subagent, messages.search, messages.image` | a history page; one launch card's subagent steps, read when the person opens them (#222); search over what was said; a local image a reply names (`![a](/path/shot.png)`), read by the session's host because the window cannot load a file path: `{ sessionId, path }` with `path` as the reply wrote it, answered `{ ok: true, mime, data, file? }` or `{ ok: false, reason, message, file? }`. `reason` is `not_mentioned` (no reply of this session wrote it; nothing is touched), `not_found`, `not_an_image` (by its bytes: PNG, JPEG, GIF and WebP only), `too_large` (`IMAGE_PREVIEW_MAX_BYTES`, 10 MB) or `unreadable`; `file` is the resolved path on the host's machine, for revealing it. A refusal is an answer, not an error. Additive: an older host answers "Unknown method" and the window shows that in the image's place ([security-boundaries.md](security-boundaries.md), "Images a reply names") |
| grid | `grid.get, grid.set` | the grid's panels in order, written whole (product spec §5.4). Each is a `GridPanel`: `{ kind: 'session', sessionId }` or `{ kind: 'app', projectId: string \| null, appId, span? }` (`null` is a user-folder app) — #288. `span` (#306) is the `{ cols, rows }` the person chose for that app panel from its top bar, each 1 to 4, absent when none was chosen; a host from before it strips it and the panel falls back to its defaults. `machine` (#82, additive) names a linked machine for its user-folder app, whose null project cannot; the hub keeps another machine's app panel while it knows that machine and project ([plans/remote-hub.md](plans/remote-hub.md) §11.8). Expanded, not replaced (§4), so `PROTOCOL_VERSION` stays 1: `grid.get { tagged: true }` and `grid.set { panels }` speak panels; without them both speak the pre-#288 shape, bare session ids (an older UI's `grid.set { sessionIds }` replaces the list with its sessions). The UI sends `sessionIds` next to `panels` and reads a bare id list as session panels, so a UI and a host one build apart keep working both ways; the old fields go one release later. `grid.set` takes at most 256 and answers what it stored: duplicates, unknown sessions and an app of an unregistered project left out. Whether an app exists is not checked — the app list can lag behind its folder, and the screen leaves out an app it cannot find. The shape is the panel's identity alone, so it can move to the client unchanged (#82) |
| machines | `machines.list, machines.add, machines.sshHosts, machines.probe, machines.remove, machines.reconnect, machines.disconnect, machines.setConnect, machines.need, machines.acceptVersions, machines.install, machines.update, machines.rollback, machines.uninstall, machines.autostart, machines.activity` | #82: the hub's links to other machines (§6), and the Centralu it installs there (docs/agent-host.md §4.8). `machines.sshHosts` and `machines.probe` (#514, additive): the hosts of the hub computer's ssh config, and what runs at one before it is linked. `machines.disconnect`, `machines.setConnect` and `machines.need` (#1134, additive): close a link without unlinking, connect a machine at start or when needed, and the window saying it needs one now. Always the hub's own, never forwarded |
| host | `host.stop`, `host.activity`, `host.sessions`, `host.readSession`, `host.recall`, `host.send` | #82: ends this host the way a signal would, answering first. For `centralu serve --stop` ([agent-host.md](agent-host.md) §4.7); a host the app runs refuses it. Never forwarded. `host.activity` counts what stopping this host would end (the `hostBusy` rule), for a hub's `machines.activity`. `host.sessions`, `host.readSession { sessionId, limit?, around?, tools? }` and `host.recall { query, limit? }` are this host's sessions as a hub's orchestrator reads them, made by the orchestrator's own code over what a hub shows (no orchestrator or coordinator; at most 200 lines, 50 hits), asked of a linked machine by the hub directly ([plans/remote-hub.md](plans/remote-hub.md) §12). `host.send { sessionId, text, from: { name }, ask? }` delivers a hub's orchestrator's instruction to one of them (§12.4); `ask: { depth }` (#838) says the text is an ask_project task, worked on at that agent depth until the turn that consumes it is recorded. Additive |
| git | `git.status, git.diff, git.log, git.commitDetail, git.branches, git.ignoredEntries, git.checkout, git.stage, git.commit, git.push` | served by the host's `dev-services` in dev and prod alike: despite the name it is the prod path ([agent-host.md](agent-host.md) §5) |
| fs | `fs.listDir, fs.watch, fs.readFile, fs.move, fs.importFile, fs.resolve`, `files.search` | 〃. `fs.readFile` and `fs.resolve` take an optional `sessionId` (#1209): the path is then that session's, read from its worktree when it has one and refused outside it ([security-boundaries.md](security-boundaries.md), "Project files and native handoff"). Additive: an older host drops the field and reads the project's |
| workspace | `workspace.load, workspace.save` | the window's snapshot of where things are. Conversations are read through `messages.*` above; the host writes them itself |
| usage | `agents.usage`, `agents.account` | the account's limit windows, asked of the tool itself, and the prompt cache over the last hours as the host counted it (`cache`, [agent-host.md](agent-host.md) §6, §6.1). `agents.usage { limits: false }` answers the cache alone; a hub's answer for a linked machine carries `sameAccountAsHub: true` when the limits are its own. `agents.account { tool }` is an opaque fingerprint of the login (`{ loggedIn, fingerprint }`) the hub compares with a machine's, never the email (#726). Additive |

The request and response types of the git, fs and workspace RPCs are **1:1 with the port interfaces**. Deliberate duplication — the port is the original contract, and the RPC carries it (a Tauri invoke would be a second carrier, if git or fs ever moved to Rust).

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

## 3.2 Retired methods and events ([#97](https://github.com/ijun17/centralu/issues/97), [#372](https://github.com/ijun17/centralu/pull/372))

Apps compiled into Centralu kept one JSON document and an on/off flag each, carried as `unknown` by `apps.state`,
`apps.setState`, `apps.setEnabled` and the `app_state_changed` event. The only such app, the control rail, was removed
in #372 (decided in #97). Those four left the protocol after it, together with `agents.createCoordinator`, which only
the control app's tasks called, from inside the host. Removing them changes no version (§4): each side already
survives the other not knowing a name.

| Retired | What an older peer sees |
|---|---|
| `apps.state`, `apps.setState`, `apps.setEnabled` | A window of v0.1.0-beta.10 or before attached to a newer host gets the host's unknown-method error (`internal`, not retryable: "Unknown method: apps.state. This Centralu host does not have it; the window may be from another build."). Its rail catches a failed read without a word and stands empty, turned on even where it had been turned off (it can no longer read that); its Settings toggle for the rail shows the message. Its rail tools already failed against a host of #372 (`apps.invoke` lost the control app there). Nothing else in that window calls them |
| `agents.createCoordinator` | No released window ever called it. A caller would get the same error |
| `app_state_changed` | A host of v0.1.0-beta.10 or before still sends it when its control app changes its document. A newer window drops it as an event type it does not know (§4) |

The stored rows (`app:control:*` in `app_settings`) are left where they are: a release that still has the rail may
open the same store. Coordinator sessions already in a store keep working (listed, read, woken, trashed), so
`coordinator` stays a session kind ([domain-model.md](domain-model.md) §1.1); only the way to create one is gone.
`control` stays a reserved app id (`RESERVED_APP_IDS` in `app-id.ts`) so no external app inherits those rows or the
coordinator sessions stamped with it.

External apps keep their state in their own process ([apps.md](apps.md)).

## 3.3 What a peer of another build loses ([#844](https://github.com/ijun17/centralu/issues/844))

A window and a host one or more builds apart meet often: a window stays attached to an older host until the person
switches (#280), a host swap keeps the previous build serving for a moment, and a hub links machines that run other
releases (#692). The rules in §4 make most additions free. These are the ones that still cost an older peer something,
with the build where each arrived, so a report from a mixed setup can be read against them.

**Approval cards.** An `approval_request` is an event, and an event that does not parse is dropped whole. From #844 on,
a card a window cannot read, of a kind it does not know or a known kind with a word it does not have, reads as an
`other` card instead (`ApprovalDetail`'s fallback, `about: 'unknown_card'`). It says first that it is a fallback and of
which kind (for a known kind, the values that did not read), then the projects, app or machine it names, then its own
text quoted and marked as not checked (often the asking agent's words), and last a line on why. It offers allow and
deny only, since "always" would remember a question the person never read in full; the host that raised it applies the
answer the way its own kind says. A hub refuses "always" for a linked machine's card it read this way (`unreadCard`),
since a window from before #844 on that hub would still offer it. A window from before #844 still drops such a card, and its session waits with no card on screen until a
window of the host's build answers it:

| Card | First build | A window before it |
|---|---|---|
| `project_create` (#515) | beta.16 | drops the card |
| `agent_start` (#561) | beta.17 | drops the card |
| `centralu_update` (#581) | beta.18 | drops the card |
| a remembered `agents` consent (#561), in Settings' list of consents | beta.17 | lists it without saying what it allows |
| the apply card (#665) and the handoff card (#694) | beta.23, beta.25 | reads them, since they ride on `other` |

So a new card kind that has to reach released windows rides on `other` with an `about`, the question whole in `raw`,
as the apply and handoff cards do; a kind of its own is for a card a generic one can stand in for.

**Words on events.** An enum carried on an event drops the event when a newer host widens it, unless it has a
fallback. Those with one: a notice's `level` and `audience` (#304, #342), an interruption's `reason` (#698), a
background task's `kind` (#290), the update `phase` (#844, read as `updating`, which shows the host's `error` text).
A window from before beta.18 drops every `update_status` while the host waits for npm (`waiting_for_npm`), and its
update line stays where it was.

**Event types an older window drops** (§4). Nothing breaks; the window misses what the event says until it reads the
same thing another way:

| Event | First build | A window before it |
|---|---|---|
| `projects_changed` | beta.16 | sees a project another window or an agent added or removed after its next reload |
| `session_live` | beta.18 | does not see a session go to sleep or wake (#568); the list says so on its next read |
| `update_apply_request`, `update_apply_go` | beta.23 | never answers an agent's apply card's request (#665): after 5 seconds the agent's call ends with "No Centralu window answered", which tells it to ask the person to click Apply now |
| `interruption`, `session_owner`, `orchestrator_proposals_changed` | beta.24 | shows no interruption line (#698); until it reads the list again, it keeps a moved child under its old owner and does not refresh the orchestrator's proposals |

**Fields an older host strips.** A field a newer window sends that an older host does not declare is dropped there
(§4). Where it changes what happens:

- `createSession`'s `handoff.removesOriginal` (#738, beta.25). A host before it moves only the predecessor's live
  children to the successor (#693, beta.24; none before that), and does not move the settled ones when the window
  then removes the predecessor: they stay with it in the trash, and come back with it if it is restored.

**Fields whose meaning moved.** `SessionInfo.askedBy` named the session of another project that asked for this one
(ask_project, #371); since #561 part 3 and #614 it names only the session that started this one in its own project
(start_agent), and store step v48 copied `parent_session_id` into it for former worktree managers' sessions. A window
of beta.20 or before shows a start_agent child as "asked by" its parent, which is now what it means. A host of beta.20
or before still writes the cross-project meaning; a newer host clears those rows once (store step v55,
[agent-host.md](agent-host.md) §5.1), and a row such a host writes after that keeps its mark, as that host showed it.

## 4. Schema and version rules (the C6 defence)

- Every message is defined by a zod schema and validated **only at the boundary** (once, on receipt. Re-validating internally is forbidden — performance).
- **A shape on the wire is declared once, here.** The host and the platform `import type` it (re-exporting it under an old local name where callers use one) instead of writing it out again: copies drifted (#428), a host `GitCommit` without `sessionName` and an error bundle without `sentAt`. A result shape is named (`FsEntry`, `FsFile`) rather than written inline in its method, so both sides can name it. A host type that only looks alike gets a name of its own (`ConsentRow` beside `ProjectConsent`, `IdleActivity` beside `SessionActivity`, the shell's `ShellHostBuild` beside `HostBuild`).
- `protocolVersion` is a single integer. Compatibility rules:
  - **Additions are free** (a new event type, a new optional field) — the version does not change.
  - The receiver **must ignore event types and fields it does not know** (a plain zod object drops a field it does not declare; an event of an unknown type is dropped whole).
  - **A word or a shape carried on an event has a fallback before anyone widens it** (#844). An event is parsed whole, so a value this build cannot read inside it (an enum's new word, an approval card's new kind) drops the whole event, not just the value. An enum on an event therefore carries a `.catch()` to the nearest honest word (`level` to `info`, an update `phase` to `updating`), and an approval card this build cannot read becomes an `other` card that says so (§3.3). A window released before a fallback existed still drops the event, so §3.3 lists what each such change costs it.
  - **A field added to a host payload must have a default, and the client applies it** (#280, #337). The two halves are one rule. Under the keeper a window can stay attached to a host of an older build until the person switches, so every field added after the first release may be missing from what the host sends. A `.default()` alone does not help: the window's types are the parser's output, so the code reads the field as always there, and that is true only if the payload went through the schema. Events always did (`parseServerFrame`); RPC results were `unknown` in the envelope and reached the screen as sent, and a beta.9 window on a beta.7 host crashed on a session list without `backgroundTasks` (#305). A new field is therefore either optional (and every reader handles its absence) or carries a default; a required field with no default can only arrive with a version increment.
  - **The client reads every RPC result through its method's result schema, once, where it arrives** (`RpcClient`, `parseRpcResult`), the way the host reads every RPC's params. The read is tolerant (`parseTolerant`): when the whole parse fails, the result is read again field by field and element by element, and a value that still fails on its own is kept as it came — so a word a newer host's enum has and this build's does not costs that one value, not the whole list. Measured on Node: a 200-session list takes 0.33 ms, a 200-row history page 0.03 ms. The test that guards the rule (`e2e/older-host.spec.ts`) runs the real UI against a real host with every defaulted field taken out of every result, event and handshake (`withoutDefaultedFields`).
  - Removing a field or changing its meaning = version increment = rejected at the handshake. **Avoid this wherever possible** — adding a new field and keeping the old one for one milestone is always cheaper.
  - **A whole method or event type can be removed without a version increment**, because the rules above already make its absence survivable: a client calling a method the host does not have gets the unknown-method error (`internal`, not retryable), which every caller has to handle anyway for a method added after its host (`agents.versions` on an older host, §3); a receiver drops an event type it does not know. Before removing one, read its callers in every release tag (`git grep <name> <tag>`) and check that each handles the failure, then list it in §3.2 with what an older peer sees. A removed name is never reused for something else.
- Golden tests: freeze sample message JSON per version as fixtures, and when the schema changes, CI verifies that the past fixtures still parse. A retired event type moves from the fixtures to the retired list next to them, which checks that it is dropped (§3.2).

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
- A call the hub could not pass to a linked machine because its link is down (§6) is `internal`, `retryable: true`, with `data: { machine, reason: 'unreachable' }`. A failure the remote host answered keeps its own code, `retryable` and `data`.
- An adapter's raw errors (SDK exceptions, process exit codes) are converted into this shape inside the host.

## 6. Linked machines ([#82](https://github.com/ijun17/centralu/issues/82), [plans/remote-hub.md](plans/remote-hub.md))

Every machine runs one host. The host a UI is attached to is that UI's **hub**: it links to the
hosts of other machines the person added (`machines.add`), each over the person's own `ssh`
([agent-host.md](agent-host.md) §4.8), and shows their sessions and projects as if they were its
own. The UI still talks to one host; everything here is additive, and `PROTOCOL_VERSION` stays 1.

- **Qualified ids.** An id another machine handed over reads `<machine>.<id>`: sessions, projects,
  terminals (`<machine>.term-3`), command runs, and ids inside results and events
  (`parentSessionId`, `worktreeManager.sessionId`, a message's `from.sessionId`). A machine id is
  lowercase letters, digits and hyphens, starting with a letter (`MachineId`), so the first dot
  ends it, and a qualified id still matches the session and project id pattern. **The UI never
  parses an id**: rows carry an explicit `machine` field (`SessionInfo`, `ProjectInfo`,
  `TrashedSession`, `ExternalAppInfo`, `ProjectConsent`, approval rules), absent or null for the
  hub's own.
- **Routing.** The hub sends a call to the machine its `sessionId`, `projectId` or `terminalId`
  names, and answers the rest itself. A per-machine question takes an optional `machine`
  parameter, absent meaning the hub: `agents.detect`, `agents.capabilities`, `agents.models`,
  `agents.usage`, `agents.versions`, `agents.setAutoApplyVersions`, `agents.applyVersions`,
  `agents.sleepPolicy`, `agents.setSleepPolicy` (#568),
  `projects.add`, `projects.create`, `projects.createPreview` (#515), `processes.strays`, `processes.stop`. Lists the UI rebuilds from
  (`sessions.list`, `projects.list`, `trash.list`, `subagents.usage`, `messages.search`, `apps.list`,
  `approvals.rules`, `projectConsents.list`) are merged across machines. A machine that cannot be
  reached is left out of the merge; `trash.list` and `subagents.usage` name those (`unreached`, #841) and `trash.empty`
  lists each as failed, so neither reads as the whole trash. The table, one entry per
  method, is `packages/agent-host/src/links/routes.ts`; a method added to the protocol does not
  compile until it is classified there.
- **Numbers.** An approval rule id from another machine is folded into a negative number (one
  range per machine), and `approvals.deleteRule` with it reaches that machine; no local rule id is
  negative, so a UI that does not know about machines can never delete a local rule with it.
  Process ids do not travel: `processes.strays` and `processes.stop` take the same `machine`.
- **What stays on the hub in phase 1.** The orchestrator and its tools, the coordinators
  already in its store, layout, grid, preferences, themes, updates, app imports and screen
  questions. A remote machine's own orchestrator and coordinators are not
  listed, and their events are not passed on. `fs.resolve` (a path for this computer's OS) is
  refused for another machine's project.
- **App views of another machine** ([plans/remote-hub.md](plans/remote-hub.md) §11). The instance
  is opened on the machine and reaches the UI qualified (`<machine>.<id>`: the `apps.openView` and
  `apps.inlineReopen` answers, `apps.inlineViews` rows, `app_view` events, an
  `external_app_state_changed` cause). `apps.viewFrame` stays on the hub, which serves every view
  from its own door, asking the machine `apps.viewDocument { instanceId }` (additive; answers
  `{ appId, projectId, uri, origin, resource }`, the app's `resources/read` answer as is).
  `apps.invoke`, `apps.readResource`, `apps.viewMessage` and `apps.closeView` go to the machine
  their instance, project or conversation names; one naming two machines, or a machine and the
  hub, is refused. A user-folder app has no project to name its machine, so `apps.openView` takes
  the optional `machine` (additive), and so do the calls of its panels and Restart: `apps.runs`,
  `apps.permissions`, `apps.forgetPermission`, `apps.usage`, `apps.setSecret`, `apps.versions`,
  `apps.restoreVersion`, `apps.builder`, `apps.createBuilder`, `apps.askBuilder`, `apps.errors`,
  `apps.sendError`, `apps.restart` (additive; [plans/remote-hub.md](plans/remote-hub.md) §11.9), and `apps.remove`,
  which then removes that machine's app and never this host's of the same id (§11.10).
  `apps.runs` rows come back with their session ids qualified.
  `messages.image` is read on the session's own machine, and the hub drops `file` from its answer: that path is on the
  other machine, so the window offers no reveal for it.
- **When a machine is away.** `sessions.list` and `projects.list` answer for it from the hub's
  headers mirror, each row marked `unreachable: true`, with `live` as last heard. The UI keeps
  those rows and does not wake them. Calls to it fail at once (§5).
- **Events.** A linked machine's session events reach the UI under the hub's own `seq`, with ids
  qualified; one about the remote host itself (`update_status`, `themes_changed`,
  `app_state_changed`, `agent_versions`, `external_app_questions_changed`,
  `orchestrator_proposals_changed`, an `error` with no
  session) is dropped. Terminal frames arrive with the qualified terminal id. `machine_status`
  carries a link's whole `MachineInfo` whenever its state changes. `machine_resync` says that what
  the UI holds about one machine has to be read again: it comes on every (re)connect of that link
  and when the machine is removed. The UI re-reads `sessions.list` and `projects.list` and runs its
  reconnect recovery for that machine's sessions alone: one it held as live that the fresh list
  says is not (the remote host restarted without a keeper) is woken.
- **`MachineInfo`.** `{ id, name, sshTarget, shell, wslDistro, command, status, error, versions,
  lastConnectedAt, localPort, sameLocalPort, hostStarted }`. `shell` is `posix`, `powershell` or
  `wsl`. `status` is `connecting`, `connected`, `unreachable`, `not_running` (Centralu answers
  there, no `centralu serve` runs, and the hub could not start one: `error` says why), `starting`
  (the hub is starting one, [plans/remote-hub.md](plans/remote-hub.md) §10.9 decision 7; additive,
  an older window reads it as `unreachable`), `versions_differ` or `refused`. `hostStarted` is
  null, or `{ how, at, note }` when the hub started that host: `detached` outlives the link,
  `link_bound` runs in the link's own ssh session because the machine blocks starting a process
  through WMI, and `note` says so. Additive. `elevated` (#702, additive) is what the machine's host said in its last
  hello (`hello_ok.elevated`): true when its agents run with administrator rights, null when it has not said.
  `install` is `{ managed, current, previous }`, each version `{ version, node, source? }`; `source` (#1036, additive)
  is `{ kind: 'dev', commit, dirty }` for a dev build made there from a commit (`pnpm remote-dev`), absent for a release.
  `connect` (#1134, additive) is `at_start` (the default, and what an older hub's rows read as) or `when_needed`: such
  a machine is not connected at start, and is connected while something needs it (the window has one of its projects
  or sessions open and says so with `machines.need` every 2 minutes, with `repeat` after the first, which does not undo
  the person's `machines.disconnect`; or an agent is started, sent work or read there),
  and while a session there is in a turn. `status` `disconnected` (#1134, additive; an older window reads it as
  `unreachable`) is a link closed on purpose and not tried: by `machines.disconnect`, at start for `when_needed`, or
  once nothing needed it for 10 minutes. `machines.reconnect` connects such a machine and keeps it so until
  `machines.disconnect`. `versions` is
  `{ hub, remote, older, compatible, sameChannel, accepted }`, each side
  `{ version, protocolVersion, dev }`: the link does not connect while the two run different
  versions, until they are aligned or the person declines (`machines.acceptVersions`, refused
  when the protocols differ). The prompt names `older`; a dev build has no older and connects on
  one protocol.
- **The reverse direction is off.** The link is a client connection the hub opened; the protocol
  has no frame for a host to call its client, and the hub drops anything shaped like one.

