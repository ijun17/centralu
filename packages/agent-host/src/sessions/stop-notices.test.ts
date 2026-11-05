/**
 * A turn that stops without answering tells the senders of the questions it left (docs/plans/turn-owned-by-no-one.md §4.1, P1), over the real manager:
 * the event that ended the turn gives the cause, a quit or the system's end found at the next start is told quietly, and a cut turn Centralu continues
 * or a turn that ended normally tells no one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL } from '../adapters/contract.js'
import type { MailRow } from '../dev-services/store/mailbox.js'
import { wakesMessage } from '../mail/rules.js'
import type { HostMail } from '../mail/host-mail.js'
import { crossWorld, type CrossHandle, type CrossWorld } from './cross-project.test-helpers.js'
import { addressOf as addr, mailReader, wireHostMail } from './host-mail.test-helpers.js'

let w: CrossWorld
let m: HostMail
let read: ReturnType<typeof mailReader>

beforeEach(async () => {
  w = await crossWorld()
  m = wireHostMail(w.mgr, w.store)
  read = mailReader(w.store)
})
afterEach(async () => {
  m.delivery.stop()
  vi.restoreAllMocks()
  await w.dispose()
})

const handleOf = (id: string): CrossHandle => (w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id))!
type Internals = { meta: Map<string, { interruption?: unknown; state: string }>; restartPolicy: { continuingTurns: Set<string> }; turnLostInSwap(m: unknown): void }
const inside = () => w.mgr as unknown as Internals

/** `asker` asked `child` a question that was delivered to it and is not answered */
async function asked(): Promise<{ asker: string; child: string; question: MailRow }> {
  const asker = await w.callerSession()
  const child = await w.callerSession()
  const question = m.service.send(addr(asker), { to: [addr(child)], text: 'which branch is the release on?', needsReply: true }).message
  w.store.mailbox.markDelivered(addr(child), [question.id], Date.now(), null)
  return { asker, child, question }
}
const working = (child: string) => handleOf(child).event({ type: 'state_change', sessionId: child, state: 'working' })
/** The stop notices Centralu wrote to `who` */
const stopNotices = (who: string) => read.to(addr(who)).filter((x) => x.message.kind === 'notice' && x.message.facts.unanswered)
const stopNoticesToPerson = () => w.store.mailbox.pendingFor('person', Date.now() + 60_000).filter((p) => p.message.kind === 'notice' && p.message.facts.unanswered)

type Ending = { name: string; end: (child: string) => NormalizedEvent; why: string; says: string }
const ENDINGS: Ending[] = [
  { name: 'an error', end: (s) => ({ type: 'error', sessionId: s, error: { code: 'internal', message: 'something broke', retryable: false } }), why: 'error', says: 'stopped with an error before it answered' },
  {
    name: 'a network error',
    end: (s) => ({ type: 'error', sessionId: s, error: { code: 'internal', message: 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)', retryable: false } }),
    why: 'network',
    says: 'lost the network before it answered',
  },
  { name: 'a usage limit', end: (s) => ({ type: 'limit_reached', sessionId: s }), why: 'limit', says: 'reached its usage limit before it answered' },
  { name: "its tool's interrupt", end: (s) => ({ type: 'state_change', sessionId: s, state: 'waiting_input', reason: INTERRUPTED_BY_TOOL }), why: 'interrupted', says: "tool interrupted its turn before it answered" },
  { name: "the person's Stop", end: (s) => ({ type: 'state_change', sessionId: s, state: 'waiting_input', reason: 'interrupted' }), why: 'stopped', says: 'was stopped before it answered' },
]

describe('a turn ends without finishing', () => {
  it.each(ENDINGS)('$name: the asker is told once, in words that say what happened and what it can do, and the question stays open', async ({ end, why, says }) => {
    const { asker, child, question } = await asked()
    working(child)
    handleOf(child).event(end(child))
    await w.until(() => stopNotices(asker).length === 1)

    expect(read.row(question.id, addr(child))).toMatchObject({ releasedWhy: why, settled: null })
    const message = stopNotices(asker)[0]!.message
    expect(message.facts.unanswered).toEqual([{ id: question.id, recipient: addr(child), why }])
    expect(message.body).toContain(says)
    expect(message.body).toContain(question.id)
    // The asker is at rest: the notice wakes it. The tool's own words are not in it (#120)
    expect(wakesMessage(message)).toBe(true)
    expect(message.body).not.toContain('something broke')
    expect(message.body).not.toContain('ECONNREFUSED')

    // Once: another stop of the same session, before it was continued, tells no one again
    working(child)
    handleOf(child).event({ type: 'limit_reached', sessionId: child })
    await new Promise((r) => setTimeout(r, 20))
    expect(stopNotices(asker)).toHaveLength(1)
  })

  it('an asker that is in a turn reads the notice with its other mail: it is written quiet', async () => {
    const { asker, child } = await asked()
    working(asker)
    working(child)
    handleOf(child).event({ type: 'limit_reached', sessionId: child })
    await w.until(() => stopNotices(asker).length === 1)
    expect(wakesMessage(stopNotices(asker)[0]!.message)).toBe(false)
  })

  it('the person who asked is told in the Inbox', async () => {
    const child = await w.callerSession()
    const q = m.service.send('person', { to: [addr(child)], text: 'are you done?', needsReply: true }).message
    w.store.mailbox.markDelivered(addr(child), [q.id], Date.now(), null)
    working(child)
    handleOf(child).event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'x', retryable: false } })
    await w.until(() => stopNoticesToPerson().length === 1)
    expect(stopNoticesToPerson()[0]?.message.facts.unanswered).toEqual([{ id: q.id, recipient: addr(child), why: 'error' }])
  })

  it('a turn that completes tells no one, and neither does a stop of a session nobody asked', async () => {
    const { asker, child } = await asked()
    handleOf(child).answer('the release is on main')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    await new Promise((r) => setTimeout(r, 20))
    expect(stopNotices(asker)).toEqual([])
    // The same session, asked again, that then stops is told
    m.service.send(addr(asker), { to: [addr(child)], text: 'and the tag?', needsReply: true })
    const again = read.between(addr(asker), addr(child)).at(-1)!
    w.store.mailbox.markDelivered(addr(child), [again.id], Date.now(), null)
    working(child)
    handleOf(child).event({ type: 'limit_reached', sessionId: child })
    await w.until(() => stopNotices(asker).length === 1)

    const quiet = await w.callerSession()
    working(quiet)
    handleOf(quiet).event({ type: 'limit_reached', sessionId: quiet })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.store.mailbox.feedOf(addr(quiet), { limit: 10 })).toEqual([])
  })

  it('a turn Centralu continues after an update tells no one, and the continued turn that then fails does', async () => {
    const { asker, child } = await asked()
    inside().restartPolicy.continuingTurns.add(child)
    working(child)
    handleOf(child).event({ type: 'state_change', sessionId: child, state: 'waiting_input', reason: INTERRUPTED_BY_TOOL })
    await new Promise((r) => setTimeout(r, 20))
    expect(stopNotices(asker)).toEqual([])

    inside().restartPolicy.continuingTurns.delete(child)
    working(child)
    handleOf(child).event({ type: 'limit_reached', sessionId: child })
    await w.until(() => stopNotices(asker).length === 1)
  })
})

describe('who is not told, or told another way', () => {
  it('a host that is leaving writes nothing: the turns it cuts are continued or marked by the next one', async () => {
    const { asker, child } = await asked()
    const leaving = w.mgr as unknown as { handingOver: boolean }
    working(child)
    leaving.handingOver = true
    handleOf(child).event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'x', retryable: false } })
    await new Promise((r) => setTimeout(r, 20))
    leaving.handingOver = false
    expect(stopNotices(asker)).toEqual([])
    expect(read.row(read.between(addr(asker), addr(child))[0]!.id, addr(child))).toMatchObject({ releasedAt: null })
    // Nothing was released, so the next host's stop of the same question is told
    working(child)
    handleOf(child).event({ type: 'limit_reached', sessionId: child })
    await w.until(() => stopNotices(asker).length === 1)
  })

  it('the session that started the child, which the older report tells of the stop, gets that and not a second notice', async () => {
    const asker = await w.callerSession()
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const started = await w.mgr.startAgent(asker, { task: 'long job', wait: false })
    const child = started.ok ? started.sessionId : ''
    const q = m.service.send(addr(asker), { to: [addr(child)], text: 'which branch?', needsReply: true }).message
    w.store.mailbox.markDelivered(addr(child), [q.id], Date.now(), null)
    handleOf(child).event({ type: 'limit_reached', sessionId: child })
    await w.until(() => read.reportsOn(read.tasks(addr(asker), child)[0]!.id).length === 1)
    expect(read.row(q.id, addr(child))).toMatchObject({ releasedWhy: 'limit', toldAt: expect.any(Number) })
    expect(stopNotices(asker)).toEqual([])
  })

  it('a sender a quit cut is told quietly: a notice would start a turn with nobody there', async () => {
    const { asker, child } = await asked()
    inside().meta.get(asker)!.interruption = { reason: 'quit', at: Date.now() }
    working(child)
    handleOf(child).event({ type: 'limit_reached', sessionId: child })
    await w.until(() => stopNotices(asker).length === 1)
    expect(wakesMessage(stopNotices(asker)[0]!.message)).toBe(false)
  })
})

describe('a stop found at the next start, or a cut turn that could not be continued', () => {
  it.each(['quit', 'shutdown'] as const)('%s: the senders are told at the start, quietly, and a second start tells no one again', async (reason) => {
    const { asker, child, question } = await asked()
    // The last host ended in the middle of the child's turn: the start found it cut and marked it
    inside().meta.get(child)!.interruption = { reason, at: Date.now() }

    m.afterReady()
    const message = stopNotices(asker)[0]!.message
    expect(message.facts).toMatchObject({ quiet: true, unanswered: [{ id: question.id, recipient: addr(child), why: reason }] })
    expect(wakesMessage(message)).toBe(false)
    expect(message.body).toContain(reason === 'quit' ? 'Centralu quit while' : 'the computer shut down, restarted or signed out')
    expect(read.row(question.id, addr(child))).toMatchObject({ releasedWhy: reason, settled: null })

    m.afterReady()
    expect(stopNotices(asker)).toHaveLength(1)
    m.delivery.stop()
  })

  it('only a session marked cut is told of at the start', async () => {
    const unmarked = await asked()
    const cut = await asked()
    inside().meta.get(cut.child)!.interruption = { reason: 'quit', at: Date.now() }
    m.afterReady()
    expect(stopNotices(cut.asker)).toHaveLength(1)
    expect(stopNotices(unmarked.asker)).toEqual([])
    m.delivery.stop()
  })

  it('a cut turn Centralu could not continue is told as a stop that wakes its asker', async () => {
    const { asker, child, question } = await asked()
    inside().turnLostInSwap(inside().meta.get(child))
    await w.until(() => stopNotices(asker).length === 1)
    const message = stopNotices(asker)[0]!.message
    expect(message.facts.unanswered).toEqual([{ id: question.id, recipient: addr(child), why: 'uncontinued' }])
    expect(message.body).toContain('Centralu could not continue')
    expect(wakesMessage(message)).toBe(true)
  })
})
