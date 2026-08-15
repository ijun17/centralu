/** T1-2 완료 기준: 스키마가 실제로 적용되고 CRUD가 도는지 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.js'

function seeded() {
  const s = new Store()
  s.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.upsertSession({
    id: 's1', projectId: 'p1', tool: 'claude', externalId: null, name: '새 세션',
    autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
    createdAt: Date.now(), waitingSince: null, live: true,
  })
  return s
}

describe('Store (dev sqlite)', () => {
  it('최신 스키마까지 마이그레이션된다', () => {
    expect(new Store().schemaVersion).toBe(3)
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
    expect(store.schemaVersion).toBe(3)

    // 백필이 되어야 예전 대화도 찾을 수 있다
    const hits = store.searchMessages('승인')
    expect(hits.length).toBe(1)
    expect(hits[0]!.sessionId).toBe('s1')

    // 새 컬럼도 쓸 수 있다
    store.setTouchedPaths('s1', ['src/a.ts'])
    expect(store.getTouchedPaths('s1')).toEqual(['src/a.ts'])

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
})
