import { describe, expect, it } from 'vitest'
import { CacheLedger, DEFAULT_TTL_MS, isRebuild, REBUILD_MIN_TOKENS, REBUILD_SHARE } from './cache-ledger.js'

const HOUR = 3600_000
// 15:00 local, so "today" reaches back fifteen hours and "last 5 h" five
const NOW = new Date(2026, 9, 12, 15, 0).getTime()
const names: Record<string, string> = { a: 'Session A', b: 'Session B', c: 'Session C', d: 'Session D' }
const nameOf = (id: string) => names[id]

const req = (read: number, write: number | undefined, input = 10) => ({
  inputTokens: input,
  cacheReadTokens: read,
  ...(write === undefined ? {} : { cacheCreationTokens: write }),
})

describe('isRebuild', () => {
  it('is a request that wrote at least half its input, and at least the floor', () => {
    expect(isRebuild(req(0, 30_000))).toBe(true)
    // An ordinary request in a long session: reads 80k, writes what is new
    expect(isRebuild(req(80_000, 2_000))).toBe(false)
    // Below the floor, however large the share
    expect(isRebuild(req(0, REBUILD_MIN_TOKENS - 1, 0))).toBe(false)
    expect(isRebuild(req(0, REBUILD_MIN_TOKENS, 0))).toBe(true)
    // A tool that reports reads only: what it did not read from cache stands in for the write
    expect(isRebuild(req(0, undefined, 50_000))).toBe(true)
    expect(isRebuild(req(80_000, undefined, 2_000))).toBe(false)
    expect(isRebuild(req(1_000, undefined, REBUILD_MIN_TOKENS - 1))).toBe(false)
  })

  it('draws the line at the share, swept across it', () => {
    const write = 20_000
    for (let pct = 0; pct <= 100; pct += 1) {
      // write is `pct`% of the request's whole input
      const total = Math.round((write * 100) / Math.max(pct, 1))
      const r = req(pct === 0 ? 1_000_000 : total - write, write, 0)
      const share = write / (r.cacheReadTokens + write)
      expect(isRebuild(r), `${pct}%`).toBe(share >= REBUILD_SHARE)
    }
  })
})

describe('CacheLedger', () => {
  it('sums each window from the requests in it', () => {
    const l = new CacheLedger(NOW - 20 * HOUR)
    l.record('claude', 'a', req(1_000, 100), NOW - 6 * HOUR) // today only
    l.record('claude', 'a', req(9_000, 500), NOW - 1 * HOUR)
    l.record('claude', 'b', req(0, 40_000), NOW - 2 * HOUR) // a rebuild
    l.record('claude', 'a', req(5_000, 0), NOW - 16 * HOUR) // yesterday: in neither
    const s = l.stats('claude', nameOf, NOW)
    expect(s.writes).toBe(true)
    const [five, today] = s.windows
    expect(five).toMatchObject({ id: '5h', requests: 2, inputTokens: 20, cacheReadTokens: 9_000, cacheCreationTokens: 40_500, rebuilds: 1 })
    expect(today).toMatchObject({ id: 'today', requests: 3, cacheReadTokens: 10_000, cacheCreationTokens: 40_600, rebuilds: 1 })
    expect(five!.since).toBe(new Date(NOW - 5 * HOUR).toISOString())
    expect(today!.since).toBe(new Date(2026, 9, 12, 0, 0).toISOString())
  })

  it('names the sessions that wrote most, most first, a few at most', () => {
    const l = new CacheLedger(NOW - HOUR)
    l.record('claude', 'a', req(0, 10_000), NOW - 30 * 60_000)
    l.record('claude', 'b', req(0, 50_000), NOW - 20 * 60_000)
    l.record('claude', 'c', req(0, 30_000), NOW - 10 * 60_000)
    l.record('claude', 'd', req(0, 20_000), NOW - 5 * 60_000)
    l.record('claude', 'gone', req(0, 5_000), NOW - 5 * 60_000)
    const top = l.stats('claude', nameOf, NOW).windows[0]!.sessions
    expect(top.map((s) => [s.sessionId, s.name, s.cacheCreationTokens, s.rebuilds])).toEqual([
      ['b', 'Session B', 50_000, 1],
      ['c', 'Session C', 30_000, 1],
      ['d', 'Session D', 20_000, 1],
    ])
  })

  it('ranks a tool that reports reads only by its uncached input, and says it reports no writes', () => {
    const l = new CacheLedger(NOW - HOUR)
    l.record('codex', 'a', req(9_000, undefined, 1_000), NOW - 30 * 60_000)
    l.record('codex', 'b', req(1_000, undefined, 8_000), NOW - 20 * 60_000)
    const s = l.stats('codex', nameOf, NOW)
    expect(s.writes).toBe(false)
    // b read 1,000 of 9,000 from cache: a rebuild for a tool that reports reads only
    expect(s.windows[0]).toMatchObject({ inputTokens: 9_000, cacheReadTokens: 10_000, cacheCreationTokens: 0, rebuilds: 1 })
    expect(s.windows[0]!.sessions.map((x) => x.sessionId)).toEqual(['b', 'a'])
  })

  it('keeps tools apart', () => {
    const l = new CacheLedger(NOW - HOUR)
    l.record('claude', 'a', req(100, 10), NOW - 60_000)
    expect(l.stats('codex', nameOf, NOW).windows[0]!.requests).toBe(0)
  })

  it('does not count a synthesized answer that carries no input', () => {
    const l = new CacheLedger(NOW - HOUR)
    l.record('claude', 'a', req(0, 0, 0), NOW - 60_000)
    expect(l.stats('claude', nameOf, NOW).windows[0]!.requests).toBe(0)
  })

  it('says when it began counting, so the screen can say "since"', () => {
    const l = new CacheLedger(NOW - 2 * HOUR)
    expect(l.stats('claude', nameOf, NOW).countingSince).toBe(new Date(NOW - 2 * HOUR).toISOString())
  })

  it('lets go of entries older than a day as new ones arrive', () => {
    const l = new CacheLedger(NOW - 30 * HOUR)
    l.record('claude', 'a', req(100, 0), NOW - 25 * HOUR)
    l.record('claude', 'a', req(100, 0), NOW)
    const held = (l as unknown as { entries: Map<string, unknown[]> }).entries.get('claude')!
    expect(held).toHaveLength(1)
  })

  it('holds at most its cap, the oldest dropped first', () => {
    const l = new CacheLedger(NOW - HOUR)
    for (let i = 0; i < 50_010; i++) l.record('claude', 'a', req(1, 0, 0), NOW - HOUR + i)
    const held = (l as unknown as { entries: Map<string, { at: number }[]> }).entries.get('claude')!
    expect(held).toHaveLength(50_000)
    expect(held[0]!.at).toBe(NOW - HOUR + 10)
  })
})

/*
 * Why each rebuild happened (docs/agent-host.md §6.1): from what the host was told between the conversation's last
 * request and this one, strongest evidence first, then the idle time against the lifetime the API reported.
 */
describe('CacheLedger rebuild causes', () => {
  const MIN = 60_000
  const rebuild = { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000 }
  const ordinary = { inputTokens: 5, cacheReadTokens: 30_000, cacheCreationTokens: 500 }
  const causes = (l: CacheLedger) => l.stats('claude', nameOf, NOW).windows[0]!.rebuildCauses

  it('names the first request of a new session a cold start', () => {
    const l = new CacheLedger(NOW - HOUR)
    l.note('a', 'cold_start')
    l.record('claude', 'a', rebuild, NOW - 10 * MIN)
    expect(causes(l)).toEqual({ cold_start: 1 })
  })

  it("names a session's first request seen by this host, with nothing noted, a new process (a restart or a host swap)", () => {
    const l = new CacheLedger(NOW - HOUR)
    l.record('claude', 'a', rebuild, NOW - 10 * MIN)
    expect(causes(l)).toEqual({ new_process: 1 })
  })

  it('takes the strongest evidence when several things happened, in the documented order', () => {
    const order = ['new_process', 'model_change', 'compaction', 'thread_restart', 'instructions', 'launch_settings'] as const
    for (let i = 0; i < order.length; i++) {
      const l = new CacheLedger(NOW - HOUR)
      l.record('claude', 'a', ordinary, NOW - 20 * MIN)
      // Everything weaker than order[i] is noted too, and a long idle gap on top
      for (const c of order.slice(i).reverse()) l.note('a', c)
      l.record('claude', 'a', rebuild, NOW - 1 * MIN)
      expect(causes(l), order[i]).toEqual({ [order[i]!]: 1 })
    }
  })

  it('uses a note once: the next rebuild is judged on its own', () => {
    const l = new CacheLedger(NOW - HOUR)
    l.record('claude', 'a', ordinary, NOW - 30 * MIN)
    l.note('a', 'model_change')
    l.record('claude', 'a', ordinary, NOW - 29 * MIN) // not a rebuild, and the note is gone with it
    l.record('claude', 'a', rebuild, NOW - 28 * MIN)
    expect(causes(l)).toEqual({ unknown: 1 })
  })

  it("keeps a subagent's requests apart: its first is a subagent start, and it does not take the session's notes", () => {
    const l = new CacheLedger(NOW - HOUR)
    l.record('claude', 'a', ordinary, NOW - 30 * MIN)
    l.note('a', 'compaction')
    l.record('claude', 'a', { ...rebuild, agent: 'tu1' }, NOW - 29 * MIN)
    l.record('claude', 'a', rebuild, NOW - 28 * MIN)
    expect(causes(l)).toEqual({ subagent: 1, compaction: 1 })
  })

  it('names idle longer than the lifetime the API reported "cache expired", and within it "unknown"', () => {
    for (const [ttl, idleMin, cause] of [
      ['5m', 6, 'expired'],
      ['5m', 4, 'unknown'],
      ['1h', 30, 'unknown'],
      ['1h', 61, 'expired'],
    ] as const) {
      const l = new CacheLedger(NOW - 3 * HOUR)
      l.record('claude', 'a', { ...ordinary, cacheTtl: ttl }, NOW - (idleMin + 1) * MIN)
      l.record('claude', 'a', rebuild, NOW - 1 * MIN)
      expect(causes(l), `${ttl} after ${idleMin} min`).toEqual({ [cause]: 1 })
    }
  })

  it('remembers the lifetime from the last request that reported one, when later ones wrote nothing', () => {
    const l = new CacheLedger(NOW - 3 * HOUR)
    l.record('claude', 'a', { ...ordinary, cacheTtl: '1h' }, NOW - 50 * MIN)
    l.record('claude', 'a', { inputTokens: 5, cacheReadTokens: 30_000, cacheCreationTokens: 0 }, NOW - 40 * MIN)
    l.record('claude', 'a', rebuild, NOW - 1 * MIN) // 39 min idle, inside the hour
    expect(causes(l)).toEqual({ unknown: 1 })
  })

  it('without a reported lifetime, says "probably expired" past five minutes, swept across the line', () => {
    for (let idleSec = 240; idleSec <= 360; idleSec += 10) {
      const l = new CacheLedger(NOW - HOUR)
      l.record('codex', 'a', { inputTokens: 1_000, cacheReadTokens: 30_000 }, NOW - 10 * MIN - idleSec * 1000)
      l.record('codex', 'a', { inputTokens: 30_000, cacheReadTokens: 1_000 }, NOW - 10 * MIN)
      const w = l.stats('codex', nameOf, NOW).windows[0]!
      expect(w.rebuildCauses, `${idleSec}s`).toEqual({ [idleSec * 1000 > DEFAULT_TTL_MS ? 'probably_expired' : 'unknown']: 1 })
    }
  })

  it('reports the shortest and longest idle time before the rebuilds put down to expiry, and counts causes per session', () => {
    const l = new CacheLedger(NOW - 4 * HOUR)
    l.record('claude', 'a', { ...ordinary, cacheTtl: '5m' }, NOW - 3 * HOUR)
    l.record('claude', 'a', rebuild, NOW - 3 * HOUR + 12 * MIN)
    l.record('claude', 'a', rebuild, NOW - 3 * HOUR + 76 * MIN)
    l.note('a', 'model_change')
    l.record('claude', 'a', rebuild, NOW - 3 * HOUR + 77 * MIN)
    const w = l.stats('claude', nameOf, NOW).windows[0]!
    expect(w.rebuildCauses).toEqual({ expired: 2, model_change: 1 })
    expect(w.expiredIdleMs).toEqual({ min: 12 * MIN, max: 64 * MIN })
    expect(w.sessions[0]!.rebuildCauses).toEqual({ expired: 2, model_change: 1 })
  })

  it('holds a bounded number of notes for sessions that never make a request', () => {
    const l = new CacheLedger(NOW - HOUR)
    for (let i = 0; i < 6_000; i++) l.note(`s${i}`, 'cold_start')
    expect((l as unknown as { notes: Map<string, unknown> }).notes.size).toBe(5_000)
  })

  it('says what it counted, so the history records the same rebuild with the same cause', () => {
    const l = new CacheLedger(NOW - HOUR)
    l.note('a', 'model_change')
    l.record('claude', 'a', req(5_000, 100), NOW - 2 * HOUR) // takes the note, not a rebuild
    expect(l.record('claude', 'a', req(5_000, 100), NOW - HOUR)).toEqual({ rebuild: false })
    expect(l.record('claude', 'a', req(0, 40_000), NOW - 1_000)).toEqual({ rebuild: true, cause: 'probably_expired' })
    // A reading that was no request counts as nothing
    expect(l.record('claude', 'a', req(0, 0, 0), NOW)).toBeUndefined()
  })

  it('forgets a purged session, so no window names it with an empty name', () => {
    const l = new CacheLedger(NOW - 9 * HOUR)
    l.restore([{ hour: NOW - 3 * HOUR, sessionId: 'a', projectId: 'p', tool: 'claude', model: '', machine: '', requests: 2, input: 1, cacheRead: 1, cacheWrite: 50_000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, rebuilds: 1, rebuildTokens: 50_000, causes: { expired: 1 } }])
    l.record('claude', 'a', req(0, 40_000), NOW - HOUR)
    l.record('claude', 'b', req(0, 30_000), NOW - HOUR)
    l.forget('a')
    expect(l.stats('claude', nameOf, NOW).windows[0]!.sessions.map((s) => s.sessionId)).toEqual(['b'])
  })

  it('takes the buckets an earlier run stored, so the figures outlive a restart, and counts them once', () => {
    const l = new CacheLedger(NOW)
    const hour = NOW - 3 * HOUR // 12:00
    const bucket = (over: object) => ({ hour, sessionId: 'a', projectId: 'p', tool: 'claude' as const, model: '', machine: '', requests: 4, input: 40, cacheRead: 9_000, cacheWrite: 41_000, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, rebuilds: 1, rebuildTokens: 41_000, causes: { expired: 1 }, ...over })
    l.restore([bucket({}), bucket({ hour: NOW - 9 * HOUR, requests: 2, cacheWrite: 5, rebuilds: 0, causes: {} })])
    l.record('claude', 'a', req(1_000, 10), NOW - 1_000)
    const s = l.stats('claude', nameOf, NOW)
    expect(s.writes).toBe(true)
    expect(s.countingSince).toBe(new Date(NOW - 9 * HOUR).toISOString())
    const [five, today] = s.windows
    expect(five).toMatchObject({ requests: 5, cacheReadTokens: 10_000, cacheCreationTokens: 41_010, rebuilds: 1, rebuildCauses: { expired: 1 } })
    expect(today).toMatchObject({ requests: 7, cacheCreationTokens: 41_015 })
    expect(five!.sessions).toMatchObject([{ sessionId: 'a', requests: 5, rebuilds: 1, rebuildCauses: { expired: 1 } }])
    // Another tool has nothing of it
    expect(l.stats('codex', nameOf, NOW).windows[0]).toMatchObject({ requests: 0 })
  })
})

describe('what the rebuilds wrote, and what the cache cost (#1492)', () => {
  it('puts a rebuild’s writes into rebuildTokens, per window and per session, and a steady write is not in it', () => {
    const l = new CacheLedger(NOW - 9 * HOUR)
    // Steady work: reads what it had, writes what is new
    l.record('claude', 'a', req(80_000, 2_000), NOW - 3 * HOUR)
    l.record('claude', 'a', req(82_000, 1_500), NOW - 2 * HOUR)
    // Two rebuilds of one session and one of another
    expect(l.record('claude', 'a', req(0, 60_000), NOW - HOUR)).toMatchObject({ rebuild: true })
    l.record('claude', 'a', req(500, 25_000), NOW - 30 * 60_000)
    l.record('claude', 'b', req(0, 40_000), NOW - 20 * 60_000)
    const [five] = l.stats('claude', nameOf, NOW).windows
    expect(five).toMatchObject({ rebuilds: 3, rebuildTokens: 125_000, cacheCreationTokens: 128_500 })
    const bySession = Object.fromEntries(five!.sessions.map((s) => [s.sessionId, s]))
    expect(bySession.a).toMatchObject({ rebuilds: 2, rebuildTokens: 85_000, cacheCreationTokens: 88_500 })
    expect(bySession.b).toMatchObject({ rebuilds: 1, rebuildTokens: 40_000 })
    // No rebuild: none written
    const calm = new CacheLedger(NOW - HOUR)
    calm.record('claude', 'a', req(80_000, 2_000), NOW - 1_000)
    expect(calm.stats('claude', nameOf, NOW).windows[0]).toMatchObject({ rebuilds: 0, rebuildTokens: 0 })
    // A tool that reports reads only: the input it did not read stands in
    const codex = new CacheLedger(NOW - HOUR)
    codex.record('codex', 'a', req(0, undefined, 50_000), NOW - 1_000)
    codex.record('codex', 'a', req(80_000, undefined, 2_000), NOW - 500)
    expect(codex.stats('codex', nameOf, NOW).windows[0]).toMatchObject({ rebuilds: 1, rebuildTokens: 50_000 })
  })

  it('weights the cache cost by the price ratios, with a mix of five-minute and one-hour writes', () => {
    const l = new CacheLedger(NOW - HOUR)
    // read 0.1, five-minute write 1.25, one-hour write 2: 90,000 read; 3,000 written for five minutes and 1,000 for an hour
    l.record('claude', 'a', { ...req(90_000, 4_000, 0), cacheWrite5mTokens: 3_000, cacheWrite1hTokens: 1_000, cacheTtl: '1h' }, NOW - 1_000)
    const w = l.stats('claude', nameOf, NOW).windows[0]!
    expect(w.cacheReadCost).toBeCloseTo(9_000)
    expect(w.cacheWriteCost).toBeCloseTo(3_000 * 1.25 + 1_000 * 2)
    // The write share of what the cache cost: 5,750 of 14,750, where the hit rate by tokens is 96%
    expect(w.cacheWriteCost! / (w.cacheReadCost! + w.cacheWriteCost!)).toBeCloseTo(5_750 / 14_750)
    // A request that did not split its writes is priced as five minutes, and one under a single reported lifetime by that
    const plain = new CacheLedger(NOW - HOUR)
    plain.record('claude', 'a', req(1_000, 2_000, 0), NOW - 2_000)
    plain.record('claude', 'a', { ...req(0, 1_000, 0), cacheTtl: '1h' }, NOW - 1_000)
    expect(plain.stats('claude', nameOf, NOW).windows[0]).toMatchObject({ cacheReadCost: 100, cacheWriteCost: 2_000 * 1.25 + 1_000 * 2 })
  })

  it('prices Codex by model: GPT-5.6 on reads at 0.1, Sol at 0.05, and a 30-minute write at 1.25; an older model has no write price', () => {
    const cost = (model: string) => {
      const l = new CacheLedger(NOW - HOUR, (tool) => (tool === 'codex' ? 'openai' : 'anthropic'))
      l.record('codex', 'a', req(10_000, undefined, 1_000), NOW - 1_000, model)
      const w = l.stats('codex', nameOf, NOW).windows[0]!
      return [w.cacheReadCost, w.cacheWriteCost]
    }
    expect(cost('gpt-5.6')).toEqual([1_000, 1_250])
    expect(cost('gpt-5.7-codex')).toEqual([1_000, 1_250])
    expect(cost('gpt-5.6-sol')).toEqual([500, 1_250])
    expect(cost('gpt-5.5')).toEqual([1_000, 1_000])
    expect(cost('')).toEqual([1_000, 1_000])
  })

  it('takes both from the buckets an earlier run stored, and says the tokens are not known for rebuilds stored without them', () => {
    const l = new CacheLedger(NOW)
    const bucket = (over: object) => ({ hour: NOW - 3 * HOUR, sessionId: 'a', projectId: 'p', tool: 'claude' as const, model: '', machine: '', requests: 4, input: 40, cacheRead: 9_000, cacheWrite: 41_000, cacheWrite5m: 1_000, cacheWrite1h: 40_000, output: 0, rebuilds: 1, rebuildTokens: 40_000, causes: { expired: 1 }, ...over })
    l.restore([bucket({})])
    l.record('claude', 'a', req(0, 30_000), NOW - 1_000)
    const [five] = l.stats('claude', nameOf, NOW).windows
    expect(five).toMatchObject({ rebuilds: 2, rebuildTokens: 70_000 })
    expect(five!.cacheReadCost).toBeCloseTo(900)
    expect(five!.cacheWriteCost).toBeCloseTo(40_000 * 2 + 1_000 * 1.25 + 30_000 * 1.25)
    expect(five!.sessions[0]).toMatchObject({ rebuildTokens: 70_000 })

    // An hour from before the column had rebuilds counted and no tokens: the sum is not known, and is not shown as smaller
    const old = new CacheLedger(NOW)
    old.restore([bucket({ rebuildTokens: 0 }), bucket({ sessionId: 'b', rebuildTokens: 20_000 })])
    const o = old.stats('claude', nameOf, NOW).windows[0]!
    expect(o.rebuilds).toBe(2)
    expect(o).not.toHaveProperty('rebuildTokens')
    const sessions = Object.fromEntries(o.sessions.map((x) => [x.sessionId, x]))
    expect(sessions.a).not.toHaveProperty('rebuildTokens')
    expect(sessions.b).toMatchObject({ rebuildTokens: 20_000 })
  })
})
