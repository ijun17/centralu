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
import { withDragRelay } from './views/drag-relay.js'

/**
 * The seam between app views and the external app runtime (M4 B-3 ↔ A) — the exact
 * `runtimeViewSource` that main.ts uses.
 *
 * Each of the two layers is green with a stand-in in its own tests. Here, a real app process (the
 * runtime fixture's `view` mode) is put face to face with a real HostServer and ViewHost, and the
 * wire between them is checked: is the view document actually from the app, does the manifest's
 * origin request reach the proxy, does an open view hold the app open.
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

/** Reads state as if the view called it — the answer's `_meta` carries the pid of the app process that answered */
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

describe('the view document is what the runtime read from the app', () => {
  it("apps.viewFrame's proxy page carries the HTML the app process served and the CSP that document declared", async () => {
    plant('slider')
    await start()
    const { instanceId } = views.open(ref('slider'), 'ui://fixture/main')

    const frame = (await rpc('apps.viewFrame', { appId: 'slider', projectId: 'p1', instanceId, hostOrigin: HOST_ORIGIN })) as { url: string; sandbox: { csp: { connectDomains: string[] } } }
    expect(frame.sandbox.csp.connectDomains).toEqual(['https://api.fixture.test'])
    const page = await get(frame.url)
    expect(page.status).toBe(200)
    const pid = await servingPid('slider')
    // The document's pid matches the tool answer's pid — this is the document that app process
    // actually served, not a stand-in — with the host's drag relay added at its end (#308)
    expect(pageConfig(page.body).html).toBe(withDragRelay(`<!doctype html><p id="served">view from app process ${pid}</p>`))
    expect(page.csp).toContain('connect-src https://api.fixture.test')

    // The view's onreadresource takes the same path
    const read = (await rpc('apps.readResource', { appId: 'slider', projectId: 'p1', uri: 'ui://fixture/main', instanceId })) as { contents: { text: string }[] }
    expect(read.contents[0]?.text).toContain(`view from app process ${pid}`)
  })

  it('the view of a nonexistent app does not open', async () => {
    await start()
    expect(() => views.open(ref('ghost'), 'ui://ghost/main')).toThrow(/There is no such app/)
  })
})

describe("the origin method is decided by the manifest's view.origin", () => {
  it('only an app that requested it gets a per-app port; an app that did not request it renders with an opaque origin', async () => {
    plant('mapper', { view: { origin: 'app' } })
    plant('plain')
    await start()

    const optIn = views.open(ref('mapper'), 'ui://fixture/main')
    const optInPage = await get((await views.frame({ app: ref('mapper'), instanceId: optIn.instanceId, hostOrigin: HOST_ORIGIN })).url)
    const appPort = book?.assigned['p1/mapper']
    expect(appPort).toBeGreaterThanOrEqual(20000)
    expect(appPort).toBeLessThanOrEqual(32767)
    expect(pageConfig(optInPage.body)).toMatchObject({ mode: 'app', appOrigin: `http://127.0.0.1:${appPort}` })
    // What is served from the per-app origin is also the app process's document
    const doc = await get(pageConfig(optInPage.body).src!)
    expect(doc.body).toContain('view from app process')

    const plain = views.open(ref('plain'), 'ui://fixture/main')
    const plainPage = await get((await views.frame({ app: ref('plain'), instanceId: plain.instanceId, hostOrigin: HOST_ORIGIN })).url)
    expect(pageConfig(plainPage.body)).toMatchObject({ mode: 'opaque', sandbox: 'allow-scripts allow-forms' })
    // An app that did not request one is never even assigned a port — assignment is irreversible
    // (the table never shrinks)
    expect(Object.keys(book?.assigned ?? {})).toEqual(['p1/mapper'])
  })
})

describe('an open view holds the app open', () => {
  it('the idle shutdown does not fire while the view is open, and the countdown starts once it is closed', async () => {
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

  it('holds the newly started app open even when the manifest changes while the view is open', async () => {
    plant('slider')
    await start({ idleMs: 250 })
    const { instanceId } = views.open(ref('slider'), 'ui://fixture/main')
    const first = await servingPid('slider')

    // The building session edits the app — the runtime shuts down the old process and starts a new
    // one on the next need
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

  it('a view that was never closed is still released when ViewHost shuts down', async () => {
    plant('slider')
    await start({ idleMs: 250 })
    views.open(ref('slider'), 'ui://fixture/main')
    const pid = await servingPid('slider')
    await views.dispose()
    await until(() => alive(pid), (a) => a === false, 3000)
  })
})
