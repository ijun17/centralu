import type { ProjectConsent, ProjectConsentKind } from '@cc/protocol'
import type { DelegationHost } from './delegation-flow.js'
import type { QueuedRequests } from './queued-requests.js'
import type { SessionTrashHost } from './session-trash.js'

/**
 * What the cross-project consents reach of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type ProjectConsentsHost = Pick<DelegationHost, 'askHost' | 'emit' | 'meta' | 'store'> &
  Pick<SessionTrashHost, 'appsHub'> &
  Pick<QueuedRequests, 'withdrawReaches'>

/**
 * Whether a session of one project may reach another (#371): the person's card, a remembered "always" for the pair,
 * the list Settings shows and its revoke. Moved out of the session manager as it was (#428); what it reaches of the
 * manager is `ProjectConsentsHost`.
 */
export class ProjectConsents {
  constructor(private readonly host: ProjectConsentsHost) {}

  /**
   * Whether a session of one project may reach another (#371) — the one gate for both parts: 'delegate'
   * (ask_project) and 'apps' (another project's app tools). Same project needs no consent. A remembered "always" for
   * the pair and kind passes at once; otherwise a card stands in the calling session (the same slot as an approval,
   * so it waits behind one already up) until the person answers or `signal` fires.
   *
   *   allow once   passes this call only
   *   always       remembered for (caller's project, target, kind) — listed and revoked in Settings
   *   deny         refused, and not remembered: the next call asks again, like a denied approval
   *
   * The refusal is worded for the model that called: what happened and that it should not retry on its own.
   */
  async ensureProjectAccess(
    callerSessionId: string,
    toProjectId: string,
    access: ProjectConsentKind,
    what: { text: string; app?: { appId: string; name: string }; session?: { id: string; name: string } },
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const caller = this.host.meta.get(callerSessionId)
    if (!caller) return { ok: false, error: 'The calling session is gone' }
    const fromId = caller.projectId
    if (!fromId) return { ok: false, error: 'This session belongs to no project, so it cannot reach another project' }
    if (fromId === toProjectId) return { ok: true }
    const projects = this.host.store.projects.listProjects()
    const from = projects.find((p) => p.id === fromId)
    const to = projects.find((p) => p.id === toProjectId)
    if (!from || !to) return { ok: false, error: 'That project is no longer registered' }
    if (this.host.store.getProjectConsent(fromId, toProjectId, access)) return { ok: true }
    const decision = await this.host.askHost(
      callerSessionId,
      {
        kind: 'project_access',
        access,
        from: { id: from.id, name: from.name },
        // Said on the card (#382): the selected session there follows its trust, so the person should know before allowing
        to: { id: to.id, name: to.name, trusted: to.trusted },
        text: what.text,
        ...(what.app ? { app: what.app } : {}),
        ...(what.session ? { session: what.session } : {}),
      },
      signal,
    )
    // Either project may have been removed while the card stood: nothing is remembered for a pair that no longer exists
    const both = this.host.store.projects.listProjects()
    if (decision !== null && (!both.some((p) => p.id === fromId) || !both.some((p) => p.id === toProjectId))) {
      return { ok: false, error: 'That project is no longer registered' }
    }
    if (decision === 'always') {
      this.host.store.setProjectConsent(fromId, toProjectId, access)
      this.host.emit({ type: 'project_consents_changed' })
      return { ok: true }
    }
    if (decision === 'allow') return { ok: true }
    if (decision === 'deny') {
      return { ok: false, error: `The person did not allow ${from.name} to reach ${to.name} this way. Do not ask again unless they tell you to.` }
    }
    return { ok: false, error: `The question to the person was withdrawn before they answered, so ${to.name} was not reached.` }
  }

  /** Every remembered cross-project consent, with the projects' names as they are now (#371, Settings) */
  projectConsents(): ProjectConsent[] {
    const names = new Map(this.host.store.projects.listProjects().map((p) => [p.id, p.name]))
    return this.host.store.listProjectConsents().map((c) => ({
      ...c,
      fromName: names.get(c.fromProjectId) ?? '(project no longer exists)',
      toName: names.get(c.toProjectId) ?? '(project no longer exists)',
    }))
  }

  /**
   * Revokes one remembered consent (#371) — the next reach asks again. A delegation already running is left to finish;
   * an ask for the pair still queued is not delivered (`withdrawReaches`)
   */
  revokeProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): void {
    if (!this.host.store.forgetProjectConsent(fromProjectId, toProjectId, kind)) return
    this.host.emit({ type: 'project_consents_changed' })
    if (kind === 'delegate') {
      this.host.withdrawReaches(
        () => false,
        (_r, from, to) => from === fromProjectId && to === toProjectId,
        'The person revoked the consent for the asking project to ask this one.',
        true,
      )
    }
    // Apps attached under that "always" step back now (#371 part A): the sessions recount, and the app is gone from them
    if (kind === 'apps') this.host.appsHub?.rt.sharingChanged()
  }
}
