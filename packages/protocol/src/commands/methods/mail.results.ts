import { z } from 'zod'
import { MailHeldRow, MailTaskRow, MailThreadRow, MailThreadView, WatchView } from '../../entities/mail.js'

/** The results of the `mail` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./mail.params.ts */
export const mailResults = {
  'mail.list': z.object({
    threads: z.array(MailThreadRow),
    held: z.array(MailHeldRow).default([]),
    /** Sleeping sessions with mail from while Centralu was off that wait for "Wake them" or "Leave them" (§7.9) */
    waiting: z.number().default(0),
  }),
  'mail.tasks': z.object({
    tasks: z.array(MailTaskRow).default([]),
    /** How many open tasks are listed when more are open than the host lists (the oldest left out); null when every open one is. Absent from an older host */
    capped: z.number().nullable().default(null),
  }),
  'mail.thread': MailThreadView,
  'mail.reply': MailThreadView,
  'mail.close': MailThreadRow,
  'mail.held': z.object({ changed: z.number() }),
  'mail.resume': z.object({ ok: z.literal(true) }),
  'mail.wake': z.object({ ok: z.literal(true) }),
  'watches.list': z.object({ watches: z.array(WatchView).default([]) }),
  /** `cancelled: false`: the watch had ended already (it fired, expired or was cancelled), and nothing changed */
  'watches.cancel': z.object({ cancelled: z.boolean() }),
} as const
