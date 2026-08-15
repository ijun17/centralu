import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ProjectInfo, SessionInfo, StoredMessage } from '@cc/protocol'

const SCHEMA_PATH = fileURLToPath(new URL('../../../protocol/src/schema/schema.sql', import.meta.url))

/**
 * dev 전용 저장소 (docs/agent-host.md §5). Tauri 전환 시 rusqlite로 대체되며
 * 스키마 파일(protocol/src/schema/schema.sql)은 그대로 공유한다.
 */
export class Store {
  private db: Database.Database

  constructor(path = ':memory:') {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  }

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  close() {
    this.db.close()
  }

  addProject(p: { id: string; path: string; name: string }): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name`,
      )
      .run(p.id, p.path, p.name, Date.now())
  }

  listProjects(): Omit<ProjectInfo, 'git'>[] {
    return this.db
      .prepare(`SELECT id, path, name, default_tool as defaultTool, default_model as defaultModel FROM projects ORDER BY sidebar_order, created_at`)
      .all() as Omit<ProjectInfo, 'git'>[]
  }

  findProjectByPath(path: string): { id: string } | undefined {
    return this.db.prepare(`SELECT id FROM projects WHERE path = ?`).get(path) as { id: string } | undefined
  }

  upsertSession(s: SessionInfo): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, tool, external_id, name, auto_named, state, archived, last_read_seq, waiting_since, created_at)
         VALUES (@id, @projectId, @tool, @externalId, @name, @autoNamed, @state, @archived, @lastReadSeq, @waitingSince, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           external_id = excluded.external_id, name = excluded.name, auto_named = excluded.auto_named,
           state = excluded.state, archived = excluded.archived, last_read_seq = excluded.last_read_seq,
           waiting_since = excluded.waiting_since`,
      )
      .run({
        ...s,
        autoNamed: s.autoNamed ? 1 : 0,
        archived: s.archived ? 1 : 0,
      })
  }

  listSessions(): SessionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.project_id as projectId, s.tool, s.external_id as externalId, s.name,
                s.auto_named as autoNamed, s.state, s.archived, s.last_read_seq as lastReadSeq,
                s.waiting_since as waitingSince, s.created_at as createdAt,
                COALESCE((SELECT MAX(seq) FROM messages m WHERE m.session_id = s.id), 0) as lastSeq
         FROM sessions s ORDER BY s.created_at`,
      )
      .all() as (Omit<SessionInfo, 'autoNamed' | 'archived'> & { autoNamed: number; archived: number })[]
    return rows.map((r) => ({ ...r, autoNamed: !!r.autoNamed, archived: !!r.archived, live: false }))
  }

  appendMessages(msgs: StoredMessage[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const tx = this.db.transaction((rows: StoredMessage[]) => {
      for (const m of rows) stmt.run(m.sessionId, m.seq, m.role, m.kind, JSON.stringify(m.payload), m.ts)
    })
    tx(msgs)
  }

  loadMessages(sessionId: string, limit = 200, beforeSeq?: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT session_id as sessionId, seq, role, kind, payload, ts FROM messages
         WHERE session_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, beforeSeq ?? null, beforeSeq ?? null, limit) as (StoredMessage & { payload: string })[]
    return rows.reverse().map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  nextSeq(sessionId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) as m FROM messages WHERE session_id = ?`).get(sessionId) as { m: number }
    return row.m + 1
  }

  markRead(sessionId: string, seq: number): void {
    this.db.prepare(`UPDATE sessions SET last_read_seq = MAX(last_read_seq, ?) WHERE id = ?`).run(seq, sessionId)
  }

  addApprovalRule(r: { scope: string; projectId?: string; sessionId?: string; matcher: string; decision: string }): void {
    this.db
      .prepare(`INSERT INTO approval_rules (scope, project_id, session_id, matcher, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.scope, r.projectId ?? null, r.sessionId ?? null, r.matcher, r.decision, Date.now())
  }

  listApprovalRules(): { scope: string; matcher: string; decision: string; projectId: string | null; sessionId: string | null }[] {
    return this.db
      .prepare(`SELECT scope, matcher, decision, project_id as projectId, session_id as sessionId FROM approval_rules ORDER BY created_at`)
      .all() as { scope: string; matcher: string; decision: string; projectId: string | null; sessionId: string | null }[]
  }
}
