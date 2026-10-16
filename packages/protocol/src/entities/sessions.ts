import { z } from 'zod'
import { ToolName } from './ids.js'

/** A session's state (product-spec FR-12). Urgency is judged by core/session. */
export const SessionState = z.enum(['idle', 'working', 'waiting_approval', 'waiting_input', 'limited', 'error'])
export type SessionState = z.infer<typeof SessionState>

/**
 * **What** a session is doing while it is busy. A different axis from SessionState.
 *
 * The state remains 'working' even while compacting — since nothing is waiting on us, there is
 * no reason to change it, and adding a new state would silently break every piece of code that
 * checks `state === 'working'`. But looking at the screen alone, it is indistinguishable from
 * generating a reply: both just blink a dot. Measured: one manual compaction took 39 seconds,
 * and during that time there was no way to tell whether it was stuck or working.
 */
/**
 * The kind of busy. compacting comes from either tool, reviewing comes from codex's /review (a
 * dedicated RPC). retrying is codex reconnecting on its own after a dropped stream (an `error`
 * notification with `willRetry`, #168): the turn is still alive, so it is not a failure, but a
 * wait of several attempts should not look like an ordinary one.
 */
export const SessionActivity = z.enum(['compacting', 'reviewing', 'retrying'])

/**
 * Why a session's turn did not run to its end, when nobody here chose to stop it (#698). A session in this state
 * looks like any other at rest (`error`, `idle`, `waiting_input`), and on 2026-10-15 several child sessions sat in
 * `error` for most of a day after the internet dropped twice, with neither the person nor the orchestrator told.
 *
 *   network       the turn failed because the model's API could not be reached (ECONNREFUSED, ENOTFOUND, no
 *                 response, the computer slept), after the tool's own retries
 *   quit          Centralu quit or the computer restarted while the turn ran, and the process went with it: a start
 *                 found the session `working` with no process left and reset it to `idle`
 *   interrupted   the tool interrupted the turn, and neither the person nor Centralu asked it to (Codex's
 *                 `turn/completed` with `interrupted` that no Stop of ours preceded)
 *   reconnecting  still `working`, but the tool has been reconnecting to its API for longer than the host's bound
 *                 (`retrying` past it). Live only: the turn may still go on by itself
 *
 * The person's own Stop is none of these: they know. Cleared when the session works again. An unknown word from a
 * newer host reads as `interrupted`, which still says "this turn did not finish".
 */
export const InterruptionReason = z.enum(['network', 'quit', 'interrupted', 'reconnecting']).catch('interrupted')
export type InterruptionReason = z.infer<typeof InterruptionReason>

export const Interruption = z.object({
  reason: InterruptionReason,
  /** When it happened (ms); for `reconnecting`, when the reconnecting began */
  at: z.number(),
  /** The tool's own words, where it gave some (the error's message) */
  detail: z.string().optional(),
})
export type Interruption = z.infer<typeof Interruption>

/**
 * The goal set on a session (2026-09-07 — claude's `/goal`, and codex's thread/goal/*).
 *
 * This is the union of both tools: objective/status are shared, iterations/reason are claude's
 * (the number of laps and the reason it fell short, judged each time the Stop hook runs — read
 * from the CLI's Stop hook feedback, since its `active_goal` does not reach a headless session), and
 * tokenBudget/tokensUsed are codex's. status carries the tool's own vocabulary as-is — claude
 * only ever has 'active' while a goal is set (achieving it arrives as a null notification), while
 * codex has active, paused, blocked, usageLimited, budgetLimited, complete. Why this is not
 * tightened into an enum: if the protocol broke every time a tool added a new word, that would
 * cost far more than the value of a single badge.
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
 * One piece of work an agent runs in the background of a session (#290): a subagent, a backgrounded shell command,
 * an MCP task. The adapter maps its tool's own report onto this — Claude's `background_tasks_changed` and task
 * messages, Codex's child threads — and an adapter that cannot see its background work reports nothing rather than
 * guessing.
 *
 *   kind           what it is. A tool's kind that fits none of the first three is `other`; an unknown word from a
 *                  newer host reads as `other` too, instead of failing the whole event
 *   parentCallId   the tool call that started it, when known: Claude's `Agent` or `Bash` tool_use id, Codex's
 *                  `spawnAgent` collab item. For an agent this is also the key of its recorded steps (#222)
 *   ambient        housekeeping the tool itself says is not activity (Claude's flag). Listed, never counted
 *   stopsWithTurn  what interrupting the session's turn does to it, as measured per tool: true stops it, false
 *                  leaves it running, absent means not measured. Claude: a subagent stops, a shell continues;
 *                  Codex: a child agent continues (probe-background-tasks.mts, probe-codex-background.mts)
 *   stoppable      it can be stopped on its own (`agents.stopBackgroundTask`)
 *   timer          a timer the tool holds rather than work it runs: Claude's `ScheduleWakeup` (`/loop`) and `CronCreate`
 *                  (#721). It keeps the process awake like any task, but a report is not held for it
 *   status         running while it is in the live set; an ended task keeps how it ended
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
 * The one way a session's task list moves (#290) — the host's manager, the UI's reducer and the mock all call this,
 * so the three cannot drift apart.
 *
 * `live` replaces every running entry (REPLACE semantics: a missed edge cannot leave a stale "running"). `ended`
 * adds tasks that just left, with their status; an ended task stays listed until `clearEnded` or until it is pushed
 * out by newer ones (`BACKGROUND_ENDED_KEPT`). A task that leaves the live set with no `ended` entry simply
 * disappears — the adapter did not say how it ended, and nothing here guesses.
 */
export function applyBackgroundTasks(
  prev: readonly BackgroundTask[],
  e: { live: readonly BackgroundTask[]; ended?: readonly BackgroundTask[]; clearEnded?: boolean },
): BackgroundTask[] {
  const live = e.live.map((t) => ({ ...t, status: 'running' as const }))
  const liveIds = new Set(live.map((t) => t.id))
  const fresh = (e.ended ?? []).filter((t) => !liveIds.has(t.id) && t.status !== 'running')
  const freshIds = new Set(fresh.map((t) => t.id))
  const kept = e.clearEnded ? [] : prev.filter((t) => t.status !== 'running' && !liveIds.has(t.id) && !freshIds.has(t.id))
  return [...live, ...[...kept, ...fresh].slice(-BACKGROUND_ENDED_KEPT)]
}

/** The running tasks that count as activity — what the header, the sidebar and the idle check count (ambient excluded) */
export function liveBackgroundTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return tasks.filter((t) => t.status === 'running' && !t.ambient)
}

/**
 * Choices an agent presents to a person (AskUserQuestion).
 *
 * **Never truncated.** During dogfooding, this tool call once got cut off partway while flowing
 * through as raw JSON, and everything from the second option onward disappeared — the entire
 * means of answering vanished with it. Unlike an approval (ApprovalDetail), this does not carry
 * a preview — it carries **everything needed to answer**.
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

/** The answer to one question — the chosen labels (several if multiSelect, or the typed text for free input) */
export const QuestionAnswer = z.object({
  question: z.string(),
  answers: z.array(z.string()),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswer>

export const ToolSummary = z.object({
  tool: z.string(),
  /** A one-line summary (the full command, a file path, etc.) */
  title: z.string(),
  /**
   * No longer set or read (#428). It was meant to collapse a read-only tool's card (FR-3), but every card folds now
   * (core/approval.ts), and the two adapters' classifiers had drifted (Codex counted every `git` command, `git push`
   * included, as read-only). Kept, optional, so events and stored records from older builds still parse.
   */
  readOnly: z.boolean().optional(),
  paths: z.array(z.string()).default([]),
})
export type ToolSummary = z.infer<typeof ToolSummary>

/**
 * An attachment (FR-13).
 * An image is never put into messages.payload as base64 — it would bloat the database and
 * pollute FTS. The host saves it as a file and only the path is exchanged (m2-plan decision D-1).
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
 * A prior session the tool itself keeps (outside Centralu — including one created in a terminal).
 *
 * Both the list and the body are read **only through each tool's official API**.
 * ~/.claude/projects/**.jsonl and ~/.codex/sessions/**.jsonl are never parsed directly: that file
 * format is not a documented contract, so it breaks silently when the tool is upgraded. The
 * official API absorbs its own version's storage format differences on its own.
 */
export const ExternalSession = z.object({
  externalId: z.string(),
  tool: ToolName,
  title: z.string(),
  updatedAt: z.number(),
  createdAt: z.number().nullable().default(null),
  branch: z.string().nullable().default(null),
  /** A session already imported into Centralu — keeps the same conversation from being opened twice */
  imported: z.boolean().default(false),
  /**
   * **The id of that session**, if it is already open.
   *
   * A label alone is not enough — this used to just say "already imported" while the click still
   * went through as before, producing the same conversation twice in the list (confirmed by
   * measurement). If this value is present, the UI takes the person to that session instead of
   * creating a new one.
   */
  importedAs: z.string().nullable().default(null),
})
export type ExternalSession = z.infer<typeof ExternalSession>
