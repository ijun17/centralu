import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { freePort } from './free-port.js'

const held: Server[] = []
afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

describe('freePort', () => {
  it('stays out of the ephemeral range, where listen(0) and every outgoing connection draw from', async () => {
    const probe = createServer()
    held.push(probe)
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const ephemeral = (probe.address() as { port: number }).port
    const ports = await Promise.all(Array.from({ length: 50 }, () => freePort()))
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(20000)
      expect(p).toBeLessThan(30000)
      expect(p).not.toBe(ephemeral)
    }
  })

  it('never gives one port twice, and never one that is taken', async () => {
    const first = await freePort()
    const taken = createServer()
    held.push(taken)
    await new Promise<void>((r) => taken.listen(first, '127.0.0.1', r))
    const more = await Promise.all(Array.from({ length: 200 }, () => freePort()))
    expect(new Set([first, ...more]).size).toBe(201)
  })
})
