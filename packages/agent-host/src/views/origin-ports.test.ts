/**
 * Per-app origin ports (M4 B-3). WebKit keeps storage separated by origin (port included). So the
 * same app has to keep getting the same port across runs, and a port that has been assigned once
 * must never be given to a different app. "Host restart" means keeping only the store that holds
 * the assignment table and rebuilding the allocator from scratch.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OriginPorts, type PortBook, type PortBookStore } from './origin-ports.js'

const open: Server[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))))
})

/** An assignment table that behaves like disk — serializes on every save (sharing a reference could not simulate a restart) */
function diskStore(): PortBookStore & { raw: string | null } {
  return {
    raw: null,
    load() {
      return this.raw ? (JSON.parse(this.raw) as PortBook) : null
    },
    save(book) {
      this.raw = JSON.stringify(book)
    },
  }
}

/** n ports that are currently free. Gets them from the OS and releases them immediately */
async function freePorts(n: number): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const s = createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    out.push((s.address() as AddressInfo).port)
    await new Promise<void>((r) => s.close(() => r()))
  }
  return out
}

/** Hands out candidates in a fixed order. Once exhausted, gives an out-of-range value so it fails */
function sequence(ports: number[]): () => number {
  let i = 0
  return () => ports[i++] ?? -1
}

const noop = () => {}
const RANGE = [1024, 65535] as const

async function serve(ports: OriginPorts, key: string) {
  const got = await ports.serve(key, (_req, res) => res.end(key))
  open.push(got.server)
  return got
}

async function stop(server: Server) {
  await new Promise<void>((r) => server.close(() => r()))
}

describe('OriginPorts', () => {
  it('the same key gets the same port even after a restart, and a free port belonging to someone else is not taken', async () => {
    const [pA, pB, pC] = await freePorts(3)
    const disk = diskStore()

    // First run: same-named apps from two projects each get their own port
    const first = new OriginPorts(disk, { range: RANGE, pick: sequence([pA!, pB!]), log: noop })
    const a = await serve(first, 'p1/notes')
    const b = await serve(first, 'p2/notes')
    expect([a.port, b.port]).toEqual([pA, pB])
    await stop(a.server)
    await stop(b.server)

    // Restart: the allocator is new, and all that remains is the store. Even if a candidate for
    // someone else's port comes up first, it is not taken
    const second = new OriginPorts(disk, { range: RANGE, pick: sequence([pA!, pB!, pC!]), log: noop })
    const again = await serve(second, 'p1/notes')
    expect(again.port).toBe(pA)
    const fresh = await serve(second, '_user/new-app')
    // p2/notes is not currently running, so pB is free — it is still not given to the new app
    expect(fresh.port).toBe(pC)
    expect(disk.load()).toEqual({ assigned: { 'p1/notes': pA, 'p2/notes': pB, '_user/new-app': pC }, retired: [] })
  })

  it('binds only to loopback', async () => {
    const [p] = await freePorts(1)
    const got = await serve(new OriginPorts(diskStore(), { range: RANGE, pick: sequence([p!]), log: noop }), 'k')
    expect((got.server.address() as AddressInfo).address).toBe('127.0.0.1')
  })

  it('moves when another program holds the assigned port, and the old port is retired and goes to no one', async () => {
    const [pA, pB, pC] = await freePorts(3)
    const disk = diskStore()
    const first = await serve(new OriginPorts(disk, { range: RANGE, pick: sequence([pA!]), log: noop }), 'p1/notes')
    await stop(first.server)

    // Another program holds pA
    const squatter = createServer()
    await new Promise<void>((r) => squatter.listen(pA, '127.0.0.1', () => r()))
    open.push(squatter)

    const lines: string[] = []
    const second = new OriginPorts(disk, { range: RANGE, pick: sequence([pA!, pB!]), log: (l) => lines.push(l) })
    const moved = await serve(second, 'p1/notes')
    expect(moved.port).toBe(pB)
    expect(disk.load()).toEqual({ assigned: { 'p1/notes': pB }, retired: [pA] })
    expect(lines.join('\n')).toMatch(new RegExp(`port ${pA} for p1/notes is taken`))

    // Even after that program leaves, pA never comes back out
    await stop(squatter)
    const third = new OriginPorts(disk, { range: RANGE, pick: sequence([pA!, pC!]), log: noop })
    expect((await serve(third, 'p3/other')).port).toBe(pC)
  })

  it('skips a candidate currently held by someone else, but does not assign it', async () => {
    const [busy, free] = await freePorts(2)
    const squatter = createServer()
    await new Promise<void>((r) => squatter.listen(busy, '127.0.0.1', () => r()))
    open.push(squatter)
    const disk = diskStore()
    const got = await serve(new OriginPorts(disk, { range: RANGE, pick: sequence([busy!, free!]), log: noop }), 'k')
    expect(got.port).toBe(free)
    expect(disk.load()).toEqual({ assigned: { k: free }, retired: [] })
  })

  it('closes the server and throws if the assignment cannot be recorded — an unrecorded port could go to someone else on the next run', async () => {
    const [p] = await freePorts(1)
    const ports = new OriginPorts(
      {
        load: () => null,
        save: () => {
          throw new Error('disk full')
        },
      },
      { range: RANGE, pick: sequence([p!]), log: noop },
    )
    await expect(ports.serve('k', (_q, r) => r.end())).rejects.toThrow('disk full')
    // The port is free — nobody is holding it
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(p, '127.0.0.1', () => resolve())
    })
    await stop(probe)
  })

  it('reads a corrupted assignment table as empty, and drops only the invalid entries', async () => {
    const [p, q] = await freePorts(2)
    const disk = diskStore()
    disk.raw = JSON.stringify({ assigned: { good: p, bad: 'x', neg: -1, huge: 70000 }, retired: [q, 'y', 0] })
    const ports = new OriginPorts(disk, { range: RANGE, pick: sequence([q!, p!]), log: noop })
    expect(ports.book()).toEqual({ assigned: { good: p }, retired: [q] })
    disk.raw = '"not an object"'
    expect(ports.book()).toEqual({ assigned: {}, retired: [] })
  })
})
