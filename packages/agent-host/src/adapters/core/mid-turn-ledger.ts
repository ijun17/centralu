import type { NormalizedEvent } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL, type EventSink, type InputObserver } from '../contract.js'
import { InputReceipts, isUuid, type InputReceipt } from '../input-receipts.js'
import { stopNotConfirmed, undeliveredError } from '../session-kit.js'
import type { MidTurnInput, MidTurnWire, ToolTurnEnding } from './seam.js'

/**
 * The ledger for a tool that takes input mid-turn (docs/plans/session-core.md §4.2, §4.3, #1654): Codex and Claude. The tool merges an input into the turn it runs or starts a turn for it, and names its turns, so the inputs are bound
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

/** A Stop of the running turn waiting to be confirmed: `late` once its bound was said, `asks` the interrupts not answered yet */
type StopWait = { bound: ReturnType<typeof setTimeout> | undefined; late: boolean; asks: number }

/** What a tracked input fails with when the process ends under it, unless the wire says otherwise (`MidTurnWire.exitWords`) */
const PROCESS_ENDED = 'The session process ended before the parent note finished'

export class MidTurnLedger {
  readonly ready: Promise<void>
  private phase: 'opening' | 'ready' | 'closed'
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
  /** The Stop of the running turn the tool has not confirmed yet, under a bound (`MidTurnWire.stop`) */
  private stopWait: StopWait | null = null

  constructor(
    private readonly sessionId: string,
    private readonly emit: EventSink,
    private readonly wire: MidTurnWire,
  ) {
    // A wire with no `open` writes its own inputs, on a conversation that exists from the start (Claude: the SDK's input stream)
    this.phase = wire.open ? 'opening' : 'ready'
    this.ready = (wire.open?.() ?? Promise.resolve()).then(() => {
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
    const receipt = this.track(observer, id)
    this.enqueue({ text, receipt })
    return receipt.done
  }

  /** A receipt for an input the wire writes itself (Claude); `id` as for `sendTracked`. `accept`: the tool took it */
  track(observer?: InputObserver, id?: string): InputReceipt {
    return this.receipts.create(observer, id !== undefined && isUuid(id) ? id : undefined)
  }
  accept(id: string): void { this.receipts.accept(id) }
  /** How many tracked inputs wait for their end */
  get tracking(): number { return this.receipts.size }

  /** Every tracked input fails, and nothing is stopped (the turn already failed): the ids that did */
  failTracked(reason: Error): string[] {
    const ids = this.receipts.ids
    this.receipts.failAll(reason)
    return ids
  }

  /** A turn runs: one the tool started, or one an input of ours started */
  get turnRunning(): boolean { return this.running !== null }

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
    let written: ReturnType<NonNullable<MidTurnWire['write']>>
    try {
      if (!this.wire.write) throw new Error(`${this.wire.label} writes its own inputs`)
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
    this.emit({ type: 'error', sessionId: this.sessionId, error: this.wire.refusal?.(err) ?? { code: 'internal', message: err.message, retryable: true } })
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
        if (!this.ended.includes(id)) this.stop(id, false, true)
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
    this.endStopWait()
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

  /** A turn's end in the tool's own events (Claude's result): the turn closes, they go out with `took` read meanwhile, a Stop is confirmed */
  endSaid(events: readonly NormalizedEvent[], completes: readonly string[] | undefined, took: readonly string[] | null): void {
    this.turnEnded(null, null)
    this.ending = took
    try {
      this.said(events, completes)
    } finally {
      this.ending = null
      this.confirmStop()
    }
  }

  /** The inputs of the turn whose end is being said (`endSaid`), for the host to read as it handles it; null otherwise */
  get endingInputs(): readonly string[] | null { return this.ending }
  private ending: readonly string[] | null = null

  /**
   * Events the tool says itself, in order (Claude's normalizer's: a turn's end among the goal's events and closed cards). `completes`
   * complete after their `turn_complete`; a failure or a limit among them is how the turn ended, and a waiting Stop is let go
   */
  said(events: readonly NormalizedEvent[], completes?: readonly string[]): void {
    for (const e of events) {
      this.emit(e)
      // Before a later turn's frames can overwrite the host's answer
      if (e.type === 'turn_complete' && completes) this.receipts.complete(completes)
      if (e.type === 'error' || e.type === 'limit_reached') this.endStopWait()
    }
  }

  /** Our Stop was sent to this turn (#698) */
  stopSent(turnId: string): boolean {
    return this.stopped.includes(turnId)
  }

  /** The tool reported an error: the tracked inputs still waiting fail with it, as on a Stop */
  failed(reason: Error): void {
    if (this.receipts.size > 0) this.interrupt(reason)
  }

  private stop(turnId: string, running: boolean, tracked: boolean): void {
    if (!this.stopped.includes(turnId)) keep(this.stopped, turnId)
    const wait = running ? this.awaitStop() : null
    if (wait) wait.asks++
    void this.wire.interrupt(turnId, tracked).then(
      () => {
        if (wait) this.confirmStop(wait)
      },
      (err: Error) => {
        if (!running) return
        if (wait) {
          wait.asks--
          // Confirmed already, closed, or another Stop's interrupt may still land
          if (this.stopWait !== wait || this.closed || wait.asks > 0) return
          this.endStopWait()
          this.wire.stopRefused?.()
          if (wait.late) return
        }
        // As a notice (#1060): the turn is still running, and an error would end it for the host
        this.emit(stopNotConfirmed(this.sessionId, `Could not stop: ${err.message}. The turn is still running.`))
      },
    )
  }

  /**
   * Waits for the tool to confirm a Stop under the wire's bound (none: no wait). A second Stop joins the wait (one bound, one
   * confirmation); one after the bound was said starts it again on the same wait, which an answer to the first still confirms
   */
  private awaitStop(): StopWait | null {
    const bound = this.wire.stop
    if (!bound) return null
    const current = this.stopWait
    if (current && !current.late) return current
    const wait: StopWait = current ?? { late: false, asks: 0, bound: undefined }
    wait.late = false
    wait.bound = setTimeout(() => {
      wait.late = true
      if (!this.closed) this.emit(stopNotConfirmed(this.sessionId, bound.notice(Math.round(bound.ms / 1000))))
    }, bound.ms)
    wait.bound.unref?.()
    this.stopWait = wait
    return wait
  }

  /** The turn ended otherwise (its end said, a failure, a limit): a Stop still waiting is let go without a word */
  private endStopWait(): void {
    if (this.stopWait) clearTimeout(this.stopWait.bound)
    this.stopWait = null
  }

  /** The tool confirmed the Stop (the interrupt's answer, or the stopped turn's end the tool said itself): said stopped once */
  private confirmStop(wait = this.stopWait): void {
    if (!wait || this.stopWait !== wait) return
    this.endStopWait()
    if (!this.closed) this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
  }

  /**
   * Every tracked input fails now, and the turns they were bound to are stopped. Before the conversation exists, what was sent
   * meanwhile is dropped and no turn will come to say it stopped, so the stop is said here (#168). Once it exists, a turn may
   * run in it (an adopted one, still being looked up): what waits goes once it opens, as any message sent then
   */
  interrupt(reason = new Error('The parent note was stopped before it finished'), tracked = this.receipts.size > 0): void {
    const waking = this.phase === 'opening' && !this.wire.hasConversation?.() && this.queue.length > 0
    for (const turn of this.receipts.failAll(reason)) {
      if (turn !== this.running && !this.ended.includes(turn)) this.stop(turn, false, tracked)
    }
    this.queue = this.queue.filter((q) => !q.receipt)
    this.wire.releaseCards(tracked)
    if (waking) {
      this.queue = []
      this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
      return
    }
    if (this.running !== null) this.stop(this.running, true, tracked)
  }

  /**
   * The person's Stop. With no turn running and none that can start, no end will come to say it, so it is said here, as Claude
   * says it with no turn open (#1829): a turn whose end was lost, or an adopted one with no id, otherwise read as running for good
   */
  stopByPerson(): void {
    const tracked = this.receipts.size > 0
    this.interrupt(undefined, tracked)
    if (this.phase === 'ready' && this.running === null && this.unanswered === 0 && this.queue.length === 0) {
      this.wire.idleStop?.(tracked)
      this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
    }
  }

  /** The connection ended. `expected`: this side closed it; `crash`: what is said when it ended with work in flight */
  exited(expected: boolean, crash: string): void {
    // Read before the receipts fail and the connection's work ends with it
    const held = !expected && !!this.wire.inFlight?.()
    this.receipts.failAll(new Error(this.wire.exitWords ?? PROCESS_ENDED))
    this.wire.connectionEnded()
    if (expected) return
    const busy = held || this.phase !== 'ready' || this.running !== null || this.unanswered > 0 || this.queue.length > 0 || this.blocking
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

  /** The session is closed and says nothing more; `why`: what the tracked inputs still waiting fail with */
  close(why?: Error): void {
    this.phase = 'closed'
    if (why) this.receipts.failAll(why)
  }

  /** Said before the connection closes, while the session is still this one's (the manager drops a stale one's events) */
  async dispose(): Promise<void> {
    const opening = this.phase === 'opening'
    this.close(new Error(PROCESS_ENDED))
    this.wire.connectionEnded()
    if (opening || this.blocking) this.dropQueue(opening ? 'were sent while it was opening' : 'were sent during compaction')
    // One sent in this tick with nothing to wait behind: a tracked one has failed and is not written; any other is, and the
    // closed connection refuses it
    this.queue = this.queue.filter((q) => !q.receipt)
    await this.wire.close?.()
  }

  /** A host swap: the next host resumes the conversation, but not what this one held while it opened (#428) */
  async detach(): Promise<void> {
    if (this.phase === 'opening') this.dropQueue('were sent while it was opening, as Centralu restarted,')
    await this.wire.detach?.()
    this.phase = 'closed'
  }
}
