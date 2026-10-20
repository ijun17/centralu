import { randomUUID } from 'node:crypto'
import type { ApprovalDetail, BackgroundTask, SessionInfo } from '@cc/protocol'
import type { QueuedRequest, Store } from '../dev-services/store.js'
import type { AgentRunWait } from './app-agents.js'
import { inTurn } from '../idle.js'
import { readJsonObjects } from '../dev-services/store/json.js'

/**
 * How long a report held over a session's own background work (#721), here or on a linked machine (#723), waits, once
 * that work has ended with no turn running, for the turn its ending may start. Claude starts that turn within a second
 * of the task's end (its task-notification); a task the person stopped by hand starts none, and the report then goes
 * out with the last answer.
 */
export const PAUSED_REPORT_SETTLE_MS = 60_000

/** The tools a request can be queued through that this build delivers (#677); a row of another is left alone (#384) */
const QUEUED_VIA: ReadonlySet<string> = new Set<QueuedRequest['via']>(['ask_project', 'agent_session', 'send_to_session'])

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
  /** The name the child starts with (#861): the caller's, or one made from its task; absent for a worktree child named by its branch */
  name?: string
  /**
   * The start is allowed (by the card or the project's trust) and waits only for memory (#686): a host that takes it
   * over starts it when memory allows, without raising the card again
   */
  allowed?: true
  detail: Extract<ApprovalDetail, { kind: 'agent_start' }>
}

/** One such request while this host serves it (`ChildOwnership.agentStarts`) */
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

/** One ask_project call's work in the target project (#371 part B) — see `ChildOwnership.delegations` */
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
  return readJsonObjects<PausedTask>(raw, (t) => typeof t.id === 'string' && typeof t.description === 'string')
}

/**
 * Whose a turn is (#1377): the person's (the person wrote while the session was at rest, or their message waited for
 * the turn), or the delegated work's (the caller's message, an app's or Centralu's, or the CLI starting it itself when
 * the work's background tasks end). `wrote`: the person wrote into a turn of the work; `added`: the person chose to add
 * their message to the task.
 */
export type TurnStarter = { by: 'person' | 'work'; wrote?: true; added?: true }
/** How long a message that is to start a turn waits for it: the tool starts one within moments, or none (#1377) */
const NEXT_STARTER_MS = 15_000
/** The store's record of the turn a session with an owed report is in (#1377), kept across a swap */
export const reportTurnKey = (sessionId: string) => `report_turn:${sessionId}`
function readStarter(raw: string | null): TurnStarter | null {
  if (raw === null) return null
  const parsed = readJsonObjects<TurnStarter>(`[${raw}]`, (t) => t.by === 'person' || t.by === 'work')[0]
  return parsed ?? null
}

/** A delegated turn's link (#676): who gave the turn, and the cards it was already told of */
export type TurnOwner = { callerId: string; untilTurnEnd: boolean; told: Set<string>; turnId: string }

/**
 * A linked machine's session an orchestrator asked to hear about (#82 phase 4). `paused`: the session's own background
 * work a completed turn there ended with (#723); the report stays owed until a turn ends with none of it left.
 * `instruction`: the text of the instruction the wait was set for, while the machine has not yet been heard recording it
 * (#1082); until then nothing it relays is about that instruction's turn
 */
export type LinkedReport = {
  orchestratorId: string
  busy: boolean
  paused?: BackgroundTask[]
  instruction?: string
  /** Whose the turn running there is (#1377), and whose the next will be: from the message each started with. Memory only */
  turn?: TurnStarter
  next?: TurnStarter
  /** Whose the last turn there was: its last response is the person's answer when it was theirs */
  lastBy?: 'person' | 'work'
}

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

type OwnershipStore = Pick<Store, 'children' | 'settings'>

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
  /**
   * Whose the running turn is, by session (#1377): recorded when the turn starts from the message that started it, decided
   * at its end (`ChildReports.reportBackIfAwaited`). Mirrored in the app setting `report_turn:<session>` while a report is
   * owed, so a host that takes over a kept session mid-turn knows it. None recorded (a mark an older build wrote): the
   * work's, as every turn was.
   */
  private readonly starters = new Map<string, TurnStarter>()
  private readonly lastBy = new Map<string, 'person' | 'work'>()
  /** Whose the message is that waits to start the session's next turn, delivered while it was at rest */
  private readonly nextStarter = new Map<string, TurnStarter & { at: number }>()
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
  /**
   * Told of each change to a linked report (#1038): a child start_agent started on a linked machine keeps what it is
   * owed in its stored record (`RemoteAgents`), so a restarted hub still reports its end
   */
  private linkedChanged: ((sessionId: string) => void) | undefined

  constructor(private readonly store: OwnershipStore) {}

  /** A new mark is new work: a pause of the work before it is not this work's, nor one an older build left stored */
  markReport(sessionId: string, callerId: string): void {
    this.unpauseReport(sessionId)
    this.store.settings.deleteAppSetting(pausedReportKey(sessionId))
    this.reports.set(sessionId, callerId)
    this.store.children.setReportMark(sessionId, callerId)
    this.persistTurn(sessionId)
  }
  clearReport(sessionId: string): void {
    this.unpauseReport(sessionId)
    this.store.settings.deleteAppSetting(reportTurnKey(sessionId))
    this.lastBy.delete(sessionId)
    if (!this.reports.delete(sessionId)) return
    this.store.children.clearReportMark(sessionId)
  }
  /**
   * At startup (#646): the report marks of the sessions the keeper kept that still owe them, and nothing else. Returns
   * the marks of kept sessions that ended their turn during the swap, whose callers are told so (#1186)
   */
  restoreReports(sessions: ReadonlyMap<string, SessionInfo>, keptSessions: ReadonlySet<string> | undefined): { sessionId: string; callerSessionId: string }[] {
    const endedInSwap: { sessionId: string; callerSessionId: string }[] = []
    /*
     * "You will be told when it ends" survives a host swap (#646): the keeper kept the child's process and its turn is
     * still running, so it ends under this host, and the report it owes goes out from here. Any other mark is dropped
     * rather than left to name an unrelated later turn as "the assigned work finished" (#166): a session with no
     * process lost its turn with the old host, and a kept session already at rest finished its turn while the old host
     * was letting go (`handingOver` held that report back); its answer stays readable through agent_session.
     * A kept session at rest whose report was paused over its own background work (#721) still owes it: that work runs
     * on in the kept process, and the turn its ending starts ends under this host.
     */
    for (const mark of this.store.children.listReportMarks()) {
      const child = sessions.get(mark.sessionId)
      const kept = keptSessions?.has(mark.sessionId) && !!child && sessions.has(mark.callerSessionId)
      const paused = readPausedTasks(this.store.settings.appSetting(pausedReportKey(mark.sessionId)))
      if (kept && (inTurn(child.state) || paused)) {
        this.adoptReport(mark.sessionId, mark.callerSessionId, paused)
        continue
      }
      if (child && keptSessions?.has(mark.sessionId)) {
        console.error(`[agent-host] report mark dropped: ${mark.sessionId.slice(0, 8)} ended its turn during the swap; its caller is told`)
        if (sessions.has(mark.callerSessionId)) endedInSwap.push(mark)
      }
      this.store.children.clearReportMark(mark.sessionId)
      this.store.settings.deleteAppSetting(pausedReportKey(mark.sessionId))
      this.store.settings.deleteAppSetting(reportTurnKey(mark.sessionId))
    }
    return endedInSwap
  }

  /** At startup (#676): the delegated turns of kept sessions still in them; any other row is dropped */
  restoreTurns(sessions: ReadonlyMap<string, SessionInfo>, keptSessions: ReadonlySet<string> | undefined): void {
    /*
     * A delegated turn's link survives the swap the same way (#676): a kept session still in the turn may be waiting on
     * a question its caller is to answer, and the kept CLI sends that card again to this host. With no delegation in
     * this host's memory, the link ends with the turn. Any other row is dropped: that turn is over.
     */
    for (const row of this.store.children.listDelegatedTurns()) {
      const s = sessions.get(row.sessionId)
      if (keptSessions?.has(row.sessionId) && !!s && inTurn(s.state) && sessions.has(row.callerSessionId)) {
        this.adoptTurn(row.sessionId, { callerId: row.callerSessionId, untilTurnEnd: true, told: new Set(row.told), turnId: row.turnId })
        continue
      }
      this.store.children.clearDelegatedTurn(row.sessionId)
    }
  }

  /** At startup (#677): every queued request whose session and requester still exist; `legacyOpenedByAuto` reads a row an older build wrote */
  restoreQueued(sessions: ReadonlyMap<string, SessionInfo>, legacyOpenedByAuto: (r: QueuedRequest) => boolean): void {
    /*
     * Queued requests (#677) outlive the host: the next one delivers them when the session's turn ends, or soon after
     * start for a session already at rest. A kept session waits for its adoption (`adoptKept`), so its first input
     * does not start a second process. A request whose session or requester is gone is dropped.
     */
    for (const r of this.store.children.listQueuedRequests()) {
      if (!sessions.has(r.sessionId) || !sessions.has(r.callerSessionId)) {
        this.store.children.removeQueuedRequest(r.id)
        continue
      }
      /*
       * Queued by a newer build through a tool this one does not know (#384): no gate here stands for it, so it is not
       * delivered, and not dropped either. The row stays for a build that knows the tool; the requests behind it go.
       */
      if (!QUEUED_VIA.has(r.via)) {
        console.error(`[agent-host] queued request ${r.id} to ${r.sessionId.slice(0, 8)} came through ${JSON.stringify(r.via)}, which this build cannot deliver; it is left for one that can`)
        continue
      }
      // A delivery the old host began and never saw start is delivered again (#684 review)
      if (r.deliveringAt) {
        console.error(`[agent-host] queued request ${r.id} to ${r.sessionId.slice(0, 8)} was being delivered at the swap; delivering it again`)
        this.store.children.markQueuedDelivering(r.id, null)
      }
      // A row an older build wrote does not say whether only `auto` let it through: an ask with no consent for the pair is read as such
      const openedByAuto = r.openedByAuto ?? legacyOpenedByAuto(r)
      this.adoptQueued({ ...r, deliveringAt: null, openedByAuto })
    }
  }

  /** A mark the previous host left, kept for a session the keeper kept (the store already holds it) */
  adoptReport(sessionId: string, callerId: string, paused: PausedTask[] | null): void {
    this.reports.set(sessionId, callerId)
    if (paused) this.paused.set(sessionId, paused)
    // The turn it was in when the last host stopped (#1377): the person's is not reported when it ends here
    const starter = readStarter(this.store.settings.appSetting(reportTurnKey(sessionId)))
    if (starter) this.starters.set(sessionId, starter)
  }
  /** Holds the session's owed report over its own background work (#721); the mark itself stays as it is */
  pauseReport(sessionId: string, running: readonly PausedTask[]): void {
    const held = this.paused.get(sessionId) ?? []
    const added = running.filter((t) => !held.some((h) => h.id === t.id)).map((t) => ({ id: t.id, description: t.description }))
    if (!this.paused.has(sessionId) || added.length) {
      const next = [...held, ...added]
      this.paused.set(sessionId, next)
      this.store.settings.setAppSetting(pausedReportKey(sessionId), JSON.stringify(next))
    }
  }
  unpauseReport(sessionId: string): void {
    this.stopSettling(sessionId)
    if (this.paused.delete(sessionId)) this.store.settings.deleteAppSetting(pausedReportKey(sessionId))
  }
  /**
   * A message goes into the session (#1377): the person's, or anyone else's (a caller's, an app's, Centralu's). At rest
   * (or where the tool holds it for a turn of its own) it is what the next turn starts from; into a running turn it joins
   * that turn: a person's into the work's is noted ("the person wrote during this turn"), into their own it is theirs.
   */
  noteMessage(sessionId: string, by: 'person' | 'work', inTurnNow: boolean, joinsRunningTurn: boolean, added = false): void {
    if (inTurnNow && joinsRunningTurn) {
      // A turn from before this host knew whose turns are whose reads as the work's
      const running = this.starters.get(sessionId) ?? { by: 'work' as const }
      this.starters.set(sessionId, running)
      if (by === 'person' && running.by === 'work') {
        if (added) running.added = true
        else running.wrote = true
        this.persistTurn(sessionId)
      }
      return
    }
    // A note that no turn ever started from (a command the tool answers itself, a message it refused) goes stale
    const found = this.nextStarter.get(sessionId)
    const next = found && Date.now() - found.at < NEXT_STARTER_MS ? found : undefined
    // "Add to the task" (a person's message that is the work's): the turn is the work's, noted as their addition
    const mine: TurnStarter = added ? { by: 'work', added: true } : { by }
    if (!next) {
      this.nextStarter.set(sessionId, { ...mine, at: Date.now() })
      return
    }
    // Two messages before the turn starts make one turn: the work's if either is (the work's instruction is in it)
    if (mine.by === 'person') {
      if (next.by === 'work' && !next.added) next.wrote = true
      return
    }
    const adds = !!mine.added || !!next.added
    const wrote = next.by === 'person' || !!next.wrote
    this.nextStarter.set(sessionId, { by: 'work', ...(adds ? { added: true as const } : wrote ? { wrote: true as const } : {}), at: Date.now() })
  }
  /** A turn starts (#1377): from the message waiting for it, else the CLI's own (the work's background tasks ended) */
  turnStarted(sessionId: string): void {
    const found = this.nextStarter.get(sessionId)
    this.nextStarter.delete(sessionId)
    const next = found && Date.now() - found.at < NEXT_STARTER_MS ? found : undefined
    const { at: _at, ...starter } = next ?? { by: 'work' as const, at: 0 }
    this.starters.set(sessionId, starter)
    this.persistTurn(sessionId)
  }
  /** The turn ends (#1377): whose it was; none recorded reads as the work's. The record goes with it */
  turnEnded(sessionId: string): TurnStarter {
    const starter = this.starters.get(sessionId) ?? { by: 'work' as const }
    this.starters.delete(sessionId)
    this.lastBy.set(sessionId, starter.by)
    this.store.settings.deleteAppSetting(reportTurnKey(sessionId))
    return starter
  }
  /** Whose the session's last turn was (#1377): its last response is the person's answer when it was theirs */
  lastTurnBy(sessionId: string): 'person' | 'work' | undefined {
    return this.lastBy.get(sessionId)
  }
  /** Whose the running turn is, when one is recorded */
  starterOf(sessionId: string): TurnStarter | undefined {
    return this.starters.get(sessionId)
  }
  /** The person took the session over (#1377): the running turn is theirs from here */
  takeTurn(sessionId: string): void {
    if (this.starters.has(sessionId)) {
      this.starters.set(sessionId, { by: 'person' })
      this.persistTurn(sessionId)
    }
  }
  /** Kept while a report is owed, for a host that takes the session over mid-turn */
  private persistTurn(sessionId: string): void {
    const s = this.starters.get(sessionId)
    if (s && this.reports.has(sessionId)) this.store.settings.setAppSetting(reportTurnKey(sessionId), JSON.stringify(s))
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
    this.store.children.setDelegatedTurn(sessionId, callerId, turnId)
  }
  /** Ends the link; with `callerId`, only that caller's (a later delegation by someone else is not cut) */
  releaseTurn(sessionId: string, callerId?: string): void {
    const owner = this.turns.get(sessionId)
    if (!owner || (callerId && owner.callerId !== callerId)) return
    this.turns.delete(sessionId)
    this.store.children.clearDelegatedTurn(sessionId)
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
    this.store.children.setDelegatedTurnTold(sessionId, [...owner.told])
  }

  /** Holds a request for a busy session, last in its queue; returns its place */
  enqueue(r: QueuedRequest): number {
    const list = [...(this.queues.get(r.sessionId) ?? []), r]
    this.queues.set(r.sessionId, list)
    this.store.children.addQueuedRequest(r)
    return list.length
  }
  /** Marks a queued ask as resting on its requester's `auto` alone, here and in the store (#838) */
  markOpenedByAuto(r: QueuedRequest): void {
    if (r.openedByAuto === true) return
    r.openedByAuto = true
    this.store.children.markQueuedOpenedByAuto(r.id)
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
      for (const r of list) if (which(r)) { dropped.push(r); this.store.children.removeQueuedRequest(r.id) }
      if (keep.length) this.queues.set(id, keep)
      else this.queues.delete(id)
    }
    return dropped
  }
  /** A queued request goes in now (#684 review): the session is busy with it until its turn starts */
  startDelivering(sessionId: string, requestId: string): void {
    this.deliveries.set(sessionId, requestId)
    this.store.children.markQueuedDelivering(requestId, Date.now())
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

  /** Set again with the same report after changing it in place, so its listener reads the change */
  setLinkedReport(sessionId: string, wait: LinkedReport): void {
    this.linked.set(sessionId, wait)
    this.linkedChanged?.(sessionId)
  }
  dropLinkedReport(sessionId: string): void {
    if (this.linked.delete(sessionId)) this.linkedChanged?.(sessionId)
  }
  onLinkedReportChange(listener: (sessionId: string) => void): void {
    this.linkedChanged = listener
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
    for (const [id, wait] of this.linked) {
      if (wait.orchestratorId !== from || !moving.has(id)) continue
      wait.orchestratorId = to
      this.linkedChanged?.(id)
    }
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

