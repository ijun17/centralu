import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './app-views.js'
import { expectCoveredInSight, expectFrameTakesPointer, expectOutOfSight, hiddenAround, newSession } from './project-screen.js'

/**
 * Apps on the grid (#288): an app's sidebar row dropped on the grid stands there as a panel, moves and leaves like a
 * session's, and shows a view of its own — apart from the app's pinned view, which the app view and the project screen
 * share. The frames are real (the sandbox proxy from the fixture host), as in fixtures/project-screen.ts, so "the same
 * document" is something the view itself reports.
 *
 * A function rather than a describe in one file, because it runs twice: in Chromium (grid-apps.spec.ts) and in WebKit
 * (grid-apps-webkit.spec.ts). The view is laid over its panel by measuring the panel, and in WebKit a drag goes into a
 * frame whatever the frame's pointer-events say (the panel's cover over the view answers that, dragShield.tsx) — both
 * places where the desktop app (WKWebView) can differ.
 *
 * Grid panels are keyed by session id, or `app:<project | _user>/<appId>` for an app (core's `gridPanelKey`).
 */

export const slider = (projectId: string | null, overrides: Record<string, unknown> = {}) => ({
  appId: 'slider',
  projectId,
  dir: projectId ? '/tmp/alpha/.centralu/apps/slider' : '/tmp/user/apps/slider',
  name: 'Slider',
  version: '0.1.0',
  description: null,
  home: 'home',
  trusted: true,
  status: 'stopped',
  error: null,
  warnings: [],
  ...overrides,
})

export const setApps = (page: Page, apps: unknown[]) =>
  page.evaluate((list) => (window as any).__mock.setExternalApps(list), apps)

/** The grid's panels, in the order they stand */
export const gridOrder = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="grid"] [data-testid^="grid-panel-"]')].map((el) =>
      el.getAttribute('data-testid')!.slice('grid-panel-'.length),
    ),
  )

/** What the store holds for the grid — the references, as the host keeps them */
export const stored = (page: Page) => page.evaluate(() => (window as any).__store.getState().gridPanels as unknown[])

const opened = (page: Page) => page.evaluate(() => ((window as any).__mock.openedViews as unknown[]).length)
const closed = (page: Page) => page.evaluate(() => (window as any).__mock.closedViews as string[])
const teardowns = (page: Page) =>
  page.evaluate(
    () =>
      ((window as any).__mock.appToolCalls as { tool: string }[]).filter((c) => c.tool === 'save-on-teardown')
        .length,
  )
const instanceOf = (page: Page, key: string) =>
  page.evaluate(
    (k) =>
      ((window as any).__store.getState().pinnedViews as { key: string; instanceId: string }[]).find(
        (p) => p.key === k,
      )!.instanceId,
    key,
  )

/** The app's document inside a view: the proxy frame, then the app's own frame inside it */
const viewOf = (page: Page, key: string): FrameLocator =>
  page
    .getByTestId(`pinned-app-${key}`)
    .getByTestId('app-frame-iframe')
    .contentFrame()
    .locator('iframe')
    .contentFrame()

/** The view stands inside its panel's slot, to within a pixel */
export async function expectOverSlot(page: Page, viewKey: string, slot: Locator) {
  await expect
    .poll(async () => {
      const s = await slot.boundingBox()
      const v = await page.getByTestId(`pinned-app-${viewKey}`).boundingBox()
      if (!s || !v) return false
      return [v.x - s.x, v.y - s.y, v.width - s.width, v.height - s.height].every((d) => Math.abs(d) <= 1)
    })
    .toBe(true)
}

/** Opens the grid with these sessions on it */
export async function openGrid(page: Page, sessionIds: string[]) {
  await page.evaluate(
    (l) =>
      (window as any).__store
        .getState()
        .setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))),
    sessionIds,
  )
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()
}

/**
 * Drags a sidebar row onto the grid with the mouse — before or after a panel, or onto the grid's padding (the empty
 * grid's middle). Only a drag the browser runs itself goes through a frame the way a hand does.
 */
export async function dragRowToGrid(
  page: Page,
  row: Locator,
  to: { panel: string; side: 'before' | 'after' } | 'padding',
) {
  const from = (await row.boundingBox())!
  let x: number
  let y: number
  if (to === 'padding') {
    const grid = (await page.getByTestId('grid').boundingBox())!
    x = grid.x + grid.width / 2
    y = grid.y + grid.height / 2
  } else {
    const card = (await page.getByTestId(`grid-panel-${to.panel}`).boundingBox())!
    x = card.x + card.width * (to.side === 'before' ? 0.2 : 0.8)
    y = card.y + card.height * 0.5
  }
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(x + 20, y, { steps: 8 })
  await page.mouse.move(x, y, { steps: 4 })
  await page.mouse.up()
}

/** Drags grid panel `from` to one side of panel `to`, one dispatched step at a time (fixtures/project-screen.ts says why) */
export async function dragGridPanel(page: Page, from: string, to: string, side: 'before' | 'after', view?: Locator) {
  await page.evaluate((id) => {
    const w = window as any
    w.__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="grid-panel-${id}"] [data-testid="pane-header"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true }))
  }, from)
  await expect(page.getByTestId(`grid-panel-${from}`)).toHaveClass(/opacity-40/)
  if (view) await expectCoveredInSight(view, true)
  await page.evaluate(
    ({ to, side }) => {
      const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
      const r = card.getBoundingClientRect()
      const x = side === 'before' ? r.left + r.width * 0.2 : r.left + r.width * 0.8
      card.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: (window as any).__dt,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: r.top + 10,
        }),
      )
    },
    { to, side },
  )
  await expect(page.getByTestId(`grid-panel-${to}`)).toHaveAttribute('data-drop', side)
  await page.evaluate((to) => {
    document
      .querySelector(`[data-testid="grid-panel-${to}"]`)!
      .dispatchEvent(
        new DragEvent('drop', { dataTransfer: (window as any).__dt, bubbles: true, cancelable: true }),
      )
  }, to)
  await page.evaluate((id) => {
    document
      .querySelector(`[data-testid="grid-panel-${id}"] [data-testid="pane-header"]`)!
      .dispatchEvent(new DragEvent('dragend', { dataTransfer: (window as any).__dt, bubbles: true }))
  }, from)
  await expect(page.getByTestId(`grid-panel-${from}`)).not.toHaveClass(/opacity-40/)
  if (view) await expectFrameTakesPointer(page, view)
}

export function gridAppTests(): void {
  test.describe('apps on the grid (#288)', () => {
    let fx: FixtureHost
    test.beforeAll(async () => {
      fx = await startFixtureHost({ 'slider ui://slider/main': { html: fixtureViewHtml() } })
    })
    test.afterAll(async () => {
      await fx?.close()
    })

    test.beforeEach(async ({ page }) => {
      await page.exposeFunction(
        '__viewFrame',
        (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
          fx.views.frame({
            app: { appId, projectId: opts.projectId ?? null },
            instanceId,
            hostOrigin: opts.hostOrigin,
          }),
      )
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
    })

    /** Points the mock's views at the fixture host. Again after a reload: the mock is the page's */
    const useFixtureViews = (page: Page) =>
      page.evaluate(() => {
        const w = window as any
        w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
        w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
      })

    /** A trusted project `alpha` with the slider app in it, and one session; returns the project and the session */
    async function alphaWithSlider(page: Page): Promise<{ pid: string; s: string }> {
      await page.goto('/?mock=1')
      await useFixtureViews(page)
      await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
      await page.getByTestId('add-project').click()
      await page.getByTestId('trust-ask-yes-alpha').click()
      const pid = await page.evaluate(
        () => Object.keys((window as any).__store.getState().projects)[0] as string,
      )
      await setApps(page, [slider(pid)])
      const s = await newSession(page, 'alpha')
      return { pid, s }
    }

    test('an app row dropped on the grid stands there in a view of its own, moves against a session, and leaves with teardown', async ({
      page,
    }) => {
      const { pid, s } = await alphaWithSlider(page)
      const app = `app:${pid}/slider`
      const viewKey = `grid:${pid}/slider`
      await openGrid(page, [])
      await expect(page.getByTestId('grid-empty')).toContainText(
        'Drag sessions and apps here from the sidebar',
      )

      // The app's row, dropped on the empty grid: its panel, with the app's name and status, and its view over it
      await dragRowToGrid(page, page.getByTestId(`app-row-${pid}/slider`), 'padding')
      await expect.poll(() => gridOrder(page)).toEqual([app])
      expect(await stored(page)).toEqual([{ kind: 'app', projectId: pid, appId: 'slider' }])
      const panel = page.getByTestId(`grid-panel-${app}`)
      await expect(panel.getByTestId('app-panel-title')).toHaveText('Slider')
      await expect(panel.getByTestId('app-panel-status')).toHaveText('Stopped')
      const view = page.getByTestId(`pinned-app-${viewKey}`)
      await expect(view).toHaveAttribute('data-mode', 'slot')
      await expect(view.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await expectOverSlot(page, viewKey, page.getByTestId(`grid-slot-${app}`))
      const v = viewOf(page, viewKey)
      await expect(v.locator('li[data-k="tool-result"]')).toHaveText('tool-result {"home":"slider"}')
      // Something done in the view — a reloaded document would lose this line
      await v.locator('#call').click()
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)

      // A session row dropped on the app's panel lands beside it: the panel covers its view while the row is dragged
      await dragRowToGrid(page, page.getByTestId(`session-row-${s}`), { panel: app, side: 'before' })
      await expect.poll(() => gridOrder(page)).toEqual([s, app])
      await expectFrameTakesPointer(page, view)
      await expectOverSlot(page, viewKey, page.getByTestId(`grid-slot-${app}`))

      // The app's panel moves before the session, its view dimmed in sight while dragged; the view follows it in the same document
      await dragGridPanel(page, app, s, 'before', view)
      expect(await gridOrder(page)).toEqual([app, s])
      await expectOverSlot(page, viewKey, page.getByTestId(`grid-slot-${app}`))
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)

      // And the session back before it, with the mouse — onto the app's panel, whose body is a frame not inside it
      const from = (await page.getByTestId(`grid-panel-${s}`).getByTestId('pane-header').boundingBox())!
      const to = (await page.getByTestId(`grid-slot-${app}`).boundingBox())!
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width * 0.25, to.y + to.height / 2, { steps: 8 })
      await page.mouse.move(to.x + to.width * 0.2, to.y + to.height / 2, { steps: 4 })
      await expect(panel).toHaveAttribute('data-drop', 'before')
      // The view stays in sight under its panel's cover (#296)
      await expectCoveredInSight(view)
      await page.mouse.up()
      await expect.poll(() => gridOrder(page)).toEqual([s, app])
      await expectFrameTakesPointer(page, view)
      await expectOverSlot(page, viewKey, page.getByTestId(`grid-slot-${app}`))
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
      expect(await opened(page)).toBe(1)

      // × takes it off the grid and closes its view, teardown first; the session stays
      const instanceId = await instanceOf(page, viewKey)
      await page.getByTestId(`grid-remove-${app}`).click()
      await expect(view).toHaveCount(0)
      await expect.poll(() => teardowns(page)).toBe(1)
      await expect.poll(() => closed(page)).toEqual([instanceId])
      expect(await gridOrder(page)).toEqual([s])
      expect(await stored(page)).toEqual([{ kind: 'session', sessionId: s }])
    })

    test('the same app on the grid and on its project screen at once: one view each, each keeping its document', async ({
      page,
    }) => {
      const { pid } = await alphaWithSlider(page)
      const app = `app:${pid}/slider`
      const gridKey = `grid:${pid}/slider`
      const pinnedKey = `${pid}/slider`
      await page.evaluate(
        (p) =>
          (window as any).__store.getState().setGridPanels([{ kind: 'app', projectId: p, appId: 'slider' }]),
        pid,
      )
      await page.getByTestId('grid-button').click()
      const onGrid = page.getByTestId(`pinned-app-${gridKey}`)
      await expect(onGrid.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await viewOf(page, gridKey).locator('#call').click()
      await expect(viewOf(page, gridKey).locator('li[data-k="call-result"]')).toHaveCount(1)

      // The project screen shows the app in its own pinned view; the grid's is hidden, not unloaded
      await page.getByTestId('project-header-alpha').click()
      const onScreen = page.getByTestId(`pinned-app-${pinnedKey}`)
      await expect(onScreen).toHaveAttribute('data-mode', 'slot')
      await expect(onScreen.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await expectOverSlot(page, pinnedKey, page.getByTestId('project-slot-slider'))
      await expect(onGrid).toHaveAttribute('data-mode', 'hidden')
      await expect(viewOf(page, pinnedKey).locator('li[data-k="call-result"]')).toHaveCount(0)
      expect(await opened(page)).toBe(2)

      // Back on the grid: the same document as before, nothing opened again
      await page.getByTestId('grid-button').click()
      await expect(onGrid).toHaveAttribute('data-mode', 'slot')
      await expectOverSlot(page, gridKey, page.getByTestId(`grid-slot-${app}`))
      await expect(viewOf(page, gridKey).locator('li[data-k="call-result"]')).toHaveCount(1)
      await expect(viewOf(page, gridKey).locator('li[data-k="connected"]')).toHaveCount(1)
      expect(await opened(page)).toBe(2)

      // Taking it off the grid closes the grid's view only; the project screen keeps its own
      const gridInstance = await instanceOf(page, gridKey)
      await page.getByTestId(`grid-remove-${app}`).click()
      await expect.poll(() => closed(page)).toEqual([gridInstance])
      await expect(onGrid).toHaveCount(0)
      await expect(onScreen).toHaveCount(1)
    })

    test('a view on another screen waits out of the window, never display: none or visibility: hidden, and comes back in the same document (#309)', async ({
      page,
    }) => {
      const { pid } = await alphaWithSlider(page)
      const app = `app:${pid}/slider`
      const gridKey = `grid:${pid}/slider`
      const pinnedKey = `${pid}/slider`
      await page.evaluate(
        (p) =>
          (window as any).__store.getState().setGridPanels([{ kind: 'app', projectId: p, appId: 'slider' }]),
        pid,
      )
      await page.getByTestId('grid-button').click()
      const onGrid = page.getByTestId(`pinned-app-${gridKey}`)
      await expect(onGrid.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await viewOf(page, gridKey).locator('#call').click()
      await expect(viewOf(page, gridKey).locator('li[data-k="call-result"]')).toHaveCount(1)

      // The project screen: the grid's view waits out of sight, and the project's view stands in its panel
      await page.getByTestId('project-header-alpha').click()
      await expectOutOfSight(onGrid)
      const pinned = page.getByTestId(`pinned-app-${pinnedKey}`)
      await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')

      // The app view: the grid's view still out of sight; then the grid, where the app view's waits in turn
      await page.getByTestId('project-open-app-slider').click()
      await expect(pinned).toHaveAttribute('data-mode', 'full')
      await expectOutOfSight(onGrid)
      await page.getByTestId('grid-button').click()
      await expectOutOfSight(pinned)

      // Back over its panel, nothing around its frame hidden, and the same document as before
      await expect(onGrid).toHaveAttribute('data-mode', 'slot')
      await expectOverSlot(page, gridKey, page.getByTestId(`grid-slot-${app}`))
      expect(await hiddenAround(onGrid)).toEqual([])
      await expect(onGrid).not.toHaveAttribute('inert')
      await expect(viewOf(page, gridKey).locator('li[data-k="call-result"]')).toHaveCount(1)
      await expect(viewOf(page, gridKey).locator('li[data-k="connected"]')).toHaveCount(1)
    })

    test('an untrusted app and an invalid one say why in their panels instead of a blank frame, and open nothing', async ({
      page,
    }) => {
      await page.goto('/?mock=1')
      await useFixtureViews(page)
      await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
      await page.getByTestId('add-project').click()
      await page.getByTestId('trust-ask-no-alpha').click()
      const pid = await page.evaluate(
        () => Object.keys((window as any).__store.getState().projects)[0] as string,
      )
      await setApps(page, [
        slider(pid, { trusted: false, status: 'untrusted' }),
        slider(null, {
          appId: 'broken',
          name: 'Broken',
          status: 'invalid',
          error: 'centralu.app.json: "home" is not a tool',
        }),
      ])
      await page.evaluate(
        (p) =>
          (window as any).__store.getState().setGridPanels([
            { kind: 'app', projectId: p, appId: 'slider' },
            { kind: 'app', projectId: null, appId: 'broken' },
          ]),
        pid,
      )
      await page.getByTestId('grid-button').click()

      const untrusted = page.getByTestId(`pinned-app-grid:${pid}/slider`)
      await expect(
        page.getByTestId(`grid-panel-app:${pid}/slider`).getByTestId('app-panel-status'),
      ).toHaveText('Not trusted')
      await expect(untrusted.getByTestId('pinned-untrusted')).toContainText(
        "This project isn't trusted, so its apps don't run.",
      )
      await expect(untrusted.getByTestId('pinned-trust')).toBeVisible()
      await expectOverSlot(page, `grid:${pid}/slider`, page.getByTestId(`grid-slot-app:${pid}/slider`))

      const invalid = page.getByTestId('pinned-app-grid:_user/broken')
      await expect(
        page.getByTestId('grid-panel-app:_user/broken').getByTestId('app-panel-status'),
      ).toHaveText('Invalid')
      await expect(invalid.getByTestId('pinned-reason')).toHaveText('centralu.app.json: "home" is not a tool')
      await expect(page.getByTestId('app-frame')).toHaveCount(0)
      expect(await opened(page)).toBe(0)
    })

    test('the grid’s apps and sessions come back after a reload, in the order they were left', async ({
      page,
    }) => {
      // The demo scene grows the same ids on every load, so its sessions and projects are there again after a reload
      await page.goto('/?demo')
      await expect(page.getByTestId('session-view')).toBeVisible()
      await useFixtureViews(page)
      const { pid, sessions } = await page.evaluate(() => {
        const st = (window as any).__store.getState()
        const project = (Object.values(st.projects) as { id: string; name: string }[]).find(
          (p) => p.name === 'centralu',
        )!
        const ids = (Object.values(st.sessions) as { id: string; projectId: string | null }[])
          .filter((x) => x.projectId === project.id)
          .map((x) => x.id)
        return { pid: project.id, sessions: ids }
      })
      const [a, b] = sessions as [string, string]
      await setApps(page, [slider(pid), slider(null, { appId: 'notes', name: 'Notes' })])
      await openGrid(page, [a, b])
      // A user-folder app, from its row under "Your apps", and the project's app between the two sessions
      await dragRowToGrid(page, page.getByTestId('app-row-_user/notes'), { panel: a, side: 'before' })
      await expect.poll(() => gridOrder(page)).toEqual(['app:_user/notes', a, b])
      await dragRowToGrid(page, page.getByTestId(`app-row-${pid}/slider`), { panel: a, side: 'after' })
      const arranged = ['app:_user/notes', a, `app:${pid}/slider`, b]
      await expect.poll(() => gridOrder(page)).toEqual(arranged)

      await page.reload()
      await expect(page.getByTestId('session-view')).toBeVisible()
      await useFixtureViews(page)
      // The app list is the mock's and empty after a reload: until it is read, the apps' panels wait, unshown
      await page.getByTestId('grid-button').click()
      await expect.poll(() => gridOrder(page)).toEqual([a, b])
      await setApps(page, [slider(pid), slider(null, { appId: 'notes', name: 'Notes' })])
      await expect.poll(() => gridOrder(page)).toEqual(arranged)
      const view = page.getByTestId(`pinned-app-grid:${pid}/slider`)
      await expect(view.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await expectOverSlot(page, `grid:${pid}/slider`, page.getByTestId(`grid-slot-app:${pid}/slider`))
    })

    test('an app panel stands on the same surfaces as the session panel beside it, and the sidebar stays apart from the conversation', async ({
      page,
    }) => {
      const { pid, s } = await alphaWithSlider(page)
      const viewKey = `grid:${pid}/slider`
      await page.evaluate(
        ({ p, s }) =>
          (window as any).__store.getState().setGridPanels([
            { kind: 'session', sessionId: s },
            { kind: 'app', projectId: p, appId: 'slider' },
          ]),
        { p: pid, s },
      )
      await page.getByTestId('grid-button').click()
      const view = page.getByTestId(`pinned-app-${viewKey}`)
      await expect(view.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      const conversation = page.getByTestId(`grid-panel-${s}`).getByTestId('session-view')
      const background = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
      const rgb = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number)
      /** The style variables the view was last told: the first context, then whatever each change carried */
      const told = async () => {
        const v = viewOf(page, viewKey)
        const read = (k: string) =>
          v.locator(`li[data-k="${k}"]`).evaluateAll((lis, key) => lis.map((li) => JSON.parse(li.textContent!.slice(key.length + 1))), k)
        const [connected] = await read('connected')
        const contexts = [connected.hostContext, ...(await read('host-context-changed'))]
        return Object.assign({}, ...contexts.map((c) => c.styles?.variables ?? {})) as Record<string, string>
      }

      // Dark and Light by value; the high-contrast presets only have to agree with themselves
      const presets = [
        { id: 'dark', base: 'dark', floor: '#141414', raised: '#1d1d1d' },
        { id: 'light', base: 'light', floor: '#f2f2f2', raised: '#ffffff' },
        { id: 'hc-dark', base: 'dark' },
        { id: 'hc-light', base: 'light' },
      ] as const
      for (const preset of presets) {
        await page.evaluate(
          ({ id, base }) =>
            (window as any).__store
              .getState()
              .setPrefs(base === 'dark' ? { themeMode: 'dark', themeDark: id } : { themeMode: 'light', themeLight: id }),
          preset,
        )
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(preset.id)

        // The conversation's steps are the floor's (#362)...
        const steps = await conversation.evaluate((el) => {
          const cs = getComputedStyle(el)
          const root = getComputedStyle(document.documentElement)
          const t = (s: CSSStyleDeclaration, n: string) => s.getPropertyValue(n).trim()
          return {
            floor: t(cs, '--color-surface-floor'),
            raised: t(cs, '--color-surface-raised'),
            rootFloor: t(root, '--color-surface-floor'),
            rootRaised: t(root, '--color-surface-raised'),
          }
        })
        expect(steps.floor, preset.id).toBe(steps.rootFloor)
        expect(steps.raised, preset.id).toBe(steps.rootRaised)
        if ('floor' in preset) expect([steps.floor, steps.raised], preset.id).toEqual([preset.floor, preset.raised])

        // ...so the two panels' grounds are one colour...
        expect(await background(view), preset.id).toBe(await background(conversation))

        // ...and the view is told the conversation's steps: its ground, and the raised step its cards rest on
        await expect.poll(async () => (await told())['--color-background-primary'], preset.id).toBe(steps.floor)
        expect((await told())['--color-background-secondary'], preset.id).toBe(steps.raised)

        /*
         * With the conversation on the floor, the sidebar must not read as the same colour (the 2026-08 report: three
         * steps apart, a hairline between them): at least six steps, with the hairline still drawn. The high-contrast
         * presets put the sidebar on the floor itself and leave the edge to a 3:1 hairline (fixtures/theme.ts).
         */
        const sidebar = page.getByTestId('sidebar')
        expect(await sidebar.evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe('1px')
        if (preset.id === 'dark' || preset.id === 'light') {
          const [side, floor] = [rgb(await background(sidebar)), rgb(await background(conversation))]
          expect(Math.min(...side.map((v, i) => Math.abs(v - floor[i]!))), `${preset.id}: sidebar ${side} vs conversation ${floor}`).toBeGreaterThanOrEqual(6)
        }
      }
    })

    test('Tab from an app panel’s header reaches its view, and Shift+Tab out of the view comes back to the header', async ({
      page,
    }) => {
      const { pid } = await alphaWithSlider(page)
      const app = `app:${pid}/slider`
      const viewKey = `grid:${pid}/slider`
      await page.evaluate(
        (p) =>
          (window as any).__store.getState().setGridPanels([{ kind: 'app', projectId: p, appId: 'slider' }]),
        pid,
      )
      await page.getByTestId('grid-button').click()
      await expect(page.getByTestId(`pinned-app-${viewKey}`).getByTestId('app-frame')).toHaveAttribute(
        'data-phase',
        'ready',
      )

      const remove = page.getByTestId(`grid-remove-${app}`)
      await remove.focus()
      await page.keyboard.press('Tab')
      // The view is after every panel in the document; the slot hands focus on to its frame
      await expect
        .poll(() =>
          page.evaluate(
            (k) =>
              document.activeElement ===
              document.querySelector(`[data-testid="pinned-app-${k}"] [data-testid="app-frame-iframe"]`),
            viewKey,
          ),
        )
        .toBe(true)
      /*
       * Shift+Tab out of the view lands on the slot, the last thing before the view in the document. Where the engine
       * puts focus inside two nested cross-origin frames first is its own business, so the step that is ours is
       * played directly: focus reaching the slot from inside the view goes on to the header, not back into the view.
       */
      // In the page: Playwright's own focus() goes about it differently while focus is inside a frame
      const after = await page.evaluate((a) => {
        ;(document.querySelector(`[data-testid="grid-slot-${a}"]`) as HTMLElement).focus()
        return document.activeElement?.getAttribute('data-testid')
      }, app)
      expect(after).toBe(`grid-remove-${app}`)
    })
  })
}
