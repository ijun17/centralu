import { methodsOf } from './methods-of.js'
import { mailParams } from './mail.params.js'
import { mailResults } from './mail.results.js'

/**
 * The person's side of the hub's own mailbox (docs/protocol.md §3 "mailbox"). What the person writes is theirs by the host's
 * account of who asks, never by a field of the call; a refusal is `refused` with `data.reason` (docs/protocol.md §5).
 */
export const mailMethods = methodsOf(mailParams, mailResults)
