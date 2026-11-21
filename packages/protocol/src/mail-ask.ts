import type { MailAsk, MailParty } from './entities/mail.js'
import { plainLines } from './plain-line.js'

/** A question's card shows its first lines (#2229) */
const ASK_LINES = 4
const ASK_CHARS = 320

/**
 * Made alike by the host's list and the mock, so the card's text is cut in one place. Which messages are open is the
 * host's rule (`MailPerson.asking`), held on the mock by `tooling/mail-mock-parity.test.ts`; `open` is oldest first
 */
export function mailAsk(newest: { id: string; body: string; choices?: string[] | null | undefined }, sender: MailParty, open: readonly string[]): MailAsk {
  return { id: newest.id, sender, text: plainLines(newest.body, ASK_LINES, ASK_CHARS), ...(newest.choices ? { choices: newest.choices } : {}), open: [...open] }
}
