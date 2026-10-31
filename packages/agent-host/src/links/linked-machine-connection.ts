import { randomBytes } from 'node:crypto'
import { asObj, isObj } from '../json-value.js'
import { rpcError } from '../rpc-error.js'
import {
  HostHandover,
  errorMessage,
  type HostLogon,
  type MachineInfo,
  type MachineOperation,
  type MachineSide,
  type MachineStatus,
  type MachineVersions,
  type NormalizedEvent,
} from '@cc/protocol'
import type { LinkDeps, MachineRecord } from './link-deps.js'
import { belowFloor, NodeTooOld } from './node-floor.js'
import { nodeFloor } from './install.js'
import { Qualifier } from './qualifier.js'
import { RemoteClient, type RemoteHello } from './remote-client.js'
import type { RoutedMachine } from './router.js'
import { credentialCheck, verifierOf } from '../lifecycle/serve-credentials.js'
import { credentialsOf, shimNames, StartedNotServing, type ConnectionLine, type RemoteCredential, type Endpoint, type HostStart, type RemoteAutostart, type RemoteInstall, type Tunnel } from './tunnel.js'
import { acceptanceKey, compareVersions, mayConnect } from './versions.js'
import { isNoAnswer } from './away.js'
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
 * What a row of an unreachable machine says comes next (#1341): the hub tries again on its backoff while Auto reconnect
 * is on, and waits for the person's Connect while it is off. A row already showing one is changed when the switch moves
 */
const KEEPS_TRYING = 'reconnecting'
const WAITS_FOR_PERSON = 'press Connect to try again'
const NEXT_STEP = new RegExp(`; (${KEEPS_TRYING}|asking the machine again|${WAITS_FOR_PERSON})$`)
/** How often a connected link reads the machine's full credentials (`host.credentials`, #1405) */
const CREDENTIALS_MS = 30_000
/** How many of a machine's other full credentials its row lists; the rest are counted (`otherCredentialsMore`) */
const OTHER_CREDENTIALS_SHOWN = 32
/**
 * The longest a withdrawal from the row is remembered (#1712). It is forgotten sooner: once a read of the machine answers
 * that its host keeps no record of the credential any more (`usedIds`), which it does a week (`WITHDRAWN_KEPT_MS`) after
 * it first found the credential withdrawn, and that is the first report after the withdrawal, which may be long after
 * the person's act when no hub reads. This is for a host that does not say its ids (from before them) and for one never
 * read again, so that a withdrawal is not kept for good
 */
const REVOKED_KEPT_MS = 60 * 24 * 60 * 60 * 1000

/** A credential as the row shows one that is held: without the mark of one withdrawn */
const withoutGone = ({ gone: _gone, ...c }: RemoteCredential): RemoteCredential => c
/** How many credentials the host told this hub of (`host_credential_used`) it keeps until a read answers for them (#1712) */
const REPORTED_USED_KEPT = 64

/** How long a call waits for an attempt to connect that is under way before it is answered as not reachable */
const ATTEMPT_WAIT_MS = 60_000
/**
 * How long a call that needs a machine which is down waits for the attempt it starts (#1532): the ssh to a machine that is
 * up answers in 2 to 4 s, and one that does not answer would hold the agent for the whole timeout. Past it the call is
 * answered as not reachable and the attempt goes on
 */
const CALL_WAIT_MS = 10_000
/** How long the reason a call's attempt failed is still given to the calls that follow it: past it, a stale reason would be told of a new drop */
const CALL_FAILURE_KEPT_MS = 60_000
/** At most one attempt started by a call per machine within this window, so calls cannot defeat the backoff (#1532) */
const CALL_WINDOW_MS = 15_000
/** Statuses of a link that is away between attempts: turning Auto reconnect on tries again now */
const AWAY: ReadonlySet<MachineStatus> = new Set(['unreachable', 'away', 'not_running', 'refused', 'stopped'])
/** Statuses a call's attempt can help (#1532): a host the person stopped there, a version gate or an operation need more than a try */
const CALL_RETRIES: ReadonlySet<MachineStatus> = new Set(['unreachable', 'away', 'not_running', 'refused'])

export abstract class LinkedMachineConnection implements RoutedMachine {
  readonly q: Qualifier
  protected status: MachineStatus = 'connecting'
  private error: string | null = null
  protected versions: MachineVersions | null = null
  private lastConnectedAt: number | null = null
  /** The host this link started there, if it did (owner decision 7, plan §10.9) */
  protected hostStarted: (HostStart & { at: number }) | null = null
  protected endpoint: Endpoint | null = null
  /**
   * The machine's host closed this hub's link because the credential it was paired with is gone there (#1405 review:
   * 4001 "credential withdrawn"), while it was still this hub's latest: something paired under its label or withdrew
   * it. Kept for as long as this hub runs, since the link pairs again at once and the poll would not see it
   */
  private ownCredentialTaken = false
  /**
   * The full credentials this hub withdrew on the machine (#1405): never listed again, whatever a line read before said.
   * Kept in the registry (#1712) until a read of the machine answers that its host holds no record of the credential
   * (`forgetRevoked`), and for `REVOKED_KEPT_MS` at most, so a hub that starts again does not list them as used and
   * withdrawn again: the machine's host keeps its record of a withdrawn credential for a week from its first report after
   */
  protected revokedHere = new Set<string>()
  private revokedAt = new Map<string, number>()
  /**
   * The machine's full credentials as this link last read them through `host.credentials` (#1405), the hub's own among
   * them; null until read, and on a machine that does not answer it (the connection line's `others` stand then)
   */
  private credentials: RemoteCredential[] | null = null
  /**
   * The ids of every credential this hub paired on the machine while it runs (#1405 review), and the ids the machine's
   * host says were used there under a hub's label (`host.credentials` `usedUnderHubLabels`): one under this hub's label
   * that this hub did not pair is something else's, shown as used and gone though its pairer re-paired after it
   */
  private pairedHere = new Map<string, string | null>()
  private usedUnderHubLabels: RemoteCredential[] = []
  /**
   * Full credentials the machine's host told this hub, over this link, were just used there (#1712,
   * `host_credential_used`), and that no `host.credentials` read has answered for since: shown as used and gone, since
   * a credential used and withdrawn before the next read (or a host stopped right after) is what they are for. A read
   * that succeeds replaces them with the host's own answer, which has them (its record is written before the event is
   * sent). `settled`: the read the event started has ended without an answer, so they may be shown while connected.
   * `answered`: a read that began after the event answered and does not list it, so it is withdrawn (shown "used, then
   * withdrawn"); until one has, nothing says it is not still held, and it is shown as held, as a listed one is
   */
  private reportedUsed: { key: string; seq: number; settled: boolean; answered: boolean; credential: RemoteCredential }[] = []
  private reportSeq = 0
  /** The read under way for what the host told (`readForReported`), and whether another was asked for while it ran */
  private reportRead: Promise<void> | null = null
  private reportReadAgain = false
  /** The machine's host says its serve.json cannot be read (#1405 review), or closed this link for that */
  private fileUnreadable = false
  /** Reads `credentials` again now, while the link that started it is up (`watchCredentials`) */
  protected readCredentials: (() => Promise<void>) | null = null
  private credentialsTimer: ReturnType<typeof setInterval> | undefined
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
  /**
   * The turns the remote host said in its last hello it continues after an update cut them, with when its start took each
   * up, on its clock (#1618); null: a host from before that, which continues none
   */
  private updateContinued: ReadonlyMap<string, number> | null = null
  /** The floor could not be read from this host once already; said once in the log */
  private floorUnreadable = false
  /**
   * The link was closed on purpose and none is tried (#1134, status `disconnected`): the person disconnected it.
   * `stopped` is set with it, so every path that opens or retries ends as after a removal; `connect` and `start` open it
   * again
   */
  private parked = false
  /**
   * The next retry is only to read (#1341): Auto reconnect is off, and the versions check looks again for a change on
   * either side (`check`). It refreshes the row and connects nothing
   */
  private readsOnly = false
  /** The retry that is opening now is the backoff's own: a machine that is `away` stays so while it is tried (#1398), the person's Connect shows `connecting` */
  private quietRetry = false
  /** When the next attempt is due while the machine is `away` (#1398); null when none is scheduled */
  private nextAttemptAt: number | null = null
  /** Calls waiting for an attempt to connect to end (`settled`) */
  private statusWaiters = new Set<() => void>()
  /** When a call last started an attempt (`reachForCall`), and how the attempt a call waited on ended, with when */
  private lastCallAttemptAt = 0
  private callFailure: string | null = null
  private callFailureAt = 0

  constructor(
    protected record: MachineRecord,
    protected readonly tunnel: Tunnel,
    protected readonly deps: LinkDeps,
  ) {
    this.q = new Qualifier(record.id, record.slot, deps.ownerOf)
    for (const s of deps.mirror.read(record.id, 'sessions') ?? []) this.classify(s)
    // When it was last up, kept across restarts (#1398)
    this.lastConnectedAt = record.lastConnectedAt ?? null
    // What the person withdrew from the row before this run (#1712), while the host there could still hold a record of it
    for (const [credential, at] of Object.entries(record.revoked ?? {})) {
      if (Date.now() - at >= REVOKED_KEPT_MS) continue
      this.revokedAt.set(credential, at)
      this.revokedHere.add(credential)
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
  /** Auto reconnect (#1341), on unless the person turned it off */
  get autoReconnect(): boolean {
    return this.record.autoReconnect !== false
  }
  /**
   * Not connected now, and nothing here will connect it until the person presses Connect (#1341): they disconnected it,
   * or Auto reconnect is off and the attempt it makes at the hub's start is over. An agent's call that needs it is
   * answered as such at once. Not while an attempt is under way, or an operation holds it
   */
  get waitsForPerson(): boolean {
    if (this.reachable || this.opening || this.inOperation()) return false
    // Connecting is an attempt under way (the handshake and its few redials outlast `opening`); a link held at
    // versions_differ or updating waits for something Connect does not give
    if (this.status === 'connecting' || this.status === 'starting' || this.status === 'versions_differ' || this.status === 'updating') return false
    if (this.redialing) return false
    return this.parked || !this.autoReconnect
  }

  /**
   * An attempt to connect is under way (#1341): the tunnel is opening, or the link is shaking hands with the host. A call
   * that needs the machine waits for it (`settled`); with nothing trying it is answered at once
   */
  get attemptUnderWay(): boolean {
    if (this.reachable || this.stopped) return false
    return this.opening !== null || this.status === 'connecting' || this.status === 'starting'
  }

  /**
   * The client is dialling the forward again after a drop, or shaking hands: it has not given up (`gaveUp`). Not an attempt a
   * call waits for (it is answered as not reachable right now, as before), but not the person's to connect either
   */
  private get redialing(): boolean {
    return this.client !== null && this.client !== this.gaveUp
  }

  /** Resolves once no attempt is under way, or after `waitMs` (a minute): connecting took 2 to 4 s on a LAN, a host started there adds its start */
  settled(waitMs = this.deps.attemptWaitMs ?? ATTEMPT_WAIT_MS): Promise<void> {
    return this.waitUntil(() => !this.attemptUnderWay, waitMs)
  }

  /** Resolves once `ready()` holds (checked at every change of status and at the end of every opening), or after `waitMs` */
  private waitUntil(ready: () => boolean, waitMs: number): Promise<void> {
    if (ready()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.statusWaiters.delete(waiter)
        resolve()
      }
      const waiter = () => {
        if (ready()) done()
      }
      const timer = setTimeout(done, waitMs)
      timer.unref?.()
      this.statusWaiters.add(waiter)
    })
  }

  /**
   * An agent's call needs this machine (#1532): with Auto reconnect on and the link down, it does what the person's Connect
   * does (`connect`, the one action that opens a link now) instead of waiting out the backoff, and waits for it a short
   * bound (`CALL_WAIT_MS`). The caller reads `reachable` afterwards: connected in time, the call goes through; not, it is
   * answered as not reachable with `whyDown`, and the backoff goes on from where it was (`keepBackoff`).
   *
   * - one attempt at a time: a call that finds one under way (the backoff's, the person's press, another call's) waits on
   *   it and starts none; so do ten calls at once, and a press at the same moment as a call;
   * - calls cannot defeat the backoff: at most one attempt started by a call per machine within `CALL_WINDOW_MS`; a call
   *   inside the window waits for nothing and is answered at once;
   * - with Auto reconnect off nothing is started (#1341): the call is answered as not connected, and the person is named.
   *   Neither does it when the person disconnected the machine, the host was stopped there, an operation holds the link
   *   or the versions differ: a Connect does not help those, or is the person's to press
   */
  async reachForCall(): Promise<void> {
    if (this.reachable) return
    const until = Date.now() + (this.deps.callWaitMs ?? CALL_WAIT_MS)
    const left = (): number => Math.max(0, until - Date.now())
    // The client dials the same forward again after a drop, about 6 s and no ssh (`LINK_REDIALS`): let it, it may be back
    await this.waitUntil(() => this.reachable || !this.redialing, left())
    if (this.reachable) return
    // An attempt under way is joined, whoever started it, and waited for to this call's own bound
    if (this.attemptUnderWay) {
      await this.settled(Math.min(left(), this.deps.attemptWaitMs ?? ATTEMPT_WAIT_MS))
      return this.noteCallFailure()
    }
    if (this.stopped || this.parked || this.held || this.inOperation() || !this.autoReconnect || this.redialing) return
    if (!CALL_RETRIES.has(this.status)) return
    const now = Date.now()
    if (now - this.lastCallAttemptAt < (this.deps.callWindowMs ?? CALL_WINDOW_MS)) return
    this.lastCallAttemptAt = now
    // Not the person's Start: it starts no host the link would not start by itself
    this.connect({ start: false, keepBackoff: true })
    await this.settled(Math.min(left(), this.deps.attemptWaitMs ?? ATTEMPT_WAIT_MS))
    this.noteCallFailure()
  }

  /** The window in which a call starts at most one attempt (`reachForCall`) */
  get callWindowMs(): number {
    return this.deps.callWindowMs ?? CALL_WINDOW_MS
  }

  /** How the attempt a call waited on ended when it did not connect: the machine's own words. One still going is told as it is (`whyDown`) */
  private noteCallFailure(): void {
    if (this.reachable || this.attemptUnderWay) return
    this.callFailure = this.error?.replace(NEXT_STEP, '') ?? null
    this.callFailureAt = Date.now()
  }

  /**
   * What the answer to a call that could not take it says of the attempt to connect the machine (#1532), as a clause: that
   * one is still under way, or that the one a call made last failed, with the machine's own words. Null once the link is
   * up, and when no attempt was made or told of
   */
  get whyDown(): string | null {
    if (this.reachable) return null
    if (this.attemptUnderWay) return 'an attempt to connect it is still under way'
    if (!this.callFailure || Date.now() - this.callFailureAt > CALL_FAILURE_KEPT_MS) return null
    return `the attempt to connect it just now failed: ${this.callFailure}`
  }

  /** An install, update or other operation the person started is running: its retries are part of it (`retryLater`) */
  protected inOperation(): boolean {
    return this.held
  }

  /** The link has just connected, its hello and lists read; `LinkedMachine` looks at the versions then (#1508) */
  protected connectedNow(): void {}

  /** Whether the remote host continues the turns an update's stop cuts (#1618): its last hello said which it continues */
  continuesCutTurns(): boolean {
    return this.updateContinued !== null
  }

  /** When the remote host took up this session's turn (its own id) after an update cut it (#1618); null when it did not */
  continuedAfterUpdate(sessionId: string): number | null {
    return this.updateContinued?.get(sessionId) ?? null
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
      nextAttemptAt: this.status === 'away' ? this.nextAttemptAt : null,
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
      autoReconnect: this.autoReconnect,
      updateWaits: true,
      connect: this.autoReconnect ? 'at_start' : 'when_needed',
      ...this.otherCredentials(),
    }
  }

  /**
   * The machine's other full credentials for its row (#1405): as `host.credentials` last said, else as the connection
   * line of this link named them, less this hub's own and any it withdrew since. None while not connected, so a list
   * from an earlier link is not taken for the present one. Each is marked when it carries this hub's own label, and the
   * row says when this hub's own is gone from the list (something paired under its label, or withdrew it)
   */
  private otherCredentials(): Pick<MachineInfo, 'otherCredentials' | 'otherCredentialsMore' | 'ownCredentialGone' | 'credentialFileUnreadable'> {
    const line = this.endpoint?.line
    const all = this.credentials ?? line?.others ?? null
    const credentialFileUnreadable = this.fileUnreadable
    const connected = this.status === 'connected'
    // Told by the host over this link; shown also while the link is away. Withdrawn once a read has answered and does not list it, held until then (#1712)
    const told = this.reportedUsed.filter((r) => (r.settled || !connected) && !this.revokedHere.has(r.credential.id)).map((r) => (r.answered ? r.credential : withoutGone(r.credential)))
    if (!connected || !line || !all) {
      const gone = told.slice(0, OTHER_CREDENTIALS_SHOWN).map(({ check: _check, own: _own, ...c }) => ({ ...c, hubsName: !!line?.pairedAs && c.label === line.pairedAs }))
      return { otherCredentials: gone.length ? gone : null, otherCredentialsMore: 0, ownCredentialGone: this.ownCredentialTaken, credentialFileUnreadable }
    }
    // Told of and also listed: listed (the list read last may be older than the news). The hub's own entry does not hide another secret's under its id
    const named = new Set(all.filter((c) => c.own !== true).map((c) => c.id))
    const others = [...all, ...this.notPairedHere(line, all), ...told.filter((c) => !named.has(c.id))].filter((c) => !this.isCurrent(c, line) && !this.revokedHere.has(c.id))
    const shown = others.slice(0, OTHER_CREDENTIALS_SHOWN).map(({ check: _check, own: _own, ...c }) => ({ ...c, hubsName: !!line.pairedAs && c.label === line.pairedAs }))
    // One listed as `gone` is no longer held: this hub's own among them is gone too, and none of them counts as more access
    const ownGone = this.credentials !== null && !!line.credential && !this.credentials.some((c) => this.isCurrent(c, line) && !c.gone)
    const more = others.slice(OTHER_CREDENTIALS_SHOWN).filter((c) => !c.gone).length
    return { otherCredentials: shown, otherCredentialsMore: more, ownCredentialGone: ownGone || this.ownCredentialTaken, credentialFileUnreadable }
  }

  /** The person withdrew `id` from the row: kept in the registry, so it is not listed again after this hub restarts (#1712) */
  protected rememberRevoked(id: string): void {
    this.revokedAt.set(id, Date.now())
    for (const [credential, at] of this.revokedAt) if (Date.now() - at >= REVOKED_KEPT_MS) this.revokedAt.delete(credential)
    this.deps.registry.setRevoked?.(this.id, Object.fromEntries(this.revokedAt))
  }

  /**
   * Forgets the withdrawals from the row (#1712) of credentials the machine's host holds no record of any more: it dropped
   * the record a week after it found the credential withdrawn, so it cannot list it as used again. Only from a read that
   * began after the person's act, which says `known` (its `usedIds`) without the id and `listed` without it too
   */
  private forgetRevoked(known: ReadonlySet<unknown>, listed: readonly RemoteCredential[], readStartedAt: number): void {
    let changed = false
    for (const [credential, at] of this.revokedAt) {
      if (at >= readStartedAt || known.has(credential) || listed.some((c) => c.id === credential) || this.endpoint?.line.others?.some((c) => c.id === credential)) continue
      this.revokedAt.delete(credential)
      this.revokedHere.delete(credential)
      changed = true
    }
    if (changed) this.deps.registry.setRevoked?.(this.id, Object.fromEntries(this.revokedAt))
  }

  /** An entry's id with its check, for telling two secrets under one id apart (`credentialCheck`) */
  private keyOf(c: RemoteCredential): string {
    return `${c.id}:${c.check ?? ''}`
  }

  /**
   * Whether `c` is a credential this hub paired on the machine in its present run (#1405 review): its id is one this hub
   * made and, when the host sent a `check` of this read's nonce, the check is of the secret this hub holds under that
   * id. An entry written into serve.json by hand under a reused id, with another secret, is not. A host that sent no
   * check (one from before it) is compared by id alone
   */
  private isPairedHere(c: RemoteCredential): boolean {
    if (!this.pairedHere.has(c.id)) return false
    return c.own ?? true
  }

  /** Whether `c` is the credential this link is open with, by its id and, as far as the host says, its secret */
  private isCurrent(c: RemoteCredential, line: ConnectionLine): boolean {
    return !!line.credential && c.id === line.credential && this.isPairedHere(c)
  }

  /**
   * The credentials used on the machine under this hub's own label that this hub did not pair (#1405 review), and that
   * `listed` does not name already, as used and gone. The machine's host leaves out a credential whose label's next one
   * was paired the same way, taking it for its pairer again; under a hub's label only the hub can tell. Counted from the
   * first use there of one this hub paired in its present run, so the credentials of its own earlier runs, which it does
   * not remember, are not taken for another's
   */
  /**
   * Marks, in a list the host answered with `nonce`, the entries whose `check` is of the secret this hub holds under
   * their id (`own`). An entry without a check (a host from before it) or a credential this hub holds no secret of is not
   * marked, and is compared by id alone
   */
  private ownOf(list: RemoteCredential[] | null, nonce: string): RemoteCredential[] | null {
    return (
      list?.map((c) => {
        const verifier = this.pairedHere.get(c.id)
        return c.check === undefined || !verifier ? c : { ...c, own: c.check === credentialCheck(verifier, nonce) }
      }) ?? null
    )
  }

  private notPairedHere(line: ConnectionLine, listed: readonly RemoteCredential[]): RemoteCredential[] {
    if (!line.pairedAs) return []
    const first = this.usedUnderHubLabels.findIndex((u) => this.isPairedHere(u))
    if (first < 0) return []
    const named = new Set(listed.map((c) => this.keyOf(c)))
    return this.usedUnderHubLabels
      .slice(first)
      .filter((u) => u.label === line.pairedAs && !this.isPairedHere(u) && !named.has(this.keyOf(u)))
      .map((u) => ({ id: u.id, label: u.label, created: u.created, replaced: false, gone: true, ...(u.check ? { check: u.check } : {}), ...(u.own !== undefined ? { own: u.own } : {}) }))
  }

  /**
   * The machine's host says a full credential said hello there (#1712, `host_credential_used`). Not this hub's own (the
   * host's `check` of the event's nonce is of the secret this hub holds under that id, as `host.credentials`' is), and
   * not one this hub withdrew: kept as used and gone until a read of `host.credentials` answers for it, and that read
   * is started now, not waited for. If the host is stopped before it answers, the use stays on the row. Fire and
   * forget: nothing here is waited on by the host or by anything of this hub's
   */
  private credentialUsed(raw: unknown): void {
    const o = asObj(raw)
    const nonce = typeof o.nonce === 'string' && o.nonce.length >= 8 && o.nonce.length <= 64 ? o.nonce : null
    const check = typeof o.check === 'string' && o.check.length <= 64 ? o.check : null
    const c = credentialsOf([{ ...o, gone: true }])?.[0]
    if (!c || !nonce || !check || this.stopped) return
    const mine = this.pairedHere.get(c.id)
    // Past this line it is not the secret this hub holds under that id, so not the credential this link is open with (`own: false`)
    if (mine && check === credentialCheck(mine, nonce)) return
    if (this.revokedHere.has(c.id)) return
    const key = `${c.id}:${nonce}`
    if (this.reportedUsed.some((r) => r.key === key)) return
    const seq = ++this.reportSeq
    this.reportedUsed = [...this.reportedUsed, { key, seq, settled: false, answered: false, credential: { id: c.id, label: c.label, created: c.created, replaced: c.replaced, gone: true, own: false } }].slice(-REPORTED_USED_KEPT)
    const read = this.readCredentials
    const settle = () => {
      const entry = this.reportedUsed.find((r) => r.seq === seq)
      if (!entry) return
      entry.settled = true
      this.deps.broadcast({ type: 'machine_status', machine: this.info() })
    }
    if (!read) return settle()
    // The read answers for this credential, which then leaves `reportedUsed` (`watchCredentials`); one that fails leaves it shown
    void this.readForReported(read).then(settle, settle)
  }

  /**
   * A read that began after the event that asks for it (`credentialUsed`). Events that come while one is under way ask
   * for one more after it, not one each: a burst of first uses costs the machine's host one read in flight and one
   * waiting, and no more
   */
  private readForReported(read: () => Promise<void>): Promise<void> {
    if (this.reportRead) {
      this.reportReadAgain = true
      return this.reportRead
    }
    const run = async () => {
      do {
        this.reportReadAgain = false
        await read()
      } while (this.reportReadAgain)
    }
    const p = run().finally(() => {
      this.reportRead = null
    })
    this.reportRead = p
    return p
  }

  /**
   * Reads the machine's full credentials through `client` now and every `credentialsMs` while it is this link's and
   * connected (#1405, `host.credentials`): a pairing made there while the link is up shows on the row within that, not
   * only at the next link. A machine that does not know the method is not asked again on this link
   */
  private watchCredentials(client: RemoteClient): void {
    clearInterval(this.credentialsTimer)
    this.credentials = null
    // A link that came up paired, so the file was read there: what a closed link said of it is past
    this.fileUnreadable = false
    const stop = () => {
      clearInterval(this.credentialsTimer)
      if (this.readCredentials === read) this.readCredentials = null
    }
    const read = async (): Promise<void> => {
      if (this.client !== client || !client.connected) return stop()
      const startedAt = Date.now()
      // What the host told this hub of before this read was asked is in its answer (#1712)
      const told = this.reportSeq
      try {
        const nonce = randomBytes(16).toString('base64url')
        const r = asObj(await client.call('host.credentials', { nonce }))
        if (this.client !== client) return
        // Each entry's check read now, with this read's nonce: which are the secrets this hub holds (`own`), kept with the entry
        const listed = this.ownOf(credentialsOf(r.credentials), nonce)
        // Unreadable there (#1405 review): the last list stands, and the row says the file cannot be read
        const unreadable = typeof r.unreadable === 'string'
        if (listed === null && !unreadable) {
          // Not a file it cannot read (none there, or a host not run by serve): nothing to say about one
          if (this.fileUnreadable) {
            this.fileUnreadable = false
            this.deps.broadcast({ type: 'machine_status', machine: this.info() })
          }
          return stop()
        }
        const before = JSON.stringify(this.otherCredentials())
        /*
         * Answered: the host's own list has what it told of, if its record holds it. A host that started again with no
         * record of a credential (the file was removed or could not be written) says its ids (`usedIds`) without it, and
         * what the hub was told stays. A host that says no ids (from before this) is taken at its word, as before. A
         * reply that cannot be read keeps them all
         */
        if (listed) {
          const known = Array.isArray(r.usedIds) ? new Set(r.usedIds) : null
          this.reportedUsed = this.reportedUsed.filter((u) => u.seq > told || (known !== null && !known.has(u.credential.id)))
          if (known !== null) this.forgetRevoked(known, listed, startedAt)
          // What stays from before this read was answered for by it, and is not listed: withdrawn
          for (const u of this.reportedUsed) if (u.seq <= told) u.answered = true
        }
        if (listed) this.credentials = listed
        this.fileUnreadable = unreadable
        this.usedUnderHubLabels = this.ownOf(credentialsOf(r.usedUnderHubLabels), nonce) ?? []
        if (JSON.stringify(this.otherCredentials()) !== before) this.deps.broadcast({ type: 'machine_status', machine: this.info() })
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Unknown method: host.credentials')) return stop()
        this.deps.log?.(`[links] ${this.name}: could not read its full credentials: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.readCredentials = read
    void read()
    this.credentialsTimer = setInterval(() => void read(), this.deps.credentialsMs ?? CREDENTIALS_MS)
    this.credentialsTimer.unref?.()
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
   * stops offering this hub to its sessions. A machine that could not be told says so on the row, while the switch is on
   */
  protected async offerAsks(client: RemoteClient): Promise<void> {
    const self = this.deps.hubSelf?.()
    if (!self) return
    const on = this.record.asks === true
    let note: string | null = null
    try {
      await client.call('host.hubOffer', { hub: self, on })
    } catch (err) {
      if (on) note = `${this.name} could not be told yet (${(err as Error).message}); it is told again at the next connect`
    }
    if (this.client !== client) return
    const changed = note !== this.asksNote
    this.asksNote = note
    if (changed) this.deps.broadcast({ type: 'machine_status', machine: this.info() })
  }

  /**
   * Tells the machine this hub's "when agents compact" setting (#1376), as a change of its own preferences: the machine
   * starts and wakes its sessions from them. Said at every connect and when the hub's setting changes, so the machine
   * applies what the person set here. A machine from before it drops the field and applies nothing, which its sessions'
   * menu says (`agents.autoCompact` answers "Unknown method" there). Best effort: the next connect tells it again
   */
  async offerAutoCompact(client: RemoteClient | null = this.client): Promise<void> {
    const setting = this.deps.autoCompact?.()
    if (!setting || !client?.connected) return
    try {
      await client.call('prefs.set', { patch: { autoCompact: setting } })
    } catch (err) {
      this.deps.log?.(`[links] ${this.name}: could not tell it when agents compact (${errorMessage(err)}); it is told again at the next connect`)
    }
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
    this.parked = false
    void this.open()
  }

  /**
   * The person's Connect (`machines.reconnect`, #1134): opens now, forgetting the backoff, also a disconnected link and
   * also with Auto reconnect off (#1341), where it is the only way to try again. It is also the person's Start
   * (#1143): a host is started there even where they stopped it or the link stopped starting them. `start: false` is
   * the orchestrator's reconnect without its card, which opens the link and starts nothing the link would not.
   * `keepBackoff` is an agent's call that needs the machine (`reachForCall`, #1532): it opens now too, but the backoff
   * goes on from the step it was at instead of starting over, so calls cannot hold it at its short steps
   */
  connect(opts: { start?: boolean; keepBackoff?: boolean } = {}): void {
    if (opts.start !== false) {
      this.startAsked = true
      this.autoStarts = []
      this.restartsSpent = false
    }
    if (this.parked) return this.start()
    this.reconnect(opts.keepBackoff === true)
  }

  /**
   * Closes the link and tries none until the person connects it again (#1134). The machine stays linked; its sessions
   * keep running there, and the mirror lists them as last known
   */
  async disconnect(why?: string): Promise<void> {
    this.startAsked = false
    this.parked = true
    this.stopped = true
    this.clearRetry()
    this.client?.close()
    this.client = null
    if (why) this.deps.log?.(`[links] ${this.name}: ${why}`)
    this.setStatus('disconnected', null)
    await this.tunnel.close()
  }

  /**
   * Auto reconnect on or off (#1341), as the registry now keeps it. Off while connected leaves the link up: the switch
   * says what happens after the next drop. Off while the link is away cancels the retry that was waiting, and the row
   * says it waits for Connect. On while the link is away tries again now, as at the hub's start
   */
  setAutoReconnect(on: boolean): void {
    this.record = { ...this.record, autoReconnect: on }
    // An operation's retries stand: the switch takes effect once it ends (cancelling them rolled an update back)
    if (!on && this.status !== 'versions_differ' && !this.inOperation()) this.clearRetry()
    // A swap's hold was waiting on the retry just cancelled: the row would say updating for good
    if (!on && this.status === 'updating' && !this.inOperation()) this.setStatus('unreachable', `The host on ${this.name} was being swapped; ${WAITS_FOR_PERSON}`)
    this.noteNextStep()
    if (on && !this.parked && !this.stopped && !this.held && AWAY.has(this.status)) this.reconnect()
    // Said to whoever follows the machine: a link that was waiting to retry now waits for the person (the reports of a child there)
    this.deps.broadcast({ type: 'machine_status', machine: this.info() })
  }

  /** An unreachable row says what comes next (`NEXT_STEP`); said again when the switch moves */
  private noteNextStep(): void {
    if (this.status !== 'unreachable' || !this.error) return
    const next = this.error.replace(NEXT_STEP, `; ${this.autoReconnect ? KEEPS_TRYING : WAITS_FOR_PERSON}`)
    if (next !== this.error) this.setStatus('unreachable', next)
  }

  /**
   * What the person asks of a disconnected machine runs over its link's ssh (#1134): it is opened for that. Nothing
   * closes a link on its own, so it stays up (the person's Disconnect closes it)
   */
  openForOperation(): void {
    if (!this.parked) return
    this.start()
  }

  /** Opens again now, forgetting the backoff (`machines.reconnect`, or the person accepted the versions) */
  reconnect(keepBackoff = false): void {
    this.clearRetry()
    if (!keepBackoff) this.attempt = 0
    /*
     * An opening already under way answers this one (`open`). Its retry, if it set one, was just cleared: once it ends
     * without a client of its own it opens again now, or the link would wait for nothing (#1293 re-review)
     */
    const under = this.opening
    if (under) {
      // The person's Connect joins the attempt under way, and says so: a quiet retry shows nothing of its own (#1398)
      if (this.status === 'away') this.setStatus('connecting', null)
      const set = this.retriesSet
      void under.finally(() => {
        // It set a retry of its own after this (a start that failed, a refusal): that backoff stands
        if (this.stopped || this.held || this.opening || this.retriesSet !== set) return
        if (this.client === null || this.client === this.gaveUp) this.retryLater(0, 'within')
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
    this.clearRetry()
    this.client?.close()
    this.client = null
    for (const w of [...this.statusWaiters]) w()
    await this.tunnel.close()
  }

  private open(): Promise<void> {
    if (this.held) return Promise.resolve()
    this.opening ??= this.doOpen().finally(() => {
      this.opening = null
      for (const w of [...this.statusWaiters]) w()
      // An attempt that failed set its status while it was still under way: the machine waits for the person only from here,
      // and whoever reads `waitsForPerson` on a status event (the reports of a working child) is told again
      if (this.waitsForPerson) this.deps.broadcast({ type: 'machine_status', machine: this.info() })
    })
    return this.opening
  }

  private async doOpen(): Promise<void> {
    if (this.stopped) return
    // Looking again at the versions with Auto reconnect off (#1341): reads the line, opens no link and starts no host
    const readsOnly = this.readsOnly
    this.readsOnly = false
    const quiet = this.quietRetry
    this.quietRetry = false
    // Kept only when it gave up redialling: `connectClient` points it at what the connection line says
    if (this.client !== this.gaveUp) {
      this.client?.close()
      this.client = null
    }
    // Held back (#1143): the row stays `stopped` while the line is read again, rather than flicker to `connecting`
    if (this.heldBack && !this.startAsked) this.setStatus('stopped', this.heldBack)
    // A machine that is away stays so between the backoff's attempts, instead of flipping to `connecting` and back at each (#1398)
    else if (!(quiet && this.status === 'away')) this.setStatus('connecting', null)
    let endpoint = await this.openTunnel()
    if (!endpoint) return
    // ssh got an answer: the machine is not away any more, whatever comes of the rest of the attempt
    if (this.status === 'away') this.setStatus('connecting', null)
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
    if (readsOnly && !endpoint.line.hostRunning) {
      this.setStatus('unreachable', `Centralu is no longer running on ${this.name}; ${WAITS_FOR_PERSON}`)
      return
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
        // With Auto reconnect off nothing asks again (#1341): the row says so instead of waiting on a retry
        if (!this.autoReconnect) return this.setStatus('unreachable', `${hold.by} is swapping the host on ${this.name}; ${WAITS_FOR_PERSON}`)
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
    if (endpoint.line.credential) this.pairedHere.set(endpoint.line.credential, endpoint.token ? verifierOf(endpoint.token) : null)
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
    if (readsOnly) {
      this.setStatus('unreachable', `The versions on ${this.name} agree now; Auto reconnect is off, so ${WAITS_FOR_PERSON}`)
      return
    }
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
      const message = (err as Error).message
      // The machine does not answer at all (asleep, off, off the network): a state, not an error (#1398)
      this.setStatus(isNoAnswer(message) ? 'away' : 'unreachable', message)
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
      this.retryLater(this.deps.versionsRetryMs ?? 60_000, 'reads')
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
      idle.updateEndpoint(endpoint.url, endpoint.token, endpoint.line.credential)
      return
    }
    this.client?.close()
    this.client = null
    const client = new RemoteClient(
      // A host that can prove it holds the token is asked to, before the token goes out (#838)
      {
        redials: LINK_REDIALS,
        ...this.deps.client,
        url: endpoint.url,
        token: endpoint.token,
        proveHost: endpoint.line.proof === true,
        // The credential paired for this hub at this link (#1405): the host proves under its verifier
        ...(endpoint.line.credential ? { credential: endpoint.line.credential } : {}),
      },
      {
        hello: (h) => void this.onHello(client, h),
        event: (e) => this.onEvent(e),
        // The machine's calls to this hub (#550): answered as this machine, whatever they say, by the hub's allowlist
        ...(this.deps.reverse ? { call: (method: string, params: unknown, signal: AbortSignal) => this.deps.reverse!({ id: this.id, name: this.name }, method, params, signal) } : {}),
        terminal: (f) => this.deps.terminal({ ...f, terminalId: this.q.id(f.terminalId) }),
        down: (reason) => {
          if (this.client !== client) return
          /*
           * A short drop is dialled again at once, with the switch off too (#1341, owner decision): the client redials the
           * same forward a few times (`LINK_REDIALS`, about 6 s, no ssh), and a blip or a host swapped in place is back
           * within them. Only when they fail (`gaveUp`) does an off machine stay down until the person's Connect
           */
          this.setStatus('unreachable', `The link to ${this.name} dropped (${reason}); ${KEEPS_TRYING}`)
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
          // Nothing will use the forward before the person's Connect, which opens it again (#1341)
          if (!this.autoReconnect) void this.tunnel.close().catch(() => {})
          this.setStatus('unreachable', `${this.name}'s host did not answer on the link (${reason}); ${this.autoReconnect ? 'asking the machine again' : WAITS_FOR_PERSON}`)
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
          /*
           * Its credential withdrawn there while the link held it (#1405 review): pairing again is the way on, and the row
           * keeps saying it happened. Not when this hub had already paired anew (its own earlier link, closed late)
           */
          const withdrawn = r.code === 4001 && r.reason === 'credential withdrawn'
          if (withdrawn && client.credential !== undefined && client.credential === this.endpoint?.line.credential) {
            this.ownCredentialTaken = true
            this.deps.log?.(`[links] ${this.name}: its host closed the link, this computer's credential there was withdrawn; pairing again`)
          }
          /*
           * Its serve.json cannot be read there (#1405 review, transport/server.ts `CREDENTIAL_FILE_UNREADABLE`): nothing
           * withdrew this hub's credential, so its own is not marked gone, and the row says the file cannot be read
           */
          const unreadable = r.code === 4001 && r.reason === 'credential file unreadable'
          if (unreadable) this.fileUnreadable = true
          const why = r.proving
            ? `${this.name} runs an older Centralu host than the one installed there, which cannot prove it holds the link's token`
            : r.code === 4002
              ? (r.error?.message ?? 'The remote host speaks another protocol')
              : withdrawn
                ? `${this.name} withdrew this computer's credential there`
                : unreadable ? `${this.name} cannot read its credential file` : `${this.name} refused the link's token`
          if (!this.refusedOnce) {
            this.refusedOnce = true
            this.setStatus('connecting', why)
            return this.retryLater(0, 'within')
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
    this.updateContinued = h.updateContinued ? new Map(h.updateContinued.map((c) => [c.sessionId, c.at])) : null
    this.switched = null
    this.switchTried = false
    this.switchFailure = null
    this.seen()
    this.setStatus('connected', null)
    // Who this hub is, and whether the machine's sessions may ask it (#550); said at every connect
    void this.offerAsks(client)
    // And when agents compact (#1376)
    void this.offerAutoCompact(client)
    // Who else holds full access there, kept current while the link is up (#1405)
    this.watchCredentials(client)
    /*
     * The UI re-reads this machine's sessions and projects, and wakes the ones that were live
     * before and are not now (a remote host that restarted without a keeper). Sent on every
     * connect, replay or not: the UI read the mirror while the link was away, marked unreachable.
     */
    this.deps.broadcast({ type: 'machine_resync', machineId: this.id })
    // A machine on an older release follows the hub's version when its automatic updates are on (#1508)
    this.connectedNow()
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
    // A full credential was just used on the machine (#1712): kept on its row, passed on to no one
    if (raw.type === 'host_credential_used') {
      this.credentialUsed(raw.credential)
      return
    }
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
    this.setStatus('unreachable', `The connection to ${this.name} ended (${reason}); ${this.nextStep()}`)
    this.retryLater()
  }

  /** What a row of an unreachable machine says comes next (`NEXT_STEP`) */
  private nextStep(): string {
    return this.autoReconnect ? KEEPS_TRYING : WAITS_FOR_PERSON
  }

  /**
   * Asks the machine again after a delay. `backoff` (the default): the next step of the backoff, and nothing at all
   * while Auto reconnect is off (#1341), where only the person's Connect tries again (after the client's quick redials,
   * which an off machine keeps). `within`: part of an attempt that
   * is under way or of the person's own request (a refusal asked again at once, a Connect that met an opening), so it
   * goes ahead either way. `reads`: the versions check looking again for a change on either side; with the switch off it
   * reads the line and connects nothing (`readsOnly`)
   */
  /** The link is up, or was just: remembers when, and keeps it for the next start of this host */
  private seen(): void {
    this.lastConnectedAt = Date.now()
    this.deps.registry.setLastConnected?.(this.id, this.lastConnectedAt)
  }

  /** Cancels the retry that waits, and the time it was due */
  protected clearRetry(): void {
    clearTimeout(this.retryTimer)
    this.nextAttemptAt = null
  }

  protected retryLater(fixedMs?: number, mode: 'backoff' | 'within' | 'reads' = 'backoff'): void {
    if (this.stopped || this.held) return
    if (mode === 'backoff' && !this.autoReconnect && !this.inOperation()) return
    clearTimeout(this.retryTimer)
    const [first, max] = this.deps.retryMs ?? RETRY_MS
    const delay = fixedMs ?? Math.min(max, first * 2 ** this.attempt++)
    this.retriesSet++
    this.nextAttemptAt = Date.now() + delay
    this.retryTimer = setTimeout(() => {
      this.readsOnly = mode === 'reads' && !this.autoReconnect
      // Not when an attempt is under way: the flag would wait for the person's next Connect
      this.quietRetry = mode === 'backoff' && !this.opening
      this.nextAttemptAt = null
      void this.open()
    }, delay)
    this.retryTimer.unref?.()
    // The status does not change between attempts that fail alike, so the new time is said here (#1398)
    if (this.status === 'away') this.deps.broadcast({ type: 'machine_status', machine: this.info() })
  }

  protected setStatus(status: MachineStatus, error: string | null): void {
    // The link was up until now (#1398): that is when the machine was last seen, not when it said hello
    if (this.status === 'connected' && status !== 'connected') this.seen()
    const changed = status !== this.status || error !== this.error
    if (status === 'connected') this.callFailure = null
    this.status = status
    this.error = error
    if (changed) {
      if (error) this.deps.log?.(`[links] ${this.name}: ${status}: ${error}`)
      this.deps.broadcast({ type: 'machine_status', machine: this.info() })
      for (const w of [...this.statusWaiters]) w()
    }
  }
}
