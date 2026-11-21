import type { ToolName } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import { mockSessionInfo } from './session-info.js'
import type { SessionStore } from './session-store.js'
import type { ToolsMock } from './tools.js'

/** The Assistant seat: its tool (#63) and the session behind it */
export class AssistantMock {
  /** Chosen on the intro screen (#63); the host keeps it in app_settings */
  private savedAssistantTool: ToolName | null = null
  get assistantTool(): ToolName {
    return this.savedAssistantTool ?? this.toolsMock.firstRegisteredTool()
  }
  set assistantTool(tool: ToolName) {
    this.savedAssistantTool = tool
  }
  readonly agents: Pick<AgentPort, 'assistant' | 'assistantPeek' | 'configureAssistant'> = {
    assistant: async () => {
      // As the host: made on the spot if missing
      const found = [...this.store.sessions.values()].find((x) => x.projectId === null)
      if (found) return found
      const id = `orc-${this.clock.next()}`
      const info = mockSessionInfo({
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
    // As the host (#63): opening the screen only asks; `assistant()` creates it at the first question
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
