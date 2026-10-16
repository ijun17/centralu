import { expect, test, type Page } from '@playwright/test'

/**
 * Settings' switches and remembered grants (#850 item 12, `SettingToggle`, `GrantList`): a switch whose change is
 * saving does not take another click, and a grant that cannot be taken back says so and stays listed.
 */

async function openSettings(page: Page, tab: string) {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId(`settings-tab-${tab}`).click()
}

test('the background switch takes no second click while its change is saving', async ({ page }) => {
  await openSettings(page, 'background')
  const toggle = page.getByTestId('settings-background-toggle')
  await expect(toggle).toBeEnabled()
  // The keeper answers when the test says so
  await page.evaluate(() => {
    const port = (window as any).__mock.background
    const real = port.set
    port.set = (on: boolean) =>
      new Promise((resolve) => {
        ;(window as any).__answerBackground = () => resolve(real(on))
      })
  })

  await toggle.click()
  // Saving: a second click would send the opposite value while the first is still on its way
  await expect(toggle).toBeDisabled()
  await page.evaluate(() => (window as any).__answerBackground())
  await expect(toggle).toBeEnabled()
  await expect(toggle).toBeChecked()
  expect(await page.evaluate(() => (window as any).__mock.backgroundOn)).toBe(true)
})

test('a rule that cannot be deleted says so and stays listed', async ({ page }) => {
  const unhandled: string[] = []
  page.on('pageerror', (e) => unhandled.push(e.message))
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.rulesList = [{ id: 7, scope: 'project', matcher: 'Bash(npm test)', decision: 'allow', createdAt: Date.now() }]
    m.rules.remove = () => Promise.reject(new Error('the host refused'))
    ;(window as any).__store.getState().toggleSettings(true)
  })
  await page.getByTestId('settings-tab-permissions').click()
  await expect(page.getByTestId('rules-list')).toContainText('Bash(npm test)')

  await page.getByTestId('delete-rule-7').click()
  await expect(page.getByTestId('rules-error')).toContainText('the host refused')
  await expect(page.getByTestId('rules-list')).toContainText('Bash(npm test)')
  expect(unhandled).toEqual([])
})
