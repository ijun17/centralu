/**
 * Store regression tests: the conversation, its rows and the composer.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { composerTarget, droppedQuestionsText, messagesToChat, useStore, type ChatItem } from './store.js'
import { delta, line, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

/*
 * When the current turn started (issue #23).
 *
 * The "Waiting for response" line counted up from its own mount, so any remount put a
 * three-minute turn back at zero. The instant lives here now and the count is derived from
 * it — which only helps if the instant itself holds still while a turn streams, and is let
 * go when the turn ends. Both are what these check.
 *
 * It is deliberately not `waitingSince`: that one is when a session started waiting for a
 * *human*, and the reducer nulls it the moment a session goes back to working.
 */
describe('the instant a turn started (issue #23)', () => {
  it('the instant does not move while streaming continues — elapsed time is derived from it', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s1', sessionInfo('ws-s1'))
    await useStore.getState().attach(mock)

    useStore.getState().dispatchEvent(delta('ws-s1', 'first letter'))
    const started = useStore.getState().workingSince['ws-s1']
    expect(started).toBeDefined()
    expect(useStore.getState().sessions['ws-s1']!.state).toBe('working')

    useStore.getState().dispatchEvent(delta('ws-s1', ' and then more'))
    expect(useStore.getState().workingSince['ws-s1']).toBe(started)
  })

  it('the instant is released once a turn ends — the next turn must never inherit someone else\'s start', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s2', sessionInfo('ws-s2'))
    await useStore.getState().attach(mock)

    useStore.getState().dispatchEvent(delta('ws-s2', 'reply'))
    expect(useStore.getState().workingSince['ws-s2']).toBeDefined()

    useStore.getState().dispatchEvent({ sessionId: 'ws-s2', type: 'turn_complete' } as NormalizedEvent)
    expect(useStore.getState().sessions['ws-s2']!.state).toBe('waiting_input')
    expect(useStore.getState().workingSince['ws-s2']).toBeUndefined()
  })

  it('a session that was already running before the app was opened also gets an instant stamped — with none, the screen has nothing to count from', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s3', sessionInfo('ws-s3', { state: 'working' }))

    await useStore.getState().attach(mock)

    // The host never tells us when the turn really started — the moment we found out is the earliest honest answer
    expect(useStore.getState().workingSince['ws-s3']).toBeDefined()
  })
})

describe('preventing the opening prompt from being drawn twice', () => {
  it('the host\'s user_message confirmation settles the optimistic opening prompt — it is never drawn twice', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/ip')
    const info = await useStore.getState().createSession(p.id, { initialPrompt: 'first instruction' })

    // The host also stores and announces the opening prompt (the `user_message` in manager.createSession)
    // — the mock also announces it before the response (#172). Even if the same confirmation arrives a
    // second time (reconnect replay), it is never drawn twice
    useStore
      .getState()
      .dispatchEvent({ type: 'user_message', sessionId: info.id, seq: 1, text: 'first instruction' } as NormalizedEvent)

    const users = useStore.getState().chat[info.id]!.filter((i) => i.kind === 'user')
    expect(users).toHaveLength(1)
    expect((users[0] as { pending?: boolean }).pending).toBeFalsy()
  })
})

describe('whether a conversation stood at the bottom (issue #31)', () => {
  it('a session nobody has scrolled is treated as being at the bottom — a conversation starts at its newest line', () => {
    expect(useStore.getState().stickToBottom['sb-s1']).toBeUndefined()
  })

  it('scrolling up to read leaves that fact recorded on the session', () => {
    useStore.getState().setStickToBottom('sb-s1', false)
    expect(useStore.getState().stickToBottom['sb-s1']).toBe(false)
  })

  /*
   * The default (bottom) is recorded **by not being recorded**. That way, an entry does not pile up
   * for every session that was merely passed through — the same rule as an unfinished draft clearing
   * itself once emptied.
   */
  it('returning to the bottom makes the entry itself disappear', () => {
    useStore.getState().setStickToBottom('sb-s2', false)
    useStore.getState().setStickToBottom('sb-s2', true)
    expect('sb-s2' in useStore.getState().stickToBottom).toBe(false)
  })

  /*
   * A single scroll fires dozens of events. If a new object were created even when the value stays
   * the same, every subscriber watching this map would re-render for the entire scroll.
   */
  it('an unchanged value never creates a new state object — scrolling fires dozens of times a second', () => {
    useStore.getState().setStickToBottom('sb-s3', false)
    const before = useStore.getState().stickToBottom
    useStore.getState().setStickToBottom('sb-s3', false)
    expect(useStore.getState().stickToBottom).toBe(before)
  })
})

describe('messagesToChat — restoring tool output', () => {
  /*
   * The host keeps the call and the result as separate rows. While there was no branch for the
   * result, reopening a session left the card with only its title, its output gone — a screen that
   * had only ever existed for whoever watched it live.
   */
  const call = (seq: number) => ({
    sessionId: 's',
    seq,
    role: 'system' as const,
    kind: 'tool_call' as const,
    payload: { type: 'tool_call', summary: { tool: 'Bash', title: 'pnpm test' } },
    ts: 0,
  })
  const result = (seq: number, summary: string, ok = true) => ({
    sessionId: 's',
    seq,
    role: 'system' as const,
    kind: 'tool_result' as const,
    payload: { type: 'tool_result', callId: 'c1', ok, summary },
    ts: 0,
  })

  it('a result row attaches to a tool row that has no result yet', () => {
    const items = messagesToChat([call(1), result(2, '3 passed')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'tool', result: '3 passed', ok: true })
  })

  it('a restored card keeps the files its call named, so their paths are links as they were live', () => {
    const named = {
      ...call(1),
      payload: { type: 'tool_call', summary: { tool: 'Read', title: 'Read: /repo/a.ts', paths: ['/repo/a.ts'] } },
    }
    expect(messagesToChat([named])[0]).toMatchObject({ kind: 'tool', paths: ['/repo/a.ts'] })
    // A call that named none (and a row written before `paths` was kept) carries no field
    expect(messagesToChat([call(1)])[0]).not.toHaveProperty('paths')
  })

  it('with several calls, they are paired in the order they were emitted — the two are never swapped', () => {
    const items = messagesToChat([call(1), call(2), result(3, 'first'), result(4, 'second', false)])
    expect(items.map((i) => (i.kind === 'tool' ? [i.result, i.ok] : null))).toEqual([
      ['first', true],
      ['second', false],
    ])
  })

  it('a result with no match is discarded — never creates a row that never existed', () => {
    expect(messagesToChat([result(1, 'output with no owner')])).toEqual([])
  })
})

/**
 * A tool row finds its own result and output by `callId` (#98).
 *
 * A background agent's card stays open from the moment it is raised until it finishes (the adapter
 * withholds the result of raising it), and in the meantime the parent uses its own tool. The
 * positional rule (the longest-open row, the last-opened row) swaps ownership between them during
 * that window — the parent's Bash result to the agent's card, the agent's own steps to the parent's
 * Bash card. Both the live and restored paths are checked together.
 */
describe('a tool row finds its pair by callId — beside an open agent card (#98)', () => {
  const agentCall = {
    type: 'tool_call', callId: 'toolu_agent',
    summary: { tool: 'Agent', title: 'Research the build', paths: [] },
  }
  const bashCall = {
    type: 'tool_call', callId: 'toolu_bash',
    summary: { tool: 'Bash', title: 'git status', paths: [] },
  }
  const bashDone = { type: 'tool_result', callId: 'toolu_bash', ok: true, summary: 'nothing to commit' }
  const agentDone = { type: 'tool_result', callId: 'toolu_agent', ok: true, summary: '3 tool uses · 2m 14s\n\nI checked all 13 items' }
  const tools = (items: ReturnType<typeof messagesToChat>) =>
    items.flatMap((i) => (i.kind === 'tool' ? [{ tool: i.tool, result: i.result, live: i.live }] : []))

  it('live: the parent\'s result to the parent\'s card, the agent\'s steps to the agent\'s card', async () => {
    const s = 'cid-live'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    const send = (e: object) => useStore.getState().dispatchEvent({ sessionId: s, ...e } as NormalizedEvent)

    send(agentCall)
    send({ type: 'tool_output_delta', callId: 'toolu_agent', text: 'Running in the background\n' })
    send(bashCall)
    // The agent takes a step while the parent's Bash is still open
    send({ type: 'tool_output_delta', callId: 'toolu_agent', text: 'Grep: boundaries\n' })
    send(bashDone)

    expect(tools(useStore.getState().chat[s] ?? [])).toEqual([
      { tool: 'Agent', result: undefined, live: 'Running in the background\nGrep: boundaries\n' },
      { tool: 'Bash', result: 'nothing to commit', live: undefined },
    ])

    send(agentDone)
    expect(tools(useStore.getState().chat[s] ?? [])[0]).toEqual({
      tool: 'Agent', result: '3 tool uses · 2m 14s\n\nI checked all 13 items', live: undefined,
    })
  })

  it('restoration: finds its own pair even when the stored order differs from the call order', () => {
    const row = (seq: number, kind: 'tool_call' | 'tool_result', payload: object) =>
      ({ sessionId: 's', seq, role: 'system' as const, kind, payload, ts: 0 })
    const items = messagesToChat([
      row(1, 'tool_call', agentCall),
      row(2, 'tool_call', bashCall),
      row(3, 'tool_result', bashDone),
      row(4, 'tool_result', agentDone),
    ])
    expect(tools(items).map((t) => [t.tool, t.result])).toEqual([
      ['Agent', '3 tool uses · 2m 14s\n\nI checked all 13 items'],
      ['Bash', 'nothing to commit'],
    ])
  })

  it('restoration: a result whose call sits outside this batch never grabs an open agent card', () => {
    const items = messagesToChat([
      { sessionId: 's', seq: 1, role: 'system', kind: 'tool_call', payload: agentCall, ts: 0 },
      { sessionId: 's', seq: 2, role: 'system', kind: 'tool_result', payload: { ...bashDone, callId: 'toolu_elsewhere' }, ts: 0 },
    ])
    expect(tools(items)).toEqual([{ tool: 'Agent', result: undefined, live: undefined }])
  })
})

/**
 * A launch card's subagent steps (#222): read only when the person opens them, never part of the conversation, and
 * joined live by later steps once every earlier one is read.
 */
describe('a subagent\'s steps under its launch card (#222)', () => {
  const AGENT = 'toolu_agent'
  const step = (sessionId: string, s: object) =>
    ({ type: 'subagent_event', sessionId, parentCallId: AGENT, step: { sessionId, ...s } }) as NormalizedEvent
  const grep = (sessionId: string) =>
    step(sessionId, { type: 'tool_call', callId: 'toolu_sub', summary: { tool: 'Grep', title: 'Grep: boundaries', paths: [] } })
  const grepDone = (sessionId: string) => step(sessionId, { type: 'tool_result', callId: 'toolu_sub', ok: true, summary: 'tooling/boundaries.test.ts' })
  const said = (sessionId: string, text: string) => step(sessionId, { type: 'message_delta', role: 'assistant', text })

  const setup = async (s: string) => {
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.emit({ sessionId: s, type: 'tool_call', callId: AGENT, summary: { tool: 'Agent', title: 'Research', paths: [] } } as NormalizedEvent)
    return mock
  }
  const steps = (s: string) => messagesToChat(useStore.getState().subagentSteps[s]?.[AGENT]?.rows ?? []).map(line)

  it('a step is not the conversation: no row, no unread, no state change, nothing read until the card is opened', async () => {
    const s = 'sub-quiet'
    const mock = await setup(s)
    const before = useStore.getState().sessions[s]!
    const chat = useStore.getState().chat[s]
    mock.emit(grep(s))
    mock.emit(said(s, 'The test holds.'))
    expect(useStore.getState().chat[s]).toBe(chat)
    expect(useStore.getState().sessions[s]).toBe(before)
    expect(useStore.getState().subagentSteps[s]).toBeUndefined()
    expect(mock.subagentReads).toBe(0)
  })

  it('opening the card reads its steps once; closing and opening again does not read them again', async () => {
    const s = 'sub-open'
    const mock = await setup(s)
    mock.emit(grep(s))
    mock.emit(grepDone(s))
    mock.emit(said(s, 'The test holds.'))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries', 'The test holds.']))
    expect(messagesToChat(useStore.getState().subagentSteps[s]![AGENT]!.rows)[0]).toMatchObject({ result: 'tooling/boundaries.test.ts' })
    useStore.getState().toggleSubagentSteps(s, AGENT)
    expect(useStore.getState().subagentSteps[s]![AGENT]!.open).toBe(false)
    useStore.getState().toggleSubagentSteps(s, AGENT)
    expect(mock.subagentReads).toBe(1)
  })

  it('a later step joins an opened card live, once, and not while earlier pages are unread', async () => {
    const s = 'sub-live'
    const mock = await setup(s)
    mock.emit(grep(s))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries']))
    mock.emit(grepDone(s))
    mock.emit(said(s, 'Found it.'))
    // The same step arriving again (a replay) is drawn once
    useStore.getState().dispatchEvent({ ...(said(s, 'Found it.') as object), stepSeq: 3 } as NormalizedEvent)
    expect(steps(s)).toEqual(['Grep: boundaries', 'Found it.'])

    useStore.setState((st) => ({ subagentSteps: { ...st.subagentSteps, [s]: { [AGENT]: { ...st.subagentSteps[s]![AGENT]!, more: true } } } }))
    mock.emit(said(s, 'Past an unread page.'))
    expect(steps(s)).toEqual(['Grep: boundaries', 'Found it.'])
  })

  it('a closed card lets go of its steps when its conversation is cut back to the window, and reads them again when opened (#392)', async () => {
    const s = 'sub-trim'
    const mock = await setup(s)
    mock.sessions.set('sub-other', sessionInfo('sub-other'))
    await useStore.getState().attach(mock)
    mock.emit(grep(s))
    useStore.getState().focusSession(s)
    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries']))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    const OPEN = 'toolu_still_open'
    useStore.setState((st) => ({
      // A conversation longer than the window, so leaving it cuts it back; and a second card the person left open
      chat: { ...st.chat, [s]: Array.from({ length: 120 }, (_, i) => ({ kind: 'assistant', seq: i + 1, storedSeq: i + 1, text: `L${i + 1}` }) as ChatItem) },
      subagentSteps: { ...st.subagentSteps, [s]: { ...st.subagentSteps[s], [OPEN]: { open: true, rows: [], more: false, loading: false, error: null } } },
    }))

    useStore.getState().focusSession('sub-other')
    expect(useStore.getState().chat[s]!.length).toBeLessThan(120)
    expect(Object.keys(useStore.getState().subagentSteps[s] ?? {})).toEqual([OPEN])

    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries']))
    expect(mock.subagentReads).toBe(2)
  })

  it('so does a closed card of a session that is not on screen, when the off-screen trim cuts it (#392)', async () => {
    const s = 'sub-offscreen'
    const mock = await setup(s)
    mock.sessions.set('sub-seen', sessionInfo('sub-seen'))
    await useStore.getState().attach(mock)
    mock.emit(grep(s))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries']))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    useStore.getState().focusSession('sub-seen')
    for (let i = 1; i <= 300; i++) {
      mock.emit({ sessionId: s, type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    expect(useStore.getState().chat[s]!.length).toBeLessThanOrEqual(100)
    expect(useStore.getState().subagentSteps[s]?.[AGENT]).toBeUndefined()
  })
})

/**
 * A failed turn **must be visible** (#107).
 *
 * An actual incident: a codex rollout carried the full 400 error in `task_complete`, but the app kept
 * an empty reply and a state of `waiting_input`. "Waiting for a human" was a lie — what needed waiting
 * for was an explanation, not a person. Both halves are checked together: does it survive in the
 * transcript, and is the state honest.
 */
describe('a failed turn reaches the screen (#107)', () => {
  const boom = (sessionId: string, message: string) =>
    ({ type: 'error', sessionId, error: { code: 'internal', message, retryable: true } }) as NormalizedEvent

  it('the error stands as one line in the transcript, and the session does not pretend to be idle', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('err-1', sessionInfo('err-1'))
    await useStore.getState().attach(mock)

    mock.emit(boom('err-1', "The 'opus[1m]' model is not supported"))

    const last = (useStore.getState().chat['err-1'] ?? []).at(-1)
    expect(last?.kind).toBe('mark')
    expect((last as { text: string }).text).toContain("The 'opus[1m]' model is not supported")
    expect(useStore.getState().sessions['err-1']?.state).toBe('error')
  })

  it('the line is still there after reopening — an error is stored as a marker', () => {
    const items = messagesToChat([
      {
        sessionId: 'err-2', seq: 4, role: 'system', kind: 'marker', ts: 1,
        payload: { type: 'error', sessionId: 'err-2', error: { code: 'internal', message: '400 invalid_request_error' } },
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'mark', seq: 4 })
    expect((items[0] as { text: string }).text).toContain('400 invalid_request_error')
  })
})

describe('messagesToChat — image rows (#40, second pass)', () => {
  it('a persisted image is restored into the conversation', () => {
    const items = messagesToChat([
      {
        sessionId: 's1', seq: 1, role: 'system', kind: 'image', ts: 1,
        payload: { type: 'message_image', sessionId: 's1', mime: 'image/png', data: 'aWJs', path: '/tmp/a.png' },
      },
    ])
    expect(items).toEqual([{ kind: 'image', seq: 1, storedSeq: 1, mime: 'image/png', data: 'aWJs', path: '/tmp/a.png', note: undefined }])
  })

  it('a cleaned-up image is restored with its reason — not a silent gap', () => {
    const items = messagesToChat([
      {
        sessionId: 's1', seq: 2, role: 'system', kind: 'image', ts: 1,
        payload: { type: 'message_image', sessionId: 's1', mime: 'image/png', data: '', path: '/tmp/b.png', note: 'The image was cleared and no longer exists (total-size cap)' },
      },
    ])
    expect(items[0]).toMatchObject({ kind: 'image', data: '', note: expect.stringContaining('cleared') })
  })
})

/** A reasoning summary (#58) — delta rows are restored as one block (the same rule as `assistant`) */
describe('messagesToChat — reasoning rows', () => {
  it('neighboring reasoning rows are different thoughts — they are never merged (#77)', () => {
    const row = (seq: number, kind: 'reasoning' | 'text', text: string) => ({
      sessionId: 's1', seq, role: 'assistant' as const, kind, ts: 1,
      payload: { type: kind === 'text' ? 'message_delta' : 'reasoning_delta', sessionId: 's1', text },
    })
    const items = messagesToChat([row(1, 'reasoning', '**Path review**'), row(2, 'reasoning', '**Test check**'), row(3, 'text', 'reply')])
    expect(items).toEqual([
      { kind: 'reasoning', seq: 1, storedSeq: 1, text: '**Path review**' },
      { kind: 'reasoning', seq: 2, storedSeq: 2, text: '**Test check**' },
      { kind: 'assistant', seq: 3, storedSeq: 3, text: 'reply' },
    ])
  })
})

/*
 * Two neighboring replies are two blocks (#77). A new reply with no human message in between (a
 * background task finished, a question card was answered) used to run together with the reply before
 * it, with no gap: "…still running.All six reviews are in." Messages are split by stored number — the
 * host groups a message's chunks into one row and carries that row's number on every chunk (#66). The
 * mock numbers them by the same rule.
 */
describe('neighboring replies are split by stored number (#77)', () => {
  const ask = (sessionId: string, seq: number, text: string) =>
    ({ sessionId, seq, role: 'user' as const, kind: 'text' as const, payload: { text }, ts: seq })
  const reply = (sessionId: string, seq: number, text: string) =>
    ({ sessionId, seq, role: 'assistant' as const, kind: 'text' as const, payload: { type: 'message_delta', text }, ts: seq })
  const shape = (id: string) => useStore.getState().chat[id]!.map((i) => [i.kind, i.storedSeq, line(i)])

  /** Opens a session whose history has four rows — the next message is number 5 */
  async function opened(id: string) {
    const mock = new MockPlatform()
    mock.sessions.set(id, sessionInfo(id))
    mock.messages.set(id, [ask(id, 1, 'question'), reply(id, 2, 'reply'), ask(id, 3, 'Run the review'), reply(id, 4, 'Six reviews started.')])
    await useStore.getState().attach(mock)
    useStore.getState().focusSession(id)
    await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
    return mock
  }

  it('a chunk of message 6 arriving after a chunk of message 5 makes two items', async () => {
    const mock = await opened('s77-a')
    mock.emit(delta('s77-a', 'One review '))
    mock.emit(delta('s77-a', 'is still running.'))
    // The turn ends, and a new turn stands with no human message in between (a background task finished)
    mock.emit({ type: 'turn_complete', sessionId: 's77-a' } as never)
    mock.emit(delta('s77-a', 'All six reviews are in.'))
    expect(shape('s77-a').slice(-2)).toEqual([
      ['assistant', 5, 'One review is still running.'],
      ['assistant', 6, 'All six reviews are in.'],
    ])
  })

  it('chunks with the same number are gathered into one item — reasoning too', async () => {
    const mock = await opened('s77-b')
    mock.emit({ type: 'reasoning_delta', sessionId: 's77-b', text: '**Path ' } as never)
    mock.emit({ type: 'reasoning_delta', sessionId: 's77-b', text: 'review**' } as never)
    mock.emit(delta('s77-b', 'One review '))
    mock.emit(delta('s77-b', 'is still running.'))
    expect(shape('s77-b').slice(-2)).toEqual([
      ['reasoning', 5, '**Path review**'],
      ['assistant', 6, 'One review is still running.'],
    ])
  })

  it('reasoning with a different number also makes two items', async () => {
    const mock = await opened('s77-c')
    mock.emit({ type: 'reasoning_delta', sessionId: 's77-c', text: "the previous turn's thought" } as never)
    mock.emit({ type: 'turn_complete', sessionId: 's77-c' } as never)
    mock.emit({ type: 'reasoning_delta', sessionId: 's77-c', text: "the new turn's thought" } as never)
    expect(shape('s77-c').slice(-2)).toEqual([
      ['reasoning', 5, "the previous turn's thought"],
      ['reasoning', 6, "the new turn's thought"],
    ])
  })

  it('neighboring replies stay separate even after merging the history page with the live tail (mergePage)', async () => {
    const id = 's77-d'
    const mock = new MockPlatform()
    mock.sessions.set(id, sessionInfo(id))
    // Two neighboring replies already exist at the end of history
    mock.messages.set(id, [ask(id, 1, 'Run the review'), reply(id, 2, 'One review is still running.'), reply(id, 3, 'All six reviews are in.')])
    await useStore.getState().attach(mock)

    // The page is as of the moment it was requested, and the answer arrives later than a message that came after it (same condition as history cursor B)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = real(...args)
      await gate
      return page
    }
    useStore.getState().focusSession(id)
    mock.emit(delta(id, 'Here is the summary.'))
    release()
    await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
    mock.agents.loadMessages = real
    // A new turn's message arriving after the merge also stands separately in the tail
    mock.emit({ type: 'turn_complete', sessionId: id } as never)
    mock.emit(delta(id, 'Anything else?'))

    expect(shape(id)).toEqual([
      ['user', 1, 'Run the review'],
      ['assistant', 2, 'One review is still running.'],
      ['assistant', 3, 'All six reviews are in.'],
      ['assistant', 4, 'Here is the summary.'],
      ['assistant', 5, 'Anything else?'],
    ])
  })
})

/**
 * A conversation item's **identity** — only a changed row becomes a new object.
 *
 * The screen's own optimization rests on this rule: `ChatRow` is memoized, so it does not re-render
 * while the item object stays the same. So when a single streaming chunk arrives, exactly **one**
 * bubble re-renders (measured at 1.0 renders per chunk). If the reducer ever did something like
 * `items.map((i) => ({ ...i }))`, that property would quietly disappear — the screen would look
 * identical while the cost grew in proportion to the conversation's length. The render count can only
 * be measured in a browser, but the identity it rests on can be pinned down right here.
 */
describe('a conversation item\'s identity — only a changed row becomes a new object', () => {
  const idOf = (sessionId: string) => useStore.getState().chat[sessionId] ?? []

  it('a streaming chunk only creates a new object for the last row', async () => {
    const s = 'ident-s1'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    useStore.getState().dispatchEvent({ type: 'user_message', sessionId: s, seq: 1, text: 'question' } as NormalizedEvent)
    useStore.getState().dispatchEvent(delta(s, 'reply '))
    const before = idOf(s)
    expect(before.length).toBe(2)

    useStore.getState().dispatchEvent(delta(s, 'continuing'))
    const after = idOf(s)
    expect(after.length).toBe(2)
    expect(after[0]).toBe(before[0]) // The human message is untouched — same object
    expect(after[1]).not.toBe(before[1]) // Only the growing row becomes a new object
  })

  it('a tool result only creates a new object for that tool row — messages that came after it are untouched', async () => {
    const s = 'ident-s2'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    useStore.getState().dispatchEvent({
      type: 'tool_call', sessionId: s, callId: 'c1',
      summary: { tool: 'Read', title: 'a.ts', paths: [] },
    } as NormalizedEvent)
    useStore.getState().dispatchEvent(delta(s, 'reading'))
    const before = idOf(s)
    expect(before.length).toBe(2)

    useStore.getState().dispatchEvent({
      type: 'tool_result', sessionId: s, callId: 'c1', ok: true, summary: '12 lines',
    } as NormalizedEvent)
    const after = idOf(s)
    expect(after[0]).not.toBe(before[0]) // Only the tool row that received the result
    expect(after[1]).toBe(before[1]) // Messages after it are untouched
  })
})

/**
 * Restoring written text after a send failure (a follow-up to the loss incident of 2026-09-02).
 *
 * The composer is cleared the instant it is sent (#38). On failure, the bubble is removed, which
 * leaves the sentence **nowhere at all** — a toast only reports the failure, it does not return the
 * text. A failed sentence must come back to the composer to be sent again.
 */
describe('restoring written text after a send failure', () => {
  it('a failure returns the sentence to the composer', async () => {
    const s = 'sf-s1'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.sessions.delete(s) // The host refuses it (the same trick as the rename-failure test)

    await useStore.getState().send(s, 'a sentence that must not be lost')

    expect(useStore.getState().drafts[s]?.text).toBe('a sentence that must not be lost')
    expect(useStore.getState().toast).toMatch(/Could not send/)
    // Still no bubble left behind that looks sent (existing behavior kept)
    expect((useStore.getState().chat[s] ?? []).some((i) => i.kind === 'user')).toBe(false)
  })

  it('text written while waiting for the failure is not overwritten — the failed message is prepended in front of it', async () => {
    const s = 'sf-s2'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.sessions.delete(s)

    const inFlight = useStore.getState().send(s, 'the sentence sent first')
    useStore.getState().setDraft(s, { text: 'the sentence written meanwhile', attachments: [] })
    await inFlight

    expect(useStore.getState().drafts[s]?.text).toBe('the sentence sent first\nthe sentence written meanwhile')
  })

  it('a success leaves the composer untouched', async () => {
    const s = 'sf-s3'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)

    await useStore.getState().send(s, 'a sentence that goes through')

    expect(useStore.getState().drafts[s]).toBeUndefined()
  })
})

/*
 * #158: if a second input arrives on the same card before the first response's result reaches the
 * screen, the second response became a "vanished request" on the host and recorded a command that had
 * already run as Denied. A request is sent only once.
 */
describe('an approval is sent only once per request (#158)', () => {
  async function pendingCard() {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'safe' })
    useStore.setState({
      platform,
      sessions: {
        [s.id]: { ...s, pendingApproval: { requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/tmp' } } } as never,
      },
    })
    return { platform, id: s.id }
  }

  it('a second input before the response returns is never sent', async () => {
    const { platform, id } = await pendingCard()
    const finish: (() => void)[] = []
    const spy = vi
      .spyOn(platform.agents, 'respondApproval')
      .mockImplementation(() => new Promise<void>((r) => void finish.push(r)))
    const first = useStore.getState().respondApproval(id, 'r1', 'allow')
    const second = useStore.getState().respondApproval(id, 'r1', 'deny')
    finish.forEach((f) => f())
    await Promise.all([first, second])
    expect(spy.mock.calls.map((c) => c[2])).toEqual(['allow'])
  })

  // #683 review: ids repeat across sessions (each process counts its own), so the guard is per session
  it('an answer in flight in one session does not swallow the same request id in another', async () => {
    const { platform, id } = await pendingCard()
    const other = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'safe' })
    useStore.setState((st) => ({
      sessions: { ...st.sessions, [other.id]: { ...other, pendingApproval: { requestId: 'r1', detail: { kind: 'command', command: 'rm x', cwd: '/tmp' } } } as never },
    }))
    const finish: (() => void)[] = []
    const spy = vi
      .spyOn(platform.agents, 'respondApproval')
      .mockImplementation(() => new Promise<void>((r) => void finish.push(r)))
    const first = useStore.getState().respondApproval(id, 'r1', 'allow')
    const second = useStore.getState().respondApproval(other.id, 'r1', 'deny')
    finish.forEach((f) => f())
    await Promise.all([first, second])
    expect(spy.mock.calls.map((c) => [c[0], c[2]])).toEqual([[id, 'allow'], [other.id, 'deny']])
  })

  it('nothing is sent for a request whose card is already dismissed', async () => {
    const { platform, id } = await pendingCard()
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockResolvedValue(undefined as never)
    useStore.setState((st) => ({ sessions: { ...st.sessions, [id]: { ...st.sessions[id]!, pendingApproval: null } } }))
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(spy).not.toHaveBeenCalled()
  })

  it('a send failure allows pressing it again', async () => {
    const { platform, id } = await pendingCard()
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockRejectedValueOnce(new Error('Connection lost'))
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(useStore.getState().toast).toBe('Connection lost')
    spy.mockResolvedValue(undefined as never)
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(useStore.getState().approvalsInFlight).toEqual({})
  })
})

/*
 * #174 (the rest of #125): when text cannot be an answer to a question (several questions, or an
 * attachment), sending it starts a new turn and drops the question. The hint text never looked at
 * attachments, so it said "write an answer" while sending the text as a new turn, and the card
 * vanished with no explanation. Handing off a session with an open question sent the request text as
 * that question's answer.
 */
describe('an open question and the composer (#174)', () => {
  const q = (requestId: string, ...questions: string[]) => ({
    requestId,
    questions: questions.map((question) => ({ question, header: 'h', options: [{ label: 'a', description: '' }], multiSelect: false })),
  })

  it('the hint text and sending use the same decision — an attachment means it is never an answer', () => {
    expect(composerTarget([], false)).toBe('none')
    expect(composerTarget([q('r1', 'Which DB?')], false)).toBe('answer')
    expect(composerTarget([q('r1', 'Which DB?')], true)).toBe('drops')
    expect(composerTarget([q('r1', 'Which DB?', 'Which port?')], false)).toBe('drops')
    expect(composerTarget([q('r1', 'Which DB?'), q('r2', 'Which port?')], false)).toBe('drops')
  })

  async function withQuestions(...open: ReturnType<typeof q>[]) {
    const mock = new MockPlatform()
    mock.sessions.set('q174', sessionInfo('q174', { state: 'waiting_approval', pendingQuestions: open as never }))
    await useStore.getState().attach(mock)
    const sent = vi.spyOn(mock.agents, 'send')
    const answered = vi.spyOn(mock.agents, 'answerQuestion')
    return { mock, sent, answered }
  }

  it('with several questions, the text goes to a new turn, and a line is left before the bubble stating what was dropped', async () => {
    const { sent, answered } = await withQuestions(q('r1', 'Which DB?', 'Which port?'))
    await useStore.getState().send('q174', 'just do it')
    expect(answered).not.toHaveBeenCalled()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(useStore.getState().chat['q174']!.map(line)).toEqual([droppedQuestionsText(['Which DB?', 'Which port?']), 'just do it'])
  })

  it('even one question takes the same path once there is an attachment', async () => {
    const { sent, answered } = await withQuestions(q('r1', 'Which DB?'))
    await useStore.getState().send('q174', 'see this', [{ kind: 'file', path: '/tmp/a.txt', name: 'a.txt', mime: 'text/plain', bytes: 1 }])
    expect(answered).not.toHaveBeenCalled()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(useStore.getState().chat['q174']!.map(line)).toEqual([droppedQuestionsText(['Which DB?']), 'see this'])
  })

  it('never asks a session with an open question for a note — the request text would become that question\'s answer', async () => {
    const { mock, sent, answered } = await withQuestions(q('r1', 'Which DB?'))
    const proj = await mock.projects.add('/tmp/q174')
    useStore.setState((st) => ({
      projects: { ...st.projects, [proj.id]: proj },
      sessions: { ...st.sessions, q174: { ...st.sessions.q174!, projectId: proj.id } },
    }))
    await useStore.getState().handoffSession('q174', { mode: 'agent' })
    expect(answered).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
    expect(useStore.getState().toast).toBe('Answer the open question first, or hand off from the record')
  })
})

/*
 * #180: if the send path failed or raced, what a person wrote disappeared.
 */
describe('a failed send returns what was written (#180)', () => {
  it('text sent as an answer to a question comes back to the composer if it never lands', async () => {
    const mock = new MockPlatform()
    const open = [{ requestId: 'r1', questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'pg', description: '' }], multiSelect: false }] }]
    mock.sessions.set('a180', sessionInfo('a180', { state: 'waiting_approval', pendingQuestions: open as never }))
    await useStore.getState().attach(mock)
    useStore.getState().setDraft('a180', { text: 'typed after', attachments: [] })
    vi.spyOn(mock.agents, 'answerQuestion').mockRejectedValueOnce(
      Object.assign(new Error('That question is already gone'), { code: 'question_gone' }),
    )
    await useStore.getState().send('a180', 'sqlite please')
    expect(useStore.getState().drafts['a180']!.text).toBe('sqlite please\ntyped after')
    expect(useStore.getState().toast).toBe('That question is already gone')
  })

  it('never claims the first question went out if the orchestrator failed to be born', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    vi.spyOn(mock.agents, 'orchestrator').mockRejectedValueOnce(new Error('no tool'))
    expect(await useStore.getState().askOrchestrator('first question')).toBe(false)
    expect(useStore.getState().toast).toBe('Could not start the orchestrator: no tool')
  })

  it('returns a failure to the calling window if the worktree trunk could not be set', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/wm180')
    await useStore.getState().attach(mock)
    vi.spyOn(mock.projects, 'setWorktreeTrunk').mockRejectedValueOnce(new Error('not a git repository'))
    await expect(useStore.getState().setWorktreeTrunk(proj.id, 'main')).rejects.toThrow('Could not set the trunk: not a git repository')
    // Set, it is the project's trunk on screen
    await useStore.getState().setWorktreeTrunk(proj.id, 'develop')
    expect(useStore.getState().projects[proj.id]?.worktreeManager?.baseBranch).toBe('develop')
  })

  it('counts an attachment while it is uploading — the composer refuses to send during that time', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u180', sessionInfo('u180'))
    await useStore.getState().attach(mock)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const save = mock.agents.saveAttachment.bind(mock.agents)
    vi.spyOn(mock.agents, 'saveAttachment').mockImplementationOnce(async (...a) => {
      await gate
      return save(...a)
    })
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    const up = useStore.getState().attachFile('u180', file)
    await vi.waitFor(() => expect(useStore.getState().uploading['u180']).toBe(1))
    release()
    expect(await up).toMatchObject({ name: 'shot.png' })
    expect(useStore.getState().uploading['u180']).toBeUndefined()
  })
})

/**
 * A composer asked to take the keyboard (#528) belongs to the session asked for: showing another
 * session withdraws the request, so it never lands later in a session the person has left.
 */
describe('composerFocusFor (#528)', () => {
  it('is kept while the session asked for is shown, and withdrawn when another one is', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('cf-a', sessionInfo('cf-a'))
    mock.sessions.set('cf-b', sessionInfo('cf-b'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('cf-a')
    useStore.getState().askComposerFocus('cf-a')
    useStore.getState().focusSession('cf-a')
    expect(useStore.getState().composerFocusFor).toBe('cf-a')
    useStore.getState().focusSession('cf-b')
    expect(useStore.getState().composerFocusFor).toBeNull()
    useStore.getState().askComposerFocus('cf-b')
    useStore.getState().focusSession(null)
    expect(useStore.getState().composerFocusFor).toBeNull()
  })
})
