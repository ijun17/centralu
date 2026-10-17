import type { ExternalSession, ToolName } from '@cc/protocol'
import type { AgentPort } from '../ports/index.js'
import type { SessionStore } from './session-store.js'

/** The previous conversations the tools pretend to have, behind `agents.listExternalSessions` */
export class ExternalSessionsMock {
  /** For tests: previous sessions the tool pretends to have. supported=false also reproduces an older tool version */
  externalSessions: { supported: boolean; reason?: string; sessions: ExternalSession[] } = {
    supported: true,
    sessions: [],
  }
  /** The previous conversation of a session chosen to be imported (externalId → list of lines) */
  externalHistory = new Map<string, { role: 'user' | 'assistant'; text: string }[]>()
  /** For tests: while true, a read of the list waits for `releaseExternalSessions()`, so the screen's wait can be seen */
  holdExternalSessions = false
  private readonly held: (() => void)[] = []
  releaseExternalSessions(): void {
    this.holdExternalSessions = false
    for (const go of this.held.splice(0)) go()
  }
  readonly agents: Pick<AgentPort, 'listExternalSessions'> = {
    listExternalSessions: async (_projectId: string, tool: ToolName, _limit = 30) => {
      if (this.holdExternalSessions) await new Promise<void>((go) => this.held.push(go))
      // The same rule as the host: the original held by a session that is not hidden is "already open"
      const known = new Map<string, string>()
      for (const s of this.store.sessions.values()) {
        if (s.tool !== tool) continue
        for (const key of [s.importedFrom, s.externalId]) {
          if (key && !known.has(key)) known.set(key, s.id)
        }
      }
      return {
        ...this.externalSessions,
        sessions: this.externalSessions.sessions
          .filter((s) => s.tool === tool)
          .map((s) => ({
            ...s,
            imported: known.has(s.externalId),
            importedAs: known.get(s.externalId) ?? null,
          })),
      }
    },
  }

  constructor(
    private readonly store: SessionStore,
  ) {}
}
