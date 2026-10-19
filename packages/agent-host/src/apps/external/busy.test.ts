import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppLifecycle, type LifecycleHost } from './app-lifecycle.js'
import type { AppEntry } from './app-entry.js'
import type { AppProcess } from './app-process.js'
import { ExternalApps, resultText, type AppRef } from './runtime.js'
import { DEFAULT_TIMING } from './runtime-types.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { until } from './test-helpers.js'
import { alive } from '../../process.test-helpers.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * Background work keeps an app running (#1236): an app whose manifest declares `uses.background` says it is busy
 * (`centralu.busy`), and the idle rule leaves it running meanwhile, as it does an app with an open view. Exercised
 * with an app expanded from the template, so the helper, the broker and the lifecycle are the product's own, and judged
 * by the operating system's process table.
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps | null = null

beforeEach(() => {
  root = tempRoot('cc-app-busy-')
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  await removeTree(root)
})

const IDLE_MS = 200
const RESUME_MS = 50
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const caller = { kind: 'session' as const, sessionId: 's1' }

/**
 * A template app with `hold`, `release` and `pid` tools; with `background`, its manifest declares `uses.background`.
 * With `atStart`, it says it is busy as its module loads, before Centralu has connected: outside any call, as a timer
 * would.
 */
function plant(id: string, { background = true, atStart = false } = {}): void {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name: id, description: `${id} app` })
  const manifest = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8')) as Record<string, unknown>
  if (background) manifest.uses = { background: 'lands queued pull requests' }
  writeFileSync(join(dir, 'centralu.app.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'
${atStart ? "void centralu.busy('started busy')" : ''}
serveStdio(() => {
  const server = new McpServer({ name: '${id}', version: '0' }, { capabilities: { tools: {} } })
  const say = (t) => ({ content: [{ type: 'text', text: String(t) }] })
  centralu.tool(server, 'hold', { description: 'Hold', inputSchema: z.object({ reason: z.string() }) }, async ({ reason }) => say(await centralu.busy(reason)))
  centralu.tool(server, 'release', { description: 'Release' }, async () => say(await centralu.busy(false)))
  centralu.tool(server, 'pid', { description: 'Pid' }, async () => say(process.pid))
  return server
})
`,
  )
}

function runtime(): ExternalApps {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: IDLE_MS, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, resumeBusyMs: RESUME_MS },
  })
  rt.refresh()
  return rt
}

async function call(r: ExternalApps, appId: string, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const out = await r.call(ref(appId), tool, args, caller)
  expect(out.status).toBe('ok')
  return resultText(out.result!)
}

const info = (r: ExternalApps, appId: string) => r.list().find((a) => a.appId === appId)
/** Several idle times: an app the idle rule would stop is gone well before this */
const pastIdle = () => new Promise((resolve) => setTimeout(resolve, IDLE_MS * 4))

describe('an app busy with background work is not stopped for being idle (#1236)', () => {
  it('holds its process past the idle time while busy, shows why on its row, and stops on idle once it releases', async () => {
    plant('queue')
    const r = runtime()
    const pid = Number(await call(r, 'queue', 'pid'))
    expect(await call(r, 'queue', 'hold', { reason: 'merge queue, 3 items' })).toBe('true')

    await pastIdle()
    expect(alive(pid)).toBe(true)
    expect(info(r, 'queue')).toMatchObject({ status: 'running', busy: 'merge queue, 3 items' })
    expect(info(r, 'queue')?.uses).toEqual({ background: 'lands queued pull requests' })

    expect(await call(r, 'queue', 'release')).toBe('true')
    await until(() => alive(pid), (a) => a === false)
    expect(info(r, 'queue')?.status).toBe('stopped')
    expect(info(r, 'queue')?.busy).toBeUndefined()
  })

  it('counts a hold the app makes while it is still starting, outside any call', async () => {
    plant('early', { atStart: true })
    const r = runtime()
    const pid = Number(await call(r, 'early', 'pid'))
    await pastIdle()
    expect(alive(pid)).toBe(true)
    expect(info(r, 'early')?.busy).toBe('started busy')
  })

  it('refuses a hold from an app that does not declare uses.background: the idle rule stops it as before', async () => {
    plant('undeclared', { background: false })
    const r = runtime()
    const pid = Number(await call(r, 'undeclared', 'pid'))
    expect(await call(r, 'undeclared', 'hold', { reason: 'forever' })).toBe('false')
    await until(() => alive(pid), (a) => a === false)
    expect(info(r, 'undeclared')?.busy).toBeUndefined()
  })

  it('the person stopping the app ends its hold with its process', async () => {
    plant('stoppable')
    const r = runtime()
    const pid = Number(await call(r, 'stoppable', 'pid'))
    await call(r, 'stoppable', 'hold', { reason: 'working' })
    await r.restart(ref('stoppable'))
    await until(() => alive(pid), (a) => a === false)
    expect(info(r, 'stoppable')).toMatchObject({ status: 'stopped' })
    expect(info(r, 'stoppable')?.busy).toBeUndefined()
  })
})

describe('a host that starts again resumes the apps that were busy (#1236)', () => {
  const busyFile = () => join(dataRoot, 'app-busy.json')
  const recorded = () => (existsSync(busyFile()) ? Object.values(JSON.parse(readFileSync(busyFile(), 'utf8')) as Record<string, { appId: string }>).map((r) => r.appId) : [])
  /** Long enough for the resume (RESUME_MS) to have run and a start it began to show */
  const pastResume = () => new Promise((resolve) => setTimeout(resolve, RESUME_MS + 1_500))

  it('starts an app that held busy when the host stopped, with no call, and it holds again', async () => {
    plant('queue', { atStart: true })
    const first = runtime()
    await call(first, 'queue', 'pid')
    await until(() => info(first, 'queue')?.busy, (b) => b === 'started busy')
    await first.dispose()
    expect(recorded()).toEqual(['queue'])

    // The next host (a restart or a swap): nothing calls the app, and it runs again
    const r = runtime()
    expect(info(r, 'queue')?.status).toBe('stopped')
    await until(() => info(r, 'queue'), (a) => a?.status === 'running' && a.busy === 'started busy')
    expect(recorded()).toEqual(['queue'])
  })

  it('does not start one that let its hold go, nor one the person stopped', async () => {
    plant('released')
    plant('stopped')
    const first = runtime()
    await call(first, 'released', 'hold', { reason: 'work' })
    await call(first, 'released', 'release')
    await call(first, 'stopped', 'hold', { reason: 'work' })
    await first.restart(ref('stopped'))
    expect(recorded()).toEqual([])
    await first.dispose()

    const r = runtime()
    await pastResume()
    expect([info(r, 'released')?.status, info(r, 'stopped')?.status]).toEqual(['stopped', 'stopped'])
  })

  it('does not start one that no longer declares uses.background, and spends its record', async () => {
    plant('queue')
    const first = runtime()
    await call(first, 'queue', 'hold', { reason: 'work' })
    await first.dispose()
    expect(recorded()).toEqual(['queue'])
    // Its manifest no longer declares it
    const manifest = join(projRoot, '.centralu', 'apps', 'queue', 'centralu.app.json')
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), uses: {} }, null, 2))

    const r = runtime()
    await pastResume()
    expect(info(r, 'queue')?.status).toBe('stopped')
    expect(recorded()).toEqual([])
  })
})

describe('a hold belongs to the process that made it (#1236)', () => {
  /** An entry whose current process is pipe 2 and alive, under a manifest that declares (or not) uses.background */
  function world(background = true) {
    const recordedHolds: (string | null)[] = []
    const host = {
      timing: { ...DEFAULT_TIMING, idleMs: 60_000 },
      appsChanged: () => {},
      holdKey: (r: AppRef) => r.appId,
      busyRecorded: (_e: AppEntry, reason: string | null) => void recordedHolds.push(reason),
    } as unknown as LifecycleHost
    const lifecycle = new AppLifecycle(host)
    const e = {
      ref: { projectId: 'p1', appId: 'a' },
      manifest: { uses: background ? { background: 'work' } : {} },
      life: { proc: { alive: true } as unknown as AppProcess, pipeId: 2, busy: null, idle: null, inflight: 0 },
    } as unknown as AppEntry
    return { lifecycle, e, recordedHolds }
  }

  it("refuses a report from a process older than the app's current one, and ignores a hold once its process is not current", () => {
    const { lifecycle, e, recordedHolds } = world()
    expect(lifecycle.setBusy(e, 1, 'from the old process')).toMatch(/no longer the app's current one/)
    expect(lifecycle.busyReason(e)).toBe(null)
    expect(recordedHolds).toEqual([])

    expect(lifecycle.setBusy(e, 2, 'now')).toBe(null)
    expect(lifecycle.busyReason(e)).toBe('now')
    // A newer process starting (pipe 3) holds only once it is the current one
    expect(lifecycle.setBusy(e, 3, 'starting')).toBe(null)
    expect(lifecycle.busyReason(e)).toBe(null)
    e.life.pipeId = 3
    expect(lifecycle.busyReason(e)).toBe('starting')
    // Its process ended: the hold holds nothing
    ;(e.life as { proc: unknown }).proc = { alive: false }
    expect(lifecycle.busyReason(e)).toBe(null)
  })

  it('refuses a hold from an app that does not declare uses.background, and records nothing', () => {
    const { lifecycle, e, recordedHolds } = world(false)
    expect(lifecycle.setBusy(e, 2, 'work')).toMatch(/does not declare/)
    expect(lifecycle.busyReason(e)).toBe(null)
    expect(recordedHolds).toEqual([])
  })
})
