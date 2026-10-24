import type { Asker } from '../mail/asked-by.js'
import { askedAct, askedQuestion } from './asked-acts.js'

/**
 * The orchestrator's privileged steps, asked about when a session asked for them (docs/plans/mailbox.md §9.7, #1447).
 *
 * Every tool and command of the orchestrator runs through `when`. In a turn that a session's request started, a step that changes
 * something (`askedAct`) raises the person's card first, naming who asked, under every preset (`alwaysAsk`: `auto` does not answer it). Allow
 * runs the step, and Deny does not. In any other turn it runs at once, as before.
 *
 * One card for one step. The person's Allow is for exactly this call, so the cards the step would raise itself meanwhile (a
 * trust card, a delete card, a start_agent consent) are not raised a second time: they have an "always" this turn must not offer, and
 * the answer to them is the one just given.
 */


export type AskedGateHost = {
  /** Who asked for the turn the orchestrator is in, or null when the turn is not a session's request (the person's, or one the orchestrator was given by another route) */
  askedBy(orchestratorId: string): Asker | null
  /** The person's card with the question, Allow or Deny only; not covered by a step's own Allow */
  ask(orchestratorId: string, question: string, signal?: AbortSignal): Promise<'allow' | 'deny' | null>
  /** Runs `run` while the cards the orchestrator raises are covered by the Allow just given */
  cover<T>(orchestratorId: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

/**
 * `T` is what the step gives back: a tool's result for the orchestrator's own tools, an app tool's for an attached app's. `refused` makes the
 * refusal in that shape
 */
/** `AskedGate.when` as the places that call it hold it: a session's step is run when it is not a request's turn, or the person allows it */
export type WhenAsked = <T>(
  sessionId: string,
  call: { name: string; args: Record<string, unknown> },
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  refused: (text: string) => T,
) => Promise<T>

export class AskedGate {
  constructor(private readonly host: AskedGateHost) {}

  /** Whether the orchestrator's turn that is going is a session's request */
  active(orchestratorId: string): boolean {
    return this.host.askedBy(orchestratorId) !== null
  }

  /** The orchestrator's CLI wants to run a step of its own (a command, a file written, a page fetched): the person is asked, or it is a read */
  async askCli(orchestratorId: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ allowed: true } | { allowed: false; message: string }> {
    const answer = await this.when<{ allowed: true } | { allowed: false; message: string }>(
      orchestratorId,
      { name: tool, args: input },
      signal,
      async () => ({ allowed: true }),
      (message) => ({ allowed: false, message }),
    )
    return answer
  }

  async when<T>(
    orchestratorId: string,
    call: { name: string; args: Record<string, unknown> },
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
    refused: (text: string) => T,
  ): Promise<T> {
    const asker = this.host.askedBy(orchestratorId)
    if (!asker) return run()
    const step = askedAct(call.name, call.args, asker.threadId)
    if (step === null) return run()
    if ('tooLong' in step) {
      return refused('Nothing was done: this step is too long to show the person in a card whole, and a card that hid part of it would not be a fair question. Ask for it in smaller parts, or leave it for the person.')
    }
    const answer = await this.host.ask(orchestratorId, askedQuestion(asker, step.act), signal)
    // The person may answer long after the turn the card was raised in: an Allow for a request's step is for that request's turn, not a later one
    if (answer === 'allow' && this.host.askedBy(orchestratorId)?.threadId !== asker.threadId) {
      return refused('Nothing was done: the turn this was asked in has ended. Ask again in the thread if it is still wanted.')
    }
    if (answer === 'allow') return this.host.cover(orchestratorId, run, signal)
    return refused(
      answer === null
        ? 'Nothing was done: the person did not answer the card, which asked whether to do this for the session. Say so in the thread, and leave it for the person.'
        : 'Nothing was done: the person did not allow it. Tell the session that asked, in the thread, that the person declined.',
    )
  }
}
