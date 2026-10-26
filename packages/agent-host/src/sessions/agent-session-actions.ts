import { liveBackgroundTasks } from '@cc/protocol'
import type { AgentListRow, AgentSessionOpts, ChildRunResult } from '../adapters/contract.js'
import { inTurn } from '../idle.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { taskList, type BackgroundStops } from './background-stops.js'
import type { AgentStartRecord } from './child-ownership.js'
import type { DelegationForks } from './delegation-forks.js'
import type { DelegationHost } from './delegation-host.js'
import type { DelegationWaits } from './delegation-waits.js'
import type { ObservedTurns } from './observed-turns.js'
import type { RemoteAgents } from './remote-agents.js'
import { agentState, ownAgents } from './own-agents.js'
import { agentFrame, agentNoteFrame, presetWithin } from './start-agent.js'
import { agentStartPending, agentStartPersonText, type AgentStartFlow, type StartAgentDelegations } from './start-agent-flow.js'
import { labelOf, lastActiveOf } from './transcript-view.js'
import { raceBound } from './with-timeout.js'

/**
 * What agent_session reaches of the rest of the delegation flow (`DelegationFlow`): the child's run and its wait, the
 * answers, the observed turns, the stops of background work, the fork and start_agent's requests
 */
export type AgentSessionDelegations = Pick<StartAgentDelegations, 'agentWorking' | 'awaitAgent' | 'handedOverAnswer' | 'startDelegation'> &
  Pick<DelegationWaits, 'agentAsking' | 'agentAtRest' | 'handedOverReply' | 'untilHandedOver'> &
  Pick<ObservedTurns, 'observeTurn' | 'readObserverNote' | 'tellNoteRefused'> &
  Pick<BackgroundStops, 'restingWork' | 'stopOwnWork' | 'stopPausedWork'> &
  Pick<DelegationForks, 'forkFor'> & { readonly starts: AgentStartFlow; readonly remote: RemoteAgents }


/**
 * agent_session (#561): status, wait, send, stop and delete on a session the caller started or may work with, on a
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
   *   send    gives it more, including during the caller's turn on adapters that accept mid-turn input; refused
   *           while it works on the person's own message or has a higher preset than the caller
   *   stop    stops the turn the caller gave it; a turn the person started there is theirs
   *   delete  trashes a child without a worktree, stopping it first; worktree cleanup requires an idle child (#608)
   */
  async agentSession(callerId: string, opts: AgentSessionOpts, signal?: AbortSignal): Promise<ChildRunResult> {
    if (opts.sessionId === callerId && opts.action !== 'status') {
      return { ok: false, error: 'agent_session cannot wait on, stop, delete or send to its own calling session.' }
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
     * A turn this caller gave a session of another project (#676, ask_project): its cards are the caller's to read and
     * answer. Nothing else of that session is; ask_project with no task waits on the turn.
     */
    if (caller && child && child.projectId !== caller.projectId && this.host.children.turnOwners.get(child.id)?.callerId === callerId) {
      if (opts.action === 'answer') return this.host.answerRoutedCard(callerId, child.id, opts.card, opts.text ?? '')
      if (opts.action !== 'status' && opts.action !== 'wait') return { ok: false, error: `"${child.name}" is another project's session: you can read and answer the cards of the turn you gave it (status, answer), and wait on it with ask_project.` }
      const cards = this.host.routedCards(child.id, callerId)
      return cards.length
        ? { ok: true, state: 'asking', sessionId: child.id, sessionName: child.name, tool: child.tool, cards }
        : { ok: true, state: 'working', sessionId: child.id, sessionName: child.name, tool: child.tool, reported: false }
    }
    const deletingWithoutWorktree = opts.action === 'delete' && !child?.worktree
    const startedHere = child?.askedBy === callerId || (deletingWithoutWorktree && child?.parentSessionId === callerId)
    // The orchestrator works on the children it started outside any project (#853), and on no other session
    const seat = caller?.projectId ? 'project' : caller?.kind === 'orchestrator' ? 'orchestrator' : null
    const owns = seat === 'orchestrator' ? child?.askedBy === callerId : startedHere || (!deletingWithoutWorktree && this.host.autoBoundaryOpen(callerId, 'session ownership'))
    if (!caller || !seat || !child || !owns || child.projectId !== caller.projectId) {
      return { ok: false, error: `${opts.sessionId} is not a session this session started. agent_session works only on sessions start_agent started here.` }
    }
    if (opts.sessionId === callerId) return this.flow.agentAtRest(child)
    if (opts.action === 'answer') return this.host.answerRoutedCard(callerId, child.id, opts.card, opts.text ?? '')
    const key = `${callerId}>${child.id}`
    // An observer that sent a note reads its own note's reader, never the owner's delegation (#646)
    const note = this.host.children.delegations.has(key) ? undefined : this.host.children.observerNotes.get(key)
    if (note && (opts.action === 'status' || opts.action === 'wait')) return this.flow.readObserverNote(key, note, opts.action === 'wait', signal)
    let d = this.host.children.delegations.get(key)
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
    // A turn it gave that this host has no delegation for (it found the link in the store after a swap, #676)
    if (!d && (opts.action === 'status' || opts.action === 'wait')) {
      const cards = this.host.routedCards(child.id, callerId)
      if (cards.length) return { ok: true, state: 'asking', sessionId: child.id, sessionName: child.name, tool: child.tool, cards }
    }
    try {
      switch (opts.action) {
        case 'status': {
          // A request still queued for it (#677)
          const held = (!d || d.settled) ? this.host.queuedOf(callerId, child.id) : undefined
          if (held) return held
          // The cards of the turn it gave are what the owner reads first (#676)
          const cards = d && !d.settled && !observing ? this.host.routedCards(child.id, callerId) : []
          if (d && cards.length) return this.flow.agentAsking(d, cards)
          if (d && !d.settled) return this.flow.agentWorking(d, false, observing)
          return d ? await this.flow.awaitAgent(key, d, signal, observing) : this.flow.agentAtRest(child, callerId)
        }
        case 'wait':
          return d ? await this.flow.awaitAgent(key, d, signal, observing) : this.flow.agentAtRest(child, callerId)
        case 'stop': {
          // A queued request is withdrawn before it is delivered (#677)
          if ((!d || d.settled) && this.host.children.dropQueued((r) => r.sessionId === child.id && r.callerSessionId === callerId && this.host.children.delivering.get(child.id) !== r.id).length) {
            return { ok: true, state: 'stopped', sessionId: child.id, sessionName: child.name, tool: child.tool }
          }
          // A report paused over its own background work (#721): stop ends that wait
          if ((!d || d.settled) && !observing && this.host.children.pausedReports.has(child.id) && this.host.children.awaitingReport.get(child.id) === callerId) {
            return this.flow.stopPausedWork(child)
          }
          // Its turn over, only its own background work left (#718): that is what is running, and what delete waits on
          const resting = (!d || d.settled) && !observing ? this.flow.restingWork(child, callerId) : []
          if (resting.length) return this.flow.stopOwnWork(child, resting, false)
          if (!d || d.settled) return { ok: false, error: `Nothing you gave "${child.name}" is running.` }
          if (!observing && this.host.children.awaitingReport.get(child.id) === callerId) this.host.children.clearReport(child.id)
          d.stop('the session that started it stopped it', observing)
          await d.outcome
          if (!observing) this.host.children.dropDelegation(key, d)
          return { ok: true, state: 'stopped', sessionId: child.id, sessionName: child.name, tool: child.tool }
        }
        case 'delete': {
          if (!child.worktree) {
            const busy = inTurn(child.state) ||
              !!child.pendingApproval || child.pendingQuestions.length > 0 ||
              (this.host.agentRuns.has(child.id) && !this.host.agentRuns.get(child.id)!.finished)
            if (!this.host.trashing.has(child.id) && busy && (!d || d.settled || d.callerId !== callerId)) {
              return { ok: false, error: `"${child.name}" is busy with something else; the person may be using it. Wait for that turn and its pending approval or question to finish before deleting it.` }
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
          const r = await this.host.cleanUpWorktreeChild(child)
          if (!r.ok) return r
          if (d) this.host.children.dropDelegation(key, d)
          const note = [r.note, timers.length ? `Its timers ended with its process: ${taskList(timers)}.` : ''].filter(Boolean).join(' ')
          return { ok: true, state: 'deleted', sessionId: child.id, sessionName: child.name, tool: child.tool, branch: r.branch, setAside: r.setAside, ...(r.warning ? { warning: r.warning } : {}), ...(note ? { note } : {}) }
        }
        case 'send': {
          if (!presetWithin(child.permissionPreset, caller.permissionPreset)) {
            return {
              ok: false,
              error: `"${child.name}" now has more permissions (${child.permissionPreset}) than this session (${caller.permissionPreset}), so this session cannot give it work. Tell the person.`,
            }
          }
          const from = { sessionId: callerId, name: labelOf(this.host.store.messages, caller) }
          /*
           * Busy with a turn that is not the caller's (#677): the caller chooses what happens, a note into that turn,
           * a queue, or a fork; without `ifBusy` nothing is sent and the choices come back. Its own delegation's
           * turn is not busy for it: a note into its own work goes on as before.
           */
          if ((d && !d.settled && observing) || ((!d || d.settled) && this.host.busyForCaller(callerId, child.id))) {
            if (!opts.ifBusy) return { ok: true, tool: child.tool, ...this.host.busyAnswer(callerId, child, 'agent_session') }
            if (opts.ifBusy === 'queue') return { ok: true, tool: child.tool, ...this.host.enqueue(callerId, child, 'agent_session', opts.text ?? '') }
            if (opts.ifBusy === 'fork' || opts.ifBusy === 'fork_read') {
              const f = await this.flow.forkFor(callerId, child, opts.text ?? '', opts.ifBusy === 'fork_read', 'agent_session', signal)
              if (!f.ok) return f
              if ('queued' in f) return { ok: true, tool: child.tool, ...f.queued }
              const r = await this.flow.awaitAgent(f.key, f.d, signal)
              return r.ok ? { ...r, via: 'fork', forkedFrom: child.id } : r
            }
            const note = this.host.busyChoices(callerId, child, 'agent_session').find((c) => c.choice === 'note')!
            if (!note.available || !d || d.settled) return { ok: false, error: `No note to "${child.name}": ${note.why ?? 'nothing is running there to add it to'}. Queue it or fork it instead.` }
            this.host.autoBoundaryOpen(callerId, 'a note into a turn that is not its own')
          }
          /*
           * The turn the child's own tool started when the work it paused on ended is the caller's work (#1576): its end is
           * the report the caller is owed (`continuesPause`). A note goes into it as an observer's does, on a wait of its
           * own, so the report owed is not touched; it needs no `auto`, as the turn it gave needs none
           */
          const continuing = (!d || d.settled) && inTurn(child.state) && this.host.children.continuesPause(child.id, callerId)
          if ((d && !d.settled) || continuing) {
            const text = agentNoteFrame(from.name, opts.text ?? '')
            if (!this.host.adapters.get(child.tool)?.capabilities.midTurnInput || !this.host.handles.get(child.id)?.sendTracked) {
              return { ok: false, error: `"${child.name}" cannot take messages while working. Wait for it (action "wait") or stop it first.` }
            }
            /*
             * An observer's note rides on a wait of its own (#646). Holding, resolving or failing the owner's wait
             * would hand the owner the reply to this note instead of its answer, or fail its whole delegation when
             * the note is refused; the owner's wait is never touched from here.
             */
            const own = observing || continuing ? this.flow.observeTurn(child, true, true) : undefined
            if (own) void own.run.wait.done.then(own.release, own.release)
            const record = own ? { run: own.run, waiters: 0, told: false } : undefined
            if (record) this.host.children.setObserverNote(key, record)
            const wait = own?.run.wait ?? d!.wait
            const releaseHold = wait.holdInput()
            const release = () => {
              releaseHold()
              this.host.applyDeferredRestart(child.id)
            }
            try {
              await this.host.deliver(child.id, text, undefined, from, false, undefined, 'inline', (h, input) => {
                const fail = (e: Error) => {
                  if (!record) {
                    wait.fail(e)
                    return release()
                  }
                  wait.fail(new Error(`your note was not delivered: ${e.message}`))
                  release()
                  // A wait on the note reads the refusal itself; otherwise the observer is told, once
                  if (!record.told && !record.waiters && this.host.children.observerNotes.get(key) === record) {
                    record.told = true
                    void this.flow.tellNoteRefused(callerId, child.id, e.message)
                  }
                }
                void h.sendTracked!(input, { complete: release, fail }).then(release, fail)
              })
            } catch (e) {
              if (record) {
                wait.fail(e as Error)
                this.host.children.dropObserverNote(key, record)
              }
              release()
              return { ok: false, error: `Could not send it: ${(e as Error).message}` }
            }
            // An observer's note is not work its owner gave (#646): only the caller's own words are written down in the mailbox
            if (!observing) this.host.children.delegated(callerId, child.id, 'agent_session', opts.text ?? '')
            // Keep the same outcome and any active wait. A send must not re-arm a report on top of that wait.
            if (continuing) return { ...this.flow.agentWorking(own!.run, false, true), reported: this.host.children.awaitingReport.get(child.id) === callerId, via: 'note' }
            const working = this.flow.agentWorking(d!, false, observing)
            return working.ok && observing ? { ...working, via: 'note' } : working
          }
          if (inTurn(child.state) || (this.host.agentRuns.has(child.id) && !this.host.agentRuns.get(child.id)!.finished)) {
            // Said by what started the turn (#1576): "the person may be using it" only when a person's message did
            const person = this.host.children.starterOf(child.id)?.by !== 'work'
            return { ok: false, error: `"${child.name}" is busy with ${person ? 'something else (the person may be using it)' : 'a turn you did not give it (another session, or its own tool, started it)'}. Try again later.` }
          }
          // An answer the caller never came back for gives way to the new message
          if (d) this.host.children.dropDelegation(key)
          const full = this.flow.starts.agentCeilingError(callerId, child.projectId ?? '')
          if (full) return { ok: false, error: full }
          const project = this.host.store.projects.listProjects().find((p) => p.id === child.projectId)
          const cwd = this.host.store.sessions.sessionCwd(child.id) ?? child.worktree?.path ?? project?.path ?? ''
          const next = this.flow.startDelegation(key, callerId, child.id, { id: child.projectId ?? '', name: project?.name ?? '', path: cwd }, true)
          try {
            await this.host.deliver(child.id, agentFrame(from.name, opts.text ?? ''), undefined, from, false)
          } catch (e) {
            // Its wait fails too (#839): a wait of the caller's joined it while the child woke
            next.wait.fail(e as Error)
            this.host.children.dropDelegation(key, next)
            if (this.host.agentRuns.get(child.id) === next.wait) this.host.agentRuns.delete(child.id)
            this.host.children.releaseTurn(child.id, callerId)
            return { ok: false, error: `Could not send it: ${(e as Error).message}` }
          }
          this.host.children.delegated(callerId, child.id, 'agent_session', opts.text ?? '')
          return this.flow.awaitAgent(key, next, signal)
        }
        default:
          return { ok: false, error: 'Unknown agent_session action.' }
      }
    } finally {
      releaseObservation?.()
    }
  }

  /**
   * agent_session on a start_agent request's handle (#673). While the card stands: status says so, wait waits for the
   * person's answer up to the bound, stop (or delete) withdraws the card, send is refused. Once the child started, the
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
      if (action === 'send') {
        const on = rec.lowMemory ? 'memory to start' : "the person's answer"
        return { ok: false, error: `No session yet: request ${id} is still waiting for ${on}. Send once it has started.` }
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
