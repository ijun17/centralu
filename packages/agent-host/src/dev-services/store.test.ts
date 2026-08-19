/** T1-2 완료 기준: 스키마가 실제로 적용되고 CRUD가 도는지 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionInfo } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'

function seeded() {
  const s = new Store()
  s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.upsertSession({
    id: 's1', projectId: 'p1', tool: 'claude', externalId: null, name: '새 세션',
    autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true, model: null, effort: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    ...sessionLiveDefaults(),
  })
  return s
}

/**
 * v10은 테이블을 통째로 다시 만든다 (SQLite는 NOT NULL을 못 푼다).
 * 이 프로젝트에서 가장 위험한 변경이라, **옛 DB에 데이터를 넣고 실제로 올려본다.**
 * 한 줄이라도 조용히 잃으면 되돌릴 방법이 없다.
 */
describe('v10 이관 — 프로젝트 없는 세션을 허용한다', () => {
  it('옛 DB(v9)의 세션·메시지가 그대로 살아 넘어온다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v10-'))
    const file = join(dir, 'store.db')

    // v9 상태의 DB를 손으로 만든다 (project_id NOT NULL)
    const old = new Database(file)
    old.pragma('foreign_keys = ON')
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
        auto_named INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0, is_orchestrator INTEGER NOT NULL DEFAULT 0,
        last_read_seq INTEGER NOT NULL DEFAULT 0, waiting_since INTEGER, created_at INTEGER NOT NULL,
        touched_paths TEXT NOT NULL DEFAULT '[]', model TEXT, effort TEXT,
        permission_preset TEXT NOT NULL DEFAULT 'normal', imported_from TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1)`).run()
    for (const id of ['s1', 's2', 's3']) {
      old.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at) VALUES (?,?,?,?,?)`)
        .run(id, 'p1', 'claude', '이름 ' + id, 1)
      old.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`).run(id, 1, 'user', 'text', '{"text":"안녕"}', 1)
    }
    old.pragma('user_version = 9')
    old.close()

    const store = new Store(file)
    expect(store.schemaVersion).toBe(13)
    expect(store.listSessions().map((x) => x.id).sort()).toEqual(['s1', 's2', 's3'])
    expect(store.listSessions().find((x) => x.id === 's2')?.name).toBe('이름 s2')
    expect(store.loadMessages('s1').length).toBe(1)

    // 그리고 이제 프로젝트 없는 세션이 들어간다
    store.upsertSession({
      id: 'orc', projectId: null, tool: 'claude', externalId: null, name: 'Orchestrator',
      autoNamed: false, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: 1, waitingSince: null, live: true, model: null, effort: null,
      permissionPreset: 'normal', importedFrom: null, worktree: null, ...sessionLiveDefaults(),
    })
    expect(store.listSessions().find((x) => x.id === 'orc')?.projectId).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('Store (dev sqlite)', () => {
  it('최신 스키마까지 마이그레이션된다', () => {
    expect(new Store().schemaVersion).toBe(13)
  })

  it('프로젝트 등록·조회, 경로 중복은 갱신으로 처리', () => {
    const s = seeded()
    s.addProject({ id: 'p1b', path: '/tmp/p1', name: '이름변경' })
    const list = s.listProjects()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('이름변경')
  })

  it('세션 upsert와 목록', () => {
    const s = seeded()
    const before = s.listSessions()[0]!
    expect(before.autoNamed).toBe(true)
    expect(before.archived).toBe(false)
    s.upsertSession({ ...before, name: 'auth 리팩터링', autoNamed: false, state: 'working' })
    const after = s.listSessions()[0]!
    expect(after.name).toBe('auth 리팩터링')
    expect(after.autoNamed).toBe(false)
    expect(after.state).toBe('working')
  })

  /*
   * UPDATE 절에 tool이 빠져 있어서 에이전트 전환(claude→codex)이 저장되지 않았다.
   * 재시작하면 도구는 claude로 되돌아가는데, 전환하면서 이어갈 실마리(external_id)는
   * 이미 끊은 뒤라 되살릴 수도 없는 세션이 됐다.
   */
  it('도구 전환이 저장된다 — 다시 켜도 codex다', () => {
    const s = seeded()
    const before = s.listSessions()[0]!
    s.upsertSession({ ...before, tool: 'codex', externalId: null, importedFrom: null })
    const after = s.listSessions()[0]!
    expect(after.tool).toBe('codex')
    expect(after.externalId).toBeNull()
  })

  it('메시지 append/load와 seq 증가', () => {
    const s = seeded()
    expect(s.nextSeq('s1')).toBe(1)
    s.appendMessages([
      { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: '안녕' }, ts: 1 },
      { sessionId: 's1', seq: 2, role: 'assistant', kind: 'text', payload: { text: '네' }, ts: 2 },
    ])
    expect(s.nextSeq('s1')).toBe(3)
    const msgs = s.loadMessages('s1')
    expect(msgs.map((m) => m.seq)).toEqual([1, 2])
    expect(msgs[0]!.payload).toEqual({ text: '안녕' })
    expect(s.listSessions()[0]!.lastSeq).toBe(2)
  })

  it('페이지네이션: beforeSeq 이전 것만', () => {
    const s = seeded()
    s.appendMessages(
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: 's1', seq: i + 1, role: 'user' as const, kind: 'text' as const, payload: { i }, ts: i,
      })),
    )
    expect(s.loadMessages('s1', 2, 4).map((m) => m.seq)).toEqual([2, 3])
  })

  it('읽음 위치는 뒤로 가지 않는다', () => {
    const s = seeded()
    s.markRead('s1', 5)
    s.markRead('s1', 3)
    expect(s.listSessions()[0]!.lastReadSeq).toBe(5)
  })

  it('승인 규칙 저장·조회', () => {
    const s = seeded()
    s.addApprovalRule({ scope: 'session', sessionId: 's1', matcher: 'npm test*', decision: 'allow' })
    const rules = s.listApprovalRules()
    expect(rules).toHaveLength(1)
    expect(rules[0]!.matcher).toBe('npm test*')
  })
})

describe('마이그레이션 (E-0)', () => {
  it('v1 DB를 열면 새 컬럼·FTS가 추가되고 기존 메시지가 검색된다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-migrate-'))
    const file = join(dir, 'old.db')

    // v1 상태를 손으로 만든다 (touched_paths도 messages_fts도 없는 상태)
    const raw = new Database(file)
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, tool TEXT, external_id TEXT,
        name TEXT, auto_named INTEGER, state TEXT, archived INTEGER, last_read_seq INTEGER,
        waiting_since INTEGER, created_at INTEGER);
      CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, kind TEXT, payload TEXT, ts INTEGER,
        PRIMARY KEY (session_id, seq));
      INSERT INTO sessions VALUES ('s1','p1','claude',NULL,'옛 세션',1,'idle',0,0,NULL,0);
      INSERT INTO messages VALUES ('s1',1,'assistant','text','{"text":"승인을 기다립니다"}',0);
      PRAGMA user_version = 1;
    `)
    raw.close()

    const store = new Store(file)
    expect(store.schemaVersion).toBe(13)

    // 백필이 되어야 예전 대화도 찾을 수 있다
    const hits = store.searchMessages('승인')
    expect(hits.length).toBe(1)
    expect(hits[0]!.sessionId).toBe('s1')

    // 새 컬럼도 쓸 수 있다
    store.setTouchedPaths('s1', ['src/a.ts'])
    expect(store.getTouchedPaths('s1')).toEqual(['src/a.ts'])

    // v4: 모델·권한도 기존 세션에 붙는다 (기본값으로)
    const migrated = store.listSessions().find((s) => s.id === 's1')
    expect(migrated).toMatchObject({ model: null, effort: null, permissionPreset: 'normal', importedFrom: null })

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('한국어 조사가 붙어도 검색된다 (trigram 토크나이저)', () => {
    const s = seeded()
    s.appendMessages([
      { sessionId: 's1', seq: 10, role: 'assistant', kind: 'text', payload: { text: '승인을 기다리는 중입니다' }, ts: 0 },
    ])
    // unicode61이면 '승인'으로 '승인을'을 못 찾는다 — 이게 이 앱에서 실제로 겪을 문제
    expect(s.searchMessages('승인').length).toBe(1)
    expect(s.searchMessages('기다리').length).toBe(1)
    s.close()
  })

  /*
   * 색인이 메시지보다 8.6배 많았다 (실제 DB: 메시지 28,892 · 색인 249,809).
   * messages는 덮어쓰는데 색인은 맨 INSERT라, 같은 자리를 다시 쓸 때마다 한 행씩 쌓였다.
   * recall이 같은 말을 반복해 내놓은 것도, 색인이 본문의 수십 배로 부푼 것도 여기서 나왔다.
   */
  it('같은 메시지를 다시 써도 색인이 늘지 않는다', () => {
    const s = seeded()
    const msg = {
      sessionId: 's1', seq: 10, role: 'assistant' as const, kind: 'text' as const,
      payload: { text: '은하수 그라데이션' }, ts: 0,
    }
    for (let i = 0; i < 5; i++) s.appendMessages([msg])
    expect(s.searchMessages('은하수').length).toBe(1)
    s.close()
  })

  it('내용을 고쳐 쓰면 옛 내용은 검색되지 않는다', () => {
    const s = seeded()
    const at = { sessionId: 's1', seq: 11, role: 'assistant' as const, kind: 'text' as const, ts: 0 }
    s.appendMessages([{ ...at, payload: { text: '옛날내용' } }])
    s.appendMessages([{ ...at, payload: { text: '새내용' } }])
    expect(s.searchMessages('옛날내용').length).toBe(0)
    expect(s.searchMessages('새내용').length).toBe(1)
    s.close()
  })

  it('본문 전체를 돌려준다 — 자르는 일은 부르는 쪽이 한다', () => {
    const s = seeded()
    const long = `${'앞'.repeat(300)}은하수${'뒤'.repeat(300)}`
    s.appendMessages([
      { sessionId: 's1', seq: 12, role: 'assistant', kind: 'text', payload: { text: long }, ts: 0 },
    ])
    // 예전에는 snippet(...,12)로 15자쯤에서 끊겨 무엇인지 가릴 수 없었다
    expect(s.searchMessages('은하수')[0]!.body).toBe(long)
    s.close()
  })
})

describe('마이그레이션 v5 — 이어받은 원본 기록', () => {
  it('imported_from 컬럼이 생기고 왕복한다', () => {
    const store = new Store()
    store.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    const base = {
      id: 's-import', projectId: 'p1', tool: 'claude' as const, externalId: 'ext-new',
      name: '이어받은 대화', autoNamed: true, state: 'idle' as const, archived: false,
      lastReadSeq: 0, lastSeq: 0, createdAt: Date.now(), waitingSince: null, live: true,
      model: null, effort: null, permissionPreset: 'normal' as const, importedFrom: 'ext-old', worktree: null,
      ...sessionLiveDefaults(),
    }
    store.upsertSession(base)
    const back = store.listSessions().find((s) => s.id === 's-import')!
    // resume이 새 식별자를 발급해도 어느 대화에서 왔는지는 남아 있어야 한다
    expect(back.importedFrom).toBe('ext-old')
    expect(back.externalId).toBe('ext-new')
  })
})

/**
 * 추론 강도는 모델과 같은 성질이라 세션과 함께 남아야 한다.
 * 이미 쓰고 있는 DB에 컬럼이 붙는 것이므로 마이그레이션이 실제로 도는지 확인한다.
 */
describe('마이그레이션 v7 — 추론 강도', () => {
  const row = (over: Partial<SessionInfo>): SessionInfo => ({
    id: 's-x', projectId: 'p1', tool: 'claude', externalId: null, name: '세션',
    autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true,
    model: null, effort: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    ...sessionLiveDefaults(),
    ...over,
  })

  it('effort 컬럼이 생기고 왕복한다', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-effort', effort: 'xhigh', model: 'fable' }))
    const back = store.listSessions().find((r) => r.id === 's-effort')
    expect(back?.effort).toBe('xhigh')
    expect(back?.model).toBe('fable')
    store.close()
  })

  it('강도를 안 고른 세션은 null로 남는다 — 빈 문자열과 구분된다', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-none' }))
    expect(store.listSessions().find((r) => r.id === 's-none')?.effort).toBeNull()
    store.close()
  })
})

/**
 * 사이드바 순서는 사람이 정한 것이라 **다시 켜도 그대로여야 한다.**
 * 세션 저장(upsert)이 순서를 덮어쓰지 않는지도 함께 본다 — 대화 한 줄마다
 * upsert가 도는데 거기서 순서가 초기화되면 사람이 정한 것이 계속 흐트러진다.
 */
describe('마이그레이션 v8 — 사이드바 순서', () => {
  it('세션 순서를 저장하고 그 순서로 읽는다', () => {
    const s = seeded()
    for (const id of ['s2', 's3']) {
      s.upsertSession({
        id, projectId: 'p1', tool: 'claude', externalId: null, name: id,
        autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
        createdAt: Date.now(), waitingSince: null, live: true,
        model: null, effort: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
        ...sessionLiveDefaults(),
      })
    }
    s.setSessionOrder(['s3', 's1', 's2'])
    expect(s.listSessions().map((x) => x.id)).toEqual(['s3', 's1', 's2'])
    s.close()
  })

  it('세션을 다시 저장해도 순서가 흐트러지지 않는다', () => {
    const s = seeded()
    s.setSessionOrder(['s1'])
    const before = s.listSessions()[0]!
    s.upsertSession({ ...before, name: 'renamed' })
    expect(s.listSessions().map((x) => x.name)).toEqual(['renamed'])
    s.close()
  })

  it('프로젝트 순서도 저장된다', () => {
    const s = seeded()
    s.addProject({ id: 'p2', path: '/tmp/p2', name: 'p2' })
    s.setProjectOrder(['p2', 'p1'])
    expect(s.listProjects().map((p) => p.id)).toEqual(['p2', 'p1'])
    s.close()
  })
})

/**
 * 그리드 배치는 **껐다 켜도 그대로**여야 한다 — 사람이 짠 화면이기 때문이다.
 * 세션 테이블이 아니라 따로 두었으므로, 세션을 저장해도 배치가 흔들리지 않는지 함께 본다.
 */
describe('마이그레이션 v9 — 그리드 배치', () => {
  it('올려둔 순서대로 돌아온다', () => {
    const s = seeded()
    for (const id of ['s2', 's3']) {
      s.upsertSession({
        id, projectId: 'p1', tool: 'claude', externalId: null, name: id,
        autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
        createdAt: Date.now(), waitingSince: null, live: true,
        model: null, effort: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
        ...sessionLiveDefaults(),
      })
    }
    s.setGridView(['s3', 's1'])
    expect(s.listGridView()).toEqual(['s3', 's1'])
    s.close()
  })

  it('통째로 다시 쓴다 — 추가·제거·순서가 모두 한 가지로 온다', () => {
    const s = seeded()
    s.setGridView(['s1'])
    s.setGridView([])
    expect(s.listGridView()).toEqual([])
    s.close()
  })

  it('세션을 다시 저장해도 배치는 그대로', () => {
    const s = seeded()
    s.setGridView(['s1'])
    const before = s.listSessions()[0]!
    s.upsertSession({ ...before, name: 'renamed' })
    expect(s.listGridView()).toEqual(['s1'])
    s.close()
  })

  it('세션을 지우면 배치에서도 빠진다 — 없는 것을 그리려 하면 안 된다', () => {
    const s = seeded()
    s.setGridView(['s1'])
    s.deleteSession('s1')
    expect(s.listGridView()).toEqual([])
    s.close()
  })
})

describe('오케스트레이터는 하나뿐', () => {
  it('표식이 없으면 null', () => {
    expect(seeded().orchestratorId()).toBeNull()
  })

  it('표식을 옮기면 이전 것은 내려간다 — 둘이 될 수 없다', () => {
    const s = seeded()
    const mk = (id: string) =>
      s.upsertSession({
        id, projectId: null, tool: 'claude', externalId: null, name: id,
        autoNamed: false, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
        createdAt: 1, waitingSince: null, live: true, model: null, effort: null,
        permissionPreset: 'normal', importedFrom: null, worktree: null, ...sessionLiveDefaults(),
      })
    mk('a')
    mk('b')

    s.markOrchestrator('a')
    expect(s.orchestratorId()).toBe('a')

    s.markOrchestrator('b')
    expect(s.orchestratorId()).toBe('b')
    // 'a'가 남아 있으면 여기서 둘 중 하나가 임의로 뽑힌다 — 그게 이 테스트의 요점이다
    expect(s.listSessions().filter((x) => x.projectId === null).length).toBe(2)
  })
})

/**
 * 개명의 마지막 조각: DB 테이블 이름.
 *
 * 데이터는 그대로여야 한다 — 그리드에 올려둔 세션이 개명 때문에 사라지면
 * "왜 화면이 비었지"가 되고, 그건 이름 하나 맞추자고 치를 값이 아니다.
 */
describe('v13 이관 — 옛 이름의 테이블을 grid_panels로', () => { // legacy-name
  it('올려둔 그리드 배치가 그대로 살아 넘어온다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v13-'))
    const file = join(dir, 'store.db')

    // v12까지 온 DB를 손으로 만든다 (테이블 이름은 옛것)
    const old = new Database(file)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
        auto_named INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0, last_read_seq INTEGER NOT NULL DEFAULT 0,
        waiting_since INTEGER, created_at INTEGER NOT NULL, touched_paths TEXT NOT NULL DEFAULT '[]',
        model TEXT, effort TEXT, permission_preset TEXT NOT NULL DEFAULT 'normal',
        imported_from TEXT, worktree_path TEXT, worktree_branch TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
      CREATE TABLE control_center (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, -- legacy-name
        position INTEGER NOT NULL);
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1)`).run()
    old.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at) VALUES ('s1','p1','claude','올려둔 세션',1)`).run()
    old.prepare(`INSERT INTO control_center (session_id, position) VALUES ('s1', 0)`).run() // legacy-name
    old.pragma('user_version = 12')
    old.close()

    const store = new Store(file)

    expect(store.schemaVersion).toBe(13)
    expect(store.listGridView()).toEqual(['s1'])
    rmSync(dir, { recursive: true, force: true })
  })
})
