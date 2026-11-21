/**
 * Tauri rejects with a Rust `Err` as the bare string, and a plugin may too, so `e.message` would read undefined
 * ("Could not move window: undefined"). Every `invoke` and plugin call in this folder goes through here.
 */
export function toError(e: unknown): Error {
  if (e instanceof Error) return e
  if (typeof e === 'string') return new Error(e)
  const message = typeof e === 'object' && e !== null ? (e as { message?: unknown }).message : undefined
  if (typeof message === 'string') return new Error(message, { cause: e })
  return new Error(String(e), { cause: e })
}

export function rethrowAsError(e: unknown): never {
  throw toError(e)
}

/** For a call that is not an `invoke`: a failure thrown or rejected becomes an Error */
export async function asError<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    throw toError(e)
  }
}
