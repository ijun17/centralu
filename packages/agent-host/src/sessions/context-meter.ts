import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { inTurn } from '../idle.js'

/**
 * The context figure during a turn (#1492). The tool's own reading comes at a turn's end (Claude reads it just after the turn ends;
 * Codex sends one with each token count), so a long turn left the window's meter where the turn before had put it while the
 * context grew past a share. Each model request of the session's own conversation says how big its prompt was
 * (`usage_update.request`: Claude per assistant message, Codex per token count), and that moves the figure as a `context_update`
 * marked `estimate` (the window draws "≈"), so everything that reads `SessionInfo.context` and the event, a hub and an older window
 * included, sees it as it sees a reading.
 *
 *  - **The tool's reading is the authority.** It replaces an estimate whatever the two say. Estimates stop for the rest of a turn
 *    once the tool has read the size in it (Codex does, with every request), so the two do not alternate.
 *  - **A reading owed for the turn before is not this turn's.** A tool that reads the size after a turn ends (Claude) may land it
 *    after the next turn's first request moved the figure; applied then it would put an older, smaller size over a newer one. It is
 *    dropped when this turn has an estimate of its own (`stale`), and applied when it is not (the session is at rest, or the turn has
 *    asked for nothing yet). A turn that ended with no reading in it owes one.
 *  - **Throttled** to one estimate per `ESTIMATE_GAP_MS` per session: a tool-heavy turn makes a request every second or less, and the
 *    window need not redraw the meter for each. The turn's end brings the reading.
 *  - **Denominator.** The window the tool's readings use (`SessionInfo.context.window`), not the model's own: a Claude process started
 *    under the compaction setting reports a smaller one, and the meter must not change its denominator in the middle of a turn. With
 *    no reading yet there is no window and no estimate.
 */

/** At most one estimate per session in this time */
export const ESTIMATE_GAP_MS = 3_000

type State = { working: boolean; estimated: boolean; readThisTurn: boolean; owed: boolean; at: number }

export class ContextMeter {
  private readonly sessions = new Map<string, State>()

  constructor(private readonly now: () => number = Date.now) {}

  private state(id: string): State {
    let s = this.sessions.get(id)
    if (!s) this.sessions.set(id, (s = { working: false, estimated: false, readThisTurn: false, owed: false, at: 0 }))
    return s
  }

  /**
   * Whether a context reading, before it is applied, is the turn before's landing in a turn that has an estimate of its own: then it
   * must not become the session's figure. Sees the tool's readings only; an estimate is never stale.
   */
  stale(e: NormalizedEvent): boolean {
    if (e.type !== 'context_update' || e.exactness === 'estimate') return false
    const s = this.state(e.sessionId)
    const late = s.owed
    s.owed = false
    // A reading owed for the turn before is not a reading in this one
    if (late) return s.working && s.estimated
    s.readThisTurn = true
    return false
  }

  /**
   * After an event is applied (`m` is the session as it now is): the estimate it brings, if any, as the event to apply.
   * `perRequest`: the tool reads the size with every request (Codex sends it right after the request's token count), so the
   * figure is exact without an estimate, which could only flicker in front of it (#1504 review)
   */
  observe(e: NormalizedEvent, m: SessionInfo, perRequest = false): NormalizedEvent | null {
    const s = this.state(m.id)
    if (e.type === 'session_deleted') {
      this.sessions.delete(m.id)
      return null
    }
    const working = inTurn(m.state)
    if (working && !s.working) {
      s.estimated = false
      s.readThisTurn = false
    }
    // A turn that ended with no reading in it owes one: the tool reads after the turn ends (the next one to come is its)
    if (s.working && !working) s.owed = !s.readThisTurn
    s.working = working
    if (perRequest || e.type !== 'usage_update' || !e.request || e.request.agent !== undefined) return null
    // A subagent has a prompt of its own, and the tool's reading is in this turn already
    if (!working || s.readThisTurn || !m.context || m.context.window <= 0) return null
    const used = Math.min(m.context.window, e.request.inputTokens + e.request.cacheReadTokens + (e.request.cacheCreationTokens ?? 0))
    const now = this.now()
    if (used === m.context.used || now - s.at < ESTIMATE_GAP_MS) return null
    s.at = now
    s.estimated = true
    return { type: 'context_update', sessionId: m.id, used, window: m.context.window, exactness: 'estimate' }
  }
}
