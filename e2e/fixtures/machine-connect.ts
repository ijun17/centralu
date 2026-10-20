import { expect, test, type Page } from '@playwright/test'
import { setup } from './project-screen.js'

/**
 * When this computer reconnects to a linked machine (#1341, owner decision 2026-10-20), against the mock: Settings →
 * Machines' "Auto reconnect" switch and its Connect and Disconnect. The host's side (one attempt at start, no retry
 * after a drop, agents answered at once) is links/auto-reconnect.test.ts. A function, because it runs in Chromium and in
 * WebKit: the desktop app is WKWebView.
 */

type MockWindow = { __mock: any; __store: any }

async function openMachines(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-machines').click()
}

async function addMachine(page: Page, name: string): Promise<void> {
  const open = page.getByTestId('machines-add-open')
  if (await open.isVisible()) await open.click()
  await page.getByTestId('machines-add-name').fill(name)
  await page.getByTestId('machines-add-target').fill(`me@${name.toLowerCase().replace(/\s+/g, '-')}`)
  await page.getByTestId('machines-add-shell-posix').click()
  await page.getByTestId('machines-add-confirm').click()
  await expect(page.getByTestId('machines-add-form')).toHaveCount(0)
}

export function machineConnectTests(): void {
  test('Auto reconnect is on unless turned off, and a machine is disconnected and connected again from its row', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await openMachines(page)
    await addMachine(page, 'Laptop')
    const box = page.getByTestId('machine-auto-reconnect-laptop')

    await test.step('on by default; turning it off says what that means', async () => {
      await expect(box).toBeChecked()
      await expect(page.getByTestId('machine-auto-reconnect-note-laptop')).toContainText('Connects when Centralu starts')
      await box.click()
      await expect(box).not.toBeChecked()
      await expect(page.getByTestId('machine-auto-reconnect-note-laptop')).toContainText('stays away until you press Connect')
      expect(await page.evaluate(() => (window as unknown as MockWindow).__mock.machinesList[0].autoReconnect)).toBe(false)
    })

    await test.step('Disconnect closes the link and keeps the machine; Connect brings it back', async () => {
      await expect(page.getByTestId('machine-reconnect-laptop')).toHaveCount(0)
      await page.getByTestId('machine-disconnect-laptop').click()
      await expect(page.getByTestId('machine-row-status-laptop')).toHaveAttribute('data-status', 'disconnected')
      await expect(page.getByTestId('machine-row-status-laptop')).toHaveText('disconnected')
      // Nothing is wrong: the row says no problem, only the state
      await expect(page.getByTestId('machine-problem-laptop')).toHaveCount(0)
      await expect(page.getByTestId('machine-disconnect-laptop')).toHaveCount(0)
      await expect(page.getByTestId('machine-reconnect-laptop')).toHaveText('Connect')
      await page.getByTestId('machine-reconnect-laptop').click()
      await expect(page.getByTestId('machine-row-status-laptop')).toHaveAttribute('data-status', 'connected')
    })

    await test.step('a refusal is said, and the box stays where the host has it', async () => {
      await page.evaluate(() => {
        ;(window as unknown as MockWindow).__mock.machines.setAutoReconnect = async () => {
          throw Object.assign(new Error('Unknown method: machines.setAutoReconnect'), { code: 'internal' })
        }
      })
      await box.click()
      await expect(page.getByTestId('toast')).toContainText('Could not change Auto reconnect: Unknown method: machines.setAutoReconnect')
      await expect(box).not.toBeChecked()
    })
  })
}
