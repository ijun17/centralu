import { HubMethods, type HubAskParams, type HubAskResult, type HubMailParams, type HubMailResult, type HubProject } from '@cc/protocol'
import { rpcError } from '../rpc-error.js'
import type { ReverseCalls } from './link-deps.js'

/**
 * What the hub answers a linked machine's call with (#550, the reverse direction, docs/plans/remote-hub.md §12.7): an
 * allowlist of two calls, `hub.projects` and `hub.askProject` (owner decision 2026-10-18, option (a): only ask_project
 * into the hub's projects). Nothing else a machine sends reaches this host: not an RPC method, not a read of a session,
 * not the router. Each call is refused unless that machine's switch is on, read when the call comes; the machine is the
 * link's own (`LinkedMachineConnection`), never what the call says.
 *
 * `hub.mail` (#2067 item 1, docs/plans/linked-mail.md §3, §5): a session this hub started on the machine mails the session
 * that started it. A child may always mail its parent, so the switch is not read; the hub finds the parent in its own
 * record of the machine's children, and answers `not_yours` for any other session. Without `mail` it is "Unknown method",
 * as in a build from before it.
 */
export function reverseCalls(o: {
  /** Whether the machine's switch is on now (the store's) */
  allowed: (machineId: string) => boolean
  projects: () => HubProject[]
  ask: (machine: { id: string; name: string }, p: HubAskParams, signal: AbortSignal) => Promise<HubAskResult>
  /** This computer's name, as the machine's session reads it */
  selfName: () => string
  /** A message of a session this hub started on the machine to its parent (`mailFromMachine`, mail/from-machine.ts) */
  mail?: (machine: { id: string; name: string }, p: HubMailParams) => HubMailResult
}): ReverseCalls {
  return async (machine, method, params, signal) => {
    if (method === 'hub.mail' && o.mail) {
      const p = HubMethods['hub.mail'].params.safeParse(params)
      if (!p.success) throw rpcError('Not a message this computer reads')
      return o.mail(machine, p.data)
    }
    if (method !== 'hub.projects' && method !== 'hub.askProject') {
      throw rpcError(`Unknown method: ${method}. A linked machine may ask this computer only hub.projects and hub.askProject${o.mail ? ', and mail with hub.mail' : ''}.`)
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
