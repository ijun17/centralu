import { describe, expect, it } from 'vitest'
import { Qualifier } from './qualifier.js'

/**
 * What a linked machine says about itself is not the hub's to pass on. `prefs_changed` (#1306) is about the machine's own
 * preferences, so a window of the hub, which reads the hub's, must never be told to read again because of it. An event with
 * no session is dropped anyway; one that names a session would pass as that session's, which is the case the explicit
 * rule is for.
 */
describe('a linked machine\'s events about itself', () => {
  const q = new Qualifier('m1', 1)

  it('drops prefs_changed, also when it names a session', () => {
    expect(q.event({ type: 'prefs_changed' })).toBeNull()
    expect(q.event({ type: 'prefs_changed', sessionId: 's1' })).toBeNull()
  })

  it('still passes an event of a type it does not know when it names a session, qualified (the case prefs_changed must not fall into)', () => {
    expect(q.event({ type: 'a_later_event', sessionId: 's1' })).toEqual({ type: 'a_later_event', sessionId: 'm1.s1' })
    expect(q.event({ type: 'a_later_event' })).toBeNull()
  })
})

// #1604: the sender of the message a turn ran for is named as a message's sender is, or the hub could not match it to its own
describe('the origin a linked machine says a turn ran for', () => {
  const q = new Qualifier('m1', 1)

  it('qualifies the sender of the message, and passes a turn that names none as it came', () => {
    expect(q.event({ type: 'state_change', sessionId: 's1', state: 'working', origin: { seq: 4, from: { sessionId: '_hub-orchestrator', name: 'Parent' } } })).toEqual({
      type: 'state_change',
      sessionId: 'm1.s1',
      state: 'working',
      origin: { seq: 4, from: { sessionId: 'm1._hub-orchestrator', name: 'Parent' } },
    })
    expect(q.event({ type: 'state_change', sessionId: 's1', state: 'working' })).toEqual({ type: 'state_change', sessionId: 'm1.s1', state: 'working' })
  })
})
