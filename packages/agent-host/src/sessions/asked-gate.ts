import type { ToolOutput } from '../apps/contract.js'
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
  cover(orchestratorId: string, run: () => Promise<ToolOutput>): Promise<ToolOutput>
}

export class AskedGate {
  constructor(private readonly host: AskedGateHost) {}

  async when(orchestratorId: string, call: { name: string; args: Record<string, unknown> }, signal: AbortSignal | undefined, run: () => Promise<ToolOutput>): Promise<ToolOutput> {
    const asker = this.host.askedBy(orchestratorId)
    if (!asker) return run()
    const act = askedAct(call.name, call.args, asker.threadId)
    if (act === null) return run()
    const answer = await this.host.ask(orchestratorId, askedQuestion(asker, act), signal)
    if (answer === 'allow') return this.host.cover(orchestratorId, run)
    return {
      text:
        answer === null
          ? 'Nothing was done: the person did not answer the card, which asked whether to do this for the session. Say so in the thread, and leave it for the person.'
          : 'Nothing was done: the person did not allow it. Tell the session that asked, in the thread, that the person declined.',
      isError: true,
    }
  }
}
