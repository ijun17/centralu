import type { MachineInfo, MachineSide, MachineStatus, MachineVersions, NormalizedEvent } from '@cc/protocol'
import { newMachineId, splitQualified } from './machine-ids.js'
import { Qualifier } from './qualifier.js'
import { RemoteClient, type RemoteClientOptions, type RemoteHello } from './remote-client.js'
import type { RoutedMachine } from './router.js'
import type { Endpoint, RemoteSpec, Tunnel } from './tunnel.js'
import { acceptanceKey, compareVersions, mayConnect } from './versions.js'

/**
 * The hub's links to other machines (docs/plans/remote-hub.md §2, §5): one `LinkedMachine` per
 * machine the person linked, each with its transport (`Tunnel`), its connection (`RemoteClient`),
 * its own cursor and epoch, and the headers mirror that answers for it while it is away.
 */

/** One linked machine as the registry keeps it (store: `linked_machines`) */
export type MachineRecord = {
  id: string
  name: string
  sshTarget: string
  /** The remote's shell, and what runs in place of `centralu` there (tunnel.ts) */
  remote: RemoteSpec
  /** The machine's number for folding numeric ids (machine-ids.ts). Never reused while the row exists */
  slot: number
  addedAt: number
  /** The version pair the person chose to connect without aligning, if any (versions.ts) */
  acceptedVersions: string | null
}

export interface MachineRegistry {
  list(): MachineRecord[]
  add(record: Omit<MachineRecord, 'slot'>): MachineRecord
  remove(id: string): void
  setAcceptedVersions(id: string, key: string | null): void
}

/**
 * What the hub last heard from a machine, for when it cannot ask (mirror.ts): the session and
 * project headers in the remote's own terms, never a conversation.
 */
export interface HeadersMirror {
  read(machine: string, kind: 'sessions' | 'projects'): unknown[] | null
  replace(machine: string, kind: 'sessions' | 'projects', list: unknown[]): void
  upsertSession(machine: string, session: Record<string, unknown>): void
  patchSession(machine: string, sessionId: string, patch: Record<string, unknown>): void
  removeSession(machine: string, sessionId: string): void
  forget(machine: string): void
}

export type LinkDeps = {
  hub: MachineSide
  /** Into the hub's own event log, under the hub's sequence numbers */
  broadcast: (event: NormalizedEvent) => void
  /** Into the hub's own terminal lane */
  terminal: (frame: { terminalId: string; data?: string; exitCode?: number | null }) => void
  mirror: HeadersMirror
  registry: MachineRegistry
  tunnelFor: (record: MachineRecord) => Tunnel
  log?: (line: string) => void
  /** For tests: the client's options beyond url and token */
  client?: Partial<RemoteClientOptions>
  /** Backoff between attempts while a machine is away; doubles up to the second value */
  retryMs?: [number, number]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A session the hub does not show: the remote's orchestrator and its coordinators (§3.4) */
function hiddenKind(s: unknown): boolean {
  return isObj(s) && (s.kind === 'orchestrator' || s.kind === 'coordinator')
}

export class LinkedMachine implements RoutedMachine {
  readonly q: Qualifier
  private status: MachineStatus = 'connecting'
  private error: string | null = null
  private versions: MachineVersions | null = null
  private lastConnectedAt: number | null = null
  private endpoint: Endpoint | null = null
  private client: RemoteClient | null = null
  /** Sessions of the remote the hub shows / hides, by the remote's id. Events of any other session are not passed on */
  private shown = new Set<string>()
  private hidden = new Set<string>()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private attempt = 0
  private stopped = false
  private opening: Promise<void> | null = null
  /** A refusal was already answered by asking the remote again; the next one is reported and backed off */
  private refusedOnce = false

  constructor(
    private record: MachineRecord,
    private readonly tunnel: Tunnel,
    private readonly deps: LinkDeps,
  ) {
    this.q = new Qualifier(record.id, record.slot)
    for (const s of deps.mirror.read(record.id, 'sessions') ?? []) this.classify(s)
    tunnel.onDown((reason) => this.transportDown(reason))
  }

  get id(): string {
    return this.record.id
  }
  get name(): string {
    return this.record.name
  }
  get reachable(): boolean {
    return this.status === 'connected' && this.client?.connected === true
  }

  info(): MachineInfo {
    return {
      id: this.record.id,
      name: this.record.name,
      sshTarget: this.record.sshTarget,
      shell: this.record.remote.shell,
      wslDistro: this.record.remote.wslDistro ?? null,
      command: this.record.remote.command ?? null,
      status: this.status,
      error: this.error,
      versions: this.versions,
      lastConnectedAt: this.lastConnectedAt,
      localPort: this.endpoint && this.endpoint.localPort > 0 ? this.endpoint.localPort : null,
      sameLocalPort: this.endpoint ? this.endpoint.localPort === this.endpoint.line.port : false,
    }
  }

  // ── RoutedMachine ───────────────────────────────────────────────────────────────────────

  call(method: string, params: unknown): Promise<unknown> {
    if (!this.client) return Promise.reject(Object.assign(new Error(`${this.name} is not reachable right now`), { code: 'internal', retryable: true }))
    return this.client.call(method, params)
  }

  lastKnown(kind: 'sessions' | 'projects'): unknown[] | null {
    return this.deps.mirror.read(this.id, kind)
  }

  observe(kind: 'sessions' | 'projects', list: unknown[]): void {
    if (kind === 'sessions') {
      this.shown.clear()
      this.hidden.clear()
      for (const s of list) this.classify(s)
      this.deps.mirror.replace(this.id, 'sessions', list.filter((s) => !hiddenKind(s)))
    } else {
      this.deps.mirror.replace(this.id, 'projects', list)
    }
  }

  hides(session: unknown): boolean {
    return hiddenKind(session)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false
    void this.open()
  }

  /** Opens again now, forgetting the backoff (`machines.reconnect`, or the person accepted the versions) */
  reconnect(): void {
    clearTimeout(this.retryTimer)
    this.attempt = 0
    void this.open()
  }

  /** The person chose to connect without aligning versions (plan §4); only meaningful when compatible */
  acceptVersions(): void {
    if (!this.versions?.compatible) return
    const key = acceptanceKey(this.versions.hub, this.versions.remote)
    this.deps.registry.setAcceptedVersions(this.id, key)
    this.record = { ...this.record, acceptedVersions: key }
    this.versions = { ...this.versions, accepted: true }
    this.reconnect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.client?.close()
    this.client = null
    await this.tunnel.close()
  }

  private open(): Promise<void> {
    this.opening ??= this.doOpen().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async doOpen(): Promise<void> {
    if (this.stopped) return
    this.client?.close()
    this.client = null
    this.setStatus('connecting', null)
    let endpoint: Endpoint
    try {
      endpoint = await this.tunnel.open()
    } catch (err) {
      this.setStatus('unreachable', (err as Error).message)
      return this.retryLater()
    }
    if (this.stopped) return
    this.endpoint = endpoint
    if (!endpoint.line.hostRunning) {
      this.setStatus('not_running', `Centralu is installed on ${this.name}, but no \`centralu serve\` is running there`)
      return this.retryLater()
    }
    // The versions are checked before the link is opened (plan §4)
    const versions = this.check({ version: endpoint.line.version, protocolVersion: endpoint.line.protocolVersion, dev: false })
    if (!mayConnect(versions)) return
    this.connectClient(endpoint)
  }

  /** Records the versions, and holds the link at `versions_differ` when they do not allow connecting */
  private check(remote: MachineSide): MachineVersions {
    const pending = compareVersions(this.deps.hub, remote, false)
    const accepted = this.record.acceptedVersions === acceptanceKey(pending.hub, pending.remote)
    const v = compareVersions(this.deps.hub, remote, accepted)
    this.versions = v
    if (!mayConnect(v)) {
      this.client?.close()
      this.client = null
      const which = v.older === 'hub' ? 'this computer' : v.older === 'remote' ? this.name : null
      this.setStatus(
        'versions_differ',
        !v.compatible
          ? `${this.name} runs Centralu ${v.remote.version} (protocol ${v.remote.protocolVersion}); this computer runs ${v.hub.version} (protocol ${v.hub.protocolVersion}). Update ${which ?? 'one side'} to connect`
          : `${this.name} runs Centralu ${v.remote.version}; this computer runs ${v.hub.version}${which ? `. Update ${which}, or connect anyway` : ''}`,
      )
      // A later update on either side is noticed by asking again now and then (§4: the prompt comes again)
      this.retryLater(60_000)
    }
    return v
  }

  private connectClient(endpoint: Endpoint): void {
    const client = new RemoteClient(
      { ...this.deps.client, url: endpoint.url, token: endpoint.token },
      {
        hello: (h) => void this.onHello(client, h),
        event: (e) => this.onEvent(e),
        terminal: (f) => this.deps.terminal({ ...f, terminalId: this.q.id(f.terminalId) }),
        down: (reason) => {
          if (this.client !== client) return
          this.setStatus('unreachable', `The link to ${this.name} dropped (${reason}); reconnecting`)
        },
        refused: (r) => {
          if (this.client !== client) return
          /*
           * 4002: another protocol after all (the remote restarted on another build). 4001: a token
           * the remote no longer takes (`--rotate-token`). Either way the connection line is read
           * again at once, which carries the running host's versions and the current token. A
           * second refusal in a row is reported and backed off: a running `serve` keeps its old
           * token until it restarts, while `--connection` already prints the new one, and asking
           * again at once would loop.
           */
          const why = r.code === 4002 ? (r.error?.message ?? 'The remote host speaks another protocol') : `${this.name} refused the link's token`
          if (!this.refusedOnce) {
            this.refusedOnce = true
            this.setStatus('connecting', why)
            return this.retryLater(0)
          }
          this.setStatus('refused', `${why}. If its token was rotated, restart \`centralu serve\` there`)
          this.retryLater()
        },
      },
    )
    this.client = client
    client.connect()
  }

  private async onHello(client: RemoteClient, h: RemoteHello): Promise<void> {
    if (this.client !== client) return
    // The host that answered may not be the one the connection line described (restarted since)
    if (h.build) {
      const v = this.check({ version: h.build.version ?? this.versions?.remote.version ?? 'unknown', protocolVersion: h.build.protocolVersion, dev: h.build.commit === 'dev' })
      if (!mayConnect(v)) return
    }
    try {
      const [sessions, projects] = await Promise.all([client.call('sessions.list', {}), client.call('projects.list', {})])
      if (Array.isArray(sessions)) this.observe('sessions', sessions)
      if (Array.isArray(projects)) this.observe('projects', projects)
    } catch (err) {
      this.deps.log?.(`[links] ${this.name}: could not read its lists after connecting: ${(err as Error).message}`)
    }
    if (this.client !== client) return
    this.attempt = 0
    this.refusedOnce = false
    this.lastConnectedAt = Date.now()
    this.setStatus('connected', null)
    /*
     * The UI re-reads this machine's sessions and projects, and wakes the ones that were live
     * before and are not now (a remote host that restarted without a keeper). Sent on every
     * connect, replay or not: the UI read the mirror while the link was away, marked unreachable.
     */
    this.deps.broadcast({ type: 'machine_resync', machineId: this.id })
  }

  private onEvent(raw: unknown): void {
    if (!isObj(raw)) return
    const sid = typeof raw.sessionId === 'string' ? raw.sessionId : null
    if (sid !== null) {
      if (raw.type === 'session_created') {
        this.classify(raw.session)
        if (isObj(raw.session) && !hiddenKind(raw.session)) this.deps.mirror.upsertSession(this.id, raw.session)
      }
      if (!this.shown.has(sid)) return
      if (raw.type === 'session_deleted') {
        this.shown.delete(sid)
        this.deps.mirror.removeSession(this.id, sid)
      } else if (raw.type === 'session_title' && typeof raw.title === 'string') {
        this.deps.mirror.patchSession(this.id, sid, { name: raw.title })
      } else if (raw.type === 'state_change' && typeof raw.state === 'string') {
        this.deps.mirror.patchSession(this.id, sid, { state: raw.state })
      }
    }
    const out = this.q.event(raw)
    if (out) this.deps.broadcast(out as NormalizedEvent)
  }

  private classify(s: unknown): void {
    if (!isObj(s) || typeof s.id !== 'string') return
    if (hiddenKind(s)) this.hidden.add(s.id)
    else this.shown.add(s.id)
  }

  private transportDown(reason: string): void {
    if (this.stopped) return
    this.client?.close()
    this.client = null
    this.setStatus('unreachable', `The connection to ${this.name} ended (${reason}); reconnecting`)
    this.retryLater()
  }

  private retryLater(fixedMs?: number): void {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    const [first, max] = this.deps.retryMs ?? [2_000, 60_000]
    const delay = fixedMs ?? Math.min(max, first * 2 ** this.attempt++)
    this.retryTimer = setTimeout(() => void this.open(), delay)
    this.retryTimer.unref?.()
  }

  private setStatus(status: MachineStatus, error: string | null): void {
    const changed = status !== this.status || error !== this.error
    this.status = status
    this.error = error
    if (changed) {
      if (error) this.deps.log?.(`[links] ${this.name}: ${status}: ${error}`)
      this.deps.broadcast({ type: 'machine_status', machine: this.info() })
    }
  }
}

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
  knowsSession(id: string): boolean {
    const split = splitQualified(id)
    const m = split ? this.machines.get(split.machine) : undefined
    return !!m && (m.lastKnown('sessions') ?? []).some((s) => isObj(s) && s.id === split!.id)
  }

  add(spec: { name: string; sshTarget: string; shell?: RemoteSpec['shell']; wslDistro?: string | null; command?: string | null }): MachineInfo {
    const trimmed = { name: spec.name.trim(), sshTarget: spec.sshTarget.trim() }
    const remote: RemoteSpec = { shell: spec.shell ?? 'posix', wslDistro: spec.wslDistro?.trim() || null, command: spec.command?.trim() || null }
    if (remote.shell === 'wsl' && !remote.wslDistro) throw Object.assign(new Error('A WSL machine needs the distro name (`wsl.exe -l -v` lists them)'), { code: 'internal' })
    if (remote.command && /[\r\n]/.test(remote.command)) throw Object.assign(new Error('The remote command must be one line'), { code: 'internal' })
    if (!trimmed.name) throw Object.assign(new Error('A machine needs a name'), { code: 'internal' })
    if (!trimmed.sshTarget || trimmed.sshTarget.startsWith('-') || /\s/.test(trimmed.sshTarget)) {
      throw Object.assign(new Error('Not an ssh target: use a host alias from ~/.ssh/config, or user@host'), { code: 'internal' })
    }
    const record = this.deps.registry.add({ id: newMachineId(trimmed.name, new Set(this.machines.keys())), ...trimmed, remote, addedAt: Date.now(), acceptedVersions: null })
    return this.startOne(record).info()
  }

  reconnect(id: string): MachineInfo {
    const m = this.need(id)
    m.reconnect()
    return m.info()
  }

  acceptVersions(id: string): MachineInfo {
    const m = this.need(id)
    if (m.info().versions?.compatible === false) {
      throw Object.assign(new Error('The two sides speak different protocols; one of them has to be updated first'), { code: 'internal' })
    }
    m.acceptVersions()
    return m.info()
  }

  private need(id: string): LinkedMachine {
    const m = this.machines.get(id)
    if (!m) throw Object.assign(new Error(`No linked machine ${id}`), { code: 'internal' })
    return m
  }

  async remove(id: string): Promise<void> {
    const m = this.machines.get(id)
    if (!m) throw Object.assign(new Error(`No linked machine ${id}`), { code: 'internal' })
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
