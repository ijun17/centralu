import { z } from 'zod'
import {
  AgentVersions,
  AppId,
  ApprovalDecision,
  BackgroundTask,
  Attachment,
  ApprovalDetail,
  ProtocolError,
  PermissionPreset,
  Question,
  RequestInput,
  SessionActivity,
  SessionGoal,
  Interruption,
  SessionState,
  TokenUsage,
  ToolName,
  ToolSetup,
  ToolSummary,
  UpdateStatus,
  HostRequest,
  HostRequestOutcome,
  MailParty,
} from './entities.js'
import { MachineInfo } from './machines.js'
import { HostHandover } from './host-logon.js'
import { TurnContinues, TurnOrigin, TurnWho } from './turn-who.js'

/** Normalized events, adapter → app (docs/protocol.md §2); per-tool differences stop at the adapter */
const base = { sessionId: z.string() }

const endsTurn = { turn: TurnWho.optional() }

// An event of no session keeps `sessionId`, optional: a branch without the key would make `e.sessionId` a type error
// across the whole union, in every reader of session events
const appScoped = { sessionId: z.string().optional() }

// The session's message number, assigned when the host records the event (messages.seq), not the envelope's seq.
// Unread tracking uses only this: the UI's render key leaking into lastSeq turned a session's unread badge off for good
// (measured)
const persistedSeq = { seq: z.number().optional() }

/**
 * App screens alive at once in one conversation; past it the longest-alive collapses to a placeholder. Host and UI
 * both keep to it: the host releases the app with no UI present, the UI trims frames when the host's word is late
 */
export const APP_VIEWS_LIVE_PER_SESSION = 3

/**
 * The notice `label` for a Stop the tool refused or did not confirm in time, the turn still running: a notice, since an
 * error ends the turn on screen. The Stop button reads it to stop saying "Stopping…"
 */
export const STOP_NOT_CONFIRMED_LABEL = 'stop not confirmed'

/** One message a mail delivery's line stands for; `threadId` is its chain's root (`mail.thread`) */
export const MailDelivered = z.object({ threadId: z.string(), messageId: z.string() })
export type MailDelivered = z.infer<typeof MailDelivered>

/**
 * The caller (`AppCaller`) of the call behind an app's "changed" event: the screen that made it already has the change
 * as its answer, and does not hear it again. Loose, so a new caller kind does not fail the event and leave open screens
 * without updates; only `view`'s `instanceId` is read
 */
export const AppChangeCause = z.looseObject({ kind: z.string(), instanceId: z.string().optional() })
export type AppChangeCause = z.infer<typeof AppChangeCause>

// `messageId`, where the tool says it (codex: the agentMessage item id): a chunk of another message than the host's open
// row starts a new row, so two messages with nothing recorded between them stay two. Absent: the same message
const MessageDelta = z.object({
  ...base,
  ...persistedSeq,
  type: z.literal('message_delta'),
  role: z.enum(['assistant']),
  text: z.string(),
  messageId: z.string().optional(),
})

// Only the reasoning a tool shows (measured): codex streams a summary `text` (with model_reasoning_summary on), which is
// recorded; Claude's thinking is encrypted, so only `estTokens`, a "thinking ~N" that goes when the turn ends
const ReasoningDelta = z.object({
  ...base,
  ...persistedSeq,
  type: z.literal('reasoning_delta'),
  text: z.string().optional(),
  estTokens: z.number().optional(),
})

// `summary` is the card; `input` and `output` are the record, for the store only: the host strips them from all it
// sends (docs/protocol.md §2; why: docs/security-boundaries/untrusted-text.md "Tool output in the store")
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

/** One whole step of a native subagent, in the parent's own shapes (docs/protocol.md §2) */
export const SubagentStep = z.discriminatedUnion('type', [MessageDelta, ReasoningDelta, ToolCall, ToolResult])
export type SubagentStep = z.infer<typeof SubagentStep>

/** Claude Code's `Agent` tool (`Task` in older Claude Code) and Codex's `spawnAgent` collab call */
const SUBAGENT_LAUNCH_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'spawnAgent'])
export const launchesSubagent = (tool: string): boolean => SUBAGENT_LAUNCH_TOOLS.has(tool)

export const NormalizedEvent = z.discriminatedUnion('type', [
  MessageDelta,
  ReasoningDelta,
  // A full snapshot each time, never a delta. No persistedSeq: a progress indicator that goes when the turn ends.
  // Measured: codex's plan never arrives as an item, and its explanation was only ever null, so it is not carried
  z.object({
    ...base,
    type: z.literal('plan_update'),
    steps: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'inProgress', 'completed']) })),
  }),
  // Not recorded: the tool_result carries it all again, and the first chunk can be gone before the stream attaches
  // (measured). A Claude subagent's steps come here too, one line each, on its launching call: find the card by callId,
  // not by position, or it lands on someone else's open card
  z.object({ ...base, type: z.literal('tool_output_delta'), callId: z.string(), text: z.string() }),
  // A wrapper kind, not a flag on the parent's events (docs/protocol.md §2). `stepSeq` is its number among the launch's
  // steps, not a session `seq`: the steps are not the conversation and never count as unread
  z.object({
    ...base,
    type: z.literal('subagent_event'),
    parentCallId: z.string(),
    step: SubagentStep,
    stepSeq: z.number().optional(),
  }),
  // The UI is not the only producer: the Assistant's send_to_session adds messages it draws only from this event. The
  // sending UI drew its own already and tells it apart by `seq`
  z.object({
    ...base,
    type: z.literal('user_message'),
    seq: z.number(),
    text: z.string(),
    // Absent: the person typed it. Set only by the Assistant's send_to_session and a worker's reportBack
    from: z.object({ sessionId: z.string(), name: z.string() }).optional(),
    // A person chose to send it, but an app wrote it, so it is drawn as the app's and reaches the agent framed as app text
    // (docs/security-boundaries/untrusted-text.md "Text an app sends")
    fromApp: z.object({ appId: z.string(), projectId: z.string().nullable(), name: z.string() }).optional(),
    // A first message a script wrote with the limited credential: it can carry outside words, so it is drawn as the
    // script's. `credential` comes from the connection's hello (`scriptLabel`), never from the call. An older reader
    // draws it as a message
    fromScript: z.object({ credential: z.string() }).optional(),
    // For text the host inserts (the composer under an app screen) this event is the only way on screen. Path and name
    // only: the host loads the bytes again when the record is read
    attachments: z.array(Attachment).optional(),
  }),
  ToolCall,
  ToolResult,
  // An app screen under a tool call's card (`callId`). Phases: open (`instanceId`, `toolInput`); result (the app's
  // answer as is); cancelled (no answer, `reason`); rejected (the declared screen is not that app's: impersonation);
  // closed (the cap, the app gone, trust lost). `kept`: the host holds input and result for `apps.inlineReopen`, unless
  // too large. Only open and rejected are recorded, with no body: a reopened UI plants a placeholder from them
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
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('approval_request'),
    requestId: z.string(),
    detail: ApprovalDetail,
  }),
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('approval_resolved'),
    requestId: z.string(),
    decision: ApprovalDecision,
  }),
  // Not an approval: several questions of several options, and the answer goes back to the model
  z.object({
    ...base,
    type: z.literal('question_request'),
    requestId: z.string(),
    questions: z.array(Question),
  }),
  z.object({ ...base, type: z.literal('question_resolved'), requestId: z.string() }),
  // Claude carries an image as base64 in tool_result; Codex only as a path, which the adapter reads. Recorded with the
  // bytes in an attachments file, so a history re-read matches the image by seq. Empty `data`: `note` says why
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('message_image'),
    mime: z.string(),
    /** base64 */
    data: z.string(),
    /** Codex imageView's source path */
    path: z.string().optional(),
    /** The file the agent viewed: a stored row's `path` is the host's own copy of it */
    name: z.string().optional(),
    note: z.string().optional(),
  }),
  // `output`: only for a turn answered against a schema (an app's agent's `schema`). Claude gives it only as the turn's
  // `result.structured_output`, never as conversation text (measured, SDK 0.3.263, CLI 2.1.282). Codex's last message is
  // the JSON itself
  z.object({ ...base, ...endsTurn, type: z.literal('turn_complete'), output: z.unknown().optional() }),
  // Not recorded: the conversation already has the error, or the host's marker for a quit
  z.object({ ...base, type: z.literal('interruption'), interruption: Interruption.nullable() }),
  z.object({
    ...base,
    ...endsTurn,
    type: z.literal('state_change'),
    state: SessionState,
    reason: z.string().optional(),
    origin: TurnOrigin.optional(),
    continues: TurnContinues.optional(),
  }),
  // How every window but the caller's learns that `SessionInfo.live` changed
  z.object({
    ...base,
    type: z.literal('session_live'),
    live: z.boolean(),
    /** `restart_failed`: the host replaced the process and the new one did not come up */
    reason: z.enum(['asleep', 'restart_failed', 'crashed']).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('usage_update'),
    tokens: TokenUsage,
    /**
     * One model request's input, once per request (docs/agent-host/prompt-cache.md); `tokens` is a running reading.
     * Absent on readings that close no request (Claude's turn result, a Codex repeat)
     */
    request: RequestInput.optional(),
  }),
  z.object({
    ...base,
    type: z.literal('context_update'),
    used: z.number(),
    window: z.number(),
    exactness: z.enum(['exact', 'estimate']),
    /** What the tool resolved the model name to: Claude's alias or the project's default names other models over time */
    model: z.string().optional(),
    /**
     * `window` is the model's full window as the host says it: Claude's CLI reports the smaller of it and its compaction
     * point. `capped`: not known, so `window` is the tool's reading, a floor. `compactAt`: where this process compacts by
     * itself (Claude: the CLI's threshold; Codex: its start limit); the host drops one not under `window`
     */
    capped: z.boolean().optional(),
    compactAt: z.number().optional(),
  }),
  z.object({
    ...base,
    ...endsTurn,
    type: z.literal('limit_reached'),
    /** ISO8601, the tool's expected reset */
    resumeAt: z.string().optional(),
    /** Codex only */
    usedPercent: z.number().optional(),
    windowMins: z.number().optional(),
    /** A limit on credits or spend (Codex), which no time resets: never continued by itself */
    credits: z.boolean().optional(),
  }),
  // Who set the name travels with it: a receiver judging from its own autoNamed state drops every edit after a person's
  // first. `auto` false: a person's, never overwritten (FR-18); absent, as from an older host: automatic
  z.object({ ...base, type: z.literal('session_title'), title: z.string(), auto: z.boolean().default(true) }),
  z.object({ ...base, type: z.literal('files_touched'), paths: z.array(z.string()) }),
  // Null: an ordinary wait for a reply
  z.object({ ...base, type: z.literal('activity'), activity: SessionActivity.nullable() }),
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('compaction'),
    /** Recorded too, or the person cannot tell why the context never shrank (measured: "Not enough messages to compact.") */
    failed: z.boolean().default(false),
    reason: z.string().optional(),
    /** Only when the tool reports it (Claude compact_metadata) */
    before: z.number().optional(),
    after: z.number().optional(),
    /**
     * Claude's `compact_metadata.trigger`: `manual` is a `/compact` (the person's or Centralu's), `auto` the tool's at its
     * threshold, never taken as Centralu's. Codex does not say; its adapter says `manual` inside the session's compact turn
     */
    trigger: z.enum(['manual', 'auto']).optional(),
  }),
  // Claude Code's `/clear` (measured: this, then an `init` with a new `session_id`); per the SDK, plan-mode exit and other
  // fresh-session flows too, with another `trigger`. A marker (docs/protocol.md §2)
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('conversation_reset'),
    trigger: z.string().optional(),
  }),
  // Text the tool wants the person to read, one line (docs/protocol.md §2). From Claude: `system/informational`,
  // `system/notification`, `model_refusal_fallback` and `model_refusal_no_fallback` when its turn did not fail. From
  // Codex: `warning`, `configWarning`, `deprecationNotice`, `guardianWarning`, `model/rerouted`, an MCP server that
  // failed to start, a thread another client changed. `oncePerSession` measured with codex-cli 0.160.0
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']).catch('info'),
    text: z.string(),
    oncePerSession: z.boolean().optional(),
    from: z.string().optional(),
    label: z.string().optional(),
    audience: z.enum(['you', 'centralu']).optional().catch(undefined),
    summary: z.string().optional(),
    /** What the explanation names, one per line (the settings Codex ignored) */
    items: z.array(z.string()).optional(),
    hint: z.string().optional(),
    mail: z.array(MailDelivered).optional().catch(undefined),
  }),
  // The predecessor's note, pinned in a session born from a handoff: the first message carries only the note's path, and
  // a note cannot be made again once its author is gone. `note` is never broadcast (it can run to megabytes)
  z.object({
    ...base,
    ...persistedSeq,
    type: z.literal('handoff'),
    /** The only value written into the marker */
    from: z.string(),
    note: z.string().optional(),
    /** Stored marker only: whose name the inherited note file is under, for orphan cleanup at startup */
    fromSessionId: z.string().optional(),
  }),
  // Another hand than the person's (the Assistant, the tool, another client): a change with no trace is the silent
  // action this codebase keeps fixing. Values are snapshots
  z.object({
    ...base,
    type: z.literal('settings_changed'),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    verbosity: z.string().nullable(),
    /** Response speed; absent from an older host */
    serviceTier: z.string().nullable().optional(),
    /** Absent from an older host and on a tool's own switch, which never touches it: the receiver keeps its value */
    permissionPreset: PermissionPreset.optional(),
    /** Absent: the Assistant. `tool`: the tool switched by itself (docs/protocol.md §2) */
    // `assistant`: the same as `orchestrator`, under the role's new name, which a host of a later release sends (#2133)
    by: z.enum(['orchestrator', 'tool', 'assistant']).optional(),
    /** A client's `agents.updateSettings`: no toast. A flag, not a `by` word, which an older build fails to parse (§2) */
    person: z.boolean().optional(),
  }),
  // Caught up on a conversation continued from outside — the signal for the UI to reread the record
  z.object({ ...base, type: z.literal('history_synced'), added: z.number() }),
  z.object({ ...base, type: z.literal('session_deleted') }),
  // A session the host made itself (an adopted worktree orphan's manager, create_session); a UI's own comes in its RPC
  // answer. Events of a session not yet registered wait in pendingEvents until this arrives
  z.object({ ...base, type: z.literal('session_created'), session: z.unknown() }),
  // A handoff moved the original's children to the session that took over
  z.object({
    ...base,
    type: z.literal('session_owner'),
    askedBy: z.string().nullable(),
    parentSessionId: z.string().nullable(),
  }),
  // The branch's work landed in the trunk, found by the host (at startup, on a git refresh). A fact for the badge, not an
  // action: the person removes the tree
  z.object({ ...base, type: z.literal('worktree_merged') }),
  // Read through gh; a merged PR (a squash too) is followed by `worktree_merged`
  z.object({
    ...base,
    type: z.literal('worktree_pr'),
    pr: z.object({ number: z.number(), state: z.enum(['open', 'merged', 'closed']), url: z.string() }),
  }),
  // Null: cleared or achieved, as the tool judges. Codex announces it; Claude's CLI does not to a headless session
  // (measured), so its adapter reads the /goal replies, Stop hook feedback and goal-driven turn ends
  // (`ClaudeGoalTracker`). Live-only: codex re-asks after a restart; a swapped Claude process is handed the goal, and
  // after a host restart Claude's shows once the person sends `/goal` (the CLI restores it silently)
  z.object({ ...base, type: z.literal('goal'), goal: SessionGoal.nullable() }),
  // A level, not an edge (docs/protocol.md §2): `live` replaces the set. `clearEnded` is the host's own. Live-only: a
  // Claude process that goes takes its tasks with it (measured)
  z.object({
    ...base,
    type: z.literal('background_tasks'),
    live: z.array(BackgroundTask),
    ended: z.array(BackgroundTask).optional(),
    clearEnded: z.boolean().optional(),
    /** The tool's own full list (Claude's `background_tasks_changed`), the only one that settles an adopted process's */
    snapshot: z.boolean().optional(),
  }),
  // A signal, not the list (docs/plans/mailbox.md §18.8): the header asks `watches.list` again. Live-only
  z.object({ ...base, type: z.literal('watches_changed') }),
  // Claude's init `claude_code_version`, Codex's `initialize` `userAgent`. Once per process, live-only
  z.object({ ...base, type: z.literal('agent_version'), version: z.string() }),
  // App-wide: the host reads the installed versions on its own schedule, with no RPC to answer
  z.object({ ...appScoped, type: z.literal('agent_versions'), status: AgentVersions }),
  // Signed out shows as `-32000` on ACP. Never carries the sign-in address
  z.object({ ...appScoped, type: z.literal('tool_setup'), tool: ToolName, setup: ToolSetup }),
  // App-wide: the host checks on its own schedule, and a check hours into a running window has no RPC answer to ride
  z.object({ ...appScoped, type: z.literal('update_status'), status: UpdateStatus }),
  // Names the thread and nothing of its content, which the screen asks for (`mail.thread`; docs/plans/mailbox.md §12.2)
  z.object({
    ...appScoped,
    type: z.literal('mail_changed'),
    threadId: z.string(),
    toPerson: z.boolean().default(false),
    /** A new message the person can read, not their own: an OS notification, once per message */
    arrived: z.object({ messageId: z.string(), from: MailParty, kind: z.string(), preview: z.string() }).optional(),
  }),
  // A replay after the host stopped asking is answered with no ticket, so it starts nothing
  z.object({ ...appScoped, type: z.literal('update_apply_request'), requestId: z.string() }),
  // `unasked`: no card stood before it (Automatic updates on, host idle), so the window also waits out typing
  z.object({
    ...appScoped,
    type: z.literal('update_apply_go'),
    requestId: z.string(),
    ticket: z.string(),
    unasked: z.boolean().optional(),
  }),
  // Only that the receiver refetches the app's state tool (a screen hears `centralu/notifications/changed`); null
  // `projectId`: a user-folder app. Not sent for a rejected call or a read-only tool's. Batched per app over 250 ms (up
  // to 4 a second); `cause` only when every batched call has one owner
  z.object({
    ...appScoped,
    type: z.literal('external_app_state_changed'),
    appId: AppId,
    projectId: z.string().nullable(),
    cause: AppChangeCause.optional(),
  }),
  // For the run history panel alone. Apart from `external_app_state_changed`, which a read-only tool does not fire (it
  // would loop a screen's refetch, #190), though one can stand up a long agent chain. Batched per app over 250 ms
  z.object({
    ...appScoped,
    type: z.literal('external_app_runs_changed'),
    appId: AppId,
    projectId: z.string().nullable(),
  }),
  // An app's slot or status changed, not a value inside it: the list refetches `apps.list`, not on every tool call
  z.object({ ...appScoped, type: z.literal('external_apps_changed') }),
  // Saved from Settings, by hand or by an agent: refetch `themes.list`
  z.object({ ...appScoped, type: z.literal('themes_changed') }),
  // A window or the Assistant saved one: read `prefs.get` again
  z.object({ ...appScoped, type: z.literal('prefs_changed') }),
  // A limited caller's call waits for the person (docs/protocol.md §1); a window that missed it reads `requests.list`
  z.object({ ...appScoped, type: z.literal('host_request'), request: HostRequest }),
  z.object({
    ...appScoped,
    type: z.literal('host_request_resolved'),
    requestId: z.string(),
    outcome: HostRequestOutcome,
  }),
  // Refetch `apps.questions`. A chain that started from a session raises that session's `approval_request` instead
  z.object({ ...appScoped, type: z.literal('external_app_questions_changed') }),
  // Sent after the write: a screen must not guess the moment from the Assistant's `tool_call`, which comes before the
  // save. Refetch `agents.mcpProposals` and `agents.skillProposals`
  z.object({ ...appScoped, type: z.literal('orchestrator_proposals_changed') }),
  // The same event under the role's new name, which a host of a later release sends (#2133 step 4); this build sends the old one
  z.object({ ...appScoped, type: z.literal('assistant_proposals_changed') }),
  // Settings refetches `projectConsents.list`
  z.object({ ...appScoped, type: z.literal('project_consents_changed') }),
  // A project changed without this window asking (docs/protocol.md §2): the list is re-read. `added`: a folder the person
  // let the Assistant add, whose trust a window asks about once; an older window only re-reads
  z.object({ ...appScoped, type: z.literal('projects_changed'), added: z.string().optional() }),
  // The whole record, so the receiver replaces its row (docs/protocol.md §6)
  z.object({ ...appScoped, type: z.literal('machine_status'), machine: MachineInfo }),
  // A hub keeps it on `MachineInfo.handover` and passes it on to no one. Null: none pending
  z.object({ ...appScoped, type: z.literal('host_handover'), handover: HostHandover.nullable() }),
  // A full credential other than the hub's own said hello here (docs/protocol.md §3 `host.credentials`); the host has
  // recorded it in its file before the socket got its rights
  z.object({
    ...appScoped,
    type: z.literal('host_credential_used'),
    credential: z.object({
      id: z.string().max(16),
      label: z.string().max(80),
      created: z.number(),
      replaced: z.boolean().catch(false).default(false),
      // A verifier's `nonce` and `check`, or a key entry's `publicKey`, which is not secret
      nonce: z.string().min(8).max(64).optional(),
      check: z.string().max(64).optional(),
      publicKey: z.string().max(64).optional(),
    }),
  }),
  // Re-read what the UI holds about that machine (docs/protocol.md §6); the gap's events are not replayed
  z.object({ ...appScoped, type: z.literal('machine_resync'), machineId: z.string() }),
  // Only which directories to re-read, never what changed: macOS collapses renames, so the detail would be right on one
  // platform of three
  z.object({ ...appScoped, type: z.literal('fs_changed'), projectId: z.string(), dirs: z.array(z.string()) }),
  // A session's error is recorded as a marker row, so it carries `persistedSeq`: without it zod strips `seq`, and the
  // session shows an unread dot after it was viewed
  z.object({ ...appScoped, ...persistedSeq, ...endsTurn, type: z.literal('error'), error: ProtocolError }),
])
export type NormalizedEvent = z.infer<typeof NormalizedEvent>

export type NormalizedEventType = NormalizedEvent['type']

/** Drops an unknown event type (docs/protocol.md §4). Only at the receiving boundary */
export function parseEventLenient(raw: unknown): NormalizedEvent | null {
  const r = NormalizedEvent.safeParse(raw)
  return r.success ? r.data : null
}

/** The event as it may leave the host: tool calls and results, a subagent's too, without `input` and `output` */
export function withoutToolRecord(e: NormalizedEvent): NormalizedEvent {
  if (e.type === 'subagent_event') {
    const step = withoutStepRecord(e.step)
    return step === e.step ? e : { ...e, step }
  }
  if (e.type === 'tool_call' || e.type === 'tool_result') return withoutStepRecord(e)
  return e
}

function withoutStepRecord(step: SubagentStep): SubagentStep {
  if (step.type === 'tool_call' && 'input' in step) {
    const { input: _input, ...card } = step
    return card
  }
  if (step.type === 'tool_result' && 'output' in step) {
    const { output: _output, ...card } = step
    return card
  }
  return step
}
