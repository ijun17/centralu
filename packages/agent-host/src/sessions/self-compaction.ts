import type { AutoCompact, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import { inTurn, type SessionIdle } from '../idle.js'
import type { StoredThen, ThenKeep, ThenStage } from './then-keep.js'

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
 * **Only a tool that can.** A tool with no compact command (`SelfCompactionHost.command` is null: an ACP agent that advertises none)
 * is never sent one, and `compact_self` answers that it cannot: the bare `/compact` would be an ordinary prompt to its model.
 * **One compaction per rest.** What a compaction leaves is not always read back (Codex reports no size), so a session
 * Centralu compacted is not compacted again until it has had a turn of its own.
 * **Going on after it (#2024).** `compact_self` may carry `then`, the agent's own next step. Once the compact turn Centralu started has
 * ended (the tool reported the compaction in it), `then` goes in as an ordinary turn of the session's own, in Centralu's channel and with no
 * user row. **Only to a session at rest, after what was queued has gone first**: the host looks at what waits (`queued`: the inputs the tool holds, mail
 * waiting for the session); with nothing it goes at once, else it follows the end of that turn with a line saying the message came first, and it goes only when the
 * session can take a turn (`SelfCompactionHost.ready`); else the end of the turn that runs, or the sweep, tries again. **A request that is refused** (under the
 * floor, no size read since the last compaction, the tool refused the compact or never reported it) still sends `then`, as a turn that says it did not
 * compact and why: nothing is left stalled with the agent told to end its turn. That turn counts as a cycle. Asked again at the same size (`refusedAt`) it is
 * answered in the tool result and no turn is made. **The person's interrupt sends nothing**: of the
 * turn that asked, the compact turn (before or after the tool reported the compaction), or the turn that ran first; the session is told so, quietly,
 * with the text of its `then` (`tell`). A compaction the tool reported as failed leaves the context as it was, so `then` still goes. A tool whose
 * compact takes no focus (Codex) gets the focus line at the head of the `then` turn; with no `then` the tool's answer says the focus was not applied.
 * **One compaction in flight per session**: a second request while one is on its way (its command sent, queued or running) asks for no second command; it
 * only replaces the `then` (or drops it, with none), and its answer says so.
 * **Across a host swap or restart.** A `then` is kept in the store from the request on (`ThenKeep`, the setting `compact_then:<session>`, a key an older build
 * ignores), with its `stage` and the time of its last move: `asked` (the turn runs), `sent` (the compact command went), `compacted` (the tool reported the
 * compaction), `refused` (the request did not compact; `why`), `sending`. The step from `compacted` or `refused` to `sending` is one transaction (`claim`): of the
 * old host and the new, only the one that makes it sends, so a `then` goes at most once, and **from the claim on the record never goes back**: a host that leaves with
 * the delivery in the air leaves it `sending`, and the next one only tells the session. A host that starts (`recover`) sends a `compacted` or `refused` one,
 * waking the session if it has no process; for any other stage it cannot tell how far things came, so the session is **woken with a turn** that says Centralu
 * changed hosts, with the text of its `then` (a quiet note when it is in a turn; kept for its next input when the tool takes none), and the conversation line says
 * which of these happened. A record older than `THEN_KEEP_MS` is not sent (a rollback to an older build left it), and the deletion of the session clears it and the
 * notes (a session restored from the trash must not get an old step). A note the tool cannot take yet is kept in the store too (`compact_notes:<session>`).
 * **No loop guard but the floor.** A `then` turn that asks again at once finds a context far under the floor and is dropped, so nothing
 * loops; a context that grew back over it did real work. After a compaction only a size read since it counts for the floor (`unread`):
 * Codex reports none, and the reading kept from before would let a small context pass.
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
/** More compact then-step cycles than this in an hour, of one session, and the person gets one warning (#2024); nothing is held, refused or delayed for it */
export const WARN_COMPACT_CYCLES_PER_HOUR = 6
/** The longest `then` a request takes: it is a prompt, so it is refused rather than cut */
export const THEN_MAX_CHARS = 4_000
/**
 * What waits behind the compact turn is looked at directly (`SelfCompactionHost.queued`: the inputs the tool holds, and mail waiting for the session); with
 * nothing waiting `then` goes at once, and with something it goes at the end of that turn. **The one guess left** is for a tool that cannot say what it holds
 * (`SessionHandle.queuedInputs` absent: an ACP agent): its `then` waits this long after the compact turn ends for a queued turn to start, and goes if none did
 */
export const THEN_SETTLE_MS = 3_000
/** A `then` held for a turn that waits behind the compact goes anyway after this long, if that turn never started (mail the mailbox holds back, a queue that stays) */
export const THEN_QUEUE_MAX_MS = 60_000
/** How often, and how many times, a step looks again while the session's state has not caught up with the end of the turn (see `settleThen`) */
const THEN_LOOK_MS = 250
const THEN_LOOKS = 12
/** A `then` asked again with the context within this many tokens of where the last refusal found it is answered in the tool result, with no turn (#2036 review) */
export const REFUSED_AGAIN_TOKENS = 2_000
/**
 * A kept `then` older than this is not sent by the host that finds it. A compact is stale after `COMPACT_STALE_MS`, and a swap or a restart
 * with a wake takes minutes: an hour covers a long outage, and cuts what a rollback to an older build left for a newer one to find days later
 */
export const THEN_KEEP_MS = 60 * 60_000

export type SelfCompactionHost = {
  sessions(): SessionInfo[]
  session(sessionId: string): SessionInfo | undefined
  /** `SessionProcesses.sessionIdle`: in a turn, a card, a question or background work make it not idle */
  idle(sessionId: string): SessionIdle
  /** The model's own context window when Centralu has read it, else null (`ModelWindows.of`, #1553): the record for this tool and model, which a floor is never written to */
  window(session: SessionInfo): number | null
  /** Whether a process of the session runs */
  running(sessionId: string): boolean
  /** Whether the session can be given a turn now: between turns, no card or limit standing, and this host not leaving (`MailSessionsView.mailReceiver`'s `ready`; a session with no process is ready, it is woken) */
  ready(sessionId: string): boolean
  setting(): AutoCompact
  /**
   * The input that makes the session's tool compact (`SessionHandle.compactCommand`, else `AgentAdapter.compactCommand`).
   * `null`: the tool has none (an ACP agent that advertises no `compact`), so the session is never compacted by Centralu
   */
  command(sessionId: string, tool: ToolName, focus: string | null): string | null
  /** Sends the tool's compact command to the session as a turn of its own; throws when it cannot */
  send(sessionId: string, text: string): void
  /**
   * Whether inputs wait to start a turn of the session: the ones the tool holds (`SessionHandle.queuedInputs`: the person's message in its queue, written and
   * not started) and mail that wakes it. `null`: the tool cannot say, and the caller waits a moment instead (`THEN_SETTLE_MS`)
   */
  queued(sessionId: string): boolean | null
  /** Sends text as an ordinary turn of the session's own, in Centralu's channel and with no user row (`SessionEvents.deliverMail`); throws when it cannot. `line`: the conversation line, once the tool took it */
  sendThen(sessionId: string, text: string, line: string): Promise<void>
  /** What a host swap or restart must not lose (`ThenKeep`) */
  keep: ThenKeep
  /** The person is warned that the session went through `count` compaction cycles in the hour (the mailbox's warning to the person, once per clock hour; the session is not stopped) */
  warnCycles(sessionId: string, count: number): void
  /** A note read with the session's next input, starting nothing (`SessionHandle.nudge`): whether the tool took it. False when it cannot now */
  nudge(sessionId: string, text: string): boolean | Promise<boolean>
  /** A line in the conversation, in Centralu's name */
  notice(sessionId: string, text: string): void
  now?: () => number
}

/**
 * What Centralu sent and is waiting to see done. `started`: a turn began after the send, so a turn's end is the compact's (Codex's
 * request starts its turn later). `compacted`: the tool reported the compaction. `ended`: its turn is over; the entry then stays until
 * the session has a turn of its own.
 */
type Compacting = {
  why: string
  sentAt: number
  started: boolean
  compacted: boolean
  ended: boolean
  /** The agent's next step, sent when the compact turn has ended and the session is at rest; null when none, or once it went or was dropped */
  then: string | null
  /** Why the request did not compact, for a step that goes all the same (`then` is then held in an entry that has `ended`); null for a compaction */
  refused: string | null
  /** The focus line a tool that takes none could not be given: it heads the `then` turn */
  focusAside: string | null
  /** A turn of the person's ran before the compact */
  ahead: boolean
}

/**
 * A request from `compact_self`. `endedAt` is set once its turn ended and the size of the context is awaited (a timer decides it after
 * `READING_WAIT_MS`). `held`: a card the host raised was open at the turn's end, so the request waits for it to close at rest, and goes
 * if a turn starts first (the person's answer is theirs: the request is never carried into it); `size` is what the turn grew to.
 */
type Request = { focus: string | null; then: string | null; endedAt: number | null; held: boolean; size: number | null }

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
  /** The size and the reason of a session's last refused request, so one asked again at the same size is answered in the tool result (`REFUSED_AGAIN_TOKENS`); `used` is null when none had been read since a compaction */
  private readonly refusedAt = new Map<string, { used: number | null; why: string }>()
  /** The timers that hold a `then` back for what waits behind the compact (`THEN_SETTLE_MS` for a tool that cannot say, else `THEN_QUEUE_MAX_MS`) */
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>()
  /** The size of the last model request of the session's own conversation in the running turn: the size the turn grew to, in both tools */
  private readonly lastRequest = new Map<string, number>()
  /** Sessions compacted whose context the tool has not read since: the reading kept in `SessionInfo.context` is from before, no size to judge by */
  private readonly unread = new Set<string>()
  /** Notes for a session that the tool could not take yet, tried again at a turn's start and with a request of a running turn */
  private readonly owed = new Map<string, string[]>()
  /** Sessions sent their next step (`goOn`) whose turn has not opened yet: the turn that opens goes on with the work of the turn that asked (`stepOpens`, #2164) */
  private readonly stepping = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** `stop()` was called: a late event of a turn that was running is not acted on (it would start the timer or send) */
  private stopped = false

  constructor(private readonly host: SelfCompactionHost) {}

  private now(): number {
    return (this.host.now ?? Date.now)()
  }

  /** Whether the tool's compact command takes the focus line (Claude: `/compact <focus>`; Codex's request takes none) */
  private takesFocus(id: string, tool: ToolName): boolean {
    return this.host.command(id, tool, 'focus') !== this.host.command(id, tool, null)
  }

  /** The `compact_self` tool's answer. Says what will happen */
  request(sessionId: string, focus?: string, then?: string): { text: string; isError?: boolean } {
    const m = this.host.session(sessionId)
    if (!m) return { text: 'This session is not known to Centralu.', isError: true }
    if (this.host.command(sessionId, m.tool, null) === null) {
      return { text: 'This tool has no compact command, so Centralu cannot compact this conversation. Nothing was asked; carry on as usual.', isError: true }
    }
    const next = then?.trim() || null
    if (next && next.length > THEN_MAX_CHARS) {
      return { text: `\`then\` is ${next.length} characters, over the ${THEN_MAX_CHARS} a request takes. Nothing was asked: put the plan in a file and name it in a shorter \`then\`.`, isError: true }
    }
    const line = focus?.replace(/\s+/g, ' ').trim().slice(0, FOCUS_MAX_CHARS) || null
    // Refused at this size a moment ago and asked again with the context where it was: the answer is this one, in the tool result. No turn is made for it, so an
    // agent that asks again at once costs a tool call and not a turn, and the session is never blocked: it goes on in the turn it is in
    const again = next ? this.refusedAt.get(sessionId) : undefined
    if (again) {
      const size = this.lastRequest.get(sessionId) ?? this.reading(sessionId, m)
      // Under the floor the answer is true only while the size is: a refusal at 99k and a request at 100.5k is not the same request
      const same = size === null ? again.used === null : again.used !== null && Math.abs(size - again.used) < REFUSED_AGAIN_TOKENS && (again.used >= COMPACT_FLOOR_TOKENS || size < COMPACT_FLOOR_TOKENS)
      if (same) {
        return { text: `Not compacted (${again.why}); nothing has changed since your last request, so no new turn is made for it. Continue in this turn.` }
      }
    }
    // One compaction per session at a time. One on its way (its command sent, in the tool's queue or running) is not asked for again: the request joins it
    // and only its `then` is its own, so two compact commands are never queued
    const flight = this.compacting.get(sessionId)
    if (flight && !flight.ended) {
      const earlier = flight.then !== null
      flight.then = next
      if (next) this.stage(sessionId, flight, flight.compacted ? 'compacted' : 'sent')
      else if (earlier) this.erase(sessionId)
      const own = next ? `Your \`then\` ${earlier ? 'replaces the earlier one and ' : ''}goes after it.` : earlier ? 'The earlier `then` is dropped: this call has none.' : 'Nothing more is asked.'
      return { text: `A compaction is already on its way, asked for earlier, so none is asked for again${line ? ' and the focus line comes too late for it' : ''}. ${own}${next ? ' End your turn now.' : ''}` }
    }
    // A step held for the turn of someone else's that goes first is replaced by this request, whose own `then` it may be
    const heldThen = flight?.ended ? flight.then : null
    if (flight && heldThen) {
      flight.then = null
      this.stopSettling(sessionId)
      this.compacting.delete(sessionId)
    }
    const before = this.pending.get(sessionId)
    const earlierThen = before?.then ?? heldThen
    this.pending.set(sessionId, { focus: line, then: next, endedAt: null, held: false, size: null })
    if (next) this.save(sessionId, { stage: 'asked', then: next, focusAside: null, ahead: false, why: null, at: this.now() })
    else if (earlierThen) this.erase(sessionId)
    const aside = line !== null && !this.takesFocus(sessionId, m.tool)
    const after = next
      ? `The next turn starts from the summary with your \`then\`${aside ? ' (the focus line at its head: this tool\'s compact takes none)' : ''}. If nothing is compacted, \`then\` still comes as your next turn, with a line saying why. End your turn now.`
      : `The next turn starts from the summary.${aside ? ' This tool\'s compact takes no focus, so the focus line is not applied.' : ''} Finish and answer as usual.`
    const text = `Centralu compacts this conversation when the current turn ends, never in the middle of one, if the context is then over ${COMPACT_FLOOR_TOKENS / 1000}k tokens. ${after}`
    const replaced = [line ? 'the focus line' : null, next || earlierThen ? '`then`' : null].filter(Boolean)
    return { text: before || heldThen ? `Already asked${replaced.length ? ` (${replaced.join(' and ')} ${replaced.length > 1 ? 'are' : 'is'} replaced)` : ''}. ${text}` : text }
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

  /** Whether the turn opening now is the one a next step this host sent opens (#2164): it goes on with the work of the turn that asked. Once per step */
  stepOpens(sessionId: string): boolean {
    return this.stepping.delete(sessionId)
  }

  /** Sends a next step as a turn of the session's own (`SelfCompactionHost.sendThen`), the turn it opens marked as going on with the work (`stepOpens`) */
  private async goOn(id: string, text: string, line: string): Promise<void> {
    this.stepping.add(id)
    await this.host.sendThen(id, text, line).catch((err: unknown) => {
      this.stepping.delete(id)
      throw err
    })
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
    // A reading by the tool is a size since the last compaction; a compaction that worked leaves the sizes read before it behind
    if (e.type === 'context_update') this.unread.delete(id)
    if (e.type === 'compaction' && !e.failed) {
      this.unread.add(id)
      this.read.delete(id)
      this.lastRequest.delete(id)
    }
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
    if (this.owed.size > 0 && (turnStarted || (e.type === 'usage_update' && e.request))) this.flushOwed(id)
    // A reading the tool owes for the turn that ended is that turn's, wherever it lands; any other is this turn's
    const owed = e.type === 'context_update' && this.late.delete(id)
    if (e.type === 'context_update' && !owed) this.read.add(id)
    if (e.type === 'usage_update' && e.request && e.request.agent === undefined) {
      this.lastRequest.set(id, e.request.inputTokens + e.request.cacheReadTokens + (e.request.cacheCreationTokens ?? 0))
    }
    const sent = this.compacting.get(id)
    if (turnStarted && sent) {
      // A turn of the session's own after Centralu's compact (or one the tool compacted in without our seeing it start) frees it to be compacted again
      if (sent.ended || (sent.compacted && !sent.started)) {
        if (sent.then) {
          // A step is held and a turn of someone else's begins (the person's message that was queued, mail): that goes first, and the step follows its end.
          // (A compaction reported with no turn seen to start is the same: the turn running now is not the compact's, and a step sent into it is not a turn of its own)
          sent.ended = true
          sent.ahead = true
          this.stopSettling(id)
          this.stage(id, sent, sent.refused === null ? 'compacted' : 'refused')
        } else this.compacting.delete(id)
      } else sent.started = true
    }
    const req = this.pending.get(id)
    if (turnStarted && req) {
      // A request held for a card is not carried into the turn the answer starts; one waiting for its size goes to this turn's end
      if (req.held) this.drop(id, 'a card was open when the turn ended and the person’s answer started the next turn', true)
      else this.stopWaiting(id, req)
    }
    // The tool refused the compact before any turn began: nothing is running, and the session may be tried again
    if (e.type === 'error' && sent && !sent.started && !sent.ended) this.refuseFlight(id, sent, 'the tool refused the compact')
    const mine = this.compacting.get(id)
    // Not the tool's own compaction at its threshold (Claude says so): that is the person's turn running first, not Centralu's compact
    if (e.type === 'compaction' && mine && !mine.compacted && e.trigger !== 'auto') {
      // Done, or failed (the tool's own marker says why): either way Centralu waits for a turn of the session's own. A failed one is a refusal for the step: nothing was
      // compacted, and the step goes saying so, not "the compaction is done"
      mine.compacted = true
      if (e.failed && mine.then) {
        mine.refused = `the tool reported the compaction failed${e.reason ? `: ${e.reason}` : ''}`
        this.host.notice(id, `The compaction did not happen (${mine.refused}): the next step the agent set goes on without it`)
      }
      this.stage(id, mine, mine.refused === null ? 'compacted' : 'refused')
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
    if (c?.ended && c.then) {
      // The turn of someone else's that went first has ended. Interrupted, it takes the step with it: the person took control
      if (stopped) this.lose(id, c, 'the turn that ran first was interrupted')
      else this.settleThen(id, c)
    }
    if (c && c.started && !c.ended) {
      if (c.compacted) {
        // The turn Centralu's own compact ran in has ended: the session is at rest, and its next step goes once what was queued behind it has had its turn.
        // Interrupted, the person took control: no step is sent
        c.ended = true
        if (stopped) this.lose(id, c, 'the compact turn was interrupted, or it ended in an error')
        else this.settleThen(id, c)
        return
      }
      // Stopped before the tool reported the compaction: a compaction after this is not Centralu's
      if (stopped) {
        this.lose(id, c, 'the turn was interrupted before the compaction')
        this.compacting.delete(id)
      } else {
        c.ahead = true
        this.stage(id, c, 'sent')
      }
    }
    if (!live) return
    // The request goes with a turn that was stopped: it is theirs
    if (stopped) {
      this.drop(id, 'the person interrupted the turn, or it ended in an error', true)
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
      this.drop(id, 'the session had no process left', true)
      return true
    }
    if (inTurn(m.state) || this.cardOpen(id)) return false
    this.decide(id, req.size ?? this.reading(id, m), m.tool)
    return true
  }

  /** The tool's last reading of the context, unless the session was compacted since: then it is the size from before, and there is none */
  private reading(id: string, m: SessionInfo): number | null {
    return this.unread.has(id) ? null : (m.context?.used ?? 0)
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
        if (live && live.endedAt !== null && m) this.decide(id, this.reading(id, m), m.tool)
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

  /** The store is a safeguard for a host that leaves: a failing write is logged and the request goes on in memory */
  private save(id: string, record: StoredThen): void {
    try {
      this.host.keep.write(id, record)
    } catch (err) {
      console.error(`[compact] ${id.slice(0, 8)}: could not keep the next step for a host swap: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private erase(id: string): void {
    try {
      this.host.keep.clear(id)
    } catch {
      // The next host reads it as it stood, and tells the session
    }
  }

  /** The stage the record of a compaction in flight is at: kept as it moves */
  private stage(id: string, c: Compacting, stage: ThenStage): void {
    if (c.then) this.save(id, { stage, then: c.then, focusAside: c.focusAside, ahead: c.ahead, why: c.refused, at: this.now() })
  }

  /**
   * Ends a request that will not compact. With a `then` the session is not left to stall: the step goes as its next turn, with a line saying why (`refuse`).
   * `quiet`: the person took control (they interrupted the turn) or the turn failed, so nothing is sent and the session is told at its next input
   */
  private drop(id: string, why: string, quiet = false): void {
    const req = this.pending.get(id)
    this.settle(id)
    if (!req?.then) return
    if (quiet) this.tell(id, req.then, why)
    else this.refuseRequest(id, req.then, why)
  }

  /** The turn ended and the size of the context is known (`null`: none since a compaction): compacts when it is over the floor, drops the request otherwise */
  private decide(id: string, used: number | null, tool: ToolName): void {
    const req = this.pending.get(id)
    if (!req) return
    if (used === null) return this.refused(id, null, 'no size of the context was read since the last compaction, so it could not be told to be over the floor')
    if (used < COMPACT_FLOOR_TOKENS) return this.refused(id, used, `the context was ${Math.round(used / 1000)}k tokens, under the ${COMPACT_FLOOR_TOKENS / 1000}k floor`)
    this.settle(id)
    this.fire(id, 'the agent asked to after finishing its turn', req.focus, tool, req.then)
  }

  /** The request is refused at this size: remembered, so the same request asked again is answered in the tool result; its `then` still comes once */
  private refused(id: string, used: number | null, why: string): void {
    this.refusedAt.set(id, { used, why })
    this.drop(id, why)
  }

  /** The `then` of a compact the person stopped is not sent: the session is told with its text, quietly */
  private lose(id: string, c: Compacting, why: string): void {
    const then = c.then
    c.then = null
    this.stopSettling(id)
    if (then) this.tell(id, then, why)
  }

  /** A request that did not compact and has a step: it is held like the step of a compaction (`ended`, so a turn of someone else's that begins goes first) and goes as a turn that says why */
  private refuseRequest(id: string, then: string, why: string): void {
    const entry: Compacting = { why: 'refused', sentAt: this.now(), started: true, compacted: true, ended: true, then, refused: why, focusAside: null, ahead: false }
    this.host.notice(id, `The compaction did not happen (${why}): the next step the agent set goes on without it`)
    this.compacting.set(id, entry)
    this.stage(id, entry, 'refused')
    this.settleThen(id, entry)
  }

  /** A compaction in flight that will not happen as asked: its step, if it has one, goes as a turn that says why; else the entry is gone */
  private refuseFlight(id: string, c: Compacting, why: string): void {
    if (!c.then) {
      this.compacting.delete(id)
      return
    }
    this.host.notice(id, `The compaction did not happen (${why}): the next step the agent set goes on without it`)
    c.refused = why
    c.started = true
    c.compacted = true
    c.ended = true
    this.stage(id, c, 'refused')
    this.settleThen(id, c)
  }

  /** The text of the turn that carries the agent's next step */
  private thenTurn(rec: StoredThen): string {
    return [
      rec.why === null
        ? '[Centralu] The compaction you asked for with compact_self is done. This is the step you set with `then`.'
        : `[Centralu] Your compact_self request did not compact the conversation (${rec.why}), so it is as it was. This is the step you set with \`then\`. Asking again before anything changed gets the same answer.`,
      ...(rec.ahead ? ['A message from the person ran before the compaction and came first: what they asked weighs more than this step.'] : []),
      ...(rec.focusAside ? [`This tool's compact takes no focus. What you asked the summary to keep: ${rec.focusAside}`] : []),
      '',
      rec.then,
    ].join('\n')
  }

  /**
   * The compact turn has ended (or a request was refused): the agent's step goes now if nothing waits behind it, and at the end of the turn that does if
   * something does (the person's message in the tool's queue, mail waiting for the session; `queued`). A turn that begins holds it back (`observe`) and its
   * end comes here again. A tool that cannot say what it holds gets a moment instead (`THEN_SETTLE_MS`); a queue that stays gets `THEN_QUEUE_MAX_MS`
   */
  private settleThen(id: string, c: Compacting, looked = 0): void {
    this.stopSettling(id)
    if (!c.then) return
    const queued = this.queuedNow(id)
    // The state of the session may not have caught up with the end of the turn yet (the event is heard first): looked at again in a moment, queue and all, since
    // the person's message can be typed in that moment; a session that stays busy (a card, a limit) is left to the end of its turn and the sweep
    const catching = queued === false && !this.host.ready(id)
    if (queued === false && !catching) return this.attempt(id, c)
    if (catching && looked >= THEN_LOOKS) return
    const timer = setTimeout(() => {
      this.settling.delete(id)
      try {
        if (catching) this.settleThen(id, c, looked + 1)
        else this.attempt(id, c)
      } catch (err) {
        console.error(`[compact] ${id.slice(0, 8)}: could not send the next step: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, queued === true ? THEN_QUEUE_MAX_MS : queued === null ? THEN_SETTLE_MS : THEN_LOOK_MS)
    timer.unref?.()
    this.settling.set(id, timer)
  }

  /** What waits behind the session's running turn (`SelfCompactionHost.queued`); null when the host cannot say */
  private queuedNow(id: string): boolean | null {
    try {
      return this.host.queued(id)
    } catch {
      return null
    }
  }

  private stopSettling(id: string): void {
    const t = this.settling.get(id)
    if (t) clearTimeout(t)
    this.settling.delete(id)
  }

  /** Sends the held step if the session is at rest; else the end of the turn that runs (or the sweep) tries again, and the step stays kept in the store */
  private attempt(id: string, c: Compacting): void {
    const then = c.then
    if (!then || this.stopped || this.compacting.get(id) !== c || !this.host.ready(id)) return
    c.then = null
    void this.sendThen(id, { stage: c.refused === null ? 'compacted' : 'refused', then, focusAside: c.focusAside, ahead: c.ahead, why: c.refused, at: this.now() })
  }

  /**
   * Claims the step, so the other host of a swap does not send it too, and sends it. From the claim on the record never goes back: a host that
   * leaves with the delivery in the air leaves it `sending`, and the next one tells the session that it may or may not have gone, and does not send
   * it again. A send that fails with this host staying tells the session
   */
  private async sendThen(id: string, rec: StoredThen): Promise<void> {
    let won = true
    try {
      won = this.host.keep.claim(id)
    } catch (err) {
      // Not kept (a failing store): sent from memory, as before the step was kept
      console.error(`[compact] ${id.slice(0, 8)}: could not claim the next step: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!won) return
    try {
      await this.goOn(id, this.thenTurn(rec), rec.why === null ? 'Centralu sent the agent its next step after the compaction' : 'Centralu sent the agent its next step: nothing was compacted')
      this.erase(id)
      this.counted(id)
    } catch (err) {
      if (this.stopped) return
      this.notTaken(id, rec)
      console.error(`[compact] ${id.slice(0, 8)}: could not send the next step: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** A compaction went on to its next step: past `WARN_COMPACT_CYCLES_PER_HOUR` in the hour the person is warned. A warning that cannot be written leaves the session as it was */
  private counted(id: string): void {
    try {
      const count = this.host.keep.cycle(id, this.now())
      if (count > WARN_COMPACT_CYCLES_PER_HOUR) this.host.warnCycles(id, count)
    } catch (err) {
      console.error(`[compact] ${id.slice(0, 8)}: could not count the cycle: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Tells the session, quietly, that its `then` was not sent; the person's window gets a line too */
  private tell(id: string, then: string, why: string): void {
    this.erase(id)
    this.host.notice(id, `The compaction did not happen (${why}): the next step the agent set was not sent`)
    this.deliver(id, `[Centralu] Your compact_self request did not compact (${why}), so your \`then\` was not sent. It was: ${then}`)
  }

  /** The step could not be given to the session: said as it was, for what it did (a compaction that happened is not said to have not) */
  private notTaken(id: string, rec: StoredThen): void {
    this.erase(id)
    const what = rec.why === null ? 'The compaction you asked for is done' : `Your compact_self request did not compact (${rec.why})`
    this.host.notice(id, `${rec.why === null ? 'The compaction is done' : 'The compaction did not happen'}, but the next step the agent set could not be sent`)
    this.deliver(id, `[Centralu] ${what}, but the session could not take your \`then\`. If you were not continued, go on with it yourself. It was: ${rec.then}`)
  }

  /**
   * A host that took over could not tell how far a request had come: the session is told what it was, to go on by itself. A turn that wakes the session when
   * it is at rest (a note it only read at its next input left a session stalled), a quiet note into the turn it is in. The conversation line says what happened
   */
  private async unknown(id: string, then: string, how: string): Promise<void> {
    this.erase(id)
    const text = `[Centralu] Centralu changed hosts while your compact_self request was pending (${how}), so it cannot tell whether the conversation was compacted or your \`then\` was sent. If you were not continued, go on with it yourself. It was: ${then}`
    const reached = await this.reach(id, text)
    const outcome = { turn: 'the agent was woken with its next step', note: 'the agent was told its next step', held: 'the agent is told its next step at its next input' }[reached]
    this.host.notice(id, `Centralu changed hosts while a compaction was asked for (${how}): ${outcome}`)
  }

  /** A turn for the session when it can take one (it wakes), else a quiet note; `held` when neither could be given (kept for its next input) */
  private async reach(id: string, text: string): Promise<'turn' | 'note' | 'held'> {
    if (!this.stopped && this.host.ready(id)) {
      try {
        await this.goOn(id, text, 'Centralu told the agent to go on: it changed hosts while a compaction was asked for')
        return 'turn'
      } catch {
        // The tool took no turn: the note below
      }
    }
    if (!this.stopped) {
      try {
        if (await this.host.nudge(id, text)) return 'note'
      } catch {
        // Held below
      }
    }
    this.hold(id, text)
    return 'held'
  }

  private deliver(id: string, text: string): void {
    // A host that is leaving gives the note to the next one, through the store
    if (this.stopped) return this.hold(id, text)
    const hold = (): void => this.hold(id, text)
    try {
      const took = this.host.nudge(id, text)
      if (took === true) return
      if (took === false) return hold()
      void took.then((ok) => (ok ? undefined : hold()), hold)
    } catch {
      hold()
    }
  }

  /** A note the tool cannot take now waits, in the store too, for a turn of the session or a request of its running turn */
  private hold(id: string, text: string): void {
    const notes = [...(this.owed.get(id) ?? []), text].slice(-3)
    this.owed.set(id, notes)
    try {
      this.host.keep.writeNotes(id, notes)
    } catch {
      // Kept in memory for this host
    }
  }

  /**
   * A host that starts, or has adopted a session's process after a swap: sends the `then` of a compaction known done, tells the session of every other
   * (the request or the compact was in the middle when the host changed, or the send was), and tries the notes the old host could not give. `only` limits it to
   * the sessions a caller has settled the process of: the ones the keeper kept wait for their adoption
   */
  recover(only?: (sessionId: string) => boolean): void {
    if (this.stopped) return
    for (const m of this.host.sessions()) {
      if (only && !only(m.id)) continue
      // In flight in this host: not one the last host left
      if (this.pending.has(m.id) || this.compacting.has(m.id)) continue
      let rec: StoredThen | null = null
      let notes: string[] = []
      try {
        rec = this.host.keep.read(m.id)
        notes = this.host.keep.notes(m.id)
      } catch (err) {
        console.error(`[compact] ${m.id.slice(0, 8)}: could not read what a host swap kept: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (notes.length > 0 && !this.owed.has(m.id)) this.owed.set(m.id, notes)
      if (rec) this.resume(m, rec)
      if (this.owed.has(m.id)) this.flushOwed(m.id)
    }
  }

  /** What one kept step asks of the host that finds it (`recover`) */
  private resume(m: SessionInfo, rec: StoredThen): void {
    const id = m.id
    // Left by a host long ago (a rollback to an older build): the situation it was kept for is gone
    if (this.now() - rec.at > THEN_KEEP_MS) return this.tell(id, rec.then, `it was kept for more than ${THEN_KEEP_MS / 60_000} minutes without going on, and what it followed is long past`)
    if (rec.stage === 'compacted' || rec.stage === 'refused') {
      // Known done: sent now if the session can take a turn; else (a limit or a card stands) it is held, and goes as soon as it can (`sweep`)
      // (a session with no process holds nothing: only mail waiting for it is looked at, and a step waits for the turn that mail starts)
      if (this.host.ready(id) && this.queuedNow(id) !== true) void this.sendThen(id, rec)
      else this.keepHeld(id, rec)
    } else void this.unknown(id, rec.then, rec.stage === 'sending' ? 'it was being sent' : rec.stage === 'asked' ? 'the turn had not ended' : 'the compact was sent and not yet reported done')
  }

  /** Holds a kept step that cannot go yet, like the step of a compaction in this host that ended: `sweep` sends it once the session is ready */
  private keepHeld(id: string, rec: StoredThen): void {
    this.compacting.set(id, { why: 'kept through a host change', sentAt: this.now(), started: true, compacted: true, ended: true, then: rec.then, refused: rec.why, focusAside: rec.focusAside, ahead: rec.ahead })
  }

  /** The notes the tool could not take at the time, tried again: a turn of the session has begun, or its running turn made a request */
  private flushOwed(id: string): void {
    const notes = this.owed.get(id)
    if (!notes) return
    this.owed.delete(id)
    try {
      this.host.keep.writeNotes(id, [])
    } catch {
      // Given below, or held again
    }
    for (const text of notes) this.deliver(id, text)
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

  private fire(id: string, why: string, focus: string | null, tool: ToolName, then: string | null = null): void {
    const text = this.host.command(id, tool, focus)
    // The tool has no compact command: a bare `/compact` would only be a prompt to its model
    if (text === null) {
      if (then) this.refuseRequest(id, then, 'this tool has no compact command')
      return
    }
    this.refusedAt.delete(id)
    // A tool whose compact takes no focus gets the same text with or without it: the line then heads the `then` turn
    const focusAside = focus !== null && text === this.host.command(id, tool, null) ? focus : null
    try {
      const entry: Compacting = { why, sentAt: this.now(), started: false, compacted: false, ended: false, then, refused: null, focusAside, ahead: false }
      this.compacting.set(id, entry)
      this.stage(id, entry, 'sent')
      this.host.send(id, text)
    } catch (err) {
      this.compacting.delete(id)
      if (then) this.refuseRequest(id, then, 'the compaction could not be sent')
      console.error(`[compact] ${id.slice(0, 8)}: could not send the compaction: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Compacts the resting sessions that are over the lower share. Returns the ids it sent a compact to */
  sweep(): string[] {
    const now = this.now()
    const setting = this.host.setting()
    const sent: string[] = []
    // A compact the tool never reported: its `then` is never sent (it would follow a compaction that did not happen)
    for (const [id, c] of this.compacting) if (c.then && !c.compacted && now - c.sentAt >= COMPACT_STALE_MS) this.refuseFlight(id, c, 'the tool never reported the compaction')
    // A step held for a session that was not at rest when its moment came goes as soon as it is
    // (looked at the way a turn's end looks at it: what waits goes first)
    for (const [id, c] of this.compacting) if (c.ended && c.then && !this.settling.has(id)) this.settleThen(id, c)
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
    // Compacted since the tool last read the context: the reading kept is from before and says nothing of the size now
    if (!ctx || ctx.window <= 0 || this.unread.has(m.id)) return false
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
    for (const t of this.settling.values()) clearTimeout(t)
    this.settling.clear()
    this.owed.clear()
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
    this.unread.delete(id)
    this.owed.delete(id)
    this.stepping.delete(id)
    this.refusedAt.delete(id)
    this.stopSettling(id)
    // What a host swap would find of a deleted session is gone with it: a session restored from the trash must not be sent an old step
    this.erase(id)
    try {
      this.host.keep.writeNotes(id, [])
    } catch {
      // Purged with the session in the end (SESSION_SETTING_OF)
    }
  }
}
