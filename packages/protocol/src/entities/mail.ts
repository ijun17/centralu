import { z } from 'zod'

// The mailbox as the Inbox reads it: the host owns every field; the screen draws them and decides nothing. States, kinds
// and outcomes are plain strings: a newer host's word reaches the screen unstyled, not as a failed parse (docs/protocol.md §4)

/** Centralu's name for the party, never a name the party gave itself */
export const MailParty = z.object({
  /** `session:<host>/<id>`, `app:<host>/<project>/<app>`, `person` or `centralu` */
  address: z.string(),
  kind: z.string(),
  /** The session's id on this host; null for any other party */
  sessionId: z.string().nullable().default(null),
  /** The session's or app's name; null when it is gone or is the person */
  name: z.string().nullable().default(null),
  /** The session's live state; null for any other party */
  state: z.string().nullable().default(null),
})
export type MailParty = z.infer<typeof MailParty>

/**
 * The answers a session's question offers the person: the sender's words, checked for shape only. Picking one answers
 * with its words; the person may always write their own answer instead
 */
export const MailChoices = z.array(z.string()).min(2).max(6)
export type MailChoices = z.infer<typeof MailChoices>

/**
 * What a thread waits on the person to answer: the newest message to them that asks for one. The Inbox draws a card
 * from it, answers a pick without opening the thread, and the header badge counts it; the host works it out.
 */
export const MailAsk = z.object({
  /** The message a pick or words answer (`mail.reply` `answers`) */
  id: z.string(),
  sender: MailParty,
  /** Its first lines, as plain words */
  text: z.string(),
  choices: MailChoices.optional().catch(undefined),
  /** Every message in the thread waiting for the person's answer, oldest first, `id` last: the host's one rule (#2233) */
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
  /** Null when nothing waits, and from an older host */
  ask: MailAsk.nullable().default(null),
  /** Mail in the thread held for the person to act on (a loop, a policy, a failed delivery), for any receiver */
  held: z.number().default(0),
  /** Always 0: blockers went with threads (mailbox.md §12.2). Kept for an older window, which reads it */
  blocked: z.number().default(0),
  /** A turn of this thread runs in its assignee: closing it stops that turn, so the Inbox asks first */
  working: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The latest message that is not an event */
  last: z
    .object({ sender: MailParty, kind: z.string(), preview: z.string(), at: z.number() })
    .nullable()
    .default(null),
})
export type MailThreadRow = z.infer<typeof MailThreadRow>

/**
 * One piece of open work as Tasks lists it: a message that waits for a reply, one row per recipient. The host words its
 * `state`; the window only groups the rows (`groupTasks`). `state`: `open`, `running` (the assignee's turn is on it),
 * `held` (waits for the person), `review` (the person's task, reported, not closed by them), `released` (a stop released
 * it, or its assignee is gone), `done` (with `outcome`: `answered`, `reported`, `done`, `withdrawn`, `gone`).
 */
export const MailTaskRow = z.object({
  /** The message */
  id: z.string(),
  /** The chain it is in: what `mail.thread` opens */
  root: z.string(),
  subject: z.string(),
  /** `assign` for a task, `question` for a message that needs a reply */
  kind: z.string(),
  /** Its sender */
  owner: MailParty,
  /** This row's recipient */
  assignee: MailParty,
  state: z.string(),
  outcome: z.string().nullable().default(null),
  createdAt: z.number(),
  /** When it was settled, else when it was sent */
  updatedAt: z.number(),
})
export type MailTaskRow = z.infer<typeof MailTaskRow>

/** Mail held until the person says what happens to it */
export const MailHeldRow = z.object({
  messageId: z.string(),
  threadId: z.string(),
  subject: z.string(),
  sender: MailParty,
  recipient: MailParty,
  kind: z.string(),
  /** `uncertain` | `failed` | `loop` | `policy` | …, as the host states it */
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
  /** Only Centralu writes these (an event's change, a state move); never a sender */
  facts: z.record(z.string(), z.unknown()).default({}),
  /** On a session's question to the person. A sender's words, so not in `facts`; absent from an older host */
  choices: MailChoices.optional().catch(undefined),
  /** Absent from an older host. A window reads a question's answer as the person's message that names it */
  replyTo: z.string().optional(),
  createdAt: z.number(),
  /** On the person's own messages: how far each receiver has taken them */
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
  /** Always empty: blockers went with threads (mailbox.md §12.2). Kept, as an older window requires it */
  blockers: z.array(MailBlocker),
  messages: z.array(MailMessage),
  /** More messages exist after the last one returned */
  more: z.boolean().default(false),
  /** Messages exist before the first one returned (a `tail` read): ask again with `before` */
  older: z.boolean().default(false),
  /** Done threads this one follows up */
  follows: z.array(z.object({ id: z.string(), subject: z.string() })).default([]),
  /**
   * The person has something to answer here: a message to them from a session still here, or their own to one. False
   * for mail between sessions only held for them: no reply box. Absent from an older host: read as true
   */
  canReply: z.boolean().optional(),
  /**
   * The person looks into a chain they are not in (a task between sessions, from Tasks): every message is shown, nothing
   * is read or changed for anyone, and there is no reply or close. An older host shows only the person's own chains
   */
  lookIn: z.boolean().default(false),
})
export type MailThreadView = z.infer<typeof MailThreadView>

/**
 * One watch a session keeps (docs/plans/mailbox.md §18.8); the window words the row, the host sends no sentence.
 * `source`: `session` (a session's turn end, question or stop; `what` its name), `time` (`at` the next firing,
 * `everyMinutes` when it repeats), `pr` (a pull request's checks; `what` `#123`), or `other` for a newer host's source.
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
