/**
 * Mail into a running turn (docs/plans/mailbox.md §10.6.2, #1948 step 2): a session in a turn its tool takes input into is given its mail there,
 * with no wake and no turn of its own; a task and the Assistant's requests wait for its turn's end; mail at rest still wakes once.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { deliveryWorld, settle } from './delivery.test-helpers.js'
import { A, B, C, ORC } from './messages.test-helpers.js'
import { turnsOf as turnRows } from '../dev-services/store/mailbox-turns.test-helpers.js'

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})
const started = () => {
  const w = deliveryWorld()
  w.delivery.start()
  stop = () => w.delivery.stop()
  return w
}
const inTurn = { kind: 'ready', live: true, quiet: false, joins: true } as const

describe('mail joins a running turn (§10.6.2)', () => {
  it('two senders write into one running turn: both go into it, start no turn, carry its turn number, and each can be answered', async () => {
    const w = started()
    // The turn a first message woke b for
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    expect(turnRows(w.store, 'b')).toHaveLength(1)
    w.states.set('b', inTurn)
    const one = w.send(A, { to: [B], text: 'also check the docs', needsReply: true })
    const two = w.send(C, { to: [B], text: 'which branch are you on?', needsReply: true })
    await w.advance(5_000)
    const joined = w.to('b').slice(1).map((d) => d.input)
    expect(joined.length).toBeGreaterThan(0)
    for (const input of joined) expect(input).toMatchObject({ quiet: false, joins: true })
    const text = joined.map((i) => i.text).join(' ')
    expect(text).toContain(`id="${one.message.id}"`)
    expect(text).toContain(`id="${two.message.id}"`)
    // No turn of its own: the rows name the turn that was running
    expect(turnRows(w.store, 'b')).toHaveLength(1)
    expect(w.rowOf(one.message.id, B)).toMatchObject({ deliveredAt: expect.any(Number), turnSeq: 1 })
    expect(w.rowOf(two.message.id, B)).toMatchObject({ deliveredAt: expect.any(Number), turnSeq: 1 })
    w.send(B, { to: [], replyTo: one.message.id, text: 'checked' })
    w.send(B, { to: [], replyTo: two.message.id, text: 'main' })
    expect(w.rowOf(one.message.id, B).settled).toBe('answered')
    expect(w.rowOf(two.message.id, B).settled).toBe('answered')
  })

  it('a join waits for no wake gap: it goes as soon as it is due, a second wake within 30 s would not', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'first' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    w.send(A, { to: [B], text: 'second' })
    await w.advance(2_000)
    expect(w.to('b')).toHaveLength(2)
  })

  it("a task joins no turn: it waits for the turn's end and wakes one of its own, one task to a wake (D17); a message due with it joins", async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const one = w.mail.task(A, B, { text: 'first', origin: 'agent_session', delivered: false })
    const two = w.mail.task(C, B, { text: 'second', origin: 'ask_project', delivered: false })
    const note = w.send(C, { to: [B], text: 'fyi: main is green' })
    await w.advance(5_000)
    expect(w.to('b')).toHaveLength(2)
    const joined = w.to('b')[1]!.input
    expect(joined).toMatchObject({ joins: true })
    expect(joined.reportTo).toBeUndefined()
    expect(joined.text).toContain(`id="${note.message.id}"`)
    expect(joined.text).not.toContain(one.id)
    expect(joined.text).not.toContain(two.id)
    expect([one, two].map((t) => w.rowOf(t.id, B).deliveredAt)).toEqual([null, null])
    // The turn ends: each task wakes a turn of its own, whose end is reported to its sender
    w.states.set('b', { kind: 'ready', live: true, quiet: false })
    w.delivery.poke('b')
    await w.advance(31_000)
    await w.advance(31_000)
    const wakes = w.to('b').slice(2).map((d) => d.input)
    expect(wakes).toHaveLength(2)
    for (const input of wakes) expect(input.joins).toBeUndefined()
    expect(wakes.map((i) => [i.text.includes(one.id), i.text.includes(two.id), i.reportTo])).toEqual([
      [true, false, 'a'],
      [false, true, 'c'],
    ])
    expect(turnRows(w.store, 'b')).toHaveLength(3)
    expect([one, two].map((t) => w.rowOf(t.id, B).turnSeq)).toEqual([2, 3])
  })

  it("a request to the Assistant waits for its turn's end and opens a turn of its own; its other mail joins", async () => {
    const w = started()
    const asked = w.send(ORC, { to: [A], text: 'which file?', needsReply: true })
    w.states.set('orc', inTurn)
    const request = w.send(B, { to: [ORC], text: 'please merge my branch' })
    const answer = w.send(A, { to: [], replyTo: asked.message.id, text: 'src/a.ts' })
    await w.advance(2_000)
    expect(w.to('orc')).toHaveLength(1)
    expect(w.to('orc')[0]!.input.text).toContain(`id="${answer.message.id}"`)
    expect(w.to('orc')[0]!.input.text).not.toContain(request.message.id)
    expect(w.rowOf(request.message.id, ORC).deliveredAt).toBeNull()
    // Its turn ends: the request wakes it, as a turn of its own
    w.states.set('orc', { kind: 'ready', live: true, quiet: true })
    w.delivery.poke('orc')
    await w.advance(31_000)
    expect(w.to('orc')).toHaveLength(2)
    expect(w.to('orc')[1]!.input).toMatchObject({ quiet: false })
    expect(w.to('orc')[1]!.input.joins).toBeUndefined()
    expect(w.to('orc')[1]!.input.text).toContain(`id="${request.message.id}"`)
  })

  it("a delegation tool's task held for the turn's end goes as soon as that turn ends, with no 30 s wake gap; other mail keeps the gap", async () => {
    const w = started()
    // A mail wake starts b's turn
    w.send(A, { to: [B], text: 'start on #12', needsReply: true })
    await w.advance(2_000)
    expect(w.to('b')).toHaveLength(1)
    w.states.set('b', inTurn)
    const task = w.mail.task(C, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    const question = w.send(C, { to: [B], text: 'which branch?', needsReply: true })
    await w.advance(3_000)
    // The question joined the turn; the task waits for its end
    expect(w.to('b')).toHaveLength(2)
    expect(w.to('b')[1]!.input.text).toContain(`id="${question.message.id}"`)
    // The turn ends 5 s after the wake: the task goes now, not 30 s after the wake
    w.endTurn('b')
    w.states.set('b', { kind: 'ready', live: true, quiet: false })
    w.delivery.poke('b')
    await w.advance(3_000)
    expect(w.to('b')).toHaveLength(3)
    expect(w.to('b')[2]!.input.text).toContain(`id="${task.id}"`)
    // A message that wakes still waits out the gap after that wake
    w.states.set('b', { kind: 'ready', live: true, quiet: false })
    const later = w.send(A, { to: [B], text: 'and one more thing', needsReply: true })
    await w.advance(3_000)
    expect(w.to('b')).toHaveLength(3)
    await w.advance(30_000)
    expect(w.to('b').at(-1)!.input.text).toContain(`id="${later.message.id}"`)
  })

  it('at rest, mail from two senders wakes the session once', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'one', needsReply: true })
    w.send(C, { to: [B], text: 'two', needsReply: true })
    await w.advance(2_000)
    await settle()
    expect(w.to('b')).toHaveLength(1)
    expect(w.to('b')[0]!.input.joins).toBeUndefined()
    expect(turnRows(w.store, 'b')).toHaveLength(1)
  })
})
