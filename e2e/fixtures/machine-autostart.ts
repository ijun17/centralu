import { expect, test, type Page } from '@playwright/test'
import { setup } from './project-screen.js'

/**
 * Settings → Machines' start-at-boot switch (#82, docs/plans/remote-hub.md §10.4, owner decision 4: per machine, off
 * by default), against the mock: a machine added there answers at once, a Linux one through systemd and a Windows one
 * through a scheduled task. The real `serve --autostart` behind it is tooling/launcher-autostart.test.ts, the hub's
 * call links/links.test.ts. A function, because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 */

async function addMachine(page: Page, name: string, shell: 'posix' | 'powershell'): Promise<void> {
  const open = page.getByTestId('machines-add-open')
  if (await open.isVisible()) await open.click()
  await page.getByTestId('machines-add-name').fill(name)
  await page.getByTestId('machines-add-target').fill(`me@${name.toLowerCase().replace(/\s+/g, '-')}`)
  await page.getByTestId(`machines-add-shell-${shell}`).click()
  await page.getByTestId('machines-add-confirm').click()
  await expect(page.getByTestId('machines-add-form')).toHaveCount(0)
}

export function machineAutostartTests(): void {
  test('a machine starts its host at boot when the switch says so, and says where that falls short', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-machines').click()

    await test.step('a Linux machine: off by default, on through systemd', async () => {
      await addMachine(page, 'Build box', 'posix')
      const box = page.getByTestId('machine-autostart-build-box')
      await expect(box).not.toBeChecked()
      await expect(page.getByTestId('machine-row-build-box')).toContainText('Start Centralu when Build box starts')
      await box.click()
      await expect(box).toBeChecked()
      await expect(page.getByTestId('machine-autostart-note-build-box')).toHaveCount(0)
    })

    await test.step('lingering refused there: still on, and the row says what an administrator runs', async () => {
      await page.evaluate(() => {
        const mock = (window as any).__mock
        const real = mock.machines.autostart
        mock.machines.autostart = async (id: string, on?: boolean) => {
          const r = await real(id, on)
          if (!r.autostart.on) return r
          const autostart = { ...r.autostart, linger: false }
          const row = mock.machinesList.find((m: { id: string }) => m.id === id)
          row.autostart = autostart
          mock.emit({ type: 'machine_status', machine: { ...row } })
          return { machine: { ...row }, autostart }
        }
      })
      const box = page.getByTestId('machine-autostart-build-box')
      await box.click()
      await expect(box).not.toBeChecked()
      await box.click()
      await expect(box).toBeChecked()
      await expect(page.getByTestId('machine-autostart-note-build-box')).toContainText('sudo loginctl enable-linger $USER')
    })

    await test.step('a refusal is said, and the switch stays where the machine has it', async () => {
      await page.evaluate(() => {
        ;(window as any).__mock.machines.autostart = async () => {
          throw Object.assign(new Error('Centralu on me@build-box could not stop starting at boot: Failed to connect to bus'), { code: 'internal' })
        }
      })
      const box = page.getByTestId('machine-autostart-build-box')
      await box.click()
      await expect(page.getByTestId('toast')).toContainText('Could not turn off starting at boot: Centralu on me@build-box could not stop starting at boot')
      await expect(box).toBeChecked()
    })
  })

  test('a Windows machine starts it at sign-in, with the keyboard', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-machines').click()
    await addMachine(page, 'Laptop', 'powershell')
    const box = page.getByTestId('machine-autostart-laptop')
    await expect(page.getByTestId('machine-row-laptop')).toContainText('Start Centralu when you sign in to Laptop')
    await box.focus()
    await page.keyboard.press('Space')
    await expect(box).toBeChecked()
    await expect(page.getByTestId('machine-autostart-note-laptop')).toHaveText('Windows starts it at sign-in; with automatic sign-in, that is at boot.')
  })
}
