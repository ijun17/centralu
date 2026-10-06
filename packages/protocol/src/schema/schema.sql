-- Centralu local storage schema v1
-- Read by the host (better-sqlite3). Migrations are handled by the steps in dev-services/store.ts.
--
-- **user_version is never set here.** This file runs every time the database is opened (safe,
-- since every table uses CREATE IF NOT EXISTS), so if `PRAGMA user_version = 1` were here, a
-- database already at v27 would reset to 1 on every open and **rerun all 26 migrations**.
-- Measured (2026-09-02, store.db at 94MB, 66,700 messages): 4.4 to 5.0 seconds per open, of
-- which v3 (1.4s), v11 (1.7s) and v21 (1.7s) were each a full table scan — a startup cost that
-- only grows as the conversation history piles up.
--
-- Leaving the value unset entirely means a new database starts at 0 and runs every step once
-- (the same as before), while an existing database keeps whatever number the last step left
-- behind, so nothing reruns.

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  default_tool  TEXT NOT NULL DEFAULT 'claude',
  -- The default model and effort per tool (#107): {"codex":{"model":"gpt-5.6","effort":"high"}, ...}.
  -- This is where the scalars default_model/default_effort used to be — a model name is a tool's
  -- own vocabulary, so remembering a single one with no tool attached meant a session for a
  -- different tool inherited that name and died on its first turn.
  default_models TEXT,
  sidebar_order INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  -- The orchestrator does not belong to any project (one per app, crossing all projects).
  -- Making this NOT NULL would force it to hang off some project, and deleting that project
  -- would kill it too via CASCADE.
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

-- "Always allow" rules (FR-3). Uses session_id when scope=session, project_id when scope=project
CREATE TABLE IF NOT EXISTS approval_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  matcher    TEXT NOT NULL,
  decision   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Unused: a usage aggregate planned for the first milestone and never built (docs/agent-host.md §6); no build has ever
-- written a row. Released builds up to v0.1.0-beta.10 still run `DELETE FROM usage_facts` when a project is deleted.
-- Dropping it is a contract step (docs/agent-host.md §5.1 rule 2: an older copy of this file creates it), so it waits
-- for a release after the first one that no longer touches the table (#372 follow-up).
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

-- Commit attribution (#50): which session made this commit — recorded only here, never in the repository.
-- The hash is picked up from the agent's git commit tool output, so it can be short (matched by prefix).
CREATE TABLE IF NOT EXISTS commit_sessions (
  project_id TEXT NOT NULL,
  sha        TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (project_id, sha)
);
