import { z } from 'zod'
import { SessionId, ToolName } from '../../entities.js'

/** The parameters of the `assistant` methods, which the host validates (docs/protocol.md §3). Their results: ./assistant.results.ts */
export const assistantParams = {
  /**
   * The app's single assistant. **Calling this creates one if it does not exist.**
   * Creating it ahead of time would leave a session nobody uses holding onto a tool process.
   */
  'orchestrator.get': z.object({}),
  /**
   * Returns it if it exists, and **does not create one if it does not** (#63).
   *
   * Once onboarding started showing the Assistant screen first, "opening the screen" and
   * "creating the process" had to split apart — the screen only asks via this, and creation
   * happens through `orchestrator.get` at the moment the person actually asks their first
   * question. Creating it any earlier would leave a tool process running for a person who never
   * even asked (the lazy-startup principle).
   */
  'orchestrator.peek': z.object({}),
  /**
   * Which tool the Assistant will **run on top of** (#63, the card chosen on the
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
  /*
   * #2133 step 3: the same five under the role's new name, answered as the old ones are. Nothing calls them yet: a window
   * can stay attached to a host of an older release (#280), which knows only `orchestrator.*`, so callers switch in step 4
   * (docs/plans/assistant-rename.md)
   */
  'assistant.get': z.object({}),
  'assistant.peek': z.object({}),
  'assistant.configure': z.object({ tool: ToolName }),
  'assistant.tools': z.object({ sessionId: SessionId.optional() }),
  'assistant.tool': z.object({
    sessionId: SessionId,
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
} as const
