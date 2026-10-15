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

  readonly search = {
    messages: async (query: string) => this.searchResults.filter((r) => r.snippet.includes(query)),
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
