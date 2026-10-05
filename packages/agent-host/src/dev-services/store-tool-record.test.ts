/**
 * #221: tool calls are kept whole and are not in the search index.
 *
 * The store keeps a tool call's `input` and a tool result's `output` (the whole record), hands them out only to a
 * reader that asks by name, and indexes what the person and the agent said — never a tool call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredMessage } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'

const session = (s: Store, id: string) =>
  s.upsertSession({
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })

const seeded = (file = ':memory:') => {
  const s = new Store(file)
  s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  session(s, 's1')
  return s
}

const KEEP_ALL = { projectId: 'p1', projectName: 'p1', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false }

const COMMAND = 'pnpm --filter zebracorn build'
const OUTPUT = `${'compiling zebracorn…\n'.repeat(200)}error: the conclusion is at the end`
const INPUT = { command: COMMAND, description: 'Build the zebracorn package', timeout: 120000 }

/** A short conversation with one tool call in it, as the manager writes it */
const conversation = (sessionId: string, from = 1): StoredMessage[] => [
  { sessionId, seq: from, role: 'user', kind: 'text', payload: { text: 'please build the package' }, ts: 1 },
  { sessionId, seq: from + 1, role: 'assistant', kind: 'reasoning', payload: { text: 'the build script lives in the workspace' }, ts: 2 },
  {
    sessionId, seq: from + 2, role: 'system', kind: 'tool_call',
    payload: { type: 'tool_call', sessionId, callId: 'c1', summary: { tool: 'Bash', title: COMMAND, readOnly: false, paths: [] }, input: INPUT },
    ts: 3,
  },
  {
    sessionId, seq: from + 3, role: 'system', kind: 'tool_result',
    payload: { type: 'tool_result', sessionId, callId: 'c1', ok: false, summary: OUTPUT.slice(0, 300), output: OUTPUT },
    ts: 4,
  },
  { sessionId, seq: from + 4, role: 'assistant', kind: 'text', payload: { text: 'the build failed at the end' }, ts: 5 },
]

const indexRows = (s: Store): number => {
  const db = (s as unknown as { db: Database.Database }).db
  return (db.prepare(`SELECT COUNT(*) as n FROM messages_fts`).get() as { n: number }).n
}

describe('the search index holds what was said, not the tool calls (#221)', () => {
  it('a tool call is not found by its command, and what was said around it is', () => {
    const s = seeded()
    s.appendMessages(conversation('s1'))
    expect(s.searchMessages('zebracorn')).toEqual([])
    expect(s.searchMessages('ze')).toEqual([]) // the short-query path (LIKE) reads the same index
    expect(s.searchMessages('build the package').map((h) => h.seq)).toEqual([1])
    expect(s.searchMessages('workspace').map((h) => h.seq)).toEqual([2])
    expect(s.searchMessages('failed at the end').map((h) => h.seq)).toEqual([5])
    // One row for each thing said: the user, the reasoning, the answer
    expect(indexRows(s)).toBe(3)
    s.close()
  })

  it('a session restored from the trash gets its index back without its tool calls', async () => {
    const s = seeded()
    s.appendMessages(conversation('s1'))
    await s.trashSession('s1', KEEP_ALL)
    expect(indexRows(s)).toBe(0)
    await s.restoreSession('s1', 'p1')
    expect(s.searchMessages('zebracorn')).toEqual([])
    expect(s.searchMessages('build the package').map((h) => h.seq)).toEqual([1])
    expect(indexRows(s)).toBe(3)
    s.close()
  })
})

describe('the store keeps the whole record and reads back the card (#221)', () => {
  it('a tool call keeps its input and a result its output, and a reader gets them only by asking', () => {
    const s = seeded()
    s.appendMessages(conversation('s1'))
    const card = (rows: StoredMessage[]) => rows.filter((r) => r.kind === 'tool_call' || r.kind === 'tool_result').map((r) => r.payload)

    // What every reader gets: the card, for the page and for `loadMessagesFrom` alike
    for (const rows of [s.loadMessages('s1'), s.loadMessagesFrom('s1', 0)]) {
      expect(card(rows)).toEqual([
        { type: 'tool_call', sessionId: 's1', callId: 'c1', summary: { tool: 'Bash', title: COMMAND, readOnly: false, paths: [] } },
        { type: 'tool_result', sessionId: 's1', callId: 'c1', ok: false, summary: OUTPUT.slice(0, 300) },
      ])
    }
    // What is on disk: the whole of it
    for (const rows of [s.loadMessages('s1', 200, undefined, { full: true }), s.loadMessagesFrom('s1', 0, 20, { full: true })]) {
      expect(card(rows)).toMatchObject([{ input: INPUT }, { output: OUTPUT }])
    }
    // Nothing else changes shape: the words are read as they were written
    expect(s.loadMessages('s1').filter((r) => r.kind !== 'tool_call' && r.kind !== 'tool_result')).toEqual(
      conversation('s1').filter((r) => r.kind !== 'tool_call' && r.kind !== 'tool_result'),
    )
    s.close()
  })
})

/*
 * v40 on a store written before #221. Its index holds a row for every tool call, written as `appendMessages` wrote it
 * then (keyed by the message's rowid, the body the call's title). On a copy of the real store those rows were 55,131
 * of 81,816 and the index was 124.5MiB of a 236.2MiB file.
 */
describe('v40 — tool calls leave an existing index, and the file shrinks (#221)', () => {
  let dir = ''
  afterEach(() => {
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * An old store: two sessions of conversation (one in the trash, so with no index rows), and enough tool calls
   * that their index rows are well over the vacuum's 16MB — the titles repeat so that building the index is quick.
   */
  const oldStore = async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-v40-'))
    const file = join(dir, 'store.db')
    const s = seeded(file)
    session(s, 'gone')
    s.appendMessages([...conversation('s1'), ...conversation('gone')])
    await s.trashSession('gone', KEEP_ALL)
    const calls: StoredMessage[] = Array.from({ length: 400 }, (_, i) => ({
      sessionId: 's1', seq: 100 + i, role: 'system', kind: 'tool_call',
      payload: { type: 'tool_call', sessionId: 's1', callId: `c${i}`, summary: { tool: 'Bash', title: `${COMMAND} ${'x'.repeat(50_000)}`, readOnly: false, paths: [] } },
      ts: 100 + i,
    }))
    s.appendMessages(calls)
    s.close()

    // What the index held before #221: every tool call's title, keyed by its message's rowid
    const raw = new Database(file)
    raw.exec(`
      INSERT INTO messages_fts (rowid, body, session_id, seq)
      SELECT rowid, json_extract(payload, '$.summary.title'), session_id, seq FROM messages
      WHERE kind = 'tool_call' AND session_id = 's1'
    `)
    raw.pragma('user_version = 39')
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.close()
    return file
  }

  it('the rows of tool calls are dropped, what was said is still found, the trash stays out, and the file shrinks', async () => {
    const file = await oldStore()
    const before = statSync(file).size
    const old = new Database(file)
    expect((old.prepare(`SELECT COUNT(*) as n FROM messages_fts WHERE body MATCH '"zebracorn"'`).get() as { n: number }).n).toBe(401)
    old.close()

    const s = new Store(file)
    expect(s.migrationsRun).toBe(5) // v40, then v41 (#222), v42 (#288), v43 (#306) and v44 (#371) after it
    expect(s.searchMessages('zebracorn')).toEqual([])
    expect(s.searchMessages('build the package').map((h) => [h.sessionId, h.seq])).toEqual([['s1', 1]])
    expect(indexRows(s)).toBe(3) // s1's three things said; the session in the trash has none
    s.close()
    const after = statSync(file).size
    expect(after).toBeLessThan(before - 16 * 1024 * 1024)
  })

  it('a second start finds nothing to do', async () => {
    const file = await oldStore()
    new Store(file).close()
    const size = statSync(file).size
    const raw = new Database(file)
    raw.pragma('user_version = 39')
    raw.close()

    const s = new Store(file)
    expect(s.migrationsRun).toBe(5) // v40, then v41 (#222), v42 (#288), v43 (#306) and v44 (#371) after it
    expect(indexRows(s)).toBe(3)
    s.close()
    expect(statSync(file).size).toBe(size)
  })

  it('a vacuum that cannot run is reported and the store still opens, with the index rebuilt', async () => {
    const file = await oldStore()
    const exec = Database.prototype.exec
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === 'VACUUM') throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
      return exec.call(this, sql)
    })
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new Store(file)
    expect(s.schemaVersion).toBe(44)
    expect(s.searchMessages('zebracorn')).toEqual([])
    expect(indexRows(s)).toBe(3)
    expect(said.mock.calls.some(([line]) => String(line).includes('could not vacuum'))).toBe(true)
    s.close()
  })
})
