/** Host requests (#1405): the limited credential's irreversible calls wait for the person's card */
import { describe, expect, it } from 'vitest'
import { HostRequest as HostRequestSchema, type HostRequest, type NormalizedEvent, type TrashedSession } from '@cc/protocol'
import { HostRequests, quotedName, type HostRequestsDeps } from './host-requests.js'

const row = (id: string, name: string, extra: Partial<TrashedSession> = {}): TrashedSession =>
  ({ id, name, tool: 'claude', project: null, deletedAt: 1000, messages: 4, bytes: 2048, conversationFile: 'keep', worktree: null, ...extra })

/** A host with a trash, a window that may or may not be attached, and every call it is asked to make recorded */
function harness(opts: { trash?: TrashedSession[]; canShow?: boolean; limits?: HostRequestsDeps['limits']; failPurge?: string } = {}) {
  let trash = opts.trash ?? [row('s1', 'Fix the parser'), row('m1.s2', 'Remote work', { machine: 'Laptop' })]
  const events: NormalizedEvent[] = []
  const calls: [string, unknown][] = []
  let canShow = opts.canShow ?? true
  const requests = new HostRequests({
    emit: (e) => events.push(e),
    canShow: () => canShow,
    limits: opts.limits,
    rpc: async (method, params) => {
      calls.push([method, params])
      if (method === 'trash.list') return { sessions: trash, runs: [], bytes: trash.reduce((n, s) => n + s.bytes, 0), subagentSteps: [] }
      if (method === 'trash.purge') {
        const id = (params as { sessionId: string }).sessionId
        if (id === opts.failPurge) throw new Error('the machine went away')
        trash = trash.filter((s) => s.id !== id)
        return { ok: true }
      }
      return { done: method }
    },
  })
  const raised = (): HostRequest[] => events.flatMap((e) => (e.type === 'host_request' ? [e.request] : []))
  /** Resolves once a card stands, so a test answers it the way the window does */
  const nextCard = async (): Promise<HostRequest> => {
    for (let i = 0; i < 200; i++) {
      const open = requests.list()
      if (open.length) return open.at(-1)!
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('no card was raised')
  }
  return {
    requests,
    events,
    calls,
    raised,
    nextCard,
    setTrash: (t: TrashedSession[]) => (trash = t),
    setCanShow: (v: boolean) => (canShow = v),
    purged: () => calls.filter(([m]) => m === 'trash.purge').map(([, p]) => (p as { sessionId: string }).sessionId),
  }
}

const caught = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as Error & { data?: { refused?: string } }
  }
  throw new Error('expected a refusal')
}

describe('a host request (#1405)', () => {
  it('names what a purge deletes, deletes it only once allowed, and answers as trash.purge does', async () => {
    const h = harness()
    const asked = h.requests.ask('trash.purge', { sessionId: 's1' }, { client: 'host-rpc' }, new AbortController().signal)
    const card = await h.nextCard()
    expect(card).toMatchObject({ method: 'trash.purge', client: '"host-rpc"' })
    expect(card.question).toContain('"Fix the parser"')
    expect(card.question).toContain('cannot be undone')
    expect(h.purged()).toEqual([])
    expect(h.requests.answer(card.requestId, 'allow')).toBe(true)
    await expect(asked).resolves.toEqual({ ok: true })
    expect(h.purged()).toEqual(['s1'])
    expect(h.events.at(-1)).toEqual({ type: 'host_request_resolved', requestId: card.requestId, outcome: 'allowed' })
    expect(h.requests.list()).toEqual([])
  })

  it('names the linked machine, and relays nothing to it before Allow', async () => {
    const h = harness()
    const asked = h.requests.ask('trash.purge', { sessionId: 'm1.s2' }, { client: null }, new AbortController().signal)
    const card = await h.nextCard()
    expect(card.question).toContain('"Laptop"')
    expect(card.client).toBeNull()
    // Before the answer the trash was only read
    expect(h.calls.map(([m]) => m)).toEqual(['trash.list'])
    h.requests.answer(card.requestId, 'allow')
    await asked
    expect(h.purged()).toEqual(['m1.s2'])
  })

  it('deletes nothing when the person denies it, and says so for a program to read', async () => {
    const h = harness()
    const asked = h.requests.ask('trash.purge', { sessionId: 's1' }, { client: null }, new AbortController().signal)
    h.requests.answer((await h.nextCard()).requestId, 'deny')
    const e = await caught(asked)
    expect(e.data?.refused).toBe('denied')
    expect(h.purged()).toEqual([])
  })

  it('is withdrawn when the program disconnects, and deletes nothing', async () => {
    const h = harness()
    const gone = new AbortController()
    const asked = h.requests.ask('trash.purge', { sessionId: 's1' }, { client: null }, gone.signal)
    const card = await h.nextCard()
    gone.abort()
    expect((await caught(asked)).data?.refused).toBe('withdrawn')
    expect(h.requests.answer(card.requestId, 'allow')).toBe(false)
    expect(h.purged()).toEqual([])
    expect(h.events.at(-1)).toMatchObject({ type: 'host_request_resolved', outcome: 'withdrawn' })
  })

  it('expires when nobody answers in time', async () => {
    const h = harness({ limits: { lifetimeMs: 30 } })
    const asked = h.requests.ask('trash.purge', { sessionId: 's1' }, { client: null }, new AbortController().signal)
    expect((await caught(asked)).data?.refused).toBe('expired')
    expect(h.events.at(-1)).toMatchObject({ type: 'host_request_resolved', outcome: 'expired' })
    expect(h.purged()).toEqual([])
  })

  it('is refused at once, with no card, when no window that shows requests is attached (owner, 2026-10-21)', async () => {
    const h = harness({ canShow: false })
    const e = await caught(h.requests.ask('trash.purge', { sessionId: 's1' }, { client: null }, new AbortController().signal))
    expect(e.data?.refused).toBe('no_window')
    expect(h.events).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('refuses a request past the bound instead of stacking cards', async () => {
    const h = harness({ limits: { maxOpen: 2 } })
    const signal = new AbortController().signal
    const first = h.requests.ask('projects.delete', { projectId: 'p1' }, { client: null }, signal)
    const second = h.requests.ask('projects.delete', { projectId: 'p2' }, { client: null }, signal)
    await new Promise((r) => setTimeout(r, 10))
    expect((await caught(h.requests.ask('projects.delete', { projectId: 'p3' }, { client: null }, signal))).data?.refused).toBe('too_many_requests')
    expect(h.raised()).toHaveLength(2)
    h.requests.closeAll()
    await Promise.allSettled([first, second])
  })

  it('does not delete a session restored and deleted again while the card stood', async () => {
    const h = harness()
    const asked = h.requests.ask('trash.purge', { sessionId: 's1' }, { client: null }, new AbortController().signal)
    const card = await h.nextCard()
    h.setTrash([row('s1', 'Fix the parser', { deletedAt: 2000 })])
    h.requests.answer(card.requestId, 'allow')
    const e = await caught(asked)
    expect(e.message).toContain('not what the card named')
    expect(h.purged()).toEqual([])
  })

  it('empties only what its card listed: a session that reached the trash meanwhile stays', async () => {
    const h = harness()
    const asked = h.requests.ask('trash.empty', {}, { client: null }, new AbortController().signal)
    const card = await h.nextCard()
    expect(card.question).toContain('2 sessions')
    h.setTrash([row('s1', 'Fix the parser'), row('m1.s2', 'Remote work', { machine: 'Laptop' }), row('s9', 'Arrived later')])
    h.requests.answer(card.requestId, 'allow')
    await expect(asked).resolves.toMatchObject({ purged: 2, failed: [] })
    expect(h.purged().sort()).toEqual(['m1.s2', 's1'])
    // trash.empty itself, which takes everything there is, is never called
    expect(h.calls.map(([m]) => m)).not.toContain('trash.empty')
  })

  it('shows any other method with its parameters quoted, and runs it as called once allowed', async () => {
    const h = harness()
    const params = { projectId: 'p1', note: 'line‮one' }
    const asked = h.requests.ask('projects.delete', params, { client: 'tool\nname' }, new AbortController().signal)
    const card = await h.nextCard()
    expect(card.question).toContain('Allow projects.delete?')
    // The bidi override is written as an escape, so the line reads as what it holds
    expect(card.question).toContain('\\u202e')
    expect(card.question).not.toContain('‮')
    expect(card.client).toBe('"tool\\nname"')
    h.requests.answer(card.requestId, 'allow')
    await expect(asked).resolves.toEqual({ done: 'projects.delete' })
    expect(h.calls).toEqual([['projects.delete', params]])
  })

  it('quotes a name of format characters within what the request may hold, so the window can read the card', async () => {
    const h = harness()
    // 200 characters is what a hello's client may be; each bidi override is six once escaped
    const name = String.fromCharCode(0x202e).repeat(200)
    const asked = h.requests.ask('projects.delete', { projectId: 'p1' }, { client: name }, new AbortController().signal)
    const card = await h.nextCard()
    expect(card.client).toMatch(/^"(\\u202e)+…"$/)
    expect(HostRequestSchema.safeParse(card).success).toBe(true)
    h.requests.answer(card.requestId, 'deny')
    await caught(asked)
    // An astral format character is nine; a plain name stays whole
    expect(quotedName(String.fromCodePoint(0xe0001).repeat(100)).length).toBeLessThanOrEqual(200)
    expect(quotedName('host-rpc')).toBe('"host-rpc"')
  })

  it('never runs a parameter the card did not show: parameters too long to show whole are refused, not cut', async () => {
    const h = harness()
    const hidden = { projectId: 'p1', pad: 'x'.repeat(2500), alsoDelete: 'everything' }
    const e = await caught(h.requests.ask('projects.delete', hidden, { client: null }, new AbortController().signal))
    expect(e.data?.refused).toBe('not_done')
    expect(h.raised()).toEqual([])
    expect(h.calls).toEqual([])
    // And what fits is shown whole
    const asked = h.requests.ask('projects.delete', { projectId: 'p1', pad: 'y'.repeat(1500), tail: 'END' }, { client: null }, new AbortController().signal)
    const card = await h.nextCard()
    expect(card.question).toContain('END')
    expect(card.question).not.toContain('…')
    h.requests.closeAll()
    await asked.catch(() => {})
  })

  it('keeps its bound when many trash deletes read the trash at once: no card past it', async () => {
    const h = harness({ limits: { maxOpen: 2 } })
    const signal = new AbortController().signal
    const asks = Array.from({ length: 5 }, () => h.requests.ask('trash.purge', { sessionId: 's1' }, { client: null }, signal))
    const settled = Promise.allSettled(asks)
    await new Promise((r) => setTimeout(r, 30))
    expect(h.raised()).toHaveLength(2)
    h.requests.closeAll()
    const outcomes = (await settled).map((r) => (r.status === 'rejected' ? (r.reason as { data?: { refused?: string } }).data?.refused : 'ran'))
    expect(outcomes.filter((o) => o === 'too_many_requests')).toHaveLength(3)
    expect(h.purged()).toEqual([])
  })

  it('says which sessions an allowed empty could not delete, as trash.empty answers them', async () => {
    const h = harness({ failPurge: 'm1.s2' })
    const asked = h.requests.ask('trash.empty', {}, { client: null }, new AbortController().signal)
    h.requests.answer((await h.nextCard()).requestId, 'allow')
    await expect(asked).resolves.toMatchObject({ purged: 1, failed: [{ sessionId: 'm1.s2', name: 'Remote work', error: 'the machine went away' }] })
  })

  it('withdraws what waits once no window shows requests for a while, and keeps it for one that comes back in time', async () => {
    const h = harness({ limits: { windowGoneMs: 40 } })
    const asked = h.requests.ask('projects.delete', { projectId: 'p1' }, { client: null }, new AbortController().signal)
    await h.nextCard()
    // A window reloads: gone, then back within the grace
    h.setCanShow(false)
    h.requests.showingChanged(0)
    h.setCanShow(true)
    h.requests.showingChanged(1)
    await new Promise((r) => setTimeout(r, 80))
    expect(h.requests.list()).toHaveLength(1)
    // The last window closes for good
    h.setCanShow(false)
    h.requests.showingChanged(0)
    expect((await caught(asked)).data?.refused).toBe('withdrawn')
    expect(h.calls).toEqual([])
  })

  it('takes one answer: a second, or one for a request it never raised, changes nothing', async () => {
    const h = harness()
    const asked = h.requests.ask('projects.delete', { projectId: 'p1' }, { client: null }, new AbortController().signal)
    const card = await h.nextCard()
    expect(h.requests.answer('nope', 'allow')).toBe(false)
    expect(h.requests.answer(card.requestId, 'deny')).toBe(true)
    expect(h.requests.answer(card.requestId, 'allow')).toBe(false)
    expect((await caught(asked)).data?.refused).toBe('denied')
    expect(h.calls).toEqual([])
  })
})
