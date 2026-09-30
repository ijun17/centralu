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
 * The fixed view (M4 B-2) — knocks on the real `apps.openView` / `apps.closeView` RPC door.
 *
 * The app comes up as a real child process, in the runtime fixture's `view` mode. Judgment is
 * based not on what the host says but on what the app actually experienced (the fixture's own
 * log: how many times was home called), the run record (who called which tool), and the view
 * document (is the HTML the proxy serves actually from that app's process).
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

/** What the app actually experienced — counts how many times `home` was called, from the app's own log */
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
  it('calls home once with the view as caller, and opens the view that tool declares — the answer has everything AppFrame needs', async () => {
    plant('slider', { home: 'home' })
    await start()

    const v = await openView('slider')
    expect(v).toMatchObject({ tool: 'home', resourceUri: 'ui://fixture/main', toolInput: {}, toolResult: { structuredContent: { interval: 5 } } })
    expect(v.instanceId).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(homeCalls('slider')).toBe(1)

    // The record shows "the view called home" — even though a person clicked it, the caller is the
    // view (the plan's "there is one calling path")
    expect((await runs('slider')).map((r) => [r.tool, r.callerKind, r.status, r.id])).toEqual([['home', 'view', 'ok', v.runId]])

    // The instance's view is the document that app's process actually served
    const frame = (await rpc('apps.viewFrame', { appId: 'slider', projectId: 'p1', instanceId: v.instanceId, hostOrigin: HOST_ORIGIN })) as { url: string }
    const page = await get(frame.url)
    expect(page.status).toBe(200)
    expect(page.body).toContain(`view from app process ${v.toolResult._meta?.['fixture/served-by']}`)
  })

  it('a home that declares no view, a missing home, and a view that is not a ui:// are rejected without even being called, and leave no instance', async () => {
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
    // Never called — no record either
    for (const id of ['plain', 'missing', 'outside']) expect(await runs(id)).toEqual([])
  })

  it('a home open only to the agent cannot be called with the view as caller — the rejection is recorded and there is no instance', async () => {
    plant('agenthome', { home: 'agent_home' })
    await start()
    const opened = vi.spyOn(views, 'open')

    await expect(openView('agenthome')).rejects.toThrow(/visibility/)
    expect(opened).not.toHaveBeenCalled()
    expect((await runs('agenthome')).map((r) => [r.tool, r.callerKind, r.status])).toEqual([['agent_home', 'view', 'rejected']])
  })

  it('an app from an untrusted project is neither started nor opened', async () => {
    trusted = false
    plant('slider', { home: 'home' })
    await start()
    const opened = vi.spyOn(views, 'open')

    await expect(openView('slider')).rejects.toThrow(/project is not trusted/)
    expect(opened).not.toHaveBeenCalled()
    expect(homeCalls('slider')).toBe(0)
  })

  it("opens the view even when the app answers with a failure — rendering that failure is also the view's job", async () => {
    plant('grumpy', { home: 'failing_home' })
    await start()
    const v = await openView('grumpy')
    expect(v.toolResult).toMatchObject({ isError: true, content: [{ type: 'text', text: 'the slider is not ready' }] })
    expect((await runs('grumpy'))[0]).toMatchObject({ tool: 'failing_home', callerKind: 'view', status: 'error' })
  })
})

describe('apps.closeView', () => {
  it('an open view holds the app open, and closing it releases the app so the idle shutdown runs again — closing twice is the same', async () => {
    plant('slider', { home: 'home' })
    await start({ idleMs: 250 })
    const v = await openView('slider')
    const pid = v.toolResult._meta!['fixture/served-by']!
    await new Promise((r) => setTimeout(r, 900))
    expect(alive(pid)).toBe(true)

    await expect(rpc('apps.closeView', { instanceId: v.instanceId })).resolves.toEqual({ ok: true })
    await until(() => alive(pid), (a) => a === false, 3000)
    expect(rt.list().find((a) => a.appId === 'slider')?.status).toBe('stopped')
    // A closed instance's address no longer opens
    await expect(rpc('apps.viewFrame', { appId: 'slider', projectId: 'p1', instanceId: v.instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(rpc('apps.closeView', { instanceId: v.instanceId })).resolves.toEqual({ ok: true })
  })
})
