import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { DEFAULT_AUTO_COMPACT } from '@cc/protocol'
import { inTurn, type SessionIdle } from '../idle.js'
import { managerWorld, projectDirs } from './manager.test-helpers.js'
import { settingThenKeep } from './then-keep.js'
import { COMPACT_FLOOR_TOKENS, IDLE_COMPACT_MINUTES, SelfCompaction, THEN_KEEP_MS, THEN_QUEUE_MAX_MS, THEN_SETTLE_MS, WARN_COMPACT_CYCLES_PER_HOUR, type SelfCompactionHost } from './self-compaction.js'

/**
 * Compacting at a turn's end (#1451): the agent's compact_self, and a session at rest over the lower share. The first
 * part reads the rule on a fake host and clock; the second runs it through a real session manager.
 */

const MIN = 60_000

function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 's1', tool: 'claude', state: 'waiting_input', live: true, context: { used: 150_000, window: 200_000, exactness: 'exact' }, ...over } as SessionInfo
}

/** The setting store as a map, shared by the two hosts of a swap: `updateAppSetting` is one step here, as it is one transaction in the store */
function memorySettings() {
  const m = new Map<string, string>()
  return {
    m,
    appSetting: (k: string) => m.get(k) ?? null,
    setAppSetting: (k: string, v: string) => void m.set(k, v),
    deleteAppSetting: (k: string) => void m.delete(k),
    updateAppSetting: (k: string, next: (c: string | null) => string) => void m.set(k, next(m.get(k) ?? null)),
  }
}

function world(initial: Partial<SessionInfo> = {}, settings = memorySettings()) {
  const sessions = new Map<string, SessionInfo>([['s1', info(initial)]])
  const sent: [string, string][] = []
  const notices: [string, string][] = []
  const thens: [string, string][] = []
  /** The conversation line each of `thens` was given, in order */
  const lines: string[] = []
  const nudges: string[] = []
  const warned: [string, number][] = []
  const state = { now: 1_000_000, idle: { idle: true } as SessionIdle, running: true, ready: true, setting: { ...DEFAULT_AUTO_COMPACT }, failSend: false, queued: false as boolean | null, failThen: false, thenGate: null as Promise<void> | null, nudgeTaken: true as boolean, modelWindow: undefined as number | null | undefined, noCompact: false }
  const host: SelfCompactionHost = {
    sessions: () => [...sessions.values()],
    session: (id) => sessions.get(id),
    idle: () => state.idle,
    running: () => state.running,
    // Between turns, as the manager reads it from the session's state, and the host not leaving
    ready: () => state.ready && !inTurn(sessions.get('s1')?.state ?? 'idle'),
    // undefined: the host has read the session's window in full (the reading's own); null: it knows none of the model
    window: (s) => (state.modelWindow === undefined ? (s.context?.window ?? null) : state.modelWindow),
    setting: () => state.setting,
    command: (_id, tool, focus) => (state.noCompact ? null : tool === 'claude' && focus ? `/compact ${focus}` : '/compact'),
    send: (id, text) => {
      if (state.failSend) throw new Error('no process')
      sent.push([id, text])
    },
    queued: () => state.queued,
    sendThen: async (id, text, line) => {
      if (state.thenGate) await state.thenGate
      if (state.failThen) throw new Error('no process')
      thens.push([id, text])
      lines.push(line)
    },
    keep: settingThenKeep(settings),
    warnCycles: (id, count) => void warned.push([id, count]),
    nudge: (_id, text) => {
      if (state.nudgeTaken) nudges.push(text)
      return state.nudgeTaken
    },
    notice: (id, text) => void notices.push([id, text]),
    now: () => state.now,
  }
  const c = new SelfCompaction(host)
  const m = () => sessions.get('s1')!
  /** An event as the manager's pipeline hands it over, after the session's own state has moved */
  const emit = (e: NormalizedEvent, ended = false) => c.observe(e, ended)
  const startTurn = () => {
    m().state = 'working'
    emit({ type: 'state_change', sessionId: 's1', state: 'working' })
  }
  /** The tool's reading of the context, as the host stores it and the event reaches the pipeline */
  const read = (used: number) => {
    const window = m().context?.window ?? 200_000
    m().context = { used, window, exactness: 'exact' }
    emit({ type: 'context_update', sessionId: 's1', used, window, exactness: 'exact' })
  }
  /** A turn's end; the reading of its context comes `during` it (Codex), `after` it (Claude) or not at all */
  const endTurn = (e: NormalizedEvent = { type: 'turn_complete', sessionId: 's1' }, reading: 'during' | 'after' | 'none' = 'during') => {
    if (reading === 'during' && m().context) read(m().context!.used)
    m().state = 'waiting_input'
    emit(e, true)
    if (reading === 'after' && m().context) read(m().context!.used)
  }
  return { c, state, sent, thens, lines, nudges, notices, warned, m, emit, startTurn, endTurn, read, settings }
}

describe('compact_self (#1451)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is accepted whatever size was last read, and the floor is checked on the size at the turn’s end', () => {
    // A turn that started under the floor and grew past it (the reading known during a turn is the one from the turn before)
    const grew = world({ context: { used: 24_000, window: 200_000, exactness: 'exact' } })
    grew.startTurn()
    expect(grew.c.request('s1').text).toMatch(/if the context is then over 100k tokens/)
    grew.m().state = 'waiting_input'
    grew.emit({ type: 'turn_complete', sessionId: 's1' }, true)
    expect(grew.sent).toEqual([])
    // Claude reads the size after the turn ends: the request is decided on that reading
    grew.read(156_000)
    expect(grew.sent).toEqual([['s1', '/compact']])

    // Under the floor at the turn's end: dropped, nothing compacted for nothing
    const small = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
    small.startTurn()
    small.c.request('s1')
    small.endTurn(undefined, 'after')
    expect(small.sent).toEqual([])
    small.startTurn()
    small.endTurn(undefined, 'after')
    expect(small.sent).toEqual([])
  })

  it('goes by the size of the turn’s last model request when the tool says it, however stale the reading', () => {
    const w = world({ context: { used: 24_000, window: 200_000, exactness: 'exact' } })
    w.startTurn()
    w.c.request('s1')
    // The reading of the turn before is still the stored one; the turn’s own request shows what it grew to
    w.emit({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 6_000, cacheReadTokens: 140_000, cacheCreationTokens: 10_000 } })
    w.endTurn(undefined, 'none')
    expect(w.sent).toEqual([['s1', '/compact']])

    // A reading of the turn before that lands in the next turn is not this turn’s: the request is judged on the turn’s own size
    const late = world({ context: { used: 24_000, window: 200_000, exactness: 'exact' } })
    late.startTurn()
    late.endTurn(undefined, 'none')
    late.startTurn()
    late.c.request('s1')
    late.read(150_000)
    late.emit({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 5_000, cacheReadTokens: 20_000 } })
    late.endTurn(undefined, 'none')
    expect(late.sent).toEqual([])
  })

  it('goes by the reading it has when the tool never reads the size after the turn', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1')
    w.endTurn(undefined, 'none')
    expect(w.sent).toEqual([])
    // Its own timer, not the sweep's minute: judged at 5 seconds
    vi.advanceTimersByTime(4_900)
    expect(w.sent).toEqual([])
    vi.advanceTimersByTime(200)
    expect(w.sent).toEqual([['s1', '/compact']])
  })

  it('stops waiting for a reading when the host stops, and when the session is gone', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1')
    w.endTurn(undefined, 'none')
    w.c.stop()
    vi.advanceTimersByTime(10_000)
    expect(w.sent).toEqual([])
    const g = world()
    g.startTurn()
    g.c.request('s1')
    g.endTurn(undefined, 'none')
    g.emit({ type: 'session_deleted', sessionId: 's1' })
    vi.advanceTimersByTime(10_000)
    expect(g.sent).toEqual([])
  })

  it('leaves a request waiting for the size to the end of a turn the person starts first', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1')
    w.endTurn(undefined, 'none')
    w.startTurn()
    vi.advanceTimersByTime(60_000)
    expect(w.sent).toEqual([])
    w.emit({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 5_000, cacheReadTokens: 145_000 } })
    w.endTurn(undefined, 'none')
    expect(w.sent).toEqual([['s1', '/compact']])
  })

  it('judges a turn on its own: what the turn before read or asked is not carried into it', () => {
    // A request size from the turn before is not this turn's
    const a = world({ context: { used: 24_000, window: 200_000, exactness: 'exact' } })
    a.startTurn()
    a.emit({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 5_000, cacheReadTokens: 145_000 } })
    a.endTurn(undefined, 'none')
    a.startTurn()
    a.c.request('s1')
    a.endTurn(undefined, 'after')
    expect(a.sent).toEqual([])

    // A reading from the turn before is not this turn's either: with none in this one the request waits for it
    const b = world()
    b.startTurn()
    b.endTurn()
    b.startTurn()
    b.c.request('s1')
    b.endTurn(undefined, 'none')
    expect(b.sent).toEqual([])
    vi.advanceTimersByTime(5_100)
    expect(b.sent).toEqual([['s1', '/compact']])
  })

  it('takes the reading that lands in the next turn for the turn before’s, not for the one running', () => {
    const w = world({ context: { used: 24_000, window: 200_000, exactness: 'exact' } })
    w.startTurn()
    // Claude reads the size after the turn ends: it has not come yet
    w.endTurn(undefined, 'none')
    w.startTurn()
    w.c.request('s1')
    // The turn before's reading lands now, mid-turn
    w.read(150_000)
    w.endTurn(undefined, 'none')
    expect(w.sent).toEqual([])
    vi.advanceTimersByTime(5_100)
    expect(w.sent).toEqual([['s1', '/compact']])
  })

  it('waits for the turn to end, then sends the tool’s own /compact with the focus line', () => {
    const w = world()
    w.startTurn()
    const answer = w.c.request('s1', '  keep the\nPR number  ')
    expect(answer.text).toMatch(/when the current turn ends, never in the middle of one/)
    // Mid-turn: nothing goes out, whatever else happens in it
    w.emit({ type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'working' })
    expect(w.sent).toEqual([])
    w.endTurn()
    expect(w.sent).toEqual([['s1', '/compact keep the PR number']])
  })

  it('keeps one request per session: a second one only replaces the focus', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1', 'first')
    expect(w.c.request('s1', 'second').text).toMatch(/^Already asked \(the focus line is replaced\)/)
    w.endTurn()
    expect(w.sent).toEqual([['s1', '/compact second']])
    // And it is spent: the next turn's end sends nothing
    w.startTurn()
    w.endTurn()
    expect(w.sent).toHaveLength(1)
  })

  it('sends Codex the bare command, which its slash handling routes to its compact request', () => {
    const w = world({ tool: 'codex' })
    w.startTurn()
    w.c.request('s1', 'keep the PR number')
    w.endTurn()
    expect(w.sent).toEqual([['s1', '/compact']])
  })

  it('answers that it cannot for a tool with no compact command, and never sends one', () => {
    // An ACP agent that advertises no `compact` (Antigravity: plan, logout, usage): a bare `/compact` would be a prompt to its model
    const w = world({ tool: 'antigravity' })
    w.state.noCompact = true
    w.startTurn()
    expect(w.c.request('s1', 'keep the PR')).toEqual({ text: expect.stringMatching(/no compact command/), isError: true })
    w.endTurn()
    vi.advanceTimersByTime(10_000)
    expect(w.sent).toEqual([])
  })

  it('drops the request when the person interrupts the turn, or it ends in an error', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1')
    w.endTurn({ type: 'state_change', sessionId: 's1', state: 'waiting_input', reason: 'interrupted' })
    expect(w.sent).toEqual([])
    w.startTurn()
    w.c.request('s1')
    w.m().state = 'error'
    w.emit({ type: 'error', sessionId: 's1', error: { code: 'internal', message: 'x', retryable: false } }, true)
    expect(w.sent).toEqual([])
    w.m().state = 'waiting_input'
    w.startTurn()
    w.endTurn()
    expect(w.sent).toEqual([])
  })

  it('holds the request while a card the host raised is open: it goes when the card closes at rest, and is dropped, not carried, into the turn the answer starts', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1')
    w.state.idle = { idle: false, reason: 'question' }
    w.endTurn()
    expect(w.sent).toEqual([])
    // The answer starts a turn: the request is dropped, and that turn's end sends nothing
    w.state.idle = { idle: true }
    w.startTurn()
    w.endTurn()
    expect(w.sent).toEqual([])
    // And it no longer blocks the resting compaction
    w.state.now += 10 * MIN
    expect(w.c.sweep()).toEqual(['s1'])

    // The card closes and the session stays at rest: the request is judged on the size the turn had
    const r = world()
    r.startTurn()
    r.c.request('s1')
    r.state.idle = { idle: false, reason: 'approval' }
    r.endTurn()
    r.state.idle = { idle: true }
    r.emit({ type: 'approval_resolved', sessionId: 's1', requestId: 'r1', decision: 'deny' })
    expect(r.sent).toEqual([['s1', '/compact']])

    const l = world()
    l.startTurn()
    l.c.request('s1')
    l.endTurn({ type: 'limit_reached', sessionId: 's1' })
    l.startTurn()
    l.endTurn()
    expect(l.sent).toEqual([])
  })

  it('judges a held request when its card closes without a resolved event, and drops it when the session has no process (#1500)', () => {
    // A card withdrawn or closed by the session's stop says no `approval_resolved`: any later event, or the sweep, finds it closed
    const a = world()
    a.startTurn()
    a.c.request('s1')
    a.state.idle = { idle: false, reason: 'approval' }
    a.endTurn()
    expect(a.sent).toEqual([])
    // The card is gone while the session runs background work, which is what the request is for: the held path asks only about the card
    a.state.idle = { idle: false, reason: 'background' }
    a.emit({ type: 'notice', sessionId: 's1', level: 'info', from: 'Centralu', label: 'x', text: 'the card is gone' })
    expect(a.sent).toEqual([['s1', '/compact']])

    // The sweep is the backstop when no event comes at all
    const b = world()
    b.startTurn()
    b.c.request('s1')
    b.state.idle = { idle: false, reason: 'question' }
    b.endTurn()
    b.state.idle = { idle: true }
    b.c.sweep()
    expect(b.sent).toEqual([['s1', '/compact']])

    // A stopped session has no process to take it: dropped, not sent into nothing
    const c = world()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    c.startTurn()
    c.c.request('s1')
    c.state.idle = { idle: false, reason: 'approval' }
    c.endTurn()
    c.state.running = false
    c.state.idle = { idle: true }
    c.emit({ type: 'session_live', sessionId: 's1', live: false })
    expect(c.sent).toEqual([])
    expect(err).not.toHaveBeenCalled()
    c.state.running = true
    c.c.sweep()
    c.state.now += 10 * MIN
    // Nothing is pending any more: the request did not wait for the next turn to be spent
    expect(c.c.sweep()).toEqual(['s1'])
    err.mockRestore()
  })

  it('ignores the end of a turn that comes after stop(): no timer, no send (#1500)', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1')
    w.c.stop()
    w.endTurn(undefined, 'none')
    vi.advanceTimersByTime(10_000)
    expect(w.sent).toEqual([])
    // With the size known at the turn's end it would otherwise send at once
    const known = world()
    known.startTurn()
    known.c.request('s1')
    known.c.stop()
    known.endTurn()
    expect(known.sent).toEqual([])
  })

  it('says “Compacted by Centralu” with the reason once the tool reports it, and nothing for a failed compaction', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1')
    w.endTurn()
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false, before: 150_000, after: 9_000 })
    expect(w.notices).toEqual([['s1', 'Compacted by Centralu (the agent asked to after finishing its turn)']])

    const f = world()
    f.startTurn()
    f.c.request('s1')
    f.endTurn()
    f.startTurn()
    f.emit({ type: 'compaction', sessionId: 's1', failed: true, reason: 'Not enough messages to compact.' })
    expect(f.notices).toEqual([])
  })

  it('logs and carries on when the tool takes no compact', () => {
    const w = world()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    w.state.failSend = true
    w.startTurn()
    w.c.request('s1')
    w.endTurn()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('could not send the compaction'))
    err.mockRestore()
    // Not blocked for good: a session at rest is tried again
    w.state.failSend = false
    w.state.now += (IDLE_COMPACT_MINUTES + 1) * MIN
    expect(w.c.sweep()).toEqual(['s1'])
  })
})

describe('compact_self then (#2024)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const compaction = { type: 'compaction', sessionId: 's1', failed: false } as const
  const interrupted = { type: 'state_change', sessionId: 's1', state: 'waiting_input', reason: 'interrupted' } as const
  /** The moment a step waits after the compact turn ended for what was queued behind it to start its turn */
  const settled = () => vi.advanceTimersByTimeAsync(THEN_SETTLE_MS + 1)
  /** The agent asks in a turn that ends over the floor: the compact is sent */
  function asked(w: ReturnType<typeof world>, focus: string | undefined, then: string | undefined) {
    w.startTurn()
    const answer = w.c.request('s1', focus, then)
    w.endTurn()
    return answer
  }
  /** The compact turn: the tool reports the compaction in it and it ends */
  const compactTurn = async (w: ReturnType<typeof world>, ended: NormalizedEvent = { type: 'turn_complete', sessionId: 's1' }) => {
    w.startTurn()
    w.emit(compaction)
    w.endTurn(ended)
    await settled()
  }

  it('sends the next step as a turn of the session’s own only once the compact turn has ended, after the tool reported the compaction', async () => {
    const w = world()
    const answer = asked(w, undefined, 'Continue with step 3 of the plan')
    expect(answer.text).toMatch(/with your `then`/)
    expect(answer.text).toMatch(/End your turn now/)
    expect(w.sent).toEqual([['s1', '/compact']])
    expect(w.thens).toEqual([])
    // The compact turn runs: the compaction is reported, the turn is still going
    w.startTurn()
    expect(w.thens).toEqual([])
    w.emit(compaction)
    await settled()
    expect(w.thens).toEqual([])
    w.endTurn()
    // Nothing waits behind it: the step goes at once, not after a guess
    expect(w.thens).toHaveLength(1)
    expect(w.thens[0]![1]).toContain('Continue with step 3 of the plan')
    expect(w.thens[0]![1]).not.toMatch(/came first/)
    // The turn it starts is the session’s own, not the compact’s, and sends nothing again
    w.startTurn()
    expect(w.c.compactTurn('s1')).toBe(false)
    w.endTurn()
    await settled()
    expect(w.thens).toHaveLength(1)
    expect(w.nudges).toEqual([])
  })

  it('sends the step after a compaction the tool reported as failed, as a turn that says nothing was compacted and why: the context is as it was', async () => {
    const w = world()
    asked(w, undefined, 'next')
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: true, reason: 'Not enough messages to compact.' })
    w.endTurn()
    await settled()
    expect(w.thens).toHaveLength(1)
    expect(w.thens[0]![1]).toMatch(/did not compact the conversation \(the tool reported the compaction failed: Not enough messages to compact\.\), so it is as it was/)
    expect(w.thens[0]![1]).not.toMatch(/The compaction you asked for with compact_self is done/)
    expect(w.lines).toEqual(['Centralu sent the agent its next step: nothing was compacted'])
    expect(w.notices.map((n) => n[1])).toContainEqual(expect.stringMatching(/The compaction did not happen \(the tool reported the compaction failed/))
    expect(w.notices.map((n) => n[1])).not.toContainEqual(expect.stringMatching(/^Compacted by Centralu/))
    // And it is kept as a refusal for a host that finds it
    const kept = world()
    asked(kept, undefined, 'next')
    kept.startTurn()
    kept.emit({ type: 'compaction', sessionId: 's1', failed: true })
    expect(JSON.parse(kept.settings.m.get('compact_then:s1')!)).toMatchObject({ stage: 'refused', why: 'the tool reported the compaction failed' })
  })

  it('sends it all the same when the request was refused, as a turn that says it did not compact and why (under the floor, no size read)', async () => {
    const w = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
    w.startTurn()
    w.c.request('s1', undefined, 'Continue with step 3')
    w.endTurn(undefined, 'after')
    expect(w.sent).toEqual([])
    await settled()
    expect(w.thens).toHaveLength(1)
    expect(w.thens[0]![1]).toMatch(/did not compact the conversation \(the context was 60k tokens, under the 100k floor\), so it is as it was/)
    expect(w.thens[0]![1]).toContain('Continue with step 3')
    expect(w.nudges).toEqual([])
    expect(w.notices.map((n) => n[1])).toEqual([expect.stringMatching(/The compaction did not happen \(the context was 60k/)])
    expect(w.settings.m.has('compact_then:s1')).toBe(false)
    // A request with no `then` says nothing
    const plain = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
    plain.startTurn()
    plain.c.request('s1')
    plain.endTurn(undefined, 'after')
    await settled()
    expect(plain.thens).toEqual([])
    expect(plain.nudges).toEqual([])
    expect(plain.notices).toEqual([])

    // No size read since a compaction is a refusal too
    const unread = world({ tool: 'codex' })
    unread.startTurn()
    unread.emit({ ...compaction, trigger: 'auto' })
    unread.endTurn(undefined, 'none')
    unread.startTurn()
    unread.c.request('s1', undefined, 'next')
    unread.endTurn(undefined, 'none')
    await vi.advanceTimersByTimeAsync(5_100 + THEN_SETTLE_MS)
    expect(unread.thens).toEqual([expect.arrayContaining([expect.stringMatching(/no size of the context was read since the last compaction/)])])
  })

  it('goes after the turn the person’s answer or message started when the refusal came first, and says that message came first', async () => {
    const w = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
    w.startTurn()
    w.c.request('s1', undefined, 'next')
    // A message of the person's waits in the tool's queue: its turn goes first, and the refusal turn follows its end
    w.state.queued = true
    w.endTurn(undefined, 'after')
    expect(w.thens).toEqual([])
    w.startTurn()
    await settled()
    expect(w.thens).toEqual([])
    w.state.queued = false
    w.endTurn()
    expect(w.thens).toHaveLength(1)
    expect(w.thens[0]![1]).toMatch(/message from the person ran before the compaction and came first/)
  })

  it('sends it as a turn that says why when the tool refused the compact or never reported the compaction', async () => {
    const refused = world()
    asked(refused, undefined, 'next')
    refused.emit({ type: 'error', sessionId: 's1', error: { code: 'refused', message: 'not allowed', retryable: false } })
    await settled()
    expect(refused.thens).toEqual([[ 's1', expect.stringMatching(/did not compact the conversation \(the tool refused the compact\)/) ]])
    expect(refused.nudges).toEqual([])

    const w = world()
    asked(w, undefined, 'next')
    w.state.now += 29 * MIN
    w.c.sweep()
    await settled()
    expect(w.thens).toEqual([])
    w.state.now += 2 * MIN
    w.c.sweep()
    await settled()
    expect(w.thens).toEqual([[ 's1', expect.stringMatching(/did not compact the conversation \(the tool never reported the compaction\)/) ]])
    // A compaction reported late does not bring a second one
    await compactTurn(w)
    expect(w.thens).toHaveLength(1)
  })

  it('sends nothing when the person interrupts the turn that asked, or the compact turn before or after the compaction was reported, and tells the session quietly', async () => {
    const before = world()
    before.startTurn()
    before.c.request('s1', undefined, 'next')
    before.endTurn(interrupted)
    await settled()
    expect(before.sent).toEqual([])
    expect(before.thens).toEqual([])
    expect(before.nudges).toEqual([expect.stringMatching(/the person interrupted the turn/)])

    const during = world()
    asked(during, undefined, 'next')
    during.startTurn()
    during.endTurn(interrupted)
    during.startTurn()
    during.emit(compaction)
    during.endTurn()
    await settled()
    expect(during.thens).toEqual([])
    expect(during.nudges).toEqual([expect.stringMatching(/interrupted before the compaction/)])

    // The compaction was reported and the person interrupted that same turn: they took control (#2024 review)
    const after = world()
    asked(after, undefined, 'next')
    await compactTurn(after, interrupted)
    expect(after.thens).toEqual([])
    expect(after.nudges).toEqual([expect.stringMatching(/the compact turn was interrupted/)])
    expect(after.settings.m.has('compact_then:s1')).toBe(false)
  })

  it('sends nothing when the person interrupts the turn that went first, ahead of the held step', async () => {
    const held = world()
    asked(held, undefined, 'next')
    held.startTurn()
    held.emit(compaction)
    held.state.queued = true
    held.endTurn()
    held.startTurn()
    held.endTurn(interrupted)
    await settled()
    expect(held.thens).toEqual([])
    expect(held.nudges).toEqual([expect.stringMatching(/the turn that ran first was interrupted/)])
  })

  it('keeps it when the person’s message ran before the compact, and says that message came first', async () => {
    const w = world()
    asked(w, undefined, 'next')
    // The message was already in the tool’s queue: its turn runs first
    w.startTurn()
    w.endTurn()
    await settled()
    expect(w.thens).toEqual([])
    await compactTurn(w)
    expect(w.thens).toHaveLength(1)
    expect(w.thens[0]![1]).toMatch(/message from the person ran before the compaction and came first/)
  })

  it('lets what was queued behind the compact turn go first, then sends the step with the line that it came first (a person’s message typed during the compact turn)', async () => {
    const w = world()
    asked(w, undefined, 'next')
    w.startTurn()
    w.emit(compaction)
    // The person’s message waits in the tool’s queue as the compact turn ends: nothing is sent beside it
    w.state.queued = true
    w.endTurn()
    expect(w.thens).toEqual([])
    // The tool starts its turn late, past any guess of seconds: nothing is sent into it, and no turn has two inputs
    await vi.advanceTimersByTimeAsync(THEN_SETTLE_MS + 500)
    expect(w.thens).toEqual([])
    w.startTurn()
    await settled()
    expect(w.thens).toEqual([])
    expect(JSON.parse(w.settings.m.get('compact_then:s1')!)).toMatchObject({ stage: 'compacted', ahead: true })
    w.state.queued = false
    w.endTurn()
    expect(w.thens).toHaveLength(1)
    expect(w.thens[0]![1]).toMatch(/message from the person ran before the compaction and came first/)
  })

  it('looks at the queue again when the session’s state has not caught up with the turn’s end, so a message typed in that moment still goes first (real run)', async () => {
    const w = world()
    asked(w, undefined, 'next')
    w.startTurn()
    w.emit(compaction)
    // The end is heard before the state says the session is at rest, and nothing waits yet
    w.state.ready = false
    w.endTurn()
    expect(w.thens).toEqual([])
    // The person types in that moment; the session is at rest a moment later
    await vi.advanceTimersByTimeAsync(100)
    w.state.queued = true
    w.state.ready = true
    await vi.advanceTimersByTimeAsync(2_000)
    expect(w.thens).toEqual([])
    w.startTurn()
    w.state.queued = false
    w.endTurn()
    expect(w.thens).toHaveLength(1)
    expect(w.thens[0]![1]).toMatch(/came first/)
    // Nothing typed: it goes as soon as the state has caught up, not after a second
    const plain = world()
    asked(plain, undefined, 'next')
    plain.startTurn()
    plain.emit(compaction)
    plain.state.ready = false
    plain.endTurn()
    await vi.advanceTimersByTimeAsync(100)
    plain.state.ready = true
    await vi.advanceTimersByTimeAsync(300)
    expect(plain.thens).toHaveLength(1)
  })

  it('keeps looking while the state catches up, as long as it takes up to a few seconds, and reads the queue on each look', async () => {
    const w = world()
    asked(w, undefined, 'next')
    w.startTurn()
    w.emit(compaction)
    w.state.ready = false
    w.endTurn()
    // Several looks later the session is at rest, and nothing is queued: it goes
    await vi.advanceTimersByTimeAsync(700)
    expect(w.thens).toEqual([])
    w.state.ready = true
    await vi.advanceTimersByTimeAsync(300)
    expect(w.thens).toHaveLength(1)
    // And one who was typed to on a later look is waited for, not sent beside
    const late = world()
    asked(late, undefined, 'next')
    late.startTurn()
    late.emit(compaction)
    late.state.ready = false
    late.endTurn()
    await vi.advanceTimersByTimeAsync(600)
    late.state.queued = true
    late.state.ready = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(late.thens).toEqual([])
  })

  it('guesses only for a tool that cannot say what it holds: it waits a moment, and goes if no queued turn started', async () => {
    const w = world()
    asked(w, undefined, 'next')
    w.startTurn()
    w.emit(compaction)
    w.state.queued = null
    w.endTurn()
    await vi.advanceTimersByTimeAsync(THEN_SETTLE_MS - 100)
    expect(w.thens).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(w.thens).toHaveLength(1)
  })

  it('does not hold the step for ever for a queue that never starts a turn: it goes after THEN_QUEUE_MAX_MS', async () => {
    const w = world()
    asked(w, undefined, 'next')
    w.startTurn()
    w.emit(compaction)
    w.state.queued = true
    w.endTurn()
    await vi.advanceTimersByTimeAsync(THEN_QUEUE_MAX_MS - 1_000)
    expect(w.thens).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(w.thens).toHaveLength(1)
  })

  it('gives each step the conversation line that is true of it: after the compaction, after a refusal, after a host change', async () => {
    const done = world()
    asked(done, undefined, 'next')
    await compactTurn(done)
    expect(done.lines).toEqual(['Centralu sent the agent its next step after the compaction'])

    const refused = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
    refused.startTurn()
    refused.c.request('s1', undefined, 'next')
    refused.endTurn(undefined, 'after')
    await settled()
    expect(refused.lines).toEqual(['Centralu sent the agent its next step: nothing was compacted'])

    const old = world()
    old.settings.m.set('compact_then:s1', JSON.stringify({ stage: 'sent', then: 'next', focusAside: null, ahead: false, why: null, at: 1_000_000 }))
    const next = world({}, old.settings)
    next.c.recover()
    await vi.advanceTimersByTimeAsync(0)
    expect(next.lines).toEqual(['Centralu told the agent to go on: it changed hosts while a compaction was asked for'])
  })

  describe('a request refused again at the same size (#2036 review)', () => {
    const asks = (w: ReturnType<typeof world>) => {
      w.startTurn()
      return w.c.request('s1', undefined, 'next')
    }

    it('answers it in the tool result with no new turn, so an agent that asks again at once costs a tool call', async () => {
      const w = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
      asks(w)
      w.endTurn(undefined, 'after')
      expect(w.thens).toHaveLength(1)
      // The step’s turn asks again with the context where it was
      const again = asks(w)
      expect(again.text).toMatch(/^Not compacted \(the context was 60k tokens, under the 100k floor\)/)
      expect(again.text).toMatch(/Continue in this turn/)
      expect(again.isError).toBeUndefined()
      w.endTurn(undefined, 'after')
      await settled()
      expect(w.thens).toHaveLength(1)
      expect(w.sent).toEqual([])
      expect(w.settings.m.has('compact_then:s1')).toBe(false)
      // And again: still nothing
      asks(w)
      w.endTurn(undefined, 'after')
      await settled()
      expect(w.thens).toHaveLength(1)
    })

    it('goes the normal way once the context has changed: grown, or over the floor', async () => {
      const w = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
      asks(w)
      w.endTurn(undefined, 'after')
      expect(w.thens).toHaveLength(1)
      // The step did real work: the turn’s last request is 9k larger
      w.startTurn()
      w.emit({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 69_000, cacheReadTokens: 0 } })
      const grown = w.c.request('s1', undefined, 'next')
      expect(grown.text).toMatch(/^Centralu compacts this conversation when the current turn ends/)
      w.endTurn(undefined, 'after')
      await settled()
      expect(w.thens).toHaveLength(2)
      // Over the floor it compacts
      w.startTurn()
      w.emit({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 140_000, cacheReadTokens: 0 } })
      expect(w.c.request('s1', undefined, 'next').text).toMatch(/^Centralu compacts/)
      w.endTurn(undefined, 'none')
      expect(w.sent).toEqual([['s1', '/compact']])
    })

    it('is not the answer once the context is over the floor, though it is within a few tokens of a refusal under it', async () => {
      const w = world({ context: { used: 99_000, window: 200_000, exactness: 'exact' } })
      asks(w)
      w.endTurn(undefined, 'after')
      expect(w.thens).toHaveLength(1)
      // 100.5k: not the same request. It is asked the usual way, and at the turn's end it compacts
      w.startTurn()
      w.emit({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 100_500, cacheReadTokens: 0 } })
      expect(w.c.request('s1', undefined, 'next').text).toMatch(/^Centralu compacts/)
      w.endTurn(undefined, 'none')
      expect(w.sent).toEqual([['s1', '/compact']])
    })

    it('is never the answer to a request with no step, and is forgotten once a compaction went', async () => {
      const w = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
      asks(w)
      w.endTurn(undefined, 'after')
      w.startTurn()
      expect(w.c.request('s1').text).toMatch(/^Centralu compacts/)
      w.endTurn(undefined, 'after')
      // A request over the floor fires; the refusal is forgotten
      w.m().context = { used: 150_000, window: 200_000, exactness: 'exact' }
      asks(w)
      w.endTurn(undefined, 'after')
      expect(w.sent).toEqual([['s1', '/compact']])
      await compactTurn(w)
      w.m().context = { used: 60_000, window: 200_000, exactness: 'exact' }
      expect(asks(w).text).toMatch(/^Centralu compacts/)
    })

    it('treats two requests with no size read since a compaction as the same', async () => {
      const w = world({ tool: 'codex' })
      w.startTurn()
      w.emit({ ...compaction, trigger: 'auto' })
      w.endTurn(undefined, 'none')
      asks(w)
      w.endTurn(undefined, 'none')
      await vi.advanceTimersByTimeAsync(5_100 + THEN_SETTLE_MS)
      expect(w.thens).toHaveLength(1)
      expect(asks(w).text).toMatch(/^Not compacted \(no size of the context was read/)
    })
  })

  it('sends it only to a session that can take a turn, whatever the moment: one in a turn, behind a card or at its limit waits, and the sweep sends it once it can', async () => {
    const w = world()
    asked(w, undefined, 'next')
    w.state.ready = false
    await compactTurn(w)
    expect(w.thens).toEqual([])
    expect(JSON.parse(w.settings.m.get('compact_then:s1')!)).toMatchObject({ stage: 'compacted' })
    w.c.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.thens).toEqual([])
    w.state.ready = true
    w.c.sweep()
    await vi.advanceTimersByTimeAsync(300)
    expect(w.thens).toHaveLength(1)
    w.c.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.thens).toHaveLength(1)
  })

  it('gives a tool whose compact takes no focus (Codex) the focus line at the head of the next step', async () => {
    const w = world({ tool: 'codex' })
    const answer = asked(w, 'keep the PR number', 'next')
    expect(answer.text).toMatch(/the focus line at its head/)
    expect(w.sent).toEqual([['s1', '/compact']])
    await compactTurn(w)
    expect(w.thens[0]![1]).toMatch(/takes no focus\. What you asked the summary to keep: keep the PR number\n\nnext$/)

    // Claude took the focus in its command: not repeated
    const claude = world()
    expect(asked(claude, 'keep the PR number', 'next').text).not.toMatch(/focus line at its head/)
    await compactTurn(claude)
    expect(claude.thens[0]![1]).not.toContain('keep the PR number')
  })

  it('says in the answer that a focus the tool cannot take is not applied, when there is no next step to put it in', () => {
    expect(world({ tool: 'codex' }).c.request('s1', 'keep the PR number').text).toMatch(/takes no focus, so the focus line is not applied/)
    expect(world().c.request('s1', 'keep the PR number').text).not.toMatch(/not applied/)
    expect(world({ tool: 'codex' }).c.request('s1').text).not.toMatch(/not applied/)
  })

  it('refuses a next step too long to be a prompt and asks nothing', () => {
    const w = world()
    w.startTurn()
    expect(w.c.request('s1', undefined, 'x'.repeat(4_001))).toEqual({ text: expect.stringMatching(/Nothing was asked/), isError: true })
    w.endTurn()
    expect(w.sent).toEqual([])
  })

  it('replaces the next step with a second request, and says so', async () => {
    const w = world()
    w.startTurn()
    w.c.request('s1', undefined, 'first')
    expect(w.c.request('s1', undefined, 'second').text).toMatch(/^Already asked \(`then` is replaced\)/)
    w.endTurn()
    await compactTurn(w)
    expect(w.thens).toHaveLength(1)
    expect(w.thens[0]![1]).toContain('second')
  })

  describe('one compaction in flight per session (#2024 review)', () => {
    it('does not ask for a second compaction while one is on its way: the request joins it, and its `then` replaces the earlier one', async () => {
      const w = world()
      asked(w, undefined, 'step one')
      expect(w.sent).toEqual([['s1', '/compact']])
      // The person’s turn that ran before the queued compact: the agent in it asks again
      w.startTurn()
      const again = w.c.request('s1', 'a new focus', 'step two')
      expect(again.text).toMatch(/already on its way/)
      expect(again.text).toMatch(/replaces the earlier one/)
      expect(again.text).toMatch(/focus line comes too late/)
      w.endTurn()
      expect(w.sent).toEqual([['s1', '/compact']])
      await compactTurn(w)
      expect(w.sent).toHaveLength(1)
      expect(w.thens).toHaveLength(1)
      expect(w.thens[0]![1]).toContain('step two')
      expect(w.thens[0]![1]).not.toContain('step one')
      expect(w.thens[0]![1]).toMatch(/came first/)
    })

    it('drops the earlier step when the second request has none, and says so', async () => {
      const w = world()
      asked(w, undefined, 'first')
      w.startTurn()
      expect(w.c.request('s1').text).toMatch(/earlier `then` is dropped/)
      w.endTurn()
      expect(JSON.parse(w.settings.m.get('compact_then:s1') ?? 'null')).toBeNull()
      await compactTurn(w)
      expect(w.thens).toEqual([])
      expect(w.sent).toHaveLength(1)
    })

    it('replaces a step held for the turn that goes first, and sends that one after it', async () => {
      const w = world()
      asked(w, undefined, 'first')
      w.startTurn()
      w.emit(compaction)
      w.state.queued = true
      w.endTurn()
      // The queued message’s turn begins, and the agent in it asks to compact again with its own step
      w.startTurn()
      expect(w.c.request('s1', undefined, 'second').text).toMatch(/^Already asked \(`then` is replaced\)/)
      w.endTurn()
      await settled()
      expect(w.thens).toEqual([])
      expect(w.sent).toHaveLength(2)
    })
  })

  it('tells the session, as it was, when the step could not be sent after a compaction that happened', async () => {
    const w = world()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    w.state.failThen = true
    asked(w, undefined, 'next')
    await compactTurn(w)
    expect(w.thens).toEqual([])
    expect(w.nudges).toHaveLength(1)
    expect(w.nudges[0]).toMatch(/The compaction you asked for is done, but the session could not take your `then`/)
    expect(w.nudges[0]).not.toMatch(/did not compact/)
    expect(w.notices.map((n) => n[1])).toContainEqual('The compaction is done, but the next step the agent set could not be sent')
    expect(err).toHaveBeenCalledWith(expect.stringContaining('could not send the next step'))
    err.mockRestore()
  })

  it('keeps the note for a tool that cannot take it now, and gives it with a request of a running turn', () => {
    const w = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
    w.state.nudgeTaken = false
    // The person interrupted: a quiet note, and the tool cannot take one now
    w.startTurn()
    w.c.request('s1', undefined, 'Continue with step 3')
    w.endTurn(interrupted, 'after')
    expect(w.nudges).toEqual([])
    // A turn begins: the tool still cannot steer it yet
    w.startTurn()
    expect(w.nudges).toEqual([])
    w.state.nudgeTaken = true
    const request = { type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 5_000, cacheReadTokens: 20_000 } } as const
    w.emit(request)
    expect(w.nudges).toHaveLength(1)
    expect(w.nudges[0]).toContain('Continue with step 3')
    // Given once
    w.emit(request)
    expect(w.nudges).toHaveLength(1)
  })

  describe('across a host swap or restart (#2024)', () => {
    const key = 'compact_then:s1'
    const stored = (w: ReturnType<typeof world>) => (w.settings.m.get(key) ? JSON.parse(w.settings.m.get(key)!) : null)
    /** The host after the swap: the same store, a session that is there, nothing in memory */
    const nextHost = (old: ReturnType<typeof world>) => world({}, old.settings)
    const record = (over: Record<string, unknown>) => JSON.stringify({ stage: 'compacted', then: 'Continue with step 3', focusAside: null, ahead: false, why: null, at: 1_000_000, ...over })

    it('keeps the step in the store from the request on, stage by stage, and clears it once it went', async () => {
      const w = world()
      w.startTurn()
      w.c.request('s1', undefined, 'Continue with step 3')
      expect(stored(w)).toMatchObject({ stage: 'asked', then: 'Continue with step 3', at: 1_000_000 })
      w.endTurn()
      expect(stored(w)).toMatchObject({ stage: 'sent' })
      w.startTurn()
      w.emit(compaction)
      expect(stored(w)).toMatchObject({ stage: 'compacted' })
      w.endTurn()
      await settled()
      expect(w.thens).toHaveLength(1)
      expect(stored(w)).toBeNull()
      // A request with no step keeps nothing, and a replacement without one clears it
      const plain = world()
      plain.startTurn()
      plain.c.request('s1')
      expect(plain.settings.m.size).toBe(0)
      plain.c.request('s1', undefined, 'next')
      expect(stored(plain)).not.toBeNull()
      plain.c.request('s1')
      expect(stored(plain)).toBeNull()
    })

    it('sends the step once from the new host when the compaction was reported done, and the old host finds it taken', async () => {
      const old = world()
      asked(old, undefined, 'Continue with step 3')
      old.startTurn()
      old.emit(compaction)
      // The host swaps before the compact turn ends: the new host starts
      const next = nextHost(old)
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toHaveLength(1)
      expect(next.thens[0]![1]).toContain('Continue with step 3')
      expect(next.nudges).toEqual([])
      // The old host, not yet gone, sees the compact turn end: the claim is gone, nothing is sent twice
      old.endTurn()
      await settled()
      expect(old.thens).toEqual([])
      expect(stored(old)).toBeNull()
    })

    it('keeps the step for the new host to send when the old one left before it could', async () => {
      const old = world()
      asked(old, undefined, 'next')
      old.startTurn()
      old.emit(compaction)
      // The shutdown plan stops the compactor before the sessions are let go of: a late event of the leaving host sends nothing
      old.c.stop()
      old.endTurn()
      await settled()
      expect(old.thens).toEqual([])
      expect(stored(old)).toMatchObject({ stage: 'compacted' })
      const next = nextHost(old)
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toHaveLength(1)
      // And a second recovery (another adoption, a restart again) finds nothing to send
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toHaveLength(1)
    })

    it('does not put the step back when this host leaves as it is being sent: the next host tells the session it may or may not have gone, and sends nothing again (real run D3)', async () => {
      const old = world()
      asked(old, undefined, 'Continue with step 3')
      old.startTurn()
      old.emit(compaction)
      let leave!: () => void
      old.state.thenGate = new Promise<void>((r) => (leave = r))
      old.state.failThen = true
      // The compact turn ends: the step is claimed and on its way; the host is let go of, and the delivery is refused as the leaving host refuses it
      old.endTurn()
      await settled()
      expect(stored(old)).toMatchObject({ stage: 'sending' })
      old.c.stop()
      leave()
      await vi.advanceTimersByTimeAsync(0)
      expect(stored(old)).toMatchObject({ stage: 'sending' })
      expect(old.nudges).toEqual([])
      expect(old.notices.map((n) => n[1])).not.toContainEqual(expect.stringMatching(/did not happen/))
      const next = nextHost(old)
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      // Not the step again as a step: a turn that says it was being sent, with the text to go on from
      expect(next.thens).toHaveLength(1)
      expect(next.thens[0]![1]).toMatch(/it was being sent/)
      expect(next.thens[0]![1]).not.toMatch(/This is the step you set with/)
      expect(stored(next)).toBeNull()
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toHaveLength(1)
    })

    it('carries the person-came-first line and the Codex focus line across the swap', async () => {
      const old = world({ tool: 'codex' })
      asked(old, 'keep the PR number', 'next')
      old.startTurn()
      old.endTurn()
      old.startTurn()
      old.emit(compaction)
      const next = nextHost(old)
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens[0]![1]).toMatch(/came first/)
      expect(next.thens[0]![1]).toMatch(/What you asked the summary to keep: keep the PR number/)
    })

    it('sends a refused request’s step from the new host too, as the turn that says it did not compact', async () => {
      const old = world()
      old.settings.m.set(key, record({ stage: 'refused', why: 'the context was 60k tokens, under the 100k floor' }))
      const next = nextHost(old)
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toEqual([[ 's1', expect.stringMatching(/did not compact the conversation \(the context was 60k tokens, under the 100k floor\)/) ]])
    })

    it('wakes the session with a turn, with the text of its step, when the new host cannot tell how far the request came, and says what it did', async () => {
      for (const [stage, how] of [
        ['asked', /the turn had not ended/],
        ['sent', /not yet reported done/],
        ['sending', /it was being sent/],
      ] as const) {
        const old = world()
        old.settings.m.set(key, record({ stage }))
        const next = nextHost(old)
        next.c.recover()
        await vi.advanceTimersByTimeAsync(0)
        expect(next.thens, stage).toEqual([[ 's1', expect.stringContaining('Continue with step 3') ]])
        expect(next.thens[0]![1], stage).toMatch(/changed hosts/)
        expect(next.thens[0]![1], stage).toMatch(how)
        expect(next.nudges, stage).toEqual([])
        expect(next.notices.map((n) => n[1]), stage).toEqual([expect.stringMatching(/changed hosts.*the agent was woken with its next step/)])
        expect(stored(next), stage).toBeNull()
        expect(next.settings.m.has('compact_notes:s1'), stage).toBe(false)
        // Told once
        next.c.recover()
        await vi.advanceTimersByTimeAsync(0)
        expect(next.thens, stage).toHaveLength(1)
      }
    })

    it('tells it quietly when it is in a turn, and holds the note for its next input when the tool takes none; the line says which', async () => {
      const inTurn = world()
      inTurn.settings.m.set(key, record({ stage: 'sent' }))
      const quiet = nextHost(inTurn)
      quiet.state.ready = false
      quiet.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(quiet.thens).toEqual([])
      expect(quiet.nudges).toEqual([expect.stringContaining('Continue with step 3')])
      expect(quiet.notices.map((n) => n[1])).toEqual([expect.stringMatching(/the agent was told its next step/)])

      const held = nextHost(inTurn)
      held.settings.m.set(key, record({ stage: 'sent' }))
      held.state.ready = false
      held.state.nudgeTaken = false
      held.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(held.nudges).toEqual([])
      expect(held.notices.map((n) => n[1])).toEqual([expect.stringMatching(/the agent is told its next step at its next input/)])
      expect(JSON.parse(held.settings.m.get('compact_notes:s1')!)).toEqual([expect.stringContaining('Continue with step 3')])
    })

    it('keeps a note the tool could not take in the store, and gives it once the new host’s tool can', () => {
      const old = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
      old.state.nudgeTaken = false
      old.startTurn()
      old.c.request('s1', undefined, 'Continue with step 3')
      old.endTurn(interrupted, 'after')
      expect(JSON.parse(old.settings.m.get('compact_notes:s1')!)).toEqual([expect.stringContaining('Continue with step 3')])
      const next = nextHost(old)
      next.c.recover()
      expect(next.nudges).toEqual([expect.stringContaining('Continue with step 3')])
      expect(next.settings.m.has('compact_notes:s1')).toBe(false)
    })

    it('does not send a step an older build left long ago, and tells the session', async () => {
      const old = world()
      old.settings.m.set(key, record({ at: old.state.now - THEN_KEEP_MS - 1 }))
      const next = nextHost(old)
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toEqual([])
      expect(next.nudges).toEqual([expect.stringMatching(/kept for more than 60 minutes/)])
      expect(stored(next)).toBeNull()
      // Within the bound it goes
      const fresh = world()
      fresh.settings.m.set(key, record({ at: fresh.state.now - THEN_KEEP_MS + 1_000 }))
      nextHost(fresh).c.recover()
      const again = nextHost(fresh)
      again.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(again.thens).toHaveLength(1)
    })

    it('keeps the time of the last move in the record, so a step is as old as its last stage', async () => {
      const w = world()
      w.startTurn()
      w.c.request('s1', undefined, 'next')
      w.state.now += 20 * MIN
      w.endTurn()
      expect(stored(w)).toMatchObject({ stage: 'sent', at: 1_000_000 + 20 * MIN })
    })

    it('clears what a swap would find of a session when it is deleted, so one restored from the trash is sent no old step', () => {
      const w = world()
      w.startTurn()
      w.c.request('s1', undefined, 'next')
      w.settings.m.set('compact_notes:s1', JSON.stringify(['an old note']))
      w.emit({ type: 'session_deleted', sessionId: 's1' })
      expect(w.settings.m.has(key)).toBe(false)
      expect(w.settings.m.has('compact_notes:s1')).toBe(false)
      // The host that comes up with the session restored finds nothing
      const next = nextHost(w)
      next.c.recover()
      expect(next.nudges).toEqual([])
      expect(next.thens).toEqual([])
    })

    it('holds a known-done step for a session that cannot take a turn yet, and a leftover of this host’s own request is not the last host’s', async () => {
      const old = world()
      old.settings.m.set(key, record({}))
      const next = nextHost(old)
      next.state.ready = false
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toEqual([])
      expect(stored(old)).toMatchObject({ stage: 'compacted' })
      next.state.ready = true
      next.c.sweep()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toHaveLength(1)
      // This host’s own request is not the last host’s leftover
      const mine = nextHost(old)
      mine.startTurn()
      mine.c.request('s1', undefined, 'mine')
      mine.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      expect(mine.nudges).toEqual([])
      expect(mine.thens).toEqual([])
    })

    it('looks at what waits for the session before it sends a kept step, as a turn’s end does: from a host that starts, and from the sweep', async () => {
      const old = world()
      old.settings.m.set(key, record({}))
      const next = nextHost(old)
      next.state.queued = true
      next.c.recover()
      await vi.advanceTimersByTimeAsync(0)
      // Mail waits for the session: its turn goes first
      expect(next.thens).toEqual([])
      expect(stored(old)).toMatchObject({ stage: 'compacted' })
      next.c.sweep()
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toEqual([])
      // The turn that mail started begins and ends (nothing waits now): the step follows it
      next.state.queued = false
      next.startTurn()
      next.endTurn()
      expect(next.thens).toHaveLength(1)
      expect(next.thens[0]![1]).toMatch(/came first/)
    })

    it('leaves a session whose process the keeper still holds to its adoption', async () => {
      const old = world()
      asked(old, undefined, 'next')
      old.startTurn()
      old.emit(compaction)
      const next = nextHost(old)
      next.c.recover(() => false)
      await vi.advanceTimersByTimeAsync(0)
      expect(next.thens).toEqual([])
      expect(stored(old)).toMatchObject({ stage: 'compacted' })
    })
  })

  describe('a session that keeps compacting and going on (#2024)', () => {
    /** One cycle: the agent asks with a step, the compact runs, the step goes and its turn runs */
    async function cycle(w: ReturnType<typeof world>) {
      asked(w, undefined, 'next')
      await compactTurn(w)
      w.startTurn()
      w.endTurn()
    }

    it('warns the person once it passes 6 cycles in an hour, and holds back, refuses and delays nothing', async () => {
      const w = world()
      for (let i = 1; i <= WARN_COMPACT_CYCLES_PER_HOUR; i++) await cycle(w)
      expect(w.warned).toEqual([])
      await cycle(w)
      expect(w.warned).toEqual([['s1', WARN_COMPACT_CYCLES_PER_HOUR + 1]])
      // The session keeps working: the 7th went, and an 8th is asked, compacted and continued as the others
      expect(w.thens).toHaveLength(WARN_COMPACT_CYCLES_PER_HOUR + 1)
      await cycle(w)
      expect(w.thens).toHaveLength(WARN_COMPACT_CYCLES_PER_HOUR + 2)
      expect(w.warned.at(-1)).toEqual(['s1', WARN_COMPACT_CYCLES_PER_HOUR + 2])
      // The count is told on every cycle past the threshold; the mailbox writes one line an hour from it
      expect(w.sent).toHaveLength(WARN_COMPACT_CYCLES_PER_HOUR + 2)
    })

    it('counts the hour before the last step, not all that went before, and the count survives a swap', async () => {
      const old = world()
      for (let i = 0; i < 4; i++) await cycle(old)
      // The host after the swap goes on counting from the store
      const next = world({}, old.settings)
      for (let i = 0; i < 3; i++) await cycle(next)
      expect(next.warned).toEqual([['s1', 7]])
      // An hour later the earlier ones no longer count
      next.state.now += 61 * MIN
      await cycle(next)
      expect(next.warned).toEqual([['s1', 7]])
    })

    it('counts the turn of a refused request too, and does not count a step that was not sent', async () => {
      const w = world({ context: { used: 50_000, window: 200_000, exactness: 'exact' } })
      for (let i = 0; i < 8; i++) {
        // Each step read a little more: asked again at the same size it would be answered in the tool result, with no turn
        w.m().context = { used: 50_000 + i * 5_000, window: 200_000, exactness: 'exact' }
        w.startTurn()
        w.c.request('s1', undefined, 'next')
        w.endTurn(undefined, 'after')
        await settled()
      }
      expect(w.thens).toHaveLength(8)
      expect(w.warned.map((x) => x[1])).toEqual([7, 8])
      // The person's interrupt sends no step, so it counts no cycle
      const quiet = world({ context: { used: 60_000, window: 200_000, exactness: 'exact' } })
      for (let i = 0; i < 8; i++) {
        quiet.startTurn()
        quiet.c.request('s1', undefined, 'next')
        quiet.endTurn(interrupted, 'after')
        await settled()
      }
      expect(quiet.warned).toEqual([])
    })
  })

  describe('the size read since a compaction (#2024)', () => {
    it('drops a request that ends a turn with no size read since the compaction, whatever the reading kept from before says', () => {
      // Codex reports no size after a compaction: the reading kept is the 150k from before it
      const w = world({ tool: 'codex' })
      w.startTurn()
      w.emit({ ...compaction, trigger: 'auto' })
      w.endTurn(undefined, 'none')
      w.startTurn()
      w.c.request('s1', undefined, 'next')
      w.endTurn(undefined, 'none')
      vi.advanceTimersByTime(5_100)
      expect(w.sent).toEqual([])
    })

    it('stops a next step that asks again at once after Centralu’s own compaction when nothing was read', async () => {
      const w = world({ tool: 'codex' })
      asked(w, undefined, 'first step')
      w.startTurn()
      w.emit(compaction)
      w.endTurn(undefined, 'none')
      await settled()
      expect(w.thens).toHaveLength(1)
      // The next step is done and asks again: the 150k of before the compaction is not its size
      w.startTurn()
      w.c.request('s1', undefined, 'second step')
      w.endTurn(undefined, 'none')
      await vi.advanceTimersByTimeAsync(5_100 + THEN_SETTLE_MS)
      expect(w.sent).toHaveLength(1)
      // Refused: its step still comes, saying nothing was compacted
      expect(w.thens).toHaveLength(2)
      expect(w.thens[1]![1]).toMatch(/did not compact the conversation/)
    })

    it('judges a request held for a card by it too', () => {
      const w = world({ tool: 'codex' })
      w.startTurn()
      w.emit({ ...compaction, trigger: 'auto' })
      w.endTurn(undefined, 'none')
      w.startTurn()
      w.c.request('s1')
      w.state.idle = { idle: false, reason: 'question' }
      w.endTurn(undefined, 'none')
      w.state.idle = { idle: true }
      w.c.sweep()
      expect(w.sent).toEqual([])
    })

    it('goes by a size read after the compaction, and by the size of the turn’s own last request', async () => {
      const w = world()
      w.startTurn()
      w.emit({ ...compaction, trigger: 'auto' })
      w.endTurn(undefined, 'none')
      // The tool reads the context after the compaction: small; then the turn grew
      w.read(9_000)
      w.startTurn()
      w.c.request('s1', undefined, 'next')
      w.emit({ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, request: { inputTokens: 140_000, cacheReadTokens: 0 } })
      w.endTurn(undefined, 'none')
      expect(w.sent).toEqual([['s1', '/compact']])
      // And the reading since the compaction does not keep the next compaction from going on to its next step
      await compactTurn(w)
      expect(w.thens).toHaveLength(1)

      const small = world()
      small.startTurn()
      small.emit({ ...compaction, trigger: 'auto' })
      small.endTurn(undefined, 'none')
      small.read(9_000)
      small.startTurn()
      small.c.request('s1')
      small.endTurn(undefined, 'none')
      vi.advanceTimersByTime(5_100)
      expect(small.sent).toEqual([])
    })

    it('leaves a resting session alone until the tool has read its context since the compaction', () => {
      const w = world()
      w.startTurn()
      w.emit({ ...compaction, trigger: 'auto' })
      w.endTurn(undefined, 'none')
      w.state.now += 30 * MIN
      expect(w.c.sweep()).toEqual([])
      w.read(150_000)
      expect(w.c.sweep()).toEqual(['s1'])
    })

    it('does not count a compaction that failed: nothing shrank', async () => {
      const w = world()
      w.startTurn()
      w.emit({ type: 'compaction', sessionId: 's1', failed: true })
      w.endTurn(undefined, 'none')
      w.startTurn()
      w.c.request('s1', undefined, 'next')
      w.endTurn(undefined, 'none')
      vi.advanceTimersByTime(5_100)
      expect(w.sent).toEqual([['s1', '/compact']])
      await compactTurn(w)
      expect(w.thens).toHaveLength(1)
    })
  })
})

describe('a session at rest over the lower share (#1451)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A session that ended a turn at `now` and rests */
  function resting(over: Partial<SessionInfo> = {}) {
    const w = world(over)
    w.startTurn()
    w.endTurn()
    return w
  }
  const later = (w: ReturnType<typeof world>, minutes: number) => void (w.state.now += minutes * MIN)

  it('is compacted after 10 minutes at rest, once it is over 30% of the window and the floor', () => {
    const w = resting()
    later(w, IDLE_COMPACT_MINUTES - 1)
    expect(w.c.sweep()).toEqual([])
    later(w, 1)
    expect(w.c.sweep()).toEqual(['s1'])
    expect(w.sent).toEqual([['s1', '/compact']])
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false })
    expect(w.notices).toEqual([['s1', 'Compacted by Centralu (at rest for 10 minutes, over 30% of the window)']])
  })

  it('leaves a resting session of a tool with no compact command alone', () => {
    const w = resting({ tool: 'antigravity' })
    w.state.noCompact = true
    later(w, 60)
    expect(w.c.sweep()).toEqual([])
    expect(w.sent).toEqual([])
  })

  it('leaves a context under the share or under the floor alone', () => {
    const under = resting({ context: { used: 50_000, window: 1_000_000, exactness: 'exact' } })
    later(under, 60)
    expect(under.c.sweep()).toEqual([])
    // 40% of a 200k window, but under 100k
    const small = resting({ context: { used: 80_000, window: 200_000, exactness: 'exact' } })
    later(small, 60)
    expect(small.c.sweep()).toEqual([])
    expect(COMPACT_FLOOR_TOKENS).toBe(100_000)
    // 29% of 1M is over the floor but under 30%
    const share = resting({ context: { used: 290_000, window: 1_000_000, exactness: 'exact' } })
    later(share, 60)
    expect(share.c.sweep()).toEqual([])
    share.state.setting = { ...DEFAULT_AUTO_COMPACT, idleShare: 0.2 }
    expect(share.c.sweep()).toEqual(['s1'])
  })

  it('is off with the auto-compact switch', () => {
    const w = resting()
    w.state.setting = { ...DEFAULT_AUTO_COMPACT, controlled: false }
    later(w, 60)
    expect(w.c.sweep()).toEqual([])
  })

  it('never touches a session in a turn, with a card or a question, running background work, or without a process', () => {
    for (const reason of ['turn', 'approval', 'question', 'background', 'background_unknown'] as const) {
      const w = resting()
      later(w, 60)
      w.state.idle = { idle: false, reason }
      expect(w.c.sweep(), reason).toEqual([])
    }
    const asleep = resting()
    later(asleep, 60)
    asleep.state.running = false
    expect(asleep.c.sweep()).toEqual([])
    const gone = resting({ live: false })
    later(gone, 60)
    expect(gone.c.sweep()).toEqual([])
  })

  it('counts the rest from the turn’s end: a new turn starts the ten minutes again', () => {
    const w = resting()
    later(w, 9)
    w.startTurn()
    later(w, 5)
    w.endTurn()
    later(w, 9)
    expect(w.c.sweep()).toEqual([])
    later(w, 1)
    expect(w.c.sweep()).toEqual(['s1'])
  })

  it('counts a session seen at rest without a turn end from when it was first seen', () => {
    const w = world()
    expect(w.c.sweep()).toEqual([])
    later(w, IDLE_COMPACT_MINUTES)
    expect(w.c.sweep()).toEqual(['s1'])
  })

  it('compacts a session once per rest, even when the tool reports no size afterwards, until it has a turn of its own', () => {
    const w = resting()
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
    // Its compact turn runs and ends; the context reading stays as it was (Codex reports no size)
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false })
    w.endTurn()
    later(w, 120)
    expect(w.c.sweep()).toEqual([])
    // A turn of its own, then rest again
    w.startTurn()
    w.endTurn()
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
  })

  it('counts the rest again from a wake from sleep, so the first message does not wait behind a compaction', () => {
    const w = resting()
    later(w, 120)
    w.emit({ type: 'session_live', sessionId: 's1', live: true })
    expect(w.c.sweep()).toEqual([])
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
  })

  it('takes no share of a window the host does not know in full (a floor under the model’s, or nothing read since a restart) (#1553)', () => {
    const w = resting()
    w.m().context = { used: 190_000, window: 200_000, exactness: 'exact', capped: true }
    w.state.modelWindow = null
    later(w, 60)
    expect(w.c.sweep()).toEqual([])
    w.state.modelWindow = 200_000
    expect(w.c.sweep()).toEqual(['s1'])
  })

  it('may try again when the tool refused the compact before any turn began', () => {
    const w = resting()
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
    w.emit({ type: 'error', sessionId: 's1', error: { code: 'internal', message: 'no', retryable: false } })
    expect(w.c.sweep()).toEqual(['s1'])
    expect(w.sent).toHaveLength(2)
  })

  it('marks the turn it starts to compact, from its start to its end, and no other', () => {
    const w = resting()
    expect(w.c.compactTurn('s1')).toBe(false)
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
    // The tool has not begun the turn yet (Codex’s request): the next turn’s end is not the compact’s
    expect(w.c.compactTurn('s1')).toBe(false)
    w.startTurn()
    // Marked once the tool reports the compaction in it, which is before the turn ends
    expect(w.c.compactTurn('s1')).toBe(false)
    w.emit({ type: 'compaction', sessionId: 's1', failed: false })
    expect(w.c.compactTurn('s1')).toBe(true)
    w.endTurn()
    expect(w.c.compactTurn('s1')).toBe(false)
    // A turn of the session’s own after it is not marked
    w.startTurn()
    expect(w.c.compactTurn('s1')).toBe(false)
  })

  it('also marks the turn of a compact the agent asked for', () => {
    const w = world()
    w.startTurn()
    w.c.request('s1')
    w.endTurn()
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false })
    expect(w.c.compactTurn('s1')).toBe(true)
  })

  it('does not mark a turn of the person’s that the tool ran before the compact, and marks the compact’s own after it', () => {
    const w = resting()
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
    // The person’s message was already in the tool’s queue: its turn runs first
    w.startTurn()
    expect(w.c.compactTurn('s1')).toBe(false)
    w.endTurn()
    expect(w.c.compactTurn('s1')).toBe(false)
    // Then the compact’s own turn
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false })
    expect(w.c.compactTurn('s1')).toBe(true)
    w.endTurn()
    expect(w.c.compactTurn('s1')).toBe(false)
    expect(w.notices).toHaveLength(1)
  })

  it('does not take the session’s next own turn for the compact’s when a compaction was reported with no turn seen to start', () => {
    const w = resting()
    later(w, 10)
    w.c.sweep()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false })
    w.startTurn()
    expect(w.c.compactTurn('s1')).toBe(false)
    w.endTurn()
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
  })

  it('starts the ten minutes when the session becomes idle by every rule, not at its turn’s end', () => {
    const w = world()
    w.startTurn()
    // The turn ends with background work running
    w.state.idle = { idle: false, reason: 'background' }
    w.endTurn()
    later(w, 30)
    expect(w.c.sweep()).toEqual([])
    // The work ends: idle now, counted from the sweep that sees it
    w.state.idle = { idle: true }
    expect(w.c.sweep()).toEqual([])
    later(w, IDLE_COMPACT_MINUTES - 1)
    expect(w.c.sweep()).toEqual([])
    later(w, 1)
    expect(w.c.sweep()).toEqual(['s1'])
  })

  it('starts them again when a card or background work interrupts the rest', () => {
    const w = resting()
    later(w, 9)
    w.state.idle = { idle: false, reason: 'question' }
    expect(w.c.sweep()).toEqual([])
    later(w, 30)
    w.state.idle = { idle: true }
    expect(w.c.sweep()).toEqual([])
    later(w, 9)
    expect(w.c.sweep()).toEqual([])
    later(w, 1)
    expect(w.c.sweep()).toEqual(['s1'])
  })

  it('does not take the tool’s own compaction at its threshold, in a person’s turn that ran first, for Centralu’s', () => {
    const w = resting()
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false, trigger: 'auto' })
    expect(w.c.compactTurn('s1')).toBe(false)
    expect(w.notices).toEqual([])
    w.endTurn()
    // The compact’s own turn, a /compact
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false, trigger: 'manual' })
    expect(w.c.compactTurn('s1')).toBe(true)
    expect(w.notices).toHaveLength(1)
  })

  it('forgets the compact when its turn is interrupted before the compaction, so the person’s own /compact later is not Centralu’s', () => {
    const w = resting()
    later(w, 10)
    expect(w.c.sweep()).toEqual(['s1'])
    w.startTurn()
    w.endTurn({ type: 'state_change', sessionId: 's1', state: 'waiting_input', reason: 'interrupted' })
    // Later, a /compact the person typed
    w.startTurn()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false, trigger: 'manual' })
    expect(w.c.compactTurn('s1')).toBe(false)
    expect(w.notices).toEqual([])
  })

  it('leaves a session with a request pending to the request', () => {
    const w = resting()
    w.c.request('s1')
    later(w, 60)
    expect(w.c.sweep()).toEqual([])
  })
})

describe('on the session manager (#1451)', () => {
  const dir = projectDirs()
  let world: ReturnType<typeof managerWorld>

  beforeEach(() => {
    world = managerWorld()
    world.adapter.compactCommand = (focus) => (focus ? `/compact ${focus}` : '/compact')
    // Both real tools report their background work, which is what a session counts as at rest (idle.ts)
    ;(world.adapter.capabilities as { backgroundTasks: boolean }).backgroundTasks = true
  })
  afterEach(async () => {
    vi.useRealTimers()
    await world.mgr.disposeAll()
    world.store.close()
  })

  async function session() {
    const { rpc, mgr, adapter } = world
    const p = (await rpc('projects.add', { path: dir('compact-self-') })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: dir('compact-cwd-'), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    const tools = adapter.lastOrchestratorTools!
    const h = adapter.last!
    await mgr.send(s.id, 'hello')
    h.emitContext(150_000, 200_000)
    return { id: s.id, h, tools }
  }

  it('hands every ordinary session the tool, answers it, and compacts when the turn ends, never before', async () => {
    const { id, h, tools } = await session()
    expect(tools.compactSelf).toBeTypeOf('function')
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    expect(tools.compactSelf!('keep the PR').text).toMatch(/when the current turn ends/)
    expect(h.sent).toEqual(['hello'])
    h.finishTurn()
    expect(h.sent).toEqual(['hello', '/compact keep the PR'])
    // Said to be Centralu's compact, for a tool that tells its compaction only from that turn (ACP)
    expect(h.compacts).toEqual([false, true])
    // No user row: the person said nothing
    const rows = world.store.messages.loadMessages(id, 50)
    expect(JSON.stringify(rows.filter((r) => r.role === 'user'))).not.toContain('/compact')
    // The tool reports it; the conversation says who did it
    world.events.length = 0
    h.emitEvent({ type: 'compaction', sessionId: id, failed: false, before: 150_000, after: 8_000 })
    expect(world.events).toContainEqual(expect.objectContaining({ type: 'notice', sessionId: id, from: 'Centralu', text: 'Compacted by Centralu (the agent asked to after finishing its turn)' }))
  })

  it("goes by the session's own compact command first: none means no compaction and compact_self says it cannot", async () => {
    const { id, h, tools } = await session()
    // The handle decides per process (ACP: from the commands its agent advertised); the adapter's would send `/compact`
    ;(h as { compactCommand?: (focus: string | null) => string | null }).compactCommand = () => null
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    expect(tools.compactSelf!('keep the PR')).toEqual({ text: expect.stringMatching(/no compact command/), isError: true })
    h.finishTurn()
    h.emitContext(156_000, 200_000)
    expect(h.sent).toEqual(['hello'])
    // One that has its own sends it, focus and all
    ;(h as { compactCommand?: (focus: string | null) => string | null }).compactCommand = (focus) => `/compact${focus ? ` [${focus}]` : ''}`
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    tools.compactSelf!('keep the PR')
    h.finishTurn()
    h.emitContext(157_000, 200_000)
    expect(h.sent).toEqual(['hello', '/compact [keep the PR]'])
  })

  it('accepts the request when the turn grew past the floor, and decides on the size read at its end', async () => {
    const { id, h, tools } = await session()
    // Under the floor when the turn began (the reading is the previous turn's); over it when the turn ends
    h.emitContext(40_000, 200_000)
    h.finishTurn()
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    expect(tools.compactSelf!().text).toMatch(/if the context is then over 100k tokens/)
    h.finishTurn()
    expect(h.sent).toEqual(['hello'])
    h.emitContext(156_000, 200_000)
    expect(h.sent).toEqual(['hello', '/compact'])
  })

  it('drops the request when the size read at the turn’s end is under the floor', async () => {
    const { id, h, tools } = await session()
    h.emitContext(40_000, 200_000)
    h.finishTurn()
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    tools.compactSelf!()
    h.finishTurn()
    h.emitContext(41_000, 200_000)
    expect(h.sent).toEqual(['hello'])
  })

  it('says the turn Centralu starts to compact is a compaction turn, on the event that ends it', async () => {
    const { id, h, tools } = await session()
    h.finishTurn()
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    tools.compactSelf!()
    h.finishTurn()
    h.emitContext(150_000, 200_000)
    expect(h.sent).toEqual(['hello', '/compact'])
    world.events.length = 0
    // The compact turn: the fake handle does not start it, as Codex does not; the tool starts it, then ends it
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    h.emitEvent({ type: 'compaction', sessionId: id, failed: false })
    h.finishTurn()
    const ended = world.events.filter((e) => e.type === 'turn_complete')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ turn: { by: 'work', compaction: true } })
    // The next turn is the session's own and carries no mark
    world.events.length = 0
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    h.finishTurn()
    const own = world.events.find((e) => e.type === 'turn_complete')
    expect(own).toBeDefined()
    expect(own).not.toMatchObject({ turn: { compaction: true } })
  })

  /** Real timers are left alone except the moment a step waits after the compact turn (`THEN_SETTLE_MS`), which the test moves by hand */
  const settleStep = async () => {
    await vi.advanceTimersByTimeAsync(THEN_SETTLE_MS + 1)
  }
  /** A session that asked with a step, whose compact turn is running and has reported the compaction */
  async function inCompactTurn() {
    const s = await session()
    s.h.finishTurn()
    s.h.emitEvent({ type: 'state_change', sessionId: s.id, state: 'working' })
    expect(s.tools.compactSelf!(undefined, 'Continue with step 3 of the plan').text).toMatch(/with your `then`/)
    s.h.finishTurn()
    s.h.emitContext(150_000, 200_000)
    expect(s.h.sent).toEqual(['hello', '/compact'])
    // The compact turn: the tool starts it and reports the compaction
    s.h.emitEvent({ type: 'state_change', sessionId: s.id, state: 'working' })
    s.h.emitEvent({ type: 'compaction', sessionId: s.id, failed: false })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    return s
  }

  it('sends the next step after the compaction as an ordinary turn of the session in Centralu’s channel, with no user row (#2024), at once when nothing waits', async () => {
    const { id, h } = await inCompactTurn()
    expect(h.sent).toHaveLength(2)
    h.queuedInputs = () => 0
    h.finishTurn()
    await expect.poll(() => h.sent).toEqual(['hello', '/compact', expect.stringContaining('Continue with step 3 of the plan')])
    expect(h.origins.at(-1)).toEqual({ kind: 'channel', server: 'centralu' })
    expect(h.compacts.at(-1)).toBe(false)
    const rows = world.store.messages.loadMessages(id, 50)
    expect(JSON.stringify(rows.filter((r) => r.role === 'user'))).not.toContain('Continue with step 3')
    // The turn it starts is the session's own: it ends with no compaction mark
    world.events.length = 0
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    h.finishTurn()
    expect(world.events.find((e) => e.type === 'turn_complete')).not.toMatchObject({ turn: { compaction: true } })
  })

  it('sends the step after a message the person typed during the compact turn, never into the same turn (real run E2)', async () => {
    const { id, h } = await inCompactTurn()
    // The person types while the compact turn runs: the tool queues it behind the compact
    let queued = 0
    h.queuedInputs = () => queued
    await world.mgr.send(id, 'wait, use the other branch', undefined, undefined, true)
    queued = 1
    h.finishTurn()
    // The tool starts the queued message’s turn late, past any guess; nothing is sent beside it
    await vi.advanceTimersByTimeAsync(THEN_SETTLE_MS + 500)
    expect(h.sent).toEqual(['hello', '/compact', 'wait, use the other branch'])
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    queued = 0
    h.finishTurn()
    await expect.poll(() => h.sent.length).toBe(4)
    expect(h.sent[3]).toContain('Continue with step 3 of the plan')
    expect(h.sent[3]).toMatch(/message from the person ran before the compaction and came first/)
  })

  it('sends the step after mail that is delivered as the compact turn ends, never into the same turn', async () => {
    const { id, h } = await inCompactTurn()
    // Mail for the session waits in the mailbox as the compact turn ends (the mailbox’s debounce has not made it due yet)
    let mailWaiting = true
    world.mgr.useMail({ sessionGone: () => undefined, sessionChanged: () => undefined, waiting: () => mailWaiting })
    h.queuedInputs = () => 0
    h.finishTurn()
    await vi.advanceTimersByTimeAsync(THEN_SETTLE_MS + 500)
    expect(h.sent).toEqual(['hello', '/compact'])
    // The mailbox delivers it; its turn runs; the step follows its end
    mailWaiting = false
    await world.mgr.mailSessions().deliver(id, { text: '[mail] from another session: the build is green', quiet: false, line: '✉ mail' })
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    expect(h.sent).toEqual(['hello', '/compact', '[mail] from another session: the build is green'])
    h.finishTurn()
    await expect.poll(() => h.sent.length).toBe(4)
    expect(h.sent[3]).toContain('Continue with step 3 of the plan')
  })

  it('does not send the step into a session that is in a turn when its moment comes', async () => {
    const { id, h } = await inCompactTurn()
    h.finishTurn()
    // Something other than the compact turn began and the tool has not said so: the session is working when the moment is up
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    await settleStep()
    expect(h.sent).toEqual(['hello', '/compact'])
    h.finishTurn()
    await settleStep()
    await expect.poll(() => h.sent.length).toBe(3)
  })

  it('sends the next step as a turn that says why when the request was refused (#2024)', async () => {
    const { id, h, tools } = await session()
    h.emitContext(40_000, 200_000)
    h.finishTurn()
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    tools.compactSelf!(undefined, 'Continue with step 3')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h.finishTurn()
    h.emitContext(41_000, 200_000)
    await settleStep()
    await expect.poll(() => h.sent.length).toBe(2)
    expect(h.sent[0]).toBe('hello')
    expect(h.sent[1]).toMatch(/did not compact the conversation \(the context was 41k tokens, under the 100k floor\)/)
    expect(h.sent[1]).toContain('Continue with step 3')
    expect(h.origins.at(-1)).toEqual({ kind: 'channel', server: 'centralu' })
    expect(h.nudges).toEqual([])
  })

  it('leaves a resting session alone after a model switch until the new model’s window is read: the old one’s is not its window (#1553)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { id, h } = await session()
    h.finishTurn()
    await world.rpc('agents.updateSettings', { sessionId: id, model: 'sonnet' })
    const now = world.adapter.last!
    world.mgr.startSelfCompaction()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(now.sent).not.toContain('/compact')
    expect(h.sent).not.toContain('/compact')
    // The new model's reading gives its window: the same size is now over the share
    now.emitContext(150_000, 200_000)
    await vi.advanceTimersByTimeAsync(12 * MIN)
    expect(now.sent).toContain('/compact')
  })

  it('compacts a resting session over the share after ten minutes, and not with the switch off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { id, h } = await session()
    h.finishTurn()
    world.mgr.startSelfCompaction()
    await vi.advanceTimersByTimeAsync((IDLE_COMPACT_MINUTES - 1) * MIN)
    expect(h.sent).toEqual(['hello'])
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(h.sent).toEqual(['hello', '/compact'])
    expect(world.mgr.listSessions().find((s) => s.id === id)).toBeDefined()

    // Off: a second session at rest is left alone
    world.mgr.prefs.setUiPreferences({ autoCompact: { controlled: false } })
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    h.emitEvent({ type: 'compaction', sessionId: id, failed: false })
    h.finishTurn()
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    h.finishTurn()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(h.sent).toEqual(['hello', '/compact'])
  })
})
