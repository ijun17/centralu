import { asObj, finite, str } from '../../json-value.js'
import { type NormalizedEvent, type SessionGoal } from '@cc/protocol'
import { mcpImageEvents } from '../images.js'
import { planUpdate } from '../plan.js'
import { toolResultEvent } from '../tool-result.js'
import { codexItemOk, fileChangesOf, itemInput, itemSummary, resultSummary } from './items.js'
import { turnError } from './model-rejected.js'
import { noticeWords } from './notices.js'
import { paramsOf } from './params.js'
import { tokenUsageEvents } from './token-readings.js'

/**
 * Codex protocol to NormalizedEvent conversion (based on the method names confirmed in M0).
 *
 * This is the anti-corruption boundary. No Codex type leaves this file or the readers beside it: the ones it calls
 * (items, token-readings) and the ones the session calls (approvals, thread-settings, child-tracker, known-notifications).
 * Kept as pure functions so contract tests can run without a process.
 */

export type Notification = { method: string; params?: unknown }

/**
 * codex ThreadGoal to protocol SessionGoal (2026-09-07).
 * The updated notification and the thread/goal/get called right after resume share this same
 * conversion — two copies would drift apart.
 *
 * **Complete means cleared** (dogfooding: the complete badge stayed forever). codex sends
 * updated(status:complete) rather than cleared when a goal is achieved, but an achieved goal is
 * an ending, not a state, and an ending is not the badge's job — the same convention as claude
 * (achieved -> a null notification). paused, blocked, usageLimited and budgetLimited survive:
 * those are states where action is still possible.
 */
export function goalFromCodex(g: Record<string, unknown>): SessionGoal | null {
  if (str(g.status) === 'complete') return null
  return {
    objective: str(g.objective),
    status: str(g.status) || 'active',
    ...(typeof g.tokenBudget === 'number' ? { tokenBudget: g.tokenBudget } : {}),
    ...(typeof g.tokensUsed === 'number' ? { tokensUsed: g.tokensUsed } : {}),
  }
}

/**
 * One marker per compaction, whichever of its two signs arrive (#303).
 *
 * A compaction can be announced twice: by the completed `contextCompaction` item and by the deprecated
 * `thread/compacted` notification, both carrying the turn they belong to. Every measured CLI (0.147.0, 0.153.4,
 * 0.160.0) sent only the item, but the adapter's own notes from earlier dogfooding record the sequence "item, then
 * `thread/compacted`", so a CLI that sends both must not leave two markers in the same spot. Pairing is per turn and
 * does not depend on order: a sign is admitted unless the other kind of sign for the same turn is still waiting for
 * its partner, in which case the two are one compaction. Two compactions in one turn that each send only the item
 * still leave two markers.
 */
export class CompactionMarks {
  /** Per turn: which kind of sign was admitted without a partner yet, and how many */
  private readonly open = new Map<string, { kind: 'item' | 'notice'; count: number }>()

  /** Whether this notification's compaction marker should be emitted */
  admit(n: Notification): boolean {
    const kind = n.method === 'thread/compacted' ? 'notice' : 'item'
    const turn = str(asObj(n.params).turnId)
    const waiting = this.open.get(turn)
    if (waiting && waiting.kind !== kind) {
      if (--waiting.count === 0) this.open.delete(turn)
      return false
    }
    this.open.delete(turn) // re-inserted last, so the oldest turn is the one let go below
    this.open.set(turn, { kind, count: (waiting?.count ?? 0) + 1 })
    // A CLI that sends only one kind leaves every turn open; the partner of an old turn is not coming
    if (this.open.size > 32) this.open.delete(this.open.keys().next().value!)
    return true
  }
}

/** The message a chunk belongs to — left out rather than empty, since absent means "the same message as before" */
export const messageIdOf = (id: unknown): { messageId?: string } => (typeof id === 'string' && id ? { messageId: id } : {})

/**
 * Converts one notification into zero or more NormalizedEvents.
 * An unknown notification is **dropped silently** — this must not break as the protocol grows
 * (protocol.md §4).
 */
export function normalizeNotification(sessionId: string, n: Notification): NormalizedEvent[] {
  // Each case reads its params by the generated type of its method (params.ts, #1339)
  switch (n.method) {
    /*
     * Each chunk names its agentMessage item (generated/v2/AgentMessageDeltaNotification.ts: `itemId`), and the
     * host starts a new row when that changes (#212). Without it, two messages with nothing recorded between
     * them were stored as one row. Measured (scripts/probe-codex-message-boundary.mts, codex-cli 0.153.4): two
     * commentary messages with a `write_stdin` poll of a running command between them. The poll arrives as
     * `item/commandExecution/terminalInteraction`, which is not an item, and the reasoning items between them
     * had no summary text. The row read "It is still running; I'm polling it now.It is still running; I'm
     * polling it again."
     */
    case 'item/agentMessage/delta': {
      const p = paramsOf(n, 'item/agentMessage/delta')
      // A `text` is not in AgentMessageDeltaNotification: read as before, for a CLI that sends one
      return [{ type: 'message_delta', sessionId, role: 'assistant', text: str(p.delta) || str(asObj(n.params).text), ...messageIdOf(p.itemId) }]
    }

    /*
     * Reasoning summary (measured for #58). This stream only arrives if model_reasoning_summary
     * is turned on in the thread settings — index.ts turns it on. Measured shape:
     *   item/reasoning/summaryPartAdded {itemId, summaryIndex}         — a new paragraph
     *   item/reasoning/summaryTextDelta {itemId, delta, summaryIndex}  — a chunk of text
     * The completed reasoning item also carries the full summary text, but we do not emit it —
     * it already streamed through the deltas, so emitting it again would append the same text
     * twice (the same rule as agentMessage).
     */
    case 'item/reasoning/summaryTextDelta': {
      const p = paramsOf(n, 'item/reasoning/summaryTextDelta')
      const text = str(p.delta)
      return text ? [{ type: 'reasoning_delta', sessionId, text }] : []
    }
    case 'item/reasoning/summaryPartAdded': {
      const p = paramsOf(n, 'item/reasoning/summaryPartAdded')
      // A paragraph boundary. There must be nothing before the first paragraph
      return typeof p.summaryIndex === 'number' && p.summaryIndex > 0
        ? [{ type: 'reasoning_delta', sessionId, text: '\n\n' }]
        : []
    }

    /*
     * Plan progress (measured for #58). The measured shape:
     *   turn/plan/updated {threadId, turnId, explanation: null,
     *                      plan: [{step, status: 'pending'|'inProgress'|'completed'}]}
     * It is a full snapshot every time. A plan **never arrives** as an item — dropping this
     * notification would leave codex's use of the plan tool invisible everywhere on screen
     * (measured: this turn's items were only userMessage, reasoning, agentMessage and
     * commandExecution).
     */
    case 'turn/plan/updated': {
      const p = paramsOf(n, 'turn/plan/updated')
      // The same steps Claude's TodoWrite gives (adapters/plan.ts)
      return Array.isArray(p.plan) && p.plan.length > 0 ? [planUpdate(sessionId, p.plan, 'step')] : []
    }

    /*
     * Output while a command is running (measured for #58): {threadId, turnId, itemId, delta}.
     * On completion, aggregatedOutput carries the whole thing again, so this is display-only.
     * (Measured: the first chunk can be consumed before the stream attaches and get dropped —
     * the assumption that summing the deltas equals the full output does not hold.)
     */
    case 'item/commandExecution/outputDelta': {
      const p = paramsOf(n, 'item/commandExecution/outputDelta')
      const text = str(p.delta)
      return text ? [{ type: 'tool_output_delta', sessionId, callId: str(p.itemId), text }] : []
    }

    case 'item/started': {
      const item = asObj(paramsOf(n, 'item/started').item)
      const type = str(item.type)
      if (type === 'userMessage' || type === 'reasoning' || type === 'agentMessage') return []
      /*
       * Compaction is not a tool call. Without filtering this out, the conversation gets an
       * unidentifiable tool line named 'contextCompaction' — and the "compacting now" indicator
       * that is actually needed is nowhere to be found.
       */
      if (type === 'contextCompaction') return [{ type: 'activity', sessionId, activity: 'compacting' }]
      /*
       * The start of a review (/review -> the review/start RPC). For the same reason as
       * compaction, this is an activity, not a tool line — the review body streams separately as
       * agentMessage, so making a tool line here would leave an unidentifiable call named
       * "enteredReviewMode" in the conversation (the measured shape).
       */
      if (type === 'enteredReviewMode') return [{ type: 'activity', sessionId, activity: 'reviewing' }]
      if (type === 'exitedReviewMode') return [{ type: 'activity', sessionId, activity: null }]
      // The start of viewing an image is not a tool line — the image itself is emitted at completion (#40)
      if (type === 'imageView') return []
      const s = itemSummary(item)
      return [{ type: 'tool_call', sessionId, callId: str(item.id), summary: s, input: itemInput(item) }]
    }

    case 'item/completed': {
      const item = asObj(paramsOf(n, 'item/completed').item)
      const type = str(item.type)
      if (type === 'agentMessage') {
        // A fallback for when the streamed deltas were missed (empty when deltas already arrived, to avoid duplicating)
        return str(item.text) ? [{ type: 'message_delta', sessionId, role: 'assistant', text: '', ...messageIdOf(item.id) }] : []
      }
      if (type === 'userMessage' || type === 'reasoning') return []
      /*
       * The compaction marker (FR-14, #303). The completed item is the only sign of a finished compaction that Codex
       * still sends: measured with gpt-5.6-luna on codex-cli 0.147.0, 0.153.4 and 0.160.0 (2026-10-04,
       * scripts/probe-codex-compaction.mts), a manual compaction (`thread/compact/start`) and an automatic one both
       * arrive as `item/started` then `item/completed` of `{ type: 'contextCompaction', id }`, with no
       * `thread/compacted` at all; 0.160.0's binding marks that notification deprecated in favour of this item. The
       * marker used to come only from `thread/compacted`, so no Codex compaction left one. That notification is still
       * mapped below for a CLI that sends it, and the adapter pairs the two (`CompactionMarks`) so that one compaction
       * is one marker either way.
       */
      if (type === 'contextCompaction') {
        return [
          { type: 'activity', sessionId, activity: null },
          { type: 'compaction', sessionId, failed: false },
        ]
      }
      /*
       * The end of a review. item.review carries the full result text, but we do not emit it —
       * the same text has already streamed as agentMessage (measured). Emitting it again here
       * would append the result twice. (The start/end items only ever surface as activity,
       * whether they arrive via started or completed.)
       */
      if (type === 'exitedReviewMode') return [{ type: 'activity', sessionId, activity: null }]
      if (type === 'enteredReviewMode') return []
      /*
       * The agent viewed an image (#40). Measured shape: {type:'imageView', id, path} — only the
       * path is carried. Reading the file is IO, which this pure function cannot do: it is
       * emitted with data left empty, and the adapter (index.ts) reads and fills it in right
       * before emitting. The mime type is also decided there, from the extension. (imageGeneration
       * has not been measured yet — it will be wired up once observed, the same rule as #58.)
       */
      if (type === 'imageView') {
        const path = str(item.path)
        return path ? [{ type: 'message_image', sessionId, mime: '', data: '', path }] : []
      }
      const s = itemSummary(item)
      // The card shows the opening; the result's record is all of it (#221). A declined or interrupted item usually
      // carries no output, so its card says which it was rather than fail blank, as a note, not as output (#843)
      const ending = str(item.status) === 'declined' ? 'declined' : str(item.status) === 'interrupted' ? 'interrupted' : undefined
      const out: NormalizedEvent[] = [toolResultEvent(sessionId, str(item.id), codexItemOk(item), resultSummary(item), ending)]
      // An MCP tool's images (a browser's screenshot, say) come after its card, as Claude's do (#40, #843)
      if (type === 'mcpToolCall') out.push(...mcpImageEvents(sessionId, asObj(item.result).content))
      /*
       * If a file was actually changed, announce it for conflict detection and highlighting (FR-2, FR-5). A declined
       * change wrote nothing (#843), so it marks nothing. A failed one is marked all the same: a patch is applied file by
       * file, and the item does not say which of its files were written before it failed. A move changes the file it
       * leaves and the one it makes, and only the first was named.
       */
      const moved = type === 'fileChange' ? fileChangesOf(item).flatMap((c) => (c.movePath ? [c.movePath] : [])) : []
      const paths = [...s.paths, ...moved]
      if (paths.length > 0 && str(item.status) !== 'declined') out.push({ type: 'files_touched', sessionId, paths })
      return out
    }

    /*
     * The turn ended — **read how it ended, too** (#107).
     *
     * `turn/completed` also carries a failed turn (generated/v2/Turn.ts: `status` is "completed" |
     * "interrupted" | "failed", and `error` is only filled in when failed). We used to drop
     * `turn.*` wholesale here, so a turn that errored with a 400 still went out as nothing more
     * than a single `turn_complete`, same as a successful one — the screen was left with an
     * **empty answer** while the state flipped to `waiting_input`. A real incident: the rollout
     * had the full text of `The 'opus[1m]' model …`, but not a single character of it reached the
     * app, and there was no adapter error in the host log either. Nowhere did anything say it had
     * failed.
     *
     * A failure is emitted as `error` — **not together with `turn_complete`.** If both events go
     * out, the state machine's last word ends up being "waiting for the person", which repeats
     * exactly the lie we are trying to fix. The same rule the Claude adapter uses for `result`.
     *
     * An interrupted turn is not a finished one either (#698). It went out as `turn_complete`, so a turn Codex cut
     * short told the orchestrator that gave it "The assigned work finished". It ends as the person's Stop ends a turn,
     * `waiting_input` with `interrupted`; the adapter tells a Stop of ours from an interrupt it did not ask for
     * (`INTERRUPTED_BY_TOOL`).
     */
    case 'turn/completed': {
      const turn = asObj(paramsOf(n, 'turn/completed').turn)
      const failure = asObj(turn.error)
      if (str(turn.status) === 'interrupted' && !failure.message) return [{ type: 'state_change', sessionId, state: 'waiting_input', reason: 'interrupted' }]
      if (str(turn.status) !== 'failed' && !failure.message) return [{ type: 'turn_complete', sessionId }]
      const detail = str(failure.additionalDetails)
      return [{ type: 'error', sessionId, error: turnError([str(failure.message) || 'The turn failed', detail].filter(Boolean).join('\n')) }]
    }

    case 'turn/started':
      return [{ type: 'state_change', sessionId, state: 'working' }]

    case 'thread/tokenUsage/updated':
      return tokenUsageEvents(sessionId, paramsOf(n, 'thread/tokenUsage/updated'))

    /*
     * A usage update is **not the same as hitting a limit.**
     *
     * Without a condition here, a codex session flipped to 'limited' right after its very first
     * tool call — even when the measured usedPercent was only 27%. That freezes and dims the
     * spinning icon and slaps on a "Limit 27%" label that does not actually apply (dogfooding:
     * "the loading spinner does not spin while bash is running").
     *
     * The tool tells us directly whether the limit was hit — `rateLimitReachedType` being null
     * means it was not hit (the Claude adapter also only emits this when `status !== 'allowed'`;
     * both must follow the same rule). No usage information is lost by this: the usage panel
     * reads it separately through `agents.usage`.
     */
    case 'account/rateLimits/updated': {
      const snapshot = asObj(paramsOf(n, 'account/rateLimits/updated').rateLimits)
      const reached = str(snapshot.rateLimitReachedType) !== '' || snapshot.spendControlReached === true
      if (!reached) return []

      const primary = asObj(snapshot.primary)
      const resetsAt = finite(primary.resetsAt)
      return [
        {
          type: 'limit_reached',
          sessionId,
          usedPercent: finite(primary.usedPercent),
          windowMins: finite(primary.windowDurationMins),
          resumeAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : undefined,
        },
      ]
    }

    case 'thread/name/updated': {
      // This is a name the tool made up on its own -> auto:true. A name the person set is not overwritten by this (issue #5)
      /*
       * Codex sends the name as `threadName` (generated/v2/ThreadNameUpdatedNotification.ts); this read `name`, so
       * every automatic name arrived empty, and an automatically named session's name went blank (#1339). `name` is
       * still read for a CLI that sends it; with neither there is nothing to say.
       */
      const title = str(paramsOf(n, 'thread/name/updated').threadName) || str(asObj(n.params).name)
      return title ? [{ type: 'session_title', sessionId, title, auto: true }] : []
    }

    // Deprecated (0.160.0's binding) and not sent in any measured run — kept for a CLI that still does (#303)
    case 'thread/compacted':
      return [{ type: 'compaction', sessionId, failed: false }]

    /*
     * Goal notifications (2026-09-07 — ThreadGoalUpdated/ClearedNotification). codex treats a goal
     * as a first-class thing: objective, status (active | paused | blocked | usageLimited |
     * budgetLimited | complete), and token budget/usage all arrive over the protocol. We carry
     * the vocabulary through unchanged — the judgment belongs to the tool, and we only carry the
     * basis for the badge.
     */
    case 'thread/goal/updated':
      return [{ type: 'goal', sessionId, goal: goalFromCodex(asObj(paramsOf(n, 'thread/goal/updated').goal)) }]

    case 'thread/goal/cleared':
      return [{ type: 'goal', sessionId, goal: null }]

    /*
     * Text Codex wants the person to read (#304). Measured (codex-cli 0.160.0, 2026-10-04): with two keys in
     * `~/.codex/config.toml` the CLI ignores, `configWarning {summary: "Codex is ignoring 2 unrecognized configuration
     * settings. Check for typos or deprecated settings.\n  user (…/config.toml): \`mcp_servers.plane.type\` is
     * ignored.\n…", details: null}` arrived while `thread/start` was answered, then `warning {threadId, message: <the
     * same text>}` for the thread. Both come again on every app-server start and every thread start or resume, saying the
     * same thing each time: `oncePerSession` lets the host keep one line per session. `deprecationNotice` has the
     * `configWarning` shape (generated/v2/DeprecationNoticeNotification.ts); the owner saw the full-history one (#342).
     * Each also carries who is speaking, what kind it is and who has to act, and a plain explanation for the ones we know
     * (`noticeWords`, #342).
     */
    case 'warning': {
      const text = str(paramsOf(n, 'warning').message).trim()
      return text ? [{ type: 'notice', sessionId, level: 'warning', text, oncePerSession: true, ...noticeWords('warning', text) }] : []
    }
    case 'configWarning':
    case 'deprecationNotice': {
      const p = paramsOf(n, n.method)
      const text = [str(p.summary).trim(), str(p.details).trim()].filter(Boolean).join('\n')
      return text ? [{ type: 'notice', sessionId, level: 'warning', text, oncePerSession: true, ...noticeWords(n.method, text) }] : []
    }
    // The auto-review guardian's warning about an action (generated/v2/GuardianWarningNotification.ts); not exercised
    case 'guardianWarning': {
      const text = str(paramsOf(n, 'guardianWarning').message).trim()
      return text ? [{ type: 'notice', sessionId, level: 'warning', text, ...noticeWords('guardianWarning', text) }] : []
    }

    /*
     * Codex answered a turn with another model than the thread's (#304, not exercised): `{threadId, turnId, fromModel,
     * toModel, reason}`, where the only reason the bindings know is `highRiskCyberActivity`. It names a turn, and the
     * thread's own settings do not change with it (that would be `thread/settings/updated`), so this says so in the
     * conversation and leaves the model the person picked alone.
     */
    case 'model/rerouted': {
      const p = paramsOf(n, 'model/rerouted')
      const to = str(p.toModel)
      if (!to) return []
      const reason = str(p.reason) === 'highRiskCyberActivity' ? 'it was flagged as high-risk cyber activity' : str(p.reason)
      const text = `Codex answered this turn with ${to} instead of ${str(p.fromModel) || 'the selected model'}${reason ? ` because ${reason}` : ''}`
      return [{ type: 'notice', sessionId, level: 'warning', text, ...noticeWords('model/rerouted', text) }]
    }

    /*
     * An MCP server that failed to start (#304). Measured (codex-cli 0.160.0): every server reports `starting`, then
     * `ready` or `failed {error: "MCP client for \`<name>\` failed to start: MCP startup failed: No such file or
     * directory (os error 2)"}`, and a failing one goes through `starting` → `failed` **twice** on one thread start.
     * Centralu's own orchestrator and app bridges are MCP servers too, and a failed start used to be silent: the model
     * simply had no such tools. The adapter keeps one line per server until it starts again (index.ts).
     */
    case 'mcpServer/startupStatus/updated': {
      const p = paramsOf(n, 'mcpServer/startupStatus/updated')
      if (str(p.status) !== 'failed') return []
      const name = str(p.name) || 'an MCP server'
      const reauth = str(p.failureReason) === 'reauthenticationRequired' ? ' (it needs you to sign in again)' : ''
      const text = `${str(p.error).trim() || `MCP server \`${name}\` failed to start`}${reauth}`
      return [{ type: 'notice', sessionId, level: 'warning', text, ...noticeWords('mcpStartup', text, str(p.name)) }]
    }

    /*
     * The `error` notification has the shape `{ error, willRetry, threadId, turnId }` (generated
     * binding ErrorNotification, codex-cli 0.153.4). Two cases are not left as a failure marker
     * (#168):
     *  - **an error that will be retried** (willRetry) — Codex continues on its own, e.g. by
     *    reconnecting. Leaving a marker here would leave "this turn did not finish" in the
     *    conversation even when the turn eventually succeeds. If it does fail for good, the
     *    turn/completed(failed) below reports it. It shows as the `retrying` activity while
     *    it lasts (the adapter puts the previous activity back once output resumes) and goes
     *    to host.log with Codex's reason.
     *  - **an error that belongs to a turn** — that turn ends with a turn/completed(failed)
     *    carrying the same sentence. Emitting both would leave two lines of marker (measured: one
     *    token-refresh failure left the same sentence three times across two lines within the same
     *    second). We treat the turn's own outcome as the source of truth.
     *
     * Measured with codex-cli 0.153.4 (2026-10-03, a provider whose stream closed before
     * `response.completed`, stream_max_retries=2): `error{message:"Reconnecting... 1/2",
     * additionalDetails:<the reason>, willRetry:true, turnId}`, the same for 2/2, then
     * `error{message:<the reason>, willRetry:false, turnId}` and `turn/completed{status:"failed",
     * error:{message:<the same reason>}}`. A real 400 (an unsupported model) skipped the retries
     * and sent the last two only.
     */
    case 'error': {
      const p = paramsOf(n, 'error')
      // A top-level `message` is not in ErrorNotification: read as before, for a CLI that sends one
      const message = str(asObj(p.error).message) || str(asObj(n.params).message) || 'Unknown error'
      if (p.willRetry === true) {
        const why = str(asObj(p.error).additionalDetails)
        console.error(`[codex] ${sessionId.slice(0, 8)} retrying after: ${message}${why ? ` (${why})` : ''}`)
        return [{ type: 'activity', sessionId, activity: 'retrying' }]
      }
      if (str(p.turnId)) return []
      return [{ type: 'error', sessionId, error: turnError(message) }]
    }

    default:
      return []
  }
}
