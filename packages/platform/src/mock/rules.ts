import type { ProjectConsent, ProjectConsentKind } from '@cc/protocol'
import type { Emit } from './event-bus.js'

/** What the host remembers and lists: message search, permission rules and cross-project consents */
export class RulesMock {
  /** For tests: search and rule state */
  searchResults: { sessionId: string; seq: number; snippet: string }[] = []
  rulesList: {
    id: number
    scope: string
    matcher: string
    decision: string
    createdAt: number
    projectId?: string | null
    sessionId?: string | null
  }[] = []

  /** For tests: when set, a message search answers only once this settles (an answer that arrives late) */
  searchHold: Promise<void> | null = null
  readonly search = {
    messages: async (query: string) => {
      await this.searchHold
      return this.searchResults.filter((r) => r.snippet.includes(query))
    },
  }

  /** Remembered cross-project consents (#371) — a test seeds this, and revoking emits the host's event */
  consentsList: ProjectConsent[] = []
  readonly consents = {
    list: async () => structuredClone(this.consentsList),
    revoke: async (fromProjectId: string, toProjectId: string, kind: ProjectConsentKind) => {
      this.consentsList = this.consentsList.filter((c) => !(c.fromProjectId === fromProjectId && c.toProjectId === toProjectId && c.kind === kind))
      this.emit({ type: 'project_consents_changed' })
    },
  }

  /** Saves a permission rule as the host's store does (`addApprovalRule`), with the next id and the time it was made */
  addRule(rule: { scope: string; matcher: string; decision: string; projectId?: string | null; sessionId?: string | null }): void {
    const id = this.rulesList.reduce((max, r) => Math.max(max, r.id), 0) + 1
    this.rulesList.push({ id, createdAt: Date.now(), ...rule })
  }

  readonly rules = {
    list: async () => [...this.rulesList],
    remove: async (id: number) => {
      this.rulesList = this.rulesList.filter((r) => r.id !== id)
    },
  }

  constructor(
    private readonly emit: Emit,
  ) {}
}
