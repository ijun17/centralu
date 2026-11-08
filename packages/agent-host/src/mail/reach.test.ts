/**
 * Who may write to whom, what trust means and the one hold (docs/plans/mailbox.md §7.1 to §7.4), asked of the host's table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { A, B, C, ORC, W, X, Y, addr, world } from './messages.test-helpers.js'
import { PERSON, sessionAddress } from './address.js'

afterEach(() => {
  vi.doUnmock('./rules.js')
  vi.resetModules()
})

const message = (sender: string, senderProject: string | null, depth = 0, kind: 'message' | 'task' | 'report' | 'notice' = 'message') => ({ kind, sender, senderProject, depth })

describe('trust (§7.2)', () => {
  it('untrusted: no project is trusted, a known project reads its flag, an unknown id is untrusted', () => {
    const { reach, projects } = world()
    expect(reach.untrusted(null)).toBe(false)
    expect(reach.untrusted('p1')).toBe(false)
    expect(reach.untrusted('px')).toBe(true)
    expect(reach.untrusted('deleted')).toBe(true)
    // Read live, never cached
    projects.set('px', { trusted: true })
    expect(reach.untrusted('px')).toBe(false)
    projects.delete('p1')
    expect(reach.untrusted('p1')).toBe(true)
  })
})

describe('who may write to whom (§7.1)', () => {
  it('lets a session write to a session here, the person and the Assistant, and the person and Centralu write to a session', () => {
    const { reach } = world()
    expect(reach.mayWrite(A, B)).toBeNull()
    expect(reach.mayWrite(A, C)).toBeNull()
    expect(reach.mayWrite(A, PERSON)).toBeNull()
    expect(reach.mayWrite(A, ORC)).toBeNull()
    expect(reach.mayWrite(ORC, A)).toBeNull()
    expect(reach.mayWrite(PERSON, A)).toBeNull()
    expect(reach.mayWrite('centralu', A)).toBeNull()
  })

  it('refuses a session that is gone, one whose seat has no mail tool, one on another computer, and a sender that is gone', () => {
    const { reach, sessions } = world()
    sessions.set('away', { projectId: 'p1', here: false })
    sessions.set('nomail', { projectId: 'p1', canReadMail: false })
    expect(reach.mayWrite(A, addr('never'))).toBe('gone')
    expect(reach.mayWrite(A, addr('away'))).toBe('gone')
    expect(reach.mayWrite(PERSON, addr('away'))).toBe('gone')
    expect(reach.mayWrite(A, addr('nomail'))).toBe('no_mailbox')
    expect(reach.mayWrite('centralu', addr('nomail'))).toBe('no_mailbox')
    expect(reach.mayWrite(addr('away'), A)).toBe('gone')
    expect(reach.mayWrite(addr('never'), A)).toBe('gone')
  })

  it('refuses Centralu and apps as receivers, and anything that is not an address', () => {
    const { reach } = world()
    expect(reach.mayWrite(A, 'centralu')).toBe('not_allowed')
    expect(reach.mayWrite(A, 'app:hub-aaaaaaaa/p1/board')).toBe('not_allowed')
    expect(reach.mayWrite(A, 'nonsense')).toBe('bad_address')
    expect(reach.mayWrite('nonsense', A)).toBe('bad_address')
  })

  it('an app writes to a session that called it and to no one else yet', async () => {
    const { mailReach } = await import('./reach.js')
    const app = 'app:hub-aaaaaaaa/p1/board'
    const reach = mailReach({
      hostId: 'hub-aaaaaaaa',
      session: (id) => (id === 'a' || id === 'b' ? { projectId: 'p1', askedBy: null, here: true, canReadMail: true, host: 'here' } : undefined),
      assistantId: () => null,
      assistantAsks: () => true,
      appCalledBy: (_app, session) => session === 'a',
      project: () => ({ trusted: true }),
      askGroupMembers: () => [],
    })
    expect(reach.mayWrite(app, A)).toBeNull()
    expect(reach.mayWrite(app, B)).toBe('not_allowed')
    expect(reach.mayWrite(app, PERSON)).toBe('not_allowed')
  })

  it('refuses a request to the Assistant while its tool cannot put each step to the person, but not an answer or the Assistant’s own word', () => {
    const { reach, state } = world()
    state.asks = false
    expect(reach.mayWrite(A, ORC)).toBe('orchestrator_asks')
    expect(reach.mayWrite(A, ORC, false)).toBeNull()
    expect(reach.mayWrite(ORC, A)).toBeNull()
    expect(reach.mayWrite(A, B)).toBeNull()
    state.asks = true
    expect(reach.mayWrite(A, ORC)).toBeNull()
  })
})

describe('the one hold (§7.4)', () => {
  it('an untrusted project’s session to another project’s session and to the Assistant is held policy; to its own project and to the person it is not', () => {
    const { reach } = world()
    const m = message(X, 'px')
    expect(reach.holdFor(m, C)).toBe('policy')
    expect(reach.holdFor(m, A)).toBe('policy')
    expect(reach.holdFor(m, ORC)).toBe('policy')
    expect(reach.holdFor(m, Y)).toBeNull()
    expect(reach.holdFor(m, PERSON)).toBeNull()
    // A session of no project is outside every project
    expect(reach.holdFor(m, addr('nobody'))).toBeNull()
  })

  it('a trusted project’s session, a session of none and anything that is not a message are never held', () => {
    const { reach } = world()
    expect(reach.holdFor(message(A, 'p1'), X)).toBeNull()
    expect(reach.holdFor(message(ORC, null), X)).toBeNull()
    expect(reach.holdFor(message(PERSON, null), X)).toBeNull()
    for (const kind of ['task', 'report', 'notice'] as const) expect(reach.holdFor(message(X, 'px', 0, kind), C), kind).toBeNull()
  })

  it('holdFor holds only for the one hold, whatever the depth an earlier build wrote (#2014)', () => {
    const { reach } = world()
    expect(reach.holdFor(message(A, 'p1', 5), C)).toBeNull()
    expect(reach.holdFor(message(X, 'px', 5), C)).toBe('policy')
    expect(reach.holdFor(message(X, 'px', 5), Y)).toBeNull()
  })

  it('refusesDelegation names the caller’s untrusted project for a target outside it, and nothing within it', () => {
    const { reach } = world()
    expect(reach.refusesDelegation('x', { sessionId: 'c' })).toBe('px')
    expect(reach.refusesDelegation('x', { sessionId: 'y' })).toBeNull()
    expect(reach.refusesDelegation('x', { projectId: 'p2' })).toBe('px')
    expect(reach.refusesDelegation('x', { projectId: 'px' })).toBeNull()
    expect(reach.refusesDelegation('x', { projectId: null })).toBe('px')
    expect(reach.refusesDelegation('x', { assistant: true })).toBe('px')
    expect(reach.refusesDelegation('x', { linked: true })).toBe('px')
    // A trusted caller, a caller with no project and a caller nobody knows are never refused
    expect(reach.refusesDelegation('a', { sessionId: 'c' })).toBeNull()
    expect(reach.refusesDelegation('orc', { sessionId: 'c' })).toBeNull()
    expect(reach.refusesDelegation('ghost', { sessionId: 'c' })).toBeNull()
    // A target nobody knows is outside the project
    expect(reach.refusesDelegation('x', { sessionId: 'ghost' })).toBe('px')
  })

  it('HOLD_UNTRUSTED_OUT false holds nothing and refuses nothing', async () => {
    vi.resetModules()
    vi.doMock('./rules.js', async (original) => ({ ...(await original<typeof import('./rules.js')>()), HOLD_UNTRUSTED_OUT: false }))
    const { world: freshWorld } = await import('./messages.test-helpers.js')
    const { reach } = freshWorld()
    expect(reach.holdFor(message(X, 'px'), C)).toBeNull()
    expect(reach.refusesDelegation('x', { sessionId: 'c' })).toBeNull()
  })
})

describe('what the service reads of a session', () => {
  it('knows the Assistant, a session’s project, parent and name, and its group', () => {
    const { reach } = world()
    expect(reach.isAssistant(ORC)).toBe(true)
    expect(reach.isAssistant(A)).toBe(false)
    expect(reach.isAssistant(PERSON)).toBe(false)
    expect(reach.projectOf(W)).toBe('p1')
    expect(reach.projectOf(ORC)).toBeNull()
    expect(reach.projectOf(PERSON)).toBeNull()
    expect(reach.parentOf(W)).toBe(A)
    expect(reach.parentOf(A)).toBeNull()
    expect(reach.labelOf(W)).toBe('worker')
    expect(reach.labelOf(addr('ghost'))).toBe(addr('ghost'))
    expect(reach.projectLabel('px')).toBe('Pex')
    expect(reach.projectLabel('p2')).toBe('p2')
    expect(reach.askGroupMembers(A).sort()).toEqual([A, B, W].sort())
  })

  it('looks up only the sessions of this host: an address on another computer is no session here, whatever its id', () => {
    const { reach } = world()
    const other = sessionAddress('hub-bbbbbbbb', 'a')
    expect(reach.projectOf(other)).toBeNull()
    expect(reach.labelOf(other)).toBe(other)
    expect(reach.isAssistant(sessionAddress('hub-bbbbbbbb', 'orc'))).toBe(false)
    expect(reach.mayWrite(A, other)).toBe('elsewhere')
    expect(reach.mayWrite(PERSON, other)).toBe('elsewhere')
    expect(reach.mayWrite(other, A)).toBe('gone')
  })
})
