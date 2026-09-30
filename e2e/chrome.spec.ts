import { expect, test } from '@playwright/test'

/**
 * Top bar (dogfooding finding, 2026-09-17).
 *
 * The left padding is queried from the platform because it should leave exactly as much room
 * as the window buttons take up. Where there are no traffic lights it returns 0, and that is
 * the correct answer — there is no button to leave room for. But using that value as-is made
 * the title stick to the window corner, so the bar looked lopsided.
 *
 * So what this test measures is not the padding's **size** but the single fact that a floor
 * exists. Hardcoding a number like 86px would be right where traffic lights exist and wrong
 * where they do not, and it would rot again the moment the window decoration changes.
 */
test('the title never sits closer to the edge than the right side does', async ({ page }) => {
  await page.goto('/?mock=1')
  const header = page.getByTestId('app-header')
  await expect(header).toBeVisible()

  const pad = await header.evaluate((el) => {
    const s = getComputedStyle(el)
    return { left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) }
  })

  expect(pad.right).toBeGreaterThan(0)
  expect(pad.left).toBeGreaterThanOrEqual(pad.right)
})
