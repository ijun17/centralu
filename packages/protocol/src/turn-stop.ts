import type { Interruption, InterruptionReason, SessionState } from './entities.js'
import { isInTurn, isWaiting } from './session-state.js'

/**
 * Turn stop (docs/domain-model.md §1). Buttons: `wait` Continue now and Don't continue, which gives back the stop;
 * `stopped` Continue, plus Done when `error`; `error` only Done. Null while a turn runs, `reconnecting` included. Here, not
 * in core: the host leaves a stop the Inbox lists (`inboxListing`) out of the person's stop notice (`StopNotices`).
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

/**
 * Whether the Inbox lists a session (FR-15), read state aside: `unread` lists it only while its last turn is unread.
 * A stop resting `idle` or `limited` is a finished turn that stopped short, so it is listed as one is. The Inbox
 * (`isListedWaiting`) and the host's stop notice ask this one rule.
 */
export function inboxListing(s: { state: SessionState; interruption?: Interruption | null }): 'always' | 'unread' | 'never' {
  if (s.interruption?.reason === 'reconnecting') return 'always'
  if (s.interruption && (s.state === 'idle' || s.state === 'limited')) return 'unread'
  if (s.state === 'waiting_input') return 'unread'
  return isWaiting(s.state) ? 'always' : 'never'
}
