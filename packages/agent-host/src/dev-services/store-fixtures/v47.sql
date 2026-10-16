-- A v47 store, written through the Store API of the build that had v47 as its newest step.
-- Generated once (#845); never edited by hand.
CREATE TABLE projects (
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
, commands TEXT NOT NULL DEFAULT '[]', worktree_setup TEXT, worktree_manager TEXT, trusted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (
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
, touched_paths TEXT NOT NULL DEFAULT '[]', model TEXT, permission_preset TEXT NOT NULL DEFAULT 'normal', imported_from TEXT, effort TEXT, sidebar_order INTEGER NOT NULL DEFAULT 0, worktree_path TEXT, worktree_branch TEXT, cwd TEXT, context_used INTEGER, context_window INTEGER, context_exactness TEXT, verbosity TEXT, service_tier TEXT, parent_session_id TEXT, worktree_base TEXT, scope_session_ids TEXT, role_append TEXT, app_id TEXT, deleted_at INTEGER, trash TEXT, asked_by_session_id TEXT);
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
CREATE VIRTUAL TABLE messages_fts USING fts5(
          body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
        );
CREATE TABLE app_runs (
              id                TEXT PRIMARY KEY,
              project_id        TEXT,
              app_id            TEXT NOT NULL,
              tool              TEXT NOT NULL,
              caller_kind       TEXT NOT NULL,
              caller_session_id TEXT,
              parent_run_id     TEXT,
              status            TEXT NOT NULL,
              duration_ms       INTEGER,
              args_digest       TEXT NOT NULL,
              args_summary      TEXT NOT NULL,
              error             TEXT,
              created_at        INTEGER NOT NULL
            , kind TEXT NOT NULL DEFAULT 'tool', session_id TEXT, tokens_in INTEGER, tokens_out INTEGER);
CREATE TABLE app_run_failures (
              run_id     TEXT PRIMARY KEY,
              project_id TEXT,
              app_id     TEXT NOT NULL,
              args       TEXT NOT NULL,
              result     TEXT,
              created_at INTEGER NOT NULL
            );
CREATE TABLE app_permissions (
              app_key    TEXT NOT NULL,
              project_id TEXT,
              capability TEXT NOT NULL,
              text       TEXT NOT NULL,
              decision   TEXT NOT NULL,
              uses_stamp TEXT NOT NULL,
              decided_at INTEGER NOT NULL,
              PRIMARY KEY (app_key, capability)
            );
CREATE TABLE subagent_messages (
              session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
              parent_call_id TEXT NOT NULL,
              seq            INTEGER NOT NULL,
              role           TEXT NOT NULL,
              kind           TEXT NOT NULL,
              payload        TEXT NOT NULL,
              ts             INTEGER NOT NULL,
              PRIMARY KEY (session_id, parent_call_id, seq)
            );
CREATE TABLE grid_layout (
                panel_key  TEXT PRIMARY KEY,
                kind       TEXT NOT NULL CHECK (kind IN ('session', 'app')),
                session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                project_id TEXT,
                app_id     TEXT,
                position   INTEGER NOT NULL
              , span_cols INTEGER, span_rows INTEGER, remote_session_id TEXT, remote_app_id TEXT, app_machine TEXT);
CREATE TABLE project_consents (
              from_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              to_project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              kind            TEXT NOT NULL,
              decided_at      INTEGER NOT NULL,
              PRIMARY KEY (from_project_id, to_project_id, kind)
            );
CREATE TABLE linked_machines (
              id                TEXT PRIMARY KEY,
              name              TEXT NOT NULL,
              ssh_target        TEXT NOT NULL,
              shell             TEXT NOT NULL DEFAULT 'posix',
              wsl_distro        TEXT,
              command           TEXT,
              slot              INTEGER NOT NULL UNIQUE,
              added_at          INTEGER NOT NULL,
              accepted_versions TEXT
            );
CREATE TABLE machine_headers (
              machine_id TEXT NOT NULL REFERENCES linked_machines(id) ON DELETE CASCADE,
              kind       TEXT NOT NULL CHECK (kind IN ('session', 'project')),
              item_id    TEXT NOT NULL,
              info       TEXT NOT NULL,
              position   INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (machine_id, kind, item_id)
            );
INSERT INTO "projects" ("id", "path", "name", "default_tool", "default_models", "sidebar_order", "created_at", "commands", "worktree_setup", "worktree_manager", "trusted") VALUES ('p1', '/tmp/p1', 'alpha', 'claude', NULL, 0, 1792168337226, '[]', NULL, NULL, 0);
INSERT INTO "sessions" ("id", "project_id", "tool", "external_id", "name", "auto_named", "state", "is_orchestrator", "last_read_seq", "waiting_since", "created_at", "touched_paths", "model", "permission_preset", "imported_from", "effort", "sidebar_order", "worktree_path", "worktree_branch", "cwd", "context_used", "context_window", "context_exactness", "verbosity", "service_tier", "parent_session_id", "worktree_base", "scope_session_ids", "role_append", "app_id", "deleted_at", "trash", "asked_by_session_id") VALUES ('s1', 'p1', 'claude', 'ext-s1', 'seeded at v47', 0, 'idle', 0, 2, NULL, 1700000000000, '[]', 'opus', 'normal', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "sessions" ("id", "project_id", "tool", "external_id", "name", "auto_named", "state", "is_orchestrator", "last_read_seq", "waiting_since", "created_at", "touched_paths", "model", "permission_preset", "imported_from", "effort", "sidebar_order", "worktree_path", "worktree_branch", "cwd", "context_used", "context_window", "context_exactness", "verbosity", "service_tier", "parent_session_id", "worktree_base", "scope_session_ids", "role_append", "app_id", "deleted_at", "trash", "asked_by_session_id") VALUES ('s2', 'p1', 'claude', 'ext-s2', 'second', 0, 'idle', 0, 0, NULL, 1700000000000, '[]', 'opus', 'normal', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "messages" ("session_id", "seq", "role", "kind", "payload", "ts") VALUES ('s1', 1, 'user', 'text', '{"type":"user_message","sessionId":"s1","text":"find the galaxy colour policy"}', 1700000000000);
INSERT INTO "messages" ("session_id", "seq", "role", "kind", "payload", "ts") VALUES ('s1', 2, 'assistant', 'text', '{"type":"message_delta","sessionId":"s1","role":"assistant","text":"the galaxy colour policy lives in docs"}', 1700000000001);
INSERT INTO "messages" ("session_id", "seq", "role", "kind", "payload", "ts") VALUES ('s1', 3, 'system', 'tool_call', '{"type":"tool_call","sessionId":"s1","callId":"c1","summary":{"tool":"Read","title":"Read: docs/colour.md","paths":["docs/colour.md"]}}', 1700000000002);
INSERT INTO "messages" ("session_id", "seq", "role", "kind", "payload", "ts") VALUES ('s1', 4, 'system', 'tool_result', '{"type":"tool_result","sessionId":"s1","callId":"c1","ok":true,"summary":"nebula purple is the default"}', 1700000000003);
INSERT INTO "messages" ("session_id", "seq", "role", "kind", "payload", "ts") VALUES ('s1', 5, 'assistant', 'text', '{"type":"message_delta","sessionId":"s1","role":"assistant","text":"done reading"}', 1700000000004);
INSERT INTO "messages" ("session_id", "seq", "role", "kind", "payload", "ts") VALUES ('s2', 1, 'user', 'text', '{"type":"user_message","sessionId":"s2","text":"hello second"}', 1700000000000);
INSERT INTO "approval_rules" ("id", "scope", "project_id", "session_id", "matcher", "decision", "created_at") VALUES (1, 'project', 'p1', NULL, 'npm test', 'allow', 1792168337227);
INSERT INTO "app_settings" ("key", "value") VALUES ('min_reader_version', '32');
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (1, 'find the galaxy colour policy', 's1', 1);
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (2, 'the galaxy colour policy lives in docs', 's1', 2);
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (5, 'done reading', 's1', 5);
INSERT INTO "messages_fts" ("rowid", "body", "session_id", "seq") VALUES (6, 'hello second', 's2', 1);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_app_runs_app ON app_runs(app_id, project_id, created_at);
CREATE INDEX idx_app_runs_parent ON app_runs(parent_run_id);
PRAGMA user_version = 47;
