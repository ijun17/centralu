import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { systemNow } from './clock.mjs'

// Small helpers the board app's modules share: waiting, a bounded fan-out, and words in answers (pure).

/** Sleeps, or stops early when the call is cancelled. Answers false when cancelled. */
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const t = setTimeout(() => (signal?.removeEventListener('abort', stop), resolve(true)), ms)
    const stop = () => (clearTimeout(t), resolve(false))
    signal?.addEventListener('abort', stop, { once: true })
  })
}

/** Whether the process `pid` still runs (EPERM: it does, as another user). `unknown`: the answer for a pid that is no process id. */
export function alive(pid, unknown = false) {
  if (!Number.isInteger(pid) || pid <= 0) return unknown
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * Writes `value` as JSON to `path` through a temporary file beside it and a rename, so a reader sees the old file or the
 * new one, never half of one. Synchronous, so a read-change-write around it stays one step. The temporary file does not
 * stay behind when the rename fails. `space`: JSON.stringify's indent.
 */
export function writeJsonAtomic(path, value, space) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, space)}\n`)
  // Windows refuses a rename onto a file another process has open for a moment: try again shortly
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path)
      return
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        try {
          unlinkSync(tmp)
        } catch {
          // nothing left to remove
        }
        throw e
      }
      const until = systemNow() + 25
      while (systemNow() < until);
    }
  }
}

/** Runs `fn` over `list` with at most `n` at a time, answers in order. */
export async function mapLimit(list, n, fn) {
  const out = new Array(list.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (next < list.length) {
        const i = next++
        out[i] = await fn(list[i], i)
      }
    }),
  )
  return out
}

/** A commit's first 7 characters, or `?` when there is none. */
export const short = (sha) => (sha ? String(sha).slice(0, 7) : '?')
/** A duration in words: seconds under two minutes, else minutes. */
export const span = (ms) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)
/** `1 file`, `2 files`. */
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
/** The first `max` of a list, then how many more. */
export const listSome = (xs, max) => `${xs.slice(0, max).join(', ')}${xs.length > max ? ` and ${xs.length - max} more` : ''}`

/**
 * A word for the shell a session runs a command in: as is when it is plain, else in double quotes (a
 * POSIX shell's escapes; on Windows PowerShell or cmd, as is inside the quotes).
 */
export const shellQuote = (s) =>
  /^[\w./:@-]+$/.test(String(s)) ? String(s) : process.platform === 'win32' ? `"${s}"` : `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`
