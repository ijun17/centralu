import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionRecord, STREAM_FLUSH_CHARS, STREAM_FLUSH_MS, type SessionRecordHost } from './session-record.js'

/*
 * What a session's events leave in the store, on its own (#428): one row per streamed message, closed at a boundary
 * and only then searchable (#66), a new row when the message changes (#212), and the events that are their own rows.
 * The manager's tests (messages, search, transcripts) run the same rules through real turns.
 */

let store: Store
let rec: SessionRecord
const m = { id: 's', lastSeq: 0 } as SessionInfo

function open(file?: string) {
  store = new Store(file)
  store.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  store.sessions.upsertSession({
    id: 's', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 's', autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
  m.lastSeq = 0
  rec = new SessionRecord({ store, meta: new Map([['s', m]]) } as unknown as SessionRecordHost)
}
beforeEach(() => open())
afterEach(() => store.close())

const delta = (text: string, messageId?: string): NormalizedEvent =>
  ({ type: 'message_delta', sessionId: 's', role: 'assistant', text, ...(messageId ? { messageId } : {}) }) as NormalizedEvent
const texts = () => store.messages.loadMessages('s', 50).filter((r) => r.kind === 'text').map((r) => (r.payload as { text: string }).text)

describe('a streamed message', () => {
  it('grows in one row, and is written out and indexed when a boundary closes it', () => {
    const first = rec.persistMessage(delta('Hel'), m)
    expect(rec.persistMessage(delta('lo'), m)).toBe(first)
    expect(store.messages.searchMessages('Hello', 5)).toEqual([])
    rec.persistMessage({ type: 'turn_complete', sessionId: 's' } as NormalizedEvent, m)
    expect(rec.streams.has('s')).toBe(false)
    expect(texts()).toEqual(['Hello'])
    expect(store.messages.searchMessages('Hello', 5).map((h) => h.seq)).toEqual([first])
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
    expect(store.messages.loadMessages('s', 50).map((r) => r.kind)).toEqual(['text', 'tool_call'])
    expect(m.lastSeq).toBe(call)
  })

  it('an event that is no row, and no boundary, leaves the open message alone', () => {
    rec.persistMessage(delta('half'), m)
    expect(rec.persistMessage({ type: 'state_change', sessionId: 's', state: 'working' } as NormalizedEvent, m)).toBeNull()
    expect(rec.streams.has('s')).toBe(true)
  })
})

/*
 * What a host that dies mid-answer leaves on disk (#66, #845). An open message is written when it starts and then only
 * every STREAM_FLUSH_CHARS characters or STREAM_FLUSH_MS, so that much is the most a crash may lose. A regression
 * there (a flush that never comes, or one that writes a stale body) loses a streaming reply on a crash and passes
 * every test that closes the stream first. Read here through a second connection on the file while the stream is
 * still open: what another process finds after this one is gone.
 */
describe('a message still streaming when the host dies', () => {
  let dir = ''
  let disk: Database.Database
  beforeEach(() => {
    store.close()
    dir = mkdtempSync(join(tmpdir(), 'cc-stream-flush-'))
    open(join(dir, 'store.db'))
    disk = new Database(join(dir, 'store.db'), { readonly: true })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    disk.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const onDisk = (seq: number) => {
    const row = disk.prepare(`SELECT payload FROM messages WHERE session_id = 's' AND seq = ?`).get(seq) as { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as { text: string }).text : null
  }

  it('the first chunk is on disk at once, and after that never more than STREAM_FLUSH_CHARS goes unwritten', () => {
    const seq = rec.persistMessage(delta('A'), m)!
    expect(onDisk(seq)).toBe('A')
    let said = 'A'
    let flushes = 0
    // Every size from the first chunk to a few times the bound, one character at a time
    for (let i = 1; i <= 3 * STREAM_FLUSH_CHARS + 5; i++) {
      const before = onDisk(seq)!
      const chunk = String.fromCharCode(97 + (i % 26))
      rec.persistMessage(delta(chunk), m)
      said += chunk
      const now = onDisk(seq)!
      if (now !== before) flushes++
      expect(said.startsWith(now)).toBe(true)
      expect(said.length - now.length).toBeLessThan(STREAM_FLUSH_CHARS)
      // Written exactly when the unwritten part reaches the bound, and not before
      expect(now === said).toBe(i % STREAM_FLUSH_CHARS === 0)
    }
    expect(flushes).toBe(3)
    expect(rec.streams.has('s')).toBe(true)
  })

  it('a short chunk is written once STREAM_FLUSH_MS has passed since the last write', () => {
    const seq = rec.persistMessage(delta('slow '), m)!
    vi.setSystemTime(1_000_000 + STREAM_FLUSH_MS - 1)
    rec.persistMessage(delta('answer '), m)
    expect(onDisk(seq)).toBe('slow ')
    vi.setSystemTime(1_000_000 + STREAM_FLUSH_MS)
    rec.persistMessage(delta('arrives'), m)
    expect(onDisk(seq)).toBe('slow answer arrives')
    // The clock restarts at that write
    vi.setSystemTime(1_000_000 + 2 * STREAM_FLUSH_MS - 1)
    rec.persistMessage(delta('.'), m)
    expect(onDisk(seq)).toBe('slow answer arrives')
  })
})
