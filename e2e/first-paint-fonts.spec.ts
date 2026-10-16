import { expect, test, type Page } from '@playwright/test'

/**
 * Both entries draw the app only once the bundled fonts are in (#731, #850 item 16; `prepareFirstPaint`).
 *
 * Drawn before, the first layout uses the fallback's metrics and moves when the fonts arrive. The browser entry
 * waited since #746; the desktop entry did not, so the jump could still happen in the app. The fonts are held
 * back here until the entry has everything else it needs, which is the moment it would have drawn without the wait.
 */

/** Holds every bundled font until the returned function is called */
async function holdFonts(page: Page): Promise<() => void> {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\.woff2(\?|$)/, async (route) => {
    await held
    await route.continue()
  })
  return release
}

/** Two frames, so a render the entry has already asked for is on screen */
const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

test('the desktop entry draws the app once the bundled fonts are in, not with the fallback', async ({ page }) => {
  const release = await holdFonts(page)
  // Held fonts hold the load event too
  await page.goto('/relaunch.html?scenario=plain', { waitUntil: 'domcontentloaded' })
  // The Tauri platform's last question is its second `host_build` (which mode): from here on, only the fonts are missing
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __relaunch: { asked: string[] } }).__relaunch.asked.filter((c) => c === 'host_build').length),
    )
    .toBeGreaterThanOrEqual(2)
  await frames(page)
  await expect(page.getByTestId('starting')).toBeVisible()
  await expect(page.getByTestId('open-settings')).toHaveCount(0)

  release()
  await expect(page.getByTestId('open-settings')).toBeVisible()
  expect(await page.evaluate(() => document.fonts.check('13px Pretendard'))).toBe(true)
})

test('the browser entry draws the app once the bundled fonts are in, not with the fallback', async ({ page }) => {
  const release = await holdFonts(page)
  await page.goto('/?mock=1', { waitUntil: 'domcontentloaded' })
  // The mock platform is made before the wait: from here on, only the fonts are missing
  await expect.poll(() => page.evaluate(() => '__mock' in window)).toBe(true)
  await frames(page)
  await expect(page.getByTestId('open-settings')).toHaveCount(0)

  release()
  await expect(page.getByTestId('open-settings')).toBeVisible()
  expect(await page.evaluate(() => document.fonts.check('13px Pretendard'))).toBe(true)
})
