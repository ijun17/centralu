import { expect, test, type Page } from '@playwright/test'
import { tokenColor } from './tokens.js'
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

const DARK_FLOOR = '#120e0a'
/**
 * The rule for the three lines (docs/themes.md "The lines"): each is checked on the floor, the sidebar and a raised
 * surface, the three grounds a line is drawn on. `line` stays visible but quiet, `line-chrome` is a step stronger, and
 * `line-strong` is clearly stronger again.
 */
const LINE_FLOOR = 1.2
const LINE_CHROME_FLOOR = 1.4
const LINE_STRONG_FLOOR = 1.7
/** How much more contrast each line has than the one below it */
const LINE_STEP = 0.25
/** The least contrast of each ink on a reading surface in every preset; the high-contrast presets hold every ink to 4.5:1 besides */
const INK_FLOORS = [['--color-ink', 7], ['--color-ink-muted', 4.5], ['--color-ink-faint', 3]] as const
const LINE_GROUNDS = ['--color-surface-floor', '--color-surface-side', '--color-surface-raised'] as const

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

/** Picks a theme in Settings → Appearance: the one list of every theme, whose side becomes the mode */
async function pickTheme(page: Page, id: string) {
  await page.getByTestId('settings-theme-pick').selectOption(id)
}

async function prefsOf(page: Page): Promise<{ themeMode: string; themeDark: string; themeLight: string }> {
  return page.evaluate(() => {
    const { themeMode, themeDark, themeLight } = (window as any).__store.getState().prefs
    return { themeMode, themeDark, themeLight }
  })
}

const windowAppearance = (page: Page) => page.evaluate(() => (window as any).__mock.windowAppearance)

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
  // The window's borders are one colour a theme sets (docs/themes.md "The lines"): the top bar's, the sidebar's, a session header's, the evidence panel's edge and header
  const chromeBorders = (page: Page) => [
    [page.getByTestId('app-header'), 'border-bottom-color'],
    [page.getByTestId('sidebar'), 'border-right-color'],
    [page.getByTestId('session-name').locator('..'), 'border-bottom-color'],
    [page.getByTestId('evidence-panel'), 'border-left-color'],
    [page.getByTestId('evidence-project').locator('..'), 'border-bottom-color'],
  ] as const

  test('the window borders are the one colour line-chrome, and a theme file without it gets its own line (#2207)', async ({ page }) => {
    await openDemo(page)
    await expect(page.getByTestId('evidence-panel')).toBeVisible()
    const chrome = await tokenColor(page, '--color-line-chrome')
    expect(chrome).not.toBe(await tokenColor(page, '--color-line'))
    for (const [el, prop] of chromeBorders(page)) await expect(el).toHaveCSS(prop, chrome)

    // A file that sets only `line`: the window borders follow that line, nothing of the preset's chrome colour is mixed in
    await writeFile(page, 'mine', { name: 'Mine', base: 'dark', tokens: { line: '#aa0000' } })
    await page.evaluate(() => (window as any).__store.getState().setPrefs({ themeMode: 'dark', themeDark: 'mine' }))
    await expect.poll(() => token(page, '--color-line')).toBe('#aa0000')
    for (const [el, prop] of chromeBorders(page)) await expect(el).toHaveCSS(prop, 'rgb(170, 0, 0)')

    // A file that sets the token wins
    await writeFile(page, 'mine', { name: 'Mine', base: 'dark', tokens: { line: '#aa0000', 'line-chrome': '#00aa00' } })
    for (const [el, prop] of chromeBorders(page)) await expect(el).toHaveCSS(prop, 'rgb(0, 170, 0)')
  })

  test('Picking Light shows the Light preset, and the window and color-scheme follow', async ({ page }) => {
    await openDemo(page)
    await openAppearance(page)
    await pickTheme(page, 'light')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#f0f0f0')
    expect(await token(page, '--color-ink-signal')).toBe('#111111')
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')
    await expect.poll(() => windowAppearance(page)).toEqual({ scheme: 'light', background: 'rgb(240, 240, 240)' })
    // The conversation is on the floor, as in Dark (#362)
    expect(await page.getByTestId('session-view').evaluate((el) => getComputedStyle(el).getPropertyValue('--color-surface-floor').trim())).toBe('#f0f0f0')
    // The pick is the mode and that side's theme, so the stored preferences keep their shape
    expect(await prefsOf(page)).toMatchObject({ themeMode: 'light', themeLight: 'light' })
  })

  test('the app does not follow the OS: a light OS leaves Dark, a stored System reads as Dark, and a picked light theme is held whatever the OS says', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await openDemo(page)
    expect(await token(page, '--color-surface-floor')).toBe(DARK_FLOOR)
    expect(await page.evaluate(() => document.documentElement.dataset.themeBase)).toBe('dark')

    // A `system` an older build stored, with a light theme chosen for the light side: still Dark, and the window is held to Dark (not handed back to the OS)
    await page.evaluate(() => (window as any).__store.getState().setPrefs({ themeMode: 'system', themeLight: 'hc-light' }))
    await expect.poll(() => windowAppearance(page)).toEqual({ scheme: 'dark', background: 'rgb(18, 14, 10)' })
    expect(await token(page, '--color-surface-floor')).toBe(DARK_FLOOR)

    // Picking the light theme is what sets the light side
    await openAppearance(page)
    await expect(page.getByTestId('settings-theme-pick')).toHaveValue('dark')
    await pickTheme(page, 'hc-light')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#ffffff')
    expect(await token(page, '--color-line')).toBe('#767676')
    expect(await prefsOf(page)).toMatchObject({ themeMode: 'light', themeLight: 'hc-light' })

    // And an OS gone dark does not take it away
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)))
    expect(await token(page, '--color-surface-floor')).toBe('#ffffff')
    expect(await windowAppearance(page)).toMatchObject({ scheme: 'light' })
  })

  test('Graphite is in the theme list as a dark theme, and picking it shows its floor and keeps Dark the default (#2208)', async ({ page }) => {
    await openDemo(page)
    expect(await token(page, '--color-surface-floor')).toBe(DARK_FLOOR)
    await openAppearance(page)
    const pick = page.getByTestId('settings-theme-pick')
    await expect(pick.locator('option[value="graphite"]')).toHaveText('Graphite')
    await pickTheme(page, 'graphite')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#1d1d1d')
    expect(await token(page, '--color-surface-side')).toBe('#28282a')
    expect(await prefsOf(page)).toMatchObject({ themeMode: 'dark', themeDark: 'graphite' })
    expect(await page.evaluate(() => document.documentElement.dataset.themeBase)).toBe('dark')
  })

  // #2214 (owner, 2026-11-12): a custom theme's id is made from its name, and never a preset's, so both stay selectable
  test('a custom theme named like a preset gets its own id; both are in the picker, and each applies its own tokens (#2214)', async ({ page }) => {
    await openDemo(page)
    const saved = await page.evaluate(() =>
      (window as any).__store.getState().platform.themes.save(null, { name: 'Graphite', base: 'dark', tokens: { 'surface-floor': '#223344' } }),
    )
    expect(saved.id).toBe('graphite-2')
    await openAppearance(page)
    const pick = page.getByTestId('settings-theme-pick')
    await expect(pick.locator('option[value="graphite"]')).toHaveText('Graphite')
    await expect(pick.locator('option[value="graphite-2"]')).toHaveText('Graphite')

    await pickTheme(page, 'graphite')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#1d1d1d')
    await pickTheme(page, 'graphite-2')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#223344')
    expect(await prefsOf(page)).toMatchObject({ themeDark: 'graphite-2' })
    await pickTheme(page, 'graphite')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#1d1d1d')
  })

  test('a theme file stored under a preset id before then keeps working, listed once as the custom theme it is (#2214)', async ({ page }) => {
    await openDemo(page)
    await writeFile(page, 'dark', { name: 'My dark', base: 'dark', tokens: { 'surface-floor': '#101820' } })
    await openAppearance(page)
    const pick = page.getByTestId('settings-theme-pick')
    await expect(pick.locator('option[value="dark"]')).toHaveText('My dark')
    await expect(pick.locator('option[value="dark"]')).toHaveCount(1)
    await pickTheme(page, 'dark')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#101820')
  })

  for (const preset of THEME_PRESETS) {
    test(`${preset.name} keeps the urgency order on every reading surface`, async ({ page }) => {
      await openDemo(page)
      await page.evaluate(
        ([id, base]) => (window as any).__store.getState().setPrefs(base === 'dark' ? { themeMode: 'dark', themeDark: id } : { themeMode: 'light', themeLight: id }),
        [preset.id, preset.base],
      )
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(preset.id)
      const names = [...READING_SURFACES.map(([n]) => n), ...INK_ORDER.map(([n]) => n), '--color-line', '--color-line-chrome', '--color-line-strong']
      const colors = await presetColors(page, names)
      expect(urgencyBreaks(colors)).toEqual([])
      // Every ink keeps a floor of its own on every reading surface, the ones Dark's inks keep, so no preset's quieter inks sink (#2208)
      for (const [surface] of READING_SURFACES) {
        for (const [ink, floor] of INK_FLOORS) expect(contrast(colors[ink]!, colors[surface]!), `${ink} on ${surface}`).toBeGreaterThanOrEqual(floor)
      }
      for (const surface of LINE_GROUNDS) {
        const [line, side, strong] = ['--color-line', '--color-line-chrome', '--color-line-strong'].map((n) => contrast(colors[n]!, colors[surface]!)) as [number, number, number]
        expect(line, `line on ${surface}`).toBeGreaterThanOrEqual(LINE_FLOOR)
        expect(side, `line-chrome on ${surface}`).toBeGreaterThanOrEqual(LINE_CHROME_FLOOR)
        expect(strong, `line-strong on ${surface}`).toBeGreaterThanOrEqual(LINE_STRONG_FLOOR)
        expect(side - line, `line-chrome over line on ${surface}`).toBeGreaterThanOrEqual(0)
        expect(strong - side, `line-strong over line-chrome on ${surface}`).toBeGreaterThanOrEqual(LINE_STEP)
      }
      if (preset.id.startsWith('hc-')) {
        // High contrast: every ink clears 4.5:1 and the hairline 3:1, on every reading surface
        for (const [surface] of READING_SURFACES) {
          for (const [ink] of INK_ORDER) expect(contrast(colors[ink]!, colors[surface]!), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
          expect(contrast(colors['--color-line']!, colors[surface]!), `line on ${surface}`).toBeGreaterThanOrEqual(3)
          expect(contrast(colors['--color-line-chrome']!, colors[surface]!), `line-chrome on ${surface}`).toBeGreaterThanOrEqual(3)
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
    await expect(page.getByTestId('settings-theme-pick')).toHaveValue('dark-copy')

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

  test('a theme renamed by hand while its editor is open keeps the new name when the name field is left', async ({ page }) => {
    await openDemo(page)
    await writeFile(page, 'mine', { name: 'Mine', base: 'dark', tokens: {} })
    await openAppearance(page)
    await page.getByTestId('theme-edit-mine').click()
    const name = page.getByTestId('theme-name-mine')
    await expect(name).toHaveValue('Mine')

    await writeFile(page, 'mine', { name: 'Renamed', base: 'dark', tokens: {} })
    await expect(name).toHaveValue('Renamed')
    // Focusing the field and leaving it must not write the old name back over the edit
    await name.click()
    await name.press('Tab')
    await page.evaluate(() => new Promise((r) => setTimeout(r, 100)))
    expect(JSON.parse((await fileText(page, 'mine'))!).name).toBe('Renamed')
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
    expect(await token(page, '--color-ink')).toBe('#f0ecea')
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

  test('a custom theme whose file is broken when the window starts keeps its floor instead of falling to Dark', async ({ page }) => {
    await openDemo(page)
    await writeFile(page, 'mine', { name: 'Mine', base: 'dark', tokens: { 'surface-floor': '#101820' } })
    await page.evaluate(() => (window as any).__store.getState().setPrefs({ themeDark: 'mine' }))
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#101820')
    // Half edited, then the window starts: no clean version of the file has been read in this page yet
    await writeFile(page, 'mine', '{ "name": "Mine", "base": "dark", "tokens": { "surface-floor": ')
    await page.reload()
    await expect(page.getByTestId('chat-stream')).toBeVisible()
    expect(await token(page, '--color-surface-floor')).toBe('#101820')
    const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('cc-theme') ?? 'null'))
    expect(cached.dark).toMatchObject({ id: 'mine', tokens: { '--color-surface-floor': '#101820' } })
  })

  test('a light theme file picked in Settings sets the light side and tells the window; picking Dark again takes it back, whatever the OS says', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openDemo(page)
    await writeFile(page, 'paper', { name: 'Paper', base: 'light', tokens: { 'surface-floor': '#fafafa', ink: '#1a1a1a' } })
    await openAppearance(page)
    expect(await token(page, '--color-surface-floor')).toBe(DARK_FLOOR)

    await pickTheme(page, 'paper')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#fafafa')
    expect(await page.evaluate(() => document.documentElement.dataset.themeBase)).toBe('light')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')
    expect(await prefsOf(page)).toMatchObject({ themeMode: 'light', themeLight: 'paper' })
    await expect.poll(() => windowAppearance(page)).toEqual({ scheme: 'light', background: 'rgb(250, 250, 250)' })

    // Picked back to Dark, the window is told so (and its own background is the floor); the light side keeps its theme
    await pickTheme(page, 'dark')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe(DARK_FLOOR)
    await expect.poll(() => windowAppearance(page)).toEqual({ scheme: 'dark', background: 'rgb(18, 14, 10)' })
    expect(await prefsOf(page)).toMatchObject({ themeMode: 'dark', themeDark: 'dark', themeLight: 'paper' })
  })

  test('there is no accent: Settings offers none, and one an older build stored colours neither focus nor selection', async ({ page }) => {
    await openDemo(page)
    await openAppearance(page)
    await expect(page.getByTestId('settings-accent-toggle')).toHaveCount(0)
    const focus = await token(page, '--color-focus')
    const selection = await token(page, '--color-selection')
    await page.evaluate(() => (window as any).__store.getState().setPrefs({ accent: '#6ea8fe' }))
    // Theme changes go through the same path an accent would; let one land each way, then read
    await pickTheme(page, 'light')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#f0f0f0')
    await pickTheme(page, 'dark')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe(DARK_FLOOR)
    expect(await token(page, '--color-focus')).toBe(focus)
    expect(await token(page, '--color-selection')).toBe(selection)
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
    await pickTheme(page, 'sunset')
    await expect.poll(() => token(page, '--color-surface-floor')).toBe('#201010')

    await page.getByTestId('theme-reveal-sunset').click()
    await expect.poll(() => page.evaluate(() => (window as any).__mock.revealedThemes)).toEqual(['sunset'])

    // Delete puts the side back on its preset rather than pointing at nothing
    await page.getByTestId('theme-delete-sunset').click()
    await expect(page.getByTestId('theme-file-sunset')).toHaveCount(0)
    await expect.poll(() => token(page, '--color-surface-floor')).toBe(DARK_FLOOR)
    await expect(page.getByTestId('settings-theme-pick')).toHaveValue('dark')
  })

  test('a theme that breaks the urgency order is flagged next to it', async ({ page }) => {
    await openDemo(page)
    await writeFile(page, 'flat', { name: 'Flat', base: 'dark', tokens: { 'ink-faint': '#ffffff' } })
    await openAppearance(page)
    const warning = page.getByTestId('theme-urgency-flat')
    await expect(warning).toContainText('The urgency order breaks')
    await expect(warning).toContainText('On the floor, background information stands out as much as secondary or more.')

    await writeFile(page, 'flat', { name: 'Flat', base: 'dark', tokens: { 'ink-faint': '#707070' } })
    await expect(warning).toHaveCount(0)
  })
}
