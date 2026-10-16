import { expect, test, type Page } from '@playwright/test'
import { setup } from './fixtures/project-screen.js'

/**
 * The four "are you sure" asks share one component (`InlineConfirm`, #428): Cancel first, then the action, and the
 * action cannot be pressed again while it runs. Before, Settings' app Remove and a machine's Remove stayed pressable, and
 * a second press started the same removal twice (the second one failing, with a toast saying so).
 */

const NOTES = {
  appId: 'notes',
  projectId: null,
  machine: null,
  dir: '/home/me/.centralu/apps/notes',
  name: 'Notes',
  version: '0.1.0',
  description: null,
  home: 'home',
  trusted: true,
  status: 'stopped',
  error: null,
  warnings: [],
}

/** Makes a platform call take a moment and counts it, so a second press has time to land while it runs */
const slowAndCounted = (page: Page, target: 'apps' | 'machines') =>
  page.evaluate((t) => {
    const w = window as any
    const area = w.__mock[t]
    const original = area.remove.bind(area)
    w.__removeCalls = 0
    area.remove = async (...args: unknown[]) => {
      w.__removeCalls++
      await new Promise((r) => setTimeout(r, 400))
      return original(...args)
    }
  }, target)

const removeCalls = (page: Page) => page.evaluate(() => (window as any).__removeCalls as number)

test('Settings: removing an app asks first, Cancel comes before Remove, and a second press does not remove it twice', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await page.evaluate((notes) => (window as any).__mock.setExternalApps([notes]), NOTES)
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-apps').click()
  const row = page.getByTestId('external-app-_user/notes')
  await row.getByTestId('external-app-remove').click()

  const confirm = row.getByTestId('external-app-remove-confirm')
  await expect(confirm.getByRole('button')).toHaveText(['Cancel', 'Remove'])

  await slowAndCounted(page, 'apps')
  await row.getByTestId('external-app-remove-yes').dblclick()
  await expect(row).toHaveCount(0)
  expect(await removeCalls(page)).toBe(1)
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

test('Settings → Machines: removing a machine asks first, Keep comes before Remove, and a second press does not remove it twice', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await page.evaluate(
    async () => ((await (window as any).__mock.machines.add({ name: 'Box', sshTarget: 'me@box', shell: 'posix' })) as { id: string }).id,
  )
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-machines').click()
  const row = page.getByTestId(`machine-row-${id}`)
  await row.getByTestId(`machine-remove-${id}`).click()
  await expect(row.getByRole('button', { name: /^(Keep|Remove)$/ })).toHaveText(['Keep', 'Remove'])

  await slowAndCounted(page, 'machines')
  await row.getByTestId(`machine-remove-yes-${id}`).dblclick()
  await expect(row).toHaveCount(0)
  expect(await removeCalls(page)).toBe(1)
})
