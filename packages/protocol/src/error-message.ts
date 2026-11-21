/**
 * A caught value's text (docs/architecture.md §2): a thrown value need not be an Error, and one from another realm
 * still has a string `message`. Never throws, since it runs inside a `catch`.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message
  try {
    return String(e)
  } catch {
    return `(a thrown ${typeof e} that cannot be written out)`
  }
}
