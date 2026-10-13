import { expect, test, type Page } from '@playwright/test'
import type { HostBuild } from '../packages/platform/src/tauri/index.js'

declare global {
  interface Window {
    __relaunch: {
      calls: string[]
      report: (patch: Partial<HostBuild>) => Promise<void>
      rejectRequest: (message: string) => void
    }
  }
}

const timeout = 'The host update did not finish in time'
const report = (page: Page, patch: Partial<HostBuild>) => page.evaluate((b) => window.__relaunch.report(b), patch)
const calls = (page: Page) => page.evaluate(() => window.__relaunch.calls)

async function open(page: Page, scenario: string) {
  // The websocket is deliberately absent: the shell still reports the old host while the
  // swap runs. The actual desktop entry, platform and React effects must handle that state.
  await page.clock.install()
  await page.goto(`/relaunch.html?scenario=${scenario}`)
  await expect.poll(() => calls(page)).toEqual(['switch_host_build'])
  if (scenario === 'timeout') {
    await expect(page.getByTestId('starting')).toBeVisible()
    await page.clock.runFor(120_001)
  }
  await expect(page.getByTestId('host-other-build')).toBeVisible()
}

test('DesktopRoot does not automatically repeat the relaunch attempt on the old host', async ({ page }) => {
  await open(page, 'rejected')
  await expect(page.getByTestId('host-switch-error')).toHaveText('Keeper refused the handoff')
  await report(page, { busy: true })
  await expect(page.getByTestId('host-switch-build')).toBeVisible()
  expect(await calls(page)).toEqual(['switch_host_build'])
  // Retrying is still a deliberate action, not disabled along with the automatic retry.
  await page.getByTestId('host-switch-build').click()
  await expect.poll(() => calls(page)).toEqual(['switch_host_build', 'switch_host_build'])
})

test('a failed relaunch swap shows the reason once', async ({ page }) => {
  await open(page, 'failed')
  const bar = page.getByTestId('host-other-build')
  await expect(bar).toHaveAttribute('role', 'alert')
  await expect(page.getByTestId('host-switch-progress')).toContainText('New host failed its start check')
  await expect(page.getByTestId('host-switch-error')).toHaveCount(0)
  expect((await bar.innerText()).match(/New host failed its start check/g)).toHaveLength(1)
})

for (const ending of ['same-build', 'done', 'failed'] as const) {
  test(`a relaunch timeout clears after ${ending}, preserving a later failure`, async ({ page }) => {
    await open(page, 'timeout')
    await expect(page.getByTestId('host-switch-error')).toHaveText(timeout)
    await report(page, { swap: { phase: 'activating', target: { commit: 'new' }, startedAt: 1 } })
    await expect(page.getByTestId('host-switch-progress')).toContainText('Reconnecting')
    await expect(page.getByTestId('host-switch-error')).toHaveText(timeout)
    const final: Partial<HostBuild> = ending === 'same-build'
      ? { sameBuild: true, keeperSameBuild: false, swap: undefined, keeper: undefined }
      : { swap: { phase: ending, target: { commit: 'new' }, startedAt: 1,
          ...(ending === 'failed' ? { message: 'Activation failed; rolled back', rolledBack: true } : {}) } }
    await report(page, final)
    await expect(page.getByTestId('host-switch-error')).toHaveCount(0)
    if (ending === 'failed') {
      await expect(page.getByTestId('host-switch-progress')).toContainText('Activation failed; rolled back')
    }
    await page.evaluate(() => window.__relaunch.rejectRequest('Later request was refused'))
    if (ending === 'same-build') {
      await page.getByTestId('host-restart-keeper').click()
      await page.getByTestId('confirm-restart-keeper-yes').click()
    } else {
      await page.getByTestId('host-switch-build').click()
    }
    await expect(page.getByTestId('host-switch-error')).toHaveText('Later request was refused')
    // Periodic final-state reports must not erase the later request's actual error.
    await report(page, { busy: false })
    await expect(page.getByTestId('host-switch-error')).toHaveText('Later request was refused')
  })
}
