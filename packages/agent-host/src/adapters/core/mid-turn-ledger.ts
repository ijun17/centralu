import { INTERRUPTED_BY_TOOL, type EventSink, type InputObserver } from '../contract.js'
import { InputReceipts, isUuid } from '../input-receipts.js'
import { stopNotConfirmed, undeliveredError } from '../session-kit.js'
import type { MidTurnInput, MidTurnWire, ToolTurnEnding } from './seam.js'

/**
 * The ledger for a tool that takes input mid-turn (docs/plans/session-core.md §4.2, §7.2 PR 6, #1654): Codex, and Claude in
 * PR 7. The tool merges an input into the turn it runs or starts a turn for it, and names its turns, so the inputs are bound
 * to the turn the tool says took them, not to one the core began. What it keeps: the phase, the inputs that wait (while the
 * conversation opens, and behind a turn no input may join), the receipts and the turn each is bound to, the turn a Stop
 * targets, the Stop, "interrupted by the tool", and the exit, a crash with work in flight and asleep when idle (#1397). The
 * wire owns its connection and the frames, and tells the ledger what the tool said (`turnStarted`, `taken`, `turnEnded`,
 * `failed`, `exited`).
 */

/** How many ended turns, and turns a Stop was sent to, are kept: more than can have an answer still in flight */
const TURNS_KEPT = 8

const keep = (list: string[], id: string): void => {
  list.push(id)
  if (list.length > TURNS_KEPT) list.shift()
}

const trackedOf = (inputs: readonly MidTurnInput[]) => inputs.flatMap((i) => (i.receipt ? [i.receipt] : []))

export class MidTurnLedger {
  readonly ready: Promise<void>
  private phase: 'opening' | 'ready' | 'closed' = 'opening'
  /** Inputs not written yet: sent while the conversation opens, behind a blocking turn, or in the tick they were sent */
  private queue: MidTurnInput[] = []
  private readonly receipts = new InputReceipts()
  /**
   * The tool's turn that runs now: what a Stop targets. Cleared at its end, since stopping a turn that has ended is refused
   * and the refusal would read as a Stop that did not take
   */
  private running: string | null = null
  /** The latest turns that ended: an answer that names one late does not bring it back as the running one */
  private readonly ended: string[] = []
  /** The latest turns our Stop was sent to (#698): any other turn the tool interrupted, it did on its own */
  private readonly stopped: string[] = []
  /** Writes the tool has not answered: a message not yet answered is in flight, so an exit then is a crash (#1397 review) */
  private unanswered = 0
  /**
   * A turn no input may join runs (Codex's /compact and /review, which we started): Codex 0.147.0 answered `turn/start`
   * with success during one and dropped the input. What is sent waits, and goes as one message at its end
   */
  private blocking = false

  constructor(
    private readonly sessionId: string,
    private readonly emit: EventSink,
    private readonly wire: MidTurnWire,
  ) {
    this.ready = wire.open().then(() => {
      if (this.phase === 'opening') this.phase = 'ready'
      this.drain()
    })
    // It never opened: a tracked input sent meanwhile fails with why, once whoever watches the opening has spoken (a step later)
    this.ready
      .then(() => {})
      .catch((err: Error) => {
        if (this.receipts.size > 0) this.interrupt(err)
      })
  }

  get closed(): boolean {
    return this.phase === 'closed'
  }

  /** The running turn an input could be steered into: none while opening, behind a blocking turn, or between turns */
  steerable(): string | null {
    return this.phase === 'ready' && !this.blocking ? this.running : null
  }

  send(text: string): void {
    this.enqueue({ text, receipt: null })
  }

  /** `id`: the host's name for the input, which becomes its receipt's id when it is a UUID, so the tool names it back */
  sendTracked(text: string, observer?: InputObserver, id?: string): Promise<void> {
    const receipt = this.receipts.create(observer, id !== undefined && isUuid(id) ? id : undefined)
    this.enqueue({ text, receipt })
    return receipt.done
  }

  /** Written on a later tick, as a message sent then always was: a Stop in the same tick keeps a tracked one from going */
  private enqueue(input: MidTurnInput): void {
    this.queue.push(input)
    if (this.phase !== 'opening') queueMicrotask(() => this.drain())
  }

  private drain(): void {
    while (this.phase !== 'opening' && !this.blocking) {
      const next = this.queue.shift()
      if (!next) return
      this.write([next], false)
    }
  }

  /** The blocking turn ended (or never started): what waited behind it goes as one message */
  private unblock(): void {
    this.blocking = false
    if (this.queue.length > 0) this.write(this.queue.splice(0), true)
  }

  private write(inputs: MidTurnInput[], queued: boolean): void {
    this.unanswered += 1
    let written: ReturnType<MidTurnWire['write']>
    try {
      written = this.wire.write(inputs, queued)
    } catch (err) {
      written = { answer: Promise.reject(err instanceof Error ? err : new Error(String(err))) }
    }
    const { answer, blocking } = written
    if (blocking) this.blocking = true
    answer
      .catch((err: Error) => {
        // A blocking turn that failed to start would hold the queue forever
        if (blocking) this.unblock()
        this.refused(inputs, err, queued)
      })
      // After the refusal: an exit is seen before it, so an exit with this write unanswered is a crash
      .finally(() => {
        this.unanswered -= 1
      })
  }

  private refused(inputs: readonly MidTurnInput[], err: Error, queued: boolean): void {
    const tracked = trackedOf(inputs)
    if (tracked.length > 0 && tracked.every((r) => r.cancelled || r.completed)) return
    if (queued ? this.receipts.size > 0 : tracked.length > 0) this.interrupt(err)
    this.emit({ type: 'error', sessionId: this.sessionId, error: this.wire.refusal(err) })
  }

  /** A turn the tool started: the one a Stop targets */
  turnStarted(id: string | null): void {
    this.running = id
  }

  /**
   * The tool named the turn that took these inputs (the write's answer, or the input's own item). True when the turn was taken
   * as the running one (unless it had ended) and the inputs bound to it. The answer and the notifications race: a turn can be
   * named by its answer before the tool says it started (a Stop pressed very quickly), and can end before its answer comes (a
   * short turn), so a late answer never brings an ended turn back
   */
  taken(inputs: readonly MidTurnInput[], id: string | null): boolean {
    const tracked = trackedOf(inputs)
    if (tracked.length > 0) {
      if (tracked.every((r) => r.completed)) return false
      if (!id) {
        this.interrupt(new Error(`${this.wire.label} did not identify the turn accepting the parent note`))
        return false
      }
      // Stopped while the write was in flight, before the turn was named: that turn is stopped as ours
      if (tracked.some((r) => r.cancelled)) {
        if (!this.ended.includes(id)) this.stop(id, false)
        return false
      }
    }
    if (!id) return true
    if (!this.ended.includes(id)) this.running ??= id
    for (const r of tracked) this.receipts.bind(r, id)
    // Bound to a turn that already ended: it completes now
    if (this.ended.includes(id)) this.receipts.complete(tracked.map((r) => r.id))
    return true
  }

  /** A turn ended; `ending`: how, said to the host with the inputs bound to it settled (null: the tool says no more of it) */
  turnEnded(id: string | null, ending: ToolTurnEnding | null): void {
    this.running = null
    if (id) keep(this.ended, id)
    if (!ending) return
    if (this.blocking) this.unblock()
    const sessionId = this.sessionId
    switch (ending.how) {
      case 'complete':
        this.emit({ type: 'turn_complete', sessionId })
        break
      case 'interrupted':
        this.emit({ type: 'state_change', sessionId, state: 'waiting_input', reason: id && this.stopped.includes(id) ? 'interrupted' : INTERRUPTED_BY_TOOL })
        break
      case 'failed':
        if (this.receipts.size > 0) this.interrupt(new Error(ending.error.message))
        this.emit({ type: 'error', sessionId, error: ending.error })
        return
    }
    if (id) this.receipts.endTurn(id)
  }

  /** Our Stop was sent to this turn (#698) */
  stopSent(turnId: string): boolean {
    return this.stopped.includes(turnId)
  }

  /** The tool reported an error: the tracked inputs still waiting fail with it, as on a Stop */
  failed(reason: Error): void {
    if (this.receipts.size > 0) this.interrupt(reason)
  }

  private stop(turnId: string, running: boolean): void {
    if (!this.stopped.includes(turnId)) keep(this.stopped, turnId)
    void this.wire.interrupt(turnId).catch((err: Error) => {
      // As a notice (#1060): the turn is still running, and an error would end it for the host
      if (running) this.emit(stopNotConfirmed(this.sessionId, `Could not stop: ${err.message}. The turn is still running.`))
    })
  }

  /**
   * Every tracked input fails now, and the turns they were bound to are stopped. Before the conversation exists, what was sent
   * meanwhile is dropped and no turn will come to say it stopped, so the stop is said here (#168). Once it exists, a turn may
   * run in it (an adopted one, still being looked up): what waits goes once it opens, as any message sent then
   */
  interrupt(reason = new Error('The parent note was stopped before it finished')): void {
    const waking = this.phase === 'opening' && !this.wire.hasConversation() && this.queue.length > 0
    for (const turn of this.receipts.failAll(reason)) {
      if (turn !== this.running && !this.ended.includes(turn)) this.stop(turn, false)
    }
    this.queue = this.queue.filter((q) => !q.receipt)
    this.wire.releaseCards()
    if (waking) {
      this.queue = []
      this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
      return
    }
    if (this.running !== null) this.stop(this.running, true)
  }

  /** The connection ended. `expected`: this side closed it; `crash`: what is said when it ended with work in flight */
  exited(expected: boolean, crash: string): void {
    this.receipts.failAll(new Error('The session process ended before the parent note finished'))
    this.wire.connectionEnded()
    if (expected) return
    const busy = this.phase !== 'ready' || this.running !== null || this.unanswered > 0 || this.queue.length > 0 || this.blocking
    this.emit(
      busy
        ? { type: 'error', sessionId: this.sessionId, error: { code: 'adapter_crashed', message: crash, retryable: true } }
        : // Idle when it ended: the tool keeps the conversation, and the next message opens it again (#1397)
          { type: 'session_live', sessionId: this.sessionId, live: false, reason: 'asleep' },
    )
  }

  /** The inputs not written yet, let go without a word: for a message that says how many (a resume that never finished) */
  takeQueued(): number {
    return this.queue.splice(0).length
  }

  private dropQueue(when: string): void {
    const count = this.takeQueued()
    // The screen already shows them as sent: the person is told, so they can send them again
    if (count > 0) this.emit(undeliveredError(this.sessionId, count, when))
  }

  /** Said before the connection closes, while the session is still this one's (the manager drops a stale one's events) */
  async dispose(): Promise<void> {
    const opening = this.phase === 'opening'
    this.phase = 'closed'
    this.receipts.failAll(new Error('The session process ended before the parent note finished'))
    this.wire.connectionEnded()
    if (opening || this.blocking) this.dropQueue(opening ? 'were sent while it was opening' : 'were sent during compaction')
    // One sent in this tick with nothing to wait behind: a tracked one has failed and is not written; any other is, and the
    // closed connection refuses it
    this.queue = this.queue.filter((q) => !q.receipt)
    await this.wire.close()
  }

  /** A host swap: the next host resumes the conversation, but not what this one held while it opened (#428) */
  async detach(): Promise<void> {
    if (this.phase === 'opening') this.dropQueue('were sent while it was opening, as Centralu restarted,')
    await this.wire.detach()
    this.phase = 'closed'
  }
}
