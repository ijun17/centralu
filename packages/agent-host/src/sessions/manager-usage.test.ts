/**
 * SessionManager's `agents.usage` through RPC with an in-memory adapter: the limits, the cache figures and their history.
 * Shared fakes and the world each test starts from are in manager.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, ToolName, UsageHistory } from '@cc/protocol'
import { NO_LIMITS, type AgentAdapter } from '../adapters/contract.js'
import { openCodeUsageReader } from '../adapters/opencode/usage.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { FakeAdapter, managerWorld, projectDirs } from './manager.test-helpers.js'

let store: Store
let adapter: FakeAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  ;({ store, adapter, mgr, rpc } = managerWorld())
})
const dir = projectDirs()
const addProject = () => rpc('projects.add', { path: dir('cc-usage-') }) as Promise<{ id: string; path: string }>

describe('agents.usage: limits and prompt cache figures', () => {
  const listed = async (id: string) =>
    ((await rpc('sessions.list', {})) as SessionInfo[]).find((x) => x.id === id)!

  it('answers the cache figures alone when the hub shows its own limits for this machine, and says which account it is logged in to (#726)', async () => {
    let reads = 0
    Object.assign(adapter, {
      listUsage: async () => (reads++, { plan: 'max', windows: [], daily: [] }),
      account: async () => ({ loggedIn: true, fingerprint: 'abc' }),
    })
    expect(await rpc('agents.usage', { tool: 'claude', limits: false })).toMatchObject({ supported: true, usage: null, cache: expect.anything() })
    expect(reads).toBe(0)
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: true, usage: { plan: 'max' } })
    expect(reads).toBe(1)
    expect(await rpc('agents.account', { tool: 'claude' })).toEqual({ loggedIn: true, fingerprint: 'abc' })
    // A tool whose adapter does not say answers unknown, not an error
    expect(await rpc('agents.account', { tool: 'codex' })).toEqual({ loggedIn: null, fingerprint: null })
  })

  it('marks only a tool with no way to report usage as notReported, not a read that failed (#1616)', async () => {
    Object.assign(adapter, { listUsage: async () => Promise.reject(new Error('not logged in')) })
    const failed = await rpc('agents.usage', { tool: 'claude' })
    expect(failed).toMatchObject({ supported: false, reason: 'not logged in' })
    expect(failed).not.toHaveProperty('notReported')
    Object.assign(adapter, { listUsage: undefined })
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({
      supported: false,
      reason: 'Claude Code does not report usage limits',
      notReported: true,
    })
  })

  it("keeps the plan through a failed limits read, from the tool's own command, with the read's reason (#2459)", async () => {
    let local: () => Promise<unknown> = async () => ({ plan: 'Free' })
    Object.assign(adapter, { listUsage: async () => Promise.reject(new Error('Cursor did not share its usage')), localUsage: () => local() })
    const failed = await rpc('agents.usage', { tool: 'claude' })
    expect(failed).toMatchObject({ supported: false, reason: 'Cursor did not share its usage', usage: { plan: 'Free', windows: [] } })
    expect(failed).not.toHaveProperty('notReported')
    expect(failed).not.toHaveProperty('provisional')

    local = async () => ({ plan: null, provisional: true })
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: false, provisional: true, usage: { plan: null } })

    local = async () => ({ plan: null, loggedOut: true })
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: false, reason: 'Claude Code is not logged in on this computer', usage: null })

    local = async () => Promise.reject(new Error('agent about failed'))
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: false, reason: 'Cursor did not share its usage', usage: null })
  })

  it('reads the limits once for asks that come together; a failure keeps the last good ones, and the next ask reads again (#2459)', async () => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      let reads = 0
      let answer: (s: unknown) => void = () => {}
      const good = { plan: 'Pro', windows: [{ id: 'included', label: 'Included', percent: 40, resetsAt: null, scope: null }], daily: [] }
      Object.assign(adapter, { listUsage: () => (reads++, new Promise((resolve) => (answer = resolve))), localUsage: async () => ({ plan: 'Free' }) })
      const asks = [rpc('agents.usage', { tool: 'claude' }), rpc('agents.usage', { tool: 'claude' })]
      await vi.waitFor(() => expect(reads).toBe(1))
      answer(good)
      for (const r of await Promise.all(asks)) expect(r).toMatchObject({ supported: true, usage: good })

      now += 61_000
      Object.assign(adapter, { listUsage: async () => (reads++, Promise.reject(new Error('Cursor did not share its usage'))) })
      // The last good numbers, not only the plan the tool's own command says
      expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: false, reason: 'Cursor did not share its usage', usage: good })
      // A failure is not kept here: a tool that wants it kept keeps it in its listUsage (Cursor's)
      now += 1_000
      expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: false, reason: 'Cursor did not share its usage', usage: good })
      expect(reads).toBe(3)
    } finally {
      clock.mockRestore()
    }
  })

  it('does not say a tool with no adapter reports no limits: nothing is known about it, so it is unknown (#1616)', async () => {
    const r = await rpc('agents.usage', { tool: 'cursor' })
    expect(r).toMatchObject({ supported: false, reason: 'cursor does not support usage queries', usage: null })
    expect(r).not.toHaveProperty('notReported')
  })

  it('has one definition of a tool that reports no limits: no listUsage, or one that answers no limits for the plan, read once a minute (#1623, #2459)', async () => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const totals = { scope: 'all time', rows: [{ id: 'input', label: 'Input', value: 5, unit: 'tokens' }] }
      const asks: unknown[] = []
      Object.assign(adapter, {
        listUsage: undefined,
        localUsage: async (ask?: unknown) => (asks.push(ask), { plan: 'Free', totals }),
      })
      const r = await rpc('agents.usage', { tool: 'claude' })
      expect(r).toMatchObject({ supported: false, notReported: true, usage: { plan: 'Free', windows: [], daily: [], totals } })
      expect(r).toHaveProperty('reason', 'Claude Code does not report usage limits')
      expect(r).not.toHaveProperty('provisional')
      // The adapter's reader keeps what it read; the host keeps nothing of its own, so each ask goes to it
      await rpc('agents.usage', { tool: 'claude' })
      expect(asks).toHaveLength(2)

      // A tool that has listUsage reports limits, whatever its snapshot says
      let reads = 0
      let answer: () => Promise<unknown> = async () => ({ plan: 'max', windows: [], daily: [] })
      Object.assign(adapter, { listUsage: () => (reads++, answer()) })
      const limited = await rpc('agents.usage', { tool: 'claude' })
      expect(limited).toMatchObject({ supported: true, usage: { plan: 'max' } })
      expect(limited).not.toHaveProperty('notReported')

      // Unless it answers that the plan has none (Cursor's Free plan): said as above, with what the tool says itself
      now += 61_000
      answer = async () => NO_LIMITS
      for (let i = 0; i < 2; i++) {
        expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({
          supported: false,
          reason: 'Claude Code does not report usage limits',
          notReported: true,
          usage: { plan: 'Free', windows: [], totals },
        })
      }
      expect(reads).toBe(2)

      // A read that fails after it is a failure, not "no limits"
      now += 61_000
      answer = async () => Promise.reject(new Error('Cursor did not share its usage'))
      const failed = await rpc('agents.usage', { tool: 'claude' })
      expect(failed).toMatchObject({ supported: false, reason: 'Cursor did not share its usage', usage: { plan: 'Free', windows: [] } })
      expect(failed).not.toHaveProperty('notReported')
    } finally {
      clock.mockRestore()
    }
  })

  it('passes a provisional answer through, and asks the adapter to settle when the screen does (#1623)', async () => {
    const asks: unknown[] = []
    Object.assign(adapter, {
      listUsage: undefined,
      localUsage: async (ask?: { settle?: boolean }) => (asks.push(ask), ask?.settle ? { plan: 'Free' } : { plan: null, provisional: true }),
    })
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ notReported: true, provisional: true, usage: { plan: null } })
    const settled = await rpc('agents.usage', { tool: 'claude', settle: true })
    expect(settled).toMatchObject({ notReported: true, usage: { plan: 'Free' } })
    expect(settled).not.toHaveProperty('provisional')
    expect(asks).toEqual([{ settle: undefined }, { settle: true }])
  })

  it('keeps the totals a read produced, and after a restart answers them at once with the time they were read (#1623)', async () => {
    const read = { scope: 'all time', asOf: 1_700_000_000_000, rows: [{ id: 'sessions', label: 'Sessions', value: 1204, unit: 'count' }] }
    Object.assign(adapter, { listUsage: undefined, localUsage: async () => ({ plan: null, totals: read }) })
    await rpc('agents.usage', { tool: 'claude' })
    // Asked again with the same read (a stale answer returned): nothing is written again
    const saved = vi.spyOn(store.usage, 'saveLocalTotals')
    await rpc('agents.usage', { tool: 'claude' })
    expect(saved).not.toHaveBeenCalled()
    expect(store.usage.localTotals('claude')).toEqual(read)

    // A new process on the same store, whose command is still reading: the reader is offered the kept totals as its seed
    const seeds: unknown[] = []
    const slow = new FakeAdapter()
    Object.assign(slow, {
      listUsage: undefined,
      localUsage: async (ask?: { seed?: { totals?: unknown } }) => (seeds.push(ask?.seed?.totals), ask?.seed ?? { plan: null, provisional: true }),
    })
    const adapters = new Map<ToolName, AgentAdapter>([['claude', slow]])
    const next = new SessionManager(store, adapters, () => {})
    const handler = createRpcHandler(next, adapters)
    const restored = (await handler('agents.usage', { tool: 'claude' })) as { usage: { totals: unknown }; provisional?: boolean }
    expect(restored.usage.totals).toEqual(read)
    expect(restored).not.toHaveProperty('provisional')
    await handler('agents.usage', { tool: 'claude' })
    // Offered once: the reader keeps its own answer after that
    expect(seeds).toEqual([read, undefined])
    await next.tenure.disposeAll()
  })

  it('tells the screen an old answer is being read again, and a settle brings the new totals with their new time, after a restart or not (#1623)', async () => {
    const table = (sessions: number) => ['│Sessions' + String(sessions).padStart(40) + ' │', '│Messages' + '9'.padStart(40) + ' │'].join(String.fromCharCode(10))
    let clock = 1_000_000
    let release: (out: string) => void = () => {}
    const runs: string[] = []
    // The command ends when the test says, as a slow `opencode stats` does
    const run = (): Promise<string> => new Promise((resolve) => ((release = resolve), runs.push('run')))
    const world = (reader: ReturnType<typeof openCodeUsageReader>) => {
      const a = new FakeAdapter()
      Object.assign(a, { listUsage: undefined, localUsage: reader })
      const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
      const m = new SessionManager(store, adapters, () => {})
      return { ask: createRpcHandler(m, adapters), m }
    }
    const sessionsOf = (r: unknown) => (r as { usage: { totals: { asOf: number; rows: { id: string; value: number }[] } } }).usage.totals
    const first = world(openCodeUsageReader(run, () => clock))
    const firstRead = first.ask('agents.usage', { tool: 'claude', settle: true })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    release(table(28))
    expect(sessionsOf(await firstRead)).toMatchObject({ asOf: clock, rows: [{ id: 'sessions', value: 28 }, { id: 'messages' }] })

    // Ten minutes on, with no restart: the old totals come back at once, marked provisional, while the command runs
    clock += 10 * 60_000
    const oldAt = sessionsOf(await first.ask('agents.usage', { tool: 'claude' })).asOf
    const stale = (await first.ask('agents.usage', { tool: 'claude' })) as { provisional?: boolean }
    expect(stale.provisional).toBe(true)
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    // The screen's one more ask, with settle, ends when the command does, and carries the new totals and their time
    const settled = first.ask('agents.usage', { tool: 'claude', settle: true })
    clock += 12_000
    release(table(30))
    const fresh = (await settled) as { provisional?: boolean }
    expect(fresh.provisional).toBeUndefined()
    expect(sessionsOf(fresh)).toMatchObject({ asOf: clock, rows: [{ id: 'sessions', value: 30 }, { id: 'messages' }] })
    expect(sessionsOf(fresh).asOf).toBeGreaterThan(oldAt)
    expect(store.usage.localTotals('claude')?.asOf).toBe(clock)
    await first.m.tenure.disposeAll()

    // A restart a day later: the kept totals come back at once, provisional, and a settle brings the new read
    clock += 86_400_000
    const second = world(openCodeUsageReader(run, () => clock))
    const kept = (await second.ask('agents.usage', { tool: 'claude' })) as { provisional?: boolean }
    expect(kept.provisional).toBe(true)
    expect(sessionsOf(kept)).toMatchObject({ asOf: clock - 86_400_000, rows: [{ id: 'sessions', value: 30 }, { id: 'messages' }] })
    await vi.waitFor(() => expect(runs).toHaveLength(3))
    const settledAgain = second.ask('agents.usage', { tool: 'claude', settle: true })
    release(table(31))
    expect(sessionsOf(await settledAgain)).toMatchObject({ asOf: clock, rows: [{ id: 'sessions', value: 31 }, { id: 'messages' }] })
    await second.m.tenure.disposeAll()
  })

  it('does not keep a provisional answer, nor totals that say nothing of when they were read (#1623)', async () => {
    Object.assign(adapter, {
      listUsage: undefined,
      localUsage: async () => ({ plan: null, provisional: true, totals: { scope: 'all time', asOf: 5, rows: [] } }),
    })
    await rpc('agents.usage', { tool: 'claude' })
    expect(store.usage.localTotals('claude')).toBeNull()
    Object.assign(adapter, { localUsage: async () => ({ plan: null, totals: { scope: 'all time', rows: [] } }) })
    await rpc('agents.usage', { tool: 'claude' })
    expect(store.usage.localTotals('claude')).toBeNull()
  })

  it('answers with the totals even when the store cannot keep them (#1623)', async () => {
    const read = { scope: 'all time', asOf: 9, rows: [] }
    Object.assign(adapter, { listUsage: undefined, localUsage: async () => ({ plan: null, totals: read }) })
    vi.spyOn(store.usage, 'saveLocalTotals').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ notReported: true, usage: { totals: read } })
  })

  it('tells a tool whose command says nobody is logged in as any tool is, not as one with no limits (#1623)', async () => {
    Object.assign(adapter, { listUsage: undefined, localUsage: async () => ({ plan: null, loggedOut: true }) })
    const r = await rpc('agents.usage', { tool: 'claude' })
    expect(r).toMatchObject({ supported: false, reason: 'Claude Code is not logged in on this computer', usage: null })
    expect(r).not.toHaveProperty('notReported')
  })

  it('runs no command for a tool with no limits when only the cache is wanted, and survives one that throws (#1623)', async () => {
    let runs = 0
    Object.assign(adapter, {
      listUsage: undefined,
      localUsage: async () => {
        runs++
        throw new Error('boom')
      },
    })
    expect(await rpc('agents.usage', { tool: 'claude', limits: false })).toMatchObject({ notReported: true, usage: null })
    expect(runs).toBe(0)
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: false, notReported: true, usage: null })
    expect(runs).toBe(1)
  })

  it('counts each model request into the prompt cache figures agents.usage answers with (docs/agent-host/prompt-cache.md)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h = adapter.handleOf(s.id)!
    const emit = (e: NormalizedEvent) => (h as unknown as { emit: (e: NormalizedEvent) => void }).emit(e)
    const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }

    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000 } })
    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 5, cacheReadTokens: 30_000, cacheCreationTokens: 500 } })
    // A running reading without a request is not a request
    emit({ type: 'usage_update', sessionId: s.id, tokens })
    await listed(s.id)

    const r = (await rpc('agents.usage', { tool: 'claude' })) as { cache?: { writes: boolean; windows: { id: string; requests: number; cacheReadTokens: number; cacheCreationTokens: number; rebuilds: number; sessions: { sessionId: string; name: string }[] }[] } }
    expect(r.cache?.writes).toBe(true)
    const five = r.cache!.windows.find((w) => w.id === '5h')!
    expect(five).toMatchObject({ requests: 2, cacheReadTokens: 30_000, cacheCreationTokens: 30_500, rebuilds: 1 })
    expect(five.sessions).toMatchObject([{ sessionId: s.id, name: 'New session' }])
  })

  it('keeps the counted requests per hour and answers usage.history with them; a purge takes that session rows (§6.2)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const emit = (e: NormalizedEvent) => (adapter.handleOf(s.id)! as unknown as { emit: (e: NormalizedEvent) => void }).emit(e)
    const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }
    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000, outputTokens: 70, cacheTtl: '1h' } })
    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 5, cacheReadTokens: 30_000, cacheCreationTokens: 500, outputTokens: 30 } })
    const history = async (by: 'session' | 'project') =>
      (await rpc('usage.history', { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), groupBy: 'day', by })) as UsageHistory

    // Asking flushes what is still in memory, so the answer already has both requests
    const bySession = await history('session')
    expect(bySession.rows).toMatchObject([
      { key: s.id, name: 'New session', requests: 2, inputTokens: 10, cacheReadTokens: 30_000, cacheCreationTokens: 30_500, cacheCreation1hTokens: 30_000, outputTokens: 100, rebuilds: 1, rebuildCauses: { cold_start: 1 } },
    ])
    expect((await history('project')).rows).toMatchObject([{ key: p.id }])

    // A new manager on the same store gets the cache figures back (the restart keeps them)
    const next = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', adapter]]), () => {})
    const restored = (await createRpcHandler(next, new Map<ToolName, AgentAdapter>([['claude', adapter]]))('agents.usage', { tool: 'claude' })) as { cache: { windows: { id: string; requests: number }[] } }
    expect(restored.cache.windows.find((w) => w.id === 'today')!.requests).toBe(2)
    await next.tenure.disposeAll()

    // In the trash the session can come back, and so do its rows; only the purge takes them
    await rpc('agents.deleteSession', { sessionId: s.id })
    expect((await history('session')).rows).toHaveLength(1)
    // Requests counted but not yet written must not bring the rows back after the purge
    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 7, cacheReadTokens: 0 } })
    await rpc('trash.purge', { sessionId: s.id })
    expect((await history('session')).rows).toEqual([])
  })

  it('emptying the trash takes the usage rows too, also what was counted a moment before (§6.2)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }
    ;(adapter.handleOf(s.id)! as unknown as { emit: (e: NormalizedEvent) => void }).emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 7, cacheReadTokens: 0 } })
    await rpc('agents.deleteSession', { sessionId: s.id })
    await rpc('trash.empty', {})
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), groupBy: 'day', by: 'session' }
    expect(((await rpc('usage.history', range)) as UsageHistory).rows).toEqual([])
    expect(store.usage.buckets(0, Date.now() + 3_600_000)).toEqual([])
  })

  it('names why each rebuild happened from what the host saw in that session (docs/agent-host/prompt-cache.md)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const rebuild = async () => {
      const h = adapter.handleOf(s.id)!
      ;(h as unknown as { emit: (e: NormalizedEvent) => void }).emit({
        type: 'usage_update',
        sessionId: s.id,
        tokens,
        request: { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000 },
      })
      await listed(s.id)
    }
    const causes = async () => {
      const r = (await rpc('agents.usage', { tool: 'claude' })) as { cache: { windows: { rebuildCauses?: Record<string, number> }[] } }
      return r.cache.windows[0]!.rebuildCauses
    }

    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1 })

    await rpc('agents.updateSettings', { sessionId: s.id, model: 'some-other-model' })
    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1, model_change: 1 })

    const h = adapter.handleOf(s.id)!
    ;(h as unknown as { emit: (e: NormalizedEvent) => void }).emit({ type: 'compaction', sessionId: s.id, failed: false })
    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1, model_change: 1, compaction: 1 })

    await rpc('agents.restartSession', { sessionId: s.id })
    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1, model_change: 1, compaction: 1, new_process: 1 })

    // A restart that says why (a Codex thread restarted for its apps) is named by that reason, not as a new process
    await mgr.processes.restartSession(s.id, 'thread_restart')
    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1, model_change: 1, compaction: 1, new_process: 1, thread_restart: 1 })
  })
})
