import type { ToolName } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import { mockSessionInfo } from './session-info.js'
import type { SessionStore } from './session-store.js'
import type { ToolsMock } from './tools.js'

/** The orchestrator seat: its tool (#63) and the session behind it */
export class OrchestratorMock {
  /** The orchestrator tool chosen on the intro screen (#63) — the real thing writes it to app_settings */
  private savedOrchestratorTool: ToolName | null = null
  get orchestratorTool(): ToolName {
    return this.savedOrchestratorTool ?? this.toolsMock.firstRegisteredTool()
  }
  set orchestratorTool(tool: ToolName) {
    this.savedOrchestratorTool = tool
  }
  readonly agents: Pick<AgentPort, 'orchestrator' | 'orchestratorPeek' | 'configureOrchestrator'> = {
    orchestrator: async () => {
      // The same rule as the real thing: creates one on the spot if there is none. Does not belong to a project
      const found = [...this.store.sessions.values()].find((x) => x.projectId === null)
      if (found) return found
      const id = `orc-${this.clock.next()}`
      const info = mockSessionInfo({
        // The same rule as the real thing: the tool follows the choice on the intro screen (#63)
        id,
        projectId: null,
        kind: 'orchestrator',
        tool: this.orchestratorTool,
        externalId: null,
        name: 'Orchestrator',
        createdAt: this.clock.now(),
      })
      this.store.sessions.set(id, info)
      return info
    },
    // The same rule as the real thing (#63): opening the screen only asks — creating it is orchestrator()'s job, at the first question
    orchestratorPeek: async () => [...this.store.sessions.values()].find((x) => x.projectId === null) ?? null,
    configureOrchestrator: async (tool: ToolName) => {
      this.orchestratorTool = tool
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly store: SessionStore,
    private readonly toolsMock: ToolsMock,
  ) {}
}
