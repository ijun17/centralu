import { beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'

/**
 * 세션 수명주기의 경주 — 프로세스를 갈아 끼우거나 깨우는 **도중에** 다른 일이 끼는 경우.
 *
 * 가짜 어댑터는 두 가지를 테스트 손에 쥐여 준다: 핸들마다 받은 이벤트 받이(`emit`) — 내려놓은 핸들이
 * 늦게 말하는 모양을 만든다 — 와, 멈춰 둘 수 있는 `createSession` — 깨우는 중인 창을 만든다.
 */
class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  sent: string[] = []
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    private readonly onDispose: () => void = () => {},
  ) {}
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
    this.disposed = true
    this.onDispose()
  }
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false,
  }
  created: Handle[] = []
  /** 이어 가는 대화를 쥔 프로세스 — 뜨기 시작한 순간부터 닫힐 때까지 (Codex의 쓰기 잠금 흉내) */
  locked = new Set<string>()
  /** createSession이 받은 옵션, 멈추기 **전에** 적는다 — 깨우기가 옵션을 넘긴 순간을 테스트가 안다 */
  asked: CreateSessionOpts[] = []
  /** 켜 두면 createSession이 `release()`를 부를 때까지 멈춘다 — 깨우는 중인 창 */
  gate: Promise<void> | null = null
  private open: (() => void) | null = null
  constructor(readonly tool: ToolName) {}
  hold() {
    this.gate = new Promise((r) => (this.open = r))
  }
  release() {
    this.gate = null
    this.open?.()
  }
  async deleteExternalConversation(externalId: string) {
    if (this.locked.has(externalId)) throw new Error('thread already has an active writer')
  }
  get last() {
    return this.created.at(-1)!
  }
  /** 켜 두면 detect가 `openDetect()`까지 멈춘다 — 도구 바꾸기가 확인하는 사이의 창 */
  detectGate: Promise<void> | null = null
  openDetect: (() => void) | null = null
  async detect() {
    if (this.detectGate) await this.detectGate
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    this.asked.push(opts)
    const holds = opts.resumeExternalId
    if (holds) this.locked.add(holds)
    if (this.gate) await this.gate
    const h = new Handle(opts.sessionId, opts, emit, () => holds && this.locked.delete(holds))
    if (opts.resumeExternalId) h.externalId = opts.resumeExternalId
    this.created.push(h)
    return h
  }
}

let store: Store
let claude: Adapter
let codex: Adapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  store = new Store()
  claude = new Adapter('claude')
  codex = new Adapter('codex')
  events = []
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude], ['codex', codex]])
  mgr = new SessionManager(store, adapters, (e) => events.push(e))
  rpc = createRpcHandler(mgr, adapters)
})

async function newSession(preset: 'safe' | 'normal' | 'auto' = 'normal'): Promise<string> {
  const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: preset })) as {
    id: string
  }
  return s.id
}

/** 조건이 설 때까지 이벤트 루프를 돌린다 — 매니저의 await 사슬이 가짜 어댑터에 닿기를 기다린다 */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(ok()).toBe(true)
}

const texts = (sessionId: string) =>
  store.loadMessages(sessionId, 100).map((r) => JSON.stringify(r.payload))

describe('갈아 끼운 프로세스의 늦은 말 (#157)', () => {
  it('재시작 뒤 옛 핸들이 adapter_crashed를 올려도 새 핸들이 남고, 옛 턴의 글과 끝은 기록되지 않는다', async () => {
    const id = await newSession()
    const old = claude.last
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: '옛 턴의 앞부분' })
    // 사람이 턴을 멈췄다 (이슈의 순서: Stop → 설정 변경)
    old.emit({ type: 'state_change', sessionId: id, state: 'waiting_input', reason: 'interrupted' })

    // 설정을 바꾸면 프로세스를 갈아 끼운다
    await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })
    const fresh = claude.last
    expect(fresh).not.toBe(old)
    expect(old.disposed).toBe(true)

    // 옛 프로세스가 끝나 가던 턴을 마저 내고, 오류 result를 안은 채 죽는다
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: '옛 프로세스의 늦은 글' })
    old.emit({ type: 'turn_complete', sessionId: id })
    old.emit({
      type: 'error',
      sessionId: id,
      error: { code: 'adapter_crashed', message: 'Claude Code returned an error result: x', retryable: true },
    })

    expect(fresh.disposed).toBe(false)
    expect(mgr.isLive(id)).toBe(true)
    expect(events.some((e) => e.type === 'error' && e.error.code === 'adapter_crashed')).toBe(false)
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false)
    expect(texts(id).some((t) => t.includes('옛 프로세스의 늦은 글'))).toBe(false)

    // 새 핸들의 크래시는 지금처럼 걷는다 — 가드가 크래시 분기를 통째로 막은 것이 아니다
    fresh.emit({ type: 'error', sessionId: id, error: { code: 'adapter_crashed', message: 'gone', retryable: true } })
    expect(fresh.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
  })

  it('내려놓은 핸들이 닫으며 놓아주는 승인 카드는 받는다 — 카드가 남지 않게', async () => {
    const id = await newSession('safe')
    const old = claude.last
    old.emit({ type: 'approval_request', sessionId: id, requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    expect(mgr.listSessions().find((s) => s.id === id)!.pendingApproval?.requestId).toBe('r1')

    await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })
    old.emit({ type: 'approval_resolved', sessionId: id, requestId: 'r1', decision: 'deny' })

    expect(mgr.listSessions().find((s) => s.id === id)!.pendingApproval ?? null).toBe(null)
  })
})

/*
 * 깨우는 동안 바꾼 설정 (#162). 깨우기는 설정을 읽어 프로세스에 넘긴 뒤 프로세스를 기다린다 — 큰 Codex 대화는
 * 십수 초다. 그 사이에 권한을 safe로 바꾸면 화면과 저장소는 safe인데 프로세스는 auto로 돌았고, safe를 다시
 * 골라도 매니저의 기록(running)이 이미 safe라 아무 일도 없었다.
 */
describe('깨우는 중·재시작 중에 바꾼 설정은 프로세스에 닿는다 (#162)', () => {
  it('잠든 auto 세션을 깨우는 동안 safe로 바꾸면, 결국 safe로 뜬 프로세스가 남는다', async () => {
    const id = await newSession('auto')
    await mgr.disposeAll() // 잠든 세션 (host 재시작과 같은 상태)
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id })
    await until(() => claude.asked.length > asked)
    expect(claude.asked.at(-1)!.permissionPreset).toBe('auto') // 깨우기는 이미 auto를 넘겼다

    const changing = rpc('agents.updateSettings', { sessionId: id, permissionPreset: 'safe' })
    claude.release()
    await waking
    await changing

    expect(mgr.isLive(id)).toBe(true)
    expect(claude.last.disposed).toBe(false)
    expect(claude.last.opts.permissionPreset).toBe('safe')
  })

  it('재시작이 도는 동안 온 두 번째 변경도 프로세스에 닿는다', async () => {
    const id = await newSession('auto')
    claude.hold()
    const asked = claude.asked.length
    const first = rpc('agents.updateSettings', { sessionId: id, effort: 'high' })
    await until(() => claude.asked.length > asked)

    const second = rpc('agents.updateSettings', { sessionId: id, permissionPreset: 'safe' })
    claude.release()
    await first
    await second

    expect(mgr.isLive(id)).toBe(true)
    expect(claude.last.disposed).toBe(false)
    expect(claude.last.opts).toMatchObject({ effort: 'high', permissionPreset: 'safe' })
  })
})

/*
 * 오케스트레이터가 부탁한 보고 (#166). 두 어댑터는 실패한 턴에 turn_complete를 내지 않고 error만 낸다 — 그래서
 * turn_complete에서만 보고하던 매니저는 실패를 보고하지 않았고, 남은 표식이 나중의 관계없는 턴을 "끝났습니다"로
 * 보고했다.
 */
describe('보고는 턴이 어떻게 끝나든 한 번 간다 (#166)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const handleOf = (id: string) => claude.created.filter((h) => h.sessionId === id).at(-1)!

  async function setup() {
    const worker = await newSession()
    const orc = await mgr.orchestrator()
    const tools = claude.asked.find((o) => o.sessionId === orc.id)!.orchestratorTools!
    /** 오케스트레이터 대화에 저장된 보고들 — 화면과 기록이 읽는 본문이다 */
    const reports = () =>
      store
        .loadMessages(orc.id, 100)
        .map((r) => r.payload as { text?: string; from?: { sessionId: string } })
        .filter((p) => p.from?.sessionId === worker)
        .map((p) => p.text ?? '')
    return { worker, tools, w: handleOf(worker), reports }
  }

  it('실패한 턴은 실패 보고를 한 번 보내고, 뒤의 관계없는 턴은 보고하지 않는다', async () => {
    const { worker, tools, w, reports } = await setup()
    await tools.sendToSession(worker, '빌드를 고쳐 줘', true)
    w.emit({ type: 'error', sessionId: worker, error: { code: 'internal', message: 'API Error: 400 bad model', retryable: true } })
    await tick()

    expect(reports()).toHaveLength(1)
    expect(reports()[0]).toContain('실패했습니다')
    expect(reports()[0]).toContain('API Error: 400 bad model')
    expect(reports()[0]).not.toContain('끝났습니다')

    // 사람이 직접 말을 건 턴과, 부탁 없이 시킨 턴은 보고하지 않는다
    await rpc('agents.send', { sessionId: worker, text: '직접 묻는 말' })
    w.emit({ type: 'turn_complete', sessionId: worker })
    await tools.sendToSession(worker, '조용히 해 줘', false)
    w.emit({ type: 'turn_complete', sessionId: worker })
    await tick()
    expect(reports()).toHaveLength(1)
  })

  it('부탁 없이 다시 시키면 이전 부탁은 지워진다 — 새 지시가 그것을 대신한다', async () => {
    const { worker, tools, w, reports } = await setup()
    await tools.sendToSession(worker, '끝나면 알려줘', true)
    await tools.sendToSession(worker, '아니, 이걸 대신 해 줘', false)
    w.emit({ type: 'turn_complete', sessionId: worker })
    await tick()
    expect(reports()).toEqual([])
  })

  it('끝난 턴은 지금처럼 "끝났습니다"로 보고한다', async () => {
    const { worker, tools, w, reports } = await setup()
    await tools.sendToSession(worker, '끝나면 알려줘', true)
    w.emit({ type: 'turn_complete', sessionId: worker })
    await tick()
    expect(reports()).toHaveLength(1)
    expect(reports()[0]).toContain('끝났습니다')
  })
})

/*
 * 기다린 사이에 지워지거나 도구가 바뀐 세션 (#163). 깨우기는 프로세스를 기다린 뒤 세션이 아직 있는지, 아직 같은
 * 도구인지 보지 않고 핸들을 앉히고 행을 다시 썼다.
 */
describe('깨우는 사이에 지우거나 도구를 바꾸면 (#163)', () => {
  async function sleeping() {
    const id = await newSession()
    await mgr.disposeAll()
    return id
  }
  const listed = () => store.listSessions().map((x) => x.id)

  it('깨우는 도중에 지운 세션은 되살아나지 않고, 막 뜬 프로세스는 닫힌다', async () => {
    const id = await sleeping()
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id }) as Promise<{ resumed: boolean }>
    await until(() => claude.asked.length > asked)
    const deleting = rpc('agents.deleteSession', { sessionId: id })
    claude.release()
    expect((await waking).resumed).toBe(false)
    await deleting

    expect(listed()).not.toContain(id)
    expect(claude.last.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
    // host를 다시 켜도 돌아오지 않는다
    const again = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', claude]]), () => {})
    expect(again.listSessions().map((x) => x.id)).not.toContain(id)
  })

  it('도구 쪽 대화까지 지울 때는 깨어나던 프로세스가 닫힌 뒤에 지운다 — 잠금에 막히지 않는다', async () => {
    const id = await sleeping()
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id })
    await until(() => claude.asked.length > asked)
    const deleting = rpc('agents.deleteSession', { sessionId: id, deleteExternal: true })
    claude.release()
    await waking
    await deleting

    expect(listed()).not.toContain(id)
  })

  it('깨우기가 send에서 시작됐으면, 지운 세션의 에이전트는 그 말을 받지 않는다', async () => {
    const id = await sleeping()
    claude.hold()
    const asked = claude.asked.length
    const sending = rpc('agents.send', { sessionId: id, text: 'rm the old build dir' })
    const failed = sending.then(() => null, (e: Error) => e)
    await until(() => claude.asked.length > asked)
    const deleting = rpc('agents.deleteSession', { sessionId: id })
    claude.release()
    await deleting

    expect(await failed).toBeInstanceOf(Error)
    expect(claude.last.sent).toEqual([])
    expect(listed()).not.toContain(id)
  })

  it('깨우는 도중에 도구를 바꾸면 옛 도구의 프로세스가 남지 않는다', async () => {
    const id = await sleeping()
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id }) as Promise<{ resumed: boolean }>
    await until(() => claude.asked.length > asked)
    const switching = rpc('agents.switchTool', { sessionId: id, tool: 'codex' })
    claude.release()
    await waking
    await switching

    expect(claude.last.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
    const m = mgr.listSessions().find((x) => x.id === id)!
    expect(m.tool).toBe('codex')
    expect(m.externalId).toBe(null)
  })

  it('도구 바꾸기가 확인하는 사이에 시작된 깨우기도 옛 도구의 핸들을 앉히지 않는다', async () => {
    const id = await sleeping()
    codex.detectGate = new Promise((r) => (codex.openDetect = r))
    const switching = rpc('agents.switchTool', { sessionId: id, tool: 'codex' })
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id }) as Promise<{ resumed: boolean }>
    await until(() => claude.asked.length > asked) // 깨우기는 아직 claude로 뜬다
    codex.openDetect!()
    await switching
    claude.release()

    expect((await waking).resumed).toBe(false)
    expect(claude.last.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
    expect(mgr.listSessions().find((x) => x.id === id)!.externalId).toBe(null)
  })

  it('턴 도중에 도구를 바꾸면 meta와 저장소도 idle이다 — 방송만 idle이 아니다', async () => {
    const id = await newSession()
    await rpc('agents.send', { sessionId: id, text: '긴 일' })
    expect(mgr.listSessions().find((x) => x.id === id)!.state).toBe('working')

    await rpc('agents.switchTool', { sessionId: id, tool: 'codex' })
    expect(mgr.listSessions().find((x) => x.id === id)!.state).toBe('idle')
    expect(store.listSessions().find((x) => x.id === id)!.state).toBe('idle')
  })

  it('PR을 확인하는 사이에 지운 워크트리 세션은 id 없는 행으로 남지 않는다', async () => {
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    const internals = mgr as unknown as { meta: Map<string, { worktree: unknown }> }
    internals.meta.get(s.id)!.worktree = { path: tmpdir(), branch: 'centralu/x', base: 'main' }
    mgr.prLookup = async () => {
      await rpc('agents.deleteSession', { sessionId: s.id })
      return { number: 7, state: 'merged', url: 'u', headOid: 'abc' }
    }

    await mgr.refreshMergedWorktrees(p.id)
    expect(mgr.listSessions().every((x) => typeof x.id === 'string')).toBe(true)
    expect(internals.meta.has(s.id)).toBe(false)
  })
})

/*
 * 턴 도중의 설정 변경 (#164). 두 어댑터 모두 실시간 반영이 없어서 설정이 바뀌면 곧바로 프로세스를 갈아 끼웠다 — 도는
 * 턴이 사라졌는데 화면은 "(from next turn)"이라고 말했다.
 */
describe('턴 도중에 바꾼 설정은 턴이 끝나면 적용된다 (#164)', () => {
  it('working이면 프로세스를 내리지 않고, 턴이 끝나면 새 설정으로 갈아 끼운다', async () => {
    const id = await newSession()
    const running = claude.last
    await rpc('agents.send', { sessionId: id, text: '긴 일' })

    const r = (await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })) as { applied?: string }
    expect(r.applied).toBe('after_turn')
    expect(running.disposed).toBe(false)
    expect(claude.last).toBe(running)

    running.emit({ type: 'turn_complete', sessionId: id })
    await until(() => claude.last !== running)
    expect(running.disposed).toBe(true)
    expect(claude.last.opts.effort).toBe('high')
  })

  it('승인을 기다리는 턴도 끊지 않는다 — 턴이 오류로 끝나도 그때 적용한다', async () => {
    const id = await newSession('safe')
    const running = claude.last
    running.emit({ type: 'approval_request', sessionId: id, requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })

    const r = (await rpc('agents.updateSettings', { sessionId: id, permissionPreset: 'auto' })) as { applied?: string }
    expect(r.applied).toBe('after_turn')
    expect(running.disposed).toBe(false)

    running.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: 'API Error: 500', retryable: true } })
    await until(() => claude.last !== running)
    expect(claude.last.opts.permissionPreset).toBe('auto')
  })

  it('쉬는 세션은 지금 갈아 끼우고 그렇다고 답한다', async () => {
    const id = await newSession()
    const r = (await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })) as { applied?: string }
    expect(r.applied).toBe('restarted')
    expect(claude.last.opts.effort).toBe('high')
  })
})

/*
 * 목록 밖의 오래된 대화 (#165). 깨우기 전의 "도구에 아직 있나" 확인은 도구가 준 최신 200개만 봤다 — 201번째보다
 * 오래된 대화는 파일이 멀쩡해도 "기록이 없다"로 막혔고, 다시 눌러도 같은 200개가 돌아왔다.
 */
describe('도구의 목록이 가득 차면 목록에 없다고 없는 것이 아니다 (#165)', () => {
  class Listing extends Adapter {
    rows: { externalId: string; updatedAt: number }[] = []
    failWith: string | null = null
    async listExternalSessions(_cwd: string, limit: number) {
      return this.rows.slice(0, limit).map((r) => ({ ...r, title: r.externalId, messageCount: 1 }))
    }
    override async createSession(opts: CreateSessionOpts, emit: EventSink) {
      if (this.failWith && opts.resumeExternalId) throw new Error(this.failWith)
      return super.createSession(opts, emit)
    }
  }
  let listing: Listing

  beforeEach(() => {
    listing = new Listing('claude')
    const adapters = new Map<ToolName, AgentAdapter>([['claude', listing]])
    mgr = new SessionManager(store, adapters, (e) => events.push(e))
    rpc = createRpcHandler(mgr, adapters)
  })

  /** 이 세션의 대화(ext-1)보다 새 대화 n개 */
  const newer = (n: number) => Array.from({ length: n }, (_, i) => ({ externalId: `newer-${i}`, updatedAt: 1_000_000 - i }))

  it('더 새로운 대화 250개 뒤의 대화도 깨운다', async () => {
    const id = await newSession()
    await mgr.disposeAll()
    listing.rows = newer(250)

    const r = (await rpc('agents.resumeSession', { sessionId: id })) as { resumed: boolean; reason?: string }
    expect(r.reason).toBeUndefined()
    expect(r.resumed).toBe(true)
  })

  it('목록이 다 온 것이면 지금처럼 "기록이 없다"고 말한다', async () => {
    const id = await newSession()
    await mgr.disposeAll()
    listing.rows = newer(3)

    const r = (await rpc('agents.resumeSession', { sessionId: id })) as { resumed: boolean; reason?: string }
    expect(r.resumed).toBe(false)
    expect(r.reason).toMatch(/has no record of this conversation/)
  })

  it('이어가기가 다른 이유로 실패하면 목록이 가득 찼어도 진짜 오류를 돌려준다', async () => {
    const id = await newSession()
    await mgr.disposeAll()
    listing.rows = newer(250)
    listing.failWith = 'API Error: 529 overloaded'

    const r = (await rpc('agents.resumeSession', { sessionId: id })) as { resumed: boolean; reason?: string }
    expect(r.resumed).toBe(false)
    expect(r.reason).toContain('529 overloaded')
  })
})
