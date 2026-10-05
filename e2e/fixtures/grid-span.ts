import { expect, test, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './app-views.js'
import { dragGridPanel, dragRowToGrid, expectOverSlot, gridOrder, setApps, slider, stored } from './grid-apps.js'

/**
 * An app panel's span on the grid (#306): columns × rows of grid cells, set by the person — for one placement from the
 * panel's top bar, for the app in Settings → Apps — or recommended by the app's manifest (`view.span`, the app list's
 * `span`). Precedence: the placement's choice > the Settings value > the app's recommendation > 1 × 1.
 *
 * The frames are real (the fixture host), as in fixtures/grid-apps.ts, so "the view follows its panel when the panel
 * widens" is measured on the app's own view laid over the slot. A function, run in Chromium (grid-span.spec.ts) and in
 * WebKit (grid-span-webkit.spec.ts): the view is placed by measuring the panel, where the two engines can differ.
 *
 * The window is 1600 wide unless a test says otherwise: the grid's room (1600 less the sidebar) holds three columns
 * of MIN_PANEL_W, so one session and a 2 × 1 app stand side by side in one row.
 */

/** A panel's size on screen */
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!

/** Width of `wide` is `n` cells of `cell`'s width plus the gaps between them (GRID_GAP 8), to within 2px */
async function expectCellsWide(page: Page, wide: string, cell: string, n: number) {
  await expect
    .poll(async () => {
      const w = (await box(page, wide)).width
      const c = (await box(page, cell)).width
      return Math.abs(w - (n * c + (n - 1) * 8)) <= 2
    })
    .toBe(true)
}

/** Picks a span from a span button's picker: opens it, clicks the cell */
async function pickSpan(page: Page, testId: string, cols: number, rows: number) {
  await page.getByTestId(testId).click()
  await page.getByTestId(`${testId}-picker`).getByTestId(`${testId}-cell-${cols}x${rows}`).click()
  await expect(page.getByTestId(`${testId}-picker`)).toHaveCount(0)
}

/** Goes back to the default from a span button's picker */
async function pickDefault(page: Page, testId: string) {
  await page.getByTestId(testId).click()
  await page.getByTestId(`${testId}-default`).click()
  await expect(page.getByTestId(`${testId}-picker`)).toHaveCount(0)
}

export function gridSpanTests(): void {
  test.describe('an app panel’s span on the grid (#306)', () => {
    test.use({ viewport: { width: 1600, height: 900 } })

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
          fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
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

    /**
     * The demo scene (its ids are the same after a reload), the slider app in its `centralu` project with these
     * overrides, and the grid holding `panels` (built from the project id and the scene's first two sessions).
     */
    async function scene(
      page: Page,
      appOverrides: Record<string, unknown>,
      panels: (pid: string, a: string, b: string) => unknown[],
    ): Promise<{ pid: string; a: string; b: string; app: string }> {
      await page.goto('/?demo')
      await expect(page.getByTestId('session-view')).toBeVisible()
      await useFixtureViews(page)
      const { pid, sessions } = await page.evaluate(() => {
        const st = (window as any).__store.getState()
        const project = (Object.values(st.projects) as { id: string; name: string }[]).find((p) => p.name === 'centralu')!
        const ids = (Object.values(st.sessions) as { id: string; projectId: string | null }[])
          .filter((x) => x.projectId === project.id)
          .map((x) => x.id)
        return { pid: project.id, sessions: ids }
      })
      const [a, b] = sessions as [string, string]
      await setApps(page, [slider(pid, appOverrides)])
      await page.evaluate((l) => (window as any).__store.getState().setGridPanels(l), panels(pid, a, b))
      await page.getByTestId('grid-button').click()
      await expect(page.getByTestId('grid')).toBeVisible()
      return { pid, a, b, app: `app:${pid}/slider` }
    }

    test('2×1 from the panel’s top bar widens it to two cells, its view follows, and it is still 2×1 after a reload', async ({
      page,
    }) => {
      const { pid, a, app } = await scene(page, {}, (pid, a) => [
        { kind: 'session', sessionId: a },
        { kind: 'app', projectId: pid, appId: 'slider' },
      ])
      const panel = page.getByTestId(`grid-panel-${app}`)
      const button = page.getByTestId(`grid-span-${app}`)
      const viewKey = `grid:${pid}/slider`
      await expect(panel).toHaveAttribute('data-span', '1x1')
      await expect(button).toHaveText('1×1')
      await expect(button).not.toHaveAttribute('data-chosen')
      await expect(page.getByTestId(`pinned-app-${viewKey}`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')

      await pickSpan(page, `grid-span-${app}`, 2, 1)
      await expect(panel).toHaveAttribute('data-span', '2x1')
      await expect(button).toHaveText('2×1')
      await expect(button).toHaveAttribute('data-chosen', 'true')
      await expectCellsWide(page, `grid-panel-${app}`, `grid-panel-${a}`, 2)
      // One row: the session and the app side by side, the same height
      expect((await box(page, `grid-panel-${app}`)).y).toBeCloseTo((await box(page, `grid-panel-${a}`)).y, 0)
      await expectOverSlot(page, viewKey, page.getByTestId(`grid-slot-${app}`))
      expect(await stored(page)).toEqual([
        { kind: 'session', sessionId: a },
        { kind: 'app', projectId: pid, appId: 'slider', span: { cols: 2, rows: 1 } },
      ])

      await page.reload()
      await expect(page.getByTestId('session-view')).toBeVisible()
      await useFixtureViews(page)
      await page.getByTestId('grid-button').click()
      await setApps(page, [slider(pid)])
      await expect(panel).toHaveAttribute('data-span', '2x1')
      await expect(button).toHaveAttribute('data-chosen', 'true')
      await expectCellsWide(page, `grid-panel-${app}`, `grid-panel-${a}`, 2)
      await expect(page.getByTestId(`pinned-app-${viewKey}`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await expectOverSlot(page, viewKey, page.getByTestId(`grid-slot-${app}`))
    })

    test('the app’s recommendation is the default; the Settings value overrides it and is the default for a new placement; the top bar overrides both', async ({
      page,
    }) => {
      // The app recommends 2 × 1 in its manifest; nobody has chosen anything
      const { pid, a, app } = await scene(page, { span: { cols: 2, rows: 1 } }, (_pid, a) => [{ kind: 'session', sessionId: a }])
      const panel = page.getByTestId(`grid-panel-${app}`)
      const button = page.getByTestId(`grid-span-${app}`)

      // Placed by hand from its sidebar row: it stands at the app's recommendation, and the placement records no span
      await dragRowToGrid(page, page.getByTestId(`app-row-${pid}/slider`), { panel: a, side: 'after' })
      await expect.poll(() => gridOrder(page)).toEqual([a, app])
      await expect(panel).toHaveAttribute('data-span', '2x1')
      await expect(button).not.toHaveAttribute('data-chosen')
      expect(await stored(page)).toEqual([
        { kind: 'session', sessionId: a },
        { kind: 'app', projectId: pid, appId: 'slider' },
      ])
      await page.getByTestId(`grid-remove-${app}`).click()
      await expect.poll(() => gridOrder(page)).toEqual([a])

      // Settings → Apps: the row shows the recommendation as the default, and 1 × 2 set there outranks it
      await page.getByTestId('open-settings').click()
      await page.getByTestId('settings-tab-apps').click()
      const row = page.getByTestId(`external-app-${pid}/slider`)
      await expect(row.getByTestId('external-app-span')).toHaveText('2×1')
      await expect(row.getByTestId('external-app-span')).not.toHaveAttribute('data-chosen')
      await row.getByTestId('external-app-span').click()
      await expect(page.getByTestId('external-app-span-default')).toBeDisabled()
      await expect(page.getByTestId('external-app-span-default')).toHaveText('Use the default: 2 × 1, as the app recommends')
      await page.getByTestId('external-app-span-cell-1x2').click()
      await expect(row.getByTestId('external-app-span')).toHaveText('1×2')
      await expect(row.getByTestId('external-app-span')).toHaveAttribute('data-chosen', 'true')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('settings')).toHaveCount(0)

      // A new placement takes the Settings value, still recording no span of its own
      await dragRowToGrid(page, page.getByTestId(`app-row-${pid}/slider`), { panel: a, side: 'after' })
      await expect.poll(() => gridOrder(page)).toEqual([a, app])
      await expect(panel).toHaveAttribute('data-span', '1x2')
      await expect(button).toHaveText('1×2')
      await expect(button).not.toHaveAttribute('data-chosen')
      expect(await stored(page)).toEqual([
        { kind: 'session', sessionId: a },
        { kind: 'app', projectId: pid, appId: 'slider' },
      ])
      // Two rows: the app spans both, as tall as the session and the empty cell under it together
      const s = await box(page, `grid-panel-${a}`)
      expect(Math.abs((await box(page, `grid-panel-${app}`)).height - (2 * s.height + 8))).toBeLessThanOrEqual(2)

      // The Settings value is kept across a reload (the workspace snapshot)
      await page.reload()
      await expect(page.getByTestId('session-view')).toBeVisible()
      await useFixtureViews(page)
      await page.getByTestId('grid-button').click()
      await setApps(page, [slider(pid, { span: { cols: 2, rows: 1 } })])
      await expect(panel).toHaveAttribute('data-span', '1x2')
      await expect(button).not.toHaveAttribute('data-chosen')

      // The top bar outranks both — and going back to the default there lands on the Settings value, naming it
      await pickSpan(page, `grid-span-${app}`, 2, 2)
      await expect(panel).toHaveAttribute('data-span', '2x2')
      await expect(button).toHaveAttribute('data-chosen', 'true')
      await button.click()
      await expect(page.getByTestId(`grid-span-${app}-default`)).toHaveText('Use the default: 1 × 2, from Settings')
      await page.keyboard.press('Escape')
      await pickDefault(page, `grid-span-${app}`)
      await expect(panel).toHaveAttribute('data-span', '1x2')
      await expect(button).not.toHaveAttribute('data-chosen')

      // And clearing the Settings value leaves the app's recommendation
      await page.getByTestId('open-settings').click()
      await page.getByTestId('settings-tab-apps').click()
      await pickDefault(page, 'external-app-span')
      await expect(row.getByTestId('external-app-span')).toHaveText('2×1')
      await page.keyboard.press('Escape')
      await expect(panel).toHaveAttribute('data-span', '2x1')
    })

    test('a spanning panel still moves by dragging, keeping its span, and the session panels stay one cell', async ({
      page,
    }) => {
      const { pid, a, b, app } = await scene(page, {}, (pid, a, b) => [
        { kind: 'session', sessionId: a },
        { kind: 'session', sessionId: b },
        { kind: 'app', projectId: pid, appId: 'slider', span: { cols: 2, rows: 1 } },
      ])
      const view = page.getByTestId(`pinned-app-grid:${pid}/slider`)
      await expect(view.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      // Two sessions over the 2 × 1 app: two columns, nothing empty
      await expect(page.getByTestId(`grid-panel-${app}`)).toHaveAttribute('data-span', '2x1')
      await expect(page.getByTestId(`grid-panel-${a}`)).toHaveAttribute('data-span', '1x1')
      await expectCellsWide(page, `grid-panel-${app}`, `grid-panel-${a}`, 2)

      await dragGridPanel(page, app, a, 'before', view)
      expect(await gridOrder(page)).toEqual([app, a, b])
      expect(await stored(page)).toEqual([
        { kind: 'app', projectId: pid, appId: 'slider', span: { cols: 2, rows: 1 } },
        { kind: 'session', sessionId: a },
        { kind: 'session', sessionId: b },
      ])
      // The app on top now, still two cells; the sessions under it
      const top = await box(page, `grid-panel-${app}`)
      expect(top.y).toBeLessThan((await box(page, `grid-panel-${a}`)).y)
      await expectCellsWide(page, `grid-panel-${app}`, `grid-panel-${b}`, 2)
      await expectOverSlot(page, `grid:${pid}/slider`, page.getByTestId(`grid-slot-${app}`))

      // And a session moved before it, the other way
      await dragGridPanel(page, b, app, 'before')
      expect(await gridOrder(page)).toEqual([b, app, a])
      await expect(page.getByTestId(`grid-panel-${app}`)).toHaveAttribute('data-span', '2x1')
    })

    test('a span the window cannot hold is clamped, with a hint, and grows back when the window widens', async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 800 })
      const { pid, a, app } = await scene(page, {}, (pid, a) => [
        { kind: 'session', sessionId: a },
        { kind: 'app', projectId: pid, appId: 'slider', span: { cols: 3, rows: 1 } },
      ])
      const panel = page.getByTestId(`grid-panel-${app}`)
      const button = page.getByTestId(`grid-span-${app}`)
      // One column fits: the 3 × 1 stands at one cell, under the session, and its button says so
      await expect(panel).toHaveAttribute('data-span', '1x1')
      await expectCellsWide(page, `grid-panel-${app}`, `grid-panel-${a}`, 1)
      expect((await box(page, `grid-panel-${app}`)).y).toBeGreaterThan((await box(page, `grid-panel-${a}`)).y)
      await expect(button).toHaveText('3×1')
      await expect(button).toHaveAttribute('data-clamped', 'true')
      await expect(button).toHaveAttribute('title', /This window fits 1 × 1, so it stands at that until there is room/)
      await button.click()
      await expect(page.getByTestId(`grid-span-${app}-room`)).toContainText('This window fits up to 1 × 1')
      await page.keyboard.press('Escape')
      // Nothing is lost: both panels stand, and the stored choice is still 3 × 1
      expect(await gridOrder(page)).toEqual([a, app])
      expect(await stored(page)).toContainEqual({ kind: 'app', projectId: pid, appId: 'slider', span: { cols: 3, rows: 1 } })

      // Room for four columns: the session and the app in one row, the app three cells wide, no hint
      await page.setViewportSize({ width: 2000, height: 900 })
      await expect(panel).toHaveAttribute('data-span', '3x1')
      await expect(button).not.toHaveAttribute('data-clamped')
      await expectCellsWide(page, `grid-panel-${app}`, `grid-panel-${a}`, 3)
      await expectOverSlot(page, `grid:${pid}/slider`, page.getByTestId(`grid-slot-${app}`))
    })
  })
}
