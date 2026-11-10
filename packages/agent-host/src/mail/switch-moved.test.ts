/**
 * What an older build left in the v61 tables, moved at ready (docs/plans/mailbox.md §6.3), as the sessions it was sent to read it afterwards:
 * a request to an Assistant since trashed, a task to a trashed session, a question read and not answered, an old thread's history, and a row
 * the person had released. Each written straight into the old tables (`oldThread`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { at, hostWorld } from './host-mail.test-helpers.js'
import { oldSession, oldThread } from './v61.test-helpers.js'

const A = at('a')
const B = at('b')
const X = at('x')
const mid = (n: number) => `hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G6F${String(n).padStart(2, '0')}`
const tid = (n: number) => `hub-aaaaaaaa.t_01ARZ3NDEKTSV4RRFFQ69G6F${String(n).padStart(2, '0')}`

let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})

function ready(w: ReturnType<typeof hostWorld>) {
  w.afterReady()
  stops.push(w.stop)
  return w
}
const bodies = (w: ReturnType<typeof hostWorld>, id: string) => w.to(id).map((d) => d.input.text).join('\n')

describe('the move, for the sessions the old mail was for', () => {
  it('a request to an Assistant since trashed is sent to the role: the next Assistant takes it, trusted or not', () => {
    const w = hostWorld()
    oldSession(w.store, 'orc0', { assistant: true, trashedAt: w.clock.t - 500 })
    const old = at('orc0')
    oldThread(w.store, { id: tid(1), owner: A, assignee: old, at: w.clock.t - 1_000 }, [{ id: mid(1), sender: A, kind: 'assign', body: 'trusted ask', receipts: [{ recipient: old }] }])
    oldThread(w.store, { id: tid(2), owner: X, assignee: old, projectId: 'px', at: w.clock.t - 1_000 }, [
      { id: mid(2), sender: X, kind: 'assign', body: 'untrusted ask', receipts: [{ recipient: old, held: 'policy' }] },
    ])
    ready(w)
    expect([w.row(mid(1), old)?.via, w.row(mid(2), old)?.via]).toEqual(['assistant', 'assistant'])
    w.hooks.roleMoved?.('orc')
    expect(w.row(mid(1), at('orc'))).toBeDefined()
    expect(w.row(mid(2), at('orc'))).toBeDefined()
    expect(w.row(mid(1), old)).toBeUndefined()
  })

  it('mail to an Assistant outside a session’s request stays its own', () => {
    const w = hostWorld()
    oldSession(w.store, 'orc0', { assistant: true, trashedAt: w.clock.t - 500 })
    const old = at('orc0')
    oldThread(w.store, { id: tid(3), owner: old, assignee: A, at: w.clock.t - 1_000 }, [{ id: mid(3), sender: A, kind: 'note', body: 'to its own thread', receipts: [{ recipient: old }] }])
    ready(w)
    expect(w.row(mid(3), old)?.via).toBeNull()
  })

  it('a task to a session trashed on the older build is settled gone, so a restored session is never handed it', async () => {
    const w = hostWorld()
    oldSession(w.store, 'b', { trashedAt: w.clock.t - 500, projectId: 'p1' })
    oldThread(w.store, { id: tid(4), owner: A, assignee: B, origin: 'start_agent', at: w.clock.t - 1_000 }, [{ id: mid(4), sender: A, kind: 'assign', body: 'the job', receipts: [{ recipient: B }] }])
    ready(w)
    expect(w.row(mid(4), B)?.settled).toBe('gone')
    await w.advance(2_000)
    expect(bodies(w, 'b')).not.toContain('the job')
  })

  it('a question read and not answered waits for its reply in the inbox, says so in read, and leaves the inbox once answered', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    oldThread(w.store, { id: tid(5), owner: A, assignee: B, at: t }, [{ id: mid(5), sender: A, kind: 'question', body: 'Which branch?', receipts: [{ recipient: B, deliveredAt: t, readAt: t }] }])
    ready(w)
    expect(w.tool.run('b', { action: 'inbox' }).text).toContain(`reply     ${mid(5)}`)
    const read = w.tool.run('b', { action: 'read', thread: mid(5) }).text
    expect(read).toContain('It needs a reply: not answered yet.')
    expect(read).not.toContain('legacy')
    w.tool.run('b', { action: 'reply', thread: mid(5), text: 'main' })
    expect(w.row(mid(5), B)?.settled).toBe('answered')
    expect(w.tool.run('b', { action: 'inbox' }).text).not.toContain(`reply     ${mid(5)}`)
  })

  it('the old thread above a moved message shows only what its reader was shown, and nothing after it', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    oldThread(w.store, { id: tid(6), owner: A, assignee: B, at: t }, [
      { id: mid(6), sender: A, kind: 'note', body: 'seen before', receipts: [{ recipient: B, deliveredAt: t, readAt: t, handledAt: t }] },
      { id: mid(7), sender: X, kind: 'note', body: 'held for trust', receipts: [{ recipient: B, held: 'policy' }] },
      { id: mid(8), sender: A, kind: 'question', body: 'the moved one', receipts: [{ recipient: B }] },
      { id: mid(9), sender: A, kind: 'note', body: 'held for its depth, later', receipts: [{ recipient: B, held: 'loop' }] },
      { id: mid(11), sender: A, kind: 'note', body: 'said after it', receipts: [{ recipient: B, deliveredAt: t + 5, readAt: t + 5, handledAt: t + 5 }] },
    ])
    ready(w)
    const read = w.tool.run('b', { action: 'read', thread: mid(8) }).text
    expect(read).toContain('seen before')
    expect(read).toContain('the moved one')
    expect(read).not.toContain('held for trust')
    expect(read).not.toContain('held for its depth, later')
    expect(read).not.toContain('said after it')
  })

  it('a row the person released on the older build is delivered, though its project is still not trusted', async () => {
    const w = hostWorld()
    oldThread(w.store, { id: tid(7), owner: X, projectId: 'px', at: w.clock.t - 1_000 }, [{ id: mid(10), sender: X, kind: 'note', body: 'released by the person', receipts: [{ recipient: B, held: 'released' }] }])
    ready(w)
    await w.advance(2_000)
    expect(bodies(w, 'b')).toContain(mid(10))
    expect(w.row(mid(10), B)?.held).toBe('released')
  })

  it('a row the person released on the older build to an Assistant since trashed is not held again once the next one takes it', async () => {
    const w = hostWorld()
    oldSession(w.store, 'orc0', { assistant: true, trashedAt: w.clock.t - 500 })
    const old = at('orc0')
    oldThread(w.store, { id: tid(8), owner: X, assignee: old, projectId: 'px', at: w.clock.t - 1_000 }, [
      { id: mid(12), sender: X, kind: 'assign', body: 'released request', receipts: [{ recipient: old, held: 'released' }] },
    ])
    ready(w)
    w.hooks.roleMoved?.('orc')
    await w.advance(2_000)
    expect(w.row(mid(12), at('orc'))?.held).toBe('released')
    expect(w.store.mailbox.message(mid(12))?.facts.releasedTo).toEqual([at('orc')])
    expect(w.row(mid(12), at('orc'))?.deliveredAt).not.toBeNull()
  })

  it('a row the person released on the older build keeps its release when a handoff gives it to the heir', async () => {
    const w = hostWorld()
    oldThread(w.store, { id: tid(9), owner: X, projectId: 'px', at: w.clock.t - 1_000 }, [{ id: mid(13), sender: X, kind: 'note', body: 'released note', receipts: [{ recipient: A, held: 'released' }] }])
    ready(w)
    w.mail.handOver(A, B, 'all')
    await w.advance(2_000)
    expect(w.row(mid(13), B)?.held).toBe('released')
    expect(bodies(w, 'b')).toContain(mid(13))
  })
})
