import type { InboxItem, TurnStop } from '@cc/core'
import { interruptionLabel, stateLabel, turnStopLabel } from '../../components/primitives.jsx'

/**
 * What a waiting list row says it waits for. Why a stopped turn stopped says more than the state it stopped in (#698),
 * in the note's words (`turnStopLabel`), and an open question is listed as an approval is but is not one: it is
 * answered, not allowed, so it reads as the proposals do, "Needs your answer", not "Needs approval" (docs/ux-writing.md 1.12).
 */
export function inboxStateLabel(
  it: Pick<InboxItem, 'state' | 'proposal' | 'interruption' | 'asking'>,
  stop: TurnStop | null,
  now = Date.now(),
): string {
  if (it.proposal) return 'Needs your answer'
  if (stop) return turnStopLabel(stop, now)
  if (it.interruption) return interruptionLabel(it.interruption)
  if (it.state === 'waiting_approval') return it.asking ? 'Needs your answer' : 'Needs approval'
  return stateLabel(it.state)
}
