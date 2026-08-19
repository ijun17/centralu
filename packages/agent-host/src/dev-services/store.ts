import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ProjectInfo, SessionInfo, StoredMessage } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'

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
      {
        to: 8,
        run: () => {
          // 사이드바 순서를 사람이 정할 수 있게 (프로젝트는 이미 컬럼이 있었다)
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'sidebar_order')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN sidebar_order INTEGER NOT NULL DEFAULT 0`)
          }
        },
      },
      {
        to: 9,
        run: () => {
          /*
           * 그리드에 올려둔 세션.
           *
           * 세션 테이블의 컬럼이 아니라 **따로 둔다**: 그리드에 있는 것과 세션이
           * 존재하는 것은 다른 사실이고, 그리드에서 빼도 세션은 그대로 남는다.
           * 컬럼으로 두면 "안 올라간 세션"을 0과 NULL 중 무엇으로 볼지가 계속 애매해진다.
           */
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS control_center (
              session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
              position   INTEGER NOT NULL
            )
          `)
        },
      },
      {
        to: 10,
        run: () => {
          /*
           * 오케스트레이터는 **프로젝트에 속하지 않는다.**
           *
           * 앱에 하나뿐이고 프로젝트를 가로지르는 세션이라, project_id가 NOT NULL이면
           * 아무 프로젝트에나 매달아야 하고 그 프로젝트를 지우면 CASCADE로 함께 죽는다.
           * 둘 다 틀렸다.
           *
           * SQLite는 컬럼의 NOT NULL을 못 푼다 — 표준 절차대로 테이블을 다시 만든다.
           * 이 프로젝트에서 가장 위험한 변경이므로 **옮긴 줄 수를 세어 확인**한다.
           * 조용히 한 줄이라도 잃으면 되돌릴 방법이 없다.
           */
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string; notnull: number }[]
          const pid = cols.find((c) => c.name === 'project_id')
          if (!pid || pid.notnull === 0) return // 이미 nullable

          const before = (this.db.prepare(`SELECT COUNT(*) as n FROM sessions`).get() as { n: number }).n
          const names = cols.map((c) => c.name).join(', ')

          /*
           * **한 덩어리로 돈다.**
           *
           * DROP과 RENAME 사이에서 무엇이든 잘못되면 세션 테이블이 사라진 DB가 남는다.
           * 되돌릴 방법이 없는 상태다.
           *
           * foreign_keys 프래그마는 트랜잭션 **안에서는 무시된다**(SQLite 규칙).
           * 그래서 끄고 → 트랜잭션 → 켜는 순서를 지킨다.
           */
          this.db.pragma('foreign_keys = OFF')
          try {
            this.db.transaction(() => this.rebuildSessionsTable(names, before))()
          } finally {
            this.db.pragma('foreign_keys = ON')
          }
        },
      },
      {
        to: 11,
        run: () => {
          /*
           * 색인을 메시지에 다시 못 박는다.
           *
           * 그동안 색인은 맨 INSERT라 같은 메시지를 다시 쓸 때마다 행이 하나씩 늘었다.
           * 실제 DB에서 메시지 28,892건에 색인 249,809행 — **8.6배**였다.
           * 그래서 recall이 같은 말을 반복해서 내놓았고(limit이 무의미해졌다),
           * 색인이 본문의 수십 배로 부풀어 있었다.
           *
           * 기존 행은 rowid가 메시지와 무관하므로 골라내지 못한다 — 통째로 다시 만든다.
           * 한 덩어리로 돌린다: 중간에 끊기면 검색이 통째로 빈 채로 남는다.
           */
          const tx = this.db.transaction(() => {
            this.db.exec(`DROP TABLE IF EXISTS messages_fts`)
            this.db.exec(`
              CREATE VIRTUAL TABLE messages_fts USING fts5(
                body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
              );
            `)
            const rows = this.db
              .prepare(`SELECT rowid, session_id, seq, payload FROM messages`)
              .all() as { rowid: number; session_id: string; seq: number; payload: string }[]
            const insert = this.db.prepare(
              `INSERT INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`,
            )
            for (const r of rows) {
              const body = extractText(r.payload)
              if (body) insert.run(r.rowid, body, r.session_id, r.seq)
            }
          })
          tx()
          /*
           * 지운 자리는 SQLite가 알아서 돌려주지 않는다. 겹친 행이 차지하던 공간이
           * 그대로 파일에 남아 있으므로 여기서 한 번 걷는다 — 실측한 DB에서 165MB → 21MB.
           * (트랜잭션 안에서는 돌지 않아 커밋 뒤에 따로 부른다.)
           */
          this.db.exec('VACUUM')
        },
      },
      {
        to: 12,
        run: () => {
          /*
           * 워크트리 세션 (FR-2 옵션).
           *
           * 경로를 DB에 남기는 이유: 재개할 때 **같은 워크트리로 돌아가야** 한다.
           * 프로젝트 경로로 되돌아가면 격리가 조용히 풀리고, 사용자는 여전히 격리된 줄 안다.
           */
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'worktree_path')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`)
            this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_branch TEXT`)
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

  /** v10: project_id의 NOT NULL을 푼다. SQLite는 컬럼을 못 고치므로 테이블을 다시 만든다 */
  private rebuildSessionsTable(names: string, before: number): void {
    this.db.exec(`
      CREATE TABLE sessions_new (
              id            TEXT PRIMARY KEY,
              project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
              tool          TEXT NOT NULL,
              external_id   TEXT,
              name          TEXT NOT NULL,
              auto_named    INTEGER NOT NULL DEFAULT 1,
              state         TEXT NOT NULL DEFAULT 'idle',
              archived      INTEGER NOT NULL DEFAULT 0,
              is_orchestrator INTEGER NOT NULL DEFAULT 0,
              last_read_seq INTEGER NOT NULL DEFAULT 0,
              waiting_since INTEGER,
              created_at    INTEGER NOT NULL,
              touched_paths TEXT NOT NULL DEFAULT '[]',
              model         TEXT,
              effort        TEXT,
              permission_preset TEXT NOT NULL DEFAULT 'normal',
              imported_from TEXT,
              worktree_path TEXT,
              worktree_branch TEXT,
              sidebar_order INTEGER NOT NULL DEFAULT 0
            )
          `)
          this.db.exec(`INSERT INTO sessions_new (${names}) SELECT ${names} FROM sessions`)
    this.db.exec(`DROP TABLE sessions`)
    this.db.exec(`ALTER TABLE sessions_new RENAME TO sessions`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, archived)`)

    // 한 줄이라도 조용히 잃으면 되돌릴 방법이 없다 — 던지면 트랜잭션이 통째로 물러난다
    const after = (this.db.prepare(`SELECT COUNT(*) as n FROM sessions`).get() as { n: number }).n
    if (after !== before) throw new Error(`세션 이관 중 유실: ${before} → ${after}`)
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

  /**
   * UPDATE 절에는 **바뀔 수 있는 것 전부**가 있어야 한다.
   * tool이 빠져 있어서 에이전트 전환(claude↔codex)이 저장되지 않았다 —
   * 재시작하면 도구는 되돌아가는데 이어갈 실마리(external_id)는 이미 끊긴 뒤라
   * 되살릴 수도 없는 세션이 됐다. (project_id·created_at은 정의상 바뀌지 않는다)
   */
  upsertSession(s: SessionInfo): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, tool, external_id, name, auto_named, state, archived, last_read_seq, waiting_since, created_at, model, effort, permission_preset, imported_from, worktree_path, worktree_branch)
         VALUES (@id, @projectId, @tool, @externalId, @name, @autoNamed, @state, @archived, @lastReadSeq, @waitingSince, @createdAt, @model, @effort, @permissionPreset, @importedFrom, @worktreePath, @worktreeBranch)
         ON CONFLICT(id) DO UPDATE SET
           tool = excluded.tool,
           external_id = excluded.external_id, name = excluded.name, auto_named = excluded.auto_named,
           state = excluded.state, archived = excluded.archived, last_read_seq = excluded.last_read_seq,
           waiting_since = excluded.waiting_since, model = excluded.model, effort = excluded.effort,
           permission_preset = excluded.permission_preset, imported_from = excluded.imported_from,
           worktree_path = excluded.worktree_path, worktree_branch = excluded.worktree_branch`,
      )
      .run({
        ...s,
        autoNamed: s.autoNamed ? 1 : 0,
        archived: s.archived ? 1 : 0,
        effort: s.effort ?? null,
        importedFrom: s.importedFrom ?? null,
        worktreePath: s.worktree?.path ?? null,
        worktreeBranch: s.worktree?.branch ?? null,
      })
  }

  /**
   * 사이드바 순서 저장.
   *
   * **전체 순서를 통째로 받아 다시 매긴다.** "이걸 저기로" 식으로 인접 항목만
   * 건드리면 값이 촘촘해질 때 재배치가 필요해지고, 그 사이 목록이 바뀌면 어긋난다.
   * 목록이 짧으니(사람이 보는 사이드바다) 전부 다시 쓰는 게 단순하고 안전하다.
   */
  setProjectOrder(orderedIds: readonly string[]): void {
    const stmt = this.db.prepare(`UPDATE projects SET sidebar_order = ? WHERE id = ?`)
    this.db.transaction(() => orderedIds.forEach((id, i) => stmt.run(i, id)))()
  }

  setSessionOrder(orderedIds: readonly string[]): void {
    const stmt = this.db.prepare(`UPDATE sessions SET sidebar_order = ? WHERE id = ?`)
    this.db.transaction(() => orderedIds.forEach((id, i) => stmt.run(i, id)))()
  }

  /** 그리드 배치 — 올려둔 순서대로 */
  listGridView(): string[] {
    return (
      this.db.prepare(`SELECT session_id FROM control_center ORDER BY position`).all() as {
        session_id: string
      }[]
    ).map((r) => r.session_id)
  }

  /**
   * 배치를 통째로 다시 쓴다.
   *
   * 추가·제거·순서 바꾸기가 모두 이 한 가지로 오므로 지우고 새로 넣는 게 가장 단순하다.
   * 목록이 짧고(사람이 보는 화면이다) 한 트랜잭션이라 중간 상태가 보이지 않는다.
   */
  setGridView(sessionIds: readonly string[]): void {
    const del = this.db.prepare(`DELETE FROM control_center`)
    const ins = this.db.prepare(`INSERT INTO control_center (session_id, position) VALUES (?, ?)`)
    this.db.transaction(() => {
      del.run()
      sessionIds.forEach((id, i) => ins.run(id, i))
    })()
  }

  /**
   * 앱에 하나뿐인 오케스트레이터의 id (없으면 null).
   *
   * SessionInfo에 플래그로 싣지 않는다 — `projectId === null`과 같은 사실을 두 곳에 두면
   * 언젠가 한쪽만 고쳐진다. "누가 오케스트레이터인가"는 여기서 한 번만 답한다.
   */
  orchestratorId(): string | null {
    const row = this.db.prepare(`SELECT id FROM sessions WHERE is_orchestrator = 1 LIMIT 1`).get() as
      | { id: string }
      | undefined
    return row?.id ?? null
  }

  /** 하나뿐이라는 것을 저장소가 지킨다 — 나머지는 전부 내린다 */
  markOrchestrator(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE sessions SET is_orchestrator = 0 WHERE is_orchestrator = 1`).run()
      this.db.prepare(`UPDATE sessions SET is_orchestrator = 1 WHERE id = ?`).run(sessionId)
    })()
  }

  listSessions(): SessionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.project_id as projectId, s.tool, s.external_id as externalId, s.name,
                s.auto_named as autoNamed, s.state, s.archived, s.last_read_seq as lastReadSeq,
                s.waiting_since as waitingSince, s.created_at as createdAt,
                s.model, s.effort, s.permission_preset as permissionPreset, s.imported_from as importedFrom,
                s.worktree_path as worktreePath, s.worktree_branch as worktreeBranch,
                COALESCE((SELECT MAX(seq) FROM messages m WHERE m.session_id = s.id), 0) as lastSeq
         FROM sessions s ORDER BY s.sidebar_order, s.created_at`,
      )
      .all() as (Omit<SessionInfo, 'autoNamed' | 'archived' | 'worktree'> & {
      autoNamed: number
      archived: number
      worktreePath: string | null
      worktreeBranch: string | null
    })[]
    // 살아-있는-동안 필드는 DB에 없다 — 복원된 세션에는 정의상 없는 것이 맞다 (host가 죽으면 함께 죽는 사실들)
    return rows.map(({ worktreePath, worktreeBranch, ...r }) => ({
      ...r,
      autoNamed: !!r.autoNamed,
      archived: !!r.archived,
      live: false,
      worktree: worktreePath ? { path: worktreePath, branch: worktreeBranch ?? '' } : null,
      ...sessionLiveDefaults(),
    }))
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

  /**
   * 메시지를 남긴다 — **같은 자리에 두 번 쓰면 덮어쓴다, 색인도 함께.**
   *
   * 예전에는 messages만 INSERT OR REPLACE고 색인은 맨 INSERT였다. 그래서 같은 (세션, seq)를
   * 다시 쓸 때마다 색인에는 **행이 하나씩 늘었다.** 실제 DB에서 메시지 28,892건에
   * 색인 249,809행 — 8.6배였고, 많은 것은 13번까지 겹쳐 있었다.
   *
   * 그 대가를 두 곳에서 치르고 있었다: recall 결과가 같은 말로 도배되어 limit이 무의미했고
   * (도그푸딩: "limit 8인데 같은 게 5번"), 색인이 본문의 수십 배로 부풀었다.
   *
   * 고치는 방법은 색인 행을 **메시지 행에 못 박는 것**이다. rowid를 messages의 rowid로
   * 쓰면 INSERT OR REPLACE가 알아서 덮는다. (session_id·seq는 UNINDEXED라
   * WHERE로 지우려 하면 25만 행 전체 훑기가 된다 — 쓸 때마다 그럴 수는 없다.)
   *
   * messages도 REPLACE가 아니라 UPDATE여야 한다. REPLACE는 지우고 다시 넣는 것이라
   * **rowid가 바뀌고**, 그러면 색인이 가리키던 자리가 사라진다.
   */
  appendMessages(msgs: StoredMessage[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET role = excluded.role, kind = excluded.kind,
         payload = excluded.payload, ts = excluded.ts`,
    )
    const rowidOf = this.db.prepare(`SELECT rowid FROM messages WHERE session_id = ? AND seq = ?`)
    const fts = this.db.prepare(
      `INSERT OR REPLACE INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`,
    )
    const dropFts = this.db.prepare(`INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', ?, ?)`)
    const bodyAt = this.db.prepare(`SELECT body FROM messages_fts WHERE rowid = ?`)
    const tx = this.db.transaction((rows: StoredMessage[]) => {
      for (const m of rows) {
        const payload = JSON.stringify(m.payload)
        stmt.run(m.sessionId, m.seq, m.role, m.kind, payload, m.ts)
        const body = extractText(payload)
        const rid = (rowidOf.get(m.sessionId, m.seq) as { rowid: number } | undefined)?.rowid
        if (rid === undefined) continue
        if (body) {
          fts.run(rid, body, m.sessionId, m.seq)
        } else {
          // 본문이 사라진 자리는 색인에서도 걷는다 (안 그러면 옛 본문이 계속 검색된다)
          const old = (bodyAt.get(rid) as { body: string } | undefined)?.body
          if (old !== undefined) dropFts.run(rid, old)
        }
      }
    })
    tx(msgs)
  }

  /**
   * 대화 전문 검색 (E-1). 아카이브된 세션도 포함한다 — 찾으려는 것이 거기 있을 수 있다.
   */
  /**
   * 대화 전문 검색. **본문을 통째로 돌려준다** — 자르는 일은 부르는 쪽이 한다.
   *
   * 예전에는 여기서 `snippet(..., 12)`으로 잘라 줬는데, 그 12는 글자 수가 아니라
   * **토큰 수**고 토크나이저가 trigram이라 실질 15자쯤에서 끊겼다. 오케스트레이터에게는
   * `"은하수 색이 이미 정책 목…"` 같은 것만 도착해서 **이게 찾던 대목인지 가릴 수가 없었다.**
   * 앞뒤 문맥이 얼마나 필요한지는 쓰는 쪽이 아는 일이라 판단을 넘긴다.
   */
  searchMessages(query: string, limit = 50): { sessionId: string; seq: number; body: string }[] {
    const q = query.trim()
    if (!q) return []

    // trigram 토크나이저는 **3글자 미만을 찾지 못한다** (실측).
    // 한국어에서 '승인'·'배포' 같은 두 글자 검색은 흔하므로 LIKE로 넘긴다.
    if (q.length < 3) {
      return this.db
        .prepare(
          `SELECT session_id as sessionId, seq, body FROM messages_fts
           WHERE body LIKE ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(`%${q}%`, limit) as { sessionId: string; seq: number; body: string }[]
    }

    try {
      return this.db
        .prepare(
          `SELECT session_id as sessionId, seq, body
           FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(`"${q.replace(/"/g, '""')}"`, limit) as { sessionId: string; seq: number; body: string }[]
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
