import { expect, test } from '@playwright/test'
import { setup } from './project-screen.js'

/**
 * Settings → Machines says when a linked machine's host runs with administrator rights (#702): Windows OpenSSH gives
 * an administrator's network logon a full token, so every agent there runs elevated. Against the mock, which plays the
 * hub's `machine_status` with what the host said in its hello; the hello itself is links/links.test.ts. A function,
 * because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 */
export function machineElevatedTests(): void {
  test('a machine whose host runs elevated says so on its row with the way out, and stops when it no longer does', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-machines').click()
    const open = page.getByTestId('machines-add-open')
    if (await open.isVisible()) await open.click()
    await page.getByTestId('machines-add-name').fill('Win PC')
    await page.getByTestId('machines-add-target').fill('me@win-pc')
    await page.getByTestId('machines-add-shell-powershell').click()
    await page.getByTestId('machines-add-confirm').click()
    await expect(page.getByTestId('machine-row-win-pc')).toBeVisible()
    await expect(page.getByTestId('machine-elevated-win-pc')).toHaveCount(0)

    const say = (elevated: boolean | null) =>
      page.evaluate((elevated) => {
        const mock = (window as any).__mock
        const row = mock.machinesList.find((m: { id: string }) => m.id === 'win-pc')
        row.elevated = elevated
        mock.emit({ type: 'machine_status', machine: { ...row } })
      }, elevated)

    await say(true)
    const note = page.getByTestId('machine-elevated-win-pc')
    await expect(note).toContainText('Agents on Win PC run with administrator rights')
    await expect(note).toContainText('link Win PC through a standard account with its own ssh key')

    await say(false)
    await expect(note).toHaveCount(0)
  })

  /** The same row says when the machine's host runs outside the person's Windows sign-in (#1224) */
  test('a machine whose host runs in a network logon says Git there cannot use the saved credentials, and stops once it runs in the sign-in', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-machines').click()
    const open = page.getByTestId('machines-add-open')
    if (await open.isVisible()) await open.click()
    await page.getByTestId('machines-add-name').fill('Win PC')
    await page.getByTestId('machines-add-target').fill('me@win-pc')
    await page.getByTestId('machines-add-shell-powershell').click()
    await page.getByTestId('machines-add-confirm').click()
    await expect(page.getByTestId('machine-row-win-pc')).toBeVisible()
    await expect(page.getByTestId('machine-logon-win-pc')).toHaveCount(0)

    const say = (logon: string | null) =>
      page.evaluate((logon) => {
        const mock = (window as any).__mock
        const row = mock.machinesList.find((m: { id: string }) => m.id === 'win-pc')
        row.logon = logon
        mock.emit({ type: 'machine_status', machine: { ...row } })
      }, logon)

    await say('network')
    const note = page.getByTestId('machine-logon-win-pc')
    await expect(note).toContainText('Centralu runs on Win PC without your Windows sign-in')
    await expect(note).toContainText('Sign in on Win PC')

    await say('interactive')
    await expect(note).toHaveCount(0)
  })
}
