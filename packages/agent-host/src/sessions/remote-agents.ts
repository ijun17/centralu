import { randomUUID } from 'node:crypto'
import { gitRemoteKey, type ApprovalDetail, type BackgroundTask, type PermissionPreset, type SessionInfo, type SessionState } from '@cc/protocol'
import type { AgentListRow, AgentSessionOpts, ChildRunResult, LinkedProject, LinkedSessions, OrchestratedSession, RoutedCard, StartAgentOpts } from '../adapters/contract.js'
import { gitValidBranchName } from '../dev-services/git-worktree.js'
import { readJsonObjects } from '../dev-services/store/json.js'
import { inTurn } from '../idle.js'
import { agentDepthRefusal, depthOf } from './agent-depth.js'
import { ASK_WAIT_MS, clipAnswer, taskLine } from './ask-project.js'
import { answersFrom, cardCall, cardHandle, cardNotice } from './delegated-cards.js'
import type { DelegationHost } from './delegation-host.js'
import type { LinkedReport } from './child-ownership.js'
import type { LinkedEvent } from './linked-reports.js'
import { HUB_SENDER } from './hub-sender.js'
import { linkedTurnEnd } from './linked-turn-end.js'
import { agentBranch, agentChoice, agentName, agentNoteFrame, distinguishingText, givenAgentName, presetWithin, remoteAgentFrame } from './start-agent.js'
import { ASK_THE_PERSON, START_AGENT_CALL_MS, START_AGENT_SETUP_MS } from './start-agent-terms.js'
import { labelOf } from './transcript-view.js'
import { raceBound } from './with-timeout.js'

/**
 * A child start_agent started on a linked machine (#1038), as the hub keeps it: the machine's session (its qualified
 * id), the session that started it, and what the hub says of it when the machine cannot be asked. Kept in the store, so
 * agent_session still finds it after the hub restarts.
 */
export type RemoteAgent = {
  sessionId: string
  callerId: string
  machineId: string
  machine: string
  name: string
  tool: string
  /** The machine's project it works in, by its name there */
  project: string
  /** The branch of the worktree it was started in there, if one */
  worktree?: string
  startedAt: number
  /** The turn its caller last gave it (a start, a send at rest): its cards' handles name it, as a delegated turn's do (#676) */
  turn?: string
  /**
   * The end of the turn its caller gave it is owed to the caller (a call waits on it, or its report is armed), kept so a
   * restarted hub still reports it (`restore`); `paused`, the background work its report is held over there (#723)
   */
  owed?: { paused?: BackgroundTask[] }
  /** The last instruction the hub sent it, as the machine records it: a turn that took it is the caller's (#1038 review) */
  sent?: string
}

/** The record with nothing owed */
const withoutOwed = (r: RemoteAgent): RemoteAgent => {
  const { owed: _owed, ...rest } = r
  return rest
}

/** A machine's sentence to go inside another, without its own full stop */
const bare = (error: string): string => error.trim().replace(/\.+$/, '')

/**
 * A remote address as an answer may show it (#1038 review): the repository it names, never the address as written, which
 * can carry a user and a token (`https://user:ghp_…@github.com/…`). A local path is said to be one.
 */
const shownRemote = (url: string | null): string => (url === null ? 'no origin' : (gitRemoteKey(url) ?? 'a local path'))

/**
 * The most a child on another machine runs under (#1038 review, as create_session over a link, #838): `normal`. `auto`
 * there is the person's to give on that machine, never a caller's to carry across.
 */
const remotePreset = (caller: PermissionPreset): PermissionPreset => (presetWithin(caller, 'normal') ? caller : 'normal')

/** Where the hub keeps its children on linked machines: one app setting, so an older build leaves it alone */
export const REMOTE_AGENTS_KEY = 'remote_agents'

/**
 * What a child on a linked machine reaches of the session manager (#1038), typed as the manager declares each member.
 * The manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type RemoteAgentsHost = Pick<
  DelegationHost,
  'askHost' | 'autoBoundaryOpen' | 'children' | 'emit' | 'linkedReader' | 'meta' | 'store' | 'tellSession' | 'uiPreferences' | 'projectOrigin' | 'linkedTasksRunning' | 'settleLinkedTurn'
>

/**
 * The project's ceiling on agents working at once (`AgentStartGates`, reached through the start flow): a child on a
 * linked machine counts under its parent's project (#1038), and its start holds a place from its check, as a local one
 */
export type AgentPlaces = {
  agentCeilingError(callerId: string, projectId: string): string | null
  reservePlace(callerId: string, projectId: string): { release: () => void } | { error: string }
}

/** How a wait on a remote child's turn ended */
type Step = { step: 'completed' } | { step: 'failed'; error: string } | { step: 'deleted' } | { step: 'unreachable'; machine: string } | { step: 'asking' }

/** A call waiting on a remote child's turn: the turn's end as the machine's events tell it */
type TurnWait = { busy: boolean; done: Promise<Step>; end(step: Step): void }

/**
 * start_agent on a linked machine (#1038) and agent_session on what it starts there. The child is a session of the
 * machine's checkout of the caller's repository (the same `origin`, `gitRemoteKey`), made over the link under the
 * caller's preset and one level below it in the agent depth (`CreateSessionParams.agentDepth`), after a card that
 * names the machine. Its turn's end comes back as a linked machine's session's does for the orchestrator (`LinkedReports`,
 * #723), to the session that started it; a call waiting on it reads the answer instead, as a local child's wait does.
 * A link that drops is said to the parent, and a turn that ended while it was down is reported once it is back.
 */
export class RemoteAgents {
  private loaded: RemoteAgent[] | null = null
  private readonly waits = new Map<string, TurnWait>()
  /** Children whose parent was told their link dropped, until it is back */
  private readonly toldDown = new Set<string>()
  /** The cards of a caller's turn its caller was told of, once each (`<session>\0<turn>\0<request>`, #676) */
  private readonly toldCards = new Set<string>()
  /**
   * Children seen taking the instruction this hub last sent them (its `user_message`, from `HUB_SENDER`, with that text)
   * since anything of their turn may have been missed (#1038 review): only then is the turn running there the caller's
   * to read the cards of, answer and add a note to (`ownTurn`). Gone with the turn's end, a link drop and the host
   */
  private readonly instructed = new Set<string>()
  /** Children in a turn there, as their machine's events last said (`trackBusy`) */
  private readonly busy = new Set<string>()
  /** The last message number seen of each child there, so a link's replay of a message is not taken twice */
  private readonly lastSeq = new Map<string, number>()

  constructor(
    private readonly host: RemoteAgentsHost,
    private readonly places: AgentPlaces,
  ) {}

  /**
   * At startup (#1038): what was owed of each child when the last host stopped is owed again, to a caller still here. A
   * call that waited on it is gone with that host, so its end is the caller's report now. The hub has not seen the
   * turn's end, nor whether it ended: once the machine's link is up the child is read (`caughtUp`), and a turn that
   * ended meanwhile is reported then, one still running when it ends if it is the one its caller gave it. A report held
   * over the child's background work there waits for that work as before: the link's resync reads the work whole and
   * starts its settle wait (`LinkedReports.resync`). Not before (#1038 review): a link still connecting past the settle
   * wait would have settled every task as ended.
   */
  restore(): void {
    for (const r of this.records()) {
      if (!r.owed) continue
      if (!this.host.meta.has(r.callerId)) {
        this.save(this.records().map((x) => (x.sessionId === r.sessionId ? withoutOwed(x) : x)))
        continue
      }
      this.host.children.setLinkedReport(r.sessionId, { orchestratorId: r.callerId, busy: false, ...(r.owed.paused ? { paused: r.owed.paused } : {}) })
      if (!r.owed.paused) this.toldDown.add(r.sessionId)
    }
  }

  /** The hub's record of a child on a linked machine, by its qualified id */
  of(sessionId: string): RemoteAgent | undefined {
    return this.records().find((r) => r.sessionId === sessionId)
  }

  /**
   * The caller's children on linked machines, as agent_session list shows them (#690), each with its machine and the
   * state that machine reports (as last known when it cannot be asked). One gone from its machine, or whose machine was
   * removed, is dropped from the record here (#1038 review).
   */
  async rows(callerId: string): Promise<AgentListRow[]> {
    const mine = this.records().filter((r) => r.callerId === callerId)
    const reader = this.host.linkedReader
    if (!mine.length || !reader) return []
    const listed = await reader.list().catch(() => null)
    const out: AgentListRow[] = []
    for (const r of mine) {
      if (listed && this.gone(r, reader, listed)) {
        this.forget(r.sessionId)
        continue
      }
      const there = listed?.find((s) => s.sessionId === r.sessionId)
      const state: AgentListRow['state'] =
        there?.state === 'waiting_approval' || there?.state === 'waiting_question' ? 'waiting'
        : there ? (inTurn(there.state as SessionState) ? 'working' : 'finished')
        : this.waits.has(r.sessionId) || this.reportArmed(r) ? 'working' : 'finished'
      out.push({ sessionId: r.sessionId, name: r.name, tool: r.tool, state, asleep: false, machine: r.machine })
    }
    return out
  }

  /**
   * How many children the project's sessions started on linked machines are working now (#1038): the turn the caller
   * gave is running as far as the hub knows, a call waits on it or its report is owed. One whose turn ended with its
   * own background work still running there is not, as a local child whose turn ended is not (#721)
   */
  workingIn(projectId: string): number {
    const mine = this.records().filter((r) => this.host.meta.get(r.callerId)?.projectId === projectId)
    if (!mine.length) return 0
    const reader = this.host.linkedReader
    return mine.filter((r) => {
      // A removed machine's child is out of reach for good: no end of it will come to free the place (#1038 review)
      if (!reader?.machineLinked(r.machineId)) return false
      const report = this.host.children.linkedReports.get(r.sessionId)
      return this.waits.has(r.sessionId) || (report?.orchestratorId === r.callerId && !report.paused)
    }).length
  }

  /**
   * The caller is gone (trashed): its children's records go, and nothing is owed to it (#1038 review). Each stays on
   * its machine, and goes back to that machine's project in the sidebar
   */
  forgetCaller(callerId: string): void {
    for (const r of this.records().filter((x) => x.callerId === callerId)) {
      this.forget(r.sessionId)
      this.owned(r.sessionId, null)
    }
  }

  /** A handoff gave the original's work to `to` (#693): its children on linked machines are the heir's, report included */
  moveCaller(from: string, to: string): void {
    const moving = this.records().filter((r) => r.callerId === from)
    if (!moving.length) return
    this.save(this.records().map((r) => (r.callerId === from ? { ...r, callerId: to } : r)))
    for (const r of moving) this.owned(r.sessionId, to)
    for (const [id, report] of [...this.host.children.linkedReports]) {
      if (report.orchestratorId === from && this.of(id)) this.host.children.setLinkedReport(id, { ...report, orchestratorId: to })
    }
  }

  async startAgent(callerId: string, opts: StartAgentOpts & { machine: string }, signal?: AbortSignal): Promise<ChildRunResult> {
    const startedAt = Date.now()
    const caller = this.host.meta.get(callerId)
    if (!caller?.projectId) {
      return { ok: false, error: caller?.kind === 'orchestrator'
        ? 'The orchestrator starts a session on a linked machine with create_session; start_agent with a machine is for a project\'s session.'
        : 'This session belongs to no project, so it cannot start agents.' }
    }
    const refused = this.gateError(callerId)
    if (refused) return { ok: false, error: refused }
    const project = this.host.store.projects.listProjects().find((p) => p.id === caller.projectId)!
    // Counted under the caller's project, as a local child is (#1038); checked before anything is asked
    const full = this.places.agentCeilingError(callerId, project.id)
    if (full) return { ok: false, error: full }
    const reader = this.host.linkedReader
    if (!reader) return { ok: false, error: 'No machine is linked to this computer, so no session can be started on one. Start it here, without machine.' }
    const machine = reader.machineNamed(opts.machine)
    if (!machine) return { ok: false, error: `No linked machine is called "${opts.machine}". read_session lists the linked machines' sessions, each with its machine.` }
    const found = await this.checkoutOn(machine, project, reader)
    if ('error' in found) return { ok: false, error: found.error }
    const target = found.project
    const tool = opts.tool ?? target.defaultTool ?? caller.tool
    // The person's model for a difficulty is read here, as for a local child; the machine is not asked for its list
    const { model, effort, difficulty } = agentChoice(opts, undefined, this.host.uiPreferences().agentModels?.[tool])
    const given = givenAgentName(opts.name)
    const siblings = [...this.records().filter((r) => r.callerId === callerId).map((r) => r.name), ...[...this.host.meta.values()].filter((s) => s.askedBy === callerId).map((s) => s.name)]
    const basis = given ?? distinguishingText(opts.task, siblings)
    let branch: string | undefined
    if (opts.worktree || opts.branch) {
      const asked = opts.branch?.trim()
      if (asked && !(await gitValidBranchName(asked))) return { ok: false, error: `Not a valid branch name: ${asked}` }
      branch = asked || agentBranch(basis, randomUUID())
    }
    const name = given ?? (branch ? undefined : agentName(basis))
    const detail: Extract<ApprovalDetail, { kind: 'agent_start' }> = {
      kind: 'agent_start',
      project: { id: target.id, name: target.name },
      tool,
      ...(model ? { model } : {}),
      ...(difficulty ? { difficulty } : {}),
      preset: remotePreset(caller.permissionPreset),
      ...(branch ? { worktree: { branch } } : {}),
      text: taskLine(opts.task),
      ...(given ? { name: given } : {}),
      machine: machine.name,
    }
    // The card is bounded as a local start's setup is (#660): past it the card goes and nothing is made
    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) ctl.abort()
    const timer = setTimeout(() => ctl.abort(), START_AGENT_SETUP_MS)
    let decision: Awaited<ReturnType<RemoteAgentsHost['askHost']>>
    try {
      // Asked each time, `auto` included (#1038 review): the card says so, and nothing opens another computer unasked
      decision = await this.host.askHost(callerId, detail, ctl.signal, { alwaysAsk: true })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    // The card may have stood a while: what the start rests on in the caller is read again, and its reason comes first
    const after = this.gateError(callerId)
    if (after) return { ok: false, error: after }
    if (decision === 'deny') return { ok: false, error: `The person did not allow this session to start an agent on ${machine.name}. Do not start one again unless they tell you to. ${ASK_THE_PERSON}` }
    if (decision === null || ctl.signal.aborted) {
      return { ok: false, error: signal?.aborted ? 'The call was withdrawn before the session was created, so none was.' : `No session was created: the question to the person was withdrawn or not answered in time. ${ASK_THE_PERSON}` }
    }
    // A place is held from here until the child counts (its wait or report armed), so starts at once cannot pass the ceiling together
    const place = this.places.reservePlace(callerId, project.id)
    if ('error' in place) return { ok: false, error: place.error }
    try {
      return await this.makeChild(callerId, caller, opts, { machine, target, tool, name, model, effort, branch, startedAt }, reader, place.release, signal)
    } finally {
      place.release()
    }
  }

  /** The child made on the machine once allowed, its task sent, and its answer waited for (`startAgent`) */
  private async makeChild(
    callerId: string,
    caller: SessionInfo,
    opts: StartAgentOpts & { machine: string },
    c: { machine: { id: string; name: string }; target: LinkedProject; tool: string; name?: string; model?: string; effort?: string; branch?: string; startedAt: number },
    reader: LinkedSessions,
    counted: () => void,
    signal?: AbortSignal,
  ): Promise<ChildRunResult> {
    const { machine, target, tool, name, model, effort, branch, startedAt } = c
    const made = await reader.createSession(target, {
      tool: tool as never,
      ...(name ? { name } : {}),
      preset: remotePreset(caller.permissionPreset),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(branch ? { worktreeBranch: branch } : {}),
      agentDepth: depthOf(this.host, callerId) + 1,
    })
    if (!made.ok) return { ok: false, error: `Could not start ${tool} on ${machine.name}: ${bare(made.error)}. ${ASK_THE_PERSON}` }
    const label = labelOf(this.host.store.messages, caller)
    const task = remoteAgentFrame(label, opts.task)
    const rec: RemoteAgent = {
      sessionId: made.sessionId, callerId, machineId: machine.id, machine: machine.name, name: made.name, tool,
      project: target.name, ...(branch ? { worktree: branch } : {}), startedAt: Date.now(), sent: task, turn: randomUUID(),
    }
    this.save([...this.records(), rec])
    // Its row came to the windows before the hub knew whose it is: now it hangs under the caller (#1038)
    this.owned(rec.sessionId, callerId)
    /*
     * Set before the send, as the machine's first events can reach the hub before its answer does (#1038 review: a turn
     * that failed at once was reported, and the wait that came after it waited out its bound): the call's wait when it
     * waits, otherwise the report
     */
    const waiting = opts.wait === false ? undefined : this.openWait(rec.sessionId)
    if (!waiting) this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: callerId, busy: false })
    // It counts by itself now (`workingIn`)
    counted()
    // The machine counts the task's turn one level below the caller too, whatever it keeps of the session (#838)
    const sent = await reader.send(rec.sessionId, task, label, { depth: depthOf(this.host, callerId) + 1 })
    if (!sent.ok) {
      if (waiting && this.waits.get(rec.sessionId) === waiting) this.dropWait(rec.sessionId)
      if (this.host.children.linkedReports.get(rec.sessionId)?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
      return { ok: false, error: `The session "${rec.name}" [${rec.sessionId}] was made on ${machine.name} but did not take the task: ${bare(sent.error)}. Send it again with agent_session, or delete it.` }
    }
    const unchecked = [
      model || effort ? `${[model && `model "${model}"`, effort && `effort "${effort}"`].filter(Boolean).join(' and ')} not checked against ${machine.name}'s list` : '',
      // Not passed across (#1038 review): said, rather than dropped without a word
      opts.lsp ? `lsp is not passed to another machine: it starts as ${machine.name} starts a session` : '',
      caller.permissionPreset === 'auto' ? `it runs under normal on ${machine.name}: auto is not carried to another computer` : '',
    ].filter(Boolean).join('; ') || undefined
    const left = Math.max(1_000, START_AGENT_CALL_MS - (Date.now() - startedAt))
    // The wait opened before the send: a turn that ended inside the send has settled it already
    const result = waiting ? await this.awaitTurn(rec, signal, Math.min(ASK_WAIT_MS, left), waiting) : this.working(rec, true)
    return result.ok && unchecked ? { ...result, notice: [result.notice, unchecked].filter(Boolean).join('; ') } : result
  }

  /** agent_session on a child of a linked machine (#1038): status, wait, send, stop, delete, through the link */
  async agentSession(callerId: string, rec: RemoteAgent, opts: AgentSessionOpts, signal?: AbortSignal): Promise<ChildRunResult> {
    if (rec.callerId !== callerId) return { ok: false, error: `${rec.sessionId} is not a session this session started. agent_session works only on sessions start_agent started from here.` }
    const reader = this.host.linkedReader
    if (!reader) return { ok: false, error: `${rec.sessionId} is on ${rec.machine}, and no machine is linked to this computer now.` }
    const label = labelOf(this.host.store.messages, this.host.meta.get(callerId)!)
    const stateOf = async (): Promise<{ ok: true; state: SessionState } | { ok: false; error: string }> => {
      const r = await reader.read(rec.sessionId, 1)
      return r.ok ? { ok: true, state: (r.state ?? 'idle') as SessionState } : { ok: false, error: `${rec.machine} cannot be asked about "${rec.name}" now: ${r.error ?? 'no answer'}` }
    }
    switch (opts.action) {
      case 'answer':
        return this.answer(rec, opts.card, opts.text ?? '', reader)
      case 'status': {
        const now = await stateOf()
        if (!now.ok) return now
        if (inTurn(now.state) || this.waits.has(rec.sessionId)) {
          // The cards of the turn it gave are what the caller reads first, as for a local child (#676)
          const cards = this.ownTurn(rec) ? await this.cardsOf(rec, reader) : []
          return cards.length ? this.asking(rec, cards) : this.working(rec, this.reportArmed(rec))
        }
        return this.atRest(rec, now.state, reader)
      }
      case 'wait': {
        if (this.waits.has(rec.sessionId) || this.reportArmed(rec)) return this.awaitTurn(rec, signal, ASK_WAIT_MS)
        const now = await stateOf()
        if (!now.ok) return now
        return inTurn(now.state) ? this.awaitTurn(rec, signal, ASK_WAIT_MS) : this.atRest(rec, now.state, reader)
      }
      case 'send': {
        const text = opts.text?.trim()
        if (!text) return { ok: false, error: 'Give the text to send.' }
        const now = await stateOf()
        if (!now.ok) return now
        if (inTurn(now.state)) {
          /*
           * A note into the turn the caller gave it, as into a local child's (#646): the machine takes it into the
           * running turn as it takes the person's message there. Nothing is armed again: the turn's end is still the one
           * owed. Another's turn there (the person's on that machine) is not the caller's to add to, and neither a queue
           * nor a fork reaches another machine
           */
          if (!this.ownTurn(rec)) {
            return { ok: false, error: `"${rec.name}" is busy on ${rec.machine} with a turn you did not give it (the person may be using it there). A queue or a fork does not reach another machine: try again once it is at rest.` }
          }
          const refused = this.gateError(callerId)
          if (refused) return { ok: false, error: refused }
          // Kept before it goes, as the machine records it before it answers: its record tells the turn that took it
          const framed = agentNoteFrame(label, text)
          this.sentNow(rec.sessionId, framed)
          const sent = await reader.send(rec.sessionId, framed, label, { depth: depthOf(this.host, callerId) + 1 })
          if (!sent.ok) return { ok: false, error: `Could not send to "${rec.name}" on ${rec.machine}: ${bare(sent.error)}.` }
          // The machine recorded it before it answered: in a turn that is no longer the caller's, it was only a message there
          return this.instructed.has(rec.sessionId) ? this.working(rec, this.reportArmed(rec) || this.waits.has(rec.sessionId)) : this.wentElsewhere(rec)
        }
        const refused = this.gateError(callerId)
        if (refused) return { ok: false, error: refused }
        // New work counts under the caller's project as a local child's does (#1038); nothing is awaited up to the arming
        const full = this.places.agentCeilingError(callerId, this.host.meta.get(callerId)?.projectId ?? '')
        if (full) return { ok: false, error: full }
        // A new turn: its cards are new cards (#676). Read at rest just now, so no turn is running there as far as the hub knows
        const framed = agentNoteFrame(label, text)
        this.save(this.records().map((r) => (r.sessionId === rec.sessionId ? { ...r, turn: randomUUID(), sent: framed } : r)))
        this.busy.delete(rec.sessionId)
        this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: callerId, busy: false })
        const sent = await reader.send(rec.sessionId, framed, label, { depth: depthOf(this.host, callerId) + 1 })
        if (!sent.ok) {
          if (this.host.children.linkedReports.get(rec.sessionId)?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
          return { ok: false, error: `Could not send to "${rec.name}" on ${rec.machine}: ${bare(sent.error)}.` }
        }
        /*
         * The machine recorded it before it answered. Taken into a turn already running there (the person began one
         * after it was read at rest), it is a message in another's turn: nothing of that turn is the caller's (#1038 review)
         */
        if (!this.instructed.has(rec.sessionId)) {
          if (this.reportArmed(rec)) this.host.children.dropLinkedReport(rec.sessionId)
          return this.wentElsewhere(rec)
        }
        return this.working(rec, true)
      }
      case 'stop': {
        // Stopped by the one it would report to: nothing more is owed. Taken down first, as the stopped turn's end can
        // reach the hub before the machine's answer does; put back if the stop does not go
        const owed = this.host.children.linkedReports.get(rec.sessionId)
        if (owed?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
        const r = await reader.interrupt(rec.sessionId)
        if (!r.ok) {
          if (owed?.orchestratorId === callerId && !this.host.children.linkedReports.has(rec.sessionId)) this.host.children.setLinkedReport(rec.sessionId, owed)
          return { ok: false, error: `Could not stop "${rec.name}" on ${rec.machine}: ${bare(r.error)}.` }
        }
        return { ok: true, state: 'stopped', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool }
      }
      case 'delete': {
        // Gone already (#1038 review): deleted there, or its machine removed, while the hub could not see it
        const listed = await reader.list().catch(() => null)
        if (listed && this.gone(rec, reader, listed)) {
          this.forget(rec.sessionId)
          return {
            ok: true, state: 'deleted', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool,
            notice: reader.machineLinked(rec.machineId) ? `It was no longer on ${rec.machine}; nothing was left to delete.` : `${rec.machine} was removed from Centralu; the session is forgotten here.`,
          }
        }
        const now = await stateOf()
        if (!now.ok) return now
        if (inTurn(now.state)) {
          // Nothing is owed of a child being deleted, and its stopped turn's end may come in first; put back if the stop fails
          const owed = this.host.children.linkedReports.get(rec.sessionId)
          if (owed?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
          const stopped = await reader.interrupt(rec.sessionId)
          if (!stopped.ok) {
            if (owed?.orchestratorId === callerId && !this.host.children.linkedReports.has(rec.sessionId)) this.host.children.setLinkedReport(rec.sessionId, owed)
            return { ok: false, error: `Could not stop "${rec.name}" on ${rec.machine} before deleting it: ${bare(stopped.error)}.` }
          }
        }
        const r = await reader.deleteSession(rec.sessionId)
        if (!r.ok) return { ok: false, error: `Could not delete "${rec.name}" on ${rec.machine}: ${bare(r.error)}.` }
        this.forget(rec.sessionId)
        return {
          ok: true, state: 'deleted', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool,
          notice: `It went to ${rec.machine}'s trash${rec.worktree ? `; its worktree there, on ${rec.worktree}, stays until the person deletes it on that machine` : ''}.`,
        }
      }
    }
  }

  /**
   * A linked machine's event (`SessionManager.observeLinked`), read before the linked reports are: a call waiting on a
   * child's turn takes its end, so the report a waiting caller already read is not sent too.
   */
  observe(e: LinkedEvent): void {
    if (e.type === 'machine_status') return this.linkChanged(e.machine)
    if (e.type === 'machine_resync') return void this.caughtUp(e.machineId)
    if (typeof e.sessionId !== 'string') return
    const sessionId = e.sessionId
    const rec = this.of(sessionId)
    if (!rec) return
    if (e.type === 'user_message') this.messageTaken(rec, e)
    else this.trackBusy(sessionId, e)
    const wait = this.waits.get(sessionId)
    if ((e.type === 'approval_request' || e.type === 'question_request') && typeof e.requestId === 'string') {
      this.cardRaised(rec, e.type === 'approval_request' ? 'approval' : 'question', e.requestId, !!wait)
    }
    if (e.type === 'session_deleted') {
      this.forget(sessionId)
      wait?.end({ step: 'deleted' })
      return
    }
    if (!wait) return
    const step = linkedTurnEnd(wait.busy, e)
    if (step?.step === 'busy') {
      wait.busy = true
      // A card in the turn: the call waiting on it reads the card, as a local child's wait does (#676)
      // Left in place for the call, which arms the report before it takes the wait down (`rearm`): the turn is never
      // owed to nobody in between, so what tells it the caller's stays
      if (step.waits) wait.end({ step: 'asking' })
    } else if (step && step.step !== 'card_closed') {
      this.dropWait(sessionId)
      wait.end(step)
    }
  }

  /** What start_agent and a send rest on in the caller, read again after a card: here, in a trusted project, above the depth */
  private gateError(callerId: string): string | null {
    const caller = this.host.meta.get(callerId)
    if (!caller) return 'The session that asked is no longer here.'
    const project = this.host.store.projects.listProjects().find((p) => p.id === caller.projectId)
    if (!project) return 'This session\'s project is no longer registered.'
    if (project.trusted !== true && !this.host.autoBoundaryOpen(callerId, 'start in an untrusted project')) {
      return `This session's project is not trusted, so it cannot start agents — the person can trust it from the project menu. ${ASK_THE_PERSON}`
    }
    return agentDepthRefusal(this.host, callerId, 'start agents')
  }

  /** The machine's project that is a checkout of this project's repository: the same `origin`, read on both sides */
  private async checkoutOn(
    machine: { id: string; name: string },
    project: { id: string; name: string },
    reader: LinkedSessions,
  ): Promise<{ project: LinkedProject } | { error: string }> {
    const origin = await this.host.projectOrigin(project.id)
    const key = origin ? gitRemoteKey(origin) : null
    if (!origin || !key) {
      return { error: `This project has ${origin ? 'a local folder as its origin remote' : 'no origin remote'}, so no checkout of it on ${machine.name} can be told apart. Start the agent here, without machine.` }
    }
    const all = await reader.projects()
    const away = all.away.find((a) => a.machineId === machine.id)
    if (away) return { error: `${machine.name} cannot be reached (${away.why}), so nothing was started there. Try again once its link is back.` }
    const theirs = all.projects.filter((p) => p.machineId === machine.id)
    const read = await Promise.all(theirs.map(async (p) => ({ p, r: await reader.origin(p) })))
    // A build from before #1038 would not keep the child within the agent depth: a loop of starts between machines
    if (read.some(({ r }) => !r.ok && 'olderBuild' in r)) {
      return { error: `${machine.name} runs an older Centralu, which would not keep a session started from here within the agent depth, so nothing was started there. Update Centralu on ${machine.name}, then try again.` }
    }
    const same = read.filter(({ r }) => r.ok && r.origin && gitRemoteKey(r.origin) === key).map(({ p }) => p)
    const chosen = same.length === 1 ? same[0] : same.filter((p) => p.name === project.name).length === 1 ? same.find((p) => p.name === project.name) : undefined
    if (chosen) return { project: chosen }
    if (same.length) return { error: `${machine.name} has more than one checkout of ${key}: ${same.map((p) => `"${p.name}"`).join(', ')}, none named as this project is. Choosing among them is not available yet: the person can remove the extra one there.` }
    const listed = read.map(({ p, r }) => `"${p.name}" (${r.ok ? shownRemote(r.origin) : 'not read'})`).join(', ')
    return { error: `${machine.name} has no checkout of ${key}, so nothing was started there.${listed ? ` Its projects: ${listed}.` : ' It has no projects.'} The person can clone it there first.` }
  }

  /** Waits on the child's turn up to the bound; while it waits, the answer is the call's and no report is sent */
  private async awaitTurn(rec: RemoteAgent, signal: AbortSignal | undefined, boundMs: number, opened?: TurnWait): Promise<ChildRunResult> {
    const reader = this.host.linkedReader
    const wait = opened ?? this.waits.get(rec.sessionId) ?? this.openWait(rec.sessionId)
    // As a local child's wait takes its report down (#561): the call reads the answer, and it is put back if the call does not
    if (this.reportArmed(rec)) this.host.children.dropLinkedReport(rec.sessionId)
    const r = await raceBound(wait.done, boundMs, signal)
    // The report first, then the wait down: the turn goes on, owed all along
    const rearm = () => {
      this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: rec.callerId, busy: wait.busy })
      if (this.waits.get(rec.sessionId) === wait) this.dropWait(rec.sessionId)
    }
    if (r === 'bound') {
      rearm()
      return this.working(rec, true)
    }
    if (r === 'aborted') {
      rearm()
      return { ok: false, error: `The call was cancelled; "${rec.name}" was left running on ${rec.machine}.` }
    }
    if (r.step === 'unreachable') {
      rearm()
      return { ...this.working(rec, true), notice: `The link to ${r.machine} dropped while it worked, so it cannot be followed now. Its report comes once the link is back and its turn has ended.` }
    }
    if (r.step === 'asking') {
      // Its turn goes on: its end is owed again, and the cards are the answer now
      rearm()
      const cards = reader ? await this.cardsOf(rec, reader) : []
      return cards.length ? this.asking(rec, cards) : this.working(rec, true)
    }
    if (r.step === 'deleted') return { ok: false, error: `"${rec.name}" [${rec.sessionId}] was deleted on ${rec.machine} before it finished.` }
    if (r.step === 'failed') return { ok: false, error: `"${rec.name}" [${rec.sessionId}] on ${rec.machine} did not finish: ${r.error}. Tell the person, or give it a clearer task.` }
    const answer = clipAnswer(reader ? await reader.lastWords(rec.sessionId, 20_000).catch(() => '') : '', rec.name)
    // The turn left the child's own background work running there (#721): the report waits for that work's end
    const running: BackgroundTask[] = this.host.linkedTasksRunning(rec.sessionId)
    if (running.length) this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: rec.callerId, busy: false, paused: running })
    return {
      ok: true, state: 'done', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, answer, readable: [], outside: [],
      notice: `It works on ${rec.machine}: the paths it names are that machine's, not readable from here.${running.length ? ' Its own background work still runs there; a final report follows when that work ends.' : ''}`,
    }
  }

  /** A wait on the child's turn, which the machine's events end (`observe`); `busy` as far as the hub has seen */
  private openWait(sessionId: string): TurnWait {
    let end!: (step: Step) => void
    const done = new Promise<Step>((resolve) => (end = resolve))
    const wait = { busy: this.host.children.linkedReports.get(sessionId)?.busy ?? false, done, end }
    this.waits.set(sessionId, wait)
    this.keepOwed(sessionId)
    return wait
  }

  private dropWait(sessionId: string): void {
    this.waits.delete(sessionId)
    this.keepOwed(sessionId)
  }

  /** What is owed of the child now, kept in its record when it changed (#1038): a wait open, or its report armed */
  private keepOwed(sessionId: string): void {
    const rec = this.of(sessionId)
    if (!rec) return
    const report = this.host.children.linkedReports.get(sessionId)
    const armed = report?.orchestratorId === rec.callerId ? report : undefined
    const owed = this.waits.has(sessionId) || armed ? { ...(armed?.paused ? { paused: armed.paused } : {}) } : undefined
    // Nothing owed: the caller's turn is over, and what runs there next is not its own until it takes an instruction
    if (!owed) this.instructed.delete(sessionId)
    if (JSON.stringify(owed) === JSON.stringify(rec.owed)) return
    this.save(this.records().map((r) => (r.sessionId !== sessionId ? r : owed ? { ...r, owed } : withoutOwed(r))))
  }

  /**
   * The machine recorded the instruction this hub last sent the child (#1038 review): the turn that takes it is the
   * caller's. If nothing was owed of it any more, the turn the instruction was meant for ended before it went in (a
   * note sent as the turn ended), and the instruction starts a turn of its own: its end is owed as a start's or a send's
   * is, so the caller hears of it rather than the child working on unseen
   */
  private tookInstruction(rec: RemoteAgent): void {
    this.instructed.add(rec.sessionId)
    if (this.waits.has(rec.sessionId) || this.reportArmed(rec) || !this.host.meta.has(rec.callerId)) return
    this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: rec.callerId, busy: false })
  }

  /**
   * A message the child took there (#1038 review). The instruction this hub last sent it, from this link, is evidence
   * the turn that takes it is the caller's (`tookInstruction`), unless another turn was already running there when it
   * went in: then it is only a message in that turn (a send that raced the person's own message, a note that arrived
   * after the caller's turn had ended and the person's had begun), and the turn stays another's. Any other message (the
   * person's) means what runs there is not the caller's alone: the turn is not read as the caller's again until the
   * child takes an instruction from this hub. A report held over the caller's background work is then no longer the
   * caller's to finish: the turn that ends it would be the person's. A message seen already (a link's replay) is skipped
   */
  private messageTaken(rec: RemoteAgent, e: LinkedEvent): void {
    const sessionId = rec.sessionId
    if (typeof e.seq === 'number') {
      if (e.seq <= (this.lastSeq.get(sessionId) ?? -1)) return
      this.lastSeq.set(sessionId, e.seq)
    }
    if (this.fromHubHere(rec, e.from) && e.text === rec.sent) {
      if (!this.busy.has(sessionId) || this.instructed.has(sessionId)) this.tookInstruction(rec)
      return
    }
    this.instructed.delete(sessionId)
    const report = this.host.children.linkedReports.get(sessionId)
    if (report?.orchestratorId !== rec.callerId || !report.paused) return
    this.host.children.dropLinkedReport(sessionId)
    void this.host.tellSession(
      rec.callerId,
      `[Centralu] "${rec.name}" [${sessionId}] on ${rec.machine} took a message there that you did not send while the background work of your turn still ran ` +
        '(the person on that machine, most likely). What it does now is not yours, and nothing more of your work is reported. agent_session status reads where it stands.',
      { sessionId, name: rec.name },
      true,
    )
  }

  /** Whether the child is in a turn there, as the machine's events last said (#1038 review): an instruction taken in one is a message in it */
  private trackBusy(sessionId: string, e: LinkedEvent): void {
    const step = linkedTurnEnd(true, e)
    if (step?.step === 'busy') this.busy.add(sessionId)
    else if (step?.step === 'completed' || step?.step === 'failed' || step?.step === 'deleted') this.busy.delete(sessionId)
  }

  /** A send the machine took into a turn that is not the caller's: delivered, and followed no further */
  private wentElsewhere(rec: RemoteAgent): ChildRunResult {
    return {
      ...this.working(rec, false),
      notice: `It went in while a turn you did not give it was running on ${rec.machine} (the person's, most likely), as a message in that turn. Nothing of that turn is reported to you; send again once it is at rest.`,
    }
  }

  /**
   * Whether the child is no longer anywhere (#1038 review): its machine removed from Centralu, or the machine's sessions
   * (read now, or as last known when it cannot be asked) do not have it
   */
  private gone(rec: RemoteAgent, reader: LinkedSessions, listed: readonly OrchestratedSession[]): boolean {
    if (!reader.machineLinked(rec.machineId)) return true
    return !listed.some((s) => s.sessionId === rec.sessionId)
  }

  private working(rec: RemoteAgent, reported: boolean): Extract<ChildRunResult, { state: 'working' }> {
    return { ok: true, state: 'working', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, reported }
  }

  private async atRest(rec: RemoteAgent, state: SessionState, reader: LinkedSessions): Promise<ChildRunResult> {
    const answer = clipAnswer(await reader.lastWords(rec.sessionId, 20_000).catch(() => ''), rec.name)
    return { ok: true, state: 'at_rest', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, answer, sessionState: state }
  }

  /** Whether the turn running there is the one its caller gave: a call waits on it, or its end is owed to the caller */
  private ownTurn(rec: RemoteAgent): boolean {
    // A report held over the background work of a turn that ended is no turn of the caller's running (#1038 review)
    const report = this.host.children.linkedReports.get(rec.sessionId)
    const running = this.waits.has(rec.sessionId) || (report?.orchestratorId === rec.callerId && !report.paused)
    return running && this.instructed.has(rec.sessionId)
  }

  /**
   * The cards standing in the child's turn, as its caller reads them (#676): its questions, and its approval, which is
   * never the caller's to answer here (`answer`). Each named by a handle of the turn the caller gave it, the request and
   * what the card asks, so an answer meant for an earlier card finds nothing on a new one
   */
  private async cardsOf(rec: RemoteAgent, reader: LinkedSessions): Promise<RoutedCard[]> {
    const r = await reader.cards(rec.sessionId)
    if (!r.ok) return []
    const turn = this.of(rec.sessionId)?.turn ?? rec.sessionId
    const cards: RoutedCard[] = r.questions.map((q) => ({ card: cardHandle(turn, q.requestId, q.questions), requestId: q.requestId, kind: 'question' as const, questions: q.questions }))
    if (r.approval) cards.push({ card: cardHandle(turn, r.approval.requestId, r.approval.detail), requestId: r.approval.requestId, kind: 'approval', detail: r.approval.detail, answerable: false })
    return cards
  }

  private asking(rec: RemoteAgent, cards: RoutedCard[]): ChildRunResult {
    return { ok: true, state: 'asking', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, cards }
  }

  /**
   * agent_session answer on a child of a linked machine (#1038), as on a local child's delegated turn (#676): the caller
   * must still own the turn running there, and the card must still stand as it read it. A question takes its answer,
   * through the machine as its window would answer it. An approval stays the person's: the child runs under at most
   * `normal` there, and a caller's `auto` (which alone lets a caller answer a local child's approval) is never carried
   * to another computer, so what that computer runs is allowed there, by the person
   */
  private async answer(rec: RemoteAgent, card: string | undefined, text: string, reader: LinkedSessions): Promise<ChildRunResult> {
    if (!this.ownTurn(rec)) return { ok: false, error: `"${rec.name}" on ${rec.machine} is not running a turn you gave it, so none of its cards are yours to answer.` }
    const cards = await this.cardsOf(rec, reader)
    const chosen = card ? cards.find((c) => c.card === card) : undefined
    if (!chosen) {
      return {
        ok: false,
        error: !card
          ? cards.length ? `Name the card you read: ${cards.map((c) => c.card).join(', ')}.` : `"${rec.name}" has no card waiting.`
          : `Card ${card} no longer stands in "${rec.name}" as you read it: it was answered (the person may have answered first), withdrawn, or replaced by another card. ` +
            (cards.length ? `Read it again: ${cards.map((c) => c.card).join(', ')} stands now.` : 'Nothing is waiting now.'),
      }
    }
    if (chosen.kind === 'approval') {
      return { ok: false, error: `Only the person can answer this approval in "${rec.name}": it runs on ${rec.machine}, and your preset is not carried to another computer, so what runs there is allowed there. Tell them if it matters.` }
    }
    const answers = answersFrom(chosen.questions, text)
    if ('error' in answers) return { ok: false, error: answers.error }
    const r = await reader.answerQuestion(rec.sessionId, chosen.requestId, answers)
    if (!r.ok) return { ok: false, error: `The question was not answered: ${bare(r.error)}.` }
    return { ok: true, state: 'answered', card: chosen.card, sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool }
  }

  /**
   * A card came up in the child (#676): in the turn its caller gave it, the caller hears of it once, by the wait on that
   * turn when one stands (it returns the card), otherwise by a notice into its conversation, as a report is delivered
   */
  private cardRaised(rec: RemoteAgent, kind: 'question' | 'approval', requestId: string, waited: boolean): void {
    if (!this.ownTurn(rec) || !this.host.meta.has(rec.callerId)) return
    const key = `${rec.sessionId}\0${rec.turn ?? ''}\0${requestId}`
    if (this.toldCards.has(key)) return
    this.toldCards.add(key)
    if (waited) return
    void this.host.tellSession(rec.callerId, cardNotice(kind, rec.sessionId, cardCall('reader', rec.sessionId), false), { sessionId: rec.sessionId, name: rec.name }, true)
  }

  /** Whether the child's turn end is owed to the session that started it */
  private reportArmed(rec: RemoteAgent): boolean {
    return this.host.children.linkedReports.get(rec.sessionId)?.orchestratorId === rec.callerId
  }

  /**
   * A machine's link that is no longer connected: a call waiting on a child there returns now, and the session that
   * started a child still owed a report is told once that it cannot be followed until the link is back. A report paused
   * over the child's background work is the linked reports' to send (`LinkedReports.linkChanged`).
   */
  private linkChanged(machine: unknown): void {
    const m = machine as { id?: unknown; name?: unknown; status?: unknown } | null
    if (!m || typeof m.id !== 'string' || m.status === 'connected') return
    const name = typeof m.name === 'string' && m.name ? m.name : m.id
    for (const rec of this.records()) {
      if (rec.machineId !== m.id) continue
      // Whatever happens there while the link is down is unseen: the turn is the caller's again only on evidence
      this.instructed.delete(rec.sessionId)
      const wait = this.waits.get(rec.sessionId)
      if (wait) {
        this.dropWait(rec.sessionId)
        wait.end({ step: 'unreachable', machine: name })
        // The call said it; what ended while the link was down is reported once it is back, seen working or not (#1038 review)
        this.toldDown.add(rec.sessionId)
        continue
      }
      const report = this.host.children.linkedReports.get(rec.sessionId)
      if (!report || report.orchestratorId !== rec.callerId || report.paused || this.toldDown.has(rec.sessionId)) continue
      this.toldDown.add(rec.sessionId)
      void this.host.tellSession(
        rec.callerId,
        `[Centralu] The link to ${name} dropped while "${rec.name}" [${rec.sessionId}] was working there. It cannot be followed until the link is back: ` +
          'its report comes then, once its turn has ended. agent_session status reads it once the machine can be reached.',
        { sessionId: rec.sessionId, name: rec.name },
        true,
      )
    }
  }

  /**
   * A machine's link is up again: a child whose turn the hub was owed, and whose end it may have missed while the link
   * was down, is asked where it stands; out of its turn, its report goes now, as its end would have sent it.
   */
  private async caughtUp(machineId: unknown): Promise<void> {
    const reader = this.host.linkedReader
    if (!reader || typeof machineId !== 'string') return
    // Deleted there while the link was down, or the machine removed: nothing of it will come, so nothing is owed of it
    // and it holds no place under the ceiling (#1038 review). Read as `list` reads it; not at all if it cannot be read
    const mine = this.records().filter((r) => r.machineId === machineId)
    if (!mine.length) return
    const listed = await reader.list().catch(() => null)
    for (const rec of mine) {
      if (listed && this.gone(rec, reader, listed)) {
        this.forget(rec.sessionId)
        continue
      }
      const missed = this.toldDown.delete(rec.sessionId)
      const report = this.host.children.linkedReports.get(rec.sessionId)
      if (!report || report.orchestratorId !== rec.callerId || report.paused || (!report.busy && !missed)) continue
      const now = await reader.read(rec.sessionId, 1)
      if (!now.ok) continue
      await this.onReturn(rec, report, reader, inTurn((now.state ?? 'idle') as SessionState))
    }
  }

  /**
   * A child read when the link is back after the hub missed what happened (a drop, a restart), its report still owed
   * (#1038 review). What the hub saw last of it is the caller's turn; what ran there since is the caller's only if the
   * last message the child took is the instruction this hub sent it (`sent`, from this link's `HUB_SENDER`).
   *
   * - Running and the caller's: its end is the report's, however the machine says it.
   * - At rest and the caller's: that turn ended unseen, and is reported now with its answer.
   * - Otherwise someone else's message came after (the person's on that machine, most likely), or the instruction never
   *   went in (a restart between keeping it and sending it). What the caller gave the child ended or was set aside
   *   unseen; the caller is told so, with nothing of what the child said since, and nothing more is reported.
   *
   * Not read (the machine did not answer), it stays as it is until the link's next resync.
   */
  private async onReturn(rec: RemoteAgent, report: LinkedReport, reader: LinkedSessions, running: boolean): Promise<void> {
    const last = await reader.lastUserMessage(rec.sessionId)
    // Read again after asking: the turn's own end may have come in meanwhile
    if (!last.ok || this.host.children.linkedReports.get(rec.sessionId) !== report) return
    const sent = this.of(rec.sessionId)?.sent
    if (last.message && sent !== undefined && last.message.text === sent && this.fromHubHere(rec, last.message.from)) {
      if (running) {
        report.busy = true
        this.instructed.add(rec.sessionId)
      } else this.host.settleLinkedTurn(rec.sessionId)
      return
    }
    this.host.children.dropLinkedReport(rec.sessionId)
    const what = running
      ? 'began a turn there that you did not give it (the person on that machine, most likely)'
      : 'came to rest there while the hub could not see it, after a message that is not the one you gave it (the person\'s on that machine, most likely, or yours never went in)'
    void this.host.tellSession(
      rec.callerId,
      `[Centralu] While the link to ${rec.machine} was down, "${rec.name}" [${rec.sessionId}] ${what}. ` +
        'What you gave it ended or was set aside unseen, and nothing more of it is reported. ' +
        `agent_session status reads where it stands${running ? '; send to it once it is at rest' : ''}.`,
      { sessionId: rec.sessionId, name: rec.name },
      true,
    )
  }

  /**
   * Whether a message the child took was sent by this hub over this link (#1038 review): the machine records a hub's
   * instruction from `HUB_SENDER`, which reaches the hub qualified with that machine's id. Another machine's prefix is no
   * instruction of this link's. Two hubs linked to one machine record the same sender; the text (`sent`) tells them apart
   */
  private fromHubHere(rec: RemoteAgent, from: unknown): boolean {
    return (from as { sessionId?: unknown } | null)?.sessionId === `${rec.machineId}.${HUB_SENDER}`
  }

  /** The instruction the hub is about to send the child, kept so its turn can be told from another's (`onReturn`) */
  private sentNow(sessionId: string, text: string): void {
    this.save(this.records().map((r) => (r.sessionId === sessionId ? { ...r, sent: text } : r)))
  }

  /**
   * Tells the windows whose child a machine's session is now (#1038): the links name the parent in its rows from here
   * on (`LinkDeps.ownerOf`), and this moves a row the windows hold already. The machine knows no parent for it, and
   * none for its folder: a session start_agent made there is never a worktree manager's
   */
  private owned(sessionId: string, askedBy: string | null): void {
    this.host.emit({ type: 'session_owner', sessionId, askedBy, parentSessionId: null })
  }

  private records(): RemoteAgent[] {
    if (!this.loaded) {
      // Whatever arms, moves or drops a child's report, here or in the linked reports, is kept in its record. Hooked on
      // the first read (`restore` at startup does one), as nothing is armed for a child before its record is read
      this.host.children.onLinkedReportChange((sessionId) => this.keepOwed(sessionId))
    }
    this.loaded ??= readJsonObjects<RemoteAgent>(
      this.host.store.settings.appSetting(REMOTE_AGENTS_KEY),
      (x) => typeof x.sessionId === 'string' && typeof x.callerId === 'string' && typeof x.machineId === 'string',
    )
    return this.loaded
  }

  private save(list: RemoteAgent[]): void {
    this.loaded = list
    this.host.store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify(list))
  }

  /** The child is gone from the machine: its record and anything owed of it go */
  private forget(sessionId: string): void {
    if (this.records().some((r) => r.sessionId === sessionId)) this.save(this.records().filter((r) => r.sessionId !== sessionId))
    this.toldDown.delete(sessionId)
    this.instructed.delete(sessionId)
    this.busy.delete(sessionId)
    this.lastSeq.delete(sessionId)
    for (const key of [...this.toldCards]) if (key.startsWith(`${sessionId}\0`)) this.toldCards.delete(key)
    if (this.host.children.linkedReports.has(sessionId)) this.host.children.dropLinkedReport(sessionId)
  }
}
