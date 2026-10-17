import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import type { DelegationHost } from './delegation-flow.js'
import { RECONNECTING_FLAG_MS, interruptionAfter } from './interruptions.js'
import type { SessionTrashHost } from './session-trash.js'

/**
 * What the interruption watch reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type InterruptionWatchHost = Pick<DelegationHost, 'disposing' | 'emit' | 'handingOver' | 'meta'> & Pick<SessionTrashHost, 'record'>

/**
 * A session's `interruption` (#698), kept with its events: the turn's ending as `interruptionAfter` reads it, the
 * `reconnecting` flag of a tool retrying past `RECONNECTING_FLAG_MS`, and the stop of a turn a quit cut. The rules are
 * interruptions.ts; this holds the clocks and writes the session. Moved out of the session manager as it was (#428);
 * what it reaches of the manager is `InterruptionWatchHost`.
 */
export class InterruptionWatch {
  constructor(private readonly host: InterruptionWatchHost) {}

  /** Sessions whose tool is `retrying`, and since when (#698): flagged `reconnecting` once it lasts `RECONNECTING_FLAG_MS` */
  readonly reconnecting = new Map<string, { since: number; timer: ReturnType<typeof setTimeout> }>()

  /**
   * Keeps `interruption` with the event (#698): `interruptionAfter` for the turn's ending, and the `reconnecting` flag
   * for a tool that has been `retrying` past `RECONNECTING_FLAG_MS`. Only `retrying` starts the clock: a quiet session
   * is not a stuck one.
   */
  trackInterruption(e: NormalizedEvent, m: SessionInfo, endedTurn: boolean): void {
    const next = interruptionAfter(e, Date.now(), endedTurn)
    // The reconnecting flag stands while the tool still retries, whatever else the turn says meanwhile
    const stillReconnecting = m.interruption?.reason === 'reconnecting' && m.state === 'working' && m.activity === 'retrying'
    if (next !== undefined && !stillReconnecting) m.interruption = next
    const retrying = m.state === 'working' && m.activity === 'retrying'
    if (retrying) {
      if (!this.reconnecting.has(m.id)) this.watchReconnecting(m.id)
      return
    }
    this.stopWatchingReconnect(m.id)
    if (m.interruption?.reason === 'reconnecting') m.interruption = null
  }

  /** Ends a reconnect episode's clock: the tool stopped retrying, the turn ended, or the session is gone */
  stopWatchingReconnect(sessionId: string): void {
    const watch = this.reconnecting.get(sessionId)
    if (watch) clearTimeout(watch.timer)
    this.reconnecting.delete(sessionId)
  }

  private watchReconnecting(sessionId: string): void {
    // A leaving host starts no clock: its processes still speak while they are let go, and the next host watches them (#698)
    if (this.host.handingOver || this.host.disposing) return
    const since = Date.now()
    // The entry stays after it fires, so a later event of the same episode does not start the clock again
    const timer = setTimeout(() => {
      const m = this.host.meta.get(sessionId)
      if (!m || m.state !== 'working' || m.activity !== 'retrying') return
      console.error(`[sessions] ${sessionId.slice(0, 8)} has been reconnecting to its API for ${Math.round(RECONNECTING_FLAG_MS / 60_000)} min`)
      m.interruption = { reason: 'reconnecting', at: since }
      this.host.emit({ type: 'interruption', sessionId, interruption: m.interruption })
    }, RECONNECTING_FLAG_MS)
    timer.unref?.()
    this.reconnecting.set(sessionId, { since, timer })
  }

  /**
   * The turn went with its process (#698): a start found the session mid-turn with no process left (a full quit, a
   * reboot, a crash the keeper did not survive), or a kept process could not be re-attached. The session is reset to
   * `idle`, which used to leave no mark at all: the conversation simply stopped. A line now says so, and the
   * interruption puts the session in the inbox with a way to continue.
   */
  markStoppedByQuit(m: SessionInfo, announce: boolean): void {
    m.interruption = { reason: 'quit', at: Date.now() }
    const notice: NormalizedEvent = {
      type: 'notice',
      sessionId: m.id,
      level: 'warning',
      from: 'Centralu',
      label: 'stopped',
      text: 'Centralu quit or restarted while this turn was running, so the turn stopped before it finished. Send a message to continue.',
    }
    const seq = this.host.record.persistMessage(notice, m)
    if (!announce) return
    this.host.emit(seq != null ? ({ ...notice, seq } as NormalizedEvent) : notice)
    this.host.emit({ type: 'interruption', sessionId: m.id, interruption: m.interruption })
  }

  /** Every reconnect clock ends: the host is leaving (#698) */
  stopAll(): void {
    for (const id of [...this.reconnecting.keys()]) this.stopWatchingReconnect(id)
  }
}
