import type { RequestTurnAnswer } from '../adapters/contract.js'
import type { Asker } from '../mail/asked-by.js'
import { askedAct, askedQuestion, outlivesTheTurn, stepOf, type AskedStep } from './asked-acts.js'
import { outOfReach, readScope, type Reach } from './asked-reach.js'

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
  /** What the asking session reaches itself: its folders (working folder, project folder, what it was handed back) and its project */
  reach(sessionId: string): Reach
  /** The project of a session: null for none, undefined when there is no such session */
  projectOf(sessionId: string): string | null | undefined
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
  /** What each orchestrator's turn has read that the asking session could not read itself, for the turn it was read in (§9.7) */
  private readonly reached = new Map<string, { turn: number; what: string }>()

  constructor(private readonly host: AskedGateHost) {}

  /**
   * Remembers a read of this turn that the asker could not make itself: a file outside its folders, the conversations of another project. Reading stays
   * free; the answer in the thread then asks (`askedAct`), because it could carry what was read to the session
   */
  private noteRead(orchestratorId: string, asker: Asker, name: string, args: Record<string, unknown>): void {
    const scope = readScope(name, args)
    if (scope === null || this.reached.get(orchestratorId)?.turn === asker.turn) return
    let what: string | null
    try {
      what = outOfReach(name, scope, this.host.reach(asker.sessionId), (id) => this.host.projectOf(id))
    } catch {
      what = `${name} (what the session reaches could not be told)`
    }
    if (what !== null) this.reached.set(orchestratorId, { turn: asker.turn, what })
  }

  private readIn(orchestratorId: string, asker: Asker): string | null {
    const r = this.reached.get(orchestratorId)
    return r && r.turn === asker.turn ? r.what : null
  }

  /** Whether the orchestrator's turn that is going is a session's request */
  active(orchestratorId: string): boolean {
    return this.host.askedBy(orchestratorId) !== null
  }

  /**
   * The orchestrator's CLI is about to run a step of its own (a command, a file written, a page fetched): the person is asked, unless it is a read
   * (`asked: false`), and a step that would outlive the turn is refused without a question
   */
  async askCli(orchestratorId: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<RequestTurnAnswer> {
    const asker = this.host.askedBy(orchestratorId)
    if (asker) this.noteRead(orchestratorId, asker, tool, input)
    if (!asker || askedAct(tool, input, asker.threadId) === null) return { allowed: true, asked: false }
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
    this.noteRead(orchestratorId, asker, tool, input)
    return this.put<RequestTurnAnswer>(orchestratorId, asker, stepOf(tool, input), signal, async () => ({ allowed: true, asked: true }), (message) => ({ allowed: false, message }))
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
    this.noteRead(orchestratorId, asker, call.name, call.args)
    const step = askedAct(call.name, call.args, asker.threadId, this.readIn(orchestratorId, asker))
    if (step === null) return run()
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
    if (answer === 'allow' && (now?.threadId !== asker.threadId || now.turn !== asker.turn)) {
      return refused('Nothing was done: the turn this was asked in has ended. Ask again in the thread if it is still wanted.')
    }
    if (answer === 'allow') return this.host.cover(orchestratorId, run, signal)
    if ('afterRead' in step) {
      return refused('Nothing was sent: the person did not allow this answer, which could hand the session what this turn read outside its reach. Answer without it, or leave the thread for the person.')
    }
    return refused(
      answer === null
        ? 'Nothing was done: the person did not answer the card, which asked whether to do this for the session. Say so in the thread, and leave it for the person.'
        : 'Nothing was done: the person did not allow it. Tell the session that asked, in the thread, that the person declined.',
    )
  }
}
