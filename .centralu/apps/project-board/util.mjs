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
