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
