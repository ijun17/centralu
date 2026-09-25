import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as kit from '../../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from '../../sessions/session-apps.js'
import { attachWorld, type AttachWorld } from '../../sessions/session-apps.test-helpers.js'
import type { CreateSessionOpts, OrchestratorTools, SessionHandle } from '../contract.js'

/**
 * Claude 세션에 붙은 외부 앱 (M4 A-5) — 앱마다 인프로세스 대리 서버.
 *
 * 가짜는 `query` 하나다: CLI를 띄우지 않고 SDK에 넘긴 옵션과 `setMcpServers` 호출을 적는다.
 * 대리 서버는 **진짜** `createSdkMcpServer`로 만들어지고, 테스트가 CLI 자리에 서서 JSON-RPC를
 * 직접 보낸다 — 앱 쪽은 진짜 런타임과 진짜 앱 프로세스(픽스처)다. 그래서 "CLI가 부른 도구가
 * 런타임의 한 길을 세션 호출자로 지나 기록된다"를 끝에서 끝까지 본다.
 */

type Sent = { jsonrpc: '2.0'; id?: number; method?: string; result?: Record<string, unknown>; error?: unknown }

const captured = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  setCalls: [] as Record<string, unknown>[],
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importActual) => ({
  ...(await importActual<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (args: { options: Record<string, unknown> }) => {
    captured.options = args.options
    return {
      // eslint-disable-next-line require-yield -- 옵션과 서버 집합만 보면 되므로 스트림은 조용하다
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {})
      },
      interrupt: async () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
      setMcpServers: async (servers: Record<string, unknown>) => {
        captured.setCalls.push(servers)
        return { added: [], removed: [], errors: {} }
      },
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

let w: AttachWorld
let hub: SessionAppsHub
let handle: SessionHandle | null = null

const WORKER: AppSessionKey = { id: 'claude-s1', kind: 'worker', projectId: 'p1' }
const servers = () => (captured.options?.mcpServers ?? {}) as Record<string, { type?: string; name?: string; instance?: unknown }>

async function start(key: AppSessionKey, over: Partial<CreateSessionOpts> = {}) {
  handle = await new ClaudeAdapter().createSession(
    { sessionId: key.id, cwd: '/tmp', permissionPreset: 'normal', apps: hub.attach(key), ...over },
    () => {},
  )
  return handle
}

/** 대리 서버에 CLI처럼 붙는다 — SDK의 v1 서버가 받는 전송의 모양 그대로 */
async function connect(server: string) {
  const sent: Sent[] = []
  const pipe = {
    onmessage: undefined as ((m: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    async start() {},
    async send(m: Sent) {
      sent.push(m)
    },
    async close() {},
  }
  const cfg = servers()[server] as { instance: { connect(t: unknown): Promise<void> } }
  await cfg.instance.connect(pipe)
  let id = 0
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const my = ++id
    pipe.onmessage!({ jsonrpc: '2.0', id: my, method, params })
    const res = await kit.until(() => sent.find((m) => m.id === my), (m) => m !== undefined, 15_000)
    if (res!.error) throw new Error(JSON.stringify(res!.error))
    return res!.result!
  }
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-cli', version: '0' } })
  pipe.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { request, sent }
}

beforeEach(() => {
  captured.options = null
  captured.setCalls = []
  w = attachWorld(kit)
  w.plant('p1', 'notes')
  w.plant('p1', 'tasks')
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

describe('앱마다 인프로세스 대리 서버', () => {
  it('붙은 앱마다 app-<id> 서버가 실리고, 일반 워커는 여전히 사용자 설정을 읽는다', async () => {
    await start(WORKER)
    expect(Object.keys(servers()).sort()).toEqual(['app-notes', 'app-tasks'])
    expect(servers()['app-notes']).toMatchObject({ type: 'sdk', name: 'app-notes' })
    // 오케스트레이터만 파일의 지시를 닫는다 — 앱이 붙었다고 워커의 설정 로드가 바뀌지 않는다
    expect(captured.options).not.toHaveProperty('settingSources')
  })

  it('CLI의 tools/list는 에이전트 도구만 받는다 — 설명·주석·스키마는 앱이 말한 그대로', async () => {
    await start(WORKER)
    const { request } = await connect('app-notes')
    const { tools } = (await request('tools/list')) as { tools: Record<string, unknown>[] }
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('app_only')
    expect(names).toEqual(expect.arrayContaining(['echo', 'peek', 'poke']))
    expect(tools.find((t) => t.name === 'peek')).toMatchObject({
      title: 'Peek',
      description: 'Reads the value without changing anything',
      annotations: { readOnlyHint: true, openWorldHint: false },
    })
    expect(tools.find((t) => t.name === 'poke')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { to: { type: 'number', description: 'the new value' } },
      required: ['to'],
    })
  })

  it('CLI의 tools/call은 런타임의 한 길을 세션 호출자로 지나 기록된다', async () => {
    await start(WORKER)
    const { request } = await connect('app-notes')
    const out = await request('tools/call', { name: 'poke', arguments: { to: 7 } })
    expect(out).toMatchObject({ content: [{ type: 'text', text: 'poked 7' }], isError: false })

    const runs = w.rt.runs({ projectId: 'p1', appId: 'notes' })
    expect(runs.map((r) => [r.tool, r.callerKind, r.callerSessionId, r.status])).toEqual([['poke', 'session', 'claude-s1', 'ok']])

    // 화면 전용 도구는 이름을 알아도 거절된다 — 거절도 한 줄이다
    const refused = await request('tools/call', { name: 'app_only', arguments: {} })
    expect(refused).toMatchObject({ isError: true })
    expect(w.rt.runs({ projectId: 'p1', appId: 'notes' })[0]).toMatchObject({ tool: 'app_only', status: 'rejected', callerKind: 'session' })
  })
})

describe('붙은 앱이 바뀌면 재시작 없이 따라간다', () => {
  const last = () => captured.setCalls.at(-1) ?? null

  it('앱이 생기면 새 집합으로 setMcpServers를 부른다 — 이미 붙은 서버는 같은 객체로', async () => {
    await start(WORKER)
    const notes = servers()['app-notes']
    // 폴더 감시가 부르는 다시 훑기를 직접 부른다 (fs 이벤트의 늦음을 기다리지 않는다 — session-apps.test.ts 참고)
    w.plant('p1', 'fresh')
    w.rt.refresh()
    await kit.until(() => last(), (s) => s !== null && 'app-fresh' in s)
    expect(Object.keys(last()!).sort()).toEqual(['app-fresh', 'app-notes', 'app-tasks'])
    // 같은 객체여야 SDK가 연결을 그대로 둔다 — 새 객체면 무시되거나(같은 이름) 끊겼다 다시 붙는다
    expect(last()!['app-notes']).toBe(notes)
  })

  it('앱이 사라지면 그 서버를 뺀 집합으로 부른다', async () => {
    await start(WORKER)
    rmSync(join(w.roots.p1, '.centralu', 'apps', 'tasks'), { recursive: true, force: true })
    w.rt.refresh()
    await kit.until(() => last(), (s) => s !== null)
    expect(Object.keys(last()!)).toEqual(['app-notes'])
  })

  it('신뢰가 뒤집히면 앱이 모두 떨어지고, 되돌리면 새 대리 서버로 다시 붙는다', async () => {
    await start(WORKER)
    const before = servers()['app-notes']
    w.trust.p1 = false
    w.rt.refresh()
    await kit.until(() => captured.setCalls.length, (n) => n === 1)
    expect(last()).toEqual({})

    w.trust.p1 = true
    w.rt.refresh()
    await kit.until(() => captured.setCalls.length, (n) => n === 2)
    expect(Object.keys(last()!).sort()).toEqual(['app-notes', 'app-tasks'])
    // SDK가 뗀 서버는 다시 연결할 수 없다 — 다시 붙는 앱은 새 객체다
    expect(last()!['app-notes']).not.toBe(before)
  })

  it('오케스트레이터의 집합 바꾸기에는 centralu와 승인된 서버가 처음 그대로 함께 실린다', async () => {
    const tools = {} as OrchestratorTools
    await start({ id: 'orch-1', kind: 'orchestrator', projectId: null }, {
      orchestratorTools: tools,
      toolProfile: 'orchestrator',
      extraMcpServers: [{ name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] }],
    })
    const centralu = servers()['centralu']
    expect(Object.keys(servers()).sort()).toEqual(['app-helper', 'centralu', 'playwright'])

    w.plant('user', 'second')
    w.rt.refresh()
    await kit.until(() => last(), (s) => s !== null && 'app-second' in s)
    expect(Object.keys(last()!).sort()).toEqual(['app-helper', 'app-second', 'centralu', 'playwright'])
    // 빠뜨리면 SDK가 오케스트레이터 서버를 떼어 낸다 — 같은 객체가 그대로 실려야 한다
    expect(last()!['centralu']).toBe(centralu)
  })

  it('붙은 앱의 도구만 바뀌면 서버를 갈지 않고 tools/list_changed를 보낸다', async () => {
    const extra = join(w.root, 'extra.json')
    w.plant('p1', 'grows', ['--mode', 'attach', '--extra-from', extra])
    w.rt.refresh()
    await start(WORKER)
    const { request, sent } = await connect('app-grows')
    await request('tools/list')

    const { writeFileSync } = await import('node:fs')
    writeFileSync(extra, JSON.stringify(['added_later']))
    await w.rt.restart({ projectId: 'p1', appId: 'grows' })
    await w.rt.tools({ projectId: 'p1', appId: 'grows' }, 'model')

    await kit.until(() => sent.filter((m) => m.method === 'notifications/tools/list_changed').length, (n) => n > 0)
    expect(captured.setCalls).toEqual([])
    const { tools } = (await request('tools/list')) as { tools: { name: string }[] }
    expect(tools.map((t) => t.name)).toContain('added_later')
  })
})

/**
 * 앱 도구의 승인 (결정 5): 읽기 전용 주석이 있는 도구는 묻지 않고, 나머지는 세션 프리셋을 따른다.
 * 판정은 붙은 앱이 **실제로 말한** 주석으로 한다 — 이름이 `app-`로 시작한다고 믿어 주지 않는다.
 */
describe('앱 도구의 승인 — 읽기 전용 × 프리셋', () => {
  /** 실제 승인 콜백. 200ms 안에 답이 없으면 사람에게 물은 것이다 (승인 카드가 떴다) */
  async function decide(toolName: string): Promise<unknown> {
    const canUseTool = captured.options?.canUseTool as ((n: string, i: Record<string, unknown>) => Promise<unknown>) | undefined
    expect(typeof canUseTool).toBe('function')
    return Promise.race([canUseTool!(toolName, { to: 1 }), new Promise((r) => setTimeout(() => r('asked-the-human'), 200))])
  }
  const ALLOW = { behavior: 'allow', updatedInput: { to: 1 } }

  for (const preset of ['safe', 'normal'] as const) {
    it(`${preset}: 읽기 전용 도구는 묻지 않고, 나머지 앱 도구는 사람에게 묻는다`, async () => {
      const h = await start(WORKER, { permissionPreset: preset })
      // 모델이 목록을 받은 뒤의 상황 — CLI가 tools/list를 부른 것과 같다
      await (h as unknown as { opts: CreateSessionOpts }).opts.apps!.tools('app-notes')

      expect(await decide('mcp__app-notes__peek')).toEqual(ALLOW)
      expect(await decide('mcp__app-notes__poke')).toBe('asked-the-human')
      // 주석이 없는 도구도 읽기 전용이 아니다
      expect(await decide('mcp__app-notes__echo')).toBe('asked-the-human')
    })
  }

  it('auto: 앱 도구를 포함해 아무것도 묻지 않는다 (콜백 없이 bypassPermissions)', async () => {
    await start(WORKER, { permissionPreset: 'auto' })
    expect(captured.options?.canUseTool).toBeUndefined()
    expect(captured.options?.permissionMode).toBe('bypassPermissions')
  })

  it('이름만 앱을 흉내 내는 도구는 통과하지 못한다 — 붙지 않은 앱, 모르는 목록, 칸을 더 붙인 이름', async () => {
    await start(WORKER, { permissionPreset: 'normal' })
    // 목록을 아직 모른다 — 모델이 우리 목록에서 고른 도구가 아니다
    expect(await decide('mcp__app-notes__peek')).toBe('asked-the-human')
    await w.rt.tools({ projectId: 'p1', appId: 'notes' })
    // 다른 프로젝트의 앱은 이 세션에 붙지 않았다 (읽기 전용 도구가 있어도)
    await w.rt.tools({ projectId: 'p2', appId: 'other' }).catch(() => {})
    expect(await decide('mcp__app-other__peek')).toBe('asked-the-human')
    // 칸을 하나 더 붙여 남의 서버 이름 뒤에 숨은 도구
    expect(await decide('mcp__app-notes__peek__x')).toBe('asked-the-human')
    // 이제 목록을 안다 — 같은 이름이 통과한다
    expect(await decide('mcp__app-notes__peek')).toEqual(ALLOW)
  })
})

/**
 * 오래 걸리는 호출 — Claude의 인프로세스 서버는 호출 상한이 사실상 없다(SDK 기본 약 28시간, sdk.d.ts
 * `createSdkMcpServer`). 그래서 먼저 돌려주지 않고 기다린다. `run_status`는 그래도 목록에 있다 —
 * 두 도구가 같은 목록을 본다.
 */
describe('오래 걸리는 호출 — Claude는 기다린다', () => {
  it('run_status가 목록에 읽기 전용으로 오르고, 승인 없이 불린다', async () => {
    await start(WORKER, { permissionPreset: 'safe' })
    const { request } = await connect('app-notes')
    const { tools } = (await request('tools/list')) as { tools: { name: string; annotations?: Record<string, unknown> }[] }
    expect(tools.find((t) => t.name === 'run_status')?.annotations).toMatchObject({ readOnlyHint: true })
    const canUseTool = captured.options?.canUseTool as (n: string, i: Record<string, unknown>) => Promise<unknown>
    expect(await canUseTool('mcp__app-notes__run_status', { run_id: 'run_x' })).toEqual({ behavior: 'allow', updatedInput: { run_id: 'run_x' } })
  })

  it('240초가 지나도 "아직 도는 중"으로 먼저 돌려주지 않는다 — 끝날 때 결과가 온다', async () => {
    await start(WORKER)
    const { request, sent } = await connect('app-notes')
    await request('tools/list')
    const realSetTimeout = globalThis.setTimeout
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // CLI처럼 호출을 보낸다 — 답은 sent에 온다
      const pipe = (servers()['app-notes'] as unknown as { instance: { server: { transport: { onmessage(m: unknown): void } } } }).instance.server.transport
      pipe.onmessage({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'hold', arguments: {} } })
      const deadline = performance.now() + 15_000
      while (!w.records('notes').some((r) => r.t === 'holding')) {
        if (performance.now() > deadline) throw new Error('the app never started holding')
        await new Promise((r) => realSetTimeout(r, 10))
      }
      // 240초도, Codex의 300초도 넘긴다. 10분에는 런타임의 host → 앱 울타리(callTimeoutMs)가 선다
      await vi.advanceTimersByTimeAsync(6 * 60_000)
      expect(sent.find((m) => m.id === 900)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(w.gate('notes'), '')
    const answer = await kit.until(() => sent.find((m) => m.id === 900), (m) => m !== undefined, 10_000)
    expect(answer!.result).toMatchObject({ content: [{ type: 'text', text: 'released' }], isError: false })
  })
})

/**
 * 세션을 멈추거나 닫으면 그 세션의 앱 호출이 멈춘다 (M4 A-5). CLI가 턴을 끊으며 도구 호출에
 * 취소를 보내는지는 SDK가 약속하지 않는다 — 가짜 query의 interrupt는 아무것도 하지 않으므로,
 * 여기서 멈춘다면 어댑터가 직접 끊은 것이다.
 */
describe('멈추면 앱 호출도 멈춘다 — Claude', () => {
  async function holdViaCli() {
    const { request, sent } = await connect('app-notes')
    await request('tools/list')
    const pipe = (servers()['app-notes'] as unknown as { instance: { server: { transport: { onmessage(m: unknown): void } } } }).instance.server.transport
    pipe.onmessage({ jsonrpc: '2.0', id: 700, method: 'tools/call', params: { name: 'hold', arguments: {} } })
    await kit.until(() => w.records('notes').some((r) => r.t === 'holding'), Boolean)
    return sent
  }

  it('interrupt는 도는 앱 호출을 취소한다 — 앱이 취소를 받고 CLI는 실패로 받는다', async () => {
    const h = await start(WORKER)
    const sent = await holdViaCli()
    h.interrupt()
    const answer = await kit.until(() => sent.find((m) => m.id === 700), (m) => m !== undefined)
    expect(answer!.result).toMatchObject({ isError: true })
    await kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)
    expect(w.rt.runs({ projectId: 'p1', appId: 'notes' })[0]).toMatchObject({ tool: 'hold', status: 'cancelled' })
  })

  it('dispose도 도는 앱 호출을 취소한다', async () => {
    const h = await start(WORKER)
    await holdViaCli()
    await h.dispose()
    handle = null
    await kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)
  })
})
