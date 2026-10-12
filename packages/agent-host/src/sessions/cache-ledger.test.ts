import { describe, expect, it } from 'vitest'
import { CacheLedger, isRebuild, REBUILD_MIN_TOKENS, REBUILD_SHARE } from './cache-ledger.js'

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
    // A tool that reports no writes never rebuilds
    expect(isRebuild(req(0, undefined, 50_000))).toBe(false)
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
    expect(s.windows[0]).toMatchObject({ inputTokens: 9_000, cacheReadTokens: 10_000, cacheCreationTokens: 0, rebuilds: 0 })
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
