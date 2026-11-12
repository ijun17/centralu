import type { MailAsk, MailParty } from './entities/mail.js'
import { plainLines } from './plain-line.js'

/** A question's card shows its first lines (#2229): this many, and no more than this many characters */
const ASK_LINES = 4
const ASK_CHARS = 320

/**
 * A thread's `ask` from the newest open question and the ids of all of them (oldest first): the one shape the host's list and the mock's both make, so the card's text
 * is cut in one place. Which messages are open is the host's rule (`MailPerson.asking`); the mock follows it, and `tooling/mail-mock-parity.test.ts` is what keeps it there
 */
export function mailAsk(newest: { id: string; body: string; choices?: string[] | null | undefined }, sender: MailParty, open: readonly string[]): MailAsk {
  return { id: newest.id, sender, text: plainLines(newest.body, ASK_LINES, ASK_CHARS), ...(newest.choices ? { choices: newest.choices } : {}), open: [...open] }
}
