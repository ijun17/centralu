import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'
import { expectOutOfSight } from './fixtures/project-screen.js'

/**
 * Where external apps show up in the UI (M4 A-8, B-2, B-4, B-6, B-7) — real UI on a mock platform.
 *
 * Discovery on the mock is `__mock.setExternalApps`. It changes the list and broadcasts
 * `external_apps_changed` the way the host would. So "follows the broadcast" as checked here goes
 * through the real subscription path (the store's dispatchEvent → re-reading apps.list).
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

function app(appId: string, projectId: string | null, over: Partial<AppInfo> = {}): AppInfo {
  return {
    appId,
    projectId,
    dir: `/tmp/${projectId ?? 'user'}/.centralu/apps/${appId}`,
    name: `App ${appId}`,
    version: '0.1.0',
    description: null,
    home: 'home',
    trusted: true,
    status: 'stopped',
    error: null,
    warnings: [],
    ...over,
  }
}

async function setApps(page: Page, list: AppInfo[]) {
  await page.evaluate((l) => (window as any).__mock.setExternalApps(l), list)
}

/** Picks a folder and registers a project, returning the id the mock assigned */
async function addProject(page: Page, path: string): Promise<string> {
  await page.evaluate((p) => ((window as any).__mock.nextPickedDirectory = p), path)
  await page.getByTestId('add-project').click()
  const name = path.split('/').pop()!
  await expect(page.getByTestId(`project-${name}`)).toBeVisible()
  return page.evaluate(
    (p) => (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find((x) => x.path === p)!.id,
    path,
  )
}

async function openAppsSettings(page: Page) {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-apps').click()
}

test('the settings app list: every app shows in one list, and status and reason follow the broadcast', async ({ page }) => {
  await page.goto('/?mock=1')
  const pid = await addProject(page, '/tmp/alpha')
  // With no apps yet, the list says so instead of standing empty
  await openAppsSettings(page)
  await expect(page.getByTestId('settings-apps-empty')).toBeVisible()

  await setApps(page, [
    app('notes', pid, { status: 'running' }),
    app('broken', pid, { name: null, status: 'invalid', error: 'centralu.app.json is not JSON' }),
    app('timer', null),
  ])

  // No built-in toggle row is left (the control rail went in #97)
  await expect(page.locator('[data-testid^="app-toggle-"]')).toHaveCount(0)
  await expect(page.getByTestId('settings-apps-empty')).toHaveCount(0)
  const list = page.getByTestId('settings-external-apps')
  // That project's apps under the project name, user-folder apps in their own group
  await expect(list).toContainText('alpha')
  await expect(list).toContainText('Your apps')
  const notes = page.getByTestId(`external-app-${pid}/notes`)
  await expect(notes).toHaveAttribute('data-status', 'running')
  await expect(notes.getByTestId('external-app-status')).toHaveText('Running')
  // A broken app is not hidden either — falls back to the folder name if it has none, with the reason
  const broken = page.getByTestId(`external-app-${pid}/broken`)
  await expect(broken.getByTestId('external-app-status')).toHaveText('Invalid')
  await expect(broken.getByTestId('external-app-reason')).toHaveText('centralu.app.json is not JSON')
  await expect(page.getByTestId('external-app-_user/timer')).toBeVisible()

  // The host broadcasts "it changed" — the open list re-reads
  await setApps(page, [
    app('notes', pid, { status: 'failed', error: 'exited before it was ready (code 3)' }),
    app('timer', null),
  ])
  await expect(notes.getByTestId('external-app-status')).toHaveText('Failed')
  await expect(notes.getByTestId('external-app-reason')).toHaveText('exited before it was ready (code 3)')
  await expect(broken).toHaveCount(0)
})

const trustCalls = (page: Page) => page.evaluate(() => (window as any).__mock.trustCalls as { projectId: string; trusted: boolean }[])

test('registering a project asks to trust it once — "Later" sends nothing, and it can be toggled from the project menu afterward', async ({ page }) => {
  await page.goto('/?mock=1')
  const pid = await addProject(page, '/tmp/alpha')
  const ask = page.getByTestId('trust-ask-alpha')
  await expect(ask).toBeVisible()
  await expect(ask).toContainText("Trusting lets this project's apps run and its settings apply")

  await page.getByTestId('trust-ask-no-alpha').click()
  await expect(ask).toHaveCount(0)
  expect(await trustCalls(page)).toEqual([])

  // Once asked, that is the end of it — from then on, it is in the menu
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('toggle-trust-alpha')).toHaveText('Trust this project')
  await page.getByTestId('toggle-trust-alpha').click()
  await expect.poll(() => trustCalls(page)).toEqual([{ projectId: pid, trusted: true }])
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('toggle-trust-alpha')).toHaveText('Stop trusting this project')
  await page.getByTestId('toggle-trust-alpha').click()
  await expect.poll(() => trustCalls(page)).toEqual([
    { projectId: pid, trusted: true },
    { projectId: pid, trusted: false },
  ])

  // No session is running, so there is nothing extra to say
  await expect(page.getByTestId('toast')).toHaveCount(0)
  // With a session running: it states in one line that the changed trust applies once that session restarts or resumes
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('toggle-trust-alpha').click()
  await expect(page.getByTestId('toast')).toHaveText('Running sessions here pick up the new trust when they restart or resume.')

  // A different project: trusts it right from the ask
  const beta = await addProject(page, '/tmp/beta')
  await page.getByTestId('trust-ask-yes-beta').click()
  await expect(page.getByTestId('trust-ask-beta')).toHaveCount(0)
  await expect.poll(async () => (await trustCalls(page)).at(-1)).toEqual({ projectId: beta, trusted: true })
})

test('an app from an untrusted project shows with a reason, and can be trusted right there in one click', async ({ page }) => {
  await page.goto('/?mock=1')
  const pid = await addProject(page, '/tmp/alpha')
  await page.getByTestId('trust-ask-no-alpha').click()
  await setApps(page, [app('notes', pid, { trusted: false, status: 'untrusted' })])
  await openAppsSettings(page)

  const row = page.getByTestId(`external-app-${pid}/notes`)
  await expect(row.getByTestId('external-app-status')).toHaveText('Not trusted')
  await expect(row.getByTestId('external-app-reason')).toHaveText("This project isn't trusted, so its apps don't run.")
  await row.getByTestId('external-app-trust').click()
  await expect.poll(() => trustCalls(page)).toEqual([{ projectId: pid, trusted: true }])
  // The host rescans and broadcasts — the app becomes stopped, and the trust button disappears
  await expect(row.getByTestId('external-app-status')).toHaveText('Stopped')
  await expect(row.getByTestId('external-app-trust')).toHaveCount(0)
})

test('a user-folder app is removed from the list after asking once — cancelling sends nothing, and a project app has no remove option', async ({ page }) => {
  await page.goto('/?mock=1')
  const pid = await addProject(page, '/tmp/alpha')
  // An approved MCP server becomes a screenless user-folder app (A-7)
  await setApps(page, [app('notes', pid), app('github-mcp', null, { name: 'github-mcp', home: null, description: 'Approved MCP server' })])
  await openAppsSettings(page)
  const removed = () => page.evaluate(() => (window as any).__mock.removedApps as string[])

  await expect(page.getByTestId(`external-app-${pid}/notes`).getByTestId('external-app-remove')).toHaveCount(0)
  const row = page.getByTestId('external-app-_user/github-mcp')
  await row.getByTestId('external-app-remove').click()
  await expect(row.getByTestId('external-app-remove-confirm')).toContainText('Its folder moves to the app trash')
  await row.getByTestId('external-app-remove-cancel').click()
  await expect(row.getByTestId('external-app-remove-confirm')).toHaveCount(0)
  expect(await removed()).toEqual([])

  await row.getByTestId('external-app-remove').click()
  await row.getByTestId('external-app-remove-yes').click()
  await expect.poll(removed).toEqual(['github-mcp'])
  // The host rebroadcasts the list — the row disappears
  await expect(row).toHaveCount(0)
})

/*
 * Pinned views (M4 B-2). A real ViewHost is plugged into the mock's `apps.openView` (the same
 * test bed as app-frame.spec.ts): what is opened is an instance of the HostServer/ViewHost this
 * worker started, and the view is a test app built with the official ext-apps `App`. The host
 * calling home is covered with a real app by agent-host's app-home-view.test.ts. Here what is
 * checked is what the UI does once it receives that answer.
 */
test.describe('pinned views (B-2, B-4, B-6, B-7)', () => {
  let fx: FixtureHost
  test.beforeAll(async () => {
    fx = await startFixtureHost({
      'slider ui://slider/main': { html: fixtureViewHtml() },
      'timer ui://timer/main': { html: fixtureViewHtml() },
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
    // As if the host called home and opened the instance — the result carries which app's home this is
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

  /** The inner frame the app's HTML runs in (the outer one is the proxy) */
  const viewOf = (page: Page, key: string): FrameLocator =>
    page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
  const opened = (page: Page) => page.evaluate(() => (window as any).__mock.openedViews as { appId: string; projectId: string | null }[])
  const closed = (page: Page) => page.evaluate(() => (window as any).__mock.closedViews as string[])
  /** How many times the view received teardown — the test app calls the save tool (`save-on-teardown`) and responds when it does */
  const teardowns = (page: Page) =>
    page.evaluate(() => ((window as any).__mock.appToolCalls as { tool: string }[]).filter((c) => c.tool === 'save-on-teardown').length)

  /** One trusted project */
  async function trustedProject(page: Page, path: string): Promise<string> {
    const pid = await addProject(page, path)
    await page.getByTestId(`trust-ask-yes-${path.split('/').pop()}`).click()
    await expect.poll(() => trustCalls(page)).toContainEqual({ projectId: pid, trusted: true })
    return pid
  }

  test('an app shows under its project, clicking it opens the view in the main area, and going to a session and back keeps the same instance', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider' })])

    // Inside the sidebar's project block, in the same list shape as the session rows
    const row = page.getByTestId(`project-alpha`).getByTestId(`app-row-${pid}/slider`)
    await expect(row).toHaveText('Slider')
    await row.click()
    await expect(row).toHaveAttribute('aria-current', 'page')

    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned).toBeVisible()
    await expect(pinned.getByTestId('pinned-title')).toHaveText('Slider')
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const v = viewOf(page, `${pid}/slider`)
    // The result of the home call the host made reaches the view as a spec-compliant tool-result
    await expect(v.locator('li[data-k="tool-result"]')).toHaveText('tool-result {"home":"slider"}')
    // Fills the main area — not the inline view's initial height (160px)
    expect((await pinned.getByTestId('app-frame-iframe').boundingBox())!.height).toBeGreaterThan(400)
    // The view is told the slot's size as a fixed size — the slot decides its own height, not the view
    const connected = JSON.parse(((await v.locator('li[data-k="connected"]').textContent()) ?? '').slice('connected '.length))
    expect(connected.hostContext.containerDimensions).toEqual({ height: expect.any(Number), width: expect.any(Number) })
    expect(connected.hostContext.containerDimensions.height).toBeGreaterThan(400)
    // The evidence rail withdraws — the app takes up the whole slot
    await expect(page.getByTestId('evidence-panel')).toHaveCount(0)
    await expect(page.getByTestId('evidence-rail-shell')).toHaveCount(0)

    // Do something inside the view — this row would disappear if the document were re-read
    await v.locator('#call').click()
    await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)

    // Go to the session — the pinned view only hides, it does not go down
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    await expect(page.getByTestId('session-view')).toBeVisible()
    await expectOutOfSight(pinned)
    await expect(row).not.toHaveAttribute('aria-current', 'page')

    // Come back — the keyboard follows the same row
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(pinned).toBeVisible()
    await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
    await expect(v.locator('li[data-k="connected"]')).toHaveCount(1)
    expect(await opened(page)).toEqual([{ appId: 'slider', projectId: pid }])
    expect(await closed(page)).toEqual([])
  })

  test('closing it sends the spec-compliant teardown, releases the instance, and returns to the session slot that was showing before', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    /*
     * A session to go back to. Without one the focus lane is the project's screen (#203), where the app is a panel
     * and × only leaves — project-screen.spec.ts covers that way back.
     */
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    await expect(page.getByTestId('session-view')).toBeVisible()
    const sessionId = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const instanceId = await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)

    await pinned.getByTestId('pinned-close').click()
    await expect(pinned).toHaveCount(0)
    // The test app calls the save tool and answers when it receives teardown — if that call arrived, the view received the request
    await expect.poll(() => teardowns(page)).toBe(1)
    await expect.poll(() => closed(page)).toEqual([instanceId])
    expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('focus')
    await expect(page.getByTestId('session-view')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(sessionId)
  })

  test('an app with no view still shows in the list, and opening it says "this app has no screen" — home is not even called', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('headless', pid, { home: null, description: 'Only tools for agents.' })])
    await page.getByTestId(`app-row-${pid}/headless`).click()
    const empty = page.getByTestId(`pinned-app-${pid}/headless`).getByTestId('pinned-no-screen')
    await expect(empty).toContainText('This app has no screen.')
    await expect(empty).toContainText('Only tools for agents.')
    expect(await opened(page)).toEqual([])
  })

  test('an app from an untrusted project: the row shows a reason, opening it gives the reason and a trust button, and clicking it opens the view right there', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await page.getByTestId('trust-ask-no-alpha').click()
    await setApps(page, [app('slider', pid, { trusted: false, status: 'untrusted' })])

    const row = page.getByTestId(`app-row-${pid}/slider`)
    await expect(row.getByTestId('app-row-hint')).toHaveText('not trusted')
    await row.click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    const blocked = pinned.getByTestId('pinned-untrusted')
    await expect(blocked).toContainText("This project isn't trusted, so its apps don't run.")
    expect(await opened(page)).toEqual([])

    await blocked.getByTestId('pinned-trust').click()
    await expect.poll(() => trustCalls(page)).toEqual([{ projectId: pid, trusted: true }])
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(row.getByTestId('app-row-hint')).toHaveCount(0)
    expect(await opened(page)).toEqual([{ appId: 'slider', projectId: pid }])
  })

  test('turning off trust also takes down an open view — the view\'s HTML is code from that project too', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const instanceId = await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)

    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('toggle-trust-alpha').click()
    await expect(pinned.getByTestId('pinned-untrusted')).toBeVisible()
    await expect(pinned.getByTestId('app-frame')).toHaveCount(0)
    // teardown reached the view before it was taken down (the test app calls the save tool when it receives it)
    await expect.poll(() => teardowns(page)).toBe(1)
    await expect.poll(() => closed(page)).toEqual([instanceId])
  })

  test('when an app disappears, its open view goes down and the instance is released', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const instanceId = await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)

    await setApps(page, [])
    await expect(pinned).toHaveCount(0)
    await expect.poll(() => teardowns(page)).toBe(1)
    await expect.poll(() => closed(page)).toEqual([instanceId])
    await expect(page.getByTestId('toast')).toContainText('is no longer available')
  })

  const restarts = (page: Page) => page.evaluate(() => (window as any).__mock.restarts as { appId: string; projectId: string | null }[])
  const instanceOf = (page: Page) => page.evaluate(() => (window as any).__store.getState().pinnedViews[0]?.instanceId as string | null)

  test('B-6: a skeleton shows while an app is launching, keeps covering it while the view is loading, and clears once it initializes', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider', status: 'stopped' })])
    // Holds while the host calls home (the app process's launch time), and while the proxy loads the view
    await page.evaluate(() => {
      const w = window as any
      w.__openGate = new Promise((r) => (w.__openRelease = r))
      w.__frameGate = new Promise((r) => (w.__frameRelease = r))
      const open = w.__mock.openViewProvider
      const frame = w.__mock.viewFrameProvider
      w.__mock.openViewProvider = async (a: string, p: string | null) => (await w.__openGate, open(a, p))
      w.__mock.viewFrameProvider = async (a: string, i: string, o: unknown) => (await w.__frameGate, frame(a, i, o))
    })
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('pinned-skeleton-label')).toHaveText('Starting Slider…')
    // The host broadcasts that it is launching — same skeleton, same message
    await setApps(page, [app('slider', pid, { name: 'Slider', status: 'starting' })])
    await expect(pinned.getByTestId('pinned-skeleton')).toBeVisible()

    await setApps(page, [app('slider', pid, { name: 'Slider', status: 'running' })])
    await page.evaluate(() => (window as any).__openRelease())
    // The instance exists and the frame is loading — the skeleton covers the frame
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'loading')
    await expect(pinned.getByTestId('app-frame-loading').getByTestId('pinned-skeleton-label')).toHaveText('Opening Slider…')

    await page.evaluate(() => (window as any).__frameRelease())
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(pinned.getByTestId('pinned-skeleton')).toHaveCount(0)
  })

  test('B-6: an app that repeatedly failed to launch shows the reason and Restart, and clicking it launches again then opens the view', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { status: 'failed', error: 'exited before it was ready (code 3)\nfixture: cannot open the thing it needs' })])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    const failed = pinned.getByTestId('pinned-failed')
    await expect(failed).toContainText('This app stopped after failing repeatedly.')
    await expect(failed.getByTestId('pinned-reason')).toContainText('fixture: cannot open the thing it needs')
    // A stopped app does not relaunch on its own — nothing is called before it is clicked
    expect(await opened(page)).toEqual([])

    await failed.getByTestId('pinned-restart').click()
    await expect.poll(() => restarts(page)).toEqual([{ appId: 'slider', projectId: pid }])
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    expect(await opened(page)).toEqual([{ appId: 'slider', projectId: pid }])
  })

  test('B-6: when a running app dies, the reason and Restart appear over the view, and clicking it sends teardown then reopens as a new instance', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { status: 'running' })])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const first = await instanceOf(page)

    await setApps(page, [app('slider', pid, { status: 'crashed', error: 'exited (code 7)' })])
    const banner = pinned.getByTestId('pinned-crashed')
    await expect(banner).toContainText('This app stopped.')
    await expect(banner.getByTestId('pinned-reason')).toHaveText('exited (code 7)')
    // The view stays — the content the person was looking at is still right there
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(page.getByTestId(`app-row-${pid}/slider`).getByTestId('app-row-hint')).toHaveText('crashed')

    await banner.getByTestId('pinned-restart').click()
    await expect.poll(() => teardowns(page)).toBe(1)
    await expect.poll(() => closed(page)).toEqual([first])
    await expect.poll(() => restarts(page)).toEqual([{ appId: 'slider', projectId: pid }])
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(pinned.getByTestId('pinned-crashed')).toHaveCount(0)
    expect(await opened(page)).toHaveLength(2)
    expect(await instanceOf(page)).not.toBe(first)
  })

  test('B-6: if the view fails to open, the reason the host gave and Restart appear', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    await page.evaluate(() => {
      const w = window as any
      const open = w.__mock.openViewProvider
      let first = true
      w.__mock.openViewProvider = async (a: string, p: string | null) => {
        if (first) {
          first = false
          throw new Error('exited before it was ready (code 3)')
        }
        return open(a, p)
      }
    })
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    const failed = pinned.getByTestId('pinned-open-failed')
    await expect(failed.getByTestId('pinned-reason')).toContainText('exited before it was ready (code 3)')

    await failed.getByTestId('pinned-restart').click()
    await expect.poll(() => restarts(page)).toEqual([{ appId: 'slider', projectId: pid }])
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  })

  test('B-7: the run panel shows recent runs with time, tool, caller, outcome, and duration, marks failures, and re-reads when a call finishes', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    // Create a session to check that the calling session's name shows in the row
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    const session = await page.evaluate(() => {
      const st = (window as any).__store.getState()
      return { id: st.focusedSessionId as string, name: st.sessions[st.focusedSessionId].name as string }
    })
    const t0 = Date.UTC(2026, 8, 25, 3, 4, 5)
    const mk = (id: string, tool: string, callerKind: string, status: string, durationMs: number | null, error: string | null, at: number, sid: string | null = null) => ({
      id, projectId: pid, appId: 'slider', kind: 'tool', tool, callerKind, callerSessionId: sid, parentRunId: null, status, durationMs,
      argsDigest: 'd', argsSummary: '{}', error, createdAt: at, sessionId: null, failure: null,
    })
    const runs = [
      mk('r4', 'agent_only', 'view', 'rejected', 0, 'agent_only is not open to views (visibility: ["model"])', t0),
      mk('r3', 'crash', 'session', 'error', 5, 'exited (code 7)', t0 - 1000, session.id),
      mk('r2', 'set_interval', 'app', 'ok', 1500, null, t0 - 2000),
      mk('r1', 'home', 'view', 'ok', 42, null, t0 - 3000),
    ]
    await page.evaluate(({ key, runs }) => (window as any).__mock.appRuns.set(key, runs), { key: `${pid}/slider`, runs })

    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await pinned.getByTestId('pinned-runs-toggle').click()
    await expect(pinned.getByTestId('pinned-runs-toggle')).toHaveAttribute('aria-pressed', 'true')
    const rows = pinned.getByTestId('runs-panel').getByTestId('run-row')
    await expect(rows).toHaveCount(4)
    await expect(rows.getByTestId('run-tool')).toHaveText(['agent_only', 'crash', 'set_interval', 'home'])
    await expect(rows.getByTestId('run-status')).toHaveText(['refused', 'failed', 'ok', 'ok'])
    await expect(rows.getByTestId('run-caller')).toHaveText(['View', `Session · ${session.name}`, 'App', 'View'])
    await expect(rows.getByTestId('run-duration')).toHaveText(['0 ms', '5 ms', '1.5 s', '42 ms'])
    await expect(rows.nth(0).getByTestId('run-time')).toHaveAttribute('datetime', new Date(t0).toISOString())
    // Only failures are marked — with a one-line reason
    await expect(rows.nth(0)).toHaveAttribute('data-failed', 'true')
    await expect(rows.nth(1)).toHaveAttribute('data-failed', 'true')
    await expect(rows.nth(2)).not.toHaveAttribute('data-failed', 'true')
    await expect(rows.nth(1).getByTestId('run-error')).toHaveText('exited (code 7)')
    await expect(rows.nth(2).getByTestId('run-error')).toHaveCount(0)

    // A new row landed in this app's log — the panel re-reads on the host's run-log signal
    await page.evaluate(
      ({ key, extra }) => {
        const m = (window as any).__mock
        m.appRuns.set(key, [extra, ...m.appRuns.get(key)])
        m.emit({ type: 'external_app_runs_changed', appId: 'slider', projectId: extra.projectId })
      },
      { key: `${pid}/slider`, extra: mk('r5', 'get_interval', 'view', 'ok', 3, null, t0 + 1000) },
    )
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(0).getByTestId('run-tool')).toHaveText('get_interval')

    // Closing the panel leaves the view untouched — the same document
    await pinned.getByTestId('pinned-runs-toggle').click()
    await expect(pinned.getByTestId('runs-panel')).toHaveCount(0)
    await expect(viewOf(page, `${pid}/slider`).locator('li[data-k="connected"]')).toHaveCount(1)
  })

  test('D-6: the run panel shows a chain — the row for a called app and the row for its request are indented, and clicking the agent request jumps to that session', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid), app('helper', pid)])
    // The agent session the app asked for — on the mock, this usually shows as a plain session
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    const agentSession = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
    const t0 = Date.UTC(2026, 8, 25, 3, 4, 5)
    const mk = (id: string, appId: string, kind: 'tool' | 'broker', tool: string, parentRunId: string | null, at: number, over: Record<string, unknown> = {}) => ({
      id, projectId: pid, appId, kind, tool, callerKind: kind === 'broker' || parentRunId ? 'app' : 'view', callerSessionId: null, parentRunId,
      status: 'ok', durationMs: 10, argsDigest: 'd', argsSummary: '{}', error: null, createdAt: at, sessionId: null, failure: null, ...over,
    })
    // Exactly the shape the host gives — this app's row and the chain below it, most recent first. The agent is still running and the session has not landed yet
    const chain = (agent: Record<string, unknown>) => [
      mk('ask', 'slider', 'broker', 'run_agent', 'r1', t0 + 300, agent),
      mk('h-ask', 'helper', 'broker', 'host_data', 'h1', t0 + 250, { status: 'rejected', error: 'host_data refused: "git.status" is not in this app\'s "uses.host"' }),
      mk('h1', 'helper', 'tool', 'lookup', 'r1', t0 + 200),
      mk('r1', 'slider', 'tool', 'summarize', null, t0 + 100),
    ]
    await page.evaluate(({ key, runs }) => (window as any).__mock.appRuns.set(key, runs), { key: `${pid}/slider`, runs: chain({ status: 'running', durationMs: null }) })

    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await pinned.getByTestId('pinned-runs-toggle').click()
    const rows = pinned.getByTestId('runs-panel').getByTestId('run-row')
    // Below the top row, in the order they happened — the other app's call, that app's request, and this app's request
    await expect(rows.getByTestId('run-tool')).toHaveText(['summarize', 'App helper · lookup', 'host_data', 'run_agent'])
    await expect(rows.getByTestId('run-caller')).toHaveText(['View', 'App', 'Asked by App helper', 'Asked by App slider'])
    expect(await rows.evaluateAll((els) => els.map((e) => [e.getAttribute('data-depth'), e.getAttribute('data-kind')]))).toEqual([
      ['0', 'tool'],
      ['1', 'tool'],
      ['2', 'broker'],
      ['1', 'broker'],
    ])
    await expect(rows.nth(2).getByTestId('run-status')).toHaveText('refused')
    await expect(rows.nth(2).getByTestId('run-error')).toContainText('host_data refused')
    await expect(rows.nth(3).getByTestId('run-status')).toHaveText('running')
    await expect(pinned.getByTestId('run-open-session')).toHaveCount(0)

    // The agent's session landed and the work finished — the host announces that row's completion via the run-log signal, and the panel re-reads
    await page.evaluate(
      ({ key, runs, pid }) => {
        const m = (window as any).__mock
        m.appRuns.set(key, runs)
        m.emit({ type: 'external_app_runs_changed', appId: 'slider', projectId: pid })
      },
      { key: `${pid}/slider`, runs: chain({ status: 'ok', durationMs: 4200, sessionId: agentSession }), pid },
    )
    await expect(rows.nth(3).getByTestId('run-status')).toHaveText('ok')
    await expect(rows.nth(3).getByTestId('run-duration')).toHaveText('4.2 s')
    const open = rows.nth(3).getByTestId('run-open-session')
    await expect(open).toHaveText('Open session')
    await expect(pinned.getByTestId('run-open-session')).toHaveCount(1)

    await open.click()
    await expect.poll(() => page.evaluate(() => {
      const st = (window as any).__store.getState()
      return [st.view, st.focusedSessionId]
    })).toEqual(['focus', agentSession])
  })

  test('D-5: the run panel shows the usage of the agent this app asked for — the last day and 30 days, plus tokens per row', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    const t0 = Date.UTC(2026, 8, 25, 3, 4, 5)
    const row = {
      id: 'ask', projectId: pid, appId: 'slider', kind: 'broker', tool: 'run_agent', callerKind: 'app', callerSessionId: null, parentRunId: null,
      status: 'ok', durationMs: 4200, argsDigest: 'd', argsSummary: '{}', error: null, createdAt: t0, sessionId: null, tokens: { input: 1200, output: 80 }, failure: null,
    }
    await page.evaluate(({ key, runs }) => (window as any).__mock.appRuns.set(key, runs), { key: `${pid}/slider`, runs: [row] })

    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await pinned.getByTestId('pinned-runs-toggle').click()
    const panel = pinned.getByTestId('runs-panel')
    await expect(panel.getByTestId('run-row')).toHaveCount(1)
    await expect(panel.getByTestId('run-tokens')).toHaveText('1.3k tokens')
    await expect(panel.getByTestId('run-tokens')).toHaveAttribute('title', 'in 1200 · out 80')
    // If the host says the app never asked for an agent, the usage field does not appear
    await expect(panel.getByTestId('runs-agent-use')).toHaveCount(0)

    await page.evaluate(
      ({ key }) =>
        (window as any).__mock.appUsage.set(key, {
          day: { runs: 2, durationMs: 65_000, tokens: { input: 12_000, output: 400 } },
          month: { runs: 41, durationMs: 1_325_000, tokens: { input: 1_200_000, output: 90_000 } },
        }),
      { key: `${pid}/slider` },
    )
    await panel.getByTestId('runs-refresh').click()
    const use = panel.getByTestId('runs-agent-use')
    await expect(use.getByTestId('agent-use-day')).toHaveText('2 runs · 1m 5s · 12.4k tokens')
    await expect(use.getByTestId('agent-use-month')).toHaveText('41 runs · 22m 5s · 1.3M tokens')
  })

  /** Messages the session received from the person — what the mock recorded, the way the host would */
  const sentTo = (page: Page, sid: string) =>
    page.evaluate(
      (id) =>
        (((window as any).__mock.messages.get(id) ?? []) as { role: string; payload: { text?: string } }[])
          .filter((m) => m.role === 'user')
          .map((m) => m.payload.text),
      sid,
    )
  /** A line the view logged — the nth one */
  const logged = async (v: FrameLocator, k: string, nth = 0) => {
    const li = v.locator(`li[data-k="${k}"]`).nth(nth)
    await expect(li).toBeVisible()
    return JSON.parse(((await li.textContent()) ?? '').slice(k.length + 1))
  }

  test('B-4: a pinned view\'s ui/message asks which session to send to, sends nothing before one is picked, and the view receives a refusal if it is cancelled', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider' })])
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
    const name = await page.evaluate((id) => (window as any).__store.getState().sessions[id].name as string, sid)

    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const v = viewOf(page, `${pid}/slider`)

    await v.locator('#msg').click()
    const ask = pinned.getByTestId('pinned-message-ask')
    await expect(ask).toContainText('Slider wants to send this to a session:')
    await expect(ask.getByTestId('pinned-message-text')).toHaveText('hello from the view')
    await expect(ask.getByTestId(`pinned-message-to-${sid}`)).toContainText(name)
    // It has only asked — the view's request is still waiting, and nothing has gone to the session
    await expect(v.locator('li[data-k="msg-result"]')).toHaveCount(0)
    expect(await sentTo(page, sid)).toEqual([])

    await ask.getByTestId('pinned-message-cancel').click()
    await expect(ask).toHaveCount(0)
    expect(await logged(v, 'msg-result')).toEqual({ isError: true })
    expect(await sentTo(page, sid)).toEqual([])

    // Again — this time picking one
    await v.locator('#msg').click()
    await pinned.getByTestId(`pinned-message-to-${sid}`).click()
    await expect.poll(() => sentTo(page, sid)).toEqual(['hello from the view'])
    expect(await logged(v, 'msg-result', 1)).toEqual({})
    await expect(page.getByTestId('toast')).toContainText('Sent to')
    // The person does not leave the app — sending it does not pull them into the session
    await expect(pinned).toBeVisible()
  })

  test('a user-folder app has its own group outside any project', async ({ page }) => {
    await addProject(page, '/tmp/alpha')
    await setApps(page, [app('timer', null, { name: 'Timer' })])
    const group = page.getByTestId('user-apps')
    await expect(group).toContainText('Your apps')
    await group.getByTestId('app-row-_user/timer').click()
    const pinned = page.getByTestId('pinned-app-_user/timer')
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    expect(await opened(page)).toEqual([{ appId: 'timer', projectId: null }])
  })
})
