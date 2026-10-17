import { expect, test } from '@playwright/test'
import { setup } from './fixtures/project-screen.js'

/**
 * Only the project list scrolls, and the resize handle stays put (#988). The whole sidebar used to scroll, carrying the
 * handle up with the rows, so past the first screen the sidebar could not be resized.
 *
 * Playwright's WebKit forces overlay scrollbars, unlike the app (WKWebView with the system's setting), so whether a
 * classic scrollbar covers the edge is checked in the app; this checks the layout, the handle's place and the drag.
 */
test('scrolled to the bottom of a long project list, the top doors and the bottom area stay and the edge still resizes', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 480 })
  await setup(page, Array.from({ length: 12 }, (_, i) => `/tmp/project-${i}`))
  const sidebar = page.getByTestId('sidebar')
  const list = page.getByTestId('sidebar-projects')
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100)

  const orchestratorBefore = (await page.getByTestId('orchestrator-button').boundingBox())!
  const addBefore = (await page.getByTestId('add-project').boundingBox())!
  // The aside itself never scrolls: only the list does
  await list.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
  expect(await sidebar.evaluate((el) => el.scrollTop)).toBe(0)
  expect((await page.getByTestId('orchestrator-button').boundingBox())!.y).toBe(orchestratorBefore.y)
  expect((await page.getByTestId('add-project').boundingBox())!.y).toBe(addBefore.y)

  // The handle spans the sidebar's full height after the scroll, so its lowest part is still there to drag
  const box = (await sidebar.boundingBox())!
  const handle = (await page.getByTestId('sidebar-resize').boundingBox())!
  expect(handle.y).toBe(box.y)
  expect(handle.height).toBe(box.height)
  const y = box.y + box.height - 20
  await page.mouse.move(handle.x + handle.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(handle.x + 100, y, { steps: 8 })
  await page.mouse.up()
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(box.width + 60)
})

test('in a window too short for everything, the list keeps room and its rows stay reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 150 })
  await setup(page, ['/tmp/alpha'])
  const list = (await page.getByTestId('sidebar-projects').boundingBox())!
  expect(list.height).toBeGreaterThanOrEqual(60)
  // The bottom area gave way, not the list: the row's menu opens with a click
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('project-menu-open-alpha')).toBeVisible()
})
