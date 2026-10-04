import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './app-views.js'

/**
 * Helpers for the project screen's scenarios (#203), and the scenarios that run in two engines.
 *
 * A panel drag is dispatched by hand, one step per `evaluate`: React commits the `dragstart` state in a microtask,
 * and a `dragover` sent in the same task would still see no drag. A sidebar row is dragged with the mouse instead
 * (`dragRow`): whether the screen refuses it is the browser's answer to the dragover — a drop cursor or none, a drop
 * or none — and only a drag the browser runs itself asks that question.
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

/**
 * An app's view while something is dragged (#296): still in sight — not `visibility: hidden`, not `display: none`, not
 * squeezed to nothing — with its panel's transparent cover over it (dragShield.tsx), so the drag lands on the page and
 * not in the frame. `dimmed` for the view of the panel being dragged.
 */
export async function expectCoveredInSight(view: Locator, dimmed = false) {
  await expect(view).toHaveCSS('visibility', 'visible')
  await expect(view).not.toHaveCSS('display', 'none')
  await expect
    .poll(async () => {
      const box = await view.boundingBox()
      return !!box && box.width > 0 && box.height > 0
    })
    .toBe(true)
  const shield = view.getByTestId('app-drag-shield')
  await expect(shield).toHaveCount(1)
  if (dimmed) await expect(shield).toHaveAttribute('data-dimmed', 'true')
  else await expect(shield).not.toHaveAttribute('data-dimmed')
}

/**
 * After the drop: no cover left anywhere, and the view's frame takes the pointer again — the element under the middle
 * of the view is its frame.
 */
export async function expectFrameTakesPointer(page: Page, view: Locator) {
  await expect(page.getByTestId('app-drag-shield')).toHaveCount(0)
  await expect
    .poll(() =>
      view.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return hit === el.querySelector('[data-testid="app-frame-iframe"]')
      }),
    )
    .toBe(true)
}

/**
 * What hides an app's view, from its frame (or the view itself, when it shows a notice instead) up to the root: every
 * element with `display: none` or `visibility: hidden` on the way. In WKWebView a frame hidden either way and shown
 * again stops drawing the native scrollbars inside the app's document (PinnedApps' OUT_OF_SIGHT), so a view must
 * come back to an empty list. Playwright's WebKit forces overlay scrollbars, so the paint itself cannot be read here.
 */
export const hiddenAround = (view: Locator) =>
  view.evaluate((el) => {
    const found: string[] = []
    for (let n: Element | null = el.querySelector('iframe') ?? el; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden')
        found.push(`${n.tagName.toLowerCase()}[data-testid="${n.getAttribute('data-testid')}"] ${cs.display} ${cs.visibility}`)
    }
    return found
  })

/**
 * A view hidden while another screen is looked at: out of the window, `inert` so nothing reaches it, and still not
 * hidden by `display` or `visibility` on anything around its frame (see `hiddenAround`).
 */
export async function expectOutOfSight(view: Locator) {
  await expect(view).toHaveAttribute('data-mode', 'hidden')
  await expect(view).not.toBeInViewport()
  expect(await view.evaluate((el) => (el as HTMLElement).inert)).toBe(true)
  expect(await hiddenAround(view)).toEqual([])
}

/**
 * Drags panel `from` to one side of panel `to` and drops it there. `view` is the app view laid over `from` when it
 * is an app's panel: the view is not inside the panel; it stays in sight, dimmed under its panel's cover, while it is
 * dragged (dragShield.tsx).
 */
export async function dragPanel(page: Page, from: string, to: string, side: 'before' | 'after', view?: Locator) {
  await page.evaluate((id) => {
    const w = window as any
    w.__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="project-panel-${id}"] [data-testid="pane-header"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true }))
  }, from)
  await expect(page.getByTestId(`project-panel-${from}`)).toHaveClass(/opacity-40/)
  if (view) await expectCoveredInSight(view, true)
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
  if (view) await expectFrameTakesPointer(page, view)
}

/** Where a sidebar row is dropped: one half of a panel, or the screen's own padding (the empty screen's middle) */
export type RowTarget = { panel: string; side: 'before' | 'after' } | 'padding'

/** Drags a sidebar row (or the orchestrator's) onto the project screen with the mouse, and lets go */
export async function dragRow(page: Page, row: Locator, to: RowTarget) {
  const from = (await row.boundingBox())!
  let x: number
  let y: number
  if (to === 'padding') {
    const grid = (await page.getByTestId('project-grid').boundingBox())!
    const empty = await page.getByTestId('project-empty').count()
    // The empty screen's middle, or the strip of padding under the panels
    x = grid.x + grid.width / 2
    y = empty ? grid.y + grid.height / 2 : grid.y + grid.height - 3
  } else {
    const card = (await page.getByTestId(`project-panel-${to.panel}`).boundingBox())!
    x = card.x + card.width * (to.side === 'before' ? 0.2 : 0.8)
    y = card.y + card.height * 0.4
  }
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(x + 20, y, { steps: 8 })
  await page.mouse.move(x, y, { steps: 4 })
  await page.mouse.up()
}

/**
 * Records what the last dragover over the project screen answered (`dropEffect`: 'none' is no drop cursor) and how
 * many drops reached the screen.
 *
 * Listened for on React's root, after React's own listener there: the page's handlers have all run by then, and one
 * that stopped the event (a panel taking a drop) stops it from reaching the window, not the root's other listeners.
 */
export async function watchDrags(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__drags = { effect: null, drops: 0 }
    const onScreen = (e: Event) => !!(e.target as Element | null)?.closest?.('[data-testid="project-view"]')
    if (w.__dragWatch) return
    w.__dragWatch = true
    const root = document.getElementById('root')!
    root.addEventListener('dragover', (e) => {
      if (onScreen(e)) w.__drags.effect = e.dataTransfer?.dropEffect ?? null
    })
    root.addEventListener('drop', (e) => {
      if (onScreen(e)) w.__drags.drops++
    })
  })
}

export const seenDrags = (page: Page) =>
  page.evaluate(() => (window as any).__drags as { effect: string | null; drops: number })

/** What the project screen remembers for a project (the store's `projectPanels`) */
export const arrangement = (page: Page, projectId: string) =>
  page.evaluate(
    (p) => (window as any).__store.getState().projectPanels[p] as { order: string[]; hidden: string[] } | undefined,
    projectId,
  )

const projectIdOf = (page: Page, name: string) =>
  page.evaluate(
    (n) =>
      (Object.values((window as any).__store.getState().projects) as { id: string; name: string }[]).find(
        (p) => p.name === n,
      )!.id,
    name,
  )

const gridPanels = (page: Page) => page.evaluate(() => (window as any).__store.getState().gridPanels.map((p: any) => p.sessionId) as string[])

/**
 * Sidebar rows dropped on the project screen, the way sessions are dropped on the grid — only this project's.
 *
 * A function, like `appPanelTests`, because it runs in Chromium and in WebKit: the desktop app is WKWebView, and
 * what a refused dragover means (no drop cursor, no drop) is the engine's to decide.
 */
export function sidebarDropTests(): void {
  test.describe('sidebar rows dropped on the project screen', () => {
    test('with every panel hidden the screen asks for the project’s rows, and a hidden session dropped on it comes back', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'alpha')
      await page.getByTestId('project-header-alpha').click()
      await page.getByTestId(`project-hide-session:${a}`).click()
      await page.getByTestId(`project-hide-session:${b}`).click()

      const empty = page.getByTestId('project-empty')
      await expect(empty).toContainText("Drag this project's sessions and apps here from the sidebar")
      await expect(empty).toContainText('They keep running — this is another way to look at them')
      await expect(empty).not.toContainText('evidence panel')
      await expect(empty).not.toContainText('Every panel is hidden')

      await dragRow(page, page.getByTestId(`session-row-${b}`), 'padding')
      await expect.poll(() => panels(page)).toEqual([`session:${b}`])
      // The other stays hidden, still named above; the grid is not touched
      await expect(page.getByTestId(`project-show-session:${a}`)).toBeVisible()
      expect(await gridPanels(page)).toEqual([])
    })

    test('a row dropped on a panel stands before or after it, and one already on the screen moves there', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'alpha')
      const c = await newSession(page, 'alpha')
      const pid = await projectIdOf(page, 'alpha')
      await page.getByTestId('project-header-alpha').click()
      await page.getByTestId(`project-hide-session:${c}`).click()
      expect(await panels(page)).toEqual([`session:${a}`, `session:${b}`])

      await dragRow(page, page.getByTestId(`session-row-${c}`), { panel: `session:${a}`, side: 'before' })
      await expect.poll(() => panels(page)).toEqual([`session:${c}`, `session:${a}`, `session:${b}`])

      await dragRow(page, page.getByTestId(`session-row-${c}`), { panel: `session:${b}`, side: 'after' })
      await expect.poll(() => panels(page)).toEqual([`session:${a}`, `session:${b}`, `session:${c}`])

      // Remembered through the screen's own arrangement; the grid keeps its own list
      expect(await arrangement(page, pid)).toEqual({
        order: [`session:${a}`, `session:${b}`, `session:${c}`],
        hidden: [],
      })
      expect(await gridPanels(page)).toEqual([])
    })

    test('a row that passed over a panel and was let go elsewhere leaves nothing for the next panel drag to preview', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'alpha')
      await page.getByTestId('project-header-alpha').click()
      expect(await panels(page)).toEqual([`session:${a}`, `session:${b}`])

      // By hand, so the row can end without a drop anywhere (Escape, or let go outside the window)
      const rowEvent = (type: 'dragstart' | 'dragend') =>
        page.evaluate(
          ({ id, type }) => {
            const w = window as any
            if (type === 'dragstart') w.__dt = new DataTransfer()
            document
              .querySelector(`[data-testid="session-row-${id}"]`)!
              .closest('li')!
              .dispatchEvent(new DragEvent(type, { dataTransfer: w.__dt, bubbles: true }))
          },
          { id: b, type },
        )
      await rowEvent('dragstart')
      await page.evaluate((to) => {
        const card = document.querySelector(`[data-testid="project-panel-${to}"]`)!
        const r = card.getBoundingClientRect()
        card.dispatchEvent(
          new DragEvent('dragover', {
            dataTransfer: (window as any).__dt,
            bubbles: true,
            cancelable: true,
            clientX: r.left + r.width * 0.2,
            clientY: r.top + 10,
          }),
        )
      }, `session:${a}`)
      await expect(page.getByTestId(`project-panel-session:${a}`)).toHaveAttribute('data-drop', 'before')
      await rowEvent('dragend')
      await expect(page.getByTestId(`project-panel-session:${a}`)).not.toHaveAttribute('data-drop')

      // A panel picked up next stands where it is until the hand moves it
      await page.evaluate((id) => {
        document
          .querySelector(`[data-testid="project-panel-${id}"] [data-testid="pane-header"]`)!
          .dispatchEvent(new DragEvent('dragstart', { dataTransfer: new DataTransfer(), bubbles: true }))
      }, `session:${b}`)
      await expect(page.getByTestId(`project-panel-session:${b}`)).toHaveClass(/opacity-40/)
      expect(await panels(page)).toEqual([`session:${a}`, `session:${b}`])
    })

    test('another project’s session and the orchestrator are refused while dragged, and a drop that comes anyway changes nothing', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha', '/tmp/beta'])
      const a = await newSession(page, 'alpha')
      const hidden = await newSession(page, 'alpha')
      const other = await newSession(page, 'beta')
      await page.evaluate(async () => {
        const st = (window as any).__store.getState()
        await st.openOrchestrator()
        await st.askOrchestrator('hello')
      })
      await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('draggable', 'true')
      const pid = await projectIdOf(page, 'alpha')
      await page.getByTestId('project-header-alpha').click()
      await page.getByTestId(`project-hide-session:${hidden}`).click()
      const before = await arrangement(page, pid)
      expect(await panels(page)).toEqual([`session:${a}`])
      await watchDrags(page)

      await dragRow(page, page.getByTestId(`session-row-${other}`), { panel: `session:${a}`, side: 'before' })
      expect(await seenDrags(page)).toEqual({ effect: 'none', drops: 0 })
      await dragRow(page, page.getByTestId('orchestrator-button'), 'padding')
      expect(await seenDrags(page)).toEqual({ effect: 'none', drops: 0 })
      expect(await panels(page)).toEqual([`session:${a}`])

      // A drop the dragover did not let in — one fired by a script — is ignored all the same
      await page.evaluate(
        ({ id, on }) => {
          const dt = new DataTransfer()
          dt.setData('application/x-cc-session', id)
          const card = document.querySelector(`[data-testid="project-panel-session:${on}"]`)!
          const r = card.getBoundingClientRect()
          card.dispatchEvent(
            new DragEvent('drop', {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
              clientX: r.left + r.width * 0.2,
              clientY: r.top + 10,
            }),
          )
        },
        { id: other, on: a },
      )
      expect(await panels(page)).toEqual([`session:${a}`])
      expect(await arrangement(page, pid)).toEqual(before)

      // This project's own row gets the drop cursor and is dropped, with the same hand
      await watchDrags(page)
      await dragRow(page, page.getByTestId(`session-row-${hidden}`), { panel: `session:${a}`, side: 'after' })
      await expect.poll(() => panels(page)).toEqual([`session:${a}`, `session:${hidden}`])
      expect(await seenDrags(page)).toEqual({ effect: 'move', drops: 1 })
    })
  })
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

      // The panel moves, its view dimmed in sight while it is dragged; the view follows it without being taken out of the document
      await dragPanel(page, 'app:slider', `session:${s}`, 'before', pinned)
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
      await expectOutOfSight(pinned)
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

    test('a hidden app comes back where its sidebar row is dropped, a row dropped on an app’s view lands beside it, and another project’s app of the same name is refused', async ({
      page,
    }) => {
      await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
      await page.getByTestId('add-project').click()
      await page.getByTestId('trust-ask-yes-alpha').click()
      await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/beta'))
      await page.getByTestId('add-project').click()
      await expect(page.getByTestId('project-beta')).toBeVisible()
      const pid = await projectIdOf(page, 'alpha')
      const other = await projectIdOf(page, 'beta')
      await page.evaluate(
        (projects) =>
          (window as any).__mock.setExternalApps(
            projects.map(([projectId, dir]) => ({
              appId: 'slider',
              projectId,
              dir: `${dir}/.centralu/apps/slider`,
              name: 'Slider',
              version: '0.1.0',
              description: null,
              home: 'home',
              trusted: true,
              status: 'stopped',
              error: null,
              warnings: [],
            })),
          ),
        [
          [pid, '/tmp/alpha'],
          [other, '/tmp/beta'],
        ],
      )
      const s = await newSession(page, 'alpha')
      const key = `${pid}/slider`
      const pinned = page.getByTestId(`pinned-app-${key}`)

      await page.getByTestId('project-header-alpha').click()
      expect(await panels(page)).toEqual([`session:${s}`, 'app:slider'])
      await page.getByTestId('project-hide-app:slider').click()
      await expect(pinned).toHaveCount(0)
      expect(await panels(page)).toEqual([`session:${s}`])

      // Beta's slider is another app with the same id: refused while dragged, like another project's session
      await watchDrags(page)
      await dragRow(page, page.getByTestId(`app-row-${other}/slider`), { panel: `session:${s}`, side: 'before' })
      expect(await seenDrags(page)).toEqual({ effect: 'none', drops: 0 })
      expect(await panels(page)).toEqual([`session:${s}`])

      // Alpha's own comes back where it is dropped, in its pinned view
      await dragRow(page, page.getByTestId(`app-row-${key}`), { panel: `session:${s}`, side: 'before' })
      await expect.poll(() => panels(page)).toEqual(['app:slider', `session:${s}`])
      await expect(pinned).toHaveAttribute('data-mode', 'slot')
      await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await expectOverSlot(page, key)

      /*
       * A row dropped on the app's panel lands on its view, a frame laid over the panel and not inside it. For the
       * drop to reach the panel, the panel covers the view while the row is dragged (dragShield.tsx) — and the frame
       * takes the pointer again after, the same document, with what was done in it.
       */
      const v = viewOf(page, key)
      await v.locator('#call').click()
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
      await page.getByTestId(`project-hide-session:${s}`).click()
      expect(await panels(page)).toEqual(['app:slider'])
      await dragRow(page, page.getByTestId(`session-row-${s}`), { panel: 'app:slider', side: 'before' })
      await expect.poll(() => panels(page)).toEqual([`session:${s}`, 'app:slider'])
      await expectFrameTakesPointer(page, pinned)
      await expectOverSlot(page, key)
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
      expect(await opened(page)).toBe(2)
      expect(await gridPanels(page)).toEqual([])
    })

    /*
     * #288: a session's panel carried into an app's panel from the side, not through its header. In WebKit the frame
     * took the drag whatever its pointer-events said, so the page heard nothing more and the panel could not land
     * there. The panel covers its view for the length of the drag (dragShield.tsx) — and, since #296, the view stays
     * in sight under the cover instead of being hidden.
     */
    test('a session panel carried sideways into an app’s view lands beside the app, the view in sight all along', async ({
      page,
    }) => {
      await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
      await page.getByTestId('add-project').click()
      await page.getByTestId('trust-ask-yes-alpha').click()
      const pid = await projectIdOf(page, 'alpha')
      await page.evaluate(
        (p) =>
          (window as any).__mock.setExternalApps([
            {
              appId: 'slider',
              projectId: p,
              dir: '/tmp/alpha/.centralu/apps/slider',
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
      const pinned = page.getByTestId(`pinned-app-${key}`)
      await page.getByTestId('project-header-alpha').click()
      expect(await panels(page)).toEqual([`session:${s}`, 'app:slider'])
      await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      const v = viewOf(page, key)
      await v.locator('#call').click()
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)

      // Down the session's own panel first, then across into the app's view: the hand never touches the app's header
      const from = (await page.getByTestId(`project-panel-session:${s}`).getByTestId('pane-header').boundingBox())!
      const to = (await page.getByTestId('project-slot-slider').boundingBox())!
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 6 })
      await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 8 })
      await expect(page.getByTestId('project-panel-app:slider')).toHaveAttribute('data-drop', 'after')
      await expectCoveredInSight(pinned)
      await page.mouse.up()
      await expect.poll(() => panels(page)).toEqual(['app:slider', `session:${s}`])
      await expectFrameTakesPointer(page, pinned)
      await expectOverSlot(page, key)
      await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
      expect(await opened(page)).toBe(1)

      // The keyboard reaches the view from its panel's header, as it reaches a session panel's conversation (#288)
      await page.getByTestId('project-hide-app:slider').focus()
      await page.keyboard.press('Tab')
      await expect
        .poll(() =>
          page.evaluate(
            (k) =>
              document.activeElement ===
              document.querySelector(`[data-testid="pinned-app-${k}"] [data-testid="app-frame-iframe"]`),
            key,
          ),
        )
        .toBe(true)
    })
  })
}
