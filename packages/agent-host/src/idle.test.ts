import { describe, expect, it } from 'vitest'
import { activityCounts, hostBusy, type ActivitySnapshot, type IdleActivity } from './idle.js'

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
