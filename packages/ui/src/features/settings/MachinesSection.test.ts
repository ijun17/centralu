import { describe, expect, it } from 'vitest'
import { connectAction, hubAutoNote } from './MachinesSection.jsx'

// #1143: where Centralu is stopped this computer starts none by itself, so the row's button says what it does there
describe('the button that opens a machine’s link', () => {
  it('is Start where Centralu is stopped, Connect where the link is down on purpose, Reconnect otherwise', () => {
    expect(connectAction('stopped')).toEqual({ label: 'Start', title: 'Starts Centralu there, which this computer does not do by itself' })
    expect(connectAction('disconnected')).toEqual({ label: 'Connect', title: 'Stays connected until you disconnect it' })
    expect(connectAction('unreachable')).toEqual({ label: 'Reconnect' })
  })
})

// #2127: a machine whose link is up and that did not answer is not "not connected": the row says what the read said
describe('what the row of a machine’s "Allow auto" says under its switch', () => {
  it('says a read that failed in its own words, and a machine whose link is down as not connected', () => {
    const unread = 'Box did not answer for its "Allow auto from a linked computer": no answer within 15 s'
    expect(hubAutoNote('Box', undefined, unread, null)).toBe(unread)
    expect(hubAutoNote('Box', 'unreachable', null, null)).toBe('Box is not connected, so its setting cannot be read or changed now.')
    expect(hubAutoNote('Box', 'on', null, 'it said no')).toBe('Not changed: it said no')
  })
})
