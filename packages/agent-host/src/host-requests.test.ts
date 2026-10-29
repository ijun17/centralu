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
  /** The window's lists, as the router answers them: a linked machine's rows carry its name */
  let projects: { id: string; name: string; path: string; machine?: string }[] = [
    { id: 'p1', name: 'alpha', path: '/tmp/alpha' },
    { id: 'p2', name: 'beta', path: '/tmp/beta' },
    { id: 'p3', name: 'gamma', path: '/tmp/gamma' },
    { id: 'm1.p4', name: 'delta', path: '/home/me/delta', machine: 'Laptop' },
  ]
  const lists: Record<string, () => unknown> = {
    'sessions.list': () => [{ id: 's1', name: 'Fix the parser' }, { id: 'm1.s2', name: 'Remote work', machine: 'Laptop' }],
    'projects.list': () => projects,
    'apps.list': () => [{ appId: 'notes', projectId: null, name: 'Notes' }],
    'machines.list': () => [{ id: 'm1', name: 'Laptop' }],
  }
  /** The rights each call that ran was made with */
  const rights = new Map<string, 'full' | 'limited' | undefined>()
  /** What the program called itself, as each call that ran was told */
  const labels = new Map<string, string | null | undefined>()
  const requests = new HostRequests({
    emit: (e) => events.push(e),
    canShow: () => canShow,
    // The host's sessions by name: "named" has one, "unnamed" has none, "long" is all format characters
    sessionName: (id) => ({ named: 'Orchestrator', long: String.fromCharCode(0x202e).repeat(200) })[id] ?? null,
    limits: opts.limits,
    rpc: async (method, params, ctx) => {
      if (!Object.hasOwn(lists, method)) { rights.set(method, ctx?.rights); labels.set(method, ctx?.label) }
      // The lists a card reads to name what a call acts on; every other call is recorded
      const read = Object.hasOwn(lists, method) ? lists[method] : undefined
      if (read) return read()
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
    rights,
    labels,
    raised,
    nextCard,
    setTrash: (t: TrashedSession[]) => (trash = t),
    setProjects: (p: typeof projects) => (projects = p),
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

  it('runs the call it allowed as a limited credential’s, which is what a script’s session is told from a window’s by (§8.1)', async () => {
    const h = harness()
    const asked = h.requests.ask('agents.deleteSession', { sessionId: 's1' }, { client: 'ci runner' }, new AbortController().signal)
    h.requests.answer((await h.nextCard()).requestId, 'allow')
    await asked
    expect(h.rights.get('agents.deleteSession')).toBe('limited')
    // And under the name the program gave itself, so a script’s first message carries its label (3.8b)
    expect(h.labels.get('agents.deleteSession')).toBe('ci runner')
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

  it('shows any other method as its schema runs it, naming what it acts on and loses, and runs exactly that once allowed', async () => {
    const h = harness()
    // A field the method does not take is dropped before the card: it would not run, so it may not speak on the card
    const params = { projectId: 'p1', note: 'the person asked for this' }
    const asked = h.requests.ask('projects.delete', params, { client: 'tool\nname' }, new AbortController().signal)
    const card = await h.nextCard()
    expect(card.question).toContain('Allow projects.delete for the project "alpha" ("/tmp/alpha")?')
    expect(card.question).toContain("Centralu's records of the project are erased")
    expect(card.question).toContain('called it with "{\\"projectId\\":\\"p1\\"}"')
    expect(card.question).not.toContain('the person asked for this')
    expect(card.client).toBe('"tool\\nname"')
    h.requests.answer(card.requestId, 'allow')
    await expect(asked).resolves.toEqual({ done: 'projects.delete' })
    expect(h.calls).toEqual([['projects.delete', { projectId: 'p1' }]])
  })

  it("names a linked machine's session with its machine, and writes a parameter's bidi override as an escape", async () => {
    const h = harness()
    const asked = h.requests.ask('agents.deleteSession', { sessionId: 'm1.s2', deleteWorktree: true }, { client: null }, new AbortController().signal)
    const card = await h.nextCard()
    expect(card.question).toContain('Allow agents.deleteSession for the session "Remote work" on the linked machine "Laptop"?')
    expect(card.question).toContain('The session moves to the session archive, and its worktree is marked to be deleted when the session is deleted from the archive for good.')
    // The schema's defaults are shown: they are what runs
    expect(card.question).toContain('\\"deleteExternal\\":false')
    h.requests.answer(card.requestId, 'deny')
    await caught(asked)
    const text = `line${String.fromCharCode(0x202e)}one`
    const instructions = h.requests.ask('projects.setAgentInstructions', { projectId: 'm1.p4', text }, { client: null }, new AbortController().signal)
    const second = await h.nextCard()
    expect(second.question).toContain('for the project "delta" ("/home/me/delta") on the linked machine "Laptop"?')
    expect(second.question).toContain('\\u202e')
    expect(second.question).not.toContain(String.fromCharCode(0x202e))
    h.requests.answer(second.requestId, 'deny')
    await caught(instructions)
  })

  it('refuses before the card a call its method would refuse, or one naming nothing this computer has', async () => {
    const h = harness()
    const signal = new AbortController().signal
    const calls: [string, unknown][] = [
      ['projects.delete', { projectId: '../etc' }],
      ['projects.delete', { projectId: 'p9' }],
      ['agents.deleteSession', { sessionId: 'gone' }],
      ['machines.remove', { machineId: 'm9' }],
      ['apps.remove', { appId: 'other', projectId: null }],
      ['no.suchMethod', {}],
    ]
    for (const [method, params] of calls) {
      const e = await caught(h.requests.ask(method, params, { client: null }, signal))
      expect(e.data?.refused, method).toBe('not_done')
    }
    expect(h.raised()).toEqual([])
    expect(h.calls).toEqual([])
    // And one that names what is there is asked, by name
    const asked = h.requests.ask('apps.remove', { appId: 'notes', projectId: null }, { client: null }, signal)
    expect((await h.nextCard()).question).toContain('Allow apps.remove for the app "Notes" [notes]?')
    h.requests.closeAll()
    await caught(asked)
  })

  it('does not run an allowed call whose target changed while its card stood', async () => {
    const h = harness()
    const asked = h.requests.ask('projects.delete', { projectId: 'p1' }, { client: null }, new AbortController().signal)
    const card = await h.nextCard()
    h.setProjects([{ id: 'p1', name: 'renamed', path: '/tmp/alpha' }])
    h.requests.answer(card.requestId, 'allow')
    const e = await caught(asked)
    expect(e.data?.refused).toBe('not_done')
    expect(e.message).toContain('changed while it stood')
    expect(h.calls).toEqual([])
  })

  it('names the session whose credential asked by its name, or its id when it has none, and nothing without one', async () => {
    const h = harness()
    const signal = new AbortController().signal
    const asks = [
      h.requests.ask('projects.delete', { projectId: 'p1' }, { client: null, session: 'named' }, signal),
      h.requests.ask('projects.delete', { projectId: 'p2' }, { client: null, session: 'unnamed' }, signal),
      h.requests.ask('projects.delete', { projectId: 'p3' }, { client: null, session: 'long' }, signal),
      h.requests.ask('projects.delete', { projectId: 'm1.p4' }, { client: null }, signal),
    ]
    for (let i = 0; i < 200 && h.requests.list().length < 4; i++) await new Promise((r) => setTimeout(r, 5))
    const cards = h.requests.list()
    expect(cards.map((c) => c.session?.slice(0, 19) ?? null)).toEqual(['"Orchestrator"', '"unnamed"', '"\\u202e\\u202e\\u202e', null])
    for (const card of cards) expect(HostRequestSchema.safeParse(card).success).toBe(true)
    for (const card of cards) h.requests.answer(card.requestId, 'deny')
    for (const asked of asks) await caught(asked)
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
    const hidden = { projectId: 'p1', text: 'x'.repeat(2500) + ' and delete everything' }
    const e = await caught(h.requests.ask('projects.setAgentInstructions', hidden, { client: null }, new AbortController().signal))
    expect(e.data?.refused).toBe('not_done')
    expect(h.raised()).toEqual([])
    expect(h.calls).toEqual([])
    // And what fits is shown whole
    const asked = h.requests.ask('projects.setAgentInstructions', { projectId: 'p1', text: 'y'.repeat(1500) + 'END' }, { client: null }, new AbortController().signal)
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
    // Each says why, not the trash flow's "withdrawn before the person answered"
    const messages = (await settled).flatMap((r) => (r.status === 'rejected' && (r.reason as { data?: { refused?: string } }).data?.refused === 'too_many_requests' ? [(r.reason as Error).message] : []))
    for (const m of messages) expect(m).toContain('Too many requests already wait')
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
