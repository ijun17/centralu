import type { InboxItem } from '@cc/core'
import { interruptionLabel } from '../../components/primitives.jsx'

/**
 * What a waiting list row says it waits for. Why a stopped turn stopped says more than the state it stopped in (#698),
 * and an open question is listed as an approval is (owner, 2026-10-18) but is not one: it is answered, not allowed, so
 * it reads as what the proposals read, "Needs your answer", not "Needs approval" (docs/ux-writing.md 1.12).
 */
export function inboxStateLabel(it: Pick<InboxItem, 'state' | 'proposal' | 'interruption' | 'asking'>): string {
  if (it.proposal) return 'Needs your answer'
  if (it.interruption) return interruptionLabel(it.interruption)
  if (it.state === 'waiting_approval') return it.asking ? 'Needs your answer' : 'Needs approval'
  return it.state === 'error' ? 'Error' : 'Waiting for input'
}
