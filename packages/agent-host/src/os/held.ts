import { sleep, sleepSync } from '../timing.js'
import { errnoCode } from './errors.js'

/**
 * A file another process holds for a moment, the one policy for it (#2161). Windows refuses to rename or remove a file
 * that a virus scanner, an indexer or a backup has just opened, and a folder in which a process has only just ended, with
 * `EBUSY`, `EPERM` or `EACCES`, and a folder whose last file is still being deleted with `ENOTEMPTY`. The real `Os`
 * tries each `rename` and `rm` again after these waits on Windows (os/real.ts), 1.6 s in all, and throws the last
 * refusal; any other error is thrown at once. POSIX holds none of these, so there it is never tried again. `rmdir` and
 * `unlink` are not: an `rmdir` is asked to refuse a folder that is not empty (`ENOTEMPTY`), at once.
 */
export const HELD_WAITS_MS: readonly number[] = [25, 50, 100, 200, 400, 800]

const HELD_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** Whether a failure may be a hold that waiting ends */
export const isHeld = (e: unknown): boolean => HELD_CODES.has(errnoCode(e) ?? '')

/** Told of each refusal that is tried again: the error and the wait before the next try */
export type HeldRetry = (e: unknown, waitMs: number) => void

/** `op`, tried again after each of `HELD_WAITS_MS` while it is refused as held; `wait` blocks the thread */
export function retryHeldSync<T>(op: () => T, wait: (ms: number) => void = sleepSync, retried?: HeldRetry): T {
  for (let i = 0; ; i++) {
    try {
      return op()
    } catch (e) {
      const ms = HELD_WAITS_MS[i]
      if (ms === undefined || !isHeld(e)) throw e
      retried?.(e, ms)
      wait(ms)
    }
  }
}

/** `retryHeldSync` for an operation that does not block the host */
export async function retryHeld<T>(op: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await op()
    } catch (e) {
      const ms = HELD_WAITS_MS[i]
      if (ms === undefined || !isHeld(e)) throw e
      await wait(ms)
    }
  }
}
