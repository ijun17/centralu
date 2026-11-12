import { atRest, liveBackgroundTasks, isAssistantKind } from '@cc/protocol'
import type { AgentListRow, AgentSessionOpts, ChildRunResult, IfBusy } from '../adapters/contract.js'
import { inTurn } from '../idle.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { taskList, type BackgroundStops } from './background-stops.js'
import type { AgentStartRecord } from './agent-start-record.js'
import type { DelegationForks } from './delegation-forks.js'
import type { DelegationHost } from './delegation-host.js'
import type { DelegationWaits } from './delegation-waits.js'
import type { ObservedTurns } from './observed-turns.js'
import type { RemoteAgents } from './remote-agents.js'
import { agentState, ownAgents } from './own-agents.js'
import { aboveCallerError, agentFrame, canMailParent } from './start-agent.js'
import { agentStartPending, agentStartPersonText, type AgentStartFlow, type StartAgentDelegations } from './start-agent-flow.js'
import { labelOf, lastActiveOf } from './transcript-view.js'
import { raceBound } from '../timing.js'
import { staleSessionHint } from './stale-session-id.js'

/**
 * What agent_session reaches of the rest of the delegation flow (`DelegationFlow`): the child's run and its wait, the
 * answers, the observed turns, the stops of background work, the fork and start_agent's requests
 */
export type AgentSessionDelegations = Pick<StartAgentDelegations, 'agentWorking' | 'awaitAgent' | 'handedOverAnswer' | 'startDelegation'> &
  Pick<DelegationWaits, 'agentAsking' | 'agentAtRest' | 'handedOverReply' | 'untilHandedOver'> &
  Pick<ObservedTurns, 'observeTurn'> &
  Pick<BackgroundStops, 'restingWork' | 'stopOwnWork'> &
  Pick<DelegationForks, 'forkFor'> & { readonly starts: AgentStartFlow; readonly remote: RemoteAgents }


/**
 * agent_session (#561): status, wait, stop and delete on a session the caller started or may work with, on a
 * start_agent request's handle (#673), and the list of the caller's own (#690). Moved out of `DelegationFlow` as it
 * was (#428); what it reaches of the rest of the flow is `AgentSessionDelegations`, of the manager `DelegationHost`.
 */
export class AgentSessionActions {
  constructor(
    private readonly host: DelegationHost,
    private readonly flow: AgentSessionDelegations,
  ) {}

  /**
   * agent_session list (#690): the sessions this caller started that are still here, oldest first. On 2026-10-14 a
   * parent used fourteen children's answers and deleted none of them until the person said it could: deleting was a
   * call away, but nothing showed it what was left. Only its own children (`askedBy`), in its own project, as the
   * other actions take them; a session another started is not its to delete.
   */
  async listAgents(callerId: string): Promise<AgentListRow[]> {
    const here = ownAgents(this.host, callerId).map((s) => {
      const lastActive = lastActiveOf(this.host.store.messages, s.id)
      return {
        sessionId: s.id,
        name: labelOf(this.host.store.messages, s),
        tool: s.tool,
        state: agentState(this.host, s),
        asleep: !s.live,
        ...(lastActive ? { lastActive } : {}),
        ...(s.worktree ? { worktree: { branch: s.worktree.branch, unmerged: !s.worktreeMerged } } : {}),
      }
    })
    // And those it started on linked machines (#1038), each with its machine
    return [...here, ...(await this.flow.remote.rows(callerId))]
  }

  /**
   * agent_session (#561): safe/normal work only with their own children; auto opens ownership within the project.
   *
   *   status  where it stands, without waiting (the answer, once the turn the caller gave it has ended)
   *   wait    waits on that turn up to the bound, as start_agent does
   *   stop    stops the turn the caller gave it; a turn the person started there is theirs
   *   delete  trashes a child without a worktree, stopping it first; worktree cleanup requires an idle child (#608)
   */
  async agentSession(callerId: string, opts: AgentSessionOpts, signal?: AbortSignal): Promise<ChildRunResult> {
    if (opts.sessionId === callerId && opts.action !== 'status') {
      return { ok: false, error: 'agent_session cannot wait on, stop or delete its own calling session.' }
    }
    // A child start_agent started on a linked machine (#1038): followed through the link. Its id is a linked machine's,
    // `<machine>.<id>`, which no session of this host has
    const remote = opts.sessionId.includes('.') ? this.flow.remote.of(opts.sessionId) : undefined
    if (remote) return this.flow.remote.agentSession(callerId, remote, opts, signal)
    // Work a handoff gave away (#693): the original that stayed is told where it went
    const gone = this.flow.handedOverAnswer(callerId, opts.sessionId)
    if (gone) return gone
    // A start that answered "pending" (#673): its handle is the request's id until the person answers
    const request = this.host.children.agentStarts.get(opts.sessionId)
    if (request && request.req.callerId === callerId) {
      const r = await this.agentStartSession(request, opts.action, signal)
      if ('ok' in r) return r
      opts = { ...opts, sessionId: r.childId, action: r.action }
    } else if (opts.sessionId.startsWith('ag-') && !this.host.meta.has(opts.sessionId)) {
      return {
        ok: false,
        error: `No start_agent request ${opts.sessionId} of this session is open here: it ended before Centralu restarted, or it is not this session's. read_session (without a sessionId) lists the sessions.`,
      }
    }
    const caller = this.host.meta.get(callerId)
    const child = this.host.meta.get(opts.sessionId)
    /*
     * A session of another project this caller has work open in (#676, ask_project; docs/plans/mailbox.md §10.6.4): its cards are the caller's to
     * read, and to answer as the gate allows. Nothing else of that session is; ask_project with no task waits on it.
     */
    if (caller && child && child.projectId !== caller.projectId && this.host.children.openTasks(child.id, 'to').includes(callerId)) {
      if (opts.action === 'answer') return this.host.answerRoutedCard(callerId, child.id, opts.card, opts.text ?? '')
      if (opts.action !== 'status' && opts.action !== 'wait') return { ok: false, error: `"${child.name}" is another project's session: you can read and answer the cards of the work you gave it (status, answer), and wait on it with ask_project.` }
      const cards = this.host.routedCards(child.id, callerId)
      return cards.length
        ? { ok: true, state: 'asking', sessionId: child.id, sessionName: child.name, tool: child.tool, cards }
        : { ok: true, state: 'working', sessionId: child.id, sessionName: child.name, tool: child.tool, reported: false }
    }
    const deletingWithoutWorktree = opts.action === 'delete' && !child?.worktree
    const startedHere = child?.askedBy === callerId || (deletingWithoutWorktree && child?.parentSessionId === callerId)
    // The Assistant works on the children it started outside any project (#853), and on no other session
    const seat = caller?.projectId ? 'project' : isAssistantKind(caller?.kind) ? 'assistant' : null
    const owns = seat === 'assistant' ? child?.askedBy === callerId : startedHere || (!deletingWithoutWorktree && this.host.autoBoundaryOpen(callerId, 'session ownership'))
    if (!caller || !seat || !child || !owns || child.projectId !== caller.projectId) {
      return { ok: false, error: `${opts.sessionId} is not a session this session started. agent_session works only on sessions start_agent started from here.${child ? '' : staleSessionHint(this.host, opts.sessionId, (s) => s.projectId === caller?.projectId && s.id !== callerId && (seat !== 'assistant' || s.askedBy === callerId))}` }
    }
    if (opts.sessionId === callerId) return this.flow.agentAtRest(child)
    if (opts.action === 'answer') return this.host.answerRoutedCard(callerId, child.id, opts.card, opts.text ?? '')
    const key = `${callerId}>${child.id}`
    let d = this.host.children.delegations.get(key)
    // The cards of work it gave are what the caller reads first (#676, docs/plans/mailbox.md §10.6.4), whatever delegation runs there or ran before
    const cards = opts.action === 'status' || opts.action === 'wait' ? this.host.routedCards(child.id, callerId) : []
    if (cards.length) return d && !d.settled ? this.flow.agentAsking(d, cards) : { ok: true, state: 'asking', sessionId: child.id, sessionName: child.name, tool: child.tool, cards }
    let releaseObservation: (() => void) | undefined
    if (!d && this.host.autoBoundaryOpen(callerId)) {
      const existing = [...this.host.children.delegations.values()].find((run) => run.sessionId === child.id && !run.settled)
      if (existing) d = existing
      else if (opts.action !== 'delete' && inTurn(child.state)) {
        const observation = this.flow.observeTurn(child, opts.action !== 'status')
        d = observation.run
        releaseObservation = observation.release
      }
    }
    const observing = !!d && d.callerId !== callerId
    try {
      switch (opts.action) {
        case 'status': {
          if (d && !d.settled) return this.flow.agentWorking(d, observing)
          return d ? await this.flow.awaitAgent(key, d, signal, observing) : this.flow.agentAtRest(child, callerId)
        }
        case 'wait':
          return d ? await this.flow.awaitAgent(key, d, signal, observing) : this.flow.agentAtRest(child, callerId)
        case 'stop': {
          // What it sent as mail and the session was not given yet is withdrawn first, whatever else runs (docs/plans/mailbox.md §10.6.2)
          const withdrawn = this.host.withdrawTasks(callerId, child.id)
          if ((!d || d.settled) && withdrawn > 0) {
            return { ok: true, state: 'stopped', sessionId: child.id, sessionName: child.name, tool: child.tool }
          }
          // Its turn over, only its own background work left (#718): that is what is running, and what delete waits on
          const resting = (!d || d.settled) && !observing ? this.flow.restingWork(child, callerId) : []
          if (resting.length) return this.flow.stopOwnWork(child, resting)
          if (!d || d.settled) return { ok: false, error: `Nothing you gave "${child.name}" is running.` }
          d.stop('the session that started it stopped it')
          await d.outcome
          if (!observing) this.host.children.dropDelegation(key, d)
          return { ok: true, state: 'stopped', sessionId: child.id, sessionName: child.name, tool: child.tool }
        }
        case 'delete': {
          if (!child.worktree) {
            const busy = !atRest(child) || (this.host.agentRuns.has(child.id) && !this.host.agentRuns.get(child.id)!.finished)
            if (!this.host.trashing.has(child.id) && busy && (!d || d.settled || d.callerId !== callerId)) {
              return { ok: false, error: `"${child.name}" is busy with something else; the person may be using it. Wait for that turn, its pending approval or question, and its background work to finish before deleting it (agent_session stop ends background work you started).` }
            }
            // The caller is done with the work: a thread whose work was reported is closed, before the session goes
            if (!observing) this.host.children.finishedWith(callerId, child.id)
            // Use the sidebar's stop/flush/trash path, including pending waits and wake withdrawal.
            await this.host.trashSession(child.id)
            if (d) this.host.children.dropDelegation(key, d)
            return { ok: true, state: 'deleted', sessionId: child.id, sessionName: child.name, tool: child.tool }
          }
          if (d && !d.settled) return { ok: false, error: `"${child.name}" is still working on what you gave it — stop it or wait first.` }
          // A timer the tool held (`/loop`) does not hold the cleanup (#718): it ends with the process, and the caller is told
          const timers = this.host.handles.has(child.id) ? liveBackgroundTasks(child.backgroundTasks).filter((t) => t.timer) : []
          if (!observing) this.host.children.finishedWith(callerId, child.id)
          const r = await this.host.worktrees.cleanUpWorktreeChild(child)
          if (!r.ok) return r
          if (d) this.host.children.dropDelegation(key, d)
          const note = [r.note, timers.length ? `Its timers ended with its process: ${taskList(timers)}.` : ''].filter(Boolean).join(' ')
          return { ok: true, state: 'deleted', sessionId: child.id, sessionName: child.name, tool: child.tool, branch: r.branch, setAside: r.setAside, ...(r.warning ? { warning: r.warning } : {}), ...(note ? { note } : {}) }
        }
        default:
          return { ok: false, error: 'Unknown agent_session action.' }
      }
    } finally {
      releaseObservation?.()
    }
  }

  /**
   * `mail` to a session agent_session works on for the caller, its start request or its linked child: new work, answered at once, its end told
   * (docs/plans/mailbox.md §10.6.6). Null for any other target: the send is plain mail
   */
  async sendWork(callerId: string, target: string, text: string, ifBusy?: IfBusy, signal?: AbortSignal): Promise<ChildRunResult | null> {
    const remote = target.includes('.') ? this.flow.remote.of(target) : undefined
    if (remote) {
      if (remote.callerId !== callerId) return null
      // §7.4: more work for a child on a linked machine is asked before it goes over the link
      const machine = this.host.linkedReader?.machineOf(target)
      const refused = this.host.refusesDelegation(callerId, { sessionId: target, linked: true }, { tool: 'mail', target: `a session on ${machine ?? 'a linked machine'}`, text })
      return refused ? { ok: false, error: refused } : this.flow.remote.send(callerId, remote, text)
    }
    // A start that answered "pending" (#673): its handle is the request's id until the person answers
    const request = this.host.children.agentStarts.get(target)
    if (request?.req.callerId === callerId) {
      const ended = request.ended
      if (!ended) return { ok: false, error: `No session yet: request ${target} is still waiting for ${request.lowMemory ? 'memory to start' : "the person's answer"}. Send once it has started.` }
      if ('error' in ended) return { ok: false, error: `Request ${target} started no session: ${ended.error}` }
      target = ended.childId
    }
    const caller = this.host.meta.get(callerId)
    const child = this.host.meta.get(target)
    // Only a session it started: under auto any session of the project is agent_session's, but mail to one (its parent too) stays mail
    if (!caller || !child || child.askedBy !== callerId || child.projectId !== caller.projectId) return null
    const above = aboveCallerError(child.name, child.permissionPreset, caller.permissionPreset)
    if (above) return { ok: false, error: above }
    // §7.4: before anything is sent, mailed or forked
    const refused = this.host.refusesDelegation(callerId, { sessionId: child.id, projectId: child.projectId }, { tool: 'mail', target: child.name || child.id, text })
    if (refused) return { ok: false, error: refused }
    // A session that cannot take it now is sent it as mail, which starts a turn of its own once it is free (docs/plans/mailbox.md §10.6.2); a fork if asked
    if (!this.host.takesSendNow(child.id)) {
      if (!ifBusy) {
        const mailed = this.host.mailTask(callerId, child, 'agent_session', text)
        return 'error' in mailed ? { ok: false, error: mailed.error } : { ok: true, tool: child.tool, ...mailed }
      }
      const f = await this.flow.forkFor(callerId, child, text, ifBusy === 'fork_read', 'agent_session', signal)
      if (!f.ok) return f
      if ('mailed' in f) return { ok: true, tool: child.tool, ...f.mailed }
      const working = this.flow.agentWorking(f.d)
      return working.ok ? { ...working, via: 'fork', forkedFrom: child.id } : working
    }
    const key = `${callerId}>${child.id}`
    // An answer the caller never came back for gives way to the new message
    if (this.host.children.delegations.has(key)) this.host.children.dropDelegation(key)
    const full = this.flow.starts.agentCeilingError(callerId, child.projectId ?? '')
    if (full) return { ok: false, error: full }
    const project = this.host.store.projects.listProjects().find((p) => p.id === child.projectId)
    const cwd = this.host.store.sessions.sessionCwd(child.id) ?? child.worktree?.path ?? project?.path ?? ''
    const next = this.flow.startDelegation(key, callerId, child.id, { id: child.projectId ?? '', name: project?.name ?? '', path: cwd }, true)
    // Written before the words go in, so a card the turn raises at once finds the caller's work open (docs/plans/mailbox.md §10.6.4)
    const withdraw = this.host.children.delegated(callerId, child.id, 'agent_session', text)
    const from = { sessionId: callerId, name: labelOf(this.host.store.messages, caller) }
    try {
      await this.host.deliver(child.id, agentFrame(from.name, text, [], '', canMailParent(child, callerId)), undefined, from, false)
    } catch (e) {
      withdraw()
      // Its wait fails too (#839): a wait of the caller's joined it while the child woke
      next.wait.fail(e as Error)
      this.host.children.dropDelegation(key, next)
      if (this.host.agentRuns.get(child.id) === next.wait) this.host.agentRuns.delete(child.id)
      return { ok: false, error: `Could not send it: ${(e as Error).message}` }
    }
    return this.flow.agentWorking(next)
  }

  /**
   * agent_session on a start_agent request's handle (#673). While the card stands: status says so, wait waits for the
   * person's answer up to the bound, stop (or delete) withdraws the card. Once the child started, the
   * call goes on to that session (a wait that saw it start answers its status, so the call stays inside its bound);
   * once it ended without one, the reason.
   */
  private async agentStartSession(
    rec: AgentStartRecord,
    action: AgentSessionOpts['action'],
    signal?: AbortSignal,
  ): Promise<ChildRunResult | { childId: string; action: AgentSessionOpts['action'] }> {
    const id = rec.req.requestId
    if (!rec.ended) {
      if (action === 'stop' || action === 'delete') {
        this.flow.starts.withdrawAgentStart(id, 'The session that asked withdrew the request.', agentStartPersonText(rec.req, 'stopped'))
        return { ok: true, state: 'stopped', sessionId: id, sessionName: '', tool: rec.req.detail.tool }
      }
      if (action === 'wait') {
        const owner = rec.req.callerId
        const leaving = this.flow.untilHandedOver(rec)
        const r = await raceBound(Promise.race([leaving.gone, rec.done]), ASK_WAIT_MS, signal)
        leaving.done()
        // A handoff gave the request to the session that took over (#693)
        if (r === 'handedOver') return this.flow.handedOverReply(owner, id)
        // Read again: the person may have answered while this waited
        const ended = rec.ended as AgentStartRecord['ended']
        if (ended && 'childId' in ended) return { childId: ended.childId, action: 'status' }
      }
      if (!rec.ended) return agentStartPending(rec.req, rec.lowMemory)
    }
    const ended = rec.ended!
    if ('error' in ended) return { ok: false, error: `Request ${id} started no session: ${ended.error}` }
    return { childId: ended.childId, action }
  }
}
