import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * App views inline in a conversation (M4 B-1) — real UI on a mock platform, a real ViewHost, and
 * a test view built with the official ext-apps `App`.
 *
 * What the host does (listening for the agent's call, opening an instance and emitting
 * `app_view`, matching it to the card id, blocking impersonation) is covered with a real app by
 * agent-host's inline-views.test.ts. Here what is checked is what the UI does once it receives
 * that event: the instance is opened on the real ViewHost this worker started (`fx.open`), and
 * events are streamed through the mock's `emit` the way the host would.
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
  // A pinned view is also opened on the same ViewHost — as if the host called home and opened the instance
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
  // Reopen also opens a new instance on the same ViewHost — the input and result are what the mock held onto, the way the host would
  await page.exposeFunction('__openInline', (appId: string, projectId: string | null) => fx.open({ projectId, appId }, `ui://${appId}/main`))
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const w = window as any
    w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
    w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
    w.__mock.inlineInstanceProvider = (a: string, p: string | null) => w.__openInline(a, p)
  })
})

/** One trusted project and one session in it — left with the session visible */
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
/** As if the host opened it — opens an instance on the real ViewHost and streams `open` */
async function openInline(page: Page, pid: string, sid: string, callId: string, toolInput: Record<string, unknown>): Promise<string> {
  const instanceId = fx.open({ projectId: pid, appId: 'viewer' }, 'ui://viewer/main')
  await emit(page, { type: 'app_view', sessionId: sid, callId, appId: 'viewer', projectId: pid, tool: 'show', phase: 'open', instanceId, toolInput })
  return instanceId
}

/** The conversation row that card is on — the card and the view live on the same row */
const rowOf = (page: Page, callId: string): Locator =>
  page.locator('[data-index]').filter({ has: page.getByTestId('tool-card').filter({ hasText: callId }) })
/** The inner frame the app's HTML runs in (the outer one is the proxy) */
const viewIn = (scope: Locator): FrameLocator => scope.getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
/** The keys of the lines the view logged, in the order they were written */
const keys = async (v: FrameLocator) => v.locator('li[data-k]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.k ?? ''))
async function logged(v: FrameLocator, k: string, nth = 0): Promise<unknown> {
  const li = v.locator(`li[data-k="${k}"]`).nth(nth)
  await expect(li).toBeVisible()
  return JSON.parse(((await li.textContent()) ?? '').slice(k.length + 1))
}

test('the view shows below its own call card, receiving input and then the result', async ({ page }) => {
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
  // Nothing shows below the other cards
  await expect(rowOf(page, 'toolu_before').getByTestId('inline-view')).toHaveCount(0)
  await expect(rowOf(page, 'toolu_after').getByTestId('inline-view')).toHaveCount(0)
  await expect(page.getByTestId('inline-view')).toHaveCount(1)

  const v = viewIn(inline)
  expect(await logged(v, 'tool-input')).toEqual({ q: 'weather' })
  // The call is done — the result arrives once, after the input
  await emit(page, {
    type: 'app_view', sessionId: sid, callId: 'toolu_1', appId: 'viewer', projectId: pid, tool: 'show', phase: 'result',
    toolResult: { content: [{ type: 'text', text: 'sunny' }], structuredContent: { forecast: 'sunny' } },
  })
  expect(await logged(v, 'tool-result')).toEqual({ forecast: 'sunny' })
  expect((await keys(v)).filter((k) => k.startsWith('tool-'))).toEqual(['tool-input', 'tool-result'])
})

test('a call that ends with no result ends with tool-cancelled', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_c', 'mcp__app-viewer__show'))
  await openInline(page, pid, sid, 'toolu_c', { q: 'slow' })
  const v = viewIn(rowOf(page, 'toolu_c').getByTestId('inline-view'))
  expect(await logged(v, 'tool-input')).toEqual({ q: 'slow' })
  await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_c', appId: 'viewer', projectId: pid, tool: 'show', phase: 'cancelled', reason: 'the caller cancelled this call' })
  expect(await logged(v, 'tool-cancelled')).toBe('the caller cancelled this call')
  expect((await keys(v)).filter((k) => k.startsWith('tool-'))).toEqual(['tool-input', 'tool-cancelled'])
})

test('the view\'s ui/message asks before sending it to this conversation, and the sent message shows as sent by the app', async ({ page }) => {
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
  // It has only asked — the view is waiting for an answer, and nothing has gone to the conversation yet
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
  // It shows in the conversation as sent by the app — not as a human speech bubble
  const said = page.getByTestId('msg-user').filter({ hasText: 'hello from the view' })
  await expect(said.getByTestId('msg-user-from-app')).toHaveText('Viewer app ⤷')
})

test('Pin opens that app\'s pinned view', async ({ page }) => {
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

test('when the host closes a view, it sends teardown then collapses into a placeholder with the reason; a rejected view shows only the reason', async ({ page }) => {
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

  // A view rejected for impersonation — only the reason, with no frame and no way to open the app
  await emit(page, toolCall(sid, 'toolu_s', 'mcp__app-viewer__spoof'))
  await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_s', appId: 'viewer', projectId: pid, tool: 'spoof', phase: 'rejected', reason: 'This app does not serve ui://other/main' })
  const refused = rowOf(page, 'toolu_s').getByTestId('inline-view')
  await expect(refused.getByTestId('inline-view-rejected')).toHaveText('This view was not shown: This app does not serve ui://other/main')
  await expect(refused.getByTestId('inline-view-pin')).toHaveCount(0)
  await expect(refused.getByTestId('app-frame')).toHaveCount(0)
})

const teardowns = (page: Page) =>
  page.evaluate(() => ((window as any).__mock.appToolCalls as { tool: string }[]).filter((c) => c.tool === 'save-on-teardown').length)
const closedViews = (page: Page) => page.evaluate(() => (window as any).__mock.closedViews as string[])
const viewState = (page: Page, sid: string, callId: string) =>
  page.evaluate(({ s, c }) => {
    const v = (window as any).__store.getState().inlineViews[s]?.[c]
    return v ? { state: v.state as string, reason: (v.reason ?? null) as string | null, instanceId: v.instanceId as string | null } : null
  }, { s: sid, c: callId })
/** The conversation list's scrolling panel — the ancestor that scrolls, of the box the rows sit on with absolute positioning */
const scrollChat = (page: Page, to: 'top' | 'bottom') =>
  page.evaluate((where) => {
    const row = document.querySelector('[data-index]') as HTMLElement | null
    let el: HTMLElement | null = row
    while (el && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement
    if (!el) throw new Error('no scrolling chat')
    el.scrollTop = where === 'top' ? 0 : el.scrollHeight
  }, to)

test('a view scrolled far out of view sends teardown then collapses into a placeholder, and Reopen reopens it with the input and result it held', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_1', 'mcp__app-viewer__show'))
  const first = await openInline(page, pid, sid, 'toolu_1', { q: 'weather' })
  const result = { content: [{ type: 'text', text: 'sunny' }], structuredContent: { forecast: 'sunny' } }
  await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_1', appId: 'viewer', projectId: pid, tool: 'show', phase: 'result', toolResult: result, kept: true })
  const inline = rowOf(page, 'toolu_1').getByTestId('inline-view')
  expect(await logged(viewIn(inline), 'tool-result')).toEqual({ forecast: 'sunny' })

  // The conversation grows long enough to push that row far up (following the bottom)
  for (let i = 0; i < 60; i++) await emit(page, toolCall(sid, `toolu_more_${i}`, 'Read'))
  await scrollChat(page, 'bottom')
  await expect.poll(() => viewState(page, sid, 'toolu_1')).toEqual({ state: 'parked', reason: 'Closed when it scrolled out of view', instanceId: null })
  // teardown was sent first (the view received it and saved), and the host was told to close the instance
  expect(await teardowns(page)).toBe(1)
  expect(await closedViews(page)).toEqual([first])
  await expect(page.getByTestId('inline-view')).toHaveCount(0)

  // Scrolling back shows the placeholder
  await scrollChat(page, 'top')
  const placeholder = rowOf(page, 'toolu_1').getByTestId('inline-view-placeholder')
  await expect(placeholder).toContainText("Viewer's view is closed · Closed when it scrolled out of view")
  await placeholder.getByTestId('inline-view-reopen').click()
  const again = rowOf(page, 'toolu_1').getByTestId('inline-view')
  await expect(again.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  expect(await page.evaluate(() => (window as any).__mock.reopenedViews)).toEqual([{ sessionId: sid, callId: 'toolu_1' }])
  const reopened = await viewState(page, sid, 'toolu_1')
  expect(reopened?.state).toBe('live')
  expect(reopened?.instanceId).not.toBe(first)
  // The new view receives the same input and result in the spec's order — the tool was not called again
  const v = viewIn(again)
  expect(await logged(v, 'tool-input')).toEqual({ q: 'weather' })
  expect(await logged(v, 'tool-result')).toEqual({ forecast: 'sunny' })
  expect((await keys(v)).filter((k) => k.startsWith('tool-'))).toEqual(['tool-input', 'tool-result'])
})

test('up to three views stay alive in one conversation — opening a fourth sends teardown to the oldest and collapses it into a placeholder', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  const ids: Record<string, string> = {}
  for (const c of ['c1', 'c2', 'c3']) {
    await emit(page, toolCall(sid, c, 'mcp__app-viewer__show'))
    ids[c] = await openInline(page, pid, sid, c, { q: c })
    await expect(rowOf(page, c).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  }
  expect(await teardowns(page)).toBe(0)
  await emit(page, toolCall(sid, 'c4', 'mcp__app-viewer__show'))
  ids.c4 = await openInline(page, pid, sid, 'c4', { q: 'c4' })

  const oldest = rowOf(page, 'c1').getByTestId('inline-view')
  await expect(oldest.getByTestId('inline-view-placeholder')).toContainText('Only the 3 most recent app views in a conversation stay open')
  expect(await teardowns(page)).toBe(1)
  expect(await closedViews(page)).toEqual([ids.c1])
  for (const c of ['c2', 'c3', 'c4']) await expect(rowOf(page, c).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  await expect(page.getByTestId('app-frame')).toHaveCount(3)
})

test('a view that lost its instance (the host restarted) collapses into a placeholder instead of a broken frame, and Reopen revives it', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_lost', 'mcp__app-viewer__show'))
  // An instance the host does not know — the restarted host has no record of the old instance
  await emit(page, {
    type: 'app_view', sessionId: sid, callId: 'toolu_lost', appId: 'viewer', projectId: pid, tool: 'show', phase: 'open',
    instanceId: 'gone-instance-0000000000', toolInput: { q: 'again' },
  })
  const inline = rowOf(page, 'toolu_lost').getByTestId('inline-view')
  await expect(inline.getByTestId('inline-view-placeholder')).toContainText('This view could not be shown: This app view is not open')
  await expect(inline.getByTestId('app-frame-error')).toHaveCount(0)
  await inline.getByTestId('inline-view-reopen').click()
  await expect(inline.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  expect(await logged(viewIn(inline), 'tool-input')).toEqual({ q: 'again' })
})

test('a view that cannot be reopened states the reason and withdraws Reopen — a way to open the app remains', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_big', 'mcp__app-viewer__show'))
  await openInline(page, pid, sid, 'toolu_big', {})
  // The host is not holding the result (it was too big)
  await emit(page, {
    type: 'app_view', sessionId: sid, callId: 'toolu_big', appId: 'viewer', projectId: pid, tool: 'show', phase: 'result',
    toolResult: { content: [{ type: 'text', text: 'huge' }] }, kept: false,
  })
  await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_big', appId: 'viewer', projectId: pid, tool: 'show', phase: 'closed', reason: 'This app was removed' })
  const inline = rowOf(page, 'toolu_big').getByTestId('inline-view')
  await expect(inline.getByTestId('inline-view-placeholder')).toBeVisible()
  await expect(inline.getByTestId('inline-view-reopen')).toHaveCount(0)
  await expect(inline.getByTestId('inline-view-open-app')).toBeVisible()
})

/**
 * After the UI is reopened (M4 B-1). The transcript keeps only the card and the fact that some
 * app's view stood below it — no input, no result. So the past card gets a placeholder rather
 * than the frame being redrawn. If the host is still holding that call, "Reopen" opens it without
 * calling the tool again. If the host has restarted and is not holding it, only "Open app" (the
 * pinned view) remains.
 *
 * Reopening is simulated the same way as control-loop.spec.ts: the in-memory conversation is
 * cleared and read back from storage. The mock persists the card and the app-view row the way the
 * host does, and keeps the call's input and result separately, in memory.
 */
async function reopenUi(page: Page, sid: string) {
  await page.evaluate((id) => {
    const store = (window as any).__store
    store.setState({ chat: { ...store.getState().chat, [id]: undefined }, inlineViews: {} })
    return store.getState().loadHistory(id)
  }, sid)
}

test('UI reopened: a past card gets a placeholder (no frame), and Reopen brings back the input and result if the host is still holding them', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_past', 'mcp__app-viewer__show'))
  const first = await openInline(page, pid, sid, 'toolu_past', { q: 'yesterday' })
  await emit(page, {
    type: 'app_view', sessionId: sid, callId: 'toolu_past', appId: 'viewer', projectId: pid, tool: 'show', phase: 'result',
    toolResult: { content: [{ type: 'text', text: 'rain' }], structuredContent: { forecast: 'rain' } }, kept: true,
  })
  await expect(rowOf(page, 'toolu_past').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')

  await reopenUi(page, sid)
  // The card comes back from the transcript, and below it is a placeholder rather than a frame
  await expect(rowOf(page, 'toolu_past').getByTestId('tool-card')).toBeVisible()
  const past = rowOf(page, 'toolu_past').getByTestId('inline-view')
  await expect(past.getByTestId('inline-view-placeholder')).toContainText("Viewer's view is closed")
  await expect(past.getByTestId('app-frame')).toHaveCount(0)
  await expect(past.getByTestId('inline-view-open-app')).toBeVisible()
  // The reopened UI has no knowledge of the instance left open — it closes it to let the app go
  await expect.poll(() => closedViews(page)).toEqual([first])

  await past.getByTestId('inline-view-reopen').click()
  await expect(past.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  const v = viewIn(past)
  expect(await logged(v, 'tool-input')).toEqual({ q: 'yesterday' })
  expect(await logged(v, 'tool-result')).toEqual({ forecast: 'rain' })
})

test('UI reopened: when the host is not holding the call (it restarted), only Open app remains, with no Reopen — clicking it opens the pinned view; a rejection stays visible as its reason', async ({ page }) => {
  const { pid, sid } = await sessionWithApp(page)
  await emit(page, toolCall(sid, 'toolu_gone', 'mcp__app-viewer__show'))
  await openInline(page, pid, sid, 'toolu_gone', { q: 'x' })
  await emit(page, toolCall(sid, 'toolu_spoof', 'mcp__app-viewer__spoof'))
  await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_spoof', appId: 'viewer', projectId: pid, tool: 'spoof', phase: 'rejected', reason: 'This app does not serve ui://other/main' })
  // The host restarted — the input and result it was holding in memory are gone
  await page.evaluate(() => (window as any).__mock.inlineRecords.clear())

  await reopenUi(page, sid)
  const past = rowOf(page, 'toolu_gone').getByTestId('inline-view')
  await expect(past.getByTestId('inline-view-placeholder')).toContainText("Viewer's view is closed")
  await expect(past.getByTestId('inline-view-reopen')).toHaveCount(0)
  await expect(rowOf(page, 'toolu_spoof').getByTestId('inline-view-rejected')).toHaveText(
    'This view was not shown: This app does not serve ui://other/main',
  )

  await past.getByTestId('inline-view-open-app').click()
  await expect(page.getByTestId(`pinned-app-${pid}/viewer`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
})
