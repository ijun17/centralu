import { needsAnswer } from '@cc/core'
import type { Interruption, SessionState } from '@cc/protocol'

/**
 * The four looks a session wears (#736): the sidebar's mark and the grid's panel say what a session is
 * doing by line and fill alone (styles/index.css, `.cc-mark` and `.cc-panel`). Six states and a few
 * flags are too many to tell apart by a border, so each of them maps to one of four.
 *
 * - `idle`: nothing to do or to read. A finished turn is idle too: that it is unread is said by the row's own mark.
 * - `answering`: the agent is working. No motion, no fill.
 * - `stopped`: the turn broke off (an error, an interruption, a rate limit). It needs a look, not necessarily an answer.
 * - `waiting`: the person has to act (an approval, an open question). The strongest look.
 *
 * The exact state stays in the tooltip.
 */
export type SessionLook = 'idle' | 'answering' | 'stopped' | 'waiting'

export function lookOf(s: {
  state: SessionState
  /** A stopped turn the session rests after (#698): its state alone (`idle`, `waiting_input`) does not say so */
  interruption?: Interruption | null
  /** The number of open questions; a card is waiting on the person whatever the state says */
  openQuestions?: number
}): SessionLook {
  if (needsAnswer({ state: s.state, pendingQuestions: { length: s.openQuestions ?? 0 } })) return 'waiting'
  if (s.state === 'working') return 'answering'
  if (s.state === 'error' || s.state === 'limited' || s.interruption) return 'stopped'
  return 'idle'
}
