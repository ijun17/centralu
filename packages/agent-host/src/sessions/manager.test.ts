/** T3-3 완료 기준: 인메모리 어댑터 목으로 RPC 통합 검증 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AdapterCapabilities, ApprovalDecision, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
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
  /** 프로세스를 갈아 끼우면 매달린 승인 맵이 비어서 뜬다 — 그 상태를 흉내낸다 */
  approvalsLost = false
  dropApprovals() { this.approvalsLost = true }
  respondApproval(requestId: string, decision: ApprovalDecision): boolean {
    if (this.approvalsLost) return false
    this.approvals.push({ requestId, decision })
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    return true
  }
  interrupt() {}
  /** 턴이 끝났다고 알린다 (보고 되돌아오기 테스트용) */
  finishTurn() { this.emit({ type: 'turn_complete', sessionId: this.sessionId }) }
  /** 스트리밍 조각 하나 (실제 저장 형태를 그대로 재현한다) */
  emitDelta(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
  }
  emitToolCall(tool: string, title: string) {
    this.emit({
      type: 'tool_call',
      sessionId: this.sessionId,
      callId: `c-${title.length}`,
      summary: { tool, title, readOnly: false, paths: [] },
    })
  }
  /**
   * 컨텍스트 사용량 한 번 (#48).
   *
   * 도구는 **턴 끝에 한 번** 답한다 — claude는 `result` 메시지에서, codex는 tokenUsage에서.
   * 두 어댑터 모두 이 한 가지 이벤트로 들어오므로 여기서 흉내내는 것으로 둘 다 덮는다.
   */
  emitContext(used: number, window: number) {
    this.emit({ type: 'context_update', sessionId: this.sessionId, used, window, exactness: 'exact' })
  }
  /** 승인 요청 하나 (재연결 복원 테스트용 — detail이 목록에 실려야 카드를 다시 그린다) */
  emitApproval(requestId: string) {
    this.emit({
      type: 'approval_request',
      sessionId: this.sessionId,
      requestId,
      detail: { kind: 'command', command: 'rm -rf node_modules', cwd: '/tmp' },
    })
  }
  async dispose() { this.disposed = true }
}

class FakeAdapter implements AgentAdapter {
  tool: ToolName = 'claude'
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: ['image'], verbosities: [],
  }
  last: FakeHandle | null = null
  /** 오케스트레이터에게만 오는 도구 — 붙는지/안 붙는지를 테스트가 본다 */
  lastOrchestratorTools: OrchestratorTools | undefined
  private handles = new Map<string, FakeHandle>()
  handleOf(id: string) { return this.handles.get(id) }
  /** 도구가 뜨지 못하는 상황을 만든다 (되살리기 실패 경로) */
  /** 문자열이면 그 문구로, Error면 그대로 던진다 (code를 실어 보낼 때) */
  failCreate: string | Error | null = null
  /** 도구가 뜨다 **멈추는** 상황 — 실패도 성공도 아닌 채로 (MGH 재개 사고의 모양) */
  hangCreate = false
  /** 멈춘 뒤에도 프로세스는 떠 있었을 수 있다 — 늦게 도착한 핸들을 매니저가 거두는지 본다 */
  lateHandle: FakeHandle | null = null
  resolveLate: (() => void) | null = null
  async detect() { return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' } }
  /** 어느 디렉토리에서 띄웠나 — 워크트리 세션이 정말 격리됐는지 보는 유일한 증거다 */
  lastCwd: string | null = null
  /** 마지막 세션이 어떤 옵션으로 떴나 — 설정이 프로세스까지 닿았는지의 유일한 증거 */
  lastOpts: CreateSessionOpts | null = null
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    this.lastOpts = opts
    if (this.failCreate) throw typeof this.failCreate === 'string' ? new Error(this.failCreate) : this.failCreate
    if (this.hangCreate) {
      await new Promise<void>((r) => (this.resolveLate = r))
      const h = new FakeHandle(opts.sessionId, emit)
      this.lateHandle = h
      return h
    }
    this.lastCwd = opts.cwd
    this.lastOrchestratorTools = opts.orchestratorTools
    this.last = new FakeHandle(opts.sessionId, emit)
    /*
     * **이어받은 대화의 id를 그대로 보고한다** — 실제 어댑터가 그렇게 한다
     * (codex는 thread/resume이 돌려준 threadId를, claude는 SDK의 session_id를 쓴다).
     * 늘 같은 값을 답하게 두면, 갈라져 나온 사본을 가리키게 만들어도 매니저가
     * 원본으로 되돌려 버리는 것을 테스트가 못 잡는다.
     */
    if (opts.resumeExternalId) this.last.externalId = opts.resumeExternalId
    this.handles.set(opts.sessionId, this.last)
    return this.last
  }
}

let store: Store
let adapter: FakeAdapter
let codexAdapter: FakeAdapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  store = new Store()
  adapter = new FakeAdapter()
  events = []
  // codex도 등록한다 — 도구 전환을 시험하려면 갈아 끼울 대상이 있어야 한다
  codexAdapter = new FakeAdapter()
  ;(codexAdapter as { tool: ToolName }).tool = 'codex'
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter], ['codex', codexAdapter]])
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

  /*
   * 사이드바의 변경 수는 턴이 끝날 때마다 이 문으로 다시 물어본다 (이슈 #41).
   * 그래서 **하나만** 재는 길이어야 한다 — 목록을 통째로 만들고 한 줄만 남기면
   * 턴 한 번에 등록된 프로젝트 수만큼 git status가 돈다.
   */
  it('gitStatus는 물어본 프로젝트 하나를 돌려주고, 모르는 id는 거절한다', async () => {
    const p = await addProject()
    const one = (await rpc('projects.gitStatus', { projectId: p.id })) as { id: string; path: string }
    expect(one.id).toBe(p.id)
    expect(one.path).toBe(p.path)
    await expect(rpc('projects.gitStatus', { projectId: 'nope' })).rejects.toThrow(/Project not found/)
  })

  /*
   * 마지막에 고른 도구가 그 프로젝트의 기본값이 된다 (2026-08-27 흐름 점검).
   *
   * default_tool은 프로젝트를 만들 때 'claude'로 박힌 뒤 갱신되는 자리가 **없었다** —
   * codex를 쓰는 사람은 새 세션마다 영원히 필을 다시 눌렀다. 설정 화면이 아니라
   * 세션을 만드는 행위가 이 사실을 말하므로, UI든 오케스트레이터든 같은 규칙을 받는다.
   */
  it('세션을 만들면 그 도구가 프로젝트 기본값이 된다', async () => {
    const p = await addProject()
    const list = async () => ((await rpc('projects.list', {})) as { id: string; defaultTool: string }[])
    expect((await list()).find((x) => x.id === p.id)!.defaultTool).toBe('claude')

    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })
    expect((await list()).find((x) => x.id === p.id)!.defaultTool).toBe('codex')

    // 되돌아오는 것도 같은 길이다 — 마지막 선택이 언제나 이긴다
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })
    expect((await list()).find((x) => x.id === p.id)!.defaultTool).toBe('claude')
  })
})

describe('세션 수명주기', () => {
  /*
   * host가 죽으면 세션 프로세스도 함께 죽는다. 그런데 DB에는 마지막 상태가 남아 있어서
   * 다시 켜면 프로세스가 하나도 없는데 화면은 영원히 '작업 중'이다 (도그푸딩: 40분 넘게
   * working에 갇힘 / 아카이브→복구로만 풀림 — archive가 state를 idle로 되돌리기 때문).
   */
  it('기동 시 프로세스 없는 working·waiting_approval을 idle로 바로잡는다', async () => {
    const p = await addProject()
    const live = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: live.id, text: '안녕' })
    expect((store.listSessions().find((s) => s.id === live.id)!).state).toBe('working')

    // host 재기동 — 같은 store로 매니저를 새로 만든다 (프로세스는 하나도 없다)
    const restarted = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', adapter]]), (e) => events.push(e))
    const after = (await createRpcHandler(restarted, new Map<ToolName, AgentAdapter>([['claude', adapter]]))('sessions.list', {})) as {
      id: string
      state: string
    }[]

    expect(after.find((s) => s.id === live.id)!.state).toBe('idle')
    // 화면만이 아니라 DB도 바로잡혀야 한다 — 다음 기동에서 되살아나면 안 된다
    expect(store.listSessions().find((s) => s.id === live.id)!.state).toBe('idle')
  })

  /*
   * 컨텍스트 눈금이 재시작 뒤 비어 있었다 (이슈 #48).
   *
   * 읽은 값은 처음부터 옳았다 — 저장되지 않았을 뿐이다. 그래서 다시 켜면 그 세션이
   * **다시 한 턴을 돌기 전까지** 눈금이 비어 있었고, 화면에는 고장 난 계기로 보였다.
   * 승인·질문 같은 다른 살아-있는-동안 필드와 달리 이것은 우리 프로세스의 사실이 아니라
   * **대화의 사실**이라, host보다 오래 살아야 한다.
   */
  it('컨텍스트 사용량은 host를 껐다 켜도 남는다 (#48)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    // 턴이 끝나며 도구가 답한다 — 이 앱이 이 값을 받는 유일한 순간이다
    adapter.handleOf(s.id)!.emitContext(168_000, 200_000)

    // host 재기동 — 같은 store로 매니저를 새로 만든다 (메모리에 있던 것은 전부 사라졌다)
    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter], ['codex', codexAdapter]])
    const restarted = new SessionManager(store, adapters, () => {})
    const after = (await createRpcHandler(restarted, adapters)('sessions.list', {})) as SessionInfo[]

    expect(after.find((x) => x.id === s.id)!.context).toEqual({ used: 168_000, window: 200_000, exactness: 'exact' })
    // 한 번도 답한 적 없는 세션은 여전히 모른다 — `—`와 `0%`의 구분이 여기서 시작된다
    const quiet = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })) as { id: string }
    expect(store.listSessions().find((x) => x.id === quiet.id)!.context).toBeNull()
  })

  /*
   * /clear가 대화 id를 갈아치운다 (실측 2026-08-26): claude는 /clear에 **새 session_id**로
   * 새 init을 내고, 어댑터는 핸들의 externalId를 그 값으로 갱신한다. onEvent의 따라잡기가
   * 이 값을 DB까지 나르지 않으면, 다음 재개가 옛 id로 붙어 **지운 대화가 되살아난다.**
   * (codex는 실측상 /clear류가 없다 — 스레드 id가 살아 있는 동안 안 바뀐다)
   */
  it('/clear로 대화 id가 바뀌면 다음 이벤트에 DB까지 따라온다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    expect(store.listSessions().find((x) => x.id === s.id)!.externalId).toBe('ext-1')

    const h = adapter.handleOf(s.id)!
    h.externalId = 'ext-after-clear' // 어댑터가 새 init에서 갱신한 상태
    h.finishTurn() // /clear의 턴이 끝나며 이벤트가 흐른다

    expect(store.listSessions().find((x) => x.id === s.id)!.externalId).toBe('ext-after-clear')
  })

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

  /*
   * 이름 바꾸기가 실패했는데 UI가 성공한 얼굴을 하는 일이 없어야 한다 (이슈 #5).
   * 예전에는 세션이 없으면 조용히 return이었고 RPC는 그대로 {ok:true}였다.
   */
  it('없는 세션의 이름을 바꾸려 하면 실패로 돌아온다', async () => {
    await expect(rpc('sessions.rename', { sessionId: 'nope', name: '내 세션' })).rejects.toThrow(/not found/i)
  })

  it('빈 이름은 거부한다 — 목록에서 아무것도 못 가리키는 줄이 된다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await expect(rpc('sessions.rename', { sessionId: s.id, name: '   ' })).rejects.toThrow(/empty/i)
    const list = (await rpc('sessions.list', {})) as { name: string }[]
    expect(list[0]!.name).toBe('New session')
  })

  it('사람이 정한 이름은 auto:false로 알린다 — 받는 쪽이 자동 이름을 막을 근거다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('sessions.rename', { sessionId: s.id, name: '가드 MCP' })
    const titles = events.filter((e) => e.type === 'session_title') as { title: string; auto: boolean }[]
    expect(titles.at(-1)).toMatchObject({ title: '가드 MCP', auto: false })
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

  /*
   * 도그푸딩에서 세션이 통째로 막혔다: 화면에는 "Awaiting approval"이 떠 있는데
   * 눌러도 아무 반응이 없고, 정작 백엔드의 세션 상태는 idle이었다.
   *
   * 원인은 프로세스 교체다. 권한 프리셋을 바꾸면 매니저가 프로세스를 갈아 끼우는데
   * (updateSettings의 drift 경로), 새 프로세스의 승인 맵은 비어 있다. 그래서 그 전에 뜬
   * 카드의 requestId는 어디에도 없고, 어댑터는 **조용히 return**했다 —
   * 화면은 답을 기다리며 영원히 남는다.
   */
  it('사라진 승인에 답하면 말해 주고, 화면의 카드도 걷어준다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    adapter.last!.dropApprovals() // 프로세스가 갈아 끼워진 상태

    await expect(
      rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r-오래된', decision: 'allow' }),
    ).rejects.toMatchObject({ code: 'approval_gone' })

    // 카드를 걷을 근거가 화면에 도착해야 한다 — 아니면 눌러도 안 사라지는 카드가 남는다
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'approval_resolved', sessionId: s.id, requestId: 'r-오래된' }),
    )
  })

  it("사라진 승인은 '항상 허용' 규칙을 남기지 않는다", async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    adapter.last!.dropApprovals()

    await expect(
      rpc('agents.respondApproval', { sessionId: s.id, requestId: 'r1', decision: 'always', matcher: 'git push' }),
    ).rejects.toMatchObject({ code: 'approval_gone' })

    // 실행되지도 않은 명령을 항상 허용으로 기억해 두면 다음에 조용히 통과한다
    expect(await rpc('approvals.rules', {})).toEqual([])
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
    // 등록된 어댑터를 그대로 돌려준다 (개수가 아니라 내용을 본다 — 하네스가 늘어도 안 깨진다)
    const found = (await rpc('agents.detect', {})) as { tool: string }[]
    expect(found.map((x) => x.tool)).toContain('claude')
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
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [],
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

  /*
   * 응답 길이(#54)는 effort와 달리 turn 단위로 못 바꾼다 (codex의 turn/start에 자리가
   * 없다). 그래서 이 설정이 실제가 되는 길은 **갈아 끼우기**뿐이고, 새 프로세스가
   * 그 값으로 떴는지까지 봐야 배관이 끝까지 이어졌다고 말할 수 있다.
   */
  it('응답 길이를 바꾸면 갈아 끼우고, 새 프로세스가 그 값으로 뜬다 (#54)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const before = adapter.last!

    await rpc('agents.updateSettings', { sessionId: s.id, verbosity: 'low' })

    expect(before.disposed).toBe(true)
    expect(adapter.last).not.toBe(before)
    expect(adapter.lastOpts?.verbosity).toBe('low')
    expect(mgr.listSessions().find((x) => x.id === s.id)!.verbosity).toBe('low')
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
 * 숨김의 의미: **Centralu 목록에서만 치운다.**
 * 도구(클로드·코덱스)에는 대화가 그대로 남으므로 '이전 대화'로 되찾을 수 있어야 한다.
 * 그 길이 막히면 숨김은 사실상 삭제가 된다.
 */
describe('치운 세션은 이전 대화 목록에서 되찾을 수 있다', () => {
  class ListingAdapter2 extends FakeAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [],
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
 * When the tool has no record of the conversation we are trying to resume.
 *
 * Measured: resuming anyway starts the process and the first turn dies with
 * error_during_execution — not a silent success (that would be worst), but it tells the user
 * nothing about the cause.
 *
 * And the cause is not necessarily a deletion. The tool files conversations **by working
 * directory**, so "not found" also means "this folder moved" — which is what actually happened
 * in issue #28. These tests hold the message to the observation.
 */
describe('도구가 대화를 못 찾을 때', () => {
  class GoneAdapter extends FakeAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [],
    }
    /** 도구가 갖고 있다고 답할 id 목록 */
    present: string[] = ['ext-1']
    failList = false
    async listExternalSessions() {
      if (this.failList) throw new Error('목록을 못 받았다')
      return this.present.map((externalId) => ({ externalId, title: externalId, updatedAt: 1 }))
    }
    /** 갈라진 원본 id — 원본을 건드리지 않았는지 테스트가 본다 */
    forkedFrom: string | null = null
    /** 끄면 '이 도구는 갈라질 수 없다'가 된다 (선택 메서드가 곧 능력이다) */
    canFork = true
    forkConversation = async (externalId: string) => {
      if (!this.canFork) throw new Error('unreachable — canFork=false면 메서드가 없어야 한다')
      this.forkedFrom = externalId
      this.present = [...this.present, 'forked-1']
      return 'forked-1'
    }
  }

  const setup = () => {
    const a = new GoneAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }

  it('못 찾았다고만 말한다 — 지워졌다고 하지 않는다', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    const startedIn = a.lastCwd
    await m.archive(s.id, true)
    await m.archive(s.id, false)

    a.present = [] // the tool no longer lists it — an absence is all we actually know
    const r = await m.resumeSession(s.id)

    expect(r.resumed).toBe(false)
    /*
     * This used to assert `/was deleted in Claude Code/` — the test was pinning the lie in
     * place. All the tool reported was an absence, and an absence has two causes we cannot
     * tell apart from here: removed there, or the folder moved (issue #28). So: report the
     * observation, name the directory we looked in, claim no deletion nobody witnessed.
     */
    expect(r.reason).toMatch(/has no record of this conversation/)
    expect(r.reason).toContain(startedIn!)
    expect(r.reason).not.toMatch(/delete/i)
    // 기록은 읽을 수 있어야 한다 — 세션을 지워버리지 않는다
    expect(m.listSessions().find((x) => x.id === s.id)).toBeDefined()
  })

  /*
   * codex는 한 대화에 쓰는 쪽을 하나로 제한한다("already has an active writer").
   * 예전에는 그 실패가 화면까지 오는 동안 "codex app-server exited"로 덮여서,
   * 사람은 죽지도 않은 프로세스가 죽었다는 말을 들었고 빠져나갈 길도 못 받았다.
   * 이유는 문장이 아니라 **신호**로 와야 UI가 갈림길을 내밀 수 있다.
   */
  it('다른 쪽이 대화를 쥐고 있으면 잠겼다는 신호를 함께 준다', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await m.archive(s.id, true)
    await m.archive(s.id, false)

    a.failCreate = Object.assign(new Error('This conversation is already open elsewhere'), {
      code: 'conversation_locked',
    })
    const r = await m.resumeSession(s.id)

    expect(r.resumed).toBe(false)
    expect(r.lockedElsewhere).toBe(true)
  })

  it('갈라서 이어가면 원본은 그대로 두고 사본을 가리킨다', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    const before = m.listSessions().find((x) => x.id === s.id)!.externalId
    await m.archive(s.id, true)
    await m.archive(s.id, false)

    const r = await m.forkConversation(s.id)

    expect(r.resumed).toBe(true)
    expect(a.forkedFrom).toBe(before)
    // 이 세션은 이제 사본을 가리킨다 — 원본을 다시 잡으러 가면 또 잠긴다
    expect(m.listSessions().find((x) => x.id === s.id)!.externalId).toBe('forked-1')
  })

  it('갈라질 수 없는 도구면 조용히 넘기지 않고 그렇다고 말한다', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    // 능력은 플래그가 아니라 **메서드의 유무**로 표현된다 (contract.ts의 규칙)
    delete (a as { forkConversation?: unknown }).forkConversation

    const r = await m.forkConversation(s.id)

    expect(r.resumed).toBe(false)
    expect(r.reason).toMatch(/cannot fork/)
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
 * Centralu에서 하다가 터미널의 도구로 옮겨 작업하고 돌아올 수 있다.
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
/**
 * 도구가 뜨다 **멈추면** 그 사실이 이유가 되어 돌아와야 한다 (MGH 재개 사고).
 *
 * 상한 없이 기다리면 바깥 RPC가 30초에 "RPC timed out"으로 포기하는데, 매니저의
 * 진행 중(resuming) 약속은 안 풀린 채라 Retry가 **그 멈춘 약속에 다시 합류했다** —
 * 화면에는 Retry가 있는데 아무것도 재시도되지 않는 상태. 이제 25초에 단계 이름을
 * 붙여 실패하고, 그 순간 resuming이 풀려 Retry가 진짜 재시도가 된다.
 */
describe('되살리기가 멈출 때', () => {
  it('멈춘 spawn은 단계 이름을 붙여 실패하고, Retry는 새로 시작한다', async () => {
    const s = await rpc('agents.createSession', { projectId: (await addProject()).id, cwd: tmpdir(), tool: 'claude' }) as { id: string }
    await mgr.archive(s.id, true)
    await mgr.archive(s.id, false)

    vi.useFakeTimers()
    try {
      adapter.hangCreate = true
      const attempt = mgr.resumeSession(s.id)
      await vi.advanceTimersByTimeAsync(25_100)
      const r = await attempt
      expect(r.resumed).toBe(false)
      expect(r.reason).toMatch(/Starting claude did not finish within 25s/)

      // Retry는 멈춘 약속에 합류하지 않고 새로 뜬다 — 이번엔 정상 spawn
      adapter.hangCreate = false
      const retry = mgr.resumeSession(s.id)
      await vi.advanceTimersByTimeAsync(1)
      expect((await retry).resumed).toBe(true)

      // 멈췄던 spawn이 늦게 도착하면 매니저가 거둔다 — 안 거두면 스레드를 쥔 프로세스가 샌다
      adapter.resolveLate!()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(adapter.lateHandle!.disposed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

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

  /*
   * 시킨 말에는 출처가 남는다 (FR-11 잔여분).
   * 저장까지는 됐지만 사람 말과 똑같은 행이었다 — "내가 이런 걸 시켰던가?"를
   * 화면이 답하려면 행 자체에 누가 보냈는지가 실려 있어야 한다.
   */
  it('시킨 말은 payload에 출처(from)를 싣고 저장된다', async () => {
    const { a, orc, tools } = await setup()
    await tools.sendToSession(a.id, '출처 확인용')
    const rows = (await rpc('messages.load', { sessionId: a.id, limit: 10 })) as {
      role: string
      payload: { text?: string; from?: { sessionId: string; name: string } }
    }[]
    const row = rows.find((r) => r.payload?.text === '출처 확인용')
    expect(row?.role).toBe('user')
    expect(row?.payload.from?.sessionId).toBe(orc.id)
  })

  it('보고 회신에도 출처(워커 세션)가 실린다', async () => {
    const { a, orc, tools } = await setup()
    await tools.sendToSession(a.id, '끝나면 알려줘', true)
    adapter.handleOf(a.id)!.finishTurn()
    await new Promise((r) => setTimeout(r, 0))
    const rows = (await rpc('messages.load', { sessionId: orc.id, limit: 20 })) as {
      payload: { text?: string; from?: { sessionId: string } }
    }[]
    const report = rows.find((r) => r.payload?.text?.includes('[Centralu]'))
    expect(report?.payload.from?.sessionId).toBe(a.id)
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
    const report = sent.find((t) => t.includes('[Centralu]'))
    expect(report).toBeTruthy()
    /*
     * **이름만으로는 어느 세션인지 모른다.** 압축을 이어받은 세션은 이름이 전부
     * "This session is being continued from a p…"라 실제로 네 개가 같은 이름이었다.
     * 잘못 짚으면 엉뚱한 프로젝트에 지시가 간다 — id가 반드시 실려야 한다.
     */
    expect(report).toContain(a.id)
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
    const reports = adapter.handleOf(orc.id)!.sent.filter((t) => t.includes('[Centralu]'))
    expect(reports.length).toBe(1)
  })

  /*
   * 스트리밍 조각은 하나의 메시지로 저장된다 (#66). 턴이 끝나면 그 행이 확정되고,
   * 미리보기·read_session은 조각이 아니라 완성된 문장을 읽는다.
   */
  it('미리보기는 조각이 아니라 이어붙인 응답이다', async () => {
    const { a, tools } = await setup()
    const h = adapter.handleOf(a.id)!
    for (const part of ['원인은 ', '델타를 ', '이어붙이지 ', '않은 것입니다.']) {
      h.emitDelta(part)
    }
    h.finishTurn() // 스트림이 닫히며 지금까지의 본문이 한 행으로 남는다 (#66)
    await new Promise((r) => setTimeout(r, 0))
    const list = await tools.listSessions()
    expect(list.find((s) => s.sessionId === a.id)?.preview).toBe('원인은 델타를 이어붙이지 않은 것입니다.')
  })

  it('read_session은 조각을 한 줄로 모아 돌려준다', async () => {
    const { a, tools } = await setup()
    const h = adapter.handleOf(a.id)!
    for (const part of ['앞부분 ', '뒷부분']) h.emitDelta(part)
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    const r = await tools.readSession(a.id)
    expect(r.ok).toBe(true)
    // 시각이 앞에 붙는다 — 보는 것은 조각이 이어졌는가다
    expect(r.lines!.some((l) => l.endsWith('에이전트: 앞부분 뒷부분'))).toBe(true)
  })

  /*
   * 도구 호출 본문이 대화를 덮던 문제 (도그푸딩: limit 50인데 python 스크립트 전문과
   * 커밋 메시지 전문이 대부분이었다). 기본은 한 줄로 접고 필요할 때만 펼친다.
   */
  it('read_session은 도구 호출을 기본으로 접는다', async () => {
    const { a, tools } = await setup()
    const h = adapter.handleOf(a.id)!
    h.emitToolCall('Bash', 'python3 - <<EOF\n아주 긴 스크립트 본문\n두 번째 줄\nEOF')
    await new Promise((r) => setTimeout(r, 0))

    const folded = (await tools.readSession(a.id)).lines!.join('\n')
    expect(folded).not.toContain('두 번째 줄')
    expect(folded).toContain('python3')

    const opened = (await tools.readSession(a.id, 40, { tools: true })).lines!.join('\n')
    expect(opened).toContain('두 번째 줄')
  })

  it('read_session도 이 앱의 세션만 읽는다', async () => {
    const { orc, tools } = await setup()
    expect((await tools.readSession('남의-세션')).error).toMatch(/관리하는 세션이 아닙니다/)
    expect((await tools.readSession(orc.id)).error).toMatch(/자기 자신/)
  })

  /*
   * 겉은 오케스트레이터인데 도구도 역할도 없는 세션이 가장 나쁘다.
   * codex 어댑터는 orchestratorTools를 아직 쓰지 않으므로 바꾸는 것을 막는다.
   */
  it('오케스트레이터도 codex로 바꿀 수 있다 (다리로 도구가 붙는다)', async () => {
    const { orc } = await setup()
    const r = await mgr.switchTool(orc.id, 'codex')
    expect(r.tool).toBe('codex')
  })

  /*
   * 다리는 별도 프로세스라 토큰만 있으면 무엇이든 부를 수 있다.
   * 그 문으로 다른 세션이 남의 세션에 지시하게 두면 접근 범위가 구조가 아니라 약속이 된다.
   */
  it('도구 실행 문은 오케스트레이터만 열 수 있다', async () => {
    const { a, orc } = await setup()
    await expect(mgr.runOrchestratorTool(a.id, 'list_sessions', {})).rejects.toThrow(/오케스트레이터만/)
    const r = await mgr.runOrchestratorTool(orc.id, 'list_sessions', {})
    expect(r.text).toContain(a.id)
  })

  it('평범한 세션은 바꿀 수 있다', async () => {
    const { a } = await setup()
    const r = await mgr.switchTool(a.id, 'codex')
    expect(r.tool).toBe('codex')
    // 새 도구는 옛 대화를 모른다 — 이어갈 실마리를 끊는다
    expect(r.externalId).toBeNull()
  })

  /**
   * 모델 id는 도구의 어휘다.
   *
   * 실측(smoke-switch-tool): claude에서 sonnet을 고른 세션을 codex로 바꾸면
   * 프로세스는 뜨는데 첫 턴이 400으로 죽었다 —
   * "The 'sonnet' model is not supported when using Codex with a ChatGPT account."
   * 도구를 바꾸는 기능이 고장 난 게 아니라, 도구에만 뜻이 있는 값을 들고 넘어갔던 것이다.
   */
  /**
   * 오케스트레이터는 앱에 하나뿐인 상주 상대다 — 도구를 바꿨다고 처음 만난 사이가
   * 되면 안 된다. 도구의 문맥은 되살릴 수 없지만 우리 기록은 남아 있으므로,
   * 새 프로세스에 지난 대화를 요약해 넘긴다 (resume이 아니라 인계).
   */
  it('도구를 바꾼 오케스트레이터는 지난 대화를 넘겨받는다', async () => {
    const orc = await mgr.orchestrator()
    await mgr.send(orc.id, '알파 프로젝트 상태 좀 봐줘')
    mgr['store'].appendMessages([
      {
        sessionId: orc.id, seq: mgr['store'].nextSeq(orc.id), role: 'assistant', kind: 'text',
        payload: { text: '알파는 테스트 두 개가 깨져 있습니다' }, ts: Date.now(),
      },
    ])

    await mgr.switchTool(orc.id, 'codex')
    await mgr.resumeSession(orc.id)

    const handed = codexAdapter.lastOpts?.systemPromptAppend ?? ''
    expect(handed).toContain('지난 대화')
    expect(handed).toContain('알파 프로젝트 상태')
    expect(handed).toContain('테스트 두 개가 깨져')
    // 역할도 함께 간다 — 기억만 있고 자기가 누구인지 모르면 반쪽이다
    expect(handed).toContain('오케스트레이터')
  })

  it('도구를 바꾸면 모델·강도·응답길이·티어를 놓는다 — 옆 도구의 사전에 없는 낱말이다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'safe', model: 'sonnet', effort: 'max',
    })) as { id: string }

    const r = await mgr.switchTool(s.id, 'codex')
    expect(r.model).toBeNull()
    expect(r.effort).toBeNull()
    expect(r.verbosity).toBeNull()
    expect(r.serviceTier).toBeNull()
    // 다음에 깰 때 어댑터가 받는 것도 비어 있어야 한다 — 저장만 지우면 반쪽이다
    await mgr.resumeSession(s.id)
    expect(codexAdapter.lastOpts?.model).toBeUndefined()
    expect(codexAdapter.lastOpts?.effort).toBeUndefined()
    // 권한은 사람이 정한 방침이라 도구를 건너 살아남는다
    expect(codexAdapter.lastOpts?.permissionPreset).toBe('safe')
  })

  it('평범한 세션에는 도구가 붙지 않는다 — 오케스트레이터만 받는다', async () => {
    const p = await addProject()
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })
    expect(adapter.lastOrchestratorTools).toBeUndefined()
  })

  /*
   * recall이 짚어준 seq로 읽으러 왔는데 창 끝머리만 보이던 문제.
   * around가 있으면 그 대목이 **창 가운데**에 와야 한다 — 아니면
   * "찾았는데 갈 수가 없는" 상태가 그대로 남는다.
   */
  it('read_session의 around는 그 대목을 가운데에 두고 자른다', async () => {
    const { a, tools } = await setup()
    // 사람 30마디 + 답 30개 = seq 1..60 (send마다 사용자 행과 에코 델타가 한 쌍)
    for (let i = 1; i <= 30; i++) await rpc('agents.send', { sessionId: a.id, text: `메시지 ${i}번` })

    // '메시지 15번'의 seq는 29 (i번째 send의 사용자 행이 2i-1)
    const r = await tools.readSession(a.id, 10, { around: 29 })
    const joined = r.lines!.join('\n')
    expect(joined).toContain('메시지 15번')
    // 꼬리를 자른 게 아니라는 증거 — 끝머리는 창에 없어야 한다
    expect(joined).not.toContain('메시지 30번')
  })
})

/**
 * 잠든 세션에 말이 **동시에** 두 번 오면 (사람 + 오케스트레이터가 흔한 조합)
 * 둘 다 "프로세스가 없다"를 보고 각자 되살렸다 — 프로세스가 둘 뜨고
 * 먼저 뜬 쪽은 핸들 맵에서 밀려나 dispose 없이 영영 고아가 됐다 (TOCTOU).
 */
describe('동시에 말을 걸어도 되살리기는 한 번이다', () => {
  class SlowAdapter extends FakeAdapter {
    creations = 0
    override async createSession(opts: CreateSessionOpts, emit: EventSink) {
      this.creations++
      // 진짜 어댑터는 프로세스가 뜨는 데 시간이 걸린다 — 그 창에서 경쟁이 난다
      await new Promise((r) => setTimeout(r, 20))
      return super.createSession(opts, emit)
    }
  }

  it('두 send가 같은 되살리기를 기다린다 — 프로세스는 하나만 뜬다', async () => {
    const a = new SlowAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await m.archive(s.id, true)
    await m.archive(s.id, false)
    a.creations = 0

    await Promise.all([
      call('agents.send', { sessionId: s.id, text: '사람의 말' }),
      call('agents.send', { sessionId: s.id, text: '오케스트레이터의 말' }),
    ])

    expect(a.creations).toBe(1)
    expect(a.handleOf(s.id)!.sent).toEqual(expect.arrayContaining(['사람의 말', '오케스트레이터의 말']))
  })
})

/**
 * 첫 프롬프트로 만든 세션. 어댑터로 보내기만 하고 저장하지 않으면
 * 다시 켠 뒤의 기록이 **답부터 시작한다** — 무엇을 물었는지가 없다.
 */
describe('첫 프롬프트도 기록에 남는다', () => {
  it('user 행으로 저장되고 user_message 이벤트에 seq가 실린다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: p.path, tool: 'claude', initialPrompt: '처음부터 이걸 해줘',
    })) as { id: string }

    // 어댑터에도 갔고
    expect(adapter.last!.sent).toEqual(['처음부터 이걸 해줘'])
    // 기록에도 남았다
    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 10 })) as {
      role: string
      seq: number
      payload: { text?: string }
    }[]
    const first = msgs.find((m) => m.role === 'user')!
    expect(first.payload.text).toBe('처음부터 이걸 해줘')
    // UI의 낙관적 렌더가 자기 것을 알아보는 기준은 seq다 — send()와 같은 계약
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_message', sessionId: s.id, seq: first.seq, text: '처음부터 이걸 해줘' }),
    )
    // 내가 보낸 건 읽은 것 — 첫 프롬프트로 안읽음 배지가 뜨면 안 된다
    const after = mgr.listSessions().find((x) => x.id === s.id)!
    expect(after.lastReadSeq).toBeGreaterThanOrEqual(first.seq)
  })
})

/**
 * 순서는 전역 하나(sidebar_order)다. 한 프로젝트 안에서 끌어 정렬했을 뿐인데
 * 다른 프로젝트의 순서까지 섞이면 안 된다 — 이 프로젝트가 차지하던 자리만 바뀐다.
 */
describe('프로젝트 안의 재정렬은 전역 순서를 흔들지 않는다', () => {
  it('움직이지 않은 세션은 있던 자리에 그대로 남는다', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const p1 = (await rpc('projects.add', { path: mkdtempSync(join(tmpdir(), 'cc-p1-')) })) as { id: string; path: string }
    const p2 = (await rpc('projects.add', { path: mkdtempSync(join(tmpdir(), 'cc-p2-')) })) as { id: string; path: string }
    // 전역 순서: a1, b1, a2, b2 (생성 순)
    const mk = async (proj: { id: string; path: string }) =>
      ((await rpc('agents.createSession', { projectId: proj.id, cwd: proj.path, tool: 'claude' })) as { id: string }).id
    const a1 = await mk(p1)
    const b1 = await mk(p2)
    const a2 = await mk(p1)
    const b2 = await mk(p2)

    // p1 안에서만 순서를 뒤집는다
    const after = mgr.reorderSessions(p1.id, [a2, a1]).map((s) => s.id)

    // p1의 자리(1번째·3번째)만 바뀌고 p2는 그대로다
    expect(after).toEqual([a2, b1, a1, b2])
    // 저장도 같은 순서다 — 다시 켜면 화면과 어긋나면 안 된다
    expect(store.listSessions().map((s) => s.id)).toEqual([a2, b1, a1, b2])
  })
})

/**
 * 밖(터미널)에서 이어간 대화 따라잡기 — **스트리밍으로 쌓인 기록**에서.
 * 저장된 행은 델타 조각이라, 마지막 행과 완전한 메시지를 비교하면 영원히
 * 일치하지 않아 따라잡기가 늘 0건이었다 (조용한 실패).
 */
describe('델타로 쌓인 기록에서도 따라잡는다', () => {
  class SyncAdapter2 extends FakeAdapter {
    toolHistory: { role: 'user' | 'assistant'; text: string }[] = []
    async listExternalSessions() {
      return [{ externalId: 'ext-1', title: '대화', updatedAt: 1 }]
    }
    async readExternalHistory() {
      return this.toolHistory
    }
  }

  it('마지막 응답을 조각에서 되살려 맞추고, 그 뒤만 이어붙인다', async () => {
    const a = new SyncAdapter2()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: '질문' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }

    // 응답이 스트리밍 조각으로 흘러온다 — 저장은 한 행으로 합쳐진다 (#66)
    const h = a.handleOf(s.id)!
    h.emitDelta('답의 ')
    h.emitDelta('앞부분과 뒷부분')
    // 도구 기록에는 같은 응답이 **완전한 메시지 하나**로 남아 있다
    a.toolHistory.push({ role: 'assistant', text: '답의 앞부분과 뒷부분' })

    await m.archive(s.id, true)
    await m.archive(s.id, false)
    // 그 사이 터미널에서 이어서 작업했다
    a.toolHistory.push({ role: 'user', text: '터미널에서 한 말' }, { role: 'assistant', text: '터미널 답' })

    await m.resumeSession(s.id)

    const texts = ((await call('messages.load', { sessionId: s.id, limit: 200 })) as { payload: { text?: string } }[])
      .map((r) => r.payload.text)
      .filter(Boolean)
    // 중복 없이 뒷부분만 붙는다 — 0건(못 찾음)도, 통째 중복도 아니다.
    // 스트리밍 조각 둘은 저장에서 이미 한 행이다 (#66)
    expect(texts).toEqual(['질문', '답의 앞부분과 뒷부분', '터미널에서 한 말', '터미널 답'])
    expect(events.some((e) => e.type === 'history_synced' && e.added === 2)).toBe(true)
  })
})

/**
 * 종료 길에 dispose 하나가 실패해도 나머지는 정리되어야 한다.
 * Promise.all이면 거절 하나가 전체를 끊고, 그 뒤의 정리(터미널·DB)까지 못 간다.
 */
describe('disposeAll은 하나가 실패해도 끝까지 간다', () => {
  it('실패한 세션을 건너뛰고 나머지를 정리한다', async () => {
    const p = await addProject()
    const s1 = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h1 = adapter.handleOf(s1.id)!
    const s2 = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h2 = adapter.handleOf(s2.id)!
    h1.dispose = async () => {
      throw new Error('이 프로세스는 죽기를 거부한다')
    }

    await expect(mgr.disposeAll()).resolves.toBeUndefined()
    expect(h2.disposed).toBe(true)
    expect(mgr.isLive(s1.id)).toBe(false)
    expect(mgr.isLive(s2.id)).toBe(false)
  })
})

/**
 * 어댑터가 죽었다고 알렸는데(adapter_crashed) 핸들이 handles에 남아 있으면,
 * send()가 handles.has만 보고 **끝난 큐로 push해 다음 말이 조용히 사라진다.**
 * 핸들을 걷어내면 send의 "없으면 되살려 보낸다" 경로가 자동 복구가 된다.
 */
describe('크래시한 세션에 다시 말을 걸면 되살려서 보낸다', () => {
  it('adapter_crashed가 오면 핸들이 걷히고, 다음 send는 새 프로세스로 간다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const dead = adapter.handleOf(s.id)!
    // 프로세스가 죽었다 — 어댑터가 알린다 (claude 스트림 침묵 종료 경로와 동일)
    ;(dead as unknown as { emit: (e: NormalizedEvent) => void }).emit({
      type: 'error',
      sessionId: s.id,
      error: { code: 'adapter_crashed', message: 'process ended unexpectedly', retryable: true },
    })

    expect(mgr.isLive(s.id)).toBe(false)
    expect(dead.disposed).toBe(true)

    // 죽은 큐가 아니라 **되살아난 새 프로세스**가 이 말을 받아야 한다
    await rpc('agents.send', { sessionId: s.id, text: '크래시 후의 말' })
    const revived = adapter.handleOf(s.id)!
    expect(revived).not.toBe(dead)
    expect(revived.sent).toContain('크래시 후의 말')
    expect(dead.sent).not.toContain('크래시 후의 말')
  })
})

/*
 * 재연결한 UI는 이벤트를 놓쳤다 — 목록(SessionInfo)이 살아-있는-동안 사실까지 실어야
 * state=waiting_approval인 세션의 카드를 다시 그리고 requestId로 응답할 수 있다.
 * 이 필드들이 없던 동안 재연결 후 승인 카드가 영영 안 떴다 (실측).
 */
describe('살아-있는-동안 사실이 목록에 실린다', () => {
  const listed = async (id: string) =>
    ((await rpc('sessions.list', {})) as SessionInfo[]).find((x) => x.id === id)!

  it('승인 요청이 pendingApproval로 실리고, 해소되면 걷힌다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h = adapter.handleOf(s.id)!

    h.emitApproval('req-1')
    let m = await listed(s.id)
    expect(m.state).toBe('waiting_approval')
    expect(m.pendingApproval).toEqual({
      requestId: 'req-1',
      detail: { kind: 'command', command: 'rm -rf node_modules', cwd: '/tmp' },
    })

    h.respondApproval('req-1', 'allow')
    m = await listed(s.id)
    expect(m.pendingApproval).toBeNull()
  })

  it('활동·한도·사용량·컨텍스트도 실리고, 회복하면 한도가 걷힌다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h = adapter.handleOf(s.id)!
    const emit = (e: NormalizedEvent) => (h as unknown as { emit: (e: NormalizedEvent) => void }).emit(e)

    emit({ type: 'usage_update', sessionId: s.id, tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    emit({ type: 'context_update', sessionId: s.id, used: 100, window: 1000, exactness: 'exact' })
    emit({ type: 'limit_reached', sessionId: s.id, resumeAt: '2026-08-19T12:00:00Z' })
    let m = await listed(s.id)
    expect(m.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 })
    expect(m.context).toEqual({ used: 100, window: 1000, exactness: 'exact' })
    expect(m.limit?.resumeAt).toBe('2026-08-19T12:00:00Z')

    // 다시 델타가 흐르면(회복) 한도 배너의 근거는 사라져야 한다
    h.emitDelta('다시 일한다')
    m = await listed(s.id)
    expect(m.limit).toBeNull()
  })

  it('에러가 오면 죽은 requestId의 승인·질문을 걷는다', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h = adapter.handleOf(s.id)!
    const emit = (e: NormalizedEvent) => (h as unknown as { emit: (e: NormalizedEvent) => void }).emit(e)

    h.emitApproval('req-dead')
    emit({ type: 'question_request', sessionId: s.id, requestId: 'q-dead', questions: [] })
    emit({ type: 'error', sessionId: s.id, error: { code: 'internal', message: 'boom', retryable: false } })

    const m = await listed(s.id)
    expect(m.state).toBe('error')
    expect(m.pendingApproval).toBeNull()
    expect(m.pendingQuestions).toEqual([])
  })
})

/**
 * 워크트리 세션 (FR-2의 후순위 옵션).
 *
 * 진짜 git 저장소와 임시 워크트리 뿌리를 세워서 본다 — 가짜로는 이 기능이 지켜야 할 것
 * (**격리가 조용히 풀리지 않는다**)을 확인할 수 없다.
 */
describe('워크트리 세션', () => {
  let root = ''
  let repo = ''
  let wtRoot = ''
  let wtMgr: SessionManager
  let wtRpc: ReturnType<typeof createRpcHandler>
  let project: { id: string; path: string }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-mgr-wt-'))
    repo = join(root, 'repo')
    wtRoot = join(root, 'worktrees')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })

    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
    wtMgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, wtRoot)
    wtRpc = createRpcHandler(wtMgr, adapters)
    project = (await wtRpc('projects.add', { path: repo })) as { id: string; path: string }
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const create = (worktree: boolean) =>
    wtRpc('agents.createSession', { projectId: project.id, cwd: repo, tool: 'claude', worktree }) as Promise<SessionInfo>

  it('켜면 워크트리에서 띄우고, 끄면 프로젝트 디렉토리에서 띄운다', async () => {
    const plain = await create(false)
    expect(plain.worktree).toBeNull()
    expect(adapter.lastCwd).toBe(repo)

    const isolated = await create(true)
    expect(isolated.worktree?.path.startsWith(wtRoot)).toBe(true)
    expect(isolated.worktree?.branch).toMatch(/^centralu\//)
    // 격리의 증거는 이것 하나다: 도구가 **다른 디렉토리에서** 떴다
    expect(adapter.lastCwd).toBe(isolated.worktree?.path)
    expect(existsSync(join(isolated.worktree!.path, 'a.txt'))).toBe(true)
  })

  it('앱을 껐다 켜고 재개해도 같은 워크트리로 돌아간다', async () => {
    const s = await create(true)
    const path = s.worktree!.path

    // host 재시작을 흉내낸다 — 살아 있는 세션에 대고 재개를 부르면 아무 일도 안 일어난다
    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
    const restarted = new SessionManager(store, adapters, () => {}, undefined, wtRoot)
    const restartedRpc = createRpcHandler(restarted, adapters)
    adapter.lastCwd = null

    await restartedRpc('agents.resumeSession', { sessionId: s.id })

    // 여기서 프로젝트 경로로 떨어지면 격리가 조용히 풀린다 — 사용자는 여전히 격리된 줄 안다
    expect(adapter.lastCwd).toBe(path)
    expect(adapter.lastCwd).not.toBe(repo)
  })

  it('host를 재시작해도 워크트리를 기억한다', async () => {
    const s = await create(true)
    const path = s.worktree!.path

    const restarted = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', adapter]]), () => {}, undefined, wtRoot)
    const found = restarted.listSessions().find((x) => x.id === s.id)

    // base(#69 병합 감지 기준점)도 재시작을 넘긴다 — 잃으면 그 세션은 자동 감지에서 빠진다
    expect(found?.worktree).toEqual({ path, branch: s.worktree!.branch, base: s.worktree!.base })
  })

  it('git 저장소가 아니면 만들지 않고, 이유를 말한다', async () => {
    const plainDir = join(root, 'not-a-repo')
    mkdirSync(plainDir)
    const p2 = (await wtRpc('projects.add', { path: plainDir })) as { id: string }

    await expect(
      wtRpc('agents.createSession', { projectId: p2.id, cwd: plainDir, tool: 'claude', worktree: true }),
    ).rejects.toThrow(/git repository/i)

    // **조용히 원본 디렉토리로 떨어지지 않는다** — 그게 이 기능에서 가장 나쁜 결말이다
    expect(wtMgr.listSessions().some((x) => x.projectId === p2.id)).toBe(false)
  })

  it('도구가 못 뜨면 워크트리를 남기지 않는다', async () => {
    adapter.failCreate = 'claude is not installed'
    await expect(create(true)).rejects.toThrow()

    // 세션은 저장조차 안 됐으므로, 여기 남으면 아무도 못 찾는 고아가 된다
    const left = existsSync(join(wtRoot, project.id)) ? readdirSync(join(wtRoot, project.id)) : []
    expect(left).toEqual([])
  })

  it('워크트리 세션은 태어나는 순간부터 매니저 아래에 선다 (#69)', async () => {
    const isolated = await create(true)

    expect(isolated.parentSessionId).not.toBeNull()
    const manager = wtMgr.listSessions().find((x) => x.id === isolated.parentSessionId)!
    expect(manager.name).toBe('Worktrees')
    expect(manager.worktree).toBeNull()
    // 두 번째 워크트리 세션은 같은 매니저를 재사용한다 — 프로젝트당 하나면 충분하다
    const second = await create(true)
    expect(second.parentSessionId).toBe(manager.id)
    // 프로젝트 폴더에서 직접 도는 세션은 트리 밖이다
    const plain = await create(false)
    expect(plain.parentSessionId).toBeNull()
  })

  it('브랜치 이름을 정하면 그 이름이 브랜치·세션 이름이 된다 (#69)', async () => {
    const s = (await wtRpc('agents.createSession', {
      projectId: project.id, cwd: repo, tool: 'claude', worktree: true, worktreeBranch: 'feat/login-fix',
    })) as SessionInfo

    expect(s.worktree?.branch).toBe('feat/login-fix')
    expect(s.name).toBe('feat/login-fix')
    // 자동 이름이 덮으면 브랜치와 세션 이름이 갈라진다 — 브랜치 이름이 유일한 식별자다
    expect(s.autoNamed).toBe(false)
    // 실제로 그 브랜치가 체크아웃됐다
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: s.worktree!.path, encoding: 'utf8',
    }).trim()
    expect(head).toBe('feat/login-fix')
  })

  it('브랜치 이름이 될 수 없는 것은 거절한다 — 판정은 git이 한다', async () => {
    await expect(
      wtRpc('agents.createSession', {
        projectId: project.id, cwd: repo, tool: 'claude', worktree: true, worktreeBranch: 'bad..name',
      }),
    ).rejects.toThrow(/Not a valid branch name/)
    // 거절됐으면 워크트리도 세션도 남지 않는다
    expect(wtMgr.listSessions().filter((x) => x.worktree).length).toBe(0)
  })

  it('프로비저닝 (#69): 파일이 복사되고, 셋업이 워크트리 안에서 결정론적 변수와 함께 돈다', async () => {
    // gitignored 파일 — git worktree add로는 절대 따라오지 않는 종류다
    writeFileSync(join(repo, '.env.local'), 'SECRET=1\n')
    store.setWorktreeSetup(project.id, {
      command: 'echo "$CENTRALU_WORKTREE:$CENTRALU_WORKTREE_INDEX" > setup-ran.txt',
      copyFiles: ['.env.local'],
    })

    const s = (await wtRpc('agents.createSession', {
      projectId: project.id, cwd: repo, tool: 'claude', worktree: true, worktreeBranch: 'feat/provisioned',
    })) as SessionInfo

    // 복사: .env의 내용이 git이 아니라 우리 손으로 건너왔다
    expect(readFileSync(join(s.worktree!.path, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    // 셋업: 워크트리 안에서, 브랜치 이름과 순번을 환경으로 받아서 돌았다
    expect(readFileSync(join(s.worktree!.path, 'setup-ran.txt'), 'utf8').trim()).toBe('feat/provisioned:1')
  })

  it('프로비저닝 실패는 세션 생성을 막지 않는다 — 반쯤 차려진 작업대가 아무것도 없는 것보다 낫다', async () => {
    store.setWorktreeSetup(project.id, { command: 'exit 7', copyFiles: ['does-not-exist.env'] })

    const s = (await wtRpc('agents.createSession', {
      projectId: project.id, cwd: repo, tool: 'claude', worktree: true,
    })) as SessionInfo

    expect(s.worktree).not.toBeNull()
    expect(existsSync(s.worktree!.path)).toBe(true)
  })

  it('복사 목록의 경로 이탈은 거절된다 — 프로젝트 안의 상대 경로만 뜻한다', async () => {
    const outside = join(root, 'outside-secret.txt')
    writeFileSync(outside, 'leak\n')
    store.setWorktreeSetup(project.id, { command: '', copyFiles: ['../outside-secret.txt'] })

    const s = (await wtRpc('agents.createSession', {
      projectId: project.id, cwd: repo, tool: 'claude', worktree: true,
    })) as SessionInfo

    expect(existsSync(join(s.worktree!.path, '..', 'outside-secret.txt'))).toBe(false)
    expect(existsSync(join(s.worktree!.path, 'outside-secret.txt'))).toBe(false)
  })

  it('병합 감지 (#69): 줄기에 들어간 브랜치만 merged가 되고, 갓 만든 브랜치는 아니다', async () => {
    const fresh = await create(true)
    const worked = (await wtRpc('agents.createSession', {
      projectId: project.id, cwd: repo, tool: 'claude', worktree: true, worktreeBranch: 'feat/done',
    })) as SessionInfo

    // 브랜치에서 일하고 (커밋), 줄기(main)로 병합한다 — 전부 터미널에서 하는 일이다
    writeFileSync(join(worked.worktree!.path, 'work.txt'), 'done\n')
    const g = (dir: string, args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir })
    g(worked.worktree!.path, ['add', '.'])
    g(worked.worktree!.path, ['commit', '-qm', 'work'])
    g(repo, ['merge', '-q', '--no-ff', 'feat/done'])

    await wtMgr.refreshMergedWorktrees(project.id)

    const after = new Map(wtMgr.listSessions().map((x) => [x.id, x]))
    expect(after.get(worked.id)?.worktreeMerged).toBe(true)
    // 갓 만든(일 안 한) 브랜치는 HEAD의 조상이지만 merged가 아니다 — base 기록이 그 구분이다
    expect(after.get(fresh.id)?.worktreeMerged).toBe(false)
    // 이벤트도 흘렀다 — 화면 배지의 근거
    expect(events.some((e) => e.type === 'worktree_merged' && e.sessionId === worked.id)).toBe(true)
  })

  it('병합된 자식은 매니저를 붙들지 않는다 (#69)', async () => {
    const worked = (await wtRpc('agents.createSession', {
      projectId: project.id, cwd: repo, tool: 'claude', worktree: true, worktreeBranch: 'feat/pin',
    })) as SessionInfo
    const manager = wtMgr.listSessions().find((x) => x.id === worked.parentSessionId)!

    // 산 자식이 있는 동안은 못 지운다
    await expect(wtMgr.deleteSession(manager.id)).rejects.toThrow(/worktree session/)

    writeFileSync(join(worked.worktree!.path, 'w.txt'), 'x\n')
    const g = (dir: string, args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir })
    g(worked.worktree!.path, ['add', '.'])
    g(worked.worktree!.path, ['commit', '-qm', 'w'])
    g(repo, ['merge', '-q', '--no-ff', 'feat/pin'])
    await wtMgr.refreshMergedWorktrees(project.id)

    // 병합됐으면 이력이다 — 매니저는 풀려난다
    await expect(wtMgr.deleteSession(manager.id)).resolves.toBeUndefined()
  })

  it('지울 때 기본은 워크트리를 남긴다', async () => {
    const s = await create(true)
    const path = s.worktree!.path

    await wtRpc('agents.deleteSession', { sessionId: s.id })

    expect(existsSync(path)).toBe(true)
  })

  it('지우라고 하면 커밋 안 된 변경이 있어도 지운다', async () => {
    const s = await create(true)
    const path = s.worktree!.path
    writeFileSync(join(path, 'a.txt'), '아직 커밋 안 함\n')

    await wtRpc('agents.deleteSession', { sessionId: s.id, deleteWorktree: true })

    expect(existsSync(path)).toBe(false)
  })

  it('상태를 물으면 지워도 되는지 판단할 재료를 준다', async () => {
    const plain = await create(false)
    expect(await wtRpc('agents.worktreeStatus', { sessionId: plain.id })).toBeNull()

    const s = await create(true)
    expect(await wtRpc('agents.worktreeStatus', { sessionId: s.id })).toMatchObject({ dirty: false, changedFiles: 0 })

    writeFileSync(join(s.worktree!.path, 'a.txt'), '고침\n')
    expect(await wtRpc('agents.worktreeStatus', { sessionId: s.id })).toMatchObject({ dirty: true, changedFiles: 1 })
  })
})

/**
 * 세션이 만들어진 디렉토리를 기억한다 (이슈 #28).
 *
 * The tool files a conversation under the working directory it was started in, and looks for it
 * there and nowhere else. Deriving that directory again on every start is therefore a promise
 * we cannot keep: rename the data folder, move a project, and a live session is suddenly
 * pointed at a place its history was never written to. That happened — the orchestrator's cwd
 * followed a data-directory rename, the tool answered "not found", and the app reported a
 * deletion while an 821KB transcript sat untouched under the old path.
 */
describe('재개는 만들어진 곳으로 돌아간다', () => {
  it('프로젝트 경로가 달라져도 세션이 시작한 디렉토리로 뜬다', async () => {
    const startedIn = mkdtempSync(join(tmpdir(), 'cc-cwd-'))
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string; path: string }
    // The session starts somewhere other than the project's path — which is what a rename
    // leaves behind: the derived answer and the real one stop agreeing.
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: startedIn, tool: 'claude' })) as SessionInfo

    // host 재시작 — 메모리에 남은 것이 아니라 저장된 사실을 읽는지 본다
    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
    const restarted = new SessionManager(store, adapters, () => {})
    adapter.lastCwd = null

    await createRpcHandler(restarted, adapters)('agents.resumeSession', { sessionId: s.id })

    expect(adapter.lastCwd).toBe(startedIn)
    // 프로젝트 경로로 떨어지면 도구는 기록이 없는 곳을 뒤지고, 그 답이 "없다"였다
    expect(adapter.lastCwd).not.toBe(p.path)
    rmSync(startedIn, { recursive: true, force: true })
  })

  /*
   * Rows created before v14 have no stored path — the migration deliberately leaves the
   * orchestrator NULL rather than touching the user's home. The first time we need the path we
   * derive it once and write it down, so the next rename cannot move it either.
   */
  it('예전 세션은 처음 필요할 때 한 번 정해지고, 그다음엔 사실이다', async () => {
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string; path: string }
    // Exactly how every pre-v14 row was written: upsertSession does not carry a cwd, so the
    // column is NULL — the same state the migration leaves the orchestrator in.
    store.upsertSession({
      id: 'old', projectId: p.id, kind: 'worker', tool: 'claude', externalId: 'ext-1', name: '예전 세션',
      autoNamed: false, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null, serviceTier: null,
      permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, ...sessionLiveDefaults(),
    })
    expect(store.sessionCwd('old')).toBeNull()

    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
    await new SessionManager(store, adapters, () => {}).resumeSession('old')

    expect(store.sessionCwd('old')).toBe(p.path)
  })
})

/**
 * 오케스트레이터 — 앱에 하나뿐인 자리.
 *
 * 프로젝트마다 하나씩 두던 단계(#13)는 폐기했다 (2026-09-01): 프로젝트 안에서 세션을
 * 지휘하는 자리가 워크트리 매니저(#69)와 둘이 되면서 개념이 하나 많았고, 승격은 한 번도
 * 쓰이지 않았다. 남은 약속은 둘이다 — 자리는 하나이고(지연 기동), 시야에는 경계가 없다.
 */
describe('오케스트레이터', () => {
  /**
   * #63 온보딩: 화면 열기와 프로세스 만들기가 갈라졌다.
   * peek은 절대 만들지 않고, 소개 화면의 카드 선택(configure)은 첫 orchestrator()가 읽는다.
   */
  it('peek은 만들지 않는다 — 소개 화면에서 고른 도구로 첫 질문 때 태어난다 (#63)', async () => {
    // 화면을 여는 것만으로는 아무것도 안 생긴다 (지연 기동)
    expect(mgr.orchestratorPeek()).toBeNull()

    mgr.configureOrchestrator('codex')
    const orc = await mgr.orchestrator()
    expect(orc.tool).toBe('codex')
    // 코덱스 오케스트레이터도 도구 배선을 받는다 — #13이 깔아 둔 stdio 다리 그 길이다
    expect(codexAdapter.lastOpts?.orchestratorTools).toBeDefined()

    // 태어난 뒤의 peek은 같은 세션을 준다 — 두 번째 오케스트레이터는 없다
    expect(mgr.orchestratorPeek()?.id).toBe(orc.id)
  })

  it('propose_project는 제안이 전부다 — 프로젝트를 만들지 않는다 (#63 제안-후-사람-확인)', async () => {
    const orc = await mgr.orchestrator()
    const before = ((await rpc('projects.list', {})) as unknown[]).length
    const r = await mgr.runOrchestratorTool(orc.id, 'propose_project', { reason: '작업 폴더가 필요합니다' })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('사람')
    // 도구가 폴더를 등록하는 길은 없다 — 카드의 버튼(사람의 피커)만이 그 길이다
    expect(((await rpc('projects.list', {})) as unknown[]).length).toBe(before)
  })

  it('create_session — 프로젝트 이름으로 만들고, 이름 없는 요청은 거절한다', async () => {
    const p = await addProject()
    const orc = await mgr.orchestrator()

    const missing = await mgr.runOrchestratorTool(orc.id, 'create_session', {})
    expect(missing.isError).toBe(true)

    const projName = ((await rpc('projects.list', {})) as { id: string; name: string }[]).find((x) => x.id === p.id)!.name
    const made = await mgr.runOrchestratorTool(orc.id, 'create_session', { project: projName, name: '새 일꾼' })
    expect(made.isError).toBeFalsy()
    const sessions = (await rpc('sessions.list', {})) as SessionInfo[]
    const worker = sessions.find((x) => x.name === '새 일꾼')
    expect(worker?.projectId).toBe(p.id)
    expect(worker?.kind).toBe('worker')
  })

  /**
   * 시야에 프로젝트 경계가 없다. 프로젝트 단계를 걷어낸 뒤 남아야 하는 성질이고,
   * 경계를 다시 들여오면 여기서 걸린다 — 매니저(#69)의 childrenOf만이 유일한 좁힘이다.
   */
  it('목록과 지시는 프로젝트를 가로지른다', async () => {
    const p1 = await addProject()
    const p2 = (await rpc('projects.add', { path: mkdtempSync(join(tmpdir(), 'cc-proj-')) })) as { id: string }
    const here = (await rpc('agents.createSession', {
      projectId: p1.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const there = (await rpc('agents.createSession', {
      projectId: p2.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const orc = await mgr.orchestrator()

    const list = await mgr.runOrchestratorTool(orc.id, 'list_sessions', {})
    expect(list.text).toContain(here.id)
    expect(list.text).toContain(there.id)

    const sent = await mgr.runOrchestratorTool(orc.id, 'send_to_session', { sessionId: there.id, text: '해봐' })
    expect(sent.isError).toBeFalsy()
  })
})

/**
 * 오케스트레이터의 앱 지식과 설정 손 (#30).
 *
 * 문서는 빌드에 내장된 안내서다 — docs/를 런타임에 읽으면 그 폴더에 쓸 수 있는
 * 세션이 오케스트레이터의 지식을 고칠 수 있다 (AGENTS.md 공격의 한 다리 건너 재판).
 * 설정 손은 성능 셋(model·effort·verbosity)뿐이고, 권한 프리셋은 스키마에서부터 없다.
 */
describe('오케스트레이터 앱 안내서와 설정 (#30)', () => {
  it('app_guide — 주제 없이 부르면 개요와 주제 목록, 모르는 주제는 목록을 들려주며 거절', async () => {
    const orc = await mgr.orchestrator()
    const top = await mgr.runOrchestratorTool(orc.id, 'app_guide', {})
    expect(top.text).toContain('Centralu')
    expect(top.text).toContain('orchestrator')

    const sec = await mgr.runOrchestratorTool(orc.id, 'app_guide', { topic: 'approvals' })
    expect(sec.text).toContain('승인')

    const bad = await mgr.runOrchestratorTool(orc.id, 'app_guide', { topic: 'no-such' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('overview')
  })

  it('update_session_settings — 바뀌고, 화면에 이벤트로 알려진다 (흔적 없는 변경 금지)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const orc = await mgr.orchestrator()

    const r = await mgr.runOrchestratorTool(orc.id, 'update_session_settings', {
      sessionId: s.id, effort: 'high',
    })
    expect(r.isError).toBeFalsy()
    expect(mgr.listSessions().find((x) => x.id === s.id)?.effort).toBe('high')
    const ev = events.find((e) => e.type === 'settings_changed' && e.sessionId === s.id)
    expect(ev).toBeDefined()
    expect((ev as { effort: string | null }).effort).toBe('high')
  })

  it('update_session_settings — 작업 중인 세션은 거절한다 (재시작이 턴을 죽인다)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const orc = await mgr.orchestrator()
    const internals = mgr as unknown as { meta: Map<string, { state: string }> }
    internals.meta.get(s.id)!.state = 'working'

    const r = await mgr.runOrchestratorTool(orc.id, 'update_session_settings', {
      sessionId: s.id, effort: 'low',
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('작업 중')
  })

  /*
   * "대신 승인할 수 없다"의 뒷문 검사: 권한 프리셋이 **스키마에 아예 없다**.
   * 항목을 검사해 막는 코드였다면 이 테스트는 그 코드를 지웠을 때 침묵한다 —
   * 표현할 수 없음을 못 박아야 다음 사람이 "편하니까 추가"를 하는 순간 여기가 깨진다.
   */
  it('update_session_settings 스키마에 권한 프리셋이 없다 — 뒷문 승인 차단', async () => {
    const { ORCHESTRATOR_TOOLS } = await import('./orchestrator-tools.js')
    const tool = ORCHESTRATOR_TOOLS.find((t) => t.name === 'update_session_settings')!
    const keys = Object.keys((tool.schema as { shape: Record<string, unknown> }).shape)
    expect(keys.sort()).toEqual(['effort', 'model', 'sessionId', 'verbosity'])
  })
})

/*
 * 저장의 단위가 델타에서 **메시지**로 바뀌었다 (#66).
 * 예전에는 한 문장이 행 아홉 개였다 — DB의 84%가 조각이었고, 페이지네이션은 행을
 * 세느라 의미를 잃었으며, trigram 색인은 1~2자 본문을 색인하지 못해 검색이 죽었다.
 */
describe('스트리밍 메시지는 행 하나로 저장된다 (#66)', () => {
  const openSession = async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    return { s, h: adapter.handleOf(s.id)! }
  }

  it('조각 여럿이 한 행이 되고, 끝의 빈 조각은 행을 만들지 않는다', async () => {
    const { s, h } = await openSession()
    for (const part of ['한 ', '번에 ', '뽑게 ', '하면 ', '됩니다.']) h.emitDelta(part)
    h.emitDelta('') // codex가 끝에 보내는 빈 델타 — 빈 행 1,853개의 출처였다
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    const rows = store.loadMessages(s.id, 50)
    const texts = rows.filter((r) => r.kind === 'text').map((r) => (r.payload as { text?: string }).text)
    expect(texts).toEqual(['한 번에 뽑게 하면 됩니다.'])
  })

  it('턴이 닫히면 조각 경계에 걸친 구절도 검색된다', async () => {
    const { h } = await openSession()
    // '뽑게'는 두 조각에 걸쳐 있다 — 행이 조각이던 시절엔 영영 찾을 수 없던 모양
    h.emitDelta('한 번에 뽑')
    h.emitDelta('게 하면 됩니다.')
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    expect(store.searchMessages('뽑게 하면').length).toBe(1)
  })

  it('도구 호출은 메시지의 경계다 — 앞뒤가 서로 다른 행이 된다', async () => {
    const { s, h } = await openSession()
    h.emitDelta('먼저 살펴보고')
    h.emitToolCall('Bash', 'ls')
    h.emitDelta('결과는 이렇습니다')
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    const rows = store.loadMessages(s.id, 50)
    expect(rows.map((r) => r.kind)).toEqual(['text', 'tool_call', 'text'])
    // 경계에서 닫힌 행도 색인된다 — 도구 호출 전의 말이 검색에서 빠지면 안 된다
    expect(store.searchMessages('먼저 살펴보고').length).toBe(1)
  })

  it('사람의 말(send)도 경계다 — 인터럽트 후 이어 말해도 열린 행에 붙지 않는다', async () => {
    const { s, h } = await openSession()
    h.emitDelta('하던 말')
    await new Promise((r) => setTimeout(r, 0))
    await mgr.send(s.id, '멈추고 이것부터')
    h.emitDelta('새 답')
    h.finishTurn()
    await new Promise((r) => setTimeout(r, 0))

    const texts = store.loadMessages(s.id, 50).map((r) => (r.payload as { text?: string }).text)
    // fake 핸들은 send에 echo 델타로 답한다 — 그 echo와 '새 답' 사이에는 경계가 없으므로 한 행이 맞다
    expect(texts).toEqual(['하던 말', '멈추고 이것부터', 'echo:멈추고 이것부터새 답'])
  })

  it('첨부는 payload에 경로로 남고, 이미지 바이트는 loadMessages가 파일에서 다시 싣는다', async () => {
    const { s } = await openSession()
    const dir = mkdtempSync(join(tmpdir(), 'cc-att-'))
    const img = join(dir, 'shot.png')
    writeFileSync(img, Buffer.from('PNG바이트'))
    await mgr.send(s.id, '이 화면 봐줘', [
      { kind: 'image', path: img, name: 'shot.png', mime: 'image/png', bytes: 9 },
      // 500MB 상한 정리로 사라진 파일 — 경로만 남고 화면은 이름 칩으로 눕는다
      { kind: 'image', path: join(dir, 'gone.png'), name: 'gone.png', mime: 'image/png', bytes: 9 },
    ])

    // DB에는 바이트가 없다 (D-1: 경로만)
    const raw = store.loadMessages(s.id, 50).find((r) => r.role === 'user')!
    const rawAtts = (raw.payload as { attachments: { data?: string }[] }).attachments
    expect(rawAtts.map((a) => a.data)).toEqual([undefined, undefined])

    // 화면에 줄 때는 살아 있는 파일만 바이트가 실린다
    const served = (await mgr.loadMessages(s.id, 50)).find((r) => r.role === 'user')!
    const atts = (served.payload as { attachments: { name: string; data?: string }[] }).attachments
    expect(atts[0]?.data).toBe(Buffer.from('PNG바이트').toString('base64'))
    expect(atts[1]?.data).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * 세션 트리의 기반 (#69-1): 워크트리 세션은 매니저 없이 서지 않는다.
 *
 * 이 분류의 1번 문서화된 실패가 고아 워크트리다 (Vibe Kanban #1764/#2335/#1571).
 * 고아는 책임자가 없을 때 생기므로, 소속을 두 길목에서 강제한다 — 만들 때 붙이고,
 * 기동할 때 입양한다.
 */
describe('마지막으로 고른 모델·강도가 프로젝트 기본값이 된다 (#69 ⑤)', () => {
  it('설정을 바꾸면 프로젝트에 적히고, 새 세션 생성이 그 값을 받는다', async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    await mgr.updateSettings(a.id, { model: 'opus', effort: 'high' })

    const proj = (await rpc('projects.list', {})) as { id: string; defaultModel?: string | null; defaultEffort?: string | null }[]
    expect(proj.find((x) => x.id === p.id)?.defaultModel).toBe('opus')
    expect(proj.find((x) => x.id === p.id)?.defaultEffort).toBe('high')
  })

  it('도구가 다른 세션의 선택은 적지 않는다 — codex 모델이 claude 기본값을 덮으면 첫 턴이 400으로 죽는다', async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    await mgr.updateSettings(a.id, { model: 'opus', effort: 'high' })
    // 프로젝트 기본 도구가 claude인 채로, codex 세션의 모델 선택이 끼어든다
    const b = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })) as SessionInfo
    // codex 세션 생성이 기본 도구를 codex로 바꿨다 — 이제 codex의 선택이 적힌다
    await mgr.updateSettings(b.id, { model: 'gpt-5-codex' })
    const proj = (await rpc('projects.list', {})) as { id: string; defaultModel?: string | null }[]
    expect(proj.find((x) => x.id === p.id)?.defaultModel).toBe('gpt-5-codex')
  })
})

describe('워크트리 세션의 매니저 (#69)', () => {
  const wtRow = (id: string, projectId: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
    id, projectId, kind: 'worker', tool: 'claude', externalId: null, name: id,
    autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
    createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
    serviceTier: null, permissionPreset: 'normal', importedFrom: null,
    worktree: { path: `/tmp/wt/${id}`, branch: `centralu/${id}` }, parentSessionId: null,
    ...sessionLiveDefaults(), ...over,
  })
  const boot = () =>
    new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', adapter]]), (e) => events.push(e))

  it('기동 시 고아 워크트리 세션에 매니저를 세워 붙인다 — 행만, 프로세스는 없다', async () => {
    const p = await addProject()
    store.upsertSession(wtRow('wt-a', p.id))
    store.upsertSession(wtRow('wt-b', p.id))

    const m2 = boot()

    const all = m2.listSessions()
    const manager = all.find((s) => s.name === 'Worktrees')!
    expect(manager).toBeDefined()
    expect(manager.worktree).toBeNull()
    expect(manager.live).toBe(false) // 입양은 행을 만들 뿐 에이전트를 깨우지 않는다 (lazy-spawn)
    expect(all.find((s) => s.id === 'wt-a')?.parentSessionId).toBe(manager.id)
    expect(all.find((s) => s.id === 'wt-b')?.parentSessionId).toBe(manager.id)
  })

  it('두 번 기동해도 매니저는 하나다 (멱등)', async () => {
    const p = await addProject()
    store.upsertSession(wtRow('wt-a', p.id))

    boot()
    const m3 = boot()

    expect(m3.listSessions().filter((s) => s.name === 'Worktrees').length).toBe(1)
  })

  it('부모가 사라진 자식도 고아다 — 다음 기동이 다시 입양한다', async () => {
    const p = await addProject()
    store.upsertSession(wtRow('wt-a', p.id, { parentSessionId: 'gone-forever' }))

    const m2 = boot()

    const kid = m2.listSessions().find((s) => s.id === 'wt-a')!
    expect(kid.parentSessionId).not.toBe('gone-forever')
    expect(m2.listSessions().some((s) => s.id === kid.parentSessionId)).toBe(true)
  })

  it('살아 있는 자식이 있는 매니저는 지울 수 없다 — 아카이브된 자식은 붙들지 않는다', async () => {
    const p = await addProject()
    store.upsertSession(wtRow('wt-a', p.id))
    const m2 = boot()
    const manager = m2.listSessions().find((s) => s.name === 'Worktrees')!

    await expect(m2.deleteSession(manager.id)).rejects.toThrow(/worktree session/)

    // 자식을 아카이브하면 매니저는 풀려난다 — 끝난 작업이 매니저를 영원히 고정하면 보호가 벌이 된다
    await m2.archive('wt-a', true)
    await expect(m2.deleteSession(manager.id)).resolves.toBeUndefined()
  })

  it('매니저는 부분집합 도구만 부를 수 있다 — 노출과 실행이 같은 판정을 쓴다 (#69)', async () => {
    const p = await addProject()
    store.upsertSession(wtRow('wt-a', p.id))
    const m2 = boot()
    const manager = m2.listSessions().find((s) => s.name === 'Worktrees')!

    expect(m2.toolProfileOf(manager.id)).toBe('manager')
    // 허용된 것: 제안 도구가 돈다 (아무것도 만들지 않는다 — 가리키기만)
    const before = m2.listSessions().length
    const r = await m2.runOrchestratorTool(manager.id, 'propose_worktree_session', { branch: 'feat/x' })
    expect(r.isError).not.toBe(true)
    expect(m2.listSessions().length).toBe(before)
    // 막힌 것: create_session은 매니저의 도구가 아니다 — 생성은 제안을 거쳐 사람이 한다
    await expect(m2.runOrchestratorTool(manager.id, 'create_session', {})).rejects.toThrow(/이 세션의 도구가 아닙니다/)
    // 보통 세션은 아무 도구도 못 부른다
    await expect(m2.runOrchestratorTool('wt-a', 'list_sessions', {})).rejects.toThrow()
  })

  it('매니저의 눈은 자기 자식까지다 — 같은 프로젝트의 남에게도 지시할 수 없다 (#69)', async () => {
    const p = await addProject()
    store.upsertSession(wtRow('wt-a', p.id))
    store.upsertSession(wtRow('other', p.id, { worktree: null, parentSessionId: null }))
    const m2 = boot()
    const manager = m2.listSessions().find((s) => s.name === 'Worktrees')!

    const list = await m2.runOrchestratorTool(manager.id, 'list_sessions', {})
    expect(list.text).toContain('wt-a')
    expect(list.text).not.toContain('other')

    const send = await m2.runOrchestratorTool(manager.id, 'send_to_session', { sessionId: 'other', text: '해줘' })
    expect(send.isError).toBe(true)
    expect(send.text).toContain('이 매니저의 워크트리 세션이 아닙니다')
  })

  it('adoption은 링크만 쓴다 — 세션도 대화도 지우지 않는다', async () => {
    const p = await addProject()
    store.upsertSession(wtRow('wt-a', p.id))
    store.appendMessages([
      { sessionId: 'wt-a', seq: 1, role: 'user', kind: 'text', payload: { text: '남아야 한다' }, ts: 1 },
    ])

    boot()

    expect(store.loadMessages('wt-a', 10).length).toBe(1)
  })
})
