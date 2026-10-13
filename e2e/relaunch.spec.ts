import { expect, test, type Page } from '@playwright/test'
import type { HostBuild } from '../packages/platform/src/tauri/index.js'

declare global {
  interface Window {
    __relaunch: {
      calls: string[]
      report: (patch: Partial<HostBuild>) => Promise<void>
      rejectRequest: (message: string) => void
      timeoutNextSwitch: (finalBeforeTimeout?: 'done' | 'failed') => void
    }
  }
}

const timeout = 'The host update did not finish in time'
const report = (page: Page, patch: Partial<HostBuild>) => page.evaluate((b) => window.__relaunch.report(b), patch)
const calls = (page: Page) => page.evaluate(() => window.__relaunch.calls)

async function open(page: Page, scenario: string, prior?: 'done' | 'failed') {
  // The websocket is deliberately absent: the shell still reports the old host while the
  // swap runs. The actual desktop entry, platform and React effects must handle that state.
  await page.clock.install()
  await page.goto(`/relaunch.html?scenario=${scenario}&prior=${prior ?? ""}`)
  await expect.poll(() => calls(page)).toEqual(['switch_host_build'])
  if (scenario.startsWith('timeout')) {
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

for (const prior of ['done', 'failed'] as const) {
  for (const scenario of ['rejected', 'timeout-before-swap']) {
    test(`a prior ${prior} swap does not erase a ${scenario} relaunch error`, async ({ page }) => {
      await open(page, scenario, prior)
      const error = scenario === 'rejected' ? 'Keeper refused the handoff' : timeout
      await expect(page.getByTestId('host-switch-error')).toHaveText(error)
      // The keeper repeats the same last swap in activity reports, including after handoff.
      await report(page, { busy: true })
      await expect(page.getByTestId('host-switch-error')).toHaveText(error)
      await report(page, { swap: { phase: 'failed', startedAt: 1, target: { commit: 'new' },
        message: 'Current swap failed' } })
      await expect(page.getByTestId('host-switch-progress')).toContainText('Current swap failed')
      await expect(page.getByTestId('host-switch-error')).toHaveCount(0)
    })
  }
}

for (const phase of ['done', 'failed'] as const) {
  for (const finalBeforeTimeout of [false, true]) {
    test(`a later switch timeout clears on a new ${phase} swap (final before timeout: ${finalBeforeTimeout})`, async ({ page }) => {
      await open(page, 'rejected', 'done')
      await page.evaluate((ending) => window.__relaunch.timeoutNextSwitch(ending), finalBeforeTimeout ? phase : undefined)
      await page.getByTestId('host-switch-build').click()
      await expect.poll(() => calls(page)).toHaveLength(2)
      // Both the report and the timeout belong to the manual request, which began after swap 0.
      await expect(page.getByTestId(finalBeforeTimeout && phase === 'done' ? 'host-switch-build' : 'host-switch-progress')).toBeVisible()
      await page.clock.runFor(10_001)
      if (!finalBeforeTimeout) {
        await expect(page.getByTestId('host-switch-error')).toHaveText('the keeper did not answer: operation timed out')
        await report(page, { swap: { phase, startedAt: 2, target: { commit: 'new' },
          message: 'New swap failed after drain' } })
      }
      if (phase === 'failed') {
        await expect(page.getByTestId('host-switch-progress')).toContainText('New swap failed after drain')
      }
      await expect(page.getByTestId('host-switch-error')).toHaveCount(0)
    })
  }
}
