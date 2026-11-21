import { z } from 'zod'

/** Params of the `mail` methods, parsed by the host (docs/protocol.md §3 "mailbox"). Results: ./mail.results.ts */
export const mailParams = {
  'mail.list': z.object({}),
  'mail.tasks': z.object({}),
  'mail.thread': z.object({
    threadId: z.string(),
    after: z.number().int().min(0).optional(),
    all: z.boolean().optional(),
    /** The last this many, the thread then read to its end; with `before`, the last this many before that `seq`, already read */
    tail: z.number().int().min(1).max(100).optional(),
    before: z.number().int().min(1).optional(),
    /** Nothing in it is read for anyone: a hub's look at a linked machine's chain from its Tasks. An older host drops it */
    lookIn: z.boolean().default(false),
  }),
  /** The person's words, whatever the thread's other parties are (docs/plans/mailbox.md §7.1) */
  'mail.reply': z.object({
    threadId: z.string(),
    text: z.string().min(1).max(16_000),
    kind: z.enum(['note', 'answer', 'question']).optional(),
    /** The question `text` answers, by a choice or in the person's words. An older host takes only a choice, refusing other words */
    answers: z.string().optional(),
  }),
  'mail.close': z.object({
    threadId: z.string(),
    outcome: z.enum(['finished', 'failed', 'stopped', 'dropped']).optional(),
  }),
  /** `release`: Release / Resend / Retry; `dismiss`: let it go undelivered */
  'mail.held': z.object({
    action: z.enum(['release', 'dismiss']),
    recipient: z.string(),
    messageIds: z.array(z.string()).min(1).max(500),
  }),
  /** Exactly one of the two; `sessionId`, sent by an older window, resumes nothing */
  'mail.resume': z
    .object({ sessionId: z.string().optional(), threadId: z.string().optional() })
    .refine(
      (p) => (p.sessionId === undefined) !== (p.threadId === undefined),
      'sessionId or threadId, not both',
    ),
  /** "N sessions have mail from while Centralu was off": wake them, or leave them for their next turn */
  'mail.wake': z.object({ wake: z.boolean() }),
  /** What a session's header badge lists (docs/plans/mailbox.md §18.8). An older host answers "Unknown method": no badge */
  'watches.list': z.object({ sessionId: z.string() }),
  /** Its firing not given yet is taken back, and its session gets one quiet notice */
  'watches.cancel': z.object({ id: z.string() }),
} as const
