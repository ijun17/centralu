/**
 * Requests an older build queued for a busy session (`queued_requests`, #677) are mail to this build (docs/plans/mailbox.md §10.6.2): at the start
 * each becomes an undelivered task from its requester and its row goes; the delivery then gives it to its session once, and wakes nobody else.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { takeOverFromEarlierBuild, type AdoptedSession } from './adoption.js'
import { deliveryWorld } from './delivery.test-helpers.js'
import { A, B, W } from './messages.test-helpers.js'

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})

/** A row as an older build wrote it (store v52, v54) */
function queue(w: ReturnType<typeof deliveryWorld>, row: { id: string; sessionId: string; caller: string; via: string; text: string; delivering?: number }) {
  w.db
    .prepare(`INSERT INTO queued_requests (id, session_id, caller_session_id, via, text, queued_at, delivering_at, opened_by_auto) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(row.id, row.sessionId, row.caller, row.via, row.text, w.clock.t, row.delivering ?? null)
}

function setup() {
  const w = deliveryWorld()
  const known: Record<string, AdoptedSession> = { a: { state: 'idle' }, b: { state: 'working' }, w: { askedBy: 'a', state: 'idle' } }
  const take = () => takeOverFromEarlierBuild(w.mail, w.store, { info: (id) => known[id] })
  return { ...w, take }
}

describe("an older build's queued requests (§10.6.2)", () => {
  it('each becomes a task from its requester, not delivered, with its tool as the origin; its row goes; a second start finds nothing', () => {
    const w = setup()
    queue(w, { id: 'qr-1', sessionId: 'b', caller: 'a', via: 'agent_session', text: 'run the linter too' })
    queue(w, { id: 'qr-2', sessionId: 'w', caller: 'a', via: 'ask_project', text: 'what does parse() return?', delivering: w.clock.t })
    expect(w.take().queued).toBe(2)
    expect(w.store.children.listQueuedRequests()).toEqual([])
    const toB = w.store.mailbox.newestTask(A, B)!
    expect(toB).toMatchObject({ kind: 'task', body: 'run the linter too', origin: 'agent_session' })
    expect(w.rowOf(toB.id, B)).toMatchObject({ deliveredAt: null, settled: null })
    expect(w.store.mailbox.newestTask(A, W)).toMatchObject({ body: 'what does parse() return?', origin: 'ask_project' })
    expect(w.take().queued).toBe(0)
    expect(w.store.mailbox.watchedFrom(A)).toHaveLength(2)
  })

  it('a row whose requester or session is gone goes with no task; one through a tool this build does not know stays', () => {
    const w = setup()
    queue(w, { id: 'qr-gone', sessionId: 'b', caller: 'gone', via: 'agent_session', text: 'x' })
    queue(w, { id: 'qr-new', sessionId: 'b', caller: 'a', via: 'some_future_tool', text: 'y' })
    expect(w.take().queued).toBe(0)
    expect(w.store.children.listQueuedRequests().map((r) => r.id)).toEqual(['qr-new'])
    expect(w.store.mailbox.watchedFrom(A)).toEqual([])
  })

  it('the delivery gives it to its session once, as a wake at rest, and wakes nobody else', async () => {
    const w = setup()
    queue(w, { id: 'qr-1', sessionId: 'b', caller: 'a', via: 'agent_session', text: 'run the linter too' })
    w.take()
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(2_000)
    await w.advance(120_000)
    expect(w.delivered.map((d) => d.sessionId)).toEqual(['b'])
    expect(w.to('b')[0]!.input.text).toContain('run the linter too')
  })
})
