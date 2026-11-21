import { z } from 'zod'

export const ProtocolErrorCode = z.enum([
  'adapter_crashed',
  // Another process holds the conversation (Codex's writer lock); a code, so the screen can offer "continue in a fork".
  // One that comes after the session was handed back (a slow background resume) arrives as an event with this code
  'conversation_locked',
  'tool_not_installed',
  'not_logged_in',
  'session_not_found',
  'rate_limited',
  'version_mismatch',
  // Understood and refused for a reason it names in `data.reason`, never retryable: docs/protocol.md §5
  'refused',
  'internal',
])
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCode>

export const ProtocolError = z.object({
  code: ProtocolErrorCode,
  /** Shown by the UI as it is */
  message: z.string(),
  retryable: z.boolean().default(false),
  data: z.unknown().optional(),
})
export type ProtocolError = z.infer<typeof ProtocolError>
