import { expect, test, type Page } from '@playwright/test'

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
