/** T3-3 완료 기준: 인메모리 어댑터 목으로 RPC 통합 검증 */
import { beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { AdapterCapabilities, ApprovalDecision, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, OrchestratorTools, SessionHandle } from '../adapters/contract.js'
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
  /** 턴이 끝났다고 알린다 (보고 되돌아오기 테스트용) */
  finishTurn() { this.emit({ type: 'turn_complete', sessionId: this.sessionId }) }
  async dispose() { this.disposed = true }
}

class FakeAdapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: ['image'],
  }
  last: FakeHandle | null = null
  /** 오케스트레이터에게만 오는 도구 — 붙는지/안 붙는지를 테스트가 본다 */
  lastOrchestratorTools: OrchestratorTools | undefined
  private handles = new Map<string, FakeHandle>()
  handleOf(id: string) { return this.handles.get(id) }
  /** 도구가 뜨지 못하는 상황을 만든다 (되살리기 실패 경로) */
  failCreate: string | null = null
  async detect() { return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' } }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    if (this.failCreate) throw new Error(this.failCreate)
    this.lastOrchestratorTools = opts.orchestratorTools
    this.last = new FakeHandle(opts.sessionId, emit)
    this.handles.set(opts.sessionId, this.last)
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
    await expect(rpc('projects.add', { path: '/nope/does/not/exist' })).rejects.toThrow(/Directory not found/)
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
    await expect(rpc('nope.nope', {})).rejects.toThrow(/Unknown method/)
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
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [],
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
      { externalId: 'ext-past', tool: 'claude', title: '어제 하던 일', updatedAt: 111, createdAt: null, branch: 'main', imported: false, importedAs: null },
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

    await expect(rpc('agents.send', { sessionId: s.id, text: '이어서' })).rejects.toThrow(/Could not resume the conversation/)
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
    const internals = mgr as unknown as { meta: Map<string, { permissionPreset: string }> }
    internals.meta.get(s.id)!.permissionPreset = 'auto'

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

/**
 * 숨김의 의미: **Control Center 목록에서만 치운다.**
 * 도구(클로드·코덱스)에는 대화가 그대로 남으므로 '이전 대화'로 되찾을 수 있어야 한다.
 * 그 길이 막히면 숨김은 사실상 삭제가 된다.
 */
describe('치운 세션은 이전 대화 목록에서 되찾을 수 있다', () => {
  class ListingAdapter2 extends FakeAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [],
    }
    async listExternalSessions() {
      return [{ externalId: 'ext-past', title: '어제 하던 일', updatedAt: 111 }]
    }
    async readExternalHistory() {
      return [{ role: 'user' as const, text: '어제 하던 일' }]
    }
  }

  it('목록에 있는 동안은 "이미 불러옴", 치우면 다시 가져올 수 있다', async () => {
    const a = new ListingAdapter2()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }

    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude',
      resumeExternalId: 'ext-past', importHistory: true,
    })) as { id: string }

    // 목록에 있으면 또 열지 않도록 막는다 — 어느 세션으로 열려 있는지까지 알려준다
    const listed = (await m.listExternalSessions(p.id, 'claude', 30)).sessions[0]!
    expect(listed.imported).toBe(true)
    expect(listed.importedAs).toBe(s.id)

    await m.archive(s.id, true)

    // 치웠으면 되찾을 수 있어야 한다 — 여기서 막으면 숨김이 곧 삭제다
    expect((await m.listExternalSessions(p.id, 'claude', 30)).sessions[0]!.imported).toBe(false)
  })
})

/**
 * 도구(클로드·코덱스)에서 대화를 지웠을 때.
 *
 * 실측: 그냥 이어가려 하면 프로세스는 뜨고 첫 턴이 error_during_execution으로 죽는다.
 * 조용한 성공은 아니지만(그게 최악이다) 사용자에게는 원인을 전혀 알려주지 않는다.
 */
describe('도구에서 지워진 대화', () => {
  class GoneAdapter extends FakeAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [],
    }
    /** 도구가 갖고 있다고 답할 id 목록 */
    present: string[] = ['ext-1']
    failList = false
    async listExternalSessions() {
      if (this.failList) throw new Error('목록을 못 받았다')
      return this.present.map((externalId) => ({ externalId, title: externalId, updatedAt: 1 }))
    }
  }

  const setup = () => {
    const a = new GoneAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }

  it('지워진 대화를 이어가려 하면 무엇이 일어났는지 말해준다', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await m.archive(s.id, true)
    await m.archive(s.id, false)

    a.present = [] // 사용자가 클로드 코드에서 지웠다
    const r = await m.resumeSession(s.id)

    expect(r.resumed).toBe(false)
    expect(r.reason).toMatch(/was deleted in Claude Code/)
    // 기록은 읽을 수 있어야 한다 — 세션을 지워버리지 않는다
    expect(m.listSessions().find((x) => x.id === s.id)).toBeDefined()
  })

  it('목록을 못 받았으면 삭제로 단정하지 않는다 (도구가 잠깐 안 될 뿐일 수 있다)', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await m.archive(s.id, true)
    await m.archive(s.id, false)

    a.failList = true
    const r = await m.resumeSession(s.id)

    // 확인을 못 했다고 멀쩡한 세션을 막으면 도구가 잠깐 느린 것만으로 대화가 끊긴다
    expect(r.resumed).toBe(true)
  })

  it('이어받은 원본이 살아 있으면 지워진 것으로 보지 않는다', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    await m.archive(s.id, true)
    await m.archive(s.id, false)

    // resume이 새 id를 발급해 external_id는 ext-1이 아니지만, 원본은 남아 있다
    a.present = ['ext-1']
    expect((await m.resumeSession(s.id)).resumed).toBe(true)
  })
})

/**
 * 한 대화에 쓰는 쪽이 둘이면 도구가 거부한다
 * (codex: "thread … already has an active writer"). 원문은 사용자에게 아무것도
 * 설명하지 못하므로, 우리가 먼저 막고 **누가 쥐고 있는지** 알려준다.
 */
describe('같은 대화를 둘이 열지 않는다', () => {
  class ResumeAdapter extends FakeAdapter {
    async listExternalSessions() {
      return [{ externalId: 'ext-1', title: '어제 하던 일', updatedAt: 1 }]
    }
    async readExternalHistory() {
      return [{ role: 'user' as const, text: '어제 하던 일' }]
    }
  }
  const setup = () => {
    const a = new ResumeAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }

  it('이미 열려 있는 대화를 또 불러오려 하면 누가 쥐고 있는지 말한다', async () => {
    const { m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })

    await expect(
      call('agents.createSession', {
        projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
      }),
    ).rejects.toThrow(/already open in the ".*" session/)
    // 반쪽짜리 세션이 남지 않는다
    expect(m.listSessions()).toHaveLength(1)
  })

  it('쥐고 있던 세션이 잠들면 다시 열 수 있다', async () => {
    const { m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const first = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }

    await m.archive(first.id, true) // 프로세스가 정리되면 쥐고 있는 쪽이 없다

    const second = await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })
    expect(second).toBeTruthy()
  })
})

/**
 * Control Center에서 하다가 터미널의 도구로 옮겨 작업하고 돌아올 수 있다.
 * 그동안 오간 말은 도구에만 쌓이고 우리 화면은 멈춰 있다 — 모델은 다 기억하므로
 * **화면만 어긋나서** 더 헷갈린다. 깨울 때 따라잡는다.
 */
describe('밖에서 이어간 대화를 따라잡는다', () => {
  class SyncAdapter extends FakeAdapter {
    /** 도구가 갖고 있는 대화 (터미널에서 이어가면 여기가 늘어난다) */
    toolHistory: { role: 'user' | 'assistant'; text: string }[] = []
    async listExternalSessions() {
      return [{ externalId: 'ext-1', title: '대화', updatedAt: 1 }]
    }
    async readExternalHistory() {
      return this.toolHistory
    }
  }
  const setup = () => {
    const a = new SyncAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }
  const texts = async (call: ReturnType<typeof createRpcHandler>, id: string) =>
    ((await call('messages.load', { sessionId: id, limit: 200 })) as { payload: { text?: string } }[])
      .map((r) => r.payload.text)
      .filter(Boolean)

  it('밖에서 늘어난 뒷부분만 이어붙인다 (중복 없이)', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [
      { role: 'user', text: '첫 질문' },
      { role: 'assistant', text: '첫 답' },
    ]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    expect(await texts(call, s.id)).toEqual(['첫 질문', '첫 답'])

    await m.archive(s.id, true)
    await m.archive(s.id, false)

    // 그 사이 터미널에서 이어서 작업했다
    a.toolHistory.push({ role: 'user', text: '터미널에서 한 말' }, { role: 'assistant', text: '터미널 답' })

    await m.resumeSession(s.id)

    expect(await texts(call, s.id)).toEqual(['첫 질문', '첫 답', '터미널에서 한 말', '터미널 답'])
    expect(events.some((e) => e.type === 'history_synced')).toBe(true)
  })

  it('밖에서 아무 일도 없었으면 아무것도 붙이지 않는다', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: '첫 질문' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }

    await m.archive(s.id, true)
    await m.archive(s.id, false)
    await m.resumeSession(s.id)

    expect(await texts(call, s.id)).toEqual(['첫 질문'])
  })

  it('우리가 아는 마지막 말을 못 찾으면 붙이지 않는다 (같은 말을 두 번 쌓는 것보다 낫다)', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: '첫 질문' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }

    await m.archive(s.id, true)
    await m.archive(s.id, false)
    // 도구 기록이 통째로 달라졌다 (압축 등으로 앞부분이 사라진 경우)
    a.toolHistory = [{ role: 'user', text: '전혀 다른 대화' }]
    await m.resumeSession(s.id)

    expect(await texts(call, s.id)).toEqual(['첫 질문'])
  })
})

/**
 * Claude는 external id를 system/init로 **비동기로** 준다.
 * 그래서 세션을 만들고 말을 걸기 전에 새로고침하면 아직 없다
 * (도그푸딩: "세션 식별자를 불러오지 못했습니다").
 */
describe('재개 식별자가 아직 없을 때', () => {
  class LateIdAdapter extends FakeAdapter {
    override async createSession(opts: CreateSessionOpts, emit: EventSink) {
      const h = await super.createSession(opts, emit)
      h.externalId = null // 아직 도착하지 않았다
      return h
    }
  }
  const setup = () => {
    const a = new LateIdAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }

  it('오간 말이 없으면 그냥 새로 띄운다 (잃을 것이 없다)', async () => {
    const { m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as {
      id: string
    }

    const r = (await call('agents.restartSession', { sessionId: s.id })) as { resumed: boolean }
    expect(r.resumed).toBe(true)
    expect(m.isLive(s.id)).toBe(true)
  })

  it('기록이 있는데 식별자만 없으면 그때는 이유를 말한다', async () => {
    const { m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as {
      id: string
    }
    await call('agents.send', { sessionId: s.id, text: '남는 말' })

    const r = (await m.restartSession(s.id)) as { resumed: boolean; reason?: string }
    expect(r.resumed).toBe(false)
    expect(r.reason).toMatch(/Lost this session's resume id/)
  })
})

/**
 * 불러오기만 하고 말을 걸지 않은 세션은 external_id가 채워지지 않는다
 * (Claude는 그 값을 system/init로 비동기로 주기 때문). 그런데 그런 세션은
 * 정의상 **이어받은 원본**을 갖고 있다 — 그게 이어갈 대상이다.
 * 실측: ext=null · from=c1a50932 · 메시지 95개인 세션들이 있었다.
 */
describe('식별자가 없으면 이어받은 원본으로 재개한다', () => {
  class NoIdAdapter extends FakeAdapter {
    resumedWith: string | undefined
    override async createSession(opts: CreateSessionOpts, emit: EventSink) {
      this.resumedWith = opts.resumeExternalId
      const h = await super.createSession(opts, emit)
      h.externalId = null // 아직 안 왔다 (말을 걸어야 온다)
      return h
    }
    async listExternalSessions() {
      return [{ externalId: 'ext-origin', title: '원본', updatedAt: 1 }]
    }
    async readExternalHistory() {
      return [{ role: 'user' as const, text: '불러온 대화' }]
    }
  }

  it('external_id가 없어도 importedFrom으로 이어간다', async () => {
    const a = new NoIdAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }

    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude',
      resumeExternalId: 'ext-origin', importHistory: true,
    })) as { id: string }

    // 불러온 기록은 있는데 식별자는 비어 있는 상태 (실측된 그 상태)
    expect(m.listSessions().find((x) => x.id === s.id)!.externalId).toBeNull()
    expect((await call('messages.load', { sessionId: s.id, limit: 10 })) as unknown[]).not.toHaveLength(0)

    await m.archive(s.id, true)
    await m.archive(s.id, false)
    a.resumedWith = undefined

    const r = await m.resumeSession(s.id)

    expect(r.resumed).toBe(true)
    expect(a.resumedWith).toBe('ext-origin') // 원본으로 이어갔다
  })
})

/**
 * 오케스트레이터의 도구 (FR-11).
 *
 * **여기가 접근 범위의 경계다.** 이 도구들이 볼 수 있는 것이 곧 오케스트레이터가
 * 할 수 있는 전부다 — 규칙으로 막는 게 아니라 볼 수 있는 것이 그것뿐이어야 한다.
 */
describe('오케스트레이터 도구는 이 앱의 세션만 본다', () => {
  const setup = async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const orc = (await rpc('orchestrator.get', {})) as { id: string }
    // 도구는 세션을 만들 때 어댑터에 전달된다 — 그 인스턴스를 그대로 시험한다
    const tools = adapter.lastOrchestratorTools!
    return { p, a, orc, tools }
  }

  it('목록에 자기 자신은 없다 — 자기에게 시키면 고리가 된다', async () => {
    const { a, orc, tools } = await setup()
    const list = await tools.listSessions()
    expect(list.map((s) => s.sessionId)).toContain(a.id)
    expect(list.map((s) => s.sessionId)).not.toContain(orc.id)
  })

  it('보관된 세션도 없다', async () => {
    const { a, tools } = await setup()
    await rpc('agents.archiveSession', { sessionId: a.id, archived: true })
    expect((await tools.listSessions()).map((s) => s.sessionId)).not.toContain(a.id)
  })

  it('세션에 일을 시키면 실제로 전달된다', async () => {
    const { a, tools } = await setup()
    expect(await tools.sendToSession(a.id, '테스트 고쳐줘')).toEqual({ ok: true })
    expect(adapter.handleOf(a.id)?.sent).toContain('테스트 고쳐줘')
  })

  it('모르는 세션은 이유를 돌려준다 — 조용히 삼키지 않는다', async () => {
    const { tools } = await setup()
    const r = await tools.sendToSession('남의-세션-id', '안녕')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/관리하는 세션이 아닙니다/)
  })

  it('자기 자신에게는 보낼 수 없다', async () => {
    const { orc, tools } = await setup()
    const r = await tools.sendToSession(orc.id, '나에게')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/자기 자신/)
  })

  it('reportBack 없이 보내면 끝나도 조용하다', async () => {
    const { a, orc, tools } = await setup()
    const before = adapter.handleOf(orc.id)!.sent.length
    await tools.sendToSession(a.id, '조용히 해줘')
    // 대상 세션의 턴이 끝난다
    adapter.handleOf(a.id)!.finishTurn()
    await new Promise((r) => setTimeout(r, 0))
    expect(adapter.handleOf(orc.id)!.sent.length).toBe(before)
  })

  it('reportBack이면 끝났을 때 오케스트레이터에게 한 번 알린다', async () => {
    const { a, orc, tools } = await setup()
    await tools.sendToSession(a.id, '끝나면 알려줘', true)
    adapter.handleOf(a.id)!.finishTurn()
    await new Promise((r) => setTimeout(r, 0))
    const sent = adapter.handleOf(orc.id)!.sent
    expect(sent.some((t) => t.includes('마쳤습니다'))).toBe(true)
  })

  /*
   * 이 기능의 유일한 위험: 서로 깨우는 고리.
   * 한 번 알린 뒤에도 표식이 남아 있으면, 그 세션이 이후 스스로 도는 턴마다
   * 오케스트레이터를 깨우고 그때마다 턴 값이 든다.
   */
  it('한 번만 알린다 — 그 세션이 계속 돌아도 다시 깨우지 않는다', async () => {
    const { a, orc, tools } = await setup()
    await tools.sendToSession(a.id, '끝나면 알려줘', true)
    for (let i = 0; i < 3; i++) {
      adapter.handleOf(a.id)!.finishTurn()
      await new Promise((r) => setTimeout(r, 0))
    }
    const reports = adapter.handleOf(orc.id)!.sent.filter((t) => t.includes('마쳤습니다'))
    expect(reports.length).toBe(1)
  })

  it('평범한 세션에는 도구가 붙지 않는다 — 오케스트레이터만 받는다', async () => {
    const p = await addProject()
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })
    expect(adapter.lastOrchestratorTools).toBeUndefined()
  })
})
