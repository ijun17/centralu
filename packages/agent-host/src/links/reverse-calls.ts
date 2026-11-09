import { HubMethods, type HubAskParams, type HubAskResult, type HubProject } from '@cc/protocol'
import type { MailAcross } from '../mail/across.js'
import { rpcError } from '../rpc-error.js'
import type { ReverseCalls } from './link-deps.js'

/**
 * What the hub answers a linked machine's call with (#550, the reverse direction, docs/plans/remote-hub.md §12.7): an
 * allowlist of two calls, `hub.projects` and `hub.askProject` (owner decision 2026-10-18, option (a): only ask_project
 * into the hub's projects). Nothing else a machine sends reaches this host: not an RPC method, not a read of a session,
 * not the router. Each call is refused unless that machine's switch is on, read when the call comes; the machine is the
 * link's own (`LinkedMachineConnection`), never what the call says.
 *
 * Mail (#2067, docs/plans/linked-mail.md §5 and §6): every agent may mail every other, whichever machine each runs on
 * (owner decision 2026-11-09), so `hub.mail`, `hub.mailRows` and `hub.find` are answered whatever the switch says; the
 * switch gates only asking this computer's projects. The machine's sessions are named by the link's machine, never by
 * what the call says (`MailAcross.fromMachine`). Without `across` they are "Unknown method", as in a build from before.
 */
export function reverseCalls(o: {
  /** Whether the machine's switch is on now (the store's) */
  allowed: (machineId: string) => boolean
  projects: () => HubProject[]
  ask: (machine: { id: string; name: string }, p: HubAskParams, signal: AbortSignal) => Promise<HubAskResult>
  /** This computer's name, as the machine's session reads it */
  selfName: () => string
  /** Mail across linked machines (mail/across.ts): a machine's session's message, what became of mail, and a search */
  across?: Pick<MailAcross, 'fromMachine' | 'rows' | 'answerFind'>
}): ReverseCalls {
  return async (machine, method, params, signal) => {
    const across = o.across
    if (across && method === 'hub.mail') return across.fromMachine(machine, read(HubMethods['hub.mail'].params.safeParse(params)))
    if (across && method === 'hub.find') return across.answerFind(machine, read(HubMethods['hub.find'].params.safeParse(params)))
    if (across && method === 'hub.mailRows') {
      await across.rows(read(HubMethods['hub.mailRows'].params.safeParse(params)).rows, { machine: machine.id })
      return { ok: true }
    }
    if (method !== 'hub.projects' && method !== 'hub.askProject') {
      throw rpcError(`Unknown method: ${method}. A linked machine may ask this computer only hub.projects and hub.askProject${across ? ', and mail with hub.mail, hub.mailRows and hub.find' : ''}.`)
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

/** A call's parameters as the schema read them, or the refusal of a call this computer does not read */
function read<T>(parsed: { success: true; data: T } | { success: false }): T {
  if (!parsed.success) throw rpcError('Not a call this computer reads')
  return parsed.data
}
