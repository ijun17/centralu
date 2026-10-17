import { expect, test, type Page } from '@playwright/test'

/**
 * The desktop's own dialogs (quit, switch build, restart completely) count as open layers, like every Modal: while
 * one stands over the window, a bare y does not answer the approval card behind it, and the app's other shortcuts
 * that ask `isCovered` (the waiting list's keys, the capability question, the overlay) stay quiet too.
 *
 * Before, they drew their own scrim without raising `openLayers`, so y allowed the card under the quit question.
 * Drawn through apps/web/shell-banner.html, which mounts the desktop's own dialogs on the mock.
 */

const answers = (page: Page) => page.evaluate(() => (window as any).__mock.approvalAnswers as unknown[])
const openLayers = (page: Page) => page.evaluate(() => (window as any).__store.getState().openLayers as number)

/** A card waiting on the focused session, with the keyboard on nothing (a bare y is the card's, not a field's) */
async function cardWaiting(page: Page) {
  await expect(page.getByTestId('session-view').first()).toBeVisible()
  const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  expect(sid).toBeTruthy()
  await page.evaluate(
    (s) => (window as any).__mock.requestApproval(s, { kind: 'command', command: 'rm -rf build', cwd: '/tmp/alpha' }, 'behind'),
    sid,
  )
  await expect(page.locator('[data-testid="approval-card"]').first()).toBeAttached()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  return sid
}

const DIALOGS = [
  { dialog: 'quit&background=off', testId: 'confirm-quit' },
  { dialog: 'switch', testId: 'confirm-switch-build' },
  { dialog: 'restart', testId: 'confirm-restart-keeper' },
] as const

for (const { dialog, testId } of DIALOGS) {
  test(`y does not answer the card behind the ${testId} dialog, and does once it closes`, async ({ page }) => {
    await page.goto(`/shell-banner.html?dialog=${dialog}`)
    const box = page.getByTestId(testId)
    await expect(box).toBeVisible()
    const sid = await cardWaiting(page)

    await page.keyboard.press('y')
    // Nothing to wait for when nothing happens: give the key's handler the same chance it gets below
    await page.waitForTimeout(300)
    expect(await answers(page)).toEqual([])
    expect(await openLayers(page)).toBe(1)

    // A press outside closes it, as in the app; the same y then answers the card (the setup was right)
    await box.click({ position: { x: 5, y: 5 } })
    await expect(box).toHaveCount(0)
    expect(await openLayers(page)).toBe(0)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('y')
    await expect.poll(() => answers(page)).toContainEqual({ sessionId: sid, requestId: 'behind', decision: 'allow' })
  })
}
