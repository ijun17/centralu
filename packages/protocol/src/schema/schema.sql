-- Centralu 로컬 저장 스키마 v1
-- host(better-sqlite3)가 읽는다. 마이그레이션은 dev-services/store.ts의 steps가 담당한다.
--
-- **여기서 user_version을 정하지 않는다.** 이 파일은 열 때마다 실행되므로(테이블은
-- CREATE IF NOT EXISTS라 안전하다), `PRAGMA user_version = 1`이 있으면 이미 v27인 DB도
-- 매번 1로 되돌아가 마이그레이션 26개가 **전부 다시 돌았다**. 실측(2026-09-02,
-- store.db 94MB · 메시지 66,700건): 열 때마다 4.4~5.0초, 그중 v3 1.4초 + v11 1.7초 +
-- v21 1.7초가 전부 전체 테이블 스캔이었다 — 대화가 쌓일수록 커지는 시작 비용이다.
--
-- 값을 아예 안 적으면 새 DB는 0에서 시작해 스텝이 한 번 전부 돌고(예전과 같다),
-- 기존 DB는 마지막 스텝이 적어둔 번호를 그대로 들고 있어 아무것도 다시 돌지 않는다.

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  default_tool  TEXT NOT NULL DEFAULT 'claude',
  default_model TEXT,
  sidebar_order INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  -- 오케스트레이터는 프로젝트에 속하지 않는다 (앱에 하나, 프로젝트를 가로지른다).
  -- NOT NULL이면 아무 데나 매달아야 하고 그 프로젝트를 지우면 CASCADE로 함께 죽는다.
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  tool          TEXT NOT NULL,
  external_id   TEXT,
  name          TEXT NOT NULL,
  auto_named    INTEGER NOT NULL DEFAULT 1,
  state         TEXT NOT NULL DEFAULT 'idle',
  is_orchestrator INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  waiting_since INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- "항상 허용" 규칙 (FR-3). scope=session이면 session_id, project면 project_id 사용
CREATE TABLE IF NOT EXISTS approval_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  matcher    TEXT NOT NULL,
  decision   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_facts (
  date       TEXT NOT NULL,
  tool       TEXT NOT NULL,
  model      TEXT NOT NULL,
  project_id TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_est   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, tool, model, project_id)
);

CREATE TABLE IF NOT EXISTS workspace (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  layout     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 커밋 귀속 (#50): 어느 세션이 이 커밋을 만들었나 — 저장소가 아니라 여기에만 남는다.
-- 해시는 에이전트의 git commit 도구 출력에서 주운 것이라 짧을 수 있다 (접두사 매칭).
CREATE TABLE IF NOT EXISTS commit_sessions (
  project_id TEXT NOT NULL,
  sha        TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (project_id, sha)
);
