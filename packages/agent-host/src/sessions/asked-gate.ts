import type { RequestTurnAnswer } from '../adapters/contract.js'
import type { Asker } from '../mail/asked-by.js'
import { askedAct, askedQuestion, outlivesTheTurn, stepKind, type AskedStep } from './asked-acts.js'

/**
 * The orchestrator's steps in a turn a session's request started (#1447, #1739, docs/plans/cited-requests.md §2).
 *
 * Every tool and command of the orchestrator runs through `when`, and every step of its CLI through `askCli`. In any turn that is not a request
 * they run at once, as before. In a request's turn the orchestrator judges, from the request and the person's message it may cite (checked by the
 * host at send), what to do, and these hold whatever it judges:
 *
 * - **A step that can be undone** (`stepKind` `undoable`: a project added, a session renamed, a setting changed), and work handed on to a session
 *   no looser than the asking one (`handsOn`, `noLooser`), run without the request's card. The cards such a step raises itself ask as in the
 *   person's own turn (a trust card, a project's card, a start's consent): a request's turn is never looser than the person's.
 * - **Every other step** (`asks`: a delete, an uninstall, an OS entry, a command, a file written, an app's step, work handed to a session looser
 *   than the asking one, a name no list holds) raises the person's card first, naming who asked, under every preset (`alwaysAsk`). Allow runs it, Deny
 *   does not.
 * - **A step that would outlive the turn** (a subagent, a scheduled prompt, a background command) is refused without a question.
 * - **Every step that changed something leaves a record** in the asking session (`done`), once it has run and not failed, so the person can see
 *   afterwards what a session's request had done and on which message of theirs, if any. A step of the CLI's own is recorded when the CLI says it
 *   ran (`cliDone`), not when it is allowed.
 *
 * **A turn with requests of two sessions** (`Asker.also`; the drain never makes one) fails closed: nothing can tell whose request a step is for, so
 * every step but a read asks, the answer in a request's own thread included, and the card names every asker.
 *
 * One card for one asked step. The person's Allow on the request's card is for exactly this call, so the cards it would raise itself meanwhile (a
 * delete card) are not raised a second time: they have an "always" this turn must not offer, and the answer to them is the one just given.
 */

export type AskedGateHost = {
  /** Who asked for the turn the orchestrator is in, or null when the turn is not a session's request (the person's, or one the orchestrator was given by another route) */
  askedBy(orchestratorId: string): Asker | null
  /** The person's card with the question, Allow or Deny only; not covered by a step's own Allow */
  ask(orchestratorId: string, question: string, signal?: AbortSignal): Promise<'allow' | 'deny' | null>
  /** Runs `run` while the cards the orchestrator raises are covered by the Allow just given */
  cover<T>(orchestratorId: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T>
  /**
   * Whether work handed on (`handsOn`: a session made or started, a session handed off, a message or mail to a session's turn) goes to a session
   * under no looser preset than the asking session's own, once any cap is applied. False when that preset is not known here
   */
  noLooser(asker: Asker, call: { name: string; args: Record<string, unknown> }): boolean
  /** A step that changed something was done for a session's request: its record, in the asking session (docs/plans/cited-requests.md §5) */
  done(asker: Asker, act: string): void
}

/** `AskedGate.when` as the places that call it hold it: a session's step is run when it is not a request's turn, it can be undone, or the person allows it */
export type WhenAsked = <T>(
  sessionId: string,
  /** `readOnly`: the app says the tool only reads, so it is never asked about */
  call: { name: string; args: Record<string, unknown>; readOnly?: boolean },
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  /** The refusal in the shape the step gives back: a tool's result for the orchestrator's own tools, an app tool's for an attached app's */
  refused: (text: string) => T,
) => Promise<T>

export class AskedGate {
  constructor(private readonly host: AskedGateHost) {}

  /** Whether the orchestrator's turn that is going is a session's request */
  active(orchestratorId: string): boolean {
    return this.host.askedBy(orchestratorId) !== null
  }

  /**
   * The orchestrator's CLI is about to run a step of its own (a command, a file written, a page fetched): a read is left to the CLI's own flow
   * (`asked: false`), a step that would outlive the turn is refused without a question, and every other one is put to the person. Its record is
   * `cliDone`'s, once the CLI has run it
   */
  async askCli(orchestratorId: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<RequestTurnAnswer> {
    const asker = this.host.askedBy(orchestratorId)
    if (!asker || askedAct(tool, input, threadOf(asker)) === null) return { allowed: true, asked: false }
    if (outlivesTheTurn(tool, input)) {
      return {
        allowed: false,
        message: `Nothing was done: ${tool} would go on after this turn, where the person's card for the session's request no longer applies, so a request's turn does not start it. Do the work in this turn, or tell the session to ask the person.`,
      }
    }
    const step = askedAct(tool, input, threadOf(asker))
    if (step === null) return { allowed: true, asked: false }
    return this.put<RequestTurnAnswer>(orchestratorId, asker, step, signal, async () => ({ allowed: true, asked: true }), (message) => ({ allowed: false, message }))
  }

  /** The CLI ran a step of its own that `askCli` let through as asked, and it did not fail: its record, in the asking session */
  cliDone(orchestratorId: string, tool: string, input: Record<string, unknown>): void {
    const asker = this.host.askedBy(orchestratorId)
    const step = asker ? askedAct(tool, input, threadOf(asker)) : null
    if (asker && step) this.record(asker, 'act' in step ? step.act : `run ${tool}`)
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
    const step = askedAct(call.name, call.args, threadOf(asker))
    if (step === null) return run()
    const recorded = async (): Promise<T> => {
      const done = await run()
      // A step that did nothing (refused, failed) leaves no record of having been done
      const failed = typeof done === 'object' && done !== null && (('isError' in done && done.isError === true) || ('allowed' in done && done.allowed === false))
      if (!failed) this.record(asker, 'act' in step ? step.act : `run ${call.name}`)
      return done
    }
    const kind = stepKind(call.name, call.args)
    // Not covered: the cards the step raises itself ask as they would in the person's own turn
    if (!asker.also && (kind === 'undoable' || (kind === 'handsOn' && this.host.noLooser(asker, call)))) return recorded()
    return this.put(orchestratorId, asker, step, signal, recorded, refused)
  }

  /** A step done for the turn's request is recorded in each asking session */
  private record(asker: Asker, act: string): void {
    this.host.done(asker, act)
    for (const other of asker.also ?? []) this.host.done({ ...asker, ...other, cites: null }, act)
  }

  /** Puts a step to the person and runs it on Allow; Deny, no answer and a turn that has ended run nothing */
  private async put<T>(orchestratorId: string, asker: Asker, step: AskedStep, signal: AbortSignal | undefined, run: () => Promise<T>, refused: (text: string) => T): Promise<T> {
    if ('tooLong' in step) {
      return refused('Nothing was done: this step is too long to show the person in a card whole, and a card that hid part of it would not be a fair question. Ask for it in smaller parts, or leave it for the person.')
    }
    const answer = await this.host.ask(orchestratorId, askedQuestion(asker, step.act), signal)
    // The person may answer long after the turn the card was raised in: an Allow for a request's step is for that request's turn, not a later one
    const now = this.host.askedBy(orchestratorId)
    if (answer === 'allow' && (!now || askersKey(now) !== askersKey(asker))) {
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

/** The request's thread, whose answer needs no card; none when the turn holds requests of two sessions, which fails closed */
const threadOf = (asker: Asker): string | null => (asker.also ? null : asker.messageId)

/** Who asked, in which turn: an Allow is for the turn and the askers it was asked in */
const askersKey = (asker: Asker): string => [asker.turn, asker.messageId, ...(asker.also ?? []).map((a) => a.sessionId)].join('|')
