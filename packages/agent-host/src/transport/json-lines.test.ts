import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { PendingRequests, readLines } from './json-lines.js'

describe('readLines', () => {
  it('splits at newlines only: a raw U+2028 inside a JSON string stays in its line, and a split character stays whole', async () => {
    const line = JSON.stringify({ text: 'a b 한글' })
    const bytes = Buffer.from(`${line}\r\n{"n":2}`)
    const cut = bytes.indexOf(Buffer.from('한')) + 1
    const out: string[] = []
    for await (const l of readLines(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]))) out.push(l)
    expect(out).toEqual([line, '{"n":2}'])
    expect(JSON.parse(out[0]!)).toEqual({ text: 'a b 한글' })
  })
})

describe('PendingRequests', () => {
  it('settles each request once, by its id, and its timer goes with it', async () => {
    vi.useFakeTimers()
    try {
      const p = new PendingRequests<number>()
      const a = p.wait(1, 1000, 'no answer for 1')
      const b = p.wait('x-2', 1000, 'no answer for 2')
      expect(p.resolve('1', 10)).toBe(true)
      expect(p.resolve(1, 11)).toBe(false)
      await expect(a).resolves.toBe(10)
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(1000)
      await expect(b).rejects.toThrow('no answer for 2')
      expect(p.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects every waiting request at once, with one reason', async () => {
    const p = new PendingRequests()
    const all = [p.wait(1, 60_000, ''), p.wait(2, 60_000, '')]
    p.rejectAll(new Error('the other side is gone'))
    for (const w of all) await expect(w).rejects.toThrow('the other side is gone')
    expect(p.size).toBe(0)
  })
})
