import { z } from 'zod'

/**
 * Whose a turn was, said on the event that ends it (#1377): `person` when the person's own message started it, `work`
 * otherwise (the caller's message, an app's, Centralu's, or the tool starting it when the work's background tasks end);
 * `wrote`: the person wrote into a turn of the work and the tool took it in; `added`: they chose to add it to the task.
 * Said by the host that ran the turn, so a hub that follows a linked machine reads it rather than guessing from the
 * order of the messages. Absent from a host that does not say.
 * `compaction`: Centralu started this turn to compact the conversation (#1451); a window raises no "done" for it.
 * `since` (#1812): the row the turn began after, when the host kept it (a session a hub gives messages); a hub asks for
 * this turn's words by it (`host.lastAnswer`), since the next turn may have begun or ended by the time it reads them.
 */
export const TurnWho = z.object({
  by: z.enum(['person', 'work']),
  wrote: z.literal(true).optional(),
  added: z.literal(true).optional(),
  /** An update of Centralu cut this turn and Centralu continued it (#1966): the report of its end says so */
  cut: z.literal(true).optional(),
  compaction: z.literal(true).optional(),
  since: z.number().int().optional(),
})
export type TurnWho = z.infer<typeof TurnWho>

/**
 * What a turn that began with no message of its own ran for (#1604), said on the `state_change` that opens it: the tool
 * had been sent a message while another turn ran and did not read it there, so it ran it as a turn of its own once that
 * ended. `seq` is that message's row in the conversation (the `user_message` the hub saw) and `from` who sent it, so a
 * hub that followed the sender reads whose the turn is instead of guessing from the time between. Absent from a turn
 * that began otherwise (a message at rest, the tool's own) and from a host that does not say.
 */
export const TurnOrigin = z.object({
  seq: z.number().int(),
  from: z.object({ sessionId: z.string(), name: z.string() }),
})
export type TurnOrigin = z.infer<typeof TurnOrigin>

/**
 * What a turn that began with no message of anyone's goes on with, said on the `state_change` that opens it (#2164): `compaction`, it
 * is the next step a compaction Centralu ran was asked to go on with (`compact_self`'s `then`), so it goes on with the work of the turn
 * that asked. A hub that gave that turn takes this one for the caller's too: its end is owed, and a note goes into it. Absent from a
 * turn that began otherwise and from a host that does not say.
 */
export const TurnContinues = z.literal('compaction')
export type TurnContinues = z.infer<typeof TurnContinues>
