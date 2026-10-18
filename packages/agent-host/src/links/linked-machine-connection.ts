import { isObj } from '../json-value.js'
import { rpcError } from '../rpc-error.js'
import type { MachineInfo, MachineOperation, MachineSide, MachineStatus, MachineVersions, NormalizedEvent } from '@cc/protocol'
import type { LinkDeps, MachineRecord } from './link-deps.js'
import { belowFloor, NodeTooOld } from './node-floor.js'
import { nodeFloor } from './install.js'
import { Qualifier } from './qualifier.js'
import { RemoteClient, type RemoteHello } from './remote-client.js'
import type { RoutedMachine } from './router.js'
import { shimNames, type Endpoint, type HostStart, type RemoteAutostart, type RemoteInstall, type Tunnel } from './tunnel.js'
import { acceptanceKey, compareVersions, mayConnect } from './versions.js'
import { parseHold, readHoldCommand, type SwapHold } from './swap-hold.js'

/**
 * A linked machine's connection (links.ts): its transport and client, the backoff, the version gate,
 * starting a host there, and the events and lists it relays. The install, update and autostart
 * operations and the activity probe are `LinkedMachine` (linked-machine-ops.ts), which extends this
 */

/** The connection line's `install`, as the row shows it; null when the remote did not say */
function installOf(i: RemoteInstall | undefined): MachineInfo['install'] {
  return i ? { managed: i.managed, current: i.current, previous: i.previous } : null
}

/** The connection line's `autostart`, as the row shows it; null when the remote did not say */
function autostartOf(a: RemoteAutostart | undefined): MachineInfo['autostart'] {
  return a ? { on: a.on, how: a.how, linger: a.linger } : null
}

/** A session the hub does not show: the remote's orchestrator and its coordinators (§3.4) */
function hiddenKind(s: unknown): boolean {
  return isObj(s) && (s.kind === 'orchestrator' || s.kind === 'coordinator')
}

/**
 * The backoff while a machine is away: from 2 s, doubling, up to 5 minutes (#1134). A laptop that is often closed, or
 * a server used once a week, cost an ssh attempt every minute at the earlier 1-minute cap for as long as the hub ran;
 * a machine that comes back waits at most 5 minutes, or none at all with Reconnect
 */
const RETRY_MS: [number, number] = [2_000, 5 * 60_000]

export abstract class LinkedMachineConnection implements RoutedMachine {
  readonly q: Qualifier
  protected status: MachineStatus = 'connecting'
  private error: string | null = null
  protected versions: MachineVersions | null = null
  private lastConnectedAt: number | null = null
  /** The host this link started there, if it did (owner decision 7, plan §10.9) */
  protected hostStarted: (HostStart & { at: number }) | null = null
  protected endpoint: Endpoint | null = null
  protected client: RemoteClient | null = null
  /** Sessions of the remote the hub shows / hides, by the remote's id. Events of any other session are not passed on */
  private shown = new Set<string>()
  private hidden = new Set<string>()
  protected retryTimer: ReturnType<typeof setTimeout> | undefined
  private attempt = 0
  protected stopped = false
  protected opening: Promise<void> | null = null
  /** A refusal was already answered by asking the remote again; the next one is reported and backed off */
  private refusedOnce = false
  /** That operation and its step, for the row (`MachineInfo.operation`) */
  protected operation: MachineOperation | null = null
  /**
   * While an update stops, switches and starts the host there, the link neither reconnects nor
   * starts a host of its own: it would start the old version between the stop and the switch
   */
  protected held = false
  /** Called with the version of every hello, while an update waits for the new one */
  protected helloWaiters = new Set<(version: string | null) => void>()
  /** What the hub installed there, from the last connection line (plan §10.5, S12) */
  protected installed: MachineInfo['install'] = null
  /** Whether it starts its host at boot, from the last connection line or `machines.autostart` (plan §10.4) */
  protected bootStart: MachineInfo['autostart'] = null
  /**
   * The hub switched this machine to its own Node since the link last connected, and says so in `note`
   * (#699). Once: a host that still fails under the Node it installed is reported as it is, not
   * installed over again
   */
  protected switched: { note: string } | null = null
  /**
   * The hub tried to switch this machine to its own Node since the link last connected, whether or not
   * the install worked: a failing install must not run again at every retry (each one is a download,
   * and `operate` resets the backoff)
   */
  protected switchTried = false
  /** Why the install that was tried failed, kept so the retries keep saying it */
  protected switchFailure: string | null = null
  /** The link waits on a swap's hold there and said so once (swap-hold.ts) */
  private holdSaid = false
  /** Whether the remote host said in its last hello that it runs with administrator rights (#702); null: it did not say */
  private elevated: boolean | null = null
  /** The floor could not be read from this host once already; said once in the log */
  private floorUnreadable = false

  constructor(
    protected record: MachineRecord,
    protected readonly tunnel: Tunnel,
    protected readonly deps: LinkDeps,
  ) {
    this.q = new Qualifier(record.id, record.slot, deps.ownerOf)
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
      hostStarted: this.hostStarted,
      install: this.installed,
      operation: this.operation,
      autostart: this.bootStart,
      elevated: this.elevated,
    }
  }

  // ── RoutedMachine ───────────────────────────────────────────────────────────────────────

  call(method: string, params: unknown): Promise<unknown> {
    if (!this.client) return Promise.reject(rpcError(`${this.name} is not reachable right now`, 'internal', { retryable: true }))
    // A card the hub could not read is never allowed for good from here, whatever the window offered (#844, `unreadCard`)
    if (method === 'agents.respondApproval' && isObj(params) && params.decision === 'always' && this.q.unreadCard(params.sessionId, params.requestId)) {
      return Promise.reject(
        rpcError(`This question from ${this.name} could not be read in full here, so it cannot be allowed always. Allow it once or deny it.`, 'internal', { retryable: false }),
      )
    }
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

  /** Installs the pinned Node there when the one there is too old (`LinkedMachine.switchNode`); true when it did */
  protected abstract switchNode(problem: NodeTooOld, floor: string | null, nodeThere?: string | null): Promise<boolean>

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.client?.close()
    this.client = null
    await this.tunnel.close()
  }

  private open(): Promise<void> {
    if (this.held) return Promise.resolve()
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
    let endpoint = await this.openTunnel()
    if (!endpoint) return
    /*
     * No host there: start one, then open again (owner decision 7, plan §10.9). Adding the machine was
     * the consent (§3.2), so nobody is asked; the row and host.log say it happened. Once per opening:
     * a start that did not take is reported and retried with the backoff, not in a loop.
     */
    this.installed = installOf(endpoint.line.install)
    this.bootStart = autostartOf(endpoint.line.autostart)
    if (!endpoint.line.hostRunning && this.tunnel.startHost) {
      if (this.held) return
      /*
       * `pnpm remote-dev` is swapping the host there (#1036, swap-hold.ts): a host started now would be the old version,
       * between its stop and its switch. The link waits, asking again shortly; the command starts the new one itself.
       * Asked only where the hub manages an install: a swap needs one (no other machine pays for the extra ssh)
       */
      const hold = endpoint.line.install?.current ? await this.swapHold() : null
      if (this.stopped || this.held) return
      if (hold) {
        this.setStatus('updating', null)
        if (!this.holdSaid) this.deps.log?.(`[links] ${this.name}: ${hold.by} is swapping its host; this link starts none until it is done`)
        this.holdSaid = true
        // Asked again at the backoff's first step (2 s), never later than the hold lapses
        return this.retryLater(Math.max(50, Math.min(this.deps.retryMs?.[0] ?? 2_000, hold.until - Date.now())))
      }
      this.holdSaid = false
      // A Node below the floor crashes the host on its first database call; the connection line says which Node answered (#699)
      const there = endpoint.line.install
      const floor = this.floor()
      if (floor && there && !there.managed && belowFloor(there.node, floor)) {
        if (await this.switchNode(new NodeTooOld(`Node ${there.node} is below ${floor}`, 'refused', there.node), floor)) return this.doOpen()
        return
      }
      this.setStatus('starting', null)
      this.deps.log?.(`[links] ${this.name}: no Centralu host is running there; starting one (${shimNames(this.record.remote).centralu} serve --detach)`)
      let started: HostStart
      try {
        started = await this.tunnel.startHost()
      } catch (err) {
        if (this.stopped) return
        if (err instanceof NodeTooOld) {
          if (await this.switchNode(err, this.floor(), endpoint.line.install?.node ?? null)) return this.doOpen()
          return
        }
        this.setStatus('not_running', `Centralu could not be started on ${this.name}: ${(err as Error).message}`)
        return this.retryLater()
      }
      if (this.stopped) return
      const note = [started.note, this.switched?.note].filter(Boolean).join(' ') || null
      this.hostStarted = { ...started, note, at: Date.now() }
      this.deps.log?.(
        started.how === 'detached'
          ? `[links] ${this.name}: started its host; it keeps running after this link ends`
          : `[links] ${this.name}: its host runs only while this link is up: ${started.note ?? 'it cannot be started in the background there'}`,
      )
      this.setStatus('starting', null)
      endpoint = await this.openTunnel()
      if (!endpoint) return
      this.installed = installOf(endpoint.line.install)
      this.bootStart = autostartOf(endpoint.line.autostart)
    }
    if (this.held) return
    this.endpoint = endpoint
    if (!endpoint.line.hostRunning) {
      this.setStatus('not_running', `Centralu is installed on ${this.name}, but no \`${shimNames(this.record.remote).centralu} serve\` is running there`)
      return this.retryLater()
    }
    /*
     * A check after a switch (`answers`) is met here, by the version the running host gave the
     * connection line (`serve --connection` says hello to it). A rollback leaves a host older than
     * this hub, so the link below does not open to it (plan §4) and no hello of the link's own would
     * ever come: on a real Windows PC every rollback timed out and put the newer version back (2026-10-11)
     */
    for (const w of [...this.helloWaiters]) w(endpoint.line.version)
    // The versions are checked before the link is opened (plan §4)
    const versions = this.check({ version: endpoint.line.version, protocolVersion: endpoint.line.protocolVersion, dev: false })
    if (!mayConnect(versions)) return
    this.connectClient(endpoint)
  }

  /** A swap's hold on the machine (swap-hold.ts), asked over its shell; none where there is no shell or no answer */
  private async swapHold(): Promise<SwapHold | null> {
    if (!this.tunnel.exec) return null
    try {
      return parseHold((await this.tunnel.exec(readHoldCommand(this.record.remote))).stdout, Date.now())
    } catch {
      return null
    }
  }

  /**
   * The Node floor, or null when this host's copy of it is missing or unreadable (a bundle built without it):
   * then no machine is judged by it, which is how links behaved before the floor existed
   */
  private floor(): string | null {
    try {
      return nodeFloor()
    } catch (err) {
      if (!this.floorUnreadable) this.deps.log?.(`[links] ${this.name}: the Node floor could not be read, so no machine is checked against it: ${(err as Error).message}`)
      this.floorUnreadable = true
      return null
    }
  }

  /** The tunnel's `open`, or null after reporting why not (and when the link was stopped meanwhile) */
  private async openTunnel(): Promise<Endpoint | null> {
    let endpoint: Endpoint
    try {
      endpoint = await this.tunnel.open()
    } catch (err) {
      if (this.stopped) return null
      this.setStatus('unreachable', (err as Error).message)
      this.retryLater()
      return null
    }
    if (this.stopped) {
      // Removed (or the hub stopping) while the tunnel opened: what it opened ends now, not with the host
      await this.tunnel.close()
      return null
    }
    return endpoint
  }

  /** Records the versions, and holds the link at `versions_differ` when the protocols differ (versions alone never hold it, #689) */
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
        `${this.name} runs Centralu ${v.remote.version} (protocol ${v.remote.protocolVersion}); this computer runs ${v.hub.version} (protocol ${v.hub.protocolVersion}). Update ${which ?? 'one side'} to connect`,
      )
      // A later update on either side is noticed by asking again now and then (§4: the prompt comes again)
      this.retryLater(60_000)
    }
    return v
  }

  private connectClient(endpoint: Endpoint): void {
    const client = new RemoteClient(
      // A host that can prove it holds the token is asked to, before the token goes out (#838)
      { ...this.deps.client, url: endpoint.url, token: endpoint.token, proveHost: endpoint.line.proof === true },
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
          /*
           * Refused the proof itself (#838): the installed Centralu there proves its token, the host still running is
           * from before it (updated without a restart, or rolled back). Said as that, not as a token problem.
           */
          const serve = `${shimNames(this.record.remote).centralu} serve`
          const why = r.proving
            ? `${this.name} runs an older Centralu host than the one installed there, which cannot prove it holds the link's token`
            : r.code === 4002 ? (r.error?.message ?? 'The remote host speaks another protocol') : `${this.name} refused the link's token`
          if (!this.refusedOnce) {
            this.refusedOnce = true
            this.setStatus('connecting', why)
            return this.retryLater(0)
          }
          this.setStatus('refused', r.proving ? `${why}. Restart it there: \`${serve} --stop\`, then start it again` : `${why}. If its token was rotated, restart \`${serve}\` there`)
          this.retryLater()
        },
      },
    )
    this.client = client
    client.connect()
  }

  private async onHello(client: RemoteClient, h: RemoteHello): Promise<void> {
    if (this.client !== client) return
    for (const w of [...this.helloWaiters]) w(h.build?.version ?? null)
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
    // Said by every hello: a host restarted unelevated (through a standard account) clears it. Logged when it changes
    const elevated = h.elevated ?? null
    if (elevated && !this.elevated) this.deps.log?.(`[links] ${this.name}: its host runs with administrator rights, and so does every agent it starts`)
    this.elevated = elevated
    this.switched = null
    this.switchTried = false
    this.switchFailure = null
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
      } else if (raw.type === 'session_owner') {
        // A handoff there moved this session to the session that took over (#693)
        this.deps.mirror.patchSession(this.id, sid, { askedBy: raw.askedBy ?? null, parentSessionId: raw.parentSessionId ?? null })
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
    // The update stopped the host on purpose; it reconnects when it is done
    if (this.held) return
    this.setStatus('unreachable', `The connection to ${this.name} ended (${reason}); reconnecting`)
    this.retryLater()
  }

  protected retryLater(fixedMs?: number): void {
    if (this.stopped || this.held) return
    clearTimeout(this.retryTimer)
    const [first, max] = this.deps.retryMs ?? RETRY_MS
    const delay = fixedMs ?? Math.min(max, first * 2 ** this.attempt++)
    this.retryTimer = setTimeout(() => void this.open(), delay)
    this.retryTimer.unref?.()
  }

  protected setStatus(status: MachineStatus, error: string | null): void {
    const changed = status !== this.status || error !== this.error
    this.status = status
    this.error = error
    if (changed) {
      if (error) this.deps.log?.(`[links] ${this.name}: ${status}: ${error}`)
      this.deps.broadcast({ type: 'machine_status', machine: this.info() })
    }
  }
}
