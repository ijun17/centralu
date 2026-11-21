import type { ExternalSession, ToolName } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { SessionStore } from './session-store.js'

/** The previous conversations the tools pretend to have, behind `agents.listExternalSessions` */
export class ExternalSessionsMock {
  /** `supported: false` stands for an older tool version */
  externalSessions: { supported: boolean; reason?: string; sessions: ExternalSession[] } = {
    supported: true,
    sessions: [],
  }
  /** externalId → the conversation an import brings */
  externalHistory = new Map<string, { role: 'user' | 'assistant'; text: string }[]>()
  /** While true, a read waits for `releaseExternalSessions()` */
  holdExternalSessions = false
  private readonly held: (() => void)[] = []
  releaseExternalSessions(): void {
    this.holdExternalSessions = false
    for (const go of this.held.splice(0)) go()
  }
  readonly agents: Pick<AgentPort, 'listExternalSessions'> = {
    listExternalSessions: async (_projectId: string, tool: ToolName, _limit = 30) => {
      if (this.holdExternalSessions) await new Promise<void>((go) => this.held.push(go))
      // As the host: an original a session that is not hidden holds is "already open"
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
