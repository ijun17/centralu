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
const LIGHT = { floor: '#f2f2f2', ink: 'rgb(31, 31, 31)', signal: 'rgb(0, 0, 0)', danger: 'rgb(207, 34, 46)', thumb: 'rgb(207, 207, 207)' }

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
    expect(changed.centralu.variables).toMatchObject({ '--centralu-signal': '#000000', '--centralu-scrollbar-thumb': '#cfcfcf' })
    // Nothing that did not change goes out again
    expect(changed).not.toHaveProperty('locale')

    await showTheme(page, 'dark')
    await expect.poll(async () => (await entries(v, 'host-context-changed')).map((c) => c.theme)).toEqual(['light', 'dark'])
    // The same document all along: it connected once, and the frame never reloaded
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

  test('on a light theme a view stays transparent on Centralu\'s background', async ({ page }) => {
    await showTheme(page, 'light')
    await mount(page, 'counter', 'ui://counter/main')
    const v = view(page)
    await expect.poll(() => schemeOf(v)).toBe('light')
    await expect(v.locator('#count')).toBeVisible()
    const { inside, outside } = await insideAndOutside(page)
    expect(outside, `page rgb(${outside.join(', ')})`).toEqual([242, 242, 242])
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
