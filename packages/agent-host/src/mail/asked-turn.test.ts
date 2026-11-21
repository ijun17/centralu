/**
 * Whose request the Assistant's open turn is, read from its request rows (docs/plans/turn-owned-by-no-one.md §4.2, C11), over the host's
 * wiring: where a request's words are shown and whom the turn's end reports to both rest on it.
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
/** The Assistant in the turn `a`'s request opened */
async function requestTurn(w = started()) {
  const request = w.mail.send(A, { to: [ORC], text: 'please check CI', needsReply: true }).message
  await w.advance(2_000)
  expect(w.to('orc')).toHaveLength(1)
  return { w, request, seq: w.turns.current('orc')!.turnSeq }
}
const askerOf = (w: ReturnType<typeof hostWorld>) => w.turns.current('orc')?.asker ?? null

describe('the asker is read from the turn’s request rows (§4.2)', () => {
  it('a request opens the turn: its asker the sender', async () => {
    const { w, request, seq } = await requestTurn()
    expect(w.turns.current('orc')).toMatchObject({ asker: A, messageId: request.id, turnSeq: seq })
  })

  it('the person writing into the request turn, and the request answered mid-turn, leave it the asker’s: settled rows count', async () => {
    const { w, request } = await requestTurn()
    w.turns.beginOther('orc', 'person', null)
    expect(askerOf(w)).toBe(A)
    w.clock.t += 10
    w.mail.send(ORC, { to: [], replyTo: request.id, text: 'CI is green' })
    expect(w.row(request.id, ORC)?.settled).toBe('answered')
    expect(askerOf(w)).toBe(A)
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
    expect(w.turns.current('orc')).toMatchObject({ asker: A, messageId: early.id })
    // C's request while A's turn runs: one asker per wake, so it is not given into this turn
    w.states.set('orc', { kind: 'busy', why: 'turn' })
    const later = w.mail.send(C, { to: [ORC], text: 'and mine' }).message
    await w.advance(2_000)
    expect(w.row(later.id, ORC)?.turnSeq).toBeNull()
    expect(askerOf(w)).toBe(A)
  })

  it('a host that takes the turn up after a restart or a swap reads the asker from the same rows: nothing of it was in memory', async () => {
    const { w, seq } = await requestTurn()
    w.stop()
    const next = started(hostWorld({ store: w.store, clock: w.clock, kept: new Set(['orc']) }))
    expect(next.turns.current('orc')).toMatchObject({ asker: A, turnSeq: seq })
  })

  it('a turn whose delivery a dying host left half done stays its request’s: the work message is held uncertain at the next start, and the kept turn is still the asker’s', async () => {
    const { w, request, seq } = await requestTurn()
    w.store.mailbox.undeliver(ORC, [request.id], w.row(request.id, ORC)!.deliveredAt!)
    w.store.mailbox.markUncertain(ORC, [request.id])
    expect(w.row(request.id, ORC)).toMatchObject({ held: 'uncertain', turnSeq: null })
    w.stop()
    const next = started(hostWorld({ store: w.store, clock: w.clock, kept: new Set(['orc']) }))
    expect(next.turns.current('orc')).toMatchObject({ asker: A, turnSeq: seq })
  })

  it('a reminder for an asker (`facts.asker`) given into the turn makes it that asker’s', async () => {
    const w = started()
    w.service.notice(ORC, { body: 'A reminder of a request.', facts: { asker: A }, dedupeKey: 'reminder:test' })
    await w.advance(2_000)
    expect(w.to('orc')).toHaveLength(1)
    expect(askerOf(w)).toBe(A)
  })

  it('a request held from the Assistant is never in a turn: held for trust, or told of quietly and held', async () => {
    const w = started()
    const held = w.mail.send(X, { to: [ORC], text: 'from px' }).message
    await w.advance(2_000)
    expect(w.row(held.id, ORC)?.held).toBe('policy')
    expect(askerOf(w)).toBeNull()
    // Told of into the person's turn and held (a delivery that may not have arrived): it did not join the turn, and its words are not shown there
    w.turns.beginOther('orc', 'person', null)
    const quiet = w.mail.send(C, { to: [ORC], text: 'quietly' }).message
    w.store.mailbox.markDelivered(ORC, [quiet.id], w.clock.t, w.turns.current('orc')!.turnSeq)
    w.store.mailbox.hold(ORC, [quiet.id], 'uncertain')
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
    expect(w.turns.current('orc')).toMatchObject({ asker: A, messageId: second.id })
    expect(w.tool.run('orc', { action: 'read', thread: second.id }).text).toContain('> one more thing')
    const earlier = w.tool.run('orc', { action: 'read', thread: request.id }).text
    expect(earlier).toContain('its words are shown in the turn it starts')
    expect(earlier).not.toContain('please check CI')
  })
})
