import { z } from 'zod'
import { SessionId, ToolName } from '../../entities.js'

/** Params of the `assistant` methods, parsed by the host (docs/protocol.md §3). Results: ./assistant.results.ts */
export const assistantParams = {
  /** Creates the Assistant if missing: made ahead, an unused session would hold a tool process */
  'assistant.get': z.object({}),
  /**
   * Never creates it: onboarding shows the Assistant screen first, and the process starts through `assistant.get`
   * only when the person asks their first question.
   */
  'assistant.peek': z.object({}),
  /** The tool it will run on, before it exists; after that, the session settings' Agent switch decides */
  'assistant.configure': z.object({ tool: ToolName }),
  /** With `sessionId`, that session's tool set (a manager gets a subset); the bridge asks this */
  'assistant.tools': z.object({ sessionId: SessionId.optional() }),
  /**
   * The Codex bridge's way back into the host: Codex attaches only a stdio server, through its per-thread config (HTTP
   * did not work, measured); Claude attaches in-process. The bridge passes a name and arguments; every rule is the host's.
   */
  'assistant.tool': z.object({
    sessionId: SessionId,
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
} as const
