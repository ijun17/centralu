import type { NormalizedEvent } from '@cc/protocol'
import { stepLine } from './tool-titles.js'

/**
 * A subagent's events, read the way the parent's own are, as the steps kept under the card that launched it (#98,
 * #222): a Claude subagent's messages (`parent_tool_use_id`) and a Codex child thread's items (`childSteps`) alike.
 *
 *   - its text, its readable thinking, its tool calls and their results are its steps (`SubagentStep`)
 *   - each call is also a line of the launch card's live output (`stepLine`), so the card says what the agent is doing
 *     while it works (#843: a Codex agent's card said nothing)
 *   - a file it changed is still a file changed in this session's folder, so `files_touched` goes out as the parent's
 *
 * Everything else (usage, images, activity, a nested agent's "launched" line) is not the subagent's record here.
 */
export function subagentSteps(sessionId: string, parentCallId: string, events: readonly NormalizedEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  for (const e of events) {
    if (e.type === 'tool_call') out.push({ type: 'tool_output_delta', sessionId, callId: parentCallId, text: `${stepLine(e.summary)}\n` })
    if (e.type === 'message_delta' || (e.type === 'reasoning_delta' && e.text) || e.type === 'tool_call' || e.type === 'tool_result') {
      out.push({ type: 'subagent_event', sessionId, parentCallId, step: e })
    } else if (e.type === 'files_touched') out.push(e)
  }
  return out
}
