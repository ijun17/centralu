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
  /** The model's own context window when Centralu has read it, else null (`ModelWindows.of`) */
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

/** A request from `compact_self`: `endedAt` is set once its turn ended and the size of the context is awaited */
type Request = { focus: string | null; endedAt: number | null }

export class SelfCompaction {
  private readonly pending = new Map<string, Request>()
  private readonly compacting = new Map<string, Compacting>()
  private readonly restSince = new Map<string, number>()
  private readonly wasBusy = new Map<string, boolean>()
  /** Sessions whose context was read since their turn began: the reading at the turn's end is then this turn's */
  private readonly read = new Set<string>()
  /** The size of the last model request of the session's own conversation in the running turn: the size the turn grew to, in both tools */
  private readonly lastRequest = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly host: SelfCompactionHost) {}

  private now(): number {
    return (this.host.now ?? Date.now)()
  }

  /** The `compact_self` tool's answer. Says what will happen */
  request(sessionId: string, focus?: string): { text: string; isError?: boolean } {
    if (!this.host.session(sessionId)) return { text: 'This session is not known to Centralu.', isError: true }
    const line = focus?.replace(/\s+/g, ' ').trim().slice(0, FOCUS_MAX_CHARS) || null
    const asked = this.pending.has(sessionId)
    this.pending.set(sessionId, { focus: line, endedAt: null })
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
    if (!id) return
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
    if (e.type === 'context_update') this.read.add(id)
    if (e.type === 'usage_update' && e.request && e.request.agent === undefined) {
      this.lastRequest.set(id, e.request.inputTokens + e.request.cacheReadTokens + (e.request.cacheCreationTokens ?? 0))
    }
    const sent = this.compacting.get(id)
    if (turnStarted && sent) {
      // A turn of the session's own after Centralu's compact (or one the tool compacted in without our seeing it start) frees it to be compacted again
      if (sent.ended || (sent.compacted && !sent.started)) this.compacting.delete(id)
      else sent.started = true
    }
    // A turn began while a finished request waited for its size: the request goes to that turn's end
    const req = this.pending.get(id)
    if (turnStarted && req) req.endedAt = null
    // The tool refused the compact before any turn began: nothing is running, and the session may be tried again
    if (e.type === 'error' && sent && !sent.started && !sent.ended) this.compacting.delete(id)
    const mine = this.compacting.get(id)
    if (e.type === 'compaction' && mine && !mine.compacted) {
      // Done, or failed (the tool's own marker says why): either way Centralu waits for a turn of the session's own
      mine.compacted = true
      if (!e.failed) this.host.notice(id, `Compacted by Centralu (${mine.why})`)
    }
    // The size at the turn's end has come: a request that waited for it is decided now
    if (e.type === 'context_update' && req && req.endedAt !== null) return this.decide(id, e.used, m.tool)
    if (!endedTurn) return
    this.markRest(id)
    const c = this.compacting.get(id)
    if (c && c.started && c.compacted && !c.ended) {
      // The turn Centralu's own compact ran in has ended
      c.ended = true
      return
    }
    if (!req) return
    // The person stopped the turn, or it failed: it is theirs, and the request goes with it
    const dropped = m.state === 'error' || e.type === 'limit_reached' || (e.type === 'state_change' && e.reason === 'interrupted')
    if (dropped) {
      this.pending.delete(id)
      return
    }
    // A card is open (a question the host raised at this turn's end): the request waits for the next turn's end
    if (this.cardOpen(id)) return
    // The size the turn grew to: its last model request when the tool said it, else the reading of the context (the tool reads it after
    // the turn ends, Claude, or during it, Codex): decide on one of this turn, else wait for one
    const grew = this.lastRequest.get(id)
    if (grew !== undefined) this.decide(id, grew, m.tool)
    else if (this.read.has(id) && m.context) this.decide(id, m.context.used, m.tool)
    else req.endedAt = this.now()
  }

  /** The turn ended and the size of the context is known: compacts when it is over the floor, drops the request otherwise */
  private decide(id: string, used: number, tool: ToolName): void {
    const req = this.pending.get(id)
    if (!req) return
    this.pending.delete(id)
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
    // A request whose turn ended and whose size the tool never read goes by the reading it has
    for (const [id, req] of [...this.pending]) {
      if (req.endedAt === null || now - req.endedAt < READING_WAIT_MS) continue
      const m = this.host.session(id)
      if (m) this.decide(id, m.context?.used ?? 0, m.tool)
      else this.pending.delete(id)
    }
    const setting = this.host.setting()
    const sent: string[] = []
    for (const m of this.host.sessions()) {
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
    // The model's own window when it is known: a Claude process started under the CLI's compaction setting reports a smaller one
    const window = this.host.window(m) ?? ctx.window
    return ctx.used >= COMPACT_FLOOR_TOKENS && ctx.used >= window * setting.idleShare
  }

  /** Starts the sweep. A host that never calls it still serves `compact_self` */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweepSafely(), SWEEP_MS)
    // A sweep is no reason to keep the host alive
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private sweepSafely(): void {
    try {
      this.sweep()
    } catch (err) {
      console.error(`[compact] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private forget(id: string): void {
    this.pending.delete(id)
    this.compacting.delete(id)
    this.restSince.delete(id)
    this.wasBusy.delete(id)
    this.read.delete(id)
    this.lastRequest.delete(id)
  }
}
