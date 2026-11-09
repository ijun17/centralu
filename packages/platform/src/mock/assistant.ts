import type { ToolName } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import { mockSessionInfo } from './session-info.js'
import type { SessionStore } from './session-store.js'
import type { ToolsMock } from './tools.js'

/** The Assistant seat: its tool (#63) and the session behind it */
export class AssistantMock {
  /** The Assistant tool chosen on the intro screen (#63) — the real thing writes it to app_settings */
  private savedAssistantTool: ToolName | null = null
  get assistantTool(): ToolName {
    return this.savedAssistantTool ?? this.toolsMock.firstRegisteredTool()
  }
  set assistantTool(tool: ToolName) {
    this.savedAssistantTool = tool
  }
  readonly agents: Pick<AgentPort, 'assistant' | 'assistantPeek' | 'configureAssistant'> = {
    assistant: async () => {
      // The same rule as the real thing: creates one on the spot if there is none. Does not belong to a project
      const found = [...this.store.sessions.values()].find((x) => x.projectId === null)
      if (found) return found
      const id = `orc-${this.clock.next()}`
      const info = mockSessionInfo({
        // The same rule as the real thing: the tool follows the choice on the intro screen (#63)
        id,
        projectId: null,
        kind: 'orchestrator',
        tool: this.assistantTool,
        externalId: null,
        name: 'Assistant',
        createdAt: this.clock.now(),
      })
      this.store.sessions.set(id, info)
      return info
    },
    // The same rule as the real thing (#63): opening the screen only asks — creating it is assistant()'s job, at the first question
    assistantPeek: async () => [...this.store.sessions.values()].find((x) => x.projectId === null) ?? null,
    configureAssistant: async (tool: ToolName) => {
      this.assistantTool = tool
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly store: SessionStore,
    private readonly toolsMock: ToolsMock,
  ) {}
}
