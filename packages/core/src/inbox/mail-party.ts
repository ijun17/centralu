import type { MailParty } from '@cc/protocol/client'

/** A party as the screen names it: the person is "You", a session or an app by its name, one that is gone by what it was */
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

/** The live states a party's dot is drawn for in the Inbox (#2258, owner 2026-11-14): what says something. Idle, and any other word, draws nothing */
const DOTTED = ['working', 'error', 'waiting_approval'] as const
export type PartyLive = (typeof DOTTED)[number]

/**
 * The state a party's dot shows beside its name: `live`, the window's own copy of the session when it has one (fresher than the list the host
 * sent), else the state the host named in the list. Null when nothing is drawn
 */
export function partyLive(p: Pick<MailParty, 'state'>, live?: string | null): PartyLive | null {
  const state = live ?? p.state
  return DOTTED.find((s) => s === state) ?? null
}
