import type { OsError } from './port.js'

/** The `code` a failed system call carries (`ENOENT`, `EPERM`, ...), when it is text, on an `Error` (a plain object that carries one is not a failed call); a `catch` gets `unknown` */
export function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined
}

/** Whether a failure says there is nothing at the path: `ENOENT`, or `ENOTDIR` when a file stands where a folder should */
export function isMissing(e: unknown): boolean {
  const code = errnoCode(e)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** A failure as an `OsError`: its own code, or `UNKNOWN` */
export function asOsError(e: unknown): OsError {
  const error = e instanceof Error ? e : new Error(String(e))
  return Object.assign(error, { code: errnoCode(error) ?? 'UNKNOWN' })
}

/** A thrown value as an `Error` */
export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/** Why an `AbortSignal` aborted, as an `Error` (its reason is a DOMException by default) */
export function abortReason(signal: AbortSignal): Error {
  return asError(signal.reason ?? new Error('aborted'))
}
