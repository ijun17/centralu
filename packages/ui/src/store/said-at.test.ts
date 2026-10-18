import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo, StoredMessage } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { messagesToChat, useStore, type ChatItem } from './store.js'
import { stampSaid } from './transcript.js'

/*
 * When a row was said (`ChatItem.at`, owner 2026-10-18): the stored row's `ts` for history, the moment the window
 * received it for a live row. The conversation writes it under a bubble and divides the days by it.
 */

function sessionInfo(id: string): SessionInfo {
  return {
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: true,
    state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 0,
    waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
    importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null,
    appId: null, ...sessionLiveDefaults(),
  }
}

const row = (seq: number, ts: number, kind: StoredMessage['kind'], payload: object, role: StoredMessage['role'] = 'assistant'): StoredMessage =>
  ({ sessionId: 's1', seq, role, kind, ts, payload }) as StoredMessage

const chatOf = (id: string): ChatItem[] => useStore.getState().chat[id] ?? []
const atOf = (id: string) => chatOf(id).map((i) => [i.kind, i.at])

describe('stampSaid', () => {
  it('marks a copy of the row with the moment, and leaves the row it was given alone', () => {
    const item: ChatItem = { kind: 'assistant', seq: 1, text: 'hi' }
    expect(stampSaid(item, 42)).toEqual({ kind: 'assistant', seq: 1, text: 'hi', at: 42 })
    expect(item).not.toHaveProperty('at')
  })
})

describe('a stored row says when it was said', () => {
  it('carries its own ts onto every row it makes', () => {
    const items = messagesToChat([
      row(1, 1000, 'text', { text: 'do it' }, 'user'),
      row(2, 2000, 'reasoning', { text: 'thinking' }),
      row(3, 3000, 'tool_call', { callId: 'c1', summary: { tool: 'Bash', title: 'ls' } }),
      row(4, 4000, 'text', { text: 'done' }),
      row(5, 5000, 'marker', { type: 'compaction', failed: false }, 'system'),
    ])
    expect(items.map((i) => [i.kind, i.at])).toEqual([
      ['user', 1000],
      ['reasoning', 2000],
      ['tool', 3000],
      ['assistant', 4000],
      ['mark', 5000],
    ])
  })

  it('keeps the call\'s time on a tool card its result is folded into', () => {
    const items = messagesToChat([
      row(1, 1000, 'tool_call', { callId: 'c1', summary: { tool: 'Bash', title: 'ls' } }),
      row(2, 9000, 'tool_result', { callId: 'c1', summary: 'a.txt', ok: true }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'tool', result: 'a.txt', at: 1000 })
  })
})

describe('a live row says when the window received it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stamps each new row with its arrival, and moves the answer\'s time with each chunk', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('said1', sessionInfo('said1'))
    await useStore.getState().attach(mock)

    vi.setSystemTime(10_000)
    mock.emit({ sessionId: 'said1', type: 'tool_call', callId: 'c1', summary: { tool: 'Read', title: 'a.ts' } } as NormalizedEvent)
    await vi.waitFor(() => expect(chatOf('said1')).toHaveLength(1))
    vi.setSystemTime(20_000)
    mock.emit({ sessionId: 'said1', type: 'message_delta', role: 'assistant', text: 'Read it' } as NormalizedEvent)
    await vi.waitFor(() => expect(chatOf('said1')).toHaveLength(2))
    expect(atOf('said1')).toEqual([['tool', 10_000], ['assistant', 20_000]])

    // A later chunk of the same answer: the answer reads as when it was finished, the card before it keeps its time
    vi.setSystemTime(30_000)
    mock.emit({ sessionId: 'said1', type: 'message_delta', role: 'assistant', text: ', all of it.' } as NormalizedEvent)
    await vi.waitFor(() => expect(chatOf('said1')[1]).toMatchObject({ text: 'Read it, all of it.' }))
    expect(atOf('said1')).toEqual([['tool', 10_000], ['assistant', 30_000]])
  })

  it('stamps the message the person sends the moment it is drawn', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('said2', sessionInfo('said2'))
    await useStore.getState().attach(mock)

    // The bubble as first drawn, before the host confirms it (the mock confirms within the same call)
    let drawn: ChatItem | undefined
    const stop = useStore.subscribe((s) => {
      drawn ??= s.chat.said2?.find((i) => i.kind === 'user' && i.pending)
    })
    vi.setSystemTime(50_000)
    await useStore.getState().send('said2', 'Hello')
    stop()
    expect(drawn).toMatchObject({ text: 'Hello', pending: true, at: 50_000 })
  })
})
