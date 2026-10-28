/** A `centralu serve` host's full credentials, as serve.json's verifiers (#1405) */
import { describe, expect, it } from 'vitest'
import { isFullCredential, LAST_READ_KEPT_MS, readFullCredentials, verifierOf, type FullCredential } from './serve-credentials.js'

const KEY = 'k'.repeat(43)
const HUB = 'h'.repeat(43)
const WINDOW = 'w'.repeat(43)
const entry = (id: string, token: string) => ({ id, label: id, verifier: verifierOf(token), created: 1 })

describe('reading the full credentials', () => {
  it('reads each entry of a version 2 file, and none of anything else', () => {
    const file = JSON.stringify({ v: 2, key: KEY, port: 1, full: [entry('aaaaaaaa', HUB), { id: 'bad', verifier: 'not hex' }, entry('bbbbbbbb', WINDOW)] })
    expect(readFullCredentials('v2', () => file).map((c) => c.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(readFullCredentials('v1', () => JSON.stringify({ v: 1, token: HUB }))).toEqual([])
    expect(readFullCredentials('half', () => 'half', () => {})).toEqual([])
  })

  it('takes only an entry of the shape the launcher lists and --revoke takes: an 8-hex id and a label', () => {
    const v = verifierOf(HUB)
    const file = JSON.stringify({
      v: 2,
      key: KEY,
      full: [
        { id: 'aaaaaaaa', verifier: v },
        { id: 'zz', label: 'hand', verifier: v },
        { id: 'AAAAAAAA', label: 'hand', verifier: v },
        { id: 'aaaaaaaa', label: 'two words', verifier: v },
        { id: 'aaaaaaaa', label: '', verifier: v },
        { id: 'aaaaaaaa', label: 'x'.repeat(81), verifier: v },
        { id: 'cccccccc', label: 'hub:laptop-0123abcd', verifier: v },
      ],
    })
    expect(readFullCredentials('shapes', () => file).map((c) => c.id)).toEqual(['cccccccc'])
  })

  it('reads again when the file is caught mid-replace, and names none when it stays unreadable', () => {
    let reads = 0
    const flaky = () => (++reads < 3 ? '' : JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] }))
    expect(readFullCredentials('flaky', flaky, () => {})).toHaveLength(1)
    expect(readFullCredentials('never-read', () => { throw new Error('EBUSY') }, () => {})).toEqual([])
    // Held past the retries (a scanner on Windows): what it said last, not no one
    const good = JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] })
    expect(readFullCredentials('held', () => good, () => {})).toHaveLength(1)
    expect(readFullCredentials('held', () => { throw new Error('EBUSY') }, () => {}).map((c) => c.id)).toEqual(['aaaaaaaa'])
  })

  it('names none once the file is gone, though it named some before (#1405 review: moved aside)', () => {
    const good = JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] })
    expect(readFullCredentials('moved', () => good, () => {})).toHaveLength(1)
    const gone = () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    }
    expect(readFullCredentials('moved', gone, () => {})).toEqual([])
    // And a refused read after that does not bring the old list back
    expect(readFullCredentials('moved', () => { throw new Error('EBUSY') }, () => {})).toEqual([])
  })

  it('keeps the last list for a file that stays refused only for a while, then names none', () => {
    let t = 1_000
    const good = JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] })
    const busy = () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }
    expect(readFullCredentials('busy', () => good, () => {}, () => t)).toHaveLength(1)
    t += LAST_READ_KEPT_MS
    expect(readFullCredentials('busy', busy, () => {}, () => t)).toHaveLength(1)
    t += 1
    expect(readFullCredentials('busy', busy, () => {}, () => t)).toEqual([])
  })

  it('takes a credential whose hash is one of them, and nothing else', () => {
    const full: FullCredential[] = [entry('aaaaaaaa', HUB)]
    expect(isFullCredential(full, HUB)?.id).toBe('aaaaaaaa')
    expect(isFullCredential(full, WINDOW)).toBeNull()
    expect(isFullCredential(full, verifierOf(HUB))).toBeNull()
  })
})

// What a host does with them at hello, over a real socket: transport/limited-token.test.ts
