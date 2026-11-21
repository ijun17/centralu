import { STOP_NOT_CONFIRMED_LABEL, type NormalizedEvent } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL } from '../adapters/contract.js'

/**
 * An agent an app has assigned (M4 D-1): what gets sent to the session, and what is read as its answer once it finishes.
 * Standing the session up and waiting for it is the manager's job (`AppSessions.runAppAgent`); the frame around the text is
 * `appMessageFrame` (`app-messages.ts`); the rule for picking the final answer out of the record is `turnAnswer`
 * (turn-answer.ts). Only the wait for the turn's outcome lives here.
 */

/**
 * One session an app is waiting on for an answer (M4 D-1): decides the outcome of its turn from that session's events.
 * `turn_complete` is the answer (with structured output, if any), except the end of a turn the person stopped, which is
 * returned as stopped; `error` fails the turn (a tool dying included); `limit_reached` will not resolve however long we wait;
 * `approval` and `question` wait on the person, and the app is told so in one line (not that the app itself has stalled).
 * `usage_update` (D-5) passes through whatever the outcome: Claude carries the session's running total right before the turn's
 * outcome (the `result`'s modelUsage, summed across every model), Codex the thread's; each assignment is a fresh session, so
 * the last value is exactly this assignment's share. Once the outcome is decided, later events are ignored (except for tokens).
 */
export class AgentRunWait {
  /** The person stopped that session's turn (`TurnInputs.interrupt`) */
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

  get finished(): boolean { return this.settled }

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
     * The input recorded is all of the input the model read, cache reads and cache writes included (TokenUsage's three fields
     * do not overlap): what counts is how much of the person's agent the app used, and an agent re-reads its whole context on
     * every call, so without the cache a run that read 25k looked like it read only 1k. Codex ends up with the same sum (cached
     * input is already in its reported input).
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
    switch (e.type) {
      case 'turn_complete':
        if (this.stoppedByPerson) return this.fail(new Error('the person stopped the agent before it finished'))
        return this.finish({ ...(e.output === undefined ? {} : { output: e.output }), ...(this.readAnswer ? { answer: this.readAnswer() } : {}) })
      case 'error':
        return this.fail(new Error(this.stoppedByPerson ? 'the person stopped the agent before it finished' : `the agent's turn failed: ${e.error.message}`))
      case 'limit_reached':
        return this.fail(new Error(`the agent reached its usage limit${e.resumeAt ? ` (it resets at ${e.resumeAt})` : ''}`))
      /*
       * An interrupted turn ends here (#698) as a Stop does, with no `turn_complete` after it, so waiting for one would wait
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
