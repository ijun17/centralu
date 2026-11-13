import { durationText } from '../timing.js'
import { errorMessage, type NormalizedEvent, type SessionInfo, type ToolName } from '@cc/protocol'
import { LIMIT_NOTE, NETWORK_NOTE, RETRY_NOTE } from '../adapters/input-receipts.js'
import { SERVER_OVERLOADED } from '../adapters/overloaded.js'
import { inTurn } from '../idle.js'
import type { WaitEnd } from '../mail/stop-notices.js'
import { planLimitResetAt } from './error-kind.js'

/**
 * The one owner of "continue a stopped turn once its cause clears" (#1693, #1415, #2238; docs/agent-host/lifecycle/auto-continue.md).
 * Each cause is a row of `CAUSES`; what differs between them is when the cause has cleared, not how the turn goes on: always
 * through Centralu's own channel (a note, never a message of the person's), as an update's continue goes (#1618).
 *
 * **Overloaded (#1693, owner 2026-10-28: as built).** Codex ends the turn with `serverOverloaded` (`adapters/overloaded.ts`) after
 * its own attempts. Claude Code retries a 529 itself, ten times, and its turn that ends with "API Error: 529" ended after those, so
 * no retry is stacked on it. The error does not end the turn (`hold`): the session stays `working`, so nobody who gave it the turn
 * is told it failed, and a notice says when the next try is. The wait grows (`DELAYS_MS`): the turns that ended this way had run 14
 * to 44 minutes, so a tight loop would only repeat the same refusal. Once the work is done (it finishes, or the person takes over)
 * the count starts over; output in between does not. When the tries are spent the error ends the turn, saying how often it was retried.
 * The host leaving ends a held turn with its error now (`stopAll`): no later host would hear that error again. Nothing is stored.
 *
 * **Network and usage limit (#1415, #2238, owner 2026-10-26 and 2026-11-13).** The turn ends as it does (`error` or `limited`, its
 * `interruption` says why), and the interruption gains `autoContinue` (`armAfter`): the screen shows the wait, and the wait is
 * stored with the session, so a host that starts later takes it up again (`restore`). A usage limit continues at its reset plus
 * `RESET_MARGIN_MS`; the network once a cheap request to the tool's API host gets any answer (`reachable`), tried at
 * `PROBE_STEPS_MS`, at once after the computer woke (a tick that came late), and at once when another turn of the same tool
 * finishes. Several sessions of a tool that clear together go `STAGGER_MS` apart. A continue that ends the same way counts: after
 * `MAX_TRIES` of the cause in a row the stop is left for the person. Never continued: a Codex credits limit, a compaction turn, a
 * stop the setting is off for.
 *
 * **What cancels it.** The person's Stop (`cancel`), a message into the session (`deliver` calls `supersede`: it carries the work on
 * itself; the person's Continue is told as the work going on, once it went in: `personContinues`), a turn that starts any other way (mail the
 * mailbox delivers: `observe` sees `working`), Don't continue (`stopContinue`), the cause's setting going off (`settingsChanged`, and the
 * send's gate reads it), the session going to the trash (`forget`) or being deleted. A held turn also goes with
 * any other end of the turn (`observe`). Each is honoured until the note is handed to the tool: the send is gated on the wait
 * still standing (`live`). Once handed, the tool runs a turn of its own and the session is in an ordinary turn.
 */

/** The wait before each retry of an overloaded turn, in order: how many retries there are is how many entries there are */
export const DELAYS_MS = [30_000, 120_000, 300_000, 600_000] as const

/** What stopped the turn, and so what has to clear before it goes on */
export type ContinueCause = 'overloaded' | 'network' | 'limit'
type StopCause = Exclude<ContinueCause, 'overloaded'>

/**
 * How many continues of one cause in a row before the stop is left for the person. Overloaded: the delays above. Network: five,
 * since an outage can flap, and each continue is made only once the API answered, so a sixth failure means the turn itself
 * fails there. Usage limit: three, as one reset can be followed by the weekly limit or a reset time that was not one (the
 * slow retry of a limit with no time), and a fourth stop on the limit says the account will not run it now.
 */
export const MAX_TRIES: Record<ContinueCause, number> = { overloaded: DELAYS_MS.length, network: 5, limit: 3 }

/**
 * What each continue hands the agent through Centralu's channel (`text`, input-receipts.ts), and the line the conversation shows where it
 * went in. An overloaded turn's retry has its notice already, so no line
 */
export const CONTINUE_NOTES: Record<ContinueCause, { text: string; line: string; label: string }> = {
  overloaded: { text: RETRY_NOTE, line: '', label: 'retry' },
  network: { text: NETWORK_NOTE, line: 'The network is back, so Centralu continued this turn.', label: 'continue' },
  limit: { text: LIMIT_NOTE, line: 'The usage limit reset, so Centralu continued this turn.', label: 'continue' },
}

/** After a usage limit's reset, before the continue: the provider's clock and ours differ by seconds */
export const RESET_MARGIN_MS = 60_000
/** A usage limit whose tool said no reset time is tried again this long after it stopped */
export const NO_RESET_RETRY_MS = 30 * 60_000
/** Between two probes of a tool's API while the network is down; the last repeats */
export const PROBE_STEPS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const
/** Between two sessions of one tool continued at once, so they do not hit the provider in one burst (#1913) */
export const STAGGER_MS = 5_000
/** How often the waits are looked at while any stands; a tick much later than this means the computer slept */
export const TICK_MS = 5_000
const SLEPT_MS = 30_000
/**
 * Failed probes of a tool's API in a row before its network waits are left for the person: about 6 hours of the computer awake at the
 * last step. An outage that long is not a drop, and an address the probe cannot see (a gateway set where it is not read) would wait for ever
 */
export const MAX_FAILED_PROBES = 80
const UNREACHABLE_WORDS = "Centralu could not reach this tool's API for hours, so it does not continue this turn by itself. Send a message to go on."

/** A tool's probe while its network waits stand: which step it is on, when the next is, whether one is out, how many failed in a row */
type Probe = { step: number; next: number; out: boolean; failed: number }

/** What the engine reaches of the host */
export type TurnContinueHost = {
  meta: ReadonlyMap<string, SessionInfo>
  /** The host is leaving (a quit or a swap) */
  leaving(): boolean
  /** The running turn is one Centralu started to compact the conversation: that one is not continued */
  compactTurn(sessionId: string): boolean
  /** Whether the session has a process to continue a held turn in */
  running(sessionId: string): boolean
  /** Which stops this computer continues by itself (the person's settings) */
  settings(): Record<StopCause, boolean>
  /** Whether the tool's API answers at all now: any response counts, no answer within a few seconds does not. Never throws */
  reachable(tool: ToolName): Promise<boolean>
  /** Continues the turn through Centralu's channel with the cause's note; sends nothing when the wait no longer stands by then; throws when the tool does not take it */
  send(sessionId: string, cause: ContinueCause, gate: RetrySend): Promise<void>
  /** An event of the session, as if its tool had said it */
  note(e: NormalizedEvent): void
  /** The session's interruption changed outside an event of its: stored and said to the windows */
  changed(m: SessionInfo): void
  /**
   * A stop's wait ended: `continued` when its continue went in (`first` of a run of stops), else it was dropped (Stop, a message, Don't continue,
   * the trash, the setting, the tries spent). Who the stop's notice was held from hears it now, once (the stop notice path, #1948)
   */
  waitEnded(sessionId: string, cause: StopCause, end: WaitEnd): void
}

/** What a send is given: whether the wait still stands, and the word that the tool is being handed the note (from then on the turn is the tool's) */
export type RetrySend = { live(): boolean; handed(): void }

/** Where a held retry is: waiting for its time, being sent (a restart or a wake waited out first), or handed to the tool, which runs the turn */
export type RetryPhase = 'waiting' | 'sending' | 'handed'

/** A held retry and the error it stands in for, to say if the turn ends without it */
type Held = { timer: ReturnType<typeof setTimeout> | null; message: string; phase: RetryPhase }
/** A stop's wait: its cause, its tool (the account it waits with), and for a limit when */
type StopWait = { cause: StopCause; tool: ToolName; at?: number; tries: number; phase: 'waiting' | 'due' | 'sending' }

export class TurnContinue {
  /** Retries an overloaded turn's work used since it was done */
  private readonly heldTries = new Map<string, number>()
  private readonly held = new Map<string, Held>()
  /** Continues made for a run of stops of one cause, by session: back to none when a turn finishes or the person acts */
  private readonly stopTries = new Map<string, { cause: StopCause; n: number }>()
  private readonly stops = new Map<string, StopWait>()
  /** Per tool while its network waits stand: which probe step it is on, when the next is, and whether one is out */
  private readonly probes = new Map<ToolName, Probe>()
  /** Per tool: the earliest a next continue may go, so sessions that clear together go `STAGGER_MS` apart */
  private readonly slots = new Map<ToolName, number>()
  private ticker: ReturnType<typeof setInterval> | null = null
  private lastTick = 0

  constructor(private readonly host: TurnContinueHost) {}

  /**
   * An error the tool sent, and the event that goes through the host in its place. Not an overloaded one, or one that ends
   * nothing it could continue (the session is not in a turn, the host is leaving, a compaction): as it is. Otherwise the
   * notice of the retry, and the turn goes on waiting; once the tries are spent, the error, saying so.
   */
  hold(e: Extract<NormalizedEvent, { type: 'error' }>): NormalizedEvent {
    const id = e.sessionId
    const data = e.error.data
    if (!id || typeof data !== 'object' || data === null || (data as { reason?: unknown }).reason !== SERVER_OVERLOADED) return e
    const m = this.host.meta.get(id)
    // One still to be sent already stands for this turn's end. Once the note is sent, an error is the retried turn's own: retried in its turn, the count kept
    if (!m || !inTurn(m.state) || this.host.leaving() || this.host.compactTurn(id) || this.held.get(id)?.phase === 'waiting') return e
    const tries = this.heldTries.get(id) ?? 0
    if (tries >= DELAYS_MS.length) {
      this.heldTries.delete(id)
      this.held.delete(id)
      return { ...e, error: { ...e.error, message: `${e.error.message}\n${spentWords(tries)}` } }
    }
    const wait = DELAYS_MS[tries] ?? 0
    this.heldTries.set(id, tries + 1)
    const entry: Held = { timer: null, message: e.error.message, phase: 'waiting' }
    entry.timer = setTimeout(() => void this.fireHeld(id, entry), wait)
    entry.timer.unref?.()
    this.held.set(id, entry)
    return {
      type: 'notice',
      sessionId: id,
      level: 'warning',
      from: 'Centralu',
      label: 'retry',
      text: `The model's servers are at capacity, which is not your usage limit. Centralu retries this turn in ${durationText(wait)} (retry ${tries + 1} of ${DELAYS_MS.length}). Stop cancels it.`,
    }
  }

  /**
   * A turn's end set the session's interruption (`interruptionAfter`, before the session is stored): a network or usage-limit stop is
   * given its wait, unless it may not continue by itself. `e` is the event that ended the turn: a limit's own event says its reset and
   * whether it is a credits limit
   */
  armAfter(e: NormalizedEvent, m: SessionInfo, endedTurn: boolean): void {
    const i = m.interruption
    if (!endedTurn || (i?.reason !== 'network' && i?.reason !== 'limit')) return
    const cause = i.reason
    if (!this.host.settings()[cause] || (e.type === 'limit_reached' ? e.credits : m.limit?.credits) || this.host.leaving() || this.host.compactTurn(m.id)) return
    const run = this.stopTries.get(m.id)
    const tries = run?.cause === cause ? run.n : 0
    if (tries >= MAX_TRIES[cause]) {
      this.stopTries.delete(m.id)
      this.host.note({ type: 'notice', sessionId: m.id, level: 'warning', from: 'Centralu', label: 'continue', text: giveUpWords(cause, tries) })
      return
    }
    const now = Date.now()
    const worded = e.type === 'error' ? planLimitResetAt(e.error.message, now) : undefined
    const at = cause === 'limit' ? resetAt(e.type === 'limit_reached' ? e.resumeAt : m.limit?.resumeAt, worded, now) : undefined
    i.autoContinue = at === undefined ? { tries } : { at, tries }
    this.wait(m.id, { cause, tool: m.tool, at, tries, phase: 'waiting' })
  }

  /** The stops a host before this one left waiting (stored with each session): taken up again as they were */
  restore(sessions: Iterable<SessionInfo>): void {
    for (const m of sessions) {
      const i = m.interruption
      const a = i?.autoContinue
      if (!a || (i.reason !== 'network' && i.reason !== 'limit')) continue
      this.stopTries.set(m.id, { cause: i.reason, n: a.tries })
      this.wait(m.id, { cause: i.reason, tool: m.tool, at: a.at, tries: a.tries, phase: 'waiting' })
    }
  }

  /** Every event of a session: the ones that end a held turn take its wait away; a finished turn starts every count over and says its tool's API answers */
  observe(e: NormalizedEvent): void {
    const id = e.sessionId
    if (!id) return
    if (e.type === 'turn_complete' || e.type === 'error' || e.type === 'limit_reached' || e.type === 'session_deleted' || (e.type === 'state_change' && e.state !== 'working')) this.cancelHeld(id)
    if (e.type === 'session_deleted') this.dropStop(id, false)
    // A turn starts that is not this engine's continue (that one's wait went when it was handed): mail the mailbox gave, a wake. It carries
    // the work on, so the wait goes, and who the stop's notice was held from hears it now (#2239 re-check). Before the interruption is
    // cleared (`trackInterruption` runs after this), so the stored wait is still there to say it
    if (e.type === 'state_change' && e.state === 'working' && this.stops.has(id)) this.dropStop(id, 'went on')
    // Codex says a credits limit when it likes, also after the turn it ended (#1415 review): a wait armed on the error's words goes
    if (e.type === 'limit_reached' && e.credits && this.stops.get(id)?.cause === 'limit') this.stopContinue(id)
    if (e.type !== 'turn_complete') return
    this.stopTries.delete(id)
    const tool = this.host.meta.get(id)?.tool
    if (tool && this.probes.has(tool)) this.release(tool, 'network')
  }

  /** Whether a held retry waits for its time: the turn the error stood in for goes on, so what hangs on that turn (a hub task's depth) is not over */
  stands(sessionId: string): boolean {
    return this.held.get(sessionId)?.phase === 'waiting'
  }

  /**
   * The person's Stop, or an end of the turn: takes the session's waits away. Returns where a held retry was, or null when none
   * stood. Handed, the tool's turn is running and is the caller's to stop
   */
  cancel(sessionId: string): RetryPhase | null {
    this.stopContinue(sessionId)
    return this.cancelHeld(sessionId)
  }

  /**
   * A message into the session takes its waits away (`SessionEvents.deliver`): the error a held retry stood in for, or null when none
   * stood. The error is handed back for the case that the message does not go in (`lost`). Not a retry handed to the tool: its turn is
   * running and the message joins it like any message into a running turn, with nothing owed; only the record of the note goes
   */
  supersede(sessionId: string): string | null {
    this.stopContinue(sessionId)
    const w = this.held.get(sessionId)
    if (w?.phase === 'handed') {
      this.heldTries.delete(sessionId)
      // The person's turn now: a late refusal of the note is not a failure of theirs (`fireHeld` ignores it once the entry is gone)
      this.held.delete(sessionId)
      return null
    }
    this.cancelHeld(sessionId)
    return w?.message ?? null
  }

  /** The message that took a held retry away was refused: the turn is over, ended by the error the retry stood in for */
  lost(sessionId: string, message: string): void {
    if (!inTurn(this.host.meta.get(sessionId)?.state ?? 'idle')) return
    this.host.note(failure(sessionId, `${message}\nCentralu was going to retry this turn, but a message to the session came first and was not delivered. Send a message to go on.`))
  }

  /** Don't continue (`sessions.stopContinue`), or the person acted on the session: its stop waits for the person. Whether a wait stood */
  stopContinue(sessionId: string): boolean {
    this.stopTries.delete(sessionId)
    return this.dropStop(sessionId, 'stopped')
  }

  /**
   * The person's Continue (Continue now, the inbox's Continue) while a wait stands: the wait goes now, and who the stop's notice was held from is told
   * once the message went in (`ok`: the work went on) or did not (the stop). Null when no wait stood. Any other message of the person's is them
   * taking the work over: told as the stop (`supersede`)
   */
  personContinues(sessionId: string): ((ok: boolean) => void) | null {
    const i = this.host.meta.get(sessionId)?.interruption
    if (!this.stops.has(sessionId) || !i?.autoContinue || (i.reason !== 'network' && i.reason !== 'limit')) return null
    const cause = i.reason
    const first = this.endRun(sessionId)
    this.dropStop(sessionId, false)
    return (ok) => this.host.waitEnded(sessionId, cause, ok ? { continued: 'other', first } : { continued: false, first: false })
  }

  /** The work went on in a turn of its own: the run of continues ends; whether this engine had continued none of it (the starter hears of the first) */
  private endRun(sessionId: string): boolean {
    const first = (this.stopTries.get(sessionId)?.n ?? 0) === 0
    this.stopTries.delete(sessionId)
    return first
  }

  /**
   * The person's settings changed (`UiPreferenceStore.setUiPreferences`): a wait whose setting is off now ends at once, told once, rather than
   * standing on screen until its time comes (#2239 re-check)
   */
  settingsChanged(): void {
    const on = this.host.settings()
    // One being sent is the send's gate's (`live` reads the setting right before the hand-off)
    for (const [id, w] of [...this.stops]) if (!on[w.cause] && w.phase !== 'sending') this.stopContinue(id)
  }

  /** The session goes to the trash: a restore from there continues nothing by itself, so the stored wait goes with the row */
  forget(sessionId: string): void {
    this.stopContinue(sessionId)
    this.cancelHeld(sessionId)
  }

  /**
   * The host is leaving: a held turn ends with the error it stood in for, which no later host would hear again. A handed one is the
   * tool's running turn: it leaves as any does. A stop's wait is stored with its session, so the host after this one takes it up
   */
  stopAll(): void {
    for (const [id, w] of [...this.held]) {
      this.cancelHeld(id)
      if (w.phase === 'handed') continue
      this.host.note(failure(id, `${w.message}\nCentralu was going to retry this turn, but it restarted first. Send a message to go on.`))
    }
    this.stops.clear()
    this.idle()
  }

  private cancelHeld(sessionId: string): RetryPhase | null {
    this.heldTries.delete(sessionId)
    const w = this.held.get(sessionId)
    if (!w) return null
    if (w.timer) clearTimeout(w.timer)
    this.held.delete(sessionId)
    return w.phase
  }

  /**
   * Takes a stop's wait away, stored too: whether one stood. `tell`: who its stop's notice was held from hears it now, that it ended without a
   * continue (`stopped`) or that the work went on in a turn of its own (`went on`, with the starter on the first of a run); false: the caller tells,
   * or nobody is owed
   */
  private dropStop(sessionId: string, tell: false | 'stopped' | 'went on'): boolean {
    const first = tell === 'went on' && this.endRun(sessionId)
    const had = this.stops.delete(sessionId)
    const m = this.host.meta.get(sessionId)
    const i = m?.interruption
    if (m && i?.autoContinue) {
      const { autoContinue: _, ...stop } = i
      m.interruption = stop
      this.host.changed(m)
      if (tell && (i.reason === 'network' || i.reason === 'limit')) this.host.waitEnded(sessionId, i.reason, tell === 'went on' ? { continued: 'other', first } : { continued: false, first: false })
    }
    if (!this.stops.size) this.idle()
    return had
  }

  private wait(sessionId: string, w: StopWait): void {
    this.stops.set(sessionId, w)
    // Backs off by the session's own tries: a probe that answers while the turn still fails (a gateway that answers but drops the API's requests) does not spend the tries in a minute
    if (w.cause === 'network' && !this.probes.has(w.tool)) {
      const step = Math.min(w.tries, PROBE_STEPS_MS.length - 1)
      this.probes.set(w.tool, { step, next: Date.now() + (PROBE_STEPS_MS[step] ?? PROBE_STEPS_MS[0]), out: false, failed: 0 })
    }
    if (this.ticker) return
    this.lastTick = Date.now()
    this.ticker = setInterval(() => this.tick(), TICK_MS)
    this.ticker.unref?.()
  }

  private idle(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.probes.clear()
  }

  /** Looks at every standing wait: a limit whose time came, a network probe that is due (at once after the computer slept) */
  private tick(): void {
    const now = Date.now()
    const slept = now - this.lastTick > TICK_MS + SLEPT_MS
    this.lastTick = now
    for (const [id, w] of this.stops) if (w.cause === 'limit' && w.phase === 'waiting' && (w.at ?? 0) <= now) this.due(id, w)
    for (const [tool, p] of this.probes) {
      if (![...this.stops.values()].some((w) => w.tool === tool && w.cause === 'network')) {
        this.probes.delete(tool)
        continue
      }
      if (!p.out && (slept || now >= p.next)) void this.probe(tool, p)
    }
  }

  private async probe(tool: ToolName, p: Probe): Promise<void> {
    p.out = true
    const up = await this.host.reachable(tool)
    p.out = false
    if (this.probes.get(tool) !== p) return
    if (up) return this.release(tool, 'network')
    if (++p.failed >= MAX_FAILED_PROBES) return this.unreachable(tool)
    p.step = Math.min(p.step + 1, PROBE_STEPS_MS.length - 1)
    p.next = Date.now() + (PROBE_STEPS_MS[p.step] ?? PROBE_STEPS_MS[0])
  }

  /** The tool's API has not answered for hours (or its address is one the probe cannot see): its network waits are left for the person */
  private unreachable(tool: ToolName): void {
    this.probes.delete(tool)
    for (const [id, w] of [...this.stops]) {
      if (w.tool !== tool || w.cause !== 'network' || w.phase !== 'waiting') continue
      this.stopContinue(id)
      this.host.note({ type: 'notice', sessionId: id, level: 'warning', from: 'Centralu', label: 'continue', text: UNREACHABLE_WORDS })
    }
  }

  /** The cause cleared for every session of a tool waiting on it */
  private release(tool: ToolName, cause: StopCause): void {
    if (cause === 'network') this.probes.delete(tool)
    for (const [id, w] of this.stops) if (w.tool === tool && w.cause === cause && w.phase === 'waiting') this.due(id, w)
  }

  /** Its cause cleared: it goes at the tool's next free slot */
  private due(id: string, w: StopWait): void {
    w.phase = 'due'
    const now = Date.now()
    const slot = Math.max(now, this.slots.get(w.tool) ?? 0)
    this.slots.set(w.tool, slot + STAGGER_MS)
    if (slot <= now) return void this.fireStop(id, w)
    const timer = setTimeout(() => void this.fireStop(id, w), slot - now)
    timer.unref?.()
  }

  private async fireStop(id: string, w: StopWait): Promise<void> {
    // Taken away meanwhile (every end of a wait drops it first: a turn that started, the person, the setting). Leaving: the stored wait is the next host's
    if (this.stops.get(id) !== w || this.host.leaving()) return
    w.phase = 'sending'
    const run = this.stopTries.get(id)
    const n = (run?.cause === w.cause ? run.n : 0) + 1
    this.stopTries.set(id, { cause: w.cause, n })
    let handed = false
    const standing = () => this.stops.get(id) === w
    // The one gate, read right before the note is handed: the wait still stands and its setting is still on (it can go off while a dormant session wakes)
    const live = () => standing() && this.host.settings()[w.cause]
    try {
      await this.host.send(id, w.cause, {
        live,
        // Handed: the stored wait goes before the tool has it, so a host that starts after this one does not continue the turn again
        handed: () => {
          handed = true
          this.dropStop(id, false)
        },
      })
    } catch (err) {
      const words = `Centralu could not continue this turn: ${errorMessage(err)}`
      // Handed and then refused by the tool: the wait went at the hand-off, so who the stop's notice was held from is told here (#2239 re-check)
      if (handed) {
        this.stopTries.delete(id)
        this.host.note({ type: 'notice', sessionId: id, level: 'warning', from: 'Centralu', label: 'continue', text: words })
        this.host.waitEnded(id, w.cause, { continued: false, first: false })
        return
      }
      if (!standing()) return
      this.stopContinue(id)
      this.host.note({ type: 'notice', sessionId: id, level: 'warning', from: 'Centralu', label: 'continue', text: words })
      return
    }
    // Not handed and still standing: the gate said no at the last check (the setting went off, the session was taken over), so the wait ends without a continue
    if (standing()) this.stopContinue(id)
    if (handed) this.host.waitEnded(id, w.cause, { continued: 'centralu', first: n === 1 })
  }

  private async fireHeld(id: string, w: Held): Promise<void> {
    if (this.held.get(id) !== w) return
    w.phase = 'sending'
    const live = () => this.held.get(id) === w
    try {
      if (!this.host.running(id)) throw new Error('the session has no process left to continue it in')
      await this.host.send(id, 'overloaded', { live, handed: () => { w.phase = 'handed' } })
    } catch (err) {
      // Cancelled meanwhile (a Stop, a message, another end): nothing is owed
      if (!live()) return
      this.cancelHeld(id)
      this.host.note(failure(id, `${w.message}\nCentralu could not retry the turn: ${errorMessage(err)}`))
      return
    }
    if (live()) this.held.delete(id)
  }
}

/**
 * When a usage limit's continue goes: its reset and a margin. The reset the tool's data says first (ISO), else the one its words say (`worded`, a
 * Codex 429's "try again at 6:17 PM"); with neither, a slow retry
 */
function resetAt(resumeAt: string | undefined, worded: number | undefined, now: number): number {
  const said = resumeAt ? Date.parse(resumeAt) : NaN
  const reset = Number.isFinite(said) ? said : worded
  return reset !== undefined ? Math.max(reset, now) + RESET_MARGIN_MS : now + NO_RESET_RETRY_MS
}

/** The turn's end, as the provider's error said it (without the marker, which would hold it again) */
function failure(sessionId: string, message: string): NormalizedEvent {
  return { type: 'error', sessionId, error: { code: 'internal', message, retryable: true } }
}

function spentWords(tries: number): string {
  return `Centralu retried this turn ${tries} ${tries === 1 ? 'time' : 'times'} and the servers stayed at capacity. This is not a usage limit: try again later or pick another model.`
}

function giveUpWords(cause: StopCause, tries: number): string {
  const what = cause === 'network' ? 'the network failed again' : 'it reached the usage limit again'
  return `Centralu continued this turn ${tries} ${tries === 1 ? 'time' : 'times'} and ${what}, so it does not continue it by itself any more. Send a message to go on.`
}
