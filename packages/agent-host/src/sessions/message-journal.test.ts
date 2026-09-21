import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, SessionInfo, StoredMessage } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { MessageJournal, type MessageJournalStore } from './message-journal.js'

const sessionId = 's-journal'

const text = (value: string): NormalizedEvent => ({ type: 'message_delta', sessionId, role: 'assistant', text: value })
const reasoning = (value: string): NormalizedEvent => ({ type: 'reasoning_delta', sessionId, text: value })
const toolCall = (title = 'ls'): NormalizedEvent => ({
  type: 'tool_call',
  sessionId,
  callId: `c-${title}`,
  summary: { tool: 'Bash', title, readOnly: false, paths: [] },
})

const payloadText = (m: StoredMessage) => (m.payload as { text?: string }).text

const seedSession = (store: Store, id = sessionId) => {
  const projectId = `p-${id}`
  store.addProject({ id: projectId, path: `/tmp/${projectId}`, name: projectId })
  store.upsertSession({
    id,
    projectId,
    kind: 'worker',
    tool: 'claude',
    externalId: null,
    name: id,
    autoNamed: false,
    state: 'idle',
    lastReadSeq: 0,
    lastSeq: 0,
    createdAt: 1,
    waitingSince: null,
    live: false,
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
  } satisfies SessionInfo)
}

class SpyStore implements MessageJournalStore {
  messages = new Map<string, StoredMessage>()
  upserts: StoredMessage[] = []
  appends: StoredMessage[][] = []

  nextSeq(id: string): number {
    return Math.max(0, ...[...this.messages.values()].filter((m) => m.sessionId === id).map((m) => m.seq)) + 1
  }

  upsertMessageNoIndex(message: StoredMessage): void {
    this.upserts.push(message)
    this.messages.set(`${message.sessionId}:${message.seq}`, message)
  }

  appendMessages(messages: StoredMessage[]): void {
    this.appends.push(messages)
    for (const message of messages) this.messages.set(`${message.sessionId}:${message.seq}`, message)
  }
}

describe('MessageJournal', () => {
  let store: Store
  let journal: MessageJournal

  beforeEach(() => {
    store = new Store()
    seedSession(store)
    seedSession(store, 'other')
    journal = new MessageJournal(store)
  })

  afterEach(() => store.close())

  it('keeps reasoning, text, and tool transitions as separate persisted rows and indexes closed streams', () => {
    expect(journal.persist(reasoning('생각'), sessionId)).toBe(1)
    expect(journal.persist(text('답'), sessionId)).toBe(2)
    expect(journal.persist(toolCall('pwd'), sessionId)).toBe(3)
    expect(journal.persist(text('뒤'), sessionId)).toBe(4)
    journal.closeAll()

    const rows = store.loadMessages(sessionId, 20)
    expect(rows.map((r) => [r.seq, r.kind, payloadText(r) ?? (r.payload as { callId?: string }).callId])).toEqual([
      [1, 'reasoning', '생각'],
      [2, 'text', '답'],
      [3, 'tool_call', 'c-pwd'],
      [4, 'text', '뒤'],
    ])
    expect(store.searchMessages('생각')).toHaveLength(1)
    expect(store.searchMessages('답')).toHaveLength(1)
    expect(store.searchMessages('뒤')).toHaveLength(1)
  })

  it('ignores empty deltas unless an existing text stream can absorb them', () => {
    expect(journal.persist(text(''), sessionId)).toBeNull()
    expect(journal.persist({ type: 'reasoning_delta', sessionId, text: '' }, sessionId)).toBeNull()
    expect(journal.persist({ type: 'reasoning_delta', sessionId, estTokens: 3 }, sessionId)).toBeNull()
    expect(store.loadMessages(sessionId, 20)).toEqual([])

    expect(journal.persist(text('a'), sessionId)).toBe(1)
    expect(journal.persist(text(''), sessionId)).toBe(1)
    expect(journal.persist({ type: 'reasoning_delta', sessionId, estTokens: 4 }, sessionId)).toBeNull()
    expect(journal.persist(text('b'), sessionId)).toBe(1)
    journal.close(sessionId)

    expect(store.loadMessages(sessionId, 20).map(payloadText)).toEqual(['ab'])
  })

  it('flushes open streams after two seconds or two thousand additional characters', () => {
    let now = 1_000
    const spy = new SpyStore()
    const flushing = new MessageJournal(spy, () => now)

    expect(flushing.persist(text('a'), sessionId)).toBe(1)
    expect(spy.upserts).toHaveLength(1)
    now += 1_999
    expect(flushing.persist(text('b'), sessionId)).toBe(1)
    expect(spy.upserts).toHaveLength(1)
    now += 1
    expect(flushing.persist(text('c'), sessionId)).toBe(1)
    expect(spy.upserts).toHaveLength(2)
    expect(payloadText(spy.upserts.at(-1)!)).toBe('abc')

    expect(flushing.persist({ ...text('x'), sessionId: 'chars' }, 'chars')).toBe(1)
    expect(spy.upserts).toHaveLength(3)
    expect(flushing.persist({ ...text('y'.repeat(1_999)), sessionId: 'chars' }, 'chars')).toBe(1)
    expect(spy.upserts).toHaveLength(3)
    expect(flushing.persist({ ...text('z'), sessionId: 'chars' }, 'chars')).toBe(1)
    expect(spy.upserts).toHaveLength(4)
    expect(payloadText(spy.upserts.at(-1)!)).toBe(`x${'y'.repeat(1_999)}z`)
  })

  it('closes open streams on terminal turn, error, and non-working state changes', () => {
    expect(journal.persist(text('turn done'), sessionId)).toBe(1)
    expect(journal.persist({ type: 'turn_complete', sessionId }, sessionId)).toBeNull()
    expect(store.searchMessages('turn done')).toHaveLength(1)

    expect(journal.persist(text('still working'), sessionId)).toBe(2)
    expect(journal.persist({ type: 'state_change', sessionId, state: 'working' }, sessionId)).toBeNull()
    expect(store.searchMessages('still working')).toHaveLength(0)
    expect(journal.persist({ type: 'state_change', sessionId, state: 'idle' }, sessionId)).toBeNull()
    expect(store.searchMessages('still working')).toHaveLength(1)

    expect(journal.persist(text('errored'), sessionId)).toBe(3)
    expect(journal.persist({ type: 'error', sessionId, error: { code: 'internal', message: 'boom', retryable: false } }, sessionId)).toBe(4)
    expect(store.searchMessages('errored')).toHaveLength(1)
    expect(store.loadMessages(sessionId, 20).at(-1)).toMatchObject({
      seq: 4, role: 'system', kind: 'marker', payload: { type: 'error', error: { message: 'boom' } },
    })
  })

  it('closeAll indexes every open stream and remains idempotent', () => {
    expect(journal.persist(text('one'), sessionId)).toBe(1)
    expect(journal.persist({ ...reasoning('two'), sessionId: 'other' }, 'other')).toBe(1)

    journal.closeAll()
    journal.closeAll()

    expect(store.loadMessages(sessionId, 20).map(payloadText)).toEqual(['one'])
    expect(store.loadMessages('other', 20).map(payloadText)).toEqual(['two'])
    expect(store.searchMessages('one')).toHaveLength(1)
    expect(store.searchMessages('two')).toHaveLength(1)
  })
})
