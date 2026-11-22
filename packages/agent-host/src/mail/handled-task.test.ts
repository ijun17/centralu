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
