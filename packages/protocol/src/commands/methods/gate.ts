import { z } from 'zod'
import { SessionId } from '../../entities.js'

/**
 * Fields a gate request never carries: the gate asks and never answers (#1654, session-core.md §8.1), so a request
 * that looks like an answer is refused, not read
 */
export const GATE_DECISION_FIELDS = ['decision', 'permissionDecision', 'answer'] as const

export const gateMethods = {
  /**
   * A hook-gated tool's approval gate asks about one call of its session (`agy`'s `PreToolUse` hook). Raised only by the
   * session's gate key on the front door's gate route (`POST /gate/<sessionId>`, agent-host `transport/gate-door.ts`);
   * its rights class is `gate`, so the WebSocket refuses it to every connection. `request` is the tool's hook input as
   * the hook read it. The answer comes from the session (its preset, the always-allow rules, the person's card), never
   * from the caller.
   */
  'gate.ask': {
    params: z
      .object({
        sessionId: SessionId,
        request: z
          .record(z.string(), z.unknown())
          .refine((r) => GATE_DECISION_FIELDS.every((f) => !Object.prototype.hasOwnProperty.call(r, f)), 'A gate request carries no decision'),
      })
      .strict(),
    result: z.discriminatedUnion('decision', [
      z.object({ decision: z.literal('allow') }),
      z.object({ decision: z.literal('deny'), reason: z.string() }),
    ]),
  },
} as const
