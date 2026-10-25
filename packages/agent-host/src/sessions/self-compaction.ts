import type { AutoCompact, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import { inTurn, type SessionIdle } from '../idle.js'

/**
 * Compacting at the turn's end (#1451). The CLI's own auto compact (`auto-compact.ts`, #1376) fires in the middle of work,
 * at 60% of the window; a long-lived session also pays a cache rewrite of its whole context after every long wait. So a
 * session compacts at the breaks that cost nothing instead, in two ways, and the CLI's own point stays as the backstop:
 *
 *  - **`compact_self`**: the agent asks Centralu to compact it once its current turn ends (`request`), with an optional
 *    focus line for the summary. Never mid-turn: the request waits for the turn's end and the compact goes in as the
 *    tool's own command (Claude `/compact [focus]`; Codex's compact request, `thread/compact/start`, which its slash handling
 *    routes from the bare `/compact` and which takes no focus). One request is pending per session; asking again only
 *    replaces the focus. The floor is checked when the turn has ended and the tool has read the size of the context, not at
 *    the call: the size known during a turn is the one from the turn before, so a turn that grew past the floor was refused
 *    (deep review of #1478). A context under the floor then drops the request: nothing is compacted for nothing.
 *  - **A session at rest** for `IDLE_COMPACT_MINUTES` whose context is over `AutoCompact.idleShare` of the model's window
 *    is compacted before its next turn (`sweep`). At rest is `sessionIdle`, the rule the sleep sweep reads: no turn, card,
 *    question or background work, and a process; the ten minutes count from the moment all of that holds. Off with
 *    `AutoCompact.controlled`.
 *
 * **The person's turn first.** A request waits for a turn's end, so a message the person sent into that turn is part of
 * it, and one queued behind it is already ahead of the compact in the tool's own queue: the person's turn runs first
 * and the conversation is compacted after it. A turn the person interrupts drops the request (they took control).
 * **A turn Centralu starts to compact is marked** (`compactTurn`, said on its ending event as `turn.compaction`, once the tool has
 * reported the compaction in it): the window
 * raises no "done" notice or sound for it, and it is not a turn of the session's own.
 * **One compaction per rest.** What a compaction leaves is not always read back (Codex reports no size), so a session
 * Centralu compacted is not compacted again until it has had a turn of its own.
 */

/** Below this much context a request is dropped and a resting session is left alone */
export const COMPACT_FLOOR_TOKENS = 100_000
/** How long a session rests before Centralu compacts it, in minutes */
export const IDLE_COMPACT_MINUTES = 10
const SWEEP_MS = 60_000
/** A compact the tool never reported finishing stops blocking the session after this long */
const COMPACT_STALE_MS = 30 * 60_000
/** A request whose turn ended waits this long for the tool's size reading before it goes by the one it has */
const READING_WAIT_MS = 5_000
const FOCUS_MAX_CHARS = 300

export type SelfCompactionHost = {
  sessions(): SessionInfo[]
  session(sessionId: string): SessionInfo | undefined
  /** `SessionManager.sessionIdle`: in a turn, a card, a question or background work make it not idle */
  idle(sessionId: string): SessionIdle
  /** The model's full context window when it is known, else null (`ModelWindows.fullWindowOf`, #1553): a floor under it is not one */
  window(session: SessionInfo): number | null
  /** Whether a process of the session runs */
  running(sessionId: string): boolean
  setting(): AutoCompact
  /** The input that makes the tool compact (`AgentAdapter.compactCommand`) */
  command(tool: ToolName, focus: string | null): string
  /** Sends the tool's compact command to the session as a turn of its own; throws when it cannot */
  send(sessionId: string, text: string): void
  /** A line in the conversation, in Centralu's name */
  notice(sessionId: string, text: string): void
  now?: () => number
}

/**
 * What Centralu sent and is waiting to see done. `started`: a turn began after the send, so a turn's end is the compact's (Codex's
 * request starts its turn later). `compacted`: the tool reported the compaction. `ended`: its turn is over; the entry then stays until
 * the session has a turn of its own.
 */
type Compacting = { why: string; sentAt: number; started: boolean; compacted: boolean; ended: boolean }

/**
 * A request from `compact_self`. `endedAt` is set once its turn ended and the size of the context is awaited (a timer decides it after
 * `READING_WAIT_MS`). `held`: a card the host raised was open at the turn's end, so the request waits for it to close at rest, and goes
 * if a turn starts first (the person's answer is theirs: the request is never carried into it); `size` is what the turn grew to.
 */
type Request = { focus: string | null; endedAt: number | null; held: boolean; size: number | null }

export class SelfCompaction {
  private readonly pending = new Map<string, Request>()
  private readonly compacting = new Map<string, Compacting>()
  private readonly restSince = new Map<string, number>()
  private readonly wasBusy = new Map<string, boolean>()
  /** Sessions whose context was read since their turn began: the reading at the turn's end is then this turn's */
  private readonly read = new Set<string>()
  /** Sessions whose tool reads the size after the turn ends (Claude) and has not yet: the next reading is the turn before's, even if it lands in the next turn */
  private readonly late = new Set<string>()
  /** The timers that decide a request whose turn ended without a size (`READING_WAIT_MS`) */
  private readonly waits = new Map<string, ReturnType<typeof setTimeout>>()
  /** The size of the last model request of the session's own conversation in the running turn: the size the turn grew to, in both tools */
  private readonly lastRequest = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** `stop()` was called: a late event of a turn that was running is not acted on (it would start the timer or send) */
  private stopped = false

  constructor(private readonly host: SelfCompactionHost) {}

  private now(): number {
    return (this.host.now ?? Date.now)()
  }

  /** The `compact_self` tool's answer. Says what will happen */
  request(sessionId: string, focus?: string): { text: string; isError?: boolean } {
    if (!this.host.session(sessionId)) return { text: 'This session is not known to Centralu.', isError: true }
    const line = focus?.replace(/\s+/g, ' ').trim().slice(0, FOCUS_MAX_CHARS) || null
    const asked = this.pending.has(sessionId)
    this.pending.set(sessionId, { focus: line, endedAt: null, held: false, size: null })
    const then = `Centralu compacts this conversation when the current turn ends, never in the middle of one, if the context is then over ${COMPACT_FLOOR_TOKENS / 1000}k tokens; the next turn starts from the summary. Finish and answer as usual.`
    return { text: asked ? `Already asked${line ? ' (the focus line is replaced)' : ''}. ${then}` : then }
  }

  /**
   * Whether the turn this session is in is the one Centralu started to compact it: the host says so on the event that ends it.
   * Only once the tool has reported the compaction in it: a turn of the person's that the tool ran before the compact (its queue
   * had their message already) is not the compact's, though Centralu's command was sent by then.
   */
  compactTurn(sessionId: string): boolean {
    const c = this.compacting.get(sessionId)
    return !!c && c.started && c.compacted && !c.ended
  }

  /** Hears every event of every session. Never throws into the caller's event */
  observe(e: NormalizedEvent, endedTurn: boolean): void {
    const id = e.sessionId
    if (!id || this.stopped) return
    // The context figure Centralu moves from a request's size during a turn (#1492) is no reading by the tool: this rule counts those only
    if (e.type === 'context_update' && e.exactness === 'estimate') return
    if (e.type === 'session_deleted') return this.forget(id)
    const m = this.host.session(id)
    if (!m) return
    const busy = inTurn(m.state)
    const wasBusy = this.wasBusy.get(id) ?? false
    this.wasBusy.set(id, busy)
    // The ten minutes count from when the session is idle by every rule; a wake from sleep starts them again
    if (busy || (e.type === 'session_live' && e.live)) this.restSince.delete(id)
    const turnStarted = busy && !wasBusy
    if (turnStarted) {
      this.read.delete(id)
      this.lastRequest.delete(id)
    }
    // A reading the tool owes for the turn that ended is that turn's, wherever it lands; any other is this turn's
    const owed = e.type === 'context_update' && this.late.delete(id)
    if (e.type === 'context_update' && !owed) this.read.add(id)
    if (e.type === 'usage_update' && e.request && e.request.agent === undefined) {
      this.lastRequest.set(id, e.request.inputTokens + e.request.cacheReadTokens + (e.request.cacheCreationTokens ?? 0))
    }
    const sent = this.compacting.get(id)
    if (turnStarted && sent) {
      // A turn of the session's own after Centralu's compact (or one the tool compacted in without our seeing it start) frees it to be compacted again
      if (sent.ended || (sent.compacted && !sent.started)) this.compacting.delete(id)
      else sent.started = true
    }
    const req = this.pending.get(id)
    if (turnStarted && req) {
      // A request held for a card is not carried into the turn the answer starts; one waiting for its size goes to this turn's end
      if (req.held) this.settle(id)
      else this.stopWaiting(id, req)
    }
    // The tool refused the compact before any turn began: nothing is running, and the session may be tried again
    if (e.type === 'error' && sent && !sent.started && !sent.ended) this.compacting.delete(id)
    const mine = this.compacting.get(id)
    // Not the tool's own compaction at its threshold (Claude says so): that is the person's turn running first, not Centralu's compact
    if (e.type === 'compaction' && mine && !mine.compacted && e.trigger !== 'auto') {
      // Done, or failed (the tool's own marker says why): either way Centralu waits for a turn of the session's own
      mine.compacted = true
      if (!e.failed) this.host.notice(id, `Compacted by Centralu (${mine.why})`)
    }
    // The size at the turn's end has come: a request that waited for it is decided now
    const live = this.pending.get(id)
    if (e.type === 'context_update' && live && live.endedAt !== null) return this.decide(id, e.used, m.tool)
    // The card the host raised is gone and the session is still at rest: the held request is judged on the size it had. Any event
    // can say so, not only the card's own `*_resolved`: a card also closes with the session's stop or the host's swap, and says nothing then
    if (live?.held && this.releaseHeld(id, m)) return
    if (!endedTurn) return
    this.markRest(id)
    // The tool reads the size after this turn (Claude) unless it was read during it (Codex)
    if (this.read.has(id)) this.late.delete(id)
    else this.late.add(id)
    // The person stopped the turn, or it failed
    const stopped = m.state === 'error' || e.type === 'limit_reached' || (e.type === 'state_change' && e.reason === 'interrupted')
    const c = this.compacting.get(id)
    if (c && c.started && !c.ended) {
      if (c.compacted) {
        // The turn Centralu's own compact ran in has ended
        c.ended = true
        return
      }
      // Stopped before the tool reported the compaction: a compaction after this is not Centralu's
      if (stopped) this.compacting.delete(id)
    }
    if (!live) return
    // The request goes with a turn that was stopped: it is theirs
    if (stopped) {
      this.settle(id)
      return
    }
    // The size the turn grew to: its last model request when the tool said it, else the reading of the context (the tool reads it after
    // the turn ends, Claude, or during it, Codex): decide on one of this turn, else wait for one
    const grew = this.lastRequest.get(id) ?? (this.read.has(id) && m.context ? m.context.used : null)
    // A card the host raised is open: the request waits for it to close, at rest (it goes when a turn starts)
    if (this.cardOpen(id)) {
      live.held = true
      live.size = grew
      return
    }
    if (grew !== null) this.decide(id, grew, m.tool)
    else this.awaitReading(id, live)
  }

  /**
   * A request held for a card: judged now if the card is closed and the session at rest, dropped if it has no process any more.
   * Returns whether it was settled. **Not asked: background work.** The held path goes on `!busy && !cardOpen` even while the session
   * runs background work, as the rule for every request made in a turn does (the request does not ask whether it runs: waiting for
   * CI in the background is what it is for, docs/agent-host.md "Compacting at a break"); `sessionIdle`'s rule for the rest compaction is
   * stricter on purpose, so this is not to be made to match it.
   */
  private releaseHeld(id: string, m: SessionInfo): boolean {
    const req = this.pending.get(id)
    if (!req?.held) return false
    if (!this.host.running(id)) {
      this.settle(id)
      return true
    }
    if (inTurn(m.state) || this.cardOpen(id)) return false
    this.decide(id, req.size ?? m.context?.used ?? 0, m.tool)
    return true
  }

  /** A request whose turn ended with no size: a timer decides it on the reading it has if the tool's own does not come */
  private awaitReading(id: string, req: Request): void {
    req.endedAt = this.now()
    this.clearWait(id)
    const timer = setTimeout(() => {
      this.waits.delete(id)
      try {
        const live = this.pending.get(id)
        const m = this.host.session(id)
        if (live && live.endedAt !== null && m) this.decide(id, m.context?.used ?? 0, m.tool)
        else if (live && !m) this.settle(id)
      } catch (err) {
        console.error(`[compact] ${id.slice(0, 8)}: could not decide the request: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, READING_WAIT_MS)
    timer.unref?.()
    this.waits.set(id, timer)
  }

  private stopWaiting(id: string, req: Request): void {
    req.endedAt = null
    this.clearWait(id)
  }

  private clearWait(id: string): void {
    const t = this.waits.get(id)
    if (t) clearTimeout(t)
    this.waits.delete(id)
  }

  /** Ends the request of a session: decided, dropped or gone */
  private settle(id: string): void {
    this.pending.delete(id)
    this.clearWait(id)
  }

  /** The turn ended and the size of the context is known: compacts when it is over the floor, drops the request otherwise */
  private decide(id: string, used: number, tool: ToolName): void {
    const req = this.pending.get(id)
    if (!req) return
    this.settle(id)
    if (used < COMPACT_FLOOR_TOKENS) return
    this.fire(id, 'the agent asked to after finishing its turn', req.focus, tool)
  }

  /** Where the rest starts: the turn's end if the session is idle by every rule then, else when the sweep sees it become so */
  private markRest(id: string): void {
    if (this.isIdle(id)) this.restSince.set(id, this.now())
    else this.restSince.delete(id)
  }

  private isIdle(id: string): boolean {
    try {
      return this.host.idle(id).idle === true
    } catch {
      // Gone between the list and now
      return false
    }
  }

  private cardOpen(id: string): boolean {
    try {
      const idle = this.host.idle(id)
      return !idle.idle && (idle.reason === 'approval' || idle.reason === 'question')
    } catch {
      return false
    }
  }

  private fire(id: string, why: string, focus: string | null, tool: ToolName): void {
    const text = this.host.command(tool, focus)
    try {
      this.compacting.set(id, { why, sentAt: this.now(), started: false, compacted: false, ended: false })
      this.host.send(id, text)
    } catch (err) {
      this.compacting.delete(id)
      console.error(`[compact] ${id.slice(0, 8)}: could not send the compaction: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Compacts the resting sessions that are over the lower share. Returns the ids it sent a compact to */
  sweep(): string[] {
    const now = this.now()
    const setting = this.host.setting()
    const sent: string[] = []
    for (const m of this.host.sessions()) {
      // A held request whose card closed without an event is judged here at the latest (`releaseHeld`)
      if (this.pending.get(m.id)?.held) this.releaseHeld(m.id, m)
      if (!this.due(m, setting, now)) continue
      this.fire(m.id, `at rest for ${IDLE_COMPACT_MINUTES} minutes, over ${Math.round(setting.idleShare * 100)}% of the window`, null, m.tool)
      if (this.compacting.has(m.id)) sent.push(m.id)
    }
    return sent
  }

  private due(m: SessionInfo, setting: AutoCompact, now: number): boolean {
    if (!m.live || !this.host.running(m.id) || !this.isIdle(m.id)) {
      // Not at rest: the ten minutes start again when it is
      this.restSince.delete(m.id)
      return false
    }
    const since = this.restSince.get(m.id)
    if (since === undefined) {
      // At rest since a moment this host did not see (it became idle with no turn ending, or the host is new): counted from now
      this.restSince.set(m.id, now)
      return false
    }
    if (!setting.controlled || this.pending.has(m.id)) return false
    const c = this.compacting.get(m.id)
    if (c && (c.ended || now - c.sentAt < COMPACT_STALE_MS)) return false
    if (now - since < IDLE_COMPACT_MINUTES * 60_000) return false
    const ctx = m.context
    if (!ctx || ctx.window <= 0) return false
    // The model's full window, as the gauge shows the share (#1553); a floor under it is no window to take a share of
    const window = this.host.window(m)
    if (window === null || window <= 0) return false
    return ctx.used >= COMPACT_FLOOR_TOKENS && ctx.used >= window * setting.idleShare
  }

  /** Starts the sweep. A host that never calls it still serves `compact_self` */
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.sweepSafely(), SWEEP_MS)
    // A sweep is no reason to keep the host alive
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const t of this.waits.values()) clearTimeout(t)
    this.waits.clear()
  }

  private sweepSafely(): void {
    try {
      this.sweep()
    } catch (err) {
      console.error(`[compact] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private forget(id: string): void {
    this.settle(id)
    this.late.delete(id)
    this.compacting.delete(id)
    this.restSince.delete(id)
    this.wasBusy.delete(id)
    this.read.delete(id)
    this.lastRequest.delete(id)
  }
}
