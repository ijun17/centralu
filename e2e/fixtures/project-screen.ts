import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './app-views.js'

/**
 * Helpers for the project screen's scenarios (#203), and the app panels' scenario that runs in two engines.
 *
 * Drags are dispatched by hand (a real OS drag cannot be automated), one step per `evaluate`: React commits the
 * `dragstart` state in a microtask, and a `dragover` sent in the same task would still see no drag.
 */

export async function setup(page: Page, projects: string[]) {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  for (const [i, path] of projects.entries()) {
    await page.evaluate((p: string) => ((window as any).__mock.nextPickedDirectory = p), path)
    if (i === 0) {
      await page.getByTestId('orchestrator-pick-folder').click()
      await page.getByTestId('new-session-dialog').waitFor()
      await page.keyboard.press('Escape')
    } else {
      await page.getByTestId('add-project').click()
    }
    await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
  }
}

export async function newSession(page: Page, projectName: string): Promise<string> {
  await page.getByTestId(`project-menu-${projectName}`).click()
  await page.getByTestId(`new-session-${projectName}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  return page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
}

/** The panels on the project screen, in the order they stand */
export const panels = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="project-grid"] [data-testid^="project-panel-"]')].map((el) =>
      el.getAttribute('data-testid')!.slice('project-panel-'.length),
    ),
  )

/** Drags panel `from` to one side of panel `to` and drops it there */
export async function dragPanel(page: Page, from: string, to: string, side: 'before' | 'after') {
  await page.evaluate((id) => {
    const w = window as any
    w.__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="project-panel-${id}"] [data-testid="pane-header"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true }))
  }, from)
  await expect(page.getByTestId(`project-panel-${from}`)).toHaveClass(/opacity-40/)
  await page.evaluate(
    ({ to, side }) => {
      const card = document.querySelector(`[data-testid="project-panel-${to}"]`)!
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
  await expect(page.getByTestId(`project-panel-${to}`)).toHaveAttribute('data-drop', side)
  await page.evaluate((to) => {
    document
      .querySelector(`[data-testid="project-panel-${to}"]`)!
      .dispatchEvent(
        new DragEvent('drop', { dataTransfer: (window as any).__dt, bubbles: true, cancelable: true }),
      )
  }, to)
  await page.evaluate((id) => {
    document
      .querySelector(`[data-testid="project-panel-${id}"] [data-testid="pane-header"]`)!
      .dispatchEvent(new DragEvent('dragend', { dataTransfer: (window as any).__dt, bubbles: true }))
  }, from)
  await expect(page.getByTestId(`project-panel-${from}`)).not.toHaveClass(/opacity-40/)
}

/*
 * An app's panel is its pinned view: one instance, one frame, laid over the panel. The frames are real (the sandbox
 * proxy from the fixture host), as in apps.spec.ts, so "the same document" is something the view itself reports.
 *
 * A function rather than a describe in one file, because it runs twice: in Chromium (project-screen.spec.ts) and in
 * WebKit (project-screen-webkit.spec.ts). The frame is placed over its panel by measuring the panel, and the desktop
 * app is WKWebView — where grid-ring.spec.ts found pixel positions that Chromium never showed.
 */
export function appPanelTests(): void {
  test.describe('app panels', () => {
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
      await page.goto('/?mock=1')
      await page.evaluate(() => {
        const w = window as any
        w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
        w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
      })
    })

    const opened = (page: Page) =>
      page.evaluate(() => ((window as any).__mock.openedViews as unknown[]).length)
    const closed = (page: Page) => page.evaluate(() => (window as any).__mock.closedViews as string[])
    const teardowns = (page: Page) =>
      page.evaluate(
        () =>
          ((window as any).__mock.appToolCalls as { tool: string }[]).filter(
            (c) => c.tool === 'save-on-teardown',
          ).length,
      )
    const viewOf = (page: Page, key: string): FrameLocator =>
      page
        .getByTestId(`pinned-app-${key}`)
        .getByTestId('app-frame-iframe')
        .contentFrame()
        .locator('iframe')
        .contentFrame()

    /** The view stands inside its panel's slot, to within a pixel */
    async function expectOverSlot(page: Page, key: string) {
      const slot = (await page.getByTestId('project-slot-slider').boundingBox())!
      await expect
        .poll(async () => {
          const v = (await page.getByTestId(`pinned-app-${key}`).boundingBox())!
          return [v.x - slot.x, v.y - slot.y, v.width - slot.width, v.height - slot.height].every(
            (d) => Math.abs(d) <= 1,
          )
        })
        .toBe(true)
    }

    test('an app stands on its project screen in its pinned view, moves with its panel, and keeps one instance across screens', async ({
      page,
    }) => {
      await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
      await page.getByTestId('add-project').click()
      await page.getByTestId('trust-ask-yes-alpha').click()
      const pid = await page.evaluate(
        () => Object.keys((window as any).__store.getState().projects)[0] as string,
      )
      await page.evaluate(
        (p) =>
          (window as any).__mock.setExternalApps([
            {
              appId: 'slider',
              projectId: p,
              dir: `/tmp/alpha/.centralu/apps/slider`,
              name: 'Slider',
              version: '0.1.0',
              description: null,
              home: 'home',
              trusted: true,
              status: 'stopped',
              error: null,
              warnings: [],
            },
          ]),
        pid,
      )
      const s = await newSession(page, 'alpha')
      const key = `${pid}/slider`

      await page.getByTestId('project-header-alpha').click()
      expect(await panels(page)).toEqual([`session:${s}`, 'app:slider'])
      const pinned = page.getByTestId(`pinned-app-${key}`)
      await expect(pinned).toHaveAttribute('data-mode', 'slot')
      await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await expectOverSlot(page, key)
      const v = viewOf(page, key)
      await expect(v.locator('li[data-k="tool-result"]')).toHaveText('tool-result {"home":"slider"}')
      // Something done in the view — a reloaded document would lose this line
      await v.locator('#call').click()
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)

      // The panel moves; the view follows it without being taken out of the document
      await dragPanel(page, 'app:slider', `session:${s}`, 'before')
      expect(await panels(page)).toEqual(['app:slider', `session:${s}`])
      await expectOverSlot(page, key)
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)

      /*
       * And back, with the mouse this time: the target is the app's panel, whose body is covered by a frame that is
       * not inside it. The hand has to reach the panel through the frame, so this one cannot be dispatched by hand.
       */
      const from = (await page
        .getByTestId(`project-panel-session:${s}`)
        .getByTestId('pane-header')
        .boundingBox())!
      const to = (await page.getByTestId('project-slot-slider').boundingBox())!
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width * 0.25, to.y + to.height / 2, { steps: 8 })
      await page.mouse.move(to.x + to.width * 0.2, to.y + to.height / 2, { steps: 4 })
      await expect(page.getByTestId('project-panel-app:slider')).toHaveAttribute('data-drop', 'before')
      await page.mouse.up()
      await expect.poll(() => panels(page)).toEqual([`session:${s}`, 'app:slider'])
      await expectOverSlot(page, key)
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)

      // Open: the app view shows the same instance, full size, with its header
      await page.getByTestId('project-open-app-slider').click()
      await expect(pinned).toHaveAttribute('data-mode', 'full')
      await expect(pinned.getByTestId('pinned-title')).toHaveText('Slider')
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
      // × goes back to the project screen, where the app is a panel: it leaves, and the view is not torn down
      await expect(pinned.getByTestId('pinned-close')).toHaveAttribute('aria-label', /^Back to alpha/)
      await pinned.getByTestId('pinned-close').click()
      await expect(pinned).toHaveAttribute('data-mode', 'slot')
      await expectOverSlot(page, key)
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
      expect(await teardowns(page)).toBe(0)
      await page.getByTestId('project-open-app-slider').click()
      await expect(pinned).toHaveAttribute('data-mode', 'full')
      // A session and back to the project screen: still the one document
      await page.getByTestId(`session-row-${s}`).click()
      await expect(pinned).toBeHidden()
      await page.getByTestId('project-header-alpha').click()
      await expect(pinned).toHaveAttribute('data-mode', 'slot')
      await expectOverSlot(page, key)
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
      await expect(v.locator('li[data-k="connected"]')).toHaveCount(1)
      expect(await opened(page)).toBe(1)

      // Under the text scale the slot is measured in zoomed pixels and the view placed in CSS pixels (slots.ts)
      await page.evaluate(() => (window as any).__store.getState().setTextScale(4))
      await expectOverSlot(page, key)
      await page.evaluate(() => (window as any).__store.getState().setTextScale(2))

      // Hiding the panel closes the view, teardown first
      const instanceId = await page.evaluate(
        () => (window as any).__store.getState().pinnedViews[0].instanceId as string,
      )
      await page.getByTestId('project-hide-app:slider').click()
      await expect(pinned).toHaveCount(0)
      await expect.poll(() => teardowns(page)).toBe(1)
      await expect.poll(() => closed(page)).toEqual([instanceId])
      expect(await panels(page)).toEqual([`session:${s}`])
    })
  })
}
