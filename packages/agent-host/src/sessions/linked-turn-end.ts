import { isInTurn } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL } from '../adapters/contract.js'

/** A linked machine's event as far as its turn's end is read from it: the fields `LinkedEvent` carries for this */
export type LinkedTurnEvent = {
  type: string
  state?: unknown
  reason?: unknown
  error?: { message?: string }
}

/**
 * What a linked machine's event says of the turn a wait is on (#428). `busy`: a turn runs, `waits` naming the card
 * the person is to answer there; `card_closed`: that card was answered or withdrawn; `completed`: the turn completed
 * (`turn_complete`), or the session came to rest after it was seen working; `failed`: an error, a usage limit, or an
 * interruption, which ends a turn as a local agent's run ends it (`AgentRunWait`, #698); `deleted`: the session went
 * with its turn; null: nothing about the turn.
 */
export type LinkedTurnStep =
  | { step: 'busy'; waits?: 'approval' | 'question' }
  | { step: 'card_closed' }
  | { step: 'completed' }
  | { step: 'failed'; error: string }
  | { step: 'deleted' }
  | null

/**
 * The one reading of a linked machine's turn (#428), for an ask_project task there (`AskProjectFlow.observeLinkedAsk`)
 * and the orchestrator's report from there (`LinkedReports`). Both used to classify on their own and had drifted: a
 * deleted session never settled the ask, an interrupted turn settled it as finished, and only one read a question as a
 * running turn. `busy` is whether the wait has seen the turn running, so a state the machine reports before the turn
 * starts is not taken for its end.
 */
export function linkedTurnEnd(busy: boolean, e: LinkedTurnEvent): LinkedTurnStep {
  if (e.type === 'session_deleted') return { step: 'deleted' }
  if (e.type === 'approval_request') return { step: 'busy', waits: 'approval' }
  if (e.type === 'question_request') return { step: 'busy', waits: 'question' }
  if (e.type === 'approval_resolved' || e.type === 'question_resolved') return { step: 'card_closed' }
  if (e.type === 'message_delta' || e.type === 'tool_call' || (e.type === 'state_change' && isInTurn(e.state))) return { step: 'busy' }
  if (e.type === 'error') return { step: 'failed', error: e.error?.message ?? 'the session reported an error' }
  if (e.type === 'limit_reached') return { step: 'failed', error: 'the session reached its usage limit' }
  if (e.type === 'turn_complete') return { step: 'completed' }
  /*
   * Any other end of a turn counts only for a turn the wait saw running: a stop the machine reports before then ends
   * the turn that was running when the instruction went in, not the one it starts. An interrupted turn ends with no
   * `turn_complete` after it (#698)
   */
  if (e.type !== 'state_change' || !busy) return null
  if (e.state === 'waiting_input' && (e.reason === 'interrupted' || e.reason === INTERRUPTED_BY_TOOL)) {
    return { step: 'failed', error: e.reason === INTERRUPTED_BY_TOOL ? 'its tool interrupted the turn before it finished' : 'the turn was stopped before it finished' }
  }
  return { step: 'completed' }
}
