import { z } from 'zod'

/** The parameters of the `mail` methods, which the host validates (docs/protocol.md §3). Their results: ./mail.results.ts */
export const mailParams = {
  /** The threads the person is in, unread first, the mail held for them, and how many sleeping sessions wait for their word */
  'mail.list': z.object({}),
  /** One thread with its messages after `after` (from where the person last read by default), marked read for the person */
  'mail.thread': z.object({
    threadId: z.string(),
    after: z.number().int().min(0).optional(),
    all: z.boolean().optional(),
    /** The last this many messages (at most 100), and the thread is read to its end; with `before`, the last this many before that `seq`, read already */
    tail: z.number().int().min(1).max(100).optional(),
    before: z.number().int().min(1).optional(),
  }),
  /** The person writes in a thread: their words, whatever the thread's other parties are (§7.1) */
  'mail.reply': z.object({
    threadId: z.string(),
    text: z.string().min(1).max(16_000),
    kind: z.enum(['note', 'answer', 'question']).optional(),
  }),
  /** The person closes a thread */
  'mail.close': z.object({
    threadId: z.string(),
    outcome: z.enum(['finished', 'failed', 'stopped', 'dropped']).optional(),
  }),
  /** The person gives the work to another session, with the words that go with it */
  'mail.reassign': z.object({
    threadId: z.string(),
    sessionId: z.string(),
    text: z.string().min(1).max(16_000),
  }),
  /** The person resolves a blocker */
  'mail.unblock': z.object({ threadId: z.string(), n: z.number().int().min(1) }),
  /** The person sends held mail now (`release`: Release / Resend / Retry) or lets it go undelivered (`dismiss`) */
  'mail.held': z.object({
    action: z.enum(['release', 'dismiss']),
    recipient: z.string(),
    messageIds: z.array(z.string()).min(1).max(500),
  }),
  /** The person resumes mail paused for a session's budget, or for a thread's turns (§7.9): exactly one of the two */
  'mail.resume': z
    .object({ sessionId: z.string().optional(), threadId: z.string().optional() })
    .refine(
      (p) => (p.sessionId === undefined) !== (p.threadId === undefined),
      'sessionId or threadId, not both',
    ),
  /** The person's answer to "N sessions have mail from while Centralu was off": wake them, or leave them for their next turn (§7.9) */
  'mail.wake': z.object({ wake: z.boolean() }),
} as const
