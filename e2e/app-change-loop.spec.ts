import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { APP_CHANGE_WINDOW_MS, broadcastAppChanges } from '../packages/agent-host/src/app-change-events.js'
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
 * 열린 화면의 갱신 고리 (M4 B-5 회귀) — 잰 그대로 다시 만든다.
 *
 * 실측(65acb43): 우리 템플릿으로 만든 앱의 화면 하나를 열어 두면 `show`가 초당 약 700번 불렸다(1초에 실행 기록
 * 618줄, 3초에 2035줄). 고리: 런타임이 앱에 닿은 호출마다 "바뀌었다"를 내고 → host가 방송하고 → 스토어가 세고 →
 * AppFrame이 화면에 `centralu/notifications/changed`를 보내고 → 템플릿 화면이 알림마다 `show`를 부르고 → 그
 * `show`가 다시 "바뀌었다"를 냈다. 고정 화면과 대화 안 화면은 같은 카운터를 읽는다. 이 시험을 65acb43의 배선으로
 * 돌리면 3초 동안 `show`가 고정 화면 하나로 886줄, 두 화면이면 2025줄, 주석 없는 `show`와 두 화면이면 2926줄이다.
 *
 * 그래서 host 쪽은 진짜다: 템플릿으로 펼친 앱(진짜 `node` 프로세스), 진짜 런타임과 실행 기록, 진짜 ViewHost와
 * 대화 안 화면(InlineViews), 그리고 main.ts와 같은 "바뀌었다" 배선(`broadcastAppChanges`). UI도 진짜다(목
 * 플랫폼 위). 목에 꽂는 것은 host로 가는 선뿐이다: 화면의 도구 호출은 rpc.ts의 `apps.invoke`처럼 호출자를
 * "화면과 그 인스턴스"로 런타임에 넘기고, host의 방송은 목의 `emit`으로 흘린다.
 */

const APP = 'counter'
/** 화면을 열어 두고 지켜보는 시간 — 잰 때와 같다 */
const WATCH_MS = 3000

type Harness = {
  ref: AppRef
  /** 이 앱의 `show` 실행 기록 수 — 호출마다 한 줄이다(app_runs) */
  showRuns(): number
  list(): unknown[]
  /** 세션의 에이전트가 `show`를 부른 것처럼 — 그 카드 아래에 대화 안 화면이 선다 */
  agentShows(sessionId: string, callId: string): Promise<void>
  close(): Promise<void>
}

async function startHost(page: Page, projectId: string, opts: { unannotatedShow?: boolean } = {}): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-e2e-change-loop-')))
  const projRoot = join(root, 'proj')
  const dataRoot = join(root, 'data')
  mkdirSync(dataRoot)
  mkdirSync(join(projRoot, '.centralu', 'apps'), { recursive: true })
  const dir = join(projRoot, '.centralu', 'apps', APP)
  scaffoldApp(appTemplateDir(), dir, { id: APP, name: 'Counter', description: 'Counter app' })
  if (opts.unannotatedShow) {
    // 읽기 도구에 주석을 빠뜨린 앱 — 첫 겹(읽기는 알리지 않는다)이 이 앱에는 없다
    const file = join(dir, 'server.mjs')
    const line = '      annotations: { readOnlyHint: true },\n'
    const src = readFileSync(file, 'utf8')
    if (src.split(line).length !== 2) throw new Error('the template changed: show should carry readOnlyHint: true exactly once')
    writeFileSync(file, src.replace(line, ''))
  }

  const store = new Store()
  // host의 방송 → 목의 emit. 시험이 끝나 페이지가 닫힌 뒤에 온 것은 버린다
  const toPage = (e: unknown) => void page.evaluate((ev) => (window as any).__mock.emit(ev), e).catch(() => {})
  const changes = broadcastAppChanges(toPage)
  const rt = new ExternalApps({
    projects: () => [{ id: projectId, path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    runs: storeRunLedger(store),
    emitChanged: changes.emit,
    timing: { idleMs: 60_000, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
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
  // 고정 화면을 여는 host의 몸통 그대로(rpc.ts의 apps.openView)
  await page.exposeFunction('__loopOpenView', (appId: string, pid: string | null) => openHomeView(rt, views, { appId, projectId: pid }))
  // rpc.ts의 apps.invoke와 같은 호출자 — 화면, 그리고 그 화면의 인스턴스
  await page.exposeFunction(
    '__loopCall',
    async (appId: string, tool: string, args: Record<string, unknown>, from: { projectId?: string | null; instanceId?: string }) => {
      const caller = { kind: 'view' as const, ...(from.instanceId ? { instanceId: from.instanceId } : {}) }
      const out = await rt.call({ appId, projectId: from.projectId ?? null }, tool, args, caller)
      return out.result ?? { content: [{ type: 'text', text: out.error ?? '' }], isError: true }
    },
  )
  await page.evaluate(() => {
    const w = window as any
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
    close: async () => {
      changes.dispose()
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

/** 신뢰한 프로젝트 하나와 그 세션 하나 — 세션이 보이는 채로 */
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

/** 앱의 HTML이 도는 안쪽 프레임 (바깥은 프록시) */
const inner = (page: Page, testId: string): FrameLocator =>
  page.getByTestId(testId).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
const pinnedView = (page: Page, pid: string) => inner(page, `pinned-app-${pid}/${APP}`)
const inlineView = (page: Page) => inner(page, 'inline-view')

/** 화면이 부른 `show` — 부른 인스턴스마다 */
const viewShows = (page: Page, instanceId: string) =>
  page.evaluate(
    (id) => ((window as any).__mock.appToolCalls as { tool: string; from: { instanceId?: string } }[]).filter((c) => c.tool === 'show' && c.from.instanceId === id).length,
    instanceId,
  )

/** 사이드바에서 앱을 연다 — host가 home(`show`)을 부르고 고정 화면이 선다 */
async function openPinned(page: Page, pid: string): Promise<string> {
  await page.getByTestId(`app-row-${pid}/${APP}`).click()
  await expect(page.getByTestId(`pinned-app-${pid}/${APP}`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  await expect(pinnedView(page, pid).locator('#count')).toHaveText('0')
  return page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)
}

/** 세션으로 돌아가(고정 화면은 숨을 뿐 살아 있다) 에이전트가 `show`를 부른다 — 그 카드 아래에 대화 안 화면이 선다 */
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

test('템플릿 앱의 고정 화면을 열어 두면 show는 여는 두 번(home, 화면의 첫 읽기)뿐이다 — 3초를 지켜봐도 늘지 않는다', async ({ page }) => {
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

test('고정 화면과 대화 안 화면이 함께 열려도 서로를 깨우지 않는다 — 한쪽이 바꾼 값은 다른 쪽만 다시 읽는다', async ({ page }) => {
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

  // 대화 안 화면이 값을 바꾼다 — 숨은 고정 화면이 알림을 받아 다시 읽고, 바꾼 화면은 답으로 이미 안다
  const before = { pinned: await viewShows(page, pinned), inline: await viewShows(page, inline) }
  await inlineView(page).locator('#increment').click()
  await expect(inlineView(page).locator('#count')).toHaveText('1')
  await expect(pinnedView(page, pid).locator('#count')).toHaveText('1')
  await expect.poll(() => viewShows(page, pinned)).toBe(before.pinned + 1)
  // 알림은 두 화면에 같은 렌더에서 간다 — 방송 창 둘만큼 더 기다려도 바꾼 화면은 다시 읽지 않았다
  await page.waitForTimeout(500)
  expect(await viewShows(page, inline)).toBe(before.inline)
  expect(await viewShows(page, pinned)).toBe(before.pinned + 1)
})

test('읽기 도구에 readOnlyHint를 빠뜨린 앱도 두 화면이 서로를 깨우는 고리가 한 앱에 초당 4번으로 묶인다', async ({ page }) => {
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
   * 방송은 한 앱에 250ms마다 하나까지다. 방송 하나에 다시 읽는 화면은 많아야 둘(주인이 섞였을 때)이라,
   * 3초면 (3000/250 + 1) × 2 = 26번이 끝이다. 실측은 22~24번. 막는 것이 없으면 두 화면이 서로를 수천 번 깨운다.
   */
  expect(more).toBeLessThanOrEqual((WATCH_MS / APP_CHANGE_WINDOW_MS + 1) * 2)
})
