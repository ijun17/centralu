import { z } from 'zod'
import { MailHeldRow, MailThreadRow, MailThreadView } from '../../entities/mail.js'

/**
 * The person's side of the mailbox (#1347, docs/plans/mailbox.md §10.1): the Inbox's list, a thread, the person's reply and the
 * acts that are theirs (close, reassign, unblock, release held mail, resume a paused session or thread). Everything the person
 * writes is theirs by the host's account of who is asking, never by a field the call names. A refusal arrives as the protocol
 * error `refused` with `data.reason` (docs/protocol.md §5).
 *
 * Only the hub's own mailbox: a linked machine's mail is the hub's (slice 4).
 */
export const mailMethods = {
  /** The threads the person is in, unread first, the mail held for them, and how many sleeping sessions wait for their word */
  'mail.list': {
    params: z.object({}),
    result: z.object({
      threads: z.array(MailThreadRow),
      held: z.array(MailHeldRow).default([]),
      /** Sleeping sessions with mail from while Centralu was off that wait for "Wake them" or "Leave them" (§7.9) */
      waiting: z.number().default(0),
    }),
  },
  /** One thread with its messages after `after` (from where the person last read by default), marked read for the person */
  'mail.thread': {
    params: z.object({
      threadId: z.string(),
      after: z.number().int().min(0).optional(),
      all: z.boolean().optional(),
      /** The last this many messages (at most 100), and the thread is read to its end; with `before`, the last this many before that `seq`, read already */
      tail: z.number().int().min(1).max(100).optional(),
      before: z.number().int().min(1).optional(),
    }),
    result: MailThreadView,
  },
  /** The person writes in a thread: their words, whatever the thread's other parties are (§7.1) */
  'mail.reply': {
    params: z.object({ threadId: z.string(), text: z.string().min(1).max(16_000), kind: z.enum(['note', 'answer', 'question']).optional() }),
    result: MailThreadView,
  },
  /** The person closes a thread */
  'mail.close': {
    params: z.object({ threadId: z.string(), outcome: z.enum(['finished', 'failed', 'stopped', 'dropped']).optional() }),
    result: MailThreadRow,
  },
  /** The person gives the work to another session, with the words that go with it */
  'mail.reassign': {
    params: z.object({ threadId: z.string(), sessionId: z.string(), text: z.string().min(1).max(16_000) }),
    result: MailThreadView,
  },
  /** The person resolves a blocker */
  'mail.unblock': {
    params: z.object({ threadId: z.string(), n: z.number().int().min(1) }),
    result: MailThreadRow,
  },
  /** The person sends held mail now (`release`: Release / Resend / Retry) or lets it go undelivered (`dismiss`) */
  'mail.held': {
    params: z.object({ action: z.enum(['release', 'dismiss']), recipient: z.string(), messageIds: z.array(z.string()).min(1).max(500) }),
    result: z.object({ changed: z.number() }),
  },
  /** The person resumes mail paused for a session's budget, or for a thread's turns (§7.9): exactly one of the two */
  'mail.resume': {
    params: z
      .object({ sessionId: z.string().optional(), threadId: z.string().optional() })
      .refine((p) => (p.sessionId === undefined) !== (p.threadId === undefined), 'sessionId or threadId, not both'),
    result: z.object({ ok: z.literal(true) }),
  },
  /** The person's answer to "N sessions have mail from while Centralu was off": wake them, or leave them for their next turn (§7.9) */
  'mail.wake': {
    params: z.object({ wake: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
} as const
