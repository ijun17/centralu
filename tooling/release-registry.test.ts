/**
 * What the release asks the registry before publishing (`scripts/release-registry.mts`): a job re-run
 * after it published part of a release must finish it, not fail on its first package forever; a
 * version already published from other code must still stop it; and the shim must tell "published a
 * moment ago, not visible yet" from "not published".
 */
import { describe, expect, it } from 'vitest'
import { parseView, publishStep, stillMissing } from '../scripts/release-registry.mjs'

const HEAD = '844bd5030000000000000000000000000000abcd'
const E404 = JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 9.9.9' } })

describe('reading npm view', () => {
  it('reads a published version and the commit npm recorded for it', () => {
    expect(parseView(JSON.stringify({ version: '9.9.9', gitHead: HEAD }), true, 'x@9.9.9')).toEqual({ state: 'present', gitHead: HEAD })
    expect(parseView(JSON.stringify({ version: '9.9.9' }), true, 'x@9.9.9')).toEqual({ state: 'present', gitHead: null })
  })

  it('takes only npm’s E404 for "not published"', () => {
    expect(parseView(E404, false, 'x@9.9.9')).toEqual({ state: 'absent' })
    // A registry that did not answer, or refused the token, is not "absent": publishing on that
    // guess is what fails a re-run on EPUBLISHCONFLICT
    expect(() => parseView(JSON.stringify({ error: { code: 'ECONNRESET', summary: 'socket hang up' } }), false, 'x@9.9.9')).toThrow(/socket hang up/)
    expect(() => parseView('', false, 'x@9.9.9')).toThrow(/npm view x@9\.9\.9 failed/)
    expect(() => parseView('<html>', true, 'x@9.9.9')).toThrow(/not JSON/)
  })
})

describe('publishing on a re-run', () => {
  it('publishes what is not there, and skips what an earlier attempt from this commit published', () => {
    expect(publishStep({ state: 'absent' }, HEAD, 'x@9.9.9')).toEqual({ do: 'publish' })
    expect(publishStep({ state: 'present', gitHead: HEAD }, HEAD, 'x@9.9.9')).toEqual({ do: 'skip' })
  })

  it('stops on the same version published from other code, which only a bump fixes', () => {
    const other = publishStep({ state: 'present', gitHead: '1a563a881cd9055255f47964a8ce0e24f1380273' }, HEAD, 'x@9.9.9')
    expect(other).toMatchObject({ do: 'stop', why: expect.stringMatching(/x@9\.9\.9 is already on the registry, published from commit 1a563a881cd9, not from this one \(844bd5030000\)[\s\S]*Bump/) })
    expect(publishStep({ state: 'present', gitHead: null }, HEAD, 'x@9.9.9')).toMatchObject({ do: 'stop', why: expect.stringContaining('an unknown commit') })
  })
})

describe('waiting for packages published a moment ago', () => {
  it('asks again while any is missing, and answers what never appeared', async () => {
    const seen = new Map([['a', 0], ['b', 0]])
    const visibleAfter: Record<string, number> = { a: 1, b: 3 }
    const waits: string[][] = []
    const missing = await stillMissing(['a', 'b'], (n) => {
      seen.set(n, seen.get(n)! + 1)
      return seen.get(n)! > visibleAfter[n]!
    }, { tries: 5, delayMs: 1, sleep: async () => {}, onWait: (m) => waits.push(m) })
    expect(missing).toEqual([])
    expect(waits).toEqual([['a', 'b'], ['b'], ['b']])
    // Visible packages are not asked about again
    expect(seen.get('a')).toBe(2)

    const never = await stillMissing(['a'], () => false, { tries: 3, delayMs: 1, sleep: async () => {} })
    expect(never).toEqual(['a'])
  })

  it('asks once and does not wait when told one try (a rehearsal)', async () => {
    let asked = 0
    let slept = 0
    expect(await stillMissing(['a'], () => (asked++, false), { tries: 1, delayMs: 1, sleep: async () => void slept++ })).toEqual(['a'])
    expect([asked, slept]).toEqual([1, 0])
  })
})
