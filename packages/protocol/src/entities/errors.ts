import { z } from 'zod'

export const ProtocolErrorCode = z.enum([
  'adapter_crashed',
  /*
   * Another process holds this conversation (Codex's writer lock), so the session could not be
   * opened. Carried as a code, not a sentence, so the screen can offer "continue in a fork".
   * A lock error that arrives after the adapter already handed the session back (a slow
   * background resume) comes as an event with this code (#168, item 5).
   */
  'conversation_locked',
  'tool_not_installed',
  'not_logged_in',
  'session_not_found',
  'rate_limited',
  'version_mismatch',
  /*
   * The host understood the call and said no, for a reason it can name: mail's refusals (#1347, docs/plans/mailbox.md §9).
   * Not a failure and not worth a retry: `retryable` is false, and `data.reason` is a word the caller can act on
   * (`thread_done`, `not_participant`, `policy`, ...). A window or a tool shows `message` as it is. An older window reads the
   * frame as one it cannot validate and ends the call as `internal`, with the message (docs/protocol.md §5)
   */
  'refused',
  'internal',
])
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCode>

export const ProtocolError = z.object({
  code: ProtocolErrorCode,
  /** A human-readable description — must be displayable by the UI as-is */
  message: z.string(),
  retryable: z.boolean().default(false),
  data: z.unknown().optional(),
})
export type ProtocolError = z.infer<typeof ProtocolError>
