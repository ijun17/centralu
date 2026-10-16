import type { WorktreeRecovery } from '../dev-services/worktree-recovery.js'
import { randomUUID } from 'node:crypto'
import type { QueuedRequest } from '../dev-services/store.js'
import type { AgentStartRecord, AgentStartRequest, ChildOwnership, Delegation, LowMemory } from './child-ownership.js'
import type { AppRef } from '../apps/external/runtime.js'
import { AgentRunWait, finalAnswer } from './app-agents.js'
import { ASK_WAIT_MS, clipAnswer, pathsIn, readableGrants, taskLine } from './ask-project.js'
import { AGENT_CEILING, agentBranch, agentChoice, agentFrame, agentNoteFrame, agentName, presetWithin } from './start-agent.js'
import { labelOf } from './transcript-view.js'
import type {
  ApprovalDetail,
  BackgroundTask,
  ProjectConsentKind,
  ModelOption,
  Attachment,
  CreateSessionParams,
  NormalizedEvent,
  PermissionPreset,
  SessionInfo,
  ToolName,
  UiPreferences } from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
  liveBackgroundTasks,
} from '@cc/protocol'
import { inTurn } from '../idle.js'
import type { AgentAdapter, BusyAnswer, BusyChoice, ChildRunResult, AgentSessionOpts, RoutedCard, StartAgentOpts, LinkedSessions, SessionHandle } from '../adapters/contract.js'
import { gigabytes, type MemoryGate, type MemoryShortfall } from './memory-gate.js'
import type { Store } from '../dev-services/store.js'
import {
  gitSummary,
  gitValidBranchName,
} from '../dev-services/git.js'
import type { HostAsk, HostAskAnswer } from './host-cards.js'

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
function agentStartPending(req: AgentStartRequest, lowMemory?: LowMemory): ChildRunResult {
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

/**
 * What the delegation flow reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type DelegationHost = {
  readonly adapters: Map<string, AgentAdapter>
  readonly agentRuns: Map<string, AgentRunWait>
  answerRoutedCard: (callerId: string, sessionId: string, card: string | undefined, text: string) => Promise<ChildRunResult>
  applyDeferredRestart: (sessionId: string) => void
  askHost: (sessionId: string, detail: HostAsk["detail"], signal?: AbortSignal, card?: { requestId?: string; shown?: boolean; }) => Promise<HostAskAnswer>
  autoBoundaryOpen: (sessionId: string, boundary?: string) => boolean
  builderRefOf: (m: Pick<SessionInfo, "id" | "appId" | "projectId">) => AppRef | null
  busyAnswer: (callerId: string, target: SessionInfo, from: QueuedRequest["via"]) => Extract<BusyAnswer, { state: "busy"; }>
  busyChoices: (callerId: string, target: SessionInfo, from: QueuedRequest["via"]) => BusyChoice[]
  busyForCaller: (callerId: string, sessionId: string) => boolean
  readonly children: ChildOwnership
  cleanUpWorktreeChild: (target: SessionInfo) => Promise<{ ok: true; branch: string; setAside: { changedFiles: number; commits: number; }; warning?: string; note?: string; } | { ok: false; error: string; }>
  createSession: (params: Omit<CreateSessionParams, "projectId" | "tool"> & { projectId: string | null; tool: ToolName | null; kind?: Exclude<SessionInfo["kind"], "coordinator">; roleAppend?: string; appId?: string | null; builderOf?: AppRef; appAgent?: { outputSchema?: Record<string, unknown>; }; askedBy?: string; forkedFrom?: string; lsp?: boolean; }) => Promise<SessionInfo>
  cwdFor: (m: SessionInfo) => string
  deliver: (sessionId: string, text: string, attachments: Attachment[] | undefined, from: { sessionId: string; name: string } | undefined, relayed: boolean, fromApp?: undefined, fromAppVia?: 'inline', sendInput?: (handle: SessionHandle, text: string) => void) => Promise<void>
  readonly disposing: boolean
  readonly emit: (e: NormalizedEvent) => void
  enqueue: (callerId: string, target: SessionInfo, via: QueuedRequest["via"], text: string) => Extract<BusyAnswer, { state: "queued"; }>
  ensureProjectAccess: (callerSessionId: string, toProjectId: string, access: ProjectConsentKind, what: { text: string; app?: { appId: string; name: string; }; session?: { id: string; name: string; }; }, signal?: AbortSignal) => Promise<{ ok: true; } | { ok: false; error: string; }>
  firstTool: (preferred?: ToolName | null) => ToolName | null
  gitTrust: (projectId: string | null) => { trusted: boolean; }
  readonly handingOver: boolean
  readonly handles: Map<string, SessionHandle>
  readonly linkedReader: LinkedSessions | null
  readonly memoryGate: MemoryGate | null
  readonly meta: Map<string, SessionInfo>
  modelsWithin: (tool: ToolName, ms: number, fresh?: boolean) => Promise<{ models: ModelOption[]; cached: boolean; } | null>
  onEvent: (raw: NormalizedEvent, from?: SessionHandle | null) => void
  ownTasksRunning: (sessionId: string) => BackgroundTask[]
  pauseReport: (sessionId: string, running: readonly BackgroundTask[]) => void
  pausedTasksNow: (sessionId: string) => BackgroundTask[]
  queuedOf: (callerId: string, sessionId: string) => ChildRunResult | undefined
  readonly readGrants: Map<string, Set<string>>
  rename: (sessionId: string, name: string) => void
  reportBackIfAwaited: (sessionId: string, ending: NormalizedEvent, answer?: string, settled?: readonly BackgroundTask[]) => Promise<void>
  routedCards: (sessionId: string, callerId: string) => RoutedCard[]
  readonly running: Map<string, { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset; }>
  sleepSession: (sessionId: string) => Promise<boolean>
  stopBackgroundTask: (sessionId: string, taskId: string) => Promise<void>
  readonly store: Store
  trashSession: (sessionId: string, removeWorktree?: boolean, removeExternal?: boolean, recovery?: WorktreeRecovery, fromCleanup?: boolean) => Promise<void>
  readonly trashing: Map<string, Promise<void>>
  readonly turnObservers: Map<string, Set<AgentRunWait>>
  uiPreferences: () => UiPreferences
  untilCard: (sessionId: string, callerId: string) => { asked: Promise<"asked">; done(): void; }
  withdrawHostAsk: (requestId: string) => void
}

/**
 * The work one session gives another (#428): ask_project's delegations (#371 part B; linked machines, #700), start_agent
 * and its requests (#561, #673, #686), agent_session (#561), and the waits on them, over `ChildOwnership`. Moved out of
 * the session manager as it was; what it reaches of the manager is `DelegationHost`.
 */
export class DelegationFlow {
  constructor(private readonly host: DelegationHost) {}

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

  /** Registers the wait on the delegated session's turn (the same watcher an app's agent uses, `AgentRunWait`) */
  startDelegation(key: string, callerId: string, sessionId: string, target: { id: string; name: string; path: string }, agent = false, joinedTurn = false): Delegation {
    let notice: string | undefined
    let answerAfter = this.host.meta.get(sessionId)?.lastSeq ?? 0
    const wait = new AgentRunWait((message) => (notice = message), () => this.host.meta.get(sessionId)?.name ?? 'the session', undefined, () => {
      // Queued turns have no new stored user row: their input was recorded before the previous answer.
      const answer = finalAnswer(this.host.store.loadMessages(sessionId, 50).filter((m) => m.seq > answerAfter))
      answerAfter = this.host.meta.get(sessionId)?.lastSeq ?? answerAfter
      return answer
    })
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
    // A note's reader reads each turn's answer on its own, as a delegation does: queued turns have no user row between them
    let answerAfter = this.host.meta.get(child.id)?.lastSeq ?? 0
    const wait = shared ?? new AgentRunWait(() => {}, () => child.name, undefined, own
      ? () => {
          const answer = finalAnswer(this.host.store.loadMessages(child.id, 50).filter((m) => m.seq > answerAfter))
          answerAfter = this.host.meta.get(child.id)?.lastSeq ?? answerAfter
          return answer
        }
      : () => finalAnswer(this.host.store.loadMessages(child.id, 50)))
    const project = this.host.store.listProjects().find((p) => p.id === child.projectId)
    const target = { id: child.projectId ?? '', name: project?.name ?? '', path: this.host.store.sessionCwd(child.id) ?? project?.path ?? '' }
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
          resolve(this.handedOverAnswer(callerId, standing.req.requestId) ?? agentStartPending(standing.req, standing.lowMemory))
          return
        }
        ctl.abort()
        const d = progress.stage === 'created' ? progress.d : undefined
        // The child exists and its run is registered: answered as the normal path does, with the report armed
        if (d) {
          const notice = [progress.unchecked, this.host.handles.get(d.sessionId)?.delegationNotice?.()].filter(Boolean).join('; ')
          const working = this.agentWorking(d)
          resolve(working.ok && notice ? { ...working, notice: [working.notice, notice].filter(Boolean).join('; ') } : working)
        } else resolve(startAgentLate(progress))
      }, START_AGENT_SETUP_MS)
    })
    let set: Awaited<ReturnType<DelegationFlow['setUpAgent']>>
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
      void setup.then((r) => { if ('key' in r) this.agentWorking(r.d) }, () => {})
      return set.done
    }
    const { key, d, notice } = set
    // What the setup used comes off the wait, so the whole call ends inside the bridge's bound
    const left = Math.max(1_000, START_AGENT_CALL_MS - (Date.now() - startedAt))
    const result = opts.wait === false ? this.agentWorking(d) : await this.awaitAgent(key, d, signal, false, Math.min(ASK_WAIT_MS, left))
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
        this.agentWorking(r.d)
      }
      return done(this.handedOverAnswer(callerId, request.requestId) ?? { ok: false, error: 'The request was handed over to another session.' })
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
  private async abandonChild(child: SessionInfo, why: string, name?: string): Promise<{ ok: false; error: string }> {
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
  private reservePlace(callerId: string, projectId: string): { release: () => void } | { error: string } {
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
    const d = this.startDelegation(key, callerId, child.id, { id: project.id, name: project.name, path: child.worktree?.path ?? cwd }, true)
    // The delegation counts the child now
    release()
    progress.d = d
    try {
      await this.host.deliver(child.id, agentFrame(labelOf(this.host.store, caller), choice.task), undefined, { sessionId: callerId, name: labelOf(this.host.store, caller) }, false)
    } catch (e) {
      this.host.children.dropDelegation(key)
      if (this.host.agentRuns.get(child.id) === d.wait) this.host.agentRuns.delete(child.id)
      this.host.children.releaseTurn(child.id, callerId)
      return done({ ok: false, error: `Could not give the task to the new session: ${(e as Error).message}` })
    }
    const notice = this.host.handles.get(child.id)?.delegationNotice?.()
    return { key, d, notice: [unchecked, notice].filter(Boolean).join('; ') || undefined }
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
    if (!caller?.projectId || !child || (!startedHere && (deletingWithoutWorktree || !this.host.autoBoundaryOpen(callerId, 'session ownership'))) || child.projectId !== caller.projectId) {
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
          if (!observing) this.host.children.dropDelegation(key)
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
            if (d) this.host.children.dropDelegation(key)
            return { ok: true, state: 'deleted', sessionId: child.id, sessionName: child.name, tool: child.tool }
          }
          if (d && !d.settled) return { ok: false, error: `"${child.name}" is still working on what you gave it — stop it or wait first.` }
          // A timer the tool held (`/loop`) does not hold the cleanup (#718): it ends with the process, and the caller is told
          const timers = this.host.handles.has(child.id) ? liveBackgroundTasks(child.backgroundTasks).filter((t) => t.timer) : []
          const r = await this.host.cleanUpWorktreeChild(child)
          if (!r.ok) return r
          if (d) this.host.children.dropDelegation(key)
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
          const from = { sessionId: callerId, name: labelOf(this.host.store, caller) }
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
          const full = this.agentCeilingError(callerId, child.projectId ?? '')
          if (full) return { ok: false, error: full }
          const project = this.host.store.listProjects().find((p) => p.id === child.projectId)
          const cwd = this.host.store.sessionCwd(child.id) ?? child.worktree?.path ?? project?.path ?? ''
          const next = this.startDelegation(key, callerId, child.id, { id: child.projectId ?? '', name: project?.name ?? '', path: cwd }, true)
          try {
            await this.host.deliver(child.id, agentFrame(from.name, opts.text ?? ''), undefined, from, false)
          } catch (e) {
            this.host.children.dropDelegation(key)
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
        this.withdrawAgentStart(id, 'The session that asked withdrew the request.', agentStartPersonText(rec.req, 'stopped'))
        return { ok: true, state: 'stopped', sessionId: id, sessionName: '', tool: rec.req.detail.tool }
      }
      if (action === 'send') {
        const on = rec.lowMemory ? 'memory to start' : "the person's answer"
        return { ok: false, error: `No session yet: request ${id} is still waiting for ${on}. Send once it has started.` }
      }
      if (action === 'wait') {
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        const owner = rec.req.callerId
        const leaving = this.untilHandedOver(rec)
        const r = await Promise.race([
          leaving.gone,
          rec.done,
          new Promise<void>((resolve) => (timer = setTimeout(resolve, ASK_WAIT_MS))),
          new Promise<void>((resolve) => {
            if (!signal) return
            onAbort = resolve
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', onAbort, { once: true })
          }),
        ])
        clearTimeout(timer)
        leaving.done()
        if (onAbort) signal?.removeEventListener('abort', onAbort)
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
   * The branch a child's new worktree goes on (#561 part 2): the one asked for, checked by git's own rule, or one
   * named from the job (`agentBranch`). Refused before the card when the project is no git repository, so the person
   * is never asked about a worktree that cannot be made.
   */
  private async agentWorktreeBranch(project: { id: string; path: string }, opts: StartAgentOpts): Promise<{ branch: string } | { error: string }> {
    const summary = await gitSummary(project.path, this.host.gitTrust(project.id))
    if (!summary.isRepo) return { error: 'This project is not a git repository, so it has no worktrees. Start the agent without one.' }
    const asked = opts.branch?.trim()
    if (asked) return (await gitValidBranchName(asked)) ? { branch: asked } : { error: `Not a valid branch name: ${asked}` }
    return { branch: agentBranch(opts.task, randomUUID()) }
  }

  /** A saved ceiling overrides the caller's preset default: auto unlimited, otherwise AGENT_CEILING. */
  private agentCeilingError(callerId: string, projectId: string): string | null {
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
  private async ensureAgentConsent(
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
  private agentDepthBlocked(caller: SessionInfo): boolean {
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
    if (this.host.handingOver || this.host.disposing || !this.host.meta.has(req.callerId)) return
    try {
      await this.host.deliver(
        req.callerId,
        `[Centralu] Your start_agent request ${req.requestId} did not start a session.\n` +
          `Agent: ${frameField(req.detail.tool)}\n` +
          `Task: ${frameField(req.detail.text)}\n\n` +
          `Reason: ${why.slice(0, 600)}`,
        undefined,
        { sessionId: HOST_SENDER, name: 'Centralu' },
        false,
      )
    } catch {
      // The caller may be asleep or deleted — the notice in its session is already there
    }
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
      this.agentWorking(r.d)
    } else {
      const error = r.done.ok ? 'No session was created.' : r.done.error
      this.endAgentStart(req.requestId, { error, person: agentStartPersonText(req, 'failed', error) })
    }
  }

  /**
   * "Working": the caller is told when the turn ends (#561), through the report the orchestrator's reportBack uses, unless
   * a call is waiting on it by then (`awaitAgent` takes the marker down while it waits)
   */
  private agentWorking(d: Delegation, arm = true, observing = false): ChildRunResult {
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
    if (this.host.handingOver || !this.host.meta.has(observerId)) return
    const name = this.host.meta.get(sessionId)?.name ?? sessionId
    try {
      await this.host.deliver(
        observerId,
        `[Centralu] Your note to another session was not delivered.\n` +
          `Session: ${frameField(name)}\n` +
          `id: ${sessionId}\n\n` +
          `Reason: ${why.slice(0, 600)}\n\n` +
          `Send it again with agent_session, or read that session's recent conversation with read_session.`,
        undefined,
        { sessionId, name },
        true,
      )
    } catch {
      // The observer may be asleep or deleted — a notice must not destabilize the host
    }
  }

  /** The owner's view of its delegated turn waiting on cards (#676), for start_agent and agent_session */
  private agentAsking(d: Delegation, cards: RoutedCard[]): ChildRunResult {
    // Told when it ends, as a wait past its bound is: the answer to the card lets the turn go on without this call
    this.host.children.markReport(d.sessionId, d.callerId)
    return { ok: true, state: 'asking', sessionId: d.sessionId, sessionName: this.host.meta.get(d.sessionId)?.name ?? d.sessionId, tool: this.host.meta.get(d.sessionId)?.tool ?? '', cards }
  }

  // ── Requests to a busy session (#677) ────────────────────────────────────────────────────────────────────────

  /**
   * start_agent's rules for a fork (#677): it starts an agent, so it takes the same gates. Depth one, the project's
   * trust and the per-project ceiling here; the person's consent when the fork is made (`ensureAgentConsent`).
   */
  forkGateError(callerId: string, target: SessionInfo): string | null {
    return this.forkTrustError(callerId, target) ?? this.agentCeilingError(callerId, target.projectId ?? '')
  }

  /** `forkGateError` without the ceiling: read before the card and again once it is answered (`forkFor`) */
  private forkTrustError(callerId: string, target: SessionInfo): string | null {
    const caller = this.host.meta.get(callerId)
    if (!caller) return 'the requesting session is gone'
    if (!this.host.meta.has(target.id)) return 'it is no longer here'
    if (this.agentDepthBlocked(caller) && !this.host.autoBoundaryOpen(callerId)) {
      return 'this session was itself started or asked by another session, so it cannot start a sub-session'
    }
    const project = this.host.store.listProjects().find((p) => p.id === target.projectId)
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
    const project = this.host.store.listProjects().find((p) => p.id === target.projectId)!
    const PRESETS: PermissionPreset[] = ['safe', 'normal', 'auto']
    const lowest = (...ps: PermissionPreset[]) => PRESETS[Math.min(...ps.map((p) => PRESETS.indexOf(p)))]!
    const preset = lowest(caller.permissionPreset, target.permissionPreset, ...(readOnly ? ['safe' as const] : []))
    const worktree = readOnly ? null : await this.agentWorktreeBranch(project, { task: text })
    if (worktree && 'error' in worktree) return { ok: false, error: `${worktree.error.replace('Start the agent without one.', 'Use fork_read for read-only work, or queue it.')}` }
    const consent = await this.ensureAgentConsent(
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
    const place = this.reservePlace(callerId, project.id)
    if ('error' in place) return { ok: false, error: place.error }
    try {
      /*
       * Memory (#686): no room for another agent now. The request is queued for the busy session instead (#677's queue,
       * `enqueue`), which starts no process: it goes in as a new turn there when the running one ends. Queued, not refused
       * (owner decision 2026-10-15); the requester reads that it was queued instead of forked, and why.
       */
      const short = await this.memoryShort()
      if (short) {
        const low = this.lowMemory(short)
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
      // Copying and making the session took a while: the gates are read again, with no wait before the delegation
      const lateGate = this.forkTrustError(callerId, target)
      const cap = lateGate ? undefined : lowest(this.host.meta.get(callerId)!.permissionPreset, this.host.meta.get(target.id)!.permissionPreset)
      const late = lateGate
        ? `No fork of "${target.name}": ${lateGate}.`
        : cap && !presetWithin(child.permissionPreset, cap)
          ? `No fork of "${target.name}": a preset was lowered to ${cap} while the fork was being made.`
          : null
      if (late) return this.abandonChild(child, late, worktree ? undefined : `Fork of ${target.name}`.slice(0, 48))
      if (!worktree) this.host.rename(child.id, `Fork of ${target.name}`.slice(0, 48))
      const key = `${callerId}>${child.id}`
      const d = this.startDelegation(key, callerId, child.id, { id: project.id, name: project.name, path: child.worktree?.path ?? this.host.cwdFor(child) }, true)
      // The delegation counts the fork now
      place.release()
      try {
        await this.host.deliver(child.id, agentFrame(labelOf(this.host.store, caller), text), undefined, { sessionId: callerId, name: labelOf(this.host.store, caller) }, false)
      } catch (e) {
        d.wait.fail(e as Error)
        this.host.children.dropDelegation(key)
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
      answer: clipAnswer(finalAnswer(this.host.store.loadMessages(child.id, 50)), child.name),
      sessionState: child.state,
      ...(child.interruption ? { interruption: child.interruption } : {}),
      ...(notice ? { notice } : {}),
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

  /** Waits on a child's turn up to the bound (#561), like `awaitDelegation`, and reads its outcome for the caller */
  private async awaitAgent(key: string, d: Delegation, signal?: AbortSignal, observing = false, boundMs = ASK_WAIT_MS): Promise<ChildRunResult> {
    // Only the owner consumes its report/key/grants. Auto observers have their own bound and cancellation.
    // A report held over the child's own background work (#721) is the work's end, still to come: reading the paused
    // turn's answer does not take it
    if (!observing && this.host.children.awaitingReport.get(d.sessionId) === d.callerId && !this.host.children.pausedReports.has(d.sessionId)) this.host.children.clearReport(d.sessionId)
    const endedBefore = d.settled
    // A card already waiting on the caller is what it reads first (#676): the turn goes nowhere until it is answered
    const standing = observing || d.settled ? [] : this.host.routedCards(d.sessionId, d.callerId)
    if (standing.length) return this.agentAsking(d, standing)
    const name = () => this.host.meta.get(d.sessionId)?.name ?? d.sessionId
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const bound = new Promise<'bound'>((resolve) => (timer = setTimeout(() => resolve('bound'), boundMs)))
    const aborted = new Promise<'aborted'>((resolve) => {
      if (!signal) return
      onAbort = () => resolve('aborted')
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    const card = observing ? undefined : this.host.untilCard(d.sessionId, d.callerId)
    // A handoff that gives the child away ends this wait (#693): the answer is the new owner's, never read twice
    const owner = d.callerId
    const leaving = observing ? undefined : this.untilHandedOver(d)
    if (!observing) d.waiters = (d.waiters ?? 0) + 1
    try {
      const r = await Promise.race([d.outcome, bound, aborted, ...(card ? [card.asked] : []), ...(leaving ? [leaving.gone] : [])])
      if (!observing) d.waiters = (d.waiters ?? 1) - 1
      if (r === 'handedOver') return this.handedOverReply(owner, d.sessionId)
      if (r === 'asked') {
        const cards = this.host.routedCards(d.sessionId, d.callerId)
        return cards.length ? this.agentAsking(d, cards) : this.agentWorking(d)
      }
      if (r === 'aborted') {
        if (observing) return { ok: false, error: `The observation was cancelled; "${name()}" was left running.` }
        d.stop('the call that started it was cancelled')
        await d.outcome
        this.host.children.dropDelegation(key)
        return { ok: false, error: `The call was cancelled, so "${name()}" was stopped.` }
      }
      if (r === 'bound') return this.agentWorking(d, !observing, observing)
      if (!observing) this.host.children.dropDelegation(key, d)
      if (!r.ok) return { ok: false, error: `"${name()}" [${d.sessionId}] did not finish: ${r.error}. Tell the person, or give it a clearer task.` }
      const answer = r.answer ?? finalAnswer(this.host.store.loadMessages(d.sessionId, 50))
      if (observing) return {
        ok: true, state: 'done', sessionId: d.sessionId, sessionName: name(),
        tool: this.host.meta.get(d.sessionId)?.tool ?? '', answer: clipAnswer(answer, name()), readable: [], outside: [],
      }
      // Paths it names in its folder become readable to the caller, as ask_project's do: a child in another
      // folder (a worktree, #561 part 2) is outside the caller's own
      const { granted, outside } = readableGrants(pathsIn(answer), d.target.path)
      if (granted.length) {
        const set = this.host.readGrants.get(d.callerId) ?? new Set<string>()
        for (const g of granted) set.add(g)
        this.host.readGrants.set(d.callerId, set)
      }
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
      return {
        ok: true,
        state: 'done',
        sessionId: d.sessionId,
        sessionName: name(),
        tool: this.host.meta.get(d.sessionId)?.tool ?? '',
        answer: clipAnswer(answer, name()),
        readable: granted,
        outside,
        ...(notice ? { notice } : {}),
      }
    } finally {
      card?.done()
      leaving?.done()
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
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

  private handedOverAnswer(callerId: string, id: string): { ok: false; error: string } | undefined {
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
