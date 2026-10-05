import { expect, test, type Locator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './app-views.js'
import { openGrid, setApps, slider } from './grid-apps.js'
import { newSession } from './project-screen.js'

/**
 * "Show the conversation" under an app's view must show the builder's conversation wherever the view stands (#375).
 *
 * The builder's conversation opens beside the view in the app's own page (BuilderPane). A view laid over a panel — on
 * the grid or on the project screen — has no room for that pane, so the link goes to the app's page with the pane
 * open, through the same `openApp` the panel's Open uses. Before the fix the link only set the slotted view's own
 * "builder open" flag, which nothing in a slot draws, so the click did nothing.
 *
 * A function rather than a describe in one file, because it runs twice: in Chromium (builder-link.spec.ts) and in
 * WebKit (builder-link-webkit.spec.ts) — the desktop app is WKWebView, and a slotted view is laid over its panel by
 * measuring it.
 */
export function builderLinkTests(): void {
  test.describe('"Show the conversation" reaches the builder from every place a view stands', () => {
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
      await page.goto('/?mock=1')
      await page.evaluate(() => {
        const w = window as any
        w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
        w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
      })
    })

    /** A trusted project `alpha` with the slider app, its builder session, and one other session */
    async function alphaWithBuilder(page: Page): Promise<{ pid: string; s: string; builderId: string }> {
      await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
      await page.getByTestId('add-project').click()
      await page.getByTestId('trust-ask-yes-alpha').click()
      const pid = await page.evaluate(() => Object.keys((window as any).__store.getState().projects)[0] as string)
      await setApps(page, [slider(pid)])
      const builderId = await page.evaluate(
        async (p) => ((await (window as any).__mock.apps.createBuilder('slider', p, 'claude')) as { id: string }).id,
        pid,
      )
      const s = await newSession(page, 'alpha')
      return { pid, s, builderId }
    }

    /** Sends a request through the fix bar under this view, and waits for the "sent" line */
    async function askBuilder(view: Locator, text: string) {
      await expect(view.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      const input = view.getByTestId('fix-bar-input')
      await input.fill(text)
      await input.press('Enter')
      await expect(view.getByTestId('fix-bar-sent')).toContainText('Sent to Slider · builder.')
    }

    /** The app's own page is on screen, with the builder's conversation open beside its view, showing what was said */
    async function expectBuilderBesideAppPage(page: Page, pid: string, said: string) {
      const page_ = page.getByTestId(`pinned-app-${pid}/slider`)
      await expect(page_).toHaveAttribute('data-mode', 'full')
      const pane = page_.getByTestId('builder-pane')
      await expect(pane).toBeVisible()
      await expect(page_.getByTestId('pinned-builder-toggle')).toHaveAttribute('aria-pressed', 'true')
      await expect(pane.getByTestId('session-name')).toHaveText('Slider · builder')
      await expect(pane.getByTestId('msg-user').filter({ hasText: said })).toBeVisible()
      await expect(page_.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    }

    test('in the app’s own page the conversation opens beside the view', async ({ page }) => {
      const { pid } = await alphaWithBuilder(page)
      await page.getByTestId(`app-row-${pid}/slider`).click()
      const view = page.getByTestId(`pinned-app-${pid}/slider`)
      await askBuilder(view, 'The slider jumps back')
      await view.getByTestId('fix-bar-show-builder').click()
      await expectBuilderBesideAppPage(page, pid, 'The slider jumps back')
    })

    test('in a grid panel, too narrow for the pane, it goes to the app’s page with the conversation open', async ({ page }) => {
      const { pid, s } = await alphaWithBuilder(page)
      await openGrid(page, [s])
      await page.evaluate(
        ({ p, sid }) =>
          (window as any).__store.getState().setGridPanels([
            { kind: 'session', sessionId: sid },
            { kind: 'app', projectId: p, appId: 'slider' },
          ]),
        { p: pid, sid: s },
      )
      const view = page.getByTestId(`pinned-app-grid:${pid}/slider`)
      await expect(view).toHaveAttribute('data-mode', 'slot')
      await askBuilder(view, 'The slider jumps back')
      await view.getByTestId('fix-bar-show-builder').click()

      await expect(page.getByTestId('grid')).toHaveCount(0)
      expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('app')
      await expectBuilderBesideAppPage(page, pid, 'The slider jumps back')
      // The grid's own view waits out of sight, as when leaving the grid any other way
      await expect(view).toHaveAttribute('data-mode', 'hidden')
    })

    test('in a grid panel, the error tail’s Show goes to the app’s page with the conversation open', async ({ page }) => {
      const { pid, s } = await alphaWithBuilder(page)
      await openGrid(page, [s])
      await page.evaluate(
        (p) => (window as any).__store.getState().setGridPanels([{ kind: 'app', projectId: p, appId: 'slider' }]),
        pid,
      )
      const view = page.getByTestId(`pinned-app-grid:${pid}/slider`)
      await expect(view.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      // The app dies: the host holds the bundle, and the list changes along with the reason
      await page.evaluate(
        (key) =>
          (window as any).__mock.appErrors.set(key, [
            {
              kind: 'crash', at: Date.now(), message: 'exited (code 7)', stderr: ['boom'], tool: null, args: null, runId: null,
              text: 'App Slider (alpha/slider): the app\'s process ended\nReason: exited (code 7)\nstderr (last lines):\nboom',
            },
          ]),
        `${pid}/slider`,
      )
      await setApps(page, [slider(pid, { status: 'crashed', error: 'exited (code 7)' })])
      const tail = view.getByTestId('error-tail')
      await tail.getByTestId('error-tail-send').click()
      await expect(tail.getByTestId('error-tail-sent')).toContainText('Sent to the builder.')
      await tail.getByTestId('error-tail-show-builder').click()

      expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('app')
      await expectBuilderBesideAppPage(page, pid, 'error report')
    })

    test('on the project screen it goes to the app’s page with the conversation open, in the same view, and × comes back', async ({
      page,
    }) => {
      const { pid } = await alphaWithBuilder(page)
      await page.getByTestId('project-header-alpha').click()
      const view = page.getByTestId(`pinned-app-${pid}/slider`)
      await expect(view).toHaveAttribute('data-mode', 'slot')
      await expect(view.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      const instance = await page.evaluate(
        (k) => ((window as any).__store.getState().pinnedViews as { key: string; instanceId: string }[]).find((p) => p.key === k)!.instanceId,
        `${pid}/slider`,
      )
      await askBuilder(view, 'The slider jumps back')
      await view.getByTestId('fix-bar-show-builder').click()

      expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('app')
      await expectBuilderBesideAppPage(page, pid, 'The slider jumps back')
      // The project screen's view is the app page's view: the same instance, not a second one
      expect(
        await page.evaluate(
          (k) => ((window as any).__store.getState().pinnedViews as { key: string; instanceId: string }[]).find((p) => p.key === k)!.instanceId,
          `${pid}/slider`,
        ),
      ).toBe(instance)
      await view.getByTestId('pinned-close').click()
      await expect(view).toHaveAttribute('data-mode', 'slot')
      await expect(view.getByTestId('builder-pane')).toHaveCount(0)
    })
  })
}
