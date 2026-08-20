/**
 * T4-2 완료 기준: 동일한 계약 테스트 스위트를 두 구현(web/mock)에 실행한다.
 * 구현이 갈라지면 여기서 잡힌다 — Tauri 구현이 추가되면 세 번째 항목으로 넣는다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { HostServer } from '../../agent-host/src/transport/server.js'
import { SessionManager } from '../../agent-host/src/sessions/manager.js'
import { Store } from '../../agent-host/src/dev-services/store.js'
import { createRpcHandler } from '../../agent-host/src/rpc.js'
import { UpdateService } from '../../agent-host/src/updates.js'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../../agent-host/src/adapters/contract.js'
import type { ApprovalDecision, NormalizedEvent, ToolName } from '@cc/protocol'
import { APP_VERSION } from '@cc/protocol'
import type { Platform } from './ports/index.js'
import { createMockPlatform } from './mock/index.js'
import { createWebPlatform } from './web/index.js'

/** web 구현 테스트를 위한 최소 실 host (어댑터만 가짜) */
class EchoHandle implements SessionHandle {
  externalId = 'ext-1'
  constructor(readonly sessionId: string, private emit: EventSink) {}
  send(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: `echo:${text}` })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval(requestId: string, decision: ApprovalDecision): boolean {
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
    return true
  }
  interrupt() {}
  async dispose() {}
}
class EchoAdapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  readonly capabilities = { approvals: true, contextUsage: 'exact' as const, resume: true, autoTitle: true, attachments: ['image' as const] }
  async detect() { return { tool: this.tool, installed: true, loggedIn: true, detail: 'echo' } }
  async createSession(opts: CreateSessionOpts, emit: EventSink) { return new EchoHandle(opts.sessionId, emit) }
}

/**
 * `offerUpdate`: 레지스트리에 그 버전이 올라와 있는 상황을 만든다 (이슈 #43).
 * 두 구현이 같은 자극에 같은 답을 하는지가 이 파일의 존재 이유다.
 */
type Harness = { platform: Platform; cleanup: () => Promise<void>; offerUpdate: (version: string) => void }

async function makeWeb(): Promise<Harness> {
  const store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', new EchoAdapter()]])
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  /*
   * 레지스트리도 `npm i -g`도 **주입한다.**
   *
   * 안 그러면 이 스위트가 도는 동안 진짜 레지스트리에 요청이 나가고, 최악의 경우
   * 테스트가 이 기계의 전역 패키지를 갈아 끼운다. 여기 있는 두 줄이 그 일이 일어날 수
   * 없다는 보장이다 — 규칙이 아니라 구조로.
   */
  let registryVersion: string | null = null
  const updates = new UpdateService((status) => server.broadcast({ type: 'update_status', status }), {
    fetchLatest: async () =>
      registryVersion === null
        ? { ok: false as const, reason: 'Could not reach the registry — check the network' }
        : { ok: true as const, version: registryVersion },
    run: async () => {},
  })
  const server = new HostServer({
    port: 0,
    token: 'contract',
    onRpc: createRpcHandler(mgr, adapters, undefined, updates),
  })
  const port = await server.listen()
  const platform = createWebPlatform({
    hostUrl: `ws://127.0.0.1:${port}`,
    token: 'contract',
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  })
  await waitFor(() => platform.agents.listSessions().then(() => true).catch(() => false))
  return {
    platform,
    offerUpdate: (version) => {
      registryVersion = version
    },
    cleanup: async () => {
      await platform.dispose()
      await mgr.disposeAll()
      await server.close()
      store.close()
    },
  }
}

async function makeMock(): Promise<Harness> {
  const platform = createMockPlatform()
  return {
    platform,
    offerUpdate: (version) => {
      platform.registryVersion = version
    },
    cleanup: async () => platform.dispose(),
  }
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await pred()) return
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe.each([
  ['mock', makeMock],
  ['web(+실 host)', makeWeb],
])('Platform 계약: %s', (_name, make) => {
  let h: Harness
  let events: NormalizedEvent[]

  beforeAll(async () => {
    h = await make()
    events = []
    h.platform.agents.subscribe((e) => events.push(e))
  })
  afterAll(async () => h.cleanup())

  it('프로젝트를 등록하고 목록에 나온다', async () => {
    const p = await h.platform.projects.add(tmpdir())
    expect(p.path).toBe(tmpdir())
    const list = await h.platform.projects.list()
    expect(list.some((x) => x.id === p.id)).toBe(true)
  })

  it('같은 경로 재등록은 중복을 만들지 않는다', async () => {
    const before = (await h.platform.projects.list()).length
    await h.platform.projects.add(tmpdir())
    expect((await h.platform.projects.list()).length).toBe(before)
  })

  /**
   * 등록한 셸 명령은 **프로젝트와 함께 온다** (이슈 #44).
   *
   * 저장이 되는지만 보는 테스트가 아니다. 실행 메뉴는 목록을 따로 묻지 않고 프로젝트에
   * 딸려 온 것을 그대로 그리므로, 저장은 됐는데 `list()`가 안 실어 보내면 화면에는
   * "등록한 적이 없다"로 보인다 — 두 구현이 같은 답을 하는지가 여기서 갈린다.
   */
  it('프로젝트에 등록한 셸 명령이 목록과 함께 돌아온다 (#44)', async () => {
    const [p] = await h.platform.projects.list()
    const saved = await h.platform.projects.setCommands(p!.id, ['pnpm test', '   ', 'pnpm lint'])
    // 빈 줄은 저장되지 않는다 — 눌러도 아무 일도 일어나지 않는 줄이 목록에 남으면 안 된다
    expect(saved).toEqual(['pnpm test', 'pnpm lint'])
    const found = (await h.platform.projects.list()).find((x) => x.id === p!.id)
    expect(found?.commands).toEqual(['pnpm test', 'pnpm lint'])

    // 지우기도 같은 문으로 온다 — 남은 것만 보내면 그것이 곧 목록이다
    await h.platform.projects.setCommands(p!.id, ['pnpm lint'])
    expect((await h.platform.projects.list()).find((x) => x.id === p!.id)?.commands).toEqual(['pnpm lint'])
  })

  it('세션 생성 → 목록 반영', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    expect(s.id).toBeTruthy()
    const list = await h.platform.agents.listSessions()
    expect(list.some((x) => x.id === s.id)).toBe(true)
  })

  it('전송하면 이벤트가 구독자에게 온다', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    events.length = 0
    await h.platform.agents.send(s.id, '안녕')
    await waitFor(() => events.length > 0)
    expect(events.some((e) => e.sessionId === s.id)).toBe(true)
  })

  it('첫 메시지가 세션 이름이 된다 (FR-18)', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.send(s.id, 'auth 리팩터링해줘')
    await waitFor(async () => (await h.platform.agents.listSessions()).find((x) => x.id === s.id)?.name === 'auth 리팩터링해줘')
  })

  it('rename 후에는 자동 이름이 덮어쓰지 않는다', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.rename(s.id, '내 세션')
    await h.platform.agents.send(s.id, '다른 프롬프트')
    const found = (await h.platform.agents.listSessions()).find((x) => x.id === s.id)
    expect(found?.name).toBe('내 세션')
  })

  it('markRead는 뒤로 가지 않는다', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.markRead(s.id, 10)
    await h.platform.agents.markRead(s.id, 3)
    const found = (await h.platform.agents.listSessions()).find((x) => x.id === s.id)
    expect(found?.lastReadSeq).toBe(10)
  })

  it('메시지를 저장하고 다시 읽는다', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.send(s.id, '기록될 메시지')
    await waitFor(async () => (await h.platform.agents.loadMessages(s.id)).length > 0)
    const msgs = await h.platform.agents.loadMessages(s.id)
    expect(msgs[0]!.role).toBe('user')
  })

  it('아카이브하면 archived=true (기록은 남는다)', async () => {
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.archiveSession(s.id)
    const found = (await h.platform.agents.listSessions()).find((x) => x.id === s.id)
    expect(found?.archived).toBe(true)
  })

  /**
   * 자판 표기도 capability다 (이슈 #32).
   *
   * ui에는 뒤에 붙은 구현이 없어서, 거기 OS 분기를 두면 우리가 돌리는 어떤 테스트에도
   * 안 보인다 — 그래서 `⌘`는 포트를 통해 온다. 두 구현이 여기서 같은 답을 하는지 본다:
   * 한쪽만 조용히 바뀌면 브라우저에서 보던 화면과 앱에서 보는 화면이 갈라진다.
   *
   * **두 구현 다 맥 표기가 정답이다.** 실제 자판을 아는 건 Rust뿐이고(tauri 구현),
   * 이 둘은 각각 개발 서버와 E2E의 것이라 자판을 짐작하기 시작하면 테스트가 도는
   * 기계에 따라 결과가 달라진다.
   */
  it('자판이 조합키를 뭐라고 부르는지 답한다 (#32)', () => {
    const keys = h.platform.capabilities.shortcutKeys
    expect(keys.mod).toBe('⌘')
    expect(keys.alt).toBe('⌥')
    // 기호는 붙여 쓴다 (`⌘⇧A`). 이름이 되는 자판에서만 구분자가 생긴다
    expect(keys.join).toBe('')
  })

  it('capabilities와 detect를 노출한다', async () => {
    expect((await h.platform.agents.capabilities('claude')).approvals).toBe(true)
    expect((await h.platform.agents.detect()).length).toBeGreaterThan(0)
  })

  it('없는 세션 조작은 에러', async () => {
    await expect(h.platform.agents.send('nope', 'x')).rejects.toThrow()
  })

  /**
   * 업데이트: 알리는 데서 멈춘다 (이슈 #43).
   *
   * 알아냈다는 사실만으로는 아무것도 바뀌지 않는지를 본다. `phase`가 'idle'이라는 것이
   * 그 말이다 — 새 버전을 찾은 것과 그것을 설치한 것 사이에는 사람의 클릭이 있다.
   */
  it('레지스트리에 새것이 있으면 알리되 스스로 설치하지 않는다 (#43)', async () => {
    h.offerUpdate('9999.0.0')
    const s = await h.platform.updates.status(true)
    expect(s.current).toBe(APP_VERSION)
    expect(s.latest).toBe('9999.0.0')
    expect(s.newer).toBe(true)
    expect(s.phase).toBe('idle')
  })

  /**
   * 꺼 두면 진짜로 안 묻는다.
   *
   * 이 체크상자가 장식이 되는 방식은 하나다: 주기 요청만 막고 **기동 직후의 한 번**은
   * 그대로 나가는 것. 화면은 앱을 열 때마다 `status(force: false)`를 부르므로, 그 자리에
   * 가드가 없으면 껐다고 말한 사람의 기계에서 요청이 계속 나간다.
   */
  it('자동 확인을 끄면 자동 호출은 레지스트리에 닿지 않는다 (#43)', async () => {
    await h.platform.updates.setAuto(false)
    h.offerUpdate('8888.0.0')
    // 자동 호출은 아무 데도 안 갔다 — 알던 답이 그대로다
    expect((await h.platform.updates.status(false)).latest).toBe('9999.0.0')
    // 사람이 누른 것은 여전히 통한다
    expect((await h.platform.updates.status(true)).latest).toBe('8888.0.0')
    // 다시 켜면 그 자리에서 묻는다 — 방금 켠 사람은 지금 궁금한 것이다
    h.offerUpdate('9999.0.0')
    expect((await h.platform.updates.setAuto(true)).latest).toBe('9999.0.0')
  })

  /**
   * 설치는 **시작하자마자** 답하고, 끝났다는 말은 이벤트로 온다 (이슈 #43).
   *
   * `npm i -g`는 RPC 제한 시간(30초)을 넘기는 일이 흔하다. 끝을 기다리는 계약으로 두면
   * 실제로는 성공한 설치가 화면에서는 시간 초과로 보이고, 그 뒤로 두 쪽이 서로 다른
   * 이야기를 하게 된다.
   *
   * 마지막 줄이 이 기능의 전부다: 끝났는데도 **앱은 그대로 돌고 있다.**
   */
  it('설치는 시작을 답하고 완료는 이벤트로 알린다 — 스스로 재시작하지 않는다 (#43)', async () => {
    h.offerUpdate('9999.0.0')
    await h.platform.updates.status(true)
    events.length = 0

    const started = await h.platform.updates.apply()
    expect(started.phase).toBe('updating')

    await waitFor(() => events.some((e) => e.type === 'update_status' && e.status.phase === 'restart_required'))
    expect((await h.platform.updates.status(false)).phase).toBe('restart_required')
  })

  it('구독 해제가 동작한다', async () => {
    const seen: NormalizedEvent[] = []
    const off = h.platform.agents.subscribe((e) => seen.push(e))
    const [p] = await h.platform.projects.list()
    const s = await h.platform.agents.createSession({ projectId: p!.id, cwd: p!.path, tool: 'claude', permissionPreset: 'normal' })
    await h.platform.agents.send(s.id, 'a')
    await waitFor(() => seen.length > 0)
    const count = seen.length
    off()
    await h.platform.agents.send(s.id, 'b')
    await new Promise((r) => setTimeout(r, 100))
    expect(seen.length).toBe(count)
  })
})
