/**
 * Store regression tests: history and its cursor.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { inlineViewsFromHistory, messagesToChat, useStore } from './store.js'
import { delta, line, readAll, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

/**
 * Reading back further (dogfooding, 2026-09-09: "older conversation does not load above").
 *
 * The conversation the screen holds and the history cursor **must move together.** If they fall out
 * of sync, "earlier conversation" either prepends a range that does not connect to the screen, or the
 * way to load it disappears entirely.
 */
describe('history cursor', () => {
  const many = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: i + 1, role: 'user' as const, kind: 'text' as const,
      payload: { text: `line ${i + 1}` }, ts: i + 1,
    }))

  it('leaving a session while shrinking the window also moves the cursor to the trim point', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h1', sessionInfo('h1'))
    mock.sessions.set('h2', sessionInfo('h2'))
    mock.messages.set('h1', many('h1', 120))
    await useStore.getState().attach(mock)

    await useStore.getState().focusSession('h1')
    await vi.waitFor(() => expect(useStore.getState().chat['h1']?.length).toBe(100))

    await useStore.getState().focusSession('h2')

    const chat = useStore.getState().chat['h1']!
    const info = useStore.getState().history['h1']!
    expect(chat.length).toBe(50)
    // The cursor is at the same spot as the top of the screen — that is what makes the next page line up
    expect(info.oldestSeq).toBe(chat[0]!.seq)
    expect(info.more).toBe(true)
  })

  /*
   * The old assertion was `oldestSeq === chat[0].seq`. It passed while a bug remained: since that
   * `seq` was the render key, `loadOlder` still started reading from the wrong place (#79) even
   * though the cursor was at "the same spot" as the screen. So the actual outcome is checked instead.
   */
  it('a conversation built only from events still has every stored row exactly once when read back to the end', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h3', sessionInfo('h3'))
    mock.messages.set('h3', many('h3', 120))
    await useStore.getState().attach(mock)

    // The event arrived before the screen was opened — only `chat` exists, with no cursor
    mock.emit({ sessionId: 'h3', type: 'message_delta', role: 'assistant', text: 'message that arrived first' } as never)
    await vi.waitFor(() => expect(useStore.getState().chat['h3']).toBeDefined())
    expect(useStore.getState().history['h3']).toBeUndefined()

    await useStore.getState().focusSession('h3')

    expect(await readAll('h3')).toEqual([...Array.from({ length: 120 }, (_, i) => `line ${i + 1}`), 'message that arrived first'])
  })

  it('opens a search hit outside the newest page with context on both sides (#590)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h590', sessionInfo('h590', { live: false }))
    mock.messages.set('h590', many('h590', 260))
    await useStore.getState().attach(mock)

    useStore.getState().openSearchHit('h590', 40)

    await vi.waitFor(() => expect(useStore.getState().chat.h590?.some((row) => row.storedSeq === 40)).toBe(true))
    const rows = useStore.getState().chat.h590!
    expect(rows.map((row) => row.storedSeq)).toEqual(Array.from({ length: 140 }, (_, i) => i + 1))
    expect(useStore.getState().searchTargets.h590).toMatchObject({ seq: 40 })
    expect(mock.resumeCalls).toEqual([])
  })
})

/**
 * The history cursor is set only by the stored number (#79).
 *
 * A live row's `seq` is the render key shared across every session; the `seq` on a row read from
 * history is the number the host assigned within that session. In a session where an event arrives
 * before the screen, if the cursor took the render key instead: a key lower than the stored number
 * leaves a gap in the middle (A), and a key higher appends the newest page a second time (A2). An
 * event arriving mid-read used to discard the page just fetched (B). Measured (2026-09-25): opening
 * the session for an app's requested agent for the first time showed the prompt and the Read/Write
 * cards twice.
 */
describe('the cursor for a session where an event arrives before history (#79)', () => {
  const rows = (id: string, n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: from + i, role: 'user' as const, kind: 'text' as const,
      payload: { text: `L${from + i}` }, ts: from + i,
    }))
  const L = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`)

  /** Reads another session's large history first — makes the render key far larger than the stored number (the measured condition) */
  async function openBigFirst(mock: MockPlatform, id: string) {
    mock.sessions.set(id, sessionInfo(id))
    mock.messages.set(id, rows(id, 1000))
    useStore.getState().focusSession(id)
    await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
  }

  it.each([
    ['the first page', 50],
    ['an older page', 200],
  ])('A: no gap in the middle even when the render key is lower than the stored number — the key overlapping %s\'s number still leaves the viewed row\'s key untouched', async (_where, over) => {
    const mock = new MockPlatform()
    mock.sessions.set('a79-probe', sessionInfo('a79-probe'))
    mock.sessions.set('a79', sessionInfo('a79'))
    await useStore.getState().attach(mock)
    // Measures the next render key and creates a session 200 lines longer than that — the key lands inside the middle of the stored numbers
    mock.emit({ sessionId: 'a79-probe', type: 'tool_call', callId: 'p', summary: { tool: 'Read', title: 'probe' } } as never)
    const n = useStore.getState().chat['a79-probe']![0]!.seq + over
    mock.messages.set('a79', rows('a79', n))

    mock.emit(delta('a79', 'LIVE-D'))
    const key = useStore.getState().chat['a79']![0]!.seq
    expect(key).toBeLessThan(n) // Condition confirmed: the key is inside the stored range
    useStore.getState().focusSession('a79')

    expect(await readAll('a79')).toEqual([...L(n), 'LIVE-D'])
    const chat = useStore.getState().chat['a79']!
    // The screen's row is not redrawn during the merge (same key) — a stored row with the same number steps around it
    expect(chat.find((i) => line(i) === 'LIVE-D')!.seq).toBe(key)
    expect(new Set(chat.map((i) => i.seq)).size).toBe(chat.length)
  })

  it('A2: the newest page is not appended twice even when the render key is higher than the stored number', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a2-79', sessionInfo('a2-79'))
    mock.messages.set('a2-79', rows('a2-79', 20))
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 'a2-big')

    mock.emit(delta('a2-79', 'LIVE-S'))
    expect(useStore.getState().chat['a2-79']![0]!.seq).toBeGreaterThan(21)
    useStore.getState().focusSession('a2-79')

    expect(await readAll('a2-79')).toEqual([...L(20), 'LIVE-S'])
  })

  it('B: a message arriving mid-read never causes the fetched page to be discarded', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('b79', sessionInfo('b79'))
    mock.messages.set('b79', rows('b79', 250))
    await useStore.getState().attach(mock)

    // Like the host: reads the page as of the moment the request was received, and the answer arrives later than an event that came in after it
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = real(...args)
      await gate
      return page
    }
    useStore.getState().focusSession('b79')
    mock.emit(delta('b79', 'LIVE'))
    release()
    mock.agents.loadMessages = real

    expect(await readAll('b79')).toEqual([...L(250), 'LIVE'])
  })

  it("an app's requested agent's session: created in the background and opened for the first time only after it finished still shows everything exactly once (reproducing the measured incident)", async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 'app79-big')

    // The host creates the session in the background (D-1), the app's request enters as the first message, and the agent reads, writes and replies
    const info = sessionInfo('app79', { appId: 'notes' })
    mock.sessions.set('app79', info)
    mock.emit({ type: 'session_created', sessionId: 'app79', session: info } as never)
    const fromApp = { appId: 'notes', projectId: 'p1', name: 'Notes' }
    mock.emit({ type: 'user_message', sessionId: 'app79', seq: 0, text: 'Make a note', fromApp } as never)
    mock.emit({ type: 'tool_call', sessionId: 'app79', callId: 'r', summary: { tool: 'Read', title: 'Read note.md' } } as never)
    mock.emit({ type: 'tool_result', sessionId: 'app79', callId: 'r', ok: true, summary: 'empty' } as never)
    mock.emit({ type: 'tool_call', sessionId: 'app79', callId: 'w', summary: { tool: 'Write', title: 'Write note.md' } } as never)
    mock.emit({ type: 'tool_result', sessionId: 'app79', callId: 'w', ok: true, summary: 'written' } as never)
    mock.emit(delta('app79', 'Done.'))
    mock.emit({ type: 'turn_complete', sessionId: 'app79' } as never)
    expect(useStore.getState().history['app79']).toBeUndefined()
    const key = useStore.getState().chat['app79']!.find((i) => line(i) === 'Write note.md')!.seq

    useStore.getState().focusSession('app79')

    expect(await readAll('app79')).toEqual(['Make a note', 'Read note.md', 'Write note.md', 'Done.'])
    // The card being viewed keeps the same key even after merging with history — it is not redrawn, and the read position (scrollAnchor) stays anchored to that key
    const write = useStore.getState().chat['app79']!.find((i) => line(i) === 'Write note.md')
    expect(write).toMatchObject({ seq: key, result: 'written', ok: true })
  })

  it('events replayed by the initial connection each appear exactly once, in their proper place, even overlapping the page', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('r79', sessionInfo('r79'))
    const approval = { type: 'approval_request', sessionId: 'r79', seq: 30, requestId: 'old', detail: { kind: 'command', command: 'old command' } }
    const resolved = { type: 'approval_resolved', sessionId: 'r79', seq: 31, requestId: 'old', decision: 'allow' }
    const stored = rows('r79', 150).map((r) =>
      r.seq === 148 || r.seq === 150 ? { ...r, role: 'assistant' as const, payload: { text: `L${r.seq}` } }
      : r.seq === 30 || r.seq === 31 ? { ...r, role: 'system' as const, kind: 'approval' as const, payload: r.seq === 30 ? approval : resolved }
      : r,
    )
    mock.messages.set('r79', stored as never)

    // The host replays its buffer to a freshly attached UI — held before the session is registered,
    // then replayed during attach. An old message (21), messages inside the page, and the last reply
    // whose earlier part was pushed out of the buffer (only '150' remains)
    // History never draws approval rows — an approval older than the page has nowhere to find its place, so it is left out
    const replay = [
      { type: 'user_message', sessionId: 'r79', seq: 21, text: 'L21' },
      approval,
      resolved,
      { type: 'message_delta', sessionId: 'r79', seq: 148, role: 'assistant', text: 'L148' },
      { type: 'user_message', sessionId: 'r79', seq: 149, text: 'L149' },
      { type: 'message_delta', sessionId: 'r79', seq: 150, role: 'assistant', text: '150' },
    ]
    for (const e of replay) useStore.getState().dispatchEvent(e as NormalizedEvent)
    await useStore.getState().attach(mock)
    expect(useStore.getState().chat['r79']!.map(line)).toEqual(['L21', 'old command', 'L148', 'L149', '150'])

    useStore.getState().focusSession('r79')

    expect(await readAll('r79')).toEqual(L(150).filter((t) => t !== 'L30' && t !== 'L31'))
  })

  it('history stands first, and an event for the same row that follows is never drawn twice', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('q79', sessionInfo('q79'))
    mock.messages.set('q79', [
      ...rows('q79', 8),
      { sessionId: 'q79', seq: 9, role: 'system', kind: 'tool_call', payload: { callId: 'c9', summary: { tool: 'Read', title: 'T9' } }, ts: 9 },
      { sessionId: 'q79', seq: 10, role: 'system', kind: 'marker', payload: { type: 'compaction', sessionId: 'q79', failed: false }, ts: 10 },
    ])
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('q79')
    await vi.waitFor(() => expect(useStore.getState().history['q79']).toBeDefined())

    // An event for the same row, held in the pen, was replayed later than the page
    for (const e of [
      { type: 'user_message', sessionId: 'q79', seq: 8, text: 'L8' },
      { type: 'tool_call', sessionId: 'q79', seq: 9, callId: 'c9', summary: { tool: 'Read', title: 'T9' } },
      { type: 'compaction', sessionId: 'q79', seq: 10, failed: false },
    ]) useStore.getState().dispatchEvent(e as NormalizedEvent)

    expect(useStore.getState().chat['q79']!.map(line)).toEqual([...L(8), 'T9', 'Earlier messages were compacted here'])
  })

  it('a streaming message is never truncated by merging with history — the screen version is longer than the stored text', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('s79', sessionInfo('s79'))
    mock.messages.set('s79', rows('s79', 10))
    await useStore.getState().attach(mock)
    mock.emit(delta('s79', 'Hel'))

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = real(...args)
      await gate
      return page
    }
    useStore.getState().focusSession('s79')
    // A chunk that arrived after the page was read — the store's own version of that message is still 'Hel'
    mock.emit(delta('s79', 'lo'))
    release()
    mock.agents.loadMessages = real

    expect(await readAll('s79')).toEqual([...L(10), 'Hello'])
  })

  it('a tail (a sent message and an image numbered, an error not) already in history shows only once, and an approval row stays in its own place', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('e79', sessionInfo('e79'))
    mock.sessions.set('e79-other', sessionInfo('e79-other'))
    mock.messages.set('e79', rows('e79', 5))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('e79-other')

    // Before this session is opened: a command that went through approval, a human message (numbered by
    // its user_message, as the host announces it, #999), an agent's image (numbered like any recorded
    // row since #868), a failed turn (the schema strips the number, #161)
    mock.emit({ type: 'approval_request', sessionId: 'e79', requestId: 'q1', detail: { kind: 'command', command: 'rm -rf build' } } as never)
    mock.emit({ type: 'approval_resolved', sessionId: 'e79', requestId: 'q1', decision: 'allow' } as never)
    await useStore.getState().send('e79', 'Hi')
    mock.emit({ type: 'message_image', sessionId: 'e79', mime: 'image/png', data: 'aWJs' } as never)
    const error = { type: 'error', sessionId: 'e79', error: { code: 'internal', message: 'boom', retryable: false } }
    mock.messages.get('e79')!.push({ sessionId: 'e79', seq: 10, role: 'system', kind: 'marker', payload: error, ts: 10 })
    useStore.getState().dispatchEvent(error as NormalizedEvent)
    expect(useStore.getState().chat['e79']!.map((i) => i.storedSeq)).toEqual([6, 8, 9, undefined])

    useStore.getState().focusSession('e79')

    expect(await readAll('e79')).toEqual([
      ...L(5), 'rm -rf build', 'Hi', 'image:image/png', 'The agent could not finish this turn — boom',
    ])
  })

  it('a session restored by importing also has each row exactly once when read back to the end — a number already on screen is never appended a second time', async () => {
    const mock = new MockPlatform()
    mock.externalHistory.set('ext-79', Array.from({ length: 150 }, (_, i) => ({ role: 'user' as const, text: `L${i + 1}` })))
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/imp79')
    const info = await useStore.getState().createSession(p.id, { resumeExternalId: 'ext-79', importHistory: true })

    expect(await readAll(info.id)).toEqual(L(150))
  })

  it('a message that started with an unstored, unnumbered empty chunk still receives the stored number of the chunk that follows — it is never duplicated when merging', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('d79', sessionInfo('d79'))
    mock.messages.set('d79', rows('d79', 3))
    await useStore.getState().attach(mock)

    // The host never stores an empty chunk and sends it with no number (codex's trailing ""). The chunk that follows starts row 4
    useStore.getState().dispatchEvent(delta('d79', ''))
    mock.emit(delta('d79', 'Answer'))
    useStore.getState().focusSession('d79')

    expect(await readAll('d79')).toEqual([...L(3), 'Answer'])
  })

  it('when trimming the window, the cursor is still the stored number even if the top row is a live one', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('t79', sessionInfo('t79'))
    mock.sessions.set('t79-other', sessionInfo('t79-other'))
    mock.messages.set('t79', rows('t79', 120))
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 't79-big')
    useStore.getState().focusSession('t79')
    await vi.waitFor(() => expect(useStore.getState().history['t79']).toBeDefined())

    // 60 tool calls follow while it is being viewed — all 50 rows left when leaving are live rows
    for (let i = 121; i <= 180; i++) {
      mock.emit({ sessionId: 't79', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    useStore.getState().focusSession('t79-other')
    expect(useStore.getState().chat['t79']).toHaveLength(50)
    expect(useStore.getState().history['t79']!.oldestSeq).toBe(131)

    useStore.getState().focusSession('t79')
    expect(await readAll('t79')).toEqual(L(180))
  })

  it('a session that is never on screen does not keep every event it receives', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('off-bg', sessionInfo('off-bg'))
    mock.sessions.set('off-seen', sessionInfo('off-seen'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('off-seen')

    // A worker nobody opens — the trim on losing focus never reaches it
    for (let i = 1; i <= 300; i++) {
      mock.emit({ sessionId: 'off-bg', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    expect(useStore.getState().chat['off-bg']!.length).toBeLessThanOrEqual(100)

    // Nothing is lost: opening it reads the cut rows back from the store
    useStore.getState().focusSession('off-bg')
    expect(await readAll('off-bg')).toEqual(L(300))
  })

  it('the conversation on screen is never cut while it is being read', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('off-focused', sessionInfo('off-focused'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('off-focused')
    await vi.waitFor(() => expect(useStore.getState().history['off-focused']).toBeDefined())

    for (let i = 1; i <= 300; i++) {
      mock.emit({ sessionId: 'off-focused', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    expect(useStore.getState().chat['off-focused']).toHaveLength(300)
  })

  it('an off-screen conversation is not cut while a page of its history is on the way', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('off-paging', sessionInfo('off-paging'))
    mock.sessions.set('off-paging-other', sessionInfo('off-paging-other'))
    mock.messages.set('off-paging', rows('off-paging', 130))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('off-paging')
    await vi.waitFor(() => expect(useStore.getState().history['off-paging']).toBeDefined())
    // Leaving cuts it to the window: rows 81..130, with older rows still to read
    useStore.getState().focusSession('off-paging-other')
    expect(useStore.getState().history['off-paging']).toMatchObject({ oldestSeq: 81, more: true })

    // A page of older rows is asked for and held on its way
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = await real(...args)
      await gate
      return page
    }
    const paging = useStore.getState().loadOlder('off-paging')
    expect(useStore.getState().history['off-paging']!.loading).toBe(true)

    // Meanwhile the session keeps working off screen, past the point where it would be cut
    for (let i = 131; i <= 190; i++) {
      mock.emit({ sessionId: 'off-paging', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    release()
    await paging
    mock.agents.loadMessages = real

    // The page joins the rows it was asked for: no gap between it and the rest
    expect(useStore.getState().chat['off-paging']!.map(line)).toEqual(L(190))
  })

  it('a re-read in the middle of reading back keeps the pages already read, and the cursor with them', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mid-read', sessionInfo('mid-read'))
    mock.messages.set('mid-read', rows('mid-read', 350))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('mid-read')
    await vi.waitFor(() => expect(useStore.getState().history['mid-read']).toBeDefined())
    await useStore.getState().loadOlder('mid-read')
    await useStore.getState().loadOlder('mid-read')
    expect(useStore.getState().chat['mid-read']!.map(line)[0]).toBe('L51')

    // The resumed session caught up on a line said elsewhere: the host announces it and the screen reads again
    mock.messages.set('mid-read', rows('mid-read', 351))
    useStore.getState().dispatchEvent({ type: 'history_synced', sessionId: 'mid-read', added: 1 } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().chat['mid-read']!.map(line).at(-1)).toBe('L351'))

    // Still where the person was reading, not snapped back to the last page
    expect(useStore.getState().chat['mid-read']!.map(line)).toEqual(L(351).slice(50))
    expect(useStore.getState().history['mid-read']).toMatchObject({ oldestSeq: 51, more: true, loading: false })
    expect(await readAll('mid-read')).toEqual(L(351))
  })

  it('a page of older rows that lands after a re-read moved the cursor is dropped, leaving no gap', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('raced', sessionInfo('raced'))
    mock.messages.set('raced', rows('raced', 350))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('raced')
    await vi.waitFor(() => expect(useStore.getState().history['raced']).toMatchObject({ oldestSeq: 251 }))

    // "Earlier messages" is asked for, and its page is held on the way
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = await real(...args)
      if (args[2] !== undefined) await gate
      return page
    }
    const paging = useStore.getState().loadOlder('raced')

    // Meanwhile a hundred lines were said elsewhere, and a re-read lands first: a gap the screen cannot bridge, so it shows the new page
    mock.messages.set('raced', rows('raced', 450))
    await useStore.getState().loadHistory('raced')
    expect(useStore.getState().history['raced']).toMatchObject({ oldestSeq: 351 })

    release()
    await paging
    mock.agents.loadMessages = real

    expect(await readAll('raced')).toEqual(L(450))
  })

  it.each(['orchestrator', 'grid'] as const)(
    'the focused session keeps everything it loaded while the %s is on screen',
    async (view) => {
      const mock = new MockPlatform()
      mock.sessions.set('off-kept', sessionInfo('off-kept'))
      mock.messages.set('off-kept', rows('off-kept', 150))
      await useStore.getState().attach(mock)
      useStore.getState().focusSession('off-kept')
      expect(await readAll('off-kept')).toEqual(L(150))

      // Looking elsewhere does not take focus: the session stays focused, only the view changes
      useStore.getState().setView(view)
      mock.emit({ sessionId: 'off-kept', type: 'tool_call', callId: 'c151', summary: { tool: 'Read', title: 'L151' } } as never)

      const st = useStore.getState()
      expect(st.focusedSessionId).toBe('off-kept')
      expect(st.chat['off-kept']!.map(line)).toEqual(L(151))
      expect(st.history['off-kept']).toMatchObject({ oldestSeq: 1, more: false })
    },
  )
})

/**
 * When a non-conversation event arrives before history is read (dogfooding, 2026-09-25).
 *
 * Reopening the app showed an 11,550-line session as completely empty. A state or usage event the
 * host sent while resuming the session created `chat[id] = []` before the user ever clicked that
 * session, and focusing read that empty array as "already read," so history was never called. There
 * was no error either.
 */
describe('an event arriving before history', () => {
  const many = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: i + 1, role: 'user' as const, kind: 'text' as const,
      payload: { text: `line ${i + 1}` }, ts: i + 1,
    }))
  const quiet = [
    ['state_change', { type: 'state_change', state: 'idle' }],
    ['context_usage', { type: 'context_usage', used: 111693, window: 1000000, exactness: 'exact' }],
  ] as const

  it.each(quiet)('even if %s arrives first, clicking that session still shows history', async (_name, ev) => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('b', sessionInfo('b'))
    mock.messages.set('b', many('b', 50))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    mock.emit({ sessionId: 'b', ...ev } as unknown as NormalizedEvent)
    useStore.getState().focusSession('b')

    await vi.waitFor(() => expect(useStore.getState().chat['b']).toHaveLength(50))
    expect(useStore.getState().history['b']?.more).toBe(false)
  })

  it('a non-conversation event slipping in mid-read never discards history', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('c', sessionInfo('c'))
    mock.messages.set('c', many('c', 30))
    await useStore.getState().attach(mock)

    // Holds back the answer so the event arrives after the history request goes out but before the answer comes back
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      await gate
      return real(...args)
    }

    const loading = useStore.getState().loadHistory('c')
    mock.emit({ sessionId: 'c', type: 'state_change', state: 'idle' } as unknown as NormalizedEvent)
    release()
    await loading

    expect(useStore.getState().chat['c']).toHaveLength(30)
  })

  /*
   * The actual fix is here: a non-conversation event never creates a slot. `chat[id]` being absent is
   * used throughout the store as "not read yet" (focus, session creation). The two safeguards below
   * catch this at load time, so this promise would silently break without a test pinning it down on
   * its own.
   */
  it.each(quiet)('%s never creates an empty slot for an unread session', async (_name, ev) => {
    const mock = new MockPlatform()
    mock.sessions.set('g', sessionInfo('g'))
    await useStore.getState().attach(mock)

    mock.emit({ sessionId: 'g', ...ev } as unknown as NormalizedEvent)

    expect(useStore.getState().chat['g']).toBeUndefined()
    // State is still applied as usual — not creating a slot does not mean discarding the event
    expect(useStore.getState().sessions['g']).toBeDefined()
  })

  /*
   * The two below pin down the rule itself, **independent of any event**: an empty slot is treated the
   * same as never having read it. An event is not the only way an empty array gets created (a filter
   * that undoes an optimistically drawn row can also empty it). The tests above never see these two
   * safeguards, since the event-side fix already blocks it.
   */
  it('clicking a session with an empty slot and no cursor still calls history — no matter where the empty slot came from', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('e', sessionInfo('e'))
    mock.messages.set('e', many('e', 20))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    useStore.setState((s) => ({ chat: { ...s.chat, e: [] } }))
    useStore.getState().focusSession('e')

    await vi.waitFor(() => expect(useStore.getState().chat['e']).toHaveLength(20))
  })

  it('if the slot is still empty by the time history arrives, history fills it — no matter where the empty slot came from', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('f', sessionInfo('f'))
    mock.messages.set('f', many('f', 25))
    await useStore.getState().attach(mock)

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      await gate
      return real(...args)
    }
    const loading = useStore.getState().loadHistory('f')
    useStore.setState((s) => ({ chat: { ...s.chat, f: [] } }))
    release()
    await loading

    expect(useStore.getState().chat['f']).toHaveLength(25)
  })

  it('even when a row already exists on screen, it is merged with history rather than cleared (the promise from 09-09, #79)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('d', sessionInfo('d'))
    mock.messages.set('d', many('d', 40))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    // A streaming message arrived first — this is a row that must never be cleared
    mock.emit(delta('d', 'writing right now'))
    useStore.getState().focusSession('d')
    await new Promise((r) => setTimeout(r, 20))

    const chat = useStore.getState().chat['d']!
    expect(chat.map((i) => (i as { text?: string }).text)).toContain('writing right now')
    expect(useStore.getState().history['d']).toBeDefined()
  })
})

/**
 * Restoring the slot of an in-conversation app view (M4 B-1). History carries no body, only "some
 * app's view stood (or was rejected) under this card" — a reopened UI stands a placeholder on that
 * card. Whether it can be reopened is unknown until the host is asked (`kept: false`). A history row
 * for an app view never becomes a conversation row (`ChatItem`).
 */
describe('inlineViewsFromHistory — a past card\'s app view slot', () => {
  const row = (seq: number, payload: Record<string, unknown>) =>
    ({ sessionId: 's-hist', seq, role: 'system' as const, kind: 'app_view' as const, payload, ts: 0 })
  const call = (seq: number, callId: string) =>
    ({ sessionId: 's-hist', seq, role: 'system' as const, kind: 'tool_call' as const, payload: { type: 'tool_call', callId, summary: { tool: 'mcp__app-viewer__show', title: 'show', paths: [] } }, ts: 0 })

  it('an open becomes a placeholder of unknown reopenability, a rejection a placeholder with only a reason — the same card lets the later row win', () => {
    const msgs = [
      call(1, 'c-open'),
      row(2, { type: 'app_view', callId: 'c-open', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'open' }),
      call(3, 'c-spoof'),
      row(4, { type: 'app_view', callId: 'c-spoof', appId: 'viewer', projectId: null, tool: 'spoof', phase: 'rejected', reason: 'This app does not serve ui://other/main' }),
      call(5, 'c-late'),
      row(6, { type: 'app_view', callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'open' }),
      row(7, { type: 'app_view', callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'rejected', reason: "This call's result points at ui://other/main" }),
      // A malformed row is discarded
      row(8, { type: 'app_view', phase: 'open' }),
    ]
    expect(inlineViewsFromHistory(msgs)).toEqual({
      'c-open': { callId: 'c-open', appId: 'viewer', projectId: 'p1', tool: 'show', state: 'parked', instanceId: null, kept: false, liveAt: 0 },
      'c-spoof': {
        callId: 'c-spoof', appId: 'viewer', projectId: null, tool: 'spoof', state: 'parked', instanceId: null, kept: false, liveAt: 0,
        rejected: 'This app does not serve ui://other/main', reason: 'This app does not serve ui://other/main',
      },
      'c-late': {
        callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', state: 'parked', instanceId: null, kept: false, liveAt: 0,
        rejected: "This call's result points at ui://other/main", reason: "This call's result points at ui://other/main",
      },
    })
    // The conversation's rows are only the three cards — a history row for an app view never becomes a row
    expect(messagesToChat(msgs).map((i) => i.kind)).toEqual(['tool', 'tool', 'tool'])
  })
})
