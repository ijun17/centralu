import type { MachineAskConsent, MachineInfo, MachineProbe, SshHostList } from '@cc/protocol'
import type { ProjectStore } from './project-store.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** The linked machines (#82), behind the `machines` port */
export class MachinesMock {
  /**
   * Linked machines (#82). The mock reaches no machine: one added here stands as connected at once,
   * so a screen can be built against the shape; the real link's states come from two real hosts in
   * e2e (`e2e/fixtures/linked-hosts.ts`).
   */
  machinesList: MachineInfo[] = []
  /**
   * The ssh config the mock "reads" (#514): none by default, so the Add machine dialog opens on its
   * fields as before; a test or the demo sets hosts here, and what each answers to the probe in
   * `probeAnswers` (unreachable when absent). `linked` is filled from `machinesList` as the host fills it
   */
  sshConfig: SshHostList = { configFile: '~/.ssh/config', hosts: [], notes: [] }
  probeAnswers: Record<string, Omit<MachineProbe, 'sshTarget'>> = {}
  /**
   * The pairs approved for the reverse direction (#550): none until a test or the demo puts one here, as the mock
   * raises no card of a machine's session
   */
  askPairs: MachineAskConsent[] = []
  /** Every `machines.update` the window sent (#1399), in order, with when it asked the update to stop the host */
  updates: { machineId: string; when: 'idle' | 'now' }[] = []
  /** Each mock machine's "Allow auto from a linked computer" (#1273): on unless a test turned it off */
  hubAutoOff = new Set<string>()
  /**
   * How a Connect that finds the machine not connected ends (#1533): it stands as `connecting` for `afterMs`, then moves to
   * `status` with `error` (a failed attempt keeps its reason). Unset: the mock's old rule, a disconnected machine connects at
   * once and any other state stays as it is
   */
  reconnectPlan: { afterMs: number; status: MachineInfo['status']; error: string | null } | null = null
  machineRow(id: string, patch: Partial<MachineInfo>): MachineInfo {
    const at = this.machinesList.findIndex((m) => m.id === id)
    const current = this.machinesList[at]
    if (at === -1 || !current) throw mockError(`No linked machine ${id}`)
    const next = { ...current, ...patch }
    this.machinesList[at] = next
    this.emit({ type: 'machine_status', machine: { ...next } })
    return { ...next }
  }
  /** Installs or updates a mock machine to this mock's own version at once: no steps, nothing stops */
  private mockInstall(machineId: string, _kind: 'install' | 'update') {
    const m = this.machinesList.find((x) => x.id === machineId)
    const current = { version: m?.versions?.hub.version ?? '0.0.0', node: '24.21.0' }
    const previous = m?.install?.current ?? null
    const machine = this.machineRow(machineId, {
      status: 'connected',
      error: null,
      versions: m?.versions ? { ...m.versions, remote: m.versions.hub, older: null } : null,
      install: { managed: true, current, previous },
    })
    return { machine, current, previous, removed: [], left: [] }
  }
  readonly machines = {
    list: async () => this.machinesList.map((m) => ({ ...m })),
    add: async (spec: { name: string; sshTarget: string; shell: MachineInfo['shell']; wslDistro?: string | null; command?: string | null }) => {
      const base = spec.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 24) || 'machine'
      let id = base
      for (let n = 2; this.machinesList.some((m) => m.id === id); n++) id = `${base}-${n}`
      const info: MachineInfo = {
        id,
        name: spec.name,
        sshTarget: spec.sshTarget,
        shell: spec.shell,
        wslDistro: spec.wslDistro ?? null,
        command: spec.command ?? null,
        status: 'connected',
        error: null,
        versions: null,
        lastConnectedAt: Date.now(),
        nextAttemptAt: null,
        localPort: null,
        sameLocalPort: false,
        hostStarted: null,
        install: null,
        operation: null,
        autostart: { on: false, how: spec.shell === 'posix' ? 'systemd' : 'task', linger: null },
        elevated: null,
        // The reverse direction is off for a machine just linked (#550)
        asks: { on: false, note: null },
        logon: null,
        handover: null,
        autoReconnect: true,
        updateWaits: true,
        connect: 'at_start',
      }
      this.machinesList.push(info)
      this.emit({ type: 'machine_status', machine: { ...info } })
      return { ...info }
    },
    sshHosts: async (): Promise<SshHostList> => ({
      ...this.sshConfig,
      hosts: this.sshConfig.hosts.map((h) => ({
        ...h,
        linked: this.machinesList.filter((m) => m.sshTarget === h.alias).map((m) => ({ machineId: m.id, name: m.name, shell: m.shell, wslDistro: m.wslDistro })),
      })),
    }),
    probe: async (sshTarget: string): Promise<MachineProbe> => {
      const answer = this.probeAnswers[sshTarget]
      if (answer) return { sshTarget, ...answer }
      return { sshTarget, reachable: false, os: null, windowsShell: null, wslDistros: [], error: `ssh: Could not resolve hostname ${sshTarget}: nodename nor servname provided, or not known` }
    },
    remove: async (machineId: string) => {
      this.machinesList = this.machinesList.filter((m) => m.id !== machineId)
      this.askPairs = this.askPairs.filter((c) => c.machineId !== machineId)
      this.projectStore.list = this.projectStore.list.filter((p) => p.machine !== machineId)
      this.emit({ type: 'machine_resync', machineId })
    },
    reconnect: async (machineId: string) => {
      const was = this.machinesList.find((m) => m.id === machineId)?.status
      const plan = this.reconnectPlan
      if (plan && was !== undefined && was !== 'connected') {
        const row = this.machineRow(machineId, { status: 'connecting', error: null })
        setTimeout(() => {
          if (this.machinesList.some((m) => m.id === machineId)) this.machineRow(machineId, { status: plan.status, error: plan.error })
        }, plan.afterMs)
        return row
      }
      return this.machineRow(machineId, was === 'disconnected' ? { status: 'connected', error: null } : {})
    },
    /** The mock's link closes and opens at once (#1134): no ssh, no hold */
    disconnect: async (machineId: string) => this.machineRow(machineId, { status: 'disconnected', error: null }),
    setAutoReconnect: async (machineId: string, autoReconnect: boolean) =>
      this.machineRow(machineId, { autoReconnect, connect: autoReconnect ? 'at_start' : 'when_needed' }),
    acceptVersions: async (machineId: string) => {
      const v = this.machinesList.find((m) => m.id === machineId)?.versions
      if (v && !v.compatible) throw mockError('The two sides speak different protocols; one of them has to be updated first')
      return this.machineRow(machineId, { status: 'connected', error: null, versions: v ? { ...v, accepted: true } : null })
    },
    install: async (machineId: string) => this.mockInstall(machineId, 'install'),
    update: async (machineId: string, opts?: { when?: 'idle' | 'now' }) => {
      this.updates.push({ machineId, when: opts?.when ?? 'idle' })
      return this.mockInstall(machineId, 'update')
    },
    cancelUpdate: async (machineId: string) => this.machineRow(machineId, {}),
    rollback: async (machineId: string) => {
      const prev = this.machinesList.find((m) => m.id === machineId)?.install?.previous
      if (!prev) throw mockError('There is no earlier version installed there to go back to')
      const machine = this.machineRow(machineId, { status: 'versions_differ', install: { managed: true, current: prev, previous: null } })
      return { machine, current: prev, previous: null, removed: [], left: [] }
    },
    uninstall: async (machineId: string) => {
      const was = this.machinesList.find((m) => m.id === machineId)?.autostart ?? null
      const machine = this.machineRow(machineId, { status: 'not_running', install: { managed: false, current: null, previous: null }, autostart: was && { ...was, on: false, linger: null } })
      return { machine, stopped: true }
    },
    /** A mock machine takes the change at once; a systemd one lingers, as most would after `loginctl enable-linger` */
    autostart: async (machineId: string, on?: boolean) => {
      const was = this.machinesList.find((m) => m.id === machineId)?.autostart
      if (!was?.how) throw mockError('Starting Centralu at boot is offered on Linux and Windows')
      const autostart = on === undefined ? was : { ...was, on, linger: on && was.how === 'systemd' ? true : null }
      return { machine: this.machineRow(machineId, { autostart }), autostart }
    },
    activity: async () => ({ working: 1, approvals: 0, questions: 0, background: 0, terminals: 1, commandRuns: 0 }),
    hubAuto: async (machineId: string, allowed?: boolean) => {
      if (this.machinesList.find((m) => m.id === machineId)?.status !== 'connected') return 'unreachable' as const
      if (allowed !== undefined) {
        if (allowed) this.hubAutoOff.delete(machineId)
        else this.hubAutoOff.add(machineId)
      }
      return this.hubAutoOff.has(machineId) ? ('off' as const) : ('on' as const)
    },
    /** The switch takes at once; off forgets the machine's pairs, as the host does */
    setAsks: async (machineId: string, on: boolean) => {
      if (!on && this.askPairs.some((c) => c.machineId === machineId)) {
        this.askPairs = this.askPairs.filter((c) => c.machineId !== machineId)
        this.emit({ type: 'project_consents_changed' })
      }
      return this.machineRow(machineId, { asks: { on, note: null } })
    },
    askConsents: async () => this.askPairs.map((c) => ({ ...c })),
    withdrawAsk: async (machineId: string, sessionId: string, projectId: string) => {
      const before = this.askPairs.length
      this.askPairs = this.askPairs.filter((c) => !(c.machineId === machineId && c.sessionId === sessionId && c.projectId === projectId))
      if (this.askPairs.length !== before) this.emit({ type: 'project_consents_changed' })
    },
  }

  constructor(
    private readonly emit: Emit,
    private readonly projectStore: ProjectStore,
  ) {}
}
