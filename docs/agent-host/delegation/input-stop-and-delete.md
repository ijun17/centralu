# The person's input, stopping and deleting a child

**The person's input is stamped as theirs.** The Claude Agent SDK's user message has an `origin`; an absent one is
"unattributed" and fails closed at the CLI's strict `isHuman()` trust gates. `TurnInputs.send` takes `fromPerson`,
which only `agents.send` (the composer, slash commands, the person's Continue) sets.
`SessionEvents.deliver` hands it to the handle as `send(text, { origin: { kind: 'human' } })`, and the Claude adapter
writes `origin: { kind: 'human' }` on that stdin message. A message with a source (a caller's delivery, a report), an app's
notice or view message, a builder request, a new session's first message (only the UI's handoff opening, which quotes an
agent's note), a message with a Centralu line in front of it (`rootAppsNotice`) and every note through `sendTracked` carry
none, as before. One known gap: the handoff request the UI writes for the predecessor goes through `agents.send` and is
stamped, since the host cannot tell Centralu's text from the person's there. Measured on CLI
2.1.296: the CLI accepts it, echoes it on the replayed user message, and answers the same with or without it, mid-turn
wording and `/compact` included (`docs/plans/mailbox.md` §7.1).

`agent_session` normally acts on a session whose `askedBy` is the caller, in its project (the `auto` exception is in [start-agent.md](start-agent.md)).
Deleting a child without a worktree also accepts `parentSessionId` as its ownership link. `send` during the caller's turn
uses the adapter's ordinary message path when it declares `capabilities.midTurnInput` and provides `sendTracked`:
Codex 0.160 `turn/start`
steers an already-active regular turn (confirmed by `TurnStartParams.turnTrigger`; compact/review messages keep
their existing queue), and Claude queues a user message for the query's streaming prompt iterator. It returns
`working` immediately and holds the original delegation until every note's completion receipt finishes. Codex
binds a receipt through the input's `clientUserMessageId` / `userMessage.clientId` and the `turn/start` response's
turn id, even if that response follows its completion notification;
notes during compact/review can share a later turn. Claude stamps input UUIDs and uses the result's
`user_message_uuids` to identify consumed notes, including folded batches. Receipts complete only by matching
UUIDs: a sign-in-race retry can reorder delivery, and a capped list never proves an omitted input was consumed. At initialization, the adapter
requires the verified CLI protocol (2.1.289 or newer, compared as semver, so a suffixed version such as
`2.1.290-beta.1` counts) and its `interrupt_receipt_v1` and
`interrupt_cancel_queued_v1` capabilities before exposing `sendTracked`. Older or unknown producers keep the
mid-turn refusal: the single `user_message_uuid` names the turn's first input and cannot confirm a folded note.
Results without input IDs belong to synthetic turns (including background-task notifications) and neither
complete nor cancel a pending note. **A Stop is a stop** (#1640): on any Stop of a turn (the person's, or a caller's or an app's
that ends the work it gave) every tool drops what it still holds queued behind the turn, notes and plain messages alike, and nothing runs as a turn after the Stop. Claude asks the SDK's
`cancelQueued` / control-request `cancel_queued` on every Stop when the CLI offers it (a plain interrupt leaves a
message sent while the turn wrote its answer queued, and the CLI runs it right after; measured on 2.1.296); a CLI
older than that protocol is interrupted plainly, as before. Codex removes what waits behind a compact or review
(not while an adopted conversation opens: that Stop stops nothing yet) and interrupts a turn named by an in-flight
response after Stop; an ACP tool drops the prompts it queued. Each reports the messages dropped as **not
delivered**, asking the person to resend them. Mail that must not wake (a quiet input) is never the person's to
resend: Claude's `cancel_queued` cancels it with the rest, so it goes again, quiet. A turn error instead cancels only parent notes, via the SDK's optional
`cancelAsyncMessage` / `cancel_async_message`, and preserves the person's local/SDK queue. Without that SDK
method the CLI queue is left intact; the failed delegation still receives the turn's error. SDK cancellation
is also skipped while person input is pending: cancelling an already-dequeued representative UUID can drop its
whole coalesced batch. Only batches without person input are eligible for per-UUID cancellation.

The existing `wait` follows the whole delegation, so an intermediate turn cannot deliver an
answer or detach the queued note from its parent. Each completed turn's answer is captured separately: queued
input was already stored before the earlier answer, so those turns need not have a user row between them.
The adapters notify the host synchronously **after recording the matched completion**, so later frames in the
same event batch cannot overwrite that answer. Pending notes also make the child non-idle between turns, so the
sleeper, CLI replacement and deferred settings/instructions restart cannot discard queued work. Deferred
restart markers remain set while input is held. Since adapters complete receipts after emitting `turn_complete`,
the last receipt re-checks the restart when the session is not mid-turn. New input waits for disposal and resume,
so the next task uses the updated settings, app set and launch policy. The person's
Stop is marked before calling the adapter, including adapters that reject receipts synchronously. A follow-up is framed as a **note about ongoing work**
(`agentNoteFrame`), without the initial task/answer frame, and stored and shown with `from`.
A `send` after the child finishes starts a new delegation and uses the task/return-answer frame (`agentFrame`).
It is refused on an adapter without this capability, while the child works on something else
(the person may be using it), or when the person has since raised its preset above the caller's (`presetWithin`).
`stop` ends the turn the caller gave it; a turn the person started there is theirs.

**Stop and delete.** The caller's call cancelled (Claude's MCP signal), or Stop on the caller while a call waits on
a child, stops that child's turn. A child left running (`wait: false`, or past the bound) is its own session: the
caller's Stop does not reach it, it has its own Stop. Deleting the caller drops its waits and its session consent;
the children keep their turns and their link.

**Deleting a child without a worktree** (#637). In every preset, the caller may delete only a session it started
in the same project (`askedBy` or `parentSessionId` equals the caller). The host uses the sidebar's
`trashSession` path (the session archive's entry point; the archive was called the trash until #1404, and the code names keep that word): withdraw a pending wake, settle waits, dispose the child process if present, flush streamed
messages, then move the session to the archive and emit `session_deleted`. Mid-turn deletion requires the caller's
own unsettled delegation, including while the parent is working; it does not stop the parent's turn. If the
person has started another turn, or an approval/question remains without that delegation, deletion is refused
until that work finishes, even under `auto`. History and the tool's conversation remain restorable.
Concurrent sidebar and agent archive requests share one operation per session: the first request's options and
result apply to both, with one process disposal, store write and deletion event.
The result is `deleted` without worktree/branch recovery fields. A session belonging to another caller, an
unowned session, a session in another project, and self-deletion are refused.
