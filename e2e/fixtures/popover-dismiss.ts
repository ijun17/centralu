import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * How popovers and menus go away (#428), now one rule (`useDismiss`): Escape closes the innermost open thing and
 * nothing behind it; the window losing focus closes it (a click into an app's view takes focus out of this document
 * without a mousedown); Escape gives focus back to the button that opened it.
 *
 * Before, each of seven popovers had its own copy: the sidebar's menu let Escape reach the inbox behind it, and only the
 * span picker closed on blur or gave focus back.
 *
 * A function because it runs in Chromium and in WebKit (popover-dismiss-webkit.spec.ts): the desktop app is WKWebView,
 * where a click does not focus a button.
 */

/** What the window does when focus goes into an app's view or to another application */
const leaveWindow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('blur')))

const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)

async function withBackgroundTask(page: Page) {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  await page.evaluate(
    (sid) =>
      (window as any).__mock.emit({
        type: 'background_tasks',
        sessionId: sid,
        live: [{ id: 'bzztskv5d', kind: 'shell', description: 'sleep 191', stopsWithTurn: false, stoppable: true }],
      }),
    id,
  )
  await expect(page.getByTestId('background-badge')).toBeVisible()
}

export function popoverDismissTests(): void {
  test.describe('popover dismissal (#428)', () => {
    test('Escape closes the sidebar menu and leaves the inbox open behind it', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await page.getByTestId('project-menu-alpha').click()
      await expect(page.getByTestId('project-menu-open-alpha')).toBeVisible()
      // The inbox opens by key, since its backdrop would take a click meant for the sidebar
      await page.keyboard.press('ControlOrMeta+i')
      await expect(page.getByTestId('inbox')).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(page.getByTestId('project-menu-open-alpha')).toBeHidden()
      await expect(page.getByTestId('inbox')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('inbox')).toBeHidden()
    })

    test('Escape gives focus back to the button that opened the sidebar menu', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await page.getByTestId('project-menu-alpha').click()
      await expect(page.getByTestId('project-menu-open-alpha')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('project-menu-open-alpha')).toBeHidden()
      expect(await focusedTestId(page)).toBe('project-menu-alpha')
    })

    test('the sidebar menu closes when the window loses focus', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await page.getByTestId('project-menu-alpha').click()
      await expect(page.getByTestId('project-menu-open-alpha')).toBeVisible()
      await leaveWindow(page)
      await expect(page.getByTestId('project-menu-open-alpha')).toBeHidden()
    })

    test('a window too short for the sidebar menu caps it and scrolls inside, instead of running off the bottom', async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 150 })
      await setup(page, ['/tmp/alpha'])
      await page.getByTestId('project-menu-alpha').click()
      const menu = page.getByTestId('project-menu-open-alpha')
      await expect(menu).toBeVisible()
      const box = (await menu.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(150)
      expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    })

    test('the background list closes when the window loses focus, and Escape gives focus back to its button', async ({ page }) => {
      await withBackgroundTask(page)
      await page.getByTestId('background-badge').click()
      await expect(page.getByTestId('background-list')).toBeVisible()
      await leaveWindow(page)
      await expect(page.getByTestId('background-list')).toBeHidden()

      await page.getByTestId('background-badge').click()
      await expect(page.getByTestId('background-list')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('background-list')).toBeHidden()
      expect(await focusedTestId(page)).toBe('background-badge')
    })

    test('the session settings menu closes when the window loses focus, and Escape gives focus back to its button', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')
      await page.getByTestId('settings-open').click()
      await expect(page.getByTestId('settings-menu')).toBeVisible()
      await leaveWindow(page)
      await expect(page.getByTestId('settings-menu')).toBeHidden()

      await page.getByTestId('settings-open').click()
      await expect(page.getByTestId('settings-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('settings-menu')).toBeHidden()
      expect(await focusedTestId(page)).toBe('settings-open')
    })

    test('Escape leaves the keyboard in the composer when that is where the person was typing', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')
      await page.getByTestId('settings-open').click()
      await expect(page.getByTestId('settings-menu')).toBeVisible()
      await page.getByTestId('prompt-input').focus()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('settings-menu')).toBeHidden()
      expect(await focusedTestId(page)).toBe('prompt-input')
    })
  })
}
