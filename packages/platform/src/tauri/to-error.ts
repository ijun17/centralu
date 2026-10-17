/**
 * What a failed Tauri call rejects with, as an Error (#972 item 2).
 *
 * Tauri passes a Rust-side `Err` through as a rejection value **exactly as the string it is**, and
 * a plugin may do the same. Since it is not an Error, `e.message` comes out undefined, and the
 * screen shows a failure with no reason, like "Could not move window: undefined" — the most
 * useless shape a failure can take, saying that it failed without saying why. Every `invoke` and
 * plugin call in this folder goes through here, so the UI can always read `err.message`.
 */
export function toError(e: unknown): Error {
  if (e instanceof Error) return e
  if (typeof e === 'string') return new Error(e)
  const message = typeof e === 'object' && e !== null ? (e as { message?: unknown }).message : undefined
  if (typeof message === 'string') return new Error(message, { cause: e })
  return new Error(String(e), { cause: e })
}

/** `toError` for a `.catch`: rethrows what a Tauri call rejected with as an Error */
export function rethrowAsError(e: unknown): never {
  throw toError(e)
}

/** Runs a Tauri call (a plugin's, or one that is not an `invoke`) so that any failure, thrown or rejected, is an Error */
export async function asError<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    throw toError(e)
  }
}
