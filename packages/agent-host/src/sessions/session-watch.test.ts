import { describe, expect, it } from 'vitest'
import { SessionInfo, sessionLiveDefaults, type NormalizedEvent } from '@cc/protocol'
import { SessionWatch, WATCH_RING, WATCH_ROWS_MAX } from './session-watch.js'

/**
 * What an app that observes its project hears of its sessions (docs/plans/task-ledger.md): the feed of changes, the
 * cursor, and the long-poll on it, judged with sessions the test holds and the events the host would send for them.
 * The manager's side (its real events) is `app-observe.test.ts`.
 */

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return SessionInfo.parse({
    id,
    projectId: 'p1',
    kind: 'worker',
    tool: 'claude',
    externalId: null,
    name: id,
    autoNamed: false,
    state: 'idle',
    lastReadSeq: 0,
    lastSeq: 1,
    createdAt: 1,
    waitingSince: null,
    live: true,
    model: null,
    effort: null,
    verbosity: null,
    serviceTier: null,
    permissionPreset: 'normal',
    importedFrom: null,
    worktree: null,
    parentSessionId: null,
    scopeSessionIds: null,
    roleAppend: null,
    appId: null,
    ...sessionLiveDefaults(),
    ...over,
  })
}

function world(settleMs = 0) {
  const held = new Map<string, SessionInfo>()
  const leaving = new Set<string>()
  const watch = new SessionWatch({ get: (id) => held.get(id), all: () => [...held.values()], live: () => true, leaving: (id) => leaving.has(id), settleMs })
  const put = (s: SessionInfo) => void held.set(s.id, s)
  /** The host changed the session and sent this event for it */
  const happen = (e: NormalizedEvent, change?: (m: SessionInfo) => void) => {
    const m = held.get(e.sessionId!)
    if (m && change) change(m)
    watch.observe(e)
  }
  return { watch, held, put, leaving, happen }
}

const live = new AbortController().signal
const text = (id: string): NormalizedEvent => ({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'x' })
const deleted = (id: string): NormalizedEvent => ({ type: 'session_deleted', sessionId: id })

describe('a poll for the sessions of a project', () => {
  it('answers every session of the project at once when it holds no cursor, and none of another project', async () => {
    const w = world()
    w.put(session('a'))
    w.put(session('b', { projectId: 'p2' }))
    const first = await w.watch.watch('p1', undefined, 5_000, live)
    expect(first.full).toBe(true)
    expect(first.sessions.map((s) => s.id)).toEqual(['a'])
    expect(first.sessions[0]).toMatchObject({ state: 'idle', lastSeq: 1, pending: { approvals: 0, questions: 0 }, parentId: null })
    expect(first.cursor).toMatch(new RegExp(`^${w.watch.epoch}\\.`))
  })

  it('waits for a change after its cursor, then answers with that session only', async () => {
    const w = world()
    w.put(session('a'))
    w.put(session('b'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    const poll = w.watch.watch('p1', cursor, 5_000, live)
    w.happen(text('a'), (m) => (m.state = 'working'))
    const got = await poll
    expect(got.full).toBe(false)
    expect(got.sessions.map((s) => [s.id, s.state])).toEqual([['a', 'working']])
    expect(got.gone).toEqual([])
    expect(got.cursor).not.toBe(cursor)
  })

  it('answers at once with what changed while the app was away, and empty after the wait when nothing did', async () => {
    const w = world()
    w.put(session('a'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    w.happen(text('a'), (m) => (m.state = 'working'))
    const behind = await w.watch.watch('p1', cursor, 60_000, live)
    expect(behind.sessions.map((s) => s.id)).toEqual(['a'])
    const quiet = await w.watch.watch('p1', behind.cursor, 20, live)
    expect(quiet).toMatchObject({ full: false, sessions: [], gone: [], cursor: behind.cursor })
  })

  it("is not woken by another project's session", async () => {
    const w = world()
    w.put(session('a'))
    w.put(session('other', { projectId: 'p2' }))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    const poll = w.watch.watch('p1', cursor, 40, live)
    w.happen(text('other'), (m) => (m.state = 'working'))
    expect((await poll).sessions).toEqual([])
  })

  it('answers empty at once when the app cancels the poll', async () => {
    const w = world()
    w.put(session('a'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    const stop = new AbortController()
    const poll = w.watch.watch('p1', cursor, 60_000, stop.signal)
    stop.abort()
    expect((await poll).sessions).toEqual([])
  })

  it('makes a burst one answer', async () => {
    const w = world(30)
    w.put(session('a'))
    w.put(session('b'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    const poll = w.watch.watch('p1', cursor, 5_000, live)
    w.happen(text('a'), (m) => (m.state = 'working'))
    w.happen(text('b'), (m) => (m.state = 'working'))
    expect((await poll).sessions.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })
})

describe('what counts as a change', () => {
  it("does not wake a poll for a working session's every message, but does for the answer it ends with", async () => {
    const w = world()
    w.put(session('a', { state: 'working', lastSeq: 5 }))
    w.happen(text('a'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    // More messages in the turn: lastSeq moves, nothing an app sees does
    for (let i = 0; i < 20; i++) w.happen(text('a'), (m) => (m.lastSeq += 1))
    expect(await w.watch.watch('p1', cursor, 20, live)).toMatchObject({ sessions: [], gone: [] })
    // The turn ends: at rest with a new answer, one change
    w.happen({ type: 'turn_complete', sessionId: 'a' }, (m) => (m.state = 'waiting_input'))
    const done = await w.watch.watch('p1', cursor, 20, live)
    expect(done.sessions.map((s) => [s.state, s.lastSeq])).toEqual([['waiting_input', 25]])
  })

  it('tells a session that stopped on a card, and the person answering it', async () => {
    const w = world()
    w.put(session('a', { state: 'working' }))
    w.happen(text('a'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    w.happen({ type: 'question_request', sessionId: 'a', requestId: 'q', questions: [] } as unknown as NormalizedEvent, (m) => {
      m.state = 'waiting_approval'
      m.pendingQuestions = [{ requestId: 'q', questions: [] }]
    })
    const asked = await w.watch.watch('p1', cursor, 20, live)
    expect(asked.sessions[0]).toMatchObject({ state: 'waiting_approval', pending: { approvals: 0, questions: 1 } })
  })

  it('carries when the host last saw the session do anything, without waking a poll for it', async () => {
    let now = 1_000
    const held = new Map([['a', session('a', { state: 'working' })]])
    const watch = new SessionWatch({ get: (id) => held.get(id), all: () => [...held.values()], live: () => true, leaving: () => false, now: () => now })
    watch.observe(text('a'))
    now = 9_000
    const first = await watch.watch('p1', undefined, 0, live)
    expect(first.sessions[0]!.activeAt).toBe(1_000)
    now = 20_000
    watch.observe(text('a'))
    expect(await watch.watch('p1', first.cursor, 20, live)).toMatchObject({ sessions: [] })
    expect((await watch.watch('p1', undefined, 0, live)).sessions[0]!.activeAt).toBe(20_000)
  })
})

describe('a session that goes', () => {
  it('is told as gone, also when the app saw it only in a snapshot', async () => {
    const w = world()
    w.put(session('a'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    w.held.delete('a')
    w.happen(deleted('a'))
    expect(await w.watch.watch('p1', cursor, 20, live)).toMatchObject({ full: false, sessions: [], gone: ['a'] })
  })

  it('is no longer there for an app once it is on its way to the trash', async () => {
    const w = world()
    w.put(session('a'))
    w.put(session('b'))
    w.leaving.add('a')
    expect((await w.watch.watch('p1', undefined, 0, live)).sessions.map((s) => s.id)).toEqual(['b'])
  })
})

describe('a cursor the host cannot follow', () => {
  it('is answered with every session: one of another host (a swap), a made-up one, and one that is ahead', async () => {
    const w = world()
    w.put(session('a'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    const rev = cursor.split('.')[1]
    for (const bad of [`deadbeef.${rev}`, 'nonsense', `${w.watch.epoch}.-1`, `${w.watch.epoch}.9999`, `${w.watch.epoch}.x`, '']) {
      const got = await w.watch.watch('p1', bad, 5_000, live)
      expect(got.full, bad).toBe(true)
      expect(got.sessions.map((s) => s.id), bad).toEqual(['a'])
    }
  })

  it('is answered with every session once the ring has overflowed past it, and by changes right up to the edge', async () => {
    const w = world()
    w.put(session('a'))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    const flip = (n: number) => w.happen(text('a'), (m) => (m.name = `n${n}`))
    // The ring holds WATCH_RING changes: a cursor exactly that far behind is still followed, one more is not
    for (let i = 1; i <= WATCH_RING; i++) flip(i)
    const edge = await w.watch.watch('p1', cursor, 0, live)
    expect(edge.full).toBe(false)
    expect(edge.sessions.map((s) => s.name)).toEqual([`n${WATCH_RING}`])
    flip(WATCH_RING + 1)
    expect((await w.watch.watch('p1', cursor, 0, live)).full).toBe(true)
    expect((await w.watch.watch('p1', edge.cursor, 0, live)).full).toBe(false)
  })

  it('is answered with every session when the ring went past its cursor while it waited for a change', async () => {
    const w = world()
    w.put(session('a'))
    w.put(session('other', { projectId: 'p2' }))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    const poll = w.watch.watch('p1', cursor, 5_000, live)
    w.happen(text('a'), (m) => (m.state = 'working'))
    // Other projects' changes fill the ring before the answer goes out
    for (let i = 0; i < WATCH_RING + 5; i++) w.happen(text('other'), (m) => (m.name = `o${i}`))
    const got = await poll
    expect(got.full).toBe(true)
    expect(got.sessions.map((s) => [s.id, s.state])).toEqual([['a', 'working']])
  })

  it('cuts a project of more than a full answer holds to its newest sessions and says so', async () => {
    const w = world()
    for (let i = 0; i < WATCH_ROWS_MAX + 7; i++) w.put(session(`s${i}`, { createdAt: i }))
    const got = await w.watch.watch('p1', undefined, 0, live)
    expect(got.sessions).toHaveLength(WATCH_ROWS_MAX)
    expect(got.truncated).toBe(true)
    expect(got.sessions[0]!.id).toBe(`s${WATCH_ROWS_MAX + 6}`)
  })
})

describe('a session that moves into a project', () => {
  it('is announced to the project it joined, and its going to the one it left (a user-folder app that became a project)', async () => {
    const w = world()
    w.put(session('a', { projectId: null }))
    w.happen(text('a'))
    const left = await w.watch.watch('p1', undefined, 0, live)
    expect(left.sessions).toEqual([])
    const before = left.cursor
    w.happen({ type: 'session_created', sessionId: 'a', session: {} }, (m) => (m.projectId = 'p1'))
    const joined = await w.watch.watch('p1', before, 20, live)
    expect(joined.sessions.map((s) => s.id)).toEqual(['a'])
    // Seen in a snapshot, then moved out again and deleted: the project it was in hears that it went
    const there = await w.watch.watch('p1', undefined, 0, live)
    w.happen({ type: 'session_created', sessionId: 'a', session: {} }, (m) => (m.projectId = 'p2'))
    expect(await w.watch.watch('p1', there.cursor, 20, live)).toMatchObject({ sessions: [], gone: ['a'] })
  })
})

describe('what is kept of a session', () => {
  it('is nothing for an event of a session that is not there, so a late event after a delete leaves nothing behind', async () => {
    let now = 100
    const held = new Map<string, SessionInfo>()
    const watch = new SessionWatch({ get: (id) => held.get(id), all: () => [...held.values()], live: () => true, leaving: () => false, now: () => now })
    now = 500
    watch.observe(text('late'))
    now = 900
    held.set('late', session('late'))
    // Its first activity as the app hears it is when the host started watching, not the stray event of before it existed
    expect((await watch.watch('p1', undefined, 0, live)).sessions[0]!.activeAt).toBe(100)
  })
})

describe('the feed', () => {
  it('tells every listener each change once, with its session and project, and stops when one is removed', () => {
    const w = world()
    w.put(session('a'))
    const heard: string[] = []
    const off = w.watch.onChange((c) => heard.push(`${c.rev}:${c.id}:${c.projectId}`))
    w.happen(text('a'), (m) => (m.state = 'working'))
    w.happen(text('a'))
    w.happen({ type: 'turn_complete', sessionId: 'a' }, (m) => (m.state = 'waiting_input'))
    off()
    w.happen(text('a'), (m) => (m.state = 'working'))
    expect(heard).toEqual(['1:a:p1', '2:a:p1'])
  })
  it('does not let a reader that throws break the event path or the readers after it', async () => {
    const w = world()
    w.put(session('a'))
    const heard: number[] = []
    w.watch.onChange(() => {
      throw new Error('a reader of the feed failed')
    })
    w.watch.onChange((c) => heard.push(c.rev))
    const { cursor } = await w.watch.watch('p1', undefined, 0, live)
    expect(() => w.happen(text('a'), (m) => (m.state = 'working'))).not.toThrow()
    expect(heard).toEqual([1])
    expect((await w.watch.watch('p1', cursor, 20, live)).sessions.map((s) => s.id)).toEqual(['a'])
  })
})
