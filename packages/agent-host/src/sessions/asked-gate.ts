import type { RequestTurnAnswer } from '../adapters/contract.js'
import type { Asker } from '../mail/asked-by.js'
import { askedAct, askedQuestion, onPersonsWord, outlivesTheTurn, postsInThread, stepOf, type AskedStep } from './asked-acts.js'

/**
 * The orchestrator's steps in a turn a session's request started (#1447, #1739, docs/plans/cited-requests.md §2).
 *
 * Every tool and command of the orchestrator runs through `when`, and every step of its CLI through `askCli`. In any turn that is not a request
 * they run at once, as before. In a request's turn:
 *
 * - **On the person's word** (the request cites their message, checked at send): reading and answering in the thread are free; the reversible
 *   steps the word covers (`onPersonsWord`) run with no card, with the cards they raise themselves covered by that word, and leave a record in the
 *   asking session; every other step that changes something raises the person's card first, naming who asked, under every preset (`alwaysAsk`).
 * - **Without it** (a request an older build stored, one moved from a v61 thread, a reminder's turn): nothing leaves the turn. Every step that
 *   changes something is refused, and so is every word to the session, in its thread too; reading, marking it handled and mail to the person
 *   are free.
 *
 * One card for one step. The person's Allow is for exactly this call, so the cards the step would raise itself meanwhile (a trust card, a delete
 * card, a start_agent consent) are not raised a second time: they have an "always" this turn must not offer, and the answer to them is the one
 * just given.
 */

export type AskedGateHost = {
  /** Who asked for the turn the orchestrator is in, or null when the turn is not a session's request (the person's, or one the orchestrator was given by another route) */
  askedBy(orchestratorId: string): Asker | null
  /** The person's card with the question, Allow or Deny only; not covered by a step's own Allow */
  ask(orchestratorId: string, question: string, signal?: AbortSignal): Promise<'allow' | 'deny' | null>
  /** Runs `run` while the cards the orchestrator raises are covered by the Allow just given, or by the person's word */
  cover<T>(orchestratorId: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T>
  /** A step was done on the person's word: its record, in the asking session (docs/plans/cited-requests.md §5) */
  onPersonsWord(asker: Asker & { cites: NonNullable<Asker['cites']> }, act: string): void
}

/** `AskedGate.when` as the places that call it hold it: a session's step is run when it is not a request's turn, the person's word covers it, or the person allows it */
export type WhenAsked = <T>(
  sessionId: string,
  /** `readOnly`: the app says the tool only reads, so it is never asked about */
  call: { name: string; args: Record<string, unknown>; readOnly?: boolean },
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  /** The refusal in the shape the step gives back: a tool's result for the orchestrator's own tools, an app tool's for an attached app's */
  refused: (text: string) => T,
) => Promise<T>

const UNCITED =
  "Nothing was done: this request cites no word of the person's, so in its turn nothing reaches the session that asked and nothing is changed for it. If it needs the person, tell them with mail send to person."

export class AskedGate {
  constructor(private readonly host: AskedGateHost) {}

  /** Whether the orchestrator's turn that is going is a session's request */
  active(orchestratorId: string): boolean {
    return this.host.askedBy(orchestratorId) !== null
  }

  /**
   * The orchestrator's CLI is about to run a step of its own (a command, a file written, a page fetched): the person is asked, unless it is a read
   * (`asked: false`); a step that would outlive the turn, and any step in a turn with no word of the person's, is refused without a question
   */
  async askCli(orchestratorId: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<RequestTurnAnswer> {
    const asker = this.host.askedBy(orchestratorId)
    if (!asker || askedAct(tool, input, asker.messageId) === null) return { allowed: true, asked: false }
    if (asker.cites === null) return { allowed: false, message: UNCITED }
    if (outlivesTheTurn(tool, input)) {
      return {
        allowed: false,
        message: `Nothing was done: ${tool} would go on after this turn, where the person's card for the session's request no longer applies, so a request's turn does not start it. Do the work in this turn, or tell the session to ask the person.`,
      }
    }
    return this.when<RequestTurnAnswer>(orchestratorId, { name: tool, args: input }, signal, async () => ({ allowed: true, asked: true }), (message) => ({ allowed: false, message }))
  }

  /**
   * The CLI itself is about to ask the person about a read of its own (a file outside its working folder, in a preset that asks): in a request's turn
   * the question is this gate's, naming the session and offering Allow or Deny only, not the CLI's plain card with its "always"
   */
  async askCliRead(orchestratorId: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<RequestTurnAnswer> {
    const asker = this.host.askedBy(orchestratorId)
    if (!asker) return { allowed: true, asked: false }
    return this.put<RequestTurnAnswer>(orchestratorId, asker, stepOf(tool, input), signal, async () => ({ allowed: true, asked: true }), (message) => ({ allowed: false, message }))
  }

  async when<T>(
    orchestratorId: string,
    call: { name: string; args: Record<string, unknown>; readOnly?: boolean },
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
    refused: (text: string) => T,
  ): Promise<T> {
    const asker = this.host.askedBy(orchestratorId)
    if (!asker || call.readOnly === true) return run()
    const step = askedAct(call.name, call.args, asker.messageId)
    if (asker.cites === null) return step === null && !postsInThread(call.name, call.args) ? run() : refused(UNCITED)
    if (step === null) return run()
    if (onPersonsWord(call.name)) {
      const cites = asker.cites
      const done = await this.host.cover(orchestratorId, run, signal)
      // A step that did nothing (refused, failed) leaves no record of having been done
      const failed = typeof done === 'object' && done !== null && 'isError' in done && done.isError === true
      if (!failed) this.host.onPersonsWord({ ...asker, cites }, 'act' in step ? step.act : `run ${call.name}`)
      return done
    }
    return this.put(orchestratorId, asker, step, signal, run, refused)
  }

  /** Puts a step to the person and runs it on Allow; Deny, no answer and a turn that has ended run nothing */
  private async put<T>(orchestratorId: string, asker: Asker, step: AskedStep, signal: AbortSignal | undefined, run: () => Promise<T>, refused: (text: string) => T): Promise<T> {
    if ('tooLong' in step) {
      return refused('Nothing was done: this step is too long to show the person in a card whole, and a card that hid part of it would not be a fair question. Ask for it in smaller parts, or leave it for the person.')
    }
    const answer = await this.host.ask(orchestratorId, askedQuestion(asker, step.act), signal)
    // The person may answer long after the turn the card was raised in: an Allow for a request's step is for that request's turn, not a later one
    const now = this.host.askedBy(orchestratorId)
    if (answer === 'allow' && (now?.messageId !== asker.messageId || now.turn !== asker.turn)) {
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
