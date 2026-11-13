import { expect, test } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * The watches a session keeps, in its header (#1324, docs/plans/mailbox.md §18.8), driven through the mock platform. CI runs it in both
 * engines: the desktop app is WKWebView, and the list is a popover laid over the header, as the background work's is.
 */
test('the badge appears with a watch, lists it, and Cancel takes the row and then the badge away', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  await expect(page.getByTestId('watches-badge')).toHaveCount(0)

  const until = Date.now() + 60 * 60_000
  const watchId = await page.evaluate(
    ([sid, end]) => (window as any).__mock.seedWatch(sid, { source: 'time', what: '', at: end, everyMinutes: null, until: end, note: 'check CI' }),
    [id, until] as const,
  )
  const badge = page.getByTestId('watches-badge')
  await expect(badge).toHaveAttribute('data-count', '1')

  await page.getByTestId('watches-button').click()
  const row = page.getByTestId(`watch-${watchId}`)
  await expect(row).toContainText('At ')
  await expect(row).toContainText('check CI')

  await row.getByRole('button', { name: 'Cancel' }).click()
  await expect(row).toHaveCount(0)
  await expect(badge).toHaveCount(0)
})
