import { isObj } from '../json-value.js'
import { rpcError } from '../rpc-error.js'
import {
  isInTurn,
  transition,
  HostHandover,
  type HostLogon,
  type MachineConnect,
  type MachineInfo,
  type MachineOperation,
  type MachineSide,
  type MachineStatus,
  type MachineVersions,
  type NormalizedEvent,
  type SessionState,
} from '@cc/protocol'
import type { LinkDeps, MachineRecord } from './link-deps.js'
import { belowFloor, NodeTooOld } from './node-floor.js'
import { nodeFloor } from './install.js'
import { Qualifier } from './qualifier.js'
import { RemoteClient, type RemoteHello } from './remote-client.js'
import type { RoutedMachine } from './router.js'
import { shimNames, StartedNotServing, type ConnectionLine, type Endpoint, type HostStart, type RemoteAutostart, type RemoteInstall, type Tunnel } from './tunnel.js'
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

/**
 * How many times the client dials the forward again after a drop before the link reads the connection line instead
 * (`RemoteClientOptions.redials`, #1143). From 200 ms, doubling, about 6 s in all: a blip, or a host swapped in place
 * there (about 1 s, docs/agent-host.md), is back within them and keeps the event cursor. Past them the question is
 * whether a host still runs there, which costs an ssh command, and its answer may start one
 */
const LINK_REDIALS = 5

/**
 * How long a host has to stay up before the backoff starts over (#1143). One that answers its hello and then stops
 * again at once (a crash in a resume, a migration, an agent install) reset it at every hello and was started again
 * every 10 s for good
 */
const STABLE_MS = 60_000

/**
 * At most this many hosts started there by the link alone within `windowMs` (#1143); past it the row says `stopped`
 * and why, and the link starts no more until the person's Start. Three: serve.log keeps three earlier starts'
 * logs (serve-files.mjs `SERVE_LOGS_KEPT`), so the first failure's is still there to read
 */
const RESTARTS = { max: 3, windowMs: 10 * 60_000 }

/**
 * A machine that connects when needed (#1134) stays connected this long after the last thing that needed it, and
 * longer while a session there is in a turn. A window that keeps one of its projects or sessions open says so again
 * well within it (every 2 minutes, `machines.need`)
 */
const NEED_HOLD_MS = 10 * 60_000
/** How often such a machine is looked at for having been idle that long */
const IDLE_CHECK_MS = 30_000
/**
 * How long an agent's call waits for such a machine to connect before it is answered as not reachable. Connecting
 * took 2.1 to 4.3 s on a LAN (docs/agent-host.md §4.7); starting a host there adds its start. A machine that cannot
 * be reached answers sooner: ssh fails
 */
const NEED_WAIT_MS = 60_000

/** Where an attempt to connect ended, one way or the other: what a call waiting on `need` waits for */
const SETTLED: ReadonlySet<MachineStatus> = new Set(['connected', 'unreachable', 'not_running', 'versions_differ', 'refused', 'disconnected', 'stopped'])
/** Statuses a need tries again now, instead of waiting out the backoff */
const RETRYING: ReadonlySet<MachineStatus> = new Set(['unreachable', 'not_running', 'refused'])

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
  /** The client when it stopped redialling (`gaveUp`, #1143) and is waiting, idle, for the next opening */
  private gaveUp: RemoteClient | null = null
  /** Sessions of the remote the hub shows / hides, by the remote's id. Events of any other session are not passed on */
  private shown = new Set<string>()
  private hidden = new Set<string>()
  protected retryTimer: ReturnType<typeof setTimeout> | undefined
  private attempt = 0
  /** Starts the backoff over once the host that last said hello has stayed up `STABLE_MS` */
  private stableTimer: ReturnType<typeof setTimeout> | undefined
  /** When the link started a host there by itself, within the last `RESTARTS.windowMs` (#1143) */
  private autoStarts: number[] = []
  /**
   * The link reached `RESTARTS` and starts no host there until the person's Start, or until a host it finds there has
   * stayed up `STABLE_MS` (#1143). Kept, not read off `autoStarts` again: those age out of the window, and a host that
   * kept stopping would be started three more times every ten minutes for good
   */
  private restartsSpent = false
  /**
   * Why the link last declined to start a host there (`startRefusal`), until a host is found running, says hello, or a
   * start goes through (#1143 re-review). Kept across the openings that read the line again and across a machine that
   * cannot be reached meanwhile: the row stays `stopped` through them, and the orchestrator's `reconnect_machine` asks
   * with a card whenever this is set, not only when the status happens to say `stopped`
   */
  private heldBack: string | null = null
  /** What the last counted start said when its host never answered; null when it answered */
  private lastStartFailure: string | null = null
  /** Counts the retries set (`retryLater`), so `reconnect` can tell whether an opening under way set its own */
  private retriesSet = 0
  /**
   * The person's Start (`connect`, the row's Connect/Start/Reconnect, or the orchestrator's card): the next start
   * there goes ahead even when the person stopped it there or the link stopped starting them. Spent once a start went
   * through or a host is found running; a start that failed keeps it, so it is tried again on the backoff
   */
  private startAsked = false
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
  /** Which Windows logon the remote host said in its last hello it runs in (#1224); null: it did not say */
  private logon: HostLogon | null = null
  /** A sign-in's serve waiting to take over from the remote host, as its hello or `host_handover` last said (#1224) */
  private handover: HostHandover | null = null
  /** The floor could not be read from this host once already; said once in the log */
  private floorUnreadable = false
  /**
   * The link was closed on purpose and none is tried (#1134, status `disconnected`): by the person, at start for a
   * machine that connects when needed, or because nothing needed it. `stopped` is set with it, so every path that
   * opens or retries ends as after a removal; `connect`, `need` and `start` open it again
   */
  private parked = false
  /** The person connected it (`connect`): it stays up until they disconnect it, whatever `connect` says */
  private pinned = false
  /**
   * The person disconnected it (`machines.disconnect`): the window saying again that it still has the machine open
   * (`need` with `repeat`) does not bring it back. Connect does, the window opening something of it does, and an
   * agent's work does
   */
  private downByPerson = false
  /** When something last needed it (`need`), for a machine that connects when needed */
  private neededAt = 0
  private idleTimer: ReturnType<typeof setInterval> | undefined
  /** Calls waiting on `need` for the attempt to connect to end */
  private statusWaiters = new Set<() => void>()
  /**
   * Each shown session's state as the hub last heard it (#1134): from the lists, then followed event by event by the
   * rule both sides run (`transition`). The mirror's `state` follows explicit `state_change` events only, which a turn
   * need not send. Kept while the link is away, so a turn that was open when it dropped still counts
   */
  private states = new Map<string, SessionState>()

  constructor(
    protected record: MachineRecord,
    protected readonly tunnel: Tunnel,
    protected readonly deps: LinkDeps,
  ) {
    this.q = new Qualifier(record.id, record.slot, deps.ownerOf)
    for (const s of deps.mirror.read(record.id, 'sessions') ?? []) {
      this.classify(s)
      this.noteState(s)
    }
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
  /** When the hub opens this link (#1134) */
  get connectMode(): MachineConnect {
    return this.record.connect ?? 'at_start'
  }
  /**
   * Not connected now, and connected when something needs it (#1134): parked, connecting, or away between attempts.
   * What the mirror holds stands for it until then, and what is asked of it waits on `need`. Not while its versions
   * hold it or an operation runs there, which a need cannot end; and never a machine that connects at start, which the
   * person disconnected or which is away: nothing but Connect or its backoff brings that one back
   */
  get onDemand(): boolean {
    if (this.connectMode !== 'when_needed' || this.reachable) return false
    return this.status !== 'versions_differ' && this.status !== 'updating'
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
      asks: { on: this.record.asks === true, note: this.record.asks === true ? this.asksNote : null },
      logon: this.logon,
      handover: this.handover,
      connect: this.connectMode,
    }
  }

  // ── The reverse direction (#550) ──────────────────────────────────────────────────────────

  /** Why the switch is on but cannot work, for the row: the machine runs a Centralu from before it */
  private asksNote: string | null = null

  /**
   * Turns the switch on or off (#550): stored with the machine, said to the machine at once when it is connected, and
   * at its every connect after. Off forgets the pairs approved for it (the registry's)
   */
  async setAsks(on: boolean): Promise<void> {
    this.deps.registry.setAsks?.(this.id, on)
    this.record = { ...this.record, asks: on }
    if (!on) this.asksNote = null
    const client = this.client
    if (client && this.reachable) await this.offerAsks(client)
    this.deps.broadcast({ type: 'machine_status', machine: this.info() })
  }

  /**
   * Tells the machine who this hub is and whether its sessions may ask this hub's projects (`host.hubOffer`), so the
   * machine knows the connection to call back on. Said off too, so a machine that heard "on" earlier in its own life
   * stops offering this hub to its sessions. A machine from before the reverse direction answers "Unknown method": the
   * row then says to update it there, while the switch is on
   */
  protected async offerAsks(client: RemoteClient): Promise<void> {
    const self = this.deps.hubSelf?.()
    if (!self) return
    const on = this.record.asks === true
    let note: string | null = null
    try {
      await client.call('host.hubOffer', { hub: self, on })
    } catch (err) {
      if (on) {
        note = /Unknown method/i.test((err as Error).message)
          ? `${this.name} runs a Centralu from before this: update it there before its sessions can ask this computer's projects`
          : `${this.name} could not be told yet (${(err as Error).message}); it is told again at the next connect`
      }
    }
    if (this.client !== client) return
    const changed = note !== this.asksNote
    this.asksNote = note
    if (changed) this.deps.broadcast({ type: 'machine_status', machine: this.info() })
  }

  /**
   * Tells the machine this hub no longer answers it (the machine is being removed while it is connected), so its
   * sessions stop seeing this hub at once. Best effort: a machine that cannot hear it forgets the hub when the link ends
   */
  async withdrawOffer(): Promise<void> {
    const self = this.deps.hubSelf?.()
    const client = this.client
    if (!self || !client || !this.reachable || this.record.asks !== true) return
    await client.call('host.hubOffer', { hub: self, on: false }).catch(() => {})
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
      this.states.clear()
      for (const s of list) {
        this.classify(s)
        this.noteState(s)
      }
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
    this.parked = false
    this.neededAt = Date.now()
    this.watchIdle()
    void this.open()
  }

  /** Not connected at start: the machine connects when needed (#1134). Nothing is opened or tried */
  park(): void {
    this.stopped = true
    this.parked = true
    this.setStatus('disconnected', null)
  }

  /**
   * The person's Connect (`machines.reconnect`, #1134): opens now, forgetting the backoff, also a disconnected link.
   * It stays up until they disconnect it, as a machine that connects at start does. It is also the person's Start
   * (#1143): a host is started there even where they stopped it or the link stopped starting them. `start: false` is
   * the orchestrator's reconnect without its card, which opens the link and starts nothing the link would not
   */
  connect(opts: { start?: boolean } = {}): void {
    this.pinned = true
    this.downByPerson = false
    if (opts.start !== false) {
      this.startAsked = true
      this.autoStarts = []
      this.restartsSpent = false
    }
    if (this.parked) return this.start()
    this.reconnect()
  }

  /**
   * Something needs the machine now (#1134): the window opened one of its projects or sessions, or an agent is started
   * or sent work there. A machine that connects when needed is connected, or tried again now when it was away, and
   * is kept up for `NEED_HOLD_MS` after this. Resolves once the attempt ended (connected, or why not) or after
   * `waitMs`; never rejects. Any other machine is left as it is. `repeat`: the window saying again that something of
   * the machine is still open, which does not undo the person's Disconnect
   */
  need(opts: { waitMs?: number; repeat?: boolean } = {}): Promise<void> {
    const waitMs = opts.waitMs ?? this.deps.needWaitMs ?? NEED_WAIT_MS
    if (this.connectMode !== 'when_needed') return Promise.resolve()
    if (opts.repeat && this.downByPerson) return Promise.resolve()
    this.downByPerson = false
    this.neededAt = Date.now()
    if (this.reachable) return Promise.resolve()
    if (this.parked) {
      this.deps.log?.(`[links] ${this.name}: needed; connecting`)
      this.start()
    } else if (!this.stopped && !this.opening && RETRYING.has(this.status)) {
      this.reconnect()
    }
    const settled = () => this.stopped || this.reachable || SETTLED.has(this.status)
    if (settled()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.statusWaiters.delete(waiter)
        resolve()
      }
      const waiter = () => {
        if (settled()) done()
      }
      const timer = setTimeout(done, waitMs)
      this.statusWaiters.add(waiter)
    })
  }

  /**
   * Closes the link and tries none until it is connected or needed again (#1134). The machine stays linked; its
   * sessions keep running there, and the mirror lists them as last known
   */
  async disconnect(why?: string, byPerson = false): Promise<void> {
    this.pinned = false
    this.downByPerson = byPerson
    this.startAsked = false
    this.parked = true
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.stopIdle()
    this.client?.close()
    this.client = null
    if (why) this.deps.log?.(`[links] ${this.name}: ${why}`)
    this.setStatus('disconnected', null)
    await this.tunnel.close()
  }

  /** When the hub opens the link (#1134), as the registry now keeps it */
  setConnect(connect: MachineConnect): void {
    this.record = { ...this.record, connect }
    if (connect === 'at_start') {
      this.stopIdle()
      // At start means whenever the hub runs: a machine down for want of a need comes up now
      if (this.parked) this.start()
    } else if (!this.parked) {
      // Counted as needed now, so it does not drop the moment the setting changes
      this.neededAt = Date.now()
      this.watchIdle()
    }
  }

  /** An install, update or other operation the person started holds the machine; it is not idle meanwhile */
  protected operating(): boolean {
    return this.held
  }

  /**
   * What the person asks of a disconnected machine runs over its link's ssh (#1134): it is opened for that, and not
   * pinned. The operation holds it while it runs (`operating`), and its end counts as a need (`noteNeeded`)
   */
  openForOperation(): void {
    if (!this.parked) return
    this.downByPerson = false
    this.start()
  }

  /** Counted as needed now, so the hold runs from here (#1134) */
  protected noteNeeded(): void {
    this.neededAt = Date.now()
  }

  /**
   * Nothing needs the machine (#1134): it connects when needed, the person did not connect it themselves, nothing
   * needed it for `NEED_HOLD_MS`, no operation runs, and no session there is in a turn as the hub last heard. A
   * child working there keeps the link, also while it is away, so its report arrives
   */
  private idle(): boolean {
    if (this.connectMode !== 'when_needed' || this.pinned || this.parked || this.stopped || this.operating()) return false
    // An attempt under way is let finish: the next check after it decides, connected or away
    if (this.opening) return false
    if (Date.now() - this.neededAt < (this.deps.needHoldMs ?? NEED_HOLD_MS)) return false
    // A child there whose report is owed: its turn runs, or its background work does after the turn ended
    if (this.deps.workOwed?.(this.id)) return false
    return ![...this.states.values()].some((state) => isInTurn(state))
  }

  /** A shown session's state from a list row or a `session_created` */
  private noteState(s: unknown): void {
    if (isObj(s) && typeof s.id === 'string' && typeof s.state === 'string' && !hiddenKind(s)) this.states.set(s.id, s.state as SessionState)
  }

  private watchIdle(): void {
    if (this.connectMode !== 'when_needed' || this.idleTimer) return
    // Also while it is away: a machine nothing needs is not tried every few minutes for as long as the hub runs
    this.idleTimer = setInterval(() => {
      if (this.idle()) void this.disconnect('nothing has needed it for a while and no session there is working; disconnected until something needs it')
    }, this.deps.idleCheckMs ?? IDLE_CHECK_MS)
    this.idleTimer.unref?.()
  }

  private stopIdle(): void {
    clearInterval(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Opens again now, forgetting the backoff (`machines.reconnect`, or the person accepted the versions) */
  reconnect(): void {
    clearTimeout(this.retryTimer)
    this.attempt = 0
    /*
     * An opening already under way answers this one (`open`). Its retry, if it set one, was just cleared: once it ends
     * without a client of its own it opens again now, or the link would wait for nothing (#1293 re-review)
     */
    const under = this.opening
    if (under) {
      const set = this.retriesSet
      void under.finally(() => {
        // It set a retry of its own after this (a start that failed, a refusal): that backoff stands
        if (this.stopped || this.held || this.opening || this.retriesSet !== set) return
        if (this.client === null || this.client === this.gaveUp) this.retryLater(0)
      })
      return
    }
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
    this.stopIdle()
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
    // Kept only when it gave up redialling: `connectClient` points it at what the connection line says
    if (this.client !== this.gaveUp) {
      this.client?.close()
      this.client = null
    }
    // Held back (#1143): the row stays `stopped` while the line is read again, rather than flicker to `connecting`
    if (this.heldBack && !this.startAsked) this.setStatus('stopped', this.heldBack)
    else this.setStatus('connecting', null)
    let endpoint = await this.openTunnel()
    if (!endpoint) return
    /*
     * No host there: start one, then open again (owner decision 7, plan §10.9). Adding the machine was
     * the consent (§3.2), so nobody is asked; the row and host.log say it happened. Once per opening:
     * a start that did not take is reported and retried with the backoff, not in a loop.
     */
    this.installed = installOf(endpoint.line.install)
    this.bootStart = autostartOf(endpoint.line.autostart)
    // Found running: a Start has nothing left to start, and nothing is held back
    if (endpoint.line.hostRunning) {
      this.startAsked = false
      this.heldBack = null
    }
    // Only where the link can start one; elsewhere a host that is not running is `not_running`, as before
    const notStarted = endpoint.line.hostRunning || !this.tunnel.startHost ? null : this.startRefusal(endpoint.line)
    if (notStarted) {
      if (this.held) return
      this.heldBack = notStarted
      this.setStatus('stopped', notStarted)
      // Asked again on the backoff: a host the person starts there themselves is connected to
      return this.retryLater()
    }
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
        // A host that was started and never answered, one that crashes at boot (#1143 re-review): counted as one that
        // answered and then stopped, and the Start it answered is spent. A crash the Node there may explain too
        if (err instanceof StartedNotServing || (err instanceof NodeTooOld && err.kind === 'crashed')) this.countStart((err as Error).message)
        if (err instanceof NodeTooOld) {
          if (await this.switchNode(err, this.floor(), endpoint.line.install?.node ?? null)) return this.doOpen()
          return
        }
        this.setStatus('not_running', `Centralu could not be started on ${this.name}: ${(err as Error).message}`)
        return this.retryLater()
      }
      if (this.stopped) return
      /*
       * A start that went through counts against `RESTARTS` (#1143), the person's included, which it spends: a host it
       * starts that stops again before its hello is not started at every step for good. A start that failed does not
       * count: it is `not_running` with its reason, on the backoff, as before
       */
      this.countStart()
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

  /**
   * A start there went through, or started a host that never answered: it counts, and it spends the person's Start.
   * `failed`: what the start said when its host never answered, kept for the row should the link stop starting them
   */
  private countStart(failed: string | null = null): void {
    this.startAsked = false
    this.heldBack = null
    this.autoStarts.push(Date.now())
    this.lastStartFailure = failed
  }

  /**
   * Why the link starts no host there just now, or null (#1143): the person stopped it there, or the link reached its
   * limit of starts. Kept while the machine cannot be reached, and while the line is read again
   */
  get startHeldBack(): string | null {
    return this.heldBack
  }

  /**
   * Why no host is started there now, or null (#1143): the person stopped it there (the line's `stopped`), or the link
   * already started `RESTARTS.max` within its window. The person's Start overrides both. An older remote says no
   * `stopped`, and is started as before
   */
  private startRefusal(line: ConnectionLine): string | null {
    if (this.startAsked) return null
    if (line.stopped) {
      const how = line.stopped.by === 'quit' ? 'by quitting Centralu there' : 'with `centralu serve --stop`'
      return `Centralu was stopped on ${this.name} ${how}, so this computer does not start it by itself. Start starts it there`
    }
    const { max, windowMs } = this.deps.restarts ?? RESTARTS
    const now = Date.now()
    this.autoStarts = this.autoStarts.filter((t) => now - t < windowMs)
    if (this.autoStarts.length >= max) this.restartsSpent = true
    if (!this.restartsSpent) return null
    return (
      `The Centralu hosts this computer started on ${this.name} did not stay up (${max} starts within ${Math.round(windowMs / 60_000)} minutes), ` +
      'so it starts no more by itself; serve.log and host.log in its data folder there say why' +
      (this.lastStartFailure ? ` (the last start: ${this.lastStartFailure})` : '') +
      '. Start tries again'
    )
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
      /*
       * The machine could not be reached: a Start pressed now is spent, not kept for whenever it comes back (#1143),
       * when the person may have stopped Centralu there since. They press Start again once it answers
       */
      this.startAsked = false
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
    /*
     * The client that gave up redialling (#1143) is pointed at what the line names: at the same address it keeps its
     * cursor, so the host replays what it sent meanwhile (a new lifetime resyncs as ever). Every path that ends the
     * client nulls `this.client`, so one still held here was never closed
     */
    const idle = this.client !== null && this.client === this.gaveUp ? this.client : null
    this.gaveUp = null
    if (idle && idle.provesHost === (endpoint.line.proof === true)) {
      idle.updateEndpoint(endpoint.url, endpoint.token)
      return
    }
    this.client?.close()
    this.client = null
    const client = new RemoteClient(
      // A host that can prove it holds the token is asked to, before the token goes out (#838)
      { redials: LINK_REDIALS, ...this.deps.client, url: endpoint.url, token: endpoint.token, proveHost: endpoint.line.proof === true },
      {
        hello: (h) => void this.onHello(client, h),
        event: (e) => this.onEvent(e),
        // The machine's calls to this hub (#550): answered as this machine, whatever they say, by the hub's allowlist
        ...(this.deps.reverse ? { call: (method: string, params: unknown, signal: AbortSignal) => this.deps.reverse!({ id: this.id, name: this.name }, method, params, signal) } : {}),
        terminal: (f) => this.deps.terminal({ ...f, terminalId: this.q.id(f.terminalId) }),
        down: (reason) => {
          if (this.client !== client) return
          this.setStatus('unreachable', `The link to ${this.name} dropped (${reason}); reconnecting`)
        },
        /*
         * A few redials of the same forward did not reach a host (#1143). A detached host that died leaves `ssh -N` up,
         * and redialling it went on for good: the host was started again only when ssh died or the person pressed
         * reconnect. Now the link does what reconnect does: reads the connection line again, which starts a host there
         * when none runs, on the link's own backoff. The client is kept, idle, for the host the line names next: a host
         * that was there all along (a laptop waking, a network change) replays what it sent meanwhile (`connectClient`)
         */
        gaveUp: (reason) => {
          if (this.client !== client) return
          if (this.held) {
            client.close()
            this.client = null
            return
          }
          this.gaveUp = client
          this.setStatus('unreachable', `${this.name}'s host did not answer on the link (${reason}); asking the machine again`)
          this.retryLater()
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
    /*
     * The backoff starts over once this host has stayed up a while (#1143), not at its hello: a host that answers and
     * stops again at once reset it every time, and was started again every 10 s for good
     */
    clearTimeout(this.stableTimer)
    this.stableTimer = setTimeout(() => {
      if (this.client !== client || !client.connected) return
      this.attempt = 0
      // A host that stays up: the link may start one again by itself, should it stop
      this.restartsSpent = false
    }, this.deps.stableMs ?? STABLE_MS)
    this.stableTimer.unref?.()
    this.startAsked = false
    this.heldBack = null
    this.refusedOnce = false
    // Said by every hello: a host restarted unelevated (through a standard account) clears it. Logged when it changes
    const elevated = h.elevated ?? null
    if (elevated && !this.elevated) this.deps.log?.(`[links] ${this.name}: its host runs with administrator rights, and so does every agent it starts`)
    this.elevated = elevated
    // Said by every hello too: a host that moved into the person's sign-in clears it (#1224)
    const logon = h.logon ?? null
    if (logon === 'network' && this.logon !== 'network') {
      this.deps.log?.(`[links] ${this.name}: its host runs in a network logon (started over ssh), so Git there cannot use a sign-in saved in Windows`)
    }
    this.logon = logon
    this.handover = h.handover ?? null
    this.switched = null
    this.switchTried = false
    this.switchFailure = null
    this.lastConnectedAt = Date.now()
    this.setStatus('connected', null)
    // Who this hub is, and whether the machine's sessions may ask it (#550); said at every connect
    void this.offerAsks(client)
    /*
     * The UI re-reads this machine's sessions and projects, and wakes the ones that were live
     * before and are not now (a remote host that restarted without a keeper). Sent on every
     * connect, replay or not: the UI read the mirror while the link was away, marked unreachable.
     */
    this.deps.broadcast({ type: 'machine_resync', machineId: this.id })
  }

  private onEvent(raw: unknown): void {
    if (!isObj(raw)) return
    // The machine's own hand-over into its sign-in (#1224): kept on its row, passed on to no one
    if (raw.type === 'host_handover') {
      const h = HostHandover.nullable().safeParse(raw.handover)
      this.handover = h.success ? h.data : null
      this.deps.broadcast({ type: 'machine_status', machine: this.info() })
      return
    }
    const sid = typeof raw.sessionId === 'string' ? raw.sessionId : null
    if (sid !== null) {
      if (raw.type === 'session_created') {
        this.classify(raw.session)
        this.noteState(raw.session)
        if (isObj(raw.session) && !hiddenKind(raw.session)) this.deps.mirror.upsertSession(this.id, raw.session)
      }
      if (!this.shown.has(sid)) return
      const was = this.states.get(sid)
      if (was !== undefined) this.states.set(sid, transition(was, raw as NormalizedEvent).state)
      if (raw.type === 'session_deleted') {
        this.states.delete(sid)
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
    this.retriesSet++
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
      for (const w of [...this.statusWaiters]) w()
    }
  }
}
