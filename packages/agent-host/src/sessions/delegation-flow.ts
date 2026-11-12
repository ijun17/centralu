import { errorMessage } from '@cc/protocol'
import type { Delegation } from './child-ownership.js'
import type { DelegatedWork } from './delegation-host.js'
import { labelOf } from './transcript-view.js'
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
export { ASK_THE_PERSON, agentStartPersonText } from './start-agent-flow.js'
// Moved with stopping a child's background work (#428); still importable from here
export { taskList } from './background-stops.js'

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
  readonly actions: AgentSessionActions
  /** The children start_agent starts on linked machines, and agent_session on them (remote-agents.ts, #1038) */
  readonly remote: RemoteAgents

  constructor(private readonly host: DelegationHost) {
    this.starts = new AgentStartFlow(host, this)
    this.stops = new BackgroundStops(host)
    this.waits = new DelegationWaits(host)
    this.forks = new DelegationForks(host, this)
    this.observed = new ObservedTurns(host)
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

  /**
   * Gives a session the caller's work, the one way start_agent, ask_project, a fork and a mail send do: the wait on its turn, the caller's thread
   * written before the words go in so a card the turn raises at once finds the work open (docs/plans/mailbox.md §10.6.4), and all of it undone
   * when they do not go in, the wait failed too (#839: a wait of the caller's may have joined it while the session woke). `delivered` is the
   * error text when they did not go in
   */
  delegate(w: DelegatedWork): { d: Delegation; delivered: Promise<string | null> } {
    const d = this.startDelegation(w.key, w.callerId, w.sessionId, w.target, w.agent)
    const withdraw = this.host.children.delegated(w.callerId, w.sessionId, w.via, w.task)
    const caller = this.host.meta.get(w.callerId)
    const delivered = (async () => {
      try {
        await this.host.deliver(w.sessionId, w.frame, undefined, { sessionId: w.callerId, name: caller ? labelOf(this.host.store.messages, caller) : w.callerId }, false, undefined, 'inline', undefined, w.stillAllowed)
        return null
      } catch (e) {
        withdraw()
        d.wait.fail(e as Error)
        this.host.children.dropDelegation(w.key, d)
        if (this.host.agentRuns.get(w.sessionId) === d.wait) this.host.agentRuns.delete(w.sessionId)
        return errorMessage(e)
      }
    })()
    return { d, delivered }
  }

  /** Registers the wait on the delegated session's turn (the same watcher an app's agent uses, `AgentRunWait`); only `delegate` calls it, tests aside */
  startDelegation(key: string, callerId: string, sessionId: string, target: { id: string; name: string; path: string }, agent = false): Delegation {
    let notice: string | undefined
    const wait = new AgentRunWait((message) => (notice = message), () => this.host.meta.get(sessionId)?.name ?? 'the session', undefined, this.answerReader(sessionId))
    const d: Delegation = {
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
      stop: (why) => {
        if (d.settled) return
        wait.fail(new Error(`${why}, so the delegated turn was stopped`))
        try {
          this.host.handles.get(sessionId)?.interrupt()
        } catch {
          // The session has already gone down — there is nothing left to stop
        }
      },
      ...(agent ? { agent: true } : {}),
    }
    void d.outcome.then(() => {
      if (this.host.agentRuns.get(sessionId) === wait) this.host.agentRuns.delete(sessionId)
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

  /** `DelegationWaits.agentAsking` (delegation-waits.ts), kept on the flow for its callers */
  agentAsking(...a: Parameters<DelegationWaits['agentAsking']>): ReturnType<DelegationWaits['agentAsking']> {
    return this.waits.agentAsking(...a)
  }

  /** `DelegationForks.forkFor` (delegation-forks.ts), kept on the flow for its callers */
  forkFor(...a: Parameters<DelegationForks['forkFor']>): ReturnType<DelegationForks['forkFor']> {
    return this.forks.forkFor(...a)
  }

  /** `DelegationWaits.agentAtRest` (delegation-waits.ts), kept on the flow for its callers */
  agentAtRest(...a: Parameters<DelegationWaits['agentAtRest']>): ReturnType<DelegationWaits['agentAtRest']> {
    return this.waits.agentAtRest(...a)
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
