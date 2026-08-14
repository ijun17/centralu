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
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: ['image'],
  }
  last: FakeHandle | null = null
  async detect() { return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' } }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
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
