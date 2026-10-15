import { randomUUID } from 'node:crypto'
import type { ApprovalDetail } from '@cc/protocol'
import type { QueuedRequest, Store } from '../dev-services/store.js'
import type { AgentRunWait } from './app-agents.js'

/**
 * A start_agent request waiting on the person's card (#673), as stored in `agent_start_requests`: everything the start
 * needs once allowed, so a host that takes over after a swap or restart can raise the card again and start the child.
 */
export type AgentStartRequest = {
  requestId: string
  callerId: string
  projectId: string
  tool: string
  model?: string
  effort?: string
  worktreeBranch?: string
  task: string
  unchecked?: string
  /** start_agent's code intelligence choice (#686) */
  lsp?: boolean
  /**
   * The start is allowed (by the card or the project's trust) and waits only for memory (#686): a host that takes it
   * over starts it when memory allows, without raising the card again
   */
  allowed?: true
  detail: Extract<ApprovalDetail, { kind: 'agent_start' }>
}

/** One such request while this host serves it (`SessionManager.agentStarts`) */
export type AgentStartRecord = {
  req: AgentStartRequest
  /** The call that raised it has answered "pending" (#673): how it ends is told to the caller as a message */
  detached: boolean
  ended?: { childId: string } | { error: string }
  /** Resolves when it ends (agent_session wait on the handle) */
  done: Promise<void>
  end: () => void
  /** Allowed, and queued until memory recovers (#686): what was read when it was queued */
  lowMemory?: LowMemory
  /** Ends the wait for memory, when the request ends another way (withdrawn, the caller deleted) */
  stopWaiting?: () => void
  /** The caller's waits on the handle now, ended when a handoff gives the request to another session (#693) */
  leaving?: Set<() => void>
}

/** A start queued for memory (#686), as the caller reads it */
export type LowMemory = { available: string; floor: string; maxWaitMinutes: number }

/** One ask_project call's work in the target project (#371 part B) — see `SessionManager.delegations` */
export type Delegation = {
  callerId: string
  /** The delegated session, in the target project */
  sessionId: string
  target: { id: string; name: string; path: string }
  wait: AgentRunWait
  /** The turn's outcome, never rejecting */
  outcome: Promise<{ ok: true; answer?: string } | { ok: false; error: string }>
  readonly settled: boolean
  /** What the delegated session waits on, when it waits on the person */
  notice(): string | undefined
  /** A task that joined the person's running turn: caller cancellation must leave that turn alone. */
  joinedTurn?: boolean
  /** Ends only the caller's wait, keeping the target's receipt watcher and observers alive. */
  waitCancelled?: Promise<{ ok: false; error: string }>
  /** Ends the wait; interrupts only an assigned turn or an explicit stop of the target itself. */
  stop(why: string, targetStop?: boolean): void
  /** A child start_agent started in the caller's own project (#561), rather than ask_project's delegated session */
  agent?: boolean
  /** How many of the caller's calls are waiting on it right now (`awaitAgent`, `awaitDelegation`) */
  waiters?: number
  /** The owner's calls waiting on it now, ended when a handoff gives it to another session (#693) */
  leaving?: Set<() => void>
}

/** The store's record that a session's owed report is held over its own background work (#721), kept across a swap */
export const pausedReportKey = (sessionId: string) => `report_paused:${sessionId}`
/** A task a paused report waits on (#721), as kept in `report_paused:<session>` */
export type PausedTask = { id: string; description: string }
/** The tasks of a stored pause, or null when there is none (an unreadable value is a pause on nothing known) */
export function readPausedTasks(raw: string | null): PausedTask[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((t): t is PausedTask => !!t && typeof t.id === 'string' && typeof t.description === 'string')
      : []
  } catch {
    return []
  }
}

/** A delegated turn's link (#676): who gave the turn, and the cards it was already told of */
export type TurnOwner = { callerId: string; untilTurnEnd: boolean; told: Set<string>; turnId: string }

/** A linked machine's session an orchestrator asked to hear about (#82 phase 4) */
export type LinkedReport = { orchestratorId: string; busy: boolean }

/** What one owner change moves (`ChildOwnership.moveOwner`), as the session manager chose it */
export type OwnerMove = {
  /** The child sessions that move, in the order the handoff note lists them */
  sessions: readonly string[]
  /** Children a wait of the original had taken the report mark down for: the mark is owed to the new owner */
  armReports: readonly string[]
  /** The original's start_agent requests still open that move with it */
  starts: readonly AgentStartRecord[]
  /** Whether the requests the original queued move too (not for a removed original: the trash drops them) */
  queued: boolean
}

type OwnershipStore = Pick<
  Store,
  | 'setReportMark'
  | 'clearReportMark'
  | 'setAppSetting'
  | 'deleteAppSetting'
  | 'setDelegatedTurn'
  | 'clearDelegatedTurn'
  | 'setDelegatedTurnTold'
  | 'addQueuedRequest'
  | 'removeQueuedRequest'
  | 'markQueuedDelivering'
>

/**
 * Who owns a child session's work (#428): the report a child owes and to whom, a report paused over the child's own
 * background work, the turn another session gave it, the requests held for it while it is busy, the delegations and
 * start requests a session made, and what a handoff gave away. Each change that has a store mirror writes it here, so
 * memory and store do not drift apart; reads go through the read-only maps.
 *
 * An owner change is one operation (`moveOwner`), so a handoff does not keep these maps in step by hand. Deciding what
 * moves, and the store's own transaction for it (`Store.moveChildren`), stay with the session manager, which knows the
 * sessions' state.
 */
export class ChildOwnership {
  /**
   * Session asked to be reported on completion -> orchestrator to notify (removed once notified). Mirrored in the
   * store's `report_marks` (v49, #646) through `markReport` / `clearReport`, so a host swap (#280) does not lose
   * "you will be told when it ends": the constructor reads the marks back for the sessions the keeper kept.
   */
  private readonly reports = new Map<string, string>()
  readonly awaitingReport: ReadonlyMap<string, string> = this.reports
  /**
   * An auto observer's own mid-turn note (#646), `<observer>><session>` -> the reader its receipt is held on. The
   * observer's `status` and `wait` read this, never the owner's delegation, until a read takes its settled outcome.
   */
  private readonly notes = new Map<string, { run: Delegation; waiters: number; told: boolean }>()
  readonly observerNotes: ReadonlyMap<string, { run: Delegation; waiters: number; told: boolean }> = this.notes
  /**
   * Reports held over the session's own background work (#721): a turn ended while work it started still ran, so the
   * work is paused, not over. The report stays owed in `awaitingReport` (its caller was told once that it paused) and
   * goes out at the end of a turn with none of that work left, or `PAUSED_REPORT_SETTLE_MS` after the work ended with
   * no turn following. Holds the tasks it paused on (each id and description, for how they ended and for `stop`).
   * Mirrored in the app setting `report_paused:<session>`, so a swap keeps it with the mark.
   */
  private readonly paused = new Map<string, PausedTask[]>()
  readonly pausedReports: ReadonlyMap<string, PausedTask[]> = this.paused
  /** The settle timer of a paused report whose background work has ended (#721) */
  private readonly pausedSettles = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Delegated turns (#676): session -> the session that gave it the turn it is running, and the cards that session was
   * already told of. While the turn runs, its question cards go to that session as well as to the person, and its
   * approval cards are told to it (`routeCard`). Set when another session's work starts the turn (`ask_project` into a
   * session at rest, `start_agent`, `agent_session` send, `send_to_session` to a session at rest); never for work that
   * joins a turn the person started. Ends with the delegation's outcome, or with the turn (`untilTurnEnd`: a
   * `send_to_session` turn, or one a new host found in the store). Mirrored in the store's `delegated_turns` (v51) so
   * a host swap keeps the link while the kept session waits on a question.
   */
  private readonly turns = new Map<string, TurnOwner>()
  readonly turnOwners: ReadonlyMap<string, TurnOwner> = this.turns
  /**
   * Requests held for a busy session (#677, `ifBusy: "queue"`): session -> its queue, oldest first. Each goes in as a new
   * turn of its requester's when the session's running turn ends (`drainQueue`). Mirrored in the store's
   * `queued_requests` (v52), so a host swap keeps them.
   */
  private readonly queues = new Map<string, QueuedRequest[]>()
  readonly queued: ReadonlyMap<string, readonly QueuedRequest[]> = this.queues
  /**
   * The queued request being delivered now, per session (#684 review): it stays first in its queue, and its row stays
   * in the store marked `delivering_at`, until the session's turn actually starts (`onEvent`); only then is it taken
   * off. While it is here the session counts as busy and no other drain runs for it, so waking a sleeping session
   * cannot let a second request in, and a swap or crash mid-delivery leaves the row for the next host.
   */
  private readonly deliveries = new Map<string, string>()
  readonly delivering: ReadonlyMap<string, string> = this.deliveries
  /**
   * ask_project's delegations still owed to their caller (#371 part B) — `<caller session>><target project>><target session>` -> the
   * delegation. One per chosen session at a time: a second task while the first runs is refused, and a call with no task waits
   * on this one. Removed once the caller has read the outcome; an outcome nobody comes back for goes with the caller.
   */
  private readonly runs = new Map<string, Delegation>()
  readonly delegations: ReadonlyMap<string, Delegation> = this.runs
  /**
   * start_agent requests whose card stands or stood (#673) — request id -> the request. A card is no longer withdrawn
   * when the call's bound passes: the call answers "pending" with the request id as a handle, the card stays until the
   * person answers, and an approval starts the child then. Mirrored in the store's `agent_start_requests` while it
   * stands, so the next host raises it again (`resumeAgentStart`). Kept after it ends, for agent_session on the handle,
   * until the caller goes.
   */
  private readonly starts = new Map<string, AgentStartRecord>()
  readonly agentStarts: ReadonlyMap<string, AgentStartRecord> = this.starts
  /**
   * What a handoff gave away (#693): child session or start request id -> the original and the session that took over.
   * An original that stays (a handoff that keeps it) and asks about one of them is told where it went, rather than "not
   * a session this session started". Live only, like the delegations it explains; goes when either session is deleted.
   */
  private readonly given = new Map<string, { from: string; to: string }>()
  readonly handedOver: ReadonlyMap<string, { from: string; to: string }> = this.given
  /**
   * A linked machine's sessions whose turn the orchestrator asked to hear about (`reportBack`, #82 phase 4), by
   * qualified id. `busy` is whether that turn was seen working yet, so a state the machine reports before the turn
   * starts (the session waking) is not taken for its end.
   */
  private readonly linked = new Map<string, LinkedReport>()
  readonly linkedReports: ReadonlyMap<string, LinkedReport> = this.linked

  constructor(private readonly store: OwnershipStore) {}

  /** A new mark is new work: a pause of the work before it is not this work's, nor one an older build left stored */
  markReport(sessionId: string, callerId: string): void {
    this.unpauseReport(sessionId)
    this.store.deleteAppSetting(pausedReportKey(sessionId))
    this.reports.set(sessionId, callerId)
    this.store.setReportMark(sessionId, callerId)
  }
  clearReport(sessionId: string): void {
    this.unpauseReport(sessionId)
    if (!this.reports.delete(sessionId)) return
    this.store.clearReportMark(sessionId)
  }
  /** A mark the previous host left, kept for a session the keeper kept (the store already holds it) */
  adoptReport(sessionId: string, callerId: string, paused: PausedTask[] | null): void {
    this.reports.set(sessionId, callerId)
    if (paused) this.paused.set(sessionId, paused)
  }
  /** Holds the session's owed report over its own background work (#721); the mark itself stays as it is */
  pauseReport(sessionId: string, running: readonly PausedTask[]): void {
    const held = this.paused.get(sessionId) ?? []
    const added = running.filter((t) => !held.some((h) => h.id === t.id)).map((t) => ({ id: t.id, description: t.description }))
    if (!this.paused.has(sessionId) || added.length) {
      const next = [...held, ...added]
      this.paused.set(sessionId, next)
      this.store.setAppSetting(pausedReportKey(sessionId), JSON.stringify(next))
    }
  }
  unpauseReport(sessionId: string): void {
    this.stopSettling(sessionId)
    if (this.paused.delete(sessionId)) this.store.deleteAppSetting(pausedReportKey(sessionId))
  }
  /** Starts a paused report's settle timer (#721); the session manager decides when, and what it does */
  settleAfter(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
    this.pausedSettles.set(sessionId, timer)
  }
  /** Ends a paused report's settle timer, or forgets one that fired; with no session, every one */
  stopSettling(sessionId?: string): void {
    if (sessionId === undefined) {
      for (const timer of this.pausedSettles.values()) clearTimeout(timer)
      this.pausedSettles.clear()
      return
    }
    const timer = this.pausedSettles.get(sessionId)
    if (timer) clearTimeout(timer)
    this.pausedSettles.delete(sessionId)
  }

  ownTurn(sessionId: string, callerId: string, untilTurnEnd: boolean): void {
    const turnId = randomUUID()
    this.turns.set(sessionId, { callerId, untilTurnEnd, told: new Set(), turnId })
    this.store.setDelegatedTurn(sessionId, callerId, turnId)
  }
  /** Ends the link; with `callerId`, only that caller's (a later delegation by someone else is not cut) */
  releaseTurn(sessionId: string, callerId?: string): void {
    const owner = this.turns.get(sessionId)
    if (!owner || (callerId && owner.callerId !== callerId)) return
    this.turns.delete(sessionId)
    this.store.clearDelegatedTurn(sessionId)
  }
  /** A link the previous host left, kept for a session the keeper kept still in its turn (the store already holds it) */
  adoptTurn(sessionId: string, owner: TurnOwner): void {
    this.turns.set(sessionId, owner)
  }
  /** The turn's owner was told of a card (#676), once per card handle */
  markTurnTold(sessionId: string, handle: string): void {
    const owner = this.turns.get(sessionId)
    if (!owner) return
    owner.told.add(handle)
    this.store.setDelegatedTurnTold(sessionId, [...owner.told])
  }

  /** Holds a request for a busy session, last in its queue; returns its place */
  enqueue(r: QueuedRequest): number {
    const list = [...(this.queues.get(r.sessionId) ?? []), r]
    this.queues.set(r.sessionId, list)
    this.store.addQueuedRequest(r)
    return list.length
  }
  /** A request the previous host left, read back at startup (the store already holds it) */
  adoptQueued(r: QueuedRequest): void {
    this.queues.set(r.sessionId, [...(this.queues.get(r.sessionId) ?? []), r])
  }
  dropQueued(which: (r: QueuedRequest) => boolean): QueuedRequest[] {
    const dropped: QueuedRequest[] = []
    for (const [id, list] of [...this.queues]) {
      const now = this.deliveries.get(id)
      if (now && list.some((r) => r.id === now && which(r))) this.deliveries.delete(id)
      const keep = list.filter((r) => !which(r))
      for (const r of list) if (which(r)) { dropped.push(r); this.store.removeQueuedRequest(r.id) }
      if (keep.length) this.queues.set(id, keep)
      else this.queues.delete(id)
    }
    return dropped
  }
  /** A queued request goes in now (#684 review): the session is busy with it until its turn starts */
  startDelivering(sessionId: string, requestId: string): void {
    this.deliveries.set(sessionId, requestId)
    this.store.markQueuedDelivering(requestId, Date.now())
  }
  /** The session's turn started while a queued request was being delivered to it: that request is delivered (#684 review) */
  queuedTurnStarted(sessionId: string): void {
    const id = this.deliveries.get(sessionId)
    if (!id) return
    this.deliveries.delete(sessionId)
    this.dropQueued((x) => x.id === id)
  }

  setDelegation(key: string, d: Delegation): void {
    this.runs.set(key, d)
  }
  /** Drops the delegation under `key`; with `only`, only while that one is still there */
  dropDelegation(key: string, only?: Delegation): void {
    if (only && this.runs.get(key) !== only) return
    this.runs.delete(key)
  }
  setObserverNote(key: string, note: { run: Delegation; waiters: number; told: boolean }): void {
    this.notes.set(key, note)
  }
  /** Drops the note under `key`; with `only`, only while that one is still there */
  dropObserverNote(key: string, only?: { run: Delegation; waiters: number; told: boolean }): void {
    if (only && this.notes.get(key) !== only) return
    this.notes.delete(key)
  }
  /** The notes a session took as an observer, and the ones taken on it */
  dropObserverNotesOf(sessionId: string): void {
    for (const key of [...this.notes.keys()]) if (key.startsWith(`${sessionId}>`) || key.endsWith(`>${sessionId}`)) this.notes.delete(key)
  }

  addAgentStart(rec: AgentStartRecord): void {
    this.starts.set(rec.req.requestId, rec)
  }
  dropAgentStart(requestId: string): void {
    this.starts.delete(requestId)
  }

  /** A start_agent call whose request a handoff gave away made its child (#693): the child is the new owner's */
  recordHandedOver(id: string, from: string, to: string): void {
    this.given.set(id, { from, to })
  }
  /** What a handoff gave away from the session, or to it, or the given work itself */
  forgetHandedOver(sessionId: string): void {
    for (const [id, h] of [...this.given]) if (id === sessionId || h.from === sessionId || h.to === sessionId) this.given.delete(id)
  }

  setLinkedReport(sessionId: string, wait: LinkedReport): void {
    this.linked.set(sessionId, wait)
  }
  dropLinkedReport(sessionId: string): void {
    this.linked.delete(sessionId)
  }

  /**
   * Moves what `from` owns of the given children to `to`, in memory (#693, #738): their report marks, the marks a wait
   * had taken down (`armReports`), the turns `from` gave them, its delegations and observer notes on them (their keys
   * name the caller), the requests it queued (`queued`), linked machines' reports, and the start requests that made
   * them. `moveCards` runs next, for the cards that stand for the moving `starts`; then what moved is recorded as
   * handed over, and the original's calls still waiting on it are ended.
   *
   * The caller has already moved what is stored (`Store.moveChildren`) and the sessions' own `askedBy` and
   * `parentSessionId`. Nothing here awaits, so no event lands in the middle.
   */
  moveOwner(from: string, to: string, move: OwnerMove, moveCards: () => void): void {
    const { sessions, armReports, starts } = move
    const moving = new Set(sessions)
    for (const id of sessions) if (this.reports.get(id) === from) this.reports.set(id, to)
    for (const id of armReports) this.reports.set(id, to)
    for (const [id, owner] of this.turns) if (moving.has(id) && owner.callerId === from) owner.callerId = to
    // A delegation's key names its caller (`<caller>><child>`, `<caller>><project>><child>`)
    for (const [key, d] of [...this.runs]) {
      if (d.callerId !== from || !moving.has(d.sessionId)) continue
      this.runs.delete(key)
      d.callerId = to
      this.runs.set(to + key.slice(from.length), d)
    }
    for (const [key, n] of [...this.notes]) {
      if (!key.startsWith(`${from}>`) || !moving.has(key.slice(from.length + 1))) continue
      this.notes.delete(key)
      this.notes.set(`${to}>${key.slice(from.length + 1)}`, n)
    }
    if (move.queued) for (const list of this.queues.values()) for (const r of list) if (r.callerSessionId === from) r.callerSessionId = to
    for (const [id, wait] of this.linked) if (wait.orchestratorId === from && moving.has(id)) wait.orchestratorId = to
    // A start that already made its child: its handle follows the child
    for (const r of this.starts.values()) if (r.req.callerId === from && r.ended && 'childId' in r.ended && moving.has(r.ended.childId)) r.req.callerId = to
    moveCards()
    /*
     * The original learns what it no longer follows (#693 review): a handoff can keep it, and its next agent_session or
     * ask_project about one of these says where it went. Its calls still waiting on one of them end now, with that
     * answer, so the result is read once, by the new session.
     */
    for (const id of [...sessions, ...starts.map((r) => r.req.requestId)]) this.given.set(id, { from, to })
    for (const r of starts) if (!r.detached) r.detached = true
    for (const d of this.runs.values()) if (d.callerId === to && moving.has(d.sessionId)) for (const leave of [...(d.leaving ?? [])]) leave()
    for (const r of starts) for (const leave of [...(r.leaving ?? [])]) leave()
  }
}

