import { nudgeShares, type AutoCompact, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import { COMPACT_FLOOR_TOKENS } from './self-compaction.js'

/**
 * Telling a session its context is growing (#1492). An agent cannot see how full its context is: Claude Code does not tell the
 * model, and `compact_self` (#1478) only works when the agent thinks of it. So when a session's context passes a first share
 * (30% of the model's window by default) Centralu tells it, once, its size and "when this step of the work is done, call
 * `compact_self`", and tells it once more at a second share that sits below the share the tool compacts at by itself
 * (`nudgeShares`: 10 points below it by default, never at or above it), where that compaction would come in the middle of work.
 *
 *  - **Quiet.** The note rides in with the session's next input or tool result (`SessionHandle.nudge`: Claude's quiet input, Codex's
 *    steering of the running turn) and never starts a turn or interrupts one. A session at rest is the rest rule's job (`SelfCompaction`).
 *  - **The size during a turn** is the input of the session's own last model request, as the stream says it per request (Claude: per
 *    assistant message; Codex: per token count, `usage_update.request`). The context reading the tool gives (`context_update`, and
 *    so `SessionInfo.context`) comes at a turn's end for Claude, too late for a turn that grows past a share on its own.
 *  - **Once per share per compaction cycle.** A share is told when a request is first over it; a compaction of any kind (the agent's,
 *    Centralu's, the tool's own, the person's `/compact`) or a fresh conversation starts the cycle again, so the shares are told
 *    again when the context grows back. A request that crosses both shares at once says it once. The counters are in memory: a host
 *    that starts tells a session already over a share again, once.
 *  - **Only where it can be acted on.** A session that has `compact_self` (an ordinary session and the orchestrator), with Centralu's
 *    control on (`autoCompact.controlled`) and the notices on, over the compaction floor (a smaller context would be refused), and
 *    under the tool's own share (a share at or above it is never told). A note the tool does not take now (Codex between turns, or
 *    in a compact turn) waits and goes with a later request of a running turn.
 */

export type ContextNudgesHost = {
  session(sessionId: string): SessionInfo | undefined
  /** The model's own context window when Centralu has read it, else null (`ModelWindows.of`) */
  window(session: SessionInfo): number | null
  setting(): AutoCompact
  /** Whether `compact_self` is one of the session's tools */
  hasCompactTool(sessionId: string): boolean
  /** `SessionHandle.nudge`: whether the tool took the note. False for a session with no process */
  nudge(sessionId: string, text: string): boolean
  /** A line in the conversation, in Centralu's name */
  notice(sessionId: string, text: string): void
}

/** What a session was last told, and what is waiting to be told */
type Cycle = { told: Set<'first' | 'second'>; waiting: 'first' | 'second' | null; size: number }

export class ContextNudges {
  private readonly cycles = new Map<string, Cycle>()
  private stopped = false

  constructor(private readonly host: ContextNudgesHost) {}

  /** Hears every event of every session. Never throws into the caller's event */
  observe(e: NormalizedEvent): void {
    const id = e.sessionId
    if (!id || this.stopped) return
    switch (e.type) {
      case 'session_deleted':
        this.cycles.delete(id)
        return
      case 'conversation_reset':
        this.cycles.delete(id)
        return
      case 'compaction':
        // A failed compaction shrank nothing: the cycle goes on
        if (!e.failed) this.cycles.delete(id)
        return
      case 'usage_update':
        // A subagent has a prompt of its own: its requests say nothing of this conversation's size
        if (e.request && e.request.agent === undefined) this.requested(id, e.request.inputTokens + e.request.cacheReadTokens + (e.request.cacheCreationTokens ?? 0))
        return
      default:
    }
  }

  private cycle(id: string): Cycle {
    let c = this.cycles.get(id)
    if (!c) this.cycles.set(id, (c = { told: new Set(), waiting: null, size: 0 }))
    return c
  }

  private requested(id: string, size: number): void {
    // Cheapest first: this runs for every model request of every session
    if (size < COMPACT_FLOOR_TOKENS) return
    const setting = this.host.setting()
    const m = this.host.session(id)
    if (!m || !setting.controlled || !setting.nudge || !this.host.hasCompactTool(id)) return
    const window = this.host.window(m) ?? m.context?.window ?? 0
    if (window <= 0) return
    const c = this.cycle(id)
    c.size = size
    const share = size / window
    const { first, second } = nudgeShares(setting)
    // A share at or above the tool's own is never told: the tool compacts before the session gets there
    const crossed = (['first', 'second'] as const).filter((k) => !c.told.has(k) && (k === 'first' ? first : second) < setting.share && (k === 'first' ? first : second) <= share)
    if (crossed.length > 0) {
      for (const k of crossed) c.told.add(k)
      c.waiting = crossed.includes('second') ? 'second' : 'first'
    }
    if (c.waiting) this.deliver(id, c, m, window, setting)
  }

  private deliver(id: string, c: Cycle, m: SessionInfo, window: number, setting: AutoCompact): void {
    const which = c.waiting
    if (!which) return
    const percent = Math.round((c.size / window) * 100)
    const used = `${Math.round(c.size / 1000)}k of ${Math.round(window / 1000)}k tokens`
    const text =
      which === 'second'
        ? `[Centralu] Your context is now about ${percent}% full (${used}), and the tool compacts it by itself in the middle of work at ${Math.round(setting.share * 100)}%. Call compact_self when the current step is done, at the latest; do not stop what you are doing for it.`
        : `[Centralu] Your context is now about ${percent}% full (${used}). When this step of the work is done, call compact_self so the next step starts from a summary; do not stop what you are doing for it.`
    let took = false
    try {
      took = this.host.nudge(id, text)
    } catch (err) {
      // Not told: the share stays told, so a failing send is not repeated with every request
      c.waiting = null
      console.error(`[compact] ${id.slice(0, 8)}: could not send the context notice: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!took) return
    c.waiting = null
    this.host.notice(id, `Centralu told it its context is ${percent}% full: call compact_self when this step is done`)
  }

  /** The host is leaving: nothing is told after this, and nothing waits to be */
  stop(): void {
    this.stopped = true
    this.cycles.clear()
  }
}
