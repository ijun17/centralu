import { MACHINE_CHANGE, type MachineConnect, type MachineInfo, type MachineProbe, type RemoteShell } from '@cc/protocol'
import type { MachineRequest } from '../adapters/contract.js'
import type { DelegationHost } from './delegation-flow.js'
import { trustedJsonText } from './tool-answers.js'

/**
 * What the orchestrator's machine commands reach of the hub's links (#1219), the same calls the window's `machines.*`
 * make (`Links`, links/links-registry.ts). Wired by main.ts (`SessionManager.useMachineOps`); none on a host that links
 * nothing, where every command says so.
 */
export type MachineOps = {
  list(): MachineInfo[]
  probe(sshTarget: string): Promise<MachineProbe>
  add(spec: { name: string; sshTarget: string; shell: RemoteShell; wslDistro?: string | null }): MachineInfo
  remove(id: string): Promise<void>
  reconnect(id: string): MachineInfo
  setConnect(id: string, connect: MachineConnect): MachineInfo
  install(id: string): Promise<{ machine: MachineInfo; current: { version: string }; note?: string }>
  update(id: string): Promise<{ machine: MachineInfo; current: { version: string }; note?: string }>
  autostart(id: string, on?: boolean): Promise<{ machine: MachineInfo; autostart: { on: boolean; how: string | null; linger: boolean | null } }>
  /** Why an install or update would be refused before it starts, or null (`LinkedMachine.operationRefusal`) */
  installRefusal(id: string, kind: 'install' | 'update'): string | null
}

export type { MachineRequest }

export type MachineAnswer = { ok: true; text: string } | { ok: false; error: string }

/** What the machine commands reach of the session manager: its cards */
export type MachineFlowHost = Pick<DelegationHost, 'askHost'>

/** A linked machine's status in words (#1220); a status this build does not name reads as itself */
const MACHINE_STATUS: Record<string, string> = {
  connected: 'connected',
  connecting: 'connecting',
  starting: 'connecting (starting Centralu there)',
  updating: 'updating Centralu there',
  unreachable: 'unreachable',
  disconnected: 'disconnected',
  not_running: 'unreachable (Centralu is not running there)',
  versions_differ: 'not connected (waiting for the person to align versions)',
  refused: 'not connected (it refused the link)',
}

/** The OS and shell the hub reaches a machine with, in words: PowerShell is Windows, WSL a distro on Windows */
function osOf(m: Pick<MachineInfo, 'shell' | 'wslDistro' | 'autostart'>): string {
  if (m.shell === 'powershell') return 'Windows, PowerShell'
  if (m.shell === 'wsl') return `Linux in WSL${m.wslDistro ? ` (${m.wslDistro})` : ''} on Windows`
  return m.autostart?.how === 'systemd' ? 'Linux, Unix shell' : 'macOS or Linux, Unix shell'
}

/**
 * One linked machine for list_machines (#1220) and every machine command's answer (#1219): its name as the person
 * gave it (quoted, since it is theirs), status, OS and shell, and when its link is opened (#1134).
 */
export function machineLine(m: MachineInfo): string {
  const connect = m.connect === 'when_needed' ? 'connects when needed' : 'connects at start'
  return `- ${trustedJsonText(m.name)} [${m.id}]: ${MACHINE_STATUS[m.status] ?? m.status}; ${osOf(m)}; ${connect}`
}

/** Why `machines.add` would refuse this target (links-registry.ts), said before anything runs */
function targetError(target: string): string | null {
  if (!target || target.startsWith('-') || /\s/.test(target) || target.length > 255) {
    return `Not an ssh target: ${JSON.stringify(target)}. Use a host alias from this computer's ~/.ssh/config, or user@host.`
  }
  return null
}

/**
 * The orchestrator's commands for linked machines (#1219): add (probed first), install or update Centralu there,
 * remove, reconnect, when it connects, and whether it starts at boot. Each is the call the window's Machines screen
 * makes. What changes a machine or this computer's reach (add, install, update, remove, start at boot) waits for the
 * person's card, in every preset; reconnecting and the connect mode do not, as the row's buttons do not ask. Every
 * refusal that can be known first (no such machine, a target that is no ssh target or does not answer, a build that
 * cannot install) comes before any card.
 */
export class MachineFlow {
  private ops: MachineOps | null = null

  constructor(private readonly host: MachineFlowHost) {}

  useOps(ops: MachineOps): void {
    this.ops = ops
  }

  async run(sessionId: string, req: MachineRequest, signal?: AbortSignal): Promise<MachineAnswer> {
    const ops = this.ops
    if (!ops) return { ok: false, error: 'This computer links no machines here.' }
    try {
      if (req.action === 'add') return await this.add(ops, sessionId, req, signal)
      const m = this.named(ops, req.machine)
      if (typeof m === 'string') return { ok: false, error: m }
      switch (req.action) {
        case 'reconnect':
          return done(`Reconnecting ${m.name}.`, ops.reconnect(m.id))
        case 'connect':
          return done(
            req.connect === 'when_needed' ? `${m.name} now connects only when something needs it.` : `${m.name} now connects when Centralu starts.`,
            ops.setConnect(m.id, req.connect),
          )
        case 'remove': {
          const refused = await this.ask(
            sessionId,
            `Remove the linked machine ${m.name} (${m.sshTarget})? Its sessions and projects leave this computer's lists. Nothing on ${m.name} changes: ` +
              'its sessions keep running there, and adding it again lists them again.',
            signal,
          )
          if (refused) return { ok: false, error: refused }
          await ops.remove(m.id)
          return { ok: true, text: `Removed ${trustedJsonText(m.name)} [${m.id}] from this computer's linked machines. Nothing on it changed.` }
        }
        case 'install':
        case 'update': {
          const why = ops.installRefusal(m.id, req.action)
          if (why) return { ok: false, error: why }
          const version = m.versions?.hub.version ? `Centralu ${m.versions.hub.version}` : "this computer's Centralu"
          const refused = await this.ask(
            sessionId,
            req.action === 'install'
              ? `Install ${version} on ${m.name} (${m.sshTarget}, ${osOf(m)})? Over ssh it downloads Node and the npm packages there, checked against the ` +
                  "release's pins, beside what is installed. A Centralu running there keeps running until it next starts."
              : `Update ${m.name} (${m.sshTarget}, ${osOf(m)}) to ${version}? It installs beside the running one, stops the Centralu there (its agents end ` +
                  'and resume on the new one; a turn in progress is lost), starts the new one, and puts the old one back if it does not answer in 30 s.',
            signal,
          )
          if (refused) return { ok: false, error: refused }
          const r = req.action === 'install' ? await ops.install(m.id) : await ops.update(m.id)
          return done(`${req.action === 'install' ? 'Installed' : 'Updated to'} Centralu ${r.current.version} on ${m.name}.${r.note ? ` ${r.note}` : ''}`, r.machine)
        }
        case 'autostart': {
          const refused = await this.ask(
            sessionId,
            req.on
              ? `Make ${m.name} (${m.sshTarget}, ${osOf(m)}) start Centralu when it boots? The Centralu there writes a systemd user unit (Linux) or a ` +
                  'scheduled task at sign-in (Windows and WSL); macOS offers none. Nothing is started or stopped now.'
              : `Stop ${m.name} (${m.sshTarget}) starting Centralu when it boots? The Centralu there removes its entry. A Centralu running there keeps running.`,
            signal,
          )
          if (refused) return { ok: false, error: refused }
          const r = await ops.autostart(m.id, req.on)
          const how = r.autostart.how === 'systemd' && r.autostart.linger === false ? ' (at login, until lingering is enabled there)' : ''
          return done(r.autostart.on ? `${m.name} starts Centralu when it boots${how}.` : `${m.name} no longer starts Centralu when it boots.`, r.machine)
        }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** A linked machine by id or by the name the person gave it, case aside; the refusal names the way to list them */
  private named(ops: MachineOps, ref: string): MachineInfo | string {
    const wanted = ref.trim().toLowerCase()
    const m = ops.list().find((x) => x.id === wanted || x.name.toLowerCase() === wanted)
    return m ?? `No linked machine is called ${JSON.stringify(ref)}; list_machines names them.`
  }

  /**
   * add_machine: the target checked and probed (one BatchMode ssh, nothing changed there) before the card, which names
   * the target, what runs there and what linking does. The shell follows what answered, as the Add machine dialog's
   * rows do: a Unix shell, Windows (PowerShell), or a WSL distro of that Windows when one is named.
   */
  private async add(ops: MachineOps, sessionId: string, req: Extract<MachineRequest, { action: 'add' }>, signal?: AbortSignal): Promise<MachineAnswer> {
    const target = req.sshTarget.trim()
    const bad = targetError(target)
    if (bad) return { ok: false, error: bad }
    const distro = req.wslDistro?.trim() || null
    const name = (req.name?.trim() || `${target.replace(/^.*@/, '')}${distro ? ` ${distro}` : ''}`).slice(0, 64)
    const linked = ops.list()
    if (linked.some((m) => m.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `A linked machine is already called ${name}; give another name.` }
    const probe = await ops.probe(target)
    if (!probe.reachable) return { ok: false, error: `${target} did not answer over ssh${probe.error ? `: ${probe.error}` : ''}. Nothing was linked.` }
    if (!probe.os) return { ok: false, error: `Could not tell what runs on ${target}; the person can add it from Settings, Machines, choosing what it runs.` }
    let shell: RemoteShell
    let wslDistro: string | null = null
    if (probe.os === 'posix') {
      if (distro) return { ok: false, error: `${target} runs a Unix shell, not Windows, so it has no WSL distro; leave wslDistro out.` }
      shell = 'posix'
    } else if (distro) {
      const found = probe.wslDistros.find((d) => d.name.toLowerCase() === distro.toLowerCase())
      if (!found) return { ok: false, error: `${target} has no WSL distro ${distro}${probe.wslDistros.length ? `; it has ${probe.wslDistros.map((d) => d.name).join(', ')}` : ''}.` }
      shell = 'wsl'
      wslDistro = found.name
    } else {
      shell = 'powershell'
    }
    const same = linked.find((m) => m.sshTarget === target && m.shell === shell && (shell !== 'wsl' || (m.wslDistro ?? '').toLowerCase() === (wslDistro ?? '').toLowerCase()))
    if (same) return { ok: false, error: `${target} is already linked that way, as ${same.name}.` }
    const runs = osOf({ shell, wslDistro, autostart: null })
    const refused = await this.ask(
      sessionId,
      `Link ${target} as the machine ${name} (${runs})? This computer then connects to it over your ssh and keys, runs \`centralu serve --connection\` there, ` +
        'and starts the Centralu installed there when none is running. Its sessions and projects join this computer\'s lists, and agents here can work ' +
        'on it. Nothing is installed: that is a separate question.',
      signal,
    )
    if (refused) return { ok: false, error: refused }
    return done(`Linked ${target} as ${name}.`, ops.add({ name, sshTarget: target, shell, wslDistro }))
  }

  /** The machine card, allow or deny only (`MACHINE_CHANGE`): the refusal the orchestrator reads, or null once allowed */
  private async ask(sessionId: string, question: string, signal?: AbortSignal): Promise<string | null> {
    const decision = await this.host.askHost(sessionId, { kind: 'other', about: MACHINE_CHANGE, raw: question }, signal, { alwaysAsk: true })
    if (decision === 'deny') return 'The person did not approve it, so nothing changed. Do not ask again unless they tell you to.'
    if (decision === null) return 'The card was withdrawn before the person answered, so nothing changed.'
    return null
  }
}

/** A command's answer: what it did, then the machine as it is now */
function done(text: string, machine: MachineInfo): MachineAnswer {
  return { ok: true, text: `${text}\nNow:\n${machineLine(machine)}` }
}
