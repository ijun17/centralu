import { describe, expect, it } from 'vitest'
import { CENTRALU, PERSON, appAddress, sessionAddress } from './address.js'
import { holdsInbound } from './policy.js'

const a = (id: string) => sessionAddress('hub-aaaaaaaa', id)
const thread = { owner: a('owner'), assignee: a('worker') }

describe('what a session that runs without asking holds (§7.7)', () => {
  it('holds mail from another session or an app that is in the thread but is not its owner or assignee', () => {
    expect(holdsInbound({ sender: a('member') }, thread)).toBe(true)
    expect(holdsInbound({ sender: appAddress('hub-aaaaaaaa', 'p1', 'board') }, thread)).toBe(true)
  })

  it('accepts the person, Centralu, and the owner and the assignee', () => {
    expect(holdsInbound({ sender: PERSON }, thread)).toBe(false)
    expect(holdsInbound({ sender: CENTRALU }, thread)).toBe(false)
    expect(holdsInbound({ sender: a('owner') }, thread)).toBe(false)
    expect(holdsInbound({ sender: a('worker') }, thread)).toBe(false)
  })
})
