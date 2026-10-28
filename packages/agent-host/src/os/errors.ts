import type { OsError } from './port.js'

/** The errno name of a failure (`ENOENT`), or undefined for one that has none */
export function errorCode(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined
}

/** A failure as an `OsError`: its own code, or `UNKNOWN` */
export function asOsError(e: unknown): OsError {
  const error = e instanceof Error ? e : new Error(String(e))
  return Object.assign(error, { code: errorCode(error) ?? 'UNKNOWN' })
}

/** A tree copy refused for a link it cannot take (`linkLoop` in rules.ts): `ELOOP` at the link */
export function linkLoopError(path: string): OsError {
  return Object.assign(new Error(`ELOOP: too many symbolic links encountered, cp '${path}'`), { code: 'ELOOP', syscall: 'cp', path })
}

/** A thrown value as an `Error` */
export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/** Why an `AbortSignal` aborted, as an `Error` (its reason is a DOMException by default) */
export function abortReason(signal: AbortSignal): Error {
  return asError(signal.reason ?? new Error('aborted'))
}
