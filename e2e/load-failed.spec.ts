import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * A list read when its screen shows says so when the read fails (#850 item 8, `useLoad`). It used to draw the failure
 * as an empty list: "No changes", "No commits yet", "No saved rules", when the host had not answered at all. Retry
 * reads again, and the list appears once the host answers.
 */

/** Makes one port call fail until the returned function is called */
async function failing(page: Page, port: 'git' | 'rules', method: string, message: string): Promise<() => Promise<void>> {
  await page.evaluate(
    ([port, method, message]) => {
      const target = (window as any).__mock[port]
      target[`__real_${method}`] = target[method]
      target[method] = () => Promise.reject(new Error(message))
    },
    [port, method, message] as const,
  )
  return () =>
    page.evaluate(
      ([port, method]) => {
        const target = (window as any).__mock[port]
        target[method] = target[`__real_${method}`]
      },
      [port, method] as const,
    )
}

test('the evidence panel says a failed read of the changes failed, not that there are none', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await page.evaluate(() => {
    ;(window as any).__mock.gitState.files = [{ path: 'a.ts', staged: false, status: 'M' }]
  })
  const heal = await failing(page, 'git', 'status', 'git did not answer')
  await newSession(page, 'alpha')

  await expect(page.getByTestId('evidence-git-failed')).toContainText('git did not answer')
  await expect(page.getByTestId('evidence-clean')).toHaveCount(0)

  await heal()
  await page.getByTestId('evidence-git-failed-retry').click()
  await expect(page.getByTestId('evidence-git-failed')).toHaveCount(0)
  await expect(page.getByTestId('evidence-change-count')).toHaveText('1')
})

test('the history tab says a failed read of the commits failed, not that there are none', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const heal = await failing(page, 'git', 'log', 'git log did not answer')
  await newSession(page, 'alpha')
  await page.getByTestId('evidence-tab-history').click()

  await expect(page.getByTestId('evidence-history-failed')).toContainText('git log did not answer')
  await expect(page.getByTestId('evidence-history-empty')).toHaveCount(0)

  await heal()
  await page.getByTestId('evidence-history-failed-retry').click()
  await expect(page.getByTestId('evidence-history-empty')).toBeVisible()
})

test('settings say a failed read of the always-allow rules failed, not that there are none', async ({ page }) => {
  await setup(page, [])
  const heal = await failing(page, 'rules', 'list', 'rules did not answer')
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-permissions').click()

  await expect(page.getByTestId('rules-failed')).toContainText('rules did not answer')
  await expect(page.getByTestId('rules-empty')).toHaveCount(0)

  await heal()
  await page.getByTestId('rules-failed-retry').click()
  await expect(page.getByTestId('rules-empty')).toBeVisible()
})

test('a refresh of the changes that fails keeps the last list, with the error beside it', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await page.evaluate(() => {
    ;(window as any).__mock.gitState.files = [{ path: 'a.ts', staged: false, status: 'M' }]
  })
  await newSession(page, 'alpha')
  await expect(page.getByTestId('evidence-change-count')).toHaveText('1')

  await failing(page, 'git', 'status', 'git did not answer')
  // A turn's end reads the list again
  await page.evaluate(() => {
    const m = (window as any).__mock
    for (const s of [...m.sessions.values()] as any[]) m.emit({ type: 'turn_complete', sessionId: s.id })
  })
  await expect(page.getByTestId('evidence-git-failed')).toContainText('git did not answer')
  await expect(page.getByTestId('evidence-git').getByText('a.ts')).toBeVisible()
})
