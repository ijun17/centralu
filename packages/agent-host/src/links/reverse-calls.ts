import { HubMethods, type HubAskParams, type HubAskResult, type HubProject } from '@cc/protocol'
import { rpcError } from '../rpc-error.js'
import type { ReverseCalls } from './link-deps.js'

/**
 * What the hub answers a linked machine's call with (#550, the reverse direction, docs/plans/remote-hub.md §12.7): an
 * allowlist of two calls, `hub.projects` and `hub.askProject` (owner decision 2026-10-18, option (a): only ask_project
 * into the hub's projects). Nothing else a machine sends reaches this host: not an RPC method, not a read of a session,
 * not the router. Each call is refused unless that machine's switch is on, read when the call comes; the machine is the
 * link's own (`LinkedMachineConnection`), never what the call says.
 */
export function reverseCalls(o: {
  /** Whether the machine's switch is on now (the store's) */
  allowed: (machineId: string) => boolean
  projects: () => HubProject[]
  ask: (machine: { id: string; name: string }, p: HubAskParams, signal: AbortSignal) => Promise<HubAskResult>
  /** This computer's name, as the machine's session reads it */
  selfName: () => string
}): ReverseCalls {
  return async (machine, method, params, signal) => {
    if (method !== 'hub.projects' && method !== 'hub.askProject') {
      throw rpcError(`Unknown method: ${method}. A linked machine may ask this computer only hub.projects and hub.askProject.`)
    }
    if (!o.allowed(machine.id)) {
      throw rpcError(`${o.selfName()} does not let sessions on ${machine.name} ask its projects. The person can turn that on in Settings → Machines on ${o.selfName()}.`)
    }
    if (method === 'hub.projects') return { projects: o.projects() }
    const p = HubMethods['hub.askProject'].params.safeParse(params)
    if (!p.success) throw rpcError('Not an ask this computer reads')
    return o.ask(machine, p.data, signal)
  }
}
