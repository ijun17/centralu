/** T1-2 done criteria: whether the schema is actually applied and CRUD works */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GridPanel, SessionInfo, StoredMessage } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'

/**
 * The current latest schema version — bump **only this one place** when adding a migration.
 * v22, v23 and v24 broke the same six assertions one after another: if the version is written
 * six times, every migration bills six small chores.
 */
const LATEST_SCHEMA = 42

function seeded() {
  const s = new Store()
  s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.upsertSession({
    id: 's1', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'New session',
    autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
    ...sessionLiveDefaults(),
  })
  return s
}

/** A session's grid panel (#288) */
const sp = (sessionId: string): GridPanel => ({ kind: 'session', sessionId })

/** A plain worker session in `projectId`, for the grid's tests */
function gridSession(s: Store, id: string, projectId: string) {
  s.upsertSession({
    id, projectId, kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
}

/** A trash record that removes nothing outside the store when purged */
const KEEP_ALL = { projectId: 'p1', projectName: 'p1', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false }

/** Counts one session's search index rows straight from the table — `searchMessages` filters the trash, this does not */
function indexRowsOf(s: Store, sessionId: string): () => number {
  const db = (s as unknown as { db: Database.Database }).db
  const q = db.prepare(`SELECT COUNT(*) as n FROM messages_fts WHERE session_id = ?`)
  return () => (q.get(sessionId) as { n: number }).n
}

/**
 * v10 rebuilds the table whole (SQLite cannot drop a NOT NULL).
 * This is the riskiest change in this project, so **actual data is loaded into an old database
 * and actually migrated.** Silently losing even one row would be unrecoverable.
 */
describe('v10 migration — allows a session with no project', () => {
  it('the sessions and messages of an old database (v9) survive the move intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v10-'))
    const file = join(dir, 'store.db')

    // Build a v9-state database by hand (project_id NOT NULL)
    const old = new Database(file)
    old.pragma('foreign_keys = ON')
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
        auto_named INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0, is_orchestrator INTEGER NOT NULL DEFAULT 0,
        last_read_seq INTEGER NOT NULL DEFAULT 0, waiting_since INTEGER, created_at INTEGER NOT NULL,
        touched_paths TEXT NOT NULL DEFAULT '[]', model TEXT, effort TEXT,
        permission_preset TEXT NOT NULL DEFAULT 'normal', imported_from TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1)`).run()
    for (const id of ['s1', 's2', 's3']) {
      old.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at) VALUES (?,?,?,?,?)`)
        .run(id, 'p1', 'claude', 'name ' + id, 1)
      old.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`).run(id, 1, 'user', 'text', '{"text":"hello"}', 1)
    }
    old.pragma('user_version = 9')
    old.close()

    const store = new Store(file)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA)
    expect(store.listSessions().map((x) => x.id).sort()).toEqual(['s1', 's2', 's3'])
    expect(store.listSessions().find((x) => x.id === 's2')?.name).toBe('name s2')
    expect(store.loadMessages('s1').length).toBe(1)

    // And now a session with no project is inserted
    store.upsertSession({
      id: 'orc', projectId: null, kind: 'orchestrator', tool: 'claude', externalId: null, name: 'Orchestrator',
      autoNamed: false, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: 1, waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null,
      permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
    expect(store.listSessions().find((x) => x.id === 'orc')?.projectId).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('Store (dev sqlite)', () => {
  it('migrates all the way to the latest schema', () => {
    expect(new Store().schemaVersion).toBe(LATEST_SCHEMA)
  })

  /**
   * Opening the database a second time runs **zero** migrations.
   *
   * This is nailed down because it was broken for a long time. schema.sql used to rewrite
   * `user_version = 1` on every open, so even a v27 database replayed all 26 steps from
   * scratch on every run — every step was idempotent, so the result stayed correct, and
   * **nobody noticed.** The measured cost was 4.4 to 5.0 seconds per open (a 94MB store.db,
   * 66,700 messages; v3, v11 and v21 each scanned the whole table).
   *
   * This is measured by count, not by time. Time depends on the machine and the data size, but
   * "did it run again" has the same answer everywhere.
   */
  it('a migration that has already run does not run again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-store-'))
    const file = join(dir, 'store.db')

    const first = new Store(file)
    expect(first.migrationsRun).toBeGreaterThan(0)
    expect(first.schemaVersion).toBe(LATEST_SCHEMA)
    first.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    first.close()

    const again = new Store(file)
    expect(again.migrationsRun).toBe(0)
    expect(again.schemaVersion).toBe(LATEST_SCHEMA)
    // And the data is intact — "did not run" must not mean "cannot be read"
    expect(again.listProjects().map((p) => p.id)).toEqual(['p1'])
    again.close()

    rmSync(dir, { recursive: true, force: true })
  })

  it('registers and lists projects; a duplicate path is treated as an update', () => {
    const s = seeded()
    s.addProject({ id: 'p1b', path: '/tmp/p1', name: 'Renamed' })
    const list = s.listProjects()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('Renamed')
  })

  it('session upsert and listing', () => {
    const s = seeded()
    const before = s.listSessions()[0]!
    expect(before.autoNamed).toBe(true)
    s.upsertSession({ ...before, name: 'auth refactor', autoNamed: false, state: 'working' })
    const after = s.listSessions()[0]!
    expect(after.name).toBe('auth refactor')
    expect(after.autoNamed).toBe(false)
    expect(after.state).toBe('working')
  })

  /*
   * The UPDATE clause used to be missing tool, so switching agents (claude to codex) was never
   * saved. On restart the tool reverted to claude, but by then the thread to resume from
   * (external_id), already broken by the switch, turned the session into one that could not
   * even be recovered.
   */
  it('a tool switch is saved — it is still codex after restart', () => {
    const s = seeded()
    const before = s.listSessions()[0]!
    s.upsertSession({ ...before, tool: 'codex', externalId: null, importedFrom: null })
    const after = s.listSessions()[0]!
    expect(after.tool).toBe('codex')
    expect(after.externalId).toBeNull()
  })

  it('message append/load and seq incrementing', () => {
    const s = seeded()
    expect(s.nextSeq('s1')).toBe(1)
    s.appendMessages([
      { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: 'hello' }, ts: 1 },
      { sessionId: 's1', seq: 2, role: 'assistant', kind: 'text', payload: { text: 'yes' }, ts: 2 },
    ])
    expect(s.nextSeq('s1')).toBe(3)
    const msgs = s.loadMessages('s1')
    expect(msgs.map((m) => m.seq)).toEqual([1, 2])
    expect(msgs[0]!.payload).toEqual({ text: 'hello' })
    expect(s.listSessions()[0]!.lastSeq).toBe(2)
  })

  it('pagination: only what comes before beforeSeq', () => {
    const s = seeded()
    s.appendMessages(
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: 's1', seq: i + 1, role: 'user' as const, kind: 'text' as const, payload: { i }, ts: i,
      })),
    )
    expect(s.loadMessages('s1', 2, 4).map((m) => m.seq)).toEqual([2, 3])
  })

  it('the read position never moves backward', () => {
    const s = seeded()
    s.markRead('s1', 5)
    s.markRead('s1', 3)
    expect(s.listSessions()[0]!.lastReadSeq).toBe(5)
  })

  it('saves and lists approval rules', () => {
    const s = seeded()
    s.addApprovalRule({ scope: 'session', sessionId: 's1', matcher: 'npm test*', decision: 'allow' })
    const rules = s.listApprovalRules()
    expect(rules).toHaveLength(1)
    expect(rules[0]!.matcher).toBe('npm test*')
  })
})

describe('migrations (E-0)', () => {
  it('opening a v1 database adds new columns and FTS, and existing messages become searchable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-migrate-'))
    const file = join(dir, 'old.db')

    // Build a v1 state by hand (neither touched_paths nor messages_fts exist)
    const raw = new Database(file)
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, tool TEXT, external_id TEXT,
        name TEXT, auto_named INTEGER, state TEXT, archived INTEGER, last_read_seq INTEGER,
        waiting_since INTEGER, created_at INTEGER);
      CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, kind TEXT, payload TEXT, ts INTEGER,
        PRIMARY KEY (session_id, seq));
      INSERT INTO sessions VALUES ('s1','p1','claude',NULL,'Old session',1,'idle',0,0,NULL,0);
      INSERT INTO messages VALUES ('s1',1,'assistant','text','{"text":"승인을 기다립니다"}',0);
      PRAGMA user_version = 1;
    `)
    raw.close()

    const store = new Store(file)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA)

    // Only the backfill lets an old conversation be found
    const hits = store.searchMessages('승인')
    expect(hits.length).toBe(1)
    expect(hits[0]!.sessionId).toBe('s1')

    // The new column is usable too
    store.setTouchedPaths('s1', ['src/a.ts'])
    expect(store.getTouchedPaths('s1')).toEqual(['src/a.ts'])

    // v4: model and permission are also attached to an existing session (with default values)
    const migrated = store.listSessions().find((s) => s.id === 's1')
    expect(migrated).toMatchObject({ model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null })

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a search still matches a word with a Korean particle attached (trigram tokenizer)', () => {
    const s = seeded()
    s.appendMessages([
      { sessionId: 's1', seq: 10, role: 'assistant', kind: 'text', payload: { text: '승인을 기다리는 중입니다' }, ts: 0 },
    ])
    // With unicode61, searching '승인' would not find '승인을' — a real problem this app runs into
    expect(s.searchMessages('승인').length).toBe(1)
    expect(s.searchMessages('기다리').length).toBe(1)
    s.close()
  })

  /*
   * The index held 8.6 times more rows than messages (real database: 28,892 messages, 249,809
   * index rows). messages overwrites, but the index was a plain INSERT, so rewriting the same
   * spot stacked up another row every time. This is where recall repeating the same line came
   * from, and where the index bloating to tens of times the size of the actual text came from.
   */
  it('rewriting the same message does not grow the index', () => {
    const s = seeded()
    const msg = {
      sessionId: 's1', seq: 10, role: 'assistant' as const, kind: 'text' as const,
      payload: { text: 'milky way gradient' }, ts: 0,
    }
    for (let i = 0; i < 5; i++) s.appendMessages([msg])
    expect(s.searchMessages('milky way').length).toBe(1)
    s.close()
  })

  it('rewriting the content makes the old content unsearchable', () => {
    const s = seeded()
    const at = { sessionId: 's1', seq: 11, role: 'assistant' as const, kind: 'text' as const, ts: 0 }
    s.appendMessages([{ ...at, payload: { text: 'old content' } }])
    s.appendMessages([{ ...at, payload: { text: 'new content' } }])
    expect(s.searchMessages('old content').length).toBe(0)
    expect(s.searchMessages('new content').length).toBe(1)
    s.close()
  })

  /*
   * The statement that removed a spot with no body from the index used to be FTS5's 'delete'
   * command. That command only works on contentless or external-content tables, so it always
   * failed with SQL logic error, and rolled back other messages in the same batch along with it
   * (#179).
   */
  it('rewriting an indexed spot with no body leaves the batch intact and makes the old body unsearchable', () => {
    const s = seeded()
    const at = { sessionId: 's1', role: 'assistant' as const, kind: 'text' as const, ts: 0 }
    s.appendMessages([{ ...at, seq: 1, payload: { text: 'hello world' } }])
    expect(s.searchMessages('hello').length).toBe(1)
    s.appendMessages([
      { ...at, seq: 2, role: 'user', payload: { text: 'newly arrived words' } },
      { ...at, seq: 1, payload: { type: 'tool' } },
    ])
    expect(s.loadMessages('s1').map((m) => m.seq)).toEqual([1, 2])
    expect(s.loadMessages('s1')[0]!.payload).toEqual({ type: 'tool' })
    expect(s.searchMessages('hello').length).toBe(0)
    expect(s.searchMessages('newly arrived').length).toBe(1)
    s.close()
  })

  /*
   * Deleting one large session in a single transaction froze the host for nearly two seconds
   * (#179, 1.96s on a real-database session with 49,710 messages). The event loop has to turn
   * between chunks, and no matter which chunk boundary this is stopped at, the remaining
   * messages and the index have to agree with each other.
   * Since #204 that is purging a session from the trash; the index rows it meets are the ones a trash step cut
   * short left behind, so they are put back here first to give the chunks something to keep in step.
   */
  it('purging a session lets the event loop go between chunks, and its messages and index rows leave together', async () => {
    const s = seeded()
    const n = 1000
    s.appendMessages(
      Array.from({ length: n }, (_, i) => ({
        // A human's words are never joined together — loadMessages's count is exactly the row count
        sessionId: 's1', seq: i + 1, role: 'user' as const, kind: 'text' as const,
        payload: { text: `test message ${i}` }, ts: i,
      })),
    )
    const fts = indexRowsOf(s, 's1')
    await s.trashSession('s1', KEEP_ALL)
    s.appendMessages(s.loadMessages('s1', n)) // the index rows a cut-short trash step would have left
    expect(fts()).toBe(n)
    const seen: { messages: number; hits: number }[] = []
    let deleting = true
    const look = () => {
      if (!deleting) return
      seen.push({ messages: s.loadMessages('s1', n).length, hits: fts() })
      setImmediate(look)
    }
    setImmediate(look)
    await s.purgeSession('s1', 100)
    deleting = false
    // If this finished in one shot, look would never have run even once
    expect(seen.length).toBeGreaterThanOrEqual(5)
    for (const at of seen) expect(at.hits).toBe(at.messages)
    expect(seen.some((at) => at.messages > 0 && at.messages < n)).toBe(true)
    expect(s.listSessions().map((x) => x.id)).not.toContain('s1')
    expect(s.listTrash()).toEqual([])
    expect(s.loadMessages('s1')).toEqual([])
    expect(fts()).toBe(0)
    s.close()
  })

  it('returns the whole body — trimming it is left to the caller', () => {
    const s = seeded()
    const long = `${'앞'.repeat(300)}은하수${'뒤'.repeat(300)}`
    s.appendMessages([
      { sessionId: 's1', seq: 12, role: 'assistant', kind: 'text', payload: { text: long }, ts: 0 },
    ])
    // This used to be cut off at around 15 characters by snippet(...,12), unable to tell what it was
    expect(s.searchMessages('은하수')[0]!.body).toBe(long)
    s.close()
  })
})

describe('migration v5 — the original conversation an import inherited', () => {
  it('the imported_from column exists and round-trips', () => {
    const store = new Store()
    store.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    const base = {
      id: 's-import', projectId: 'p1', kind: 'worker' as const, tool: 'claude' as const, externalId: 'ext-new',
      name: 'Imported conversation', autoNamed: true, state: 'idle' as const,
      lastReadSeq: 0, lastSeq: 0, createdAt: Date.now(), waitingSince: null, live: true,
      model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal' as const, importedFrom: 'ext-old', worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
      ...sessionLiveDefaults(),
    }
    store.upsertSession(base)
    const back = store.listSessions().find((s) => s.id === 's-import')!
    // Even when resume issues a new identifier, which conversation it came from must survive
    expect(back.importedFrom).toBe('ext-old')
    expect(back.externalId).toBe('ext-new')
  })
})

/**
 * Reasoning effort is the same kind of property as the model, so it has to persist with the
 * session. It is a column added to a database already in use, so this checks that the
 * migration actually runs.
 */
describe('migration v7 — reasoning effort', () => {
  const row = (over: Partial<SessionInfo>): SessionInfo => ({
    id: 's-x', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'Session',
    autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true,
    model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
    ...sessionLiveDefaults(),
    ...over,
  })

  it('the effort column exists and round-trips', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-effort', effort: 'xhigh', model: 'fable' }))
    const back = store.listSessions().find((r) => r.id === 's-effort')
    expect(back?.effort).toBe('xhigh')
    expect(back?.model).toBe('fable')
    store.close()
  })

  it('a session with no effort chosen stays null — distinct from an empty string', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-none' }))
    expect(store.listSessions().find((r) => r.id === 's-none')?.effort).toBeNull()
    store.close()
  })
})

/**
 * v18 — response length (#54). This is a spot with the same recurring trap as model (v4) and
 * effort (v7): add a column and miss one of the four places (DDL, INSERT, UPDATE, SELECT), and
 * it compiles fine while the value just quietly disappears. A round-trip test checks all four
 * places at once.
 */
describe('migration v18 — response length', () => {
  const row = (over: Partial<SessionInfo>): SessionInfo => ({
    id: 's-x', projectId: 'p1', kind: 'worker', tool: 'codex', externalId: null, name: 'Session',
    autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true,
    model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
    ...sessionLiveDefaults(),
    ...over,
  })

  it('the verbosity column exists and round-trips', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-verb', verbosity: 'low' }))
    expect(store.listSessions().find((r) => r.id === 's-verb')?.verbosity).toBe('low')
    // An update persists too — missing it from the UPDATE clause would save it only the first time and never after
    store.upsertSession(row({ id: 's-verb', verbosity: 'high' }))
    expect(store.listSessions().find((r) => r.id === 's-verb')?.verbosity).toBe('high')
    store.close()
  })

  it('a session with none chosen is null — distinct from the tool default', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-verb-none' }))
    expect(store.listSessions().find((r) => r.id === 's-verb-none')?.verbosity).toBeNull()
    store.close()
  })

  /** Response speed (v20) is the same kind of property — the same round-trip contract */
  it('the service_tier column exists and round-trips', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-tier', serviceTier: 'priority' }))
    expect(store.listSessions().find((r) => r.id === 's-tier')?.serviceTier).toBe('priority')
    store.upsertSession(row({ id: 's-tier', serviceTier: null }))
    expect(store.listSessions().find((r) => r.id === 's-tier')?.serviceTier).toBeNull()
    store.close()
  })
})

/**
 * The sidebar order was set by a person, so it **has to survive a restart.** This also checks
 * that saving a session (upsert) does not overwrite the order — upsert runs on every line of a
 * conversation, and if the order reset there, what the person arranged would keep getting
 * shuffled.
 */
describe('migration v8 — sidebar order', () => {
  it('saves session order and reads it back in that order', () => {
    const s = seeded()
    for (const id of ['s2', 's3']) {
      s.upsertSession({
        id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id,
        autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
        createdAt: Date.now(), waitingSince: null, live: true,
        model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
        ...sessionLiveDefaults(),
      })
    }
    s.setSessionOrder(['s3', 's1', 's2'])
    expect(s.listSessions().map((x) => x.id)).toEqual(['s3', 's1', 's2'])
    s.close()
  })

  it('saving a session again does not disturb the order', () => {
    const s = seeded()
    s.setSessionOrder(['s1'])
    const before = s.listSessions()[0]!
    s.upsertSession({ ...before, name: 'renamed' })
    expect(s.listSessions().map((x) => x.name)).toEqual(['renamed'])
    s.close()
  })

  it('project order is saved too', () => {
    const s = seeded()
    s.addProject({ id: 'p2', path: '/tmp/p2', name: 'p2' })
    s.setProjectOrder(['p2', 'p1'])
    expect(s.listProjects().map((p) => p.id)).toEqual(['p2', 'p1'])
    s.close()
  })
})

/**
 * The grid layout has to **survive a restart** — it is a screen a person arranged. Since it is
 * kept separate from the sessions table, this also checks that saving a session does not
 * disturb the layout.
 */
describe('migration v9 — the grid layout', () => {
  it('comes back in the order it was placed', () => {
    const s = seeded()
    for (const id of ['s2', 's3']) {
      s.upsertSession({
        id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id,
        autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
        createdAt: Date.now(), waitingSince: null, live: true,
        model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
        ...sessionLiveDefaults(),
      })
    }
    s.setGridView([sp('s3'), sp('s1')])
    expect(s.listGridView()).toEqual([sp('s3'), sp('s1')])
    s.close()
  })

  it('rewrites the whole thing — adding, removing and reordering all come through the same call', () => {
    const s = seeded()
    s.setGridView([sp('s1')])
    s.setGridView([])
    expect(s.listGridView()).toEqual([])
    s.close()
  })

  it('the layout stays put even after resaving a session', () => {
    const s = seeded()
    s.setGridView([sp('s1')])
    const before = s.listSessions()[0]!
    s.upsertSession({ ...before, name: 'renamed' })
    expect(s.listGridView()).toEqual([sp('s1')])
    s.close()
  })

  it('deleting a session drops it from the layout too — it must not try to draw something that no longer exists', async () => {
    const s = seeded()
    s.setGridView([sp('s1')])
    await s.trashSession('s1', KEEP_ALL)
    expect(s.listGridView()).toEqual([])
    s.close()
  })
})

/**
 * v42: apps stand on the grid too (#288). The table is rebuilt, so the panels a person already
 * arranged are moved through a real v41-shaped table — a grid that comes back empty after an
 * update reads as the app forgetting.
 */
describe('migration v42 — the grid holds apps as well as sessions', () => {
  const ap = (projectId: string | null, appId: string): GridPanel => ({ kind: 'app', projectId, appId })

  it('a v41 grid of session ids comes back as the same sessions, in the same order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v42-'))
    const file = join(dir, 'store.db')
    try {
      const fresh = new Store(file)
      fresh.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
      for (const id of ['s1', 's2', 's3']) gridSession(fresh, id, 'p1')
      fresh.close()
      // Take the grid back to v41: one row per session id
      const raw = new Database(file)
      raw.exec(`
        DROP TABLE grid_layout;
        INSERT INTO grid_panels (session_id, position) VALUES ('s3', 0), ('s1', 1), ('s2', 2);
      `)
      // A row whose session is gone, written with the key unenforced: never shown, and it must not stop the copy
      raw.pragma('foreign_keys = OFF')
      raw.exec(`INSERT INTO grid_panels (session_id, position) VALUES ('vanished', 3)`)
      raw.pragma('user_version = 41')
      raw.close()

      const s = new Store(file)
      expect(s.schemaVersion).toBe(LATEST_SCHEMA)
      expect(s.migrationsRun).toBe(LATEST_SCHEMA - 41)
      expect(s.listGridView()).toEqual([sp('s3'), sp('s1'), sp('s2')])
      // Now an app can stand between them
      s.setGridView([sp('s3'), ap('p1', 'slider'), sp('s1')])
      expect(s.listGridView()).toEqual([sp('s3'), ap('p1', 'slider'), sp('s1')])
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /*
   * #292's rule: v42 only expands. A v41 host opening the same store still reads and rewrites `grid_panels` with its own
   * statements (copied here from that build's listGridView and setGridView), and this build's list is untouched by it.
   */
  it('leaves grid_panels as a v41 host reads and writes it, and this build’s list apart from it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v42-old-'))
    const file = join(dir, 'store.db')
    try {
      const s = new Store(file)
      s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
      for (const id of ['s1', 's2']) gridSession(s, id, 'p1')
      s.setGridView([ap('p1', 'slider'), sp('s1')])
      s.close()

      const older = new Database(file)
      older.pragma('foreign_keys = ON')
      older.transaction(() => {
        older.prepare(`DELETE FROM grid_panels`).run()
        const ins = older.prepare(`INSERT INTO grid_panels (session_id, position) VALUES (?, ?)`)
        ;['s2', 's1'].forEach((id, i) => ins.run(id, i))
      })()
      const read = older
        .prepare(
          `SELECT g.session_id FROM grid_panels g JOIN sessions s ON s.id = g.session_id
           WHERE s.deleted_at IS NULL ORDER BY g.position`,
        )
        .all() as { session_id: string }[]
      expect(read.map((r) => r.session_id)).toEqual(['s2', 's1'])
      const minReader = older.prepare(`SELECT value FROM app_settings WHERE key = 'min_reader_version'`).get() as
        | { value: string }
        | undefined
      expect(Number(minReader?.value ?? 0)).toBeLessThan(42)
      older.close()

      const again = new Store(file)
      expect(again.listGridView()).toEqual([ap('p1', 'slider'), sp('s1')])
      again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sessions, a project’s app and a user-folder app keep one order, and a panel named twice keeps its first place', () => {
    const s = seeded()
    s.setGridView([ap(null, 'notes'), sp('s1'), ap('p1', 'slider'), ap('p1', 'slider'), ap(null, 'notes')])
    expect(s.listGridView()).toEqual([ap(null, 'notes'), sp('s1'), ap('p1', 'slider')])
    s.close()
  })

  it('two projects’ apps with the same id are two panels', () => {
    const s = seeded()
    s.addProject({ id: 'p2', path: '/tmp/p2', name: 'p2' })
    s.setGridView([ap('p1', 'slider'), ap('p2', 'slider')])
    expect(s.listGridView()).toEqual([ap('p1', 'slider'), ap('p2', 'slider')])
    s.close()
  })

  it('deleting a project takes its apps off the grid and leaves the rest where they were', () => {
    const s = seeded()
    s.addProject({ id: 'p2', path: '/tmp/p2', name: 'p2' })
    s.setGridView([ap('p2', 'slider'), sp('s1'), ap(null, 'notes'), ap('p1', 'slider')])
    s.deleteProject('p2')
    expect(s.listGridView()).toEqual([sp('s1'), ap(null, 'notes'), ap('p1', 'slider')])
    s.close()
  })
})

/**
 * There is one marker, kind (#13). There used to be a separate markOrchestrator, which meant
 * "two write paths." With the project orchestrator retired (v26), the marked session is once
 * again unique to the app.
 */
describe('the orchestrator marker (kind)', () => {
  const mk = (s: Store, id: string, projectId: string | null, kind: 'worker' | 'orchestrator') =>
    s.upsertSession({
      id, projectId, kind, tool: 'claude', externalId: null, name: id,
      autoNamed: false, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: 1, waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null,
      permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })

  it('the central orchestrator is null when there is no marker', () => {
    expect(seeded().orchestratorId()).toBeNull()
  })

  it('kind round-trips through upsert — there is one write path', () => {
    const s = seeded()
    mk(s, 'orc', null, 'orchestrator')
    expect(s.orchestratorId()).toBe('orc')
    expect(s.listSessions().find((x) => x.id === 'orc')?.kind).toBe('orchestrator')
    // A demotion persists through the same path
    mk(s, 'orc', null, 'worker')
    expect(s.orchestratorId()).toBeNull()
    s.close()
  })

  /**
   * v26 — the safeguard for retiring the project orchestrator (2026-09-01).
   *
   * **This was about to become a promotion, not a demotion.** Once the project-scoped tier is
   * gone from the code, a session that still carries the marker gets, the next time it wakes, a
   * tool that sees **every project** rather than just its own — a privilege escalation that
   * shows up nowhere on screen. So the data is fixed first.
   */
  it('v26: an old marker with a project is cleared, and the central marker survives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v26-'))
    const file = join(dir, 'store.db')

    // Build a v25 state: one project orchestrator plus one central orchestrator
    const before = new Store(file)
    before.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    mk(before, 'proj-orc', 'p1', 'orchestrator')
    mk(before, 'central', null, 'orchestrator')
    before.close()
    const raw = new Database(file)
    raw.pragma('user_version = 25')
    raw.close()

    const after = new Store(file)
    expect(after.schemaVersion).toBe(LATEST_SCHEMA)
    // The marker with a project disappears — the conversation is untouched
    expect(after.listSessions().find((x) => x.id === 'proj-orc')?.kind).toBe('worker')
    // The central one is untouched — the app's only orchestrator
    expect(after.orchestratorId()).toBe('central')
    after.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * The last piece of the rename: the database table name.
 *
 * The data has to survive — a session that vanished from the grid because of a rename becomes
 * "why is the screen empty," and that is not a price worth paying to line up a name.
 */
describe('v13 migration — the old-named table becomes grid_panels', () => { // legacy-name
  it('a saved grid layout survives the move intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v13-'))
    const file = join(dir, 'store.db')

    /*
     * Build an old database by hand (with the table under its old name).
     *
     * **The version number has to be genuine.** This file has the old-named table and no
     * `grid_panels`, which is the shape the database had before v9 (the step that creates
     * grid_panels). This test used to get away with writing 12 — because schema.sql reset
     * user_version to 1, v9 replayed anyway. Once that replay was removed, this lie surfaced
     * immediately (`no such table: grid_panels`). A genuine v12 database has already passed
     * through v9, so it is guaranteed to have that table.
     */
    const old = new Database(file)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
        auto_named INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0, last_read_seq INTEGER NOT NULL DEFAULT 0,
        waiting_since INTEGER, created_at INTEGER NOT NULL, touched_paths TEXT NOT NULL DEFAULT '[]',
        model TEXT, effort TEXT, permission_preset TEXT NOT NULL DEFAULT 'normal',
        imported_from TEXT, worktree_path TEXT, worktree_branch TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
      CREATE TABLE control_center (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, -- legacy-name
        position INTEGER NOT NULL);
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1)`).run()
    old.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at) VALUES ('s1','p1','claude','Pinned session',1)`).run()
    old.prepare(`INSERT INTO control_center (session_id, position) VALUES ('s1', 0)`).run() // legacy-name
    old.pragma('user_version = 8')
    old.close()

    const store = new Store(file)

    expect(store.schemaVersion).toBe(LATEST_SCHEMA)
    expect(store.listGridView()).toEqual([sp('s1')])
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v14: a session's cwd stops being recomputed. (issue #28)
 *
 * The whole failure was a derived path. Renaming the data directory moved the orchestrator's
 * cwd, Claude Code files conversations by working directory, and the tool went looking under a
 * slug that had never existed. So this runs against a real v13-shaped database — a migration
 * that is only assumed to work is exactly the kind that quietly orphans someone's history.
 */
describe('v14 migration — remembers the directory a session was created in', () => {
  const v13Db = (file: string) => {
    const old = new Database(file)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
        auto_named INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0, is_orchestrator INTEGER NOT NULL DEFAULT 0,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        waiting_since INTEGER, created_at INTEGER NOT NULL, touched_paths TEXT NOT NULL DEFAULT '[]',
        model TEXT, effort TEXT, permission_preset TEXT NOT NULL DEFAULT 'normal',
        imported_from TEXT, worktree_path TEXT, worktree_branch TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
      CREATE TABLE grid_panels (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL);
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1)`).run()
    const add = old.prepare(
      `INSERT INTO sessions (id, project_id, tool, name, created_at, is_orchestrator, worktree_path, worktree_branch)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    add.run('plain', 'p1', 'claude', 'Project session', 1, 0, null, null)
    add.run('wt', 'p1', 'claude', 'Worktree session', 1, 0, '/tmp/wt/feature', 'feature')
    add.run('orc', null, 'claude', 'Orchestrator', 1, 1, null, null)
    old.pragma('user_version = 13')
    old.close()
  }

  it('project and worktree sessions are backfilled with their own path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v14-'))
    const file = join(dir, 'store.db')
    v13Db(file)

    const store = new Store(file)

    expect(store.schemaVersion).toBe(LATEST_SCHEMA)
    expect(store.sessionCwd('plain')).toBe('/tmp/p1')
    // A worktree session's history is filed under the worktree, not the project it came from
    expect(store.sessionCwd('wt')).toBe('/tmp/wt/feature')
    rmSync(dir, { recursive: true, force: true })
  })

  /*
   * The orchestrator is the one row SQL cannot answer for: it has no project and no worktree,
   * and the only source left is `orchestratorHome()`, which creates a directory under the
   * user's home. A migration that does that on every open is how `pnpm verify` once created
   * `~/.centralu/orchestrator` and blocked the real data move (see data-dir.ts). So it stays
   * NULL here and the manager resolves it the first time it actually needs a path.
   */
  it('the orchestrator stays NULL — the migration does not touch the home directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v14-orc-'))
    const file = join(dir, 'store.db')
    v13Db(file)

    const store = new Store(file)

    expect(store.sessionCwd('orc')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  /*
   * schema.sql resets user_version to 1, so every migration step replays on every open. A
   * backfill without `WHERE cwd IS NULL` would therefore rewrite the stored path on each
   * start — reintroducing the recomputation this version exists to end.
   */
  it('reopening does not overwrite the recorded path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v14-again-'))
    const file = join(dir, 'store.db')
    v13Db(file)

    const first = new Store(file)
    first.setSessionCwd('plain', '/tmp/where-it-really-started')
    first.close()

    const second = new Store(file)
    expect(second.sessionCwd('plain')).toBe('/tmp/where-it-really-started')
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v15: a project remembers the shell commands saved on it. (issue #44)
 *
 * The Run menu is the only place these are registered, so surviving a relaunch is the whole
 * point — and the failure would be silent in the worst way. A menu that lost them says
 * "nothing saved yet", which reads as "you never added any" rather than as "they are gone",
 * so nobody would think to report it.
 *
 * Run against a real v14-shaped database rather than a fresh one: the column has to arrive
 * on the file people already have, which is the half `CREATE TABLE IF NOT EXISTS` never does.
 */
describe('v15 migration — remembers the shell commands a project registered', () => {
  it('the column exists on an old database (v14), and commands survive a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v15-'))
    const file = join(dir, 'store.db')

    const old = new Database(file)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1)`).run()
    old.pragma('user_version = 14')
    old.close()

    const first = new Store(file)
    expect(first.schemaVersion).toBe(LATEST_SCHEMA)
    // A project that never existed correctly has none — an empty list is exactly 'never registered any'
    expect(first.projectCommands('p1')).toEqual([])
    first.setProjectCommands('p1', [{ command: 'pnpm test', label: 'Test' }, { command: 'pnpm e2e' }])
    first.close()

    const second = new Store(file)
    expect(second.projectCommands('p1')).toEqual([
      { command: 'pnpm test', label: 'Test' },
      { command: 'pnpm e2e' },
    ])
    // A row from before labels (~2026-09-06) is an array of strings — upgraded on read
    second.close()
    const raw2 = new Database(file)
    raw2.prepare(`UPDATE projects SET commands = ? WHERE id = 'p1'`).run('["pnpm dev","pnpm lint"]')
    raw2.close()
    const third = new Store(file)
    expect(third.projectCommands('p1')).toEqual([{ command: 'pnpm dev' }, { command: 'pnpm lint' }])
    // schema.sql resets user_version to 1, so steps replay on every open —
    // a second open must not recreate the column and wipe the list
    expect(third.listProjects().map((p) => p.id)).toEqual(['p1'])
    third.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A value that cannot be parsed reads as 'none'.
   *
   * Throwing here would block the whole path that builds the project list, leaving the sidebar
   * empty — the worst that can be lost has to end at "the menu has to be filled in again."
   */
  it('the project list survives a corrupted value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v15-bad-'))
    const file = join(dir, 'store.db')

    const first = new Store(file)
    first.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    first.close()

    const poke = new Database(file)
    poke.prepare(`UPDATE projects SET commands = ? WHERE id = 'p1'`).run('{ this is not json')
    poke.close()

    const second = new Store(file)
    expect(second.projectCommands('p1')).toEqual([])
    expect(second.listProjects().map((p) => p.name)).toEqual(['p1'])
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v16 — the host's own settings (issue #43).
 *
 * The first one to go in is "check for updates automatically," and this only counts as a
 * setting if the answer **survives a restart.** A checkbox that turns itself back on every time
 * it is switched off is the same as being permanently on.
 *
 * A value that was never written is distinguished from one holding `'false'` — room left so
 * that changing the default later does not overrule the choice of a person who deliberately
 * turned it off.
 */
describe('v16 migration — the host settings survive a restart', () => {
  it('the table exists on an old database, and the value survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v16-'))
    const file = join(dir, 'store.db')

    const old = new Database(file)
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
      sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`)
    old.pragma('user_version = 15')
    old.close()

    const first = new Store(file)
    // Something never written is null — distinct from 'false'
    expect(first.appSetting('updates.auto')).toBeNull()
    first.setAppSetting('updates.auto', 'false')
    first.close()

    const second = new Store(file)
    expect(second.appSetting('updates.auto')).toBe('false')
    // schema.sql resets user_version to 1, so steps replay on every open —
    // a second open must not recreate the table and wipe the answer
    second.setAppSetting('updates.auto', 'true')
    expect(second.appSetting('updates.auto')).toBe('true')
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v17 — how full the context is survives the host (issue #48).
 *
 * The reading was always right; it lived in memory and died with the process, so a cold start
 * showed `Context —` on every session until that one happened to work again. The gauge looked
 * broken when nobody had written the number down — the same disease as #37.
 *
 * Run against a real v16-shaped file, because the half that would actually have failed is the
 * one `CREATE TABLE IF NOT EXISTS` silently skips: adding columns to the database people
 * already have.
 */
describe('v17 migration — context usage survives a restart', () => {
  const v16Db = (file: string) => {
    const old = new Database(file)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, commands TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
        auto_named INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0, is_orchestrator INTEGER NOT NULL DEFAULT 0,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        waiting_since INTEGER, created_at INTEGER NOT NULL, touched_paths TEXT NOT NULL DEFAULT '[]',
        model TEXT, effort TEXT, permission_preset TEXT NOT NULL DEFAULT 'normal',
        imported_from TEXT, worktree_path TEXT, worktree_branch TEXT, cwd TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1,'[]')`).run()
    const add = old.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at) VALUES (?,?,?,?,?)`)
    add.run('worked', 'p1', 'claude', 'Worked session', 1)
    add.run('fresh', 'p1', 'codex', 'Session that has not run yet', 1)
    old.pragma('user_version = 16')
    old.close()
  }

  const row = (over: Partial<SessionInfo>): SessionInfo => ({
    id: 'worked', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'Worked session',
    autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
    createdAt: 1, waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null,
    permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
    ...sessionLiveDefaults(),
    ...over,
  })

  it('the column exists on an old database, and usage survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v17-'))
    const file = join(dir, 'store.db')
    v16Db(file)

    const first = new Store(file)
    expect(first.schemaVersion).toBe(LATEST_SCHEMA)
    // A session that has never reported one is null — the `—` on screen is exactly this fact
    expect(first.listSessions().find((s) => s.id === 'worked')!.context).toBeNull()
    first.upsertSession(row({ context: { used: 168_000, window: 200_000, exactness: 'exact' } }))
    first.close()

    // The host restarted — an empty reading here would be exactly the bug this issue describes
    const second = new Store(file)
    expect(second.listSessions().find((s) => s.id === 'worked')!.context).toEqual({
      used: 168_000, window: 200_000, exactness: 'exact',
    })
    // A session that has not had a single turn yet is still unknown — this must read as unknown, not 0%
    expect(second.listSessions().find((s) => s.id === 'fresh')!.context).toBeNull()
    // schema.sql resets user_version to 1, so steps replay on every open —
    // a second open must not recreate the column and wipe the value
    expect(second.listSessions().find((s) => s.id === 'fresh')!.tool).toBe('codex')
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Compaction **lowers** usage. If a new value could not overwrite the old one, the gauge
   * after a restart would be stuck too high forever, and a person would end a conversation
   * over a limit that does not actually exist.
   */
  it('a later report overwrites an earlier one', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's1', context: { used: 190_000, window: 200_000, exactness: 'exact' } }))
    store.upsertSession(row({ id: 's1', context: { used: 24_000, window: 200_000, exactness: 'exact' } }))
    expect(store.listSessions().find((s) => s.id === 's1')!.context!.used).toBe(24_000)
    store.close()
  })
})

describe('commit attribution (#50) — kept in our own database, not the repository', () => {
  it('records and looks up per project (the same hash: the last record wins)', () => {
    const s = new Store()
    s.recordCommit('p1', '4ce6fc7', 's-auth')
    s.recordCommit('p1', 'abc1234', 's-docs')
    s.recordCommit('p2', '4ce6fc7', 's-other') // the same hash in a different project is a separate fact
    s.recordCommit('p1', '4ce6fc7', 's-auth2') // recorded again — overwrites
    const rows = s.commitSessions('p1')
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.sha === '4ce6fc7')?.sessionId).toBe('s-auth2')
    expect(s.commitSessions('p2')).toEqual([{ sha: '4ce6fc7', sessionId: 's-other' }])
    expect(s.commitSessions('p-none')).toEqual([])
  })
})

describe('WAL checkpoint', () => {
  /*
   * Measured (2026-08-26): a real database's -wal was 97MB, bigger than the main database
   * itself (91MB). The default auto-checkpoint (PASSIVE) does not shrink the file — only
   * TRUNCATE does. The contract: checkpoint() truncates the -wal file to zero.
   */
  it('checkpoint() truncates the -wal file to 0 bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-wal-'))
    const path = join(dir, 'store.db')
    const s = new Store(path)
    s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    s.upsertSession({
      id: 's1', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'New session',
      autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
      ...sessionLiveDefaults(),
    })
    for (let i = 1; i <= 200; i++) {
      s.appendMessages([{ sessionId: 's1', seq: i, role: 'user', kind: 'text', payload: { text: 'x'.repeat(2000) }, ts: i }])
    }
    expect(statSync(path + '-wal').size).toBeGreaterThan(0)
    s.checkpoint()
    expect(statSync(path + '-wal').size).toBe(0)
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/*
 * Reading gives one row as one message (#77).
 * Rows from the delta era were merged by v21. Since then, neighboring assistant rows are
 * different replies and are not joined — joining them would run "…still running." and
 * "All six reviews are in." together into one paragraph with no space.
 */
describe('loadMessages reads one row as one message (#77)', () => {
  const reply = (seq: number, text: string) =>
    ({ sessionId: 's1', seq, role: 'assistant' as const, kind: 'text' as const, payload: { type: 'message_delta', text }, ts: seq })
  const ask = (seq: number, text: string) =>
    ({ sessionId: 's1', seq, role: 'user' as const, kind: 'text' as const, payload: { text }, ts: seq })
  const texts = (msgs: StoredMessage[]) => msgs.map((m) => [m.seq, (m.payload as { text?: string }).text])

  it('neighboring assistant rows are two messages — neither replies nor reasoning are joined', () => {
    const s = seeded()
    s.appendMessages([
      ask(1, 'run the review'),
      reply(2, 'One review is still running.'),
      // A new reply with no human turn in between — a background task finished and a new turn started
      reply(3, 'All six reviews are in.'),
      { sessionId: 's1', seq: 4, role: 'assistant', kind: 'reasoning', payload: { text: 'earlier thought' }, ts: 4 },
      { sessionId: 's1', seq: 5, role: 'assistant', kind: 'reasoning', payload: { text: 'later thought' }, ts: 5 },
    ])
    expect(texts(s.loadMessages('s1'))).toEqual([
      [1, 'run the review'],
      [2, 'One review is still running.'],
      [3, 'All six reviews are in.'],
      [4, 'earlier thought'],
      [5, 'later thought'],
    ])
  })

  it('limit counts rows — reading onward by cursor never overlaps or joins neighboring replies', () => {
    const s = seeded()
    s.appendMessages([ask(1, 'question1'), reply(2, 'answer1-a'), reply(3, 'answer1-b'), ask(4, 'question2'), reply(5, 'answer2-a'), reply(6, 'answer2-b')])
    const page = s.loadMessages('s1', 2)
    expect(texts(page)).toEqual([[5, 'answer2-a'], [6, 'answer2-b']])
    const older = s.loadMessages('s1', 2, page[0]!.seq)
    expect(texts(older)).toEqual([[3, 'answer1-b'], [4, 'question2']])
    expect(texts(s.loadMessages('s1', 2, older[0]!.seq))).toEqual([[1, 'question1'], [2, 'answer1-a']])
  })

  it('loadMessagesFrom reads what comes after a spot, by the same rule', () => {
    const s = seeded()
    s.appendMessages([ask(1, 'question'), reply(2, 'the answer that came first.'), reply(3, 'the later answer.'), ask(4, 'the next question')])
    const after = s.loadMessagesFrom('s1', 1, 10)
    expect(texts(after)).toEqual([[2, 'the answer that came first.'], [3, 'the later answer.'], [4, 'the next question']])
  })

  it('upsertMessageNoIndex updates only the body and leaves the index untouched', () => {
    const s = seeded()
    s.upsertMessageNoIndex({ sessionId: 's1', seq: 1, role: 'assistant', kind: 'text', payload: { text: 'a growing body' }, ts: 1 })
    expect((s.loadMessages('s1')[0]!.payload as { text?: string }).text).toBe('a growing body')
    expect(s.searchMessages('a growing body').length).toBe(0) // the index is written once, when it closes (appendMessages)
    s.appendMessages([{ sessionId: 's1', seq: 1, role: 'assistant', kind: 'text', payload: { text: 'a growing body, done' }, ts: 2 }])
    expect(s.searchMessages('a growing body').length).toBe(1)
  })
})

/*
 * v21 migration (#66): merges rows from the delta era into whole messages.
 *
 * The property that matters most is not size but **not losing any text** — at the time of the
 * move, reads were also joining rows by the same rule to display them, so if the text differs
 * after the move, data was lost. Reads no longer join rows (#77) — the text formed by joining
 * the pre-move rows has to equal the post-move text.
 */
describe('v21 migration — merges delta rows into messages', () => {
  const oldDbWithDeltas = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v21-'))
    const file = join(dir, 'store.db')
    const s = new Store(file)
    s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    s.upsertSession({
      id: 's1', projectId: 'p1', kind: 'worker', tool: 'codex', externalId: null, name: 'New session',
      autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
      ...sessionLiveDefaults(),
    })
    // The exact shape observed in the real data: one token is one row
    s.appendMessages([
      { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: '맵 추출 어떻게 해?' }, ts: 1 },
      { sessionId: 's1', seq: 2, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '한 ' }, ts: 2 },
      { sessionId: 's1', seq: 3, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '번에 ' }, ts: 3 },
      { sessionId: 's1', seq: 4, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '뽑게 됩니다.' }, ts: 4 },
      { sessionId: 's1', seq: 5, role: 'system', kind: 'tool_call', payload: { summary: { tool: 'Bash', title: 'ls' } }, ts: 5 },
      { sessionId: 's1', seq: 6, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '결과는 ' }, ts: 6 },
      { sessionId: 's1', seq: 7, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '이렇습니다' }, ts: 7 },
      { sessionId: 's1', seq: 8, role: 'assistant', kind: 'reasoning', payload: { text: '생각 ' }, ts: 8 },
      { sessionId: 's1', seq: 9, role: 'assistant', kind: 'reasoning', payload: { text: '조각' }, ts: 9 },
    ])
    s.markRead('s1', 3) // marked as read partway through a reply — "unread" must not come back after the move
    const beforeRead = s.loadMessages('s1', 50).map((m) => [m.kind, (m.payload as { text?: string }).text])
    s.close()
    return { file, beforeRead }
  }

  it('the row count drops, but the read result is identical to before the move', () => {
    const { file, beforeRead } = oldDbWithDeltas()
    // Roll back to the pre-move state (writes already use the new approach, so only the version is lowered to replay this step)
    const raw = new Database(file)
    raw.pragma('user_version = 20')
    const rawRows = (raw.prepare(`SELECT COUNT(*) as n FROM messages`).get() as { n: number }).n
    raw.close()

    const s = new Store(file)
    const rows = s.loadMessages('s1', 50)
    const afterRead = rows.map((m) => [m.kind, (m.payload as { text?: string }).text])

    // Different text means data was lost — the text joined from the 9 pre-move rows equals the text joined from the 5 post-move messages
    const joined = (read: (string | undefined)[][]) => read.map(([, t]) => t ?? '').join('')
    expect(joined(afterRead)).toBe(joined(beforeRead))
    expect(afterRead).toEqual([
      ['text', '맵 추출 어떻게 해?'],
      ['text', '한 번에 뽑게 됩니다.'],
      ['tool_call', undefined],
      ['text', '결과는 이렇습니다'],
      ['reasoning', '생각 조각'],
    ])
    // 9 rows -> 5 rows
    const nowRows = s.loadMessages('s1', 50).length
    expect(rawRows).toBe(9)
    expect(nowRows).toBe(5)
    s.close()
  })

  it('the seq of a merged spot is the first chunk\'s, so the read position never moves backward', () => {
    const { file } = oldDbWithDeltas()
    const raw = new Database(file)
    raw.pragma('user_version = 20')
    raw.close()

    const s = new Store(file)
    const merged = s.loadMessages('s1', 50)
    expect(merged[1]!.seq).toBe(2) // the spot where 2, 3, 4 merged is numbered 2
    // The read position (3) is unchanged, and since the first chunk (2) survives, a reply already read never comes back as unread
    expect(s.listSessions()[0]!.lastReadSeq).toBe(3)
    s.close()
  })

  it('after merging, even a phrase that spanned a chunk boundary is searchable', () => {
    const { file } = oldDbWithDeltas()
    const raw = new Database(file)
    raw.pragma('user_version = 20')
    raw.close()

    const s = new Store(file)
    expect(s.searchMessages('번에 뽑게').length).toBe(1) // a phrase the old index could never have found
    expect(s.searchMessages('결과는 이렇습니다').length).toBe(1)
    s.close()
  })

  /*
   * Preserving the timestamp (real incident, 2026-09-03): this step stamped ts with
   * Date.now(), even on rows that had nothing to merge. When beta.4 rewound user_version and
   * this step replayed, the timestamps of an entire night's conversation were overwritten with
   * the time the step ran — the real cause behind "it looks like the conversation never saved."
   */
  it('the timestamp of a merged row is the last chunk\'s — not the current time', () => {
    const { file } = oldDbWithDeltas()
    const raw = new Database(file)
    raw.pragma('user_version = 20')
    raw.close()

    const s = new Store(file)
    const ts = s.loadMessages('s1', 50).map((m) => m.ts)
    // [user 1] [2+3+4 merged -> 4] [tool 5] [6+7 merged -> 7] [8+9 merged -> 9]
    expect(ts).toEqual([1, 4, 5, 7, 9])
    s.close()
  })
})

/**
 * v29: restores the timestamps v21 trampled. The original timestamps are gone, so they cannot
 * be recovered exactly — instead they are narrowed using seq (which is trustworthy) and the
 * neighboring ts: a timestamp later than a later row's is known to be false, so it is clamped
 * down to that later row's timestamp.
 */
describe('v29 migration — narrows a trampled timestamp using its neighbor', () => {
  it('fixes only a ts later than a later row\'s, and leaves an intact ts untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v29-'))
    const file = join(dir, 'store.db')
    const s0 = new Store(file)
    s0.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    s0.upsertSession({
      id: 's1', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'Session',
      autoNamed: true, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
      ...sessionLiveDefaults(),
    })
    s0.appendMessages([
      { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: 'question' }, ts: 100 },
      // A trampled row — it was really around 110, but the migration's own time (999999) was stamped on it
      { sessionId: 's1', seq: 2, role: 'assistant', kind: 'text', payload: { text: 'answer' }, ts: 999_999 },
      { sessionId: 's1', seq: 3, role: 'system', kind: 'tool_call', payload: {}, ts: 120 },
      { sessionId: 's1', seq: 4, role: 'assistant', kind: 'text', payload: { text: 'end' }, ts: 130 },
    ])
    s0.close()

    const raw = new Database(file)
    raw.pragma('user_version = 28') // replays only v29
    raw.close()

    const s = new Store(file)
    expect(s.loadMessages('s1', 50).map((m) => m.ts)).toEqual([100, 120, 120, 130])
    s.close()
  })
})

/** #69-1: the session tree link rides the ordinary upsert — with two write paths, only one would end up fixed */
describe('parent_session_id round-trip (#69)', () => {
  it('a parent link is saved and read back', () => {
    const s = seeded()
    const before = s.listSessions().find((x) => x.id === 's1')!
    expect(before.parentSessionId).toBeNull()

    s.upsertSession({ ...before, parentSessionId: 'mgr-1' })

    expect(s.listSessions().find((x) => x.id === 's1')?.parentSessionId).toBe('mgr-1')
  })
})

/** v23 (#69): round-trip and normalization of the worktree provisioning setup */
describe('worktree_setup round-trip (#69)', () => {
  it('saves, reads back, and an empty setup lies down as null', () => {
    const s = seeded()
    expect(s.worktreeSetup('p1')).toBeNull()

    s.setWorktreeSetup('p1', { command: 'pnpm install', copyFiles: ['.env.local'] })
    expect(s.worktreeSetup('p1')).toEqual({ command: 'pnpm install', copyFiles: ['.env.local'] })

    // Saving an empty setup means "no setup" — an empty string command must never be exec'd
    s.setWorktreeSetup('p1', { command: '', copyFiles: [] })
    expect(s.worktreeSetup('p1')).toBeNull()
  })
})

/** v27 (#76): the manager slot and trunk are held by the project — a link, not a flag on the session */
describe('worktree_manager round-trip (#76)', () => {
  it('saves, reads back, and clears', () => {
    const s = seeded()
    expect(s.worktreeManager('p1')).toBeNull()

    s.setWorktreeManager('p1', { sessionId: 'mgr-1', baseBranch: 'main' })
    expect(s.worktreeManager('p1')).toEqual({ sessionId: 'mgr-1', baseBranch: 'main' })

    // A path that changes only the trunk — the slot stays put and only the baseline changes
    s.setWorktreeManager('p1', { sessionId: 'mgr-1', baseBranch: 'develop' })
    expect(s.worktreeManager('p1')?.baseBranch).toBe('develop')

    s.setWorktreeManager('p1', null)
    expect(s.worktreeManager('p1')).toBeNull()
  })

  it('one per project — there cannot be two, since there is only one column', () => {
    const s = seeded()
    s.setWorktreeManager('p1', { sessionId: 'mgr-1', baseBranch: 'main' })
    s.setWorktreeManager('p1', { sessionId: 'mgr-2', baseBranch: 'main' })
    expect(s.worktreeManager('p1')?.sessionId).toBe('mgr-2')
  })
})

/**
 * v32 (#107): the default model and effort get a tool of their own.
 *
 * Set up in the exact shape of the real incident — a project with `default_tool=codex` holding
 * a Claude model name as its scalar. Migrating that value over to codex looks like the most
 * plausible guess, and that exact guess is what killed the session.
 */
describe('v32 migration — the default model is per tool (#107)', () => {
  const v31Db = (file: string) => {
    const old = new Database(file)
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT, default_effort TEXT,
      sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, commands TEXT NOT NULL DEFAULT '[]');`)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','codex','opus[1m]','high',0,1,'[]')`).run()
    old.pragma('user_version = 31')
    old.close()
  }

  it('the old scalar belongs to no tool and disappears — a lost default costs one click, a wrong one costs a dead session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v32-'))
    const file = join(dir, 'store.db')
    v31Db(file)

    const s = new Store(file)
    expect(s.projectToolDefaults('p1')).toEqual({})
    const cols = (s as unknown as { db: Database.Database }).db
      .prepare(`PRAGMA table_info(projects)`)
      .all() as { name: string }[]
    expect(cols.map((c) => c.name)).not.toContain('default_model')
    expect(cols.map((c) => c.name)).not.toContain('default_effort')

    // Each tool sits in its own slot, and neither overwrites the other
    s.setProjectToolDefaults('p1', 'codex', { model: 'gpt-5.6-terra', effort: 'high' })
    s.setProjectToolDefaults('p1', 'claude', { model: 'opus', effort: null })
    s.close()

    const reopened = new Store(file)
    expect(reopened.projectToolDefaults('p1')).toEqual({
      codex: { model: 'gpt-5.6-terra', effort: 'high' },
      claude: { model: 'opus', effort: null },
    })
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v33 (M4 A-2): the project trust column, v35: already-registered projects are trusted.
 *
 * v33 left old rows at "no." v35 reverses that, but only for existing rows: those projects are
 * folders a person chose and has been running agents in, and trust also decides #92 (respecting
 * project settings). An update must not silently start ignoring that setting. A project
 * registered after this still starts at "no."
 */
describe('v33/v35 migration — the trust column, and only projects that existed at migration time are trusted', () => {
  const oldProjects = (file: string, version: number, cols = '', rows: string[] = ["('p1','/tmp/p1','p1',1)"]) => {
    const old = new Database(file)
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      default_tool TEXT NOT NULL DEFAULT 'claude', default_models TEXT,
      sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, commands TEXT NOT NULL DEFAULT '[]'${cols});`)
    for (const r of rows) old.prepare(`INSERT INTO projects (id, path, name, created_at) VALUES ${r}`).run()
    old.pragma(`user_version = ${version}`)
    old.close()
  }

  it('a v32 project gains the column and comes up trusted — turning trust off survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v33-'))
    const file = join(dir, 'store.db')
    oldProjects(file, 32)

    const s = new Store(file)
    expect(s.projectRoots()).toEqual([{ id: 'p1', path: '/tmp/p1', trusted: true }])
    expect(s.setProjectTrusted('p1', false)).toBe(true)
    // This does not silently succeed on a project that does not exist
    expect(s.setProjectTrusted('nope', true)).toBe(false)
    s.close()

    const reopened = new Store(file)
    expect(reopened.projectRoots()).toEqual([{ id: 'p1', path: '/tmp/p1', trusted: false }])
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a v34 project is trusted even if trust had been turned off, and a project registered after migration starts at no', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v35-'))
    const file = join(dir, 'store.db')
    oldProjects(file, 34, ', trusted INTEGER NOT NULL DEFAULT 0', ["('p1','/tmp/p1','p1',1)", "('p2','/tmp/p2','p2',2)"])

    const s = new Store(file)
    expect(s.schemaVersion).toBe(LATEST_SCHEMA)
    expect(s.projectRoots().map((p) => [p.id, p.trusted])).toEqual([
      ['p1', true],
      ['p2', true],
    ])
    // This is also carried in the shape sent to the screen — the trust toggle shows this value
    expect(s.listProjects().map((p) => [p.id, p.trusted])).toEqual([
      ['p1', true],
      ['p2', true],
    ])
    s.addProject({ id: 'p3', path: '/tmp/p3', name: 'p3' })
    s.setProjectTrusted('p2', false)
    s.close()

    // Reopening does not replay the migration — the trust a person turned off, and the new project's "no," both survive
    const reopened = new Store(file)
    expect(reopened.projectRoots().map((p) => [p.id, p.trusted])).toEqual([
      ['p1', true],
      ['p2', false],
      ['p3', false],
    ])
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a project registered on a new database starts out untrusted', () => {
    const s = new Store()
    s.addProject({ id: 'p2', path: '/tmp/p2', name: 'p2' })
    expect(s.projectRoots()).toEqual([{ id: 'p2', path: '/tmp/p2', trusted: false }])
    expect(s.listProjects()[0]?.trusted).toBe(false)
  })
})

describe('the person\'s answers to an app\'s capability requests (M4 D-4)', () => {
  const allow = (capability: string, at: number) => ({ capability, text: `do ${capability}`, decision: 'allow' as const, stamp: 'stamp-1', decidedAt: at })

  it('one row per app and capability — answering again overwrites, forgetting deletes, and a user-folder app is also one row', () => {
    const s = new Store()
    s.putAppPermission('p1/notes', 'p1', allow('agent:claude', 1))
    s.putAppPermission('p1/notes', 'p1', { ...allow('agent:claude', 2), decision: 'deny' })
    s.putAppPermission('p1/notes', 'p1', allow('host:git.status', 3))
    // Even with project_id null, the same key is one row — why null was kept out of the PRIMARY KEY
    s.putAppPermission('_user/timer', null, allow('agent:claude', 4))
    s.putAppPermission('_user/timer', null, allow('agent:claude', 5))
    expect(s.getAppPermission('p1/notes', 'agent:claude')).toEqual({ ...allow('agent:claude', 2), decision: 'deny' })
    expect(s.listAppPermissions('p1/notes').map((r) => r.capability)).toEqual(['host:git.status', 'agent:claude'])
    expect(s.listAppPermissions('_user/timer')).toEqual([allow('agent:claude', 5)])
    s.forgetAppPermission('p1/notes', 'host:git.status')
    expect(s.getAppPermission('p1/notes', 'host:git.status')).toBeNull()
  })

  it('deleting a project clears the answers for that project\'s apps too — a user-folder app\'s answer survives', () => {
    const s = new Store()
    s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    s.putAppPermission('p1/notes', 'p1', allow('agent:claude', 1))
    s.putAppPermission('_user/timer', null, allow('agent:claude', 2))
    s.deleteProject('p1')
    expect(s.listAppPermissions('p1/notes')).toEqual([])
    expect(s.listAppPermissions('_user/timer')).toHaveLength(1)
  })
})

/**
 * The run log chain (M4 D-6) — a request an app made to the broker gets a row too (`kind: broker`), and reading one
 * app's run log brings the chain beneath it along (rows for other apps it called, rows for agents it requested). A
 * single history screen has to read "what the UI clicked -> another app -> an agent" as one chain.
 */
describe('the run log chain (M4 D-6)', () => {
  const t0 = 1_760_000_000_000
  let seq = 0
  const put = (s: Store, id: string, appId: string, parentRunId: string | null, over: Record<string, unknown> = {}) =>
    s.beginAppRun({
      id, projectId: 'p1', appId, kind: 'tool', tool: 't', callerKind: parentRunId ? 'app' : 'view', callerSessionId: null, parentRunId,
      status: 'ok', durationMs: 1, argsDigest: 'x', argsSummary: '{}', error: null, createdAt: t0 + seq++, sessionId: null, ...over,
    })

  it('one app\'s log carries the chain beneath it — the limit counts roots, and in another app\'s log the called row is the root', () => {
    const s = new Store()
    put(s, 'a1', 'notes', null) // the UI called notes
    put(s, 'a1-ask', 'notes', 'a1', { kind: 'broker', tool: 'run_agent', callerKind: 'app', sessionId: 's-9' }) // notes requested an agent
    put(s, 'b1', 'helper', 'a1') // notes called helper
    put(s, 'b1-ask', 'helper', 'b1', { kind: 'broker', tool: 'run_agent', callerKind: 'app', sessionId: 's-10' }) // helper requested an agent
    put(s, 'a2', 'notes', null)
    put(s, 'c1', 'other', null) // an unrelated app
    put(s, 'lonely', 'notes', null, { kind: 'broker', tool: 'host_data', callerKind: 'app', status: 'rejected' }) // requested with no open run

    const ids = (appId: string, limit: number) => s.listAppRuns('p1', appId, limit).map((r) => r.id)
    expect(ids('notes', 10)).toEqual(['lonely', 'a2', 'b1-ask', 'b1', 'a1-ask', 'a1'])
    // The limit counts roots — rows below a root do not push a root out
    expect(ids('notes', 2)).toEqual(['lonely', 'a2'])
    expect(ids('notes', 3)).toEqual(['lonely', 'a2', 'b1-ask', 'b1', 'a1-ask', 'a1'])
    // In helper's log, the row notes called is the root — its parent (notes's own row) does not belong to helper
    expect(ids('helper', 10)).toEqual(['b1-ask', 'b1'])
    expect(s.listAppRuns('p1', 'notes', 10).find((r) => r.id === 'b1-ask')).toMatchObject({ appId: 'helper', kind: 'broker', parentRunId: 'b1', sessionId: 's-10' })

    s.linkAppRunSession('a1', 's-1')
    expect(s.listAppRuns('p1', 'notes', 10).find((r) => r.id === 'a1')?.sessionId).toBe('s-1')
  })

  it('v36 records all come up as tool-call rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v37-'))
    const file = join(dir, 'store.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE app_runs (
      id TEXT PRIMARY KEY, project_id TEXT, app_id TEXT NOT NULL, tool TEXT NOT NULL, caller_kind TEXT NOT NULL,
      caller_session_id TEXT, parent_run_id TEXT, status TEXT NOT NULL, duration_ms INTEGER, args_digest TEXT NOT NULL,
      args_summary TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE app_run_failures (run_id TEXT PRIMARY KEY, project_id TEXT, app_id TEXT NOT NULL, args TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);`)
    old.prepare(`INSERT INTO app_runs VALUES ('r1', 'p1', 'notes', 'echo', 'view', NULL, NULL, 'ok', 3, 'd', '{}', NULL, 1)`).run()
    old.pragma('user_version = 36')
    old.close()

    const s = new Store(file)
    expect(s.schemaVersion).toBe(LATEST_SCHEMA)
    expect(s.listAppRuns('p1', 'notes', 10)).toEqual([
      expect.objectContaining({ id: 'r1', kind: 'tool', sessionId: null, tool: 'echo', status: 'ok' }),
    ])
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * How much of the agents an app requested were used (M4 D-5) — tokens on a run_agent row, and the sum per app and
 * per period.
 */
describe('how much of an app\'s requested agents were used (M4 D-5)', () => {
  const t0 = 1_760_000_000_000
  const row = (id: string, over: Record<string, unknown>) => ({
    id, projectId: 'p1', appId: 'notes', kind: 'broker', tool: 'run_agent', callerKind: 'app', callerSessionId: null, parentRunId: 'r0',
    status: 'running', durationMs: null, argsDigest: 'x', argsSummary: '{}', error: null, createdAt: t0, sessionId: null, ...over,
  })

  it('only counts run_agent rows a session stood up — duration and tokens are summed, and a run with no reported tokens is left out only of the token sum', () => {
    const s = new Store()
    s.beginAppRun(row('old', { createdAt: t0 - 10_000, sessionId: 's0' }))
    s.endAppRun('old', { status: 'ok', durationMs: 7_000, error: null, tokens: { input: 5_000, output: 500 } })
    s.beginAppRun(row('a', { sessionId: 's1' }))
    s.endAppRun('a', { status: 'ok', durationMs: 4_000, error: null, tokens: { input: 1_200, output: 80 } })
    s.beginAppRun(row('b', { sessionId: 's2', createdAt: t0 + 1 }))
    s.endAppRun('b', { status: 'cancelled', durationMs: 2_500, error: 'stopped', tokens: null })
    s.beginAppRun(row('running', { sessionId: 's3', createdAt: t0 + 2 }))
    // A request that never stood up an agent, an unrelated request, another app's agent
    s.beginAppRun(row('refused', { status: 'rejected', createdAt: t0 + 3 }))
    s.beginAppRun(row('data', { tool: 'host_data', sessionId: null, createdAt: t0 + 4 }))
    s.beginAppRun(row('other', { appId: 'other', sessionId: 's9', createdAt: t0 + 5 }))

    expect(s.appAgentUse('p1', 'notes', t0)).toEqual({ runs: 3, durationMs: 6_500, tokens: { input: 1_200, output: 80 } })
    expect(s.appAgentUse('p1', 'notes', t0 - 60_000)).toEqual({ runs: 4, durationMs: 13_500, tokens: { input: 6_200, output: 580 } })
    expect(s.appAgentUse('p1', 'nobody', 0)).toEqual({ runs: 0, durationMs: 0, tokens: null })
    expect(s.listAppRuns('p1', 'notes', 10).find((r) => r.id === 'a')?.tokens).toEqual({ input: 1_200, output: 80 })
    expect(s.listAppRuns('p1', 'notes', 10).find((r) => r.id === 'b')?.tokens).toBeNull()
  })

  it('v37 records gain the token columns, and old rows are empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v38-'))
    const file = join(dir, 'store.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE app_runs (
      id TEXT PRIMARY KEY, project_id TEXT, app_id TEXT NOT NULL, tool TEXT NOT NULL, caller_kind TEXT NOT NULL,
      caller_session_id TEXT, parent_run_id TEXT, status TEXT NOT NULL, duration_ms INTEGER, args_digest TEXT NOT NULL,
      args_summary TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'tool', session_id TEXT);
      CREATE TABLE app_run_failures (run_id TEXT PRIMARY KEY, project_id TEXT, app_id TEXT NOT NULL, args TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);`)
    old.prepare(`INSERT INTO app_runs VALUES ('r1', 'p1', 'notes', 'run_agent', 'app', NULL, 'r0', 'ok', 3, 'd', '{}', NULL, 1, 'broker', 's1')`).run()
    old.pragma('user_version = 37')
    old.close()

    const s = new Store(file)
    expect(s.schemaVersion).toBe(LATEST_SCHEMA)
    expect(s.listAppRuns('p1', 'notes', 10)).toEqual([expect.objectContaining({ id: 'r1', kind: 'broker', sessionId: 's1', tokens: null })])
    expect(s.appAgentUse('p1', 'notes', 0)).toEqual({ runs: 1, durationMs: 3, tokens: null })
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * The trash (#204). Deleting a session moves it here; only purging removes its rows. While it is here it is out of
 * reach: of every list and of search (its index rows are dropped, which is also where the size is — #96 measured
 * the index at 71MB of a 137MB store).
 */
describe('the trash (#204)', () => {
  const galaxy = (sessionId: string, n: number): StoredMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      sessionId, seq: i + 1, role: 'user' as const, kind: 'text' as const, payload: { text: `galaxy ${i}` }, ts: i,
    }))
  const session = (s: Store, id: string, projectId: string | null, over: Partial<SessionInfo> = {}) =>
    s.upsertSession({
      id, projectId, kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
      lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
      verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
      parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(), ...over,
    })

  it('a trashed session leaves every listing and search at once, and keeps its messages', async () => {
    const s = seeded()
    s.appendMessages(galaxy('s1', 5))
    s.addApprovalRule({ scope: 'session', projectId: 'p1', sessionId: 's1', matcher: 'Bash(ls)', decision: 'allow' })
    s.setGridView([sp('s1')])
    session(s, 'orch', null, { kind: 'orchestrator' })
    expect(s.orchestratorId()).toBe('orch')

    expect(await s.trashSession('s1', KEEP_ALL)).toBe(true)
    await s.trashSession('orch', { ...KEEP_ALL, projectId: null })

    expect(s.listSessions()).toEqual([])
    expect(s.orchestratorId()).toBeNull()
    expect(s.listGridView()).toEqual([])
    expect(s.searchMessages('galaxy')).toEqual([])
    expect(s.searchMessages('ga')).toEqual([]) // the short-query path (LIKE) is a second way into the index
    expect(s.listApprovalRules()).toEqual([])
    expect(indexRowsOf(s, 's1')()).toBe(0)
    // Out of reach is not gone: the conversation is all there, and the trash lists it with where it came from
    expect(s.loadMessages('s1', 10)).toHaveLength(5)
    expect(s.listTrash().map((r) => [r.id, r.messages, r.record.projectId]).sort()).toEqual([
      ['orch', 0, null],
      ['s1', 5, 'p1'],
    ])
    expect(await s.trashSession('s1', KEEP_ALL)).toBe(false) // twice is once
    s.close()
  })

  /*
   * The guard for the next query. Every SQL string in the store that reads `sessions` has to say what it does about
   * the trash: filter it (`deleted_at`), read one session by id, or carry a comment saying why it includes the trash.
   * A new listing that forgets all three fails here, before it reaches a screen or an agent.
   */
  it('no query in the store reads sessions without deciding about the trash', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
    // Migrations run before anything is in the trash; the queries that serve the app start after them
    const body = src.slice(src.indexOf('get schemaVersion(): number'))
    const literals = [...body.matchAll(/`([^`]*)`/g)].map((m) => m[1]!)
    const reading = literals.filter((q) => /\b(FROM|JOIN)\s+sessions\b/i.test(q))
    expect(reading.length).toBeGreaterThan(10)
    const undecided = reading.filter(
      (q) => !/deleted_at/.test(q) && !/\bid = \?/.test(q) && !/\/\* includes the trash: /.test(q) && !/\$\{where\}/.test(q),
    )
    expect(undecided).toEqual([])
    // `readSessions` takes its condition from the caller — every caller has to name the trash in it
    const callers = [...body.matchAll(/this\.readSessions\(`([^`]*)`/g)].map((m) => m[1]!)
    expect(callers.length).toBeGreaterThanOrEqual(3)
    expect(callers.filter((w) => !/deleted_at/.test(w))).toEqual([])
  })

  it('restoring rebuilds the index and brings the session back into its project as it was', async () => {
    const s = seeded()
    s.appendMessages(galaxy('s1', 5))
    s.appendMessages([{ sessionId: 's1', seq: 6, role: 'assistant', kind: 'tool_call', payload: { id: 'x' }, ts: 6 }])
    s.addApprovalRule({ scope: 'session', projectId: 'p1', sessionId: 's1', matcher: 'Bash(ls)', decision: 'allow' })
    const before = s.listSessions()[0]!
    await s.trashSession('s1', KEEP_ALL)

    const back = await s.restoreSession('s1', 'p1')
    expect(back).toEqual(before)
    expect(s.listSessions()).toEqual([before])
    expect(s.listTrash()).toEqual([])
    expect(s.searchMessages('galaxy')).toHaveLength(5)
    expect(indexRowsOf(s, 's1')()).toBe(5) // a message with no text gets no index row, as when it was written
    expect(s.listApprovalRules().map((r) => r.sessionId)).toEqual(['s1'])
    expect(await s.restoreSession('s1', 'p1')).toBeNull() // only what is in the trash comes back
    s.close()
  })

  it('moving to the trash and back let the event loop go between chunks, and search reaches it only once it is back', async () => {
    const s = seeded()
    const n = 1000
    s.appendMessages(galaxy('s1', n))
    const seen: { messages: number; hits: number; listed: number }[] = []
    let busy = true
    const look = () => {
      if (!busy) return
      seen.push({
        messages: s.loadMessages('s1', n).length,
        hits: s.searchMessages('galaxy', n).length,
        listed: s.listSessions().length,
      })
      setImmediate(look)
    }
    setImmediate(look)
    await s.trashSession('s1', KEEP_ALL, 100)
    busy = false
    expect(seen.length).toBeGreaterThanOrEqual(5)
    // Out of reach from the first chunk, with every message still there
    expect(seen.every((at) => at.hits === 0 && at.listed === 0 && at.messages === n)).toBe(true)
    expect(indexRowsOf(s, 's1')()).toBe(0)

    seen.length = 0
    busy = true
    setImmediate(look)
    await s.restoreSession('s1', 'p1', 100)
    busy = false
    expect(seen.length).toBeGreaterThanOrEqual(5)
    expect(seen.every((at) => at.hits === 0 && at.listed === 0)).toBe(true)
    expect(s.searchMessages('galaxy', n)).toHaveLength(n)
    s.close()
  })

  it('purging takes only a session in the trash, with every row that points at it and nothing else', async () => {
    const s = seeded()
    session(s, 's2', 'p1')
    for (const id of ['s1', 's2']) {
      s.appendMessages(galaxy(id, 3))
      s.addApprovalRule({ scope: 'session', projectId: 'p1', sessionId: id, matcher: 'Bash(ls)', decision: 'allow' })
      s.recordCommit('p1', `sha-${id}`, id)
      const run = { projectId: 'p1', appId: 'notes', kind: 'broker', tool: 'run_agent', callerKind: 'session', parentRunId: null,
        status: 'ok', durationMs: 1, argsDigest: 'x', argsSummary: '{}', error: null, createdAt: 1 }
      s.beginAppRun({ ...run, id: `ran-${id}`, callerSessionId: null, sessionId: id })
      s.beginAppRun({ ...run, id: `called-${id}`, callerSessionId: id, sessionId: null })
      s.keepAppRunFailure({ runId: `called-${id}`, projectId: 'p1', appId: 'notes', args: '{}', result: null, createdAt: 1 }, 10)
    }
    expect(await s.purgeSession('s1')).toBe(false) // a live session has to go through the trash first
    expect(s.loadMessages('s1', 10)).toHaveLength(3)

    await s.trashSession('s1', KEEP_ALL)
    expect(await s.purgeSession('s1')).toBe(true)

    const db = (s as unknown as { db: Database.Database }).db
    const count = (sql: string, id: string) => (db.prepare(sql).get(id) as { n: number }).n
    for (const [sql, left] of [
      [`SELECT COUNT(*) as n FROM sessions WHERE id = ?`, 0],
      [`SELECT COUNT(*) as n FROM messages WHERE session_id = ?`, 0],
      [`SELECT COUNT(*) as n FROM messages_fts WHERE session_id = ?`, 0],
      [`SELECT COUNT(*) as n FROM approval_rules WHERE session_id = ?`, 0],
      [`SELECT COUNT(*) as n FROM commit_sessions WHERE session_id = ?`, 0],
      [`SELECT COUNT(*) as n FROM app_runs WHERE ? IN (session_id, caller_session_id)`, 0],
      [`SELECT COUNT(*) as n FROM app_run_failures WHERE run_id = 'called-' || ?`, 0],
    ] as const) {
      expect([sql, count(sql, 's1')]).toEqual([sql, left])
      // the other session's rows are all still there
      expect([sql, count(sql, 's2')]).not.toEqual([sql, 0])
    }
    expect(s.listTrash()).toEqual([])
    s.close()
  })

  it('deleting a project moves its sessions to the trash and keeps the rows that point at them', async () => {
    const s = seeded()
    session(s, 's2', 'p1')
    s.appendMessages(galaxy('s1', 3))
    s.appendMessages(galaxy('s2', 2))
    await s.trashSession('s2', KEEP_ALL) // already in the trash when the project goes
    s.addApprovalRule({ scope: 'session', projectId: 'p1', sessionId: 's1', matcher: 'Bash(ls)', decision: 'allow' })
    s.addApprovalRule({ scope: 'project', projectId: 'p1', matcher: 'Bash(pwd)', decision: 'allow' })
    s.recordCommit('p1', 'sha-s1', 's1')
    s.recordCommit('p1', 'sha-gone', 'purged-long-ago')
    const run = { projectId: 'p1', appId: 'notes', kind: 'tool', tool: 't', callerKind: 'view', parentRunId: null,
      status: 'ok', durationMs: 1, argsDigest: 'x', argsSummary: '{}', error: null, createdAt: 1 }
    s.beginAppRun({ ...run, id: 'of-s1', callerSessionId: 's1', sessionId: null })
    s.beginAppRun({ ...run, id: 'of-view', callerSessionId: null, sessionId: null })

    s.deleteProject('p1')

    expect(s.listProjects()).toEqual([])
    expect(s.listSessions()).toEqual([])
    const trash = s.listTrash()
    expect(trash.map((r) => [r.id, r.messages])).toEqual(expect.arrayContaining([['s1', 3], ['s2', 2]]))
    // Nobody was asked about the tool's files or a worktree, so emptying the trash leaves them
    expect(trash.find((r) => r.id === 's1')?.record).toEqual(KEEP_ALL)
    expect(s.searchMessages('galaxy')).toEqual([])
    const db = (s as unknown as { db: Database.Database }).db
    const rows = (sql: string) => db.prepare(sql).all()
    expect(rows(`SELECT sha FROM commit_sessions`)).toEqual([{ sha: 'sha-s1' }])
    expect(rows(`SELECT id FROM app_runs`)).toEqual([{ id: 'of-s1' }])
    expect(rows(`SELECT matcher FROM approval_rules`)).toEqual([{ matcher: 'Bash(ls)' }])
    s.close()
  })

  it('a store from before the trash comes up with nothing in it, each step after v38 run once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v39-'))
    const file = join(dir, 'store.db')
    try {
      const fresh = new Store(file)
      fresh.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
      fresh.close()
      // Take the store back to v38: no trash columns
      const raw = new Database(file)
      raw.exec(`ALTER TABLE sessions DROP COLUMN deleted_at; ALTER TABLE sessions DROP COLUMN trash`)
      raw.pragma('user_version = 38')
      raw
        .prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at) VALUES ('old', 'p1', 'claude', 'old', 1)`)
        .run()
      raw.close()

      const s = new Store(file)
      expect(s.schemaVersion).toBe(LATEST_SCHEMA)
      expect(s.migrationsRun).toBe(LATEST_SCHEMA - 38)
      expect(s.listSessions().map((x) => x.id)).toEqual(['old'])
      expect(s.listTrash()).toEqual([])
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
