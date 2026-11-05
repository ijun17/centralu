import { expect, test } from '@playwright/test'
import { setup } from './fixtures/project-screen.js'

/*
 * The list's scrollbar is drawn over it, so rows do not move when it comes and goes (owner, 2026-11-05). A native bar
 * took a column of its own: the rows shifted left by its width when the list grew past the window. Playwright's headless
 * Chromium hides every scrollbar (`--hide-scrollbars`) and its WebKit forces overlay ones, so neither shows the bug as
 * they are; the Chromium run here keeps the engine's classic scrollbars, as WebView2 on Windows has them, and measures a
 * row with and without overflow. The WebKit run skips it: it cannot draw the bar this guards against.
 */
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })
test.skip(({ browserName }) => browserName === 'webkit', 'WebKit forces overlay scrollbars')

test('moves no row: its left edge and width are the same with and without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 })
  await setup(page, ['/tmp/alpha'])
  const list = page.getByTestId('sidebar-projects')
  const row = page.getByTestId('project-header-alpha')
  await expect(row).toBeVisible()
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(false)
  const before = (await row.boundingBox())!
  // The list grows past the window: now it has a scrollbar
  await page.evaluate(() => {
    const store = (window as any).__store
    const projects: Record<string, unknown> = {}
    for (let i = 0; i < 14; i++) projects['p' + i] = { ...Object.values(store.getState().projects)[0] as object, id: 'p' + i, name: 'extra-' + i, root: '/tmp/extra-' + i }
    store.setState((s: any) => ({ projects: { ...s.projects, ...projects } }))
  })
  await expect.poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  // No native bar took a column: the scroller's inner width is its whole width
  expect(await list.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(0)
  const after = (await row.boundingBox())!
  expect(after.x).toBe(before.x)
  expect(after.width).toBe(before.width)
  // The drawn bar stands in its place
  await expect(page.getByTestId('sidebar-scrollbar')).toBeVisible()
})
