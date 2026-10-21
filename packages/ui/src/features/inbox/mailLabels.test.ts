import { describe, expect, it } from 'vitest'
import type { MailParty } from '@cc/protocol'
import { canGiveWorkTo, crowdText, heldLabel, heldResume, partyName, replyKind, threadStateLabel } from './mailLabels.js'

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

describe('the thread’s state', () => {
  it('is a word, with how it ended when it is done and did not finish, and a word a newer host wrote as it wrote it', () => {
    expect(threadStateLabel({ state: 'review', outcome: null })).toBe('In review')
    expect(threadStateLabel({ state: 'done', outcome: 'finished' })).toBe('Done')
    expect(threadStateLabel({ state: 'done', outcome: 'dropped' })).toBe('Done (dropped)')
    expect(threadStateLabel({ state: 'parked', outcome: null })).toBe('parked')
  })
})

describe('held mail', () => {
  it('says why, and frees a pause with Resume on the thread or the session, the rest by sending it', () => {
    expect(heldLabel('loop')).toMatchObject({ action: 'Resume', kind: 'resume-thread' })
    expect(heldLabel('budget')).toMatchObject({ action: 'Resume', kind: 'resume-session' })
    expect(heldLabel('policy')).toMatchObject({ action: 'Release', kind: 'release' })
    expect(heldLabel('uncertain').action).toBe('Send again')
    // A restart’s hold and a wake the tool failed late: the session may already have run it
    expect(heldLabel('uncertain').why).toContain('may already have run')
    expect(heldLabel('failed').action).toBe('Retry')
    expect(heldLabel('newer')).toEqual({ why: 'newer', action: 'Send now', kind: 'release' })
  })

  it('resumes a thread by its id and a session by the receiver’s; mail that is only sent again resumes nothing', () => {
    const recipient = party({ sessionId: 's1' })
    expect(heldResume({ reason: 'loop', threadId: 't1', recipient })).toEqual({ threadId: 't1' })
    expect(heldResume({ reason: 'budget', threadId: 't1', recipient })).toEqual({ sessionId: 's1' })
    expect(heldResume({ reason: 'budget', threadId: 't1', recipient: party({}) })).toBeNull()
    expect(heldResume({ reason: 'failed', threadId: 't1', recipient })).toBeNull()
  })
})

describe('who work can be given to', () => {
  it('is an ordinary session of this computer in a project; not the orchestrator, a coordinator, a builder, an app’s agent or another machine’s', () => {
    expect(canGiveWorkTo({ kind: 'worker', projectId: 'p1' })).toBe(true)
    expect(canGiveWorkTo({ kind: 'worker', projectId: 'p1', appId: null, machine: null })).toBe(true)
    expect(canGiveWorkTo({ kind: 'orchestrator', projectId: null })).toBe(false)
    expect(canGiveWorkTo({ kind: 'coordinator', projectId: 'p1' })).toBe(false)
    expect(canGiveWorkTo({ kind: 'worker', projectId: 'p1', appId: 'board' })).toBe(false)
    expect(canGiveWorkTo({ kind: 'worker', projectId: 'p1', machine: 'laptop' })).toBe(false)
    expect(canGiveWorkTo({ kind: 'worker', projectId: null })).toBe(false)
  })
})

describe('the crowd of sleeping sessions', () => {
  it('counts them in the singular and the plural', () => {
    expect(crowdText(1)).toBe('1 session has mail from while Centralu was off')
    expect(crowdText(12)).toBe('12 sessions have mail from while Centralu was off')
  })
})

describe('the person’s reply', () => {
  it('is an answer to a question, and a note otherwise; Centralu’s lines and the person’s own do not count', () => {
    const them = party({ name: 'Parser' })
    const you = party({ kind: 'person', address: 'person' })
    const centralu = party({ kind: 'centralu' })
    expect(replyKind([{ sender: them, kind: 'question' }])).toBe('answer')
    expect(replyKind([{ sender: them, kind: 'question' }, { sender: centralu, kind: 'event' }, { sender: you, kind: 'note' }])).toBe('answer')
    expect(replyKind([{ sender: them, kind: 'question' }, { sender: them, kind: 'report' }])).toBe('note')
    expect(replyKind([])).toBe('note')
  })
})
