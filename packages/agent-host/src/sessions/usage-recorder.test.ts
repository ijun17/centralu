import { describe, expect, it, vi } from 'vitest'
import { Store } from '../dev-services/store.js'
import { KEEP_DAYS, TURN_END_GAP_MS, UsageRecorder } from './usage-recorder.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 9, 12, 10, 0) // an hour boundary
const src = { sessionId: 's1', projectId: 'p1', tool: 'claude' as const, model: 'opus' }
const rebuild = { rebuild: true, cause: 'expired' as const }
const plain = { rebuild: false }

function setup(now = { at: T0 + 5 * 60_000 }) {
  const store = new Store()
  const rec = new UsageRecorder(store.usage, { accountOf: async () => 'acct', now: () => now.at })
  return { store, rec, now }
}

describe('UsageRecorder requests (docs/agent-host.md §6.2)', () => {
  it('sums the requests of an hour into one bucket per session, project, tool and model, and writes it once', () => {
    const { store, rec } = setup()
    rec.request(src, { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000, outputTokens: 70, cacheTtl: '1h' }, rebuild)
    rec.request(src, { inputTokens: 5, cacheReadTokens: 30_000, cacheCreationTokens: 500, outputTokens: 30, cacheTtl: '5m' }, plain)
    rec.request(src, { inputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3 }, plain)
    rec.request({ ...src, model: 'sonnet' }, { inputTokens: 1, cacheReadTokens: 1 }, plain)
    // Nothing is written until the flush
    expect(store.usage.buckets(0, T0 + 24 * HOUR)).toEqual([])

    expect(rec.flush()).toBe(2)
    expect(rec.flush()).toBe(0)
    const rows = store.usage.buckets(0, T0 + 24 * HOUR)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.model === 'opus')).toMatchObject({
      hour: T0, sessionId: 's1', projectId: 'p1', tool: 'claude', machine: '',
      requests: 3, input: 11, cacheRead: 30_002, cacheWrite: 30_503, cacheWrite1h: 30_000, cacheWrite5m: 500, output: 100,
      rebuilds: 1, causes: { expired: 1 },
    })
  })

  it('keys a request by the model that served it when the tool says, else by the session setting', () => {
    const { store, rec } = setup()
    rec.request(src, { inputTokens: 1, cacheReadTokens: 0, model: 'claude-haiku-5-5' }, plain)
    rec.request(src, { inputTokens: 2, cacheReadTokens: 0 }, plain)
    rec.flush()
    expect(store.usage.buckets(0, T0 + HOUR).map((b) => [b.model, b.input]).sort()).toEqual([['claude-haiku-5-5', 1], ['opus', 2]])
  })

  it('adds a later flush to the hour instead of replacing it, and starts a new row in the next hour', () => {
    const { store, rec, now } = setup()
    rec.request(src, { inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 9_000 }, rebuild)
    rec.flush()
    rec.request(src, { inputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 9_000 }, { rebuild: true, cause: 'model_change' })
    rec.request(src, { inputTokens: 4, cacheReadTokens: 0 }, plain)
    rec.flush()
    now.at += HOUR
    rec.request(src, { inputTokens: 8, cacheReadTokens: 0 }, plain, now.at)
    rec.flush()
    const rows = store.usage.buckets(0, T0 + 24 * HOUR)
    expect(rows.map((r) => [r.hour, r.requests, r.input, r.rebuilds, r.causes])).toEqual([
      [T0, 3, 7, 2, { expired: 1, model_change: 1 }],
      [T0 + HOUR, 1, 8, 0, {}],
    ])
  })

  it('keeps what it could not write for the next flush', () => {
    const { store, rec } = setup()
    rec.request(src, { inputTokens: 3, cacheReadTokens: 0 }, plain)
    const add = vi.spyOn(store.usage, 'addBuckets').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(rec.flush()).toBe(0)
    add.mockRestore()
    expect(rec.flush()).toBe(1)
    expect(store.usage.buckets(0, T0 + HOUR)[0]).toMatchObject({ input: 3 })
  })

  it('drops what a purged session had counted and not written', () => {
    const { store, rec } = setup()
    rec.request(src, { inputTokens: 3, cacheReadTokens: 0 }, plain)
    rec.forget('s1')
    expect(rec.flush()).toBe(0)
    expect(store.usage.buckets(0, T0 + HOUR)).toEqual([])
  })
})

describe('UsageRecorder limit readings', () => {
  const snap = (percent: number, resetsAt: string | null = '2026-10-15T00:00:00.000Z') => ({
    plan: null,
    daily: [],
    windows: [
      { id: 'weekly_all', label: 'Weekly', percent, resetsAt, scope: null },
      { id: 'weekly_scoped', label: 'Weekly', percent: percent / 2, resetsAt, scope: 'Opus' },
    ],
  })

  it('stores each window per tool and account, and leaves out a reading identical to the last one', async () => {
    const { store, rec, now } = setup()
    await rec.snapshot('claude', snap(40))
    now.at += 10 * 60_000
    await rec.snapshot('claude', snap(40)) // the same: not a row
    now.at += 10 * 60_000
    await rec.snapshot('claude', snap(44))
    now.at += 10 * 60_000
    await rec.snapshot('claude', snap(44, '2026-10-16T00:00:00.000Z')) // a new reset time is a change
    const r = store.usage.readings(0, T0 + 24 * HOUR).filter((x) => x.id === 'weekly_all')
    expect(r.map((x) => x.percent)).toEqual([40, 44, 44])
    expect(r[0]).toMatchObject({ tool: 'claude', account: 'acct', label: 'Weekly', scope: null, resetsAt: Date.parse('2026-10-15T00:00:00.000Z') })
    expect(store.usage.readings(0, T0 + 24 * HOUR).find((x) => x.id === 'weekly_scoped')).toMatchObject({ scope: 'Opus', percent: 20 })
  })

  it('treats a reset time that moved by a few hundred ms as the same reading (Claude derives it from a relative time)', async () => {
    const { store, rec, now } = setup()
    const base = Date.parse('2026-10-15T00:00:00.000Z')
    const at = (jitter: number) => snap(40, new Date(base + jitter).toISOString())
    for (const jitter of [0, 361, -224, 727]) {
      await rec.snapshot('claude', at(jitter))
      now.at += 10 * 60_000
    }
    expect(store.usage.readings(0, now.at).filter((x) => x.id === 'weekly_all')).toHaveLength(1)
    // A real change of the reset time (a new window began) still writes
    await rec.snapshot('claude', snap(2, new Date(base + 7 * 24 * HOUR).toISOString()))
    expect(store.usage.readings(0, now.at + 1).filter((x) => x.id === 'weekly_all').map((x) => x.percent)).toEqual([40, 2])
  })

  it('keeps accounts apart and asks which account only now and then', async () => {
    const store = new Store()
    const accountOf = vi.fn(async (): Promise<string> => 'a')
    const now = { at: T0 }
    const rec = new UsageRecorder(store.usage, { accountOf, now: () => now.at })
    await rec.snapshot('claude', snap(10))
    await rec.snapshot('claude', snap(11))
    expect(accountOf).toHaveBeenCalledTimes(1)
    accountOf.mockResolvedValue('b')
    now.at += 11 * 60_000
    await rec.snapshot('claude', snap(10))
    expect(new Set(store.usage.readings(0, now.at + 1).map((x) => x.account))).toEqual(new Set(['a', 'b']))
  })

  it('reads the limits at a turn end at most every couple of minutes', () => {
    const { rec, now } = setup()
    const read = vi.fn(async (_tool: string) => undefined)
    rec.turnEnded('claude', read)
    rec.turnEnded('claude', read)
    now.at += TURN_END_GAP_MS
    rec.turnEnded('claude', read)
    rec.turnEnded('codex', read)
    expect(read.mock.calls.map((c) => c[0])).toEqual(['claude', 'claude', 'codex'])
  })
})

describe('UsageRecorder keeping time', () => {
  it('prunes records older than 90 days, readings and buckets alike', async () => {
    const { store, rec, now } = setup()
    const old = now.at - (KEEP_DAYS + 1) * 24 * HOUR
    rec.request(src, { inputTokens: 1, cacheReadTokens: 0 }, plain, old)
    rec.request(src, { inputTokens: 2, cacheReadTokens: 0 }, plain, now.at - 2 * 24 * HOUR)
    rec.flush()
    await rec.snapshot('claude', { plan: null, daily: [], windows: [{ id: 'w', label: 'W', percent: 1, resetsAt: null, scope: null }] }, old)
    await rec.snapshot('claude', { plan: null, daily: [], windows: [{ id: 'w', label: 'W', percent: 2, resetsAt: null, scope: null }] }, now.at)
    rec.prune(true)
    expect(store.usage.buckets(0, now.at + HOUR).map((b) => b.input)).toEqual([2])
    expect(store.usage.readings(0, now.at + HOUR).map((r) => r.percent)).toEqual([2])
  })
})
