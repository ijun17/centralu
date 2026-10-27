import { z } from 'zod'
import { SessionId, ToolName } from '../../entities.js'

/** The parameters of the `orchestrator` methods, which the host validates (docs/protocol.md §3). Their results: ./orchestrator.results.ts */
export const orchestratorParams = {
  /**
   * The app's single orchestrator. **Calling this creates one if it does not exist.**
   * Creating it ahead of time would leave a session nobody uses holding onto a tool process.
   */
  'orchestrator.get': z.object({}),
  /**
   * Returns it if it exists, and **does not create one if it does not** (#63).
   *
   * Once onboarding started showing the orchestrator screen first, "opening the screen" and
   * "creating the process" had to split apart — the screen only asks via this, and creation
   * happens through `orchestrator.get` at the moment the person actually asks their first
   * question. Creating it any earlier would leave a tool process running for a person who never
   * even asked (the lazy-startup principle).
   */
  'orchestrator.peek': z.object({}),
  /**
   * Which tool the central orchestrator will **run on top of** (#63, the card chosen on the
   * intro screen). This setting is only for before a session exists — once one does, switching
   * the Agent in session settings takes over.
   */
  'orchestrator.configure': z.object({ tool: ToolName }),
  /** If sessionId is given, filters to that session's tool set (a manager under #69 gets a subset) — used by the bridge */
  'orchestrator.tools': z.object({ sessionId: SessionId.optional() }),
  'orchestrator.tool': z.object({
    sessionId: SessionId,
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
} as const
