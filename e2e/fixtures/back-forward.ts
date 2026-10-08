import { expect, test, type Page } from '@playwright/test'
import { openGrid, setApps, slider } from './grid-apps.js'
import { newSession, setup } from './project-screen.js'

/**
 * Back and forward between screens, like a web browser (#374).
 *
 * Each scenario jumps through the screen's own doors (the sidebar, the grid button, an app's row, Settings) and goes
 * back with what a person presses: the top bar's buttons, ⌘[ / ⌘] and Alt+← / Alt+→, and the mouse's side buttons.
 * A function, like `composerFocusTests`, because it runs in Chromium (back-forward.spec.ts) and in WebKit
 * (back-forward-webkit.spec.ts): the desktop app is WKWebView.
 */

const st = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__store.getState()
    return { view: s.view as string, session: s.focusedSessionId as string | null, settings: s.settingsOpen as boolean }
  })

/** Project `alpha` with two sessions, A then B, B on screen */
async function twoSessions(page: Page): Promise<{ a: string; b: string }> {
  await setup(page, ['/tmp/alpha'])
  const a = await newSession(page, 'alpha')
  const b = await newSession(page, 'alpha')
  await page.getByTestId(`session-row-${a}`).click()
  await page.getByTestId(`session-row-${b}`).click()
  await expect.poll(() => st(page)).toMatchObject({ view: 'focus', session: b })
  return { a, b }
}

/**
 * A side-button release on the page, as the browser would send it. Playwright's mouse has only left, right and
 * middle, so the native button cannot be pressed here in WebKit; in Chromium, `pressSideButton` below presses it
 * through the browser's own input path instead.
 */
const sideButton = (page: Page, button: 3 | 4) =>
  page.evaluate((b) => {
    const target = document.querySelector('[data-testid="app-header"]')!
    target.dispatchEvent(new MouseEvent('mousedown', { button: b, bubbles: true, cancelable: true }))
    target.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true, cancelable: true }))
  }, button)

export function backForwardTests(): void {
  test.describe('back and forward between screens (#374)', () => {
    test('session A → session B → back → forward, with the top bar buttons', async ({ page }) => {
      const { a, b } = await twoSessions(page)
      await expect(page.getByTestId('nav-forward')).toBeDisabled()
      await page.getByTestId('nav-back').click()
      await expect.poll(() => st(page)).toMatchObject({ view: 'focus', session: a })
      await expect(page.getByTestId('nav-forward')).toBeEnabled()
      await page.getByTestId('nav-forward').click()
      await expect.poll(() => st(page)).toMatchObject({ view: 'focus', session: b })
    })

    test('with the keys: ⌘[ / ⌘] and Alt+← / Alt+→', async ({ page }) => {
      const { a, b } = await twoSessions(page)
      // Off the composer, which a new session's screen focuses
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Meta+BracketLeft')
      await expect.poll(() => st(page)).toMatchObject({ session: a })
      await page.keyboard.press('Meta+BracketRight')
      await expect.poll(() => st(page)).toMatchObject({ session: b })
      await page.keyboard.press('Alt+ArrowLeft')
      await expect.poll(() => st(page)).toMatchObject({ session: a })
      await page.keyboard.press('Alt+ArrowRight')
      await expect.poll(() => st(page)).toMatchObject({ session: b })
    })

    test('with the mouse side buttons', async ({ page }) => {
      const { a, b } = await twoSessions(page)
      await sideButton(page, 3)
      await expect.poll(() => st(page)).toMatchObject({ session: a })
      await sideButton(page, 4)
      await expect.poll(() => st(page)).toMatchObject({ session: b })
    })

    test('a real side button press reaches the page and does not leave it (Chromium)', async ({ page, browserName }) => {
      // Playwright's mouse has no side buttons; Chromium's own input path does (WebKit has none to reach, see sideButton)
      test.skip(browserName !== 'chromium', 'only Chromium takes a side button press through its input path')
      const { a, b } = await twoSessions(page)
      const cdp = await page.context().newCDPSession(page)
      const press = async (button: 'back' | 'forward') => {
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await cdp.send('Input.dispatchMouseEvent', { type, x: 400, y: 300, button, clickCount: 1 })
        }
      }
      const url = page.url()
      await press('back')
      await expect.poll(() => st(page)).toMatchObject({ session: a })
      await press('forward')
      await expect.poll(() => st(page)).toMatchObject({ session: b })
      expect(page.url()).toBe(url)
    })

    test('the keys are left to the composer while it has focus', async ({ page }) => {
      const { b } = await twoSessions(page)
      const box = page.getByTestId('prompt-input')
      await box.click()
      await page.keyboard.type('one two')
      await page.keyboard.press('Meta+BracketLeft')
      await page.keyboard.press('Alt+ArrowLeft')
      await page.keyboard.press('Alt+ArrowRight')
      await expect(box).toBeFocused()
      expect(await st(page)).toMatchObject({ view: 'focus', session: b })
      await expect(box).toHaveValue('one two')
    })

    test('grid → app page → back returns to the grid with the same panels', async ({ page }) => {
      const { a, b } = await twoSessions(page)
      const pid = await page.evaluate(() => Object.keys((window as any).__store.getState().projects)[0] as string)
      await setApps(page, [slider(pid)])
      await openGrid(page, [a, b])
      await expect(page.getByTestId(`grid-panel-${a}`)).toBeVisible()
      await page.getByTestId(`app-row-${pid}/slider`).click()
      await expect.poll(() => st(page)).toMatchObject({ view: 'app' })
      await page.getByTestId('nav-back').click()
      await expect(page.getByTestId('grid')).toBeVisible()
      await expect(page.getByTestId(`grid-panel-${a}`)).toBeVisible()
      await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()
      await page.getByTestId('nav-forward').click()
      await expect.poll(() => st(page)).toMatchObject({ view: 'app' })
    })

    test('back skips a session deleted since it was seen', async ({ page }) => {
      const { a, b } = await twoSessions(page)
      const c = await newSession(page, 'alpha')
      await page.getByTestId(`session-row-${b}`).click()
      await page.getByTestId(`session-row-${c}`).click()
      // History: … A, B, C, B, C. B goes
      await page.evaluate((id) => (window as any).__store.getState().deleteSession(id), b)
      await expect(page.getByTestId(`session-row-${b}`)).toHaveCount(0)
      await page.getByTestId('nav-back').click()
      await expect.poll(() => st(page)).toMatchObject({ view: 'focus', session: a })
    })

    test('Settings is a screen: closing it is back, forward opens it again', async ({ page }) => {
      const { b } = await twoSessions(page)
      await page.getByTestId('open-settings').click()
      await expect(page.getByTestId('settings')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('settings')).toBeHidden()
      expect(await st(page)).toMatchObject({ session: b, settings: false })
      await page.getByTestId('nav-forward').click()
      await expect(page.getByTestId('settings')).toBeVisible()
    })
  })
}
