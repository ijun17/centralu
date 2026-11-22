import { z } from 'zod'
import { ToolName } from './ids.js'

/** A session's state (product-spec FR-12). Urgency is judged by core/session. */
export const SessionState = z.enum([
  'idle',
  'working',
  'waiting_approval',
  'waiting_input',
  'limited',
  'error',
])
export type SessionState = z.infer<typeof SessionState>

/**
 * What a busy session is doing, beside its state, which stays 'working' (code checks `state === 'working'`). It tells a
 * compaction (measured: one took 39 s) from a stuck reply. `reviewing` is Codex's /review; `retrying` is Codex
 * reconnecting after a dropped stream (`error` with `willRetry`): the turn is alive, not failed.
 */
export const SessionActivity = z.enum(['compacting', 'reviewing', 'retrying'])

/**
 * Why a turn did not run to its end when nobody here chose to stop it; the person's own Stop is none of these. Each
 * reason, set and cleared: docs/agent-host/lifecycle/turn-endings-and-mail.md. `reconnecting` is live only: the turn
 * may still go on. An unknown word from a newer host reads as `interrupted`, which still says the turn did not finish.
 */
export const InterruptionReason = z
  .enum(['network', 'limit', 'quit', 'shutdown', 'interrupted', 'reconnecting'])
  .catch('interrupted')
export type InterruptionReason = z.infer<typeof InterruptionReason>

/**
 * What a `shutdown` says happened, in the same words everywhere it is said (label, composer note, conversation line, the
 * Assistant's list, the report). After a colon, so it starts in lower case
 */
export const SHUTDOWN_WORDS = 'the computer shut down, restarted or signed out'

/**
 * What going on with a stopped turn asks: the person's Continue sends it, and each of Centralu's continue notes ends
 * with it. Short, as the agent still has its conversation; the second sentence because a cut turn may have done part of a step
 */
export const CONTINUE_WORDS = 'Continue where you stopped. Check what already happened before repeating a step.'

export const Interruption = z.object({
  reason: InterruptionReason,
  /** When it happened (ms); for `reconnecting`, when the reconnecting began */
  at: z.number(),
  /** The tool's own words, where it gave some (the error's message) */
  detail: z.string().optional(),
  /**
   * Centralu continues the turn once its cause clears (docs/agent-host/lifecycle/auto-continue.md); the host decides, so
   * a window shows the wait without working it out. `at`: when (ms), a usage limit's reset; absent for the network.
   * `tries`: continues made in this run of stops. Absent: nothing continues it by itself, or an older host
   */
  autoContinue: z.object({ at: z.number().optional(), tries: z.number().int().min(0) }).optional(),
  /** The continues Centralu made before it left the stop to the person (`MAX_TRIES`, #2360). Absent: none, or an older host */
  gaveUpAfter: z.number().int().min(1).optional(),
  /** A `limit` stop's reset (ms), kept when the wait goes (#1415). Absent: not known, or an older host */
  resetAt: z.number().optional(),
})
export type Interruption = z.infer<typeof Interruption>

/**
 * The union of Claude's `/goal` and Codex's thread/goal/*. `iterations` and `reason` are Claude's, read from the CLI's
 * Stop hook feedback (its `active_goal` does not reach a headless session); the token fields are Codex's. `status` is
 * the tool's own word (Claude only says 'active', a reached goal arrives as null), not an enum, so a new word breaks nothing.
 */
export const SessionGoal = z.object({
  objective: z.string(),
  status: z.string(),
  iterations: z.number().optional(),
  reason: z.string().optional(),
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number().optional(),
})
export type SessionGoal = z.infer<typeof SessionGoal>
export type SessionActivity = z.infer<typeof SessionActivity>

/**
 * Background work in a session: a subagent, a backgrounded shell, an MCP task. The fields: docs/protocol.md §2; what each
 * tool reports and the measured `stopsWithTurn`: docs/agent-host/adapters/contract.md. An adapter that cannot see its
 * background work reports nothing rather than guessing. An unknown `kind` reads as `other`.
 */
export const BackgroundTaskKind = z.enum(['agent', 'shell', 'mcp', 'other'])
export type BackgroundTaskKind = z.infer<typeof BackgroundTaskKind>
export const BackgroundTaskStatus = z.enum(['running', 'completed', 'failed', 'stopped'])
export type BackgroundTaskStatus = z.infer<typeof BackgroundTaskStatus>
export const BackgroundTask = z.object({
  id: z.string(),
  kind: BackgroundTaskKind.catch('other'),
  description: z.string(),
  parentCallId: z.string().optional(),
  ambient: z.boolean().optional(),
  stopsWithTurn: z.boolean().optional(),
  stoppable: z.boolean().optional(),
  timer: z.boolean().optional(),
  status: BackgroundTaskStatus.catch('completed').default('running'),
  /** How it ended, in the tool's words (a failure's reason, a stop's cause). Ended tasks only */
  summary: z.string().optional(),
})
export type BackgroundTask = z.infer<typeof BackgroundTask>

/** How many ended tasks a session keeps listed. Enough for one burst of parallel agents, small enough to stay a list */
export const BACKGROUND_ENDED_KEPT = 10

/**
 * The one way a session's task list moves: the host's manager, the UI's reducer and the mock all call it. `live`
 * replaces every running entry (a missed edge cannot leave a stale "running"); `ended` adds tasks that left. An ended
 * task stays until `clearEnded`, `BACKGROUND_ENDED_KEPT`, or the next burst (work starting while none ran, #2230). A
 * task that leaves with no `ended` entry disappears: nothing guesses how it ended.
 */
export function applyBackgroundTasks(
  prev: readonly BackgroundTask[],
  e: { live: readonly BackgroundTask[]; ended?: readonly BackgroundTask[]; clearEnded?: boolean },
): BackgroundTask[] {
  const live = e.live.map((t) => ({ ...t, status: 'running' as const }))
  const liveIds = new Set(live.map((t) => t.id))
  const fresh = (e.ended ?? []).filter((t) => !liveIds.has(t.id) && t.status !== 'running')
  const freshIds = new Set(fresh.map((t) => t.id))
  const newBurst = liveBackgroundTasks(live).length > 0 && liveBackgroundTasks(prev).length === 0
  const kept = e.clearEnded || newBurst
    ? []
    : prev.filter((t) => t.status !== 'running' && !liveIds.has(t.id) && !freshIds.has(t.id))
  return [...live, ...[...kept, ...fresh].slice(-BACKGROUND_ENDED_KEPT)]
}

/** The running tasks that count as activity — what the header, the sidebar and the idle check count (ambient excluded) */
export function liveBackgroundTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return tasks.filter((t) => t.status === 'running' && !t.ambient)
}

/**
 * What a paused report or a reminder waits for: the live tasks without a tool's timers (`/loop`, `CronCreate`). A timer
 * keeps a process awake but is not work: counting it would hold a report or a reminder for good
 */
export function workTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return liveBackgroundTasks(tasks).filter((t) => !t.timer)
}

/**
 * Choices an agent presents to a person (AskUserQuestion). Never truncated: cut (measured), the call loses every option
 * after the cut and the means of answering. Unlike an approval, it carries everything needed to answer, not a preview.
 */
export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().default(''),
})
export type QuestionOption = z.infer<typeof QuestionOption>

export const Question = z.object({
  question: z.string(),
  /** A short tag (12 characters or fewer recommended) */
  header: z.string().default(''),
  options: z.array(QuestionOption),
  multiSelect: z.boolean().default(false),
})
export type Question = z.infer<typeof Question>

/** The chosen labels (several if multiSelect), or the typed text for free input */
export const QuestionAnswer = z.object({
  question: z.string(),
  answers: z.array(z.string()),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswer>

export const ToolSummary = z.object({
  tool: z.string(),
  /** One line (the full command, a file path, etc.) */
  title: z.string(),
  /** Not set or read: every card folds (core/approval.ts). Kept so older builds' events and stored records parse */
  readOnly: z.boolean().optional(),
  paths: z.array(z.string()).default([]),
  /**
   * A call to one of Centralu's own tools (the `centralu` server's, or an app's: `app` its id), drawn apart on the card.
   * Set by the adapter: only Claude's tool name carries the server. `tool` bare (`start_agent`), `label` in words, and
   * `sessionId` the session the call names. Absent from older records, where the screen reads `mcp__centralu__…`
   */
  centralu: z
    .object({
      tool: z.string(),
      app: z.string().optional(),
      label: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
})
export type ToolSummary = z.infer<typeof ToolSummary>

/**
 * An attachment (FR-13). An image is never base64 in messages.payload (it would bloat the database and pollute FTS):
 * the host saves it as a file and only the path is exchanged.
 */
export const Attachment = z.object({
  kind: z.enum(['image', 'file']),
  /** A relative path for a file inside the project, or the saved absolute path for a pasted image */
  path: z.string(),
  name: z.string(),
  mime: z.string().optional(),
  bytes: z.number().optional(),
})
export type Attachment = z.infer<typeof Attachment>

/**
 * A prior session the tool itself keeps (one started in a terminal too), listed and read only through the tool's
 * official API, never its files (docs/agent-host/importing-sessions.md).
 */
export const ExternalSession = z.object({
  externalId: z.string(),
  tool: ToolName,
  title: z.string(),
  updatedAt: z.number(),
  createdAt: z.number().nullable().default(null),
  branch: z.string().nullable().default(null),
  /** Keeps the same conversation from being opened twice */
  imported: z.boolean().default(false),
  /**
   * The open session's id: the UI goes there instead of making a new one (measured: a label alone still let the click
   * through, and the conversation opened twice)
   */
  importedAs: z.string().nullable().default(null),
})
export type ExternalSession = z.infer<typeof ExternalSession>
