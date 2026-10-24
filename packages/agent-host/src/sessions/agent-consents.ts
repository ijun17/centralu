import { randomUUID } from 'node:crypto'
import type { ApprovalDetail } from '@cc/protocol'
import type { DelegationHost } from './delegation-host.js'
import type { HostAskAnswer } from './host-cards.js'
import { ASK_THE_PERSON, ORCHESTRATOR_PLACE } from './start-agent-terms.js'

/** The person's answer on a start_agent card, read as consent; a refusal says whether they refused or nobody answered */
type AgentConsent = { ok: true } | { ok: false; error: string; why: 'denied' | 'withdrawn' }

/**
 * The person's consent for a session to start agents (#561, #673): the card, the project's trust as consent, and the
 * "always" answers remembered for the session or the project. Moved out of `AgentStartFlow` as it was (#428); what it
 * reaches of the manager is `DelegationHost`.
 */
export class AgentConsents {
  constructor(private readonly host: DelegationHost) {}

  /**
   * Sessions the person allowed to start agents "always for this session" (#561, `ensureAgentConsent`). Live only, like
   * `readGrants`: a restart asks again. The project-wide always is a stored consent instead.
   */
  readonly agentConsents = new Set<string>()

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
    if (detail.project.id && this.host.store.permissions.getProjectConsent(detail.project.id, detail.project.id, 'agents')) return { ok: true }
    if (this.trustIsAgentConsent(callerId, detail.project.id)) return { ok: true }
    const requestId = `ag-${randomUUID()}`
    if (this.host.meta.get(callerId)?.permissionPreset !== 'auto') onCard?.(requestId)
    return this.agentConsentFrom(callerId, detail.project.id, await this.host.askHost(callerId, detail, signal, { requestId }))
  }

  /** A `normal` or `edits` caller in a trusted project needs no card to start agents (#673): the project's trust, read now */
  private trustIsAgentConsent(callerId: string, projectId: string): boolean {
    const preset = this.host.meta.get(callerId)?.permissionPreset
    if (preset !== 'normal' && preset !== 'edits') return false
    return this.host.store.projects.listProjects().find((p) => p.id === projectId)?.trusted === true
  }

  /** The person's answer on a start_agent card, as consent (remembered where they chose "always") or a refusal */
  agentConsentFrom(callerId: string, projectId: string, decision: HostAskAnswer): AgentConsent {
    // The orchestrator's place is no project to remember it for (#853): always for the project is always for this session
    if (decision === 'always_project' && projectId === ORCHESTRATOR_PLACE) {
      this.agentConsents.add(callerId)
      return { ok: true }
    }
    if (decision === 'always_project') {
      this.host.store.permissions.setProjectConsent(projectId, projectId, 'agents')
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
}
