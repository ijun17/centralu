-- Control Center 로컬 저장 스키마 v1
-- dev(better-sqlite3)와 prod(rusqlite)가 이 파일을 공유한다 (docs/agent-host.md §5)
PRAGMA user_version = 1;

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
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool          TEXT NOT NULL,
  external_id   TEXT,
  name          TEXT NOT NULL,
  auto_named    INTEGER NOT NULL DEFAULT 1,
  state         TEXT NOT NULL DEFAULT 'idle',
  archived      INTEGER NOT NULL DEFAULT 0,
  is_orchestrator INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  waiting_since INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, archived);

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
