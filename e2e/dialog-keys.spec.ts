import { test, expect } from '@playwright/test'
import { setup, newSession } from './fixtures/control.js'

/**
 * The window's shortcuts and the layers over it (#842). A key is typed the way a person types it (`page.keyboard`), so
 * the test sees where the keyboard actually is.
 */

test('global shortcuts do not reach the screen under settings or a modal (#842 item 1)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings')).toBeVisible()
  // ⌘K used to open the palette under settings and take the keyboard from it
  await page.keyboard.press('Meta+k')
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  await expect(page.getByTestId('inbox')).toHaveCount(0)
  // Esc is the dialog's, and closes only it
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).toHaveCount(0)

  // A modal (the new-session dialog) keeps the keyboard the same way
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0)

  // With nothing over the screen the shortcuts still work, and ⌘K closes the palette it opened
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toHaveCount(0)
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
})

test('Esc closes Settings from a field of the add-machine form (#842 item 8)', async ({ page }) => {
  await page.goto('/?demo')
  await expect(page.getByTestId('session-name')).toBeVisible()
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-machines').click()
  const name = page.getByTestId('machines-add-name')
  await expect(name).toBeFocused()
  await page.keyboard.type('Build box')
  // The form keeps the app's shortcuts away from what is typed, and used to keep Esc away too
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).toHaveCount(0)
})
