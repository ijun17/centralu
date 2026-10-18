/**
 * Per-app origin ports (M4 B-3). WebKit keeps storage separated by origin (port included). So the
 * same app has to keep getting the same port across runs, and a port that has been assigned once
 * must never be given to a different app. "Host restart" means keeping only the store that holds
 * the assignment table and rebuilding the allocator from scratch.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomInt } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OriginPorts, parsePortBook, type PortBook, type PortBookStore } from './origin-ports.js'

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

// Below the normal Linux/macOS/Windows ephemeral ranges and the production origin range.
// listen(0) elsewhere must not claim a candidate between its probe and the test's bind.
const CANDIDATE_RANGE = [10000, 19999] as const

/** Probe distinct candidates, holding them until the whole set has been collected. */
async function freePorts(n: number): Promise<number[]> {
  const out: number[] = []
  const held: Server[] = []
  const [lo, hi] = CANDIDATE_RANGE
  const size = hi - lo + 1
  const start = randomInt(size)
  try {
    for (let i = 0; i < size && out.length < n; i++) {
      const port = lo + ((start + i) % size)
      const s = createServer()
      try {
        await new Promise<void>((resolve, reject) => {
          s.once('error', reject)
          s.listen(port, '127.0.0.1', () => resolve())
        })
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        // Windows reports EACCES for ports reserved by Hyper-V or WSL.
        if (code === 'EADDRINUSE' || code === 'EACCES') continue
        throw e
      }
      held.push(s)
      out.push(port)
    }
    if (out.length !== n) throw new Error(`Could not find ${n} free test ports in ${lo}-${hi}`)
    return out
  } finally {
    await Promise.all(held.map(stop))
  }
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
  it('uses distinct candidate ports outside the ephemeral range that can all be rebound', async () => {
    const candidates = await freePorts(3)
    expect(new Set(candidates).size).toBe(3)
    const ports = new OriginPorts(diskStore(), { range: RANGE, pick: sequence(candidates), log: noop })
    for (const port of candidates) {
      expect(port).toBeGreaterThanOrEqual(CANDIDATE_RANGE[0])
      expect(port).toBeLessThanOrEqual(CANDIDATE_RANGE[1])
      expect((await serve(ports, `app-${port}`)).port).toBe(port)
    }
  })

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

  /*
   * The book is one row another build reads and writes too (#384): during a host swap, and after a person goes back
   * a release. Whatever it holds that this build cannot read must not cost the promise above, that a port once given
   * to an app is never given to another one.
   */
  describe('a book another build wrote', () => {
    /** The row as main.ts reads it: text, parsed by `parsePortBook` */
    function textStore(raw: string): PortBookStore & { raw: string; said: string[] } {
      return {
        raw,
        said: [],
        load() {
          return parsePortBook(this.raw, (line) => void this.said.push(line))
        },
        save(book) {
          this.raw = JSON.stringify(book)
        },
      }
    }

    it('keeps the fields this build does not know when it records a port', async () => {
      const [p, q] = await freePorts(2)
      const disk = textStore(JSON.stringify({ assigned: { 'p/a': p }, retired: [], movedAt: { 'p/a': 5 } }))
      const ports = new OriginPorts(disk, { range: RANGE, pick: sequence([q!]), log: noop })
      expect((await serve(ports, 'p/b')).port).toBe(q)
      expect(JSON.parse(disk.raw)).toEqual({ assigned: { 'p/a': p, 'p/b': q }, retired: [], movedAt: { 'p/a': 5 } })
    })

    it('never gives the port inside an assignment it cannot read to another app', async () => {
      const [p, q] = await freePorts(2)
      const disk = textStore(JSON.stringify({ assigned: { 'p/a': { port: p, since: 1 } }, retired: [] }))
      const ports = new OriginPorts(disk, { range: RANGE, pick: sequence([p!, q!]), log: noop })
      expect((await serve(ports, 'p/b')).port).toBe(q)
      expect(JSON.parse(disk.raw).retired).toContain(p)
    })

    it('retires every port a book that is not JSON names, says so naming the row, and gives the next app another', async () => {
      const [p, q, r] = await freePorts(3)
      const disk = textStore(`{"assigned":{"p/a":${p},"p/b":${q},"p/c":`)
      const ports = new OriginPorts(disk, { range: RANGE, pick: sequence([p!, q!, r!]), log: noop })
      expect((await serve(ports, 'p/d')).port).toBe(r)
      expect(JSON.parse(disk.raw)).toMatchObject({ assigned: { 'p/d': r }, retired: expect.arrayContaining([p, q]) })
      expect(disk.said.join(' | ')).toMatch(/not a JSON object.*retired/)
    })
  })

  it('keeps every key recorded when several first-time keys are served at once', async () => {
    const candidates = await freePorts(3)
    const disk = diskStore()
    const ports = new OriginPorts(disk, { range: RANGE, pick: sequence(candidates), log: noop })
    const got = await Promise.all(['p1/a', 'p2/b', 'p3/c'].map((key) => serve(ports, key)))
    expect(new Set(got.map((g) => g.port)).size).toBe(3)
    const recorded = disk.load()!
    expect(Object.keys(recorded.assigned).sort()).toEqual(['p1/a', 'p2/b', 'p3/c'])
    for (const [i, key] of ['p1/a', 'p2/b', 'p3/c'].entries()) expect(recorded.assigned[key]).toBe(got[i]!.port)
  })

  it('gives up a port that another writer recorded while it was being bound', async () => {
    const [taken, other] = await freePorts(2)
    const disk = diskStore()
    // The writer of the shared store (the other host of a swap) records `taken` for its own key
    // right before this serve() commits
    let rival = true
    const store: PortBookStore = {
      load: () => disk.load(),
      save: (book) => disk.save(book),
      update(fn) {
        if (rival) {
          rival = false
          disk.save({ assigned: { 'rival/app': taken! }, retired: [] })
        }
        disk.save(fn(disk.load()))
      },
    }
    const ports = new OriginPorts(store, { range: RANGE, pick: sequence([taken!, other!]), log: noop })
    const got = await serve(ports, 'mine')
    expect(got.port).toBe(other)
    expect(disk.load()).toEqual({ assigned: { 'rival/app': taken, mine: other }, retired: [] })
    // The port given up was closed again
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(taken, '127.0.0.1', () => resolve())
    })
    await stop(probe)
  })

  it('keeps a port retired by another writer retired when it moves its own', async () => {
    const [pA, pB, pC] = await freePorts(3)
    const disk = diskStore()
    const first = await serve(new OriginPorts(disk, { range: RANGE, pick: sequence([pA!]), log: noop }), 'p1/notes')
    await stop(first.server)
    const squatter = createServer()
    await new Promise<void>((r) => squatter.listen(pA, '127.0.0.1', () => r()))
    open.push(squatter)
    let rival = true
    const store: PortBookStore = {
      load: () => disk.load(),
      save: (book) => disk.save(book),
      update(fn) {
        if (rival) {
          rival = false
          const cur = disk.load()!
          disk.save({ ...cur, retired: [...cur.retired, pC!] })
        }
        disk.save(fn(disk.load()))
      },
    }
    const moved = await serve(new OriginPorts(store, { range: RANGE, pick: sequence([pB!]), log: noop }), 'p1/notes')
    expect(moved.port).toBe(pB)
    expect(disk.load()).toEqual({ assigned: { 'p1/notes': pB }, retired: [pC, pA] })
  })

  it('retires a different port that another writer recorded for the same key meanwhile, instead of overwriting it silently', async () => {
    const [theirs, mine] = await freePorts(2)
    const disk = diskStore()
    let rival = true
    const store: PortBookStore = {
      load: () => disk.load(),
      save: (book) => disk.save(book),
      update(fn) {
        if (rival) {
          rival = false
          disk.save({ assigned: { k: theirs! }, retired: [] })
        }
        disk.save(fn(disk.load()))
      },
    }
    const lines: string[] = []
    // No entry for `k` at first, so this serve() allocates; the entry appears just before it records
    const got = await serve(new OriginPorts(store, { range: RANGE, pick: sequence([mine!]), log: (l) => lines.push(l) }), 'k')
    expect(got.port).toBe(mine)
    expect(disk.load()).toEqual({ assigned: { k: mine }, retired: [theirs] })
    expect(lines.join('\n')).toMatch(new RegExp(`port ${theirs} for k was recorded elsewhere`))
  })
})
