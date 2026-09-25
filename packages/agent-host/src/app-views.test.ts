import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { runtimeViewSource } from './app-view-source.js'
import { ExternalApps, type RuntimeTiming } from './apps/external/runtime.js'
import { MANIFEST_FILE } from './apps/external/manifest.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'
import { Store } from './dev-services/store.js'
import { createRpcHandler } from './rpc.js'
import { SessionManager } from './sessions/manager.js'
import { HostServer } from './transport/server.js'
import { OriginPorts, type PortBook } from './views/origin-ports.js'
import { ViewHost } from './views/view-host.js'

/**
 * 앱 화면과 외부 앱 런타임의 이음새 (M4 B-3 ↔ A) — main.ts가 쓰는 `runtimeViewSource` 그대로.
 *
 * 두 층은 각자의 시험에서 대역을 끼고 초록이다. 여기서는 진짜 앱 프로세스(런타임 픽스처의
 * `view` 모드)와 진짜 HostServer·ViewHost를 맞대고, 그 사이의 선을 본다: 화면 문서는 앱이
 * 준 것인가, 매니페스트의 출처 요청이 프록시까지 가는가, 열린 화면이 앱을 붙드는가.
 */

const FIXTURE = fileURLToPath(new URL('./apps/external/test-fixtures/app.mjs', import.meta.url))
const SECRET = 'app-views-test-secret-0123456789abcdef'
const HOST_ORIGIN = 'http://127.0.0.1:5174'

let fixture = ''
let projRoot = ''
let rt: ExternalApps
let views: ViewHost
let server: HostServer
let book: PortBook | null
let rpc: ReturnType<typeof createRpcHandler>
let store: Store

const ref = (appId: string) => ({ projectId: 'p1', appId })
const appsDir = () => join(projRoot, ...PROJECT_APPS)
const plant = (id: string, over: Record<string, unknown> = {}) =>
  plantApp(appsDir(), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', 'view'] }, ...over })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function start(timing: Partial<RuntimeTiming> = {}) {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot: join(fixture, 'data'),
    reservedIds: [],
    watchFlushMs: 50,
    timing: { idleMs: 60_000, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  let port: number | null = null
  views = new ViewHost({
    secret: SECRET,
    allowedOrigins: [HOST_ORIGIN],
    source: runtimeViewSource(rt),
    ports: new OriginPorts({ load: () => book, save: (b) => void (book = structuredClone(b)) }, { log: () => {} }),
    hostPort: () => port,
    log: () => {},
  })
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>()
  rpc = createRpcHandler(new SessionManager(store, adapters, () => {}), adapters, { externalApps: rt, views })
  server = new HostServer({ port: 0, token: 'tok', onRpc: rpc, http: { secret: SECRET, routes: views.routes } })
  port = await server.listen()
}

function get(url: string) {
  return new Promise<{ status: number; body: string; csp: string }>((resolve, reject) => {
    const u = new URL(url)
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, csp: String(res.headers['content-security-policy'] ?? '') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function pageConfig(body: string): Record<string, string> {
  const m = /<script type="application\/json" id="cc-view-config">(.*?)<\/script>/s.exec(body)
  if (!m?.[1]) throw new Error('no config block')
  return JSON.parse(m[1]) as Record<string, string>
}

/** 화면이 부른 것처럼 상태를 읽는다 — 답의 `_meta`에 그 답을 준 앱 프로세스의 pid가 있다 */
async function servingPid(appId: string): Promise<number> {
  const out = (await rpc('apps.invoke', { appId, projectId: 'p1', name: 'get_interval', args: {} })) as { result: { _meta: Record<string, number> } }
  return out.result._meta['fixture/served-by']!
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-views-')))
  projRoot = join(fixture, 'proj')
  mkdirSync(join(fixture, 'data'))
  mkdirSync(projRoot)
  book = null
})

afterEach(async () => {
  await views?.dispose()
  await rt?.dispose()
  await server?.close()
  store?.close()
  rmSync(fixture, { recursive: true, force: true })
})

describe('화면 문서는 런타임이 앱에서 읽은 것이다', () => {
  it('apps.viewFrame의 프록시 페이지가 앱 프로세스가 준 HTML과 그 문서가 선언한 CSP를 싣는다', async () => {
    plant('slider')
    await start()
    const { instanceId } = views.open(ref('slider'), 'ui://fixture/main')

    const frame = (await rpc('apps.viewFrame', { appId: 'slider', projectId: 'p1', instanceId, hostOrigin: HOST_ORIGIN })) as { url: string; sandbox: { csp: { connectDomains: string[] } } }
    expect(frame.sandbox.csp.connectDomains).toEqual(['https://api.fixture.test'])
    const page = await get(frame.url)
    expect(page.status).toBe(200)
    const pid = await servingPid('slider')
    // 문서의 pid가 도구 답의 pid와 같다 — 대역이 아니라 그 앱 프로세스가 준 문서다
    expect(pageConfig(page.body).html).toBe(`<!doctype html><p id="served">view from app process ${pid}</p>`)
    expect(page.csp).toContain('connect-src https://api.fixture.test')

    // 화면의 onreadresource도 같은 길이다
    const read = (await rpc('apps.readResource', { appId: 'slider', projectId: 'p1', uri: 'ui://fixture/main', instanceId })) as { contents: { text: string }[] }
    expect(read.contents[0]?.text).toContain(`view from app process ${pid}`)
  })

  it('없는 앱의 화면은 열리지 않는다', async () => {
    await start()
    expect(() => views.open(ref('ghost'), 'ui://ghost/main')).toThrow(/There is no such app/)
  })
})

describe('출처 방식은 매니페스트의 view.origin이 정한다', () => {
  it('요청한 앱만 앱별 포트를 받고, 요청하지 않은 앱은 불투명 출처로 뜬다', async () => {
    plant('mapper', { view: { origin: 'app' } })
    plant('plain')
    await start()

    const optIn = views.open(ref('mapper'), 'ui://fixture/main')
    const optInPage = await get((await views.frame({ app: ref('mapper'), instanceId: optIn.instanceId, hostOrigin: HOST_ORIGIN })).url)
    const appPort = book?.assigned['p1/mapper']
    expect(appPort).toBeGreaterThanOrEqual(20000)
    expect(appPort).toBeLessThanOrEqual(32767)
    expect(pageConfig(optInPage.body)).toMatchObject({ mode: 'app', appOrigin: `http://127.0.0.1:${appPort}` })
    // 앱별 출처에서 서빙되는 것도 앱 프로세스의 문서다
    const doc = await get(pageConfig(optInPage.body).src!)
    expect(doc.body).toContain('view from app process')

    const plain = views.open(ref('plain'), 'ui://fixture/main')
    const plainPage = await get((await views.frame({ app: ref('plain'), instanceId: plain.instanceId, hostOrigin: HOST_ORIGIN })).url)
    expect(pageConfig(plainPage.body)).toMatchObject({ mode: 'opaque', sandbox: 'allow-scripts allow-forms' })
    // 요청하지 않은 앱에는 포트를 배정하지도 않는다 — 배정은 되돌릴 수 없는 일이다(표는 줄지 않는다)
    expect(Object.keys(book?.assigned ?? {})).toEqual(['p1/mapper'])
  })
})

describe('열린 화면은 앱을 붙든다', () => {
  it('화면이 열려 있는 동안은 쉬어도 내리지 않고, 닫으면 그때부터 센다', async () => {
    plant('slider')
    await start({ idleMs: 250 })
    const { instanceId } = views.open(ref('slider'), 'ui://fixture/main')
    const pid = await servingPid('slider')
    await new Promise((r) => setTimeout(r, 900))
    expect(alive(pid)).toBe(true)

    views.close(instanceId)
    await until(() => alive(pid), (a) => a === false, 3000)
    expect(rt.list().find((a) => a.appId === 'slider')?.status).toBe('stopped')
  })

  it('화면이 열린 채 매니페스트가 바뀌어도 새로 뜬 앱을 붙든다', async () => {
    plant('slider')
    await start({ idleMs: 250 })
    const { instanceId } = views.open(ref('slider'), 'ui://fixture/main')
    const first = await servingPid('slider')

    // 만드는 세션이 앱을 고친다 — 런타임은 옛 프로세스를 내리고 다음 필요에 새로 띄운다
    const manifestPath = join(appsDir(), 'slider', MANIFEST_FILE)
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeFileSync(manifestPath, JSON.stringify({ ...m, description: 'edited while the view is open' }))
    await until(() => rt.list().find((a) => a.appId === 'slider')?.status, (s) => s === 'stopped')
    const second = await servingPid('slider')
    expect(second).not.toBe(first)

    await new Promise((r) => setTimeout(r, 900))
    expect(alive(second)).toBe(true)
    views.close(instanceId)
    await until(() => alive(second), (a) => a === false, 3000)
  })

  it('닫지 않은 화면도 ViewHost가 끝날 때 놓는다', async () => {
    plant('slider')
    await start({ idleMs: 250 })
    views.open(ref('slider'), 'ui://fixture/main')
    const pid = await servingPid('slider')
    await views.dispose()
    await until(() => alive(pid), (a) => a === false, 3000)
  })
})
