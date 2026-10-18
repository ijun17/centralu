/**
 * Store step v55 (#614, #844): a session another project asked for (ask_project, before #617) loses that asker's mark,
 * and a session started by one of its own project (start_agent) keeps it. The cases are those the host start told
 * apart before the step took the work over; each row is written into a store put back to v54, which is then opened.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ASK = "[A session in the project \"web\" asks this project, through Centralu's ask_project. ]\n\nexport the sprites"

function v54Store(rows: (db: Database.Database) => void): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-store-asked-by-'))
  dirs.push(d)
  const file = join(d, 'store.db')
  new Store(file).close()
  const db = new Database(file)
  db.exec(`
    INSERT INTO projects (id, path, name, created_at) VALUES ('web', '/w', 'web', 1), ('api', '/a', 'api', 1);
  `)
  rows(db)
  db.pragma('user_version = 54')
  db.close()
  return file
}

const session = (db: Database.Database, id: string, projectId: string | null, askedBy: string | null, extra: { trashOf?: string | null } = {}) => {
  db.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at, asked_by_session_id) VALUES (?, ?, 'claude', ?, 1, ?)`).run(
    id, extra.trashOf !== undefined ? null : projectId, id, askedBy,
  )
  if (extra.trashOf !== undefined) {
    db.prepare(`UPDATE sessions SET deleted_at = 5, trash = ? WHERE id = ?`).run(JSON.stringify({ projectId: extra.trashOf, projectName: 'x', projectPath: '/x' }), id)
  }
}
const message = (db: Database.Database, sessionId: string, payload: string) =>
  db.prepare(`INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, 1, 'user', 'text', ?, 1)`).run(sessionId, payload)

const askers = (file: string) => {
  const store = new Store(file)
  const out = Object.fromEntries(store.sessions.listSessions().map((s) => [s.id, s.askedBy ?? null]))
  const ran = store.migrationsRun
  store.close()
  return { out, ran }
}

describe('store step v55: old cross-project askers are cleared (#844)', () => {
  it('clears an asker of another project, listed or in the trash, and keeps one of the same project', () => {
    const file = v54Store((db) => {
      session(db, 'caller', 'web', null)
      session(db, 'gone-caller', null, null, { trashOf: 'web' })
      session(db, 'sibling', 'api', null)
      session(db, 'asked', 'api', 'caller')
      session(db, 'asked-by-trashed', 'api', 'gone-caller')
      session(db, 'started', 'api', 'sibling')
    })
    const { out, ran } = askers(file)
    expect(ran).toBe(5) // v55, then v56 (#423), v57 (#378), v58 (#418) and v59 (#1134)
    expect(out).toMatchObject({ asked: null, 'asked-by-trashed': null, started: 'sibling' })
  })

  it('decides by the first message when the asker is purged, or listed with no project', () => {
    const file = v54Store((db) => {
      session(db, 'orchestrator', null, null)
      session(db, 'purged-ask', 'api', 'purged')
      message(db, 'purged-ask', JSON.stringify({ text: ASK, from: { sessionId: 'purged', name: 'Old caller' } }))
      session(db, 'orchestrator-ask', 'api', 'orchestrator')
      message(db, 'orchestrator-ask', JSON.stringify({ text: ASK, from: { sessionId: 'orchestrator', name: 'Orchestrator' } }))
      // Its first message was not the asker's ask_project task: the mark stays, as the host start left it
      session(db, 'orchestrator-other', 'api', 'orchestrator')
      message(db, 'orchestrator-other', JSON.stringify({ text: 'hello', from: { sessionId: 'orchestrator', name: 'Orchestrator' } }))
      session(db, 'purged-quiet', 'api', 'purged')
      // A payload that is not JSON does not stop the step
      session(db, 'purged-broken', 'api', 'purged')
      message(db, 'purged-broken', '{not json')
    })
    const { out } = askers(file)
    expect(out).toMatchObject({ 'purged-ask': null, 'orchestrator-ask': null, 'orchestrator-other': 'orchestrator', 'purged-quiet': 'purged', 'purged-broken': 'purged' })
  })
})
