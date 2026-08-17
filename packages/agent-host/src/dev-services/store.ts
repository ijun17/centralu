import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ProjectInfo, SessionInfo, StoredMessage } from '@cc/protocol'

/**
 * 스키마 위치는 실행 형태에 따라 다르다.
 * dev(tsx)는 소스 트리에서, 번들(배포 `.app`)은 산출물 옆에서 읽는다 —
 * 번들 후에는 소스 경로가 존재하지 않으므로 후보를 순서대로 찾는다 (F-0).
 */
function resolveSchemaPath(): string {
  const candidates = [
    new URL('./schema.sql', import.meta.url), // 번들 산출물 레이아웃
    new URL('../../../protocol/src/schema/schema.sql', import.meta.url), // 소스 트리
  ].map((u) => fileURLToPath(u))
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`schema.sql not found: ${candidates.join(', ')}`)
  return found
}

const SCHEMA_PATH = resolveSchemaPath()

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
    this.migrate()
  }

  /**
   * 마이그레이션 러너 (E-0).
   *
   * 스키마 파일은 `CREATE TABLE IF NOT EXISTS`뿐이라 **기존 DB에는 컬럼·인덱스 추가가
   * 조용히 무시된다.** 이미 실사용 데이터가 쌓인 파일이 있으므로(~/.control-center/store.db)
   * user_version을 보고 순차 적용한다.
   */
  private migrate(): void {
    const current = this.schemaVersion
    const steps: { to: number; run: () => void }[] = [
      {
        to: 2,
        run: () => {
          // B-7: 에이전트가 만진 파일을 재시작 후에도 기억한다
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'touched_paths')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN touched_paths TEXT NOT NULL DEFAULT '[]'`)
          }
        },
      },
      {
        to: 3,
        run: () => {
          // E-1: 대화 전문 검색. 한국어는 조사가 붙으므로 trigram을 쓴다
          //   (unicode61은 '승인'으로 '승인을'을 못 찾는다)
          this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
              body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
            );
          `)
          // 기존 메시지 백필 — 이게 없으면 예전 대화는 영원히 검색되지 않는다
          const rows = this.db.prepare(`SELECT session_id, seq, payload FROM messages`).all() as {
            session_id: string
            seq: number
            payload: string
          }[]
          const insert = this.db.prepare(`INSERT INTO messages_fts (body, session_id, seq) VALUES (?, ?, ?)`)
          const tx = this.db.transaction(() => {
            for (const r of rows) {
              const body = extractText(r.payload)
              if (body) insert.run(body, r.session_id, r.seq)
            }
          })
          tx()
        },
      },
      {
        to: 4,
        run: () => {
          // FR-7: 모델·권한을 세션별로 기억한다 (대화 도중 변경 가능)
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'model')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`)
          }
          if (!cols.some((c) => c.name === 'permission_preset')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN permission_preset TEXT NOT NULL DEFAULT 'normal'`)
          }
        },
      },
      {
        to: 5,
        run: () => {
          // 어느 이전 대화를 이어받았는지. external_id로는 알 수 없다 —
          // 도구가 resume하면서 **새 식별자를 발급**할 수 있어서 원본과 달라진다.
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'imported_from')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN imported_from TEXT`)
          }
        },
      },
      {
        to: 6,
        run: () => {
          /*
           * 슬래시 명령(스킬) 캐시.
           *
           * 스킬은 세션이 아니라 **도구+디렉토리의 성질**이라 세션과 함께 사라지면 안 된다.
           * 메모리에만 두면 host를 껐다 켠 뒤 첫 세션(=잠들어 있는 세션)에서 영영 못 받는다:
           * 잠든 세션에는 물어볼 프로세스가 없고, 캐시도 비어 있기 때문이다
           * (도그푸딩에서 지적됨). 그래서 디스크에 남긴다.
           */
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS command_cache (
              tool TEXT NOT NULL,
              cwd TEXT NOT NULL,
              commands TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (tool, cwd)
            )
          `)
        },
      },
      {
        to: 7,
        run: () => {
          // 추론 강도도 세션별로 기억한다 — 모델과 같은 성질이라 같은 자리에 둔다
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'effort')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN effort TEXT`)
          }
        },
      },
    ]

    for (const step of steps) {
      if (current < step.to) {
        step.run()
        this.db.pragma(`user_version = ${step.to}`)
      }
    }
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
        `INSERT INTO sessions (id, project_id, tool, external_id, name, auto_named, state, archived, last_read_seq, waiting_since, created_at, model, effort, permission_preset, imported_from)
         VALUES (@id, @projectId, @tool, @externalId, @name, @autoNamed, @state, @archived, @lastReadSeq, @waitingSince, @createdAt, @model, @effort, @permissionPreset, @importedFrom)
         ON CONFLICT(id) DO UPDATE SET
           external_id = excluded.external_id, name = excluded.name, auto_named = excluded.auto_named,
           state = excluded.state, archived = excluded.archived, last_read_seq = excluded.last_read_seq,
           waiting_since = excluded.waiting_since, model = excluded.model, effort = excluded.effort,
           permission_preset = excluded.permission_preset, imported_from = excluded.imported_from`,
      )
      .run({
        ...s,
        autoNamed: s.autoNamed ? 1 : 0,
        archived: s.archived ? 1 : 0,
        effort: s.effort ?? null,
        importedFrom: s.importedFrom ?? null,
      })
  }

  listSessions(): SessionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.project_id as projectId, s.tool, s.external_id as externalId, s.name,
                s.auto_named as autoNamed, s.state, s.archived, s.last_read_seq as lastReadSeq,
                s.waiting_since as waitingSince, s.created_at as createdAt,
                s.model, s.effort, s.permission_preset as permissionPreset, s.imported_from as importedFrom,
                COALESCE((SELECT MAX(seq) FROM messages m WHERE m.session_id = s.id), 0) as lastSeq
         FROM sessions s ORDER BY s.created_at`,
      )
      .all() as (Omit<SessionInfo, 'autoNamed' | 'archived'> & { autoNamed: number; archived: number })[]
    return rows.map((r) => ({ ...r, autoNamed: !!r.autoNamed, archived: !!r.archived, live: false }))
  }

  /**
   * 세션을 완전히 지운다 (대화·검색 인덱스·승인 규칙까지).
   * 아카이브는 "치우되 남긴다"이고 이건 "없앤다"다 — 둘 다 필요하다.
   */
  deleteSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM approval_rules WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId)
    })
    tx()
  }

  appendMessages(msgs: StoredMessage[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const fts = this.db.prepare(`INSERT INTO messages_fts (body, session_id, seq) VALUES (?, ?, ?)`)
    const tx = this.db.transaction((rows: StoredMessage[]) => {
      for (const m of rows) {
        const payload = JSON.stringify(m.payload)
        stmt.run(m.sessionId, m.seq, m.role, m.kind, payload, m.ts)
        const body = extractText(payload)
        if (body) fts.run(body, m.sessionId, m.seq)
      }
    })
    tx(msgs)
  }

  /**
   * 대화 전문 검색 (E-1). 아카이브된 세션도 포함한다 — 찾으려는 것이 거기 있을 수 있다.
   */
  searchMessages(query: string, limit = 50): { sessionId: string; seq: number; snippet: string }[] {
    const q = query.trim()
    if (!q) return []

    // trigram 토크나이저는 **3글자 미만을 찾지 못한다** (실측).
    // 한국어에서 '승인'·'배포' 같은 두 글자 검색은 흔하므로 LIKE로 넘긴다.
    if (q.length < 3) {
      return this.db
        .prepare(
          `SELECT session_id as sessionId, seq, body as snippet FROM messages_fts
           WHERE body LIKE ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(`%${q}%`, limit) as { sessionId: string; seq: number; snippet: string }[]
    }

    try {
      return this.db
        .prepare(
          `SELECT session_id as sessionId, seq, snippet(messages_fts, 0, '', '', '…', 12) as snippet
           FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(`"${q.replace(/"/g, '""')}"`, limit) as { sessionId: string; seq: number; snippet: string }[]
    } catch {
      // FTS 구문 오류(특수문자 등)에는 조용히 빈 결과 — 검색창이 깨지면 안 된다
      return []
    }
  }

  setTouchedPaths(sessionId: string, paths: string[]): void {
    this.db.prepare(`UPDATE sessions SET touched_paths = ? WHERE id = ?`).run(JSON.stringify(paths), sessionId)
  }

  getTouchedPaths(sessionId: string): string[] {
    const row = this.db.prepare(`SELECT touched_paths as p FROM sessions WHERE id = ?`).get(sessionId) as
      | { p: string }
      | undefined
    try {
      return row ? (JSON.parse(row.p) as string[]) : []
    } catch {
      return []
    }
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

  /** 스킬 목록을 남긴다 (도구+디렉토리 단위) */
  saveCommands(tool: string, cwd: string, commands: unknown): void {
    this.db
      .prepare(
        `INSERT INTO command_cache (tool, cwd, commands, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tool, cwd) DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at`,
      )
      .run(tool, cwd, JSON.stringify(commands), Date.now())
  }

  loadCommands<T>(tool: string, cwd: string): T | null {
    const row = this.db
      .prepare(`SELECT commands FROM command_cache WHERE tool = ? AND cwd = ?`)
      .get(tool, cwd) as { commands: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.commands) as T
    } catch {
      return null
    }
  }

  nextSeq(sessionId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) as m FROM messages WHERE session_id = ?`).get(sessionId) as { m: number }
    return row.m + 1
  }

  markRead(sessionId: string, seq: number): void {
    this.db.prepare(`UPDATE sessions SET last_read_seq = MAX(last_read_seq, ?) WHERE id = ?`).run(seq, sessionId)
  }

  /**
   * 워크스페이스 스냅샷 (C-3). 종료 시점이 아니라 변화 시마다 저장하므로
   * 크래시해도 마지막 상태가 남는다 (docs/state-management.md §5).
   */
  saveWorkspace(layout: unknown): void {
    this.db
      .prepare(
        `INSERT INTO workspace (id, layout, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(layout), Date.now())
  }

  loadWorkspace<T = unknown>(): T | null {
    const row = this.db.prepare(`SELECT layout FROM workspace WHERE id = 1`).get() as { layout: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.layout) as T
    } catch {
      return null
    }
  }

  addApprovalRule(r: { scope: string; projectId?: string; sessionId?: string; matcher: string; decision: string }): void {
    this.db
      .prepare(`INSERT INTO approval_rules (scope, project_id, session_id, matcher, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.scope, r.projectId ?? null, r.sessionId ?? null, r.matcher, r.decision, Date.now())
  }

  listApprovalRules(): {
    id: number
    scope: string
    matcher: string
    decision: string
    projectId: string | null
    sessionId: string | null
    createdAt: number
  }[] {
    return this.db
      .prepare(
        `SELECT id, scope, matcher, decision, project_id as projectId, session_id as sessionId,
                created_at as createdAt
         FROM approval_rules ORDER BY created_at DESC`,
      )
      .all() as never
  }

  /** 규칙은 지울 수 있어야 한다 — 저장만 되고 못 지우면 '결과를 보이게 한다'가 반쪽이다 */
  deleteApprovalRule(id: number): void {
    this.db.prepare(`DELETE FROM approval_rules WHERE id = ?`).run(id)
  }
}

/** 검색 대상 텍스트만 뽑는다 (도구 호출 payload 전체를 넣으면 잡음이 된다) */
function extractText(payload: string): string {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>
    if (typeof p.text === 'string') return p.text
    if (typeof p.title === 'string') return p.title
    if (p.summary && typeof p.summary === 'object') {
      const s = p.summary as { title?: string }
      return s.title ?? ''
    }
    return ''
  } catch {
    return ''
  }
}
