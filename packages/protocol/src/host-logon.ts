import { z } from 'zod'

/**
 * Which kind of Windows logon a host runs in (#1224, `HelloServer.logon`, `MachineInfo.logon`). A module of its own:
 * both the envelope and the machine rows read it, and machines.ts is reached from the envelope through the events.
 */
export const HostLogon = z.enum(['interactive', 'network', 'batch', 'service'])
export type HostLogon = z.infer<typeof HostLogon>

/**
 * A `serve` in the person's Windows sign-in waiting to take over from this host (#1224), as it last told this host
 * (`host.handover`): `waiting` while this host has work running, since `since`; `gave_up` once it stopped waiting, at
 * `since` (after 30 minutes; it tries again at the next sign-in or start). Said in `hello_ok.handover` and in the
 * `host_handover` event, and kept on the hub's row (`MachineInfo.handover`)
 */
export const HostHandover = z.object({ state: z.enum(['waiting', 'gave_up']), since: z.number() })
export type HostHandover = z.infer<typeof HostHandover>
