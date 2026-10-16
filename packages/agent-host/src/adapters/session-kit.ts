import type { NormalizedEvent } from '@cc/protocol'

/**
 * Bookkeeping both adapters do the same way. Each helper here replaces copies that had drifted apart, so a rule
 * changed here changes for Claude and Codex at once.
 */

/** Counts notices across every handle in this host, so a notice from a new handle never reuses an open row's id */
let notices = 0

/**
 * A line Centralu itself says in a session's chat (a `/goal` confirmation or refusal), as an assistant message of
 * its own. It carries its own message id: the record and the screen join a chunk that names no message onto the
 * open row (session-record.ts, #212), so a notice without one was glued onto the model's open reply mid-turn.
 */
export function adapterNotice(sessionId: string, text: string): NormalizedEvent {
  return { type: 'message_delta', sessionId, role: 'assistant', messageId: `centralu-notice-${++notices}`, text }
}
