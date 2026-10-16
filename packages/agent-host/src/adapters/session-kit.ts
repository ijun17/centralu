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

/**
 * What a message the person sent and the CLI never read is called, by when it was left behind (`when`, read after
 * the count: "were still queued when the session closed"). The screen already shows such a message as sent (the
 * manager records it first), so dropping it silently leaves "sent, but the agent never read it" (the 2026-09-02 loss
 * incident): every place that lets one go says so with this text.
 */
export function undeliveredText(count: number, when: string): string {
  return `${count} message(s) ${when} and were not delivered — please resend`
}

/** `undeliveredText` as the error event a session shows (`internal`, not retryable: only a resend brings it back) */
export function undeliveredError(sessionId: string, count: number, when: string): NormalizedEvent {
  return { type: 'error', sessionId, error: { code: 'internal', message: undeliveredText(count, when), retryable: false } }
}
