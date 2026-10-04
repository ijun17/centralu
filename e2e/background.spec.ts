import { test, expect } from '@playwright/test'

/**
 * Background mode (#280), on the mock platform, which stands in for the desktop app with a keeper.
 *
 * The keeper side (what closing the window does with it on or off, the idle exit, "Quit and stop
 * agents") is driven end to end by `scripts/keeper-integration.mjs`; this holds the setting's own
 * screen: it is off by default, it says what it costs, and what it saves is what the platform holds.
 */
test('background mode is off by default, says what it keeps running, and saves through the platform', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-background').click()

  const section = page.getByTestId('settings-background')
  const toggle = page.getByTestId('settings-background-toggle')
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  // What someone needs before turning it on: what keeps running, how to stop it, when it stops itself
  await expect(section).toContainText('Keep agents running after Centralu quits')
  await expect(section).toContainText('Quit and stop agents')
  await expect(section).toContainText('30 minutes')

  await toggle.check()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.backgroundOn)).toBe(true)

  // Read back from the platform, not from the checkbox's own memory
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-background').click()
  await expect(page.getByTestId('settings-background-toggle')).toBeChecked()
})
