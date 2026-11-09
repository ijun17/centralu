/**
 * The host's mail over a real manager, wired the one way `main.ts` wires it (docs/plans/mailbox.md §16 M3a): `hostMail` on the manager's own
 * answers, and `useMail` with its hooks. Plus readers of the message tables the session tests assert on.
 */
import type { Store } from '../dev-services/store.js'
import type { MailRow, RecipientRow } from '../dev-services/store/mailbox.js'
import { sessionAddress } from '../mail/address.js'
import type { MailDeliveryOptions } from '../mail/delivery.js'
import { hostMail, mailSessionsOf, type HostMail } from '../mail/host-mail.js'
import type { SessionManager } from './manager.js'
import type { MailHooks } from './mail-sessions.js'

export const MAIL_HOST = 'hub-aaaaaaaa'
/** A session's mail address on the test host */
export const addressOf = (sessionId: string): string => sessionAddress(MAIL_HOST, sessionId)

/**
 * The host's mail for `mgr` over `store`, its hooks in the manager. Delivery is not started (`m.delivery.start()` or `m.afterReady()` does), and
 * its timers run only when the test schedules them (`delivery.schedule`, default: never)
 */
export function wireHostMail(
  mgr: SessionManager,
  store: Store,
  opts: { now?: () => number; delivery?: MailDeliveryOptions; assistantHasMailCommand?: () => boolean; hooks?: Partial<MailHooks>; hostId?: string } = {},
): HostMail {
  const m = hostMail(store, mailSessionsOf(mgr, opts.assistantHasMailCommand ?? (() => true)), {
    // Two linked hosts each have their own (`hubSelfId`), as main.ts gives it
    hostId: opts.hostId ?? MAIL_HOST,
    ...(opts.now ? { now: opts.now } : {}),
    delivery: { schedule: () => () => {}, ...opts.delivery },
  })
  mgr.mail.useMail({ ...m.hooks, ...opts.hooks })
  return m
}

/** Readers of the message tables, for assertions */
export function mailReader(store: Store) {
  const box = store.mailbox
  const row = (messageId: string, recipient: string): RecipientRow | undefined => box.recipient(messageId, recipient)
  /** Every message sent by `sender` with a row for `recipient`, oldest first */
  const between = (sender: string, recipient: string, kind?: MailRow['kind']): MailRow[] =>
    box
      .feedOf(recipient, { limit: 500 })
      .filter((m) => m.sender === sender && (kind === undefined || m.kind === kind) && box.recipient(m.id, recipient) !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return {
    row,
    message: (id: string) => box.message(id),
    /** The tasks `owner` gave `child` (session ids), oldest first */
    tasks: (ownerAddress: string, childId: string): MailRow[] => between(ownerAddress, addressOf(childId), 'task'),
    /** Centralu's reports on a task, oldest first */
    reportsOn: (taskId: string): MailRow[] => box.reportsOn(taskId),
    /** The task row of `childId` on task `taskId` */
    taskRow: (taskId: string, childId: string) => row(taskId, addressOf(childId)),
    between,
    /** Every row addressed to `recipient` with its message */
    to: (recipient: string): { message: MailRow; row: RecipientRow }[] =>
      box.feedOf(recipient, { limit: 500 }).flatMap((m) => {
        const r = box.recipient(m.id, recipient)
        return r ? [{ message: m, row: r }] : []
      }),
  }
}
