/**
 * Mail into a running turn (docs/plans/mailbox.md §10.6.2, §10.6.3): a session in a turn its tool takes input into is given its mail there, tasks
 * included, with no wake and no turn of its own; the Assistant's requests wait for its turn's end; mail at rest still wakes once.
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

  it('tasks from two senders join the running turn with a message due with them: each input named for the tool, no turn of their own (§10.6.3)', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const one = w.mail.task(A, B, { text: 'first', origin: 'agent_session', delivered: false })
    const two = w.mail.task(C, B, { text: 'second', origin: 'ask_project', delivered: false })
    const note = w.send(C, { to: [B], text: 'fyi: main is green' })
    await w.advance(5_000)
    const joined = w.to('b').slice(1).map((d) => d.input)
    expect(joined.length).toBeGreaterThan(0)
    for (const input of joined) expect(input).toMatchObject({ joins: true, id: expect.any(String) })
    expect(new Set(joined.map((i) => i.id)).size).toBe(joined.length)
    const text = joined.map((i) => i.text).join(' ')
    for (const id of [one.id, two.id, note.message.id]) expect(text).toContain(`id="${id}"`)
    expect(turnRows(w.store, 'b')).toHaveLength(1)
    expect([one, two].map((t) => w.rowOf(t.id, B))).toEqual([expect.objectContaining({ deliveredAt: expect.any(Number), turnSeq: 1 }), expect.objectContaining({ deliveredAt: expect.any(Number), turnSeq: 1 })])
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

  it("a delegation tool's task joins the running turn as its own input, and one given at rest goes with no 30 s wake gap; other mail keeps the gap", async () => {
    const w = started()
    // A mail wake starts b's turn
    w.send(A, { to: [B], text: 'start on #12', needsReply: true })
    await w.advance(2_000)
    expect(w.to('b')).toHaveLength(1)
    w.states.set('b', inTurn)
    const task = w.mail.task(C, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    const question = w.send(C, { to: [B], text: 'which branch?', needsReply: true })
    await w.advance(3_000)
    // Both joined the turn (docs/plans/mailbox.md §10.6.3: tasks join a running turn), each under a name of its own the turn's end says it took
    const joined = w.to('b').slice(1)
    expect(joined.map((d) => d.input.joins)).toEqual([true, true])
    expect(joined.map((d) => d.input.text).join(' ')).toContain(`id="${task.id}"`)
    expect(joined.map((d) => d.input.text).join(' ')).toContain(`id="${question.message.id}"`)
    expect(new Set(joined.map((d) => d.input.id)).size).toBe(2)
    // The turn ends 5 s after the wake: a task given now goes at once, as the tool's direct send would, not 30 s after the wake
    w.endTurn('b')
    w.states.set('b', { kind: 'ready', live: true, quiet: false })
    const next = w.mail.task(C, B, { text: 'then the changelog', origin: 'agent_session', delivered: false })
    w.delivery.poke('b')
    await w.advance(3_000)
    expect(w.to('b')).toHaveLength(4)
    expect(w.to('b')[3]!.input.text).toContain(`id="${next.id}"`)
    // A message that wakes still waits out the gap after that wake
    w.states.set('b', { kind: 'ready', live: true, quiet: false })
    const later = w.send(A, { to: [B], text: 'and one more thing', needsReply: true })
    await w.advance(3_000)
    expect(w.to('b')).toHaveLength(4)
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

  it("a turn the tool opens for a task a turn before did not take is that mail's: started by mail, the task its work and starter", async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const task = w.mail.task(A, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    const input = w.to('b').at(-1)!.input.id!
    // The turn ends without taking it: the tool holds it for a turn after
    w.delivery.turnInputs(B, { took: [] })
    w.endTurn('b')
    expect(w.rowOf(task.id, B).turnSeq).toBeNull()
    // The tool opens a turn for it; the session side, which finds no row of its own under that input, records it first as the CLI's own
    w.turns.beginOther('b', 'cli', null)
    w.delivery.turnInputs(B, { opened: [input] })
    expect(turnRows(w.store, 'b').at(-1)).toMatchObject({ turnSeq: 2, startedBy: 'mail', starterId: task.id, messageId: task.id })
    expect(w.rowOf(task.id, B).turnSeq).toBe(2)
    expect(w.turns.current('b')).toMatchObject({ by: 'mail', starter: task.id, messageId: task.id })
  })
})
