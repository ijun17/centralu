import type { Interruption, InterruptionReason, SessionState } from './entities.js'
import { isInTurn } from './session-state.js'

/**
 * Turn stop (docs/domain-model.md §1). Buttons: `wait` Continue now and Don't continue, which gives back the stop;
 * `stopped` Continue, plus Done when `error`; `error` only Done. Null while a turn runs, `reconnecting` included. Here, not
 * in core: the host leaves a stop the person sees out of their stop notice (`StopNotices`), by the same rule as the window.
 */
export type TurnStop =
  | { kind: 'wait'; interruption: Interruption }
  | { kind: 'stopped'; reason: Exclude<InterruptionReason, 'reconnecting'>; resetAt?: number; gaveUpAfter?: number; error: boolean }
  | { kind: 'error' }

/** A limit wait always has its time (the reset, or 30 minutes after the stop); one without is no wait */
export const waitStands = (i: Interruption | null | undefined): boolean =>
  !!i?.autoContinue && (i.reason === 'network' || (i.reason === 'limit' && i.autoContinue.at !== undefined))

export function turnStop(s: { state: SessionState; interruption?: Interruption | null }): TurnStop | null {
  if (isInTurn(s.state)) return null
  const error = s.state === 'error'
  const i = s.interruption
  if (i && i.reason !== 'reconnecting') {
    if (waitStands(i)) return { kind: 'wait', interruption: i }
    return {
      kind: 'stopped',
      reason: i.reason,
      ...(i.reason === 'limit' && i.resetAt !== undefined ? { resetAt: i.resetAt } : {}),
      ...(i.gaveUpAfter !== undefined ? { gaveUpAfter: i.gaveUpAfter } : {}),
      error,
    }
  }
  return error ? { kind: 'error' } : null
}
