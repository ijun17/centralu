import type { NormalizedEvent } from '@cc/protocol'
import { withStderrTail } from '../../stream-text.js'
import { INTERRUPTED_BY_TOOL, type AgentProcess, type EventSink, type InputObserver, type InputOrigin } from '../contract.js'
import { InputReceipts } from '../input-receipts.js'
import { stopNotConfirmed, undeliveredError } from '../session-kit.js'
import type { CoreIo, RunningTurn, ToolWire, TurnEnding, TurnInput } from './seam.js'
import { SessionProcess, type ToolStart } from './tool-process.js'

/**
 * The ledger (docs/plans/session-core.md §3.1, §7.2 PR 5, #1654): what every tool's session does the same way, once. The
 * session's phase, the turn that runs and the inputs it took, the queue for a tool that takes no input mid-turn, the input
 * receipts, the Stop and its confirmation timer, "interrupted by the tool", undelivered input on an exit and on the close,
 * and the exit itself: a crash in a turn or while opening, asleep when idle (#1397). It runs the session's process through
 * `SessionProcess`, and starts it again on the same conversation for a tool whose Stop ends it (`agy`). The tool's frames
 * and their meaning stay in its `ToolWire`.
 */

/** How long a Stop waits for the tool to end the turn before the person hears it has not taken effect (§2.4) */
export const STOP_CONFIRM_MS = 10_000

/** What a session is doing; the queue drains only in `ready` */
type Phase = 'opening' | 'ready' | 'closed'

/** One input: its receipt's id, the name the host gave it (`turnInputs`), and what the wire writes */
type Queued = { input: TurnInput; named: string | null }

type Turn = {
  inputs: Queued[]
  stopAsked: boolean
  /** The process the turn runs on: its exit ends the turn */
  proc: AgentProcess
  stopTimer?: ReturnType<typeof setTimeout>
}

export type CoreSessionOpts = {
  sessionId: string
  /** The conversation to go on with, or null for a new one */
  resumeExternalId: string | null
  /** Where the process comes from (`startToolProcess`): the keeper's source, or this host's spawn */
  start: Omit<ToolStart, 'sessionId'>
  /** How long a Stop may wait for the tool's end of the turn (`STOP_CONFIRM_MS`) */
  stopConfirmMs?: number
}

export class CoreSession<W extends ToolWire = ToolWire> {
  readonly ready: Promise<void>
  private phase: Phase = 'opening'
  private turn: Turn | null = null
  private readonly queue: Queued[] = []
  private readonly receipts = new InputReceipts()
  private readonly process: SessionProcess
  /** The process the session runs on now: null before its start, and once it has ended */
  private live: AgentProcess | null = null
  /** Processes this side ended or asked to end (a Stop that ends the process, a replacement): their exit is no crash */
  private readonly expectedExits = new WeakSet<AgentProcess>()
  /** A new process is being started and opened for the next input: the queue waits for it */
  private launching = false
  private lastTurnInputs: string[] = []
  private readonly stopConfirmMs: number

  constructor(
    private readonly core: CoreSessionOpts,
    protected readonly emit: EventSink,
    protected readonly wire: W,
  ) {
    this.stopConfirmMs = core.stopConfirmMs ?? STOP_CONFIRM_MS
    this.process = new SessionProcess(wire.label, wire.launch, { ...core.start, sessionId: core.sessionId, onStart: (proc) => this.watch(proc) }, core.resumeExternalId)
    this.ready = this.open()
    this.ready.catch(() => {})
  }

  get sessionId(): string {
    return this.core.sessionId
  }

  /** The conversation's id: the one resumed, opened, or said last by the process that runs now */
  get externalId(): string | null {
    return this.process.externalId
  }

  private async open(): Promise<void> {
    await this.openOn(await this.process.start())
    if (this.phase === 'opening') this.phase = 'ready'
    this.drain()
  }

  private async openOn(proc: AgentProcess): Promise<void> {
    const io = this.ioFor(proc)
    const id = this.process.externalId
    const opened = await this.wire.open(io, id === null ? null : { externalId: id })
    if (opened.externalId !== null) io.externalId(opened.externalId)
  }

  private ioFor(proc: AgentProcess): CoreIo {
    return {
      process: proc,
      gates: this.process.gates,
      emit: (e) => this.emit(e),
      inputAccepted: (id) => this.receipts.accept(id),
      externalId: (id) => this.process.noteExternalId(id, proc),
    }
  }

  /** Watched from its start, before the wire reads it: an exit or a failed start comes here once */
  private watch(proc: AgentProcess): void {
    this.live = proc
    let seen = false
    const gone = (code: number | null) => {
      if (seen) return
      seen = true
      this.exited(proc, code)
    }
    proc.once('exit', (code: number | null) => gone(code))
    proc.on('error', () => gone(null))
  }

  send(text: string, opts?: { origin?: InputOrigin; id?: string; compact?: boolean }): void {
    void this.enqueue(text, opts?.id ?? null, opts?.compact === true)
  }

  sendTracked(text: string, observer?: InputObserver): Promise<void> {
    return this.enqueue(text, null, false, observer)
  }

  private enqueue(text: string, named: string | null, compact: boolean, observer?: InputObserver): Promise<void> {
    const receipt = this.receipts.create(observer)
    if (this.phase === 'closed') {
      this.receipts.fail([receipt.id], new Error(`${this.wire.label} session is closed`))
      return receipt.done
    }
    this.queue.push({ input: { id: receipt.id, text, compact }, named })
    this.drain()
    return receipt.done
  }

  /** The names of the inputs the last turn took (`SessionHandle.turnInputs`) */
  turnInputs(): readonly string[] {
    return this.lastTurnInputs
  }

  /** The next input goes to the tool when the session is ready and, for a tool without mid-turn input, no turn runs */
  private drain(): void {
    if (this.phase !== 'ready' || this.launching || this.queue.length === 0) return
    if (this.turn && !this.wire.turns.midTurnInput) return
    if (this.needsProcess()) {
      void this.replaceProcess()
      return
    }
    const proc = this.live
    if (!proc) return
    for (let next = this.queue.shift(); next; next = this.wire.turns.midTurnInput ? this.queue.shift() : undefined) {
      const turn = this.turn ?? this.begin(next, proc)
      if (turn.inputs[0] !== next) turn.inputs.push(next)
      this.wire.startTurn(next.input, this.handleOf(turn))
    }
  }

  private begin(first: Queued, proc: AgentProcess): Turn {
    const turn: Turn = { inputs: [first], stopAsked: false, proc }
    this.turn = turn
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
    return turn
  }

  private handleOf(turn: Turn): RunningTurn {
    return {
      get stopAsked() {
        return turn.stopAsked
      },
      end: (ending, events) => this.endTurn(turn, ending, events),
    }
  }

  /** A tool whose Stop ends its process starts a new one for the next input; any other tool's gone process closed the session */
  private needsProcess(): boolean {
    if (!this.wire.turns.interruptEndsProcess) return false
    return this.live === null || this.expectedExits.has(this.live)
  }

  /** The old process ended (or is ended now), a new one starts on the same conversation, and the queue goes on in it */
  private async replaceProcess(): Promise<void> {
    this.launching = true
    try {
      const proc = this.process.current ? await this.process.relaunch() : await this.process.start()
      await this.openOn(proc)
    } catch (err) {
      if (this.phase === 'closed') return
      this.launching = false
      // The same rule as an exit while opening: the session could not go on, which is a crash, and the input waiting fails
      const failure = err instanceof Error ? err : new Error(String(err))
      this.phase = 'closed'
      this.failQueue(failure)
      this.emit({ type: 'error', sessionId: this.sessionId, error: { code: 'adapter_crashed', message: withStderrTail(`${this.wire.label} could not start again: ${failure.message}`, this.live), retryable: true } })
      return
    }
    this.launching = false
    this.drain()
  }

  interrupt(): void {
    const turn = this.turn
    if (!turn || this.phase !== 'ready') return
    turn.stopAsked = true
    this.wire.interrupt?.()
    this.wire.releaseCards()
    if (this.wire.turns.confirmsStop && !turn.stopTimer) {
      turn.stopTimer = setTimeout(() => {
        if (this.turn === turn) this.emit(stopNotConfirmed(this.sessionId, `${this.wire.label} has not confirmed the stop; the turn may still be running.`))
      }, this.stopConfirmMs)
      turn.stopTimer.unref?.()
    }
    if (this.wire.turns.interruptEndsProcess) {
      // Its exit is the Stop's confirmation (it may come at once, ending the turn), not a crash; the open gate requests are
      // denied before the signal
      this.expectedExits.add(turn.proc)
      this.process.interrupt()
    }
  }

  private endTurn(turn: Turn, ending: TurnEnding, events?: () => readonly NormalizedEvent[]): void {
    if (this.turn !== turn || this.phase === 'closed') return
    if (turn.stopTimer) clearTimeout(turn.stopTimer)
    this.wire.turnOver()
    this.wire.releaseCards()
    this.lastTurnInputs = turn.inputs.flatMap((q) => (q.named ? [q.named] : []))
    this.turn = null
    for (const e of events?.() ?? []) this.emit(e)
    const ids = turn.inputs.map((q) => q.input.id)
    const sessionId = this.sessionId
    switch (ending.how) {
      case 'complete':
        this.emit({ type: 'turn_complete', sessionId })
        this.receipts.complete(ids)
        break
      case 'interrupted':
        this.emit({ type: 'state_change', sessionId, state: 'waiting_input', reason: turn.stopAsked ? 'interrupted' : INTERRUPTED_BY_TOOL })
        // A turn our Stop ended did not finish its input, as Claude and Codex fail it: a stopped delegation is not reported done (§2.3)
        if (turn.stopAsked) this.receipts.fail(ids, new Error('The parent note was stopped before it finished'))
        else this.receipts.complete(ids)
        break
      case 'failed':
        this.emit({ type: 'error', sessionId, error: ending.error })
        if (ending.inputError) this.receipts.fail(ids, ending.inputError)
        else this.receipts.complete(ids)
    }
    this.drain()
  }

  private exited(proc: AgentProcess, code: number | null): void {
    if (this.phase === 'closed' || proc !== this.live) return
    this.live = null
    const turn = this.turn
    if (this.expectedExits.has(proc)) {
      // A Stop that ends the process (`agy`): its exit ends the turn it stopped, if the tool did not say so first
      if (turn?.proc === proc) this.endTurn(turn, { how: 'interrupted' })
      else this.drain()
      return
    }
    const wasOpen = this.phase === 'ready'
    this.phase = 'closed'
    this.wire.releaseCards()
    this.process.gates.close('The process ended.')
    this.turn = null
    if (turn?.stopTimer) clearTimeout(turn.stopTimer)
    this.dropQueue('were still queued when the agent exited')
    const failure = new Error(`${this.wire.label} exited${code === null ? '' : ` (code ${code})`}`)
    if (turn) {
      this.wire.turnOver()
      this.receipts.fail(turn.inputs.map((q) => q.input.id), failure)
    }
    if (turn || !wasOpen) {
      this.emit({ type: 'error', sessionId: this.sessionId, error: { code: 'adapter_crashed', message: withStderrTail(failure.message, proc), retryable: true } })
    } else {
      // Idle when it ended: the conversation is kept by the tool, and the next message opens it again (#1397)
      this.emit({ type: 'session_live', sessionId: this.sessionId, live: false, reason: 'asleep' })
    }
  }

  private dropQueue(when: string): void {
    const count = this.queue.length
    if (count === 0) return
    this.failQueue(new Error(`${count} message(s) ${when}`))
    this.emit(undeliveredError(this.sessionId, count, when))
  }

  private failQueue(error: Error): void {
    this.receipts.fail(this.queue.splice(0).map((q) => q.input.id), error)
  }

  async dispose(): Promise<void> {
    if (this.phase === 'closed') return
    const turn = this.turn
    this.phase = 'closed'
    this.wire.releaseCards()
    this.dropQueue('were still queued when the session closed')
    this.turn = null
    if (turn) {
      // The calls it had open end with it (#1562 review: a host stopped mid-command left the card spinning after its restart)
      this.wire.turnOver('Centralu stopped this session while the call ran')
      if (turn.stopTimer) clearTimeout(turn.stopTimer)
      this.receipts.fail(turn.inputs.map((q) => q.input.id), new Error('the session closed'))
    }
    await this.wire.close({ turnRunning: turn !== null }).catch(() => {})
    await this.process.close()
  }
}
