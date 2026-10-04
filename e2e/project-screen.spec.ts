import { expect, test } from '@playwright/test'
import { appPanelTests, dragPanel, newSession, panels, setup, sidebarDropTests } from './fixtures/project-screen.js'
import { columnsThrough } from './fixtures/columns.js'

/**
 * The project screen (#203): clicking a project's name shows everything the project has — its sessions and its
 * apps — as panels that move like the grid's, and the order is remembered per project. The helpers, the app panels'
 * scenarios and the sidebar drops live in fixtures/project-screen.ts, which project-screen-webkit.spec.ts runs again
 * in WebKit.
 */
test('clicking a project name shows only that project’s sessions as panels, and a session made after a drag lands at the end', async ({
  page,
}) => {
  await setup(page, ['/tmp/alpha', '/tmp/beta'])
  const a = await newSession(page, 'alpha')
  const b = await newSession(page, 'alpha')
  const other = await newSession(page, 'beta')

  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view-name')).toHaveText('alpha')
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
  expect(await panels(page)).toEqual([`session:${b}`, `session:${a}`, `session:${c}`])
})

test('the order survives a reload, and the global grid keeps its own', async ({ page }) => {
  // The demo scene grows the same ids on every load, so what was arranged by hand comes back (CONTRIBUTING)
  await page.goto('/?demo=grid')
  await expect(page.getByTestId('grid')).toBeVisible()
  const gridBefore = await page.evaluate(() => (window as any).__store.getState().gridPanels.map((p: any) => p.sessionId) as string[])
  expect(gridBefore.length).toBe(4)

  await page.getByTestId('project-header-centralu').click()
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
  expect((await panels(page)).length).toBe(2)
})

test('a trashed session is not on its project screen, a hidden panel is named above and comes back at the end', async ({
  page,
}) => {
  await setup(page, ['/tmp/alpha'])
  const a = await newSession(page, 'alpha')
  const b = await newSession(page, 'alpha')
  const c = await newSession(page, 'alpha')
  // Arranged first, so the remembered order names the session that then goes to the trash
  await page.getByTestId('project-header-alpha').click()
  await dragPanel(page, `session:${b}`, `session:${a}`, 'before')
  expect(await panels(page)).toEqual([`session:${b}`, `session:${a}`, `session:${c}`])

  await page.getByTestId(`session-menu-${b}`).click()
  await page.getByTestId(`delete-session-${b}`).click()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${b}`)).toHaveCount(0)

  await page.getByTestId('project-header-alpha').click()
  expect(await panels(page)).toEqual([`session:${a}`, `session:${c}`])

  await page.getByTestId(`project-hide-session:${a}`).click()
  expect(await panels(page)).toEqual([`session:${c}`])
  // Hidden is not deleted: the session is still in the sidebar, and its name waits above the panels
  await expect(page.getByTestId(`session-row-${a}`)).toBeVisible()
  await page.getByTestId(`project-show-session:${a}`).click()
  expect(await panels(page)).toEqual([`session:${c}`, `session:${a}`])
  await expect(page.getByTestId('project-hidden')).toHaveCount(0)
})

test('a session that finishes on the project screen gets no card — the person is watching its panel', async ({
  page,
}) => {
  await setup(page, ['/tmp/alpha'])
  const a = await newSession(page, 'alpha')
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId(`project-panel-session:${a}`)).toBeVisible()

  await page.evaluate((id) => (window as any).__mock.emit({ type: 'turn_complete', sessionId: id }), a)
  await expect(page.getByTestId('gust')).toHaveCount(1)
  await expect(page.getByTestId('notice')).toHaveCount(0)

  // Hidden, it is off screen again, and the card comes back
  await page.getByTestId(`project-hide-session:${a}`).click()
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
  expect(await panels(page)).toEqual([`session:${a}`, `session:${b}`])

  const counts = await columnsThrough(page, '[data-testid="project-grid"] > div', () =>
    page.evaluate(() => (window as any).__store.getState().setTextScale(4)),
  )
  expect(counts).toEqual([1])
})

test('a project with nothing in it says so and offers a session', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-empty')).toContainText('Nothing in this project yet')
  // The evidence panel stands beside the screen and says so itself; the empty screen does not point at it
  await expect(page.getByTestId('project-empty')).not.toContainText('evidence panel')
  await page.getByTestId('project-empty-new-session').click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
})

appPanelTests()
sidebarDropTests()
