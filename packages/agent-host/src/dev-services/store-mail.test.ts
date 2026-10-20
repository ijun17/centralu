/**
 * The mailbox's tables (#1347, docs/plans/mailbox.md §4, store step v61): the step itself, a host swap with an older build
 * beside the new tables (§4.2), what a stored word this build does not know reads as, a message posted twice under one
 * key, retention (§4.4) and a purged session's rows.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'
import type { MailRecords, NewThread, ThreadRow } from './store/mail.js'
import { sweepMail } from './store/mail-retention.js'

const MAIL_TABLES = ['mail_threads', 'mail_participants', 'mail_blockers', 'mail_messages', 'mail_receipts', 'mail_turns']
const HOST = 'hub-aaaaaaaa'
const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const storeFile = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cc-store-mail-'))
  dirs.push(d)
  return join(d, 'store.db')
}
const dbOf = (s: Store) => (s as unknown as { db: Database.Database }).db
function raw<T>(file: string, f: (db: Database.Database) => T): T {
  const db = new Database(file)
  try {
    return f(db)
  } finally {
    db.close()
  }
}
const tables = (file: string) => raw(file, (db) => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name))

/** The build before the mailbox: it knows the steps up to v60 and nothing of the tables v61 adds */
class OlderBuild extends Store {
  protected override migrationSteps() {
    return super.migrationSteps().filter((step) => step.to <= 60)
  }
}

const KNOWN = new Store().latestKnownVersion

const thread = (id: string, over: Partial<NewThread> = {}): NewThread => ({
  id,
  home: HOST,
  projectId: null,
  subject: `subject of ${id}`,
  origin: 'mail',
  depth: 0,
  parentId: null,
  follows: [],
  state: 'open',
  owner: 'person',
  assignee: null,
  next: null,
  links: {},
  ...over,
})
const tid = (n: number) => `${HOST}.t_${String(n).padStart(26, '0')}`
const mid = (n: number) => `${HOST}.m_${String(n).padStart(26, '0')}`

let counter = 0
/** A message in a thread, with a receipt for each recipient */
function message(m: MailRecords, threadId: string, over: { kind?: 'notice' | 'event' | 'note' | 'assign' | 'report'; at?: number; recipients?: string[]; sender?: string; dedupeKey?: string | null } = {}) {
  const row = m.insertMessage({
    id: mid(++counter),
    threadId,
    sender: over.sender ?? 'centralu',
    kind: over.kind ?? 'note',
    urgent: false,
    needsOwner: false,
    wake: null,
    replyTo: null,
    body: `message ${counter}`,
    facts: {},
    dedupeKey: over.dedupeKey ?? null,
    createdAt: over.at ?? NOW,
  })
  for (const r of over.recipients ?? []) m.insertReceipt(row.id, r, row.createdAt)
  return row
}

/** A thread that went `done` `ago` ms before NOW */
function doneThread(m: MailRecords, id: string, ago: number, over: Partial<NewThread> = {}): ThreadRow {
  m.insertThread(thread(id, over), NOW - ago - DAY)
  return m.updateThread(id, { state: 'done', outcome: 'finished', doneAt: NOW - ago, stateSince: NOW - ago }, NOW - ago, true)
}

const count = (s: Store, table: string, where = '1=1') => (dbOf(s).prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n

describe('store step v61: the mailbox tables', () => {
  it('a new store has the six tables, and the step adds them without breaking an older reader', () => {
    const s = new Store()
    expect(s.schemaVersion).toBe(KNOWN)
    const names = (dbOf(s).prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(MAIL_TABLES))
    const step = (s as unknown as { migrationSteps(): { to: number; breaksOlderReaders: boolean; heavy?: true }[] }).migrationSteps().find((x) => x.to === 61)
    expect(step).toMatchObject({ to: 61, breaksOlderReaders: false })
    expect(step?.heavy).toBeUndefined()
  })

  it('a store at v60 gets the tables, and its record of which builds can read it does not move', () => {
    const file = storeFile()
    new Store(file).close()
    const floor = raw(file, (db) => (db.prepare(`SELECT value FROM app_settings WHERE key = 'min_reader_version'`).get() as { value: string }).value)
    raw(file, (db) => {
      for (const t of MAIL_TABLES) db.exec(`DROP TABLE ${t}`)
      db.pragma('user_version = 60')
    })

    const s = new Store(file)
    expect(s.migrationsRun).toBe(1)
    expect(tables(file)).toEqual(expect.arrayContaining(MAIL_TABLES))
    expect(String(s.minReaderVersion)).toBe(floor)
    s.close()
  })
})

describe('a host swap with an older build beside the mail tables (§4.2)', () => {
  it('an older build opens a store that holds mail, migrates nothing, keeps writing its own paths, and leaves the mail as it was', () => {
    const file = storeFile()
    const first = new Store(file)
    first.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'alpha' })
    first.mail.insertThread(thread(tid(1), { owner: `session:${HOST}/s1`, assignee: `session:${HOST}/s2`, state: 'running' }), NOW)
    first.mail.putParticipant(tid(1), `session:${HOST}/s1`, 'owner', NOW)
    const sent = message(first.mail, tid(1), { kind: 'assign', sender: `session:${HOST}/s1`, recipients: [`session:${HOST}/s2`], dedupeKey: 'k1' })
    first.close()

    const older = new OlderBuild(file)
    // It knows v60 at most, the store is at v61, and it opens it: step v61 breaks no reader
    expect(older.schemaVersion).toBe(KNOWN)
    expect(older.migrationsRun).toBe(0)
    expect(older.projects.listProjects().map((p) => p.id)).toEqual(['p1'])
    // It goes on with the paths it has: the marks of work it gave, a new project
    older.children.setReportMark('s2', 's1')
    older.projects.addProject({ id: 'p2', path: '/tmp/p2', name: 'beta' })
    older.close()

    const next = new Store(file)
    expect(next.migrationsRun).toBe(0)
    expect(next.mail.thread(tid(1))).toMatchObject({ state: 'running', assignee: `session:${HOST}/s2` })
    expect(next.mail.message(sent.id)).toMatchObject({ kind: 'assign', dedupeKey: 'k1' })
    expect(next.mail.receiptsOf(sent.id)).toHaveLength(1)
    // What the older build wrote while it served is there for the newer one to adopt (slice 3)
    expect(next.children.listReportMarks()).toEqual([{ sessionId: 's2', callerSessionId: 's1' }])
    expect(next.projects.listProjects().map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    next.close()
  })

  it('the host taking over a v60 store runs step v61 during the swap, and the older build can serve the result again', () => {
    const file = storeFile()
    const older = new OlderBuild(file)
    older.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'alpha' })
    older.children.setReportMark('s2', 's1')
    older.close()
    expect(tables(file)).not.toContain('mail_threads')

    const taking = new Store(file, { swap: true })
    // An expand step is not left for later: the previous build can read what it adds
    expect(taking.deferredSteps).not.toContain(61)
    expect(taking.schemaVersion).toBe(KNOWN)
    taking.mail.insertThread(thread(tid(1)), NOW)
    expect(taking.mail.thread(tid(1))?.state).toBe('open')
    taking.close()

    // The new host failed before it was ready: the keeper starts the previous build on the same store
    const back = new OlderBuild(file)
    expect(back.migrationsRun).toBe(0)
    expect(back.children.listReportMarks()).toEqual([{ sessionId: 's2', callerSessionId: 's1' }])
    back.close()
  })
})

describe('what is stored and read back', () => {
  it('an origin or a kind this build does not know reads as a default, a state or an outcome as `unknown` (which refuses changes), a broken JSON column as empty, and the row still reads', () => {
    const s = new Store()
    s.mail.insertThread(thread(tid(1)), NOW)
    message(s.mail, tid(1))
    dbOf(s)
      .prepare(`UPDATE mail_threads SET state = 'paused', origin = 'telepathy', outcome = 'vanished', links = 'not json', follows = '{' WHERE id = ?`)
      .run(tid(1))
    dbOf(s).prepare(`UPDATE mail_messages SET kind = 'shout', facts = '[1]' WHERE thread_id = ?`).run(tid(1))

    expect(s.mail.thread(tid(1))).toMatchObject({ state: 'unknown', origin: 'mail', outcome: 'unknown', links: {}, follows: [] })
    expect(s.mail.messagesAfter(tid(1), 0)[0]).toMatchObject({ kind: 'note', facts: {} })
  })

  it('a role it does not know is the weakest one, a permission it cannot read is never a grant', () => {
    const s = new Store()
    s.mail.insertThread(thread(tid(1)), NOW)
    s.mail.putParticipant(tid(1), `session:${HOST}/s1`, 'owner', NOW)
    s.mail.insertBlocker({ threadId: tid(1), n: 1, kind: 'text', ref: null, text: 'x' })
    dbOf(s).prepare(`UPDATE mail_participants SET role = 'archmage'`).run()
    dbOf(s).prepare(`UPDATE mail_blockers SET kind = 'wish'`).run()
    expect(s.mail.participants(tid(1))[0]?.role).toBe('member')
    expect(s.mail.blockers(tid(1))[0]?.kind).toBe('text')
  })

  it('a message posted again under the same key by the same sender in the same thread is refused by the store; no key, another thread or another sender is not', () => {
    const s = new Store()
    s.mail.insertThread(thread(tid(1)), NOW)
    s.mail.insertThread(thread(tid(2)), NOW)
    message(s.mail, tid(1), { dedupeKey: 'unassigned:100' })
    expect(() => message(s.mail, tid(1), { dedupeKey: 'unassigned:100' })).toThrow(/UNIQUE/)
    // Another thread, another key, and any number of messages with none
    expect(() => message(s.mail, tid(2), { dedupeKey: 'unassigned:100' })).not.toThrow()
    expect(() => message(s.mail, tid(1), { dedupeKey: 'unassigned:200' })).not.toThrow()
    expect(() => message(s.mail, tid(1))).not.toThrow()
    expect(() => message(s.mail, tid(1))).not.toThrow()
    // A key is its sender's own: a session cannot use up the key an app or Centralu will use
    expect(() => message(s.mail, tid(1), { dedupeKey: 'unassigned:100', sender: `session:${HOST}/s1` })).not.toThrow()
    expect(s.mail.messageByDedupeKey(tid(1), 'centralu', 'unassigned:100')?.sender).toBe('centralu')
    expect(s.mail.messageByDedupeKey(tid(1), `session:${HOST}/s1`, 'unassigned:100')?.sender).toBe(`session:${HOST}/s1`)
    expect(s.mail.messageByDedupeKey(tid(1), `session:${HOST}/s2`, 'unassigned:100')).toBeUndefined()
  })

  it('numbers a thread’s messages 1, 2, 3 and each thread on its own', () => {
    const s = new Store()
    s.mail.insertThread(thread(tid(1)), NOW)
    s.mail.insertThread(thread(tid(2)), NOW)
    const seqs = [message(s.mail, tid(1)), message(s.mail, tid(1)), message(s.mail, tid(2)), message(s.mail, tid(1))].map((m) => [m.threadId, m.seq, m.homeSeq])
    expect(seqs).toEqual([[tid(1), 1, 1], [tid(1), 2, 2], [tid(2), 1, 1], [tid(1), 3, 3]])
  })
})

describe('retention (§4.4)', () => {
  it('keeps a thread that is not done however old its messages are', () => {
    const s = new Store()
    for (const [n, state] of [[1, 'open'], [2, 'running'], [3, 'review'], [4, 'blocked']] as const) {
      s.mail.insertThread(thread(tid(n), { state, assignee: `session:${HOST}/s${n}`, owner: 'person' }), NOW - 400 * DAY)
      message(s.mail, tid(n), { kind: 'assign', at: NOW - 400 * DAY, recipients: [`session:${HOST}/s${n}`] })
      message(s.mail, tid(n), { kind: 'notice', at: NOW - 399 * DAY })
    }
    const swept = s.mail.sweep(NOW)
    expect(swept).toEqual({ messages: 0, threads: 0 })
    expect(count(s, 'mail_threads')).toBe(4)
    expect(count(s, 'mail_messages')).toBe(8)
    expect(count(s, 'mail_receipts')).toBe(4)
  })

  it('a done thread loses its messages after 30 days but keeps its events, then goes whole after 180', () => {
    const s = new Store()
    doneThread(s.mail, tid(1), 31 * DAY)
    message(s.mail, tid(1), { kind: 'assign', at: NOW - 40 * DAY, recipients: ['person'] })
    message(s.mail, tid(1), { kind: 'report', at: NOW - 32 * DAY, recipients: ['person'] })
    message(s.mail, tid(1), { kind: 'event', at: NOW - 31 * DAY })
    s.mail.putParticipant(tid(1), 'person', 'owner', NOW - 40 * DAY)
    // Within 30 days: untouched
    doneThread(s.mail, tid(2), 29 * DAY)
    message(s.mail, tid(2), { kind: 'report', at: NOW - 29 * DAY, recipients: ['person'] })

    expect(s.mail.sweep(NOW)).toEqual({ messages: 2, threads: 0 })
    expect(s.mail.messagesAfter(tid(1), 0).map((m) => m.kind)).toEqual(['event'])
    expect(count(s, 'mail_receipts', `message_id IN (SELECT id FROM mail_messages WHERE thread_id = '${tid(1)}')`)).toBe(0)
    expect(s.mail.messagesAfter(tid(2), 0)).toHaveLength(1)
    expect(s.mail.participants(tid(1))).toHaveLength(1)

    // A done thread at 181 days is gone with its header
    doneThread(s.mail, tid(3), 181 * DAY)
    message(s.mail, tid(3), { kind: 'event', at: NOW - 181 * DAY })
    s.mail.putParticipant(tid(3), 'person', 'owner', NOW - 181 * DAY)
    s.mail.insertBlocker({ threadId: tid(3), n: 1, kind: 'text', ref: null, text: 'x' })
    expect(s.mail.sweep(NOW)).toEqual({ messages: 1, threads: 1 })
    expect(s.mail.thread(tid(3))).toBeUndefined()
    expect(count(s, 'mail_participants', `thread_id = '${tid(3)}'`)).toBe(0)
    expect(count(s, 'mail_blockers', `thread_id = '${tid(3)}'`)).toBe(0)
    expect(s.mail.thread(tid(1))).toBeDefined()
  })

  it('a pinned done thread is kept whole', () => {
    const s = new Store()
    doneThread(s.mail, tid(1), 400 * DAY)
    message(s.mail, tid(1), { kind: 'report', at: NOW - 400 * DAY })
    s.mail.updateThread(tid(1), { pinnedAt: NOW - 300 * DAY }, NOW, false)
    expect(s.mail.sweep(NOW)).toEqual({ messages: 0, threads: 0 })
    expect(s.mail.messagesAfter(tid(1), 0)).toHaveLength(1)
  })

  it('a thread that is only read news goes after 14 days; an unread notice, a question, an assignee, a standing blocker or a changed task keeps it', () => {
    const s = new Store()
    const old = NOW - 15 * DAY
    // Read news: goes
    s.mail.insertThread(thread(tid(1)), old)
    const read = message(s.mail, tid(1), { kind: 'notice', at: old, recipients: ['person'] })
    s.mail.markRead('person', [read.id], 0)
    // Unread
    s.mail.insertThread(thread(tid(2)), old)
    message(s.mail, tid(2), { kind: 'notice', at: old, recipients: ['person'] })
    // A note, which is not news, read
    s.mail.insertThread(thread(tid(3)), old)
    const q = message(s.mail, tid(3), { kind: 'note', at: old, recipients: ['person'] })
    s.mail.markRead('person', [q.id], 0)
    // With an assignee
    s.mail.insertThread(thread(tid(4), { assignee: `session:${HOST}/s4` }), old)
    const n4 = message(s.mail, tid(4), { kind: 'notice', at: old, recipients: ['person'] })
    s.mail.markRead('person', [n4.id], 0)
    // With a blocker that stands
    s.mail.insertThread(thread(tid(5)), old)
    const n5 = message(s.mail, tid(5), { kind: 'notice', at: old, recipients: ['person'] })
    s.mail.markRead('person', [n5.id], 0)
    s.mail.insertBlocker({ threadId: tid(5), n: 1, kind: 'text', ref: null, text: 'waiting' })
    // A task that lost its assignee, with a notice read: it was never only news
    s.mail.insertThread(thread(tid(7), { assignee: `session:${HOST}/s7`, state: 'running' }), old)
    const n7 = message(s.mail, tid(7), { kind: 'notice', at: old, recipients: ['person'] })
    s.mail.markRead('person', [n7.id], 0)
    s.mail.updateThread(tid(7), { assignee: null, state: 'open' }, old, true)
    // Read news, but recent
    s.mail.insertThread(thread(tid(6)), NOW - 13 * DAY)
    const n6 = message(s.mail, tid(6), { kind: 'notice', at: NOW - 13 * DAY, recipients: ['person'] })
    s.mail.markRead('person', [n6.id], 0)

    expect(s.mail.sweep(NOW)).toEqual({ messages: 1, threads: 1 })
    expect(s.mail.thread(tid(1))).toBeUndefined()
    for (const n of [2, 3, 4, 5, 6, 7]) expect(s.mail.thread(tid(n)), `thread ${n}`).toBeDefined()
  })

  it('a thread past 2,000 messages loses its oldest notices first and nothing else', () => {
    const s = new Store()
    s.mail.insertThread(thread(tid(1), { assignee: `session:${HOST}/s1` }), NOW)
    message(s.mail, tid(1), { kind: 'assign' })
    for (let i = 0; i < 10; i++) message(s.mail, tid(1), { kind: 'notice' })
    message(s.mail, tid(1), { kind: 'report' })
    message(s.mail, tid(1), { kind: 'event' })

    // A limit of 8 for the test: 13 messages, 5 over, the oldest 5 notices go
    expect(s.mail.sweep(NOW, { maxMessages: 8 })).toEqual({ messages: 5, threads: 0 })
    const left = s.mail.messagesAfter(tid(1), 0)
    expect(left.map((m) => m.kind)).toEqual(['assign', 'notice', 'notice', 'notice', 'notice', 'notice', 'report', 'event'])
    // Over its size with nothing but an assign and a report to cut: they stay
    expect(s.mail.sweep(NOW, { maxMessages: 3 })).toEqual({ messages: 5, threads: 0 })
    expect(s.mail.messagesAfter(tid(1), 0).map((m) => m.kind)).toEqual(['assign', 'report', 'event'])
    expect(s.mail.sweep(NOW, { maxMessages: 1 })).toEqual({ messages: 0, threads: 0 })
  })

  it('works through a large backlog in batches', () => {
    const s = new Store()
    for (let n = 1; n <= 7; n++) doneThread(s.mail, tid(n), 200 * DAY)
    expect(s.mail.sweep(NOW, { batch: 2 })).toEqual({ messages: 0, threads: 7 })
    expect(count(s, 'mail_threads')).toBe(0)
  })
})

describe('a session purged from the session archive (§4.1)', () => {
  const sessionRow = (s: Store, id: string) =>
    s.sessions.upsertSession({
      id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
      importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
  const KEEP = { projectId: 'p1', projectName: 'alpha', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false }

  it('takes its receipts, its place in threads and its turns with it, and leaves the thread, its messages and everyone else’s rows', async () => {
    const s = new Store()
    // This host's id, as `hubSelfId` keeps it: the purge matches this host's own addresses
    s.settings.setAppSetting('hub.selfId', HOST)
    s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'alpha' })
    sessionRow(s, 'gone')
    sessionRow(s, 'stays')
    const gone = `session:${HOST}/gone`
    const stays = `session:${HOST}/stays`
    s.mail.insertThread(thread(tid(1), { owner: stays, assignee: gone }), NOW)
    s.mail.putParticipant(tid(1), stays, 'owner', NOW)
    s.mail.putParticipant(tid(1), gone, 'assignee', NOW)
    const m = message(s.mail, tid(1), { kind: 'assign', sender: stays, recipients: [gone] })
    const back = message(s.mail, tid(1), { kind: 'report', sender: gone, recipients: [stays] })
    s.mail.startTurn({ sessionId: 'gone', turnSeq: 1, threadId: tid(1), startedBy: 'mail', startedAt: NOW })
    s.mail.startTurn({ sessionId: 'stays', turnSeq: 1, threadId: null, startedBy: 'person', startedAt: NOW })
    // A session whose id merely ends the same way is not it, and neither is a session of another host with its id (slice 4)
    sessionRow(s, 'not-gone')
    s.mail.putParticipant(tid(1), `session:${HOST}/not-gone`, 'member', NOW)
    const elsewhere = 'session:hub-bbbbbbbb/gone'
    s.mail.putParticipant(tid(1), elsewhere, 'member', NOW)
    const toElsewhere = message(s.mail, tid(1), { kind: 'note', sender: stays, recipients: [elsewhere] })

    // Not yet in the session archive: nothing happens
    expect(await s.trash.purgeSession('gone')).toBe(false)
    expect(s.mail.receiptsOf(m.id)).toHaveLength(1)

    await s.trash.trashSession('gone', KEEP)
    // In the session archive its rows stay, so that restoring it brings them back
    expect(s.mail.receiptsOf(m.id)).toHaveLength(1)
    expect(await s.trash.purgeSession('gone')).toBe(true)

    expect(s.mail.receiptsOf(m.id)).toEqual([])
    expect(s.mail.receiptsOf(back.id)).toHaveLength(1)
    expect(s.mail.participants(tid(1)).map((p) => p.address).sort()).toEqual([stays, `session:${HOST}/not-gone`, elsewhere].sort())
    expect(s.mail.receiptsOf(toElsewhere.id)).toHaveLength(1)
    expect(count(s, 'mail_turns', `session_id = 'gone'`)).toBe(0)
    expect(count(s, 'mail_turns', `session_id = 'stays'`)).toBe(1)
    // The thread and what was said in it are the task's history
    expect(s.mail.thread(tid(1))).toBeDefined()
    expect(s.mail.messagesAfter(tid(1), 0)).toHaveLength(3)
  })

  it('on a host that never made mail there is no id and nothing to delete, and a purge still works', async () => {
    const s = new Store()
    s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'alpha' })
    sessionRow(s, 'gone')
    await s.trash.trashSession('gone', KEEP)
    expect(await s.trash.purgeSession('gone')).toBe(true)
  })
})

describe('the indexes v61 makes now, so that no later step has to', () => {
  const plan = (s: Store, sql: string, ...args: unknown[]) =>
    (dbOf(s).prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((p) => p.detail).join(' | ')

  it('a thread’s running turn is found by mail_turns_open, not by reading a row for every turn of every session', () => {
    const s = new Store()
    expect(plan(s, `SELECT 1 FROM mail_turns WHERE thread_id = ? AND ended_at IS NULL LIMIT 1`, 'x')).toContain('mail_turns_open')
    s.mail.insertThread(thread(tid(1)), NOW)
    expect(s.mail.hasOpenTurn(tid(1))).toBe(false)
    s.mail.startTurn({ sessionId: 's1', turnSeq: 1, threadId: tid(1), startedBy: 'mail', startedAt: NOW })
    expect(s.mail.hasOpenTurn(tid(1))).toBe(true)
    s.mail.endTurn('s1', 1, NOW + 1, 'finished')
    expect(s.mail.hasOpenTurn(tid(1))).toBe(false)
  })

  it('a thread opened under a key is found by it without reading every message', () => {
    const s = new Store()
    expect(plan(s, `SELECT * FROM mail_messages WHERE sender = ? AND dedupe_key = ? AND seq = 1`, 'a', 'b')).toContain('mail_messages_dedupe')
  })
})

describe('retention takes the write lock before it reads (L10)', () => {
  it('every batch is an immediate transaction, so a host that commits in between does not fail it at once', () => {
    const s = new Store()
    doneThread(s.mail, tid(1), 200 * DAY)
    message(s.mail, tid(1), { kind: 'report', at: NOW - 200 * DAY })
    s.mail.insertThread(thread(tid(2), { assignee: `session:${HOST}/s2` }), NOW)
    for (let i = 0; i < 4; i++) message(s.mail, tid(2), { kind: 'notice' })
    const used: string[] = []
    const real = dbOf(s)
    const spy = new Proxy(real, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (fn: () => unknown) => {
            const t = target.transaction(fn)
            const wrapped = Object.assign(
              () => {
                used.push('deferred')
                return t()
              },
              {
                immediate: () => {
                  used.push('immediate')
                  return t.immediate()
                },
              },
            )
            return wrapped
          }
        }
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
    const swept = sweepMail(spy, NOW, { maxMessages: 2 })
    expect(swept.threads).toBe(1)
    expect(swept.messages).toBeGreaterThan(1)
    expect(used.length).toBeGreaterThan(2)
    expect(used.every((u) => u === 'immediate')).toBe(true)
  })
})

describe('retention of turns (§4.1)', () => {
  const turn = (s: Store, session: string, seq: number, threadId: string | null, ended: boolean) => {
    s.mail.startTurn({ sessionId: session, turnSeq: seq, threadId, startedBy: threadId ? 'caller' : 'person', startedAt: NOW - 1000 + seq })
    if (ended) s.mail.endTurn(session, seq, NOW, 'acted')
  }
  const seqs = (s: Store, session: string) => s.mail.turnsOf(session).map((t) => t.turnSeq)

  it('a turn of no thread goes once a later one of the session has ended; the latest ended one, a running one and a thread’s turns stay', () => {
    const s = new Store()
    s.mail.insertThread(thread(tid(1)), NOW)
    // s1: three of the person’s, the last still running; a turn of a thread between
    turn(s, 's1', 1, null, true)
    turn(s, 's1', 2, tid(1), true)
    turn(s, 's1', 3, null, true)
    turn(s, 's1', 4, null, false)
    // s2: one ended turn of no thread is the latest ended one
    turn(s, 's2', 1, null, true)
    sweepMail(dbOf(s), NOW)
    expect(seqs(s, 's1')).toEqual([2, 3, 4])
    expect(seqs(s, 's2')).toEqual([1])
    // Again, and a session with many: only the newest ended one stays
    for (let i = 5; i < 60; i++) turn(s, 's1', i, null, true)
    sweepMail(dbOf(s), NOW, { batch: 7 })
    expect(seqs(s, 's1')).toEqual([2, 4, 59])
  })

  it('a turn of a thread that goes becomes a turn of none and goes in the same sweep, the latest ended one excepted', () => {
    const s = new Store()
    doneThread(s.mail, tid(1), 200 * DAY)
    turn(s, 's1', 1, tid(1), true)
    turn(s, 's1', 2, null, true)
    sweepMail(dbOf(s), NOW)
    expect(s.mail.thread(tid(1))).toBeUndefined()
    expect(seqs(s, 's1')).toEqual([2])
  })
})
