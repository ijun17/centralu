import { expect, test, type Page } from '@playwright/test'
import { INK_ORDER, READING_SURFACES, THEME_PRESETS, contrast, urgencyBreaks, type Rgba } from '../../packages/ui/src/app/theme.js'

/**
 * Themes (#312 step 3), run in Chromium (theme.spec.ts) and WebKit (theme-webkit.spec.ts).
 *
 * A custom theme is a file the host watches; here the mock stands in for the folder
 * (`__mock.themeFiles`, `__mock.writeThemeFile` is what an editor or an agent saving the file
 * does). What is checked is what reaches the page: the computed value of a token on `<html>`.
 */

type Mock = {
  themeFiles: Map<string, string>
  writeThemeFile(id: string, text: string): void
  themeImportSources: Map<string, string>
  nextPickedFile: string | null
  revealedThemes: string[]
  windowAppearance: { scheme: 'dark' | 'light' | null; background: string } | null
}

const DARK_FLOOR = '#141414'

export async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
}

/** The demo, once the app has attached — a theme file written before that could race the first list */
async function openDemo(page: Page) {
  await page.goto('/?demo')
  await expect(page.getByTestId('chat-stream')).toBeVisible()
}

async function openAppearance(page: Page) {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-appearance').click()
  await expect(page.getByTestId('settings-theme')).toBeVisible()
}

async function writeFile(page: Page, id: string, file: unknown) {
  await page.evaluate(
    ([i, text]) => (window as never as { __mock: Mock }).__mock.writeThemeFile(i!, text!),
    [id, typeof file === 'string' ? file : JSON.stringify(file)],
  )
}

async function fileText(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((i) => (window as never as { __mock: Mock }).__mock.themeFiles.get(i), id)
}

/** The preset's colours as the page resolves them, read back through a canvas so any syntax lands as sRGB */
async function presetColors(page: Page, names: readonly string[]): Promise<Record<string, Rgba>> {
  return page.evaluate((list) => {
    const probe = document.createElement('div')
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const out: Record<string, [number, number, number, number]> = {}
    for (const name of list) {
      probe.style.color = `var(${name})`
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = getComputedStyle(probe).color
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      out[name] = [r!, g!, b!, a! / 255]
    }
    probe.remove()
    return out
  }, names as string[])
}

export function presetTests() {
  test('Light mode shows the Light preset, and the window and color-scheme follow', async ({ page }) => {
    await openDemo(page)
    await openAppearance(page)
    await page.getByTestId('settings-theme-mode-light').click()
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#f2f2f2')
    expect(await token(page, '--color-ink-signal')).toBe('#000000')
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')
    await expect.poll(() => page.evaluate(() => (window as any).__mock.windowAppearance)).toEqual({ scheme: 'light', background: 'rgb(242, 242, 242)' })
    // The conversation keeps its own front-most surface in light too
    expect(await page.getByTestId('session-view').evaluate((el) => getComputedStyle(el).getPropertyValue('--color-surface-floor').trim())).toBe('#f8f8f8')
  })

  test('Follow system picks the light preset when the OS is light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await openDemo(page)
    await page.evaluate(() => (window as any).__store.getState().setPrefs({ themeMode: 'system', themeLight: 'hc-light' }))
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#ffffff')
    expect(await token(page, '--color-line')).toBe('#767676')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => token(page, '--color-surface-floor')).toBe(DARK_FLOOR)
  })

  for (const preset of THEME_PRESETS) {
    test(`${preset.name} keeps the urgency order on every reading surface`, async ({ page }) => {
      await openDemo(page)
      await page.evaluate(
        ([id, base]) => (window as any).__store.getState().setPrefs(base === 'dark' ? { themeMode: 'dark', themeDark: id } : { themeMode: 'light', themeLight: id }),
        [preset.id, preset.base],
      )
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(preset.id)
      const names = [...READING_SURFACES.map(([n]) => n), ...INK_ORDER.map(([n]) => n), '--color-line']
      const colors = await presetColors(page, names)
      expect(urgencyBreaks(colors)).toEqual([])
      if (preset.id.startsWith('hc-')) {
        // High contrast: every ink clears 4.5:1 and the hairline 3:1, on every reading surface
        for (const [surface] of READING_SURFACES) {
          for (const [ink] of INK_ORDER) expect(contrast(colors[ink]!, colors[surface]!), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
          expect(contrast(colors['--color-line']!, colors[surface]!), `line on ${surface}`).toBeGreaterThanOrEqual(3)
        }
      }
    })
  }
}

export function themeTests() {
  test('Customise copies the showing theme into a file, and editing a token there changes the page live and writes the file', async ({ page }) => {
    await openDemo(page)
    await openAppearance(page)
    expect(await token(page, '--color-surface-floor')).toBe(DARK_FLOOR)

    await page.getByTestId('settings-theme-duplicate').click()
    const row = page.getByTestId('theme-file-dark-copy')
    await expect(row).toBeVisible()
    // The copy is every Dark token spelled out, and it is now the dark side's theme
    const written = JSON.parse((await fileText(page, 'dark-copy'))!)
    expect(written).toMatchObject({ $schema: './theme.schema.json', name: 'Dark copy', base: 'dark' })
    expect(written.tokens['surface-floor']).toBe(DARK_FLOOR)
    await expect(page.getByTestId('settings-theme-dark')).toHaveValue('dark-copy')

    const field = page.getByTestId('theme-token-surface-floor')
    await field.fill('#202830')
    await field.press('Enter')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#202830')
    expect(JSON.parse((await fileText(page, 'dark-copy'))!).tokens['surface-floor']).toBe('#202830')

    // A value the browser rejects is marked and never written
    await field.fill('not a colour')
    await field.press('Enter')
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(JSON.parse((await fileText(page, 'dark-copy'))!).tokens['surface-floor']).toBe('#202830')
  })

  test('a theme file edited by hand updates the page live; a broken save keeps the last good theme and says why', async ({ page }) => {
    await openDemo(page)
    await writeFile(page, 'mine', { name: 'Mine', base: 'dark', tokens: { 'surface-floor': '#101820' } })
    await page.evaluate(() => (window as any).__store.getState().setPrefs({ themeDark: 'mine' }))
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#101820')

    await writeFile(page, 'mine', { name: 'Mine', base: 'dark', tokens: { 'surface-floor': '#182030', ink: '#dddddd' } })
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#182030')
    expect(await token(page, '--color-ink')).toBe('#dddddd')

    // Halfway through an edit: not JSON. The page keeps the last version that read
    await writeFile(page, 'mine', '{ "name": "Mine", "base": "dark", "tokens": { "surface-floor": ')
    await openAppearance(page)
    await expect(page.getByTestId('theme-problems-mine')).toContainText('cannot be read as a theme')
    await expect(page.getByTestId('theme-problems-mine')).toContainText('Not valid JSON')
    expect(await token(page, '--color-surface-floor')).toBe('#182030')

    // Unknown keys and unusable values are reported next to the theme and skipped
    await writeFile(page, 'mine', { name: 'Mine', base: 'dark', sparkle: 1, tokens: { 'surface-floor': '#223344', glitter: '#fff', ink: 'blue-ish' } })
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#223344')
    const problems = page.getByTestId('theme-problems-mine')
    await expect(problems).toContainText('Unknown key "sparkle" is ignored.')
    await expect(problems).toContainText('Unknown token "glitter" is ignored.')
    await expect(problems).toContainText('"blue-ish" is not a usable value for ink')
    // The unusable ink is not applied: the Dark ink stays
    expect(await token(page, '--color-ink')).toBe('#e9e9e9')
  })

  test('the theme choice and the file survive a reload, and the last theme is cached for the first frame', async ({ page }) => {
    await openDemo(page)
    await writeFile(page, 'mine', { name: 'Mine', base: 'dark', tokens: { 'surface-floor': '#101820' } })
    await page.evaluate(() => (window as any).__store.getState().setPrefs({ themeDark: 'mine' }))
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#101820')
    const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('cc-theme') ?? 'null'))
    expect(cached.dark.tokens['--color-surface-floor']).toBe('#101820')

    // On the next load the cached theme is on <html> before the app has asked for anything
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        ;(window as any).__floorAtStart = document.documentElement.style.getPropertyValue('--color-surface-floor')
      })
    })
    await page.reload()
    await expect(page.getByTestId('chat-stream')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__floorAtStart)).toBe('#101820')
    expect(await token(page, '--color-surface-floor')).toBe('#101820')
  })

  test('Follow system switches sides with prefers-color-scheme, and the window is handed back to the OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openDemo(page)
    await writeFile(page, 'paper', { name: 'Paper', base: 'light', tokens: { 'surface-floor': '#fafafa', ink: '#1a1a1a' } })
    await openAppearance(page)
    await page.getByTestId('settings-theme-light').selectOption('paper')
    await page.getByTestId('settings-theme-mode-system').click()
    await expect.poll(() => page.evaluate(() => (window as any).__mock.windowAppearance?.scheme)).toBe(null)
    expect(await token(page, '--color-surface-floor')).toBe(DARK_FLOOR)

    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#fafafa')
    expect(await page.evaluate(() => document.documentElement.dataset.themeBase)).toBe('light')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => token(page, '--color-surface-floor')).toBe(DARK_FLOOR)

    // Held to Dark, the window is told so (and its own background is the floor)
    await page.getByTestId('settings-theme-mode-dark').click()
    await expect.poll(() => page.evaluate(() => (window as any).__mock.windowAppearance)).toEqual({ scheme: 'dark', background: 'rgb(20, 20, 20)' })
  })

  test('the accent colours focus and selection, never the signal', async ({ page }) => {
    await openDemo(page)
    await openAppearance(page)
    const signal = await token(page, '--color-ink-signal')
    await page.getByTestId('settings-accent-toggle').check()
    await expect.poll(() => token(page, '--color-focus')).toBe('#6ea8fe')
    expect(await token(page, '--color-selection')).toContain('#6ea8fe')
    expect(await token(page, '--color-ink-signal')).toBe(signal)
    await page.getByTestId('settings-accent-toggle').uncheck()
    await expect.poll(() => token(page, '--color-focus')).toBe('#909090')
  })

  test('Import copies a theme file in, and Show in Finder reveals one', async ({ page }) => {
    await openDemo(page)
    await page.evaluate(() => {
      const mock = (window as any).__mock as Mock
      mock.themeImportSources.set('/elsewhere/sunset.json', JSON.stringify({ name: 'Sunset', base: 'dark', tokens: { 'surface-floor': '#201010' } }))
      mock.nextPickedFile = '/elsewhere/sunset.json'
    })
    await openAppearance(page)
    await page.getByTestId('settings-theme-import').click()
    await expect(page.getByTestId('theme-file-sunset')).toBeVisible()
    expect(JSON.parse((await fileText(page, 'sunset'))!).tokens['surface-floor']).toBe('#201010')
    await page.getByTestId('settings-theme-dark').selectOption('sunset')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#201010')

    await page.getByTestId('theme-reveal-sunset').click()
    await expect.poll(() => page.evaluate(() => (window as any).__mock.revealedThemes)).toEqual(['sunset'])

    // Delete puts the side back on its preset rather than pointing at nothing
    await page.getByTestId('theme-delete-sunset').click()
    await expect(page.getByTestId('theme-file-sunset')).toHaveCount(0)
    await expect.poll(() => token(page, '--color-surface-floor')).toBe(DARK_FLOOR)
    await expect(page.getByTestId('settings-theme-dark')).toHaveValue('dark')
  })

  test('a theme that breaks the urgency order is flagged next to it', async ({ page }) => {
    await openDemo(page)
    await writeFile(page, 'flat', { name: 'Flat', base: 'dark', tokens: { 'ink-faint': '#ffffff' } })
    await openAppearance(page)
    const warning = page.getByTestId('theme-urgency-flat')
    await expect(warning).toContainText('The urgency order breaks')
    await expect(warning).toContainText('On the floor, background information stands out as much as secondary or more.')

    await writeFile(page, 'flat', { name: 'Flat', base: 'dark', tokens: { 'ink-faint': '#5c5c5c' } })
    await expect(warning).toHaveCount(0)
  })
}
