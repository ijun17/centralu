import { describe, expect, it } from 'vitest'
import type { MailParty } from '@cc/protocol'
import { partyName } from './mail-party.js'

const party = (over: Partial<MailParty>): MailParty => ({ address: 'x', kind: 'session', sessionId: null, name: null, state: null, ...over })

describe('naming the parties', () => {
  it('the person is You, Centralu is Centralu, and a session or an app is its name, or what it was when it is gone', () => {
    expect(partyName(party({ kind: 'person', address: 'person' }))).toBe('You')
    expect(partyName(party({ kind: 'centralu' }))).toBe('Centralu')
    expect(partyName(party({ name: 'Parser' }))).toBe('Parser')
    expect(partyName(party({}))).toBe('A session that is gone')
    expect(partyName(party({ kind: 'app', name: 'board' }))).toBe('board')
    expect(partyName(party({ kind: 'robot', address: 'robot:1' }))).toBe('robot:1')
  })
})
