import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { AgentStartRequest, Delegation } from './child-ownership.js'
import { ASK_WAIT_MS, taskLine } from './ask-project.js'
import { agentChoice, agentFrame, agentName, distinguishingText, givenAgentName, presetWithin } from './start-agent.js'
import { labelOf } from './transcript-view.js'
import { agentDepthRefusal, recordAgentDepth } from './agent-depth.js'
import type {
  ApprovalDetail,
  PermissionPreset,
  SessionInfo,
} from '@cc/protocol'
import type { ChildRunResult, StartAgentOpts } from '../adapters/contract.js'
import type { DelegationHost } from './delegation-host.js'
import { newOrchestratorAgentFolder } from './orchestrator-home.js'
import { AgentStartGates } from './agent-start-gates.js'
import { AgentConsents } from './agent-consents.js'
import { AgentChoices } from './agent-choices.js'
import { AgentStartRequests } from './agent-start-requests.js'
import type { RemoteAgents } from './remote-agents.js'
import {
  ASK_THE_PERSON,
  ORCHESTRATOR_PLACE,
  START_AGENT_CALL_MS,
  START_AGENT_SETUP_MS,
  agentStartPending,
  agentStartPersonText,
  orchestratorPlace,
  type StartProgress,
} from './start-agent-terms.js'

// Moved to the terms start_agent's modules share (#428); still importable from here
export { ASK_THE_PERSON, ORCHESTRATOR_PLACE, START_AGENT_CALL_MS, START_AGENT_MODEL_CHECK_MS, START_AGENT_SETUP_MS, agentStartPending, agentStartPersonText } from './start-agent-terms.js'

/** The answer when start_agent's setup outlasts its bound: it states whether a session exists, and what to do next */
function startAgentLate(progress: StartProgress): ChildRunResult {
  const seconds = Math.round(START_AGENT_SETUP_MS / 1000)
  const note = progress.unchecked ? ` (${progress.unchecked}.)` : ''
  switch (progress.stage) {
    case 'created':
      return {
        ok: false,
        error:
          `The session [${progress.childId}] was created, but handing it the task took longer than ${seconds} seconds. ` +
          `Do not start another: agent_session(sessionId="${progress.childId}", action="status") shows where it stands. ${ASK_THE_PERSON}${note}`,
      }
    case 'creating':
      return {
        ok: false,
        error:
          `Starting the session took longer than ${seconds} seconds and had not finished, so a session may or may not exist. ` +
          `Do not call start_agent again until read_session (without a sessionId) shows whether a new session is there; if one starts, you will be told when it ends. ${ASK_THE_PERSON}${note}`,
      }
    case 'asking':
      return {
        ok: false,
        error:
          `No session was created: the person did not answer the question in this session within ${seconds} seconds, so it was withdrawn. ${ASK_THE_PERSON}`,
      }
    default:
      return { ok: false, error: `No session was created: checking the request took longer than ${seconds} seconds. Try again once; if it repeats, ask the person. ${ASK_THE_PERSON}` }
  }
}

/** What start_agent reaches of the rest of the delegation flow (`DelegationFlow`): the child's run, its wait, its answers */
export type StartAgentDelegations = {
  startDelegation(key: string, callerId: string, sessionId: string, target: { id: string; name: string; path: string }, agent?: boolean, joinedTurn?: boolean): Delegation
  agentWorking(d: Delegation, arm?: boolean, observing?: boolean): ChildRunResult
  awaitAgent(key: string, d: Delegation, signal?: AbortSignal, observing?: boolean, boundMs?: number): Promise<ChildRunResult>
  handedOverAnswer(callerId: string, id: string): { ok: false; error: string } | undefined
  /** start_agent on a linked machine (#1038) */
  readonly remote: Pick<RemoteAgents, 'startAgent' | 'workingIn'>
}

/**
 * start_agent (#561) and its requests (#673, #686): the setup, the person's consent, the per-project ceiling, the
 * request a card or low memory keeps standing, and the child's start. Moved out of `DelegationFlow` as it was (#850);
 * what it reaches of the rest of the flow is `StartAgentDelegations`, of the manager `DelegationHost`.
 */
export class AgentStartFlow {
  /** Whether a session may start an agent now: its caller's standing and the ceiling (agent-start-gates.ts) */
  private readonly gates: AgentStartGates
  /** The person's consent for a session to start agents (agent-consents.ts) */
  private readonly consents: AgentConsents
  /** A child's worktree branch, and its model and effort checked (agent-choices.ts) */
  private readonly choices: AgentChoices
  /** start_agent requests that outlive their call: a card standing, or memory short (agent-start-requests.ts) */
  private readonly requests: AgentStartRequests

  constructor(
    private readonly host: DelegationHost,
    private readonly flow: StartAgentDelegations,
  ) {
    // Read when counted: the flow makes its children on linked machines after this
    this.gates = new AgentStartGates(host, (projectId) => flow.remote.workingIn(projectId))
    this.consents = new AgentConsents(host)
    this.choices = new AgentChoices(host)
    this.requests = new AgentStartRequests(host, flow, this)
  }

  /** `AgentConsents.agentConsents` (agent-consents.ts), kept on the flow for its callers */
  get agentConsents(): Set<string> {
    return this.consents.agentConsents
  }

  /**
   * start_agent (#561): an ordinary session starts another agent (Claude or Codex) in its own project on a task.
   *
   *   1. Who may: an ordinary session of a trusted project (the rule ask_project and attach_app follow, #382), and
   *      not one as deep below a session the person started as the agent depth allows (#867, `agentDepthRefusal`;
   *      1 by default, so only the person's own sessions start agents). No preset opens it, `auto` included.
   *   2. How many: at most `AGENT_CEILING` children run at once in a project, over all its sessions.
   *   3. The person's consent (`ensureAgentConsent`): the project's trust for a `normal` caller (#673); otherwise a
   *      card, answered once, always for this session, or always for this project.
   *   4. The child: a visible session in the caller's folder, marked `askedBy` the caller, on the tool, model and
   *      effort asked for (or the project's own, as a session the person opens there), under **the caller's own
   *      permission preset**: never more than the caller has, and nothing the caller can change afterwards.
   *   5. The task goes in a frame (`agentFrame`) recorded as sent by the caller, and the call waits on the turn the
   *      way ask_project does (`AgentRunWait`, `ASK_WAIT_MS`). With `wait: false`, or past the bound, it answers
   *      "working" and the caller is told when the turn ends (the reportBack path); agent_session waits again.
   */
  async startAgent(callerId: string, opts: StartAgentOpts, signal?: AbortSignal): Promise<ChildRunResult> {
    // A child on a linked machine (#1038) is made over the link, behind its own card that names the machine
    const machine = opts.machine?.trim()
    if (machine) return this.flow.remote.startAgent(callerId, { ...opts, machine }, signal)
    /*
     * **The setup has a bound of its own (#660).** Before the child exists the call can wait on the person's card, a
     * model list and the tool's own start, none of which `wait: false` shortens; the Codex bridge cuts the call at 280
     * seconds with a bare "timed out" that says nothing of whether a session exists. So the setup is raced against a
     * bound under that, and the answer says what was and was not created. A card still standing then stays (#673).
     */
    const startedAt = Date.now()
    const progress: StartProgress = { stage: 'checking' }
    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) ctl.abort()
    // Not `raceBound` (#428): what the bound answers is decided inside its timer, in the same instant as a card's answer
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<ChildRunResult>((resolve) => {
      timer = setTimeout(() => {
        /*
         * **A card is not withdrawn at the bound (#673).** The person may be away; the card stays in the caller's
         * session, the call answers "pending" with the request as a handle, and the setup goes on in the background:
         * an approval starts the child with its report armed (below), a refusal is told to the caller as a message
         */
        const standing = progress.stage === 'asking' && progress.requestId ? this.host.children.agentStarts.get(progress.requestId) : undefined
        if (standing && !standing.ended) {
          standing.detached = true
          // A handoff gave the request away while the card stood (#693): the call hears where it went
          resolve(this.flow.handedOverAnswer(callerId, standing.req.requestId) ?? agentStartPending(standing.req, standing.lowMemory))
          return
        }
        ctl.abort()
        const d = progress.stage === 'created' ? progress.d : undefined
        // The child exists and its run is registered: answered as the normal path does, with the report armed
        if (d) {
          const notice = [progress.unchecked, this.host.handles.get(d.sessionId)?.delegationNotice?.()].filter(Boolean).join('; ')
          const working = this.flow.agentWorking(d)
          resolve(working.ok && notice ? { ...working, notice: [working.notice, notice].filter(Boolean).join('; ') } : working)
        } else resolve(startAgentLate(progress))
      }, START_AGENT_SETUP_MS)
    })
    let set: Awaited<ReturnType<AgentStartFlow['setUpAgent']>>
    const setup = this.setUpAgent(callerId, opts, ctl.signal, progress)
    try {
      set = await Promise.race([setup, late.then((r) => ({ done: r }))])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    if ('done' in set) {
      /*
       * A start still in flight past the bound is not left without its report: if the session does come up, the
       * caller is told when its turn ends, as for any child that outlives the call
       */
      void setup.then((r) => { if ('key' in r) this.flow.agentWorking(r.d) }, () => {})
      return set.done
    }
    const { key, d, notice } = set
    // What the setup used comes off the wait, so the whole call ends inside the bridge's bound
    const left = Math.max(1_000, START_AGENT_CALL_MS - (Date.now() - startedAt))
    const result = opts.wait === false ? this.flow.agentWorking(d) : await this.flow.awaitAgent(key, d, signal, false, Math.min(ASK_WAIT_MS, left))
    return result.ok && notice ? { ...result, notice: [result.notice, notice].filter(Boolean).join('; ') } : result
  }

  /** Everything start_agent does before it waits on the child's turn (#660); `done` is a final answer, otherwise the child works */
  private async setUpAgent(
    callerId: string,
    opts: StartAgentOpts,
    signal: AbortSignal,
    progress: StartProgress,
  ): Promise<{ done: ChildRunResult } | { key: string; d: Delegation; notice: string | undefined }> {
    const done = (r: ChildRunResult) => ({ done: r })
    const caller = this.host.meta.get(callerId)
    // The orchestrator starts children outside any project (#853); any other session in its own project
    const fromOrchestrator = caller?.kind === 'orchestrator'
    if (!caller || (!caller.projectId && !fromOrchestrator)) return done({ ok: false, error: 'This session belongs to no project, so it cannot start agents.' })
    // How deep agents may start agents (#867): a setting, read now, that no preset opens
    const deep = agentDepthRefusal(this.host, callerId, 'start agents')
    if (deep) return done({ ok: false, error: deep })
    const project = fromOrchestrator ? orchestratorPlace(caller) : this.host.store.projects.listProjects().find((p) => p.id === caller.projectId)
    if (!project) return done({ ok: false, error: 'This session\'s project is no longer registered.' })
    if (fromOrchestrator && (opts.worktree || opts.branch)) {
      return done({ ok: false, error: 'A session the orchestrator starts works outside any project, so it has no worktree. Start it without one, or hand the work to a project\'s session with send_to_session.' })
    }
    if (project.trusted !== true && !this.host.autoBoundaryOpen(callerId, 'start in an untrusted project')) {
      return done({ ok: false, error: `This session's project is not trusted, so it cannot start agents — the person can trust it from the project menu. ${ASK_THE_PERSON}` })
    }
    /*
     * The same job already waiting on the person (#673 review): a call cut short by a host swap's drain is told to call
     * again, and a model that does gets the handle it never read, not a second card for the same work
     */
    const waiting = [...this.host.children.agentStarts.values()].find(
      (r) => !r.ended && r.req.callerId === callerId && r.req.task === opts.task && (!opts.tool || r.req.tool === opts.tool),
    )
    if (waiting) return done(agentStartPending(waiting.req, waiting.lowMemory))
    const tool = opts.tool ?? this.host.firstTool(project.defaultTool)
    if (!tool) return done({ ok: false, error: 'No agent adapter is available. Install and configure an agent CLI before starting an agent.' })
    const adapter = this.host.adapters.get(tool)
    if (!adapter) return done({ ok: false, error: `No agent named "${tool}" here. Installed tools: ${[...this.host.adapters.keys()].join(', ') || 'none'}.` })
    const full = this.agentCeilingError(callerId, project.id)
    if (full) return done({ ok: false, error: full })
    // The model named, else the person's for the difficulty named (#729), else the project's remembered one (#107)
    const { model, effort, difficulty } = agentChoice(opts, fromOrchestrator ? undefined : this.host.store.projects.projectToolDefaults(project.id)[tool], this.host.uiPreferences().agentModels?.[tool])
    // A setting's choice is checked as a named one is: a model retired since it was picked is refused with the list.
    // The caller never named it, so the remedy it reads is to tell the person or name a model, not to leave it out
    const setting = difficulty ? `the person's choice for ${difficulty} work in Settings → Agents` : ''
    const checked = await this.agentChoiceError(
      tool, difficulty ? model : opts.model, difficulty ? effort : opts.effort, model,
      difficulty ? `name a model (it is ${setting})` : undefined,
    )
    if (checked.error) {
      // Only what the setting chose: an effort the caller named with a difficulty is the caller's own
      const theirs = difficulty && (checked.on === 'model' || !opts.effort)
      return done({ ok: false, error: checked.error + (theirs ? ` That is ${setting}: tell them, or name a model.` : '') })
    }
    const unchecked = checked.unchecked
    progress.unchecked = unchecked
    const found = await adapter.detect()
    if (!found.installed || !found.loggedIn) return done({ ok: false, error: `${adapter.descriptor.label} cannot take the task: ${found.detail}. ${ASK_THE_PERSON}` })
    /*
     * The name the child starts with and the words its branch is made of (#861): the caller's short name, or the task
     * from the first word that tells it apart from this caller's other children
     */
    const given = givenAgentName(opts.name)
    const siblings = [...this.host.meta.values()].filter((s) => s.askedBy === callerId).map((s) => s.name)
    const basis = given ?? distinguishingText(opts.task, siblings)
    // A new worktree (part 2): its branch is settled before the card, which names it
    const worktree = opts.worktree || opts.branch ? await this.agentWorktreeBranch(project, opts, basis) : null
    if (worktree && 'error' in worktree) return done({ ok: false, error: worktree.error })
    // A worktree child is named by its branch, as every worktree session is, unless the caller named it
    const name = given ?? (worktree ? undefined : agentName(basis))

    progress.stage = 'asking'
    const detail: Extract<ApprovalDetail, { kind: 'agent_start' }> = {
      kind: 'agent_start',
      project: { id: project.id, name: project.name },
      tool: adapter.descriptor.label,
      ...(model ? { model } : {}),
      ...(difficulty ? { difficulty } : {}),
      preset: caller.permissionPreset,
      ...(worktree ? { worktree: { branch: worktree.branch } } : {}),
      text: taskLine(opts.task),
      ...(given ? { name: given } : {}),
    }
    const choice = {
      tool,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(worktree ? { worktreeBranch: worktree.branch } : {}),
      task: opts.task,
      ...(unchecked ? { unchecked } : {}),
      ...(opts.lsp !== undefined ? { lsp: opts.lsp } : {}),
      ...(name ? { name } : {}),
    }
    let request: AgentStartRequest | undefined
    const consent = await this.ensureAgentConsent(callerId, detail, signal, (requestId) => {
      request = { requestId, callerId, projectId: project.id, ...choice, detail }
      this.openAgentStart(request)
      progress.requestId = requestId
    })
    if (!consent.ok) {
      // The host is leaving (a swap or a quit), not the person answering: the request stays stored, and the next host
      // raises the card again (#673)
      if (request && consent.why === 'withdrawn' && (this.host.handingOver || this.host.disposing)) return done(agentStartPending(request))
      if (request) {
        // Withdrawn for a reason of its own (trust revoked, the caller withdrew it): that reason is the answer
        const ended = this.host.children.agentStarts.get(request.requestId)?.ended
        if (ended && 'error' in ended) return done({ ok: false, error: ended.error })
        const how = consent.why === 'denied' ? 'denied' : signal.aborted ? 'cancelled' : 'withdrawn'
        this.endAgentStart(request.requestId, { error: consent.error, person: agentStartPersonText(request, how), denied: consent.why === 'denied' })
      }
      return done(consent)
    }
    // The call was cancelled in the instant the card was answered: nothing is created now
    if (signal.aborted) {
      const error = 'The call was withdrawn before the session was created, so none was.'
      if (request) this.endAgentStart(request.requestId, { error, person: agentStartPersonText(request, 'cancelled') })
      return done({ ok: false, error })
    }
    /*
     * Memory (#686): allowed, but the machine has no room for another agent now. Queued, not refused (owner decision
     * 2026-10-15): the call answers "pending" with a handle at once, the person reads why in this session, and the
     * child starts when memory recovers, with its report armed. A start that had no card gets a request of its own here.
     */
    const short = await this.memoryShort()
    if (short) {
      const req = request ?? { requestId: `ag-${randomUUID()}`, callerId, projectId: project.id, ...choice, detail }
      return done(this.queueAgentStart(req, short))
    }
    // A handoff while the card stood moved the request to the session that took over (#693): the child is that session's
    const r = await this.createAgentChild(request?.callerId ?? callerId, { id: project.id, name: project.name, path: project.path }, choice, progress, request?.detail.preset, request?.requestId)
    if (request) {
      if ('key' in r) this.endAgentStart(request.requestId, { childId: r.d.sessionId })
      else {
        const error = r.done.ok ? 'No session was created.' : r.done.error
        this.endAgentStart(request.requestId, { error, person: agentStartPersonText(request, 'failed', error) })
      }
    }
    /*
     * The request was handed over while its card stood (#693): the child is the new session's, which is told when it
     * ends; the call that asked hears where it went instead of the child's answer
     */
    if (request && request.callerId !== callerId) {
      if ('key' in r) {
        this.host.children.recordHandedOver(r.d.sessionId, callerId, request.callerId)
        this.flow.agentWorking(r.d)
      }
      return done(this.flow.handedOverAnswer(callerId, request.requestId) ?? { ok: false, error: 'The request was handed over to another session.' })
    }
    return r
  }

  /**
   * The child itself, once the person (or the project's trust) allowed it (#561, #673): counted again, made in the
   * caller's folder or a new worktree, named, and given the task. A card may have stood for hours, so what the start
   * rests on is read again first (#673 review): the caller is still here, its project still trusted, it is still above
   * the agent depth (#867), and its preset is no higher than the one the person read on the card (`approvedPreset`).
   *
   * **The place is taken before the first wait** (#673 review): the ceiling is checked and a place reserved in one
   * synchronous step (`agentStartReserved`), held until the child's delegation counts it or the start fails. Checked
   * and counted on either side of `createSession`, eight calls at once all passed a ceiling of four.
   */
  async createAgentChild(
    callerId: string,
    project: { id: string; name: string; path: string },
    choice: Pick<AgentStartRequest, 'tool' | 'model' | 'effort' | 'worktreeBranch' | 'task' | 'unchecked' | 'lsp' | 'name'>,
    progress: StartProgress,
    approvedPreset?: PermissionPreset,
    /** The start request this child is made for, if one stood: withdrawn while the child is made, it gets no task (#839) */
    requestId?: string,
  ): Promise<{ done: ChildRunResult } | { key: string; d: Delegation; notice: string | undefined }> {
    const done = (r: ChildRunResult) => ({ done: r })
    const refused = this.agentStartGateError(callerId, project.id)
    if (refused) return done({ ok: false, error: refused })
    const caller = this.host.meta.get(callerId)!
    if (approvedPreset && !presetWithin(caller.permissionPreset, approvedPreset)) {
      return done({
        ok: false,
        error:
          `This session's permissions were raised to ${caller.permissionPreset} after the person allowed a session with ${approvedPreset}, ` +
          `so none was started. Call start_agent again if it is still needed: the person decides on the new permissions. ${ASK_THE_PERSON}`,
      })
    }
    const { tool, model, effort, unchecked } = choice
    const worktree = choice.worktreeBranch ? { branch: choice.worktreeBranch } : null
    // The card may have stood a while: counted again, and the place taken now
    const place = this.reservePlace(callerId, project.id)
    if ('error' in place) return done({ ok: false, error: place.error })
    const { release } = place
    try {
      return await this.createReservedChild(
        callerId,
        caller,
        project,
        { tool, model, effort, unchecked, task: choice.task, ...(choice.lsp !== undefined ? { lsp: choice.lsp } : {}), ...(choice.name ? { name: choice.name } : {}) },
        worktree,
        progress,
        release,
        requestId,
      )
    } finally {
      release()
    }
  }

  /** `AgentStartGates.agentStartGateError` (agent-start-gates.ts), kept on the flow for its callers */
  private agentStartGateError(...a: Parameters<AgentStartGates['agentStartGateError']>): ReturnType<AgentStartGates['agentStartGateError']> {
    return this.gates.agentStartGateError(...a)
  }

  /** `AgentStartGates.reservePlace` (agent-start-gates.ts), kept on the flow for its callers */
  reservePlace(...a: Parameters<AgentStartGates['reservePlace']>): ReturnType<AgentStartGates['reservePlace']> {
    return this.gates.reservePlace(...a)
  }

  /**
   * A session made for a child or a fork whose gates no longer pass once it exists: it gets no task, named for what it
   * was made for, and goes to the session archive (a worktree stays, as for any archived session); the call reads why. A session
   * the session archive refuses has its process stopped instead, and the call says so.
   */
  async abandonChild(child: SessionInfo, why: string, name?: string): Promise<{ ok: false; error: string }> {
    if (name) this.host.rename(child.id, name)
    const called = this.host.meta.get(child.id)?.name ?? child.name
    try {
      await this.host.trashSession(child.id)
      return { ok: false, error: `${why} The session "${called}" made for it got no task and was archived.` }
    } catch (e) {
      const running = this.host.handles.has(child.id)
      let stopped = running && (await this.host.sleepSession(child.id).catch(() => false))
      // A fresh session has no turn to wait out: one sleep refuses is stopped all the same
      const h = this.host.handles.get(child.id)
      if (running && !stopped && h) {
        this.host.handles.delete(child.id)
        this.host.running.delete(child.id)
        this.host.emit({ type: 'session_live', sessionId: child.id, live: false, reason: 'asleep' })
        stopped = await h.dispose().then(() => true, () => false)
      }
      const left = !running ? 'no process of its was running' : stopped ? 'its process was stopped' : 'its process could not be stopped'
      return {
        ok: false,
        error: `${why} The session "${called}" [${child.id}] made for it got no task, but could not be archived (${(e as Error).message}); ${left}. Tell the person.`,
      }
    }
  }

  /** The rest of `createAgentChild`, with its place reserved; `release` once the delegation counts the child */
  private async createReservedChild(
    callerId: string,
    caller: SessionInfo,
    project: { id: string; name: string; path: string },
    choice: { tool: string; model?: string; effort?: string; unchecked?: string; task: string; lsp?: boolean; name?: string },
    worktree: { branch: string } | null,
    progress: StartProgress,
    release: () => void,
    requestId?: string,
  ): Promise<{ done: ChildRunResult } | { key: string; d: Delegation; notice: string | undefined }> {
    const done = (r: ChildRunResult) => ({ done: r })
    const { tool, model, effort, unchecked } = choice

    // The caller's own folder (a worktree session's is its worktree), so the two work on the same files; or a new
    // worktree of the project's repository (part 2), which createSession makes in the worktree root
    // The orchestrator's child: a folder of its own, never the orchestrator's (#994 review)
    const scratch = project.id === ORCHESTRATOR_PLACE ? newOrchestratorAgentFolder() : null
    const cwd = scratch ?? (worktree ? project.path : (this.host.store.sessions.sessionCwd(callerId) ?? caller.worktree?.path ?? project.path))
    let child: SessionInfo
    let setupProblems: string[] = []
    let forkNote: string | undefined
    progress.stage = 'creating'
    try {
      child = await this.host.createSession({
        onSetupProblems: (problems) => (setupProblems = problems),
        onWorktreeBase: (note) => (forkNote = note),
        // The orchestrator's children have no project (#853)
        projectId: project.id === ORCHESTRATOR_PLACE ? null : project.id,
        cwd,
        tool,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        // Never above the caller (#561): the caller's own preset, which the caller cannot change for it afterwards
        permissionPreset: caller.permissionPreset,
        askedBy: callerId,
        // Code intelligence (#686): off for a child unless its caller asked for it
        ...(choice.lsp !== undefined ? { lsp: choice.lsp } : {}),
        /*
         * A worktree forks from what the caller works on: its own branch when it is a worktree session itself, so
         * the child starts from the caller's work; otherwise the project's trunk, as the new-session window does
         */
        ...(worktree ? { worktree: true, worktreeBranch: worktree.branch, ...(caller.worktree ? { worktreeBase: caller.worktree.branch } : {}) } : {}),
      })
    } catch (e) {
      // No session owns the child's folder: it goes with the failed start
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
      return done({ ok: false, error: `Could not start the session: ${(e as Error).message}` })
    }
    // Its depth stays even when the caller is deleted later (#897 review)
    recordAgentDepth(this.host, child.id, callerId)
    // Making the session took a while: what the start rests on is read again, with no wait before the delegation
    const callerNow = this.host.meta.get(callerId)
    const withdrawn = requestId ? this.host.children.agentStarts.get(requestId)?.ended : undefined
    const late = (withdrawn && 'error' in withdrawn ? `The request was withdrawn while its session was being made. ${withdrawn.error}` : null) ??
      this.agentStartGateError(callerId, project.id) ??
      (callerNow && !presetWithin(child.permissionPreset, callerNow.permissionPreset)
        ? `This session's permissions were lowered to ${callerNow.permissionPreset} while the session was being made.`
        : null)
    // A request stored by an older host carries no name: named from its task, as that host did
    const name = choice.name ?? (worktree ? undefined : agentName(choice.task))
    if (late) return done(await this.abandonChild(child, late, name))
    progress.stage = 'created'
    progress.childId = child.id
    // A worktree session is named by its branch, as every worktree session is, unless the caller named it (#861)
    if (name) this.host.rename(child.id, name)
    const key = `${callerId}>${child.id}`
    const d = this.flow.startDelegation(key, callerId, child.id, { id: project.id, name: project.name, path: child.worktree?.path ?? cwd }, true)
    // The delegation counts the child now
    release()
    progress.d = d
    try {
      // The project's instructions for started agents (#1161 item 2), read now: a card may have stood while they changed
      const instructions = project.id === ORCHESTRATOR_PLACE ? '' : this.host.store.projects.agentInstructions(project.id)
      await this.host.deliver(child.id, agentFrame(labelOf(this.host.store.messages, caller), choice.task, setupProblems, instructions), undefined, { sessionId: callerId, name: labelOf(this.host.store.messages, caller) }, false)
    } catch (e) {
      this.host.children.dropDelegation(key, d)
      if (this.host.agentRuns.get(child.id) === d.wait) this.host.agentRuns.delete(child.id)
      this.host.children.releaseTurn(child.id, callerId)
      return done({ ok: false, error: `Could not give the task to the new session: ${(e as Error).message}` })
    }
    // The mailbox writes the task down as a thread the caller owns (docs/plans/mailbox.md §8.1): the caller's own words, not the frame
    this.host.children.delegated(callerId, child.id, 'start_agent', choice.task)
    const notice = this.host.handles.get(child.id)?.delegationNotice?.()
    return { key, d, notice: [unchecked, forkNote, notice].filter(Boolean).join('; ') || undefined }
  }

  /** `AgentChoices.agentWorktreeBranch` (agent-choices.ts), kept on the flow for its callers */
  agentWorktreeBranch(...a: Parameters<AgentChoices['agentWorktreeBranch']>): ReturnType<AgentChoices['agentWorktreeBranch']> {
    return this.choices.agentWorktreeBranch(...a)
  }

  /** `AgentStartGates.agentCeilingError` (agent-start-gates.ts), kept on the flow for its callers */
  agentCeilingError(...a: Parameters<AgentStartGates['agentCeilingError']>): ReturnType<AgentStartGates['agentCeilingError']> {
    return this.gates.agentCeilingError(...a)
  }

  /** `AgentChoices.agentChoiceError` (agent-choices.ts), kept on the flow for its callers */
  private agentChoiceError(...a: Parameters<AgentChoices['agentChoiceError']>): ReturnType<AgentChoices['agentChoiceError']> {
    return this.choices.agentChoiceError(...a)
  }

  /** `AgentConsents.ensureAgentConsent` (agent-consents.ts), kept on the flow for its callers */
  ensureAgentConsent(...a: Parameters<AgentConsents['ensureAgentConsent']>): ReturnType<AgentConsents['ensureAgentConsent']> {
    return this.consents.ensureAgentConsent(...a)
  }

  /** `AgentConsents.agentConsentFrom` (agent-consents.ts), kept on the flow for its callers */
  agentConsentFrom(...a: Parameters<AgentConsents['agentConsentFrom']>): ReturnType<AgentConsents['agentConsentFrom']> {
    return this.consents.agentConsentFrom(...a)
  }

  /** `AgentStartRequests.openAgentStart` (agent-start-requests.ts), kept on the flow for its callers */
  private openAgentStart(...a: Parameters<AgentStartRequests['openAgentStart']>): ReturnType<AgentStartRequests['openAgentStart']> {
    return this.requests.openAgentStart(...a)
  }

  /** `AgentStartRequests.endAgentStart` (agent-start-requests.ts), kept on the flow for its callers */
  private endAgentStart(...a: Parameters<AgentStartRequests['endAgentStart']>): ReturnType<AgentStartRequests['endAgentStart']> {
    return this.requests.endAgentStart(...a)
  }

  /** `AgentStartRequests.withdrawAgentStart` (agent-start-requests.ts), kept on the flow for its callers */
  withdrawAgentStart(...a: Parameters<AgentStartRequests['withdrawAgentStart']>): ReturnType<AgentStartRequests['withdrawAgentStart']> {
    return this.requests.withdrawAgentStart(...a)
  }

  /** `AgentStartRequests.resumeAgentStart` (agent-start-requests.ts), kept on the flow for its callers */
  resumeAgentStart(...a: Parameters<AgentStartRequests['resumeAgentStart']>): ReturnType<AgentStartRequests['resumeAgentStart']> {
    return this.requests.resumeAgentStart(...a)
  }

  /** `AgentStartRequests.memoryShort` (agent-start-requests.ts), kept on the flow for its callers */
  memoryShort(...a: Parameters<AgentStartRequests['memoryShort']>): ReturnType<AgentStartRequests['memoryShort']> {
    return this.requests.memoryShort(...a)
  }

  /** `AgentStartRequests.lowMemory` (agent-start-requests.ts), kept on the flow for its callers */
  lowMemory(...a: Parameters<AgentStartRequests['lowMemory']>): ReturnType<AgentStartRequests['lowMemory']> {
    return this.requests.lowMemory(...a)
  }

  /** `AgentStartRequests.queueAgentStart` (agent-start-requests.ts), kept on the flow for its callers */
  private queueAgentStart(...a: Parameters<AgentStartRequests['queueAgentStart']>): ReturnType<AgentStartRequests['queueAgentStart']> {
    return this.requests.queueAgentStart(...a)
  }

  /** `AgentStartRequests.restoreAgentStarts` (agent-start-requests.ts), kept on the flow for its callers */
  restoreAgentStarts(...a: Parameters<AgentStartRequests['restoreAgentStarts']>): ReturnType<AgentStartRequests['restoreAgentStarts']> {
    return this.requests.restoreAgentStarts(...a)
  }
}
