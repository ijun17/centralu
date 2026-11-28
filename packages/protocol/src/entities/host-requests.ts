import { z } from 'zod'

/**
 * A limited-credential call that cannot be undone or widens what runs unasked, waiting for a window's Allow
 * (docs/security-boundaries/credentials.md, "Who holds full power"). `question` is the whole card.
 */
export const HostRequest = z.object({
  requestId: z.string().min(1).max(100),
  method: z.string().max(200),
  question: z.string().max(20_000),
  /** What the program called itself (`hello.client`): never checked, only shown quoted */
  client: z.string().max(200).nullable(),
  /** The session whose credential it holds, unchecked (any process of its user reads an agent's env); null: the plain one */
  session: z.string().max(200).nullable().catch(null).default(null),
  createdAt: z.number(),
  expiresAt: z.number(),
})
export type HostRequest = z.infer<typeof HostRequest>

/** An outcome this build does not know reads as `withdrawn` */
export const HostRequestOutcome = z.enum(['allowed', 'denied', 'withdrawn', 'expired']).catch('withdrawn')
export type HostRequestOutcome = z.infer<typeof HostRequestOutcome>

/** In a window's hello: without such a window holding the token the host refuses at once; an older window says none */
export const SHOWS_HOST_REQUESTS = 'host_requests'

/** A dev browser tab the person trusted (docs/security-boundaries/dev-browser-tabs.md), as Settings lists it: never its key */
export const DevTab = z.object({
  id: z.string(),
  origin: z.string(),
  grantedAt: z.number(),
  expiresAt: z.number(),
})
export type DevTab = z.infer<typeof DevTab>
