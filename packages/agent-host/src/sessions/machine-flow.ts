import { errorMessage, MACHINE_CHANGE, turnsRunning, type HostActivity, type MachineInfo, type MachineProbe, type RemoteShell, type SshHostList } from '@cc/protocol'
import type { MachineRequest } from '../adapters/contract.js'
import type { DelegationHost } from './delegation-host.js'
import type { HostCards } from './host-cards.js'
import { plainQuoted, trustedJsonText } from './tool-answers.js'

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
  /** `when: 'idle'`: waits until no session there is in a turn before it stops the host (#1399), which can take hours */
  update(id: string, opts?: { when?: 'idle' | 'now' }): Promise<{ machine: MachineInfo; current: { version: string }; note?: string }>
  /** For tests: how long an install or update call is waited for before it is answered as still under way (`UPDATE_ANSWER_MS` when absent) */
  updateAnswerMs?: number
  autostart(id: string, on?: boolean): Promise<{ machine: MachineInfo; autostart: { on: boolean; how: string | null; linger: boolean | null } }>
  /** Why an install, update, rollback or uninstall would be refused before it starts, or null (`LinkedMachine.operationRefusal`) */
  installRefusal(id: string, kind: 'install' | 'update' | 'rollback' | 'uninstall'): string | null
  /** The row's Disconnect (#1134): the link closes and none is tried; the machine and its lists stay */
  disconnect(id: string): Promise<MachineInfo>
  /** Back to the version installed before, one step (`machines.rollback`) */
  rollback(id: string): Promise<{ machine: MachineInfo; current: { version: string }; note?: string }>
  /** Stops the host there and removes what this computer installed; the data stays (`machines.uninstall`) */
  uninstall(id: string): Promise<{ machine: MachineInfo; stopped: boolean }>
  /** What would stop there if its host stopped now; null when the machine cannot say (`machines.activity`) */
  activity(id: string): Promise<HostActivity | null>
  /** The aliases of the person's ssh config, each with the machines linked through it (`machines.sshHosts`) */
  sshHosts(): Promise<SshHostList>
}

export type { MachineRequest }

export type MachineAnswer = { ok: true; text: string } | { ok: false; error: string }

/** What the machine commands reach of the session manager: its cards */
export type MachineFlowHost = Pick<HostCards, 'askHost'> & Pick<DelegationHost, 'tellSession'>

/** Who a message from Centralu itself is from, in a session's conversation (as `agent-start-requests.ts`) */
const HOST_SENDER = '_centralu'

/** How long install_machine waits for the install or update before it answers that it is still under way (#1399) */
const UPDATE_ANSWER_MS = 200_000

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
      if (req.action === 'ssh_hosts') return await this.sshHosts(ops)
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
          /*
           * An update never stops a turn that runs there on the orchestrator's say (#1399): with sessions in a turn the card says so
           * and Allow means "update when idle". Forcing it is the person's, from Settings
           */
          const seen = req.action === 'update' ? await ops.activity(m.id).catch(() => null) : null
          const running = turnsRunning(seen)
          const refused = await this.ask(
            sessionId,
            req.action === 'install'
              ? `Install ${version} on ${m.name} (${m.sshTarget}, ${osOf(m)})? Over ssh it downloads Node and the npm packages there, checked against the ` +
                  "release's pins, beside what is installed. A Centralu running there keeps running until it next starts."
              : running > 0
                ? `Update ${m.name} (${m.sshTarget}, ${osOf(m)}) to ${version} when it is idle? ${running} ${running === 1 ? 'session is' : 'sessions are'} in a turn there, so the update ` +
                  `installs beside the running Centralu and waits until ${running === 1 ? 'it is' : 'they are'} done; it stops nothing before that, and the call is answered while it waits. Then it stops the Centralu there ` +
                  '(its agents end and resume on the new one), starts the new one, and puts the old one back if it does not answer in 30 s.'
                : seen
                  ? `Update ${m.name} (${m.sshTarget}, ${osOf(m)}) to ${version}? It installs beside the running one, stops the Centralu there (its agents end ` +
                    'and resume on the new one; no turn is running there now, and if one starts the update waits for it), starts the new one, and puts the old one back if it does not answer in 30 s.'
                  : `Update ${m.name} (${m.sshTarget}, ${osOf(m)}) to ${version}? It installs beside the running one, stops the Centralu there (its agents end ` +
                    'and resume on the new one; what runs there could not be read, so a turn in progress may be lost), starts the new one, and puts the old one back if it does not answer in 30 s.',
            signal,
          )
          if (refused) return { ok: false, error: refused }
          /*
           * Answered when it is done, or while it still runs (#1399): a wait for sessions can last hours, and a tool call that long is
           * cut by its caller (the Codex bridge at 280 s) while the update goes on unannounced. The update goes on; list_machines shows
           * it, and the person can cancel the wait from Settings
           */
          const run = req.action === 'install' ? ops.install(m.id) : ops.update(m.id, { when: 'idle' })
          const waited = ops.updateAnswerMs ?? UPDATE_ANSWER_MS
          const r = await Promise.race([run, new Promise<null>((resolve) => setTimeout(() => resolve(null), waited).unref?.())])
          if (!r) {
            // Answered as still under way (#1399 review): how it ends is told to the caller in its conversation, a failure too
            void run.then(
              (ended) => this.tellEnd(sessionId, `[Centralu] The ${req.action} of ${plainQuoted(m.name)} you started has finished: Centralu ${ended.current.version} is there.${ended.note ? ` ${ended.note}` : ''}`),
              (e: unknown) => this.tellEnd(sessionId, `[Centralu] The ${req.action} of ${plainQuoted(m.name)} you started did not finish: ${errorMessage(e).slice(0, 600)}`),
            )
            return done(
              `${req.action === 'install' ? 'Installing' : 'Updating'} ${m.name} is still under way${req.action === 'update' ? ' (it installs beside, then waits until no session there is in a turn, and stops none)' : ''}. ` +
                'It goes on without this call; list_machines shows where it stands. The person can cancel the wait in Settings, Machines.',
              ops.list().find((x) => x.id === m.id) ?? m,
            )
          }
          return done(`${req.action === 'install' ? 'Installed' : 'Updated to'} Centralu ${r.current.version} on ${m.name}.${r.note ? ` ${r.note}` : ''}`, r.machine)
        }
        case 'disconnect': {
          // The row's Disconnect does not ask. Undoing it does (reconnect above), so this only narrows what the person has connected
          if (m.status === 'disconnected') return done(`${plainQuoted(m.name)} is already disconnected; nothing was done.`, m)
          const disconnected = await ops.disconnect(m.id)
          return done(
            `Disconnected ${plainQuoted(m.name)}: the link is closed and nothing here connects it by itself. Its sessions and projects stay in the lists, as the last read left them. ` +
              "Connecting it again takes the person's card (reconnect_machine).",
            disconnected,
          )
        }
        case 'rollback': {
          const previous = m.install?.previous
          const nm = plainQuoted(m.name)
          if (!previous) return { ok: false, error: `There is no earlier version installed on ${nm} to go back to; an update puts the one it replaces there.` }
          const why = ops.installRefusal(m.id, 'rollback') ?? busyWith(m)
          if (why) return { ok: false, error: why }
          const was = m.install?.current?.version ?? m.versions?.remote.version
          const refused = await this.ask(
            sessionId,
            `Roll ${nm} (${m.sshTarget}, ${osOf(m)}) back to Centralu ${shownVersion(previous.version)}${was ? `, from ${shownVersion(was)}` : ''}? It stops the Centralu there (its agents end and resume on ` +
              'the older one; a turn in progress is lost), starts the older one, and puts the newer one back if it does not answer in 30 s. One step only: ' +
              `the version it leaves is not kept, so a second rollback is not offered.${reconnects(m)}`,
            signal,
          )
          if (refused) return { ok: false, error: refused }
          // The card named this machine as it was: versions, no other change under way, and what connecting it would do
          const now = stillAsCardSaid(ops, m)
          if (typeof now === 'string') return { ok: false, error: now }
          const r = await ops.rollback(m.id)
          return done(`Rolled back to Centralu ${shownVersion(r.current.version)} on ${nm}.${r.note ? ` ${plainQuoted(r.note, 300)}` : ''}`, r.machine)
        }
        case 'uninstall': {
          const installed = m.install?.current
          const nm = plainQuoted(m.name)
          if (!installed) return { ok: false, error: `Nothing this computer installed is on ${nm}, so there is nothing to uninstall.` }
          const why = ops.installRefusal(m.id, 'uninstall') ?? busyWith(m)
          if (why) return { ok: false, error: why }
          const refused = await this.ask(
            sessionId,
            `Uninstall Centralu from ${nm} (${m.sshTarget}, ${osOf(m)})? It stops the Centralu running there (its agents end; a turn in progress is lost) and removes what this ` +
              `computer installed there (Centralu ${shownVersion(installed.version)}${m.install?.previous ? ` and ${shownVersion(m.install.previous.version)}` : ''}, with the Node it runs on). Its sessions, projects and other data stay, and an npm ` +
              `install of its own is not touched. ${nm} stays linked, and is away until Centralu is installed or started there again.${reconnects(m)}`,
            signal,
          )
          if (refused) return { ok: false, error: refused }
          const now = stillAsCardSaid(ops, m)
          if (typeof now === 'string') return { ok: false, error: now }
          const r = await ops.uninstall(m.id)
          return done(`Removed what this computer installed on ${nm}${r.stopped ? ' and stopped the Centralu running there' : ''}. Its data stays.`, r.machine)
        }
        case 'activity': {
          const a = await ops.activity(m.id)
          if (!a) return { ok: true, text: `${m.name} cannot say what is running (it is not connected, speaks another protocol, or predates the question).` }
          const parts: string[] = []
          for (const [n, what] of [
            [a.working, 'sessions working'],
            [a.approvals, 'waiting on an approval'],
            [a.questions, 'asking a question'],
            [a.background, 'running background work'],
            [a.terminals, 'terminals open'],
            [a.commandRuns, 'commands running'],
          ] as const) {
            if (n > 0) parts.push(`${n} ${what}`)
          }
          return {
            ok: true,
            text: parts.length ? `On ${m.name}, an update or a restart would stop: ${parts.join(', ')}.` : `Nothing is running on ${m.name} that an update or a restart would stop.`,
          }
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

  /** The hosts of the person's ssh config, each with the machines linked through it: what add_machine can be given (#1219) */
  /** Tells the session that called, in its conversation (relayed, since an orchestrator only gets a pointer to a message that is not), how an update it was answered "still under way" for ended; never throws */
  private async tellEnd(sessionId: string, text: string): Promise<void> {
    await this.host.tellSession(sessionId, text, { sessionId: HOST_SENDER, name: 'Centralu' }, true).catch(() => undefined)
  }

  private async sshHosts(ops: MachineOps): Promise<MachineAnswer> {
    const list = await ops.sshHosts()
    // The config file's path and ssh's own notes can echo lines of the file: each is quoted
    const notes = list.notes.length ? ` ${list.notes.map((n) => plainQuoted(n, 300)).join(' ')}` : ''
    const file = plainQuoted(list.configFile, 300)
    if (!list.hosts.length) return { ok: true, text: `No host is named in ${file}.${notes} add_machine also takes user@host.` }
    const rows = list.hosts.map((h) => {
      const reach = `${h.user ? `${h.user}@` : ''}${h.hostName ?? h.alias}${h.port ? `:${h.port}` : ''}`
      const linked = h.linked.length ? `; linked as ${h.linked.map((l) => trustedJsonText(l.name)).join(', ')}` : ''
      return `- ${trustedJsonText(h.alias)}: ${trustedJsonText(reach)}${linked}`
    })
    return { ok: true, text: `Hosts in ${file} (pass an alias as sshTarget to add_machine):\n${rows.join('\n')}${notes ? `\n${notes.trim()}` : ''}` }
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

/** A version a machine reported, as one quoted line: it is the machine's own text, and a card or an answer must not read as something it does not say */
const shownVersion = (version: string): string => plainQuoted(version, 80)

/** Why an operation on a machine cannot start just now, when another one is under way there; known before any card */
function busyWith(m: MachineInfo): string | null {
  return m.operation ? `${plainQuoted(m.name)} is busy with ${m.operation.kind} (${m.operation.step}); try again once that is done.` : null
}

/**
 * The card's last words when the operation would connect a machine the person had it not connected (#1341): they disconnected
 * it, or turned its Auto reconnect off and it is down. The operation opens its link, and keeps it open afterwards
 * (`LinkedMachine.operate` reconnects whenever the link is not up), which undoes that choice
 */
function reconnects(m: MachineInfo): string {
  const nm = plainQuoted(m.name)
  if (m.status === 'disconnected') return ` ${nm} is disconnected: this connects it for the change, and it stays connected afterwards until you disconnect it again.`
  if (m.status !== 'connected' && !m.autoReconnect) {
    return ` ${nm} is not connected and its Auto reconnect is off, so nothing here connects it by itself: this connects it for the change, and it stays connected afterwards.`
  }
  return ''
}

/**
 * After Allow, the machine as it is now, or why it is no longer the one the card named (nothing is changed then): gone, its
 * installed versions moved (a rollback would go from a version the card did not name), another change under way, or a link
 * the person closed meanwhile that this would open again without the card having said so
 */
function stillAsCardSaid(ops: MachineOps, before: MachineInfo): MachineInfo | string {
  const nm = plainQuoted(before.name)
  const now = ops.list().find((x) => x.id === before.id)
  if (!now) return `${nm} was removed while the card stood, so nothing was changed.`
  const held = (m: MachineInfo) => `${m.install?.current?.version ?? ''}|${m.install?.previous?.version ?? ''}`
  if (held(now) !== held(before)) return `The versions Centralu keeps on ${nm} changed while the card stood, so it is not what the card named and nothing was changed. Ask again to show the person what it holds now.`
  const busy = busyWith(now)
  if (busy) return `${busy} Nothing was changed.`
  if (reconnects(now) && !reconnects(before)) {
    return `${nm} was disconnected, or lost its connection with Auto reconnect off, while the card stood. This would connect it again, which the card did not say, so nothing was changed. Ask again.`
  }
  return now
}

/** A command's answer: what it did, then the machine as it is now */
function done(text: string, machine: MachineInfo): MachineAnswer {
  return { ok: true, text: `${text}\nNow:\n${machineLine(machine)}` }
}
