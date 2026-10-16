import type { NormalizedEvent } from '@cc/protocol'

/**
 * How much of a tool's answer its card carries, the same for every tool (#843). The card's `summary` is also what
 * another session reads of it (`read_session`, `recall`, the handoff record, #73), so the two adapters cutting it at
 * 300 and 2,000 characters meant the same answer read differently depending on which tool gave it. The whole answer
 * is the result's `output`, the record (#221).
 */
export const RESULT_SUMMARY_CHARS = 2000

/** A call's result: the card's `summary` is the opening of `output`, and `output` is the whole answer, left out when there is none. */
export function toolResultEvent(sessionId: string, callId: string, ok: boolean, output: string): NormalizedEvent {
  return {
    type: 'tool_result',
    sessionId,
    callId,
    ok,
    summary: output.slice(0, RESULT_SUMMARY_CHARS),
    ...(output ? { output } : {}),
  }
}
