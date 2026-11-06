/**
 * The asked gate's asker, read from the request rows of the orchestrator's open turn (docs/plans/turn-owned-by-no-one.md §4.2, C11), over the
 * host's wiring: each row of §4.2's table, "It is not weaker", and the fail-closed invariant when a turn ever holds two askers' requests.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { at, hostWorld } from './host-mail.test-helpers.js'

const A = at('a')
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
/** The orchestrator in the turn `a`'s request opened */
async function requestTurn(w = started()) {
  const request = w.mail.send(A, { to: [ORC], text: 'please check CI', needsReply: true }).message
  await w.advance(2_000)
  expect(w.to('orc')).toHaveLength(1)
  return { w, request, seq: w.turns.current('orc')!.turnSeq }
}
const askerOf = (w: ReturnType<typeof hostWorld>) => w.hooks.askedBy!('orc')

describe('the asker is read from the turn’s request rows (§4.2)', () => {
  it('a request opens the turn: gated, asker the sender, its request the oldest of the turn', async () => {
    const { w, request, seq } = await requestTurn()
    expect(askerOf(w)).toEqual({ messageId: request.id, sessionId: 'a', turn: seq, name: 'alpha', project: 'p1', trusted: true, cites: null })
    expect(w.turns.current('orc')?.asker).toBe(A)
  })

  it('the person writing into the request turn, and the request answered mid-turn, leave it gated: settled rows count', async () => {
    const { w, request } = await requestTurn()
    w.turns.beginOther('orc', 'person', null)
    expect(askerOf(w)?.sessionId).toBe('a')
    w.clock.t += 10
    w.mail.send(ORC, { to: [], replyTo: request.id, text: 'CI is green' })
    expect(w.row(request.id, ORC)?.settled).toBe('answered')
    expect(askerOf(w)?.sessionId).toBe('a')
  })

  it('a request during the person’s own turn, and another asker’s during a request turn, wait for the turn’s end', async () => {
    const w = started()
    w.states.set('orc', { kind: 'busy', why: 'turn' })
    w.turns.beginOther('orc', 'person', null)
    const early = w.mail.send(A, { to: [ORC], text: 'mine first' }).message
    await w.advance(2_000)
    expect(w.row(early.id, ORC)?.deliveredAt).toBeNull()
    expect(askerOf(w)).toBeNull()
    w.states.set('orc', { kind: 'ready', live: true, quiet: true })
    w.endTurn('orc')
    w.delivery.poke('orc')
    await w.advance(2_000)
    expect(askerOf(w)?.messageId).toBe(early.id)
    // C's request while A's turn runs: one asker per wake, so it is not given into this turn
    w.states.set('orc', { kind: 'busy', why: 'turn' })
    const later = w.mail.send(C, { to: [ORC], text: 'and mine' }).message
    await w.advance(2_000)
    expect(w.row(later.id, ORC)?.turnSeq).toBeNull()
    expect(askerOf(w)).toMatchObject({ sessionId: 'a' })
    expect(askerOf(w)?.also).toBeUndefined()
  })

  it('a second asker’s request that ever joined the turn fails closed: both are named', async () => {
    const { w, seq } = await requestTurn()
    w.clock.t += 10
    const joined = w.mail.send(C, { to: [ORC], text: 'joined' }).message
    w.store.mailbox.markDelivered(ORC, [joined.id], w.clock.t, seq)
    expect(askerOf(w)).toMatchObject({ sessionId: 'a', also: [{ sessionId: 'c', name: 'gamma', project: 'p2', trusted: true }] })
  })

  it('a host that takes the turn up after a restart or a swap reads the asker from the same rows: nothing of it was in memory', async () => {
    const { w, request, seq } = await requestTurn()
    w.stop()
    const next = started(hostWorld({ store: w.store, clock: w.clock, kept: new Set(['orc']) }))
    expect(askerOf(next)).toMatchObject({ messageId: request.id, sessionId: 'a', turn: seq })
  })

  it('a reminder for an asker (`facts.asker`) given into the turn makes it that asker’s', async () => {
    const w = started()
    w.service.notice(ORC, { body: 'A reminder of a request.', facts: { asker: A }, dedupeKey: 'reminder:test' })
    await w.advance(2_000)
    expect(w.to('orc')).toHaveLength(1)
    expect(askerOf(w)).toMatchObject({ sessionId: 'a' })
  })

  it('a request held from the orchestrator is never in a turn: held for trust, or told of quietly and held', async () => {
    const w = started()
    const held = w.mail.send(X, { to: [ORC], text: 'from px' }).message
    await w.advance(2_000)
    expect(w.row(held.id, ORC)?.held).toBe('policy')
    expect(askerOf(w)).toBeNull()
    // Told of into the person's turn and held (a spent budget): it did not join the turn, and its words are not shown there
    w.turns.beginOther('orc', 'person', null)
    const quiet = w.mail.send(C, { to: [ORC], text: 'quietly' }).message
    w.store.mailbox.markDelivered(ORC, [quiet.id], w.clock.t, w.turns.current('orc')!.turnSeq)
    w.store.mailbox.hold(ORC, [quiet.id], 'budget')
    expect(askerOf(w)).toBeNull()
    expect(w.tool.run('orc', { action: 'read', thread: quiet.id }).text).not.toContain('quietly')
  })

  it('the turn after the request turn has no asker: the CLI going on after its background work is its own turn', async () => {
    const { w } = await requestTurn()
    w.endTurn('orc')
    w.turns.beginOther('orc', 'cli', null)
    expect(askerOf(w)).toBeNull()
  })

  it('a request’s words are shown only in the turn it was given in, not in a later turn of the same asker', async () => {
    const { w, request } = await requestTurn()
    expect(w.tool.run('orc', { action: 'read', thread: request.id }).text).toContain('> please check CI')
    w.endTurn('orc')
    const second = w.mail.send(A, { to: [ORC], text: 'one more thing', needsReply: true }).message
    // Past the 30 s between wakes
    await w.advance(31_000)
    expect(askerOf(w)?.messageId).toBe(second.id)
    expect(w.tool.run('orc', { action: 'read', thread: second.id }).text).toContain('> one more thing')
    const earlier = w.tool.run('orc', { action: 'read', thread: request.id }).text
    expect(earlier).toContain('its words are shown in the turn it starts')
    expect(earlier).not.toContain('please check CI')
  })
})
