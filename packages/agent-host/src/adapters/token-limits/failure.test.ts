import { describe, expect, it } from 'vitest'
import { LimitsFailure, readWithReasons, type LimitsReasons } from './failure.js'

const REASONS: LimitsReasons = {
  'no-token': 'no token',
  expired: 'expired',
  'signed-out': 'signed out',
  refused: 'refused',
  unreachable: 'unreachable',
  unreadable: 'unreadable',
}

describe('a limits read whose failures carry the reader’s reasons (#2459, #2462)', () => {
  it("answers what the read answers, and throws each failure as its kind with the reader's reason", async () => {
    const lines: string[] = []
    await expect(readWithReasons('tool', REASONS, (l) => lines.push(l), async () => 7)()).resolves.toBe(7)
    const failing = readWithReasons('tool', REASONS, (l) => lines.push(l), async () => Promise.reject(new LimitsFailure('refused', 'usage: HTTP 403')))
    await expect(failing()).rejects.toMatchObject({ kind: 'refused', detail: 'usage: HTTP 403', message: 'refused' })
    // Anything else is an answer that could not be read, by the error's name only
    const odd = readWithReasons('tool', REASONS, (l) => lines.push(l), async () => Promise.reject(new TypeError('secret text')))
    await expect(odd()).rejects.toMatchObject({ kind: 'unreadable', detail: 'TypeError', message: 'unreadable' })
    expect(lines.join('\n')).not.toContain('secret')
  })

  it('writes one host.log line per kind', async () => {
    const lines: string[] = []
    let fail = new LimitsFailure('refused', 'usage: HTTP 403')
    const read = readWithReasons('tool', REASONS, (l) => lines.push(l), async () => Promise.reject(fail))
    await expect(read()).rejects.toThrow()
    await expect(read()).rejects.toThrow()
    expect(lines).toEqual(['[usage] tool: limits not read (refused: usage: HTTP 403)'])
    fail = new LimitsFailure('unreachable', 'usage: HTTP 503')
    await expect(read()).rejects.toThrow()
    expect(lines).toHaveLength(2)
  })
})
