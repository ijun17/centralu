import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readLines } from './json-lines.js'

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
