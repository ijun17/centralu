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

  /**
   * 이번에 **실제로 돌린** 마이그레이션 스텝 수.
   *
   * 진단이자 회귀 방지선이다. "이미 지난 스텝을 다시 돌지 않는다"는 성질은 눈에
   * 보이지 않아서, 한 번 깨지면(schema.sql의 `PRAGMA user_version`이 그랬듯) 결과가
   * 옳은 채로 시간만 먹으며 아무도 모르게 지낸다. 세어 두면 테스트가 물어볼 수 있다.
   */
  migrationsRun = 0

  constructor(path = ':memory:') {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
    this.migrate()
    /*
     * 물려받은 WAL을 여기서 접는다. 실측(2026-08-26): store.db 91MB 옆에 store.db-wal이
     * 97MB — DB보다 컸다. WAL은 close()가 접어주지만, 앱 종료 경로에서 host가 close()에
     * 못 미치고 SIGKILL당하면(예전 Tauri 300ms 예산) 다음 실행까지 그대로 남는다.
     * 시작할 때 한 번, 그리고 닫을 때 한 번 — 어느 쪽이 못 돌아도 반대쪽이 접는다.
     */
    this.checkpoint()
  }

  /** WAL을 본 DB에 합치고 파일을 0으로 자른다. 실패해도 치명적이지 않아 조용히 넘어간다 */
  checkpoint(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      // 다른 연결이 읽는 중이면 TRUNCATE가 미뤄질 수 있다 — 다음 기회에 다시
    }
  }

  /**
   * 마이그레이션 러너 (E-0).
   *
   * 스키마 파일은 `CREATE TABLE IF NOT EXISTS`뿐이라 **기존 DB에는 컬럼·인덱스 추가가
   * 조용히 무시된다.** 이미 실사용 데이터가 쌓인 파일이 있으므로(~/.centralu/store.db)
   * user_version을 보고 순차 적용한다.
   *
   * **한 번 지난 스텝은 다시 돌지 않는다.** 오랫동안 그러지 못했다 — schema.sql이
   * 열 때마다 `PRAGMA user_version = 1`을 다시 적어서, v27인 DB도 매 실행 26개를
   * 처음부터 다시 돌았다. 스텝들이 하나같이 멱등하게(guard로) 쓰여 있어서 결과는
   * 옳았고, 그래서 **비용만 조용히 자랐다**: 열 때마다 4.4~5.0초, 그중 v3·v11·v21이
   * 각각 전체 메시지(66,700건)를 훑는 값이었다. 그 PRAGMA를 지운 것이 이 성질을 만든다.
   *
   * 아래 스텝들은 여전히 **멱등하게 써야 한다.** 새 DB는 0에서 시작해 26개를 순서대로
   * 한 번에 다 돌고, schema.sql이 이미 만들어 둔 테이블 위에서 도는 스텝이 많다
   * (예: v13은 v9가 만든 빈 테이블을 보고 건너뛴다).
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
            CREATE TABLE IF NOT EXISTS grid_panels (
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
      {
        to: 13,
        run: () => {
          /*
           * 개명 마무리: 옛 이름의 테이블에 남은 그리드 배치를 `grid_panels`로 옮긴다. (legacy-name)
           *
           * **`ALTER TABLE ... RENAME TO`로 하면 안 된다.** `schema.sql`이 실행될 때마다
           * `user_version`을 1로 되돌리므로 이 목록은 **매번 처음부터 다시 돈다** — 그래서
           * 9번이 먼저 빈 `grid_panels`를 만들어 놓고, 여기서 "이미 있네" 하고 건너뛰게 된다.
           * 그러면 사용자가 올려둔 배치가 옛 테이블에 고아로 남는다 (테스트가 잡은 실제 결함).
           *
           * 그래서 옮기고 지운다. 두 번째 실행부터는 옛 테이블이 없으므로 아무 일도 안 한다.
           */
          const has = (name: string) =>
            this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) !== undefined
          if (has('control_center')) { // legacy-name
            this.db.exec(
              `INSERT OR IGNORE INTO grid_panels (session_id, position)
               SELECT session_id, position FROM control_center`, // legacy-name
            )
            this.db.exec(`DROP TABLE control_center`) // legacy-name
          }
        },
      },
      {
        to: 14,
        run: () => {
          /*
           * The directory a session was created in. Stored, not recomputed. (issue #28)
           *
           * Until now every start derived the cwd again — the project's path, or
           * `orchestratorHome()` (= `dataRoot()/orchestrator`) for the orchestrator. Then the
           * data directory was renamed to `~/.centralu` from the folder named just below, and
           * the orchestrator's cwd moved with it. Claude Code keys its session store **by
           * working directory**, so the tool went looking in a project slug that had never
           * existed and answered "not found". The 821KB transcript sat untouched under the old
           * slug the whole time, and the app told its owner the conversation had been deleted.
           *
           *   old cwd `~/.control-center/orchestrator` → transcript filed here, still there // legacy-name
           *   new cwd `~/.centralu/orchestrator`       → no such slug, so "not found"
           *
           * The old name is spelled out because naming it is the whole explanation; nothing
           * here goes near that path (see DATA_DIR_LEGACY in brand.ts).
           *
           * A derived cwd is a promise we cannot keep: anything that moves a folder — our own
           * rename, the user moving a project — silently repoints a live session at a place
           * its history was never written to. So we write it down once and read it back.
           *
           * Backfill is what SQL can prove: a worktree session's worktree, otherwise the
           * project's path. Orchestrator rows (no project, no worktree) stay NULL — resolving
           * them here would mean calling `orchestratorHome()`, which creates a directory, and
           * a migration that touches the user's home on every open is how `pnpm verify` once
           * blocked the real data move (see data-dir.ts). The manager fills those in the first
           * time it actually needs the path, and from then on they are stored too.
           */
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'cwd')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN cwd TEXT`)
          }
          // `WHERE cwd IS NULL` matters: schema.sql resets user_version to 1, so every step
          // replays on every open (see v13's note). Without it this would overwrite the
          // stored path with a freshly derived one — exactly the bug being fixed.
          this.db.exec(`
            UPDATE sessions
               SET cwd = COALESCE(worktree_path, (SELECT p.path FROM projects p WHERE p.id = sessions.project_id))
             WHERE cwd IS NULL
               AND (worktree_path IS NOT NULL OR project_id IS NOT NULL)
          `)
        },
      },
      {
        to: 15,
        run: () => {
          /*
           * Shell commands saved on a project (issue #44).
           *
           * A column on the project row, not a table of its own. The list is short, it is
           * always read and written whole, and it has no life apart from the project it
           * belongs to — a table would buy per-row identity nobody asks for and would need
           * its own rule for what happens when the project goes.
           *
           * That also keeps `listProjects` a single query, which is what lets the Run menu
           * say "nothing saved yet" as a fact instead of as "not loaded yet". Contrast
           * `grid_panels` (v9), which is a table because being on the grid and existing as a
           * session are two different facts; a saved command has no such second life.
           */
          const cols = this.db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'commands')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN commands TEXT NOT NULL DEFAULT '[]'`)
          }
        },
      },
      {
        to: 16,
        run: () => {
          /*
           * Settings that belong to the host itself (issue #43).
           *
           * The first one is whether to check for updates on a schedule, and it cannot live
           * in `workspace` with the rest of the preferences: that row is a single blob the
           * UI writes whole, and the host reading its own setting out of the other side's
           * document would be a second reader of a record with exactly one author. Worse,
           * the thing this governs is a **timer in this process**, which has to know its
           * answer before any UI has connected.
           *
           * A key/value table rather than a column, because there is no row it belongs to —
           * this is about the install, not about a project or a session.
           */
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS app_settings (
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
          `)
        },
      },
      {
        to: 17,
        run: () => {
          /*
           * How full a conversation's context is (issue #48).
           *
           * The reading was right and arrived once a turn; it simply lived in memory and
           * died with the host. So a cold start showed `Context —` on every session until
           * that session happened to work again — a gauge that read as broken when in fact
           * nobody had ever written the number down. This is the third time for this shape:
           * model/effort/permission (v4/v7) and the worktree (v12) were the same bug, a
           * runtime fact coming back as a default.
           *
           * Three flat columns rather than one JSON blob, following `worktree_path` /
           * `worktree_branch` (v12) — the record is small, fixed, and always read whole, so
           * columns buy the same thing without a decoding rule that can fail. `commands`
           * (v15) is JSON because it is a list of unknown length; this is not.
           *
           * `context_used IS NULL` is the honest "never reported one", which is exactly the
           * state the gauge already tells apart from 0%. Both adapters feed this through the
           * one `context_update` event, so nothing here is Claude-shaped (Codex started
           * sending it in 3ae2029).
           */
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'context_used')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN context_used INTEGER`)
            this.db.exec(`ALTER TABLE sessions ADD COLUMN context_window INTEGER`)
            this.db.exec(`ALTER TABLE sessions ADD COLUMN context_exactness TEXT`)
          }
        },
      },
      {
        to: 18,
        run: () => {
          // 응답 길이(codex의 model_verbosity, #54) — model/effort(v4/v7)와 같은 성질이라 같은 자리
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'verbosity')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN verbosity TEXT`)
          }
          /*
           * is_orchestrator를 여기서도 보장한다 (#13). 새 DB의 DDL과 v10 재구축에는
           * 있지만, **v10이 일찍 돌아나가는 DB**(project_id가 애초에 nullable이던 옛
           * 스키마)는 이 컬럼 없이 v17까지 왔다 — orchestratorId()가 읽는 순간
           * 터지는 지뢰였는데, listSessions까지 읽게 되면서(#13) 겉으로 드러났다.
           */
          if (!cols.some((c) => c.name === 'is_orchestrator')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN is_orchestrator INTEGER NOT NULL DEFAULT 0`)
          }
        },
      },
      {
        to: 19,
        run: () => {
          /*
           * 커밋 귀속 (#50). 저장소에는 아무것도 쓰지 않는다는 결정(2026-08-23)의
           * 반쪽 — 기록은 여기, 우리 DB에만 남는다. 해시는 에이전트의 git commit
           * 도구 출력에서 주운 것이라 짧을 수 있다(접두사 매칭으로 푼다).
           */
          this.db.exec(`CREATE TABLE IF NOT EXISTS commit_sessions (
            project_id TEXT NOT NULL,
            sha        TEXT NOT NULL,
            session_id TEXT NOT NULL,
            ts         INTEGER NOT NULL,
            PRIMARY KEY (project_id, sha)
          )`)
        },
      },
      {
        to: 20,
        run: () => {
          // 응답 속도(codex의 service_tier) — verbosity(v18)와 같은 성질이라 같은 자리
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'service_tier')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN service_tier TEXT`)
          }
        },
      },
      {
        to: 21,
        run: () => this.mergeDeltaRows(),
      },
      {
        to: 22,
        run: () => {
          /*
           * 세션 트리 (#69): 워크트리 세션이 매니저 세션 아래에 매달린다.
           * FK 제약은 걸지 않는다 — 부모가 지워질 때 자식까지 CASCADE로 죽으면
           * 워크트리 세션의 대화가 부모 삭제 한 번에 사라진다. 링크가 끊긴 자식은
           * 다음 기동의 입양(adoptOrphanWorktrees)이 다시 붙인다.
           */
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'parent_session_id')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`)
          }
        },
      },
      {
        to: 23,
        run: () => {
          /*
           * 워크트리 프로비저닝 (#69): 새 워크트리는 빈 작업대다 — node_modules도
           * .env도 없다. 프로젝트마다 셋업 커맨드와 복사할 파일 목록을 기억한다.
           * 레포가 아니라 여기(우리 DB)에 사는 이유: 레포에는 아무것도 쓰지 않는다 (#50).
           */
          const cols = this.db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'worktree_setup')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN worktree_setup TEXT`)
          }
        },
      },
      {
        to: 24,
        run: () => {
          /*
           * 병합 감지의 기준점 (#69): 워크트리 브랜치가 생성될 때의 HEAD sha.
           * 갓 만든 브랜치는 HEAD의 조상이라, 이 기준 없이 is-ancestor만 보면
           * 만들자마자 "병합됨"으로 읽힌다. 이전 행(base 없음)은 자동 감지에서 빠진다 —
           * 추측으로 채우면 틀린 배지가 되고, 사람이 지우는 길은 언제나 열려 있다.
           */
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'worktree_base')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_base TEXT`)
          }
        },
      },
      {
        to: 25,
        run: () => {
          /*
           * 마지막으로 고른 추론 강도도 프로젝트 기본값이 된다 (#69 도그푸딩 ⑤).
           * default_model은 v1부터 있었지만 effort 자리가 없어서, Opus·high를 고른
           * 사람이 세션마다 high를 다시 눌렀다 — default_tool이 배운 교훈 그대로다.
           */
          const cols = this.db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'default_effort')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN default_effort TEXT`)
          }
        },
      },
      {
        to: 26,
        run: () => {
          /*
           * 프로젝트 오케스트레이터 폐기 (2026-09-01, #13 되돌림).
           *
           * **데이터를 먼저 고쳐야 하는 이유가 있다.** 코드에서 프로젝트 범위 단계가
           * 사라지면서, 표식이 남은 세션은 강등되는 게 아니라 **중앙 시야를 얻는다** —
           * 자기 프로젝트만 보던 세션이 다음에 깰 때 모든 프로젝트의 세션에 지시할 수
           * 있게 된다. 조용한 권한 확대라 화면 어디에도 안 나타난다.
           *
           * 그래서 표식을 지운다. 잃는 것은 도구 몇 개뿐이고 대화는 그대로다.
           * 중앙 오케스트레이터(project_id IS NULL)는 건드리지 않는다.
           */
          this.db.exec(`UPDATE sessions SET is_orchestrator = 0 WHERE is_orchestrator = 1 AND project_id IS NOT NULL`)
        },
      },
      {
        to: 27,
        run: () => {
          /*
           * 워크트리 매니저의 자리와 줄기 (#76).
           *
           * **왜 프로젝트에 다는가.** 매니저는 지금까지 순전히 관계였다 — 워크트리 자식이
           * 있으면 매니저다. 그 규칙은 표식과 링크가 어긋날 수 없다는 장점이 있었지만,
           * 자식이 생기기 전에는 매니저가 존재할 수 없다는 뜻이기도 했다: 첫 브랜치는
           * 언제나 사람이 혼자 정해야 했고, 매니저의 제안 기능은 두 번째 브랜치부터
           * 쓸모가 생겼다.
           *
           * 세션에 표식 컬럼을 다는 대신 **프로젝트가 자기 매니저를 가리킨다.** 여전히
           * 링크지 플래그가 아니고, "프로젝트당 하나"가 컬럼 하나로 구조가 된다 (예전엔
           * 명령형 검사였다). 가리키는 세션이 사라지거나 보관되면 없는 것으로 친다 —
           * 링크가 끊긴 상태를 매니저 없음으로 읽는 쪽이, 유령을 붙드는 쪽보다 안전하다.
           *
           * baseBranch가 같이 사는 이유: 줄기는 매니저의 성질이고 매니저는 프로젝트당
           * 하나라, 둘은 같은 자리에 산다. 이 값이 세 질문의 답을 한 번에 고정한다 —
           * 어디서 갈라지는가, 어디로 병합하는가, 무엇을 기준으로 병합됐다고 하는가.
           */
          const cols = this.db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'worktree_manager')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN worktree_manager TEXT`)
          }
        },
      },
    ]

    for (const step of steps) {
      if (current < step.to) {
        step.run()
        this.db.pragma(`user_version = ${step.to}`)
        this.migrationsRun += 1
      }
    }
  }

  /**
   * v21: 델타 시절의 행들을 메시지로 합친다 (#66).
   *
   * 쓰기는 이미 메시지 단위로 바뀌었지만(persistMessage), 그 전에 쌓인 행들은
   * **토큰 하나가 행 하나**다. 읽기가 병합해 주므로 동작에는 문제가 없었고,
   * 그래서 이 이사는 급한 일이 아니라 **미룰 수 있는 일**이었다 — 크기와 검색을 위한 것이다.
   * (실측: 한 세션이 시간당 32,698행 → 761행, 행당 2.1자 → 222자)
   *
   * 규칙은 읽기(loadMessages)와 **같아야 한다**: 연속된 assistant의 text끼리,
   * reasoning끼리만 잇는다. 다르면 이사 전후로 대화가 달라 보인다.
   *
   * 합친 자리의 seq는 **첫 조각의 것**을 남긴다 — 읽음 위치(last_read_seq)와
   * fresh_start 경계가 전부 숫자 비교라, 중간 seq가 사라져 구멍이 생겨도 안전하다.
   * 반대로 마지막 seq를 남기면 "안 읽음"이 되살아난다.
   *
   * 색인은 통째로 다시 만든다 (v11과 같은 이유: 행이 지워지면 rowid에 못 박힌
   * 색인이 엉뚱한 곳을 가리킨다). VACUUM은 트랜잭션 밖에서 부른다.
   */
  private mergeDeltaRows(): void {
    const before = this.db.prepare(`SELECT COUNT(*) as n FROM messages`).get() as { n: number }
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT rowid, session_id, seq, role, kind, payload FROM messages ORDER BY session_id, seq`)
        .all() as { rowid: number; session_id: string; seq: number; role: string; kind: string; payload: string }[]

      const update = this.db.prepare(`UPDATE messages SET payload = ?, ts = ? WHERE rowid = ?`)
      const del = this.db.prepare(`DELETE FROM messages WHERE rowid = ?`)

      /** 지금 이어붙이는 중인 런 — 첫 조각의 행에 본문을 모은다 */
      let head: { rowid: number; sessionId: string; kind: string; payload: Record<string, unknown>; text: string } | null = null
      let lastTs = 0
      const closeRun = () => {
        if (!head) return
        update.run(JSON.stringify({ ...head.payload, text: head.text }), lastTs, head.rowid)
        head = null
      }

      for (const r of rows) {
        const streaming = r.role === 'assistant' && (r.kind === 'text' || r.kind === 'reasoning')
        if (!streaming) {
          closeRun()
          continue
        }
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(r.payload) as Record<string, unknown>
        } catch {
          closeRun() // 못 읽는 행은 건드리지 않는다 — 합치려다 잃는 것보다 남기는 편이 낫다
          continue
        }
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (head && head.sessionId === r.session_id && head.kind === r.kind) {
          head.text += text
          lastTs = Date.now()
          del.run(r.rowid)
        } else {
          closeRun()
          head = { rowid: r.rowid, sessionId: r.session_id, kind: r.kind, payload, text }
          lastTs = Date.now()
        }
      }
      closeRun()

      // 색인 재구축 (v11과 같은 방식) — 지워진 행이 남긴 자리를 걷는다
      this.db.exec(`DROP TABLE IF EXISTS messages_fts`)
      this.db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
        );
      `)
      const fresh = this.db
        .prepare(`SELECT rowid, session_id, seq, payload FROM messages`)
        .all() as { rowid: number; session_id: string; seq: number; payload: string }[]
      const insert = this.db.prepare(`INSERT INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`)
      for (const r of fresh) {
        const body = extractText(r.payload)
        if (body) insert.run(r.rowid, body, r.session_id, r.seq)
      }
    })
    tx()
    const after = this.db.prepare(`SELECT COUNT(*) as n FROM messages`).get() as { n: number }
    if (after.n < before.n) {
      /*
       * stderr, not stdout. The host tees **stderr** to `~/.centralu/host.log`
       * (`teeStderrToFile`); a `.app` launched from Finder has no stdout anywhere, so a
       * `console.log` here reaches nobody. This line was written with `console.log` and
       * was duly lost — the v21 migration ran on the real store, rewrote 349,825 rows
       * into 57,709, and left no trace of having run. The one irreversible thing this
       * process does was also the one thing it did silently.
       */
      console.error(`[store] merged streaming rows into messages: ${before.n} -> ${after.n} rows`)
      this.db.exec('VACUUM') // 지운 자리는 SQLite가 알아서 돌려주지 않는다 (v11 주석)
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
              verbosity     TEXT,
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
    this.checkpoint()
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

  /**
   * `commands` is deliberately not in here (issue #44) — `projectCommands` answers that one.
   *
   * The column holds JSON, so it needs decoding, and every caller of this method wants a
   * path or a name. Leaving it out of the row type means the omission is stated rather than
   * silently cast away, which is how `Omit<ProjectInfo, 'git'>` would have become a lie the
   * moment the field was added.
   */
  listProjects(): Omit<ProjectInfo, 'git' | 'commands'>[] {
    return this.db
      .prepare(`SELECT id, path, name, default_tool as defaultTool, default_model as defaultModel, default_effort as defaultEffort FROM projects ORDER BY sidebar_order, created_at`)
      .all() as Omit<ProjectInfo, 'git' | 'commands'>[]
  }

  /**
   * The shell commands saved on a project (issue #44).
   *
   * Unreadable JSON reads as "none". A row that somehow got corrupted must not take the
   * project list — and with it the sidebar — down with it; the worst it can cost is a menu
   * you have to fill in again.
   */
  projectCommands(projectId: string): string[] {
    const row = this.db.prepare(`SELECT commands FROM projects WHERE id = ?`).get(projectId) as
      | { commands: string }
      | undefined
    if (!row) return []
    try {
      const parsed = JSON.parse(row.commands) as unknown
      return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : []
    } catch {
      return []
    }
  }

  /** The whole list at once — add and delete both arrive here as "it looks like this now" */
  setProjectCommands(projectId: string, commands: readonly string[]): void {
    this.db.prepare(`UPDATE projects SET commands = ? WHERE id = ?`).run(JSON.stringify(commands), projectId)
  }

  /**
   * 워크트리 프로비저닝 설정 (#69). null이면 아무것도 안 돈다 — 강제하지 않는다.
   * projectCommands와 같은 규칙: 통째로 읽고 통째로 쓴다.
   */
  worktreeSetup(projectId: string): { command: string; copyFiles: string[] } | null {
    const row = this.db.prepare(`SELECT worktree_setup FROM projects WHERE id = ?`).get(projectId) as
      | { worktree_setup: string | null }
      | undefined
    if (!row?.worktree_setup) return null
    try {
      const parsed = JSON.parse(row.worktree_setup) as { command?: unknown; copyFiles?: unknown }
      const command = typeof parsed.command === 'string' ? parsed.command : ''
      const copyFiles = Array.isArray(parsed.copyFiles)
        ? parsed.copyFiles.filter((f): f is string => typeof f === 'string')
        : []
      if (!command && copyFiles.length === 0) return null
      return { command, copyFiles }
    } catch {
      return null
    }
  }

  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): void {
    this.db
      .prepare(`UPDATE projects SET worktree_setup = ? WHERE id = ?`)
      .run(setup ? JSON.stringify(setup) : null, projectId)
  }

  /**
   * 이 프로젝트의 워크트리 매니저 자리와 줄기 (#76).
   *
   * **가리키는 세션이 실제로 있는지는 여기서 보지 않는다** — 그건 세션을 아는 쪽
   * (SessionManager)의 일이고, 저장소는 자기가 적어 둔 것을 그대로 돌려준다.
   * 링크가 끊긴 상태(세션 삭제·보관)의 판정을 두 곳에 두면 서로 다른 답을 낸다.
   */
  worktreeManager(projectId: string): { sessionId: string; baseBranch: string } | null {
    const row = this.db.prepare(`SELECT worktree_manager FROM projects WHERE id = ?`).get(projectId) as
      | { worktree_manager: string | null }
      | undefined
    if (!row?.worktree_manager) return null
    try {
      const parsed = JSON.parse(row.worktree_manager) as { sessionId?: unknown; baseBranch?: unknown }
      if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null
      return { sessionId: parsed.sessionId, baseBranch: typeof parsed.baseBranch === 'string' ? parsed.baseBranch : '' }
    } catch {
      return null
    }
  }

  setWorktreeManager(projectId: string, manager: { sessionId: string; baseBranch: string } | null): void {
    this.db
      .prepare(`UPDATE projects SET worktree_manager = ? WHERE id = ?`)
      .run(manager ? JSON.stringify(manager) : null, projectId)
  }

  /**
   * The tool a new session in this project starts on.
   *
   * Written when a session is created with an explicit tool, not from a settings screen:
   * the column was set to 'claude' at project creation and never updated again, so a Codex
   * user re-picked the pill on every single new session, forever.
   */
  setProjectDefaultTool(projectId: string, tool: string): void {
    this.db.prepare(`UPDATE projects SET default_tool = ? WHERE id = ?`).run(tool, projectId)
  }

  /** 마지막으로 고른 모델·강도가 기본값이 된다 (#69 ⑤) — default_tool과 같은 규칙 */
  setProjectDefaultModel(projectId: string, model: string | null, effort: string | null): void {
    this.db
      .prepare(`UPDATE projects SET default_model = ?, default_effort = ? WHERE id = ?`)
      .run(model, effort, projectId)
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
        `INSERT INTO sessions (id, project_id, tool, external_id, name, auto_named, state, archived, is_orchestrator, last_read_seq, waiting_since, created_at, model, effort, verbosity, service_tier, permission_preset, imported_from, worktree_path, worktree_branch, worktree_base, parent_session_id, context_used, context_window, context_exactness)
         VALUES (@id, @projectId, @tool, @externalId, @name, @autoNamed, @state, @archived, @isOrchestrator, @lastReadSeq, @waitingSince, @createdAt, @model, @effort, @verbosity, @serviceTier, @permissionPreset, @importedFrom, @worktreePath, @worktreeBranch, @worktreeBase, @parentSessionId, @contextUsed, @contextWindow, @contextExactness)
         ON CONFLICT(id) DO UPDATE SET
           tool = excluded.tool,
           external_id = excluded.external_id, name = excluded.name, auto_named = excluded.auto_named,
           state = excluded.state, archived = excluded.archived, last_read_seq = excluded.last_read_seq,
           is_orchestrator = excluded.is_orchestrator,
           waiting_since = excluded.waiting_since, model = excluded.model, effort = excluded.effort,
           verbosity = excluded.verbosity,
           service_tier = excluded.service_tier,
           permission_preset = excluded.permission_preset, imported_from = excluded.imported_from,
           worktree_path = excluded.worktree_path, worktree_branch = excluded.worktree_branch,
           worktree_base = excluded.worktree_base,
           parent_session_id = excluded.parent_session_id,
           context_used = excluded.context_used, context_window = excluded.context_window,
           context_exactness = excluded.context_exactness`,
      )
      .run({
        ...s,
        autoNamed: s.autoNamed ? 1 : 0,
        // 표식(#13)도 보통의 upsert에 실려 다닌다 — 쓰는 길이 둘이면 한쪽만 고쳐진다
        isOrchestrator: s.kind === 'orchestrator' ? 1 : 0,
        archived: s.archived ? 1 : 0,
        effort: s.effort ?? null,
        verbosity: s.verbosity ?? null,
        serviceTier: s.serviceTier ?? null,
        importedFrom: s.importedFrom ?? null,
        worktreePath: s.worktree?.path ?? null,
        worktreeBranch: s.worktree?.branch ?? null,
        worktreeBase: s.worktree?.base ?? null,
        parentSessionId: s.parentSessionId ?? null,
        /*
         * Context rides the ordinary upsert (issue #48), which the manager already runs after
         * every event — so a reading is on disk the instant it arrives, with no second write
         * path to remember. Saving at session close instead would lose exactly the sessions
         * that matter: the ones a crash or a force-quit ends.
         */
        contextUsed: s.context?.used ?? null,
        contextWindow: s.context?.window ?? null,
        contextExactness: s.context?.exactness ?? null,
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
      this.db.prepare(`SELECT session_id FROM grid_panels ORDER BY position`).all() as {
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
    const del = this.db.prepare(`DELETE FROM grid_panels`)
    const ins = this.db.prepare(`INSERT INTO grid_panels (session_id, position) VALUES (?, ?)`)
    this.db.transaction(() => {
      del.run()
      sessionIds.forEach((id, i) => ins.run(id, i))
    })()
  }

  /**
   * **중앙** 오케스트레이터의 id (없으면 null).
   *
   * 예전에는 "오케스트레이터는 앱에 하나"여서 이 질의가 곧 전부였다. 프로젝트
   * 오케스트레이터(#13)가 생기면서 표식(is_orchestrator=1)은 여럿일 수 있고,
   * 그중 프로젝트가 없는 것이 중앙이다. 표식 자체는 SessionInfo.kind에 실려
   * 보통의 upsert로 다닌다 — 한때 "두 곳에 두면 한쪽만 고쳐진다"며 여기서만
   * 답했는데, 프로젝트 오케스트레이터가 그 전제(projectId=null과 같은 사실)를
   * 깨뜨렸으므로 이제 kind가 유일한 사실이고 이 질의는 그걸 읽을 뿐이다.
   */
  orchestratorId(): string | null {
    const row = this.db
      .prepare(`SELECT id FROM sessions WHERE is_orchestrator = 1 AND project_id IS NULL LIMIT 1`)
      .get() as { id: string } | undefined
    return row?.id ?? null
  }

  listSessions(): SessionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.project_id as projectId, s.tool, s.external_id as externalId, s.name,
                s.auto_named as autoNamed, s.state, s.archived, s.is_orchestrator as isOrchestrator,
                s.last_read_seq as lastReadSeq,
                s.waiting_since as waitingSince, s.created_at as createdAt,
                s.model, s.effort, s.verbosity, s.service_tier as serviceTier, s.permission_preset as permissionPreset, s.imported_from as importedFrom,
                s.worktree_path as worktreePath, s.worktree_branch as worktreeBranch,
                s.worktree_base as worktreeBase,
                s.parent_session_id as parentSessionId,
                s.context_used as contextUsed, s.context_window as contextWindow,
                s.context_exactness as contextExactness,
                COALESCE((SELECT MAX(seq) FROM messages m WHERE m.session_id = s.id), 0) as lastSeq
         FROM sessions s ORDER BY s.sidebar_order, s.created_at`,
      )
      .all() as (Omit<SessionInfo, 'autoNamed' | 'archived' | 'worktree' | 'kind'> & {
      autoNamed: number
      archived: number
      isOrchestrator: number
      worktreePath: string | null
      worktreeBranch: string | null
      worktreeBase: string | null
      contextUsed: number | null
      contextWindow: number | null
      contextExactness: string | null
    })[]
    // 살아-있는-동안 필드는 DB에 없다 — 복원된 세션에는 정의상 없는 것이 맞다 (host가 죽으면 함께 죽는 사실들)
    return rows.map(({ worktreePath, worktreeBranch, worktreeBase, contextUsed, contextWindow, contextExactness, isOrchestrator, ...r }) => ({
      ...r,
      autoNamed: !!r.autoNamed,
      archived: !!r.archived,
      kind: isOrchestrator ? ('orchestrator' as const) : ('worker' as const),
      live: false,
      worktree: worktreePath
        ? { path: worktreePath, branch: worktreeBranch ?? '', ...(worktreeBase ? { base: worktreeBase } : {}) }
        : null,
      ...sessionLiveDefaults(),
      /*
       * **Context is the one that comes back** (issue #48), so it overrules the defaults above.
       *
       * The rest of that group are facts about *our* process — a request id nobody can answer
       * any more, a rate-limit window that expired while we were gone — and are rightly gone
       * with it. How full the context is, is not: it is a fact about the conversation, and the
       * conversation is the tool's and outlives us.
       *
       * It is shown plainly, with no staleness mark, and that is a decision rather than an
       * omission. The gauge has never claimed to be live — the reading arrives at the end of a
       * turn and is already a turn behind while the next one runs; restarting only lengthens a
       * gap that is always there. The event that really makes it wrong is the conversation
       * moving without us (someone continuing it in the terminal), which can happen with or
       * without a restart and which we cannot detect either way. A mark keyed on "we
       * restarted" would therefore flag the common case, where nothing moved and the number is
       * exact, and stay silent in the case that actually earns it. The first turn corrects it
       * regardless — at the very instant the old behaviour would have shown anything at all.
       */
      context:
        contextUsed !== null && contextWindow !== null
          ? {
              used: contextUsed,
              window: contextWindow,
              // Only the adapter can claim 'exact'; anything we cannot read back says 'estimate'
              exactness: contextExactness === 'exact' ? ('exact' as const) : ('estimate' as const),
            }
          : null,
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
   * 프로젝트를 완전히 지운다 — 세션·대화·색인·규칙·귀속까지.
   *
   * **FK의 CASCADE에 기대지 않는다.** `sessions.project_id`에는 걸려 있지만 messages는
   * 세션을 타고 두 다리 건너이고, `messages_fts`는 가상 테이블이라 외래키 자체가 없다.
   * 그대로 두면 지운 프로젝트의 말이 검색에 계속 나온다 — 지운 것이 안 지워진 자리다.
   * 그래서 세션마다 deleteSession을 거친다: 한 세션을 없애는 규칙이 한 곳에만 있어야
   * 다음에 테이블이 하나 더 늘어도 고칠 곳이 한 곳이다.
   *
   * project_id를 들고 있는 나머지 셋(approval_rules·usage_facts·commit_sessions)도 같이
   * 간다. usage_facts는 날짜별 집계라 아깝지만, 지운 프로젝트의 이름이 사용량 화면에
   * 남아 있는 쪽이 더 이상하다.
   *
   * 한 덩어리로 돈다 — 중간에 끊기면 세션 없는 프로젝트나 프로젝트 없는 세션이 남는다.
   */
  deleteProject(projectId: string): void {
    const tx = this.db.transaction(() => {
      const ids = this.db.prepare(`SELECT id FROM sessions WHERE project_id = ?`).all(projectId) as {
        id: string
      }[]
      for (const { id } of ids) {
        this.db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`).run(id)
        this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id)
        this.db.prepare(`DELETE FROM approval_rules WHERE session_id = ?`).run(id)
        this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
      }
      this.db.prepare(`DELETE FROM approval_rules WHERE project_id = ?`).run(projectId)
      this.db.prepare(`DELETE FROM usage_facts WHERE project_id = ?`).run(projectId)
      this.db.prepare(`DELETE FROM commit_sessions WHERE project_id = ?`).run(projectId)
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId)
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

  /**
   * The directory this session was created in — the one its tool-side history is filed under.
   *
   * Deliberately **not** part of `SessionInfo`: it is not something the screen shows, and
   * `upsertSession` must never carry it. The whole point (issue #28) is that this value is
   * written once and then left alone; routing it through the same upsert that saves names and
   * states would let any later save quietly replace it with whatever the caller happened to
   * hold. `touched_paths` lives on the same terms.
   *
   * null means "we do not know yet" — an orchestrator row that predates v14. The manager
   * resolves it the first time it needs the path and writes it back.
   */
  sessionCwd(sessionId: string): string | null {
    const row = this.db.prepare(`SELECT cwd FROM sessions WHERE id = ?`).get(sessionId) as
      | { cwd: string | null }
      | undefined
    return row?.cwd ?? null
  }

  setSessionCwd(sessionId: string, cwd: string): void {
    this.db.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`).run(cwd, sessionId)
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

  /**
   * 대화를 읽는다 — **limit은 행이 아니라 메시지 개수다** (#66).
   *
   * 예전 데이터는 스트리밍 델타 하나가 행 하나라, 행으로 세면 한 페이지가
   * 토큰 200개 = 두어 문장이었다. 세션을 열면 답변 꼬리 토막만 보였고,
   * 위로 스크롤하면 한 세션에 52번을 되읽었다 (#64의 방아쇠).
   *
   * 그래서 여기서 연속된 assistant 조각(text·reasoning)을 한 메시지로 합친 뒤에
   * 센다. 새 데이터는 이미 메시지 하나가 행 하나라 병합이 그대로 통과한다 —
   * 두 형식이 섞여 있어도(마이그레이션 전) 같은 모양이 나온다.
   *
   * 합친 메시지의 seq는 **첫 조각의 seq**다. beforeSeq 커서가 그 seq로 돌아오면
   * 그 앞부터 이어 읽으므로 페이지 경계에서 같은 조각을 두 번 주지 않는다.
   * ts는 마지막 조각의 것 — "언제까지 말했나"가 목록 정렬에 쓰인다.
   */
  loadMessages(sessionId: string, limit = 200, beforeSeq?: number): StoredMessage[] {
    const stmt = this.db.prepare(
      `SELECT session_id as sessionId, seq, role, kind, payload, ts FROM messages
       WHERE session_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
    )
    // 최신부터 병합해 내려간다. limit+1개가 모이면 limit번째 메시지의 경계가
    // 확정된 것이다 — 조각이 배치 경계에 걸쳐 있어도 잘리지 않는다.
    const merged: StoredMessage[] = []
    let cursor: number | null = beforeSeq ?? null
    const BATCH = 400
    outer: for (;;) {
      const raw = stmt.all(sessionId, cursor, cursor, BATCH) as (StoredMessage & { payload: string })[]
      if (raw.length === 0) break
      for (const r of raw) {
        const row: StoredMessage = { ...r, payload: JSON.parse(r.payload) }
        const oldest = merged[merged.length - 1]
        if (oldest && continuesRun(row, oldest)) {
          // row가 더 오래된 조각이다 — 앞에 이어 붙인다
          const head = (row.payload as { text?: string }).text ?? ''
          const tail = (oldest.payload as { text?: string }).text ?? ''
          oldest.payload = { ...(oldest.payload as object), text: head + tail }
          oldest.seq = row.seq
        } else {
          merged.push(row)
          if (merged.length > limit) break outer
        }
      }
      cursor = raw[raw.length - 1]!.seq
      if (raw.length < BATCH) break
    }
    return merged.slice(0, limit).reverse()
  }

  /**
   * afterSeq **뒤의** 대화 — loadMessages의 앞으로 가는 짝 (#66).
   * recall이 준 자리의 "다음에 무슨 말이 오갔나"를 읽을 때 쓴다. 같은 병합 규칙.
   */
  loadMessagesFrom(sessionId: string, afterSeq: number, limit = 20): StoredMessage[] {
    const stmt = this.db.prepare(
      `SELECT session_id as sessionId, seq, role, kind, payload, ts FROM messages
       WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    const merged: StoredMessage[] = []
    let cursor = afterSeq
    const BATCH = 400
    outer: for (;;) {
      const raw = stmt.all(sessionId, cursor, BATCH) as (StoredMessage & { payload: string })[]
      if (raw.length === 0) break
      for (const r of raw) {
        const row: StoredMessage = { ...r, payload: JSON.parse(r.payload) }
        const newest = merged[merged.length - 1]
        if (newest && continuesRun(newest, row)) {
          const head = (newest.payload as { text?: string }).text ?? ''
          const tail = (row.payload as { text?: string }).text ?? ''
          newest.payload = { ...(newest.payload as object), text: head + tail }
          newest.ts = row.ts // 마지막 조각의 시각
        } else {
          merged.push(row)
          if (merged.length > limit) break outer
        }
      }
      cursor = raw[raw.length - 1]!.seq
      if (raw.length < BATCH) break
    }
    return merged.slice(0, limit)
  }

  /**
   * 스트리밍 중의 행 갱신 — **색인은 건드리지 않는다** (#66).
   *
   * 자라는 본문을 델타마다 trigram으로 다시 색인하면 메시지 길이의 제곱이 된다.
   * 스트림이 닫힐 때 appendMessages가 한 번 색인한다 (turn_complete 경계).
   */
  upsertMessageNoIndex(m: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET role = excluded.role, kind = excluded.kind,
           payload = excluded.payload, ts = excluded.ts`,
      )
      .run(m.sessionId, m.seq, m.role, m.kind, JSON.stringify(m.payload), m.ts)
  }

  /** 스킬 목록을 남긴다 (도구+디렉토리 단위) */
  /** 커밋 귀속 기록 (#50) — 저장소가 아니라 여기에만 남는다 */
  recordCommit(projectId: string, sha: string, sessionId: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO commit_sessions (project_id, sha, session_id, ts) VALUES (?, ?, ?, ?)`)
      .run(projectId, sha, sessionId, Date.now())
  }

  commitSessions(projectId: string): { sha: string; sessionId: string }[] {
    return this.db
      .prepare(`SELECT sha, session_id AS sessionId FROM commit_sessions WHERE project_id = ?`)
      .all(projectId) as { sha: string; sessionId: string }[]
  }

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

  /**
   * A setting that belongs to this install rather than to any project or session (#43).
   *
   * `null` means never written, which is deliberately distinguishable from a stored
   * `'false'`: it is what lets a default move later without silently overruling the one
   * person who had turned the thing off (the same trade `showIgnored` makes in the UI).
   */
  appSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setAppSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
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
/**
 * older가 newer의 같은 메시지 조각인가 (#66) — UI의 messagesToChat과 같은 규칙:
 * assistant의 text끼리, reasoning끼리만 잇는다. 사람의 말(role=user)은 잇지 않는다.
 */
function continuesRun(older: StoredMessage, newer: StoredMessage): boolean {
  if (older.kind !== newer.kind || older.role !== newer.role) return false
  if (older.role !== 'assistant') return false
  return older.kind === 'text' || older.kind === 'reasoning'
}

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
