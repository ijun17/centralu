import { describe, expect, it } from 'vitest'
import type { MailParty, SessionState } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, badgeCount, mailNotification, notificationFor, readNotifyPolicy } from './notify.js'

describe('readNotifyPolicy: the policy a snapshot from another build holds (#384)', () => {
  it('an older snapshot without a later switch takes that switch on by default, not off', () => {
    const older = { approval: false, error: true, allDone: true, whenFocused: false, sound: false }
    expect(readNotifyPolicy(older)).toEqual({ ...DEFAULT_NOTIFY_POLICY, approval: false, sound: false })
  })

  it('a newer snapshot keeps the switches this build knows and drops the rest', () => {
    const newer = { ...DEFAULT_NOTIFY_POLICY, error: false, quietHours: { from: 22, to: 7 } }
    expect(readNotifyPolicy(newer)).toEqual({ ...DEFAULT_NOTIFY_POLICY, error: false })
  })

  it('a broken value is no choice: each bad switch, or the whole policy, is the default', () => {
    expect(readNotifyPolicy({ done: 'yes', sound: false })).toEqual({ ...DEFAULT_NOTIFY_POLICY, sound: false })
    expect(readNotifyPolicy('loud')).toEqual(DEFAULT_NOTIFY_POLICY)
    expect(readNotifyPolicy([true])).toEqual(DEFAULT_NOTIFY_POLICY)
  })
})

const s = (state: SessionState, name = 'session') => ({ id: 's1', name, state })
const bg = { appFocused: false }

describe('immediate notifications (approvals only)', () => {
  it('notifies on a transition to waiting for approval', () => {
    expect(notificationFor(s('waiting_approval'), 'working', bg)).toMatchObject({ kind: 'approval' })
  })

  // The error switch is kept in the record and followed by nothing since 2026-10-20 (#2168)
  it('does not notify on a transition to error, whatever its switch says', () => {
    expect(notificationFor(s('error'), 'working', { ...bg, policy: { ...DEFAULT_NOTIFY_POLICY, error: true } })).toBeNull()
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
    expect(notificationFor(s('waiting_approval', 'auth refactor'), 'working', bg)?.body).toContain('auth refactor')
  })
})

describe('dock badge', () => {
  it('counts only approvals and errors (awaiting response does not go on the badge)', () => {
    expect(badgeCount({ approval: 2, error: 1 })).toBe(3)
    expect(badgeCount({ approval: 0, error: 0 })).toBe(0)
  })
})

describe('mail to the person (#1630)', () => {
  const planner: MailParty = { address: 'session:s1', kind: 'session', sessionId: 's1', name: 'Planner', state: null }
  const centralu: MailParty = { address: 'centralu', kind: 'centralu', sessionId: null, name: null, state: null }
  it('every message raises one, of any kind, a question too; focus follows the setting, and the approval switch does not', () => {
    expect(mailNotification({ from: planner, kind: 'note', preview: 'The build is green' }, bg)).toEqual({ kind: 'mail', title: 'Mail from Planner', body: 'The build is green' })
    expect(mailNotification({ from: centralu, kind: 'notice', preview: 'Centralu refused mail' }, bg)).toMatchObject({ kind: 'mail', title: 'Mail from Centralu' })
    expect(mailNotification({ from: planner, kind: 'question', preview: 'Which branch?' }, bg)).toEqual({ kind: 'mail', title: 'Question from Planner', body: 'Which branch?' })
    expect(mailNotification({ from: planner, kind: 'question', preview: 'x' }, { ...bg, policy: { ...DEFAULT_NOTIFY_POLICY, approval: false } })).not.toBeNull()
    expect(mailNotification({ from: planner, kind: 'note', preview: 'x' }, { appFocused: true })).toBeNull()
    expect(mailNotification({ from: planner, kind: 'note', preview: 'x' }, { appFocused: true, policy: { ...DEFAULT_NOTIFY_POLICY, whenFocused: true } })).not.toBeNull()
  })
})
