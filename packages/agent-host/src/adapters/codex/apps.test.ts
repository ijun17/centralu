import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import * as kit from '../../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from '../../sessions/session-apps.js'
import { attachWorld, type AttachWorld } from '../../sessions/session-apps.test-helpers.js'
import type { CreateSessionOpts, OrchestratorTools, SessionHandle } from '../contract.js'
import { bridgePath } from './bridge-path.js'

/**
 * Codex 세션에 붙은 외부 앱 (M4 A-5) — 앱마다 stdio 다리, 스레드를 시작·재개할 때 싣는다.
 *
 * 가짜는 app-server 클라이언트 하나다: 우리가 보낸 요청(스레드 설정)을 적고, 서버 요청(elicitation)을
 * 흉내 낸다. 앱 쪽은 진짜 런타임과 진짜 앱(도구 목록·주석)이다.
 *
 * **Codex의 동작은 소스·타입으로만 확인했다** (로그아웃이라 실행으로 재지 못했다, 플랜 S-3·S-7).
 * 이 테스트가 보는 것은 "우리가 Codex에게 무엇을 보내고, Codex가 보낼 것에 어떻게 답하는가"다.
 */

type Req = { method: string; params: Record<string, unknown> }
type Fake = {
  requests: Req[]
  responses: { id: number | string; payload: unknown }[]
  trigger(r: { id: number | string; method: string; params?: unknown }): void
}

const state = vi.hoisted(() => ({ instances: [] as Fake[] }))

vi.mock('./client.js', () => ({
  CodexClient: class {
    requests: Req[] = []
    responses: { id: number | string; payload: unknown }[] = []
    constructor(private handlers: { onServerRequest: (r: unknown) => void }) {
      state.instances.push(this as unknown as Fake)
    }
    request(method: string, params: Record<string, unknown> = {}) {
      this.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' } })
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: params.threadId } })
      return Promise.resolve({})
    }
    notify() {}
    respond(id: number | string, payload: unknown) {
      this.responses.push({ id, payload })
    }
    trigger(r: unknown) {
      this.handlers.onServerRequest(r)
    }
    async dispose() {}
  },
}))

const { CodexAdapter } = await import('./index.js')

let w: AttachWorld
let hub: SessionAppsHub
let handle: SessionHandle | null = null
let events: NormalizedEvent[] = []

const BRIDGE = { url: 'ws://127.0.0.1:5999', token: 'tok-bridge' }
const WORKER: AppSessionKey = { id: 'codex-s1', kind: 'worker', projectId: 'p1' }
const ORCH: AppSessionKey = { id: 'codex-o1', kind: 'orchestrator', projectId: null }

async function start(key: AppSessionKey, over: Partial<CreateSessionOpts> = {}) {
  state.instances.length = 0
  events = []
  handle = await new CodexAdapter().createSession(
    // 프로젝트의 앱은 신뢰한 프로젝트에만 붙는다(결정 4) — 매니저가 넘기는 것과 같게 그 세션은 신뢰한 프로젝트의 것이다
    { sessionId: key.id, cwd: '/tmp', permissionPreset: 'normal', projectTrusted: key.projectId !== null, apps: hub.attach(key), orchestratorBridge: BRIDGE, ...over },
    (e) => events.push(e),
  )
  return state.instances[0]!
}
const threadConfig = (c: Fake, method: 'thread/start' | 'thread/resume') =>
  c.requests.find((r) => r.method === method)!.params.config as Record<string, unknown>
const mcpServers = (c: Fake, method: 'thread/start' | 'thread/resume' = 'thread/start') =>
  (threadConfig(c, method).mcp_servers ?? null) as Record<string, Record<string, unknown>> | null

beforeEach(() => {
  w = attachWorld(kit)
  w.plant('p1', 'notes')
  w.plant('p1', 'tasks')
  w.plant('p2', 'other')
  w.plant('user', 'helper')
  w.rt.refresh()
  hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000 })
})

afterEach(async () => {
  await handle?.dispose()
  handle = null
  hub.dispose()
  await w.dispose()
})

describe('thread/start — 앱마다 다리 하나', () => {
  it('붙은 앱마다 다리가 실린다: host로 돌아올 주소와 세션·서버 이름, 도구 상한', async () => {
    const c = await start(WORKER)
    const servers = mcpServers(c)!
    expect(Object.keys(servers).sort()).toEqual(['app-notes', 'app-tasks'])
    expect(servers['app-notes']).toMatchObject({
      command: process.execPath,
      args: [bridgePath()],
      env: { CC_HOST_URL: BRIDGE.url, CC_HOST_TOKEN: BRIDGE.token, CC_SESSION_ID: 'codex-s1', CC_APP_SERVER: 'app-notes' },
      tool_timeout_sec: 300,
    })
    // 오래 걸리는 호출은 Codex의 300초 상한보다 먼저(240초) 실행 id로 돌려받는다 — 값은 다리가 host로 나른다
    expect((servers['app-notes']!.env as Record<string, string>).CC_APP_WAIT_MS).toBe('240000')
    // 신뢰한 프로젝트의 워커다 — 오케스트레이터의 다리도, 문서 막기도 없다
    expect(servers).not.toHaveProperty('centralu')
    expect(threadConfig(c, 'thread/start')).not.toHaveProperty('project_doc_max_bytes')
  })

  it('붙은 앱이 없는 세션에는 다리가 하나도 없다 — 대부분의 세션은 프로세스를 더 띄우지 않는다', async () => {
    const c = await start({ id: 'codex-s2', kind: 'worker', projectId: 'p2' })
    expect(mcpServers(c)).toBeNull()
  })

  const modes: [PermissionPreset, string][] = [
    ['auto', 'approve'],
    ['normal', 'writes'],
    ['safe', 'prompt'],
  ]
  for (const [preset, mode] of modes) {
    it(`${preset} → default_tools_approval_mode ${mode}, 읽기 전용 도구는 어느 프리셋에서도 approve`, async () => {
      const c = await start(WORKER, { permissionPreset: preset })
      expect(mcpServers(c)!['app-notes']).toMatchObject({
        default_tools_approval_mode: mode,
        tools: { peek: { approval_mode: 'approve' } },
      })
      // 읽기 전용이 아닌 도구는 도구별 칸이 없다 — 프리셋의 방식을 따른다. run_status는 host의 읽기 전용 도구다
      expect(Object.keys(mcpServers(c)!['app-notes']!.tools as object).sort()).toEqual(['peek', 'run_status'])
    })
  }
})

describe('thread/resume — 재개에도 서버를 다시 싣는다', () => {
  it('워커의 재개에 앱 다리가 실린다 (스레드가 도는 동안 붙은 앱은 여기서 붙는다)', async () => {
    const c = await start(WORKER, { resumeExternalId: 'thread-9' })
    await (handle as unknown as { ready: Promise<void> }).ready
    expect(Object.keys(mcpServers(c, 'thread/resume')!).sort()).toEqual(['app-notes', 'app-tasks'])
    expect(mcpServers(c, 'thread/resume')!['app-notes']).toMatchObject({ default_tools_approval_mode: 'writes' })
  })

  // 승인된 MCP 서버는 사용자 폴더의 앱(app-helper 자리)으로 온다 — 날것으로 실리는 서버는 없다 (A-7)
  it('오케스트레이터의 재개에는 centralu와 사용자 폴더 앱의 다리, 문서 막기가 함께 실린다', async () => {
    const c = await start(ORCH, {
      resumeExternalId: 'thread-o',
      orchestratorTools: {} as OrchestratorTools,
      toolProfile: 'orchestrator',
    })
    await (handle as unknown as { ready: Promise<void> }).ready
    const config = threadConfig(c, 'thread/resume')
    expect(config.project_doc_max_bytes).toBe(0)
    expect(Object.keys(mcpServers(c, 'thread/resume')!).sort()).toEqual(['app-helper', 'centralu'])
    expect(mcpServers(c, 'thread/resume')!['centralu']).toMatchObject({
      command: process.execPath,
      args: [bridgePath()],
      env: { CC_HOST_URL: BRIDGE.url, CC_HOST_TOKEN: BRIDGE.token, CC_SESSION_ID: 'codex-o1' },
    })
  })
})

describe('elicitation — 앱 도구 승인은 우리 카드로, 나머지는 예전 그대로', () => {
  const approval = (id: number, serverName: string, meta: Record<string, unknown> = { codex_approval_kind: 'mcp_tool_call' }) => ({
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread-1',
      turnId: null,
      serverName,
      mode: 'form',
      message: `Allow ${serverName} to run a tool?`,
      requestedSchema: { type: 'object', properties: {} },
      _meta: { tool_title: 'poke', tool_params: { to: 3 }, ...meta },
    },
  })

  it('붙인 앱의 도구 승인은 카드가 되고, 사람의 답이 elicitation 응답으로 간다', async () => {
    const c = await start(WORKER)
    c.trigger(approval(21, 'app-notes'))
    // 자동으로 답하지 않는다 — 사람을 기다린다
    expect(c.responses).toEqual([])
    const card = events.find((e) => e.type === 'approval_request')
    expect(card).toMatchObject({
      type: 'approval_request',
      requestId: 'codex-req-1',
      detail: { kind: 'other', raw: 'app-notes · poke {"to":3}' },
    })

    expect(handle!.respondApproval('codex-req-1', 'allow')).toBe(true)
    expect(c.responses).toContainEqual({ id: 21, payload: { action: 'accept', content: null, _meta: null } })

    c.trigger(approval(22, 'app-notes'))
    handle!.respondApproval('codex-req-2', 'deny')
    expect(c.responses).toContainEqual({ id: 22, payload: { action: 'decline', content: null, _meta: null } })

    c.trigger(approval(23, 'app-tasks', { 'codex/approval_kind': 'mcp_tool_call' }))
    handle!.respondApproval('codex-req-3', 'always')
    expect(c.responses).toContainEqual({ id: 23, payload: { action: 'accept', content: null, _meta: { persist: 'session' } } })
  })

  it('모르는 서버, 붙이지 않은 app- 서버, 도구 승인이 아닌 elicitation은 여전히 거절한다', async () => {
    const c = await start(WORKER)
    const DECLINE = { action: 'decline', content: null, _meta: null }
    c.trigger(approval(31, 'playwright'))
    // 이름은 앱 같지만 이 스레드에 우리가 싣지 않은 서버 (사용자의 config.toml 등)
    c.trigger(approval(32, 'app-other'))
    // 붙인 앱이라도 도구 승인이 아닌 입력 양식은 그릴 화면이 없다
    c.trigger(approval(33, 'app-notes', { codex_approval_kind: 'something_else' }))
    expect(c.responses).toEqual([
      { id: 31, payload: DECLINE },
      { id: 32, payload: DECLINE },
      { id: 33, payload: DECLINE },
    ])
    expect(events.filter((e) => e.type === 'approval_request')).toEqual([])
  })

  it('centralu의 elicitation은 예전처럼 받아들인다 (앱과 섞이지 않는다)', async () => {
    const c = await start(ORCH, { orchestratorTools: {} as OrchestratorTools, toolProfile: 'orchestrator' })
    c.trigger({ id: 41, method: 'mcpServer/elicitation/request', params: { serverName: 'centralu' } })
    expect(c.responses).toContainEqual({ id: 41, payload: { action: 'accept', content: null, _meta: null } })
  })
})

/**
 * 세션을 멈추면 다리로 들어온 앱 호출이 멈춘다 (M4 A-5) — **턴이 없어도.** 240초를 넘겨 먼저
 * 돌려준 호출은 턴이 끝난 뒤에도 돈다. 다리는 판단하지 않으므로 host의 어댑터가 끊는다.
 * 다리의 호출은 host의 세션 문(`forSession`)으로 들어온다 — 여기서도 그 문으로 부른다.
 */
describe('멈추면 앱 호출도 멈춘다 — Codex', () => {
  it('interrupt는 도는 턴이 없어도 이 세션의 앱 호출을 취소한다', async () => {
    const c = await start(WORKER)
    const p = hub.forSession(WORKER.id).call('app-notes', 'hold', {})
    await kit.until(() => w.records('notes').some((r) => r.t === 'holding'), Boolean)
    handle!.interrupt()
    expect((await p).isError).toBe(true)
    await kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)
    // 턴이 없었으므로 Codex에는 아무것도 보내지 않았다 — 멈춘 것은 host다
    expect(c.requests.some((r) => r.method === 'turn/interrupt')).toBe(false)
  })

  it('dispose도 이 세션의 앱 호출을 취소한다', async () => {
    await start(WORKER)
    const p = hub.forSession(WORKER.id).call('app-notes', 'hold', {})
    await kit.until(() => w.records('notes').some((r) => r.t === 'holding'), Boolean)
    await handle!.dispose()
    handle = null
    expect((await p).isError).toBe(true)
  })
})
