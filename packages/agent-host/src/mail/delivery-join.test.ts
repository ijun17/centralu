/**
 * Mail into a running turn (docs/plans/mailbox.md §10.6.2, §10.6.3): a session in a turn its tool takes input into is given its mail there, tasks
 * included, with no wake and no turn of its own; the Assistant's requests wait for its turn's end; mail at rest still wakes once.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { answerRecorder } from './delegation.js'
import { deliveryWorld, settle } from './delivery.test-helpers.js'
import { hostWorld } from './host-mail.test-helpers.js'
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

  it('a task the running turn took in is given again at rest, saying it came during that turn; a note it took stays delivered (#2369)', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const task = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    const note = w.send(C, { to: [B], text: 'fyi: main is green' })
    await w.advance(5_000)
    const inputs = w.to('b').slice(1).map((d) => d.input.id!)
    // The turn took both in and ended: its end answers neither task given in it
    w.delivery.turnInputs(B, { took: inputs, finished: true })
    w.endTurn('b')
    expect(w.rowOf(task.id, B)).toMatchObject({ deliveredAt: null, readAt: null, turnSeq: null })
    expect(w.rowOf(note.message.id, B).deliveredAt).toEqual(expect.any(Number))
    // At rest (the host pokes the mailbox), it wakes the session again, marked as given again
    w.states.set('b', { kind: 'ready', live: true, quiet: false })
    w.delivery.poke('b')
    await w.advance(31_000)
    const again = w.to('b').at(-1)!.input
    expect(again.joins).toBeUndefined()
    expect(again.text).toContain(`id="${task.id}"`)
    expect(again.text).toContain('givenAgain="1"')
    expect(again.text).toContain(`${task.id} came while your last turn ran, so it is given again (givenAgain="1"). If that turn already did it, say so in one line.`)
    expect(w.rowOf(task.id, B).deliveredAt).toEqual(expect.any(Number))
  })

  it('a task given again and handed over is not given again to its heir, which ran no turn with it (#2369)', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const task = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    w.delivery.turnInputs(B, { took: w.to('b').slice(1).map((d) => d.input.id!), finished: true })
    w.endTurn('b')
    expect(w.rowOf(task.id, B).givenAgainAt).toEqual(expect.any(Number))
    w.mail.handOver(B, C, 'all')
    expect(w.rowOf(task.id, C)).toMatchObject({ deliveredAt: null, givenAgainAt: null })
    w.states.set('c', { kind: 'ready', live: true, quiet: false })
    w.delivery.poke('c')
    await w.advance(31_000)
    const frame = w.to('c').at(-1)!.input.text
    expect(frame).toContain(`id="${task.id}"`)
    expect(frame).not.toContain('givenAgain')
  })

  it('a task the running turn took in stays with it when that turn is stopped or cut, and is not given again (#2369)', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const task = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    w.delivery.turnInputs(B, { took: w.to('b').slice(1).map((d) => d.input.id!), finished: false })
    expect(w.rowOf(task.id, B)).toMatchObject({ deliveredAt: expect.any(Number), turnSeq: 1 })
    // The control: a task the next turn takes in, which ends as a turn does, is given again
    w.endTurn('b')
    w.states.set('b', inTurn)
    const next = w.mail.task(A, B, { text: 'and #14', origin: 'agent_session', delivered: false })
    await w.advance(31_000)
    w.delivery.turnInputs(B, { took: w.to('b').map((d) => d.input.id).filter((id): id is string => !!id), finished: true })
    expect(w.rowOf(next.id, B)).toMatchObject({ deliveredAt: null, turnSeq: null })
    expect(w.rowOf(task.id, B).deliveredAt).toEqual(expect.any(Number))
  })

  it('a call that waited on a task the turn only joined does not answer it: no report, and the task goes again for a turn of its own (#2369)', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const task = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    w.delivery.turnInputs(B, { took: w.to('b').slice(1).map((d) => d.input.id!), finished: true })
    w.endTurn('b')
    // The call that waited reads the turn's end; the mailbox says that answer is not the task's
    expect(answerRecorder(w.mail, w.store.mailbox)('a', 'b', { ok: true, text: 'done with #12' })).toBe(false)
    expect(w.rowOf(task.id, B)).toMatchObject({ deliveredAt: null, readAt: null, settled: null })
    w.states.set('b', { kind: 'ready', live: true, quiet: false })
    w.delivery.poke('b')
    await w.advance(31_000)
    expect(w.to('b').at(-1)!.input.text).toContain(`id="${task.id}"`)
    // The turn the task started answers it, as any turn does
    expect(answerRecorder(w.mail, w.store.mailbox)('a', 'b', { ok: true, text: 'reviewed #13' })).toBe(true)
    expect(w.rowOf(task.id, B).settled).toBe('reported')
  })

  it('a call reads a task given again as working whatever else the turn left: no answer (its own background work runs) or work handed on (#2369)', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const task = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    w.delivery.turnInputs(B, { took: w.to('b').slice(1).map((d) => d.input.id!), finished: true })
    w.endTurn('b')
    const answered = answerRecorder(w.mail, w.store.mailbox)
    // The turn left its own background work running: the call passes no answer
    expect(answered('a', 'b', undefined, task.id)).toBe(false)
    // Work handed on in the task's name is open
    w.turns.beginOther('b', 'caller', task.id, 'a')
    expect(w.mail.task(B, C, { text: 'write the tests for #13', origin: 'start_agent', delivered: true }).causeId).toBe(task.id)
    expect(answered('a', 'b', { ok: true, text: 'handed the tests on' }, task.id)).toBe(false)
    expect(w.store.mailbox.reportsOn(task.id)).toEqual([])
    // A failed try while it waits keeps the mark: its next frame still says it was given again
    w.store.mailbox.failedTry(B, [task.id], 'the tool refused', w.clock.t)
    expect(w.rowOf(task.id, B)).toMatchObject({ lastError: 'the tool refused', givenAgainAt: expect.any(Number) })
  })

  it('a task that started the turn is answered by the call that waited on it, while the one that joined that turn is given again (#2369)', async () => {
    const w = started()
    const first = w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const joined = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    w.delivery.turnInputs(B, { took: w.to('b').map((d) => d.input.id).filter((id): id is string => !!id), finished: true })
    w.endTurn('b')
    expect(w.rowOf(first.id, B).deliveredAt).toEqual(expect.any(Number))
    expect(w.rowOf(joined.id, B).givenAgainAt).toEqual(expect.any(Number))
    const answered = answerRecorder(w.mail, w.store.mailbox)
    // The call that gave the first task reads the turn's end as its answer, though the caller's newest task is the one given again
    expect(answered('a', 'b', { ok: true, text: '#12 done' }, first.id)).toBe(true)
    expect(w.rowOf(first.id, B).settled).toBe('reported')
    expect(answered('a', 'b', { ok: true, text: '#12 done' }, joined.id)).toBe(false)
    expect(w.rowOf(joined.id, B).settled).toBeNull()
  })

  it('a task given again does not join another running turn, which would give it again once more, and waits for a turn of its own (#2369, #2493)', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const task = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    w.delivery.turnInputs(B, { took: w.to('b').slice(1).map((d) => d.input.id!), finished: true })
    w.endTurn('b')
    // Before it is at rest, the person starts another turn: the task does not go into that one
    w.turns.beginOther('b', 'person', null)
    w.states.set('b', inTurn)
    const before = w.to('b').length
    w.delivery.poke('b')
    await w.advance(5_000)
    expect(w.to('b')).toHaveLength(before)
    expect(w.rowOf(task.id, B)).toMatchObject({ deliveredAt: null, givenAgainAt: expect.any(Number) })
    w.delivery.turnInputs(B, { took: [], finished: true })
    w.endTurn('b')
    const answered = answerRecorder(w.mail, w.store.mailbox)
    expect(answered('a', 'b', { ok: true, text: 'changelog done' }, task.id)).toBe(false)
    // At rest it wakes the session for a turn of its own, whose end answers it
    w.states.set('b', { kind: 'ready', live: true, quiet: false })
    w.delivery.poke('b')
    await w.advance(31_000)
    const own = w.to('b').at(-1)!.input
    expect(own.joins).toBeUndefined()
    expect(own.text).toContain('givenAgain="1"')
    expect(answered('a', 'b', { ok: true, text: 'reviewed #13' }, task.id)).toBe(true)
    expect(w.rowOf(task.id, B).settled).toBe('reported')
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
    w.delivery.turnInputs(B, { took: [], finished: true })
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

/** Holds the next delivery until the call it returns, as Claude Code takes an input it did not fold into the turn only as that input's own turn opens */
function holdDelivery(w: ReturnType<typeof started>): () => void {
  let take = () => {}
  const hold = new Promise<void>((r) => (take = r))
  w.behaviour.hold = hold
  return () => {
    if (w.behaviour.hold === hold) w.behaviour.hold = null
    take()
  }
}

describe('an input given into a turn that ends without it (#2499)', () => {
  const atRest = { kind: 'ready', live: true, quiet: false } as const
  const lastResponse = (w: ReturnType<typeof started>) => w.mail.lastResponse(B, { body: () => 'Done.', released: false, answers: () => true, queued: w.delivery.queuedFor(B) })

  it.each([
    ['given once', false],
    ['given again after a delivery that failed', true],
  ])('%s, and taken only as its own turn opens, after a turn the tool ran on its own: that turn answers it, and it is not given again', async (_, failedFirst) => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    if (failedFirst) w.behaviour.fail = new Error('the tool refused it')
    let take = holdDelivery(w)
    const task = w.mail.task(A, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    if (failedFirst) {
      // The first try fails before the tool took it: nothing of it is left in the turn, and the try after goes into it again
      take()
      await w.advance(0)
      w.behaviour.fail = null
      take = holdDelivery(w)
      await w.advance(5_000)
      expect(w.to('b').filter((d) => d.input.text.includes(task.id))).toHaveLength(2)
    }
    const input = w.to('b').at(-1)!.input.id!
    // The turn ends naming only what it began with: the tool holds the input queued, and has not said it took it
    w.delivery.turnInputs(B, { took: [], finished: true })
    w.endTurn('b')
    w.states.set('b', atRest)
    lastResponse(w)
    expect(w.rowOf(task.id, B)).toMatchObject({ settled: null, deliveredAt: null, givenAgainAt: null })
    expect([...w.delivery.queuedFor(B)]).toEqual([task.id])
    // A turn the tool runs on its own (#2318) names none of it
    w.turns.beginOther('b', 'cli', null)
    w.delivery.turnInputs(B, { took: [], finished: false })
    w.endTurn('b')
    // The input's own turn: its opening names it, and the tool says it took it as that turn opens
    w.turns.beginOther('b', 'cli', null)
    w.delivery.turnInputs(B, { opened: [input] })
    take()
    await w.advance(0)
    expect(w.turns.current('b')).toMatchObject({ by: 'mail', starter: task.id })
    w.delivery.turnInputs(B, { took: [input], finished: true })
    w.endTurn('b')
    lastResponse(w)
    expect(w.rowOf(task.id, B)).toMatchObject({ settled: 'reported', givenAgainAt: null })
  })

  it("one the turn folded in, named in its result before the tool says it took it, is that turn's: given again at rest (#2369)", async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const take = holdDelivery(w)
    const task = w.mail.task(A, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    const input = w.to('b').at(-1)!.input.id!
    // Claude Code's result names the folded input; the host handles that end before the tool's word that it took it
    w.delivery.turnInputs(B, { took: [input], finished: true })
    w.endTurn('b')
    w.states.set('b', atRest)
    take()
    await w.advance(0)
    lastResponse(w)
    expect(w.rowOf(task.id, B)).toMatchObject({ settled: null, deliveredAt: null, givenAgainAt: expect.any(Number) })
    await w.advance(60_000)
    expect(w.to('b').filter((d) => d.input.text.includes(task.id))).toHaveLength(2)
  })

  it('one whose delivery fails after the turn ended without it leaves nothing queued: the wake that tries it again answers it', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const take = holdDelivery(w)
    const task = w.mail.task(A, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    w.delivery.turnInputs(B, { took: [], finished: true })
    w.endTurn('b')
    w.states.set('b', atRest)
    expect([...w.delivery.queuedFor(B)]).toEqual([task.id])
    w.behaviour.fail = new Error('the tool refused it')
    take()
    await w.advance(0)
    expect([...w.delivery.queuedFor(B)]).toEqual([])
    w.behaviour.fail = null
    await w.advance(60_000)
    expect(w.to('b').filter((d) => d.input.text.includes(task.id))).toHaveLength(2)
    w.endTurn('b')
    lastResponse(w)
    expect(w.rowOf(task.id, B)).toMatchObject({ settled: 'reported', givenAgainAt: null })
  })

  it('one the tool fails after it was counted taken leaves nothing queued to hide its task from a later turn: it is held for the person', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'start on #12' })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const task = w.mail.task(A, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    // Counted taken, then failed by the tool: it never ran it
    w.lates.at(-1)?.(new Error('the process closed with the input still queued'))
    w.delivery.turnInputs(B, { took: [], finished: true })
    w.endTurn('b')
    w.states.set('b', atRest)
    expect([...w.delivery.queuedFor(B)]).toEqual([])
    expect(w.rowOf(task.id, B)).toMatchObject({ held: 'uncertain', deliveredAt: null })
  })

  it.each([
    ['before the tool took it: held for the person, who sends it again or dismisses it', false],
    ['after the tool took it: answered by the turn it joined, as its rows say', true],
  ])("a host that restarts between the hand-off and the turn's end leaves the task neither lost nor given twice, %s", async (_, takenFirst) => {
    const first = hostWorld({ kept: new Set(['b']) })
    first.afterReady()
    stop = first.stop
    first.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await first.advance(2_000)
    first.states.set('b', inTurn)
    if (!takenFirst) first.behaviour.hold = new Promise<void>(() => {})
    const task = first.mail.task(A, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    await first.advance(5_000)
    const input = first.to('b').at(-1)!.input.id!
    first.stop()
    // What the host held in memory of the turn is gone; the rows say what was tried and what was taken
    const next = hostWorld({ store: first.store, clock: first.clock, kept: new Set(['b']) })
    next.states.set('b', inTurn)
    next.afterReady()
    stop = next.stop
    await next.advance(5_000)
    next.delivery.turnInputs(B, { took: [input], finished: true })
    next.endTurn('b')
    next.states.set('b', atRest)
    next.mail.lastResponse(B, { body: () => 'Done.', released: false, answers: () => true, queued: next.delivery.queuedFor(B) })
    await next.advance(60_000)
    expect(next.to('b')).toEqual([])
    expect(next.row(task.id, B)).toMatchObject(takenFirst ? { settled: 'reported', givenAgainAt: null } : { held: 'uncertain', settled: null, deliveredAt: null })
  })
})
