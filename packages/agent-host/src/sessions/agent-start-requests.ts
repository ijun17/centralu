import type { PermissionPreset } from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
} from '@cc/protocol'
import type { ChildRunResult } from '../adapters/contract.js'
import type { AgentConsents } from './agent-consents.js'
import type { AgentStartRecord, AgentStartRequest, Delegation, LowMemory } from './child-ownership.js'
import type { DelegationHost } from './delegation-host.js'
import { gigabytes, type MemoryShortfall } from './memory-gate.js'
import { ASK_THE_PERSON, ORCHESTRATOR_PLACE, agentStartPending, agentStartPersonText, orchestratorPlace, type StartProgress } from './start-agent-terms.js'

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

/** What a standing request reaches of the delegation flow (`DelegationFlow`): the answer for a child that started */
export type StandingRequestDelegations = {
  agentWorking(d: Delegation, arm?: boolean, observing?: boolean): ChildRunResult
}

/** What a standing request reaches of the rest of start_agent (`AgentStartFlow`): the child's start, the card read as consent */
export type StandingRequestSteps = Pick<AgentConsents, 'agentConsentFrom'> & {
  createAgentChild(
    callerId: string,
    project: { id: string; name: string; path: string },
    choice: Pick<AgentStartRequest, 'tool' | 'model' | 'effort' | 'worktreeBranch' | 'task' | 'unchecked' | 'lsp' | 'name'>,
    progress: StartProgress,
    approvedPreset?: PermissionPreset,
    requestId?: string,
  ): Promise<{ done: ChildRunResult } | { key: string; d: Delegation; notice: string | undefined }>
}

/**
 * A start_agent request that outlives its call (#673, #686): kept while its card stands or memory is short, in memory
 * and in the store, ended once with the reason told, withdrawn, resumed after a restart, and started once memory is
 * free. Moved out of `AgentStartFlow` as it was (#428); what it reaches of the rest of start_agent is
 * `StandingRequestSteps`, of the delegation flow `StandingRequestDelegations`, of the manager `DelegationHost`.
 */
export class AgentStartRequests {
  constructor(
    private readonly host: DelegationHost,
    private readonly flow: StandingRequestDelegations,
    private readonly starts: StandingRequestSteps,
  ) {}

  /** A start_agent request whose card now stands (#673): kept, in memory and in the store, until it is answered */
  openAgentStart(req: AgentStartRequest): AgentStartRecord {
    let end!: () => void
    const done = new Promise<void>((resolve) => (end = resolve))
    const rec: AgentStartRecord = { req, detached: false, done, end }
    this.host.children.addAgentStart(rec)
    this.host.store.children.putAgentStartRequest(req.requestId, req.callerId, req)
    return rec
  }

  /**
   * How a start_agent request ended (#673), once: the row goes, a wait on its handle returns, and unless a session
   * started, the person is shown why in the caller's session (not only the model, in a tool result). A request whose
   * call already answered "pending" is told to the caller as a message, since no call is left to answer it.
   * A refusal the person gave on the card while the call waited needs no line: the card itself says "Denied".
   */
  endAgentStart(requestId: string | undefined, ended: { childId: string } | { error: string; person: string; denied?: boolean }): void {
    const rec = requestId ? this.host.children.agentStarts.get(requestId) : undefined
    if (!rec || rec.ended) return
    rec.ended = 'childId' in ended ? { childId: ended.childId } : { error: ended.error }
    rec.end()
    rec.stopWaiting?.()
    this.host.store.children.deleteAgentStartRequest(rec.req.requestId)
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
      this.host.store.children.deleteAgentStartRequest(req.requestId)
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
      const consent = this.starts.agentConsentFrom(req.callerId, req.projectId, decision)
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
  queueAgentStart(req: AgentStartRequest, short: MemoryShortfall): ChildRunResult {
    req.allowed = true
    const rec = this.host.children.agentStarts.get(req.requestId) ?? this.openAgentStart(req)
    this.host.store.children.putAgentStartRequest(req.requestId, req.callerId, req)
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
        this.host.store.children.putAgentStartRequest(req.requestId, req.callerId, req)
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
    const caller = this.host.meta.get(req.callerId)
    const project = req.projectId === ORCHESTRATOR_PLACE && caller?.kind === 'orchestrator' ? orchestratorPlace(caller) : this.host.store.projects.listProjects().find((p) => p.id === req.projectId)
    const r = project
      ? await this.starts.createAgentChild(req.callerId, { id: project.id, name: project.name, path: project.path }, req, { stage: 'creating' }, req.detail.preset, req.requestId)
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
    for (const row of this.host.store.children.listAgentStartRequests()) {
      const req = readAgentStartRequest(row.request)
      if (!req || req.requestId !== row.requestId || req.callerId !== row.callerSessionId) {
        this.host.store.children.deleteAgentStartRequest(row.requestId)
        continue
      }
      this.resumeAgentStart(req)
    }
  }
}
