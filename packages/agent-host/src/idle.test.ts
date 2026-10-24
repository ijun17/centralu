import { describe, expect, it } from 'vitest'
import { activityCounts, hostBusy, hostBusyBesides, updateAtRest, type ActivitySnapshot, type IdleActivity } from './idle.js'

describe('activityCounts (host.activity, for the "Update <machine>" prompt)', () => {
  const live = (over: Partial<IdleActivity>): IdleActivity => ({ state: 'waiting_input', live: true, ...over })

  it('counts each busy session once, by what a stop would cost it, and nothing hostBusy does not count', () => {
    const s: ActivitySnapshot = {
      sessions: [
        live({ state: 'working' }),
        live({ state: 'working', pendingApproval: { requestId: 'a', detail: { kind: 'other', raw: 'x' } } }),
        live({ state: 'waiting_approval' }),
        live({ pendingQuestions: [{ requestId: 'q', questions: [] }] }),
        live({ state: 'working', live: false }),
        live({ state: 'waiting_input' }),
      ],
      terminals: 2,
      commandRuns: 1,
    }
    expect(activityCounts(s)).toEqual({ working: 1, approvals: 2, questions: 1, background: 0, terminals: 2, commandRuns: 1 })
    const idle: ActivitySnapshot = { sessions: [live({}), live({ state: 'working', live: false })], terminals: 0, commandRuns: 0 }
    expect(hostBusy(idle)).toBe(false)
    expect(Object.values(activityCounts(idle)).every((n) => n === 0)).toBe(true)
  })

  it('counts a question as a question though it blocks the session as an approval does (#428)', () => {
    // The host keeps a session with an open question in waiting_approval, as the window does (protocol session-state.ts)
    const s: ActivitySnapshot = {
      sessions: [live({ state: 'waiting_approval', pendingQuestions: [{ requestId: 'q', questions: [] }] })],
      terminals: 0,
      commandRuns: 0,
    }
    expect(activityCounts(s)).toMatchObject({ approvals: 0, questions: 1 })
  })
})

describe('hostBusyBesides (an agent applying an update, #1509)', () => {
  const live = (over: Partial<IdleActivity>): IdleActivity => ({ state: 'waiting_input', live: true, ...over })
  const snap = (...sessions: IdleActivity[]): ActivitySnapshot => ({ sessions, terminals: 0, commandRuns: 0 })

  it('does not count the asking session\'s own turn, and counts every other session as hostBusy does', () => {
    expect(hostBusy(snap(live({ id: 'me', state: 'working' })))).toBe(true)
    expect(hostBusyBesides(snap(live({ id: 'me', state: 'working' })), 'me')).toBe(false)
    expect(hostBusyBesides(snap(live({ id: 'me', state: 'working' }), live({ id: 'other', state: 'working' })), 'me')).toBe(true)
    expect(hostBusyBesides(snap(live({ id: 'me', state: 'working' }), live({ id: 'other' })), 'me')).toBe(false)
  })

  it('still counts what the asking session holds besides its turn, and terminals and commands', () => {
    const task = { id: 't', kind: 'other', description: 'dev server', status: 'running' } as const
    expect(hostBusyBesides(snap(live({ id: 'me', state: 'working', backgroundTasks: [task] })), 'me')).toBe(true)
    expect(hostBusyBesides(snap(live({ id: 'me', state: 'working', pendingQuestions: [{ requestId: 'q', questions: [] }] })), 'me')).toBe(true)
    expect(hostBusyBesides({ ...snap(live({ id: 'me', state: 'working' })), terminals: 1 }, 'me')).toBe(true)
    expect(hostBusyBesides({ ...snap(live({ id: 'me', state: 'working' })), commandRuns: 1 }, 'me')).toBe(true)
  })
})

describe('updateAtRest (Automatic updates on and the host idle, #1509)', () => {
  const live = (over: Partial<IdleActivity>): IdleActivity => ({ state: 'waiting_input', live: true, ...over })
  const quiet: ActivitySnapshot = { sessions: [live({ id: 'a' })], terminals: 0, commandRuns: 0 }
  const base = { automatic: true, draining: false, activity: quiet }

  it('is true with the switch on, no swap draining and nothing running', () => {
    expect(updateAtRest(base)).toBe(true)
  })

  it('is false while the host drains for a swap', () => {
    expect(updateAtRest({ ...base, draining: true })).toBe(false)
  })

  it('is false with Automatic updates off', () => {
    expect(updateAtRest({ ...base, automatic: false })).toBe(false)
  })

  it('is false while anything runs, apart from the asking session\'s own turn', () => {
    const busy: ActivitySnapshot = { sessions: [live({ id: 'me', state: 'working' }), live({ id: 'other', state: 'working' })], terminals: 0, commandRuns: 0 }
    expect(updateAtRest({ ...base, activity: busy })).toBe(false)
    expect(updateAtRest({ ...base, activity: busy, besides: 'me' })).toBe(false)
    const mine: ActivitySnapshot = { sessions: [live({ id: 'me', state: 'working' })], terminals: 0, commandRuns: 0 }
    expect(updateAtRest({ ...base, activity: mine })).toBe(false)
    expect(updateAtRest({ ...base, activity: mine, besides: 'me' })).toBe(true)
    expect(updateAtRest({ ...base, activity: { ...quiet, terminals: 1 } })).toBe(false)
  })
})
