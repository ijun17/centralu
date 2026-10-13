import { expect, test } from '@playwright/test'

/** The same scenario runs in each CI engine; no host or model event makes the label advance. */
test('a visible unfocused response label advances at its own boundary and catches up when shown (#615)', async ({ page }) => {
  await page.clock.install()
  await page.goto('/?demo')
  const label = page.getByTestId('activity-elapsed')
  await expect(page.getByTestId('activity-row')).toBeVisible()
  const nextMinute = await page.evaluate(() => (Math.floor(Date.now() / 60_000) + 1) * 60_000)
  await page.clock.pauseAt(nextMinute)
  await page.evaluate(() => {
    const store = (window as any).__store
    const id = store.getState().focusedSessionId
    store.setState({ appFocused: false, workingSince: { [id]: Date.now() - (3 * 60 + 28) * 60_000 - 30_000 } })
  })
  await expect(label).toHaveText('3h 28m')
  await page.clock.runFor(30_010)
  await expect(label).toHaveText('3h 29m')

  // Headless browsers do not minimize their native window; deliver WKWebView's visibility signal.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(120_010)
  await expect(label).toHaveText('3h 29m')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(label).toHaveText('3h 31m')
})
