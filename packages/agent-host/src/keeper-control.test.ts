import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { bridgeAddress, ControlChannel, viewPort } from './keeper-control.js'
import { readHandedToken } from './lifecycle/handed-token.js'
import { bridgeSessionOf } from './transport/bridge-token.js'

describe('the Codex bridge address (#280 step 3)', () => {
  it('under a keeper is the front door, which outlives this host, and not the host’s own port', () => {
    expect(bridgeAddress('ws://127.0.0.1:61000', 52001, 'tok', 's1')?.url).toBe('ws://127.0.0.1:61000')
  })

  it('without a keeper is the host itself, and nothing before the host listens', () => {
    expect(bridgeAddress(undefined, 52001, 'tok', 's1')?.url).toBe('ws://127.0.0.1:52001')
    expect(bridgeAddress('ws://127.0.0.1:61000', undefined, 'tok', 's1')).toBeNull()
  })

  it('carries the session’s bridge credential, never the host’s token, which would open every RPC (#382)', () => {
    const token = 'front-door-token-0123456789abcdef'
    const given = bridgeAddress('ws://127.0.0.1:61000', 52001, token, 's1')!
    expect(given.token).not.toContain(token)
    expect(bridgeSessionOf(token, given.token)).toBe('s1')
  })
})

describe('the port an app view address points at (#280 step 4)', () => {
  it('under a keeper is the front door’s, so the address an iframe holds still reaches the host the keeper starts next', () => {
    expect(viewPort('ws://127.0.0.1:61000', 52001)).toBe(61000)
  })

  it('without a keeper, or with a door that is not a loopback port, is the host’s own; nothing before the host listens', () => {
    expect(viewPort(undefined, 52001)).toBe(52001)
    expect(viewPort('ws://example.com:61000', 52001)).toBe(52001)
    expect(viewPort('not a url', 52001)).toBe(52001)
    expect(viewPort('ws://127.0.0.1:61000', undefined)).toBeNull()
  })
})

describe('the control channel on the host’s stdin (#280 step 3, #1895)', () => {
  it('reads one JSON object per line, across chunk boundaries, and ignores anything else', async () => {
    const input = new PassThrough()
    const ch = new ControlChannel(input)
    const seen: string[] = []
    ch.on('stop', (m) => seen.push(`stop ${m.forUpdate}`))
    input.write('not json\n{"op":"st')
    input.write('op","forUpdate":true}\n\n[1,2]\n')
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual(['stop true'])
  })

  /*
   * #538: the keeper writes the token as the first line on this same stdin, and the host reads it first
   * (`readHandedToken`), which leaves the stream paused with what followed put back. A listener alone does not
   * restart a paused stream: without the channel's own resume, every control line after the token went unread.
   */
  it('reads the control lines that came after the token line, from the paused stream it is handed', async () => {
    const input = new PassThrough()
    const token = readHandedToken(input, 1000)
    input.write('{"token":"t-1"}\n{"op":"system-ending"}\n')
    expect(await token).toBe('t-1')
    const ch = new ControlChannel(input)
    const seen: string[] = []
    ch.on('system-ending', (m) => seen.push(`ending ${m.cancelled === true}`))
    input.write('{"op":"system-ending","cancelled":true}\n')
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual(['ending false', 'ending true'])
  })

  it('a line that grows past 64 KiB without a newline is dropped, even one that would parse, and the next line is read (HO12)', async () => {
    const input = new PassThrough()
    const ch = new ControlChannel(input)
    const seen: string[] = []
    ch.on('stop', (m) => seen.push(`stop ${m.forUpdate}`))
    // Valid JSON once its end arrives, but over the cap before it does
    input.write(`{"op":"stop","forUpdate":false,"pad":"${'x'.repeat(64 * 1024)}`)
    input.write('"}\n{"op":"stop","forUpdate":true}\n')
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual(['stop true'])
  })

  it('keeps the last line of an op that came before its handler, and gives it when the handler is set (#1895)', async () => {
    const input = new PassThrough()
    const ch = new ControlChannel(input)
    input.write('{"op":"stop"}\n{"op":"stop","forUpdate":true}\n')
    await new Promise((r) => setImmediate(r))
    const seen: (boolean | undefined)[] = []
    ch.on('stop', (m) => seen.push(m.forUpdate))
    input.write('{"op":"stop"}\n')
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual([true, undefined])
  })
})
