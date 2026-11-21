import type { NormalizedEvent, SessionGoal } from '@cc/protocol'
import { str, type Json } from './json.js'

/** The text of a message's content, a string or its text blocks joined. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Json[]).filter((b) => str(b?.type) === 'text').map((b) => str(b.text)).join('')
}

/**
 * What a Claude session's `/goal` is doing, read off the stream so it draws a Codex goal's badge (`active_goal` does not reach a
 * headless session, see `normalizeMessage`; the SDK has no goal API). Measured 2026-10-03 with `query()` and CLI 2.1.282 (SDK 0.3.263):
 *   not met at Stop   a user message with isSynthetic: true, "Stop hook feedback:
[<condition>]: <reason>"; the CLI goes on with
 *                     the same turn, one result at the end. Read only while its bracket holds the condition we know (a person's
 *                     own prompt Stop hook has the same shape)
 *   met               **nothing** before the result (includeHookEvents adds nothing: the goal hook is a prompt hook)
 *   interrupted       a success result, the goal still set ("Goal active" after)
 *   resumed           the goal restored from the transcript, nothing on the stream
 * "Met" is inferred, see `push`.
 */
export class ClaudeGoalTracker {
  private goal: SessionGoal | null = null
  /** `/goal` commands passed to the CLI whose reply has not arrived yet. */
  private replies = 0
  /** A model call ran while a goal was set, since the last result — this turn's end went past the goal's Stop hook. */
  private drove = false
  /** The CLI announced the goal itself (`active_goal`) — its word replaces our reading for the rest of the session. */
  private announced = false

  constructor(private readonly sessionId: string) {}

  /** The adapter passed a `/goal` command through to the CLI. */
  commandSent(): void {
    this.replies++
  }

  /**
   * The goal the host last knew of, handed to a process that resumes the conversation. The CLI restores
   * the goal from its transcript without a word on the stream (measured), so without this the new process
   * would not know the goal it is running, and a met goal would leave the badge up.
   */
  seed(goal: SessionGoal | null | undefined): void {
    if (goal && goal.status === 'active') this.goal = goal
  }

  /** Reads one parent-stream message. `streamed`: this assistant message's body came as deltas, i.e. a model call. */
  push(m: Json, opts: { streamed: boolean; interrupted: boolean }): NormalizedEvent[] {
    const type = str(m.type)
    if (type === 'active_goal') {
      this.announced = true
      return []
    }
    if (this.announced) return []

    if (type === 'stream_event' && str((m.event as Json | undefined)?.type) === 'message_start') {
      if (this.goal) this.drove = true
      return []
    }

    if (type === 'assistant' && this.replies > 0 && !opts.streamed) {
      const reply = this.readReply(textOfContent((m.message as Json | undefined)?.content))
      if (reply === undefined) return []
      this.replies--
      if (reply === 'other') return []
      return this.set(reply)
    }

    if (type === 'user' && m.isSynthetic === true && this.goal) {
      const prefix = `Stop hook feedback:\n[${this.goal.objective}]: `
      const text = textOfContent((m.message as Json | undefined)?.content)
      if (!text.startsWith(prefix)) return []
      const reason = text.slice(prefix.length).trim()
      return this.set({ ...this.goal, iterations: (this.goal.iterations ?? 0) + 1, ...(reason ? { reason } : {}) })
    }

    if (type === 'result') {
      const drove = this.drove
      this.drove = false
      const success = str(m.subtype) === 'success' && m.is_error !== true
      // The goal's Stop hook blocks every stop until the condition holds, so a success we did not interrupt after a model call under
      // the goal is the CLI's met, its "impossible" (it gives up and clears) or an unrecoverable-error clear: all three clear the goal.
      // Not told apart (read in the CLI, not measured): a check deferred behind background work, an evaluator timeout; the badge
      // clears early there, and `/goal` shows the truth again.
      if (this.goal && drove && success && !opts.interrupted) return this.set(null)
    }
    return []
  }

  /**
   * One synthetic reply to a `/goal` command — the goal it states (null for none), `'other'` for the
   * command's own refusals (an untrusted folder, hooks disabled, a condition too long), and undefined
   * for a message that is not the reply. The CLI's words, not a typed field, so read only while a `/goal` we passed
   * through waits (`commandSent`). Measured (see the class), each an assistant message with no deltas (model "<synthetic>"):
   *   /goal <condition>    "Goal set: <condition>"; then the model works in the same turn
   *   /goal                "Goal active: <condition> (not yet evaluated | N turn[s])" plus an optional "\nLast check: <reason>"
   *                        line, or "No goal set. Usage: `/goal <condition>`"; a result with num_turns 0 follows
   *   /goal clear          "Goal cleared: <condition>" or "No goal set" (stop, off, reset, none and cancel are the same command)
   */
  private readReply(text: string): SessionGoal | null | 'other' | undefined {
    const set = /^Goal set: ([\s\S]+)$/.exec(text)
    if (set) return { objective: set[1]!.trim(), status: 'active' }
    const active = /^Goal active: ([\s\S]+?) \((not yet evaluated|(\d+) turns?)\)(?:\nLast check: ([\s\S]*))?$/.exec(text)
    if (active) {
      const reason = active[4]?.trim()
      return {
        objective: active[1]!.trim(),
        status: 'active',
        ...(active[3] ? { iterations: Number(active[3]) } : {}),
        ...(reason ? { reason } : {}),
      }
    }
    if (/^Goal cleared: /.test(text) || /^No goal set/.test(text)) return null
    if (/^\/goal /.test(text) || /^Goal condition is limited to /.test(text)) return 'other'
    return undefined
  }

  private set(goal: SessionGoal | null): NormalizedEvent[] {
    if (goal === null && this.goal === null) return []
    this.goal = goal
    return [{ type: 'goal', sessionId: this.sessionId, goal }]
  }
}
