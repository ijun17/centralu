import { z } from 'zod'

/**
 * Whose a turn was, on the event that ends it, said by the host that ran it so a hub need not guess from message order.
 * `by: 'person'` only when the person's own message started it; `wrote`: the person wrote into a turn of the work.
 */
export const TurnWho = z.object({
  by: z.enum(['person', 'work']),
  wrote: z.literal(true).optional(),
  /** An update cut this turn and Centralu continued it (#1966) */
  cut: z.literal(true).optional(),
  /** Centralu started it to compact (#1451); a window raises no "done" for it */
  compaction: z.literal(true).optional(),
  /** The row the turn began after: a hub asks `host.lastAnswer` by it, as the next turn may have begun by then */
  since: z.number().int().optional(),
})
export type TurnWho = z.infer<typeof TurnWho>

/**
 * On the `state_change` opening a turn the tool ran for a message it was sent during another turn (#1604): `seq` is
 * that message's row and `from` its sender, so a hub reads whose the turn is instead of guessing from timing
 */
export const TurnOrigin = z.object({
  seq: z.number().int(),
  from: z.object({ sessionId: z.string(), name: z.string() }),
})
export type TurnOrigin = z.infer<typeof TurnOrigin>

/**
 * On the `state_change` opening the turn that runs `compact_self`'s `then` (#2164): it continues the turn that asked,
 * so a hub that gave that turn owes the caller this one's end too
 */
export const TurnContinues = z.literal('compaction')
export type TurnContinues = z.infer<typeof TurnContinues>
