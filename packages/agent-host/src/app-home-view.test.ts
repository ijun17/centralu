import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppRun, ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { storeRunLedger } from './app-run-ledger.js'
import { runtimeViewSource } from './app-view-source.js'
import { ExternalApps, type RuntimeTiming } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'
import { Store } from './dev-services/store.js'
import { createRpcHandler } from './rpc.js'
import { SessionManager } from './sessions/manager.js'
import { HostServer } from './transport/server.js'
import { OriginPorts } from './views/origin-ports.js'
import { ViewHost } from './views/view-host.js'

/**
 * 고정 화면 (M4 B-2) — `apps.openView`·`apps.closeView`를 진짜 RPC 문에서 두드린다.
 *
 * 앱은 런타임 픽스처의 `view` 모드로 진짜 자식 프로세스로 뜬다. 판정은 host의 말이 아니라 앱이 겪은
 * 것(픽스처의 기록: home이 몇 번 불렸나), 실행 기록(누가 어느 도구를 불렀나), 그리고 화면 문서(프록시가
 * 싣는 HTML이 그 앱 프로세스의 것인가)로 한다.
 */

const FIXTURE = fileURLToPath(new URL('./apps/external/test-fixtures/app.mjs', import.meta.url))
const SECRET = 'app-home-view-test-secret-0123456789abcdef'
const HOST_ORIGIN = 'http://127.0.0.1:5174'

let fixture = ''
let projRoot = ''
let appLogs = ''
let trusted = true
let rt: ExternalApps
let views: ViewHost
let server: HostServer
let store: Store
let rpc: ReturnType<typeof createRpcHandler>

const plant = (id: string, over: Record<string, unknown> = {}) =>
  plantApp(join(projRoot, ...PROJECT_APPS), id, {
    server: { command: process.execPath, args: [FIXTURE, '--mode', 'view', '--log', join(appLogs, `${id}.jsonl`)] },
    ...over,
  })

/** 앱이 겪은 것 — `home`이 불린 횟수를 앱 쪽 기록으로 센다 */
const homeCalls = (id: string) => {
  const f = join(appLogs, `${id}.jsonl`)
  if (!existsSync(f)) return 0
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"t":"home"')).length
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function start(timing: Partial<RuntimeTiming> = {}) {
  store = new Store()
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted }],
    dataRoot: join(fixture, 'data'),
    reservedIds: [],
    runs: storeRunLedger(store),
    timing: { idleMs: 60_000, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  let port: number | null = null
  views = new ViewHost({
    secret: SECRET,
    allowedOrigins: [HOST_ORIGIN],
    source: runtimeViewSource(rt),
    ports: new OriginPorts({ load: () => null, save: () => {} }, { log: () => {} }),
    hostPort: () => port,
    log: () => {},
  })
  const adapters = new Map<ToolName, AgentAdapter>()
  rpc = createRpcHandler(new SessionManager(store, adapters, () => {}), adapters, { externalApps: rt, views })
  server = new HostServer({ port: 0, token: 'tok', onRpc: rpc, http: { secret: SECRET, routes: views.routes } })
  port = await server.listen()
}

const openView = (appId: string) =>
  rpc('apps.openView', { appId, projectId: 'p1' }) as Promise<{
    instanceId: string
    tool: string
    resourceUri: string
    toolInput: Record<string, unknown>
    toolResult: { content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, number> }
    runId: string
  }>

const runs = async (appId: string) => (await rpc('apps.runs', { appId, projectId: 'p1' })) as AppRun[]

function get(url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(url)
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-home-')))
  projRoot = join(fixture, 'proj')
  appLogs = join(fixture, 'fixture-logs')
  for (const d of [join(fixture, 'data'), projRoot, appLogs]) mkdirSync(d)
  trusted = true
})

afterEach(async () => {
  await views?.dispose()
  await rt?.dispose()
  await server?.close()
  store?.close()
  rmSync(fixture, { recursive: true, force: true })
})

describe('apps.openView', () => {
  it('home을 화면 호출자로 한 번 부르고, 그 도구가 선언한 화면을 연다 — 답에 AppFrame이 받을 것이 다 있다', async () => {
    plant('slider', { home: 'home' })
    await start()

    const v = await openView('slider')
    expect(v).toMatchObject({ tool: 'home', resourceUri: 'ui://fixture/main', toolInput: {}, toolResult: { structuredContent: { interval: 5 } } })
    expect(v.instanceId).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(homeCalls('slider')).toBe(1)

    // 기록에는 "화면이 home을 불렀다" — 사람이 눌렀어도 호출자는 화면이다(플랜 "호출 경로는 하나다")
    expect((await runs('slider')).map((r) => [r.tool, r.callerKind, r.status, r.id])).toEqual([['home', 'view', 'ok', v.runId]])

    // 인스턴스의 화면은 그 앱 프로세스가 준 문서다
    const frame = (await rpc('apps.viewFrame', { appId: 'slider', projectId: 'p1', instanceId: v.instanceId, hostOrigin: HOST_ORIGIN })) as { url: string }
    const page = await get(frame.url)
    expect(page.status).toBe(200)
    expect(page.body).toContain(`view from app process ${v.toolResult._meta?.['fixture/served-by']}`)
  })

  it('화면을 선언하지 않은 home, 없는 home, ui://가 아닌 화면은 부르지도 않고 거절하고, 인스턴스를 남기지 않는다', async () => {
    plant('plain', { home: 'no_screen' })
    plant('nohome')
    plant('missing', { home: 'nope' })
    plant('outside', { home: 'bad_home' })
    await start()
    const opened = vi.spyOn(views, 'open')

    await expect(openView('plain')).rejects.toThrow('This app has no screen: its home tool "no_screen" declares no _meta.ui.resourceUri')
    await expect(openView('nohome')).rejects.toThrow('This app has no screen: its manifest names no home tool')
    await expect(openView('missing')).rejects.toThrow('This app has no screen: its home tool "nope" is not in its tool list')
    await expect(openView('outside')).rejects.toThrow(/must be a ui:\/\/ URI \(got "https:\/\/evil\.test\/view"\)/)

    expect(opened).not.toHaveBeenCalled()
    // 부르지 않았다 — 기록도 없다
    for (const id of ['plain', 'missing', 'outside']) expect(await runs(id)).toEqual([])
  })

  it('에이전트에게만 열린 home은 화면 호출자로 부를 수 없다 — 거절이 기록되고 인스턴스는 없다', async () => {
    plant('agenthome', { home: 'agent_home' })
    await start()
    const opened = vi.spyOn(views, 'open')

    await expect(openView('agenthome')).rejects.toThrow(/visibility/)
    expect(opened).not.toHaveBeenCalled()
    expect((await runs('agenthome')).map((r) => [r.tool, r.callerKind, r.status])).toEqual([['agent_home', 'view', 'rejected']])
  })

  it('신뢰하지 않은 프로젝트의 앱은 띄우지도 열지도 않는다', async () => {
    trusted = false
    plant('slider', { home: 'home' })
    await start()
    const opened = vi.spyOn(views, 'open')

    await expect(openView('slider')).rejects.toThrow(/신뢰하지 않은 프로젝트/)
    expect(opened).not.toHaveBeenCalled()
    expect(homeCalls('slider')).toBe(0)
  })

  it('앱이 실패를 답해도 화면은 연다 — 그 실패를 그리는 것도 화면이다', async () => {
    plant('grumpy', { home: 'failing_home' })
    await start()
    const v = await openView('grumpy')
    expect(v.toolResult).toMatchObject({ isError: true, content: [{ type: 'text', text: 'the slider is not ready' }] })
    expect((await runs('grumpy'))[0]).toMatchObject({ tool: 'failing_home', callerKind: 'view', status: 'error' })
  })
})

describe('apps.closeView', () => {
  it('연 화면은 앱을 붙들고, 닫으면 놓아서 쉬는 앱 내리기가 다시 돈다 — 두 번 닫아도 같다', async () => {
    plant('slider', { home: 'home' })
    await start({ idleMs: 250 })
    const v = await openView('slider')
    const pid = v.toolResult._meta!['fixture/served-by']!
    await new Promise((r) => setTimeout(r, 900))
    expect(alive(pid)).toBe(true)

    await expect(rpc('apps.closeView', { instanceId: v.instanceId })).resolves.toEqual({ ok: true })
    await until(() => alive(pid), (a) => a === false, 3000)
    expect(rt.list().find((a) => a.appId === 'slider')?.status).toBe('stopped')
    // 닫힌 인스턴스의 주소는 더 열리지 않는다
    await expect(rpc('apps.viewFrame', { appId: 'slider', projectId: 'p1', instanceId: v.instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(rpc('apps.closeView', { instanceId: v.instanceId })).resolves.toEqual({ ok: true })
  })
})
