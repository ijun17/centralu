import { z } from 'zod'
import { MailHeldRow, MailThreadRow, MailThreadView } from '../../entities/mail.js'

/** The results of the `mail` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./mail.params.ts */
export const mailResults = {
  'mail.list': z.object({
    threads: z.array(MailThreadRow),
    held: z.array(MailHeldRow).default([]),
    /** Sleeping sessions with mail from while Centralu was off that wait for "Wake them" or "Leave them" (§7.9) */
    waiting: z.number().default(0),
  }),
  'mail.thread': MailThreadView,
  'mail.reply': MailThreadView,
  'mail.close': MailThreadRow,
  'mail.reassign': MailThreadView,
  'mail.unblock': MailThreadRow,
  'mail.held': z.object({ changed: z.number() }),
  'mail.resume': z.object({ ok: z.literal(true) }),
  'mail.wake': z.object({ ok: z.literal(true) }),
} as const
