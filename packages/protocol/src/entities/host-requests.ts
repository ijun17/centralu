import { z } from 'zod'

/**
 * A host request (#1405): a call made with the limited credential that cannot be undone or widens what runs without
 * asking, waiting for the person to allow it in a window. Not tied to a session: the program that asked holds no
 * session's rights, so its card is the host's own (docs/security-boundaries.md, "Who holds full power").
 *
 * `question` is the whole card: what will happen, named (the trash's rows by name and size, as the orchestrator's own
 * card names them), and that it cannot be undone. `client` is the name the program gave itself in its hello, never
 * checked, and only ever shown quoted. The request is withdrawn when the program disconnects, and at `expiresAt`.
 */
export const HostRequest = z.object({
  requestId: z.string().min(1).max(100),
  /** The RPC method that waits */
  method: z.string().max(200),
  question: z.string().max(20_000),
  /** What the program called itself (`hello.client`), quoted; null when it said nothing */
  client: z.string().max(200).nullable(),
  /**
   * The session whose credential the program holds (#1405), quoted: it says it runs under that session, which nothing
   * checks (an agent's environment is readable by every process of its user). Null for the plain limited credential.
   * Additive: an older host sends none
   */
  session: z.string().max(200).nullable().catch(null).default(null),
  createdAt: z.number(),
  expiresAt: z.number(),
})
export type HostRequest = z.infer<typeof HostRequest>

/** How a host request ended. An outcome this build does not know reads as `withdrawn` */
export const HostRequestOutcome = z.enum(['allowed', 'denied', 'withdrawn', 'expired']).catch('withdrawn')
export type HostRequestOutcome = z.infer<typeof HostRequestOutcome>

/**
 * What a window says in its hello it can show (#1405). A host raises a host request only while a window that shows
 * them is attached with the token; otherwise the call is refused at once (owner, 2026-10-21). Additive: an older
 * window says nothing, and counts as showing none.
 */
export const SHOWS_HOST_REQUESTS = 'host_requests'
