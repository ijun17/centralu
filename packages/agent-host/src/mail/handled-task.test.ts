/**
 * A task its receiver marks handled (#2493): `mail handled` on a task says the turn it runs in does it, so that turn's report answers it and it is
 * never given again (`MailDelivery.claim`). Without it, a task that joined a running turn is given again at rest (#2369), and one given again joins
 * no other turn, so each costs one turn more, never two.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { at, hostWorld } from './host-mail.test-helpers.js'

const A = at('a')
const B = at('b')
const C = at('c')
const inTurn = { kind: 'ready', live: true, quiet: false, joins: true } as const
let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})
const started = () => {
  const w = hostWorld()
  w.afterReady()
  stops.push(w.stop)
  return w
}
type World = ReturnType<typeof started>
const handled = async (w: World, id: string) => (await w.tool.call('b', { action: 'handled', thread: id })).text
/** The turn ends as turns do, at rest: the tool took what it was given, and the session's last response answers its open tasks */
function endAtRest(w: World) {
  w.delivery.turnInputs(B, { took: w.to('b').map((d) => d.input.id).filter((id): id is string => !!id), finished: true })
  w.endTurn('b')
  w.states.set('b', { kind: 'ready', live: true, quiet: false })
  return w.mail.lastResponse(B, { body: () => 'The session ended its turn.', released: false, answers: () => true })
}

describe('a task marked handled by its receiver (#2493)', () => {
  it('T0 starts a turn, A and B join it and are marked handled there: its end answers all three in one report, and nothing is given again', async () => {
    const w = started()
    const t0 = w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const a = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    const b = w.mail.task(A, B, { text: 'and the standing rule', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    // The notice that gives each into the running turn says how its report can answer it
    const joined = w.to('b').slice(1).map((d) => d.input.text).join('\n')
    expect(joined).toContain(`${a.id} joined your running turn: if this turn does it,`)
    expect(joined).toContain("lets this turn's report answer it.")
    expect(await handled(w, a.id)).toBe(`${a.id} is answered by this turn's report, and is not given again.`)
    expect(await handled(w, b.id)).toBe(`${b.id} is answered by this turn's report, and is not given again.`)
    const given = w.to('b').length
    endAtRest(w)
    for (const id of [t0.id, a.id, b.id]) expect(w.row(id, B)).toMatchObject({ settled: 'reported', givenAgainAt: null })
    expect(new Set([t0.id, a.id, b.id].map((id) => w.store.mailbox.reportsOn(id)[0]?.id)).size).toBe(1)
    await w.advance(60_000)
    expect(w.to('b')).toHaveLength(given)
  })

  it('keeps a claim made while the delivery that gives the task into the turn waits for the tool to take it (#2497)', async () => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    // The tool takes a folded input late: Claude Code names it in the turn's result, the host counts it taken after 90 s at most
    let take = () => {}
    w.behaviour.hold = new Promise<void>((r) => (take = r))
    const a = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    expect(w.to('b').at(-1)?.input.text).toContain(a.id)
    expect(await handled(w, a.id)).toContain('is answered by this turn')
    w.behaviour.hold = null
    take()
    await w.advance(0)
    endAtRest(w)
    expect(w.row(a.id, B)).toMatchObject({ settled: 'reported', givenAgainAt: null })
  })

  it.each([
    ['its result, without the input', { took: [], finished: true }],
    ['a stop', { took: [], finished: false }],
    ['an error that took the process', { took: undefined, finished: false }],
  ] as const)('forgets a claim when its turn ends by %s: the input the tool takes after joins the next turn unclaimed (#2497)', async (_, ending) => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    let take = () => {}
    w.behaviour.hold = new Promise<void>((r) => (take = r))
    const a = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    expect(await handled(w, a.id)).toContain('is answered by this turn')
    w.delivery.turnInputs(B, ending)
    w.endTurn('b')
    // The tool takes the input into the turn after, which ends having done it: a task that joined it, given again at rest as any (#2369)
    w.turns.beginOther('b', 'person', null)
    w.behaviour.hold = null
    take()
    await w.advance(0)
    endAtRest(w)
    expect(w.row(a.id, B)).toMatchObject({ settled: null, givenAgainAt: expect.any(Number) })
  })

  it('answers the heir once when the giver hands over a task claimed while its delivery waited for the tool (#2497)', async () => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    let take = () => {}
    w.behaviour.hold = new Promise<void>((r) => (take = r))
    const a = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    expect(await handled(w, a.id)).toContain('is answered by this turn')
    w.mail.handOver(A, C, 'all', [B])
    const again = w.store.mailbox.watchedTo(B).find((r) => w.store.mailbox.message(r.messageId)?.sender === C)?.messageId ?? ''
    w.behaviour.hold = null
    take()
    await w.advance(0)
    const given = w.to('b').length
    endAtRest(w)
    expect(w.row(again, B)).toMatchObject({ settled: 'reported', givenAgainAt: null })
    expect(w.store.mailbox.recipients(w.store.mailbox.reportsOn(again)[0]?.id ?? '').map((r) => r.recipient)).toEqual([C])
    expect(w.row(a.id, B)).toMatchObject({ settled: 'withdrawn', givenAgainAt: null })
    await w.advance(60_000)
    expect(w.to('b')).toHaveLength(given)
  })

  it('takes a task given again and waiting into the turn that marks it handled, and refuses with no turn running', async () => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const a = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    endAtRest(w)
    expect(w.row(a.id, B)).toMatchObject({ deliveredAt: null, givenAgainAt: expect.any(Number) })
    // No turn runs: nothing can answer it now
    expect(await handled(w, a.id)).toBe(`Task ${a.id} is answered by the report of the turn it runs in, not marked handled: it is not in this turn.`)
    // The person's turn, before the task's own: marked handled there, it is delivered into it and that turn's report answers it
    w.turns.beginOther('b', 'person', null)
    expect(await handled(w, a.id)).toContain('is answered by this turn')
    expect(w.row(a.id, B)).toMatchObject({ deliveredAt: expect.any(Number), givenAgainAt: null })
    endAtRest(w)
    expect(w.row(a.id, B)?.settled).toBe('reported')
  })

  it('claims nothing that is not open in a turn: a task answered already, one held for the person, or one its tool holds queued for a turn after', async () => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const queued = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    // The turn ends without taking it: the tool holds it for a turn after, which answers it
    w.delivery.turnInputs(B, { took: [], finished: true })
    w.endTurn('b')
    w.turns.beginOther('b', 'person', null)
    const refusal = (id: string) => `Task ${id} is answered by the report of the turn it runs in, not marked handled: it is not in this turn.`
    expect(await handled(w, queued.id)).toBe(refusal(queued.id))
    const held = w.mail.task(A, B, { text: 'and the docs', origin: 'agent_session', delivered: false })
    w.store.mailbox.hold(B, [held.id], 'policy')
    expect(await handled(w, held.id)).toBe(refusal(held.id))
    expect(w.row(held.id, B)?.deliveredAt).toBeNull()
    const done = w.mail.task(A, B, { text: 'and the tests', origin: 'agent_session', delivered: true })
    w.store.mailbox.settle(done.id, B, 'reported', w.clock.t)
    expect(await handled(w, done.id)).toBe('Nothing was waiting to be marked handled.')
  })

  it("reports a task its giver handed over after the child marked it handled to the heir, at the child's turn end", async () => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const a = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    expect(await handled(w, a.id)).toContain('is answered by this turn')
    w.mail.handOver(A, C, 'all', [B])
    // The task goes again from the heir with the same delivery (#1936): the child's turn end answers it to the heir, and the giver that left hears nothing
    const again = w.store.mailbox.watchedTo(B).find((r) => w.store.mailbox.message(r.messageId)?.sender === C)
    expect(again).toBeDefined()
    expect(w.row(a.id, B)?.settled).toBe('withdrawn')
    endAtRest(w)
    const [report] = w.store.mailbox.reportsOn(again?.messageId ?? '')
    expect(w.store.mailbox.recipients(report?.id ?? '').map((r) => r.recipient)).toEqual([C])
    expect(w.store.mailbox.reportsOn(a.id)).toEqual([])
  })
})

describe('the delivery of a claimed task and of a note to a started child (#2493)', () => {
  it('leaves a claimed task its turn did not take queued for the turn after, which answers it', async () => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const a = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    expect(await handled(w, a.id)).toContain('is answered by this turn')
    // The tool did not fold it in: it waits there for a turn after, and this turn's end does not answer it
    w.delivery.turnInputs(B, { took: [], finished: true })
    w.endTurn('b')
    w.mail.lastResponse(B, { body: () => 'The session ended its turn.', released: false, answers: () => true, queued: w.delivery.queuedFor(B) })
    expect(w.row(a.id, B)?.settled).toBeNull()
    expect(w.delivery.queuedFor(B).has(a.id)).toBe(true)
  })

  it('gives a task that wakes a session no line about joining a running turn, and a quiet note no wake of its own', async () => {
    const w = started()
    const t = w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    const wake = w.to('b')[0]?.input.text ?? ''
    expect(wake).toContain(t.id)
    expect(wake).not.toContain('joined your running turn')
    endAtRest(w)
    const given = w.to('b').length
    const note = w.mail.task(A, B, { text: 'fyi: rebase before review', origin: 'agent_session', delivered: false, note: true })
    await w.advance(60_000)
    expect(w.to('b')).toHaveLength(given)
    expect(w.row(note.id, B)?.deliveredAt).toBeNull()
    // It rides the next wake, and asks for no report
    w.mail.send(C, { to: [B], text: 'which branch?', needsReply: true })
    await w.advance(60_000)
    expect(w.to('b').at(-1)?.input.text).toContain(note.id)
    expect(w.store.mailbox.watchedTo(B).map((r) => r.messageId)).not.toContain(note.id)
  })
})

describe('what the joined line, a claim and a quiet note take (#2493)', () => {
  it('gives the joined line to a task only, not to a message that joins the same turn', async () => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    w.states.set('b', inTurn)
    const m = w.mail.send(C, { to: [B], text: 'which branch?', needsReply: true }).message
    const t = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    await w.advance(5_000)
    const joined = w.to('b').slice(1).map((d) => d.input.text).join('\n')
    expect(joined).toContain(m.id)
    expect(joined).toContain(`${t.id} joined your running turn`)
    expect(joined).not.toContain(`${m.id} joined your running turn`)
  })

  it('claims a task the person let go of after it was held', async () => {
    const w = started()
    w.mail.task(A, B, { text: 'start on #12', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    const t = w.mail.task(A, B, { text: 'and review #13', origin: 'agent_session', delivered: false })
    w.store.mailbox.hold(B, [t.id], 'released')
    expect(await handled(w, t.id)).toContain('is answered by this turn')
  })

  it("writes quiet only a session's note to one it started: the Assistant's send_to_session note is the person's request, and wakes", () => {
    const w = started()
    expect(w.mail.task(A, B, { text: 'fyi', origin: 'agent_session', delivered: false, note: true }).facts.quiet).toBe(true)
    expect(w.mail.task(A, B, { text: 'fyi', origin: 'send_to_session', delivered: false, note: true }).facts.quiet).toBeUndefined()
    expect(w.mail.task(A, B, { text: 'work', origin: 'agent_session', delivered: false }).facts.quiet).toBeUndefined()
  })
})
