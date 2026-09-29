import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, allDoneNotification, badgeCount, notificationFor } from './notify.js'

const s = (state: SessionState, name = '세션') => ({ id: 's1', name, state })
const bg = { appFocused: false }

describe('immediate notifications (approvals and errors only)', () => {
  it('notifies on a transition to waiting for approval', () => {
    expect(notificationFor(s('waiting_approval'), 'working', bg)).toMatchObject({ kind: 'approval' })
  })

  it('notifies on a transition to error', () => {
    expect(notificationFor(s('error'), 'working', bg)).toMatchObject({ kind: 'error' })
  })

  it('does not notify for awaiting response (badge only — it is not urgent)', () => {
    expect(notificationFor(s('waiting_input'), 'working', bg)).toBeNull()
  })

  it('does not notify when the state is unchanged (only once, even when the same event repeats)', () => {
    expect(notificationFor(s('waiting_approval'), 'waiting_approval', bg)).toBeNull()
  })

  it('does not notify when the app is right in front of you (a notification while you are looking is noise)', () => {
    expect(notificationFor(s('waiting_approval'), 'working', { appFocused: true })).toBeNull()
  })

  it('a policy can turn on notifications in the foreground', () => {
    const ctx = { appFocused: true, policy: { ...DEFAULT_NOTIFY_POLICY, whenFocused: true } }
    expect(notificationFor(s('waiting_approval'), 'working', ctx)).toMatchObject({ kind: 'approval' })
  })

  it('the notification body includes the session name (you have to know which session it is to act)', () => {
    expect(notificationFor(s('waiting_approval', 'auth 리팩터링'), 'working', bg)?.body).toContain('auth 리팩터링')
  })
})

describe('the "all done" notification (the signal someone who has left the desk needs)', () => {
  // The decision is based on identity, so the same session in prev and now has to have the same id
  const w = (id: string, state: SessionState) => ({ id, state })

  it('notifies once when the last piece of work finishes', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input')]
    const now = [w('a', 'waiting_input'), w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toMatchObject({ kind: 'all_done' })
  })

  it('does not notify while a session is still working', () => {
    const prev = [w('a', 'working'), w('b', 'working')]
    const now = [w('a', 'working'), w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('does not notify again if everything had already finished (no duplicates)', () => {
    const done = [w('a', 'waiting_input')]
    expect(allDoneNotification(done, done, bg)).toBeNull()
  })

  it('does not notify when there are no sessions at all', () => {
    expect(allDoneNotification([], [w('a', 'working')], bg)).toBeNull()
  })

  it('it is not "all done" while a session is waiting for approval (a blocked agent does not have its hands free)', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_approval')]
    const now = [w('a', 'waiting_input'), w('b', 'waiting_approval')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('does not notify while a session is waiting on a limit (it resumes on its own once the limit lifts)', () => {
    const prev = [w('a', 'working'), w('b', 'limited')]
    const now = [w('a', 'waiting_input'), w('b', 'limited')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('notifies when the last approval is resolved and everything is awaiting response', () => {
    const prev = [w('a', 'waiting_input'), w('b', 'waiting_approval')]
    const now = [w('a', 'waiting_input'), w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toMatchObject({ kind: 'all_done' })
  })

  /*
   * The trap in comparing counts: **putting away** the last working session brings busy to 0, but the work
   * has not finished — only comparing identities can tell "the session that was busy has actually let go".
   */
  it('removing the last working session does not set off "All done"', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input')]
    const now = [w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('nothing goes off when the last working session is deleted', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input')]
    const now = [w('b', 'waiting_input')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })

  it('if another session became busy while the busy one finished, it is not over yet', () => {
    const prev = [w('a', 'working'), w('b', 'waiting_input')]
    const now = [w('a', 'waiting_input'), w('b', 'working')]
    expect(allDoneNotification(now, prev, bg)).toBeNull()
  })
})

describe('dock badge', () => {
  it('counts only approvals and errors (awaiting response does not go on the badge)', () => {
    expect(badgeCount({ approval: 2, error: 1 })).toBe(3)
    expect(badgeCount({ approval: 0, error: 0 })).toBe(0)
  })
})
