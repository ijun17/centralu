import { inflateSync } from 'node:zlib'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { appScreenHtml, fixtureViewHtml, startFixtureHost, type FixtureHost } from './app-views.js'

/**
 * The theme reaching app views (#312 step 6), run in Chromium (app-theme.spec.ts) and WebKit
 * (app-theme-webkit.spec.ts).
 *
 * An AppFrame stands alone on the test-bed page (`/app-frame.html`, as in app-frame.spec.ts), with
 * the real host's sandbox proxy behind it. Three screens: the fixture view, which logs every host
 * context it receives; the app template's real `ui/index.html`; and the project-board app's. A
 * theme is switched the way app/theme.ts does it — `data-theme` and `data-theme-base` on `<html>`,
 * then `cc-themechange` — so the stylesheet's presets are what the view is told about.
 */

const TEMPLATE = new URL('../../packages/agent-host/app-template/', import.meta.url)
const BOARD = new URL('../../.centralu/apps/project-board/', import.meta.url)

/** Dark and Light values from styles/index.css, as the browser computes them */
const DARK = { floor: '#141414', ink: 'rgb(233, 233, 233)', signal: 'rgb(255, 255, 255)', danger: 'rgb(255, 161, 152)', thumb: 'rgb(41, 41, 41)' }
const LIGHT = { floor: '#e8e8e8', ink: 'rgb(31, 31, 31)', signal: 'rgb(0, 0, 0)', danger: 'rgb(207, 34, 46)', thumb: 'rgb(197, 197, 197)' }

/** A board with more cards than its column can show, so the column scrolls */
const BOARD_STATE = {
  ok: true,
  project: { title: 'Centralu', url: 'https://example.test/project', number: 1, owner: 'someone' },
  fetchedAt: '2026-10-05T09:00:00Z',
  options: { area: ['ui'], priority: ['High'] },
  columns: ['Needs decision', 'In progress', 'Done'],
  decisionStatus: 'Needs decision',
  items: Array.from({ length: 14 }, (_, i) => ({
    itemId: `item-${i}`,
    status: 'Needs decision',
    priority: 'High',
    area: 'ui',
    number: i + 1,
    title: `Item ${i + 1}`,
    url: `https://example.test/issues/${i + 1}`,
    type: 'issue',
    draft: false,
    repository: 'someone/centralu',
  })),
}

let fx: FixtureHost

async function showTheme(page: Page, side: 'dark' | 'light') {
  await page.evaluate((s) => {
    const root = document.documentElement
    root.dataset.theme = s
    root.dataset.themeBase = s
    window.dispatchEvent(new CustomEvent('cc-themechange'))
  }, side)
}

async function mount(page: Page, appId: string, uri: string) {
  const instanceId = fx.open({ projectId: null, appId }, uri)
  await page.evaluate((p) => (window as any).__appFrame.mount('a', p), { appId, projectId: null, instanceId })
  await expect(page.getByTestId('frame-a').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
}

/** The inner frame the app's HTML runs in (the outer one is the proxy) */
function view(page: Page): FrameLocator {
  return page.getByTestId('frame-a').getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
}

/** Every line the fixture view logged under one key, as JSON */
async function entries(v: FrameLocator, k: string): Promise<any[]> {
  return v.locator(`li[data-k="${k}"]`).evaluateAll((lis, key) => lis.map((li) => JSON.parse(li.textContent!.slice(key.length + 1))), k)
}

const thumb = (v: FrameLocator, selector: string) => v.locator(selector).first().evaluate((el) => getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor)
const colorOf = (v: FrameLocator, selector: string) => v.locator(selector).first().evaluate((el) => getComputedStyle(el).color)
const schemeOf = (v: FrameLocator) => v.locator('html').evaluate((el) => getComputedStyle(el).colorScheme)

/** The colour of one point on screen, from a 1×1 screenshot (a one-row PNG: a filter byte, then R, G, B, A) */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
  const idat: Buffer[] = []
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at)
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  return [raw[1]!, raw[2]!, raw[3]!]
}

/** A spot of the view where the template draws nothing (its right edge, half-way down), and the page just left of the frame */
async function insideAndOutside(page: Page) {
  const box = (await page.getByTestId('frame-a').getByTestId('app-frame-iframe').boundingBox())!
  const y = Math.round(box.y + box.height / 2)
  return { inside: await pixel(page, Math.round(box.x + box.width - 12), y), outside: await pixel(page, Math.round(box.x - 4), y) }
}

/** A board with items in every column, each title long enough to wrap in a narrow view */
const BOARD_SPREAD = {
  ...BOARD_STATE,
  columns: ['Needs decision', 'In progress', 'In review', 'On hold', 'Done'],
  items: ['Needs decision', 'In progress', 'In review', 'On hold', 'Done'].flatMap((status, c) =>
    [0, 1].map((n) => ({
      ...BOARD_STATE.items[0]!,
      itemId: `spread-${c}-${n}`,
      status,
      number: 100 + c * 10 + n,
      title: `A longer item title in ${status} that has to wrap inside a narrow panel ${n}`,
    })),
  ),
}

async function showPreset(page: Page, preset: string, side: 'dark' | 'light') {
  await page.evaluate(
    ([p, s]) => {
      const root = document.documentElement
      root.dataset.theme = p
      root.dataset.themeBase = s
      window.dispatchEvent(new CustomEvent('cc-themechange'))
    },
    [preset, side],
  )
}

async function showBoard(page: Page, state: unknown = BOARD_STATE) {
  await page.evaluate((st) => {
    ;(window as any).__mock.appToolHandler = async () => ({ content: [{ type: 'text', text: 'board' }], structuredContent: st })
  }, state)
  await mount(page, 'project-board', 'ui://project-board/index.html')
}

/** Centralu's own tokens as the host page computes them, in the form the view's computed style reports */
async function hostValues(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    document.body.appendChild(probe)
    const color = (token: string) => ((probe.style.color = `var(${token})`), getComputedStyle(probe).color)
    const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const out = {
      ink: color('--color-ink'),
      muted: color('--color-ink-muted'),
      signal: color('--color-ink-signal'),
      line: color('--color-line'),
      radiusSm: token('--radius-sm'),
      radiusMd: token('--radius-md'),
      radiusLg: token('--radius-lg'),
      textMd: token('--text-md'),
      textSm: token('--text-sm'),
    }
    probe.remove()
    return out
  })
}

const styleOf = (v: FrameLocator, selector: string, prop: 'fontFamily' | 'fontSize' | 'lineHeight' | 'borderTopColor' | 'borderTopLeftRadius') =>
  v.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], prop)

export function appThemeTests() {
  test.beforeAll(async () => {
    fx = await startFixtureHost({
      'fixture ui://fixture/main': { html: fixtureViewHtml() },
      'counter ui://counter/main': { html: appScreenHtml(TEMPLATE, { '{{APP_ID}}': 'counter', '{{APP_NAME}}': 'Counter' }) },
      'project-board ui://project-board/index.html': { html: appScreenHtml(BOARD) },
    })
  })

  test.afterAll(async () => {
    await fx?.close()
  })

  test.beforeEach(async ({ page }) => {
    await page.exposeFunction('__viewFrame', (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
      fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
    )
    await page.goto('/app-frame.html')
    await page.waitForFunction(() => !!(window as any).__appFrame)
  })

  test('a view receives every style variable, the real theme and Centralu\'s own variables, and a theme switch reaches it without a reload', async ({ page }) => {
    await mount(page, 'fixture', 'ui://fixture/main')
    const v = view(page)
    const [connected] = await entries(v, 'connected')
    const ctx = connected.hostContext
    expect(ctx.theme).toBe('dark')
    expect(Object.keys(ctx.styles.variables)).toHaveLength(76)
    expect(ctx.styles.variables).toMatchObject({
      '--color-background-primary': DARK.floor,
      '--color-text-primary': '#e9e9e9',
      // The signal colour, "waiting for you", is the standard's warning (#312 decision 5)
      '--color-text-warning': '#ffffff',
      '--color-text-danger': '#ffa198',
      '--font-text-md-size': '13px',
      '--border-radius-md': '4px',
    })
    expect(ctx.centralu.variables).toMatchObject({ '--centralu-signal': '#ffffff', '--centralu-scrollbar-thumb': '#292929', '--centralu-scrollbar-size': '10px' })

    await showTheme(page, 'light')
    await expect.poll(async () => (await entries(v, 'host-context-changed')).length).toBe(1)
    const [changed] = await entries(v, 'host-context-changed')
    expect(changed.theme).toBe('light')
    expect(changed.styles.variables).toMatchObject({ '--color-background-primary': LIGHT.floor, '--color-text-primary': '#1f1f1f', '--color-text-warning': '#000000' })
    expect(changed.centralu.variables).toMatchObject({ '--centralu-signal': '#000000', '--centralu-scrollbar-thumb': '#c5c5c5' })
    // Nothing that did not change goes out again
    expect(changed).not.toHaveProperty('locale')

    await showTheme(page, 'dark')
    await expect.poll(async () => (await entries(v, 'host-context-changed')).map((c) => c.theme)).toEqual(['light', 'dark'])
    // The same document all along: it connected once, and the frame never reloaded
    expect(await entries(v, 'connected')).toHaveLength(1)
  })

  test('the body and code fonts and the line height reach a view, and a change is sent to it without a reload (#312 step 5)', async ({ page }) => {
    await mount(page, 'fixture', 'ui://fixture/main')
    const v = view(page)
    const [connected] = await entries(v, 'connected')
    // The defaults are the stylesheet's own values
    expect(connected.hostContext.styles.variables['--font-sans']).toContain('Apple SD Gothic Neo')
    expect(connected.hostContext.styles.variables['--font-text-md-line-height']).toBe('1.65')

    await page.evaluate(() => (window as any).__typography({ bodyFont: 'Inter', codeFont: 'JetBrains Mono', lineHeight: 'relaxed' }))
    await expect.poll(async () => (await entries(v, 'host-context-changed')).length).toBe(1)
    const [changed] = await entries(v, 'host-context-changed')
    const vars = changed.styles.variables
    // The picked font goes first, and the app's own stack stays behind it (the Korean fallback)
    expect(vars['--font-sans']).toMatch(/^"Inter", -apple-system/)
    expect(vars['--font-sans']).toContain('Apple SD Gothic Neo')
    expect(vars['--font-mono']).toMatch(/^"JetBrains Mono", ui-monospace/)
    expect(vars['--font-text-md-line-height']).toBe('1.848')
    // Headings keep the tight line height
    expect(vars['--font-heading-md-line-height']).toBe('1.3')
    expect(await entries(v, 'connected')).toHaveLength(1)
  })

  test('the template applies what it receives: its colours, the danger colour and the scrollbar follow the theme', async ({ page }) => {
    await mount(page, 'counter', 'ui://counter/main')
    const v = view(page)
    await expect.poll(() => schemeOf(v)).toBe('dark')
    expect(await colorOf(v, 'body')).toBe(DARK.ink)
    expect(await thumb(v, 'html')).toBe(DARK.thumb)

    await showTheme(page, 'light')
    await expect.poll(() => schemeOf(v)).toBe('light')
    expect(await colorOf(v, 'body')).toBe(LIGHT.ink)
    expect(await colorOf(v, '.error')).toBe(LIGHT.danger)
    expect(await thumb(v, 'html')).toBe(LIGHT.thumb)
    expect(await v.locator('html').evaluate((el) => getComputedStyle(el, '::-webkit-scrollbar').width)).toBe('10px')

    // A custom theme's scrollbar is the template's scrollbar too: the value comes from the token, not a fallback
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--color-scrollbar-thumb', 'rgb(1, 2, 3)')
      window.dispatchEvent(new CustomEvent('cc-themechange'))
    })
    await expect.poll(() => thumb(v, 'html')).toBe('rgb(1, 2, 3)')
  })

  test('the project board follows light and dark: the signal column, its colour scheme and its scrollbars', async ({ page }) => {
    await page.evaluate((state) => {
      ;(window as any).__mock.appToolHandler = async () => ({ content: [{ type: 'text', text: 'board' }], structuredContent: state })
    }, BOARD_STATE)
    await mount(page, 'project-board', 'ui://project-board/index.html')
    const v = view(page)
    await expect(v.locator('.column.decision .card')).toHaveCount(BOARD_STATE.items.length)
    await expect.poll(() => schemeOf(v)).toBe('dark')
    expect(await colorOf(v, '.column.decision .col-head')).toBe(DARK.signal)
    expect(await thumb(v, '.cards')).toBe(DARK.thumb)

    await showTheme(page, 'light')
    await expect.poll(() => schemeOf(v)).toBe('light')
    // The one column waiting on the owner keeps the signal: pure black on light
    expect(await colorOf(v, '.column.decision .col-head')).toBe(LIGHT.signal)
    expect(await colorOf(v, '.card .title')).toBe(LIGHT.ink)
    expect(await thumb(v, '.cards')).toBe(LIGHT.thumb)
    expect(await thumb(v, '.board')).toBe(LIGHT.thumb)
  })

  test('the template takes its type and shape from the theme: its display size, and a changed font, line height and radius', async ({ page }) => {
    await mount(page, 'counter', 'ui://counter/main')
    const v = view(page)
    await expect(v.locator('#count')).toBeVisible()
    await expect.poll(() => styleOf(v, 'button', 'borderTopLeftRadius')).toBe('4px')
    // The count is the standard's 2xl heading (hostStyles.ts writes 28px), not a size of its own
    expect(await styleOf(v, '#count', 'fontSize')).toBe('28px')
    await page.evaluate(() => {
      const root = document.documentElement.style
      root.setProperty('--font-sans', '"Inter", -apple-system, sans-serif')
      root.setProperty('--leading-body', '1.452')
      root.setProperty('--radius-md', '6px')
      window.dispatchEvent(new CustomEvent('cc-themechange'))
    })
    await expect.poll(() => styleOf(v, 'body', 'fontFamily')).toMatch(/^"?Inter"?,/)
    // 13px x 1.452
    expect(parseFloat(await styleOf(v, 'body', 'lineHeight'))).toBeCloseTo(18.876, 2)
    expect(await styleOf(v, 'button', 'borderTopLeftRadius')).toBe('6px')
  })

  for (const [preset, side] of [['dark', 'dark'], ['light', 'light'], ['hc-dark', 'dark'], ['hc-light', 'light']] as const) {
    test(`the project board takes its colours, type and shape from the theme: ${preset}`, async ({ page }) => {
      await showBoard(page)
      const v = view(page)
      await showPreset(page, preset, side)
      await expect.poll(() => schemeOf(v)).toBe(side)
      const want = await hostValues(page)
      await expect.poll(() => colorOf(v, '.card .title')).toBe(want.ink)
      expect(await colorOf(v, '.column.decision .col-head')).toBe(want.signal)
      expect(await colorOf(v, '.column:not(.decision) .col-head')).toBe(want.muted)
      expect(await styleOf(v, '.card', 'borderTopColor')).toBe(want.line)
      expect(await styleOf(v, '.card', 'borderTopLeftRadius')).toBe(want.radiusMd)
      expect(await styleOf(v, '.column', 'borderTopLeftRadius')).toBe(want.radiusLg)
      expect(await styleOf(v, '.tag', 'borderTopLeftRadius')).toBe(want.radiusSm)
      expect(await styleOf(v, 'body', 'fontSize')).toBe(want.textMd)
      expect(await styleOf(v, '.meta', 'fontSize')).toBe(want.textSm)
    })
  }

  test('the project board follows a changed font, line height and shape without a reload', async ({ page }) => {
    await showBoard(page)
    const v = view(page)
    await expect(v.locator('.card').first()).toBeVisible()
    // What Settings → Appearance writes on the root (app/typography.ts), and a custom theme's radius
    await page.evaluate(() => {
      const root = document.documentElement.style
      root.setProperty('--font-sans', '"Inter", -apple-system, sans-serif')
      root.setProperty('--font-mono', '"Iosevka Term", ui-monospace, monospace')
      root.setProperty('--leading-body', '1.848')
      root.setProperty('--radius-md', '6px')
      window.dispatchEvent(new CustomEvent('cc-themechange'))
    })
    await expect.poll(() => styleOf(v, 'body', 'fontFamily')).toMatch(/^"?Inter"?,/)
    expect(await styleOf(v, '.num', 'fontFamily')).toMatch(/^"?Iosevka Term"?,/)
    // 13px x 1.848
    expect(parseFloat(await styleOf(v, 'body', 'lineHeight'))).toBeCloseTo(24.024, 2)
    expect(await styleOf(v, '.card', 'borderTopLeftRadius')).toBe('6px')
    expect(await styleOf(v, '#refresh', 'borderTopLeftRadius')).toBe('6px')
  })

  test('in a panel-narrow view the board stacks its columns: nothing overflows sideways and every card reads in full', async ({ page }) => {
    // A grid panel is about 360-480px wide; the harness frame is the page width less 32px of padding
    await page.setViewportSize({ width: 412, height: 900 })
    await showBoard(page, BOARD_SPREAD)
    const v = view(page)
    await expect(v.locator('.column')).toHaveCount(BOARD_SPREAD.columns.length)
    const layout = await v.locator('body').evaluate(() => {
      const board = document.querySelector('.board')!
      const header = document.querySelector('header')!
      const cols = [...document.querySelectorAll('.column')].map((c) => c.getBoundingClientRect())
      const titles = [...document.querySelectorAll('.card .title')].map((t) => ({ sw: t.scrollWidth, cw: t.clientWidth, right: t.getBoundingClientRect().right }))
      return {
        width: document.documentElement.clientWidth,
        boardOverflow: board.scrollWidth - board.clientWidth,
        headerOverflow: header.scrollWidth - header.clientWidth,
        lefts: [...new Set(cols.map((c) => Math.round(c.left)))],
        widths: cols.map((c) => Math.round(c.width)),
        tops: cols.map((c) => Math.round(c.top)),
        titles,
      }
    })
    expect(layout.width).toBeLessThan(400)
    expect(layout.boardOverflow).toBeLessThanOrEqual(0)
    expect(layout.headerOverflow).toBeLessThanOrEqual(0)
    // One column under another, each as wide as the board allows
    expect(layout.lefts).toHaveLength(1)
    for (const w of layout.widths) expect(w).toBeGreaterThan(layout.width - 40)
    expect(layout.tops).toEqual([...layout.tops].sort((a, b) => a - b))
    for (const t of layout.titles) expect(t.right).toBeLessThanOrEqual(layout.width)
    // The decision column is still first
    expect(await v.locator('.column').first().getAttribute('class')).toContain('decision')
  })

  test('in a panel-narrow view a tab per status jumps to that section, and the tab of the section in view follows the scroll', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 900 })
    await page.evaluate((st) => {
      ;(window as any).__mock.appToolHandler = async () => ({ content: [{ type: 'text', text: 'board' }], structuredContent: st })
    }, BOARD_SPREAD)
    // A panel's view: it fills a slot of fixed height, so the stacked board scrolls inside it
    const instanceId = fx.open({ projectId: null, appId: 'project-board' }, 'ui://project-board/index.html')
    await page.evaluate((p) => (window as any).__appFrame.mount('a', p), { appId: 'project-board', projectId: null, instanceId, fill: true, className: 'flex flex-col' })
    await page.getByTestId('frame-a').getByTestId('app-frame').evaluate((el: HTMLElement) => (el.style.height = '480px'))
    await expect(page.getByTestId('frame-a').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const v = view(page)
    await expect(v.locator('.column')).toHaveCount(BOARD_SPREAD.columns.length)

    const tabs = v.locator('#tabs .tab')
    await expect(tabs).toHaveText(BOARD_SPREAD.columns.map((c) => `${c}2`))
    await expect(v.locator('#tabs')).toBeVisible()
    const current = () => v.locator('#tabs .tab[aria-current]').getAttribute('data-status')
    await expect.poll(current).toBe('Needs decision')

    /** How far a section's top sits below where the first one stands unscrolled */
    const offset = (status: string) =>
      v.locator('body').evaluate((_, s) => {
        const board = document.querySelector('.board')!
        const pad = parseFloat(getComputedStyle(board).paddingTop)
        const col = document.querySelector(`.column[data-status="${s}"]`)!
        return Math.round(col.getBoundingClientRect().top - board.getBoundingClientRect().top - pad)
      }, status)

    // A tab brings its section to the top, and is the one marked
    await v.locator('#tabs .tab[data-status="In review"]').click()
    await expect.poll(async () => Math.abs(await offset('In review'))).toBeLessThanOrEqual(1)
    await expect.poll(current).toBe('In review')

    // Reachable from the keyboard: Tab onto the next tab, Enter
    await v.locator('#tabs .tab[data-status="In review"]').focus()
    await page.keyboard.press('Tab')
    await expect(v.locator('#tabs .tab[data-status="On hold"]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => Math.abs(await offset('On hold'))).toBeLessThanOrEqual(1)
    await expect.poll(current).toBe('On hold')

    // Scrolling by hand moves the mark with the section in view
    await v.locator('.board').hover()
    await page.mouse.wheel(0, -100000)
    await expect.poll(current).toBe('Needs decision')
    const inProgress = await offset('In progress')
    await page.mouse.wheel(0, inProgress + 4)
    await expect.poll(current).toBe('In progress')

    // The wide layout has no tabs
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(v.locator('#tabs')).toBeHidden()
  })

  test('on a light theme a view stays transparent on Centralu\'s background', async ({ page }) => {
    await showTheme(page, 'light')
    await mount(page, 'counter', 'ui://counter/main')
    const v = view(page)
    await expect.poll(() => schemeOf(v)).toBe('light')
    await expect(v.locator('#count')).toBeVisible()
    const { inside, outside } = await insideAndOutside(page)
    expect(outside, `page rgb(${outside.join(', ')})`).toEqual([232, 232, 232])
    // Neither a dark canvas from a proxy stuck on dark nor a white one: exactly the page under it
    expect(inside, `frame rgb(${inside.join(', ')})`).toEqual(outside)
  })
}

/**
 * WebKit repaints a frame's backdrop when the schemes come apart after the first paint (Chromium
 * decides it once, at load), so only WebKit can show a switch leaving an opaque rectangle behind.
 */
export function liveTransparencyTest() {
  test('a theme switch with a view open keeps it transparent, both ways', async ({ page }) => {
    await mount(page, 'counter', 'ui://counter/main')
    const v = view(page)
    await expect(v.locator('#count')).toBeVisible()
    await expect.poll(() => schemeOf(v)).toBe('dark')
    for (const side of ['light', 'dark'] as const) {
      await showTheme(page, side)
      await expect.poll(() => schemeOf(v)).toBe(side)
      await expect
        .poll(async () => {
          const { inside, outside } = await insideAndOutside(page)
          return inside.join(',') === outside.join(',') ? 'transparent' : `frame rgb(${inside.join(', ')}) on page rgb(${outside.join(', ')})`
        })
        .toBe('transparent')
    }
  })
}
