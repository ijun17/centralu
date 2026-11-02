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
      expect(p).toBeGreaterThanOrEqual(12000)
      expect(p).toBeLessThan(17000)
      expect(p).not.toBe(ephemeral)
    }
  })

  it('passes over a port that is taken, where its search begins', async () => {
    const taken = createServer()
    held.push(taken)
    await new Promise<void>((r) => taken.listen(12007, '127.0.0.1', r))
    expect(await freePort(7)).not.toBe(12007)
  })

  it('never gives one port twice', async () => {
    const ports = await Promise.all(Array.from({ length: 200 }, () => freePort()))
    expect(new Set(ports).size).toBe(200)
  })
})
