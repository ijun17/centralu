import { expect, test, type Page } from '@playwright/test'
import { setup } from './fixtures/project-screen.js'

/**
 * The settings' selects with an "Other…" choice (fonts in Appearance, models in Orchestrator) share one
 * implementation. Choosing "Other…" opens a text field that takes the keyboard, so the name can be typed at once;
 * a field that is open from the start (the current value is not listed) must not pull focus when Settings opens.
 */

const open = async (page: Page, tab: string) => {
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId(`settings-tab-${tab}`).click()
}

test('choosing Other… under a font puts the keyboard in the name field, and a value typed there is applied', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await open(page, 'appearance')
  await page.getByTestId('settings-font-code').selectOption({ label: 'Other…' })
  const field = page.getByTestId('settings-font-code-other')
  await expect(field).toBeFocused()
  await field.fill('Iosevka')
  await field.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().prefs.codeFont)).toBe('Iosevka')
})

test('a font that is not listed shows its name field already open, without taking the keyboard', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await page.evaluate(() => (window as any).__store.getState().setPrefs({ codeFont: 'Iosevka' }))
  await open(page, 'appearance')
  const field = page.getByTestId('settings-font-code-other')
  await expect(field).toHaveValue('Iosevka')
  await expect(field).not.toBeFocused()
})

test('choosing Other… under an agent model still puts the keyboard in the name field', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  await open(page, 'orchestrator')
  await page.getByTestId('settings-agent-model-claude-light').selectOption({ label: 'Other…' })
  await expect(page.getByTestId('settings-agent-model-claude-light-other')).toBeFocused()
})
