import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppRef } from './runtime.js'
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
    timing: { idleMs: IDLE_MS, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
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
