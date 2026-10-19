import type { ApprovalScope } from '@cc/protocol'
import type { DelegationHost } from './delegation-flow.js'

/**
 * What the approval rules reach of the session manager (#1143), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type ApprovalRulesHost = Pick<DelegationHost, 'store'>

/**
 * The remembered "always allow" answers (C-2, FR-3): written when a card is answered "always", read for a session's
 * launch, and listed and deleted from Settings. Moved out of the session manager as it was (#1143); what it reaches
 * of the manager is `ApprovalRulesHost`.
 */
export class ApprovalRules {
  constructor(private readonly host: ApprovalRulesHost) {}

  /** The settings screen must be able to see and delete rules (FR-3: make the outcome visible) */
  listApprovalRules(): {
    id: number
    scope: 'session' | 'project'
    matcher: string
    decision: string
    createdAt: number
    projectId: string | null
    sessionId: string | null
  }[] {
    return this.host.store
      .permissions.listApprovalRules()
      .filter((r) => r.matcher)
      .map((r) => ({
        id: r.id,
        scope: r.scope as 'session' | 'project',
        matcher: r.matcher,
        decision: r.decision,
        createdAt: r.createdAt,
        // Included so the settings screen can say which project or session this rule belongs to (#183)
        projectId: r.projectId,
        sessionId: r.sessionId,
      }))
  }

  deleteApprovalRule(id: number): void {
    this.host.store.permissions.deleteApprovalRule(id)
  }

  /**
   * Saved rules that apply to this session (session-scoped plus project-scoped). Only an `allow` of a scope this build
   * knows: a newer build may store another decision or scope (#384), and a rule that cannot be read allows nothing.
   * A project rule with no project (an earlier build stored one from a session with no project) belongs to no
   * project, so it applies to no session.
   */
  rulesFor(sessionId: string, projectId: string | null): string[] {
    return this.host.store
      .permissions.listApprovalRules()
      .filter((r) => r.decision === 'allow' && (r.scope === 'session' || r.scope === 'project'))
      .filter((r) => (r.sessionId ? r.sessionId === sessionId : r.projectId !== null && r.projectId === projectId))
      .map((r) => r.matcher)
      .filter(Boolean)
  }

  /**
   * Persisting the rule — the adapter only keeps it in memory, so this is needed for it to survive a
   * restart (C-2). `matcher` is the card's own key, which the caller has checked (`respondApproval`).
   * A session with no project (#994) has no project to remember for: its project answer is kept for the session.
   */
  rememberAlways(sessionId: string, sessionProjectId: string | null, scope: ApprovalScope | undefined, matcher: string): void {
    const projectId = scope === 'project' ? sessionProjectId : null
    this.host.store.permissions.addApprovalRule({
      scope: projectId !== null ? 'project' : 'session',
      sessionId: projectId !== null ? undefined : sessionId,
      projectId: projectId ?? undefined,
      matcher,
      decision: 'allow',
    })
  }
}
