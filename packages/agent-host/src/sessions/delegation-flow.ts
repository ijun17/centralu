import type { QueuedRequest } from '../dev-services/store.js'
import type { AgentStartRecord, Delegation } from './child-ownership.js'
import { AgentRunWait } from './app-agents.js'
import { turnAnswer } from './turn-answer.js'
import { ASK_WAIT_MS, clipAnswer, pathsIn, readableGrants, taskLine } from './ask-project.js'
import { agentFrame, agentNoteFrame, presetWithin } from './start-agent.js'
import { labelOf, lastActiveOf } from './transcript-view.js'
import { agentDepthRefusal, recordAgentDepth } from './agent-depth.js'
import { agentState, cleanUpDue, ownAgents } from './own-agents.js'
import type {
  BackgroundTask,
  PermissionPreset,
  SessionInfo,
} from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
  liveBackgroundTasks,
} from '@cc/protocol'
import { inTurn } from '../idle.js'
import type { AgentListRow, BusyAnswer, ChildRunResult, AgentSessionOpts, RoutedCard } from '../adapters/contract.js'
import { raceBound } from './with-timeout.js'
import type { DelegationHost } from './delegation-host.js'
import { AgentStartFlow, agentStartPending, agentStartPersonText } from './start-agent-flow.js'

// Moved with start_agent (#850); still importable from here
export type { DelegationHost } from './delegation-host.js'
export { ASK_THE_PERSON, START_AGENT_CALL_MS, START_AGENT_MODEL_CHECK_MS, START_AGENT_SETUP_MS, agentStartPersonText } from './start-agent-flow.js'

/** How a wait on a delegation's turn ended (`DelegationFlow.awaitTurn`), for each caller to word (#428) */
export type TurnWait =
  /** A handoff gave the delegation away (#693); `owner` is who it was waited for */
  | { kind: 'handedOver'; owner: string }
  /** Cards wait on the caller (#676) */
  | { kind: 'asking'; cards: RoutedCard[] }
  /** Woken by a card that is no longer standing */
  | { kind: 'working' }
  | { kind: 'bound' }
  /** The call was cancelled: the turn was stopped, or left running when it was another's or the person's */
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; answer: string }

/** Tasks named for another session's model: each description is a single framed field (#120), with how it ended */
/** How long `agent_session stop` waits for the tool to report the end of the background work it stopped (#718) */
export const STOP_REPORTED_MS = 3_000

export function taskList(tasks: readonly BackgroundTask[], status = false): string {
  return tasks.map((t) => (status ? `${frameField(t.description)}: ${t.status}` : frameField(t.description))).join(', ')
}

/**
 * The sender a hub's orchestrator's instruction is recorded under (`sendFromHub`). Not a session of this host: no id
 * this host makes starts with `_`. The window shows only the sender's name; the id is what the injection gate reads
 */
export const HUB_SENDER = '_hub-orchestrator'

/**
 * The work one session gives another (#428): ask_project's delegations (#371 part B; linked machines, #700), start_agent
 * and its requests (#561, #673, #686), agent_session (#561), and the waits on them, over `ChildOwnership`. Moved out of
 * the session manager as it was; what it reaches of the manager is `DelegationHost`.
 */
export class DelegationFlow {
  /** start_agent and its requests (start-agent-flow.ts, #850) */
  readonly starts: AgentStartFlow

  constructor(private readonly host: DelegationHost) {
    this.starts = new AgentStartFlow(host, this)
  }

  /**
   * Reads each turn's answer on its own (#428), from the session's record as it is when the reader is made: queued turns
   * have no new stored user row (their input was recorded before the previous answer), so each read starts after the
   * last one
   */
  private answerReader(sessionId: string): () => string {
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
      // A swap's failed waits are not the turn's end: the next host keeps the link while the kept turn runs
      // The delegation's owner now: a handoff may have moved it (#693)
      if (!joinedTurn && !this.host.handingOver) this.host.children.releaseTurn(sessionId, d.callerId)
      // Queued notes can finish after the original turn. Report only the whole delegation's ending.
      /*
       * A turn that completed was reported by `onEvent` as it ended, unless notes held it (`tracksInputs`): judged
       * again here, a microtask later, a pause over its own background work (#721) could read as the end once that
       * work has ended. A wait failed with no ending event (a stop, a cancel) is reported only here.
       */
      if ((agent && !r.ok) || wait.tracksInputs) void this.host.reportBackIfAwaited(sessionId, r.ok
        ? { type: 'turn_complete', sessionId }
        : { type: 'error', sessionId, error: { code: 'internal', message: r.error, retryable: false } }, r.ok ? r.answer : undefined)
    })
    this.host.agentRuns.set(sessionId, wait)
    this.host.children.setDelegation(key, d)
    return d
  }

  /**
   * Read an existing turn without claiming it in delegations, agentRuns or the caller's sleep graph. With `own`, a
   * fresh reader even while another caller's wait is active: a note's receipt is held on it, never on that wait (#646).
   */
  private observeTurn(child: SessionInfo, subscribe: boolean, own = false): { run: Delegation; release(): void } {
    const active = own ? undefined : this.host.agentRuns.get(child.id)
    const shared = active && !active.finished ? active : undefined
    /*
     * A note's reader reads each turn's answer on its own, as a delegation does: it is made before its note goes in. An
     * observer is made in the middle of a turn whose start it never saw, so the rows already written may be this turn's
     * answer: it reads the turn's answer as the record ends
     */
    const wait = shared ?? new AgentRunWait(() => {}, () => child.name, undefined, own
      ? this.answerReader(child.id)
      : () => turnAnswer(this.host.store.messages.loadMessages(child.id, 50)))
    const project = this.host.store.projects.listProjects().find((p) => p.id === child.projectId)
    const target = { id: child.projectId ?? '', name: project?.name ?? '', path: this.host.store.sessions.sessionCwd(child.id) ?? project?.path ?? '' }
    if (!shared && subscribe) {
      const readers = this.host.turnObservers.get(child.id) ?? new Set<AgentRunWait>()
      readers.add(wait)
      this.host.turnObservers.set(child.id, readers)
    }
    return {
      run: {
        // This is the target's own turn, never work owned by its observer.
        callerId: child.id, sessionId: child.id,
        target,
        wait, get settled() { return wait.finished }, notice: () => undefined,
        outcome: wait.done.then((r) => ({ ok: true as const, answer: r.answer }),
          (e: Error) => ({ ok: false as const, error: e.message })),
        stop: (why) => {
          // Only an explicit stop of the target may interrupt it or fail an app's watcher.
          if (wait.finished) return
          wait.fail(new Error(`${why}, so the turn was stopped`))
          this.host.handles.get(child.id)?.interrupt()
        },
      },
      release: () => {
        if (shared) return
        const readers = this.host.turnObservers.get(child.id)
        readers?.delete(wait)
        if (readers?.size === 0) this.host.turnObservers.delete(child.id)
      },
    }
  }

  /**
   * agent_session list (#690): the sessions this caller started that are still here, oldest first. On 2026-10-14 a
   * parent used fourteen children's answers and deleted none of them until the person said it could: deleting was a
   * call away, but nothing showed it what was left. Only its own children (`askedBy`), in its own project, as the
   * other actions take them; a session another started is not its to delete.
   */
  listAgents(callerId: string): AgentListRow[] {
    return ownAgents(this.host, callerId).map((s) => {
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
    // Work a handoff gave away (#693): the original that stayed is told where it went
    const gone = this.handedOverAnswer(callerId, opts.sessionId)
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
    if (opts.sessionId === callerId) return this.agentAtRest(child)
    if (opts.action === 'answer') return this.host.answerRoutedCard(callerId, child.id, opts.card, opts.text ?? '')
    const key = `${callerId}>${child.id}`
    // An observer that sent a note reads its own note's reader, never the owner's delegation (#646)
    const note = this.host.children.delegations.has(key) ? undefined : this.host.children.observerNotes.get(key)
    if (note && (opts.action === 'status' || opts.action === 'wait')) return this.readObserverNote(key, note, opts.action === 'wait', signal)
    let d = this.host.children.delegations.get(key)
    let releaseObservation: (() => void) | undefined
    if (!d && this.host.autoBoundaryOpen(callerId)) {
      const existing = [...this.host.children.delegations.values()].find((run) => run.sessionId === child.id && !run.settled)
      if (existing) d = existing
      else if (opts.action !== 'delete' && inTurn(child.state)) {
        const observation = this.observeTurn(child, opts.action !== 'status')
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
          if (d && cards.length) return this.agentAsking(d, cards)
          if (d && !d.settled) return this.agentWorking(d, false, observing)
          return d ? await this.awaitAgent(key, d, signal, observing) : this.agentAtRest(child, callerId)
        }
        case 'wait':
          return d ? await this.awaitAgent(key, d, signal, observing) : this.agentAtRest(child, callerId)
        case 'stop': {
          // A queued request is withdrawn before it is delivered (#677)
          if ((!d || d.settled) && this.host.children.dropQueued((r) => r.sessionId === child.id && r.callerSessionId === callerId && this.host.children.delivering.get(child.id) !== r.id).length) {
            return { ok: true, state: 'stopped', sessionId: child.id, sessionName: child.name, tool: child.tool }
          }
          // A report paused over its own background work (#721): stop ends that wait
          if ((!d || d.settled) && !observing && this.host.children.pausedReports.has(child.id) && this.host.children.awaitingReport.get(child.id) === callerId) {
            return this.stopPausedWork(child)
          }
          // Its turn over, only its own background work left (#718): that is what is running, and what delete waits on
          const resting = (!d || d.settled) && !observing ? this.restingWork(child, callerId) : []
          if (resting.length) return this.stopOwnWork(child, resting, false)
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
            // Use the sidebar's stop/flush/trash path, including pending waits and wake withdrawal.
            await this.host.trashSession(child.id)
            if (d) this.host.children.dropDelegation(key, d)
            return { ok: true, state: 'deleted', sessionId: child.id, sessionName: child.name, tool: child.tool }
          }
          if (d && !d.settled) return { ok: false, error: `"${child.name}" is still working on what you gave it — stop it or wait first.` }
          // A timer the tool held (`/loop`) does not hold the cleanup (#718): it ends with the process, and the caller is told
          const timers = this.host.handles.has(child.id) ? liveBackgroundTasks(child.backgroundTasks).filter((t) => t.timer) : []
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
              const f = await this.forkFor(callerId, child, opts.text ?? '', opts.ifBusy === 'fork_read', 'agent_session', signal)
              if (!f.ok) return f
              if ('queued' in f) return { ok: true, tool: child.tool, ...f.queued }
              const r = await this.awaitAgent(f.key, f.d, signal)
              return r.ok ? { ...r, via: 'fork', forkedFrom: child.id } : r
            }
            const note = this.host.busyChoices(callerId, child, 'agent_session').find((c) => c.choice === 'note')!
            if (!note.available || !d || d.settled) return { ok: false, error: `No note to "${child.name}": ${note.why ?? 'nothing is running there to add it to'}. Queue it or fork it instead.` }
            this.host.autoBoundaryOpen(callerId, 'a note into a turn that is not its own')
          }
          if (d && !d.settled) {
            const text = agentNoteFrame(from.name, opts.text ?? '')
            if (!this.host.adapters.get(child.tool)?.capabilities.midTurnInput || !this.host.handles.get(child.id)?.sendTracked) {
              return { ok: false, error: `"${child.name}" cannot take messages while working. Wait for it (action "wait") or stop it first.` }
            }
            /*
             * An observer's note rides on a wait of its own (#646). Holding, resolving or failing the owner's wait
             * would hand the owner the reply to this note instead of its answer, or fail its whole delegation when
             * the note is refused; the owner's wait is never touched from here.
             */
            const own = observing ? this.observeTurn(child, true, true) : undefined
            if (own) void own.run.wait.done.then(own.release, own.release)
            const record = own ? { run: own.run, waiters: 0, told: false } : undefined
            if (record) this.host.children.setObserverNote(key, record)
            const wait = own?.run.wait ?? d.wait
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
                    void this.tellNoteRefused(callerId, child.id, e.message)
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
            // Keep the same outcome and any active wait. A send must not re-arm a report on top of that wait.
            const working = this.agentWorking(d, false, observing)
            return working.ok && observing ? { ...working, via: 'note' } : working
          }
          if (inTurn(child.state) || (this.host.agentRuns.has(child.id) && !this.host.agentRuns.get(child.id)!.finished)) {
            return { ok: false, error: `"${child.name}" is busy with something else (the person may be using it). Try again later.` }
          }
          // An answer the caller never came back for gives way to the new message
          if (d) this.host.children.dropDelegation(key)
          const full = this.starts.agentCeilingError(callerId, child.projectId ?? '')
          if (full) return { ok: false, error: full }
          const project = this.host.store.projects.listProjects().find((p) => p.id === child.projectId)
          const cwd = this.host.store.sessions.sessionCwd(child.id) ?? child.worktree?.path ?? project?.path ?? ''
          const next = this.startDelegation(key, callerId, child.id, { id: child.projectId ?? '', name: project?.name ?? '', path: cwd }, true)
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
          return this.awaitAgent(key, next, signal)
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
        this.starts.withdrawAgentStart(id, 'The session that asked withdrew the request.', agentStartPersonText(rec.req, 'stopped'))
        return { ok: true, state: 'stopped', sessionId: id, sessionName: '', tool: rec.req.detail.tool }
      }
      if (action === 'send') {
        const on = rec.lowMemory ? 'memory to start' : "the person's answer"
        return { ok: false, error: `No session yet: request ${id} is still waiting for ${on}. Send once it has started.` }
      }
      if (action === 'wait') {
        const owner = rec.req.callerId
        const leaving = this.untilHandedOver(rec)
        const r = await raceBound(Promise.race([leaving.gone, rec.done]), ASK_WAIT_MS, signal)
        leaving.done()
        // A handoff gave the request to the session that took over (#693)
        if (r === 'handedOver') return this.handedOverReply(owner, id)
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

  /**
   * "Working": the caller is told when the turn ends (#561), through the report the orchestrator's reportBack uses, unless
   * a call is waiting on it by then (`awaitAgent` takes the marker down while it waits)
   */
  agentWorking(d: Delegation, arm = true, observing = false): ChildRunResult {
    if (arm && !observing) this.host.children.markReport(d.sessionId, d.callerId)
    const notice = d.notice()
    return {
      ok: true,
      state: 'working',
      sessionId: d.sessionId,
      sessionName: this.host.meta.get(d.sessionId)?.name ?? d.sessionId,
      tool: this.host.meta.get(d.sessionId)?.tool ?? '',
      reported: !observing && this.host.children.awaitingReport.get(d.sessionId) === d.callerId,
      ...(notice ? { notice } : {}),
    }
  }

  /** An observer's `status` / `wait` on the note it sent (#646): its own reader's outcome, taken once it has settled */
  private async readObserverNote(key: string, note: { run: Delegation; waiters: number; told: boolean }, wait: boolean, signal?: AbortSignal): Promise<ChildRunResult> {
    if (!wait && !note.run.settled) return this.agentWorking(note.run, false, true)
    note.waiters++
    let r: ChildRunResult
    try {
      r = await this.awaitAgent(key, note.run, signal, true)
    } finally {
      note.waiters--
    }
    if (note.run.settled) {
      note.told = true
      this.host.children.dropObserverNote(key, note)
    }
    return r
  }

  /** The observer's note was refused after its send returned (#646): said in the observer's session, as a report is */
  private async tellNoteRefused(observerId: string, sessionId: string, why: string): Promise<void> {
    const name = this.host.nameOf(sessionId)
    await this.host.tellSession(
      observerId,
      `[Centralu] Your note to another session was not delivered.\n` +
        `Session: ${frameField(name)}\n` +
        `id: ${sessionId}\n\n` +
        `Reason: ${why.slice(0, 600)}\n\n` +
        `Send it again with agent_session, or read that session's recent conversation with read_session.`,
      { sessionId, name },
      true,
    )
  }

  /** The owner's view of its delegated turn waiting on cards (#676), for start_agent and agent_session */
  private agentAsking(d: Delegation, cards: RoutedCard[]): ChildRunResult {
    // Told when it ends, as a wait past its bound is: the answer to the card lets the turn go on without this call
    this.host.children.markReport(d.sessionId, d.callerId)
    return { ok: true, state: 'asking', sessionId: d.sessionId, sessionName: this.host.meta.get(d.sessionId)?.name ?? d.sessionId, tool: this.host.meta.get(d.sessionId)?.tool ?? '', cards }
  }

  // ── Requests to a busy session (#677) ────────────────────────────────────────────────────────────────────────

  /**
   * start_agent's rules for a fork (#677): it starts an agent, so it takes the same gates. The agent depth, the project's
   * trust and the per-project ceiling here; the person's consent when the fork is made (`ensureAgentConsent`).
   */
  forkGateError(callerId: string, target: SessionInfo): string | null {
    return this.forkTrustError(callerId, target) ?? this.starts.agentCeilingError(callerId, target.projectId ?? '')
  }

  /** `forkGateError` without the ceiling: read before the card and again once it is answered (`forkFor`) */
  private forkTrustError(callerId: string, target: SessionInfo): string | null {
    const caller = this.host.meta.get(callerId)
    if (!caller) return 'the requesting session is gone'
    if (!this.host.meta.has(target.id)) return 'it is no longer here'
    const deep = agentDepthRefusal(this.host, callerId, 'start a sub-session')
    // Worded for "No fork of …: <why>."
    if (deep) return deep.replace(/^This/, 'this').replace(/\.$/, '')
    // A session with no project (the orchestrator's child, #853) has no repository to fork from (#994 review)
    if (!target.projectId) return 'it works outside any project, so there is nothing to fork it from; send to it once its turn ends, or start a new session'
    const project = this.host.store.projects.listProjects().find((p) => p.id === target.projectId)
    if (!project) return 'its project is no longer registered'
    if (project.trusted !== true && !this.host.autoBoundaryOpen(callerId)) return "its project is not trusted (the person can trust it from the project menu)"
    return null
  }

  /**
   * A sub-session from a copy of a busy session's conversation (#677, `ifBusy: "fork"`), linked to the requester: its
   * turn is the requester's delegation (the report, and its cards, #676), and the sidebar hangs it under the session it
   * was copied from (`forkedFrom`). start_agent's gates (`forkGateError`, the consent card) and its preset rule: never
   * above the requester, and never above the session it copies. `readOnly` (`fork_read`) shares that session's folder
   * under at most `safe`, so two agents never write one folder; otherwise it gets a worktree of its own, branched from
   * that session's branch when it has one.
   */
  async forkFor(
    callerId: string,
    target: SessionInfo,
    text: string,
    readOnly: boolean,
    via: QueuedRequest['via'],
    signal?: AbortSignal,
  ): Promise<{ ok: false; error: string } | { ok: true; key: string; d: Delegation; fork: SessionInfo } | { ok: true; queued: Extract<BusyAnswer, { state: 'queued' }> }> {
    const fork = this.host.busyChoices(callerId, target, 'agent_session').find((c) => c.choice === 'fork')!
    if (!fork.available) return { ok: false, error: `No fork of "${target.name}": ${fork.why}.` }
    const caller = this.host.meta.get(callerId)!
    const adapter = this.host.adapters.get(target.tool)!
    const project = this.host.store.projects.listProjects().find((p) => p.id === target.projectId)!
    const PRESETS: PermissionPreset[] = ['safe', 'normal', 'auto']
    const lowest = (...ps: PermissionPreset[]) => PRESETS[Math.min(...ps.map((p) => PRESETS.indexOf(p)))]!
    const preset = lowest(caller.permissionPreset, target.permissionPreset, ...(readOnly ? ['safe' as const] : []))
    const worktree = readOnly ? null : await this.starts.agentWorktreeBranch(project, { task: text })
    if (worktree && 'error' in worktree) return { ok: false, error: `${worktree.error.replace('Start the agent without one.', 'Use fork_read for read-only work, or queue it.')}` }
    const consent = await this.starts.ensureAgentConsent(
      callerId,
      {
        kind: 'agent_start',
        project: { id: project.id, name: project.name },
        tool: adapter.descriptor.label,
        ...(target.model ? { model: target.model } : {}),
        preset,
        ...(worktree ? { worktree: { branch: worktree.branch } } : {}),
        text: taskLine(`(a copy of "${target.name}") ${text}`),
      },
      signal,
    )
    // The card may have stood a while: the gates are read again, and their reason comes before the card's
    const refused = this.forkTrustError(callerId, target)
    if (refused) return { ok: false, error: `No fork of "${target.name}": ${refused}.` }
    if (!consent.ok) return consent
    // Counted and the place taken before the first wait, as for start_agent's child
    const place = this.starts.reservePlace(callerId, project.id)
    if ('error' in place) return { ok: false, error: place.error }
    try {
      /*
       * Memory (#686): no room for another agent now. The request is queued for the busy session instead (#677's queue,
       * `enqueue`), which starts no process: it goes in as a new turn there when the running one ends. Queued, not refused
       * (owner decision 2026-10-15); the requester reads that it was queued instead of forked, and why.
       */
      const short = await this.starts.memoryShort()
      if (short) {
        const low = this.starts.lowMemory(short)
        const queued = this.host.enqueue(callerId, target, via, text)
        return { ok: true, queued: { ...queued, lowMemory: `${low.available} free, ${low.floor} needed for a fork` } }
      }
      let forked: string
      try {
        forked = await adapter.forkConversation!(target.externalId ?? target.importedFrom!, this.host.cwdFor(target))
      } catch (e) {
        return { ok: false, error: `Could not copy "${target.name}"'s conversation: ${(e as Error).message}` }
      }
      let child: SessionInfo
      try {
        child = await this.host.createSession({
          projectId: project.id,
          cwd: readOnly ? this.host.cwdFor(target) : project.path,
          tool: target.tool,
          ...(target.model ? { model: target.model } : {}),
          ...(target.effort ? { effort: target.effort } : {}),
          // Never above either preset as they are when it starts, nor above the one the card showed
          permissionPreset: lowest(preset, this.host.meta.get(callerId)?.permissionPreset ?? 'safe', this.host.meta.get(target.id)?.permissionPreset ?? 'safe'),
          // A same-project ordinary session owns it as its agent; the orchestrator, which has no project, through the delegation alone
          ...(caller.projectId === project.id ? { askedBy: callerId } : {}),
          forkedFrom: target.id,
          resumeExternalId: forked,
          importHistory: true,
          ...(worktree ? { worktree: true, worktreeBranch: worktree.branch, ...(target.worktree ? { worktreeBase: target.worktree.branch } : {}) } : {}),
        })
      } catch (e) {
        return { ok: false, error: `Could not start the fork of "${target.name}": ${(e as Error).message}` }
      }
      // Its depth stays even when the requester is deleted later (#897 review)
      recordAgentDepth(this.host, child.id, callerId)
      // Copying and making the session took a while: the gates are read again, with no wait before the delegation
      const lateGate = this.forkTrustError(callerId, target)
      const cap = lateGate ? undefined : lowest(this.host.meta.get(callerId)!.permissionPreset, this.host.meta.get(target.id)!.permissionPreset)
      const late = lateGate
        ? `No fork of "${target.name}": ${lateGate}.`
        : cap && !presetWithin(child.permissionPreset, cap)
          ? `No fork of "${target.name}": a preset was lowered to ${cap} while the fork was being made.`
          : null
      if (late) return this.starts.abandonChild(child, late, worktree ? undefined : `Fork of ${target.name}`.slice(0, 48))
      if (!worktree) this.host.rename(child.id, `Fork of ${target.name}`.slice(0, 48))
      const key = `${callerId}>${child.id}`
      const d = this.startDelegation(key, callerId, child.id, { id: project.id, name: project.name, path: child.worktree?.path ?? this.host.cwdFor(child) }, true)
      // The delegation counts the fork now
      place.release()
      try {
        await this.host.deliver(child.id, agentFrame(labelOf(this.host.store.messages, caller), text), undefined, { sessionId: callerId, name: labelOf(this.host.store.messages, caller) }, false)
      } catch (e) {
        d.wait.fail(e as Error)
        this.host.children.dropDelegation(key, d)
        return { ok: false, error: `The fork "${child.name}" [${child.id}] was made but did not take the request: ${(e as Error).message}` }
      }
      return { ok: true, key, d, fork: child }
    } finally {
      place.release()
    }
  }

  /** A child with nothing of the caller's running: its last final answer (#561), and a report it still owes (#721) */
  private agentAtRest(child: SessionInfo, callerId?: string): ChildRunResult {
    const notice = callerId ? this.pausedNotice(child.id, callerId) : undefined
    return {
      ok: true,
      state: 'at_rest',
      sessionId: child.id,
      sessionName: child.name,
      tool: child.tool,
      answer: clipAnswer(turnAnswer(this.host.store.messages.loadMessages(child.id, 50)), child.name),
      sessionState: child.state,
      ...(child.interruption ? { interruption: child.interruption } : {}),
      ...(notice ? { notice } : {}),
      ...(callerId && cleanUpDue(child, callerId, notice) ? { cleanUp: true } : {}),
    }
  }

  /**
   * What the caller reads of a child whose report is held over its own background work (#721): the answer it has is
   * from a turn that paused, and the end is still to be told.
   */
  private pausedNotice(childId: string, callerId: string): string | undefined {
    if (!this.host.children.pausedReports.has(childId) || this.host.children.awaitingReport.get(childId) !== callerId) return undefined
    const running = this.host.ownTasksRunning(childId)
    if (!running.length) {
      return `The background work its turn ended with has ended (${taskList(this.host.pausedTasksNow(childId), true)}); a final report follows when a turn ends the work, or within a minute.`
    }
    return (
      `Its own background work is still running (${taskList(running)}). If that work is a server or watcher it leaves running, ` +
      'this answer may be its final one; a final report follows only if that work ends. ' +
      'agent_session(action="stop") on it stops that work and ends the wait.'
    )
  }

  /**
   * `agent_session stop` on a child whose report is paused over its own background work (#721): the caller is done
   * waiting. The tasks it paused on that still run are stopped where the tool can stop them one by one, and the report
   * is taken down; the turns their ending may start are the child's own. What could not be stopped is named.
   */
  private stopPausedWork(child: SessionInfo): Promise<ChildRunResult> {
    const held = new Set((this.host.children.pausedReports.get(child.id) ?? []).map((t) => t.id))
    const running = this.host.ownTasksRunning(child.id).filter((t) => held.has(t.id))
    this.host.children.clearReport(child.id)
    return this.stopOwnWork(child, running, true)
  }

  /**
   * Stops a child's own background work one task at a time, where the tool can (`stopBackgroundTask`), and names what
   * it could not stop. `paused`: the work a paused report waited on (#721), whose report is already down; otherwise
   * the work a child at rest still runs (#718), which keeps its worktree from being cleaned up.
   */
  private async stopOwnWork(child: SessionInfo, running: readonly BackgroundTask[], paused: boolean): Promise<ChildRunResult> {
    const stopped: BackgroundTask[] = []
    const left: BackgroundTask[] = []
    for (const t of running) {
      try {
        await this.host.stopBackgroundTask(child.id, t.id)
        stopped.push(t)
      } catch {
        left.push(t)
      }
    }
    const unstoppable = left.length ? `Not stoppable from here, still running: ${taskList(left)}; the person can stop it, or you can ask the child to stop it.` : ''
    // Nothing stopped and no wait ended: nothing was done (#718 review)
    if (!paused && !stopped.length) return { ok: false, error: `Nothing of "${child.name}" was stopped. ${unstoppable}` }
    /*
     * The tool reports a task's end after its stop returns (Claude's `background_tasks_changed` follows `stopTask`), so
     * a delete right after this would still see it running. The answer waits a moment for that end, and says so if it
     * did not come
     */
    const ids = new Set(stopped.map((t) => t.id))
    const stillListed = () => this.host.ownTasksRunning(child.id).filter((t) => ids.has(t.id))
    for (const until = Date.now() + STOP_REPORTED_MS; stillListed().length && Date.now() < until;) await new Promise((r) => setTimeout(r, 25))
    const unreported = stillListed()
    const notice = [
      stopped.length ? `Stopped its background work: ${taskList(stopped)}.` : 'None of the background work it paused on was still running.',
      unreported.length ? `Its tool has not reported the end of ${taskList(unreported)} yet; a delete waits for that.` : '',
      unstoppable,
      paused ? 'You will not be told more about this work.' : '',
    ].filter(Boolean).join(' ')
    return { ok: true, state: 'stopped', sessionId: child.id, sessionName: child.name, tool: child.tool, notice }
  }

  /**
   * The background work `stop` may end on a child at rest (#718): its own, when this caller started it, no turn and no
   * card stand there, nobody's delegation or wait is on it, and no report paused over that work is owed to another
   * session. A turn the person or another session gives it is theirs, and so is the work that turn starts while it
   * runs. Work an earlier, finished turn of the person's left running cannot be told apart from the caller's.
   */
  private restingWork(child: SessionInfo, callerId: string): BackgroundTask[] {
    if (child.askedBy !== callerId || inTurn(child.state) || child.pendingApproval || child.pendingQuestions.length) return []
    if ([...this.host.children.delegations.values()].some((r) => r.sessionId === child.id && !r.settled)) return []
    const run = this.host.agentRuns.get(child.id)
    if (run && !run.finished) return []
    const owed = this.host.children.awaitingReport.get(child.id)
    if (owed && owed !== callerId && this.host.children.pausedReports.has(child.id)) return []
    return this.host.ownTasksRunning(child.id)
  }

  /**
   * Waits on a delegation's turn up to the bound, the one wait ask_project (`AskProjectFlow.awaitDelegation`) and
   * start_agent / agent_session (`awaitAgent`) share (#428); each words the result for its caller. A card already
   * waiting on the caller comes first (#676), before and during the wait; a handoff that gives the delegation away ends
   * the wait (#693), the answer then the new owner's, never read twice. A cancelled call stops the turn (one that
   * joined the person's turn is only left) and lets the delegation go, only if it is still this one. The call counts
   * as waiting on it (`waiters`) until it has its result, the stop included.
   *
   * `observing`: an auto caller reading another caller's turn (#646): no cards, no handoff, no claim on the delegation,
   * and a cancelled call leaves the turn running.
   */
  async awaitTurn(key: string, d: Delegation, opts: { signal?: AbortSignal; boundMs?: number; observing?: boolean; stopWhy: string }): Promise<TurnWait> {
    const observing = opts.observing ?? false
    const standing = observing || d.settled ? [] : this.host.routedCards(d.sessionId, d.callerId)
    if (standing.length) return { kind: 'asking', cards: standing }
    const card = observing ? undefined : this.host.untilCard(d.sessionId, d.callerId)
    const owner = d.callerId
    const leaving = observing ? undefined : this.untilHandedOver(d)
    if (!observing) d.waiters = (d.waiters ?? 0) + 1
    try {
      // The owner's own cancellation (`waitCancelled`, a task that joined the person's turn) ends its wait, never an observer's
      const r = await raceBound(d.outcome, opts.boundMs ?? ASK_WAIT_MS, opts.signal, ...(d.waitCancelled && !observing ? [d.waitCancelled] : []), ...(card ? [card.asked] : []), ...(leaving ? [leaving.gone] : []))
      if (r === 'handedOver') return { kind: 'handedOver', owner }
      if (r === 'asked') {
        const cards = this.host.routedCards(d.sessionId, d.callerId)
        return cards.length ? { kind: 'asking', cards } : { kind: 'working' }
      }
      if (r === 'aborted') {
        if (observing) return { kind: 'cancelled' }
        d.stop(opts.stopWhy)
        if (!d.joinedTurn) await d.outcome
        this.host.children.dropDelegation(key, d)
        return { kind: 'cancelled' }
      }
      if (r === 'bound') return { kind: 'bound' }
      if (!observing) this.host.children.dropDelegation(key, d)
      if (!r.ok) return { kind: 'failed', error: r.error }
      return { kind: 'done', answer: r.answer ?? turnAnswer(this.host.store.messages.loadMessages(d.sessionId, 50)) }
    } finally {
      card?.done()
      leaving?.done()
      if (!observing) d.waiters = (d.waiters ?? 1) - 1
    }
  }

  /**
   * Paths an answer names under `root` become readable to the caller (ask_project's and a child's alike); the rest are
   * listed as outside. A child in another folder (a worktree, #561 part 2) is outside the caller's own
   */
  grantReads(callerId: string, answer: string, root: string): { granted: string[]; outside: string[] } {
    const { granted, outside } = readableGrants(pathsIn(answer), root)
    if (granted.length) {
      const set = this.host.readGrants.get(callerId) ?? new Set<string>()
      for (const g of granted) set.add(g)
      this.host.readGrants.set(callerId, set)
    }
    return { granted, outside }
  }

  /** Waits on a child's turn up to the bound (#561), as `awaitTurn` does, and reads its outcome for the caller */
  async awaitAgent(key: string, d: Delegation, signal?: AbortSignal, observing = false, boundMs = ASK_WAIT_MS): Promise<ChildRunResult> {
    // Only the owner consumes its report/key/grants. Auto observers have their own bound and cancellation.
    // A report held over the child's own background work (#721) is the work's end, still to come: reading the paused
    // turn's answer does not take it
    if (!observing && this.host.children.awaitingReport.get(d.sessionId) === d.callerId && !this.host.children.pausedReports.has(d.sessionId)) this.host.children.clearReport(d.sessionId)
    const endedBefore = d.settled
    const name = () => this.host.meta.get(d.sessionId)?.name ?? d.sessionId
    const r = await this.awaitTurn(key, d, { signal, boundMs, observing, stopWhy: 'the call that started it was cancelled' })
    switch (r.kind) {
      case 'handedOver':
        return this.handedOverReply(r.owner, d.sessionId)
      case 'asking':
        return this.agentAsking(d, r.cards)
      case 'working':
        return this.agentWorking(d)
      case 'cancelled':
        // A turn this call only joined is left running, as ask_project words it (no child's turn joins one today)
        return { ok: false, error: observing ? `The observation was cancelled; "${name()}" was left running.` : d.joinedTurn ? `The call was cancelled; "${name()}" was left running.` : `The call was cancelled, so "${name()}" was stopped.` }
      case 'bound':
        return this.agentWorking(d, !observing, observing)
      case 'failed':
        return { ok: false, error: `"${name()}" [${d.sessionId}] did not finish: ${r.error}. Tell the person, or give it a clearer task.` }
    }
    if (observing) return {
      ok: true, state: 'done', sessionId: d.sessionId, sessionName: name(),
      tool: this.host.meta.get(d.sessionId)?.tool ?? '', answer: clipAnswer(r.answer, name()), readable: [], outside: [],
    }
    const { granted, outside } = this.grantReads(d.callerId, r.answer, d.target.path)
    /*
     * The turn this call saw end left background work of the child's own running (#721): the caller reads the answer
     * now, and the report is held for the work's end, with no separate notice of the pause
     */
    const left = this.host.ownTasksRunning(d.sessionId)
    if (!endedBefore && !this.host.children.pausedReports.has(d.sessionId) && left.length) {
      this.host.children.markReport(d.sessionId, d.callerId)
      this.host.pauseReport(d.sessionId, left)
    }
    const notice = this.pausedNotice(d.sessionId, d.callerId)
    const child = this.host.meta.get(d.sessionId)
    return {
      ok: true,
      state: 'done',
      sessionId: d.sessionId,
      sessionName: name(),
      tool: this.host.meta.get(d.sessionId)?.tool ?? '',
      answer: clipAnswer(r.answer, name()),
      readable: granted,
      outside,
      ...(notice ? { notice } : {}),
      ...(child && cleanUpDue(child, d.callerId, notice) ? { cleanUp: true } : {}),
    }
  }

  /** Resolves `gone` when a handoff gives this delegation (or start request) to another session (#693); `done` lets go */
  untilHandedOver(d: { leaving?: Set<() => void> }): { gone: Promise<'handedOver'>; done(): void } {
    let leave!: () => void
    const gone = new Promise<'handedOver'>((resolve) => (leave = () => resolve('handedOver')))
    const set = (d.leaving ??= new Set())
    set.add(leave)
    return { gone, done: () => set.delete(leave) }
  }

  /**
   * What an original that stays after a handoff hears about work the handoff gave away (#693), or undefined: where it
   * went, so the original neither waits on it nor reads its answer a second time.
   */
  /**
   * `handedOverAnswer` for a wait a handoff ended: always an answer. The entry can be gone by the time the wait reads it
   * (#740 review): an original removed while waiting has its moves recorded, its waits woken, and its entries dropped
   * by the trash before the woken calls run.
   */
  handedOverReply(callerId: string, id: string): { ok: false; error: string } {
    return this.handedOverAnswer(callerId, id) ?? {
      ok: false,
      error: `[${id}] was handed to another session, which follows it now: this session no longer does, and nothing was stopped.`,
    }
  }

  handedOverAnswer(callerId: string, id: string): { ok: false; error: string } | undefined {
    const h = this.host.children.handedOver.get(id)
    if (!h || h.from !== callerId) return undefined
    const heir = this.host.meta.get(h.to)
    const what = this.host.meta.get(id)?.name ?? this.host.children.agentStarts.get(id)?.req.detail.text ?? id
    return {
      ok: false,
      error:
        `A handoff gave "${what}" [${id}] to the session that took over from this one, "${heir?.name ?? h.to}" [${h.to}]. ` +
        'It answers to that session now: this session no longer follows it, and nothing was stopped.',
    }
  }

}
