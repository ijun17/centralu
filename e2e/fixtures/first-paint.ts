import { expect, test, type Page } from '@playwright/test'

/**
 * The first paint (#340), run in Chromium (first-paint.spec.ts) and WebKit (first-paint-webkit.spec.ts,
 * the engine the desktop app runs in).
 *
 * The desktop window used to show white before the UI drew under a light OS appearance: nothing set
 * the page's colours until the main bundle had loaded and run. The inline script in index.html now
 * paints the last theme's floor first. "Before the main bundle runs" is made literal here: the
 * module is refused, so whatever <html> shows is the inline script's doing alone. In dev the
 * stylesheet arrives through that module too, so none is loaded either.
 */

const LIGHT_CHOICE = {
  mode: 'light',
  dark: { id: 'dark', name: 'Dark', base: 'dark', preset: 'dark', tokens: {}, accent: null },
  light: { id: 'light', name: 'Light', base: 'light', preset: 'light', tokens: {}, accent: null },
}

/** What <html> shows with only index.html's own script run */
async function beforeTheBundle(page: Page, cache: unknown) {
  if (cache !== undefined) await page.addInitScript((c) => localStorage.setItem('cc-theme', JSON.stringify(c)), cache)
  await page.route(/\/src\/main\.tsx/, (route) => route.abort())
  await page.goto('/?mock=1')
  return page.evaluate(() => ({
    sheets: document.styleSheets.length,
    root: document.getElementById('root')!.childElementCount,
    background: getComputedStyle(document.documentElement).backgroundColor,
    scheme: getComputedStyle(document.documentElement).colorScheme,
  }))
}

export function firstPaintTests() {
  test.describe('the first paint (#340)', () => {
    test('with nothing cached, the page is the dark floor before any stylesheet or module loads', async ({ page }) => {
      // A light OS: the webview's own default would be white
      await page.emulateMedia({ colorScheme: 'light' })
      const shown = await beforeTheBundle(page, undefined)
      expect(shown).toEqual({ sheets: 0, root: 0, background: 'rgb(20, 20, 20)', scheme: 'dark' })
    })

    test('with a light theme cached, the page is the light floor before any stylesheet or module loads', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' })
      const shown = await beforeTheBundle(page, LIGHT_CHOICE)
      expect(shown).toEqual({ sheets: 0, root: 0, background: 'rgb(242, 242, 242)', scheme: 'light' })
    })

    test('once a theme is applied the stylesheet owns the colours again, so a switch is not held to the first side', async ({ page }) => {
      await page.goto('/?demo')
      await expect(page.getByTestId('chat-stream')).toBeVisible()
      const inline = () => page.evaluate(() => [document.documentElement.style.backgroundColor, document.documentElement.style.colorScheme])
      expect(await inline()).toEqual(['', ''])
      await page.evaluate(() => (window as any).__store.getState().setPrefs({ themeMode: 'light', themeLight: 'light' }))
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')
    })
  })
}
