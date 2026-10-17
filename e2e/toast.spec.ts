import { expect, test } from '@playwright/test'

/**
 * The toast (#842 item 14): its timer restarts for every toast said, the same words again included, and it can be put
 * away. The clock is the page's fake one, so the 2.5 seconds are counted exactly and not under the machine's load.
 */
test('a toast said again restarts its timer, and Dismiss puts it away', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 60_000))
  const say = (text: string) => page.evaluate((t) => (window as any).__store.getState().setToast(t), text)

  await say('Could not save order: offline')
  await expect(page.getByTestId('toast')).toBeVisible()
  await page.clock.runFor(2000)
  // The same failure again: a full 2.5 seconds from here, not the half second left of the first
  await say('Could not save order: offline')
  await page.clock.runFor(1500)
  await expect(page.getByTestId('toast')).toBeVisible()
  await page.clock.runFor(1500)
  await expect(page.getByTestId('toast')).toHaveCount(0)

  await say('Could not run: no such command')
  await page.getByTestId('toast-dismiss').click()
  await expect(page.getByTestId('toast')).toHaveCount(0)
})
