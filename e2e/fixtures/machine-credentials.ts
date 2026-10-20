import { expect, test } from '@playwright/test'
import { setup } from './project-screen.js'

/**
 * Settings → Machines lists who else holds full access to a linked machine, and withdraws it (#1405): each full
 * credential the machine's `centralu serve` holds besides this computer's own. Against the mock, which plays the hub's
 * `machine_status` with what the machine's connection line named; the revoke over ssh is links/links.test.ts. A
 * function, because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 */
export function machineCredentialsTests(): void {
  test('a machine with other full credentials names each, and Revoke withdraws one', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-machines').click()
    const open = page.getByTestId('machines-add-open')
    if (await open.isVisible()) await open.click()
    await page.getByTestId('machines-add-name').fill('Box')
    await page.getByTestId('machines-add-target').fill('me@box')
    await page.getByTestId('machines-add-confirm').click()
    await expect(page.getByTestId('machine-row-box')).toBeVisible()
    await expect(page.getByTestId('machine-credentials-box')).toHaveCount(0)

    await page.evaluate(() => {
      const mock = (window as any).__mock
      const row = mock.machinesList.find((m: { id: string }) => m.id === 'box')
      row.otherCredentials = [
        { id: 'aaaa1111', label: 'hub:studio', created: Date.UTC(2026, 9, 20) },
        { id: 'bbbb2222', label: 'agent-script', created: Date.UTC(2026, 9, 21) },
      ]
      mock.emit({ type: 'machine_status', machine: { ...row } })
    })
    const list = page.getByTestId('machine-credentials-box')
    await expect(list).toContainText('2 others also have full access to this machine')
    // The label is the asker's own word, never checked: shown quoted
    await expect(page.getByTestId('machine-credential-bbbb2222')).toContainText('"agent-script"')
    await page.getByTestId('machine-credential-revoke-bbbb2222').click()
    await expect(page.getByTestId('machine-credential-bbbb2222')).toHaveCount(0)
    await expect(list).toContainText('Something else also has full access to this machine')
    await page.getByTestId('machine-credential-revoke-aaaa1111').click()
    await expect(list).toHaveCount(0)
  })
}
