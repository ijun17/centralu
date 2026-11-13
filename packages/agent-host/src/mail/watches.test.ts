import { afterEach, describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { NOW, at, hostWorld } from './host-mail.test-helpers.js'
import { HOUR_MS, MINUTE_MS } from './rules.js'

/**
 * Watches the host keeps (#1324, docs/plans/mailbox.md §18): a session asks Centralu to wake it at a time or when another session ends its turn, asks
 * or stops, and the change comes as one notice through the mailbox. Time is a fake clock and the delivery's injected `schedule`; nothing sleeps.
 */

const A = at('a')
const B = at('b')
let worlds: ReturnType<typeof hostWorld>[] = []
afterEach(() => {
  for (const w of worlds) w.stop()
  worlds = []
})
const started = (opts: Parameters<typeof hostWorld>[0] = {}) => {
  const w = hostWorld(opts)
  worlds.push(w)
  w.delivery.start()
  return w
}
const watch = (w: ReturnType<typeof hostWorld>, id: string, to: string, text?: string) => w.tool.run(id, { action: 'watch', to, ...(text ? { text } : {}) })
const idOf = (answer: { text: string }) => /id (\S+)\./.exec(answer.text)?.[1] ?? ''
/** The watch notices `address` was sent, oldest first */
const notices = (w: ReturnType<typeof hostWorld>, address: string) => w.store.mailbox.feedOf(address, { limit: 50 }).filter((m) => m.facts.watch !== undefined).reverse()
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)
const turnEnded = (w: ReturnType<typeof hostWorld>, id: string) => {
  w.turns.beginOther(id, 'person', null)
  w.endTurn(id)
  w.hooks.lastResponse?.(id, { body: () => 'It ended its turn.', relay: () => {}, released: true })
}

describe('a time watch (§18.3)', () => {
  it('`in` fires once at its minute, in the session’s mail with its note inline, and ends', async () => {
    const w = started()
    const answer = watch(w, 'a', 'in 30m', 'check CI')
    expect(answer.text).toBe(`Watching for ${hhmm(NOW + 30 * MINUTE_MS)}: Centralu wakes you then. id ${idOf(answer)}. Cancel with mail(action="close", thread="${idOf(answer)}").`)
    await w.advance(29 * MINUTE_MS)
    expect(notices(w, A)).toEqual([])
    await w.advance(MINUTE_MS + 5_000)
    const [fired, ...more] = notices(w, A)
    expect(more).toEqual([])
    expect(fired?.body).toBe(`Your timer set at ${hhmm(NOW)} for ${hhmm(NOW + 30 * MINUTE_MS)} is due.\n\nYour note:\n> check CI`)
    expect(fired?.facts.watch).toEqual({ id: idOf(answer), source: 'time', change: 'due' })
    expect(fired?.dedupeKey).toBe(`watch:${A}:${idOf(answer)}:${slotKey(NOW + 30 * MINUTE_MS)}`)
    // Delivered like any mail, its words in the wake: Centralu's and the session's own note (§8.2 step 4)
    expect(w.to('a').at(-1)?.input.text).toContain('> check CI')
    expect(w.watches.read(idOf(answer))?.state).toBe('fired')
    await w.advance(2 * HOUR_MS)
    expect(notices(w, A)).toHaveLength(1)
  })

  it('a slot missed across a sleep fires once, late', async () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'in 10m'))
    // The computer slept: no timer ran, and the sweep that runs on waking finds it due
    w.clock.t += 3 * HOUR_MS
    await w.delivery.sweep()
    await w.delivery.sweep()
    const [fired, ...more] = notices(w, A)
    expect(more).toEqual([])
    expect(fired?.facts.watch).toEqual({ id, source: 'time', change: 'due', late: true })
    expect(fired?.body).toContain(`It fires late: Centralu was not running at ${hhmm(NOW + 10 * MINUTE_MS)}, or the computer slept.`)
  })

  it('missed `every` slots are one firing, and the next slot fires on time', async () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'every 10m'))
    w.clock.t += HOUR_MS + 5 * MINUTE_MS
    await w.delivery.sweep()
    expect(notices(w, A).map((m) => m.facts.watch)).toEqual([{ id, source: 'time', change: 'due', late: true }])
    await w.advance(5 * MINUTE_MS)
    expect(notices(w, A).map((m) => m.facts.watch)).toEqual([
      { id, source: 'time', change: 'due', late: true },
      { id, source: 'time', change: 'due' },
    ])
    expect(w.watches.read(id)?.state).toBe('active')
  })

  it('`at` is the next such minute of this computer’s time, resolved once', () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'at 06:15'))
    const want = new Date(NOW)
    want.setHours(6, 15, 0, 0)
    if (want.getTime() <= NOW) want.setDate(want.getDate() + 1)
    expect(w.watches.views('a')).toEqual([{ id, source: 'time', what: '', at: want.getTime(), everyMinutes: null, until: want.getTime(), note: '', createdAt: NOW }])
  })
})

describe('a session watch (§18.3)', () => {
  it('set while the target is at rest fires at its next turn’s end, not at once, then ends', async () => {
    const w = started()
    const answer = watch(w, 'a', 'beta', 'review its diff')
    expect(answer.text).toBe(`Watching beta (${B}) until ${tomorrow(NOW + 24 * HOUR_MS)}; it is at rest now. id ${idOf(answer)}. Cancel with mail(action="close", thread="${idOf(answer)}").`)
    await w.advance(5 * MINUTE_MS)
    expect(notices(w, A)).toEqual([])
    turnEnded(w, 'b')
    const [fired] = notices(w, A)
    expect(fired?.body).toBe(`Your watch on beta (${B}): its turn ended. Read what it said with read_session.\n\nYour note:\n> review its diff`)
    expect(fired?.facts).toEqual({ watch: { id: idOf(answer), source: 'session', change: 'turn_ended' }, about: { session: B }, reason: 'turn_ended' })
    expect(w.watches.read(idOf(answer))?.state).toBe('fired')
    turnEnded(w, 'b')
    expect(notices(w, A)).toHaveLength(1)
  })

  it('a turn that ends while the target’s own background work runs does not fire: only its last response at rest does', () => {
    const w = started()
    watch(w, 'a', 'beta')
    // The turn ended, and no last response came (ChildReports waits for the session's own work to end)
    w.turns.beginOther('b', 'person', null)
    w.endTurn('b')
    expect(notices(w, A)).toEqual([])
    w.hooks.lastResponse?.('b', { body: () => 'done', relay: () => {}, released: false })
    expect(notices(w, A).map((m) => m.facts.reason)).toEqual(['turn_ended'])
  })

  it('fires `asked` for a new card, not one it was set with; `stopped`; and `gone`, each ending the watch', () => {
    const w = started()
    w.cards.set('b', ['q-old'])
    watch(w, 'a', 'beta')
    expect(watch(w, 'c', 'beta').text).toContain('it is waiting on a question or an approval now')
    w.hooks.sessionEvent?.({ type: 'question_request', sessionId: 'b', requestId: 'q-old' } as never, false)
    expect(notices(w, A)).toEqual([])
    w.hooks.sessionEvent?.({ type: 'question_request', sessionId: 'b', requestId: 'q-new' } as never, false)
    expect(notices(w, A).map((m) => m.facts.reason)).toEqual(['asked'])

    watch(w, 'a', 'gamma')
    w.hooks.stopped?.('c', 'error')
    expect(notices(w, A).map((m) => m.facts.reason)).toEqual(['asked', 'stopped'])

    const id = idOf(watch(w, 'a', 'xi'))
    delete w.table.x
    w.hooks.sessionGone('x')
    expect(notices(w, A).map((m) => m.facts.reason)).toEqual(['asked', 'stopped', 'gone'])
    expect(w.watches.read(id)?.state).toBe('gone')
  })

  it('a deleted owner’s watches go with it', () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'beta'))
    w.hooks.sessionGone('a')
    expect(w.watches.read(id)).toBeUndefined()
    turnEnded(w, 'b')
    expect(notices(w, A)).toEqual([])
  })

  it('set again keeps one row, with the later end and the new note', () => {
    const w = started()
    const first = idOf(watch(w, 'a', 'beta', 'one'))
    w.clock.t += HOUR_MS
    const again = idOf(watch(w, 'a', 'beta', 'two'))
    expect(again).toBe(first)
    expect(w.watches.list(A)).toMatchObject([{ id: first, note: 'two', expiresAt: NOW + HOUR_MS + 24 * HOUR_MS }])
  })

  it('refuses itself, a session it cannot read, one it gave open work, one on another computer, `every 5m` and a 21st watch', () => {
    const w = started({ readsSession: (reader, target) => !(reader === 'a' && target === 'c') })
    const refused = (id: string, to: string) => watch(w, id, to)
    expect(refused('a', 'a')).toEqual({ text: 'Refused (bad_value): a session does not watch itself.', isError: true })
    expect(refused('a', A)).toEqual({ text: 'Refused (bad_value): a session does not watch itself.', isError: true })
    expect(refused('a', 'gamma')).toEqual({ text: `Refused (not_allowed): ${at('c')} is not a session you can read with read_session, so you cannot watch it.`, isError: true })
    w.mail.task(A, B, { text: 'do it', origin: 'mail', delivered: true })
    expect(refused('a', 'beta')).toEqual({ text: 'Refused (not_allowed): you gave beta work that is open: its last response or reply reaches you as mail, and so does its stop, without a watch.', isError: true })
    expect(refused('a', 'session:hub-bbbbbbbb/z')).toEqual({ text: 'Refused (elsewhere): session:hub-bbbbbbbb/z is on another computer, and a watch waits only for a session on this one.', isError: true })
    expect(refused('a', 'every 5m')).toEqual({ text: 'Refused (bad_value): "every" is at least 10 minutes.', isError: true })
    expect(refused('a', 'in 8d').text).toBe('Refused (bad_value): a time is at most 7 days ahead.')
    for (let i = 1; i <= 20; i++) expect(refused('b', `in ${i}h`).isError).toBeUndefined()
    expect(refused('b', 'in 21h')).toEqual({ text: 'Refused (not_allowed): a session keeps at most 20 watches. Cancel one with mail(action="close", thread="<id>").', isError: true })
    expect(w.watches.list(A)).toEqual([])
  })
})

describe('the end of a watch (§18.4, §18.8)', () => {
  it('one that expires without a change posts one quiet notice', async () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'beta'))
    await w.advance(25 * HOUR_MS)
    expect(notices(w, A)).toMatchObject([{ body: `Your watch on beta (${B}) ended after 24 hours without a change.`, facts: { quiet: true, watch: { id, source: 'session', change: 'expired' } } }])
    expect(w.watches.read(id)).toMatchObject({ state: 'expired', endedBy: 'host' })
  })

  it('cancelled, its firing not given yet is taken back; the person’s cancel tells its owner once, quietly', async () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'every 10m'))
    w.states.set('a', { kind: 'busy', why: 'turn' })
    await w.advance(10 * MINUTE_MS)
    expect(notices(w, A)).toHaveLength(1)
    expect(w.tool.run('a', { action: 'close', thread: id })).toEqual({ text: `Cancelled watch ${id}.` })
    expect(notices(w, A)).toEqual([])
    expect(w.tool.run('a', { action: 'close', thread: id })).toEqual({ text: `Watch ${id} had ended already.` })

    const other = idOf(watch(w, 'a', 'beta'))
    expect(w.watches.cancel(other, 'person')).toBe(true)
    expect(w.watches.cancel(other, 'person')).toBe(false)
    expect(notices(w, A)).toMatchObject([{ body: `The person cancelled your watch on beta (${B}).`, facts: { quiet: true, watch: { id: other, change: 'cancelled' } } }])
    expect(w.watches.read(other)).toMatchObject({ state: 'cancelled', endedBy: 'person' })
  })

  it('tells the window each time a session’s watch set changes', () => {
    const w = started()
    const changed: string[] = []
    w.watches.onChange((sessionId) => changed.push(sessionId))
    const id = idOf(watch(w, 'a', 'beta'))
    turnEnded(w, 'b')
    idOf(watch(w, 'b', 'in 1h'))
    w.watches.cancel(id, 'person')
    expect(changed).toEqual(['a', 'a', 'b'])
  })
})

describe('evaluation (§18.5)', () => {
  it('two hosts on one store, both evaluating one change, post one notice', () => {
    const w = started()
    const other = started({ store: w.store, clock: w.clock })
    watch(w, 'a', 'beta')
    w.turns.beginOther('b', 'person', null)
    w.endTurn('b')
    for (const host of [w, other]) host.hooks.lastResponse?.('b', { body: () => 'x', relay: () => {}, released: true })
    expect(notices(w, A)).toHaveLength(1)
  })

  it('a turn that ends while no delivery runs fires once when one starts, and not again at the next start', () => {
    const w = hostWorld()
    worlds.push(w)
    w.delivery.start()
    watch(w, 'a', 'beta')
    w.delivery.stop()
    turnEnded(w, 'b')
    expect(notices(w, A)).toEqual([])
    w.delivery.start()
    expect(notices(w, A).map((m) => m.facts.reason)).toEqual(['turn_ended'])
    const next = started({ store: w.store, clock: w.clock })
    expect(notices(next, A)).toHaveLength(1)
  })

  it('a handoff moves the session’s watches to its heir, and the watches on it wait for the heir', () => {
    const w = started({ extra: { h: { name: 'heir', projectId: 'p1' } } })
    const mine = idOf(watch(w, 'a', 'beta'))
    const onA = idOf(watch(w, 'c', 'alpha'))
    w.hooks.handOver?.('a', 'h', 'all', [])
    expect(w.watches.read(mine)?.owner).toBe(at('h'))
    expect(w.watches.read(onA)?.target).toBe(at('h'))
    turnEnded(w, 'b')
    expect(notices(w, at('h')).map((m) => m.facts.watch)).toEqual([{ id: mine, source: 'session', change: 'turn_ended' }])
    turnEnded(w, 'h')
    expect(notices(w, at('c')).map((m) => m.facts.watch)).toEqual([{ id: onA, source: 'session', change: 'turn_ended' }])
  })

  it('warns the person once when a session’s watches woke it a 7th time in an hour, not at the 6th', async () => {
    const w = started()
    for (let i = 1; i <= 7; i++) watch(w, 'a', `in ${i}m`)
    const warnings = () => w.store.mailbox.feedOf(PERSON, { limit: 10 }).filter((m) => m.facts.watchWakes !== undefined)
    await w.advance(6 * MINUTE_MS + 5_000)
    expect(warnings()).toEqual([])
    await w.advance(MINUTE_MS)
    expect(warnings()).toMatchObject([{ body: "alpha's watches woke it 7 times in the last hour. They keep firing: look at it if that is more than you expect.", facts: { watchWakes: { session: A, count: 7 } } }])
  })
})

/** A slot's change key, as the host words it: its local minute */
function slotKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A time a day ahead as an answer words it: with its date */
function tomorrow(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hhmm(ms)}`
}
