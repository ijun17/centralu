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
import { listSshHosts } from './ssh-config.js'
import { newMachineId, splitQualified } from './machine-ids.js'
import type { RemoteSpec } from './tunnel.js'
import { isObj } from '../json-value.js'
import { rpcError } from '../rpc-error.js'
import type { LinkDeps, MachineRecord } from './link-deps.js'
import { LinkedMachine } from './linked-machine-ops.js'

export type { HeadersMirror, LinkDeps, LinkInstaller, MachineRecord, MachineRegistry } from './link-deps.js'
export { LinkedMachine } from './linked-machine-ops.js'

/**
 * The hub's links to other machines (docs/plans/remote-hub.md §2, §5): one `LinkedMachine` per
 * machine the person linked, each with its transport (`Tunnel`), its connection (`RemoteClient`),
 * its own cursor and epoch, and the headers mirror that answers for it while it is away.
 */

/** Every link of this hub, and the registry they come from */
export class Links {
  private machines = new Map<string, LinkedMachine>()

  constructor(private readonly deps: LinkDeps) {}

  /** Starts a link for every machine in the registry */
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

  /** One BatchMode ssh to tell what runs there (probe.ts); the target need not be linked or in the config */
  probe(sshTarget: string): Promise<MachineProbe> {
    return probeTarget(sshTarget, this.deps.ssh ?? {})
  }

  reconnect(id: string): MachineInfo {
    const m = this.need(id)
    m.reconnect()
    return m.info()
  }

  acceptVersions(id: string): MachineInfo {
    const m = this.need(id)
    if (m.info().versions?.compatible === false) {
      throw rpcError('The two sides speak different protocols; one of them has to be updated first')
    }
    m.acceptVersions()
    return m.info()
  }

  install(id: string): Promise<MachineInstallResult> {
    return this.need(id).install()
  }

  update(id: string): Promise<MachineInstallResult> {
    return this.need(id).update()
  }

  rollback(id: string): Promise<MachineInstallResult> {
    return this.need(id).rollback()
  }

  uninstall(id: string): Promise<MachineUninstallResult> {
    return this.need(id).uninstall()
  }

  autostart(id: string, on?: boolean): Promise<MachineAutostartResult> {
    return this.need(id).autostart(on)
  }

  activity(id: string): Promise<HostActivity | null> {
    return this.need(id).activity()
  }

  private need(id: string): LinkedMachine {
    const m = this.machines.get(id)
    if (!m) throw rpcError(`No linked machine ${id}`)
    return m
  }

  async remove(id: string): Promise<void> {
    const m = this.machines.get(id)
    if (!m) throw rpcError(`No linked machine ${id}`)
    this.machines.delete(id)
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
