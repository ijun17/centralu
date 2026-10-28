import type { Delegation } from './child-ownership.js'
import { AgentRunWait } from './app-agents.js'
import { turnAnswer } from './turn-answer.js'
import type { DelegationHost } from './delegation-host.js'
import { AgentStartFlow } from './start-agent-flow.js'
import { BackgroundStops } from './background-stops.js'
import { DelegationWaits } from './delegation-waits.js'
import { DelegationForks } from './delegation-forks.js'
import { ObservedTurns } from './observed-turns.js'
import { AgentSessionActions } from './agent-session-actions.js'
import { RemoteAgents } from './remote-agents.js'

// Moved with start_agent (#850); still importable from here
export type { DelegationHost } from './delegation-host.js'
export { ASK_THE_PERSON, START_AGENT_CALL_MS, START_AGENT_MODEL_CHECK_MS, START_AGENT_SETUP_MS, agentStartPersonText } from './start-agent-flow.js'
// Moved with stopping a child's background work (#428); still importable from here
export { STOP_REPORTED_MS, taskList } from './background-stops.js'
// Moved with the waits on a delegated turn (#428); still importable from here
export type { TurnWait } from './delegation-waits.js'

// Moved to a module of its own, which the linked reports read without this one's imports (#1082); still importable from here
export { HUB_SENDER } from './hub-sender.js'

/**
 * The work one session gives another (#428): ask_project's delegations (#371 part B; linked machines, #700), start_agent
 * and its requests (#561, #673, #686), agent_session (#561), and the waits on them, over `ChildOwnership`. Moved out of
 * the session manager as it was; what it reaches of the manager is `DelegationHost`.
 */
export class DelegationFlow {
  /** start_agent and its requests (start-agent-flow.ts, #850) */
  readonly starts: AgentStartFlow
  /** Stopping a child's own background work (background-stops.ts) */
  private readonly stops: BackgroundStops
  /** The waits on a delegated turn and the answers they give (delegation-waits.ts) */
  private readonly waits: DelegationWaits
  /** A fork of a busy session for a requester (delegation-forks.ts) */
  private readonly forks: DelegationForks
  /** Turns read by a session that does not own them, and an observer's note (observed-turns.ts) */
  private readonly observed: ObservedTurns
  /** agent_session's actions (agent-session-actions.ts) */
  private readonly actions: AgentSessionActions
  /** The children start_agent starts on linked machines, and agent_session on them (remote-agents.ts, #1038) */
  readonly remote: RemoteAgents

  constructor(private readonly host: DelegationHost) {
    this.starts = new AgentStartFlow(host, this)
    this.stops = new BackgroundStops(host)
    this.waits = new DelegationWaits(host)
    this.forks = new DelegationForks(host, this)
    this.observed = new ObservedTurns(host, this)
    this.actions = new AgentSessionActions(host, this)
    this.remote = new RemoteAgents(host, this.starts)
  }

  /**
   * Reads each turn's answer on its own (#428), from the session's record as it is when the reader is made: queued turns
   * have no new stored user row (their input was recorded before the previous answer), so each read starts after the
   * last one
   */
  answerReader(sessionId: string): () => string {
    let after = this.host.meta.get(sessionId)?.lastSeq ?? 0
    return () => {
      const answer = turnAnswer(this.host.store.messages.loadMessages(sessionId, 50), { afterSeq: after })
      after = this.host.meta.get(sessionId)?.lastSeq ?? after
      return answer
    }
  }

  /** Registers the wait on the delegated session's turn (the same watcher an app's agent uses, `AgentRunWait`) */
  startDelegation(key: string, callerId: string, sessionId: string, target: { id: string; name: string; path: string }, agent = false, joinedTurn = false): Delegation {
    let notice: string | undefined
    const wait = new AgentRunWait((message) => (notice = message), () => this.host.meta.get(sessionId)?.name ?? 'the session', undefined, this.answerReader(sessionId))
    // Detach the caller without failing the target's receipt watcher or other observers.
    let cancelWait!: (result: { ok: false; error: string }) => void
    const waitCancelled = new Promise<{ ok: false; error: string }>((resolve) => { cancelWait = resolve })
    const d: Delegation = {
      joinedTurn,
      waitCancelled,
      callerId,
      sessionId,
      target,
      wait,
      get settled() { return wait.finished },
      notice: () => notice,
      outcome: wait.done.then(
        (r) => ({ ok: true as const, answer: r.answer }),
        (e: Error) => ({ ok: false as const, error: e.message }),
      ),
      stop: (why, targetStop = false) => {
        if (d.settled) return
        if (joinedTurn && !targetStop) {
          cancelWait({ ok: false, error: `${why}; the caller stopped waiting and the target session was left running` })
          return
        }
        wait.fail(new Error(`${why}, so the delegated turn was stopped`))
        try {
          this.host.handles.get(sessionId)?.interrupt()
        } catch {
          // The session has already gone down — there is nothing left to stop
        }
      },
      ...(agent ? { agent: true } : {}),
    }
    // The caller's new work supersedes its work the session paused on (#721): this run's own wait or report tells it
    if (this.host.children.pausedReports.has(sessionId) && this.host.children.awaitingReport.get(sessionId) === callerId) this.host.children.clearReport(sessionId)
    // The turn is the caller's (#676): its cards go to the caller too. A task that joined the person's turn is not
    if (!joinedTurn) this.host.children.ownTurn(sessionId, callerId, false)
    void d.outcome.then((r) => {
      if (this.host.agentRuns.get(sessionId) === wait) this.host.agentRuns.delete(sessionId)
      /*
       * A swap's or a quit's failed waits are not the turn's end: the next host keeps the link while a kept turn runs, and
       * decides at its start what became of one the quit cut (told as stopped, or continued after an update, #1618). The
       * report it owes and whose the turn is stay recorded for it
       */
      if (this.host.closing) return
      // The delegation's owner now: a handoff may have moved it (#693)
      if (!joinedTurn) this.host.children.releaseTurn(sessionId, d.callerId)
      // Queued notes can finish after the original turn. Report only the whole delegation's ending.
      /*
       * A turn that completed was reported by `onEvent` as it ended, unless notes held it (`tracksInputs`): judged
       * again here, a microtask later, a pause over its own background work (#721) could read as the end once that
       * work has ended. A wait failed with no ending event (a stop, a cancel) is reported only here.
       */
      /*
       * An ask_project turn that completed with the session's own background work still running (#721, #1460) is a pause,
       * decided here so it holds whether or not a call was waiting (one past its bound is not): the report is marked owed
       * and paused for the work's last turn end, in the store, and the call that reads the answer says so
       * (`AskProjectFlow.awaitDelegation`). A start_agent child's is `awaitAgent`'s and the report's own
       */
      if (!agent && r.ok && !joinedTurn && this.host.meta.has(d.callerId) && !this.host.children.pausedReports.has(sessionId)) {
        const left = this.host.ownTasksRunning(sessionId)
        if (left.length) {
          this.host.children.markReport(sessionId, d.callerId)
          this.host.pauseReport(sessionId, left)
        }
      }
      if ((agent && !r.ok) || wait.tracksInputs) void this.host.reportBackIfAwaited(sessionId, r.ok
        ? { type: 'turn_complete', sessionId }
        : { type: 'error', sessionId, error: { code: 'internal', message: r.error, retryable: false } }, r.ok ? r.answer : undefined)
    })
    this.host.agentRuns.set(sessionId, wait)
    this.host.children.setDelegation(key, d)
    return d
  }

  /** `ObservedTurns.observeTurn` (observed-turns.ts), kept on the flow for its callers */
  observeTurn(...a: Parameters<ObservedTurns['observeTurn']>): ReturnType<ObservedTurns['observeTurn']> {
    return this.observed.observeTurn(...a)
  }

  /** `AgentSessionActions.listAgents` (agent-session-actions.ts), kept on the flow for its callers */
  listAgents(...a: Parameters<AgentSessionActions['listAgents']>): ReturnType<AgentSessionActions['listAgents']> {
    return this.actions.listAgents(...a)
  }

  /** `AgentSessionActions.agentSession` (agent-session-actions.ts), kept on the flow for its callers */
  agentSession(...a: Parameters<AgentSessionActions['agentSession']>): ReturnType<AgentSessionActions['agentSession']> {
    return this.actions.agentSession(...a)
  }

  /** `DelegationWaits.agentWorking` (delegation-waits.ts), kept on the flow for its callers */
  agentWorking(...a: Parameters<DelegationWaits['agentWorking']>): ReturnType<DelegationWaits['agentWorking']> {
    return this.waits.agentWorking(...a)
  }

  /** `ObservedTurns.readObserverNote` (observed-turns.ts), kept on the flow for its callers */
  readObserverNote(...a: Parameters<ObservedTurns['readObserverNote']>): ReturnType<ObservedTurns['readObserverNote']> {
    return this.observed.readObserverNote(...a)
  }

  /** `ObservedTurns.tellNoteRefused` (observed-turns.ts), kept on the flow for its callers */
  tellNoteRefused(...a: Parameters<ObservedTurns['tellNoteRefused']>): ReturnType<ObservedTurns['tellNoteRefused']> {
    return this.observed.tellNoteRefused(...a)
  }

  /** `DelegationWaits.agentAsking` (delegation-waits.ts), kept on the flow for its callers */
  agentAsking(...a: Parameters<DelegationWaits['agentAsking']>): ReturnType<DelegationWaits['agentAsking']> {
    return this.waits.agentAsking(...a)
  }

  /** `DelegationForks.forkGateError` (delegation-forks.ts), kept on the flow for its callers */
  forkGateError(...a: Parameters<DelegationForks['forkGateError']>): ReturnType<DelegationForks['forkGateError']> {
    return this.forks.forkGateError(...a)
  }

  /** `DelegationForks.forkFor` (delegation-forks.ts), kept on the flow for its callers */
  forkFor(...a: Parameters<DelegationForks['forkFor']>): ReturnType<DelegationForks['forkFor']> {
    return this.forks.forkFor(...a)
  }

  /** `DelegationWaits.agentAtRest` (delegation-waits.ts), kept on the flow for its callers */
  agentAtRest(...a: Parameters<DelegationWaits['agentAtRest']>): ReturnType<DelegationWaits['agentAtRest']> {
    return this.waits.agentAtRest(...a)
  }

  /** `BackgroundStops.stopPausedWork` (background-stops.ts), kept on the flow for its callers */
  stopPausedWork(...a: Parameters<BackgroundStops['stopPausedWork']>): ReturnType<BackgroundStops['stopPausedWork']> {
    return this.stops.stopPausedWork(...a)
  }

  /** `BackgroundStops.stopOwnWork` (background-stops.ts), kept on the flow for its callers */
  stopOwnWork(...a: Parameters<BackgroundStops['stopOwnWork']>): ReturnType<BackgroundStops['stopOwnWork']> {
    return this.stops.stopOwnWork(...a)
  }

  /** `BackgroundStops.restingWork` (background-stops.ts), kept on the flow for its callers */
  restingWork(...a: Parameters<BackgroundStops['restingWork']>): ReturnType<BackgroundStops['restingWork']> {
    return this.stops.restingWork(...a)
  }

  /** `DelegationWaits.awaitTurn` (delegation-waits.ts), kept on the flow for its callers */
  awaitTurn(...a: Parameters<DelegationWaits['awaitTurn']>): ReturnType<DelegationWaits['awaitTurn']> {
    return this.waits.awaitTurn(...a)
  }

  /** `DelegationWaits.grantReads` (delegation-waits.ts), kept on the flow for its callers */
  grantReads(...a: Parameters<DelegationWaits['grantReads']>): ReturnType<DelegationWaits['grantReads']> {
    return this.waits.grantReads(...a)
  }

  /** `DelegationWaits.awaitAgent` (delegation-waits.ts), kept on the flow for its callers */
  awaitAgent(...a: Parameters<DelegationWaits['awaitAgent']>): ReturnType<DelegationWaits['awaitAgent']> {
    return this.waits.awaitAgent(...a)
  }

  /** `DelegationWaits.untilHandedOver` (delegation-waits.ts), kept on the flow for its callers */
  untilHandedOver(...a: Parameters<DelegationWaits['untilHandedOver']>): ReturnType<DelegationWaits['untilHandedOver']> {
    return this.waits.untilHandedOver(...a)
  }

  /** `DelegationWaits.handedOverReply` (delegation-waits.ts), kept on the flow for its callers */
  handedOverReply(...a: Parameters<DelegationWaits['handedOverReply']>): ReturnType<DelegationWaits['handedOverReply']> {
    return this.waits.handedOverReply(...a)
  }

  /** `DelegationWaits.handedOverAnswer` (delegation-waits.ts), kept on the flow for its callers */
  handedOverAnswer(...a: Parameters<DelegationWaits['handedOverAnswer']>): ReturnType<DelegationWaits['handedOverAnswer']> {
    return this.waits.handedOverAnswer(...a)
  }

}
