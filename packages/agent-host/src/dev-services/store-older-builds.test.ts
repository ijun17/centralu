/**
 * Stores written by older builds open in this one with everything in them (#845).
 *
 * `store-migrations.test.ts` runs the whole list from a v1 store, but a v1 store holds only what v1 had: every
 * column, table and kind of row added later reaches the later steps empty, so a step that rewrites one of them
 * (v40 takes tool calls out of the search index) never meets a row there. The stores here were written by the
 * builds that had v20, v39 and v47 as their newest step, through their own `Store` API, and kept as SQL in
 * `store-fixtures/` (`scripts/write-store-fixture.mts` says how; a fixture is never edited by hand). Each is opened with this
 * build and read back through today's API.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A store file holding what the build at `version` wrote */
function olderStore(version: number): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-store-older-'))
  dirs.push(d)
  const file = join(d, 'store.db')
  const db = new Database(file)
  db.exec(readFileSync(fileURLToPath(new URL(`./store-fixtures/v${version}.sql`, import.meta.url)), 'utf8'))
  db.close()
  return file
}

const LATEST = new Store().latestKnownVersion

describe.each([20, 39, 47])('a store the v%i build wrote', (version) => {
  it('migrates to the newest schema and keeps its projects, sessions, conversation and rules', () => {
    const file = olderStore(version)
    const store = new Store(file)
    try {
      expect(store.schemaVersion).toBe(LATEST)
      expect(store.migrationsRun).toBe(LATEST - version)

      expect(store.projects.listProjects()).toEqual([expect.objectContaining({ id: 'p1', path: '/tmp/p1', name: 'alpha' })])
      const sessions = store.sessions.listSessions()
      expect(sessions.map((s) => s.id).sort()).toEqual(['s1', 's2'])
      expect(sessions.find((s) => s.id === 's1')).toMatchObject({
        projectId: 'p1',
        tool: 'claude',
        externalId: 'ext-s1',
        name: `seeded at v${version}`,
        autoNamed: false,
        lastReadSeq: 2,
        model: 'opus',
        permissionPreset: 'normal',
      })

      expect(store.messages.loadMessages('s1').map((m) => [m.seq, m.role, m.kind, m.payload])).toEqual([
        [1, 'user', 'text', { type: 'user_message', sessionId: 's1', text: 'find the galaxy colour policy' }],
        [2, 'assistant', 'text', { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'the galaxy colour policy lives in docs' }],
        [3, 'system', 'tool_call', { type: 'tool_call', sessionId: 's1', callId: 'c1', summary: { tool: 'Read', title: 'Read: docs/colour.md', paths: ['docs/colour.md'] } }],
        [4, 'system', 'tool_result', { type: 'tool_result', sessionId: 's1', callId: 'c1', ok: true, summary: 'nebula purple is the default' }],
        [5, 'assistant', 'text', { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'done reading' }],
      ])
      expect(store.messages.loadMessages('s2').map((m) => m.payload)).toEqual([{ type: 'user_message', sessionId: 's2', text: 'hello second' }])

      // The search index holds what was said, and since v40 no tool call, whichever build indexed the row
      expect(store.messages.searchMessages('galaxy colour').map((h) => [h.sessionId, h.seq])).toEqual(
        expect.arrayContaining([['s1', 1], ['s1', 2]]),
      )
      expect(store.messages.searchMessages('galaxy colour')).toHaveLength(2)
      expect(store.messages.searchMessages('docs/colour.md')).toEqual([])

      expect(store.permissions.listApprovalRules()).toEqual([expect.objectContaining({ scope: 'project', projectId: 'p1', matcher: 'npm test', decision: 'allow' })])
    } finally {
      store.close()
    }

    // And it is done: the next open runs nothing
    const again = new Store(file)
    expect(again.migrationsRun).toBe(0)
    again.close()
  })

  it('has no usage_facts table afterwards: the fixture has it, v56 drops it (#423)', () => {
    const file = olderStore(version)
    const tables = (path: string) => {
      const db = new Database(path)
      try {
        return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name)
      } finally {
        db.close()
      }
    }
    expect(tables(file)).toContain('usage_facts')
    new Store(file).close()
    expect(tables(file)).not.toContain('usage_facts')
  })
})

describe('a store written before a question’s choices had a column (v69, #1630)', () => {
  it('migrates with its mail intact, shows a question without choices, and an older build’s insert leaves the column empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-mail-choices-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const first = new Store(file)
    const written = (first as unknown as { db: Database.Database }).db
    const at = 1_800_000_000_000
    const row = { id: 'h1.m_1', sender: 'session:h1/a', kind: 'message', needs_reply: 1, root_id: 'h1.m_1', body: 'Which?', facts: '{}', created_at: at }
    written
      .prepare(`INSERT INTO mail (id, sender, kind, needs_reply, root_id, body, facts, created_at) VALUES (@id, @sender, @kind, @needs_reply, @root_id, @body, @facts, @created_at)`)
      .run(row)
    written.exec(`ALTER TABLE mail DROP COLUMN choices`)
    written.pragma('user_version = 69')
    written.close()

    const second = new Store(file)
    expect(second.migrationsRun).toBe(4) // v70, then v71 (#2229), v72 (#2243), v73 (#1324)
    expect(second.mailbox.message('h1.m_1')).toMatchObject({ body: 'Which?', choices: null })
    const db = (second as unknown as { db: Database.Database }).db
    // What a build of v69 writes: its own column list, none of ours
    db.prepare(`INSERT INTO mail (id, sender, kind, needs_reply, root_id, body, facts, created_at) VALUES ('h1.m_2', 'session:h1/a', 'message', 1, 'h1.m_2', 'old', '{}', ?)`).run(at)
    expect(second.mailbox.message('h1.m_2')).toMatchObject({ body: 'old', choices: null })
    db.close()
  })
})

describe('a store written before a chain’s subject had a column (v70, #2229)', () => {
  it('migrates with its mail intact, reads no subject, and an older build’s insert leaves the column empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-mail-subject-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const first = new Store(file)
    const written = (first as unknown as { db: Database.Database }).db
    const at = 1_800_000_000_000
    written
      .prepare(`INSERT INTO mail (id, sender, kind, needs_reply, root_id, body, facts, created_at) VALUES ('h1.m_1', 'session:h1/a', 'message', 1, 'h1.m_1', 'Ship it?', '{}', ?)`)
      .run(at)
    written.exec(`ALTER TABLE mail DROP COLUMN subject`)
    written.pragma('user_version = 70')
    written.close()

    const second = new Store(file)
    expect(second.migrationsRun).toBe(3) // v71, then v72 (#2243), v73 (#1324)
    expect(second.mailbox.message('h1.m_1')).toMatchObject({ body: 'Ship it?', subject: null })
    const db = (second as unknown as { db: Database.Database }).db
    // What a build of v70 writes: its own column list, none of ours
    db.prepare(`INSERT INTO mail (id, sender, kind, needs_reply, root_id, body, facts, choices, created_at) VALUES ('h1.m_2', 'session:h1/a', 'message', 1, 'h1.m_2', 'old', '{}', NULL, ?)`).run(at)
    expect(second.mailbox.message('h1.m_2')).toMatchObject({ body: 'old', subject: null })
    db.close()
  })
})

describe('a store holding mail an earlier build held (v71, #2243)', () => {
  it('ends the holds today’s gate would not hold, keeps what it would hold whoever held it, and leaves every other row as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-mail-holds-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const first = new Store(file)
    first.projects.addProject({ id: 'px', path: join(dir, 'px'), name: 'Pex' })
    first.projects.addProject({ id: 'pt', path: join(dir, 'pt'), name: 'Pet' })
    first.projects.addProject({ id: 'pb', path: join(dir, 'pb'), name: 'Pbe' })
    first.projects.setProjectTrusted('pt', true)
    const written = (first as unknown as { db: Database.Database }).db
    written.prepare(`INSERT INTO sessions (id, project_id, tool, name, is_orchestrator, created_at) VALUES ('b', 'pb', 'claude', 'b', 0, 0)`).run()
    written.prepare(`INSERT INTO sessions (id, project_id, tool, name, is_orchestrator, created_at, deleted_at) VALUES ('t', 'pb', 'claude', 't', 0, 0, 1)`).run()
    const at = 1_800_000_000_000
    const message = written.prepare(`INSERT INTO mail (id, sender, sender_project, kind, needs_reply, root_id, body, facts, created_at) VALUES (?, 'session:h1/a', ?, ?, 1, ?, 'hi', '{}', ?)`)
    const recipient = written.prepare(
      `INSERT INTO mail_recipients (message_id, recipient, due_at, held, settled, attempts, last_error, attempt_at) VALUES (?, ?, ?, ?, ?, 2, 'x', ?)`,
    )
    // [id, held, settled, the sender's project, kind]. `settled` legacy: moved by v65, and held by an earlier build or, for the `policy` ones the gate holds, by the delivery since
    const rows: [string, string, string | null, string | null, string][] = [
      ['m_budget', 'budget', 'legacy', 'px', 'message'],
      ['m_untrusted', 'policy', 'legacy', 'px', 'message'],
      ['m_trusted', 'policy', 'legacy', 'pt', 'message'],
      ['m_no_project', 'policy', 'legacy', null, 'message'],
      ['m_same_project', 'policy', 'legacy', 'pb', 'message'],
      ['m_task', 'policy', 'legacy', 'px', 'task'],
      // To a session that was trashed: the live session lookup skips it, so the gate holds nothing for it
      ['m_trashed', 'policy', 'legacy', 'px', 'message'],
      ['m_new_policy', 'policy', null, 'pt', 'message'],
      ['m_loop', 'loop', 'legacy', 'pt', 'message'],
      ['m_uncertain', 'uncertain', 'legacy', null, 'message'],
      ['m_failed', 'failed', null, null, 'message'],
    ]
    for (const [id, held, settled, project, kind] of rows) {
      message.run(`h1.${id}`, project, kind, `h1.${id}`, at)
      recipient.run(`h1.${id}`, id === 'm_trashed' ? 'session:h1/t' : 'session:h1/b', at, held, settled, at)
    }
    written.pragma('user_version = 71')
    written.close()

    const second = new Store(file)
    expect(second.migrationsRun).toBe(2) // v72, then v73 (#1324)
    // Waiting lists what today's gate holds (an untrusted project's message to a session of another project), and the holds nothing here judged
    const waiting = second.mailbox.heldRows().map((r) => `${r.messageId.slice(3)}:${r.held}`)
    expect(waiting.sort()).toEqual(['m_failed:failed', 'm_loop:loop', 'm_new_policy:policy', 'm_uncertain:uncertain', 'm_untrusted:policy'])
    // The ended rows stay, dismissed and settled as they were, with the delivery's attempt state cleared as the person's Dismiss clears it
    const db = (second as unknown as { db: Database.Database }).db
    const ended = db
      .prepare(`SELECT message_id AS id, held, settled, attempts, last_error AS err, attempt_at AS at FROM mail_recipients WHERE held = 'dismissed' ORDER BY message_id`)
      .all()
    expect(ended.map((r) => (r as { id: string }).id)).toEqual(['h1.m_budget', 'h1.m_no_project', 'h1.m_same_project', 'h1.m_task', 'h1.m_trashed', 'h1.m_trusted'])
    for (const r of ended) expect(r).toMatchObject({ settled: 'legacy', attempts: 0, err: null, at: null })
    expect(db.prepare(`SELECT held, settled, attempts, last_error AS err FROM mail_recipients WHERE message_id = 'h1.m_new_policy'`).get()).toEqual({ held: 'policy', settled: null, attempts: 2, err: 'x' })
    db.close()
  })
})

describe('a store written before watches had a table (v71, #1324)', () => {
  it('migrates with its mail intact and no watch, and a watch set then stays unseen by an older build’s reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-mail-watches-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const first = new Store(file)
    const written = (first as unknown as { db: Database.Database }).db
    const at = 1_800_000_000_000
    written
      .prepare(`INSERT INTO mail (id, sender, kind, needs_reply, root_id, body, facts, created_at) VALUES ('h1.m_1', 'session:h1/a', 'message', 1, 'h1.m_1', 'Ship it?', '{}', ?)`)
      .run(at)
    written.exec(`DROP TABLE mail_watches`)
    written.pragma('user_version = 71')
    written.close()

    const second = new Store(file)
    expect(second.migrationsRun).toBe(2) // v72 (#2243), then v73
    expect(second.mailbox.message('h1.m_1')).toMatchObject({ body: 'Ship it?' })
    expect(second.mailbox.activeWatches()).toEqual([])
    const watch = { id: 'h1.w_1', owner: 'session:h1/a', source: 'time', target: 'in 30m', spec: '{"kind":"in","slotMs":1}', note: '', state: 'active', lastKey: null, firedCount: 0, createdAt: at, expiresAt: at, nextAt: at, endedAt: null, endedBy: null }
    second.mailbox.saveWatch(watch)
    expect(second.mailbox.activeWatches()).toEqual([watch])
    // What an older build reads of the mail: the tables it names, none of which a watch is in
    const db = (second as unknown as { db: Database.Database }).db
    expect(db.prepare(`SELECT COUNT(*) AS n FROM mail`).get()).toEqual({ n: 1 })
    db.close()
  })
})
