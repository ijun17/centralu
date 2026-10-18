import { expect, test, type Page } from '@playwright/test'
import { setup } from './project-screen.js'

/**
 * When this computer connects to a linked machine (#1134, owner decision 2026-10-18), against the mock: Settings →
 * Machines' "Connect only when needed" box and its Connect and Disconnect, and the window telling the host that it
 * needs such a machine once one of its projects is opened. The host's side (not at start, the hold, a turn there,
 * agents) is links/connect-when-needed.test.ts. A function, because it runs in Chromium and in WebKit: the desktop
 * app is WKWebView.
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

/** A folder on a linked machine as a project, the way the person adds one: Add project, the machine, its path */
async function addOn(page: Page, machine: string, path: string): Promise<void> {
  await page.getByTestId('add-project').click()
  await page.getByTestId(`add-project-on-${machine}`).click()
  await page.getByTestId('add-remote-project-path').fill(path)
  await page.getByTestId('add-remote-project-confirm').click()
  await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
}

const statusOf = (page: Page, id: string) => page.evaluate((i) => (window as unknown as MockWindow).__store.getState().machines[i]?.status, id)

export function machineConnectTests(): void {
  test('a machine connects at start unless told otherwise, and is disconnected and connected again from its row', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await openMachines(page)
    await addMachine(page, 'Laptop')
    const box = page.getByTestId('machine-connect-when-needed-laptop')

    await test.step('at start by default; when needed once the box is ticked, which says what that means', async () => {
      await expect(box).not.toBeChecked()
      await expect(page.getByTestId('machine-connect-note-laptop')).toHaveCount(0)
      await box.click()
      await expect(box).toBeChecked()
      await expect(page.getByTestId('machine-connect-note-laptop')).toContainText('Not connected when Centralu starts')
      expect(await page.evaluate(() => (window as unknown as MockWindow).__mock.machinesList[0].connect)).toBe('when_needed')
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
        ;(window as unknown as MockWindow).__mock.machines.setConnect = async () => {
          throw Object.assign(new Error('Unknown method: machines.setConnect'), { code: 'internal' })
        }
      })
      await box.click()
      await expect(page.getByTestId('toast')).toContainText('Could not change when it connects: Unknown method: machines.setConnect')
      await expect(box).toBeChecked()
    })
  })

  test('opening a project of a machine that connects when needed connects it; one connected at start is not asked', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await openMachines(page)
    await addMachine(page, 'Laptop')
    await addMachine(page, 'Server')
    await page.getByTestId('machine-connect-when-needed-laptop').click()
    await expect(page.getByTestId('machine-connect-when-needed-laptop')).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-machines')).toHaveCount(0)
    // A project on each, added while both were connected
    await addOn(page, 'laptop', '/home/me/notes')
    await addOn(page, 'server', '/srv/site')
    // Its link closed since, as after a restart of this computer or once nothing needed it
    await page.evaluate(() => (window as unknown as MockWindow).__mock.machineRow('laptop', { status: 'disconnected' }))
    await expect.poll(() => statusOf(page, 'laptop')).toBe('disconnected')
    const needed = () => page.evaluate(() => (window as unknown as MockWindow).__mock.machinesNeeded as string[])
    const focused = () => page.evaluate(() => (window as unknown as MockWindow).__store.getState().focusedProjectId as string | null)

    await page.getByTestId('project-header-site').click()
    await expect.poll(focused).toMatch(/^server\./)
    // Adding a project focuses it: what was said before this point is not what is asked here
    await page.evaluate(() => {
      ;(window as unknown as MockWindow).__mock.machinesNeeded.length = 0
    })
    expect(await needed()).toEqual([])

    await page.getByTestId('project-header-notes').click()
    await expect.poll(() => statusOf(page, 'laptop')).toBe('connected')
    expect(await needed()).toEqual(['laptop'])
  })
}
