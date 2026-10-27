# The shared session core (#1654)

Proposed 2026-10-27. Part of #59 and #1599. Owner order (#59, 2026-10-26): the OS seam, then one session core that the
Claude, Codex and ACP adapters share, then Antigravity (`agy`) as the first new tool on it
(`antigravity-adapter.md` on branch `feat/agy-adapter`). A design to agree on before code: what
the three adapters do today, side by side (§1); where one concept is computed twice and which copy is right (§2); what
the core owns and what stays per tool (§3); the seam (§4); how the core reaches processes through `Os` (§5); how
recorded frames test it (§6); the pull requests (§7); Antigravity on it (§8). A record like the rest of `plans/`, so not
mirrored in Korean. This document lands in the first code pull request (owner rule); nothing on screen changes.

Measured against main at `ef5bb172c` (2026-10-27), #1626 (`centralu/kp1618-resume`) and #1650
(`centralu/os-interface`), by reading the code; nothing was run. Paths are under `packages/agent-host/src/adapters/`
unless they say otherwise. Line numbers are main's.

## 1. What each adapter does today

Marks: **S** the same in all (shared code already), **I** the same idea in different code (the core's to own),
**T** truly per tool (stays with the tool).

| Concern | Claude | Codex | ACP (Cursor, OpenCode) | Mark |
|---|---|---|---|---|
| Process start | the Agent SDK's `query()` starts it through `spawnClaudeCodeProcess` (`claude/sdk-query.ts:146`), which calls `spawnLocalAgent` or the keeper (`claude/session.ts:213`, `spawnProcess:428`); args built by the SDK | `CodexClient` (`codex/client.ts:95`) `spawnLocalAgent(codexLaunch(...) + app-server)`; keeper: `launch-config.ts:spawnInKeeper:183` | `AcpAdapter.createSession` (`acp/adapter.ts:48`): `profile.launch` → `processSource.spawn` or `spawnLocalAgent({endsWithHost: true})` (`:58`) | **I**: one start path, three call sites; the launch spec is **T** |
| Ending with the host | not set: relies on stdin EOF and the SDK's TERM | not set: relies on stdin EOF (`client.ts:91`) | `endsWithHost: true` (`HOST_WATCH`, `local-process.ts:44`), `noteTree` every 2 s while a shell runs (`acp/session.ts:watchCommands:314`) | **I**, differs (§2.6) |
| Stop and kill | `query.close()` (SDK: EOF, then TERM; on Windows the SDK waits 2 + 5 s), `ClaudeAdapter.settle` waits `exitGraceMs` on Windows (`claude/index.ts:469`) | `CodexClient.dispose:247`: EOF, `waitForExit(2000)`, SIGKILL | `AcpConnection.dispose:259`: EOF, 2 s, SIGKILL; `session/close` first if advertised (`acp/session.ts:548`) | **I**; the tree kill under it is **S** (`LocalAgentProcess.kill:207`, `kill-tree.ts`) |
| Stream framing | the SDK parses stream-json; the adapter sees typed messages (`ClaudeSession.read:262`) | `lineSplitter` + JSON-RPC routing, random id prefix (`client.ts:128`, `onLine:154`, `request:216`) | `lineSplitter` + JSON-RPC routing, random id prefix (`acp/connection.ts:163`, `onLine:188`, `idPrefix:157`) | **T** (Claude), **I** (Codex and ACP: two JSON-RPC clients) |
| stderr | 8 KB tail (`LocalAgentProcess.stderrTail:190`), `withStderrTail` (2,000 chars) on a crash | the same, `withStderrTail` | console per line (500 chars), the last 5 lines inline on a crash (`acp/session.ts:onExit:512`) | **S** tail, **I** message (§2.5) |
| Turn start and end | `deliver:540` opens, a `result` closes (`:350`); a turn the CLI starts is seen by `user_message_uuid` | `turn/start` (`codex/session.ts:sendInput:522`), `turn/started` and `turn/completed`, `CodexTurns` (`codex/turns.ts`) | `enqueue:223` → `run:245` (`session/prompt`), its answer's `stopReason` ends it (`endTurn:278`) | **I** ledger, **T** wire |
| Input during a turn | mid-turn (the SDK's input generator), `turnInputs()` | merged into the running turn by Codex; queued behind a blocking `/compact` or `/review` (`pendingInputs`, `flushPending:591`) | queued by the host, one prompt at a time (`midTurnInput: false`) | **I**: a host queue exists twice (Codex blocking turns, ACP) |
| Interrupt | `query.interrupt({cancelQueued})` (`interrupt:653`), stop-confirm timer 10 s (`awaitStop:726`) | `turn/interrupt` (`interrupt:683`); refused → `stopNotConfirmed`; no timer | `session/cancel` (`interrupt:351`), timer 10 s, cancel re-sent once (`resendLostCancel:410`) | **I** (§2.4); the request is **T** |
| An interrupt nobody here asked for | not possible | `INTERRUPTED_BY_TOOL` (`codex/session.ts:467`) | `INTERRUPTED_BY_TOOL` (`acp/session.ts:289`) | **I** |
| Input receipts | `InputReceipts` (`create`, `accept`, `complete`, `failAll`) when the CLI has the receipt capabilities (`claude/tracked-input.ts:10`) | `InputReceipts` (`create`, `bind`, `endTurn`, `failAll`), `clientUserMessageId` | not used: drives `InputObserver` by hand (`run:249`, `:268`); a stopped input completes | **I**, differs (§2.3) |
| Undelivered input on exit or dispose | `undeliveredError` (`session-kit.ts:32`) | the same, plus `reportUnsentWhileWaking:778` | the same, `dropQueue:520` | **S** |
| Resume | SDK `resume` option (`sdk-query.ts:211`); id from `system/init` | `thread/resume` (`thread-open.ts:60`), `resumeFailure:129` (`conversation_locked`), lazy resume (`LAZY_RESUME_WAIT_MS` 3 s, `background-resume.ts`) | `session/load`, else `session/resume`, else `session_not_found` (`acp/session.ts:open:140`); replay dropped while loading | **T** |
| History read-back | SDK `getSessionMessages` (`claude/history.ts:123`) | `thread/turns/list` paged (`codex/history.ts:88`), fallback `thread/read` | none (`external-conversations.ts` skips ACP tools) | **T**; the output shape is **S** (`history-events.ts`) |
| Approvals: transport | in-process `canUseTool` callback (`claude/session-cards.ts:69`) | server requests (`codex/server-requests.ts:114`) | `session/request_permission` (`acp/session.ts:onRequest:428`) | **T** |
| Approvals: decision order | own tools, request-turn reads, `auto`, unasked app tools, granted reads, the `edits` grant, AskUserQuestion, always-allow, card | always-allow, the `edits` grant (`mayGrantEdit:224`), card; elicitations by server | `auto`, Centralu's tool (`profile.centraluToolOf`), the `edits` grant, always-allow, card (`grantedWithoutCard:452`) | **I** (§2.7); `PendingCards`, `CardIds`, `AlwaysAllowRules`, `insideFolder` are **S** |
| Presets → tool | `permissionOptionsFor` (`claude/permissions.ts:90`): permission mode, setting sources | `permissionOptionsFor` (`codex/launch-config.ts:25`): approval policy and sandbox | Cursor: `auto` only; OpenCode: inline config at launch (`opencode/config.ts:presetEnv:29`) | **T** |
| Compaction boundary | `system/compact_boundary`, trigger from the tool (`claude/cli-messages.ts:181`) | `contextCompaction` item and the old `thread/compacted`, deduplicated (`codex/normalize.ts:CompactionMarks:54`); manual when our compact turn runs (`codex/session.ts:425`) | `compaction_update` (`acp/normalize.ts:208`); manual when our compact turn runs (`acp/session.ts:285`); OpenCode infers it (`inferredCompaction:346`) | **I** (manual vs auto), **T** (signals) |
| Context reading | `getContextUsage()` after each result (`reportContext:605`): `window > 0 && used >= 0` | `thread/tokenUsage/updated` `last` over `modelContextWindow`; above the window dropped (`codex/token-readings.ts:42`, `:90`) | `usage_update` when `used > 0 && size > 0` (`acp/session.ts:384`) | **I**, differs (§2.2) |
| Token usage | process total, shared `token-usage.ts` (`tokenCount`, `addTokens`) | thread total, own `splitInput` and `finite` | one turn's, own `tokenUsage` (`acp/normalize.ts:220`) | **I**, differs (§2.1) |
| Files touched | `TouchedFiles` (after an ok result, #843) | at item completion (after it ran) | on the call, before any approval (`acp/normalize.ts:175`) | **I**, differs (§2.8) |
| Images | `inlineImageEvent` (8 MB cap) | `mcpImageEvents`, `imageEventFromDisk` | `message_image` built inline, no cap (`acp/normalize.ts:64`) | **I**, differs (§2.9) |
| Unknown frames | `UnmappedTypes` + `CLAUDE_KNOWN_TYPES` | surface drift (`codex/surface.ts`) | `UnmappedTypes` + `KNOWN_UPDATES` | **S** |
| Recorded frames (#1498) | none | none | `frameRecorder` wired in `acp/adapter.ts:52` through `AcpConnection`'s `onFrame` (now the process tap, §6.1); 19 recorded scenarios replayed (11 Cursor, 8 OpenCode) (`acp/replay.test.ts`) | **I**: only ACP records (PR 1 moved it to the process tap and added Codex, §6.1) |
| Crash vs asleep | stream ends while not closed or detaching → `adapter_crashed` (`read:294`) | idle → `session_live asleep`, else `adapter_crashed` (`codex/session.ts:168`) | idle and open → asleep, else `adapter_crashed` (`acp/session.ts:onExit:495`) | **I**, differs (§2.5) |
| Retries shown | `RetryActivity` via `system/api_retry`; sign-in race resend (`claude/refresh-race.ts`) | `RetryActivity` via `willRetry` | none | **S** helper, **T** signal |
| Host swap: detach | `detach:469`: `proc.detach()`, no signal | `detach:812`: `client.detach()`, no signal | none: no `detach` | **I** |
| Host swap: adopt | takes over the running turn; lost in-process calls interrupted (`releaseLostCalls:445`); tasks seeded | takes over: "Already initialized" accepted, running turn found (`thread-open.ts:220`), approvals re-sent by `thread/resume` | SIGKILL the adopted process, close its open calls as failed, reopen with `session/load` (`acp/adapter.ts:closeAdopted:88`), `takesOverTurn = false` | **T** (what the wire allows), **I** (open calls closed) |

What the table says: the wire (framing, requests, history, resume, presets) is per tool and stays so. The life around
it, a process, a ledger of turns and inputs, the stop, the cards and their decision order, the exit, the frames, and
the event hygiene, is the same idea written three times, with real differences in a dozen places (§2).

## 2. One concept, more than one copy

Each is a finding to decide, not a silent choice. "Right" below says which copy the core should take and why; where a
copy is wrong today the fix is its own small pull request (§7.3), never folded into a move, so a move stays a move.

### 2.1 Token usage: a running reading, or one turn's

`usage_update.tokens` is "a running reading" (`protocol/src/events.ts:443`, `entities/usage.ts`: Claude's result is
cumulative over the process, Codex's `total` over the thread), and the host keeps the last one as is
(`sessions/session-events.ts:441`, `m.usage = e.tokens`).

| | Sends | Sanitizing |
|---|---|---|
| Claude `turn-ending.ts:61`, `normalize.ts:withRequest:330` | the process total plus each request since; `costUsd` = `total_cost_usd`; a `request` per model request | `tokenCount` (rejects NaN, negatives, non-numbers) |
| Codex `token-readings.ts:42` | the thread's `total`; a `request` per change of `last` | `finite` (lets a negative through; input clamped by `splitInput:19`, output not) |
| ACP `acp/normalize.ts:tokenUsage:220`, `acp/session.ts:283` | **this turn's** `PromptResult.usage`; `costUsd` is this turn's delta (`turnCost:337`); no `request` | `?? 0` on schema numbers; `thoughtTokens` added to output |

**Right:** Claude's and Codex's (the contract). An ACP session's token figure is one turn's where the others show the
session's, and it feeds nothing to the prompt cache ledger (by reading; the screen effect not checked). The core's
`events.ts` keeps a running sum for a tool that reports per turn, through `tokenCount`. A fix with its own pull
request (§7.3); can start now.

### 2.2 The context reading's guard

Three guards for one `context_update`:

| | Emits when | Drops |
|---|---|---|
| Claude `reportContext:605` | `window > 0 && used >= 0` | nothing else; a `used` of 0 is shown |
| Codex `tokenUsageEvents:42` | a window is found | a reading above the window (logged once) |
| ACP `acp/session.ts:384` | `used > 0 && size > 0` | a 0 (measured: a cancelled turn reads 0 just before it ends) |

**Right:** Codex's upper bound for every tool (a share above 1 is a misread field, never a full context), and ACP's
zero rule for every tool whose 0 is a transient (ACP, measured); Claude's read happens after a result, where 0 is not
seen in practice (assumed, not measured). Proposed core rule: `window > 0 && used <= window`, with "0 means no reading"
a per-tool flag. Adding the upper bound to Claude and ACP is a behaviour change on an impossible input only: its own
pull request (§7.3).

### 2.3 Input receipts

Claude and Codex use `InputReceipts`; ACP calls `InputObserver` by hand and keeps its own `done` promise. They differ
in two places:

| | `accepted` | An input whose turn was stopped |
|---|---|---|
| Claude | the CLI echoes `user_message_uuid` (`claude/session.ts:346`) | fails (`failAll` on interrupt, `:665`) |
| Codex | the `turn/start` answer binds it (`codex/session.ts:640`) | fails (`failAll`, `:681`) |
| ACP | **before** `session/prompt` is written (`acp/session.ts:249`) | **completes**: a `cancelled` stop reason is a result, so `observer.complete()` and `done.resolve()` (`:272`) |

`InputObserver.accepted` means "the tool took the input" (`contract.ts:282`). **Right:** Claude's and Codex's: a
stopped input fails, so a stopped delegation is not reported as finished (by reading). ACP accepting at the write is
the nearest it can say (`session/prompt` has no earlier answer), so that one is per tool. ACP also does not mint ids
through `InputReceipts.create`, so after #1626 its inputs carry no Centralu mark (`centraluInputId`); nothing reads it
for ACP today (no history read-back). The ledger uses `InputReceipts` for all; ACP's "stopped completes" is a fix
with its own pull request (§7.3), before ACP moves onto the ledger, so the move stays a move.

### 2.4 Stop confirmation

Claude and ACP start a 10 s timer after a Stop and say `stopNotConfirmed` when no confirmation comes; ACP also re-sends
`session/cancel` once. Codex has no timer: it says `stopNotConfirmed` only when `turn/interrupt` is refused. The
constants are separate (`STOP_CONFIRM_MS` in `claude/index.ts:168` and `acp/adapter.ts:13`), and the notices say it
differently ("…after N s. The turn is still running." against "…; the turn may still be running."). What a Stop
releases differs too: Claude releases approvals and questions and cancels app calls; Codex denies this thread's
approvals and cancels app calls; ACP closes approvals and leaves app calls (`opts.apps` untouched). Claude's comment
says it waits "the way Codex waits for its `turn/completed`", which Codex does not bound. **Right:** the timer
(Claude and ACP): a Stop the tool accepted and never acted on is the case the timer exists for, and Codex's
`turn/interrupt` answer is an acceptance, not a confirmation that the turn ended. Codex gaining the timer is a visible
notice in a case that today shows nothing: a behaviour change, its own pull request, and an open question (§9.2).

### 2.5 The exit: crash or asleep, and its message

| | Idle exit | Exit in a turn or while opening | Message |
|---|---|---|---|
| Claude | `adapter_crashed` (any exit not ours) | `adapter_crashed` | the SDK's error + `withStderrTail` (last 2,000 chars) |
| Codex | `session_live asleep` (#1397) | `adapter_crashed` | `codex app-server exited (code N)` + `withStderrTail` |
| ACP | `session_live asleep` | `adapter_crashed` | `<label> exited (code N): <last 5 stderr lines>` |

**Right:** Codex's rule (#1397: a process that goes while nothing runs is asleep, not crashed), which ACP follows.
Whether Claude can see an idle exit at all is the open part: Claude Code exits on its own only on a crash or a kill
(assumed); a Mac logout kills an idle Claude session as well, so the #1397 reasoning applies. The message: one format,
`withStderrTail`'s, since `failureSentence` (`sessions/interruptions.ts:48`) cuts at `stderr:` and ACP's inline tail
has no such marker, so a word in Cursor's stderr can be read as the turn's network failure (by reading). Both changes
are their own pull requests (§7.3).

### 2.6 Ending with the host

Only ACP starts behind `HOST_WATCH`. Claude and Codex rely on stdin EOF when the host dies (#57). EOF ends the CLI,
and the CLI ends its MCP servers, unless the CLI is wedged; `HOST_WATCH` ends the group whatever the CLI does (#1562
review: Cursor with the bridge outlived a SIGKILLed host). **Right:** `endsWithHost` for every locally started CLI
(the stronger guarantee; Claude and Codex were never measured to outlive a host, assumed safe). It changes what runs
on macOS and Linux: its own pull request, after the process seam, with a real-OS test per tool (§9.3). Decided (#1654,
Q3): part of the process seam itself; done in PR 3 (§5.1).

### 2.7 The approval decision order

The steps are the same set, in three orders:

| Step | Claude | Codex | ACP |
|---|---|---|---|
| Centralu's own tools allowed | 1 | (elicitation by server) | 2 |
| `auto` | 3: **deny** (in `bypassPermissions` the callback is reached only when the person's `ask` rule matched; `claude/session-cards.ts:104`) | (the tool's policy allows; no request comes) | 1: **allow** |
| `edits` grant inside the folder | 6 | 2 | 3 |
| always-allow rule | 8 | 1 | 4 |
| card | 9 | 3 | 5 |

The order matters only where two steps answer differently. The "allow" steps commute. The one "deny" step is Claude's
`auto`, and Claude puts Centralu's own tools before it on purpose (#382: an `ask` rule naming `mcp__centralu` used to
refuse them in `auto`); ACP's `auto` allows, so its place does not change an outcome. Claude's extra steps
(request-turn reads, unasked app tools, AskUserQuestion) are Claude features. **Right:** one ordered pipeline in the
core, `own tool → tool's pre-steps → auto → edits → always → card`, where `auto`'s answer is the tool's (Claude: deny,
ACP and `agy`: allow) and each tool supplies only the classification of a call (its kind, paths, server). This keeps
every current outcome (by reading): no behaviour change.

### 2.8 Files touched before the call went through

`TouchedFiles` (`file-changes.ts:55`) marks a file "edited by agent" only after an ok result (#843: a denied edit used to
mark the file). ACP emits `files_touched` when the call is first announced (`acp/normalize.ts:175`), before
`session/request_permission` is answered, so an edit the person denies in an OpenCode session still marks its files.
**Right:** `TouchedFiles`. A bug today (by reading; not reproduced): its own fix pull request, which can start now.
Codex differs on purpose and stays so: it marks a failed patch too, since a patch is applied file by file and the item
does not say which files were written before it failed, and marks nothing for a declined one
(`codex/normalize.ts:224`). The core's rule is therefore "never before the call went through; a failed call is marked
when the tool cannot say what it wrote", which `TouchedFiles.result` takes as a per-tool flag.

### 2.9 Images without the cap

`images.ts:inlineImageEvent` caps an inline image at 8 MB (the event travels over the socket to the UI). ACP emits
`message_image` with the agent's data as is (`acp/normalize.ts:64`). **Right:** `inlineImageEvent`. A bug on a large
image (by reading): its own small fix.

### 2.10 Smaller copies

| Concept | Copies | Agree? |
|---|---|---|
| Edit paths of a call | `acp/normalize.ts:pathsOf:240`, `acp/session.ts:editPaths:565`; Claude `tool-summary.ts:editedPaths:57`; Codex `items.ts:fileChangesOf:189` | ACP's two agree with each other; each reads its tool's shape (**T**), the two ACP copies become one |
| Approval card detail | `claude/tool-summary.ts:approvalDetail:139`, `codex/approvals.ts:approvalDetailFrom:30`, `acp/session.ts:detailOf:573` | per tool shape over the shared `fileEditDetail`; stays per tool |
| Tool titles | `claude/tool-summary.ts:toolSummary:19`, `codex/items.ts:itemSummary:86` (says it follows the same rule), `acp/normalize.ts:summaryOf:245` | per tool names over shared `tool-titles.ts`; stays per tool |
| Account usage snapshot | `claude/usage.ts:toSnapshot:40`, `codex/usage.ts:toSnapshot:40` | the same output shape from different sources; stays per tool |
| Manual vs auto compaction | Codex `session.ts:425`, ACP `session.ts:285` (our compact turn running); Claude from the tool's `trigger` | the same rule where the tool does not say; the core owns "our compact turn is running" |
| Duplicate compaction signals | `codex/normalize.ts:CompactionMarks:54` | one copy; the core takes it as the boundary filter for any tool with two signals |
| JSON-RPC client | `codex/client.ts`, `acp/connection.ts` | the same framing, id prefix and pending map; differ in Codex's missing `jsonrpc` field and its 120 s default timeout; a shared client is possible but not needed for the core (§3.3) |

### 2.11 More differences, each to decide

| Concept | Copies | Difference | Right |
|---|---|---|---|
| Refusal and turn-limit endings | Claude `normalize.ts:472`, `turn-ending.ts:85`; ACP `acp/session.ts:291`; Codex `model-rejected.ts:62` | Claude: a failed turn is a retryable `error`, `error_max_turns` too; ACP: `refusal` a non-retryable `error` without `turn_complete`, `max_tokens` and `max_turn_requests` a notice and `turn_complete`; Codex: non-retryable only for a rejected model | undefined by any document: an open question (§9.7); the ledger takes `turnEnded(how, detail)` and each tool keeps its mapping until decided |
| Diff preview on a card | Claude `tool-summary.ts:claudeFileChange:113` (`diffLines`); Codex the vendor's diff; ACP `acp/session.ts:detailOf:577` (`newText` only, `oldText` parsed and ignored) | the `other` card's raw text is cut at 300 characters in Claude (`tool-summary.ts:147`), 2,000 in Codex and ACP | a diff from `oldText` and `newText` for ACP (`file-changes.ts:11` means one preview rule); the 300 against 2,000 cut is a question for review |
| An emptied plan | `plan.ts:todoWritePlan:31` and ACP send it (clears the panel); Codex drops it (`codex/normalize.ts:135`, `plan.length > 0`) | a cleared Codex plan stays on screen (by reading) | `plan.ts`'s rule; a small Codex fix |
| Compaction `reason` | ACP puts the summary's first line in `reason` on success (`acp/normalize.ts:208`); the protocol and the UI read `reason` only on failure (`ui/src/store/transcript.ts:432`) | drift, nothing shown | the protocol's meaning; ACP drops it on success (no visible change) |
| The live usage limit | Claude acts only on `rejected` and sets `windowMins` only for `five_hour` (`turn-ending.ts:22`); Codex always reads the primary window (`codex/normalize.ts:281`), even when the weekly one was hit | the same window labelled "5 hours"/"Weekly" (Claude, `usage.ts:25`) or "5h"/"1w" (Codex, `usage.ts:17`) | per tool sources, one label rule: an open question (§9.8); not core |
| Closing the process | `CodexClient.dispose:247` and `AcpConnection.dispose:259`: the same code (EOF, 2,000 ms, SIGKILL); Claude through the SDK's `close()` | agree | the core's stop (PR 3), one copy |
| `safe` preset | Claude `default` (the person's allow rules still apply); Codex `untrusted` (asks about everything) | assumed different in effect, not measured | to check; presets stay per tool |
| stderr host-log line | `codex/client.ts:130`, `acp/connection.ts:80`: the same 500-character line | agree | the core's tap, one copy |

## 3. What the core owns

### 3.1 The core

`adapters/core/`, tool-neutral, no wire knowledge:

| Module | Owns | Today in |
|---|---|---|
| `tool-process.ts` | starting a tool's process (local, keeper, adopted, replayed), the tap that records its frames, its stderr tail, its exit, the stop (EOF, the stop bound, the tree), `detach` | `local-process.ts`, the three spawn sites, `frames/recorder.ts`, the three `dispose`s |
| `ledger.ts` | the session's phase (`opening`, `ready`, `closed`), the turn that runs, the input queue for a tool without mid-turn input or in a blocking turn, the `InputReceipts`, the Stop and its confirmation timer, "interrupted by the tool", undelivered input on exit and dispose, crash vs asleep | the three `session.ts` |
| `grants.ts` | the decision order of §2.7 (with the tool's `auto` answer) over `AlwaysAllowRules`, `insideFolder`, the preset; the cards (`PendingCards`, `CardIds`) and releasing them on stop, exit and dispose | `claude/session-cards.ts`, `codex/server-requests.ts`, `acp/session.ts` |
| `events.ts` | the hygiene every tool's events pass: `TouchedFiles`, the image cap, token totals, the context guard (§2.2), compaction marks (dedupe, manual when our compact turn runs), `RetryActivity`, `UnmappedTypes` | the shared helpers plus their per-tool bypasses |

`session-kit.ts`, `input-receipts.ts`, `file-changes.ts`, `images.ts`, `token-usage.ts`, `retry-activity.ts` and
`unmapped.ts` stay where they are; the core uses them. The core is what *calls* them in the same place for every tool.

### 3.2 Per tool

The wire and the tool's own meaning: launch spec and detect; framing (the SDK for Claude, JSON-RPC for Codex and ACP,
stream-json lines for `agy`); requests for a turn, a steer, an interrupt, a card's answer; history and resume; the
mapping from frames to `NormalizedEvent`s (normalizers, `known-*.ts`); presets to flags or config; what a host swap can
take over (`takesOverTurn`); features one tool has (Claude's goals, sign-in race, AskUserQuestion; Codex's review,
fork and child threads; ACP's profiles).

### 3.3 Not in the core

- **The Agent SDK.** It owns Claude's stdin and stdout. The core gives it the process (`spawnClaudeCodeProcess`) and
  taps the pipes it returns, so Claude's frames are recorded like every other tool's, but the core never parses them.
- **A shared JSON-RPC client.** Codex's and ACP's clients are near copies, but merging them changes no behaviour and
  helps no other tool (`agy` and Claude are not JSON-RPC). Left for later.
- **Session-level host logic** (`sessions/`, `lifecycle/update-resume.ts`, the restart policy): above the adapters,
  unchanged.

## 4. The seam

The core drives a tool through one small interface; the tool calls back through another. Types only, to be written in
`adapters/core/seam.ts` (names may change in review; the shape is the proposal):

```ts
/** What the core needs from a tool: its wire. One per session. */
export interface ToolWire {
  readonly label: string                      // "Claude Code", "Codex", "Cursor": for messages
  readonly turns: {
    midTurnInput: boolean                     // false: the core queues (ACP, agy); true: sent at once (Claude, Codex)
    interruptEndsProcess: boolean             // agy: a Stop ends the process; the next input starts a new one
    confirmsStop: boolean                     // the tool ends the turn after a Stop (timer applies); §2.4
  }
  /** What `auto` answers for a call that reaches the decision order (§2.7): Claude deny, ACP and agy allow */
  readonly autoGrant: 'allow' | 'deny'
  /** The process to start for this conversation, asked again for every new process (`ToolLaunch`, §5.1): agy needs a
   *  new one with `--conversation <id>` after every Stop and every model or effort change. `null`: not installed */
  launch(resume: { externalId: string } | null): Promise<AgentSpawnSpec | null>
  /** Opens or resumes the conversation on a started process; the core has already tapped it */
  open(io: CoreIo, resume: { externalId: string } | null): Promise<{ externalId: string | null }>
  /** Writes one input; `blocking` turns (Codex /compact, /review) say so in the answer */
  startTurn(input: TurnInput): Promise<{ toolTurnId?: string; blocking?: boolean }>
  steer?(text: string): Promise<boolean>      // a nudge into the running turn (Codex `turn/steer`)
  interrupt(): Promise<void>                  // rejects when the tool refused
  answer(card: CardRef, decision: GrantDecision): void
  /** The conversation's end for this process; the core then stops the process with its bound */
  close(how: 'dispose' | 'detach'): Promise<void>
  /** A process a previous host left: take over its turn, or not (then the core stops it and reopens) */
  adopt?(adopted: AdoptedProcess): Promise<'continues' | 'reopen'>
}

/** What the tool gives back to the core */
export interface CoreIo {
  readonly process: ToolProcess               // its pipes, tapped; `stderrTail()`; `noteTree()`
  emit(event: NormalizedEvent): void          // through `events.ts` hygiene, then the host's sink
  turnStarted(info: { toolTurnId?: string; inputIds?: readonly string[] | null }): void
  turnEnded(how: 'complete' | 'interrupted' | 'failed', detail?: { error?: NormalizedError }): void
  inputAccepted(inputId: string): void        // the tool took it (receipts)
  externalId(id: string): void                // an id the tool said after `open` (agy: in `init`, after the first input)
  grant(call: GrantQuery): Promise<GrantDecision>  // §2.7's order; raises the card when it must
}

/** A call as the decision order reads it; built by the tool from its own frame */
export type GrantQuery = {
  callId: string
  kind: 'read' | 'edit' | 'execute' | 'mcp' | 'subagent' | 'other'
  paths?: readonly string[]
  server?: string                             // an MCP server: Centralu's own is allowed
  alwaysAllowKey: string                      // the tool's matcher text (`alwaysAllowKey`)
  card: () => ApprovalRequestEvent            // built only when a card is needed
}
```

`SessionHandle` (`contract.ts`) does not change: a `CoreSession` implements it once over a `ToolWire`, and each
adapter's `createSession` returns one. Optional `SessionHandle` methods a tool lacks stay absent (the capability rule:
presence means supported).

The Claude wire is the SDK: `startTurn` pushes to the SDK's input generator, `interrupt` is `query.interrupt`,
`answer` resolves the pending `canUseTool` promise, `open` is `query()`. Nothing the SDK does moves.

### 4.1 As built in PR 5

`core/seam.ts` and `core/ledger.ts` (`CoreSession`), with ACP the first tool on them (`acp/session.ts`: `AcpWire`, and
`AcpSession`, a `CoreSession` that adds ACP's card and command methods). What changed from the proposal above, and why:

| Proposal | As built | Why |
|---|---|---|
| `CoreIo.turnStarted`, `turnEnded(how, detail)` | the core starts every turn (`state_change working`, then `startTurn`) and hands the wire a `RunningTurn`: `stopAsked` to read, `end(ending, events?)` to end it | the turn the tool ends is always the one it was handed, so a late answer for a turn already over is dropped by identity, not by guessing; a tool that starts turns of its own (Codex's, PR 6) adds `turnStarted` then |
| `turnEnded('failed', { error })` | `TurnEnding`: `complete`, `interrupted`, or `failed` with the `error` event and `inputError` (null: the input completes) | ACP's refusal is an error whose input completes (§2.11); Q7's change makes the endings one, and then `inputError` goes |
| (none) | `events` on `end`: the tool's own end-of-turn events (usage, a limit's notice), emitted after the turn's open calls end and before the core's ending event, and only when the end is taken | keeps today's order of events exactly, and counts no cost for a turn the session no longer runs |
| (none) | `turnOver(why?)` and `releaseCards()`: the core says when, the wire still holds its open calls and cards | the cards move into the core with the decision order (PR 8); until then the core calls `releaseCards` on a Stop, at a turn's end, on an exit and on the close, and `turnOver` at a turn's end, on an exit and on the close (`why`: "Centralu stopped this session while the call ran") |
| `CoreIo.process`, `externalId(id)` | the same, one `CoreIo` per process, plus `gates` (`SessionProcess.gates`) | an id from a replaced process changes nothing (`noteExternalId(id, from)`) |
| `interrupt()` | optional; a tool whose Stop ends its process has none, and the core signals it (`SessionProcess.interrupt`: the open gate requests are denied first) | `agy` has no Stop on its wire |
| `close(how)` | `close({ turnRunning })`, then the core stops the process (`SessionProcess.close`) | ACP sends `session/cancel` first when closed mid-turn; `detach` is no ACP feature (no `SessionHandle.detach`) |
| `autoGrant`, `answer`, `grant`, `steer`, `adopt`, `blocking` | not yet | the decision order is PR 8; `steer` and blocking turns are Codex's (PR 6); `adopt` is Codex's and Claude's |

What the ledger owns now, one copy for every tool on it:

- **The phase and the queue.** `opening`, `ready`, `closed`. A tool without mid-turn input (`midTurnInput: false`) gets one
  input at a time, the rest wait in order; with it, an input sent mid-turn joins the running turn, and the turn's end
  settles them all.
- **The receipts** (§2.3): every input has an `InputReceipts` receipt; the wire says when the tool took it
  (`CoreIo.inputAccepted`: ACP at the write); a turn our Stop ended fails its inputs; an exit fails the turn's inputs
  with "`<label>` exited (code N)", and the queued ones with the undelivered count and its `error` event; the close fails
  them with "the session closed". `turnInputs` names the inputs the last turn took by the host's names.
- **The Stop** (§2.4): `stopAsked` on the turn, the wire's own Stop, the cards released, and the 10 s timer
  (`STOP_CONFIRM_MS`, now one constant for ACP; Claude's own copy in `claude/index.ts` goes with PR 7) for a tool with
  `confirmsStop`. The notice reads ACP's words ("`<label>` has not confirmed the stop; the turn may still be running.");
  Claude's differ ("…after N s. The turn is still running."), so PR 7 takes ACP's words or keeps its own as a visible
  change of its own, not inside the move.
- **"Interrupted by the tool"**: an `interrupted` ending without our Stop is `INTERRUPTED_BY_TOOL`, and its input completes.
- **The exit** (§2.5): the core watches the process from its start (`SessionProcess`'s `onStart`, before the wire reads
  it), `exit` and a failed start (`error`) alike, once. In a turn or while opening it is `adapter_crashed` with
  `withStderrTail`'s message; idle, `session_live` asleep. ACP's `AcpConnection.onExit` no longer decides it: the
  connection only fails the requests it had open, and `close()` marks this side's own stop as expected.
- **A Stop that ends the process** (`interruptEndsProcess`, `agy`): the process is marked as ending by our hand, the gate
  requests are denied, then SIGINT. Its exit is the Stop's confirmation and ends the turn as `interrupted` if the tool did
  not say so first. The next input asks `launch` again with the conversation's id (`relaunch`, or `start` once the old
  process is gone), opens it (the session is `opening` again, so an exit then is a crash), and goes on; nothing starts
  until an input comes. A new process that cannot start or open is a crash, like an exit while opening: the inputs
  waiting are undelivered, and the process is stopped, not left running.
- **A wire that cannot write an input**: `startTurn` throwing ends that turn as `failed`, and the queue goes on.

The core tests (`core/ledger.test.ts`) run a scripted wire in memory against a small model of the above: 150 random
sequences each of inputs, Stops, the tool's endings, exits and the close, for an ACP-like tool, a tool with mid-turn
input, and an `agy`-like tool (`midTurnInput: false`, `interruptEndsProcess: true`, its id said at the first input), and
compare the ledger's events, what the wire was asked to write on which process, and how every input ended.

## 5. Reaching processes through `Os` (#1650, OS layer step 3c)

The core reaches the OS only through `tool-process.ts`, which takes an `Os` (`os/port.ts` on `centralu/os-interface`,
frozen). What it uses, all in the interface as frozen:

| Need | `Os` |
|---|---|
| start a contained child with three pipes | `processes.start(cmd, args, { cwd, env, stdio: ['pipe','pipe','pipe'] })` |
| exit, error, `kill(signal)` (agy's SIGINT), `unref` | `OsChild` |
| stop the tree with a grace, then sweep | `processes.stop(child, graceMs)` |
| find and launch the tool (`.cmd` shims) | `tools.find`, `tools.resolve` |
| the stop bound, the confirmation timer, the 2 s `noteTree` cadence | `clock.setTimeout`, `clock.now` |
| the recorder's file (`CC_RECORD_FRAMES`) | `files.mkdirSync`, `existsSync`, `appendFileSync`; `env.get` |
| config files read at launch (Codex `config.toml`, Claude settings) | `files.readFileSync` |

Two things stay outside `Os`, as os-layer.md §7.2 already says for 3c: the POSIX host watch (`HOST_WATCH`: an extra fd
and an `sh` wrapper, `endsWithHost`) and the keeper-held processes. They stay in the layer's
`dev-services/grouped-child.ts` and `kill-tree.ts` behind `LocalAgentProcess` until 3f. `tool-process.ts` therefore has
three sources: `os.processes.start` (a local child without the host watch), `LocalAgentProcess` (a local child with it),
and the keeper's `ProcessSource` (spawn and adopt). Tests give a fourth: the replayer or a fake peer.

### 5.1 As built in PR 3

`core/tool-process.ts` is the one start and stop for every tool, with no change to `Os` (PR 4 moves this file onto it):

| Function | What it does | Called by |
|---|---|---|
| `startToolProcess(spec, { sessionId, source, spawn })` | the keeper's `source.spawn` (no host watch: the keeper's child outlives the host by design), or this host's `spawnLocalAgent` **always with `endsWithHost`**; tapped when there is a `sessionId` | ACP's `createSession`, `CodexClient` (session and short-lived), the Cursor and OpenCode surface probes |
| `adoptToolProcess(proc, sessionId)` | a process a previous host left, taken over as it is: tapped from the adoption on | `CodexClient` |
| `stopToolProcess(proc, { graceMs, exited })` | stdin's end, `STOP_GRACE_MS` (2 s), then the tree (`kill('SIGKILL')`) | `CodexClient.dispose`, `AcpConnection.dispose` |
| `endToolProcess(proc, boundMs)` | the tree at once, then a bounded wait | ACP's `closeAdopted` |
| `logToolStderr(proc, label)` | the 500-character host-log line (§2.11) | `CodexClient`, `AcpConnection` |
| `SessionProcess` | a session's process across its replacements (below): `start`, `relaunch`, `interrupt`, `stop`, `close`, run one at a time in the order asked, so a Stop or a close asked while a start awaits its launch ends what it starts (or starts nothing, once closed) | the ledger (PR 5, §4.1), for every tool on it |

Claude stays on the SDK (§3.3): `claudeQueryOptions`'s `spawnClaudeCodeProcess` adds `endsWithHost` to what the SDK asks
for (`claude/sdk-query.ts`), and `claude/session.ts` (#1626's) is untouched; its keeper spawn passes four fields and so
leaves the flag out. Codex's keeper spawn (`launch-config.ts:spawnInKeeper`) is gone: `CodexClient` takes the
`ProcessSource` and builds one spec for both. What changes on screen: nothing. What changes on macOS and Linux: Claude
Code and Codex's app-server start behind `HOST_WATCH`, as ACP's tools already did (§2.6, Q3), so a host killed outright
takes them along whatever they do with stdin's end; `ends-with-host.test.ts` holds it per tool on a real OS (skipped on
Windows, which has no watch). Behind the watch `sh` always starts, and its `exec` of a missing program exits 127, so a
removed `codex` read as a crash where it used to say it failed to start (found by `codex/client.test.ts` on Linux):
`local-process.ts` now looks the program up as `sh` would and reports a missing one as not started (ENOENT), as without
the watch. That also changes ACP on macOS and Linux, from "<label> exited (code 127)" to "<label> failed to start".

**What Antigravity needs of the seam** (#1654, measured on `agy` 1.4.7), in `SessionProcess` and `core/gate.ts`:

1. **`launch(resume)`** (`ToolLaunch`): asked again for every new process, with the conversation's id once known, since
   `agy` ends its process on every Stop and takes model and effort as flags. `relaunch()` stops the old process (4.)
   before it asks for the next.
2. **An id learned late** (`noteExternalId(id, from)`): `agy` says its id only in `init`, after the first input; every
   later launch goes on with it. A late line from a process already replaced is ignored.
3. **The gate's inbound path** (`GateInbound`, `GateChannel`, `GateRequest`, `GateAnswer`): an interface in PR 3, then
   built as a route on the host's front door under a gate-only key per session (§8.1, `transport/gate-door.ts`).
4. **A Stop denies every open gate request first** (`GateRequests.denyAll`, in `interrupt` and `stop`): SIGINT does not
   end `agy` while a gate hook waits.

**No change to the frozen interface is needed** for the core or for Claude, Codex and ACP on it. One later need to
raise: `agy`'s interrupt is SIGINT (antigravity-adapter.md §1.5), and on Windows `OsChild.kill` ends a child whatever
the signal (`port.ts`); a Windows Ctrl-C to a console child is not in `Os`. That matters only for `agy` on Windows,
which its design already parks for a later pull request (its §13 step 3); not asked now (§9.5).

**How it fits 3c.** os-layer.md §7.4 lists 3c as "adapters' spawning: Claude, Codex, ACP", three spawn sites. With the
core, 3c is one: `tool-process.ts`. So the order is the core's process seam first (§7.2 PR 3, which moves the three
spawn sites behind `tool-process.ts` with no OS change), then 3c in that one file (PR 4: `tool-process.ts` on `Os`,
`LocalAgentProcess`'s OS calls behind it where `Os` has them, the adapter tests on `memoryOs` and the replayer, their
lines off the allowlist). 3c's 137 s and 35 test files leave the Windows job in that pull request, as the layer plans.

## 6. Recorded frames test the core once and each tool's mapping apart

### 6.1 One tap for every tool

Until PR 1 only ACP recorded, inside `AcpConnection` (`onFrame`). The core records at the process instead: `tool-process.ts`
wraps the child's stdin and stdout and writes each line both ways, and the exit, through `frames/recorder.ts`
(unchanged format: header, `{t, dir, line}`, `exit`). A tap at the pipes sees what any wire writes, so Claude (through
the SDK), Codex, ACP and `agy` record the same way with no wire code. The ACP connection's `onFrame` is gone; its
recordings stay valid (same lines, same file per process).

As built in PR 1: `core/tool-process.ts` holds `tapProcess(proc, recorder)` and `tapSessionProcess(proc, sessionId)` (the latter is off unless
`CC_RECORD_FRAMES` is set). The tap leaves the process as it is: it listens on stdout's `data` and wraps `stdin.write` on the
instance, each through the same `lineSplitter` the wires use, so a line is recorded once, whole, in the order it happened, and
nothing is held back or changed for the wire. It is attached before the wire's own reader, so every line of a chunk is recorded before the wire handles any of them: where a
handler answers at once, the file reads in1, in2, out1 where the old ACP recording read in1, out1, in2 (the order on the pipe; no ACP
answer is written synchronously today). A blank line is not a frame. It records `write(chunk)` with a string or bytes as UTF-8; an
`end(chunk)` or a non-UTF-8 encoding is not recorded (no wire uses them). ACP taps in
`createSession` (local or keeper process alike); Codex taps in `CodexClient` (`sessionId` option), also for a process the keeper
hands over or spawns, so an adopted process is recorded from the adoption on, as a file of its own. The app-server clients that are
not a conversation (`short-lived.ts`: model list, probes) pass no `sessionId` and record nothing.

### 6.2 Two kinds of test

| Tests | What drives them | What they prove |
|---|---|---|
| **The core, once** | a scripted `ToolWire` in memory (no process, no frames) on `memoryOs` | the ledger and its rules: queue and drain, receipts, Stop and its timer, interrupted by the tool, crash vs asleep, undelivered input, card release on stop and exit, detach and adopt; the decision order; the event hygiene |
| **Each tool's mapping, apart** | its recordings through `frames/replay.test-helpers.ts` (`replaySpawner` with the tool's `FrameCodec`) and the scenarios (`frames/scenarios.test-helpers.ts`), at `SessionHandle` level | the tool's frames become the events they did before; the tool's requests match what it was sent |

The codecs: `jsonRpcCodec` (ACP, and Codex with its id-less `jsonrpc`), `jsonLinesCodec` (`agy`), and a Claude codec
matching stream-json lines by `type` and, for `control_request`/`control_response`, `request_id`. Recordings for
Claude and Codex do not exist yet; they are made with the tap on a logged-in machine, scrubbed by
`scripts/frames-scrub.mts`, and added to `frames/recordings-private.test.ts`'s `ROOTS`.

### 6.3 Why recordings come before the moves

A move must change nothing. For ACP, the 19 recorded scenarios already pin what it does. For Claude and Codex the existing unit
tests pin a lot, but against hand-written frames. So the recording pull request (§7.2 PR 2) comes before either moves:
it records today's behaviour, and every later move runs the same replays unchanged.

## 7. The pull requests

### 7.1 What waits on what

| | Touches | Can start |
|---|---|---|
| #1626 | `contract.ts` (`HistoryMessage.sent`), `claude/session.ts` (input ids), `claude/history.ts`, `codex/history.ts`, `input-receipts.ts` (`centraluInputId`), `contract/orchestrator.ts` | open, rebasing |
| #1650 | `os/` (the interface, real and memory OSes), `os.ts`, `env-path.ts`, `tool-launch.ts`, `kill-tree.ts` | open |

The core does not change `HistoryMessage`, history read-back or `contract/orchestrator.ts`. It does move what
`claude/session.ts` and `input-receipts.ts` do, which #1626 edits: designed against main plus #1626 (the core mints
input ids with `InputReceipts.create`, which after #1626 is `centraluInputId`; Claude's `send` default id moves with
it unchanged).

### 7.2 The moves (no behaviour change)

Each pull request moves code and keeps every existing test green unchanged; each adds the tests named. Sizes are
estimates of changed lines without fixtures.

| # | Pull request | Size | Proves nothing changed | Waits on |
|---|---|---|---|---|
| 1 | **The frame tap at the process**: `core/tool-process.ts` with the tap only; ACP records through it instead of `AcpConnection.onFrame`; Codex records through it (off unless `CC_RECORD_FRAMES`). This document | S, ~250 | ACP's 19 replays unchanged; a test that a tapped process records exactly the lines written and read, and the exit | nothing: **can start before #1626 and #1650** (touches `frames/`, `acp/adapter.ts`, `acp/connection.ts`, `codex/client.ts`, none in #1626) |
| 2 | **Claude and Codex recordings**: Claude taps its process (`claude/session.ts` spawn site); the Claude codec; scrubbed recordings of the shared scenarios for both; replay tests | M, ~400 + fixtures | the replays themselves pin today's events; recorded on a logged-in machine | 1; can be written before #1626 (its hunks in `claude/session.ts` are the input ids, lines 479–500; the spawn site is line 213), but Claude's recordings should be made with #1626's input ids, so they are recorded after it lands |
| 3 | **The process seam**: `tool-process.ts` starts every tool (local, host watch, keeper, adopt) and stops it (EOF, bound, tree); the spawn and dispose paths call it; `endsWithHost` for every tool (Q3); what `agy` needs (§5.1) | M, ~350 | all adapter tests and replays unchanged; core tests for stop order and bound; a real-OS test per tool that it ends with its host | 1 (built before 2: Claude's spawn flag is in `claude/sdk-query.ts`, not its spawn site) |
| 4 | **OS step 3c**: `tool-process.ts` on `Os`; adapter tests on `memoryOs` and the replayer; allowlist lines off | M, ~300 | the same tests on `memoryOs` as both families; a few real-process tests stay on every OS | 3, #1650 |
| 5 | **The ledger, ACP first**: `core/ledger.ts` and `seam.ts`; `AcpSession` becomes an ACP `ToolWire` on `CoreSession` (queue, receipts, Stop timer, exit) | L, ~500 | ACP's replays and `acp/session.test.ts` unchanged; core tests on a scripted wire | 3 (not 4) |
| 6 | **The ledger, Codex**: Codex's blocking-turn queue, receipts and exit onto the ledger; Codex keeps no Stop timer (`confirmsStop: false`, §2.4) | L, ~450 | Codex's replays (PR 2), `interrupt.test.ts`, `lazy-resume.test.ts`, `keeper.test.ts` unchanged | 5 |
| 7 | **The ledger, Claude**: Claude's receipts, Stop timer and crash onto the ledger; the SDK stays its wire | L, ~500 | Claude's replays, `session` tests unchanged | 5, #1626 |
| 8 | **The decision order**: `core/grants.ts`; ACP, then Codex, then Claude supply `GrantQuery` (three small pull requests, or one per tool if review prefers) | M each, ~200 | the approval tests of each tool unchanged; core tests for the order | 5 |
| 9 | **Event hygiene**: `core/events.ts` calling the shared helpers for each tool; the two ACP `pathsOf` copies become one | S, ~150 | replays unchanged (the bypasses of §2 stay bypasses: see 7.3) | 5 |

PRs 5–9 for one tool do not wait for the others, so `agy` (§8) needs only 1, 3, 5, 8 and 9 with ACP on them.

### 7.3 The fixes the measurement found (behaviour changes, each its own pull request)

| Fix | From | Can start |
|---|---|---|
| ACP marks files only after an ok result (`TouchedFiles`) | §2.8 | now (a file the move does not touch until PR 9) |
| ACP sends a running token reading, through `tokenCount` | §2.1 | now |
| ACP fails an input whose turn was stopped | §2.3 | now, before PR 5 |
| ACP's card shows a diff from `oldText` | §2.11 | now |
| Codex sends an emptied plan | §2.11 | now |
| ACP caps inline images (`inlineImageEvent`) | §2.9 | now |
| The context guard's upper bound for Claude and ACP | §2.2 | after 9 (then one line) |
| ACP's crash message in `withStderrTail`'s form | §2.5 | after 5 |
| Claude's idle exit is asleep, not crashed | §2.5 | after 7, owner's call (§9.1) |
| Codex gets the Stop confirmation timer | §2.4 | after 6, owner's call (§9.2) |
| `endsWithHost` for Claude and Codex | §2.6 | done in 3 (Q3 decided it belongs there; §5.1) |

## 8. Antigravity on the core

From antigravity-adapter.md's measurements (`agy` 1.4.7, macOS, 2026-10-26), what `agy` supplies and what it takes:

| Core part | `agy` | Its doc |
|---|---|---|
| `tool-process.ts` start | `agy --input-format stream-json --output-format stream-json … -p=`, one process per session, `endsWithHost` | §3.1 |
| The tap and replay | `jsonLinesCodec`; plus a `gate` direction for hook requests (a recorder entry kind to add, not a format change) | §10.1–10.2 |
| `turns.midTurnInput` | false: the core queues (agy would too, but the person's `queuedMessages` can turn that into an interrupt) | §1.6, §4.2 |
| `turns.interruptEndsProcess` | true: SIGINT ends the process within 30 ms with a `result` `interrupted`; the next input starts a new one with `--conversation` | §1.5, §3.1 |
| Stop confirmation | the process exit is the confirmation; the timer bounds it with the existing stop bound | §3.3 |
| Crash vs asleep | the core's rule; an exit after our SIGINT is expected | §4.1 |
| `open` and resume | `--conversation <id>` from `launch(resume)` for every new process; the id from the first `init` through `noteExternalId`; the unknown-id check at the first `init` is the wire's | §4.4 |
| `grant` | the PreToolUse hook gate reaches the host through `GateInbound` (§8.1) and calls `CoreIo.grant` with a `GrantQuery` from `tool-kinds.ts` (an unknown name is a card); a Stop and a close deny what is open first | §5 |
| Event hygiene | `TouchedFiles` for edits, token totals from `agent_response` `DONE` frames, no context reading (no window), no compaction marks | §4.1, §6 |
| Not used | history read-back, `detach` takeover (`adopt` returns `reopen`, like ACP) | §8 |

So `agy`'s adapter is a wire (`stream.ts`, `normalize.ts`, `gate.ts`, `plugin-root.ts`, `tool-kinds.ts`,
`known-steps.ts`) on the core, without its own queue, Stop, exit or approval order. Its pull request follows PRs 1, 3, 5, 8 and 9
for ACP; it does not wait for Claude's or Codex's moves (PRs 2, 6, 7).

### 8.1 The gate's way back to the host: a route on the front door, under a gate-only key

The hook is a process `agy` starts per call; it must reach this host, wait for a decision and print it (a hook that
prints nothing and exits 0 lets the tool run, measured). Two transports were weighed, and a third, narrower one chosen:

| | A. Loopback listener per session, its own token | B. A route on the host's front door, the bridge credential |
|---|---|---|
| What is new | a listener per `agy` session (`127.0.0.1`, a random port) and a random token per session in the tool's environment | one route and a `SessionHandle` method it reaches; no new listener |
| Who can call | anyone on the machine who has the port and the token; the token is per session and dies with it | anyone who holds the session's bridge credential |
| What a leaked secret allows | raising that session's gate cards until it closes | the same, plus what that credential already reaches (`orchestrator.tool`, `apps.sessionCall` for that session) |
| Rights model | outside the host's method rights: a second front door to review and keep reviewed | inside them: one front door, its rights table and its tests |
| Across a host swap | dies with the host; an adopted `agy` is reopened, not taken over (§8), so a new process gets a new listener and token | the route survives; a request the old host opened is answered only if the hook asks again |
| Who holds the secret today | nobody: it is new | **no tool's environment holds the bridge credential today.** Claude's Centralu tools run inside the host with no token. Codex and ACP get the bridge's environment only in the bridge child process (thread config, `session/new`'s `mcpServers`), and only for a session with the orchestrator profile or apps. Another process can read it from that child's environment at most. The credential is an HMAC of the session id keyed by the host token: it does not die with the session and survives keeper swaps |
| What `agy`'s shell would gain | the session's gate token only | a long-lived credential for its session's orchestrator and app tools, newly in the agent's own shell, skipping what the tool asks before an MCP call |
| Windows | a loopback port (no firewall prompt for `127.0.0.1`) | nothing new |

**Decision (owner, after the security review on #1668): a route on the host's front door under a gate-only key of its own.**
Not the bridge credential, and no new listener.

- The key is random per session, held in memory, revoked when the session closes, and allows exactly one method: raise a
  gate request for that session. It is bound to the session it was made for and is not in the everyday rights.
- The method's parameters carry no decision field. Approvals stay `window`-only in the rights table
  (`agents.respondApproval`, `requests.answer`), so the channel can ask and never answer.
- It fails closed (the hook denies when the host cannot be reached), keeps the secret out of every file (the plugin root
  holds names only) and is closed with the session, denying what is open and what asks later. A Stop denies what is open and
  what a dying process asks during its grace.
- Built in `transport/gate-door.ts` (`FrontDoorGates`, the `GateInbound` the adapters open), as below.

**As built:**

| | What it is | Why |
|---|---|---|
| Where | `POST /gate/<sessionId>` on the host's front door (the keeper's port under a keeper, `swap-control.ts` `gateAddress`), outside the HTTP door's secret segment; no new listener | one front door, one rights table |
| The key | `ccg1:` and 32 random bytes per session, in the host's memory only, sent as `Authorization: Bearer`; revoked when the session's channel closes, and a host that starts holds none | not the bridge credential: that is an HMAC of the host's token, outlives the session and every swap, and opens the session's orchestrator and app tools, which the agent's own shell would then call around what the tool asks before an MCP call. Not the HTTP door's secret either, for the same reason (it opens the app views) |
| What it allows | one method, `gate.ask`, for the session it was made for: its rights class is `gate` (`method-rights.ts`), which the limited credential, a bridge and every WebSocket connection are refused, the token's included; `gateRefusal` reads the same table and the method's schema | one definition of who may call what |
| What a request carries | the tool's hook input, a JSON object; one with a top-level `decision`, `permissionDecision` or `answer` is refused (400). The decision is the session's `GateHandler.decide` alone; the person's answers stay `window` | the channel asks and never answers |
| The answer | `200` and its headers at once, a space every 30 s while the card is open, then one `{decision}` or `{decision: 'deny', reason}`. A reason comes from the session's own sentences, never from a caller; as a last check a reason is dropped whole (the door's own sentence goes instead) when any 12 letters and digits of the key, the host's token, the limited credential or the HTTP secret show in it, in any case, with or without a prefix, split by spaces or punctuation, or anything shaped like a `cc?1:` credential (`scrub`). A failure after the headers went out cuts the connection, so the hook denies at once | Node's `fetch` in the hook gives up after 300 s without a byte (antigravity-adapter.md §5.1); #1666's review, finding 4 |
| A refusal | a wrong key, another session's key, a revoked one and no route at all get the front door's same 404; a body that is no request 400; a body over 1 MiB 413 (the largest recorded hook input is 685 B; a file write carries the file); past 32 requests of one session, those whose body is still being read included, 429 before the body is read. The hook denies on every one | nothing tells a prober which it was |
| Stop, close and a hook gone | a hook that goes before its answer (`agy` kills one past its timeout, a dropped connection) has its request denied at once and its slot freed, and `decide`'s `gone` signal tells the session to withdraw its card as a cancelled card is (`approval_resolved` deny), so no dead card waits for the person; a request whose session closed while its body was read raises no card (404). A Stop answers every open request `deny` first, and what a dying process asks during its grace (`SessionProcess.stop`/`interrupt`, `GateRequests.hold`); the channel's close revokes the key and denies what still waits; the host's own close (`HostServer.close`) denies every open request before its connections are cut | `agy` does not act on SIGINT while a hook waits |
| Across a host swap | the next host has no key: the hook's old key gets 404 and denies; an adopted `agy` is reopened (§8), so its new process gets a new key | nothing long-lived in the tool's environment |

The key is in the tool's environment, so the agent's own shell commands hold it too (and another process of the same
user can read it from the process's environment). That is safe only because the channel **asks and never answers**: a
command holding the key can raise a card (noise the person sees and can deny), or ask again with an open request's id,
which only ever denies the first wait (`GateRequests.wait`); it cannot allow a call, call another method, or reach
another session. A transport that let the caller say "allowed" (a shortcut for Centralu's own tools, say) would hand the
agent its own approvals, and must not be added. The environment names are tool-neutral (`CC_GATE_URL`, `CC_GATE_TOKEN`,
`GATE_ENV`), for the next hook-gated tool.

### 8.2 As built: the `agy` session (`adapters/agy/session.ts`, `adapter.ts`)

`AgyAdapter` (the one registration point: `new AgyAdapter(profile, host)`) returns an `AgySession`, a `CoreSession` over
`AgyToolWire` with `turns { midTurnInput: false, interruptEndsProcess: true, confirmsStop: true }`.

- **Launch**, asked for every new process: the plugin root is written afresh (`writePluginRoot`), the gate channel is
  opened (`GateInbound.open`, a new gate-only key per process, which revokes the last one), and `launchArgs` adds
  `--conversation <externalId>` once `init` has said it (`CoreIo.externalId` → `noteExternalId`). The key goes into the
  process's environment (`CC_GATE_URL`, `CC_GATE_TOKEN`) and nowhere else. The channel closes when that process exits and
  when the session closes; the plugin root is removed at dispose.
- **The gate's decide** is `AgyGate.answer` (the cards and `PendingCards` the other adapters use), raced with the session's
  `GateRequests.wait`, so a Stop, an exit or the close that comes first answers `deny`.
- **A Stop**: the core calls `interrupt()` (the wire hears that the `interrupted` result is ours), then `releaseCards()`
  (`AgyGate.stop`: every card denied, with its `approval_resolved`), then `SessionProcess.interrupt` (`denyAll`, SIGINT).
- **Model and effort** are flags: `updateSettings` calls `CoreSession.restartForNextInput()`, and the next input starts a
  new process with them on the same conversation. A preset change is the gate's alone (`setPermissionPreset`).
- **The person's deny rules** are read once at `createSession` (`readAgyDenyRules`).
- **A conversation `agy` does not have** (`sessionNotFound`): the turn fails with `session_not_found` and the process is
  stopped.
- Files and the node path come from `host-files.ts` until the `Os` interface (#1650) is handed in.

## 9. Open questions

1. **Claude's idle exit** (§2.5): asleep like Codex and ACP (#1397's reasoning), or does Claude have a reason to call
   it a crash?
2. **Codex and the Stop timer** (§2.4): add the 10 s notice where Codex accepted the interrupt and the turn goes on?
3. **`endsWithHost` for Claude and Codex** (§2.6): the stronger guarantee, at the cost of an `sh` wrapper per CLI on
   macOS and Linux and a real-OS test each.
4. **The context guard** (§2.2): the upper bound for every tool, and "0 means no reading" per tool?
5. **`agy` on Windows**: its interrupt is SIGINT, which `Os` cannot send on Windows (`kill` ends the child). Raise an
   `Os` addition (a console interrupt) when `agy`'s Windows pull request comes, or treat a Stop on Windows as ending the
   process (it ends it anyway, its §1.5)?
6. **Recording Claude and Codex** (PR 2) spends real turns on a logged-in machine: which machine, and is the ACP
   scenario list the right set for them?
7. **Refusal and turn limits** (§2.11): a refusal, `max_tokens` and a turn limit end a turn differently per tool
   (retryable error, non-retryable error, notice and completion). Which is the host's meaning?
8. **Usage limits** (§2.11): Codex reads the primary window when the weekly one was hit, and the two tools label the
   same window differently. Out of the core, but worth an issue?
