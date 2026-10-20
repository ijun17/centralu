import { MACHINE_CHANGE, type MachineInfo, type MachineProbe, type RemoteShell } from '@cc/protocol'
import type { MachineRequest } from '../adapters/contract.js'
import type { HostCards } from './host-cards.js'
import { trustedJsonText } from './tool-answers.js'

/**
 * What the orchestrator's machine commands reach of the hub's links (#1219), the same calls the window's `machines.*`
 * make (`Links`, links/links-registry.ts). Wired by main.ts (`SessionManager.useMachineOps`); none on a host that links
 * nothing, where every command says so.
 */
export type MachineOps = {
  list(): MachineInfo[]
  /** What ssh would connect to (`ssh -G`, no connection opened, no key loaded): shown on add_machine's card */
  resolve(sshTarget: string): Promise<{ hostName: string | null; user: string | null; port: number | null; proxyCommand?: string | null; proxyJump?: string | null; error: string | null }>
  probe(sshTarget: string): Promise<MachineProbe>
  add(spec: { name: string; sshTarget: string; shell: RemoteShell; wslDistro?: string | null }): MachineInfo
  remove(id: string): Promise<void>
  /** `start: false`: opens the link and starts no host the link itself would not (#1143); the person's Start otherwise */
  reconnect(id: string, opts?: { start?: boolean }): MachineInfo
  /** Why no host is started on the machine just now (the person stopped it there, or the link's limit), or null */
  startHeldBack(id: string): string | null
  setAutoReconnect(id: string, autoReconnect: boolean): MachineInfo
  install(id: string): Promise<{ machine: MachineInfo; current: { version: string }; note?: string }>
  update(id: string): Promise<{ machine: MachineInfo; current: { version: string }; note?: string }>
  autostart(id: string, on?: boolean): Promise<{ machine: MachineInfo; autostart: { on: boolean; how: string | null; linger: boolean | null } }>
  /** Why an install or update would be refused before it starts, or null (`LinkedMachine.operationRefusal`) */
  installRefusal(id: string, kind: 'install' | 'update'): string | null
}

export type { MachineRequest }

export type MachineAnswer = { ok: true; text: string } | { ok: false; error: string }

/** What the machine commands reach of the session manager: its cards */
export type MachineFlowHost = Pick<HostCards, 'askHost'>

/** A linked machine's status in words (#1220); a status this build does not name reads as itself */
const MACHINE_STATUS: Record<string, string> = {
  connected: 'connected',
  connecting: 'connecting',
  starting: 'connecting (starting Centralu there)',
  updating: 'updating Centralu there',
  unreachable: 'unreachable',
  away: 'away (asleep, off or off the network)',
  disconnected: 'disconnected',
  not_running: 'unreachable (Centralu is not running there)',
  versions_differ: 'not connected (waiting for the person to align versions)',
  refused: 'not connected (it refused the link)',
  stopped: 'not connected (Centralu is stopped there; reconnecting starts it, with a card)',
}

/** The OS and shell the hub reaches a machine with, in words: PowerShell is Windows, WSL a distro on Windows */
function osOf(m: Pick<MachineInfo, 'shell' | 'wslDistro' | 'autostart'>): string {
  if (m.shell === 'powershell') return 'Windows, PowerShell'
  if (m.shell === 'wsl') return `Linux in WSL${m.wslDistro ? ` (${m.wslDistro})` : ''} on Windows`
  return m.autostart?.how === 'systemd' ? 'Linux, Unix shell' : 'macOS or Linux, Unix shell'
}

/**
 * One linked machine for list_machines (#1220) and every machine command's answer (#1219): its name as the person
 * gave it (quoted, since it is theirs), status, OS and shell, and whether it reconnects by itself (#1341).
 */
export function machineLine(m: MachineInfo): string {
  const connect = m.autoReconnect ? 'auto reconnect on' : 'auto reconnect off (only the person connects it again)'
  return `- ${trustedJsonText(m.name)} [${m.id}]: ${MACHINE_STATUS[m.status] ?? m.status}; ${osOf(m)}; ${connect}`
}

/** Why `machines.add` would refuse this target (links-registry.ts), said before anything runs */
/** Control and format characters (bidi overrides among them): a card or a list line would not show what they hide */
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u

/** Why a name or a distro the model gave cannot be shown honestly on a card, or null */
function hiddenError(what: string, value: string): string | null {
  return HIDDEN.test(value) ? `The ${what} has a control or formatting character in it; give it as plain text.` : null
}

function targetError(target: string): string | null {
  if (HIDDEN.test(target)) return hiddenError('ssh target', target)
  if (!target || target.startsWith('-') || /\s/.test(target) || target.length > 255) {
    return `Not an ssh target: ${JSON.stringify(target)}. Use a host alias from this computer's ~/.ssh/config, or user@host.`
  }
  return null
}

/**
 * The orchestrator's commands for linked machines (#1219): add (probed first), install or update Centralu there,
 * remove, reconnect, Auto reconnect, and whether it starts at boot. Each is the call the window's Machines screen
 * makes. What changes a machine or this computer's reach (add, install, update, remove, start at boot) waits for the
 * person's card, in every preset; reconnecting and Auto reconnect do not, as the row's buttons do not ask, except
 * that reconnecting a machine where Centralu is stopped starts it, which this computer does not do by itself (#1143),
 * and that undoing what the person chose asks too (#1341): reconnecting a machine they disconnected or turned Auto
 * reconnect off for, and turning Auto reconnect back on. Every
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
        case 'reconnect': {
          // Already connected: there is nothing to reconnect, so nothing is asked and nothing is done (#1341)
          if (m.status === 'connected') return done(`${m.name} is already connected; nothing was done.`, m)
          /*
           * Held back there (#1143): stopped by the person, or after the hosts this computer started kept stopping.
           * Starting one is the person's to allow, so it is asked whatever the row says just now (it reads the line again,
           * or the machine is asleep); without the card the link is only opened, and starts nothing it would not
           */
          const held = ops.startHeldBack(m.id)
          if (held) {
            const refused = await this.ask(
              sessionId,
              `Start Centralu on ${m.name} (${m.sshTarget})? ${held} It runs there in the background until it is stopped again.`,
              signal,
            )
            if (refused) return { ok: false, error: refused }
            return done(`Starting Centralu on ${m.name}.`, ops.reconnect(m.id))
          }
          /*
           * Reconnecting what the person chose not to have connected by itself is theirs to allow (#1341): they disconnected it
           * (only `machines.disconnect` leaves a machine `disconnected`), or turned its Auto reconnect off. A machine whose
           * switch is on that is away on its own is reconnected with no card, as the row's button does
           */
          if (m.status === 'disconnected' || !m.autoReconnect) {
            const why = m.status === 'disconnected' ? 'You disconnected it' : 'You turned its Auto reconnect off'
            const refused = await this.ask(
              sessionId,
              `Connect ${m.name} (${m.sshTarget})? ${why}, so nothing here connects it by itself. It connects over ssh with your keys ` +
                (m.status === 'disconnected' ? 'and stays connected until you disconnect it again.' : 'now; after a drop it stays away until you connect it again.'),
              signal,
            )
            if (refused) return { ok: false, error: refused }
          }
          return done(`Reconnecting ${m.name}.`, ops.reconnect(m.id, { start: false }))
        }
        case 'auto_reconnect':
          // Turning it back on undoes the person's choice (#1341): asked. Turning it off, or on where it already is, is not
          if (req.on && !m.autoReconnect) {
            const refused = await this.ask(
              sessionId,
              `Turn Auto reconnect back on for ${m.name} (${m.sshTarget})? You turned it off. With it on, this computer connects to it over ssh with your ` +
                'keys when Centralu starts and again after every drop, without asking.',
              signal,
            )
            if (refused) return { ok: false, error: refused }
          }
          return done(
            req.on
              ? `${m.name} now reconnects by itself, when Centralu starts and after every drop.`
              : `${m.name} no longer reconnects by itself: after a drop only the person's Connect brings it back, and nothing here connects it.`,
            ops.setAutoReconnect(m.id, req.on),
          )
        case 'remove': {
          const refused = await this.ask(
            sessionId,
            `Remove the linked machine ${m.name} (${m.sshTarget})? Its sessions and projects leave this computer's lists, and what this computer let ` +
              `its sessions ask is forgotten. Nothing on ${m.name} changes: its sessions keep running there, and adding it again lists them again.`,
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
   * add_machine (#1219; the security review of #1238): nothing connects before the person allows it. The target is
   * checked and resolved with `ssh -G` (no connection, no key loaded), and the card shows what ssh would reach: host,
   * user, port, and a proxy when one is set. After Allow, one BatchMode ssh probes what runs there; a target that does
   * not answer, or runs nothing this computer can link, is linked nowhere and the answer says why, with no second card.
   * The shell follows what answered, as the Add machine dialog's rows do: a Unix shell, Windows (PowerShell), or a WSL
   * distro of that Windows when one is named.
   */
  private async add(ops: MachineOps, sessionId: string, req: Extract<MachineRequest, { action: 'add' }>, signal?: AbortSignal): Promise<MachineAnswer> {
    const target = req.sshTarget.trim()
    const bad = hiddenError('ssh target', req.sshTarget) ?? targetError(target) ?? hiddenError('name', req.name ?? '') ?? hiddenError('WSL distro', req.wslDistro ?? '')
    if (bad) return { ok: false, error: bad }
    const distro = req.wslDistro?.trim() || null
    const name = (req.name?.trim() || `${target.replace(/^.*@/, '')}${distro ? ` ${distro}` : ''}`).slice(0, 64)
    const sameName = (list: MachineInfo[]) => list.find((m) => m.name.toLowerCase() === name.toLowerCase())
    if (sameName(ops.list())) return { ok: false, error: `A linked machine is already called ${name}; give another name.` }
    const to = await ops.resolve(target)
    if (to.error) return { ok: false, error: `ssh could not read where ${target} goes: ${to.error}. Nothing was linked.` }
    const reach = [
      `${to.user ? `${to.user}@` : ''}${to.hostName ?? target}${to.port ? `, port ${to.port}` : ''}`,
      to.proxyJump ? `through ProxyJump ${to.proxyJump}` : null,
      to.proxyCommand ? `through ProxyCommand ${to.proxyCommand}` : null,
    ].filter(Boolean)
    const refused = await this.ask(
      sessionId,
      `Link ${target} as the machine ${name}${distro ? ` (its WSL distro ${distro})` : ''}? ssh resolves it to ${reach.join(', ')}. ` +
        'Once you allow it, this computer connects there with your ssh keys, first to see what runs there, then to keep the link: it runs ' +
        "`centralu serve --connection` and starts the Centralu installed there when none is running. Its sessions and projects join this computer's " +
        'lists, and agents here can work on it. Nothing is installed: that is a separate question.',
      signal,
    )
    if (refused) return { ok: false, error: refused }
    const probe = await ops.probe(target)
    if (!probe.reachable) return { ok: false, error: `${target} did not answer over ssh${probe.error ? `: ${probe.error}` : ''}. Nothing was linked.` }
    if (!probe.os) return { ok: false, error: `Could not tell what runs on ${target}, so nothing was linked; the person can add it from Settings, Machines, choosing what it runs.` }
    let shell: RemoteShell
    let wslDistro: string | null = null
    if (probe.os === 'posix') {
      if (distro) return { ok: false, error: `${target} runs a Unix shell, not Windows, so it has no WSL distro; nothing was linked.` }
      shell = 'posix'
    } else if (distro) {
      const found = probe.wslDistros.find((d) => d.name.toLowerCase() === distro.toLowerCase())
      if (!found) return { ok: false, error: `${target} has no WSL distro ${distro}${probe.wslDistros.length ? `; it has ${probe.wslDistros.map((d) => d.name).join(', ')}` : ''}. Nothing was linked.` }
      shell = 'wsl'
      wslDistro = found.name
    } else {
      shell = 'powershell'
    }
    // Read again: the same machine may have been linked, or the name taken, while the card stood
    const now = ops.list()
    const same = now.find((m) => m.sshTarget === target && m.shell === shell && (shell !== 'wsl' || (m.wslDistro ?? '').toLowerCase() === (wslDistro ?? '').toLowerCase()))
    if (same) return { ok: false, error: `${target} is already linked that way, as ${same.name}, so nothing more was linked.` }
    const taken = sameName(now)
    if (taken) return { ok: false, error: `${taken.name} was linked while the card stood, so nothing more was linked.` }
    return done(`Linked ${target} as ${name} (${osOf({ shell, wslDistro, autostart: null })}).`, ops.add({ name, sshTarget: target, shell, wslDistro }))
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
