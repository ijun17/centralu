import type { SessionInfo } from '@cc/protocol'
import type { BusyAnswer } from '../adapters/contract.js'
import type { QueuedRequest } from '../dev-services/store.js'
import { agentDepthRefusal, recordAgentDepth } from './agent-depth.js'
import { taskLine } from './ask-project.js'
import type { Delegation } from './child-ownership.js'
import type { DelegationHost } from './delegation-host.js'
import { agentFrame, lowestPreset, presetWithin } from './start-agent.js'
import type { AgentStartFlow, StartAgentDelegations } from './start-agent-flow.js'
import { labelOf } from './transcript-view.js'

/** What a fork reaches of the rest of the delegation flow (`DelegationFlow`): start_agent's gates and the child's run */
export type ForkDelegations = Pick<StartAgentDelegations, 'startDelegation'> & { readonly starts: AgentStartFlow }

/**
 * A sub-session forked from a busy session's conversation for a requester (#677, `ifBusy: "fork"`), behind start_agent's
 * gates. Moved out of `DelegationFlow` as it was (#428); what it reaches of the rest of the flow is `ForkDelegations`,
 * of the manager `DelegationHost`.
 */
export class DelegationForks {
  constructor(
    private readonly host: DelegationHost,
    private readonly flow: ForkDelegations,
  ) {}

  // ── Requests to a busy session (#677) ────────────────────────────────────────────────────────────────────────

  /**
   * start_agent's rules for a fork (#677): it starts an agent, so it takes the same gates. The agent depth, the project's
   * trust and the per-project ceiling here; the person's consent when the fork is made (`ensureAgentConsent`).
   */
  forkGateError(callerId: string, target: SessionInfo): string | null {
    return this.forkTrustError(callerId, target) ?? this.flow.starts.agentCeilingError(callerId, target.projectId ?? '')
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
    const preset = lowestPreset(caller.permissionPreset, target.permissionPreset, ...(readOnly ? ['safe' as const] : []))
    const worktree = readOnly ? null : await this.flow.starts.agentWorktreeBranch(project, { task: text })
    if (worktree && 'error' in worktree) return { ok: false, error: `${worktree.error.replace('Start the agent without one.', 'Use fork_read for read-only work, or queue it.')}` }
    const consent = await this.flow.starts.ensureAgentConsent(
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
    const place = this.flow.starts.reservePlace(callerId, project.id)
    if ('error' in place) return { ok: false, error: place.error }
    try {
      /*
       * Memory (#686): no room for another agent now. The request is queued for the busy session instead (#677's queue,
       * `enqueue`), which starts no process: it goes in as a new turn there when the running one ends. Queued, not refused
       * (owner decision 2026-10-15); the requester reads that it was queued instead of forked, and why.
       */
      const short = await this.flow.starts.memoryShort()
      if (short) {
        const low = this.flow.starts.lowMemory(short)
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
          permissionPreset: lowestPreset(preset, this.host.meta.get(callerId)?.permissionPreset ?? 'safe', this.host.meta.get(target.id)?.permissionPreset ?? 'safe'),
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
      const cap = lateGate ? undefined : lowestPreset(this.host.meta.get(callerId)!.permissionPreset, this.host.meta.get(target.id)!.permissionPreset)
      const late = lateGate
        ? `No fork of "${target.name}": ${lateGate}.`
        : cap && !presetWithin(child.permissionPreset, cap)
          ? `No fork of "${target.name}": a preset was lowered to ${cap} while the fork was being made.`
          : null
      if (late) return this.flow.starts.abandonChild(child, late, worktree ? undefined : `Fork of ${target.name}`.slice(0, 48))
      if (!worktree) this.host.rename(child.id, `Fork of ${target.name}`.slice(0, 48))
      const key = `${callerId}>${child.id}`
      const d = this.flow.startDelegation(key, callerId, child.id, { id: project.id, name: project.name, path: child.worktree?.path ?? this.host.cwdFor(child) }, true)
      // The delegation counts the fork now
      place.release()
      try {
        await this.host.deliver(child.id, agentFrame(labelOf(this.host.store.messages, caller), text), undefined, { sessionId: callerId, name: labelOf(this.host.store.messages, caller) }, false)
      } catch (e) {
        d.wait.fail(e as Error)
        this.host.children.dropDelegation(key, d)
        return { ok: false, error: `The fork "${child.name}" [${child.id}] was made but did not take the request: ${(e as Error).message}` }
      }
      this.host.children.delegated(callerId, child.id, via, text)
      return { ok: true, key, d, fork: child }
    } finally {
      place.release()
    }
  }
}
