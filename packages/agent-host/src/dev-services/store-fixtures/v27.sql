-- The v1 store of store-migrations.test.ts, migrated to v27 by the build before the v27 baseline (b1b0d9901, its
-- migration list cut after v27). Generated once (#1143); never edited by hand. The rows go in before the tables they
-- point at are made (v10 rebuilt `sessions`), so foreign keys are off while it loads.
PRAGMA foreign_keys = OFF;
CREATE TABLE projects (
      id            TEXT PRIMARY KEY,
      path          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      default_tool  TEXT NOT NULL DEFAULT 'claude',
      default_model TEXT,
      sidebar_order INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    , commands TEXT NOT NULL DEFAULT '[]', worktree_setup TEXT, default_effort TEXT, worktree_manager TEXT);
CREATE TABLE messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL,
      role       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
CREATE TABLE approval_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scope      TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      matcher    TEXT NOT NULL,
      decision   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
CREATE TABLE usage_facts (
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
CREATE TABLE workspace (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      layout     TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
CREATE TABLE commit_sessions (
  project_id TEXT NOT NULL,
  sha        TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (project_id, sha)
);
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
CREATE TABLE command_cache (
              tool TEXT NOT NULL,
              cwd TEXT NOT NULL,
              commands TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (tool, cwd)
            );
CREATE TABLE grid_panels (
              session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
              position   INTEGER NOT NULL
            );
CREATE TABLE "sessions" (
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
            , cwd TEXT, context_used INTEGER, context_window INTEGER, context_exactness TEXT, service_tier TEXT, parent_session_id TEXT, worktree_base TEXT);
CREATE VIRTUAL TABLE messages_fts USING fts5(
          body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
        );
INSERT INTO "projects" ("rowid", "id", "path", "name", "default_tool", "default_model", "sidebar_order", "created_at", "commands", "worktree_setup", "default_effort", "worktree_manager") VALUES (1, 'p1', '/work/p1', 'one', 'claude', 'opus', 1, 100, '[]', NULL, NULL, NULL);
INSERT INTO "projects" ("rowid", "id", "path", "name", "default_tool", "default_model", "sidebar_order", "created_at", "commands", "worktree_setup", "default_effort", "worktree_manager") VALUES (2, 'p2', '/work/p2', 'two', 'claude', NULL, 0, 200, '[]', NULL, NULL, NULL);
INSERT INTO "messages" ("rowid", "session_id", "seq", "role", "kind", "payload", "ts") VALUES (1, 's1', 1, 'user', 'text', '{"text":"hello there"}', 1);
INSERT INTO "messages" ("rowid", "session_id", "seq", "role", "kind", "payload", "ts") VALUES (2, 's1', 2, 'assistant', 'text', '{"text":"one token per row"}', 4);
INSERT INTO "messages" ("rowid", "session_id", "seq", "role", "kind", "payload", "ts") VALUES (5, 's1', 5, 'assistant', 'reasoning', '{"text":"thinking hard"}', 6);
INSERT INTO "messages" ("rowid", "session_id", "seq", "role", "kind", "payload", "ts") VALUES (7, 's1', 7, 'assistant', 'tool_call', '{"id":"t1","name":"Bash","input":{"command":"ls"}}', 7);
INSERT INTO "messages" ("rowid", "session_id", "seq", "role", "kind", "payload", "ts") VALUES (8, 's1', 8, 'user', 'text', '{"text":"승인을 기다립니다"}', 8);
INSERT INTO "messages" ("rowid", "session_id", "seq", "role", "kind", "payload", "ts") VALUES (9, 's2', 1, 'user', 'text', '{"text":"archived words"}', 9);
INSERT INTO "approval_rules" ("rowid", "id", "scope", "project_id", "session_id", "matcher", "decision", "created_at") VALUES (1, 1, 'project', 'p1', NULL, 'Bash(ls)', 'allow', 10);
INSERT INTO "approval_rules" ("rowid", "id", "scope", "project_id", "session_id", "matcher", "decision", "created_at") VALUES (2, 2, 'session', NULL, 's1', 'Bash(rm *)', 'deny', 11);
INSERT INTO "usage_facts" ("rowid", "date", "tool", "model", "project_id", "input_tokens", "output_tokens", "cache_tokens", "cost_est") VALUES (1, '2026-01-01', 'claude', 'opus', 'p1', 5, 6, 0, 0);
INSERT INTO "workspace" ("rowid", "id", "layout", "updated_at") VALUES (1, 1, '{"panes":[]}', 12);
INSERT INTO "app_settings" ("rowid", "key", "value") VALUES (1, 'min_reader_version', '13');
INSERT INTO "sessions" ("rowid", "id", "project_id", "tool", "external_id", "name", "auto_named", "state", "archived", "is_orchestrator", "last_read_seq", "waiting_since", "created_at", "touched_paths", "model", "effort", "verbosity", "permission_preset", "imported_from", "worktree_path", "worktree_branch", "sidebar_order", "cwd", "context_used", "context_window", "context_exactness", "service_tier", "parent_session_id", "worktree_base") VALUES (1, 's1', 'p1', 'claude', 'ext-1', 'first', 1, 'idle', 0, 0, 2, NULL, 300, '[]', NULL, NULL, NULL, 'normal', NULL, NULL, NULL, 0, '/work/p1', NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "sessions" ("rowid", "id", "project_id", "tool", "external_id", "name", "auto_named", "state", "archived", "is_orchestrator", "last_read_seq", "waiting_since", "created_at", "touched_paths", "model", "effort", "verbosity", "permission_preset", "imported_from", "worktree_path", "worktree_branch", "sidebar_order", "cwd", "context_used", "context_window", "context_exactness", "service_tier", "parent_session_id", "worktree_base") VALUES (2, 's2', 'p1', 'codex', NULL, 'archived one', 0, 'idle', 1, 0, 0, NULL, 400, '[]', NULL, NULL, NULL, 'normal', NULL, NULL, NULL, 0, '/work/p1', NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "sessions" ("rowid", "id", "project_id", "tool", "external_id", "name", "auto_named", "state", "archived", "is_orchestrator", "last_read_seq", "waiting_since", "created_at", "touched_paths", "model", "effort", "verbosity", "permission_preset", "imported_from", "worktree_path", "worktree_branch", "sidebar_order", "cwd", "context_used", "context_window", "context_exactness", "service_tier", "parent_session_id", "worktree_base") VALUES (3, 'orc', 'p2', 'claude', NULL, 'orchestrator', 0, 'idle', 0, 0, 0, NULL, 500, '[]', NULL, NULL, NULL, 'normal', NULL, NULL, NULL, 0, '/work/p2', NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (1, 'hello there', 's1', 1);
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (2, 'one token per row', 's1', 2);
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (5, 'thinking hard', 's1', 5);
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (8, '승인을 기다립니다', 's1', 8);
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (9, 'archived words', 's2', 1);
CREATE INDEX idx_sessions_project ON sessions(project_id, archived);
PRAGMA foreign_keys = ON;
PRAGMA user_version = 27;
