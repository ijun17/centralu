/**
 * What a thrown value says went wrong, for a log line or an error event (#1339).
 *
 * `(e as Error).message` claims every throw is an Error, and the type-aware lint refuses that claim: a `catch` gets
 * `unknown`, and a rejection, a callback's error or a value from another realm need not be one. This reads an
 * Error's message, any object's string `message` (an error from another realm or library that is not an `Error`
 * here), and anything else as text.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message
  return String(e)
}
