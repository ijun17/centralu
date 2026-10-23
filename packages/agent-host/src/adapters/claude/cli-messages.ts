import type { NormalizedEvent } from '@cc/protocol'
import { str, type Json } from './json.js'

/**
 * What the CLI says about itself rather than what the model says (`normalizeMessage`): the `system` messages, a
 * conversation reset and the goal's status.
 */

/*
 * `/clear` (#304). Measured (CLI 2.1.289 through SDK 0.3.263, haiku, 2026-10-04): `/clear` passes straight through
 * to the CLI, which sends `conversation_reset {new_conversation_id, trigger: 'clear', user_message_uuid}`, then an
 * `init` carrying a **new `session_id`** (19eced5a… → b7843a7a…) and a result with `num_turns: 0`. The adapter
 * already follows the new id; what was missing is any sign on screen that the model now knows nothing above this
 * point. The context gauge read 15,967 before and 14,093 after (the system prompt alone).
 */
export function conversationResetEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const trigger = str(m.trigger)
  out.push({ type: 'conversation_reset', sessionId, ...(trigger ? { trigger } : {}) })
  return out
}

/*
 * A goal-status notification (2026-09-07 — /goal's Stop hook, SDKActiveGoalMessage). The same
 * category as #58: while this type was not handled, goal state was silently dropped. A `value`
 * of null means the goal was cleared (including having been achieved), and while one is set,
 * Claude's status vocabulary has exactly one word, 'active' — the iteration count and the reason
 * it has not been reached are the actual content.
 *
 * **The installed CLI does not send this to us** (measured 2026-10-03, CLI 2.1.282 through SDK
 * 0.3.263, whose runtime does pass the type through): the CLI's headless loop folds the event into
 * its own state, and writes it to stdout only in a remote (`CLAUDE_CODE_REMOTE`) session. So the
 * badge is driven by `ClaudeGoalTracker` (goal-tracker.ts); this stays for a CLI that starts sending it, and
 * when one does, the tracker stands down.
 */
export function activeGoalEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const v = (m.value ?? null) as Json | null
  out.push({
    type: 'goal',
    sessionId,
    goal: v
      ? {
          objective: str(v.condition),
          status: 'active',
          ...(typeof v.iterations === 'number' ? { iterations: v.iterations } : {}),
          ...(str(v.last_reason) ? { reason: str(v.last_reason) } : {}),
        }
      : null,
  })
  return out
}

/** A `system` message, by its subtype; one nothing here maps gives no events. */
export function systemEvents(m: Json, sessionId: string): NormalizedEvent[] {
  switch (str(m.subtype)) {
    case 'informational':
      return informationalEvents(m, sessionId)
    case 'notification':
      return notificationEvents(m, sessionId)
    case 'api_retry':
      return apiRetryEvents(m, sessionId)
    case 'status':
      return statusEvents(m, sessionId)
    case 'local_command_output':
      return localCommandOutputEvents(m, sessionId)
    case 'compact_boundary':
      return compactBoundaryEvents(m, sessionId)
    default:
      return []
  }
}

/*
 * Text the CLI shows its own user (#304). `system/informational` carries hook feedback: measured (CLI 2.1.289), a
 * `UserPromptSubmit` hook that exits 2 sends `{content: "UserPromptSubmit operation blocked by hook:\n[<command>]:
 * <its stderr>\n\nOriginal prompt: …", level: 'warning', prevent_continuation: true}`, then a result with
 * `num_turns: 0`. Nothing reached the screen before: the prompt simply went unanswered. The SDK says level `info`
 * "shows only in transcript mode", so the CLI itself hides it, and so does this.
 */
function informationalEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const text = str(m.content).trim()
  const level = str(m.level)
  if (text && level !== 'info') {
    // Who is speaking and what kind (#342). A hook is part of the person's own setup (theirs or the project's)
    const hook = /\bblocked by hook\b/.test(text)
    out.push({
      type: 'notice',
      sessionId,
      level: level === 'warning' ? 'warning' : 'info',
      text,
      from: 'Claude Code',
      label: hook ? 'hook' : 'notice',
      ...(hook ? { audience: 'you' as const } : {}),
    })
  }
  return out
}

/*
 * The CLI's notification queue (#304, not exercised: it carries things like fast-mode credits running out or a model
 * the organization denies). Its colour and priority fold into the notice's level. "Error compacting conversation" is
 * left out: the failed-compaction marker (`status` below) already says so, with the reason.
 */
function notificationEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const text = str(m.text).trim()
  if (!text || str(m.key) === 'error-compacting-conversation') return out
  const color = str(m.color)
  const priority = str(m.priority)
  const level = color === 'error' ? 'error' : color === 'warning' || priority === 'high' || priority === 'immediate' ? 'warning' : 'info'
  out.push({ type: 'notice', sessionId, level, text, from: 'Claude Code', label: 'notice' })
  return out
}

/*
 * The CLI is retrying a failed API call (#304), the twin of Codex's `error {willRetry}`. Measured (CLI 2.1.289, an
 * `ANTHROPIC_BASE_URL` answering 529, `CLAUDE_CODE_MAX_RETRIES=2`): `{attempt: 1, max_retries: 2, retry_delay_ms: 556,
 * error_status: 529, error: 'overloaded'}`, the same for attempt 2, then a synthetic assistant message "API Error: 529
 * Overloaded…" and an error result. Nothing came between the attempts, so the screen read "waiting for a reply" for
 * the whole time. It shows as the `retrying` activity (`ClaudeStreamNormalizer` puts back what was showing once output
 * flows again) and goes to host.log with the reason.
 */
function apiRetryEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const status = typeof m.error_status === 'number' ? `${m.error_status} ` : ''
  const delay = typeof m.retry_delay_ms === 'number' ? ` in ${m.retry_delay_ms}ms` : ''
  console.error(
    `[claude] ${sessionId.slice(0, 8)} retrying after: ${status}${str(m.error, 'connection error')} (attempt ${String(m.attempt ?? '?')}/${String(m.max_retries ?? '?')}${delay})`,
  )
  out.push({ type: 'activity', sessionId, activity: 'retrying' })
  return out
}

/*
 * What is currently happening.
 *
 * A probe confirmed the actual ordering:
 *   status:'compacting' → (39 seconds) → status:null + compact_result:'success' → compact_boundary
 * For those 39 seconds, the UI looked no different from ordinary "waiting for response" — a
 * problem that surfaced from dogfooding.
 */
function statusEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  out.push({ type: 'activity', sessionId, activity: m.status === 'compacting' ? 'compacting' : null })
  /*
   * A failure is never swallowed. If compaction fails, the context stays exactly as it was, but
   * the UI would otherwise look as if nothing had happened — a case that measured, actually
   * occurred ("Not enough messages to compact.").
   */
  if (str(m.compact_result) === 'failed') {
    out.push({ type: 'compaction', sessionId, failed: true, reason: str(m.compact_error, 'Unknown reason') })
  }
  return out
}

/*
 * The output of a local command (SDKLocalCommandOutputMessage — the **generalized channel** for
 * things like /usage).
 *
 * This is the sibling of the dogfooding incident where /usage's answer arrived as a delta-less
 * assistant message and never showed up: the output of a command the CLI handles locally can
 * also arrive as this system message, and dropping it means the command ran but only the answer
 * disappeared. To the person, this occupies the same place as something the assistant said.
 */
function localCommandOutputEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const content = str(m.content)
  if (content) out.push({ type: 'message_delta', sessionId, role: 'assistant', text: content })
  return out
}

/*
 * The point where compaction finished (FR-14).
 *
 * Without this, **a compaction marker never once appeared in a Claude session** — only Codex
 * had one. Without a marker, there is no way to know where the fold is, so "scroll back past
 * this point" cannot work either.
 */
function compactBoundaryEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const meta = (m.compact_metadata ?? {}) as Json
  out.push({
    type: 'compaction',
    sessionId,
    failed: false,
    before: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined,
    after: typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined,
    ...(meta.trigger === 'manual' || meta.trigger === 'auto' ? { trigger: meta.trigger } : {}),
  })
  return out
}
