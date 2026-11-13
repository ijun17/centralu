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

/**
 * The answers a session's question to the person offers to pick from (#1630, `MailMessage.choices`): the sender's words, which Centralu
 * checked for shape only. Picking one answers the question with its words; the person may always write their own answer instead
 */
export const MailChoices = z.array(z.string()).min(2).max(6)
export type MailChoices = z.infer<typeof MailChoices>

/**
 * What a thread waits on the person to answer (#2229): the newest message to them that asks for an answer (a session's question, or a message that needs a
 * reply), its first lines as plain words, the answers it offers to pick from, and the ids of all such messages in the thread. The Inbox draws a card
 * from it, answers a pick without opening the thread, and the header badge counts it (#2227); the host works it out, the window decides nothing.
 */
export const MailAsk = z.object({
  /** The message waiting for the answer: the one a pick or words answer (`mail.reply` `answers`) */
  id: z.string(),
  sender: MailParty,
  /** Its first lines, as plain words */
  text: z.string(),
  choices: MailChoices.optional().catch(undefined),
  /** Every message to the person that waits for an answer in this thread, oldest first, `id` being the last: the host's one rule for an open question, which a window reads and never works out (#2233). */
  open: z.array(z.string()),
})
export type MailAsk = z.infer<typeof MailAsk>

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
  /** What the thread waits on the person to answer; null when nothing does. Absent from a host of an older build */
  ask: MailAsk.nullable().default(null),
  /** Mail in the thread held for the person to act on (a loop, a spent budget, a policy, a delivery that failed), for any receiver */
  held: z.number().default(0),
  /** Standing blockers: none since blockers went with threads (§12.2); kept for a window of an older build, which reads it */
  blocked: z.number().default(0),
  /** A turn of this thread is going in its assignee: closing it stops that turn, so the Inbox asks first (3.10) */
  working: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The latest message that is not an event: who, what kind, its first words */
  last: z
    .object({ sender: MailParty, kind: z.string(), preview: z.string(), at: z.number() })
    .nullable()
    .default(null),
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
  /** On a session's question to the person: the answers it offers to pick from. A sender's words, so not in `facts`; absent from a host of an older build and on any other message */
  choices: MailChoices.optional().catch(undefined),
  /** The message this one answers; absent from a host of an older build. A window reads a question's answer as the person's message that names it */
  replyTo: z.string().optional(),
  createdAt: z.number(),
  /** For the person's own messages: how far each receiver has taken them */
  receipts: z
    .array(
      z.object({ recipient: MailParty, delivered: z.boolean(), read: z.boolean(), handled: z.boolean() }),
    )
    .optional(),
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
  /** None since blockers went with threads (§12.2): kept, as a window of an older build requires it */
  blockers: z.array(MailBlocker),
  messages: z.array(MailMessage),
  /** More messages exist after the last one returned */
  more: z.boolean().default(false),
  /** Messages exist before the first one returned (a `tail` read): ask again with `before` */
  older: z.boolean().default(false),
  /** Done threads this one follows up */
  follows: z.array(z.object({ id: z.string(), subject: z.string() })).default([]),
  /**
   * Whether the person has something in this chain to answer: a message to them from a session that is still here, or their own message to one that is
   * (the target `mail.reply` writes to). False for a chain of mail between sessions that is only held for them; the window offers no reply box then.
   * Absent from a host of an older build, which the window reads as true
   */
  canReply: z.boolean().optional(),
})
export type MailThreadView = z.infer<typeof MailThreadView>

/**
 * One watch a session keeps (#1324, docs/plans/mailbox.md §18.8), as its header lists it. The window words the row from these fields:
 * the host sends no sentence. `source` is what it waits for: `session` a session's turn end, question or stop (`what` its name);
 * `time` a time (`at` the next firing, `everyMinutes` when it repeats); `pr` a pull request's checks (`what` `#123`). An unknown
 * source from a newer host reads as `other`, shown by its `what`.
 */
export const WatchView = z.object({
  id: z.string(),
  source: z.enum(['session', 'time', 'pr', 'other']).catch('other'),
  what: z.string().default(''),
  at: z.number().nullable().default(null),
  everyMinutes: z.number().nullable().default(null),
  /** When it ends if nothing fires it */
  until: z.number(),
  /** The session's own note, at most 300 characters; empty for none */
  note: z.string().default(''),
  createdAt: z.number(),
})
export type WatchView = z.infer<typeof WatchView>
