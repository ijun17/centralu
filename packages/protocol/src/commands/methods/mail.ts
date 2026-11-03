import { methodsOf } from './methods-of.js'
import { mailParams } from './mail.params.js'
import { mailResults } from './mail.results.js'

/**
 * The person's side of the mailbox (#1347, docs/plans/mailbox.md §10.1): the Inbox's list, a thread, the person's reply and the
 * acts that are theirs (close, release held mail, resume a paused session or thread; giving the work to another session and unblocking went with threads, docs/protocol.md §3.2). Everything the person
 * writes is theirs by the host's account of who is asking, never by a field the call names. A refusal arrives as the protocol
 * error `refused` with `data.reason` (docs/protocol.md §5).
 *
 * Only the hub's own mailbox: a linked machine's mail is the hub's (slice 4).
 */
export const mailMethods = methodsOf(mailParams, mailResults)
