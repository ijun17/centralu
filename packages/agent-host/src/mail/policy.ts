import type { MessageRow, ThreadRow } from '../dev-services/store/mail.js'
import { parseAddress } from './address.js'

/**
 * The receiver's inbound policy (docs/plans/mailbox.md §7.7): what a session takes from whom. A session that runs without asking
 * (`auto`) is the one an outside text could steer furthest, so mail from another session or an app that it has no work with is
 * held: told of, never a reason to wake it, and listed in the Inbox with Release. A session under `safe` or `normal` accepts.
 *
 * | Sender class | Under `safe` / `normal` | Under `auto` |
 * |---|---|---|
 * | The person | accept | accept |
 * | Centralu | accept | accept |
 * | The thread's owner, its assignee | accept | accept |
 * | Another session or an app in the thread | accept | **hold** |
 *
 * Read when the mail is posted (§9.1's relations decide who may write at all) and again at drain (§7.5). The person's own change
 * of a receiver's policy (a setting, behind a card to loosen) is not built; these are the defaults.
 */
export function holdsInbound(message: Pick<MessageRow, 'sender'>, thread: Pick<ThreadRow, 'owner' | 'assignee'>): boolean {
  const sender = parseAddress(message.sender)
  if (sender?.kind !== 'session' && sender?.kind !== 'app') return false
  return message.sender !== thread.owner && message.sender !== thread.assignee
}
