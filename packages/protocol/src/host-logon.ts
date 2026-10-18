import { z } from 'zod'

/**
 * Which kind of Windows logon a host runs in (#1224, `HelloServer.logon`, `MachineInfo.logon`). A module of its own:
 * both the envelope and the machine rows read it, and machines.ts is reached from the envelope through the events.
 */
export const HostLogon = z.enum(['interactive', 'network', 'batch', 'service'])
export type HostLogon = z.infer<typeof HostLogon>
