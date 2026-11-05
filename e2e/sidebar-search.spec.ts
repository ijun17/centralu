import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * The search field is the first row of the sidebar (#535; back there from the top bar, owner, 2026-11-05).
 *
 * It was the first row of the sidebar, stood in the middle of the top bar for a while (#727), and went back because the
 * bar is going to hold more controls, which squeezed a centred field. What has to hold, in Chromium and in WebKit (the
 * desktop app is WKWebView): the field spans the sidebar at every width the sidebar can have and never overflows it;
 * the bar has no search and no title, and its empty middle still moves the window; the field itself is no drag region;
 * and the palette it opens hangs under the field, from its left edge, and closes as it always did.
 */

async function demo(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.goto('/?demo')
  await expect(page.getByTestId('session-name')).toHaveText('Finish the collapsed composer')
}

const box = async (el: Locator) => (await el.boundingBox())!
const drags = (page: Page) => page.evaluate(() => (window as any).__mock.windowDrags as number)
const field = (page: Page) => page.getByTestId('search-button')

/** The field fills the sidebar less its 8px sides, right under the bar, and nothing of it spills out */
async function expectFillsSidebar(page: Page): Promise<void> {
  const side = await box(page.getByTestId('sidebar'))
  const bar = await box(page.getByTestId('app-header'))
  const f = await box(field(page))
  expect(f.x - side.x).toBeCloseTo(8, 0)
  // The sidebar's right edge is its 1px border; the field ends 8px before the inside of it
  const right = side.x + side.width - (f.x + f.width)
  expect(right).toBeGreaterThanOrEqual(8)
  expect(right).toBeLessThanOrEqual(10)
  expect(f.y - (bar.y + bar.height)).toBeCloseTo(8, 0)
  // Inside the button, the label and the key fit: nothing is cut off at the right
  expect(await field(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false)
  await expect(field(page)).toContainText('⌘K')
}

for (const width of [1440, 900, 600]) {
  test(`the search field fills the sidebar's top in a ${width}px window`, async ({ page }) => {
    await demo(page, width)
    await expect(page.getByTestId('sidebar').getByTestId('search-button')).toBeVisible()
    await expectFillsSidebar(page)
  })
}

test('the field fits the sidebar at its narrowest and its widest', async ({ page }) => {
  await demo(page, 1440)
  const widths: number[] = []
  // Far past both ends: the store clamps to the narrowest and the widest the sidebar can be
  for (const px of [0, 5000]) {
    await page.evaluate((w) => (window as any).__store.getState().setSidebarWidth(w), px)
    await expect.poll(async () => (await box(page.getByTestId('sidebar'))).width).not.toBe(widths.at(-1))
    widths.push((await box(page.getByTestId('sidebar'))).width)
    await expectFillsSidebar(page)
  }
  expect(widths[0]).toBeLessThan(widths[1]! - 100)
  expect(Math.round(widths[0]!)).toBe(180)
})

test('the field fits the narrowest sidebar when the text is zoomed in', async ({ page }) => {
  await demo(page, 1440)
  // The text size comes from the preference, as the settings set it: the sidebar's minimum is in real pixels, so in CSS pixels it narrows with it
  await page.evaluate(() => (window as any).__store.getState().setPrefs({ textSize: 1.25 }))
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().prefs.textSize)).toBe(1.25)
  await page.evaluate(() => (window as any).__store.getState().setSidebarWidth(0))
  // 144 CSS pixels, 180 on screen
  await expect.poll(async () => Math.round((await box(page.getByTestId('sidebar'))).width)).toBe(180)
  await expect(field(page)).toBeVisible()
  expect(await field(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false)
  const side = await box(page.getByTestId('sidebar'))
  const f = await box(field(page))
  expect(f.x + f.width).toBeLessThanOrEqual(side.x + side.width)
})

test('the bar carries no title and no search, and the sidebar starts with the field', async ({ page }) => {
  await demo(page)
  await expect(page.getByTestId('app-title')).toHaveCount(0)
  await expect(page.getByTestId('app-header')).not.toContainText(/centralu/i)
  await expect(page.getByTestId('app-header').getByTestId('search-button')).toHaveCount(0)
  await expect(page.getByTestId('search-slot')).toHaveCount(0)
  // The field is the first thing in the sidebar, the Orchestrator door the next
  const side = await box(page.getByTestId('sidebar'))
  const f = await box(field(page))
  const orch = await box(page.getByTestId('orchestrator-button'))
  expect(f.y - side.y).toBeLessThan(10)
  expect(orch.y).toBeGreaterThanOrEqual(f.y + f.height)
})

test('the bar is empty between its left controls and its right ones, and that stretch moves the window', async ({ page }) => {
  await demo(page)
  const bar = await box(page.getByTestId('app-header'))
  const left = await box(page.getByTestId('counter'))
  const right = await box(page.getByTestId('open-settings'))
  const donuts = await page.locator('[data-testid^="usage-donut-"]').all()
  const rightEdge = Math.min(right.x, ...(await Promise.all(donuts.map(async (d) => (await box(d)).x))))
  const from = left.x + left.width + 8
  const to = rightEdge - 8
  expect(to - from).toBeGreaterThan(300)
  const y = bar.y + bar.height / 2
  await page.evaluate(() => ((window as any).__mock.windowDrags = 0))
  // Nothing interactive stands in the middle: every point across the stretch lands on the bar itself
  for (const x of [from, (from + to) / 2, to]) {
    const before = await drags(page)
    await page.mouse.move(x, y)
    expect(await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.getAttribute('data-testid'), [x, y])).toBe('app-header')
    await page.mouse.down()
    await page.mouse.up()
    expect(await drags(page)).toBe(before + 1)
  }
})

test('the bar is the native drag region, so a double press zooms the window; the sidebar and its field are not', async ({ page }) => {
  await demo(page)
  await expect(page.getByTestId('app-header')).toHaveAttribute('data-tauri-drag-region', 'true')
  await expect(page.getByTestId('open-settings').locator('xpath=ancestor::*[@data-tauri-drag-region][1]')).toHaveAttribute('data-tauri-drag-region', 'true')
  await expect(field(page).locator('xpath=ancestor-or-self::*[@data-tauri-drag-region]')).toHaveCount(0)
})

test('a press on the field opens the palette and does not move the window', async ({ page }) => {
  await demo(page)
  const f = await box(field(page))
  await page.evaluate(() => ((window as any).__mock.windowDrags = 0))
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2)
  await page.mouse.down()
  await page.mouse.up()
  expect(await drags(page)).toBe(0)
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-palette')).toBeHidden()
})

test('the palette hangs under the field from its left edge, and ⌘K puts the keyboard in its input', async ({ page }) => {
  await demo(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('palette-input')).toBeFocused()
  const f = await box(field(page))
  // Read once the panel has come down (it drops in from 8px up, cbb5ad8e)
  await expect.poll(async () => (await box(page.getByTestId('palette-panel'))).y).toBeGreaterThanOrEqual(f.y + f.height)
  const panel = await box(page.getByTestId('palette-panel'))
  expect(panel.y - (f.y + f.height)).toBeLessThan(16)
  expect(Math.abs(panel.x - f.x)).toBeLessThanOrEqual(1)
  // The field the person pressed stays in view above the panel and says it is open; so does the bar
  await expect(field(page)).toBeVisible()
  await expect(field(page)).toHaveAttribute('aria-expanded', 'true')
  const bar = await box(page.getByTestId('app-header'))
  expect(bar.y + bar.height).toBeLessThanOrEqual(f.y)
  // The dimming starts under the field, not over it
  const dim = (await page.getByTestId('command-palette').locator('> div').first().boundingBox())!
  expect(dim.y).toBeGreaterThanOrEqual(f.y + f.height - 1)
})

test('the palette stays inside a narrow window', async ({ page }) => {
  await demo(page, 600)
  await field(page).click()
  await expect.poll(async () => (await box(page.getByTestId('palette-panel'))).y).toBeGreaterThan(60)
  const panel = await box(page.getByTestId('palette-panel'))
  expect(panel.x).toBeGreaterThanOrEqual(0)
  expect(panel.x + panel.width).toBeLessThanOrEqual(600)
})

test('the palette closes on Esc, on a press outside, on the field again, and on a choice', async ({ page }) => {
  await demo(page)
  const palette = page.getByTestId('command-palette')

  await field(page).click()
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  await field(page).click()
  await expect(palette).toBeVisible()
  await page.mouse.click(1000, 500)
  await expect(palette).toBeHidden()

  await field(page).click()
  await expect(palette).toBeVisible()
  // The press lands on the catcher that covers the window, not on the field: a real pointer, not an actionability check
  const at = await box(field(page))
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
  await expect(palette).toBeHidden()

  await field(page).click()
  await page.getByTestId('palette-input').fill('Pick the hero')
  await page.getByTestId('palette-item-session').first().click()
  await expect(palette).toBeHidden()
  await expect(page.getByTestId('session-name')).toHaveText('Pick the hero copy')

  // A press inside the panel neither moves the window nor closes it
  await page.evaluate(() => ((window as any).__mock.windowDrags = 0))
  await field(page).click()
  const panel = await box(page.getByTestId('palette-panel'))
  await page.mouse.click(panel.x + panel.width - 6, panel.y + panel.height - 6)
  await expect(palette).toBeVisible()
  expect(await drags(page)).toBe(0)
})
