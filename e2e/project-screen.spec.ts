import { expect, test } from '@playwright/test'
import { addSessionPanels, appPanelTests, dragRow, dragPanel, newSession, panels, setup, sidebarDropTests } from './fixtures/project-screen.js'
import { columnsThrough } from './fixtures/columns.js'

/**
 * The project screen (#203): clicking a project's name opens an explicit list of panels that move like the
 * grid's. Panels are added by dragging sidebar rows, and membership and order are remembered. The helpers, the app panels'
 * scenarios and the sidebar drops live in fixtures/project-screen.ts, which project-screen-webkit.spec.ts runs again
 * in WebKit.
 */
test('an untouched project starts empty, sidebar dragging adds its sessions, and new sessions never appear automatically', async ({
  page,
}) => {
  await setup(page, ['/tmp/alpha', '/tmp/beta'])
  const a = await newSession(page, 'alpha')
  const b = await newSession(page, 'alpha')
  const other = await newSession(page, 'beta')

  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view-name')).toHaveText('alpha')
  expect(await panels(page)).toEqual([])
  await expect(page.getByTestId('project-empty')).toContainText("Drag this project's sessions and apps here from the sidebar")
  await expect(page.getByTestId('project-empty-new-session')).toHaveCount(0)
  await addSessionPanels(page, [a, b])
  expect(await panels(page)).toEqual([`session:${a}`, `session:${b}`])
  await expect(page.getByTestId(`project-panel-session:${other}`)).toHaveCount(0)
  // A panel is the focus view's pane, not a picture of it — the composer is there to type into
  await expect(page.getByTestId(`project-panel-session:${b}`).getByTestId('prompt-input')).toBeVisible()
  // The evidence panel stays: this screen is one project, so there is one repository to show
  await expect(page.getByTestId('evidence-panel')).toBeVisible()

  await dragPanel(page, `session:${b}`, `session:${a}`, 'before')
  expect(await panels(page)).toEqual([`session:${b}`, `session:${a}`])

  // A session's panel carries the session too: dropped on the Grid button it goes onto the grid and opens it, like a sidebar row
  await page.evaluate((id) => {
    const dt = new DataTransfer()
    const header = document.querySelector(`[data-testid="project-panel-${id}"] [data-testid="pane-header"]`)!
    header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
    const button = document.querySelector('[data-testid="grid-button"]')!
    button.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    button.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    header.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
  }, `session:${a}`)
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().gridPanels.map((p: any) => p.sessionId))).toEqual([a])
  await expect(page.getByTestId(`grid-panel-${a}`)).toBeVisible()
  await page.getByTestId('project-header-alpha').click()
  expect(await panels(page)).toEqual([`session:${b}`, `session:${a}`])

  const c = await newSession(page, 'alpha')
  await page.getByTestId('project-header-alpha').click()
  expect(await panels(page)).toEqual([`session:${b}`, `session:${a}`])
  await expect(page.getByTestId(`session-row-${c}`)).toBeVisible()
  await dragRow(page, page.getByTestId(`session-row-${c}`), 'padding')
  expect(await panels(page)).toEqual([`session:${b}`, `session:${a}`, `session:${c}`])
})

test('a panel let go before its preview has shown still lands on the half it was let go over, as on the grid (#509)', async ({
  page,
}) => {
  // React renders a dragover's update in a later task, so a quick release can drop before the preview of that last
  // dragover is on the screen. Here the dragover and the drop go in one task, so nothing renders between them.
  await setup(page, ['/tmp/alpha'])
  const a = await newSession(page, 'alpha')
  const b = await newSession(page, 'alpha')
  await page.getByTestId('project-header-alpha').click()
  await addSessionPanels(page, [a, b])
  expect(await panels(page)).toEqual([`session:${a}`, `session:${b}`])

  await page.evaluate((id) => {
    ;(window as any).__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="project-panel-${id}"] [data-testid="pane-header"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: (window as any).__dt, bubbles: true }))
  }, `session:${a}`)
  await expect(page.getByTestId(`project-panel-session:${a}`)).toHaveClass(/opacity-40/)
  const previewAtDrop = await page.evaluate((to) => {
    const dt = (window as any).__dt as DataTransfer
    const card = document.querySelector(`[data-testid="project-panel-${to}"]`)!
    const r = card.getBoundingClientRect()
    const at = { clientX: r.left + r.width * 0.8, clientY: r.top + r.height / 2 }
    card.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, ...at }))
    const shown = card.getAttribute('data-drop')
    card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, ...at }))
    return shown
  }, `session:${b}`)
  // The drop really came before the preview
  expect(previewAtDrop).toBeNull()

  await expect.poll(() => panels(page)).toEqual([`session:${b}`, `session:${a}`])
})

test('the order survives a reload, and the global grid keeps its own', async ({ page }) => {
  // The demo scene grows the same ids on every load, so what was arranged by hand comes back (CONTRIBUTING)
  await page.goto('/?demo=grid')
  await expect(page.getByTestId('grid')).toBeVisible()
  const gridBefore = await page.evaluate(() => (window as any).__store.getState().gridPanels.map((p: any) => p.sessionId) as string[])
  expect(gridBefore.length).toBe(4)

  await page.getByTestId('project-header-centralu').click()
  expect(await panels(page)).toEqual([])
  const ids = await page.evaluate(() => Object.values((window as any).__store.getState().sessions).filter((s: any) => s.projectId === (window as any).__store.getState().focusedProjectId).map((s: any) => s.id) as string[])
  await addSessionPanels(page, ids)
  const before = await panels(page)
  expect(before.length).toBe(3)
  await dragPanel(page, before[2]!, before[0]!, 'before')
  const arranged = [before[2]!, before[0]!, before[1]!]
  expect(await panels(page)).toEqual(arranged)

  await page.reload()
  await expect(page.getByTestId('grid')).toBeVisible()
  // The grid is untouched by the project screen: the same panels, in the same order
  expect(await page.evaluate(() => (window as any).__store.getState().gridPanels.map((p: any) => p.sessionId) as string[])).toEqual(
    gridBefore,
  )
  const gridOrder = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="grid"] [data-testid^="grid-panel-"]')].map((el) =>
      el.getAttribute('data-testid')!.slice('grid-panel-'.length),
    ),
  )
  expect(gridOrder).toEqual(gridBefore)

  await page.getByTestId('project-header-centralu').click()
  expect(await panels(page)).toEqual(arranged)
  // The other project has an arrangement of its own, untouched
  await page.getByTestId('project-header-landing-site').click()
  expect(await panels(page)).toEqual([])
})

test('removing every panel survives a reload without legacy fields bringing them back', async ({ page }) => {
  await page.goto('/?demo')
  await page.getByTestId('project-header-centralu').click()
  const id = await page.evaluate(() => (Object.values((window as any).__store.getState().sessions) as { id: string; name: string }[]).find((s) => s.name === 'Finish the collapsed composer')!.id)
  await addSessionPanels(page, [id])
  await page.getByTestId(`project-remove-session:${id}`).click()
  await expect(page.getByTestId('project-empty')).toBeVisible()
  await expect(page.getByTestId('project-hidden')).toHaveCount(0)
  await page.reload()
  await page.getByTestId('project-header-centralu').click()
  expect(await panels(page)).toEqual([])
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
})

test('a trashed session leaves its screen and a removed panel returns only when its sidebar row is dragged', async ({
  page,
}) => {
  await setup(page, ['/tmp/alpha'])
  const a = await newSession(page, 'alpha')
  const b = await newSession(page, 'alpha')
  const c = await newSession(page, 'alpha')
  // Arranged first, so the remembered order names the session that then goes to the trash
  await page.getByTestId('project-header-alpha').click()
  await addSessionPanels(page, [a, b, c])
  await dragPanel(page, `session:${b}`, `session:${a}`, 'before')
  expect(await panels(page)).toEqual([`session:${b}`, `session:${a}`, `session:${c}`])

  await page.getByTestId(`session-menu-${b}`).click()
  await page.getByTestId(`delete-session-${b}`).click()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${b}`)).toHaveCount(0)

  await page.getByTestId('project-header-alpha').click()
  expect(await panels(page)).toEqual([`session:${a}`, `session:${c}`])

  await page.getByTestId(`project-remove-session:${a}`).click()
  expect(await panels(page)).toEqual([`session:${c}`])
  // Removal leaves the session in the sidebar; adding it again takes one drag
  await expect(page.getByTestId(`session-row-${a}`)).toBeVisible()
  await expect(page.getByTestId('project-hidden')).toHaveCount(0)
  await dragRow(page, page.getByTestId(`session-row-${a}`), 'padding')
  expect(await panels(page)).toEqual([`session:${c}`, `session:${a}`])
  await expect(page.getByTestId('project-hidden')).toHaveCount(0)
})

test('a session that finishes on the project screen gets no card — the person is watching its panel', async ({
  page,
}) => {
  await setup(page, ['/tmp/alpha'])
  const a = await newSession(page, 'alpha')
  await page.getByTestId('project-header-alpha').click()
  await addSessionPanels(page, [a])
  await expect(page.getByTestId(`project-panel-session:${a}`)).toBeVisible()

  await page.evaluate((id) => (window as any).__mock.emit({ type: 'turn_complete', sessionId: id }), a)
  await expect(page.getByTestId('gust')).toHaveCount(1)
  await expect(page.getByTestId('notice')).toHaveCount(0)

  // Removed, it is off screen again, and the card comes back
  await page.getByTestId(`project-remove-session:${a}`).click()
  await page.evaluate((id) => (window as any).__mock.emit({ type: 'turn_complete', sessionId: id }), a)
  await expect(page.getByTestId('notice')).toHaveCount(1)
})

/*
 * The column count is decided in real pixels (grid/real-size.ts). Two panels stand one above the other at 1280×720 at
 * the default text size and at the largest; a width measured at one size and multiplied by the other stood them
 * side by side in between, and an app's view laid over its panel went there and back.
 */
test('changing the text size leaves the panels in the columns they stand in, never a count neither size lays out', async ({
  page,
}) => {
  await setup(page, ['/tmp/alpha'])
  const a = await newSession(page, 'alpha')
  const b = await newSession(page, 'alpha')
  await page.getByTestId('project-header-alpha').click()
  await addSessionPanels(page, [a, b])
  expect(await panels(page)).toEqual([`session:${a}`, `session:${b}`])

  const counts = await columnsThrough(page, '[data-testid="project-grid"] > div', () =>
    page.evaluate(() => (window as any).__store.getState().setPrefs({ textSize: 1.25 })),
  )
  expect(counts).toEqual([1])
})

test('a project without sessions explains sidebar dragging and offers a new session', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-empty')).toContainText("Drag this project's sessions and apps here from the sidebar")
  // The evidence panel stands beside the screen and says so itself; the empty screen does not point at it
  await expect(page.getByTestId('project-empty')).not.toContainText('evidence panel')
  await page.getByTestId('project-empty-new-session').click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
})

appPanelTests()
sidebarDropTests()
