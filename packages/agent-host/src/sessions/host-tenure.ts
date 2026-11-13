import type { SessionInfo } from '@cc/protocol'
import { errorMessage } from '@cc/protocol'
import type { ProjectFiles } from '../dev-services/project-files.js'
import { cutTurns, inTurn, turnCut } from '../idle.js'
import { crashedInSystemEnd, cutBySystemEnd, type SystemEnd } from '../lifecycle/system-end.js'
import type { Ended } from '../lifecycle/update-ended.js'
import { recordUpdateCut, UpdateResumeLists, type UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { stoppedAtUpdate, updateNote, type Stopped } from '../lifecycle/update-stopped.js'
import { rpcError } from '../rpc-error.js'
import type { CardRests } from './card-rest.js'
import type { DelegationHost } from './delegation-host.js'
import type { DelegationFlow } from './delegation-flow.js'
import type { ExternalConversations } from './external-conversations.js'
import type { HostCards } from './host-cards.js'
import { withHubMark } from './hub-preset.js'
import { UPDATE_CONTINUE_LINE, UPDATE_TASKS_LINE } from './interruptions.js'
import type { LinkedReports } from './linked-reports.js'
import type { MailSessionsHost, MailSessionsView } from './mail-sessions.js'
import type { MergeChecks } from './merge-checks.js'
import type { RestartPolicy } from './restart-policy.js'
import type { SelfCompaction } from './self-compaction.js'
import type { SessionAppWiring } from './session-app-wiring.js'
import type { SessionEventsHost } from './session-events.js'
import type { SessionProcesses } from './session-processes.js'
import type { SessionRecord } from './session-record.js'
import type { TurnInputs } from './turn-inputs.js'
import type { UsageRecorder } from './usage-recorder.js'

/**
 * What the host's tenure reaches of the session manager (#1143), typed as the manager declares each member. The manager builds it with
 * getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type HostTenureHost = Pick<DelegationHost, 'adapters' | 'children' | 'emit' | 'handles' | 'memoryGate' | 'meta' | 'store'> &
  Pick<SessionEventsHost, 'interruptions' | 'turnContinue' | 'reports'> &
  Pick<MailSessionsHost, 'events'> & {
    /** What the stops before this start left (the manager's constructor options) */
    readonly keeperOpts: { updateResume?: UpdateResumeFolder; systemEnd?: SystemEnd | null }
    readonly apps: SessionAppWiring
    readonly cardRests: CardRests
    readonly delegationFlow: DelegationFlow
    readonly externals: ExternalConversations
    readonly files: ProjectFiles
    readonly hostCards: HostCards
    readonly inputs: TurnInputs
    readonly linkedReports: LinkedReports
    readonly mail: MailSessionsView
    readonly merges: MergeChecks
    readonly processes: SessionProcesses
    readonly record: SessionRecord
    readonly restartPolicy: RestartPolicy
    readonly selfCompaction: SelfCompaction
    readonly usageRecorder: UsageRecorder
    listSessions: () => SessionInfo[]
    stopSelfCompaction: () => void
  }

/**
 * The host's tenure: what it takes over at its start (the sessions as the last host left them, the turns an update cut), and how it lets
 * them go (a quit, or a stop for an update). Moved out of the session manager as it was (#1143); what it reaches of the
 * manager is `HostTenureHost`.
 */
export class HostTenure {
  constructor(private readonly host: HostTenureHost) {}

  /**
   * Sessions an update's stop left, to tell once the start is done (#1618, `continueCutTurns`): a turn it cut is continued (`turn`; its end
   * says so, #1966); a session at rest whose tasks it stopped is woken for the note alone (#1902). `stopped`: what else it ended there
   */
  private updateCuts: { sessionId: string; turn: boolean; stopped: Stopped | null }[] = []
  /**
   * The turns this host continues because an update cut them, and when its start took them up (#1618): said in every hello,
   * for a hub's callers. Taken at the start, before this host answers any hello, so a hub that connects while a Continue is
   * still on its way is told of it too (#1626 review); one that turns out lost leaves it (`turnLostInSwap`)
   */
  private continuedAfterUpdate: { sessionId: string; at: number }[] = []
  /** The lists of the turns an update cut that the stops before this start left (#1618), each removed once dealt with */
  private updateLists: UpdateResumeLists | null = null
  /** A linked hub stops this host for an update (`host.stop { forUpdate }`): the turns its stop ends are listed (#1618) */
  private stoppingForUpdate = false
  /** `disposeAll` has begun (#673): a card it withdraws is not the person's answer, and its request stays stored */
  disposing = false
  /** The sessions this host took over mid-run: the turns an update cut and this host continues */
  private keptAtStart: ReadonlySet<string> = new Set()

  /**
   * Whether the session's turn goes on from the host before: cut by an update and continued (#1618). Its mail turn row is not
   * lost, so what the turn sends keeps that turn's cause and depth (mailbox §8.2 step 6)
   */
  keptInTurn(sessionId: string): boolean {
    const m = this.host.meta.get(sessionId)
    return this.keptAtStart.has(sessionId) && !!m && inTurn(m.state)
  }

  /**
   * The turn an update cut could not be continued (#698): the session goes idle with the quit mark and its line, and the senders of what it left
   * open are told now (the stop notice)
   */
  private turnLostInSwap(m: SessionInfo): void {
    // The same statement the window gets, through the same rules (#428)
    const change = { type: 'state_change' as const, sessionId: m.id, state: 'idle' as const, reason: 'reattach_failed' }
    this.host.events.applyStateHint(change, m)
    this.host.interruptions.markTurnLost(m, true)
    this.host.store.sessions.upsertSession(m)
    this.host.emit(change)
    // The turn is over: so is a hub task's depth for it, as at any end of a turn (#2020)
    this.host.events.endHubAsk(m.id)
    // This host did not see it begin, and the tool cannot say what it took: it reads as the work's
    this.host.children.turnEnded(m.id, null)
    // Centralu cut this turn and could not continue it: the senders of what it left open (the person for their own work), and the session that
    // started it, are told (mailbox.md "The stop notice")
    this.host.mail.mailStopped(m.id, 'uncontinued', { starter: m.askedBy ?? null })
  }

  /**
   * Continues each turn a linked hub's update cut (#1618, owner 2026-10-26): the update no longer waits for the turns on a
   * machine, so the host it starts takes them up again, once. The session was left `working` by the start; it is woken
   * and given Centralu's note through Centralu's own channel (`deliverMail`: no message of the person's, so the turn stays
   * whose it was and its report, if one is owed, is still that turn's end). Its requester is told nothing of the cut: the
   * report of the continued turn's end says so (#1966). A session that cannot be continued (its tool cannot resume it, it is gone there) ends
   * idle, marked stopped, its report or its requester told (`turnLostInSwap`). Each is taken once: the list is emptied first, and its id leaves the file once its Continue was sent
   * or its loss reported (`UpdateResumeLists.done`), not before, so a host stopped in between leaves it for the next.
   *
   * The note also says what else the stop ended in the session: its background tasks and the cards that waited for the person
   * (`updateNote`, #1902). A session at rest whose tasks it stopped is woken for the note alone: that is a continue of the
   * update, not a turn a message or mail started (docs/plans/mailbox.md §8.2), so it goes in through `deliverMail` and not the
   * mailbox's delivery, and a session the person woke first takes it into the turn they started.
   */
  private async continueCutTurns(): Promise<void> {
    const cuts = this.updateCuts
    this.updateCuts = []
    await Promise.all(
      cuts.map(async ({ sessionId, turn, stopped }) => {
        const m = this.host.meta.get(sessionId)
        // Leaving before it went in: still listed, for the host that starts next
        if (this.disposing) return
        if (!m || (turn && !inTurn(m.state))) {
          // Gone, or stopped by the person before its Continue went in: nothing to continue
          this.host.restartPolicy.continuingTurns.delete(sessionId)
          this.notContinued(sessionId)
          this.updateLists?.done(sessionId)
          return
        }
        // Marked before it goes in: a turn that ends at once (a tool that refuses) is still the continued one's end
        if (turn) this.host.children.noteContinuedCut(sessionId)
        try {
          await this.sendUpdateNote(sessionId, turn, stopped)
        } catch (e) {
          this.host.children.dropContinuedCut(sessionId)
          if (this.disposing || this.host.meta.get(sessionId) !== m) return
          this.host.restartPolicy.continuingTurns.delete(sessionId)
          if (!turn) {
            // Nothing was cut: the agent is not told which tasks the update stopped, and the log says so
            console.error(`[agent-host] ${sessionId.slice(0, 8)}: the agent could not be told what an update stopped (${errorMessage(e)})`)
            this.updateLists?.done(sessionId)
            return
          }
          console.error(`[agent-host] ${sessionId.slice(0, 8)}: the turn an update ended could not be continued (${errorMessage(e)})`)
          this.turnLostInSwap(m)
          this.notContinued(sessionId)
          this.updateLists?.done(sessionId)
          return
        }
        /*
         * In, but this host is leaving meanwhile (a second update's stop, #1626 review): its stop lists the turn again, the
         * note included, and the host after it continues it. Nothing is settled from here
         */
        if (this.disposing) return
        this.host.restartPolicy.continuingTurns.delete(sessionId)
        // Sent: a host that starts after this one does not send it again
        this.updateLists?.done(sessionId)
        // Its parent is told nothing now: the report of the continued turn's end says the turn was cut and continued (#1966)
      }),
    )
  }

  /**
   * Centralu's note to the agent after an update or a swap stopped it (#1618, #1966): the Continue of a cut turn, or the tasks the stop ended
   * for a session at rest. Not sent once this host is leaving (a second
   * update's stop while the session wakes): the host after it sends the one
   */
  private sendUpdateNote(sessionId: string, turn: boolean, stopped: Stopped | null): Promise<void> {
    return this.host.events.deliverMail(
      sessionId,
      { text: updateNote(turn, stopped), quiet: false, line: turn ? UPDATE_CONTINUE_LINE : UPDATE_TASKS_LINE, label: 'update', skipLine: () => this.disposing && this.stoppingForUpdate },
      { leaving: () => this.disposing, atRest: () => true },
    )
  }

  /** A turn the start took up that is not continued after all: the hello stops naming it (#1618) */
  private notContinued(sessionId: string): void {
    this.continuedAfterUpdate = this.continuedAfterUpdate.filter((c) => c.sessionId !== sessionId)
  }

  /**
   * A linked hub stops this host to update it, roll it back or put a version back (`host.stop { forUpdate }`, #1618): as the
   * sessions are let go of (`disposeAll`), the ones in a turn are listed for the host that starts next, which continues them
   */
  stopForUpdate(): void {
    this.stoppingForUpdate = true
  }

  /** The terminals and Run commands an update's stop left in the lists, once (#1902): the lists that held them go */
  takeUpdateEnded(): Ended {
    return this.updateLists?.takeEnded() ?? { terminals: [], runs: [] }
  }

  /** The turns this host continues after an update cut them (#1618), for the hello a linked hub reads */
  updateContinued(): { sessionId: string; at: number }[] {
    return [...this.continuedAfterUpdate]
  }

  /**
   * The handles are being let go of (#839): a quit sweeping them (`disposeAll`). A process that comes up now is missed
   * by the sweep, so whoever started it stops it, and no process is swapped for another.
   * Only during the quit's sweep, not after: a manager stopped this way is woken again in tests, and a quitting host
   * exits once the sweep is done.
   */
  private sweepingHandles = false
  lettingGo(): boolean {
    return this.sweepingHandles
  }
  /** Refuses a process swap asked for while the handles are let go of (#839): the sweep would miss the new process */
  refuseWhileLettingGo(): void {
    if (this.lettingGo()) throw rpcError('Centralu is restarting or quitting; try again once it is back')
  }

  async disposeAll(): Promise<void> {
    this.host.usageRecorder.stop()
    this.host.stopSelfCompaction()
    this.sweepingHandles = true
    try {
      await this.disposeEverything()
    } finally {
      this.sweepingHandles = false
    }
  }

  private async disposeEverything(): Promise<void> {
    // The cards it closes below are not the person's answers: a standing start_agent request stays stored (#673)
    // A retry waiting for the provider's capacity ends its turn with the error it stood in for: no later host would hear it again (#1693). Before the host is marked as leaving: the end is the error's, not a stop of the quit's. A stop's wait is stored, for the next host (#1415)
    this.host.turnContinue.stopAll()
    this.disposing = true
    this.leaveHost('Centralu is shutting down')
    // An earlier build that takes over after this one (a rollback) reads what the sessions in a turn owe from report marks (mailbox.md §10.6.3)
    this.host.mail.mailLeaving(this.host.listSessions().filter((s) => inTurn(s.state)).map((s) => s.id))
    /*
     * A linked hub's update stops this host (#1618): the turns it ends are the ones in a turn now, read in the same step as
     * the processes are let go of below, with no new turn taken since `leaveHost`. Listed once the processes are down and
     * their last output written (below), each with the last row of its conversation then: the mark the next start
     * continues it by. A list of its own, beside any an earlier stop left (turns this host had not continued yet)
     */
    const sessions = this.stoppingForUpdate && this.host.keeperOpts.updateResume ? this.host.listSessions() : []
    const cut = cutTurns({ sessions, terminals: 0, commandRuns: 0 })
    /*
     * And what else the stop ends in them (#1902): the background tasks their processes hold, with the command of the call that
     * started each, and the cards that wait for the person. Read here, before the processes go: the tool reports each task gone
     * as its process ends, and the store's record of them is emptied at the next start. Idle sessions count: a dev server
     * outlives the turn that started it.
     */
    const stopped = stoppedAtUpdate(sessions, (id, callId) => this.host.store.messages.toolCallInput(id, callId))
    // The messages in progress are written as they stand — a shutdown must not swallow the last two seconds (#66).
    // Written, not closed: the supervisor may kill the host before the processes are down
    for (const [id, run] of this.host.record.streams) this.host.record.flushStream(id, run)
    // Even if one fails, the rest are still cleaned up — one rejection blocking the whole cleanup during
    // shutdown would leave orphans behind
    // No merge check's git or gh is still running once this returns (#368)
    await Promise.allSettled([...[...this.host.handles.values()].map((h) => h.dispose()), ...this.host.merges.mergeChecks])
    // The closed processes get a moment to leave on their own before the host's exit takes them along (#353)
    // An adapter with nothing to settle is waited for as one that settled at once
    await Promise.allSettled([...this.host.adapters.values()].map((a) => a.settle?.() ?? Promise.resolve()))
    // Closed once the processes are down, so their last deltas grow the open rows instead of opening new ones (#213)
    for (const id of [...this.host.record.streams.keys()]) this.host.record.closeStream(id)
    if ((cut.length || stopped.length) && this.host.keeperOpts.updateResume) {
      // One mark for both, read now: the processes are down and their last rows written, which the next start's reading must find
      const mark = (id: string) => this.host.store.messages.nextSeq(id) - 1
      recordUpdateCut(this.host.keeperOpts.updateResume, cut.map((id) => ({ id, seq: mark(id) })), stopped.map((x) => ({ ...x, seq: mark(x.id) })))
    }
    // Stamped after dispose finishes (see the comment on stampExternalSynced). Never stamped on a
    // crash — stamping the current time when the actual moment of death is unknown could swallow
    // whatever happened externally between death and discovery.
    for (const id of this.host.handles.keys()) this.host.externals.stampExternalSynced(id)
    this.host.handles.clear()
  }

  /**
   * What ends with this host as it lets its sessions go (`disposeAll`): the reconnect clocks among them, which would
   * otherwise flag a session from a host that had already left. `why` is what the waits it fails hear.
   */
  private leaveHost(why: string): void {
    // Reconnect clocks die with the host (#698); the next one starts its own from the session's next event
    this.host.interruptions.stopAll()
    // So do the waits for a session's own background work to settle (#721): the next start settles every session at rest again
    this.host.reports.stopSettling()
    this.host.linkedReports.dispose()
    // So does a start waiting for memory (#686)
    this.host.memoryGate?.close()
    this.host.files.close()
    // Ends a merge check's gh; the check itself is waited for with the processes (#368). The next host checks merges
    // again at its start
    this.host.merges.mergeChecksStop.abort()
    this.host.apps.appsHub?.rt.attachBrokerHost(null)
    for (const run of [...this.host.inputs.agentRuns.values()]) run.fail(new Error(why))
    for (const readers of this.host.inputs.turnObservers.values()) for (const observer of readers) observer.fail(new Error(why))
    for (const ask of [...this.host.hostCards.hostAsks.values()]) ask.resolve(null)
    this.host.hostCards.hostAsks.clear()
    for (const q of [...this.host.hostCards.appQuestions.values()]) q.resolve(null)
    this.host.hostCards.appQuestions.clear()
    this.host.apps.appAccess?.dispose()
    this.host.apps.appsHub?.dispose()
  }

  /** The sessions as the last host left them, read once as this host starts (the manager's constructor calls it) */
  restoreAtStart(): void {
    const { store, keeperOpts } = this.host
    /*
     * On startup, state is **not simply restored as-is.**
     *
     * When the host dies, the session's process dies with it. But the DB still holds the last
     * state as-is, so on restart no process exists at all while the screen still says `working`.
     * The person thinks it is running and waits, and nothing ever happens (dogfooding: "stuck on
     * working for over 40 minutes". The workaround people found at the time was archiving and then
     * restoring it, which worked only because archive reset state to idle — archiving has since
     * been dropped, and this fixes it here so that workaround is no longer needed).
     *
     * A live state (working, waiting for approval) is **only true when a process exists**.
     * At startup no session has a process, so every one of them is corrected to idle. It wakes
     * again once something addresses it — that is better than showing a state that is not true.
     * Which states those are is the one definition a stop lists the turns it ends by (`turnCut`, idle.ts, #1618): what a
     * stop cut and what this start finds cut are the same sessions.
     */
    /** Sessions whose turn a hub's update cut, continued once the start is done (#1618, `continueCutTurns`) */
    const cutByUpdate: SessionInfo[] = []
    /** What an update's stop ended in each session besides its turn (#1902), by session: told once the start is done (`continueCutTurns`) */
    const stoppedBy = new Map<string, Stopped>()
    const lists = keeperOpts.updateResume ? new UpdateResumeLists(keeperOpts.updateResume) : null
    this.updateLists = lists
    for (const s of store.sessions.listSessions()) {
      const cut = turnCut(s)
      /*
       * Except where an update cut the turn (#1618): the turn goes on, in a new process. It stays `working` until it is continued, so a hub reading this machine meanwhile sees a
       * turn running, not one that ended; the report it owes stays owed. If it cannot be continued, it is reset there
       * (`turnLostInSwap`). Only the turn the stop listed: its
       * conversation still ends where it ended when that stop was done (`UpdateResumeLists.cut`), so a list left behind
       * names no later turn, such as one a stop of the person's cut after a rollback to a host that never reads lists. It
       * holds because every listed session leaves this start with a row past the mark: the Continue's line, or the stopped
       * mark below (`turnLostInSwap` for one that cannot be continued)
       */
      const goesOn = cut && !!lists?.cut(s.id, s.lastSeq)
      const stale = cut && !goesOn
      /*
       * Where the last host recorded the system ending (#1397): a turn it lost is the system's, unless the session has rows from
       * after that end (a later host's, of a build that reads no record). And a session in `error` by an `adapter_crashed` about
       * then: its agent got the system's termination too (exit 0) and the host wrote the error before it went. It is no crash,
       * so it is reset and marked as a lost turn is
       */
      const end = keeperOpts.systemEnd
      const recent = end && (stale || s.state === 'error') ? store.messages.loadMessages(s.id, 20) : []
      const crashedAtEnd = !cut && crashedInSystemEnd(s, recent, end)
      const lost = stale || crashedAtEnd
      const bySystem = crashedAtEnd || (stale && cutBySystemEnd(end, recent.at(-1)?.ts))
      const fixed = lost ? { ...s, state: 'idle' as const, waitingSince: null } : goesOn ? { ...s, state: 'working' as const, waitingSince: null } : s
      // Started from a linked computer (#1273): kept beside the row, as its depth is
      this.host.meta.set(s.id, withHubMark(store.settings, fixed))
      if (lost) {
        console.error(`[agent-host] stale state reset: ${s.id.slice(0, 8)} ${s.state} -> idle${bySystem ? ' (the system was ending)' : ''}`)
        // No window is attached yet: the marker and the interruption are read with the conversation and the list
        this.host.interruptions.markTurnLost(fixed, false, bySystem ? 'shutdown' : 'quit')
        store.sessions.upsertSession(fixed)
        // The turn the last host was in never sent its end (#1604)
        this.host.children.noteTurnEnd(s.id)
      }
      const stopped = lost ? null : lists?.stoppedOf(s.id, s.lastSeq) ?? null
      if (stopped) stoppedBy.set(s.id, stopped)
      if (goesOn) {
        console.error(`[agent-host] ${s.id.slice(0, 8)}: an update of this machine ended its turn; continuing it`)
        store.sessions.upsertSession(fixed)
        cutByUpdate.push(fixed)
        // Until its Continue is in: a wake meanwhile (a window that sees the machine back) keeps it in its turn (`SessionStarts`)
        this.host.restartPolicy.continuingTurns.add(s.id)
        this.continuedAfterUpdate.push({ sessionId: s.id, at: Date.now() })
      }
    }
    // A listed session this start does not find cut by that stop (at rest, gone, or in a later turn) has nothing to continue
    for (const id of lists?.ids() ?? []) if (!cutByUpdate.some((s) => s.id === id) && !stoppedBy.has(id)) this.updateLists?.done(id)
    /** What the start takes over as going on: the turns an update cut (#1618) */
    const goingOn = new Set(cutByUpdate.map((s) => s.id))
    // And a session at rest whose background tasks the stop ended is woken for the note alone (#1902)
    const cutIds = new Set(cutByUpdate.map((s) => s.id))
    this.updateCuts = [
      ...cutByUpdate.map((s) => ({ sessionId: s.id, turn: true, stopped: stoppedBy.get(s.id) ?? null })),
      ...[...stoppedBy].filter(([id]) => !cutIds.has(id)).map(([id, stopped]) => ({ sessionId: id, turn: false, stopped })),
    ]
    // No process outlives its host, so no card the previous host left standing is still asked (#428): every rest it wrote goes
    this.host.cardRests.restore(() => false)
    this.host.delegationFlow.starts.restoreAgentStarts()
    // The reports owed of children on linked machines (#1038): each settles once its machine says where it stands
    this.host.delegationFlow.remote.restore()
    // An earlier build's delegated turns (#676) are no one's now: cards go to the givers of open work (docs/plans/mailbox.md §10.6.4)
    store.children.dropDelegatedTurns()
    this.keptAtStart = goingOn
    // The stops the last host left waiting for the network or a usage limit's reset (stored with each session, #1415) are waited for again
    this.host.turnContinue.restore(this.host.meta.values())
    if (this.updateCuts.length) setTimeout(() => void this.continueCutTurns(), 0)
  }
}
