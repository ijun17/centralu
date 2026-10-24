import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { ContextMeter, ESTIMATE_GAP_MS } from './context-meter.js'
import { managerWorld, projectDirs } from './manager.test-helpers.js'

/**
 * The context figure during a turn (#1492): each request of the session's own conversation moves it, as an estimate; the tool's
 * reading at the turn's end is the authority; a reading owed for the turn before cannot put an older size over this turn's.
 */

const WINDOW = 200_000

function world() {
  const m = { id: 's1', tool: 'claude', state: 'waiting_input', context: { used: 20_000, window: WINDOW, exactness: 'exact' } } as SessionInfo
  const clock = { now: 1_000_000 }
  const meter = new ContextMeter(() => clock.now)
  /** An event as the pipeline hands it over: stale readings are asked first, then the state moves, then the meter hears it */
  const feed = (e: NormalizedEvent): NormalizedEvent | null => {
    if (e.type === 'context_update' && meter.stale(e)) return null
    if (e.type === 'state_change') m.state = e.state
    if (e.type === 'context_update') m.context = { used: e.used, window: e.window, exactness: e.exactness }
    const estimate = meter.observe(e, m)
    if (estimate?.type === 'context_update') m.context = { used: estimate.used, window: estimate.window, exactness: estimate.exactness }
    return estimate
  }
  const request = (size: number, agent?: string) =>
    feed({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 1_000, cacheReadTokens: size - 6_000, cacheCreationTokens: 5_000, ...(agent ? { agent } : {}) } })
  const start = () => feed({ type: 'state_change', sessionId: 's1', state: 'working' })
  const end = () => feed({ type: 'state_change', sessionId: 's1', state: 'waiting_input' })
  const read = (used: number) => feed({ type: 'context_update', sessionId: 's1', used, window: WINDOW, exactness: 'exact' })
  return { m, clock, feed, request, start, end, read }
}

describe('ContextMeter', () => {
  it('moves the figure with each request of a turn, as an estimate, at most once in the throttle gap', () => {
    const w = world()
    w.start()
    expect(w.request(60_000)).toMatchObject({ type: 'context_update', used: 60_000, window: WINDOW, exactness: 'estimate' })
    expect(w.m.context).toEqual({ used: 60_000, window: WINDOW, exactness: 'estimate' })
    // A request a moment later is not drawn; the turn's end brings the reading
    w.clock.now += ESTIMATE_GAP_MS - 1
    expect(w.request(70_000)).toBeNull()
    expect(w.m.context?.used).toBe(60_000)
    w.clock.now += 2
    expect(w.request(80_000)).toMatchObject({ used: 80_000 })
    // The same size again is no change
    w.clock.now += ESTIMATE_GAP_MS
    expect(w.request(80_000)).toBeNull()
  })

  it('leaves the figure to the tool’s reading at the turn’s end, whatever the estimates said', () => {
    const w = world()
    w.start()
    w.request(150_000)
    w.end()
    w.read(155_000)
    expect(w.m.context).toEqual({ used: 155_000, window: WINDOW, exactness: 'exact' })
    // And a reading smaller than the last estimate still wins
    const small = world()
    small.start()
    small.request(150_000)
    small.end()
    small.read(120_000)
    expect(small.m.context?.used).toBe(120_000)
  })

  it('does not let the reading owed for the turn before overwrite this turn’s figure when it lands in this turn', () => {
    const w = world()
    w.start()
    w.request(100_000)
    // The turn ended with no reading in it (Claude reads after the turn ends)
    w.end()
    w.clock.now += 60_000
    w.start()
    w.request(130_000)
    expect(w.m.context?.used).toBe(130_000)
    // The turn before's reading lands now: older and smaller, it must not become the figure
    w.read(101_000)
    expect(w.m.context).toEqual({ used: 130_000, window: WINDOW, exactness: 'estimate' })
    // The turn's own reading, after it ends, is the authority
    w.end()
    w.read(133_000)
    expect(w.m.context).toEqual({ used: 133_000, window: WINDOW, exactness: 'exact' })
  })

  it('applies the reading owed for the turn before when the session is at rest, or this turn has asked for nothing yet', () => {
    const rest = world()
    rest.start()
    rest.request(100_000)
    rest.end()
    rest.read(101_000)
    expect(rest.m.context?.used).toBe(101_000)

    const early = world()
    early.start()
    early.request(100_000)
    early.end()
    early.start()
    early.read(101_000)
    expect(early.m.context).toEqual({ used: 101_000, window: WINDOW, exactness: 'exact' })
    // That reading was the turn before's: this turn still moves with its own requests
    early.clock.now += 10_000
    expect(early.request(120_000)).toMatchObject({ used: 120_000 })
  })

  it('stops estimating in a turn where the tool reads the size with every request (Codex)', () => {
    const w = world()
    w.start()
    expect(w.request(60_000)).not.toBeNull()
    w.read(60_500)
    w.clock.now += 10_000
    expect(w.request(90_000)).toBeNull()
    // A reading in the turn is its own: the turn ends owing none, so the next turn's first reading is applied
    w.read(90_400)
    w.end()
    w.start()
    w.read(91_000)
    expect(w.m.context?.used).toBe(91_000)
  })

  it('says nothing for a subagent’s request, with no window known, outside a turn, or for a session that is gone', () => {
    const w = world()
    w.start()
    expect(w.request(150_000, 'toolu_1')).toBeNull()
    w.end()
    expect(w.request(150_000)).toBeNull()

    const none = world()
    none.m.context = null
    none.start()
    expect(none.request(150_000)).toBeNull()

    const gone = world()
    gone.start()
    gone.request(100_000)
    gone.feed({ type: 'session_deleted', sessionId: 's1' })
    gone.clock.now += 10_000
    gone.start()
    expect(gone.request(120_000)).toMatchObject({ used: 120_000 })
  })

  it('never shows more than the window holds', () => {
    const w = world()
    w.start()
    expect(w.request(260_000)).toMatchObject({ used: WINDOW })
  })
})

describe('on the session manager (#1492)', () => {
  const dir = projectDirs()
  let world: ReturnType<typeof managerWorld>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    world = managerWorld()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await world.mgr.disposeAll()
    world.store.close()
  })

  async function session() {
    const { rpc, mgr, adapter } = world
    const p = (await rpc('projects.add', { path: dir('meter-') })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: dir('meter-cwd-'), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    const h = adapter.last!
    await mgr.send(s.id, 'hello')
    // The reading that gives the window; the turn's end of the first turn
    h.emitContext(20_000, 200_000)
    h.finishTurn()
    return { id: s.id, h }
  }
  const context = (id: string) => world.mgr.listSessions().find((s) => s.id === id)?.context
  const request = (h: { emitEvent(e: NormalizedEvent): void }, id: string, size: number) =>
    h.emitEvent({
      type: 'usage_update',
      sessionId: id,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      request: { inputTokens: 1_000, cacheReadTokens: size - 1_000, cacheCreationTokens: 0 },
    })

  it('moves the meter with the assistant messages of a turn before it ends, tells the window, and leaves the end to the tool’s reading', async () => {
    const { id, h } = await session()
    expect(context(id)).toEqual({ used: 20_000, window: 200_000, exactness: 'exact' })
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    world.events.length = 0
    request(h, id, 60_000)
    expect(context(id)).toEqual({ used: 60_000, window: 200_000, exactness: 'estimate' })
    // The window hears it as a reading, marked as an estimate
    expect(world.events).toContainEqual({ type: 'context_update', sessionId: id, used: 60_000, window: 200_000, exactness: 'estimate' })
    vi.setSystemTime(Date.now() + 5_000)
    request(h, id, 95_000)
    expect(context(id)?.used).toBe(95_000)
    // The turn ends: the tool's reading is the figure
    h.finishTurn()
    h.emitContext(97_000, 200_000)
    expect(context(id)).toEqual({ used: 97_000, window: 200_000, exactness: 'exact' })
  })

  it('does not let the turn before’s reading, landing in the next turn, put an older figure over this turn’s', async () => {
    const { id, h } = await session()
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    request(h, id, 90_000)
    // The turn ends and the tool has not read the size yet (Claude reads it after)
    h.finishTurn()
    vi.setSystemTime(Date.now() + 60_000)
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    request(h, id, 120_000)
    world.events.length = 0
    h.emitContext(91_000, 200_000)
    expect(context(id)).toEqual({ used: 120_000, window: 200_000, exactness: 'estimate' })
    // Nothing of it reached a window either
    expect(world.events.filter((e) => e.type === 'context_update')).toEqual([])
    h.finishTurn()
    h.emitContext(122_000, 200_000)
    expect(context(id)).toEqual({ used: 122_000, window: 200_000, exactness: 'exact' })
  })
})
