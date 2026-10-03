import { z } from 'zod'
import {
  AppId,
  ApprovalDecision,
  Attachment,
  ApprovalDetail,
  ProtocolError,
  Question,
  SessionActivity,
  SessionGoal,
  SessionState,
  TokenUsage,
  ToolSummary,
  UpdateStatus,
} from './entities.js'

/**
 * Normalized events flowing adapter → app (docs/protocol.md §2).
 * Per-tool differences are absorbed by the adapter; the UI/core only ever knows this type.
 */
const base = { sessionId: z.string() }

/**
 * Events that do not belong to a session (`error`, `update_status`).
 *
 * `sessionId` is **kept, made optional, rather than removed.** Adding a branch that omits the
 * key entirely would turn `e.sessionId` into a type error across the whole union, forcing every
 * piece of code that only handles session events to be fixed too — too large a price for adding
 * one app-wide event, and every spot that fix touches is a chance for a mistake. Since the
 * receiving side already filters with `if (!sessionId) return`, this shape is enough to say a
 * missing value is missing.
 */
const appScoped = { sessionId: z.string().optional() }

/**
 * The **message number within the session** that the host assigns when it records this event
 * (the store's messages.seq).
 *
 * Unread tracking (lastSeq/lastReadSeq) must only ever use this number. The UI's render key is a
 * counter shared across all sessions, and if that value leaks into a per-session lastSeq,
 * viewing a large session inflates a small session's stored last_read_seq, **permanently turning
 * off its unread badge** (measured). This is only attached to events that get recorded (a
 * different number from the envelope's global broadcast seq).
 */
const persistedSeq = { seq: z.number().optional() }

/**
 * The number of app screens allowed to be alive at once in one conversation (M4 B-1, the plan's
 * "cap the number of recently live inline conversation screens"). Once the cap is exceeded, the
 * longest-alive screen collapses into a placeholder after teardown. The host (the instance and
 * the app it holds onto) and the UI (the frame it draws) both keep to this same number — if only
 * one side enforces it, it leaks on the other (the host must release the app even with no UI
 * present, and the UI must trim frames even when the host's notification is late).
 */
export const APP_VIEWS_LIVE_PER_SESSION = 3

/**
 * The owner of the call that produced an external app's "changed" event (M4 B-5) — exactly the
 * shape of the host runtime's caller (`AppCaller`). If a screen made the call, that screen's
 * instance id is carried here. That screen never hears its own change again — it already
 * received it as the call's response.
 *
 * The shape is not narrowed tightly. If a new kind of caller is added later and this field
 * causes the event to fail validation, an open screen would never receive its update again. All
 * the receiving side actually reads is `view`'s `instanceId`.
 */
export const AppChangeCause = z.looseObject({ kind: z.string(), instanceId: z.string().optional() })
export type AppChangeCause = z.infer<typeof AppChangeCause>

/**
 * A chunk of the assistant's reply. `messageId` names the message the chunk belongs to, where the tool says
 * so (codex: the agentMessage item id). The host keeps one open row per session and grows it with every
 * chunk until a recorded event closes it, so two messages with nothing recorded between them used to become
 * one row (#212). A chunk whose `messageId` differs from the open row's starts a new row. Absent means
 * "the same message as before", which is what every chunk meant before this field existed.
 */
const MessageDelta = z.object({
  ...base,
  ...persistedSeq,
  type: z.literal('message_delta'),
  role: z.enum(['assistant']),
  text: z.string(),
  messageId: z.string().optional(),
})

/**
 * Only as much of the model's reasoning as is actually visible (measured in #58, 2026-08-26).
 *
 * The two tools produce different things — which is why both fields are optional:
 *   codex: a summary **text** is streamed (item/reasoning/summaryTextDelta, but only if the
 *          thread config has model_reasoning_summary turned on) → text
 *   claude: the thinking body is encrypted as a whole, so there is no text — thinking_delta
 *          only ever carries estimated_tokens → estTokens (incremental)
 * Content that does not exist is never faked: if text is present, it is even kept in the
 * record (kind 'reasoning'); if only estTokens is present, it only lives as a "thinking ~N"
 * progress indicator and disappears once the turn ends.
 */
const ReasoningDelta = z.object({
  ...base,
  ...persistedSeq,
  type: z.literal('reasoning_delta'),
  text: z.string().optional(),
  estTokens: z.number().optional(),
})

/**
 * A tool call and its result. `summary` is what the card shows; `input` and `output` are the whole record (#221).
 *
 *   input   the tool's raw input as the tool received it: a Bash command with its options, the full content of a
 *           Write, both sides of an Edit, the arguments of an MCP call, Codex's file changes with their diffs
 *   output  the whole text the tool answered, uncut. Images are not in it: they are kept as attachments (#40)
 *
 * Before #221 the card's preview was the record: a result kept its first 300 characters (Claude) or 2,000 (Codex),
 * and a file edit kept only its path. The full text lived only in the tools' own files, which do not last (Claude
 * Code deletes a transcript after 30 days without activity). Rows written before then have neither field.
 *
 * **Both are for the store only.** The host strips them from everything it sends (the live broadcast, the history
 * pages) and from every stored message it reads back unless the reader asks for them by name
 * (`Store.loadMessages`). Full tool output reaching another session's prompt is the privilege path #73 closed:
 * `read_session`, `recall`, the handoff record and the orchestrator's memory read `summary` and nothing else. And
 * an agent `cat`-ing a large file would otherwise ride every page load. Neither field is in the search index.
 */
const ToolCall = z.object({
  ...base,
  ...persistedSeq,
  type: z.literal('tool_call'),
  callId: z.string(),
  summary: ToolSummary,
  input: z.unknown().optional(),
})

const ToolResult = z.object({
  ...base,
  ...persistedSeq,
  type: z.literal('tool_result'),
  callId: z.string(),
  ok: z.boolean(),
  summary: z.string().default(''),
  output: z.string().optional(),
})

/**
 * What a native subagent did, one step of it (#222): its text, its reasoning, a tool call it made, that call's result.
 * The shapes are the parent's own events, so the store keeps a subagent's step as it keeps the parent's and the screen
 * draws it the same way. Each step is whole: Claude forwards a subagent's text a block at a time, and Codex's child
 * items are read when they complete, so there are no chunks to join.
 */
export const SubagentStep = z.discriminatedUnion('type', [MessageDelta, ReasoningDelta, ToolCall, ToolResult])
export type SubagentStep = z.infer<typeof SubagentStep>

/**
 * The calls that launch a native subagent (#222): Claude Code's `Agent` tool (`Task` before it was renamed) and Codex's
 * `spawnAgent` collab call. The card of such a call is where the subagent's steps are kept and shown.
 */
const SUBAGENT_LAUNCH_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'spawnAgent'])
export const launchesSubagent = (tool: string): boolean => SUBAGENT_LAUNCH_TOOLS.has(tool)

export const NormalizedEvent = z.discriminatedUnion('type', [
  MessageDelta,
  ReasoningDelta,
  /**
   * The current state of a plan the agent set (measured in #58, codex turn/plan/updated).
   *
   * **A full snapshot arrives every time** — not a delta, so the receiving side never needs to
   * remember the prior state (the same reason as settings_changed). Measured: a plan never
   * arrives as an item — discarding this notification would mean codex's plan-tool usage never
   * shows up anywhere on screen.
   *
   * The absence of persistedSeq is a decision: this is a progress indicator, not an answer — it
   * lives on screen only, with the same lifetime as activity, and disappears once the turn ends.
   * (The only explanation ever measured was null, so it is not carried here — it can be added
   * once one is actually observed.)
   */
  z.object({
    ...base,
    type: z.literal('plan_update'),
    steps: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'inProgress', 'completed']) })),
  }),
  /**
   * A chunk of output from a running tool (measured in #58, codex item/commandExecution/outputDelta).
   *
   * Not recorded, since the tool_result at completion time carries the whole thing again as
   * aggregatedOutput — this is only a display-only chunk showing "what is coming out right now."
   * (Measured: the first chunk can be consumed before the stream attaches — treat this as
   * evidence that something is alive, not as a complete copy.)
   *
   * A sub-agent's steps also arrive through this path (#98): callId is the Agent call that
   * spawned it, and text is one line per step. These are not queued into the parent's
   * conversation — they attach only to that card. The receiving side must find the owner by
   * callId (finding it by position would attach it to someone else's open card).
   */
  z.object({ ...base, type: z.literal('tool_output_delta'), callId: z.string(), text: z.string() }),
  /**
   * A step a native subagent took (#222) — Claude Code's `Agent` tool, Codex's `spawn_agent` child thread.
   *
   * **One wrapper kind, not a flag on the parent's events.** A subagent's tool call used to land in the parent's
   * conversation as if the parent had made it (#98), and a field that every reader of `tool_call` has to remember to
   * check would bring that back the first time one forgets. A reader that does not know this kind skips it (§4 of
   * docs/protocol.md: an unknown type is ignored), so the conversation, the state machine, unread and the turn logic
   * stay the parent's without a line of code each.
   *
   *   parentCallId  the call that launched the subagent: Claude's `Agent` tool_use id (`parent_tool_use_id` on the
   *                 subagent's messages), Codex's `spawnAgent` collab item id (whose `receiverThreadIds` names the
   *                 child thread). A subagent that launches its own is tagged with its own launch call, a card inside
   *                 the first one's steps
   *   step          the step, in the parent's own event shapes (`SubagentStep`), `input` and `output` included until
   *                 it leaves the host (`withoutToolRecord`)
   *   stepSeq       its number among this launch's steps, set by the host when it stores the step. Not a session
   *                 `seq`: a subagent's steps are not the conversation, and never count as unread
   *
   * The host keeps the steps apart from the conversation (`subagent_messages`, read only by asking for one launch
   * card's steps) and out of the search index. The one-line-per-step progress on a running Claude agent's card is
   * still `tool_output_delta`.
   */
  z.object({
    ...base,
    type: z.literal('subagent_event'),
    parentCallId: z.string(),
    step: SubagentStep,
    stepSeq: z.number().optional(),
  }),
  /**
   * A person's message was added to the conversation.
   *
   * **This was unnecessary back when the UI only ever needed to draw what it itself sent.** But
   * once the orchestrator started talking to other sessions via send_to_session, there came to
   * be two producers of user messages — from that point on, a message that never passed through
   * the UI had no way to appear on screen at all (it was still saved, though).
   *
   * Why seq is sent along: the sending UI has already drawn the message optimistically, so it
   * must not draw the same message twice. The receiving side needs a way to tell that apart.
   */
  z.object({
    ...base,
    type: z.literal('user_message'),
    seq: z.number(),
    text: z.string(),
    /*
     * The origin (FR-11). Absent means the person typed it directly — which is why it is
     * optional and stays compatible with old frames. Only two places fill it in: the
     * orchestrator's send_to_session, and a worker's completion report (reportBack).
     * The screen uses this value to draw "a message that arrived via instruction" differently
     * from the person's own words.
     */
    from: z.object({ sessionId: z.string(), name: z.string() }).optional(),
    /*
     * A message sent by an inline conversation app screen (M4 B-1, B-4). A person read it and
     * chose to send it, but **an app wrote it** — the screen uses this value to draw it
     * differently from the person's own words. What reaches the agent is the shape the host
     * wraps as "app text" (the same rule as #120: text from another party is marked wherever it
     * is carried). Kept separate from `from` since this is not a session.
     */
    fromApp: z.object({ appId: z.string(), projectId: z.string().nullable(), name: z.string() }).optional(),
    /*
     * Attachments carried along with it (M4 C-5). Not needed for text the UI sends, since the
     * screen has already drawn it together with its attachments. For text inserted by the host,
     * such as text from the composer under an app screen, this event is the only way it ever
     * appears on screen — without it, a pasted screenshot would be missing from the message
     * bubble until the record is reread. Only the path and name — the image bytes are loaded
     * again by the host when the record is read.
     */
    attachments: z.array(Attachment).optional(),
  }),
  ToolCall,
  ToolResult,
  /**
   * An inline conversation app screen (M4 B-1) — a session's agent called an app tool **that has
   * a screen attached**. The screen stands under that call's card (`callId`, the same id as the
   * adapter's `tool_call`).
   *
   *   open       the host opened a screen instance. Carries `instanceId` and the tool input (`toolInput`)
   *   result     the call finished. The app's own answer, unchanged (`toolResult`) — becomes the screen's tool-result
   *   cancelled  it ended without an answer (cancelled, rejected, or the app failed to start). `reason` becomes the screen's tool-cancelled
   *   rejected   the screen was never opened — the screen the tool declared does not belong to that app (blocking impersonation). Carries a reason
   *   closed     the host closed the instance (the cap, the app disappearing, losing trust). The screen collapses into a placeholder after teardown
   *
   * `kept` is carried on result and cancelled: whether the host is holding the input and result
   * so the screen can be reopened **without calling the tool again** (`apps.inlineReopen`). Not
   * held if the result is too large.
   *
   * Only open and rejected are kept in the record (`seq`) — no body (input, result), only the
   * fact that "some app's screen stood at this card." A freshly reopened UI uses that to plant a
   * placeholder. The result body only ever lives in the host's memory.
   */
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('app_view'),
    callId: z.string(),
    appId: AppId,
    projectId: z.string().nullable(),
    tool: z.string(),
    phase: z.enum(['open', 'result', 'cancelled', 'rejected', 'closed']),
    instanceId: z.string().optional(),
    toolInput: z.record(z.string(), z.unknown()).optional(),
    toolResult: z.looseObject({ content: z.array(z.unknown()) }).optional(),
    reason: z.string().optional(),
    kept: z.boolean().optional(),
  }),
  z.object({ ...base, ...persistedSeq, type: z.literal('approval_request'), requestId: z.string(), detail: ApprovalDetail }),
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('approval_resolved'),
    requestId: z.string(),
    decision: ApprovalDecision,
  }),
  /*
   * The agent presented a set of choices (AskUserQuestion).
   *
   * Why this is **a different event** from an approval: an approval is yes or no, while this is
   * several questions times several options, and the answer has to go back to the model.
   * Forcing this onto the approval card would break both.
   */
  z.object({
    ...base,
    type: z.literal('question_request'),
    requestId: z.string(),
    questions: z.array(Question),
  }),
  z.object({ ...base, type: z.literal('question_resolved'), requestId: z.string() }),
  /*
   * The agent produced an image in the conversation (#40).
   *
   * Folds the two measured cases into one: Claude carries it as base64 inside tool_result (a
   * screenshot, an image Read), while Codex carries **only a path** in an imageView item — for
   * the path case, the adapter reads the file and fills in data before emitting it. The UI
   * always draws the same single shape (a data URL).
   *
   * **The absence of persistedSeq is a decision** (2026-08-24): this is display-only. The
   * database only keeps the text, and an image disappears on restart just like terminal
   * scrollback. This will be reconsidered if dogfooding shows people going back to look for a
   * past image.
   *
   * If data is empty, note states why (too large, failed to read — a failure should be visible).
   */
  z.object({
    ...base,
    type: z.literal('message_image'),
    mime: z.string(),
    /** base64. Empty means display failed — see note */
    data: z.string(),
    /** If the image exists on disk, its source path (Codex imageView) */
    path: z.string().optional(),
    note: z.string().optional(),
  }),
  /**
   * The turn ended.
   *
   * `output` is only carried **when this turn answered against a schema** (M4 D-1, an app's
   * requested agent's `schema`). Claude only ever gives structured output as the turn's outcome
   * (`result.structured_output`), never as text in the conversation — measured (SDK 0.3.263, CLI
   * 2.1.282): the model first answered in text with "Red and yellow.", and only after the CLI
   * told it again to call the tool did it produce JSON via the `StructuredOutput` tool. So
   * reading only the last piece of text never yields the answer. Codex is not carried here,
   * since its last message is the JSON itself.
   */
  z.object({ ...base, type: z.literal('turn_complete'), output: z.unknown().optional() }),
  z.object({ ...base, type: z.literal('state_change'), state: SessionState, reason: z.string().optional() }),
  z.object({ ...base, type: z.literal('usage_update'), tokens: TokenUsage }),
  z.object({
    ...base,
    type: z.literal('context_update'),
    used: z.number(),
    window: z.number(),
    exactness: z.enum(['exact', 'estimate']),
  }),
  z.object({
    ...base,
    type: z.literal('limit_reached'),
    /** ISO8601. The tool's reported expected reset time (FR-9) */
    resumeAt: z.string().optional(),
    /** Provided by Codex (confirmed at M0) */
    usedPercent: z.number().optional(),
    windowMins: z.number().optional(),
  }),
  /**
   * A session's name changed.
   *
   * **Who set it travels along with the change.** This used to carry only the title, and the
   * receiving side decided whether to apply it purely from its own state, "is this session's
   * name currently automatic." As a result, a name a person edited **only propagated on the
   * first change and was silently ignored from the second one onward** (once edited once,
   * autoNamed flipped off, and everything discarded this event afterward).
   *
   * auto=false means "a person set this," and an automatic name never overwrites it again
   * (FR-18). Omitted means it is an automatic name — a frame sent by an old version is still
   * interpreted correctly this way.
   */
  z.object({ ...base, type: z.literal('session_title'), title: z.string(), auto: z.boolean().default(true) }),
  /** For detecting concurrent-session conflicts and highlighting recently modified files (FR-2, FR-5) */
  z.object({ ...base, type: z.literal('files_touched'), paths: z.array(z.string()) }),
  /** What it is busy doing right now — null means an ordinary wait for a reply */
  z.object({ ...base, type: z.literal('activity'), activity: SessionActivity.nullable() }),
  /** Context compaction happened — leaves a marker in the conversation (FR-14) */
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('compaction'),
    /**
     * A failure is also recorded as a marker. Passing over it silently would let the
     * conversation continue uncompacted while the person has no way to know why the context
     * never shrank (measured: "Not enough messages to compact." — this used to be swallowed
     * whole).
     */
    failed: z.boolean().default(false),
    reason: z.string().optional(),
    /** How much it shrank. Only when the tool reports it (Claude compact_metadata) */
    before: z.number().optional(),
    after: z.number().optional(),
  }),
  /**
   * This session was born from a handoff, and the predecessor's note is pinned here (#102).
   *
   * **The reason a record is needed is the same as for the compaction marker**: back when the
   * first message was the note in full, that text remained in the conversation on its own, but
   * now the first message only carries a path. A note the agent wrote cannot be recreated once
   * its author is gone, so it is kept somewhere that outlives the file.
   *
   * `note` being optional is deliberate — **it is never carried in a broadcast.** A note can run
   * to megabytes, and all that ever gets drawn on screen is a one-line marker. The raw text
   * lives only in the stored payload.
   */
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('handoff'),
    /** The predecessor session's name — the only value written into the marker */
    from: z.string(),
    note: z.string().optional(),
    /**
     * The predecessor session's id (#106) — only carried in the stored marker. This is the only
     * way to know whose name the note file this session inherited is filed under, and it is the
     * basis for orphan cleanup at startup.
     */
    fromSessionId: z.string().optional(),
  }),
  /** Caught up on a conversation continued from outside — the signal for the UI to reread the record */
  /**
   * The orchestrator changed this session's settings (#30).
   *
   * A change a person made on screen returns as the RPC response, so no event is needed for
   * that — this path exists for a change made by **a hand other than the person's own**. A
   * settings change with no trace is exactly the silent-action problem this codebase has fixed
   * over and over, so it is broadcast along with the values and left as a toast. All three are
   * snapshots (the full new value) — a delta would force the receiving side to remember the
   * prior value.
   */
  z.object({
    ...base,
    type: z.literal('settings_changed'),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    verbosity: z.string().nullable(),
    /** Response speed. Follows the same snapshot rule as the three above — optional since old frames lack it */
    serviceTier: z.string().nullable().optional(),
  }),
  z.object({ ...base, type: z.literal('history_synced'), added: z.number() }),
  /** The session was deleted — the list must stay correct in other windows and after a reconnect too */
  z.object({ ...base, type: z.literal('session_deleted') }),
  /**
   * A session was created **on the host side** (#69).
   *
   * A session the UI creates directly is known through the RPC response, but there was no way to
   * know about a session the host creates on its own — the manager a worktree-orphan adoption
   * stands up, or the orchestrator's create_session. An event for an unknown session goes into
   * a holding area (pendingEvents), and the condition for draining that area is "once the
   * session is registered," so without a registration event it stayed there forever. A session
   * that only ever appeared via listSessions after a reconnect contradicted the create_session
   * tool's own description, which says it appears in the list right away.
   */
  z.object({ ...base, type: z.literal('session_created'), session: z.unknown() }),
  /**
   * A worktree branch's work has fully landed in the project trunk (#69). Detection is done by
   * the host (at startup, and on a project git refresh), and the screen turns on a badge.
   * Cleanup (removing the tree) is done by the person, through the delete conversation — this
   * event only announces the fact; it is not an action.
   */
  z.object({ ...base, type: z.literal('worktree_merged') }),
  /**
   * The PR status for a worktree branch became known (#76 stage 3). An announcement measured
   * through gh — the same shape as worktree_merged: it announces a fact, not an action. If the
   * PR is merged (including a squash merge), worktree_merged follows — this event is only the
   * basis for the badge (number, state, link).
   */
  z.object({
    ...base,
    type: z.literal('worktree_pr'),
    pr: z.object({ number: z.number(), state: z.enum(['open', 'merged', 'closed']), url: z.string() }),
  }),
  /**
   * A goal status announcement (2026-09-07). Null means it was cleared (including by being
   * achieved) — the tool makes the judgment; we only carry it. Codex announces it
   * (thread/goal/updated|cleared). Claude's CLI does not announce it to a headless session
   * (2026-10-03), so its adapter reads it from the CLI's own replies to /goal, its Stop hook
   * feedback, and the end of a turn the goal drove (adapters/claude `ClaudeGoalTracker`). This is a
   * live-only fact: after a restart, codex re-asks via thread/goal/get; a Claude process swapped
   * inside one host run is handed the goal the host knew, and after a host restart Claude's badge
   * comes back once the person sends `/goal` (the CLI restores the goal itself, silently).
   */
  z.object({ ...base, type: z.literal('goal'), goal: SessionGoal.nullable() }),
  /**
   * The update picture changed (issue #43).
   *
   * **The only event here that belongs to no session** — `error` already proved the
   * union can carry one (its `sessionId` is optional), so this rides the same rails
   * instead of growing a second stream. Everything downstream that keys off
   * `sessionId` already guards for its absence.
   *
   * It exists because the host checks on a schedule of its own: a check that lands
   * six hours into a running window has no RPC reply to ride home on, and without
   * this the answer would sit in the host until the next launch — which is exactly
   * the long-running window the schedule was for.
   */
  z.object({ ...appScoped, type: z.literal('update_status'), status: UpdateStatus }),
  /**
   * An app's document changed (#81) — deliberately coarse: it never carries what changed, only
   * that the receiving side should refetch via apps.state. Building a per-app event shape would
   * make the protocol know about apps.
   */
  z.object({ ...appScoped, type: z.literal('app_state_changed'), appId: AppId }),
  /**
   * An external app's tool call finished (M4 A-4) — the same meaning and the same coarseness as
   * `app_state_changed`: it never carries what changed, only that the receiving side should
   * refetch. An external app's state lives inside the app process, so "refetch" here means
   * calling that app's state tool again, not apps.state (on screen this is surfaced as
   * `centralu/notifications/changed`, B-5).
   *
   * Why the names are split: receiving that event for a built-in app makes the UI refetch
   * `apps.state(appId)`. Reusing the same name would add a useless round trip for every external
   * app call, and mix external app ids into the built-in app's own state field. An app is unique
   * per (project, id), so the project is carried too — null means a user-folder app. This does
   * not arrive for a call that never reached the app (rejected), or a call to a read-only tool
   * (`readOnlyHint: true`): nothing changed. The host batches these per app over 250ms (up to 4
   * per second for one app). `cause` is only carried when every batched call shares a single
   * owner — mixed owners means it is dropped (and everyone listens).
   */
  z.object({
    ...appScoped,
    type: z.literal('external_app_state_changed'),
    appId: AppId,
    projectId: z.string().nullable(),
    cause: AppChangeCause.optional(),
  }),
  /**
   * A row visible in an external app's run history panel started or finished (M4 D-6) — that
   * app's own row, or a row in the chain below it (another app it called, an agent it
   * requested). The same coarseness: the receiving side refetches `apps.runs`. The host batches
   * these per app over 250ms.
   *
   * Why this is split from `external_app_state_changed`: that one is a signal for an open
   * **screen** to refetch, so it never fires for a read-only tool's call (#190 — firing it would
   * create a loop of the screen refetching). But a read-only tool can also stand up a multi-minute
   * agent chain. This event is heard only by the run history panel.
   */
  z.object({ ...appScoped, type: z.literal('external_app_runs_changed'), appId: AppId, projectId: z.string().nullable() }),
  /**
   * The external app list changed (M4 A-8) — an app was created, removed or edited, a project's
   * trust changed, or an app started, stopped or failed. The same coarseness: this carries
   * nothing, and the receiving side refetches `apps.list`. The sidebar's app row and the pinned
   * screen's "starting, stopped, reason" follow this.
   *
   * Why this is split from `external_app_state_changed`: that one means **a value inside the
   * app** changed, so an open screen refetches; this one means **the app's slot or status**
   * changed, so the list refetches. There is no reason for the list to refetch on every single
   * tool call.
   */
  z.object({ ...appScoped, type: z.literal('external_apps_changed') }),
  /**
   * A capability question from a chain that started from a screen was raised or closed (M4 D-4).
   * The same coarseness: this carries nothing, and the receiving side refetches
   * `apps.questions`. A question from a chain that started from a session arrives as that
   * session's own `approval_request` instead.
   */
  z.object({ ...appScoped, type: z.literal('external_app_questions_changed') }),
  /**
   * Something changed in a watched directory (#34 — Finder, a terminal, an agent, regardless of
   * source).
   *
   * Rides the same path as `update_status` (appScoped) since this is a **project** event, not a
   * session one. dirs only ever states **which directories need to be reread** — it never
   * carries what changed or how. Precision differs by platform for this kind of event (macOS
   * collapses renames), and carrying that detail would only be accurate on one of the three
   * platforms. Rereading is just one listDir call either way.
   */
  z.object({ ...appScoped, type: z.literal('fs_changed'), projectId: z.string(), dirs: z.array(z.string()) }),
  /**
   * An error — if it belongs to a session, the host records it as a marker row (#107). Which is
   * why `persistedSeq` is carried here (#161): while it was missing, zod stripped `seq`, so a
   * session that ended in error left the screen's `lastSeq` one behind, and reopening it showed
   * an unread dot on a session that had already been viewed.
   */
  z.object({ ...appScoped, ...persistedSeq, type: z.literal('error'), error: ProtocolError }),
])
export type NormalizedEvent = z.infer<typeof NormalizedEvent>

export type NormalizedEventType = NormalizedEvent['type']

/**
 * Ignores an unknown event type (docs/protocol.md §4 — adding one never breaks version
 * compatibility). Call this only at the receiving boundary.
 */
export function parseEventLenient(raw: unknown): NormalizedEvent | null {
  const r = NormalizedEvent.safeParse(raw)
  return r.success ? r.data : null
}

/**
 * The event as it may leave the host: a tool call without its `input`, a tool result without its `output` (#221), and
 * the same for a tool call or result a subagent made (#222). Everything else, `turn_complete`'s `output` included, is
 * returned as it is.
 */
export function withoutToolRecord(e: NormalizedEvent): NormalizedEvent {
  if (e.type === 'subagent_event') {
    const step = withoutToolRecord(e.step) as SubagentStep
    return step === e.step ? e : { ...e, step }
  }
  if (e.type === 'tool_call' && 'input' in e) {
    const { input: _input, ...card } = e
    return card
  }
  if (e.type === 'tool_result' && 'output' in e) {
    const { output: _output, ...card } = e
    return card
  }
  return e
}
