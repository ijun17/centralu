import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readHandedToken } from './handed-token.js'

/** What a reader of the same stream sees after the token line was taken */
function rest(input: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let got = ''
    input.on('data', (d: Buffer) => (got += String(d)))
    input.on('end', () => resolve(got))
    input.resume()
  })
}

describe('the token handed over on stdin (#538)', () => {
  it('takes the first line and leaves what follows to the next reader, the keeper control lines', async () => {
    const input = new PassThrough()
    const token = readHandedToken(input, 1000)
    input.write('{"token":"abc123"}\n{"op":"drain"}\n')
    await expect(token).resolves.toBe('abc123')
    const after = rest(input)
    input.end('{"op":"stop"}\n')
    expect(await after).toBe('{"op":"drain"}\n{"op":"stop"}\n')
  })

  it('waits for a line written in pieces', async () => {
    const input = new PassThrough()
    const token = readHandedToken(input, 1000)
    input.write('{"tok')
    input.write('en":"in-pieces"}')
    input.write('\n')
    await expect(token).resolves.toBe('in-pieces')
  })

  it('refuses a line that is not the token, a stdin that ends first, and one that says nothing', async () => {
    const notJson = new PassThrough()
    const a = readHandedToken(notJson, 1000)
    notJson.write('hello\n')
    await expect(a).rejects.toThrow(/not JSON/)

    const empty = new PassThrough()
    const b = readHandedToken(empty, 1000)
    empty.write('{"token":"  "}\n')
    await expect(b).rejects.toThrow(/no token/)

    const ended = new PassThrough()
    const c = readHandedToken(ended, 1000)
    ended.end('{"token":"x"}')
    await expect(c).rejects.toThrow(/ended before the token line/)

    const silent = new PassThrough()
    await expect(readHandedToken(silent, 50)).rejects.toThrow(/no token line on stdin within/)
  })
})
