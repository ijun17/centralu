import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * The search field lives in the top bar, centred in the window (#727).
 *
 * It used to be the first row of the sidebar, and the top bar carried the app's name. Now the bar
 * has no name and the field stands in the middle of it, the way an editor's command bar does. What
 * has to hold, in Chromium and in WebKit (the desktop app is WKWebView): it is centred in the
 * window and not in the room the controls leave; it shrinks, still centred, rather than reach under
 * the traffic lights or the right-hand controls; the bar around it still moves the window and the
 * field does not; and the palette it opens hangs under the bar and closes as it always did.
 */

async function demo(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.goto('/?demo')
  await expect(page.getByTestId('session-name')).toHaveText('Finish the collapsed composer')
}

const box = async (el: Locator) => (await el.boundingBox())!
const drags = (page: Page) => page.evaluate(() => (window as any).__mock.windowDrags as number)

/** The field is centred in the window, within a pixel, and clear of every control on the bar */
async function expectCentredAndClear(page: Page): Promise<void> {
  const win = page.viewportSize()!
  const field = await box(page.getByTestId('search-button'))
  expect(Math.abs(field.x + field.width / 2 - win.width / 2)).toBeLessThanOrEqual(1)
  expect(field.width).toBeLessThanOrEqual(400)
  const left = await box(page.getByTestId('counter'))
  const right = await box(page.getByTestId('open-settings'))
  const donuts = page.locator('[data-testid^="usage-donut-"]')
  expect(left.x + left.width).toBeLessThanOrEqual(field.x)
  expect(field.x + field.width).toBeLessThanOrEqual(right.x)
  for (const d of await donuts.all()) expect(field.x + field.width).toBeLessThanOrEqual((await box(d)).x)
}

for (const width of [1440, 1100, 900]) {
  test(`the search field is centred in a ${width}px window and clear of the bar's controls`, async ({ page }) => {
    await demo(page, width)
    await expectCentredAndClear(page)
    const bar = await box(page.getByTestId('app-header'))
    const field = await box(page.getByTestId('search-button'))
    expect(field.y).toBeGreaterThanOrEqual(bar.y)
    expect(field.y + field.height).toBeLessThanOrEqual(bar.y + bar.height)
  })
}

test('the field shrinks as the window narrows and stays centred', async ({ page }) => {
  await demo(page, 1440)
  const wide = (await box(page.getByTestId('search-button'))).width
  // At its widest (SEARCH_MAX) in a wide window
  expect(Math.round(wide)).toBe(400)
  // At 400px the field still fits a 900px window whole
  await page.setViewportSize({ width: 900, height: 900 })
  await expect.poll(async () => (await box(page.getByTestId('search-button'))).width).toBeLessThanOrEqual(wide)
  await expectCentredAndClear(page)
  // Narrower than the desktop window can get: it gives way, still no overlap, nothing negative
  await page.setViewportSize({ width: 760, height: 900 })
  await expect.poll(async () => (await box(page.getByTestId('search-button'))).width).toBeLessThan(wide)
  await expectCentredAndClear(page)
})

test('the bar carries no title and the sidebar no search row', async ({ page }) => {
  await demo(page)
  await expect(page.getByTestId('app-title')).toHaveCount(0)
  await expect(page.getByTestId('app-header')).not.toContainText(/centralu/i)
  await expect(page.getByTestId('sidebar').getByTestId('search-button')).toHaveCount(0)
  await expect(page.getByTestId('app-header').getByTestId('search-button')).toBeVisible()
  // The first thing in the sidebar is the Orchestrator door now
  const side = await box(page.getByTestId('sidebar'))
  const first = await box(page.getByTestId('orchestrator-button'))
  expect(first.y - side.y).toBeLessThan(16)
})

test('the field does not move when the sidebar is resized to its narrowest and widest', async ({ page }) => {
  await demo(page, 1440)
  const at = async () => {
    const b = await box(page.getByTestId('search-button'))
    return [Math.round(b.x), Math.round(b.width)]
  }
  const before = await at()
  const widths: number[] = []
  // Far past both ends: the store clamps to the narrowest and the widest the sidebar can be
  for (const px of [0, 5000]) {
    await page.evaluate((w) => (window as any).__store.getState().setSidebarWidth(w), px)
    await expect.poll(async () => (await box(page.getByTestId('sidebar'))).width).not.toBe(widths.at(-1))
    widths.push((await box(page.getByTestId('sidebar'))).width)
    expect(await at()).toEqual(before)
  }
  expect(widths[0]).toBeLessThan(widths[1]! - 100)
})

test('a press on the field does not move the window and a press on the bar beside it does', async ({ page }) => {
  await demo(page)
  const field = await box(page.getByTestId('search-button'))
  const mid = field.y + field.height / 2
  await page.evaluate(() => ((window as any).__mock.windowDrags = 0))

  // On the field itself: nothing underneath it is the drag handle
  await page.mouse.move(field.x + field.width / 2, mid)
  await page.mouse.down()
  await page.mouse.up()
  expect(await drags(page)).toBe(0)
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-palette')).toBeHidden()

  // The bar above and below the field, and the gap beside it: empty bar, so each one drags
  for (const [x, y] of [
    [field.x + field.width / 2, 1],
    [field.x + field.width / 2, field.y + field.height + 1],
    [field.x - 8, mid],
    [field.x + field.width + 8, mid],
  ] as const) {
    const before = await drags(page)
    await page.mouse.move(x, y)
    await expect(page.getByTestId('app-header')).toBeVisible()
    // What is under the press is the bar itself, the element that carries the drag region
    expect(await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.getAttribute('data-testid'), [x, y])).toBe('app-header')
    await page.mouse.down()
    await page.mouse.up()
    expect(await drags(page)).toBe(before + 1)
  }
})

test('the bar around the field and the gaps inside it are the native drag region, so a double press zooms the window', async ({ page }) => {
  await demo(page)
  await expect(page.getByTestId('app-header')).toHaveAttribute('data-tauri-drag-region', 'true')
  // The wrapper of the right-hand controls: its own gaps are part of the region too
  await expect(page.getByTestId('open-settings').locator('xpath=..')).toHaveAttribute('data-tauri-drag-region', 'true')
  // The field's slot lets presses through, so the strip around the field belongs to the bar
  await expect(page.getByTestId('search-slot')).toHaveCSS('pointer-events', 'none')
  await expect(page.getByTestId('search-button')).toHaveCSS('pointer-events', 'auto')
})

test('the palette hangs under the bar, centred, and ⌘K puts the keyboard in its field', async ({ page }) => {
  await demo(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('palette-input')).toBeFocused()
  const bar = await box(page.getByTestId('app-header'))
  const panel = await box(page.getByTestId('palette-panel'))
  const win = page.viewportSize()!
  expect(panel.y).toBeGreaterThanOrEqual(bar.y + bar.height)
  expect(panel.y - (bar.y + bar.height)).toBeLessThan(16)
  expect(Math.abs(panel.x + panel.width / 2 - win.width / 2)).toBeLessThanOrEqual(1)
  // The field the person pressed stays in view above the panel and says it is open
  await expect(page.getByTestId('search-button')).toBeVisible()
  await expect(page.getByTestId('search-button')).toHaveAttribute('aria-expanded', 'true')
  expect((await box(page.getByTestId('search-button'))).y + (await box(page.getByTestId('search-button'))).height).toBeLessThanOrEqual(panel.y)
})

test('the palette closes on Esc, on a press outside, on the field again, and on a choice', async ({ page }) => {
  await demo(page)
  const field = page.getByTestId('search-button')
  const palette = page.getByTestId('command-palette')

  await field.click()
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  await field.click()
  await expect(palette).toBeVisible()
  await page.mouse.click(5, 500)
  await expect(palette).toBeHidden()

  await field.click()
  await expect(palette).toBeVisible()
  // The press lands on the catcher that covers the bar, not on the field: a real pointer, not an actionability check
  const at = await box(field)
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
  await expect(palette).toBeHidden()

  await field.click()
  await page.getByTestId('palette-input').fill('Pick the hero')
  await page.getByTestId('palette-item-session').first().click()
  await expect(palette).toBeHidden()
  await expect(page.getByTestId('session-name')).toHaveText('Pick the hero copy')

  // A press inside the panel neither moves the window nor closes it
  await page.evaluate(() => ((window as any).__mock.windowDrags = 0))
  await field.click()
  const panel = await box(page.getByTestId('palette-panel'))
  await page.mouse.click(panel.x + panel.width - 6, panel.y + panel.height - 6)
  await expect(palette).toBeVisible()
  expect(await drags(page)).toBe(0)
})
