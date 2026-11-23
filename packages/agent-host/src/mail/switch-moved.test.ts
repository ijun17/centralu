/**
 * Mail store step v75 moved from an old thread (docs/plans/mailbox.md §6.3), as the sessions it was sent to read it afterwards: a request to
 * an Assistant since trashed, a question read and not answered, and a row the person had released. Each written as the step leaves it
 * (`movedThread`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { at, hostWorld } from './host-mail.test-helpers.js'
import { movedThread } from './moved.test-helpers.js'

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

describe('moved mail, for the sessions the old mail was for', () => {
  it('a request to an Assistant since trashed is sent to the role: the next Assistant takes it, trusted or not', () => {
    const w = hostWorld()
    const old = at('orc0')
    movedThread(w, { id: tid(1), at: w.clock.t - 1_000 }, [{ id: mid(1), sender: A, kind: 'assign', body: 'trusted ask', to: [{ recipient: old, via: 'assistant' }] }])
    movedThread(w, { id: tid(2), at: w.clock.t - 1_000 }, [{ id: mid(2), sender: X, kind: 'assign', body: 'untrusted ask', to: [{ recipient: old, via: 'assistant', held: 'policy' }] }])
    ready(w)
    w.hooks.roleMoved?.('orc')
    expect(w.row(mid(1), at('orc'))).toBeDefined()
    expect(w.row(mid(2), at('orc'))).toBeDefined()
    expect(w.row(mid(1), old)).toBeUndefined()
  })

  it('a question read and not answered waits for its reply in the inbox, says so in read, and leaves the inbox once answered', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    movedThread(w, { id: tid(5), at: t }, [{ id: mid(5), sender: A, kind: 'question', body: 'Which branch?', to: [{ recipient: B, deliveredAt: t, readAt: t }] }])
    ready(w)
    expect(w.tool.run('b', { action: 'inbox' }).text).toContain(`reply     ${mid(5)}`)
    const read = w.tool.run('b', { action: 'read', thread: mid(5) }).text
    expect(read).toContain('It needs a reply: not answered yet.')
    expect(read).not.toContain('legacy')
    w.tool.run('b', { action: 'reply', thread: mid(5), text: 'main' })
    expect(w.row(mid(5), B)?.settled).toBe('answered')
    expect(w.tool.run('b', { action: 'inbox' }).text).not.toContain(`reply     ${mid(5)}`)
  })

  it('a row the person released on the older build is delivered, though its project is still not trusted', async () => {
    const w = hostWorld()
    movedThread(w, { id: tid(7), at: w.clock.t - 1_000 }, [{ id: mid(10), sender: X, kind: 'note', body: 'released by the person', to: [{ recipient: B, held: 'released' }] }])
    ready(w)
    await w.advance(2_000)
    expect(bodies(w, 'b')).toContain(mid(10))
    expect(w.row(mid(10), B)?.held).toBe('released')
  })

  it('a row the person released on the older build to an Assistant since trashed is not held again once the next one takes it', async () => {
    const w = hostWorld()
    const old = at('orc0')
    movedThread(w, { id: tid(8), at: w.clock.t - 1_000 }, [{ id: mid(12), sender: X, kind: 'assign', body: 'released request', to: [{ recipient: old, via: 'assistant', held: 'released' }] }])
    ready(w)
    w.hooks.roleMoved?.('orc')
    await w.advance(2_000)
    expect(w.row(mid(12), at('orc'))?.held).toBe('released')
    expect(w.store.mailbox.message(mid(12))?.facts.releasedTo).toEqual([at('orc')])
    expect(w.row(mid(12), at('orc'))?.deliveredAt).not.toBeNull()
  })

  it('a row the person released on the older build keeps its release when a handoff gives it to the heir', async () => {
    const w = hostWorld()
    movedThread(w, { id: tid(9), at: w.clock.t - 1_000 }, [{ id: mid(13), sender: X, kind: 'note', body: 'released note', to: [{ recipient: A, held: 'released' }] }])
    ready(w)
    w.mail.handoffs.handOver(A, B, 'all')
    await w.advance(2_000)
    expect(w.row(mid(13), B)?.held).toBe('released')
    expect(bodies(w, 'b')).toContain(mid(13))
  })
})
