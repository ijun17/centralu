import { expect, test, type Page } from '@playwright/test'

/**
 * Unread reflects only what the person actually saw (#161) — real UI on a mock platform.
 *
 * The unread timer for a focused session marks it as read 3 seconds later. If the app is behind
 * another window, the person has not seen the result, so it must not become read, and the
 * 3-second count restarts from the moment the app regains focus.
 */

const read = (page: Page, id: string) =>
  page.evaluate((sid) => {
    const s = (window as any).__store.getState().sessions[sid]
    return { lastSeq: s.lastSeq as number, lastReadSeq: s.lastReadSeq as number }
  }, id)

test('an answer that finishes while the app is behind another window does not become read until 3 seconds after the app regains focus', async ({ page }) => {
  test.setTimeout(30000)
  // The page's timers run on a clock the test can move, so "3 seconds went by" is something the test makes happen
  await page.clock.install()
  await page.goto('/?mock=1')
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)

  // Switch to another window — the agent's answer arrives while the app is away
  await page.evaluate(() => (window as any).__store.getState().setAppFocused(false))
  await page.evaluate(
    (sid) => (window as any).__mock.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: 'finished while you were away' }),
    id,
  )
  await expect(page.getByTestId('session-view')).toContainText('finished while you were away')
  const before = await read(page, id)
  expect(before.lastSeq).toBeGreaterThan(before.lastReadSeq)
  /*
   * Run every timer due in the next 3.6 seconds, the read timer's 3 included. A fixed wait could
   * end before a loaded page had run that timer, and a timer that marked it read would go unseen.
   * markRead goes through the mock and then the store; waiting for a frame lets that land.
   */
  await page.clock.runFor(3600)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
  expect(await read(page, id)).toEqual(before)

  // Return — the person is watching now, so it becomes read after 3 seconds
  await page.evaluate(() => (window as any).__store.getState().setAppFocused(true))
  await expect.poll(() => read(page, id), { timeout: 6000 }).toEqual({ lastSeq: before.lastSeq, lastReadSeq: before.lastSeq })
})
