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

/** Whether focus is inside the element with this test id */
const focusInside = (page: import('@playwright/test').Page, testId: string) =>
  page.evaluate((id) => !!document.querySelector(`[data-testid="${id}"]`)?.contains(document.activeElement), testId)

test('a modal and Settings are dialogs: focus starts inside and Tab stays there (#842 item 7)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  const modal = page.getByTestId('new-session-dialog').getByRole('dialog')
  await expect(modal).toHaveAttribute('aria-modal', 'true')
  await expect(modal).toHaveAccessibleName(/.+/)
  expect(await focusInside(page, 'new-session-dialog')).toBe(true)
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    expect(await focusInside(page, 'new-session-dialog'), `after ${i + 1} Tab`).toBe(true)
  }
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await focusInside(page, 'new-session-dialog'), `after ${i + 1} Shift+Tab`).toBe(true)
  }
  // Focus that fell to the page (the focused control went away) comes back into the dialog on the next Tab
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  await page.keyboard.press('Tab')
  expect(await focusInside(page, 'new-session-dialog'), 'Tab from the page').toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0)

  await page.getByTestId('open-settings').click()
  const settings = page.getByTestId('settings-panel')
  await expect(settings).toHaveAttribute('role', 'dialog')
  await expect(settings).toHaveAccessibleName('Settings')
  expect(await focusInside(page, 'settings-panel')).toBe(true)
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab')
    expect(await focusInside(page, 'settings-panel'), `after ${i + 1} Tab`).toBe(true)
  }
})

test('the palette field is a combobox that names the option under the cursor (#842 item 7)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.keyboard.press('Meta+k')
  const input = page.getByTestId('palette-input')
  await expect(input).toBeFocused()
  await expect(page.getByTestId('palette-panel')).toHaveAttribute('role', 'dialog')
  await expect(input).toHaveAttribute('role', 'combobox')
  await expect(page.getByRole('listbox', { name: 'Results' })).toBeVisible()

  const active = () => input.getAttribute('aria-activedescendant')
  const first = await active()
  expect(first).toBeTruthy()
  await expect(page.locator(`[id="${first}"]`)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  const second = await active()
  expect(second).not.toBe(first)
  await expect(page.locator(`[id="${second}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator(`[id="${first}"]`)).toHaveAttribute('aria-selected', 'false')
  // Tab does not walk out of the palette into the screen under it
  await page.keyboard.press('Tab')
  expect(await focusInside(page, 'palette-panel')).toBe(true)
})

test('the composer stays a text box, and names the suggestion list only while it is open (#842 item 7)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const input = page.getByTestId('prompt-input')
  // A <textarea> may not be made a combobox: it keeps its multi-line text box role
  await expect(input).not.toHaveAttribute('role', /.+/)
  await expect(input).toHaveAttribute('aria-haspopup', 'listbox')
  await expect(input).toHaveAttribute('aria-expanded', 'false')
  await expect(input).not.toHaveAttribute('aria-controls', /.+/)

  await input.focus()
  await page.keyboard.type('/')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  await expect(input).toHaveAttribute('aria-expanded', 'true')
  const list = await input.getAttribute('aria-controls')
  await expect(page.locator(`[id="${list}"]`)).toHaveAttribute('role', 'listbox')
  const active = await input.getAttribute('aria-activedescendant')
  await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('aria-selected', 'true')
})
