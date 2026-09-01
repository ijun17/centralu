/** T1-2 완료 기준: 스키마가 실제로 적용되고 CRUD가 도는지 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionInfo, StoredMessage } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'

/**
 * 지금의 최신 스키마 버전 — 마이그레이션을 더할 때 여기 **한 곳**만 올린다.
 * v22·v23·v24가 연달아 같은 여섯 군데 단언을 깨뜨렸다: 버전이 여섯 번 적혀 있으면
 * 마이그레이션마다 여섯 번의 잔손질이 청구된다.
 */
const LATEST_SCHEMA = 26

function seeded() {
  const s = new Store()
  s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.upsertSession({
    id: 's1', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: '새 세션',
    autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
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
    expect(store.schemaVersion).toBe(LATEST_SCHEMA)
    expect(store.listSessions().map((x) => x.id).sort()).toEqual(['s1', 's2', 's3'])
    expect(store.listSessions().find((x) => x.id === 's2')?.name).toBe('이름 s2')
    expect(store.loadMessages('s1').length).toBe(1)

    // 그리고 이제 프로젝트 없는 세션이 들어간다
    store.upsertSession({
      id: 'orc', projectId: null, kind: 'orchestrator', tool: 'claude', externalId: null, name: 'Orchestrator',
      autoNamed: false, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: 1, waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null,
      permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, ...sessionLiveDefaults(),
    })
    expect(store.listSessions().find((x) => x.id === 'orc')?.projectId).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('Store (dev sqlite)', () => {
  it('최신 스키마까지 마이그레이션된다', () => {
    expect(new Store().schemaVersion).toBe(LATEST_SCHEMA)
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
    expect(store.schemaVersion).toBe(LATEST_SCHEMA)

    // 백필이 되어야 예전 대화도 찾을 수 있다
    const hits = store.searchMessages('승인')
    expect(hits.length).toBe(1)
    expect(hits[0]!.sessionId).toBe('s1')

    // 새 컬럼도 쓸 수 있다
    store.setTouchedPaths('s1', ['src/a.ts'])
    expect(store.getTouchedPaths('s1')).toEqual(['src/a.ts'])

    // v4: 모델·권한도 기존 세션에 붙는다 (기본값으로)
    const migrated = store.listSessions().find((s) => s.id === 's1')
    expect(migrated).toMatchObject({ model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null })

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
      id: 's-import', projectId: 'p1', kind: 'worker' as const, tool: 'claude' as const, externalId: 'ext-new',
      name: '이어받은 대화', autoNamed: true, state: 'idle' as const, archived: false,
      lastReadSeq: 0, lastSeq: 0, createdAt: Date.now(), waitingSince: null, live: true,
      model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal' as const, importedFrom: 'ext-old', worktree: null, parentSessionId: null,
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
    id: 's-x', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: '세션',
    autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true,
    model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
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
 * v18 — 응답 길이(#54). model(v4)·effort(v7)와 같은 반복 함정이 있는 자리다:
 * 컬럼을 넣고 네 자리(DDL·INSERT·UPDATE·SELECT) 중 하나를 빼먹으면 컴파일은
 * 지나가는데 값만 조용히 사라진다. 왕복이 그 네 자리를 한 번에 검사한다.
 */
describe('마이그레이션 v18 — 응답 길이', () => {
  const row = (over: Partial<SessionInfo>): SessionInfo => ({
    id: 's-x', projectId: 'p1', kind: 'worker', tool: 'codex', externalId: null, name: '세션',
    autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true,
    model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
    ...sessionLiveDefaults(),
    ...over,
  })

  it('verbosity 컬럼이 생기고 왕복한다', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-verb', verbosity: 'low' }))
    expect(store.listSessions().find((r) => r.id === 's-verb')?.verbosity).toBe('low')
    // 갱신도 남는다 — UPDATE 절에서 빠지면 첫 저장만 되고 그 뒤로는 안 바뀐다
    store.upsertSession(row({ id: 's-verb', verbosity: 'high' }))
    expect(store.listSessions().find((r) => r.id === 's-verb')?.verbosity).toBe('high')
    store.close()
  })

  it('안 고른 세션은 null — 도구 기본값과 구분된다', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-verb-none' }))
    expect(store.listSessions().find((r) => r.id === 's-verb-none')?.verbosity).toBeNull()
    store.close()
  })

  /** 응답 속도(v20)도 같은 성질 — 같은 왕복 계약 */
  it('service_tier 컬럼이 생기고 왕복한다', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's-tier', serviceTier: 'priority' }))
    expect(store.listSessions().find((r) => r.id === 's-tier')?.serviceTier).toBe('priority')
    store.upsertSession(row({ id: 's-tier', serviceTier: null }))
    expect(store.listSessions().find((r) => r.id === 's-tier')?.serviceTier).toBeNull()
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
        id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id,
        autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
        createdAt: Date.now(), waitingSince: null, live: true,
        model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
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
        id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id,
        autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
        createdAt: Date.now(), waitingSince: null, live: true,
        model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
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

/**
 * 표식은 kind 하나다 (#13). 예전에는 markOrchestrator가 따로 있어 "쓰는 길이 둘"이었다.
 * 프로젝트 오케스트레이터가 폐기되면서(v26) 표식이 붙은 세션은 다시 앱에 하나뿐이다.
 */
describe('오케스트레이터 표식(kind)', () => {
  const mk = (s: Store, id: string, projectId: string | null, kind: 'worker' | 'orchestrator') =>
    s.upsertSession({
      id, projectId, kind, tool: 'claude', externalId: null, name: id,
      autoNamed: false, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: 1, waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null,
      permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, ...sessionLiveDefaults(),
    })

  it('표식이 없으면 중앙은 null', () => {
    expect(seeded().orchestratorId()).toBeNull()
  })

  it('kind가 upsert로 왕복한다 — 쓰는 길은 하나다', () => {
    const s = seeded()
    mk(s, 'orc', null, 'orchestrator')
    expect(s.orchestratorId()).toBe('orc')
    expect(s.listSessions().find((x) => x.id === 'orc')?.kind).toBe('orchestrator')
    // 강등도 같은 길로 남는다
    mk(s, 'orc', null, 'worker')
    expect(s.orchestratorId()).toBeNull()
    s.close()
  })

  /**
   * v26 — 프로젝트 오케스트레이터 폐기의 안전장치 (2026-09-01).
   *
   * **강등이 아니라 승격이 될 뻔한 자리다.** 코드에서 프로젝트 범위 단계가 사라지면서,
   * 표식이 남은 세션은 다음에 깰 때 자기 프로젝트가 아니라 **모든 프로젝트**를 보는
   * 도구를 받는다 — 화면 어디에도 안 나타나는 권한 확대다. 그래서 데이터를 먼저 고친다.
   */
  it('v26: 프로젝트를 가진 옛 표식은 지워지고, 중앙 표식은 살아남는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v26-'))
    const file = join(dir, 'store.db')

    // v25 상태를 만든다: 프로젝트 오케스트레이터 하나 + 중앙 하나
    const before = new Store(file)
    before.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    mk(before, 'proj-orc', 'p1', 'orchestrator')
    mk(before, 'central', null, 'orchestrator')
    before.close()
    const raw = new Database(file)
    raw.pragma('user_version = 25')
    raw.close()

    const after = new Store(file)
    expect(after.schemaVersion).toBe(LATEST_SCHEMA)
    // 프로젝트를 가진 표식은 사라진다 — 대화는 그대로다
    expect(after.listSessions().find((x) => x.id === 'proj-orc')?.kind).toBe('worker')
    // 중앙은 그대로 — 이 앱의 유일한 오케스트레이터다
    expect(after.orchestratorId()).toBe('central')
    after.close()
    rmSync(dir, { recursive: true, force: true })
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

    expect(store.schemaVersion).toBe(LATEST_SCHEMA)
    expect(store.listGridView()).toEqual(['s1'])
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v14: a session's cwd stops being recomputed. (issue #28)
 *
 * The whole failure was a derived path. Renaming the data directory moved the orchestrator's
 * cwd, Claude Code files conversations by working directory, and the tool went looking under a
 * slug that had never existed. So this runs against a real v13-shaped database — a migration
 * that is only assumed to work is exactly the kind that quietly orphans someone's history.
 */
describe('v14 이관 — 세션이 만들어진 디렉토리를 기억한다', () => {
  const v13Db = (file: string) => {
    const old = new Database(file)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
        auto_named INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0, is_orchestrator INTEGER NOT NULL DEFAULT 0,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        waiting_since INTEGER, created_at INTEGER NOT NULL, touched_paths TEXT NOT NULL DEFAULT '[]',
        model TEXT, effort TEXT, permission_preset TEXT NOT NULL DEFAULT 'normal',
        imported_from TEXT, worktree_path TEXT, worktree_branch TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
      CREATE TABLE grid_panels (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL);
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1)`).run()
    const add = old.prepare(
      `INSERT INTO sessions (id, project_id, tool, name, created_at, is_orchestrator, worktree_path, worktree_branch)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    add.run('plain', 'p1', 'claude', '프로젝트 세션', 1, 0, null, null)
    add.run('wt', 'p1', 'claude', '워크트리 세션', 1, 0, '/tmp/wt/feature', 'feature')
    add.run('orc', null, 'claude', 'Orchestrator', 1, 1, null, null)
    old.pragma('user_version = 13')
    old.close()
  }

  it('프로젝트·워크트리 세션은 자기 경로로 백필된다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v14-'))
    const file = join(dir, 'store.db')
    v13Db(file)

    const store = new Store(file)

    expect(store.schemaVersion).toBe(LATEST_SCHEMA)
    expect(store.sessionCwd('plain')).toBe('/tmp/p1')
    // A worktree session's history is filed under the worktree, not the project it came from
    expect(store.sessionCwd('wt')).toBe('/tmp/wt/feature')
    rmSync(dir, { recursive: true, force: true })
  })

  /*
   * The orchestrator is the one row SQL cannot answer for: it has no project and no worktree,
   * and the only source left is `orchestratorHome()`, which creates a directory under the
   * user's home. A migration that does that on every open is how `pnpm verify` once created
   * `~/.centralu/orchestrator` and blocked the real data move (see data-dir.ts). So it stays
   * NULL here and the manager resolves it the first time it actually needs a path.
   */
  it('오케스트레이터는 NULL로 남는다 — 마이그레이션이 홈을 건드리지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v14-orc-'))
    const file = join(dir, 'store.db')
    v13Db(file)

    const store = new Store(file)

    expect(store.sessionCwd('orc')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  /*
   * schema.sql resets user_version to 1, so every migration step replays on every open. A
   * backfill without `WHERE cwd IS NULL` would therefore rewrite the stored path on each
   * start — reintroducing the recomputation this version exists to end.
   */
  it('다시 열어도 적어둔 경로를 덮어쓰지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v14-again-'))
    const file = join(dir, 'store.db')
    v13Db(file)

    const first = new Store(file)
    first.setSessionCwd('plain', '/tmp/where-it-really-started')
    first.close()

    const second = new Store(file)
    expect(second.sessionCwd('plain')).toBe('/tmp/where-it-really-started')
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v15: a project remembers the shell commands saved on it. (issue #44)
 *
 * The Run menu is the only place these are registered, so surviving a relaunch is the whole
 * point — and the failure would be silent in the worst way. A menu that lost them says
 * "nothing saved yet", which reads as "you never added any" rather than as "they are gone",
 * so nobody would think to report it.
 *
 * Run against a real v14-shaped database rather than a fresh one: the column has to arrive
 * on the file people already have, which is the half `CREATE TABLE IF NOT EXISTS` never does.
 */
describe('v15 이관 — 프로젝트가 등록한 셸 명령을 기억한다', () => {
  it('옛 DB(v14)에 컬럼이 생기고, 껐다 켜도 명령이 남는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v15-'))
    const file = join(dir, 'store.db')

    const old = new Database(file)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1)`).run()
    old.pragma('user_version = 14')
    old.close()

    const first = new Store(file)
    expect(first.schemaVersion).toBe(LATEST_SCHEMA)
    // 없던 프로젝트에는 없는 것이 맞다 — 빈 목록이 곧 '아직 등록한 적 없음'이다
    expect(first.projectCommands('p1')).toEqual([])
    first.setProjectCommands('p1', ['pnpm test', 'pnpm e2e'])
    first.close()

    const second = new Store(file)
    expect(second.projectCommands('p1')).toEqual(['pnpm test', 'pnpm e2e'])
    // schema.sql이 user_version을 1로 되돌려 단계가 매번 다시 도는 구조다 —
    // 두 번째 열기가 컬럼을 다시 만들어 목록을 비우면 안 된다
    expect(second.listProjects().map((p) => p.id)).toEqual(['p1'])
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 읽을 수 없는 값은 '없음'으로 읽는다.
   *
   * 여기서 던지면 프로젝트 목록을 만드는 길이 통째로 막혀 사이드바가 빈 채로 뜬다 —
   * 잃을 수 있는 최악이 "메뉴를 다시 채운다"로 끝나야 한다.
   */
  it('깨진 값이 들어 있어도 프로젝트 목록은 살아 있다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v15-bad-'))
    const file = join(dir, 'store.db')

    const first = new Store(file)
    first.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    first.close()

    const poke = new Database(file)
    poke.prepare(`UPDATE projects SET commands = ? WHERE id = 'p1'`).run('{ 이건 JSON이 아니다')
    poke.close()

    const second = new Store(file)
    expect(second.projectCommands('p1')).toEqual([])
    expect(second.listProjects().map((p) => p.name)).toEqual(['p1'])
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v16 — host 자신의 설정 (이슈 #43).
 *
 * 처음 들어가는 것은 "업데이트를 자동으로 확인할까"이고, 그 답이 **다시 켰을 때 남아
 * 있어야** 이 설정이 설정이다. 끌 때마다 다시 켜지는 체크상자는 켜져 있는 것과 같다.
 *
 * 값이 아예 없는 것과 `'false'`가 들어 있는 것을 구분한다 — 나중에 기본값을 바꿀 때,
 * 일부러 꺼 둔 사람의 선택만은 덮지 않기 위한 여지다.
 */
describe('v16 이관 — host의 설정이 재시작을 넘긴다', () => {
  it('옛 DB에 테이블이 생기고, 껐다 켜도 값이 남는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v16-'))
    const file = join(dir, 'store.db')

    const old = new Database(file)
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
      sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`)
    old.pragma('user_version = 15')
    old.close()

    const first = new Store(file)
    // 쓴 적이 없는 것은 null이다 — 'false'와 구별된다
    expect(first.appSetting('updates.auto')).toBeNull()
    first.setAppSetting('updates.auto', 'false')
    first.close()

    const second = new Store(file)
    expect(second.appSetting('updates.auto')).toBe('false')
    // schema.sql이 user_version을 1로 되돌려 단계가 매번 다시 도는 구조다 —
    // 두 번째 열기가 테이블을 다시 만들어 답을 지우면 안 된다
    second.setAppSetting('updates.auto', 'true')
    expect(second.appSetting('updates.auto')).toBe('true')
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * v17 — how full the context is survives the host (issue #48).
 *
 * The reading was always right; it lived in memory and died with the process, so a cold start
 * showed `Context —` on every session until that one happened to work again. The gauge looked
 * broken when nobody had written the number down — the same disease as #37.
 *
 * Run against a real v16-shaped file, because the half that would actually have failed is the
 * one `CREATE TABLE IF NOT EXISTS` silently skips: adding columns to the database people
 * already have.
 */
describe('v17 이관 — 컨텍스트 사용량이 재시작을 넘긴다', () => {
  const v16Db = (file: string) => {
    const old = new Database(file)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        default_tool TEXT NOT NULL DEFAULT 'claude', default_model TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, commands TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        tool TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
        auto_named INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0, is_orchestrator INTEGER NOT NULL DEFAULT 0,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        waiting_since INTEGER, created_at INTEGER NOT NULL, touched_paths TEXT NOT NULL DEFAULT '[]',
        model TEXT, effort TEXT, permission_preset TEXT NOT NULL DEFAULT 'normal',
        imported_from TEXT, worktree_path TEXT, worktree_branch TEXT, cwd TEXT,
        sidebar_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
    `)
    old.prepare(`INSERT INTO projects VALUES ('p1','/tmp/p1','p1','claude',NULL,0,1,'[]')`).run()
    const add = old.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at) VALUES (?,?,?,?,?)`)
    add.run('worked', 'p1', 'claude', '일한 세션', 1)
    add.run('fresh', 'p1', 'codex', '아직 안 돈 세션', 1)
    old.pragma('user_version = 16')
    old.close()
  }

  const row = (over: Partial<SessionInfo>): SessionInfo => ({
    id: 'worked', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: '일한 세션',
    autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
    createdAt: 1, waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null,
    permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
    ...sessionLiveDefaults(),
    ...over,
  })

  it('옛 DB에 컬럼이 생기고, 껐다 켜도 사용량이 남는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v17-'))
    const file = join(dir, 'store.db')
    v16Db(file)

    const first = new Store(file)
    expect(first.schemaVersion).toBe(LATEST_SCHEMA)
    // 한 번도 보고한 적 없는 세션은 null이다 — 화면의 `—`가 곧 이 사실이다
    expect(first.listSessions().find((s) => s.id === 'worked')!.context).toBeNull()
    first.upsertSession(row({ context: { used: 168_000, window: 200_000, exactness: 'exact' } }))
    first.close()

    // 껐다 켠 host — 여기서 비어 있던 것이 이슈 그대로의 증상이다
    const second = new Store(file)
    expect(second.listSessions().find((s) => s.id === 'worked')!.context).toEqual({
      used: 168_000, window: 200_000, exactness: 'exact',
    })
    // 아직 한 턴도 안 돈 세션은 여전히 모른다 — 0%가 아니라 모름이어야 한다
    expect(second.listSessions().find((s) => s.id === 'fresh')!.context).toBeNull()
    // schema.sql이 user_version을 1로 되돌려 단계가 매번 다시 도는 구조다 —
    // 두 번째 열기가 컬럼을 다시 만들어 값을 지우면 안 된다
    expect(second.listSessions().find((s) => s.id === 'fresh')!.tool).toBe('codex')
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 압축(compaction)은 사용량을 **내린다.** 새 값이 옛 값을 못 덮으면 재시작 뒤의 눈금은
   * 영영 실제보다 높은 채로 남아, 사람은 있지도 않은 한계를 보고 대화를 새로 시작한다.
   */
  it('나중 보고가 앞선 보고를 덮는다', () => {
    const store = seeded()
    store.upsertSession(row({ id: 's1', context: { used: 190_000, window: 200_000, exactness: 'exact' } }))
    store.upsertSession(row({ id: 's1', context: { used: 24_000, window: 200_000, exactness: 'exact' } }))
    expect(store.listSessions().find((s) => s.id === 's1')!.context!.used).toBe(24_000)
    store.close()
  })
})

describe('커밋 귀속 (#50) — 저장소가 아니라 우리 DB에만', () => {
  it('기록하고 프로젝트별로 되찾는다 (같은 해시는 마지막 기록이 이긴다)', () => {
    const s = new Store()
    s.recordCommit('p1', '4ce6fc7', 's-auth')
    s.recordCommit('p1', 'abc1234', 's-docs')
    s.recordCommit('p2', '4ce6fc7', 's-other') // 다른 프로젝트의 같은 해시는 별개다
    s.recordCommit('p1', '4ce6fc7', 's-auth2') // 재기록 — 덮는다
    const rows = s.commitSessions('p1')
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.sha === '4ce6fc7')?.sessionId).toBe('s-auth2')
    expect(s.commitSessions('p2')).toEqual([{ sha: '4ce6fc7', sessionId: 's-other' }])
    expect(s.commitSessions('p-none')).toEqual([])
  })
})

describe('WAL 체크포인트', () => {
  /*
   * 실측(2026-08-26): 실사용 DB 옆의 -wal이 97MB로 본 DB(91MB)보다 컸다.
   * 기본 auto-checkpoint(PASSIVE)는 파일을 줄이지 않는다 — TRUNCATE만 줄인다.
   * 계약: checkpoint()는 -wal 파일을 0으로 자른다.
   */
  it('checkpoint()가 -wal 파일을 0바이트로 자른다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-wal-'))
    const path = join(dir, 'store.db')
    const s = new Store(path)
    s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    s.upsertSession({
      id: 's1', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: '새 세션',
      autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
      ...sessionLiveDefaults(),
    })
    for (let i = 1; i <= 200; i++) {
      s.appendMessages([{ sessionId: 's1', seq: i, role: 'user', kind: 'text', payload: { text: 'x'.repeat(2000) }, ts: i }])
    }
    expect(statSync(path + '-wal').size).toBeGreaterThan(0)
    s.checkpoint()
    expect(statSync(path + '-wal').size).toBe(0)
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/*
 * 읽기는 델타 시절의 데이터도 메시지로 병합한다 (#66).
 * 마이그레이션 전의 26만 행이 그대로 있어도, limit은 행이 아니라 메시지를 센다.
 */
describe('loadMessages는 델타 조각을 메시지로 병합한다 (#66)', () => {
  const delta = (seq: number, text: string) =>
    ({ sessionId: 's1', seq, role: 'assistant' as const, kind: 'text' as const, payload: { type: 'message_delta', text }, ts: seq })

  it('연속 assistant 조각이 한 메시지가 되고, seq는 첫 조각의 것이다', () => {
    const s = seeded()
    s.appendMessages([
      { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: '질문' }, ts: 1 },
      delta(2, '한 '), delta(3, '번에 '), delta(4, '뽑기'),
    ])
    const msgs = s.loadMessages('s1')
    expect(msgs.map((m) => [m.seq, (m.payload as { text?: string }).text])).toEqual([
      [1, '질문'],
      [2, '한 번에 뽑기'],
    ])
  })

  it('limit은 병합된 메시지를 센다 — 조각 수가 아니라', () => {
    const s = seeded()
    const rows = []
    for (let turn = 0; turn < 4; turn++) {
      rows.push({ sessionId: 's1', seq: turn * 11 + 1, role: 'user' as const, kind: 'text' as const, payload: { text: `질문${turn}` }, ts: turn * 11 + 1 })
      for (let t = 0; t < 10; t++) rows.push(delta(turn * 11 + 2 + t, `조각${turn}-${t} `))
    }
    s.appendMessages(rows)
    // 마지막 2개 = 질문3 + 그 답 (조각 10개가 아니라)
    const page = s.loadMessages('s1', 2)
    expect(page.length).toBe(2)
    expect((page[0]!.payload as { text?: string }).text).toBe('질문3')
    expect((page[1]!.payload as { text?: string }).text).toContain('조각3-0')
    expect((page[1]!.payload as { text?: string }).text).toContain('조각3-9')
    // 커서(첫 조각의 seq)로 이어 읽으면 같은 조각이 두 번 오지 않는다
    const older = s.loadMessages('s1', 2, page[0]!.seq)
    expect((older[1]!.payload as { text?: string }).text).toContain('조각2-9')
  })

  it('경계는 병합하지 않는다 — 사람의 말·도구 호출·reasoning이 갈라놓는다', () => {
    const s = seeded()
    s.appendMessages([
      delta(1, '앞'),
      { sessionId: 's1', seq: 2, role: 'system', kind: 'tool_call', payload: { summary: { tool: 'Bash', title: 'ls' } }, ts: 2 },
      delta(3, '뒤'),
      { sessionId: 's1', seq: 4, role: 'assistant', kind: 'reasoning', payload: { text: '생각' }, ts: 4 },
      delta(5, '또'),
    ])
    expect(s.loadMessages('s1').map((m) => [m.kind, (m.payload as { text?: string }).text])).toEqual([
      ['text', '앞'], ['tool_call', undefined], ['text', '뒤'], ['reasoning', '생각'], ['text', '또'],
    ])
  })

  it('배치 경계에 걸친 조각도 잘리지 않는다', () => {
    const s = seeded()
    const rows: StoredMessage[] = [{ sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: '질문' }, ts: 1 }]
    // 내부 배치(400행)보다 긴 답변 — 500조각이 한 메시지가 되어야 한다
    for (let t = 0; t < 500; t++) rows.push(delta(t + 2, `${t},`))
    s.appendMessages(rows)
    const msgs = s.loadMessages('s1', 10)
    expect(msgs.length).toBe(2)
    const text = (msgs[1]!.payload as { text?: string }).text!
    expect(text.startsWith('0,1,')).toBe(true)
    expect(text.endsWith('499,')).toBe(true)
  })

  it('loadMessagesFrom은 그 자리 뒤를 같은 규칙으로 읽는다', () => {
    const s = seeded()
    s.appendMessages([
      { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: '질문' }, ts: 1 },
      delta(2, '답 '), delta(3, '전체'),
      { sessionId: 's1', seq: 4, role: 'user', kind: 'text', payload: { text: '다음 질문' }, ts: 4 },
    ])
    const after = s.loadMessagesFrom('s1', 1, 10)
    expect(after.map((m) => (m.payload as { text?: string }).text)).toEqual(['답 전체', '다음 질문'])
  })

  it('upsertMessageNoIndex는 본문만 갱신하고 색인은 건드리지 않는다', () => {
    const s = seeded()
    s.upsertMessageNoIndex({ sessionId: 's1', seq: 1, role: 'assistant', kind: 'text', payload: { text: '자라는 본문' }, ts: 1 })
    expect((s.loadMessages('s1')[0]!.payload as { text?: string }).text).toBe('자라는 본문')
    expect(s.searchMessages('자라는 본문').length).toBe(0) // 색인은 닫힐 때(appendMessages) 한 번
    s.appendMessages([{ sessionId: 's1', seq: 1, role: 'assistant', kind: 'text', payload: { text: '자라는 본문 끝' }, ts: 2 }])
    expect(s.searchMessages('자라는 본문').length).toBe(1)
  })
})

/*
 * v21 이관 (#66): 델타 시절의 행을 메시지로 합친다.
 *
 * 가장 중요한 성질은 크기가 아니라 **읽기와 같은 답을 준다**는 것이다 —
 * 이사 전에도 loadMessages가 병합해 보여주고 있었으므로, 이사 뒤에 대화가
 * 달라 보이면 그건 데이터를 잃은 것이다.
 */
describe('v21 이관 — 델타 행을 메시지로 합친다', () => {
  const oldDbWithDeltas = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-v21-'))
    const file = join(dir, 'store.db')
    const s = new Store(file)
    s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    s.upsertSession({
      id: 's1', projectId: 'p1', kind: 'worker', tool: 'codex', externalId: null, name: '새 세션',
      autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
      ...sessionLiveDefaults(),
    })
    // 실측한 모양 그대로: 토큰 하나가 행 하나
    s.appendMessages([
      { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: '맵 추출 어떻게 해?' }, ts: 1 },
      { sessionId: 's1', seq: 2, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '한 ' }, ts: 2 },
      { sessionId: 's1', seq: 3, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '번에 ' }, ts: 3 },
      { sessionId: 's1', seq: 4, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '뽑게 됩니다.' }, ts: 4 },
      { sessionId: 's1', seq: 5, role: 'system', kind: 'tool_call', payload: { summary: { tool: 'Bash', title: 'ls' } }, ts: 5 },
      { sessionId: 's1', seq: 6, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '결과는 ' }, ts: 6 },
      { sessionId: 's1', seq: 7, role: 'assistant', kind: 'text', payload: { type: 'message_delta', text: '이렇습니다' }, ts: 7 },
      { sessionId: 's1', seq: 8, role: 'assistant', kind: 'reasoning', payload: { text: '생각 ' }, ts: 8 },
      { sessionId: 's1', seq: 9, role: 'assistant', kind: 'reasoning', payload: { text: '조각' }, ts: 9 },
    ])
    s.markRead('s1', 3) // 답변 중간을 읽은 상태 — 이사 뒤 안읽음이 되살아나면 안 된다
    const beforeRead = s.loadMessages('s1', 50).map((m) => [m.kind, (m.payload as { text?: string }).text])
    s.close()
    return { file, beforeRead }
  }

  it('행은 줄지만 읽은 결과는 이사 전과 똑같다', () => {
    const { file, beforeRead } = oldDbWithDeltas()
    // 이사 전 상태로 되돌린다 (쓰기는 이미 새 방식이므로 버전만 낮춰 이 단계를 다시 태운다)
    const raw = new Database(file)
    raw.pragma('user_version = 20')
    const rawRows = (raw.prepare(`SELECT COUNT(*) as n FROM messages`).get() as { n: number }).n
    raw.close()

    const s = new Store(file)
    const rows = s.loadMessages('s1', 50)
    const afterRead = rows.map((m) => [m.kind, (m.payload as { text?: string }).text])

    expect(afterRead).toEqual(beforeRead) // 대화가 달라 보이면 잃은 것이다
    expect(afterRead).toEqual([
      ['text', '맵 추출 어떻게 해?'],
      ['text', '한 번에 뽑게 됩니다.'],
      ['tool_call', undefined],
      ['text', '결과는 이렇습니다'],
      ['reasoning', '생각 조각'],
    ])
    // 9행 → 5행
    const nowRows = s.loadMessages('s1', 50).length
    expect(rawRows).toBe(9)
    expect(nowRows).toBe(5)
    s.close()
  })

  it('합친 자리의 seq는 첫 조각의 것이라 읽음 위치가 뒤로 가지 않는다', () => {
    const { file } = oldDbWithDeltas()
    const raw = new Database(file)
    raw.pragma('user_version = 20')
    raw.close()

    const s = new Store(file)
    const merged = s.loadMessages('s1', 50)
    expect(merged[1]!.seq).toBe(2) // 2,3,4를 합친 자리는 2번
    // 읽음 위치(3)는 그대로고, 첫 조각(2)이 남았으므로 이미 읽은 답변이 안읽음으로 돌아오지 않는다
    expect(s.listSessions()[0]!.lastReadSeq).toBe(3)
    s.close()
  })

  it('합친 뒤에는 조각 경계에 걸린 구절도 검색된다', () => {
    const { file } = oldDbWithDeltas()
    const raw = new Database(file)
    raw.pragma('user_version = 20')
    raw.close()

    const s = new Store(file)
    expect(s.searchMessages('번에 뽑게').length).toBe(1) // 옛 색인으로는 영영 못 찾던 구절
    expect(s.searchMessages('결과는 이렇습니다').length).toBe(1)
    s.close()
  })
})

/** #69-1: 세션 트리 링크는 보통의 upsert에 실려 다닌다 — 쓰는 길이 둘이면 한쪽만 고쳐진다 */
describe('parent_session_id 왕복 (#69)', () => {
  it('부모 링크가 저장되고 되읽힌다', () => {
    const s = seeded()
    const before = s.listSessions().find((x) => x.id === 's1')!
    expect(before.parentSessionId).toBeNull()

    s.upsertSession({ ...before, parentSessionId: 'mgr-1' })

    expect(s.listSessions().find((x) => x.id === 's1')?.parentSessionId).toBe('mgr-1')
  })
})

/** v23 (#69): 워크트리 프로비저닝 설정의 왕복과 정규화 */
describe('worktree_setup 왕복 (#69)', () => {
  it('저장·되읽기, 빈 설정은 null로 눕는다', () => {
    const s = seeded()
    expect(s.worktreeSetup('p1')).toBeNull()

    s.setWorktreeSetup('p1', { command: 'pnpm install', copyFiles: ['.env.local'] })
    expect(s.worktreeSetup('p1')).toEqual({ command: 'pnpm install', copyFiles: ['.env.local'] })

    // 빈 설정을 저장하면 "설정 없음"이다 — 빈 문자열 커맨드가 exec되는 일이 없어야 한다
    s.setWorktreeSetup('p1', { command: '', copyFiles: [] })
    expect(s.worktreeSetup('p1')).toBeNull()
  })
})
