import { z } from 'zod'

/**
 * The mailbox on the wire (#1347, docs/plans/mailbox.md §10.1): what the Inbox shows of the threads that are tasks and of the
 * messages in them. The host owns every field; the screen draws them and decides nothing.
 *
 * States, kinds and outcomes are plain strings: a newer host may write a word this build does not know, and it must reach the
 * screen (as a word it does not style) rather than fail the parse (docs/protocol.md §4).
 */

/** Who a message is from, or a thread's owner or assignee: Centralu's name for the party, never a name the party gave itself */
export const MailParty = z.object({
  /** The absolute address: `session:<host>/<id>`, `app:<host>/<project>/<app>`, `person` or `centralu` */
  address: z.string(),
  kind: z.string(),
  /** The session's id on this host, for a session; null for any other party */
  sessionId: z.string().nullable().default(null),
  /** The session's name or the app's name; null when it is gone or is the person */
  name: z.string().nullable().default(null),
  /** The session's state as the Inbox shows it live; null for any other party */
  state: z.string().nullable().default(null),
})
export type MailParty = z.infer<typeof MailParty>

export const MailThreadRow = z.object({
  id: z.string(),
  subject: z.string(),
  state: z.string(),
  outcome: z.string().nullable().default(null),
  next: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
  owner: MailParty,
  assignee: MailParty.nullable().default(null),
  /** Messages to the person in this thread that the person has not read */
  unread: z.number().default(0),
  /** Mail in the thread held for the person to act on (a loop, a spent budget, a policy, a delivery that failed), for any receiver */
  held: z.number().default(0),
  /** Standing blockers */
  blocked: z.number().default(0),
  /** A turn of this thread is going in its assignee: closing it stops that turn, so the Inbox asks first (3.10) */
  working: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The latest message that is not an event: who, what kind, its first words */
  last: z.object({ sender: MailParty, kind: z.string(), preview: z.string(), at: z.number() }).nullable().default(null),
})
export type MailThreadRow = z.infer<typeof MailThreadRow>

/** Mail waiting for the person to say what happens to it: held, with why (§7.6, §7.7, §7.9) */
export const MailHeldRow = z.object({
  messageId: z.string(),
  threadId: z.string(),
  subject: z.string(),
  sender: MailParty,
  /** The receiver it waits to be sent to */
  recipient: MailParty,
  kind: z.string(),
  /** `uncertain` | `failed` | `loop` | `budget` | `policy` | …: why it waits, as the host states it */
  reason: z.string(),
  preview: z.string(),
  since: z.number(),
})
export type MailHeldRow = z.infer<typeof MailHeldRow>

export const MailMessage = z.object({
  id: z.string(),
  seq: z.number(),
  sender: MailParty,
  kind: z.string(),
  urgent: z.boolean().default(false),
  body: z.string(),
  /** What only Centralu writes about the message (an event's change, a state move); never anything a sender wrote */
  facts: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.number(),
  /** For the person's own messages: how far each receiver has taken them */
  receipts: z.array(z.object({ recipient: MailParty, delivered: z.boolean(), read: z.boolean(), handled: z.boolean() })).optional(),
})
export type MailMessage = z.infer<typeof MailMessage>

export const MailBlocker = z.object({
  n: z.number(),
  kind: z.string(),
  ref: z.string().nullable().default(null),
  text: z.string().default(''),
  resolved: z.boolean().default(false),
})
export type MailBlocker = z.infer<typeof MailBlocker>

export const MailThreadView = z.object({
  thread: MailThreadRow,
  parties: z.array(z.object({ party: MailParty, role: z.string() })),
  blockers: z.array(MailBlocker),
  messages: z.array(MailMessage),
  /** More messages exist after the last one returned */
  more: z.boolean().default(false),
  /** Messages exist before the first one returned (a `tail` read): ask again with `before` */
  older: z.boolean().default(false),
  /** Done threads this one follows up */
  follows: z.array(z.object({ id: z.string(), subject: z.string() })).default([]),
})
export type MailThreadView = z.infer<typeof MailThreadView>
