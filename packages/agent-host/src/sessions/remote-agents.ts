import { randomUUID } from 'node:crypto'
import { gitRemoteKey, type ApprovalDetail, type BackgroundTask, type PermissionPreset, type SessionState } from '@cc/protocol'
import type { AgentListRow, AgentSessionOpts, ChildRunResult, LinkedProject, LinkedSessions, OrchestratedSession, StartAgentOpts } from '../adapters/contract.js'
import { gitValidBranchName } from '../dev-services/git-worktree.js'
import { readJsonObjects } from '../dev-services/store/json.js'
import { inTurn } from '../idle.js'
import { agentDepthRefusal, depthOf } from './agent-depth.js'
import { ASK_WAIT_MS, clipAnswer, taskLine } from './ask-project.js'
import type { DelegationHost } from './delegation-host.js'
import type { LinkedEvent } from './linked-reports.js'
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
  'askHost' | 'autoBoundaryOpen' | 'children' | 'linkedReader' | 'meta' | 'store' | 'tellSession' | 'uiPreferences' | 'projectOrigin' | 'linkedTasksRunning' | 'settleLinkedTurn'
>

/** How a wait on a remote child's turn ended */
type Step = { step: 'completed' } | { step: 'failed'; error: string } | { step: 'deleted' } | { step: 'unreachable'; machine: string }

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

  constructor(private readonly host: RemoteAgentsHost) {}

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

  /** The caller is gone (trashed): its children's records go, and nothing is owed to it (#1038 review) */
  forgetCaller(callerId: string): void {
    for (const r of this.records().filter((x) => x.callerId === callerId)) this.forget(r.sessionId)
  }

  /** A handoff gave the original's work to `to` (#693): its children on linked machines are the heir's, report included */
  moveCaller(from: string, to: string): void {
    if (!this.records().some((r) => r.callerId === from)) return
    this.save(this.records().map((r) => (r.callerId === from ? { ...r, callerId: to } : r)))
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
    const rec: RemoteAgent = {
      sessionId: made.sessionId, callerId, machineId: machine.id, machine: machine.name, name: made.name, tool,
      project: target.name, ...(branch ? { worktree: branch } : {}), startedAt: Date.now(),
    }
    this.save([...this.records(), rec])
    /*
     * Set before the send, as the machine's first events can reach the hub before its answer does (#1038 review: a turn
     * that failed at once was reported, and the wait that came after it waited out its bound): the call's wait when it
     * waits, otherwise the report
     */
    const waiting = opts.wait === false ? undefined : this.openWait(rec.sessionId)
    if (!waiting) this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: callerId, busy: false })
    const label = labelOf(this.host.store, caller)
    // The machine counts the task's turn one level below the caller too, whatever it keeps of the session (#838)
    const sent = await reader.send(rec.sessionId, remoteAgentFrame(label, opts.task), label, { depth: depthOf(this.host, callerId) + 1 })
    if (!sent.ok) {
      if (waiting && this.waits.get(rec.sessionId) === waiting) this.waits.delete(rec.sessionId)
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
    const label = labelOf(this.host.store, this.host.meta.get(callerId)!)
    const stateOf = async (): Promise<{ ok: true; state: SessionState } | { ok: false; error: string }> => {
      const r = await reader.read(rec.sessionId, 1)
      return r.ok ? { ok: true, state: (r.state ?? 'idle') as SessionState } : { ok: false, error: `${rec.machine} cannot be asked about "${rec.name}" now: ${r.error ?? 'no answer'}` }
    }
    switch (opts.action) {
      case 'answer':
        return { ok: false, error: `A card of "${rec.name}" on ${rec.machine} is answered there or in its own window; agent_session answer does not reach another machine yet.` }
      case 'status': {
        const now = await stateOf()
        if (!now.ok) return now
        if (inTurn(now.state) || this.waits.has(rec.sessionId)) return this.working(rec, this.reportArmed(rec))
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
        if (inTurn(now.state)) return { ok: false, error: `"${rec.name}" is working on ${rec.machine} (${now.state}). A note into a running turn does not reach another machine yet: wait for it, or stop it, then send.` }
        const refused = this.gateError(callerId)
        if (refused) return { ok: false, error: refused }
        this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: callerId, busy: false })
        const sent = await reader.send(rec.sessionId, agentNoteFrame(label, text), label, { depth: depthOf(this.host, callerId) + 1 })
        if (!sent.ok) {
          if (this.host.children.linkedReports.get(rec.sessionId)?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
          return { ok: false, error: `Could not send to "${rec.name}" on ${rec.machine}: ${bare(sent.error)}.` }
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
    if (!this.of(sessionId)) return
    const wait = this.waits.get(sessionId)
    if (e.type === 'session_deleted') {
      this.forget(sessionId)
      wait?.end({ step: 'deleted' })
      return
    }
    if (!wait) return
    const step = linkedTurnEnd(wait.busy, e)
    if (step?.step === 'busy') wait.busy = true
    else if (step && step.step !== 'card_closed') {
      this.waits.delete(sessionId)
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
    const rearm = () => {
      if (this.waits.get(rec.sessionId) === wait) this.waits.delete(rec.sessionId)
      this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: rec.callerId, busy: wait.busy })
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
    return wait
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
      const wait = this.waits.get(rec.sessionId)
      if (wait) {
        this.waits.delete(rec.sessionId)
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
    for (const rec of this.records()) {
      if (rec.machineId !== machineId) continue
      const missed = this.toldDown.delete(rec.sessionId)
      const report = this.host.children.linkedReports.get(rec.sessionId)
      if (!report || report.orchestratorId !== rec.callerId || report.paused || (!report.busy && !missed)) continue
      const now = await reader.read(rec.sessionId, 1)
      if (!now.ok || inTurn((now.state ?? 'idle') as SessionState)) continue
      // Read again: the turn's own end may have come in while the machine was asked
      if (this.host.children.linkedReports.get(rec.sessionId) === report) this.host.settleLinkedTurn(rec.sessionId)
    }
  }

  private records(): RemoteAgent[] {
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
    if (this.host.children.linkedReports.has(sessionId)) this.host.children.dropLinkedReport(sessionId)
  }
}
