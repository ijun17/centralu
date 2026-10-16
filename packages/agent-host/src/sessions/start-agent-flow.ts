import { randomUUID } from 'node:crypto'
import type { AgentStartRecord, AgentStartRequest, Delegation, LowMemory } from './child-ownership.js'
import { ASK_WAIT_MS, taskLine } from './ask-project.js'
import { AGENT_CEILING, agentBranch, agentChoice, agentFrame, agentName, presetWithin } from './start-agent.js'
import { labelOf } from './transcript-view.js'
import type {
  ApprovalDetail,
  ModelOption,
  PermissionPreset,
  SessionInfo,
} from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
} from '@cc/protocol'
import type { ChildRunResult, StartAgentOpts } from '../adapters/contract.js'
import { gigabytes, type MemoryShortfall } from './memory-gate.js'
import {
  gitSummary,
  gitValidBranchName,
} from '../dev-services/git.js'
import type { HostAskAnswer } from './host-cards.js'
import type { DelegationHost } from './delegation-host.js'

/** How long start_agent waits for a model list to check the model and effort asked for, before it starts anyway (#660) */
export const START_AGENT_MODEL_CHECK_MS = 3_000

/**
 * How long start_agent may spend before the child exists: the model check, the card for the person and the session's
 * own start. Under the Codex bridge's 280 seconds, so the caller reads an answer from the host that says whether a
 * session was created, never the bridge's bare "timed out" (#660).
 */
export const START_AGENT_SETUP_MS = 200_000

/**
 * How long one start_agent call may take in all, setup and wait together: the Codex bridge's 280 seconds
 * (`APP_CALL_TIMEOUT_MS`, orchestrator-bridge.mjs) less a margin. What the setup used is taken off the wait.
 */
export const START_AGENT_CALL_MS = 270_000

/**
 * Said to the calling model when start_agent is refused or cut short (#660). A model that reads only "could not" tends
 * to do the job with its own CLI's subagents, which the person does not see in the sidebar and did not agree to.
 */
export const ASK_THE_PERSON = 'Do not do this with your own subagents instead: tell the person what stopped it and let them decide.'

/** How far start_agent's setup had come when its bound passed (#660) */
type StartProgress = {
  stage: 'checking' | 'asking' | 'creating' | 'created'
  /** The card's request, while one stands (#673): past the bound the call answers "pending" and the card stays */
  requestId?: string
  childId?: string
  /** Set once the child's run is registered, so a late answer can describe it as the normal path does */
  d?: Delegation
  /** Said when the model or effort asked for could not be checked */
  unchecked?: string
}

/** The refusal for a session that may not start agents because it was itself started or asked (#561) */
const AGENT_DEPTH_ERROR =
  'This session was itself started or asked by another session, so it cannot start agents — say in your answer what is needed instead.'

/** The person's answer on a start_agent card, read as consent; a refusal says whether they refused or nobody answered */
type AgentConsent = { ok: true } | { ok: false; error: string; why: 'denied' | 'withdrawn' }

/**
 * The answer while a start waits on the person (#673), or on memory (#686): the request's id is the handle agent_session
 * follows
 */
export function agentStartPending(req: AgentStartRequest, lowMemory?: LowMemory): ChildRunResult {
  return { ok: true, state: 'pending', sessionId: req.requestId, sessionName: '', tool: req.detail.tool, ...(lowMemory ? { lowMemory } : {}) }
}

/** What the person reads in the caller's session when a start_agent request ends without a session (#673) */
export function agentStartPersonText(req: Pick<AgentStartRequest, 'detail'>, how: 'denied' | 'withdrawn' | 'cancelled' | 'deleted' | 'stopped' | 'untrusted' | 'failed', why?: string): string {
  const what = `The request to start ${req.detail.tool} (“${req.detail.text}”)`
  switch (how) {
    case 'denied':
      return `${what} was denied. The session was told; no agent was started.`
    case 'cancelled':
      return `${what} was withdrawn: the call that asked was cancelled before you answered. No agent was started.`
    case 'deleted':
      return `${what} was withdrawn: this session was deleted. No agent was started.`
    case 'stopped':
      return `${what} was withdrawn by this session. No agent was started.`
    case 'untrusted':
      return `${what} was withdrawn: the project is no longer trusted. The session was told; no agent was started.`
    case 'failed':
      return `${what} was allowed, but no agent was started: ${(why ?? '').slice(0, 300)}`
    default:
      return `${what} was withdrawn before you answered. No agent was started.`
  }
}

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

/** The sender Centralu's own messages to a session are recorded under (#673): like `HUB_SENDER`, no session's id */
const HOST_SENDER = '_centralu'

/** Reads a stored request back; a row this build cannot read is dropped rather than raised half-formed */
function readAgentStartRequest(raw: unknown): AgentStartRequest | null {
  const r = raw as Partial<AgentStartRequest> | null
  if (!r || typeof r !== 'object') return null
  if (typeof r.requestId !== 'string' || typeof r.callerId !== 'string' || typeof r.projectId !== 'string') return null
  if (typeof r.tool !== 'string' || typeof r.task !== 'string' || r.detail?.kind !== 'agent_start') return null
  return r as AgentStartRequest
}

/** What start_agent reaches of the rest of the delegation flow (`DelegationFlow`): the child's run, its wait, its answers */
export type StartAgentDelegations = {
  startDelegation(key: string, callerId: string, sessionId: string, target: { id: string; name: string; path: string }, agent?: boolean, joinedTurn?: boolean): Delegation
  agentWorking(d: Delegation, arm?: boolean, observing?: boolean): ChildRunResult
  awaitAgent(key: string, d: Delegation, signal?: AbortSignal, observing?: boolean, boundMs?: number): Promise<ChildRunResult>
  handedOverAnswer(callerId: string, id: string): { ok: false; error: string } | undefined
}

/**
 * start_agent (#561) and its requests (#673, #686): the setup, the person's consent, the per-project ceiling, the
 * request a card or low memory keeps standing, and the child's start. Moved out of `DelegationFlow` as it was (#850);
 * what it reaches of the rest of the flow is `StartAgentDelegations`, of the manager `DelegationHost`.
 */
export class AgentStartFlow {
  constructor(
    private readonly host: DelegationHost,
    private readonly flow: StartAgentDelegations,
  ) {}

  /**
   * Sessions the person allowed to start agents "always for this session" (#561, `ensureAgentConsent`). Live only, like
   * `readGrants`: a restart asks again. The project-wide always is a stored consent instead.
   */
  readonly agentConsents = new Set<string>()

  /**
   * Places taken by starts between their ceiling check and the child's delegation (#673 review) — project id -> how
   * many. Counted by `agentCeilingError` with the running children, so starts at once cannot pass the ceiling together.
   */
  private readonly agentStartReserved = new Map<string, number>()

  /**
   * start_agent (#561): an ordinary session starts another agent (Claude or Codex) in its own project on a task.
   *
   *   1. Who may: an ordinary session of a trusted project (the rule ask_project and attach_app follow, #382), and
   *      not one that was itself started or asked by another session (`askedBy`): depth one.
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
    if (!caller?.projectId) return done({ ok: false, error: 'This session belongs to no project, so it cannot start agents.' })
    if (this.agentDepthBlocked(caller) && !this.host.autoBoundaryOpen(callerId, 'delegation depth')) return done({ ok: false, error: AGENT_DEPTH_ERROR })
    const project = this.host.store.listProjects().find((p) => p.id === caller.projectId)
    if (!project) return done({ ok: false, error: 'This session\'s project is no longer registered.' })
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
    const { model, effort, difficulty } = agentChoice(opts, this.host.store.projectToolDefaults(project.id)[tool], this.host.uiPreferences().agentModels?.[tool])
    // A setting's choice is checked as a named one is: a model retired since it was picked is refused with the list.
    // The caller never named it, so the remedy it reads is to tell the person or name a model, not to leave it out
    const setting = difficulty ? `the person's choice for ${difficulty} work in Settings → Orchestrator` : ''
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
    // A new worktree (part 2): its branch is settled before the card, which names it
    const worktree = opts.worktree || opts.branch ? await this.agentWorktreeBranch(project, opts) : null
    if (worktree && 'error' in worktree) return done({ ok: false, error: worktree.error })

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
    }
    const choice = {
      tool,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(worktree ? { worktreeBranch: worktree.branch } : {}),
      task: opts.task,
      ...(unchecked ? { unchecked } : {}),
      ...(opts.lsp !== undefined ? { lsp: opts.lsp } : {}),
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
    const r = await this.createAgentChild(request?.callerId ?? callerId, { id: project.id, name: project.name, path: project.path }, choice, progress, request?.detail.preset)
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
   * rests on is read again first (#673 review): the caller is still here, its project still trusted, it still may start
   * agents (depth one), and its preset is no higher than the one the person read on the card (`approvedPreset`).
   *
   * **The place is taken before the first wait** (#673 review): the ceiling is checked and a place reserved in one
   * synchronous step (`agentStartReserved`), held until the child's delegation counts it or the start fails. Checked
   * and counted on either side of `createSession`, eight calls at once all passed a ceiling of four.
   */
  private async createAgentChild(
    callerId: string,
    project: { id: string; name: string; path: string },
    choice: Pick<AgentStartRequest, 'tool' | 'model' | 'effort' | 'worktreeBranch' | 'task' | 'unchecked' | 'lsp'>,
    progress: StartProgress,
    approvedPreset?: PermissionPreset,
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
        { tool, model, effort, unchecked, task: choice.task, ...(choice.lsp !== undefined ? { lsp: choice.lsp } : {}) },
        worktree,
        progress,
        release,
      )
    } finally {
      release()
    }
  }

  /**
   * What a child's start rests on in its caller, read once the person allowed it and again once its session exists,
   * right before its delegation is registered: the caller is still here, its project still registered and trusted
   * (or the caller is `auto`), and it still may start agents (depth one).
   */
  private agentStartGateError(callerId: string, projectId: string): string | null {
    const caller = this.host.meta.get(callerId)
    if (!caller) return 'The session that asked is no longer here.'
    const now = this.host.store.listProjects().find((p) => p.id === projectId)
    if (!now) return 'This session\'s project is no longer registered.'
    const auto = caller.permissionPreset === 'auto'
    if (now.trusted !== true && !auto) return `This session's project is no longer trusted, so it cannot start agents. ${ASK_THE_PERSON}`
    if (this.agentDepthBlocked(caller) && !auto) return AGENT_DEPTH_ERROR
    return null
  }

  /**
   * A session made for a child or a fork whose gates no longer pass once it exists: it gets no task, named for what it
   * was made for, and goes to the trash (a worktree stays, as for any trashed session); the call reads why. A session
   * the trash refuses has its process stopped instead, and the call says so.
   */
  async abandonChild(child: SessionInfo, why: string, name?: string): Promise<{ ok: false; error: string }> {
    if (name) this.host.rename(child.id, name)
    const called = this.host.meta.get(child.id)?.name ?? child.name
    try {
      await this.host.trashSession(child.id)
      return { ok: false, error: `${why} The session "${called}" made for it got no task and was moved to the trash.` }
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
        error: `${why} The session "${called}" [${child.id}] made for it got no task, but could not be moved to the trash (${(e as Error).message}); ${left}. Tell the person.`,
      }
    }
  }

  /**
   * A place under the per-project ceiling, checked and taken in one synchronous step (`agentStartReserved`), for a start
   * (`createAgentChild`) or a fork (`forkFor`) that waits on something before its delegation counts the child.
   * `release` once the delegation counts it, or when the start fails; a second call does nothing.
   */
  reservePlace(callerId: string, projectId: string): { release: () => void } | { error: string } {
    const full = this.agentCeilingError(callerId, projectId)
    if (full) return { error: full }
    this.agentStartReserved.set(projectId, (this.agentStartReserved.get(projectId) ?? 0) + 1)
    let reserved = true
    return {
      release: () => {
        if (!reserved) return
        reserved = false
        const left = (this.agentStartReserved.get(projectId) ?? 1) - 1
        if (left > 0) this.agentStartReserved.set(projectId, left)
        else this.agentStartReserved.delete(projectId)
      },
    }
  }

  /** The rest of `createAgentChild`, with its place reserved; `release` once the delegation counts the child */
  private async createReservedChild(
    callerId: string,
    caller: SessionInfo,
    project: { id: string; name: string; path: string },
    choice: { tool: string; model?: string; effort?: string; unchecked?: string; task: string; lsp?: boolean },
    worktree: { branch: string } | null,
    progress: StartProgress,
    release: () => void,
  ): Promise<{ done: ChildRunResult } | { key: string; d: Delegation; notice: string | undefined }> {
    const done = (r: ChildRunResult) => ({ done: r })
    const { tool, model, effort, unchecked } = choice

    // The caller's own folder (a worktree session's is its worktree), so the two work on the same files; or a new
    // worktree of the project's repository (part 2), which createSession makes in the worktree root
    const cwd = worktree ? project.path : (this.host.store.sessionCwd(callerId) ?? caller.worktree?.path ?? project.path)
    let child: SessionInfo
    progress.stage = 'creating'
    try {
      child = await this.host.createSession({
        projectId: project.id,
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
      return done({ ok: false, error: `Could not start the session: ${(e as Error).message}` })
    }
    // Making the session took a while: what the start rests on is read again, with no wait before the delegation
    const callerNow = this.host.meta.get(callerId)
    const late = this.agentStartGateError(callerId, project.id) ??
      (callerNow && !presetWithin(child.permissionPreset, callerNow.permissionPreset)
        ? `This session's permissions were lowered to ${callerNow.permissionPreset} while the session was being made.`
        : null)
    if (late) return done(await this.abandonChild(child, late, worktree ? undefined : agentName(choice.task)))
    progress.stage = 'created'
    progress.childId = child.id
    // A worktree session is named by its branch, as every worktree session is; otherwise by its job
    if (!worktree) this.host.rename(child.id, agentName(choice.task))
    const key = `${callerId}>${child.id}`
    const d = this.flow.startDelegation(key, callerId, child.id, { id: project.id, name: project.name, path: child.worktree?.path ?? cwd }, true)
    // The delegation counts the child now
    release()
    progress.d = d
    try {
      await this.host.deliver(child.id, agentFrame(labelOf(this.host.store, caller), choice.task), undefined, { sessionId: callerId, name: labelOf(this.host.store, caller) }, false)
    } catch (e) {
      this.host.children.dropDelegation(key, d)
      if (this.host.agentRuns.get(child.id) === d.wait) this.host.agentRuns.delete(child.id)
      this.host.children.releaseTurn(child.id, callerId)
      return done({ ok: false, error: `Could not give the task to the new session: ${(e as Error).message}` })
    }
    const notice = this.host.handles.get(child.id)?.delegationNotice?.()
    return { key, d, notice: [unchecked, notice].filter(Boolean).join('; ') || undefined }
  }

  /**
   * The branch a child's new worktree goes on (#561 part 2): the one asked for, checked by git's own rule, or one
   * named from the job (`agentBranch`). Refused before the card when the project is no git repository, so the person
   * is never asked about a worktree that cannot be made.
   */
  async agentWorktreeBranch(project: { id: string; path: string }, opts: StartAgentOpts): Promise<{ branch: string } | { error: string }> {
    const summary = await gitSummary(project.path, this.host.gitTrust(project.id))
    if (!summary.isRepo) return { error: 'This project is not a git repository, so it has no worktrees. Start the agent without one.' }
    const asked = opts.branch?.trim()
    if (asked) return (await gitValidBranchName(asked)) ? { branch: asked } : { error: `Not a valid branch name: ${asked}` }
    return { branch: agentBranch(opts.task, randomUUID()) }
  }

  /** A saved ceiling overrides the caller's preset default: auto unlimited, otherwise AGENT_CEILING. */
  agentCeilingError(callerId: string, projectId: string): string | null {
    const configured = this.host.uiPreferences().agentCeiling
    const ceiling = configured ?? (this.host.autoBoundaryOpen(callerId) ? 0 : AGENT_CEILING)
    if (ceiling === 0) return null
    // A start under way holds its place from its check (#673 review); a request still waiting on the person holds none
    const running =
      [...this.host.children.delegations.values()].filter((d) => d.agent && !d.settled && this.host.meta.get(d.sessionId)?.projectId === projectId).length +
      (this.agentStartReserved.get(projectId) ?? 0)
    if (running < ceiling) return null
    return `${running} agents started by this project's sessions are already working, the most at once. Wait for one (agent_session, action "wait") or stop one, then try again.`
  }

  /**
   * A model or effort the caller named that the tool does not offer, as a refusal listing what it does (#561), so a
   * wrong name costs one call rather than a child whose first turn fails. Lenient where the list is: a name the
   * list's ids or labels contain (an alias such as "sonnet") passes, and a tool that cannot list its models passes all.
   */
  private async agentChoiceError(
    tool: string,
    askedModel: string | undefined,
    askedEffort: string | undefined,
    model: string | undefined,
    /** What to do if the first turn fails on a name that could not be checked; the caller's own names can be left out */
    remedy = 'start again without it',
  ): Promise<{ error: string | null; on?: 'model' | 'effort'; unchecked?: string }> {
    if (!askedModel && !askedEffort) return { error: null }
    /*
     * **A bounded wait on a cached list (#660).** The check helps a caller that misspelled a model; it must never
     * hold the call, so with no list in time the child starts on the name as given, and the answer says it was not
     * checked. A tool that cannot list its models passes silently, as it always did.
     */
    const adapter = this.host.adapters.get(tool)
    if (!adapter?.listModels) return { error: null }
    const what = [askedModel && `model "${askedModel}"`, askedEffort && `effort "${askedEffort}"`].filter(Boolean).join(' and ')
    const notChecked = (why: string) => ({ error: null, unchecked: `${what} not checked: ${why}. If the session's first turn fails on it, ${remedy}` })
    const mismatch = (models: ModelOption[]): { error: string; on: 'model' | 'effort' } | null => {
      const find = (name: string) => {
        const n = name.toLowerCase()
        return models.find((m) => m.id.toLowerCase() === n) ?? models.find((m) => m.id.toLowerCase().includes(n) || m.label.toLowerCase().includes(n))
      }
      if (askedModel && !find(askedModel)) return { error: `${tool} has no model "${askedModel}". Its models: ${models.map((m) => m.id).join(', ')}.`, on: 'model' }
      if (askedEffort) {
        const m = model ? find(model) : models[0]
        if (m && m.efforts.length > 0 && !m.efforts.includes(askedEffort)) return { error: `${m.id} has no effort "${askedEffort}". Its efforts: ${m.efforts.join(', ')}.`, on: 'effort' }
      }
      return null
    }
    let got = await this.host.modelsWithin(tool, START_AGENT_MODEL_CHECK_MS)
    if (!got) return notChecked(`${tool}'s model list was not available in time`)
    if (got.models.length === 0) return notChecked(`${tool} listed no models`)
    let wrong = mismatch(got.models)
    if (wrong && got.cached) {
      // The CLI may have been updated since the list was read: a refusal waits on a fresh one
      got = await this.host.modelsWithin(tool, START_AGENT_MODEL_CHECK_MS, true)
      if (!got) return notChecked(`${tool}'s saved model list lacks it and a new one was not available in time`)
      if (got.models.length === 0) return notChecked(`${tool} listed no models`)
      wrong = mismatch(got.models)
    }
    return wrong ?? { error: null }
  }

  /**
   * The person's consent for a session to start agents (#561), the first time it does: a card in the caller's approval
   * slot. "Always" is kept for this session while this host serves it; with ⌥ (scope `project`) it is remembered as the
   * project's 'agents' consent, listed in Settings → Permissions with ask_project's pairs and revoked there.
   *
   * **Trust is the consent (#673).** A `normal` caller in a trusted project starts agents without a card: the person
   * already decided about that project when they trusted it (#655), and a card in a session they were not looking at
   * only made the session work alone. `safe` keeps the card, as it keeps every boundary closed (#606); `auto` opens it.
   * `onCard` hears the request id before a card is raised, so the request can be kept until the person answers.
   */
  async ensureAgentConsent(
    callerId: string,
    detail: Extract<ApprovalDetail, { kind: 'agent_start' }>,
    signal?: AbortSignal,
    onCard?: (requestId: string) => void,
  ): Promise<AgentConsent> {
    if (this.agentConsents.has(callerId)) return { ok: true }
    if (this.host.store.getProjectConsent(detail.project.id, detail.project.id, 'agents')) return { ok: true }
    if (this.trustIsAgentConsent(callerId, detail.project.id)) return { ok: true }
    const requestId = `ag-${randomUUID()}`
    if (this.host.meta.get(callerId)?.permissionPreset !== 'auto') onCard?.(requestId)
    return this.agentConsentFrom(callerId, detail.project.id, await this.host.askHost(callerId, detail, signal, { requestId }))
  }

  /** Depth one (#561): a session started by another, or handling an ask_project task now, starts no agents */
  agentDepthBlocked(caller: SessionInfo): boolean {
    return !!caller.askedBy || [...this.host.children.delegations.values()].some((d) => d.sessionId === caller.id && !d.agent && !d.settled)
  }

  /** A `normal` caller in a trusted project needs no card to start agents (#673): the project's trust, read now */
  private trustIsAgentConsent(callerId: string, projectId: string): boolean {
    if (this.host.meta.get(callerId)?.permissionPreset !== 'normal') return false
    return this.host.store.listProjects().find((p) => p.id === projectId)?.trusted === true
  }

  /** The person's answer on a start_agent card, as consent (remembered where they chose "always") or a refusal */
  private agentConsentFrom(callerId: string, projectId: string, decision: HostAskAnswer): AgentConsent {
    if (decision === 'always_project') {
      this.host.store.setProjectConsent(projectId, projectId, 'agents')
      this.host.emit({ type: 'project_consents_changed' })
      return { ok: true }
    }
    if (decision === 'always') {
      this.agentConsents.add(callerId)
      return { ok: true }
    }
    if (decision === 'allow') return { ok: true }
    if (decision === 'deny') {
      return { ok: false, why: 'denied', error: `The person did not allow this session to start another agent. Do not start one again unless they tell you to. ${ASK_THE_PERSON}` }
    }
    return { ok: false, why: 'withdrawn', error: `The question to the person was withdrawn before they answered, so no agent was started. ${ASK_THE_PERSON}` }
  }

  /** A start_agent request whose card now stands (#673): kept, in memory and in the store, until it is answered */
  private openAgentStart(req: AgentStartRequest): AgentStartRecord {
    let end!: () => void
    const done = new Promise<void>((resolve) => (end = resolve))
    const rec: AgentStartRecord = { req, detached: false, done, end }
    this.host.children.addAgentStart(rec)
    this.host.store.putAgentStartRequest(req.requestId, req.callerId, req)
    return rec
  }

  /**
   * How a start_agent request ended (#673), once: the row goes, a wait on its handle returns, and unless a session
   * started, the person is shown why in the caller's session (not only the model, in a tool result). A request whose
   * call already answered "pending" is told to the caller as a message, since no call is left to answer it.
   * A refusal the person gave on the card while the call waited needs no line: the card itself says "Denied".
   */
  private endAgentStart(requestId: string | undefined, ended: { childId: string } | { error: string; person: string; denied?: boolean }): void {
    const rec = requestId ? this.host.children.agentStarts.get(requestId) : undefined
    if (!rec || rec.ended) return
    rec.ended = 'childId' in ended ? { childId: ended.childId } : { error: ended.error }
    rec.end()
    rec.stopWaiting?.()
    this.host.store.deleteAgentStartRequest(rec.req.requestId)
    if ('childId' in ended) return
    const { callerId } = rec.req
    if (!this.host.meta.has(callerId)) return
    if (!ended.denied || rec.detached) {
      this.host.onEvent({ type: 'notice', sessionId: callerId, level: 'warning', from: 'Centralu', label: 'agent request', audience: 'you', text: ended.person })
    }
    if (rec.detached) void this.tellAgentStartEnded(rec.req, ended.error)
  }

  /** The caller of a request that already answered "pending" hears how it ended (#673), as a message in its session */
  private async tellAgentStartEnded(req: AgentStartRequest, why: string): Promise<void> {
    await this.host.tellSession(
      req.callerId,
      `[Centralu] Your start_agent request ${req.requestId} did not start a session.\n` +
        `Agent: ${frameField(req.detail.tool)}\n` +
        `Task: ${frameField(req.detail.text)}\n\n` +
        `Reason: ${why.slice(0, 600)}`,
      { sessionId: HOST_SENDER, name: 'Centralu' },
      false,
    )
  }

  /**
   * Withdraws a request's card, when the session that asked withdraws it or is deleted (#673): the card closes, the
   * request ends with `person` shown, and whatever waits on the card hears no answer.
   */
  withdrawAgentStart(requestId: string, error: string, person: string): void {
    const rec = this.host.children.agentStarts.get(requestId)
    if (!rec || rec.ended) return
    this.endAgentStart(requestId, { error, person })
    this.host.withdrawHostAsk(requestId)
  }

  /**
   * A request the previous host left standing (#673, `agent_start_requests`): its card is raised again, and an
   * approval starts the child here, with the report armed, as the call would have. A request whose caller is gone ends.
   */
  resumeAgentStart(req: AgentStartRequest): void {
    const caller = this.host.meta.get(req.callerId)
    if (!caller) {
      this.host.store.deleteAgentStartRequest(req.requestId)
      return
    }
    const rec = this.openAgentStart(req)
    rec.detached = true
    /*
     * Allowed already and waiting for memory (#686): no card again, only the wait. Begun on the next turn of the event
     * loop: this runs inside the constructor, and the gate is wired just after it (`useMemoryGate`, main.ts)
     */
    if (req.allowed) {
      setImmediate(() => void this.startWhenMemory(rec))
      return
    }
    void (async () => {
      const decision = await this.host.askHost(req.callerId, req.detail, undefined, { requestId: req.requestId, shown: true })
      // The host is leaving again: the row stays for the next one
      if (decision === null && (this.host.handingOver || this.host.disposing)) return
      const consent = this.agentConsentFrom(req.callerId, req.projectId, decision)
      if (!consent.ok) {
        this.endAgentStart(req.requestId, { error: consent.error, person: agentStartPersonText(req, consent.why === 'denied' ? 'denied' : 'withdrawn'), denied: consent.why === 'denied' })
        return
      }
      await this.startWhenMemory(rec)
    })()
  }

  /** Whether the machine has no room for another agent now (#686): null when it has, or when no gate is wired (tests) */
  async memoryShort(): Promise<MemoryShortfall | null> {
    return this.host.memoryGate ? this.host.memoryGate.short() : null
  }

  /** A shortfall in the words the caller and the person read (#686) */
  lowMemory(short: MemoryShortfall): LowMemory {
    return { available: gigabytes(short.available), floor: gigabytes(short.floor), maxWaitMinutes: this.host.memoryGate?.maxWaitMinutes ?? 0 }
  }

  /**
   * Queues an allowed start until memory recovers (#686): the request is kept (stored, so a host swap carries it), marked
   * allowed, and answered "pending" with its handle; the wait goes on in the background (`startWhenMemory`).
   */
  private queueAgentStart(req: AgentStartRequest, short: MemoryShortfall): ChildRunResult {
    req.allowed = true
    const rec = this.host.children.agentStarts.get(req.requestId) ?? this.openAgentStart(req)
    this.host.store.putAgentStartRequest(req.requestId, req.callerId, req)
    rec.detached = true
    rec.lowMemory = this.lowMemory(short)
    void this.startWhenMemory(rec, short)
    return agentStartPending(req, rec.lowMemory)
  }

  /**
   * An allowed start (#673, #686): started now when memory allows; otherwise the person is told in the caller's session,
   * and it waits (oldest first, re-read every `MEMORY_RECHECK_MS`, at most `MEMORY_WAIT_MAX_MS`). It ends without a
   * session when withdrawn, when the caller goes, or when the bound passes; a host leaving keeps it stored for the next.
   * Once started, the caller is told when the child's turn ends, as for any start whose call already answered.
   */
  private async startWhenMemory(rec: AgentStartRecord, known?: MemoryShortfall): Promise<void> {
    const { req } = rec
    const short = known ?? (await this.memoryShort())
    if (short && this.host.memoryGate && !rec.ended) {
      if (!req.allowed) {
        req.allowed = true
        this.host.store.putAgentStartRequest(req.requestId, req.callerId, req)
      }
      rec.lowMemory = this.lowMemory(short)
      if (this.host.meta.has(req.callerId)) {
        this.host.onEvent({
          type: 'notice',
          sessionId: req.callerId,
          level: 'info',
          from: 'Centralu',
          label: 'waiting for memory',
          audience: 'you',
          text:
            `Starting ${req.detail.tool} (“${req.detail.text}”) waits for memory: ${rec.lowMemory.available} free, ${rec.lowMemory.floor} needed. ` +
            `It starts when memory frees up, or gives up after ${rec.lowMemory.maxWaitMinutes} minutes.`,
        })
      }
      const ctl = new AbortController()
      rec.stopWaiting = () => ctl.abort()
      const outcome = await this.host.memoryGate.wait(ctl.signal)
      rec.stopWaiting = undefined
      // Withdrawn while it waited, or the host is leaving: the stored request goes to the next host
      if (rec.ended || outcome === 'aborted' || this.host.handingOver || this.host.disposing) return
      if (outcome === 'timeout') {
        const error =
          `Memory stayed below ${rec.lowMemory.floor} for ${rec.lowMemory.maxWaitMinutes} minutes, so no agent was started. ` +
          `Close something or wait for other agents to finish, then call start_agent again. ${ASK_THE_PERSON}`
        this.endAgentStart(req.requestId, { error, person: agentStartPersonText(req, 'failed', `memory stayed below ${rec.lowMemory.floor} for ${rec.lowMemory.maxWaitMinutes} minutes`) })
        return
      }
    }
    if (rec.ended) return
    const project = this.host.store.listProjects().find((p) => p.id === req.projectId)
    const r = project
      ? await this.createAgentChild(req.callerId, { id: project.id, name: project.name, path: project.path }, req, { stage: 'creating' }, req.detail.preset)
      : { done: { ok: false as const, error: "This session's project is no longer registered." } }
    if ('key' in r) {
      this.endAgentStart(req.requestId, { childId: r.d.sessionId })
      this.flow.agentWorking(r.d)
    } else {
      const error = r.done.ok ? 'No session was created.' : r.done.error
      this.endAgentStart(req.requestId, { error, person: agentStartPersonText(req, 'failed', error) })
    }
  }

  /** At startup (#673): the start_agent requests the previous host left standing, raised again */
  restoreAgentStarts(): void {
    /*
     * start_agent requests the previous host left standing (#673): the person has not answered yet, so the card is
     * raised again in its session and an approval starts the child here. A request whose caller is gone ends.
     */
    for (const row of this.host.store.listAgentStartRequests()) {
      const req = readAgentStartRequest(row.request)
      if (!req || req.requestId !== row.requestId || req.callerId !== row.callerSessionId) {
        this.host.store.deleteAgentStartRequest(row.requestId)
        continue
      }
      this.resumeAgentStart(req)
    }
  }
}
