import type { Interruption, InterruptionReason, SessionState } from '@cc/protocol/client'
import { isInTurn } from './state-machine.js'

/**
 * Why a session's last turn stopped and what the person can do about it (#698, #1415, #1549): the one answer the note
 * above the composer, its buttons and the pane's fold read, so none of them works the case out with conditions of its own
 * (docs/domain-model.md §3). Built only from what the host said: the state and the interruption with its wait and reset.
 *
 * - `wait`: Centralu continues the turn by itself once the cause clears (`autoContinue`); Continue now, Don't continue.
 * - `stopped`: the turn was cut short and nothing continues it; Continue. `resetAt`: a usage limit's reset, when the host
 *   knows it (`Interruption.resetAt`).
 * - `error`: the turn failed for a reason no continue fixes (the tool refused, a login, a crash); only Done.
 *
 * `error` on `stopped`: the session is in `error` too, so the stop also carries Done, which takes the mark off. A wait has
 * its two buttons only: Don't continue gives back the stop, with Done when the state is `error`.
 * Null while a turn runs (a `reconnecting` tool is still working) and after a turn that ended as asked.
 */
export type TurnStop =
  | { kind: 'wait'; interruption: Interruption }
  | { kind: 'stopped'; reason: Exclude<InterruptionReason, 'reconnecting'>; resetAt?: number; error: boolean }
  | { kind: 'error' }

/**
 * Whether Centralu continues the stop by itself (#1415). A limit wait always has its time (the reset said, or 30 minutes after
 * the stop); one without is no wait anything shows
 */
export const waitStands = (i: Interruption | null | undefined): boolean =>
  !!i?.autoContinue && (i.reason === 'network' || (i.reason === 'limit' && i.autoContinue.at !== undefined))

export function turnStop(s: { state: SessionState; interruption?: Interruption | null }): TurnStop | null {
  if (isInTurn(s.state)) return null
  const error = s.state === 'error'
  const i = s.interruption
  if (i && i.reason !== 'reconnecting') {
    if (waitStands(i)) return { kind: 'wait', interruption: i }
    return { kind: 'stopped', reason: i.reason, ...(i.reason === 'limit' && i.resetAt !== undefined ? { resetAt: i.resetAt } : {}), error }
  }
  return error ? { kind: 'error' } : null
}
