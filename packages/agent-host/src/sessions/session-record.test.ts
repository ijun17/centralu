import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionRecord, type SessionRecordHost } from './session-record.js'

/*
 * What a session's events leave in the store, on its own (#428): one row per streamed message, closed at a boundary
 * and only then searchable (#66), a new row when the message changes (#212), and the events that are their own rows.
 * The manager's tests (messages, search, transcripts) run the same rules through real turns.
 */

let store: Store
let rec: SessionRecord
const m = { id: 's', lastSeq: 0 } as SessionInfo

beforeEach(() => {
  store = new Store()
  store.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  store.upsertSession({
    id: 's', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 's', autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
  m.lastSeq = 0
  rec = new SessionRecord({ store, meta: new Map([['s', m]]) } as unknown as SessionRecordHost)
})
afterEach(() => store.close())

const delta = (text: string, messageId?: string): NormalizedEvent =>
  ({ type: 'message_delta', sessionId: 's', role: 'assistant', text, ...(messageId ? { messageId } : {}) }) as NormalizedEvent
const texts = () => store.loadMessages('s', 50).filter((r) => r.kind === 'text').map((r) => (r.payload as { text: string }).text)

describe('a streamed message', () => {
  it('grows in one row, and is written out and indexed when a boundary closes it', () => {
    const first = rec.persistMessage(delta('Hel'), m)
    expect(rec.persistMessage(delta('lo'), m)).toBe(first)
    expect(store.searchMessages('Hello', 5)).toEqual([])
    rec.persistMessage({ type: 'turn_complete', sessionId: 's' } as NormalizedEvent, m)
    expect(rec.streams.has('s')).toBe(false)
    expect(texts()).toEqual(['Hello'])
    expect(store.searchMessages('Hello', 5).map((h) => h.seq)).toEqual([first])
    expect(m.lastSeq).toBe(first)
  })

  it('a chunk naming another message starts a new row (#212); an empty one starts none', () => {
    rec.persistMessage(delta('polling it now.', 'm1'), m)
    rec.persistMessage(delta('It is still running', 'm2'), m)
    expect(rec.persistMessage(delta(''), m)).toBe(rec.streams.get('s')!.seq)
    rec.closeStream('s')
    expect(texts()).toEqual(['polling it now.', 'It is still running'])
    rec.closeStream('s')
    expect(rec.persistMessage(delta(''), m)).toBeNull()
  })

  it('a tool call is its own row and closes the message before it', () => {
    rec.persistMessage(delta('Let me look.'), m)
    const call = rec.persistMessage({ type: 'tool_call', sessionId: 's', callId: 'c1', name: 'Read', input: {} } as unknown as NormalizedEvent, m)
    expect(texts()).toEqual(['Let me look.'])
    expect(store.loadMessages('s', 50).map((r) => r.kind)).toEqual(['text', 'tool_call'])
    expect(m.lastSeq).toBe(call)
  })

  it('an event that is no row, and no boundary, leaves the open message alone', () => {
    rec.persistMessage(delta('half'), m)
    expect(rec.persistMessage({ type: 'state_change', sessionId: 's', state: 'working' } as NormalizedEvent, m)).toBeNull()
    expect(rec.streams.has('s')).toBe(true)
  })
})
