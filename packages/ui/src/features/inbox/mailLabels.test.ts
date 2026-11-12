import { describe, expect, it } from 'vitest'
import type { MailParty } from '@cc/protocol'
import { answeringTarget, closeStopsWork, crowdText, heldLabel, heldResume, replyKind, threadStateLabel } from './mailLabels.js'

const party = (over: Partial<MailParty>): MailParty => ({ address: 'x', kind: 'session', sessionId: null, name: null, state: null, ...over })

describe('the thread’s state', () => {
  it('is a word, with how it ended when it is done and did not finish, and a word a newer host wrote as it wrote it', () => {
    expect(threadStateLabel({ state: 'running', outcome: null, ask: null })).toBe('Running')
    expect(threadStateLabel({ state: 'review', outcome: null, ask: null })).toBe('In review')
    // Blockers went with threads: an older host's word is shown as it wrote it, not as a state this window has
    expect(threadStateLabel({ state: 'blocked', outcome: null, ask: null })).toBe('blocked')
    expect(threadStateLabel({ state: 'done', outcome: 'finished', ask: null })).toBe('Done')
    expect(threadStateLabel({ state: 'done', outcome: 'dropped', ask: null })).toBe('Done (dropped)')
    expect(threadStateLabel({ state: 'parked', outcome: null, ask: null })).toBe('parked')
  })

  it('says Waiting on you for a thread whose question the person has not answered (#2229), and Open for an ordinary one; a done thread says Done whatever it asked', () => {
    const ask = { id: 'm1', sender: party({}), text: 'Which branch?', open: ['m1'] }
    expect(threadStateLabel({ state: 'open', outcome: null, ask })).toBe('Waiting on you')
    expect(threadStateLabel({ state: 'open', outcome: null, ask: null })).toBe('Open')
    expect(threadStateLabel({ state: 'done', outcome: 'finished', ask })).toBe('Done')
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

describe('asking before a close', () => {
  it('only a host that does not say canReply (an older build, which stops the turn on a close) is asked first, and only while a turn is on the thread', () => {
    expect(closeStopsWork({ thread: { working: true } })).toBe(true)
    expect(closeStopsWork({ thread: { working: false } })).toBe(false)
    expect(closeStopsWork({ thread: {} })).toBe(false)
    // This build's host stops nothing, so nothing is asked, whether or not the thread has a reply box
    expect(closeStopsWork({ canReply: true, thread: { working: true } })).toBe(false)
    expect(closeStopsWork({ canReply: false, thread: { working: true } })).toBe(false)
  })
})

describe('the question the reply box answers (#2191, #2233)', () => {
  const q = (id: string, seq: number) => ({ id, seq, sender: party({}), kind: 'question', urgent: false, body: id, facts: {}, createdAt: 0 })
  const view = (open: string[] | null, ...ids: string[]) => ({
    thread: { ask: open && { id: open.at(-1) ?? '', sender: party({}), text: '', open } } as never,
    messages: ids.map((id, i) => q(id, i + 1)),
  })

  it('the host names the open questions: the window reads them and works out none of its own', () => {
    // m2 is a question in the messages that the host does not list (its sender is gone, or it is answered): it is not offered
    const { questions, target } = answeringTarget(view(['m1', 'm3'], 'm1', 'm2', 'm3'), null)
    expect(questions.map((m) => m.id)).toEqual(['m1', 'm3'])
    expect(target?.id).toBe('m3')
  })

  it('with one question open there is no target, and a host that names none (an older one) gives none however many questions the messages hold', () => {
    expect(answeringTarget(view(['m1'], 'm1', 'm2'), null).target).toBeUndefined()
    expect(answeringTarget(view(null, 'm1', 'm2'), null)).toEqual({ questions: [], target: undefined })
  })

  it('a question the person named stays the target, though it is answered elsewhere meanwhile: the words go to it and the host refuses them, they do not move to another unseen', () => {
    expect(answeringTarget(view(['m1', 'm2'], 'm1', 'm2'), 'm1').target?.id).toBe('m1')
    expect(answeringTarget(view(['m2'], 'm1', 'm2'), 'm1').target?.id).toBe('m1')
  })
})
