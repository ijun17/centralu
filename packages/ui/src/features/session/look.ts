import { needsAnswer } from '@cc/core'
import type { Interruption, SessionState } from '@cc/protocol/client'

/**
 * The four looks a session's mark and panel wear by line and fill alone (#736, `.cc-mark`, `.cc-panel`):
 * too few borders for six states. A finished turn is `idle`, its unread said by the row's mark;
 * `stopped` needs a look, not necessarily an answer. The exact state is in the tooltip.
 */
export type SessionLook = 'idle' | 'answering' | 'stopped' | 'waiting'

export function lookOf(s: {
  state: SessionState
  /** #698: the state alone (`idle`, `waiting_input`) does not say a turn stopped */
  interruption?: Interruption | null
  openQuestions?: number
  /** Default true. An interruption marks only while unread, as the inbox lists it: Done reads it (#1549) */
  unread?: boolean
}): SessionLook {
  if (needsAnswer({ state: s.state, pendingQuestions: { length: s.openQuestions ?? 0 } })) return 'waiting'
  if (s.state === 'working') return 'answering'
  if (s.state === 'error' || s.state === 'limited' || (s.interruption && (s.unread ?? true))) return 'stopped'
  return 'idle'
}
