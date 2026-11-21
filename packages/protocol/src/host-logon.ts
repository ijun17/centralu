import { z } from 'zod'

/**
 * The kind of Windows logon a host runs in (#1224). Its own module: the envelope and the machine rows both read it, and
 * machines.ts is reached from the envelope through the events.
 */
export const HostLogon = z.enum(['interactive', 'network', 'batch', 'service'])
export type HostLogon = z.infer<typeof HostLogon>

/**
 * A `serve` in the person's Windows sign-in waiting to take over from this host (docs/protocol.md §3, `host.handover`).
 * `gave_up` after 30 minutes; it tries again at the next sign-in or start.
 */
export const HostHandover = z.object({ state: z.enum(['waiting', 'gave_up']), since: z.number() })
export type HostHandover = z.infer<typeof HostHandover>
