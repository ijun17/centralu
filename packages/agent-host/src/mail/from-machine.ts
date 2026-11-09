import { errorMessage, oneLineText, type HubMailParams, type HubMailResult } from '@cc/protocol'
import type { MessageService } from './messages.js'
import { refusalReason } from './rules.js'

/**
 * A message from a session this hub started on a linked machine to the session that started it (#2067 item 1, `hub.mail`;
 * docs/plans/linked-mail.md §3). The machine names only its own session: the child is that id qualified by the machine
 * the call came in on, and the parent is the one this hub recorded when it started the child, never anything the call
 * says. The message is written here, by the one send every message of this host takes (its checks and guards), from the
 * child's address to the parent's. A refusal is answered with its reason and words, and nothing is written.
 */
export function mailFromMachine(o: {
  service: Pick<MessageService, 'send' | 'sessionAddress' | 'labelOf'>
  /**
   * The session here that started a child on a linked machine, from this hub's own record (`LinkedHost.remoteAgentParent`),
   * by the child's qualified id (`<machine id>.<session id>`; a machine id has no dot, so the machine is the link's)
   */
  parentOf: (qualifiedId: string) => string | undefined
  /** This computer's name, as the machine's session reads it */
  selfName: () => string
}): (machine: { id: string; name: string }, p: HubMailParams) => HubMailResult {
  return (machine, p) => {
    const qualified = `${machine.id}.${p.sessionId}`
    const parentId = o.parentOf(qualified)
    // Another hub may have started it: the machine asks the next one
    if (!parentId) return { ok: false, why: 'not_yours', text: `${o.selfName()} did not start this session.` }
    const parent = o.service.sessionAddress(parentId)
    try {
      const sent = o.service.send(o.service.sessionAddress(qualified), {
        to: [parent],
        text: p.text,
        // Always a note, whatever the machine asks (#2067 item 1; docs/plans/linked-mail.md §3 step 3): no reply and no
        // "no longer watched" notice reaches the child on its machine before item 2, and a watched message would leave
        // that notice undelivered here for good and promise the parent reminders for a reply it cannot send. A note is
        // never released or reminded (`releasedUntold` reads needsReply rows only)
        needsReply: false,
        ...(p.urgent ? { urgent: true } : {}),
      })
      return { ok: true, messageId: sent.message.id, to: oneLineText(o.service.labelOf(parent), 120) }
    } catch (e) {
      // A refusal is the hub's answer; anything else is a fault, said as one and never as a refusal the sender could act on
      const why = refusalReason(e)
      const text = why ? errorMessage(e) : `${o.selfName()} could not take the message: ${oneLineText(errorMessage(e), 500)}`
      return { ok: false, why: why ?? 'failed', text: text.slice(0, 4000) }
    }
  }
}
