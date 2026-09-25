import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import type { NormalizedEvent } from '@cc/protocol'
import {
  PUBLIC_APPS,
  startPublicAppsHost,
  type PublicAppsHost,
  type ToolResult,
} from './fixtures/public-apps.js'

/**
 * Compatibility: public MCP Apps built for other hosts render inline, unmodified (M4 F-3).
 *
 * The plan's promise is narrow on purpose: an app made for another host works **in the inline
 * surface** (under the tool card that called it), because that surface is the MCP Apps standard
 * and nothing else. If this file breaks, that promise broke.
 *
 * Two official ext-apps examples as published to npm (pinned by version and sha512, fetched once
 * into node_modules/.cache), run from their published `--stdio` entry points with a minimal
 * manifest (fixtures/public-apps.ts):
 *
 *   basic-vanillajs  one tool with a view; the view has a button that calls that same tool
 *   system-monitor   a model tool with a view, and an app-only tool (`visibility: ["app"]`) that the
 *                    view polls, with a Start/Stop button. It checks that our visibility rule lets a
 *                    third-party view reach its app-only tool while agents never see it.
 *
 * The host side is real (runtime, session attachment, inline-view logic, view host). The agent is
 * the test calling the session's attachment, and the UI is the real UI on the mock platform, whose
 * view hooks point at that host.
 */

const HOST_ORIGINS = ['http://127.0.0.1:5174', 'http://localhost:5174']

let fx: PublicAppsHost
test.beforeAll(async () => {
  fx = await startPublicAppsHost(Object.values(PUBLIC_APPS), HOST_ORIGINS)
})
test.afterAll(async () => {
  await fx?.close()
})

/**
 * Every frame records the MCP Apps notifications it receives. Read from inside the app's own frame,
 * this is what the unmodified view was sent (the app's code may not log it: system-monitor has no
 * tool-input handler at all).
 */
function recordMessages() {
  const w = window as unknown as { __rx?: { method: string; params: unknown }[] }
  if (w.__rx) return
  w.__rx = []
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { method?: unknown; params?: unknown } | null
    if (d && typeof d === 'object' && typeof d.method === 'string')
      w.__rx!.push({ method: d.method, params: d.params })
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(recordMessages)
  await page.exposeFunction(
    '__viewFrame',
    (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
      fx.views.frame({
        app: { appId, projectId: opts.projectId ?? null },
        instanceId,
        hostOrigin: opts.hostOrigin,
      }),
  )
  await page.exposeFunction(
    '__viewCall',
    (appId: string, tool: string, args: Record<string, unknown>, from: { projectId?: string | null }) =>
      fx.callAsView({ appId, projectId: from?.projectId ?? null }, tool, args),
  )
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const w = window as any
    w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
    w.__mock.appToolHandler = (a: string, t: string, args: unknown, from: unknown) =>
      w.__viewCall(a, t, args, from)
  })
  fx.forwardTo((e: NormalizedEvent) => page.evaluate((ev) => (window as any).__mock.emit(ev), e))
})
test.afterEach(() => {
  fx.forwardTo(null)
})

/** A trusted project whose apps are the two public ones, and one session in it */
async function sessionWithPublicApps(page: Page): Promise<{ pid: string; sid: string }> {
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/compat'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('trust-ask-yes-compat').click()
  const pid = await page.evaluate(
    () =>
      (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find(
        (x) => x.path === '/tmp/compat',
      )!.id,
  )
  fx.useProject(pid)
  await page.evaluate((list) => (window as any).__mock.setExternalApps(list), fx.list())
  await page.getByTestId('project-menu-compat').click()
  await page.getByTestId('new-session-compat').click()
  await page.getByTestId('create-session-confirm').click()
  const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  return { pid, sid }
}

/** The adapter's card for an MCP tool call — what the agent's call looks like in the conversation */
const toolCard = (page: Page, sid: string, callId: string, tool: string) =>
  page.evaluate((ev) => (window as any).__mock.emit(ev), {
    type: 'tool_call',
    sessionId: sid,
    callId,
    summary: { tool, title: callId, readOnly: false, paths: [] },
  })

const rowOf = (page: Page, callId: string): Locator =>
  page.locator('[data-index]').filter({ has: page.getByTestId('tool-card').filter({ hasText: callId }) })
/** The app's own document: the inner frame inside the sandbox proxy */
const viewIn = (scope: Locator): FrameLocator =>
  scope.getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
/** MCP Apps tool notifications the app's frame received, in order */
const toolNotifications = (v: FrameLocator) =>
  v
    .locator('body')
    .evaluate(() =>
      ((window as any).__rx as { method: string; params: any }[]).filter((m) =>
        m.method.startsWith('ui/notifications/tool-'),
      ),
    )

test('basic-vanillajs: the view opens under its tool card, gets the input then the result, and its button reaches the server tool', async ({
  page,
}) => {
  const { pid, sid } = await sessionWithPublicApps(page)
  const ref = { projectId: pid, appId: PUBLIC_APPS.time.id }
  const agent = fx.session(sid, pid)

  // The agent sees the app's tool the way the vendor published it
  const listed = await agent.tools(`app-${ref.appId}`)
  expect(listed.map((t) => t.name).sort()).toEqual(['get-time', 'run_status'])

  await toolCard(page, sid, 'toolu_before', 'Bash')
  await toolCard(page, sid, 'toolu_time', `mcp__app-${ref.appId}__get-time`)
  await toolCard(page, sid, 'toolu_after', 'Read')
  const answer = (await agent.call(
    `app-${ref.appId}`,
    'get-time',
    {},
    { callId: 'toolu_time' },
  )) as ToolResult
  expect(answer.isError).toBe(false)
  const time = (answer.structuredContent as { time: string }).time

  // Inline, under the card that made the call, and nowhere else
  const inline = rowOf(page, 'toolu_time').getByTestId('inline-view')
  await expect(inline).toHaveAttribute('data-call', 'toolu_time')
  await expect(inline.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  await expect(page.getByTestId('inline-view')).toHaveCount(1)
  await expect(rowOf(page, 'toolu_before').getByTestId('inline-view')).toHaveCount(0)
  await expect(rowOf(page, 'toolu_after').getByTestId('inline-view')).toHaveCount(0)

  // The unmodified view received tool-input, then tool-result, and drew the result
  const v = viewIn(inline)
  await expect(v.locator('#server-time')).toHaveText(time)
  const got = await toolNotifications(v)
  expect(got.map((m) => m.method)).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-result'])
  expect(got[0]!.params).toEqual({ arguments: {} })
  expect(got[1]!.params.structuredContent).toEqual({ time })

  // Its button calls the server tool through the host, recorded as the view's call
  await v.locator('#get-time-btn').click()
  await expect
    .poll(() => fx.runs(ref).map((r) => `${r.callerKind} ${r.tool} ${r.status}`))
    .toEqual(['session get-time ok', 'view get-time ok'])
  await expect(v.locator('#server-time')).not.toHaveText(time)
  await expect(v.locator('#server-time')).toHaveText(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('system-monitor: the view gets its result, polls its app-only tool, and its button restarts polling; agents never see that tool', async ({
  page,
}) => {
  const { pid, sid } = await sessionWithPublicApps(page)
  const ref = { projectId: pid, appId: PUBLIC_APPS.monitor.id }
  const server = `app-${ref.appId}`
  const agent = fx.session(sid, pid)

  // The app-only tool is not in the agent's list, and calling it by name is refused before the app
  expect((await agent.tools(server)).map((t) => t.name).sort()).toEqual(['get-system-info', 'run_status'])
  const refused = await agent.call(server, 'poll-system-stats', {})
  expect(refused.isError).toBe(true)

  await toolCard(page, sid, 'toolu_sys', `mcp__${server}__get-system-info`)
  const answer = (await agent.call(server, 'get-system-info', {}, { callId: 'toolu_sys' })) as ToolResult
  expect(answer.isError).toBe(false)
  const info = answer.structuredContent as { hostname: string }

  const inline = rowOf(page, 'toolu_sys').getByTestId('inline-view')
  await expect(inline.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  await expect(page.getByTestId('inline-view')).toHaveCount(1)
  const v = viewIn(inline)

  // tool-input then tool-result; the view draws the static info it was given
  await expect(v.locator('#info-hostname')).toHaveText(info.hostname)
  const got = await toolNotifications(v)
  expect(got.map((m) => m.method)).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-result'])
  expect(got[1]!.params.structuredContent).toEqual(info)

  // On its result the view starts polling the app-only tool: the host lets the view through
  const polls = () => fx.runs(ref).filter((r) => r.callerKind === 'view' && r.tool === 'poll-system-stats')
  await expect.poll(() => polls().filter((r) => r.status === 'ok').length).toBeGreaterThan(0)
  await expect(v.locator('#memory-percent')).toHaveText(/^\d+%$/)

  /*
   * Its button: Stop, let the last poll land, then Start polls again at once. Only polls that began
   * after the Start click count — a poll already on its way when Stop was clicked is not the button's.
   * (The status line is not checked: a poll in flight at Stop overwrites "Stopped" with its time.)
   */
  const toggle = v.locator('#poll-toggle-btn')
  await toggle.click()
  await expect(toggle).toHaveText('Start')
  await expect.poll(() => polls().filter((r) => r.status === 'running').length).toBe(0)
  // A poll the view sent just before Stop may still be crossing the frames (milliseconds) — let it land
  await page.waitForTimeout(300)
  const clickedAt = Date.now()
  await toggle.click()
  await expect(toggle).toHaveText('Stop')
  await expect
    .poll(() => polls().filter((r) => r.createdAt >= clickedAt && r.status === 'ok').length)
    .toBeGreaterThan(0)
  await toggle.click() // stop polling before the page goes

  // The agent's refused call and its real call are both on record; no view call was refused
  expect(
    fx
      .runs(ref)
      .filter((r) => r.callerKind === 'session')
      .map((r) => `${r.tool} ${r.status}`),
  ).toEqual(['poll-system-stats rejected', 'get-system-info ok'])
  expect(polls().filter((r) => r.status !== 'ok' && r.status !== 'running')).toEqual([])
})
