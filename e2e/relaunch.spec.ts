import { expect, test, type Page } from '@playwright/test'
import type { ShellHostBuild } from '../packages/platform/src/tauri/index.js'

/**
 * A window of a newer build attached to a keeper and host of an older one, through the real desktop entry, platform and
 * React effects (apps/desktop/src/harness/relaunch.ts mocks the shell only). The bar offers a restart into this build
 * (#1895 step 4, PR 3): the window asks the shell to stop the keeper, for an update when it can, and starts its own.
 */

declare global {
  interface Window {
    __relaunch: {
      calls: string[]
      report: (patch: Partial<ShellHostBuild>) => Promise<void>
      rejectRequest: (message: string) => void
    }
  }
}

const report = (page: Page, patch: Partial<ShellHostBuild>) => page.evaluate((b) => window.__relaunch.report(b), patch)
const calls = (page: Page) => page.evaluate(() => window.__relaunch.calls)

async function open(page: Page, query = '') {
  // The websocket is deliberately absent: the shell reports the old host, and the window must still draw its bar
  await page.goto(`/relaunch.html?${query}`)
  await expect(page.getByTestId('host-restart-keeper')).toHaveText('Restart into this build')
}

test('with something running, the restart asks first, says the turns go on, and nothing restarts by itself', async ({ page }) => {
  await open(page)
  await expect(page.getByTestId('host-other-build')).toContainText('The agent host is running build old (0.1.0-beta.19).')
  expect(await calls(page)).toEqual([])
  await page.getByTestId('host-restart-keeper').click()
  await expect(page.getByTestId('confirm-restart-keeper-loses')).toContainText('Running turns stop and go on once this build is up')
  await page.getByTestId('confirm-restart-keeper-yes').click()
  await expect.poll(() => calls(page)).toEqual(['restart_keeper'])
  // No progress phases: one line until this build's keeper answers, then the bar goes
  await expect(page.getByTestId('host-restarting')).toHaveText('Restarting Centralu on this build…')
  await expect(page.getByTestId('host-restart-keeper')).toHaveCount(0)
  await report(page, { sameBuild: true, keeperSameBuild: true, host: { commit: 'new' }, keeper: { commit: 'new' } })
  await expect(page.getByTestId('host-other-build')).toHaveCount(0)
})

test('a keeper of an earlier build: the question says what a full quit stops', async ({ page }) => {
  await open(page, 'keeper=earlier')
  await page.getByTestId('host-restart-keeper').click()
  await expect(page.getByTestId('confirm-restart-keeper-loses')).toContainText('Also stops agents, terminals and running commands.')
})

test('with nothing running, the restart goes without a question', async ({ page }) => {
  await open(page, 'busy=no')
  await page.getByTestId('host-restart-keeper').click()
  await expect.poll(() => calls(page)).toEqual(['restart_keeper'])
  await expect(page.getByTestId('confirm-restart-keeper')).toHaveCount(0)
})

test('a refused restart says why next to the button, which stays to try again', async ({ page }) => {
  await open(page, 'busy=no')
  await page.evaluate(() => window.__relaunch.rejectRequest('the keeper refused: a build switch is under way'))
  await page.getByTestId('host-restart-keeper').click()
  await expect(page.getByTestId('host-restart-error')).toHaveText('the keeper refused: a build switch is under way')
  await expect(page.getByTestId('host-restart-keeper')).toBeVisible()
  await page.getByTestId('host-restart-keeper').click()
  await expect.poll(() => calls(page)).toEqual(['restart_keeper', 'restart_keeper'])
})
