import { expect, test, type Locator, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * Popovers that hang inside a window drag region (#365): the top bar's usage and inbox dropdowns, and the background
 * task list portalled out of the session header.
 *
 * The top bar is a `DragRegion`, which starts a native window drag on a mousedown over anything not interactive. Each
 * dropdown's outside-click backdrop covers the whole screen from inside that region, so a press anywhere bubbled up and
 * started a window drag. On Windows a native drag runs a modal move loop that swallows the mouseup (tao's
 * `handle_os_dragging`: ReleaseCapture, then WM_NCLBUTTONDOWN with HTCAPTION), so the `click` the backdrop waited for
 * never arrived and the dropdown stayed open. macOS still delivered the click.
 *
 * Neither engine here runs that loop, so the tests stand in for it: they press and **check before releasing**. A
 * dropdown that is gone while the button is still down closes on Windows too, because nothing after the mousedown has
 * to reach the page. The mock platform counts `startWindowDrag` calls (`__mock.windowDrags`), the spy for the rest.
 *
 * A function because it runs in Chromium and in WebKit (popover-drag-webkit.spec.ts) — the desktop app on macOS is
 * WKWebView.
 */

const drags = (page: Page) => page.evaluate(() => (window as any).__mock.windowDrags as number)
const resetDrags = (page: Page) => page.evaluate(() => ((window as any).__mock.windowDrags = 0))

/** Presses the left button at the middle of the window, over the conversation, where only a backdrop can be hit */
async function pressOutside(page: Page) {
  const win = page.viewportSize()!
  await page.mouse.move(win.width / 2, win.height / 2)
  await page.mouse.down()
}

/** Presses on a spot inside the element that is not a button — text, the kind of place a hand rests on */
async function pressOn(page: Page, el: Locator) {
  const box = (await el.boundingBox())!
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
}

async function withUsage(page: Page) {
  await setup(page, ['/tmp/alpha'])
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: true,
      usage: { plan: 'max', windows: [{ id: 'weekly_all', label: 'Weekly', percent: 41, resetsAt: null, scope: null }], daily: [] },
    }
  })
  await newSession(page, 'alpha')
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
}

export function popoverDragTests(): void {
  test.describe('popovers inside a window drag region (#365)', () => {
    test('a press outside the usage dropdown closes it on the press and does not move the window', async ({ page }) => {
      await withUsage(page)
      await page.getByTestId('usage-donut-claude').click()
      await expect(page.getByTestId('usage-drop')).toBeVisible()
      await resetDrags(page)

      await pressOutside(page)
      await expect(page.getByTestId('usage-drop')).toBeHidden()
      expect(await drags(page)).toBe(0)
      await page.mouse.up()
    })

    test('a press inside the usage dropdown neither moves the window nor closes it', async ({ page }) => {
      await withUsage(page)
      await page.getByTestId('usage-donut-claude').click()
      const drop = page.getByTestId('usage-drop')
      await expect(drop).toBeVisible()
      await resetDrags(page)

      await pressOn(page, drop.locator('header h2'))
      await page.mouse.up()
      expect(await drags(page)).toBe(0)
      await expect(drop).toBeVisible()
    })

    test('the usage dropdown keeps switching donuts in one click and closing on Esc', async ({ page }) => {
      await withUsage(page)
      await expect(page.getByTestId('usage-donut-codex')).toBeVisible()
      await page.getByTestId('usage-donut-codex').click()
      await expect(page.getByTestId('usage-drop')).toContainText('Codex')
      // The donuts sit above the backdrop, so the other one is reached directly
      await page.getByTestId('usage-donut-claude').click()
      await expect(page.getByTestId('usage-drop')).toContainText('Claude Code')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('usage-drop')).toBeHidden()
    })

    test('a press outside the inbox closes it on the press and does not move the window', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await page.getByTestId('counter').click()
      await expect(page.getByTestId('inbox')).toBeVisible()
      await resetDrags(page)

      await pressOutside(page)
      await expect(page.getByTestId('inbox')).toBeHidden()
      expect(await drags(page)).toBe(0)
      await page.mouse.up()
    })

    test('a press inside the inbox neither moves the window nor closes it, and Esc still closes it', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await page.getByTestId('counter').click()
      const inbox = page.getByTestId('inbox')
      await expect(inbox).toBeVisible()
      await resetDrags(page)

      await pressOn(page, page.getByTestId('inbox-empty'))
      await page.mouse.up()
      expect(await drags(page)).toBe(0)
      await expect(inbox).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(inbox).toBeHidden()
    })

    test('the empty top bar still moves the window when no dropdown is open', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await resetDrags(page)
      await pressOn(page, page.getByTestId('app-title'))
      await page.mouse.up()
      expect(await drags(page)).toBe(1)
    })

    test('a press in the background task list does not move the window through the session header', async ({ page }) => {
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
      // The focus view's header is a window drag region; the list is portalled to body but React still bubbles to it
      await page.getByTestId('background-badge').click()
      const list = page.getByTestId('background-list')
      await expect(list).toBeVisible()
      await resetDrags(page)

      await pressOn(page, list.getByText('Background tasks', { exact: true }))
      await page.mouse.up()
      expect(await drags(page)).toBe(0)
      await expect(list).toBeVisible()
    })
  })
}
