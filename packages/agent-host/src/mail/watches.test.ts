import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrChecks } from '../dev-services/git-pr.js'
import { PERSON } from './address.js'
import { NOW, at, hostWorld } from './host-mail.test-helpers.js'
import { HOUR_MS, MINUTE_MS } from './rules.js'

/**
 * Watches the host keeps (#1324, docs/plans/mailbox.md §18): a session asks Centralu to wake it at a time or when another session ends its turn, asks
 * or stops, and the change comes as one notice through the mailbox. Time is a fake clock and the delivery's injected `schedule`; nothing sleeps.
 */

/** What gh answers for a pull request, by number; each asking counted */
const gh = vi.hoisted(() => ({ answer: new Map<number, unknown>(), asked: [] as number[] }))
vi.mock('../dev-services/git-pr.js', () => ({
  prChecks: async (_cwd: string, n: number) => {
    gh.asked.push(n)
    return (await gh.answer.get(n)) ?? null
  },
}))
const checks = (o: Partial<PrChecks>): PrChecks => ({ state: 'open', headOid: 'h1', total: 3, pending: 0, failed: 0, cancelled: 0, ...o })

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

  it('an `every` whose end passed while the host was away fires its last slot before the end, late, and no slot after it', async () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'every 30m'))
    w.clock.t += 48 * HOUR_MS
    await w.delivery.sweep()
    const [fired, ...more] = notices(w, A)
    expect(more).toEqual([])
    expect(fired?.facts.watch).toEqual({ id, source: 'time', change: 'due', late: true })
    expect(fired?.dedupeKey).toBe(`watch:${A}:${id}:${slotKey(NOW + 24 * HOUR_MS)}`)
    expect(w.watches.read(id)?.state).toBe('expired')
  })

  it('missed slots are late though the host is back right at a slot', async () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'every 10m'))
    w.clock.t += 20 * MINUTE_MS
    await w.delivery.sweep()
    expect(notices(w, A).map((m) => m.facts.watch)).toEqual([{ id, source: 'time', change: 'due', late: true }])
    expect(notices(w, A)[0]?.body).toContain(`It fires late: Centralu was not running at ${hhmm(NOW + 10 * MINUTE_MS)}, or the computer slept.`)
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

  it('an owner in the session archive keeps its watches, which may come back with it; deleted for good, they go with its mail', () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'in 1h'))
    w.hooks.sessionGone('a')
    expect(w.watches.read(id)?.state).toBe('active')
    w.store.mailbox.purgeParty(A)
    expect(w.watches.read(id)).toBeUndefined()
  })

  it('a stop Centralu holds to continue fires `stopped` only when its wait ends without going on', () => {
    const w = started()
    watch(w, 'a', 'gamma')
    w.hooks.stopped?.('c', 'limit', { held: true })
    w.hooks.waitEnded?.('c', 'limit', null, { continued: 'centralu', first: true })
    expect(notices(w, A)).toEqual([])
    w.hooks.stopped?.('c', 'limit', { held: true })
    w.hooks.waitEnded?.('c', 'limit', null, { continued: false, first: false })
    expect(notices(w, A).map((m) => m.facts.reason)).toEqual(['stopped'])
  })

  it('one watch that fails to fire leaves the others on the same session, and the turn’s end goes on', () => {
    const w = started()
    watch(w, 'a', 'beta')
    watch(w, 'c', 'beta')
    const notice = w.mail.notice.bind(w.mail)
    vi.spyOn(w.mail, 'notice').mockImplementationOnce(() => {
      throw new Error('disk full')
    }).mockImplementation(notice)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => turnEnded(w, 'b')).not.toThrow()
    expect([...notices(w, A), ...notices(w, at('c'))].map((m) => m.facts.reason)).toEqual(['turn_ended'])
    vi.restoreAllMocks()
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
    expect(w.watches.cancel(other, 'person')).toBe('cancelled')
    expect(w.watches.cancel(other, 'person')).toBe('ended')
    expect(notices(w, A)).toMatchObject([{ body: `The person cancelled your watch on beta (${B}).`, facts: { quiet: true, watch: { id: other, change: 'cancelled' } } }])
    expect(w.watches.read(other)).toMatchObject({ state: 'cancelled', endedBy: 'person' })
  })

  it('closed after it fired but before its notice reached the owner, it says the notice is taken back, and tells the window', async () => {
    const w = started()
    const id = idOf(watch(w, 'a', 'in 10m'))
    w.states.set('a', { kind: 'busy', why: 'turn' })
    await w.advance(10 * MINUTE_MS + 5_000)
    expect(w.watches.read(id)?.state).toBe('fired')
    expect(notices(w, A)).toHaveLength(1)
    const changed: string[] = []
    w.watches.onChange((sessionId) => changed.push(sessionId))
    expect(w.tool.run('a', { action: 'close', thread: id })).toEqual({ text: `Watch ${id} had fired, and its notice had not reached you yet: it will not come.` })
    expect(notices(w, A)).toEqual([])
    expect(changed).toEqual(['a'])
  })

  it('tells the window each time a session’s watch set changes', () => {
    const w = started()
    const changed: string[] = []
    w.watches.onChange((sessionId) => changed.push(sessionId))
    const id = idOf(watch(w, 'a', 'beta'))
    turnEnded(w, 'b')
    idOf(watch(w, 'b', 'in 1h'))
    // It had fired, and its notice not delivered yet is taken back: that changes the owner's mail too
    expect(w.watches.cancel(id, 'person')).toBe('withdrawn')
    expect(changed).toEqual(['a', 'a', 'b', 'a'])
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

  it('an owner deleted while no delivery ran loses its watches when one starts, and nothing fires to it', () => {
    const w = hostWorld()
    worlds.push(w)
    w.delivery.start()
    const id = idOf(watch(w, 'a', 'in 10m'))
    w.delivery.stop()
    delete w.table.a
    w.clock.t += HOUR_MS
    w.delivery.start()
    expect(w.watches.read(id)).toBeUndefined()
    expect(notices(w, A)).toEqual([])
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

  it('a handoff ends a watch that would have the heir watch itself, and moves nothing when the mail’s move fails', () => {
    const w = started({ extra: { h: { name: 'heir', projectId: 'p1' } } })
    const onHeir = idOf(watch(w, 'a', 'heir'))
    const kept = idOf(watch(w, 'a', 'in 1h'))
    expect(() => w.watches.handOver(A, at('h'), () => {
      throw new Error('the mail could not move')
    })).toThrow('the mail could not move')
    expect(w.watches.read(kept)?.owner).toBe(A)
    w.hooks.handOver?.('a', 'h', 'all', [])
    expect(w.watches.read(onHeir)).toMatchObject({ owner: at('h'), state: 'cancelled', endedBy: 'host' })
    expect(w.watches.read(kept)).toMatchObject({ owner: at('h'), state: 'active' })
    turnEnded(w, 'h')
    expect(notices(w, at('h'))).toEqual([])
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

describe('a pull request watch (§18.3, PR 2)', () => {
  afterEach(() => {
    gh.answer.clear()
    gh.asked.length = 0
  })
  const watchPr = (w: ReturnType<typeof hostWorld>, id: string, to: string, text?: string) => w.tool.call(id, { action: 'watch', to, ...(text ? { text } : {}) })

  it('gh not installed or not signed in is refused and writes no row', async () => {
    const w = started()
    gh.answer.set(7, 'unavailable')
    expect((await watchPr(w, 'a', '#7')).text).toBe('Refused (unavailable): gh is not installed on this computer, so Centralu cannot watch #7 here.')
    gh.answer.set(7, 'signed_out')
    expect((await watchPr(w, 'a', '#7')).text).toBe('Refused (unavailable): gh is not signed in on this computer (gh auth login), so Centralu cannot watch #7 here.')
    expect(w.watches.list(A)).toEqual([])
  })

  it('fires once when the checks on its head finish, saying how many failed, and asks gh once a minute for each pull request however many watch it', async () => {
    const w = started()
    gh.answer.set(7, checks({ pending: 2 }))
    const answer = await watchPr(w, 'a', '#7', 'merge it then')
    expect(answer.text).toMatch(/^Watching the checks on #7 until .*; 2 of 3 still run\. id /)
    await watchPr(w, 'b', '#7')
    gh.asked.length = 0
    await w.advance(60_000)
    expect(gh.asked).toEqual([7])
    expect(notices(w, A)).toEqual([])
    gh.answer.set(7, checks({ failed: 1, cancelled: 1 }))
    await w.advance(60_000)
    // One poll that sees none running is not the finish yet: a check can still appear (§18.3)
    expect(notices(w, A)).toEqual([])
    await w.advance(60_000)
    const [fired, ...more] = notices(w, A)
    expect(more).toEqual([])
    expect(fired?.body).toBe('The checks on #7 finished: 1 failed, 1 cancelled.\n\nYour note:\n> merge it then')
    expect(fired?.facts.watch).toMatchObject({ source: 'pr', change: 'checks' })
    expect(notices(w, B)).toHaveLength(1)
    gh.asked.length = 0
    await w.advance(5 * 60_000)
    expect(gh.asked).toEqual([])
    expect(notices(w, A)).toHaveLength(1)
  })

  it('a push starts the wait again: the new head’s checks are what it waits for', async () => {
    const w = started()
    gh.answer.set(7, checks({ pending: 1 }))
    await watchPr(w, 'a', '#7')
    gh.answer.set(7, checks({ headOid: 'h2', total: 0 }))
    await w.advance(60_000)
    expect(notices(w, A)).toEqual([])
    gh.answer.set(7, checks({ headOid: 'h2', total: 4, pending: 1 }))
    await w.advance(60_000)
    expect(notices(w, A)).toEqual([])
    gh.answer.set(7, checks({ headOid: 'h2', total: 4 }))
    await w.advance(60_000)
    expect(notices(w, A)).toEqual([])
    await w.advance(60_000)
    expect(notices(w, A).map((m) => m.body)).toEqual(['The checks on #7 finished: none failed.'])
  })

  it('believes a finish only when two polls in a row agree: a check that appears after the others ended waits, and a head with no checks fires once that none ran', async () => {
    const w = started()
    gh.answer.set(7, checks({ pending: 1 }))
    await watchPr(w, 'a', '#7')
    gh.answer.set(7, checks({ total: 3 }))
    await w.advance(60_000)
    gh.answer.set(7, checks({ total: 4 }))
    await w.advance(60_000)
    expect(notices(w, A)).toEqual([])
    gh.answer.set(7, checks({ headOid: 'h2', total: 0 }))
    await w.advance(60_000)
    expect(notices(w, A)).toEqual([])
    await w.advance(60_000)
    await w.advance(60_000)
    expect(notices(w, A).map((m) => m.body)).toEqual(['No checks ran on #7.'])
  })

  it('starts the count again when gh cannot answer between two polls, or the host stops between them', async () => {
    const w = started()
    gh.answer.set(7, checks({ pending: 1 }))
    await watchPr(w, 'a', '#7')
    gh.answer.set(7, checks({}))
    await w.advance(60_000)
    gh.answer.delete(7)
    await w.advance(60_000)
    gh.answer.set(7, checks({}))
    await w.advance(60_000)
    expect(notices(w, A)).toEqual([])
    w.delivery.stop()
    w.delivery.start()
    await w.advance(60_000)
    expect(notices(w, A)).toEqual([])
    await w.advance(60_000)
    expect(notices(w, A).map((m) => m.body)).toEqual(['The checks on #7 finished: none failed.'])
  })

  it('a watch closed while gh is asked stays closed when gh answers with a new head', async () => {
    const w = started()
    gh.answer.set(7, checks({ pending: 1 }))
    const id = idOf(await watchPr(w, 'a', '#7'))
    let answer: (r: PrChecks) => void = () => {}
    gh.answer.set(7, new Promise<PrChecks>((resolve) => (answer = resolve)))
    gh.asked.length = 0
    await w.advance(60_000)
    expect(gh.asked).toEqual([7])
    expect(w.tool.run('a', { action: 'close', thread: id }).text).toBe(`Cancelled watch ${id}.`)
    answer(checks({ headOid: 'h2', pending: 1 }))
    await w.advance(60_000)
    expect(w.watches.list(A)).toEqual([])
  })

  it('fires when the pull request is merged or closed, and has nothing to wait for when it is so already', async () => {
    const w = started()
    gh.answer.set(7, checks({ pending: 1 }))
    await watchPr(w, 'a', '#7')
    gh.answer.set(7, checks({ state: 'merged' }))
    await w.advance(60_000)
    expect(notices(w, A).map((m) => m.body)).toEqual(['Pull request #7 was merged.'])
    expect((await watchPr(w, 'a', '#7')).text).toBe('#7 is merged already: nothing to watch.')
    gh.answer.set(8, checks({}))
    expect((await watchPr(w, 'a', '#8')).text).toBe('The checks on #8 finished: none failed already: nothing to watch. A push starts new checks; watch again after it.')
    expect(w.watches.list(A)).toEqual([])
  })

  it('gh signed out after it was set ends it with one quiet notice, and gh is not asked again', async () => {
    const w = started()
    gh.answer.set(7, checks({ pending: 1 }))
    await watchPr(w, 'a', '#7')
    gh.answer.set(7, 'signed_out')
    await w.advance(60_000)
    const [ended, ...more] = notices(w, A)
    expect(more).toEqual([])
    expect(ended?.body).toBe('Your watch on the checks on #7 ended: gh is not signed in on this computer (gh auth login).')
    expect(ended?.facts.quiet).toBe(true)
    gh.asked.length = 0
    await w.advance(10 * 60_000)
    expect(gh.asked).toEqual([])
  })

  it('the window lists it by its number', async () => {
    const w = started()
    gh.answer.set(7, checks({ pending: 1 }))
    await watchPr(w, 'a', '#7', 'n')
    expect(w.watches.views('a')).toMatchObject([{ source: 'pr', what: '#7', note: 'n' }])
  })
})
