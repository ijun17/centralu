import { agentDepthRefusal } from './agent-depth.js'
import type { DelegationHost } from './delegation-host.js'
import { AGENT_CEILING } from './start-agent.js'
import { ASK_THE_PERSON, ORCHESTRATOR_PLACE } from './start-agent-terms.js'

/**
 * Whether a session may start an agent now (#561, #673, #867): what the start rests on in its caller, and the
 * per-project ceiling with the places starts under way hold. Moved out of `AgentStartFlow` as it was (#428); what it
 * reaches of the manager is `DelegationHost`.
 */
export class AgentStartGates {
  constructor(private readonly host: DelegationHost) {}

  /**
   * Places taken by starts between their ceiling check and the child's delegation (#673 review) — project id -> how
   * many. Counted by `agentCeilingError` with the running children, so starts at once cannot pass the ceiling together.
   */
  private readonly agentStartReserved = new Map<string, number>()

  /**
   * What a child's start rests on in its caller, read once the person allowed it and again once its session exists,
   * right before its delegation is registered: the caller is still here, its project still registered and trusted
   * (or the caller is `auto`), and it is still above the agent depth (#867), which `auto` does not open.
   */
  agentStartGateError(callerId: string, projectId: string): string | null {
    const caller = this.host.meta.get(callerId)
    if (!caller) return 'The session that asked is no longer here.'
    // The orchestrator's place is no project (#853): nothing to be registered or trusted
    if (projectId === ORCHESTRATOR_PLACE && caller.kind === 'orchestrator') return agentDepthRefusal(this.host, callerId, 'start agents')
    const now = this.host.store.projects.listProjects().find((p) => p.id === projectId)
    if (!now) return 'This session\'s project is no longer registered.'
    const auto = caller.permissionPreset === 'auto'
    if (now.trusted !== true && !auto) return `This session's project is no longer trusted, so it cannot start agents. ${ASK_THE_PERSON}`
    return agentDepthRefusal(this.host, callerId, 'start agents')
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

  /** A saved ceiling overrides the caller's preset default: auto unlimited, otherwise AGENT_CEILING. */
  agentCeilingError(callerId: string, projectId: string): string | null {
    const configured = this.host.uiPreferences().agentCeiling
    const ceiling = configured ?? (this.host.autoBoundaryOpen(callerId) ? 0 : AGENT_CEILING)
    if (ceiling === 0) return null
    // A start under way holds its place from its check (#673 review); a request still waiting on the person holds none
    const running =
      [...this.host.children.delegations.values()].filter((d) => {
        const child = this.host.meta.get(d.sessionId)
        // A session gone is no one's (#994 review); one with no project is the orchestrator's place (#853)
        return d.agent && !d.settled && !!child && (child.projectId ?? ORCHESTRATOR_PLACE) === projectId
      }).length +
      (this.agentStartReserved.get(projectId) ?? 0)
    if (running < ceiling) return null
    const whose = projectId === ORCHESTRATOR_PLACE ? 'you started' : "started by this project's sessions"
    return `${running} agents ${whose} are already working, the most at once. Wait for one (agent_session, action "wait") or stop one, then try again.`
  }
}
