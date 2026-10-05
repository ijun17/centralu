/**
 * #222: a native subagent's steps are kept under the card that launched it, in a table of their own.
 *
 * Nothing that reads a session's conversation reads them, nothing indexes them, and they belong to the session through
 * the trash and its purge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
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
const AGENT = 'toolu_agent'
const OUTPUT = `${'match\n'.repeat(100)}the conclusion is at the end`

/** One subagent's work, as the manager stores it */
const steps = (s: Store, sessionId = 's1', parent = AGENT) => [
  s.appendSubagentMessage(sessionId, parent, { role: 'assistant', kind: 'reasoning', payload: { type: 'reasoning_delta', sessionId, text: 'look at the zebracorn tests' }, ts: 1 }),
  s.appendSubagentMessage(sessionId, parent, {
    role: 'system', kind: 'tool_call',
    payload: { type: 'tool_call', sessionId, callId: 'sub1', summary: { tool: 'Grep', title: 'Grep: zebracorn', readOnly: true, paths: [] }, input: { pattern: 'zebracorn' } },
    ts: 2,
  }),
  s.appendSubagentMessage(sessionId, parent, {
    role: 'system', kind: 'tool_result',
    payload: { type: 'tool_result', sessionId, callId: 'sub1', ok: true, summary: OUTPUT.slice(0, 300), output: OUTPUT },
    ts: 3,
  }),
  s.appendSubagentMessage(sessionId, parent, { role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId, role: 'assistant', text: 'zebracorn is tested twice' }, ts: 4 }),
]

const conversation: StoredMessage[] = [
  { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: 'research the zebracorn tests' }, ts: 1 },
  {
    sessionId: 's1', seq: 2, role: 'system', kind: 'tool_call',
    payload: { type: 'tool_call', sessionId: 's1', callId: AGENT, summary: { tool: 'Agent', title: 'Research', readOnly: true, paths: [] } },
    ts: 2,
  },
]

describe('a subagent\'s steps are kept under the call that launched it (#222)', () => {
  it('numbers the steps within each launch, and reads one launch\'s steps oldest first, paging forward', () => {
    const s = seeded()
    expect(steps(s)).toEqual([1, 2, 3, 4])
    expect(steps(s, 's1', 'toolu_other')).toEqual([1, 2, 3, 4])
    expect(s.loadSubagentMessages('s1', AGENT).map((r) => [r.seq, r.kind])).toEqual([
      [1, 'reasoning'], [2, 'tool_call'], [3, 'tool_result'], [4, 'text'],
    ])
    expect(s.loadSubagentMessages('s1', AGENT, { afterSeq: 1, limit: 2 }).map((r) => r.seq)).toEqual([2, 3])
    expect(s.loadSubagentMessages('s1', 'toolu_unknown')).toEqual([])
    s.close()
  })

  it('a tool step reads as its card unless the reader asks for the record by name (#221)', () => {
    const s = seeded()
    steps(s)
    const tools = (rows: StoredMessage[]) => rows.filter((r) => r.kind === 'tool_call' || r.kind === 'tool_result').map((r) => r.payload)
    expect(tools(s.loadSubagentMessages('s1', AGENT))).toEqual([
      { type: 'tool_call', sessionId: 's1', callId: 'sub1', summary: { tool: 'Grep', title: 'Grep: zebracorn', readOnly: true, paths: [] } },
      { type: 'tool_result', sessionId: 's1', callId: 'sub1', ok: true, summary: OUTPUT.slice(0, 300) },
    ])
    expect(tools(s.loadSubagentMessages('s1', AGENT, { full: true }))).toMatchObject([{ input: { pattern: 'zebracorn' } }, { output: OUTPUT }])
    s.close()
  })

  it('the conversation does not hold them: its pages, its last seq and its search see none of it', () => {
    const s = seeded()
    s.appendMessages(conversation)
    steps(s)
    expect(s.loadMessages('s1', 200, undefined, { full: true })).toEqual(conversation)
    expect(s.loadMessagesFrom('s1', 0, 200, { full: true })).toEqual(conversation)
    expect(s.listSessions().find((x) => x.id === 's1')?.lastSeq).toBe(2)
    expect(s.nextSeq('s1')).toBe(3)
    // Not indexed, its words included: the parent's own report is what is searchable
    expect(s.searchMessages('zebracorn').map((h) => h.seq)).toEqual([1])
    expect(s.searchMessages('tested twice')).toEqual([])
    s.close()
  })

  it('they stay with the session in the trash and come back with it, and the purge takes them', async () => {
    const s = seeded()
    s.appendMessages(conversation)
    steps(s)
    const before = s.listTrash()
    await s.trashSession('s1', KEEP_ALL)
    expect(s.loadSubagentMessages('s1', AGENT)).toHaveLength(4)
    // What the trash says it holds counts them
    const [row] = s.listTrash()
    expect(before).toEqual([])
    const ownBytes = conversation.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m.payload)), 0)
    expect(row!.bytes).toBeGreaterThan(ownBytes + OUTPUT.length)
    expect(row!.messages).toBe(2)
    await s.restoreSession('s1', 'p1')
    expect(s.loadSubagentMessages('s1', AGENT)).toHaveLength(4)
    expect(s.searchMessages('tested twice')).toEqual([])
    await s.trashSession('s1', KEEP_ALL)
    // Chunks smaller than the steps: the purge walks them in several steps, as it walks messages (#179)
    expect(await s.purgeSession('s1', 3)).toBe(true)
    const db = (s as unknown as { db: Database.Database }).db
    expect((db.prepare(`SELECT COUNT(*) as n FROM subagent_messages`).get() as { n: number }).n).toBe(0)
    s.close()
  })

  it('a purge deletes them in chunks, letting the event loop run between, rather than in the session row\'s cascade', async () => {
    const s = seeded()
    s.appendMessages(conversation)
    steps(s)
    await s.trashSession('s1', KEEP_ALL)
    // 4 steps and 2 messages in chunks of 3: the steps take a chunk of their own before the rest goes with the session
    const yields = vi.spyOn(globalThis, 'setImmediate')
    await s.purgeSession('s1', 3)
    expect(yields).toHaveBeenCalledTimes(1)
    yields.mockRestore()
    s.close()
  })
})

describe('v41 — the table for subagent steps (#222)', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('is added to a store written before it, which keeps its conversation as it was', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-v41-'))
    const file = join(dir, 'store.db')
    const old = seeded(file)
    old.appendMessages(conversation)
    old.close()
    const raw = new Database(file)
    raw.exec('DROP TABLE subagent_messages')
    raw.pragma('user_version = 40')
    raw.close()

    const s = new Store(file)
    expect(s.migrationsRun).toBe(5) // v41, then v42 (#288), v43 (#306), v44 and v45 (#371)
    expect(s.schemaVersion).toBe(45)
    expect(s.loadMessages('s1', 200, undefined, { full: true })).toEqual(conversation)
    expect(steps(s)).toEqual([1, 2, 3, 4])
    s.close()
    // And it runs once
    const again = new Store(file)
    expect(again.migrationsRun).toBe(0)
    expect(again.loadSubagentMessages('s1', AGENT)).toHaveLength(4)
    again.close()
  })
})
