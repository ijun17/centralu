/** T3-3 완료 기준: 인메모리 어댑터 목으로 RPC 통합 검증 */
import { beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { AdapterCapabilities, ApprovalDecision, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'

class FakeHandle implements SessionHandle {
  externalId: string | null = 'ext-1'
  sent: string[] = []
  approvals: { requestId: string; decision: ApprovalDecision }[] = []
  disposed = false
  constructor(readonly sessionId: string, private emit: EventSink) {}
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: `echo:${text}` })
  }
  respondApproval(requestId: string, decision: ApprovalDecision) {
    this.approvals.push({ requestId, decision })
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
  }
  interrupt() {}
  async dispose() { this.disposed = true }
}

class FakeAdapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, listExternal: false, autoTitle: true, attachments: ['image'],
  }
  last: FakeHandle | null = null
  /** 도구가 뜨지 못하는 상황을 만든다 (되살리기 실패 경로) */
  failCreate: string | null = null
  async detect() { return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' } }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    if (this.failCreate) throw new Error(this.failCreate)
    this.last = new FakeHandle(opts.sessionId, emit)
    return this.last
  }
}

let store: Store
let adapter: FakeAdapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  store = new Store()
  adapter = new FakeAdapter()
  events = []
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, (e) => events.push(e))
  rpc = createRpcHandler(mgr, adapters)
})

const addProject = () => rpc('projects.add', { path: tmpdir() }) as Promise<{ id: string; path: string }>

describe('프로젝트', () => {
  it('등록하고 목록에 나온다', async () => {
    const p = await addProject()
    expect(p.path).toBe(tmpdir())
    expect((await rpc('projects.list', {}) as unknown[]).length).toBe(1)
  })

  it('없는 디렉토리는 거부한다', async () => {
    await expect(rpc('projects.add', { path: '/nope/does/not/exist' })).rejects.toThrow(/디렉토리/)
  })

  it('같은 경로 재등록은 중복을 만들지 않는다', async () => {
    await addProject()
    await addProject()
    expect((await rpc('projects.list', {}) as unknown[]).length).toBe(1)
  })
})

describe('세션 수명주기', () => {
  it('생성 → 전송 → 이벤트 전파', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: '안녕' })
    expect(adapter.last!.sent).toEqual(['안녕'])
    expect(events.some((e) => e.type === 'message_delta' && e.text === 'echo:안녕')).toBe(true)
  })

  it('첫 메시지가 세션 이름이 된다 (FR-18)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: 'auth 모듈 리팩터링해줘' })
    const list = (await rpc('sessions.list', {})) as { id: string; name: string }[]
    expect(list[0]!.name).toBe('auth 모듈 리팩터링해줘')
    expect(events.some((e) => e.type === 'session_title')).toBe(true)
  })

  it('수동 이름 변경 후에는 자동 갱신이 멈춘다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('sessions.rename', { sessionId: s.id, name: '내 세션' })
    await rpc('agents.send', { sessionId: s.id, text: '다른 프롬프트' })
    const list = (await rpc('sessions.list', {})) as { name: string }[]
    expect(list[0]!.name).toBe('내 세션')
  })

  it('아카이브하면 핸들이 정리되고 활성 목록에서 빠진다 (FR-20)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.archiveSession', { sessionId: s.id })
    expect(adapter.last!.disposed).toBe(true)
    expect(mgr.activeSessionsIn(p.id)).toHaveLength(0)
    const list = (await rpc('sessions.list', {})) as { archived: boolean }[]
    expect(list[0]!.archived).toBe(true) // 기록은 남는다
  })

  it('없는 세션 조작은 session_not_found', async () => {
    await expect(rpc('agents.send', { sessionId: 'nope', text: 'x' })).rejects.toMatchObject({ code: 'session_not_found' })
  })

  it('동시 세션을 감지한다 (FR-2 경고의 근거)', async () => {
    const p = await addProject()
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })
    expect(mgr.activeSessionsIn(p.id)).toHaveLength(2)
  })
})

describe('승인·읽음·메시지', () => {
  it('승인 응답이 어댑터로 전달된다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r1', decision: 'allow' })
    expect(adapter.last!.approvals).toEqual([{ requestId: 'r1', decision: 'allow' }])
  })

  it('메시지가 영속화되고 다시 로드된다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: '첫 메시지' })
    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 100 })) as { role: string }[]
    expect(msgs.length).toBeGreaterThanOrEqual(2) // 사용자 + 어댑터 델타
    expect(msgs[0]!.role).toBe('user')
  })

  it('내가 보낸 메시지는 자동으로 읽음 처리된다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: 'x' })
    const list = (await rpc('sessions.list', {})) as { lastReadSeq: number }[]
    expect(list[0]!.lastReadSeq).toBeGreaterThan(0)
  })

  it('markRead는 뒤로 가지 않는다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('sessions.markRead', { sessionId: s.id, seq: 10 })
    await rpc('sessions.markRead', { sessionId: s.id, seq: 3 })
    const list = (await rpc('sessions.list', {})) as { lastReadSeq: number }[]
    expect(list[0]!.lastReadSeq).toBe(10)
  })
})

describe('RPC 일반', () => {
  it('capabilities와 detect를 돌려준다', async () => {
    expect(await rpc('agents.capabilities', { tool: 'claude' })).toMatchObject({ approvals: true })
    expect(await rpc('agents.detect', {})).toHaveLength(1)
  })

  it('알 수 없는 메서드는 에러', async () => {
    await expect(rpc('nope.nope', {})).rejects.toThrow(/알 수 없는 메서드/)
  })

  it('잘못된 파라미터는 검증에서 걸린다', async () => {
    await expect(rpc('agents.send', { sessionId: 123 })).rejects.toThrow()
  })
})

/**
 * 이전 세션 불러오기 (FR-10 확장).
 * 도구가 갖고 있던 대화를 이어받는 경로 — 목록·본문은 어댑터의 공식 API에서 온다.
 */
describe('이전 세션 불러오기', () => {
  class ListingAdapter extends FakeAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, listExternal: true, autoTitle: true, attachments: [],
    }
    listed: { cwd: string; limit: number } | null = null
    read: { externalId: string; cwd: string } | null = null
    fail: Error | null = null
    async listExternalSessions(cwd: string, limit: number) {
      this.listed = { cwd, limit }
      if (this.fail) throw this.fail
      return [{ externalId: 'ext-past', title: '어제 하던 일', updatedAt: 111, branch: 'main' }]
    }
    async readExternalHistory(externalId: string, cwd: string) {
      this.read = { externalId, cwd }
      if (this.fail) throw this.fail
      return [
        { role: 'user' as const, text: '테스트 고쳐줘' },
        { role: 'assistant' as const, text: '고쳤습니다' },
      ]
    }
  }

  const withListing = () => {
    const a = new ListingAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, rpc: createRpcHandler(m, adapters) }
  }

  it('도구가 보관 중인 이전 세션을 목록으로 준다', async () => {
    const { a, m, rpc: call } = withListing()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const res = await m.listExternalSessions(p.id, 'claude', 30)
    expect(res.supported).toBe(true)
    expect(a.listed).toEqual({ cwd: tmpdir(), limit: 30 })
    expect(res.sessions).toEqual([
      { externalId: 'ext-past', tool: 'claude', title: '어제 하던 일', updatedAt: 111, createdAt: null, branch: 'main', imported: false },
    ])
  })

  it('목록을 못 가져와도 예외 대신 이유를 준다 — 새 세션은 계속 만들 수 있어야 한다', async () => {
    const { a, m, rpc: call } = withListing()
    a.fail = new Error('codex 업데이트가 필요합니다')
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const res = await m.listExternalSessions(p.id, 'claude', 30)
    expect(res).toMatchObject({ supported: false, reason: 'codex 업데이트가 필요합니다', sessions: [] })
    // 목록이 죽어도 생성 경로는 멀쩡하다
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    expect(s.id).toBeTruthy()
  })

  it('지원하지 않는 어댑터는 supported=false로 답한다', async () => {
    const p = await addProject()
    const res = await mgr.listExternalSessions(p.id, 'claude', 30)
    expect(res.supported).toBe(false)
    expect(res.sessions).toEqual([])
  })

  it('불러오면 이전 대화가 기록에 복원되고, 이미 읽은 것으로 표시된다', async () => {
    const { a, m, rpc: call } = withListing()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude',
      resumeExternalId: 'ext-past', importHistory: true,
    })) as { id: string; name: string; lastSeq: number; lastReadSeq: number }

    expect(a.read).toEqual({ externalId: 'ext-past', cwd: tmpdir() })
    const msgs = (await call('messages.load', { sessionId: s.id, limit: 100 })) as { role: string; payload: { text: string } }[]
    expect(msgs.map((x) => [x.role, x.payload.text])).toEqual([
      ['user', '테스트 고쳐줘'],
      ['assistant', '고쳤습니다'],
    ])
    // 불러온 대화로 사람을 부르지 않는다 (안 읽음 배지가 뜨면 안 된다)
    const after = m.listSessions().find((x) => x.id === s.id)!
    expect(after.lastReadSeq).toBe(after.lastSeq)
    expect(after.lastSeq).toBe(2)
    // 세션 이름은 이어받은 대화에서 온다
    expect(after.name).toBe('테스트 고쳐줘')
  })

  it('불러온 세션도 목록에서 imported로 표시된다 — 같은 대화를 두 번 열지 않게', async () => {
    const { m, rpc: call } = withListing()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-past', importHistory: true,
    })
    const res = await m.listExternalSessions(p.id, 'claude', 30)
    expect(res.sessions[0]!.imported).toBe(true)
  })

  it('기록을 못 읽어도 세션은 살아난다 — 대화까지 막을 이유가 없다', async () => {
    const { a, m, rpc: call } = withListing()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const created = call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-past', importHistory: true,
    })
    a.fail = new Error('트랜스크립트를 읽을 수 없습니다')
    const s = (await created) as { id: string }
    expect(m.isLive(s.id)).toBe(true)
  })
})

/** M2.6 도그푸딩: 숨김·재시작·자동 이어가기 */
describe('세션 숨김과 삭제는 다른 일이다', () => {
  it('숨기면 목록에서 빠지지만 기록은 남고, 다시 꺼낼 수 있다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: '기억해둘 말' })

    await rpc('agents.archiveSession', { sessionId: s.id, archived: true })
    expect(mgr.listSessions().find((x) => x.id === s.id)!.archived).toBe(true)
    // 숨긴 것은 프로세스만 정리한다 — 기록은 그대로다
    expect(mgr.isLive(s.id)).toBe(false)
    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 100 })) as unknown[]
    expect(msgs.length).toBeGreaterThan(0)

    await rpc('agents.archiveSession', { sessionId: s.id, archived: false })
    expect(mgr.listSessions().find((x) => x.id === s.id)!.archived).toBe(false)
  })

  it('삭제는 되돌릴 수 없다 — 기록까지 사라진다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: '사라질 말' })
    await rpc('agents.deleteSession', { sessionId: s.id })

    expect(mgr.listSessions().find((x) => x.id === s.id)).toBeUndefined()
    expect((await rpc('messages.load', { sessionId: s.id, limit: 100 })) as unknown[]).toHaveLength(0)
  })
})

describe('에이전트 재시작', () => {
  it('프로세스만 갈아 끼우고 대화 기록은 남긴다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: '첫 말' })
    const before = adapter.last!

    const r = (await rpc('agents.restartSession', { sessionId: s.id })) as { resumed: boolean }
    expect(r.resumed).toBe(true)
    expect(before.disposed).toBe(true) // 옛 프로세스는 정리한다
    expect(adapter.last).not.toBe(before) // 새 프로세스로 갈아 끼웠다
    expect(mgr.isLive(s.id)).toBe(true)

    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 100 })) as { payload: { text?: string } }[]
    expect(msgs.some((m) => m.payload.text === '첫 말')).toBe(true)
  })
})

describe('자동 이어가기', () => {
  it('프로세스가 없어도 말을 걸면 되살려서 보낸다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    // host 재시작 후 상태: 기록·external_id는 있고 프로세스만 없다
    await mgr.archive(s.id, true)
    await mgr.archive(s.id, false)
    expect(mgr.isLive(s.id)).toBe(false)

    await rpc('agents.send', { sessionId: s.id, text: '이어서 해줘' })

    expect(mgr.isLive(s.id)).toBe(true)
    expect(adapter.last!.sent).toContain('이어서 해줘')
  })

  it('정말 이어갈 수 없으면 조용히 삼키지 않고 이유를 던진다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await mgr.archive(s.id, true)
    await mgr.archive(s.id, false)
    // 도구 자체가 뜨지 못하는 상황
    adapter.failCreate = '도구를 시작할 수 없습니다'

    await expect(rpc('agents.send', { sessionId: s.id, text: '이어서' })).rejects.toThrow(/이어갈 수 없습니다/)
    // 보내지 못한 말은 기록에도 남지 않는다 (있지도 않은 대화를 만들지 않는다)
    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 100 })) as { payload: { text?: string } }[]
    expect(msgs.some((m) => m.payload.text === '이어서')).toBe(false)
  })
})

/**
 * 권한·모델은 도구 프로세스를 띄울 때 고정된다.
 * 살아 있는 세션의 메타만 고치면 화면에는 '자동'인데 계속 승인을 묻는다
 * (도그푸딩: "권한 자동으로 바꿨는데 왜 물어보냐").
 */
describe('설정 변경은 실제로 적용된다', () => {
  it('권한을 바꾸면 살아 있는 에이전트를 갈아 끼운다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const before = adapter.last!

    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })

    // 조용히 메타만 고치지 않는다 — 새 설정으로 프로세스를 다시 띄운다
    expect(before.disposed).toBe(true)
    expect(adapter.last).not.toBe(before)
    expect(mgr.listSessions().find((x) => x.id === s.id)!.permissionPreset).toBe('auto')
    expect(mgr.isLive(s.id)).toBe(true)
  })

  it('같은 값으로 다시 저장하면 프로세스를 건드리지 않는다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const before = adapter.last!

    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'normal' })

    expect(before.disposed).toBe(false)
    expect(adapter.last).toBe(before)
  })

  it('잠든 세션은 메타만 고친다 (띄울 때 새 설정으로 뜬다)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    await mgr.archive(s.id, true)
    await mgr.archive(s.id, false)

    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })
    expect(mgr.listSessions().find((x) => x.id === s.id)!.permissionPreset).toBe('auto')
    expect(mgr.isLive(s.id)).toBe(false)
  })
})

/**
 * 화면에는 '자동'인데 계속 승인을 묻던 문제 (도그푸딩 5차).
 * 비교 기준이 meta(화면값)였던 탓에, 이미 meta가 auto인 세션은 다시 골라도
 * '바뀐 게 없음'으로 판정돼 옛 설정으로 도는 프로세스가 그대로 남았다.
 */
describe('설정 어긋남(drift)은 화면값이 아니라 프로세스 기준으로 본다', () => {
  it('meta는 이미 auto인데 프로세스가 normal이면, 같은 값을 골라도 갈아 끼운다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const before = adapter.last!

    // 예전 버전이 만들어 놓은 어긋난 상태를 재현한다: 저장값만 auto로 바뀐 세션
    const meta = mgr.listSessions().find((x) => x.id === s.id)!
    ;(mgr as unknown as { meta: Map<string, typeof meta> }).meta.get(s.id)!.permissionPreset = 'auto'

    // 사용자가 화면에서 '자동'을 다시 고른다 (meta 기준으로는 변화 없음)
    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })

    expect(before.disposed).toBe(true)
    expect(adapter.last).not.toBe(before)
    expect(mgr.isLive(s.id)).toBe(true)
  })

  it('프로세스와 화면값이 같으면 건드리지 않는다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'auto',
    })) as { id: string }
    const before = adapter.last!

    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })

    expect(before.disposed).toBe(false)
    expect(adapter.last).toBe(before)
  })
})
