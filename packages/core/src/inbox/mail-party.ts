import type { MailParty } from '@cc/protocol/client'

export function partyName(p: MailParty): string {
  switch (p.kind) {
    case 'person':
      return 'You'
    case 'centralu':
      return 'Centralu'
    case 'session':
      return p.name ?? 'A session that is gone'
    case 'app':
      return p.name ?? 'An app'
    default:
      return p.name ?? p.address
  }
}

/** The states a party's dot is drawn for (#2258); idle and any other word draw nothing */
const DOTTED = ['working', 'error', 'waiting_approval'] as const
export type PartyLive = (typeof DOTTED)[number]

/** `live` is the window's own copy of the session, fresher than the host's list */
export function partyLive(p: Pick<MailParty, 'state'>, live?: string | null): PartyLive | null {
  const state = live ?? p.state
  return DOTTED.find((s) => s === state) ?? null
}
