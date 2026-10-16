import { z } from 'zod'
import { SessionId, ToolName } from '../../entities.js'
import { SessionInfo } from '../sessions.js'

export const orchestratorMethods = {
  /**
   * The app's single orchestrator. **Calling this creates one if it does not exist.**
   * Creating it ahead of time would leave a session nobody uses holding onto a tool process.
   */
  'orchestrator.get': { params: z.object({}), result: SessionInfo },
  /**
   * Returns it if it exists, and **does not create one if it does not** (#63).
   *
   * Once onboarding started showing the orchestrator screen first, "opening the screen" and
   * "creating the process" had to split apart — the screen only asks via this, and creation
   * happens through `orchestrator.get` at the moment the person actually asks their first
   * question. Creating it any earlier would leave a tool process running for a person who never
   * even asked (the lazy-startup principle).
   */
  'orchestrator.peek': { params: z.object({}), result: SessionInfo.nullable() },
  /**
   * Which tool the central orchestrator will **run on top of** (#63, the card chosen on the
   * intro screen). This setting is only for before a session exists — once one does, switching
   * the Agent in session settings takes over.
   */
  'orchestrator.configure': {
    params: z.object({ tool: ToolName }),
    result: z.object({ ok: z.literal(true) }),
  },
  'orchestrator.tools': {
    /** If sessionId is given, filters to that session's tool set (a manager under #69 gets a subset) — used by the bridge */
    params: z.object({ sessionId: SessionId.optional() }),
    result: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() })),
  },
  'orchestrator.tool': {
    params: z.object({ sessionId: SessionId, name: z.string(), args: z.record(z.string(), z.unknown()) }),
    result: z.object({ text: z.string(), isError: z.boolean().optional() }),
  },
} as const
