import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { foldSummary, groupAttention, HoverExpander, HOVER_EXPAND_MS } from './fold.js'

// Unread by default: an idle (`waiting_input`) session is not counted either way (owner, 2026-10-20)
const of = (...states: SessionState[]) => states.map((state) => ({ state, pendingQuestions: [], lastSeq: 2, lastReadSeq: 1 }))

describe('foldSummary (#205)', () => {
  it('counts waiting sessions and working sessions separately per state — never summed', () => {
    expect(
      foldSummary(of('working', 'waiting_approval', 'idle', 'waiting_input', 'waiting_approval', 'working', 'working')),
    ).toEqual([
      { state: 'waiting_approval', count: 2 },
      { state: 'working', count: 3 },
    ])
  })

  it('is in urgency order — approval, error, working', () => {
    expect(foldSummary(of('working', 'waiting_input', 'error', 'waiting_approval')).map((x) => x.state)).toEqual([
      'waiting_approval',
      'error',
      'working',
    ])
  })

  it('counts error too — it is a state the inbox counts as a waiting session', () => {
    expect(foldSummary(of('error', 'idle'))).toEqual([{ state: 'error', count: 1 }])
  })

  it('does not count an idle (waiting_input) session, read or unread: the inbox lists the unread ones', () => {
    const read = { state: 'waiting_input' as const, pendingQuestions: [], lastSeq: 3, lastReadSeq: 3 }
    const unread = { state: 'waiting_input' as const, pendingQuestions: [], lastSeq: 4, lastReadSeq: 3 }
    expect(foldSummary([read])).toEqual([])
    expect(foldSummary([read, unread])).toEqual([])
  })

  // The inbox lists an open question as an approval whatever state the session is in (`listedState`); the folded line did not
  it('counts an open question as an approval, as the inbox lists it, working or read', () => {
    const asking = { pendingQuestions: [{}], lastSeq: 3, lastReadSeq: 3 }
    expect(foldSummary([{ state: 'working', ...asking }])).toEqual([{ state: 'waiting_approval', count: 1 }])
    expect(foldSummary([{ state: 'waiting_input', ...asking }])).toEqual([{ state: 'waiting_approval', count: 1 }])
    // An error outranks the question, as in the inbox
    expect(foldSummary([{ state: 'error', ...asking }])).toEqual([{ state: 'error', count: 1 }])
  })

  it('says nothing when only idle or rate-limited sessions are present', () => {
    expect(foldSummary(of('idle', 'limited', 'idle'))).toEqual([])
    expect(foldSummary([])).toEqual([])
  })
})

describe('groupAttention (#666)', () => {
  const row = (over: Partial<{ state: SessionState; pendingQuestions: unknown[]; lastSeq: number; lastReadSeq: number }> = {}) => ({
    state: 'idle' as SessionState, pendingQuestions: [], lastSeq: 3, lastReadSeq: 3, ...over,
  })

  it('says nothing for rows that are working, idle or read', () => {
    expect(groupAttention([])).toBeNull()
    expect(groupAttention([row(), row({ state: 'working' }), row({ state: 'waiting_input' }), row({ state: 'limited' })])).toBeNull()
  })

  it('is an alert for a hidden approval, error or open question, the strongest sign', () => {
    expect(groupAttention([row({ lastSeq: 9 }), row({ state: 'waiting_approval' })])).toBe('alert')
    expect(groupAttention([row({ state: 'error' })])).toBe('alert')
    expect(groupAttention([row({ pendingQuestions: [{}] })])).toBe('alert')
  })

  it('is the quieter unread when that is all there is', () => {
    expect(groupAttention([row(), row({ lastSeq: 4 })])).toBe('unread')
  })
})

describe('HoverExpander (#1578)', () => {
  function setup(inside = true) {
    const timers: { fn: () => void; ms: number; live: boolean }[] = []
    const changes: boolean[] = []
    const state = { inside }
    const h = new HoverExpander({
      onChange: (o) => changes.push(o),
      pointerInside: () => state.inside,
      startTimer: (fn, ms) => {
        const t = { fn, ms, live: true }
        timers.push(t)
        return () => void (t.live = false)
      },
    })
    const fire = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()))
    return { h, changes, timers, fire, state }
  }

  it('expands once the pointer has rested HOVER_EXPAND_MS (100 ms) on a folded name row', () => {
    const { h, changes, timers, fire } = setup()
    h.enterRow(true)
    expect(timers).toHaveLength(1)
    expect(timers[0]?.ms).toBe(HOVER_EXPAND_MS)
    // The rest the owner chose (2026-10-26, #1605); a change of it is a decision, not a refactor
    expect(HOVER_EXPAND_MS).toBe(100)
    expect(changes).toEqual([])
    fire()
    expect(changes).toEqual([true])
  })

  it('does nothing when the pointer leaves the name before the rest is over', () => {
    const { h, changes, fire } = setup()
    h.enterRow(true)
    h.leaveRow()
    fire()
    expect(changes).toEqual([])
  })

  it('starts no timer on a project that is not folded', () => {
    const { h, timers } = setup()
    h.enterRow(false)
    expect(timers).toHaveLength(0)
  })

  it('folds when the pointer leaves the block, and not when it only leaves the name', () => {
    const { h, changes, fire } = setup()
    h.enterRow(true)
    fire()
    h.leaveRow()
    expect(changes).toEqual([true])
    h.leaveBlock()
    expect(changes).toEqual([true, false])
  })

  it('keeps one timer: entering again restarts the rest, and a block leave clears a pending one', () => {
    const { h, changes, timers, fire } = setup()
    h.enterRow(true)
    h.enterRow(true)
    expect(timers.filter((t) => t.live)).toHaveLength(1)
    h.leaveBlock()
    fire()
    expect(changes).toEqual([])
  })

  it('holds the project while a menu or a drag is open, and settles by where the pointer is', () => {
    const { h, changes, fire, state } = setup()
    h.enterRow(true)
    fire()
    h.hold(true)
    h.leaveBlock()
    expect(changes).toEqual([true])
    state.inside = false
    h.hold(false)
    expect(changes).toEqual([true, false])
  })

  it('stays open after a hold ends with the pointer still inside', () => {
    const { h, changes, fire } = setup(true)
    h.enterRow(true)
    fire()
    h.hold(true)
    h.hold(false)
    expect(changes).toEqual([true])
  })

  it('reset (a click made it stay) drops the transient state', () => {
    const { h, changes, fire } = setup()
    h.enterRow(true)
    fire()
    h.reset()
    expect(changes).toEqual([true, false])
  })
})
