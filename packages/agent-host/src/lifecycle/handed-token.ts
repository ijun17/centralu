import type { Readable } from 'node:stream'
import { asObj, tryParseJson } from '../json-value.js'

/**
 * The host token handed over on stdin (#538): the first line a keeper or `centralu serve` writes to the host's
 * stdin, `{"token":"…"}`, when it set `CC_HOST_TOKEN_ON_STDIN=1`.
 *
 * Why stdin: what a process is started with (its environment, its arguments) stays readable to every process of
 * its user for as long as it runs (`ps eww`, measured in #502), and deleting a variable hides it only from the
 * process's children. A pipe's bytes are read once by the one process that holds its end. Both launchers already
 * keep the host's stdin as a pipe: the keeper for its control lines, `centralu serve` for `--watch-parent`.
 *
 * Read before anything else uses stdin: what follows the line (the keeper's control lines) is put back and the
 * stream is left paused, so nothing is lost before the next reader is there. That reader resumes it (the control
 * channel does, and so does the parent watch) and reads on as if this had never been there.
 */

/** How long the host waits for the line before it gives up: the launcher writes it right after the spawn */
export const HANDED_TOKEN_WAIT_MS = 10_000

/** The longest line taken as the token line; a token is 32 hex characters */
const MAX_TOKEN_LINE = 4096

export async function readHandedToken(input: Readable, waitMs: number = HANDED_TOKEN_WAIT_MS): Promise<string> {
  const line = await firstLine(input, waitMs)
  const parsed = tryParseJson(line)
  if (parsed === undefined) throw new Error('the token line on stdin is not JSON')
  // A `centralu serve` host that takes verifiers gets its key there instead (#1405, `serve-credentials.ts`)
  const o = asObj(parsed)
  const token = typeof o.token === 'string' ? o.token : o.key
  if (typeof token !== 'string' || token.trim() === '') throw new Error('the token line on stdin has no token')
  return token
}

function firstLine(input: Readable, waitMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0)
    const done = (err: Error | null, line?: string, rest?: Buffer) => {
      clearTimeout(timer)
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onError)
      input.pause()
      if (rest && rest.length > 0) input.unshift(rest)
      if (err) reject(err)
      else resolve(line!)
    }
    const onData = (chunk: Buffer | string) => {
      got = Buffer.concat([got, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      const nl = got.indexOf(0x0a)
      if (nl !== -1) return done(null, got.subarray(0, nl).toString('utf8').trim(), got.subarray(nl + 1))
      if (got.length > MAX_TOKEN_LINE) done(new Error('the token line on stdin is too long'))
    }
    const onEnd = () => done(new Error('stdin ended before the token line'))
    const onError = (e: Error) => done(new Error(`stdin failed before the token line: ${e.message}`))
    const timer = setTimeout(() => done(new Error(`no token line on stdin within ${waitMs / 1000} s`)), waitMs)
    timer.unref?.()
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', onError)
  })
}
