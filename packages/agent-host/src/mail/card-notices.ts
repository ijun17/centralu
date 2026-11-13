import type { MailboxRecords } from '../dev-services/store/mailbox.js'
import { openTaskParties } from './delegation.js'
import type { MessageService } from './messages.js'

/** A card a session raised, as its notice to a giver of its open work names it (docs/plans/mailbox.md §10.6.4); the card itself is never mail */
export type CardFact = { session: string; requestId: string; handle: string; kind: 'question' | 'approval' }

/**
 * What the sessions side asks of the mailbox about cards (`MailHooks.cards`, session ids): who hears of a card in a session (`givers`, `PERSON` for the
 * person's work) and who may answer it as its giver (`answerer`); the session's latest stored turn, which a card's handle is bound to (`turn`); `tell`
 * writes one notice; `ended` takes back the notices of its cards that no longer stand (`withdrawEndedCards`)
 */
export type CardHooks = {
  givers(sessionId: string): { givers: string[]; answerer: string | null }
  turn(sessionId: string): number
  tell(giverId: string, card: CardFact, body: string, delivered: boolean): string | null
  ended(sessionId: string): void
}

/**
 * Who hears of a card in session `address`, and who may answer it as its work's giver (mailbox.md §10.6.4): every party with work open there hears of
 * it (session ids, `PERSON` for the person's own work); a session may answer only as the one party with work open there whose the running turn is alone
 * (`alone`, `StopNotices.alone`: its message started it, and nothing else entered it), so several parties' work, or a turn the person or anyone else
 * had a part in, leaves the card to the person (docs/plans/turn-owned-by-no-one.md §3.5, floor b)
 */
export function cardGivers(records: MailboxRecords, address: string, alone: (giver: string) => boolean): { givers: string[]; answerer: string | null } {
  const givers = openTaskParties(records, address, 'to')
  const [only] = givers.length === 1 ? givers : []
  return { givers, answerer: only !== undefined && alone(only) ? only : null }
}

/** One notice of a card to `giver` (an address), keyed by the card's handle; `delivered` when a call of the giver's reads the card. Null when told before */
export function tellCard(service: MessageService, giver: string, card: CardFact, body: string, delivered: boolean): string | null {
  const written = service.notice(giver, { body, facts: { card, about: { session: card.session } }, dedupeKey: `card:${giver}:${card.session}:${card.handle}`, delivered })
  return written?.id ?? null
}

/**
 * The notices of the cards in `session` (an address; every session's when null) that no longer stand (`stands`, by the card's session address and
 * request id) and that no delivery has begun to give go, so nothing wakes for a gone card. Read from the store, so a restart, a swap or a quit that
 * took the card with it leaves none behind: the event a card ended by and the host's start both call it
 */
export function withdrawEndedCards(records: MailboxRecords, session: string | null, stands: (session: string, requestId: string) => boolean): void {
  records.transaction(() => {
    const gone = records.undeliveredNotices('$.card.session', session).filter(({ message: { facts } }) => facts.card && !stands(facts.card.session, facts.card.requestId))
    if (gone.length) records.deleteRows(gone.map(({ row }) => ({ messageId: row.messageId, recipient: row.recipient })))
  })
}
