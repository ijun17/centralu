import { expect, test, type Page } from '@playwright/test'

/**
 * Fonts, line height and the text size (#312 step 5), run in Chromium (typography.spec.ts) and
 * WebKit (typography-webkit.spec.ts). What is checked is what reaches the page: the computed font
 * and line height of real elements, the terminal's own font, and the root zoom.
 */

const DEFAULT_SANS_START = '-apple-system'
const DEFAULT_MONO_START = 'ui-monospace'

const computed = (page: Page, testId: string, prop: 'fontFamily' | 'lineHeight' | 'fontSize') =>
  page.getByTestId(testId).first().evaluate((el, p) => getComputedStyle(el)[p], prop)

const rootStyle = (page: Page, name: string) => page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name)
const rootToken = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)

async function openDemo(page: Page) {
  await page.goto('/?demo')
  await expect(page.getByTestId('chat-stream')).toBeVisible()
}

async function openAppearance(page: Page) {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-appearance').click()
  await expect(page.getByTestId('settings-typography')).toBeVisible()
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-typography')).toHaveCount(0)
}

/** A shell in the terminal panel, and the element xterm draws its rows in */
async function openTerminal(page: Page) {
  await page.getByTestId('evidence-tab-terminal').click()
  await page.getByTestId('terminal-add').click()
  const surface = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-mock-term-"]').first()
  await expect(surface).toBeVisible()
  return surface.locator('.xterm-rows')
}

export function typographyTests() {
  test('with nothing chosen, nothing is written on the root and the stylesheet’s fonts and line heights show', async ({ page }) => {
    await openDemo(page)
    for (const name of ['--font-sans', '--font-mono', '--leading-body', '--leading-code']) expect(await rootStyle(page, name)).toBe('')
    expect(await computed(page, 'markdown', 'fontFamily')).toMatch(new RegExp(`^${DEFAULT_SANS_START}`))
    // .cc-md is 13px at the body line height, 1.65
    expect(parseFloat(await computed(page, 'markdown', 'lineHeight'))).toBeCloseTo(21.45, 2)
  })

  test('body font, code font and line height apply live from Settings and survive a reload', async ({ page }) => {
    await openDemo(page)
    const rows = await openTerminal(page)
    expect(await rows.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(new RegExp(`^${DEFAULT_MONO_START}`))

    await openAppearance(page)
    await page.getByTestId('settings-font-body').selectOption('Inter')
    await expect.poll(() => rootToken(page, '--font-sans')).toMatch(/^"Inter", -apple-system/)
    // The app's own stack stays behind it: Korean still has a font
    expect(await rootToken(page, '--font-sans')).toMatch(/["']Apple SD Gothic Neo["']/)
    expect(await computed(page, 'settings-font-body-sample', 'fontFamily')).toMatch(/^"?Inter"?,/)

    // A font that is not on the list, by name
    await page.getByTestId('settings-font-code').selectOption({ label: 'Other…' })
    const other = page.getByTestId('settings-font-code-other')
    await other.fill('Iosevka Term')
    await other.press('Enter')
    await expect.poll(() => rootToken(page, '--font-mono')).toMatch(/^"Iosevka Term", ui-monospace/)

    await page.getByTestId('settings-line-height-relaxed').click()
    await expect(page.getByTestId('settings-line-height-relaxed')).toHaveAttribute('aria-checked', 'true')
    await closeSettings(page)

    // The reply's prose, its code block and the terminal all follow
    await expect.poll(() => computed(page, 'markdown', 'fontFamily')).toMatch(/^"?Inter"?,/)
    // 13px × 1.65 × 1.12
    expect(parseFloat(await computed(page, 'markdown', 'lineHeight'))).toBeCloseTo(24.024, 2)
    await expect.poll(() => rows.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Iosevka Term"?,/)

    await page.reload()
    await expect(page.getByTestId('chat-stream')).toBeVisible()
    expect(await rootToken(page, '--font-sans')).toMatch(/^"Inter",/)
    expect(await rootToken(page, '--font-mono')).toMatch(/^"Iosevka Term",/)
    expect(parseFloat(await computed(page, 'markdown', 'lineHeight'))).toBeCloseTo(24.024, 2)
    await openAppearance(page)
    await expect(page.getByTestId('settings-font-body')).toHaveValue('Inter')
    await expect(page.getByTestId('settings-font-code-other')).toHaveValue('Iosevka Term')
    await expect(page.getByTestId('settings-line-height-relaxed')).toHaveAttribute('aria-checked', 'true')

    // Back to the defaults: the root is clean again
    await page.getByTestId('settings-font-body').selectOption('')
    await page.getByTestId('settings-font-code').selectOption('')
    await page.getByTestId('settings-line-height-normal').click()
    await expect.poll(() => rootStyle(page, '--font-sans')).toBe('')
    expect(await rootStyle(page, '--font-mono')).toBe('')
    expect(await rootStyle(page, '--leading-body')).toBe('')
  })

  test('the fonts and line height chosen last are on the root before the app has asked for anything', async ({ page }) => {
    await openDemo(page)
    await page.evaluate(() => (window as any).__store.getState().setPrefs({ bodyFont: 'Inter', lineHeight: 'compact', textSize: 1.1 }))
    await expect.poll(() => rootToken(page, '--leading-body')).toBe('1.452')
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.documentElement.style
        ;(window as any).__atStart = { font: s.getPropertyValue('--font-sans'), leading: s.getPropertyValue('--leading-body'), zoom: s.getPropertyValue('--text-zoom') }
      })
    })
    await page.reload()
    await expect(page.getByTestId('chat-stream')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__atStart)).toEqual({ font: expect.stringMatching(/^"Inter",/), leading: '1.452', zoom: '1.1' })
  })

  test('the text size moves out of an old workspace snapshot once, and stays where it is put after that', async ({ page }) => {
    // A snapshot written before the text size was a preference: step 4 of 5 (125%)
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('cc-mock-workspace', JSON.stringify({ textScale: 4 }))
    })
    await page.goto('/?mock=1')
    await expect.poll(() => rootToken(page, '--text-zoom')).toBe('1.25')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cc-mock-prefs') ?? '{}').textSize)).toBe(1.25)
    await openAppearance(page)
    await expect(page.getByTestId('settings-scale-4')).toHaveAttribute('aria-checked', 'true')

    await page.getByTestId('settings-scale-2').click()
    await expect.poll(() => rootToken(page, '--text-zoom')).toBe('1')
    await page.reload()
    await expect(page.getByTestId('open-settings')).toBeVisible()
    // Not moved again: the preference has its own value now
    await expect.poll(() => rootToken(page, '--text-zoom')).toBe('1')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cc-mock-prefs') ?? '{}').textSize)).toBe(1)
  })

  test('each text size button shows its own size, whichever size is on', async ({ page }) => {
    await openDemo(page)
    await openAppearance(page)
    const sample = (i: number) => page.getByTestId(`settings-scale-${i}`).locator('span').evaluate((el) => el.getBoundingClientRect().height)
    const atDefault = await sample(4)
    await page.getByTestId('settings-scale-4').click()
    await expect.poll(() => rootToken(page, '--text-zoom')).toBe('1.25')
    // On screen the 125% sample is as tall as it was before 125% was on (the zoom is divided back out)
    expect(Math.abs((await sample(4)) - atDefault)).toBeLessThan(1)
  })

  for (const lineHeight of ['compact', 'relaxed'] as const) {
    test(`at ${lineHeight} line height, a wrapped line still moves the caret before it recalls history (#38)`, async ({ page }) => {
      await page.goto('/?demo')
      await expect(page.getByTestId('chat-stream')).toBeVisible()
      await page.evaluate((l) => (window as any).__store.getState().setPrefs({ lineHeight: l }), lineHeight)
      await expect.poll(() => rootToken(page, '--leading-body')).not.toBe('')
      const input = page.getByTestId('prompt-input')
      await input.fill('sent message')
      await input.press('Enter')
      await expect(input).toHaveValue('')

      const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
      await input.fill(long)
      const rows = await input.evaluate((el: HTMLTextAreaElement) => Math.round(el.scrollHeight / parseFloat(getComputedStyle(el).lineHeight)))
      expect(rows).toBeGreaterThan(2)
      // Every press but the last one moves the caret up a line; the text stays
      for (let i = 1; i < rows; i++) {
        const before = await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)
        await input.press('ArrowUp')
        await expect(input).toHaveValue(long)
        expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBeLessThan(before)
      }
      await input.press('ArrowUp')
      await expect(input).toHaveValue('sent message')
    })
  }
}
