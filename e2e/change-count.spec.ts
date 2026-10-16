import { expect, test } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * The number of changed files, in the three places it shows: the sidebar's mark, the evidence panel's tab and the
 * panel's collapsed rail (#850 item 10). A partly staged file is two rows of the panel's list, one under Staged and
 * one under Changes; the panel and the rail used to count rows and said 3 beside a sidebar that said 2.
 */
test('a partly staged file counts once, the same in the sidebar, the panel and the rail', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await newSession(page, 'alpha')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'a.ts', staged: true, status: 'M' },
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
    ]
    // A turn's end is what re-reads the sidebar's count and the panel's list
    for (const s of [...m.sessions.values()] as any[]) m.emit({ type: 'turn_complete', sessionId: s.id })
  })

  // Both rows of a.ts are listed: the count is of files, not rows
  await expect(page.getByTestId('evidence-git').getByText('a.ts')).toHaveCount(2)
  await expect(page.getByTestId('evidence-change-count')).toHaveText('2')
  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('2')

  await page.getByTestId('evidence-close').click()
  await expect(page.getByTestId('evidence-rail-count')).toHaveText('2')
})
