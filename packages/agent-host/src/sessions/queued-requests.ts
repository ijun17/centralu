import { randomUUID } from 'node:crypto'
import type { SessionInfo } from '@cc/protocol'
import { blockedOnQuestion, frameField } from '@cc/protocol'
import type { BusyAnswer, BusyChoice, ChildRunResult, SessionHandle } from '../adapters/contract.js'
import type { QueuedRequest } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import { askFrame } from './ask-project.js'
import type { Delegation } from './child-ownership.js'
import type { DelegationHost } from './delegation-flow.js'
import type { HostAsk } from './host-cards.js'
import type { RestartHost } from './restart-policy.js'
import type { SessionTrashHost } from './session-trash.js'
import { agentFrame, presetWithin } from './start-agent.js'
import { errorKind } from './error-kind.js'
import { labelOf, progressOf } from './transcript-view.js'

/**
 * What the request queue reaches of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type QueuedRequestsHost = Pick<
  DelegationHost,
  'adapters' | 'agentRuns' | 'children' | 'deliver' | 'disposing' | 'handingOver' | 'handles' | 'meta' | 'nameOf' | 'store' | 'tellSession' | 'trashing'
> &
  Pick<SessionTrashHost, 'delegationFlow' | 'hostCards'> &
  Pick<RestartHost, 'inputsHeld'> & {
    /** ask_project's gates on the caller, read again when its queued request is delivered (ask-project-flow.ts) */
    askGateError: (callerId: string, quiet?: boolean) => string | null
    /** A registered project's row, read now */
    projectRow: (projectId: string | null | undefined) => ReturnType<DelegationHost['store']['projects']['listProjects']>[number] | undefined
    /** Whether a turn runs in the session for anyone: its state, or a wait on it not settled yet */
    turnRunning: (m: SessionInfo) => boolean
  }

/**
 * Requests for a session busy with a turn that is not the requester's (#677): what the requester may do about it, the
 * queue that holds a request until the turn ends, its delivery as a turn the requester owns, and the gates read again
 * at delivery. Moved out of the session manager as it was (#428); what it reaches of the manager is
 * `QueuedRequestsHost`.
 */
export class QueuedRequests {
  constructor(private readonly host: QueuedRequestsHost) {}

  /**
   * Whether a request from `callerId` finds the session busy with a turn that is not the caller's (#677): a turn
   * running (the person's, another session's or an app's), or requests queued ahead of it. The caller's own running
   * turn there is not busy for it: a note into its own work stays its own path.
   */
  busyForCaller(callerId: string, sessionId: string): boolean {
    const m = this.host.meta.get(sessionId)
    if (!m) return false
    if (this.host.children.queued.get(sessionId)?.length || this.host.children.delivering.has(sessionId)) return true
    if (!this.host.turnRunning(m)) return false
    return this.host.children.turnOwners.get(sessionId)?.callerId !== callerId
  }

  /**
   * What a requester may do about a busy session (#677), each with whether it can, now. The requester chooses; nothing
   * was sent. `from`: the tool the request came through, which decides what a note is and whether a fork can be.
   */
  busyChoices(callerId: string, target: SessionInfo, from: QueuedRequest['via']): BusyChoice[] {
    const auto = this.host.meta.get(callerId)?.permissionPreset === 'auto'
    const adapter = this.host.adapters.get(target.tool)
    const midTurn = !!adapter?.capabilities.midTurnInput && !!this.host.handles.get(target.id)?.sendTracked
    const running = this.host.turnRunning(target)
    const noteWhy = !auto
      ? 'only a session whose permission preset is auto adds a note to a turn that is not its own (#606)'
      : !running
        ? 'nothing is running there to add it to: requests are queued ahead of yours'
        : from === 'ask_project' && this.host.agentRuns.has(target.id) && !this.host.agentRuns.get(target.id)!.finished
          ? "another session's task runs there"
          : from !== 'send_to_session' && !midTurn
            ? 'its CLI cannot take a note during a turn'
            : undefined
    const forkWhy = from === 'ask_project'
      ? 'ask_project never creates a session in another project'
      // Said first, whatever its CLI can do (#994 review): a session with no project (the orchestrator's child) has no repository to fork from
      : !target.projectId
        ? 'it works outside any project, so there is nothing to fork it from; send to it once its turn ends, or start a new session'
      : !adapter?.forkConversation
        ? `${adapter?.descriptor.label ?? target.tool} cannot fork a conversation`
        : !(target.externalId ?? target.importedFrom)
          ? 'it has no conversation to copy yet'
          : this.host.delegationFlow.forkGateError(callerId, target) ?? undefined
    return [
      { choice: 'note', available: !noteWhy, ...(noteWhy ? { why: noteWhy } : {}) },
      { choice: 'queue', available: true },
      { choice: 'fork', available: !forkWhy, ...(forkWhy ? { why: forkWhy } : {}) },
    ]
  }

  busyAnswer(callerId: string, target: SessionInfo, from: QueuedRequest['via']): Extract<BusyAnswer, { state: 'busy' }> {
    // How many requests a queued one would wait behind, and where the running turn is (#1186)
    const ahead = this.host.children.queued.get(target.id)?.length ?? 0
    const progress = progressOf(this.host.store.messages, target.id)
    return {
      state: 'busy', sessionId: target.id, sessionName: target.name,
      sessionState: ahead && !inTurn(target.state) ? 'queued requests' : blockedOnQuestion(target) ? 'waiting on a question' : target.state,
      choices: this.busyChoices(callerId, target, from),
      ...(ahead ? { ahead } : {}),
      ...(progress ? { progress } : {}),
    }
  }

  /** Holds a request for a busy session until its turn ends (#677); the handle and the place in its queue */
  enqueue(callerId: string, target: SessionInfo, via: QueuedRequest['via'], text: string): Extract<BusyAnswer, { state: 'queued' }> {
    // A retry of the same request (same requester, tool and words) is the one already held, not a second (#684 review)
    const held = this.host.children.queued.get(target.id) ?? []
    const same = held.findIndex((x) => x.callerSessionId === callerId && x.via === via && x.text === text)
    if (same >= 0) return { state: 'queued', sessionId: target.id, sessionName: target.name, queueId: held[same]!.id, position: same + 1 }
    // Marked, and stored with the row, when only `auto` let an ask through: the delivery gate reads it (`queuedGateError`)
    const openedByAuto = via === 'ask_project' && this.host.meta.get(callerId)?.permissionPreset === 'auto' && !this.pairConsented(callerId, target)
    const r: QueuedRequest = { id: `qr-${randomUUID()}`, sessionId: target.id, callerSessionId: callerId, via, text, queuedAt: Date.now(), openedByAuto }
    const position = this.host.children.enqueue(r)
    // The turn may have ended while the caller chose
    this.scheduleDrain(target.id)
    return { state: 'queued', sessionId: target.id, sessionName: target.name, queueId: r.id, position }
  }

  /** Sessions whose queued request being delivered has been handed to the process (#839): only then can the tool refuse it */
  readonly queuedHandedIn = new Set<string>()

  /** After the event that freed the session has run its course (reports, observers), the next queued request goes in */
  scheduleDrain(sessionId: string): void {
    setTimeout(() => void this.drainQueue(sessionId), 0)
  }

  /**
   * Delivers the oldest request queued for a session now at rest (#677), as a new turn its requester owns: the
   * requester's delegation (`agent_session`, `ask_project`) or turn (`send_to_session`), with its cards (#676) and the
   * report when it ends. One at a time; the next waits for that turn to end. Not while the host is leaving: the next
   * one delivers it.
   */
  private async drainQueue(sessionId: string): Promise<void> {
    if (this.host.disposing || this.host.handingOver || this.host.children.delivering.has(sessionId)) return
    const m = this.host.meta.get(sessionId)
    const list = this.host.children.queued.get(sessionId)
    if (!m || !list?.length) return
    // A deferred restart is not waited out here: `deliver` waits for it, and its end schedules this again
    if (this.host.turnRunning(m) || this.host.inputsHeld(sessionId) || this.host.trashing.has(sessionId)) return
    const r = list[0]!
    const caller = this.host.meta.get(r.callerSessionId)
    if (!caller) {
      this.host.children.dropQueued((x) => x.id === r.id)
      return this.scheduleDrain(sessionId)
    }
    // It may have waited hours, or a host swap: the request tool's gates are read again before it goes in
    const refused = this.queuedGateError(r, caller, m)
    if (refused) {
      this.host.children.dropQueued((x) => x.id === r.id)
      void this.tellQueuedFailed(caller.id, sessionId, refused)
      return this.scheduleDrain(sessionId)
    }
    // Reserved before the first await: the session is busy from here, and this is the only drain for it
    this.host.children.startDelivering(sessionId, r.id)
    this.queuedHandedIn.delete(sessionId)
    /*
     * The input goes to the process here, after any wake (#839). The requester is told when the turn ends, as for work it
     * did not wait on: marked as the input is handed in, so a tool that refuses it at once ends the request with that
     * end reported, and a delivery that fails before (a crash while waking) is said once, as not delivered.
     */
    const handIn = (h: SessionHandle, input: string) => {
      this.host.children.markReport(sessionId, caller.id)
      this.queuedHandedIn.add(sessionId)
      h.send(input)
    }
    const from = { sessionId: caller.id, name: labelOf(this.host.store.messages, caller) }
    const project = this.host.projectRow(m.projectId)
    const target = { id: m.projectId ?? '', name: project?.name ?? '', path: this.host.store.sessions.sessionCwd(m.id) ?? m.worktree?.path ?? project?.path ?? '' }
    /*
     * And once more when the session is awake: a row being delivered is left out of `withdrawReaches` and
     * `dropOpenedByAuto`, so trust or `auto` taken away while a restart or a wake is waited out is only seen here
     */
    // An untrusted project's `auto` boundary was logged by the read above, with no wait since
    const logged = this.host.projectRow(caller.projectId)?.trusted !== true
    const stillAllowed = () => {
      const callerNow = this.host.meta.get(caller.id)
      const targetNow = this.host.meta.get(sessionId)
      return callerNow && targetNow ? this.queuedGateError(r, callerNow, targetNow, logged) : 'The session that asked, or the one asked, is gone.'
    }
    let d: Delegation | undefined
    try {
      if (r.via === 'send_to_session') {
        this.host.children.ownTurn(sessionId, caller.id, true)
        await this.host.deliver(sessionId, r.text, undefined, from, false, undefined, 'inline', handIn, stillAllowed)
      } else if (r.via === 'agent_session') {
        d = this.host.delegationFlow.startDelegation(`${caller.id}>${sessionId}`, caller.id, sessionId, target, true)
        await this.host.deliver(sessionId, agentFrame(from.name, r.text), undefined, from, false, undefined, 'inline', handIn, stillAllowed)
      } else {
        d = this.host.delegationFlow.startDelegation(`${caller.id}>${target.id}>${sessionId}`, caller.id, sessionId, target, false)
        const callerProject = this.host.projectRow(caller.projectId)?.name ?? 'another project'
        await this.host.deliver(sessionId, askFrame(callerProject, r.text, { name: from.name, sessionId: caller.id }), undefined, from, false, undefined, 'inline', handIn, stillAllowed)
      }
      this.host.children.delegated(caller.id, sessionId, r.via, r.text)
      // Its turn may have started without this host seeing the step into it
      if (inTurn(this.host.meta.get(sessionId)?.state ?? 'idle')) this.host.children.queuedTurnStarted(sessionId)
    } catch (e) {
      // Leaving: the row stays, marked, and the next host delivers it
      if (this.host.handingOver || this.host.disposing) return
      // Said once, below, rather than as a report too
      if (this.host.children.awaitingReport.get(sessionId) === caller.id) this.host.children.clearReport(sessionId)
      if (d) {
        d.wait.fail(e as Error)
      } else this.host.children.releaseTurn(sessionId, caller.id)
      this.host.children.dropQueued((x) => x.id === r.id)
      void this.tellQueuedFailed(caller.id, sessionId, (e as Error).message, true)
      this.scheduleDrain(sessionId)
    }
  }

  /**
   * What the tool that queued a request checked before queuing it, read again at delivery, with the caller's preset as
   * it is now. ask_project: the gates on the caller, the target project still registered, and the pair's consent when
   * only the caller's `auto` let the request pass without it (`QueuedRequest.openedByAuto`, stored with the row); a consent the person gave once on a
   * card covers the request, and revoking a remembered one drops the queue (`withdrawReaches`). agent_session: the
   * ownership a caller that is not `auto` needs (a session it started) and the preset rule (never work for a session
   * now above the caller). send_to_session queues behind the orchestrator's scope, which no card stands for.
   * `quiet`: an earlier read already logged the `auto` boundary an ask_project row opens (`askGateError`).
   */
  private queuedGateError(r: QueuedRequest, caller: SessionInfo, target: SessionInfo, quiet = false): string | null {
    const auto = caller.permissionPreset === 'auto'
    if (r.via === 'ask_project') {
      const project = this.host.projectRow(target.projectId)
      const gate = this.host.askGateError(caller.id, quiet) ?? (project ? null : 'The project asked was removed from Centralu.')
      if (gate) return gate
      if (!auto && r.openedByAuto && !this.pairConsented(caller.id, target)) {
        return "The asking session is no longer auto, and the person has not allowed its project to ask this one."
      }
      return null
    }
    if (r.via === 'agent_session') {
      if (!auto && (target.askedBy !== caller.id || target.projectId !== caller.projectId)) {
        return `The asking session is no longer auto, and "${target.name}" is not a session it started.`
      }
      if (!presetWithin(target.permissionPreset, caller.permissionPreset)) {
        return `"${target.name}" now has more permissions (${target.permissionPreset}) than the session that queued the request (${caller.permissionPreset}).`
      }
      return null
    }
    if (r.via === 'send_to_session') return null
    // A tool this build does not know (#384): `restoreQueued` leaves such a row in the store, so this is the guard behind it
    return `The request was queued through ${JSON.stringify(r.via)}, which this version of Centralu cannot deliver.`
  }

  /** A remembered "always" for the caller's project to ask the target's (#371), read now */
  pairConsented(callerId: string, target: SessionInfo): boolean {
    const from = this.host.meta.get(callerId)?.projectId
    return !!from && !!target.projectId && (from === target.projectId || !!this.host.store.permissions.getProjectConsent(from, target.projectId, 'delegate'))
  }

  /**
   * Requests of `sessionId` that only `auto` let through, dropped when they would go on without it (#606), as `auto`'s
   * attachments stop counting: the session moved off `auto`, or a handoff giving them to a session that is not `auto`
   * (`moveChildren`). An ask marked `openedByAuto` whose pair still has no remembered consent, and an agent_session
   * send to a session it did not start. One being delivered now is left to the delivery gate, which reads the mark
   * again if a swap delivers it once more. `tell` (default: the session itself) is told.
   */
  dropOpenedByAuto(sessionId: string, tell = sessionId): void {
    const dropped = this.host.children.dropQueued((r) => {
      if (r.callerSessionId !== sessionId || this.host.children.delivering.get(r.sessionId) === r.id) return false
      const target = this.host.meta.get(r.sessionId)
      if (!target) return false
      if (r.via === 'ask_project') return !!r.openedByAuto && !this.pairConsented(sessionId, target)
      if (r.via === 'agent_session') return target.askedBy !== sessionId
      return false
    })
    for (const r of dropped) {
      void this.tellQueuedFailed(tell, r.sessionId, 'The asking session is no longer auto, and only auto let this request through.')
    }
  }

  /**
   * Withdraws what rests on a project's trust, on a pair's consent, or on the project itself, when the person takes it
   * away: the cards a session raised to reach another project (`project_access`) or to fork (start_agent cards with no
   * request of their own, `forkFor`), and the ask_project requests still queued. A call waiting on a card reads the gate
   * that now refuses it; a queued request's caller is told, as for one that could not be delivered.
   *
   * `keepAuto`: trust and a revoked consent do not close an `auto` session's reach (#603), so its cards and requests
   * stay; the delivery gate reads them again if it is moved off `auto` (`queuedGateError`, `dropOpenedByAuto`).
   * A removed project keeps nothing.
   */
  withdrawReaches(
    cards: (ask: HostAsk) => boolean,
    queued: (r: QueuedRequest, callerProjectId: string | null | undefined, targetProjectId: string | null | undefined) => boolean,
    why: string,
    keepAuto: boolean,
  ): void {
    const kept = (sessionId: string) => keepAuto && this.host.meta.get(sessionId)?.permissionPreset === 'auto'
    for (const ask of [...this.host.hostCards.hostAsks.values()]) {
      const reach = ask.detail.kind === 'project_access' || (ask.detail.kind === 'agent_start' && !this.host.children.agentStarts.has(ask.requestId))
      if (reach && !kept(ask.sessionId) && cards(ask)) this.host.hostCards.withdrawHostAsk(ask.requestId)
    }
    const dropped = this.host.children.dropQueued((r) =>
      r.via === 'ask_project' &&
      this.host.children.delivering.get(r.sessionId) !== r.id &&
      !kept(r.callerSessionId) &&
      queued(r, this.host.meta.get(r.callerSessionId)?.projectId, this.host.meta.get(r.sessionId)?.projectId),
    )
    for (const r of dropped) void this.tellQueuedFailed(r.callerSessionId, r.sessionId, why)
    /*
     * A request kept only because its caller is `auto` now rests on `auto` alone (#838): the consent or trust it was
     * queued under is gone. Marked, and stored, so moving the caller off `auto` drops it (`dropOpenedByAuto`) and the
     * delivery gate refuses it, on this host or the next. Unmarked, an ask queued under a remembered consent was
     * delivered after the person revoked the consent and the caller left `auto`.
     */
    for (const list of this.host.children.queued.values()) {
      for (const r of list) {
        if (r.via === 'ask_project' && kept(r.callerSessionId) && queued(r, this.host.meta.get(r.callerSessionId)?.projectId, this.host.meta.get(r.sessionId)?.projectId)) {
          this.host.children.markOpenedByAuto(r)
        }
      }
    }
  }

  /**
   * A queued request could not be delivered (#677): said in the requester's session, as a report is. `fromError`: the
   * reason is an error's text, not Centralu's own sentence, and reaches the model by its kind only (#1186 review)
   */
  async tellQueuedFailed(callerId: string, sessionId: string, why: string, fromError = false): Promise<void> {
    const name = this.host.nameOf(sessionId)
    const reason = fromError
      ? `Reason, by kind: ${errorKind(why)} (its words are an error's, kept in this notice on the person's screen).`
      : `Reason (as JSON): ${JSON.stringify(why.slice(0, 600))}`
    await this.host.tellSession(
      callerId,
      `[Centralu] Your queued request to another session was not delivered.\nSession: ${frameField(name)}\nid: ${sessionId}\n\nReason: ${why.slice(0, 600)}`,
      { sessionId, name },
      true,
      // What the model reads (#1186): not the session's name, which is not Centralu's words (#120), nor an error's words
      `[Centralu] Your queued request to another session was not delivered.\nid: ${sessionId}\n\n${reason}`,
    )
  }

  /** The caller's requests still queued for a session (#677), as status reads them */
  queuedOf(callerId: string, sessionId: string): ChildRunResult | undefined {
    const list = this.host.children.queued.get(sessionId) ?? []
    const i = list.findIndex((r) => r.callerSessionId === callerId)
    const m = this.host.meta.get(sessionId)
    if (i < 0 || !m) return undefined
    return { ok: true, state: 'queued', sessionId, sessionName: m.name, tool: m.tool, queueId: list[i]!.id, position: i + 1 }
  }
}
