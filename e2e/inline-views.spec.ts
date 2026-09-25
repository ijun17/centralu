import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * 대화 안 앱 화면 (M4 B-1) — 목 플랫폼 위의 진짜 UI, 진짜 ViewHost, 공식 ext-apps `App`으로 만든 시험용 화면.
 *
 * host가 하는 일(에이전트의 호출을 듣고 인스턴스를 열어 `app_view`를 내는 일, 카드 id 짝짓기, 사칭 차단)은
 * agent-host의 inline-views.test.ts가 진짜 앱으로 본다. 여기서는 그 이벤트를 받은 UI가 무엇을 하는지를 본다:
 * 인스턴스는 이 워커가 띄운 진짜 ViewHost에서 열고(`fx.open`), 이벤트는 목의 `emit`으로 host처럼 흘린다.
 */

type AppInfo = {
  appId: string
  projectId: string | null
  dir: string
  name: string | null
  version: string | null
  description: string | null
  home: string | null
  trusted: boolean
  status: 'invalid' | 'untrusted' | 'stopped' | 'starting' | 'running' | 'crashed' | 'failed'
  error: string | null
  warnings: string[]
}

const app = (appId: string, projectId: string | null, over: Partial<AppInfo> = {}): AppInfo => ({
  appId,
  projectId,
  dir: `/tmp/${projectId ?? 'user'}/.centralu/apps/${appId}`,
  name: `App ${appId}`,
  version: '0.1.0',
  description: null,
  home: 'home',
  trusted: true,
  status: 'running',
  error: null,
  warnings: [],
  ...over,
})

let fx: FixtureHost
test.beforeAll(async () => {
  fx = await startFixtureHost({
    'viewer ui://viewer/main': { html: fixtureViewHtml() },
  })
})
test.afterAll(async () => {
  await fx?.close()
})

test.beforeEach(async ({ page }) => {
  await page.exposeFunction(
    '__viewFrame',
    (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
      fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
  )
  // 고정 화면(Pin)도 같은 ViewHost에서 연다 — host가 home을 부르고 인스턴스를 연 것처럼
  await page.exposeFunction('__openView', (appId: string, projectId: string | null) => {
    const instanceId = fx.open({ projectId, appId }, `ui://${appId}/main`)
    return {
      instanceId,
      tool: 'home',
      resourceUri: `ui://${appId}/main`,
      toolInput: {},
      toolResult: { content: [{ type: 'text', text: 'home' }], structuredContent: { home: appId } },
      runId: `run-${instanceId}`,
    }
  })
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const w = window as any
    w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
    w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
  })
})

/** 신뢰한 프로젝트 하나와 그 세션 하나 — 세션이 보이는 채로 */
async function sessionWithApp(page: Page): Promise<{ pid: string; sid: string }> {
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('trust-ask-yes-alpha').click()
  const pid = await page.evaluate(
    () => (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find((x) => x.path === '/tmp/alpha')!.id,
  )
  await page.evaluate((l) => (window as any).__mock.setExternalApps(l), [app('viewer', pid, { name: 'Viewer' })])
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  return { pid, sid }
}

const emit = (page: Page, e: Record<string, unknown>) => page.evaluate((ev) => (window as any).__mock.emit(ev), e)
const toolCall = (sid: string, callId: string, tool: string) => ({
  type: 'tool_call',
  sessionId: sid,
  callId,
  summary: { tool, title: callId, readOnly: false, paths: [] },
})
/** host가 연 것처럼 — 진짜 ViewHost의 인스턴스를 열고 `open`을 흘린다 */
async function openInline(page: Page, pid: string, sid: string, callId: string, toolInput: Record<string, unknown>): Promise<string> {
  const instanceId = fx.open({ projectId: pid, appId: 'viewer' }, 'ui://viewer/main')
  await emit(page, { type: 'app_view', sessionId: sid, callId, appId: 'viewer', projectId: pid, tool: 'show', phase: 'open', instanceId, toolInput })
  return instanceId
}

/** 그 카드가 선 대화의 줄 — 카드와 화면은 한 줄에 산다 */
const rowOf = (page: Page, callId: string): Locator =>
  page.locator('[data-index]').filter({ has: page.getByTestId('tool-card').filter({ hasText: callId }) })
/** 앱의 HTML이 도는 안쪽 프레임 (바깥은 프록시) */
const viewIn = (scope: Locator): FrameLocator => scope.getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
/** 화면이 적은 줄들의 열쇠, 적힌 순서대로 */
const keys = async (v: FrameLocator) => v.locator('li[data-k]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.k ?? ''))
async function logged(v: FrameLocator, k: string, nth = 0): Promise<unknown> {
  const li = v.locator(`li[data-k="${k}"]`).nth(nth)
  await expect(li).toBeVisible()
  return JSON.parse(((await li.textContent()) ?? '').slice(k.length + 1))
}

test('화면은 제 호출 카드 아래에 서고, 입력을 받은 뒤 결과를 받는다', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_before', 'Bash'))
  await emit(page, toolCall(sid, 'toolu_1', 'mcp__app-viewer__show'))
  await emit(page, toolCall(sid, 'toolu_after', 'Read'))
  await openInline(page, pid, sid, 'toolu_1', { q: 'weather' })

  const row = rowOf(page, 'toolu_1')
  const inline = row.getByTestId('inline-view')
  await expect(inline).toHaveAttribute('data-call', 'toolu_1')
  await expect(inline.getByTestId('inline-view-title')).toHaveText('Viewer')
  await expect(inline.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  // 다른 카드 아래에는 아무것도 서지 않는다
  await expect(rowOf(page, 'toolu_before').getByTestId('inline-view')).toHaveCount(0)
  await expect(rowOf(page, 'toolu_after').getByTestId('inline-view')).toHaveCount(0)
  await expect(page.getByTestId('inline-view')).toHaveCount(1)

  const v = viewIn(inline)
  expect(await logged(v, 'tool-input')).toEqual({ q: 'weather' })
  // 호출이 끝났다 — 결과는 입력 다음에 한 번
  await emit(page, {
    type: 'app_view', sessionId: sid, callId: 'toolu_1', appId: 'viewer', projectId: pid, tool: 'show', phase: 'result',
    toolResult: { content: [{ type: 'text', text: 'sunny' }], structuredContent: { forecast: 'sunny' } },
  })
  expect(await logged(v, 'tool-result')).toEqual({ forecast: 'sunny' })
  expect((await keys(v)).filter((k) => k.startsWith('tool-'))).toEqual(['tool-input', 'tool-result'])
})

test('답 없이 끝난 호출은 tool-cancelled로 끝난다', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_c', 'mcp__app-viewer__show'))
  await openInline(page, pid, sid, 'toolu_c', { q: 'slow' })
  const v = viewIn(rowOf(page, 'toolu_c').getByTestId('inline-view'))
  expect(await logged(v, 'tool-input')).toEqual({ q: 'slow' })
  await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_c', appId: 'viewer', projectId: pid, tool: 'show', phase: 'cancelled', reason: 'the caller cancelled this call' })
  expect(await logged(v, 'tool-cancelled')).toBe('the caller cancelled this call')
  expect((await keys(v)).filter((k) => k.startsWith('tool-'))).toEqual(['tool-input', 'tool-cancelled'])
})

test('화면의 ui/message는 이 대화로 보내기 전에 묻고, 보낸 말은 앱이 보낸 말로 선다', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_m', 'mcp__app-viewer__show'))
  const instanceId = await openInline(page, pid, sid, 'toolu_m', {})
  const inline = rowOf(page, 'toolu_m').getByTestId('inline-view')
  await expect(inline.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  const v = viewIn(inline)
  const sent = () => page.evaluate(() => (window as any).__mock.viewMessages as unknown[])

  await v.locator('#msg').click()
  const ask = inline.getByTestId('inline-view-ask')
  await expect(ask).toContainText('Viewer wants to send this to this conversation:')
  await expect(ask.getByTestId('inline-view-ask-text')).toHaveText('hello from the view')
  // 물었을 뿐이다 — 화면은 답을 기다리고, 대화에는 아무것도 가지 않았다
  await expect(v.locator('li[data-k="msg-result"]')).toHaveCount(0)
  expect(await sent()).toEqual([])

  await ask.getByTestId('inline-view-ask-cancel').click()
  await expect(ask).toHaveCount(0)
  expect(await logged(v, 'msg-result')).toEqual({ isError: true })
  expect(await sent()).toEqual([])

  await v.locator('#msg').click()
  await inline.getByTestId('inline-view-ask-send').click()
  await expect.poll(sent).toEqual([{ sessionId: sid, instanceId, text: 'hello from the view' }])
  expect(await logged(v, 'msg-result', 1)).toEqual({})
  // 대화에는 앱이 보낸 말로 — 사람의 말풍선이 아니다
  const said = page.getByTestId('msg-user').filter({ hasText: 'hello from the view' })
  await expect(said.getByTestId('msg-user-from-app')).toHaveText('Viewer app ⤷')
})

test('Pin은 그 앱의 고정 화면을 연다', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_p', 'mcp__app-viewer__show'))
  await openInline(page, pid, sid, 'toolu_p', {})
  const inline = rowOf(page, 'toolu_p').getByTestId('inline-view')
  await expect(inline.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  await inline.getByTestId('inline-view-pin').click()
  const pinned = page.getByTestId(`pinned-app-${pid}/viewer`)
  await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  expect(await page.evaluate(() => (window as any).__mock.openedViews)).toEqual([{ appId: 'viewer', projectId: pid }])
})

test('host가 화면을 닫으면 teardown을 보낸 뒤 이유와 함께 자리표시로 접히고, 거절된 화면은 이유만 선다', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_g', 'mcp__app-viewer__show'))
  await openInline(page, pid, sid, 'toolu_g', {})
  const inline = rowOf(page, 'toolu_g').getByTestId('inline-view')
  await expect(inline.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  const teardowns = () =>
    page.evaluate(() => ((window as any).__mock.appToolCalls as { tool: string }[]).filter((c) => c.tool === 'save-on-teardown').length)

  await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_g', appId: 'viewer', projectId: pid, tool: 'show', phase: 'closed', reason: 'This app was removed' })
  await expect(inline.getByTestId('inline-view-placeholder')).toBeVisible()
  expect(await teardowns()).toBe(1)
  await expect(inline.getByTestId('inline-view-reason')).toHaveText('· This app was removed')
  await expect(inline.getByTestId('app-frame')).toHaveCount(0)

  // 사칭으로 거절된 화면 — 프레임도 앱을 여는 길도 없이 이유만
  await emit(page, toolCall(sid, 'toolu_s', 'mcp__app-viewer__spoof'))
  await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_s', appId: 'viewer', projectId: pid, tool: 'spoof', phase: 'rejected', reason: 'This app does not serve ui://other/main' })
  const refused = rowOf(page, 'toolu_s').getByTestId('inline-view')
  await expect(refused.getByTestId('inline-view-rejected')).toHaveText('This view was not shown: This app does not serve ui://other/main')
  await expect(refused.getByTestId('inline-view-pin')).toHaveCount(0)
  await expect(refused.getByTestId('app-frame')).toHaveCount(0)
})
