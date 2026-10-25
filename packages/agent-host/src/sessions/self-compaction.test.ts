import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { DEFAULT_AUTO_COMPACT } from '@cc/protocol'
import type { SessionIdle } from '../idle.js'
import { managerWorld, projectDirs } from './manager.test-helpers.js'
import { COMPACT_FLOOR_TOKENS, IDLE_COMPACT_MINUTES, SelfCompaction, type SelfCompactionHost } from './self-compaction.js'

/**
 * Compacting at a turn's end (#1451): the agent's compact_self, and a session at rest over the lower share. The first
 * part reads the rule on a fake host and clock; the second runs it through a real session manager.
 */

const MIN = 60_000

function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 's1', tool: 'claude', state: 'waiting_input', live: true, context: { used: 150_000, window: 200_000, exactness: 'exact' }, ...over } as SessionInfo
}

function world(initial: Partial<SessionInfo> = {}) {
  const sessions = new Map<string, SessionInfo>([['s1', info(initial)]])
  const sent: [string, string][] = []
  const notices: [string, string][] = []
  const state = { now: 1_000_000, idle: { idle: true } as SessionIdle, running: true, setting: { ...DEFAULT_AUTO_COMPACT }, failSend: false, modelWindow: undefined as number | null | undefined }
  const host: SelfCompactionHost = {
    sessions: () => [...sessions.values()],
    session: (id) => sessions.get(id),
    idle: () => state.idle,
    running: () => state.running,
    // undefined: the host has read the session's window in full (the reading's own); null: it knows none of the model
    window: (s) => (state.modelWindow === undefined ? (s.context?.window ?? null) : state.modelWindow),
    setting: () => state.setting,
    command: (tool, focus) => (tool === 'claude' && focus ? `/compact ${focus}` : '/compact'),
    send: (id, text) => {
      if (state.failSend) throw new Error('no process')
      sent.push([id, text])
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
  return { c, state, sent, notices, m, emit, startTurn, endTurn, read }
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
    // No user row: the person said nothing
    const rows = world.store.messages.loadMessages(id, 50)
    expect(JSON.stringify(rows.filter((r) => r.role === 'user'))).not.toContain('/compact')
    // The tool reports it; the conversation says who did it
    world.events.length = 0
    h.emitEvent({ type: 'compaction', sessionId: id, failed: false, before: 150_000, after: 8_000 })
    expect(world.events).toContainEqual(expect.objectContaining({ type: 'notice', sessionId: id, from: 'Centralu', text: 'Compacted by Centralu (the agent asked to after finishing its turn)' }))
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
    world.mgr.setUiPreferences({ autoCompact: { controlled: false } })
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    h.emitEvent({ type: 'compaction', sessionId: id, failed: false })
    h.finishTurn()
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    h.finishTurn()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(h.sent).toEqual(['hello', '/compact'])
  })
})
