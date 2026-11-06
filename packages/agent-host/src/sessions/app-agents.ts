import { STOP_NOT_CONFIRMED_LABEL, type NormalizedEvent } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL } from '../adapters/contract.js'

/**
 * An agent an app has assigned (M4 D-1) — what gets sent to the session, and what gets read as
 * its answer once the session finishes.
 *
 * Standing the session up and waiting for it is the manager's job (`AppSessions.runAppAgent`).
 * The frame around the text it sends is the same one used for in-conversation UI messages
 * (`app-messages.ts`'s `appMessageFrame`). What lives here is only what comes after: waiting for the
 * turn's outcome; the rule for picking the final answer out of the record is `turnAnswer` (turn-answer.ts).
 */

/**
 * One session an app is waiting on for an answer (M4 D-1) — decides the outcome of its turn by
 * watching that session's events.
 *
 *   turn_complete       the answer landed (with structured output, if there is any). The end of a
 *                       turn the person stopped is not an answer, though — it is returned as stopped
 *   error               the turn failed (including a tool dying)
 *   limit_reached       a usage limit — this turn will not resolve no matter how long we wait
 *   approval, question  waiting on the person — the app is told in one line (that it is waiting
 *                       on the person, not that the app itself has stalled)
 *   usage_update        tokens spent (D-5) — passed through regardless of the outcome. Claude
 *                       carries the session's running total right before the turn's outcome (the
 *                       `result`'s modelUsage, summed across every model), while Codex carries the
 *                       thread's running total. Since each assignment is a fresh session, the last
 *                       value is exactly this assignment's share.
 *
 * Once the outcome is decided, later events are ignored (except for tokens).
 */
export class AgentRunWait {
  /** The person stopped that session's turn (`SessionManager.interrupt`) */
  stoppedByPerson = false
  /** The person deleted that session — there is no session left to conclude */
  deleted = false
  /**
   * How the person took part in this turn, if they did (#378): a card was shown to them, or they opened the session or
   * wrote to it. An app's agent session they took part in has become theirs, and stays when its run ends.
   */
  personTookPart: 'card' | 'opened' | 'wrote' | null = null
  readonly done: Promise<{ output?: unknown; answer?: string }>
  private settle!: { resolve: (v: { output?: unknown; answer?: string }) => void; reject: (e: Error) => void }
  private settled = false
  private inputs = 0
  private trackedInputs = false
  private ending?: { output?: unknown; answer?: string }

  get waitingForInputs(): boolean { return this.inputs > 0 }
  get finished(): boolean { return this.settled }
  get tracksInputs(): boolean { return this.trackedInputs }
  get completedAnswer(): string | undefined { return this.ending?.answer }

  /** A parent's note may join this turn or run after it. Hold before send, since adapters can emit synchronously. */
  holdInput(): () => void {
    this.trackedInputs = true
    this.inputs++
    let released = false
    return () => {
      if (released) return
      released = true
      this.inputs--
      if (!this.inputs && this.ending) this.finish(this.ending)
    }
  }

  constructor(
    private notify: (message: string) => void,
    private sessionName: () => string,
    private onUsage: (tokens: { input: number; output: number }) => void = () => {},
    private readAnswer?: () => string,
  ) {
    this.done = new Promise((resolve, reject) => (this.settle = { resolve, reject }))
    // So a failure before anyone is waiting does not leak as an unhandled rejection
    this.done.catch(() => {})
  }

  onEvent(e: NormalizedEvent): void {
    /*
     * The input recorded here is **all** of the input the model read — including what it read
     * from cache and what it wrote to cache (TokenUsage's three fields do not overlap). What is
     * recorded here is how much of the person's agent the app used, and an agent re-reads its
     * whole context on every call — without the cache, a run that read 25k looked like it read
     * only 1k. Codex ends up with the same sum (cached input is already counted inside its
     * reported input).
     */
    if (e.type === 'usage_update') {
      const t = e.tokens
      return this.onUsage({ input: t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens, output: t.outputTokens })
    }
    if (this.settled) return
    /*
     * The person's Stop did not take effect (#1060): the tool refused it or did not confirm it, and the turn runs on.
     * Whatever it ends with is its own ending then, not the person's stop; a finished answer reaches the one waiting.
     */
    if (e.type === 'notice' && e.label === STOP_NOT_CONFIRMED_LABEL) {
      this.stoppedByPerson = false
      return
    }
    if (e.type === 'message_delta' || (e.type === 'state_change' && e.state === 'working')) this.ending = undefined
    switch (e.type) {
      case 'turn_complete':
        if (this.stoppedByPerson) return this.fail(new Error('the person stopped the agent before it finished'))
        this.ending = { ...(e.output === undefined ? {} : { output: e.output }), ...(this.readAnswer ? { answer: this.readAnswer() } : {}) }
        if (this.inputs) return
        return this.finish(this.ending)
      case 'error':
        return this.fail(new Error(this.stoppedByPerson ? 'the person stopped the agent before it finished' : `the agent's turn failed: ${e.error.message}`))
      case 'limit_reached':
        return this.fail(new Error(`the agent reached its usage limit${e.resumeAt ? ` (it resets at ${e.resumeAt})` : ''}`))
      /*
       * An interrupted turn ends here (#698). Codex's interrupted turn used to arrive as `turn_complete` and was read as
       * a finished one; it now ends as a Stop does, with no `turn_complete` after it, so waiting for one would wait
       * for ever. A Stop of the person's still says so (`fail`).
       */
      case 'state_change':
        if (e.state !== 'waiting_input' || (e.reason !== 'interrupted' && e.reason !== INTERRUPTED_BY_TOOL)) return
        return this.fail(new Error(e.reason === INTERRUPTED_BY_TOOL ? 'its tool interrupted the turn before it finished' : 'the turn was stopped before it finished'))
      case 'approval_request':
        this.personTookPart ??= 'card'
        return this.notify(`waiting for the person to approve a step in "${this.sessionName()}"`)
      case 'question_request':
        this.personTookPart ??= 'card'
        return this.notify(`waiting for the person to answer a question in "${this.sessionName()}"`)
    }
  }

  fail(err: Error): void {
    if (this.settled) return
    this.settled = true
    this.settle.reject(this.stoppedByPerson ? new Error('the person stopped the agent before it finished') : err)
  }

  private finish(ending: { output?: unknown; answer?: string }): void {
    if (this.settled) return
    this.settled = true
    this.settle.resolve(ending)
  }
}
