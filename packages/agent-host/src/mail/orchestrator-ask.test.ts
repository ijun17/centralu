/**
 * A session asking the orchestrator (docs/plans/mailbox.md §7.6, #1447, #1683), over the host's wiring: a request is a message from a session, its
 * words are read only in the turn it starts, the asker's facts are the host's, there is no one-open rule, a project's sessions ask at most 5 times an
 * hour, an untrusted project's request waits for the person's trust, and the role's unsettled mail follows the role.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { reportRecorder } from './delegation.js'
import { at, hostWorld } from './host-mail.test-helpers.js'
import { openBy } from './mail.test-helpers.js'
import { MailService } from './service.js'
import { ASKS_PER_HOUR } from './rules.js'

const A = at('a')
const B = at('b')
const C = at('c')
const X = at('x')
const ORC = at('orc')
let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})
const started = (w = hostWorld()) => {
  w.afterReady()
  stops.push(w.stop)
  return w
}

describe('a request’s words are read in the turn it starts (§7.6)', () => {
  it('outside it the orchestrator sees who asks and that the words wait for that turn, and marking it done is refused; in it the words show under the asker’s facts', async () => {
    const w = started()
    w.states.set('orc', { kind: 'busy', why: 'turn' })
    const q = w.mail.send(A, { to: [ORC], text: 'please rebase #12' })
    const outside = w.tool.run('orc', { action: 'read', thread: q.message.id }).text
    expect(outside).toContain('It is a request: its words are shown in the turn it starts')
    expect(outside).toContain('Asked by session "alpha", project "p1", trusted.')
    expect(outside).not.toContain('please rebase #12')
    expect(w.tool.run('orc', { action: 'handled', thread: q.message.id }).text).toMatch(/^Refused \(not_allowed\)/)
    // Its own turn: the delivery starts it, with the asker
    w.states.set('orc', { kind: 'ready', live: true, quiet: true })
    w.delivery.poke('orc')
    await w.advance(2_000)
    expect(w.turns.current('orc')).toMatchObject({ messageId: q.message.id, asker: A })
    const inside = w.tool.run('orc', { action: 'read', thread: q.message.id }).text
    expect(inside).toContain('> please rebase #12')
    expect(inside).toContain('The person did not write it')
    expect(w.hooks.askedBy!('orc')).toMatchObject({ messageId: q.message.id, sessionId: 'a', name: 'alpha', project: 'p1', trusted: true })
  })

  it('a worker answering the orchestrator’s question is no request: no asker, its words are read anywhere', () => {
    const w = started()
    const ask = w.mail.send(ORC, { to: [B], text: 'which branch?' })
    const answer = w.mail.send(B, { to: [], replyTo: ask.message.id, text: 'main' })
    expect(w.tool.run('orc', { action: 'read', thread: answer.message.id }).text).toContain('> main')
  })
})

describe('the limits of asking (D13)', () => {
  it('no one-open rule: a second request while the first is open is taken (#1683); the sixth in an hour from a session and those it started is refused ask_rate', () => {
    const w = started()
    for (let i = 0; i < ASKS_PER_HOUR; i++) {
      w.clock.t += 10
      w.mail.send(i % 2 === 0 ? A : at('w'), { to: [ORC], text: `ask ${i}` })
    }
    w.clock.t += 10
    expect(w.tool.run('a', { action: 'send', to: 'orchestrator', text: 'one more' }).text).toMatch(/^Refused \(ask_rate\)/)
    // Another project is another group
    expect(w.tool.run('c', { action: 'send', to: 'orchestrator', text: 'mine' }).isError).toBeUndefined()
  })
})

describe('an untrusted project’s request (§7.4: the one hold replaces the asker’s hold)', () => {
  it('is held policy and never wakes the orchestrator; one from a trusted project wakes it', async () => {
    const w = started()
    const held = w.mail.send(X, { to: [ORC], text: 'from px' })
    await w.advance(2_000)
    expect(w.row(held.message.id, ORC)!.held).toBe('policy')
    expect(w.to('orc')).toEqual([])
    w.mail.send(C, { to: [ORC], text: 'from p2' })
    await w.advance(2_000)
    expect(w.to('orc')).toHaveLength(1)
  })
})

describe('the role moves (§7.7, D15, #1683)', () => {
  it('an unanswered request reaches the new orchestrator, even one the old one read, and a later request too', async () => {
    const w = started()
    const q = w.tool.run('a', { action: 'send', to: 'orchestrator', text: 'are you there?' })
    expect(q.isError).toBeUndefined()
    const request = w.store.mailbox.feedOf(A, { limit: 1 })[0]!
    await w.advance(2_000)
    expect(w.row(request.id, ORC)!.deliveredAt).not.toBeNull()
    w.endTurn('orc')
    // The old orchestrator goes to the trash: what came to the role is not settled gone with it
    w.hooks.sessionGone('orc')
    expect(w.row(request.id, ORC)!.settled).toBeNull()
    w.hooks.roleMoved!('b')
    expect(w.row(request.id, B)).toMatchObject({ deliveredAt: null, readAt: null, settled: null })
    expect(w.row(request.id, ORC)).toBeUndefined()
  })
})

describe('the end of a request turn (§7.6, S12)', () => {
  it('reports S12 to the asker, settles that turn’s requests, and an orchestrator that sent nothing owes nothing', async () => {
    const w = started()
    const q = w.mail.send(A, { to: [ORC], text: 'can you?', needsReply: true })
    await w.advance(2_000)
    w.endTurn('orc')
    reportRecorder(w.service, w.store.mailbox, w.turns)('a', 'orc', { outcome: 'interrupted', body: 'x', then: 'review', delivery: 'wake' })
    expect(w.row(q.message.id, ORC)!.settled).toBe('reported')
    expect(w.store.mailbox.reportsOn(q.message.id)[0]!.body).toBe(
      "[Centralu] The orchestrator's turn on your request did not finish (interrupted). What it sent you in reply, if anything, has reached you. Ask again, or ask the person.",
    )
  })

  it('a turn that carried two requests of one asker settles both at its end: the second is not left owed', async () => {
    const w = started()
    const first = w.mail.send(A, { to: [ORC], text: 'rebase #12', needsReply: true })
    const second = w.mail.send(A, { to: [ORC], text: 'and #13', needsReply: true })
    await w.advance(2_000)
    expect(w.to('orc')).toHaveLength(1)
    w.endTurn('orc')
    reportRecorder(w.service, w.store.mailbox, w.turns)('a', 'orc', { outcome: 'finished', body: 'done', then: 'review', delivery: 'wake' })
    expect(w.row(first.message.id, ORC)!.settled).not.toBeNull()
    expect(w.row(second.message.id, ORC)!.settled).not.toBeNull()
  })

  it('a request moved from an old thread starts a request turn with its asker; its end settles nothing more and reports S12 to the asker', async () => {
    const w = hostWorld()
    const old = new MailService(w.store.mail, { hostId: () => 'hub-aaaaaaaa', now: () => w.clock.t })
    const { message } = openBy(old, { by: A, kind: 'assign', subject: 'please', body: 'please look at CI', assignee: ORC })
    started(w)
    await w.advance(2_000)
    await w.advance(1)
    expect(w.turns.current('orc')).toMatchObject({ messageId: message.id, asker: A })
    expect(w.row(message.id, ORC)!.settled).toBe('legacy')
    w.endTurn('orc')
    expect(reportRecorder(w.service, w.store.mailbox, w.turns)('a', 'orc', { outcome: 'finished', body: 'x', then: 'review', delivery: 'wake' })).toBe('mailed')
    expect(w.store.mailbox.reportsOn(message.id)[0]!.body).toContain('ended its turn on your request')
    expect(w.row(message.id, ORC)!.settled).toBe('legacy')
  })
})
