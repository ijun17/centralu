import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { APP_CHANGE_WINDOW_MS, broadcastAppChanges, broadcastAppRuns } from '../packages/agent-host/src/app-change-events.js'
import { openHomeView } from '../packages/agent-host/src/app-home-view.js'
import { storeRunLedger } from '../packages/agent-host/src/app-run-ledger.js'
import { runtimeViewSource } from '../packages/agent-host/src/app-view-source.js'
import { ExternalApps, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import { appTemplateDir, scaffoldApp } from '../packages/agent-host/src/apps/external/scaffold.js'
import { Store } from '../packages/agent-host/src/dev-services/store.js'
import { attachInlineViews } from '../packages/agent-host/src/inline-views.js'
import { SessionAppsHub } from '../packages/agent-host/src/sessions/session-apps.js'
import { HostServer } from '../packages/agent-host/src/transport/server.js'
import { OriginPorts } from '../packages/agent-host/src/views/origin-ports.js'
import { ViewHost } from '../packages/agent-host/src/views/view-host.js'

/**
 * The refresh loop of an open view (M4 B-5 regression) — reconstructed exactly as it was measured.
 *
 * Measured (65acb43): leaving a single view of an app built from our template open made `show` get
 * called roughly 700 times a second (618 run-log lines in one second, 2,035 in three). The loop:
 * every call the runtime forwards to the app emits "it changed" → the host broadcasts it → the
 * store counts it → AppFrame sends the view `centralu/notifications/changed` → the template view
 * calls `show` on every notification → that `show` emits "it changed" again. A pinned view and an
 * inline view read the same counter. Running this test against 65acb43's wiring produces, over
 * three seconds, 886 lines of `show` with one pinned view, 2,025 with two views, and 2,926 with two
 * views and an unannotated `show`.
 *
 * So the host side here is real: an app scaffolded from the template (a real `node` process), a
 * real runtime and run log, a real ViewHost and inline views (InlineViews), and the same "it
 * changed" wiring as main.ts (`broadcastAppChanges`). The UI is real too (on a mock platform). What
 * is plugged into the mock is only the wire to the host: a view's tool call passes the caller as
 * "a view and its instance" to the runtime, the way rpc.ts's `apps.invoke` does, and the host's
 * broadcast is streamed through the mock's `emit`.
 */

const APP = 'counter'
/** How long a view is left open and watched — the same as when it was measured */
const WATCH_MS = 3000

type Harness = {
  ref: AppRef
  /** This app's `show` run-log count — one line per call (app_runs) */
  showRuns(): number
  list(): unknown[]
  /** As if a session's agent called `show` — an inline view shows up below that card */
  agentShows(sessionId: string, callId: string): Promise<void>
  /** As if a session's agent called the read-only `summarize` — the app asks for an agent, and that agent runs until `releaseAgent` */
  agentSummarizes(sessionId: string): Promise<unknown>
  releaseAgent(): void
  close(): Promise<void>
}

async function startHost(page: Page, projectId: string, opts: { unannotatedShow?: boolean; summarize?: boolean } = {}): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-e2e-change-loop-')))
  const projRoot = join(root, 'proj')
  const dataRoot = join(root, 'data')
  mkdirSync(dataRoot)
  mkdirSync(join(projRoot, '.centralu', 'apps'), { recursive: true })
  const dir = join(projRoot, '.centralu', 'apps', APP)
  scaffoldApp(appTemplateDir(), dir, { id: APP, name: 'Counter', description: 'Counter app' })
  if (opts.unannotatedShow) {
    // An app whose read tool is missing its annotation — the first layer of defense (reads do not announce) is absent for this app
    const file = join(dir, 'server.mjs')
    const line = '      annotations: { readOnlyHint: true },\n'
    const src = readFileSync(file, 'utf8')
    if (src.split(line).length !== 2) throw new Error('the template changed: show should carry readOnlyHint: true exactly once')
    writeFileSync(file, src.replace(line, ''))
  }
  if (opts.summarize) {
    /*
     * The app exactly as it was measured — the agent that built it marked `summarize` read-only,
     * and that tool asks for the person's agent (M4 D-1). A call to a read-only tool does not
     * emit "it changed" (#190).
     */
    const file = join(dir, 'server.mjs')
    const end = '  return server\n})'
    const src = readFileSync(file, 'utf8')
    if (src.split(end).length !== 2) throw new Error('the template changed: server.mjs should end its factory with `return server` once')
    const tool = `  centralu.tool(server, 'summarize', { description: 'Sum up the count', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: 'text', text: String(await centralu.agent('Sum up the count ' + state.count)) }],
  }))
`
    writeFileSync(file, src.replace(end, tool + end))
    const mf = join(dir, 'centralu.app.json')
    writeFileSync(mf, JSON.stringify({ ...JSON.parse(readFileSync(mf, 'utf8')), uses: { agent: true } }, null, 2))
  }

  const store = new Store()
  // The host's broadcast → the mock's emit. Anything arriving after the test ends and the page closes is dropped
  const toPage = (e: unknown) => void page.evaluate((ev) => (window as any).__mock.emit(ev), e).catch(() => {})
  const changes = broadcastAppChanges(toPage)
  const runChanges = broadcastAppRuns(toPage)
  const rt = new ExternalApps({
    projects: () => [{ id: projectId, path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    runs: storeRunLedger(store),
    emitChanged: changes.emit,
    emitRunsChanged: runChanges.emit,
    timing: { idleMs: 60_000, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  // The agent the app asked for — the person approved it immediately, and it runs until the test releases it
  let release: () => void = () => {}
  rt.attachBrokerHost({
    defaultAgentTool: () => 'claude',
    agentLabel: () => 'Claude Code',
    askCapability: async () => 'allow',
    hostData: () => Promise.reject(new Error('not part of this test')),
    runAgent: async (_req, ctx) => {
      ctx.onSession('s-agent')
      await new Promise<void>((r) => (release = r))
      return { sessionId: 's-agent', text: 'The count is small.' }
    },
  })
  const secret = `e2e-${Math.random().toString(36).slice(2)}-${'x'.repeat(40)}`.replace(/[^A-Za-z0-9_-]/g, 'x')
  let port: number | null = null
  const views = new ViewHost({
    secret,
    allowedOrigins: ['http://127.0.0.1:5174', 'http://localhost:5174'],
    source: runtimeViewSource(rt),
    ports: new OriginPorts({ load: () => null, save: () => {} }, { log: () => {} }),
    hostPort: () => port,
    log: () => {},
  })
  const server = new HostServer({ port: 0, token: 'e2e-token', onRpc: async () => ({}), http: { secret, routes: views.routes } })
  port = await server.listen()
  const hub = new SessionAppsHub(rt)
  const inline = attachInlineViews({ sessionAppsHub: () => hub, recordAppView: toPage }, rt, views, { log: () => {} })
  const ref: AppRef = { projectId, appId: APP }

  await page.exposeFunction('__loopFrame', (appId: string, instanceId: string, o: { projectId?: string | null; hostOrigin: string }) =>
    views.frame({ app: { appId, projectId: o.projectId ?? null }, instanceId, hostOrigin: o.hostOrigin }),
  )
  // The host's exact logic for opening a pinned view (rpc.ts's apps.openView)
  await page.exposeFunction('__loopOpenView', (appId: string, pid: string | null) => openHomeView(rt, views, { appId, projectId: pid }))
  // The same caller as rpc.ts's apps.invoke — a view, and that view's instance
  await page.exposeFunction(
    '__loopCall',
    async (appId: string, tool: string, args: Record<string, unknown>, from: { projectId?: string | null; instanceId?: string }) => {
      const caller = { kind: 'view' as const, ...(from.instanceId ? { instanceId: from.instanceId } : {}) }
      const out = await rt.call({ appId, projectId: from.projectId ?? null }, tool, args, caller)
      return out.result ?? { content: [{ type: 'text', text: out.error ?? '' }], isError: true }
    },
  )
  // The run panel reads the real runtime's log (rpc.ts's apps.runs)
  await page.exposeFunction('__loopRuns', (appId: string, pid: string | null, limit: number) => rt.runs({ appId, projectId: pid }, limit))
  await page.evaluate(() => {
    const w = window as any
    w.__mock.appRunsProvider = (a: string, p: string | null, l: number) => w.__loopRuns(a, p, l)
    w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__loopFrame(a, i, o)
    w.__mock.openViewProvider = (a: string, p: string | null) => w.__loopOpenView(a, p)
    w.__mock.appToolHandler = (a: string, t: string, args: unknown, from: unknown) => w.__loopCall(a, t, args, from)
  })

  return {
    ref,
    showRuns: () => rt.runs(ref, 1_000_000).filter((r) => r.tool === 'show').length,
    list: () => rt.list(),
    agentShows: async (sessionId, callId) => {
      const session = hub.attach({ id: sessionId, kind: 'worker', projectId })
      await session.call(`app-${APP}`, 'show', {}, { callId })
    },
    agentSummarizes: (sessionId) => rt.call(ref, 'summarize', {}, { kind: 'session', sessionId }),
    releaseAgent: () => release(),
    close: async () => {
      release()
      changes.dispose()
      runChanges.dispose()
      inline.dispose()
      hub.dispose()
      await rt.dispose()
      await views.dispose()
      await server.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

let host: Harness | null = null
test.afterEach(async () => {
  await host?.close()
  host = null
})

/** One trusted project and one session in it — left with the session visible */
async function projectAndSession(page: Page): Promise<{ pid: string; sid: string }> {
  await page.goto('/?mock=1')
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('trust-ask-yes-alpha').click()
  const pid = await page.evaluate(
    () => (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find((x) => x.path === '/tmp/alpha')!.id,
  )
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  return { pid, sid }
}

/** The inner frame the app's HTML runs in (the outer one is the proxy) */
const inner = (page: Page, testId: string): FrameLocator =>
  page.getByTestId(testId).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
const pinnedView = (page: Page, pid: string) => inner(page, `pinned-app-${pid}/${APP}`)
const inlineView = (page: Page) => inner(page, 'inline-view')

/** `show` calls made by a view — per calling instance */
const viewShows = (page: Page, instanceId: string) =>
  page.evaluate(
    (id) => ((window as any).__mock.appToolCalls as { tool: string; from: { instanceId?: string } }[]).filter((c) => c.tool === 'show' && c.from.instanceId === id).length,
    instanceId,
  )

/** Opens the app from the sidebar — the host calls home (`show`) and the pinned view shows up */
async function openPinned(page: Page, pid: string): Promise<string> {
  await page.getByTestId(`app-row-${pid}/${APP}`).click()
  await expect(page.getByTestId(`pinned-app-${pid}/${APP}`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  await expect(pinnedView(page, pid).locator('#count')).toHaveText('0')
  return page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)
}

/** Goes back to the session (the pinned view only hides, staying alive) and has the agent call `show` — an inline view shows up below that card */
async function openInline(page: Page, h: Harness, sid: string): Promise<string> {
  await page.getByTestId(`session-row-${sid}`).click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  await page.evaluate(
    (e) => (window as any).__mock.emit(e),
    { type: 'tool_call', sessionId: sid, callId: 'toolu_show', summary: { tool: `mcp__app-${APP}__show`, title: 'show', readOnly: true, paths: [] } },
  )
  await h.agentShows(sid, 'toolu_show')
  await expect(page.getByTestId('inline-view').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  await expect(inlineView(page).locator('#count')).toHaveText('0')
  return page.evaluate((id) => (window as any).__store.getState().inlineViews[id].toolu_show.instanceId as string, sid)
}

test('leaving a template app\'s pinned view open produces only the two opening `show` calls (home, the view\'s first read) — watching for 3 seconds does not add more', async ({ page }) => {
  test.setTimeout(60_000)
  const { pid } = await projectAndSession(page)
  host = await startHost(page, pid)
  await page.evaluate((l) => (window as any).__mock.setExternalApps(l), host.list())
  await openPinned(page, pid)
  await page.waitForTimeout(WATCH_MS)
  const runs = host.showRuns()
  console.log(`고정 화면 하나: ${WATCH_MS}ms 지켜본 뒤 show 실행 기록 ${runs}줄`)
  expect(runs).toBeLessThanOrEqual(2)
})

test('a pinned view and an inline view open together do not wake each other — a value changed on one side only makes the other side re-read', async ({ page }) => {
  test.setTimeout(60_000)
  const { pid, sid } = await projectAndSession(page)
  host = await startHost(page, pid)
  await page.evaluate((l) => (window as any).__mock.setExternalApps(l), host.list())
  const pinned = await openPinned(page, pid)
  const inline = await openInline(page, host, sid)

  const settled = host.showRuns()
  await page.waitForTimeout(WATCH_MS)
  const more = host.showRuns() - settled
  console.log(`고정 화면 + 대화 안 화면: 여는 데 show ${settled}줄, 그 뒤 ${WATCH_MS}ms 동안 ${more}줄`)
  expect(more).toBeLessThanOrEqual(2)

  // The inline view changes the value — the hidden pinned view receives the notification and re-reads, while the view that made the change already knows from its own response
  const before = { pinned: await viewShows(page, pinned), inline: await viewShows(page, inline) }
  await inlineView(page).locator('#increment').click()
  await expect(inlineView(page).locator('#count')).toHaveText('1')
  await expect(pinnedView(page, pid).locator('#count')).toHaveText('1')
  await expect.poll(() => viewShows(page, pinned)).toBe(before.pinned + 1)
  // The notification reaches both views in the same broadcast window — waiting two more broadcast windows still shows the view that made the change never re-read
  await page.waitForTimeout(500)
  expect(await viewShows(page, inline)).toBe(before.inline)
  expect(await viewShows(page, pinned)).toBe(before.pinned + 1)
})

test('even an app whose read tool is missing readOnlyHint has the mutual-wakeup loop between two views capped at 4 calls per second per app', async ({ page }) => {
  test.setTimeout(60_000)
  const { pid, sid } = await projectAndSession(page)
  host = await startHost(page, pid, { unannotatedShow: true })
  await page.evaluate((l) => (window as any).__mock.setExternalApps(l), host.list())
  await openPinned(page, pid)
  await openInline(page, host, sid)

  const settled = host.showRuns()
  await page.waitForTimeout(WATCH_MS)
  const more = host.showRuns() - settled
  console.log(`주석 없는 show, 고정 화면 + 대화 안 화면: ${WATCH_MS}ms 동안 show ${more}줄`)
  /*
   * A broadcast is capped at one per app per 250ms. At most two views re-read per broadcast (when
   * the owners are mixed), so over 3 seconds the ceiling is (3000/250 + 1) × 2 = 26. Measured at
   * 22-24. With nothing capping this, the two views wake each other thousands of times.
   */
  expect(more).toBeLessThanOrEqual((WATCH_MS / APP_CHANGE_WINDOW_MS + 1) * 2)
})

test('an agent chain raised by a read-only tool shows up in the run panel without clicking Refresh, and it does not wake an open view', async ({ page }) => {
  test.setTimeout(60_000)
  const { pid, sid } = await projectAndSession(page)
  host = await startHost(page, pid, { summarize: true })
  await page.evaluate((l) => (window as any).__mock.setExternalApps(l), host.list())
  const pinned = await openPinned(page, pid)
  const view = page.getByTestId(`pinned-app-${pid}/${APP}`)
  await view.getByTestId('pinned-runs-toggle').click()
  const rows = view.getByTestId('runs-panel').getByTestId('run-row')
  // The two opening `show` calls (home, the view's first read) — nothing is still running
  await expect(rows.getByTestId('run-tool')).toHaveText(['show', 'show'])
  const shown = await viewShows(page, pinned)

  const summarized = host.agentSummarizes(sid)
  // Refresh is not clicked — the chain shows up in the panel while the agent is still running
  await expect(rows.getByTestId('run-tool')).toHaveText(['summarize', 'run_agent', 'show', 'show'])
  await expect(rows.nth(1).getByTestId('run-status')).toHaveText('running')
  await expect(rows.nth(1).getByTestId('run-caller')).toHaveText(`Asked by Counter`)

  host.releaseAgent()
  await summarized
  await expect(rows.nth(0).getByTestId('run-status')).toHaveText('ok')
  await expect(rows.nth(1).getByTestId('run-status')).toHaveText('ok')
  // It only read — an open view still does not re-read after waiting two more broadcast windows
  await page.waitForTimeout(APP_CHANGE_WINDOW_MS * 2)
  expect(await viewShows(page, pinned)).toBe(shown)
})

/**
 * The color of a single point on screen — decodes a 1×1 screenshot (PNG) directly. A one-row
 * IDAT: one filter byte, then R, G, B(, A).
 */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
  const idat: Buffer[] = []
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  return [raw[1]!, raw[2]!, raw[3]!]
}

/*
 * An app view's background (M4 B-3) — the host screen is `color-scheme: dark` and its iframe
 * inherits that. If the proxy page and the app page do not declare a color scheme, Chromium
 * decides the iframe and its document have different color schemes and paints the document
 * background opaque (white, since that is the light scheme). The template view's text is a light
 * color, so it was unreadable on a white background. WKWebView (Tauri) always keeps child frames
 * transparent, so this never surfaced there.
 */
test('a template app\'s view stays transparent over the host\'s dark background even on Chromium — it does not paint a white canvas', async ({ page }) => {
  test.setTimeout(60_000)
  const { pid } = await projectAndSession(page)
  host = await startHost(page, pid)
  await page.evaluate((l) => (window as any).__mock.setExternalApps(l), host.list())
  await openPinned(page, pid)
  const frame = page.getByTestId(`pinned-app-${pid}/${APP}`).getByTestId('app-frame-iframe')
  const box = (await frame.boundingBox())!
  // A spot on the template view with no text or button (the frame's bottom-right corner), and the host background just outside it (the pinned view's margin)
  const y = Math.round(box.y + box.height - 12)
  const inside = await pixel(page, Math.round(box.x + box.width - 12), y)
  const outside = await pixel(page, Math.round(box.x - 4), y)
  expect(Math.max(...outside), `host rgb(${outside.join(', ')})`).toBeLessThan(80)
  // Transparent — neither Chromium's white canvas nor a separately painted dark canvas, but exactly the host's background
  expect(inside, `frame rgb(${inside.join(', ')}), host rgb(${outside.join(', ')})`).toEqual(outside)
  // The app page declares the host theme it received as its own color scheme
  const inner = pinnedView(page, pid)
  await expect.poll(() => inner.locator('html').evaluate((el) => getComputedStyle(el).colorScheme)).toBe('dark')
})
