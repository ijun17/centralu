import type {
  HostActivity,
  MachineAutostartResult,
  MachineInfo,
  MachineInstallResult,
  MachineProbe,
  MachineUninstallResult,
  SshHostList,
} from '@cc/protocol'
import { probeTarget } from './probe.js'
import { listSshHosts, resolveAlias, type ResolvedHost } from './ssh-config.js'
import { newMachineId, splitQualified } from './machine-ids.js'
import { wslDistroError, type RemoteSpec } from './tunnel.js'
import { isObj } from '../json-value.js'
import { rpcError } from '../rpc-error.js'
import type { LinkDeps, MachineRecord } from './link-deps.js'
import { LinkedMachine } from './linked-machine-ops.js'

/** The hub's machines, each a `LinkedMachine` (links.ts) */

/** Every link of this hub, and the registry they come from */
export class Links {
  private machines = new Map<string, LinkedMachine>()

  constructor(private readonly deps: LinkDeps) {}

  /** Starts a link for every machine in the registry. Auto reconnect (#1341) decides what happens after the first attempt */
  start(): void {
    for (const record of this.deps.registry.list()) this.startOne(record)
  }

  all(): LinkedMachine[] {
    return [...this.machines.values()]
  }

  get(id: string): LinkedMachine | undefined {
    return this.machines.get(id)
  }

  list(): MachineInfo[] {
    return this.all().map((m) => m.info())
  }

  /** Whether a qualified id names a session the hub has heard of on a linked machine (grid panels, #82) */
  /** The linked machine a qualified project id is on, when the hub's mirror knows that project (grid panels of its apps) */
  projectMachine(id: string): string | null {
    const split = splitQualified(id)
    const m = split ? this.machines.get(split.machine) : undefined
    return m && (m.lastKnown('projects') ?? []).some((p) => isObj(p) && p.id === split!.id) ? m.id : null
  }

  /** Whether a machine id is one the person linked */
  linked(machine: string): boolean {
    return this.machines.has(machine)
  }

  knowsSession(id: string): boolean {
    const split = splitQualified(id)
    const m = split ? this.machines.get(split.machine) : undefined
    return !!m && (m.lastKnown('sessions') ?? []).some((s) => isObj(s) && s.id === split!.id)
  }

  add(spec: { name: string; sshTarget: string; shell?: RemoteSpec['shell']; wslDistro?: string | null; command?: string | null }): MachineInfo {
    const trimmed = { name: spec.name.trim(), sshTarget: spec.sshTarget.trim() }
    const remote: RemoteSpec = { shell: spec.shell ?? 'posix', wslDistro: spec.wslDistro?.trim() || null, command: spec.command?.trim() || null }
    if (remote.shell === 'wsl' && !remote.wslDistro) throw rpcError('A WSL machine needs the distro name (`wsl.exe -l -v` lists them)')
    // Refused here, by the rule every WSL command applies: stored, it failed every connect and was retried for good
    const badDistro = remote.shell === 'wsl' ? wslDistroError(remote.wslDistro) : null
    if (badDistro) throw rpcError(`${badDistro}; a distro's name is letters, digits, '.', '_' and '-' (\`wsl.exe -l -v\` lists the ones there)`)
    if (remote.command && /[\r\n]/.test(remote.command)) throw rpcError('The remote command must be one line')
    if (!trimmed.name) throw rpcError('A machine needs a name')
    if (!trimmed.sshTarget || trimmed.sshTarget.startsWith('-') || /\s/.test(trimmed.sshTarget)) {
      throw rpcError('Not an ssh target: use a host alias from ~/.ssh/config, or user@host')
    }
    const record = this.deps.registry.add({ id: newMachineId(trimmed.name, new Set(this.machines.keys())), ...trimmed, remote, addedAt: Date.now(), acceptedVersions: null })
    return this.startOne(record).info()
  }

  /**
   * The hosts of the person's ssh config (#514), each with the machines already linked through it: the
   * same alias, typed exactly so (an alias is what `machines.add` stores as the target)
   */
  async sshHosts(): Promise<SshHostList> {
    const read = await listSshHosts(this.deps.ssh ?? {})
    const linked = this.list()
    return {
      configFile: read.configFile,
      notes: read.notes,
      hosts: read.hosts.map((h) => ({
        alias: h.alias,
        hostName: h.hostName,
        user: h.user,
        port: h.port,
        source: `${h.file}:${h.line}`,
        linked: linked.filter((m) => m.sshTarget === h.alias).map((m) => ({ machineId: m.id, name: m.name, shell: m.shell, wslDistro: m.wslDistro })),
      })),
    }
  }

  /**
   * What ssh would connect to for a target (`ssh -G`, which opens no connection and loads no key): the orchestrator's
   * add_machine card shows it before anything connects (#1219)
   */
  resolve(sshTarget: string): Promise<ResolvedHost> {
    return resolveAlias(sshTarget, this.deps.ssh ?? {})
  }

  /** One BatchMode ssh to tell what runs there (probe.ts); the target need not be linked or in the config */
  probe(sshTarget: string): Promise<MachineProbe> {
    return probeTarget(sshTarget, this.deps.ssh ?? {})
  }

  /** The row's Reconnect, and Connect for a disconnected machine (#1134); with Auto reconnect off (#1341) the only way to try again */
  reconnect(id: string, opts: { start?: boolean } = {}): MachineInfo {
    const m = this.need(id)
    m.connect(opts)
    return m.info()
  }

  /** Why no host is started on the machine just now, or null (#1143): what the orchestrator's card is gated on */
  startHeldBack(id: string): string | null {
    return this.need(id).startHeldBack
  }

  /** The row's Disconnect (#1134): the link closes and none is tried; the machine and its lists stay */
  async disconnect(id: string): Promise<MachineInfo> {
    const m = this.need(id)
    const op = m.info().operation
    if (op) throw rpcError(`${m.name} is busy with ${op.kind}; disconnect it once that is done`)
    await m.disconnect('disconnected by the person')
    return m.info()
  }

  /** Auto reconnect on or off for the machine's link (#1341), kept with the machine */
  setAutoReconnect(id: string, autoReconnect: boolean): MachineInfo {
    const m = this.need(id)
    this.deps.registry.setAutoReconnect(id, autoReconnect)
    m.setAutoReconnect(autoReconnect)
    return m.info()
  }

  /**
   * `machines.need`, said by a window of the older connect mode (#1134): nothing connects a machine on a need any more
   * (#1341), so this answers the row as it is. Accepted for one release so an older window does not fail
   */
  needs(id: string): MachineInfo {
    return this.need(id).info()
  }

  acceptVersions(id: string): MachineInfo {
    const m = this.need(id)
    if (m.info().versions?.compatible === false) {
      throw rpcError('The two sides speak different protocols; one of them has to be updated first')
    }
    m.acceptVersions()
    return m.info()
  }

  /** Why installing on or updating the machine would be refused before it starts, or null (#1219) */
  installRefusal(id: string, kind: 'install' | 'update'): string | null {
    return this.need(id).operationRefusal(kind)
  }

  install(id: string): Promise<MachineInstallResult> {
    return this.active(id).install()
  }

  update(id: string): Promise<MachineInstallResult> {
    return this.active(id).update()
  }

  rollback(id: string): Promise<MachineInstallResult> {
    return this.active(id).rollback()
  }

  uninstall(id: string): Promise<MachineUninstallResult> {
    return this.active(id).uninstall()
  }

  autostart(id: string, on?: boolean): Promise<MachineAutostartResult> {
    return this.active(id).autostart(on)
  }

  activity(id: string): Promise<HostActivity | null> {
    return this.need(id).activity()
  }

  /** That machine's "Allow auto from a linked computer", read or set over the link (#1273 review) */
  hubAuto(id: string, allowed?: boolean): Promise<'on' | 'off' | 'older' | 'unreachable'> {
    return this.need(id).hubAuto(allowed)
  }

  /** Tells every connected machine this hub's auto-compact setting (#1376) */
  async offerAutoCompact(): Promise<void> {
    await Promise.all([...this.machines.values()].map((m) => m.offerAutoCompact()))
  }

  /** The reverse direction's switch for one machine (#550) */
  async setAsks(id: string, on: boolean): Promise<MachineInfo> {
    const m = this.need(id)
    await m.setAsks(on)
    return m.info()
  }

  private need(id: string): LinkedMachine {
    const m = this.machines.get(id)
    if (!m) throw rpcError(`No linked machine ${id}`)
    return m
  }

  /**
   * The machine, connected first when it was disconnected (#1134): what the person asks of it runs over its ssh, which
   * the link closed, and an update waits for the new host's hello on the link
   */
  private active(id: string): LinkedMachine {
    const m = this.need(id)
    m.openForOperation()
    return m
  }

  async remove(id: string): Promise<void> {
    const m = this.machines.get(id)
    if (!m) throw rpcError(`No linked machine ${id}`)
    this.machines.delete(id)
    // Its sessions stop seeing this hub at once, while the link can still say so (#550)
    await m.withdrawOffer()
    await m.stop()
    this.deps.registry.remove(id)
    this.deps.mirror.forget(id)
    // Its sessions and projects leave the UI's lists
    this.deps.broadcast({ type: 'machine_resync', machineId: id })
  }

  async stop(): Promise<void> {
    await Promise.all(this.all().map((m) => m.stop()))
  }

  private startOne(record: MachineRecord): LinkedMachine {
    const m = new LinkedMachine(record, this.deps.tunnelFor(record), this.deps)
    this.machines.set(record.id, m)
    m.start()
    return m
  }
}
