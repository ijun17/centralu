import { expect, test, type Page } from '@playwright/test'

/**
 * The border of a panel that is mid-response shows **on all four sides**, no matter the window
 * width (#208).
 *
 * Depending on window width, a panel's width and position can land on fractional pixels, and on
 * such a panel one side of the ring used to disappear. Measured by sweeping the width 1px at a
 * time (3, 4, 6, and 9 panels; 1x and 2x device scale; text scale 1 and 1.1):
 *  - Chromium never dimmed, not once.
 *  - At 1x on WebKit, for the middle-column panel of a three-column grid, at every width where
 *    that panel starts at x.328 — one window width in three (1401, 1404, …, 1500, 1701, …) —
 *    **the entire right side vanished.** Not dimmed, zero: only the panel's gray border and the
 *    panel floor were left in its place. Both the spinning rainbow and the stationary gray broke
 *    at the same spot (both use the same mask).
 * Hence measuring with WebKit — the real app is WKWebView too (same reason as perf-idle.spec.ts).
 *
 * What is checked is **pixels**, not values. A panel's class or z-index only says the ring is
 * supposed to be there; only the rendered screen knows whether the mask actually left that pixel lit.
 */
test.use({ browserName: 'webkit', deviceScaleFactor: 1 })

/**
 * Window widths to measure. The first four are common widths the issue picked (two columns); the
 * last four are widths where the right side actually vanished on WebKit (three columns).
 */
const WIDTHS = [1280, 1281, 1333, 1366, 1401, 1404, 1437, 1500]

/** --color-ink-muted. The stationary ring's color; the test below also paints the spinning ring's layer this color to check only its shape */
const ASH = 144
/**
 * The threshold for a lit side. A side where the ring vanished reads as only the panel's border
 * (line-strong 53) or floor (surface-floor 29); a side dimmed to a half pixel sits in between (~86). A lit
 * side reads as ASH itself.
 */
const LIT = ASH - 8

const EDGES = ['top', 'right', 'bottom', 'left'] as const
type Dim = { width: number; panel: number; edge: (typeof EDGES)[number]; peak: number }

async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

async function newSession(page: Page, prompt: string): Promise<string> {
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  return page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId)
}

/** Sets up three panels mid-response in the grid — it becomes three columns from 1400px */
async function workingGrid(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await setup(page)
  const ids = [await newSession(page, 'one'), await newSession(page, 'two'), await newSession(page, 'three')]
  await page.evaluate((l: string[]) => {
    const store = (window as never as { __store: any }).__store
    store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId })))
    store.setState((s: any) => {
      const sessions = { ...s.sessions }
      for (const id of l) sessions[id] = { ...sessions[id], state: 'working' }
      return { sessions }
    })
  }, ids)
  await page.getByTestId('grid-button').click()
  for (const id of ids) await expect(page.getByTestId(`grid-panel-${id}`)).toHaveClass(/cc-orbit-ring/)
  // If the prompt field is focused, the composer rises and covers the area near the bottom edge — blur it and move the cursor off the panel
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(1, 1)
  return ids
}

/**
 * Measures the **darkest point** on each of a panel's four sides.
 *
 * Line by line along the side (excluding the 12px rounded corners), it picks the brightest of the
 * four pixels from 1px outside the panel to 3px inside it — this catches the ring whether it sits
 * right on the border or one pixel inside it. The smallest of those values becomes the side's
 * value: if any single stretch of the side breaks, it shows up here.
 */
async function edgePeaks(page: Page, ids: string[]) {
  const boxes = await page.evaluate(
    (l: string[]) =>
      l.map((id) => {
        const r = document.querySelector(`[data-testid="grid-panel-${id}"]`)!.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      }),
    ids,
  )
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const peaks = await page.evaluate(
    async ([b64, bs]: [string, typeof boxes]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const g = canvas.getContext('2d')!
      g.drawImage(img, 0, 0)
      const px = g.getImageData(0, 0, img.width, img.height).data
      const at = (x: number, y: number) => {
        const i = (y * img.width + x) * 4
        return Math.max(px[i]!, px[i + 1]!, px[i + 2]!)
      }
      const CORNER = 12
      /** outer: the first pixel outside the panel, dir: the inward direction, along: the range running the length of the side */
      const edge = (outer: number, dir: 1 | -1, from: number, to: number, horizontal: boolean) => {
        let low = 255
        for (let p = Math.ceil(from) + CORNER; p < Math.floor(to) - CORNER; p++) {
          let high = 0
          for (let k = 0; k < 4; k++) {
            const q = outer + dir * k
            high = Math.max(high, horizontal ? at(p, q) : at(q, p))
          }
          low = Math.min(low, high)
        }
        return low
      }
      return bs.map((b) => ({
        top: edge(Math.floor(b.top) - 1, 1, b.left, b.right, true),
        bottom: edge(Math.ceil(b.bottom), -1, b.left, b.right, true),
        left: edge(Math.floor(b.left) - 1, 1, b.top, b.bottom, false),
        right: edge(Math.ceil(b.right), -1, b.top, b.bottom, false),
      }))
    },
    [png.toString('base64'), boxes] as [string, typeof boxes],
  )
  return { boxes, peaks }
}

/**
 * Waits for the grid to settle into place. When the width changes, ResizeObserver recomputes the
 * column count and React re-renders — a screenshot taken in the middle of that would record a
 * mid-layout grid as fact. This waits until the panels' positions are the same for two frames in
 * a row.
 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    const read = () =>
      JSON.stringify(
        [...document.querySelectorAll('[data-testid^="grid-panel-"]')].map((el) => {
          const r = el.getBoundingClientRect()
          return [r.left, r.top, r.width, r.height]
        }),
      )
    let last = ''
    for (let i = 0; i < 30; i++) {
      await frame()
      await frame()
      const now = read()
      if (now === last) return
      last = now
    }
  })
}

/** Measures all four sides at every window width and collects only the sides that did not light up — a failure message is itself the width, panel, and side */
async function dimEdges(page: Page, ids: string[], before?: () => Promise<void>) {
  const dim: Dim[] = []
  const boxes: { width: number; left: number; top: number; right: number; bottom: number }[] = []
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 })
    await settle(page)
    if (before) {
      await before()
      await settle(page)
    }
    const m = await edgePeaks(page, ids)
    m.peaks.forEach((p, panel) => {
      for (const edge of EDGES) if (p[edge] < LIT) dim.push({ width, panel, edge, peak: p[edge] })
    })
    for (const b of m.boxes) boxes.push({ width, ...b })
  }
  return { dim, boxes }
}

/** Whether any of a panel's four corners lands between pixels */
const offPixel = (b: { left: number; top: number; right: number; bottom: number }) =>
  [b.left, b.top, b.right, b.bottom].some((v) => v % 1 !== 0)

test('the stationary ring (gray) shows on all four sides of a panel no matter the window width — even when the panel lands on a fractional pixel', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const ids = await workingGrid(page)
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setSpinGrid(false))
  await expect(page.locator('html')).toHaveAttribute('data-spin-grid', 'off')

  // As the grid lays it out by default
  expect((await dimEdges(page, ids)).dim).toEqual([])

  /*
   * And also checked with panels **deliberately** placed on fractional pixels. The grid now
   * places panels on whole pixels (GridView's wholePixelTracks), but changing the text scale
   * makes one CSS pixel fall out of alignment with a screen pixel, and the panel lands on a
   * fraction again. The stationary ring is the panel's border, so it must not depend on
   * alignment — so the old 1fr grid is overlaid to put the panel back at its old position
   * (x.328) and the same thing is measured.
   */
  const evenTracks = async () => {
    await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="grid"] > .grid') as HTMLElement
      const n = (v: string) => v.trim().split(/\s+/).length
      // The old grid gave each panel 1fr — the column and row counts are whatever the current grid picked
      const cols = n(getComputedStyle(grid).gridTemplateColumns)
      const rows = n(getComputedStyle(grid).gridTemplateRows)
      let tag = document.getElementById('even-tracks')
      if (!tag) {
        tag = document.createElement('style')
        tag.id = 'even-tracks'
        document.head.append(tag)
      }
      tag.textContent = `[data-testid="grid"] > .grid {
        grid-template-columns: repeat(${cols}, minmax(0, 1fr)) !important;
        grid-template-rows: repeat(${rows}, minmax(0, 1fr)) !important;
      }`
    })
  }
  // The overlaid grid is rewritten at every width — the column count changes with the width, and it has to be the value the grid picked
  const forced = await dimEdges(page, ids, async () => {
    await page.evaluate(() => document.getElementById('even-tracks')?.remove())
    await settle(page)
    await evenTracks()
  })
  // Whether the overlay actually put the panel on a fraction — otherwise this half of the test measured nothing
  expect(forced.boxes.some(offPixel)).toBe(true)
  expect(forced.dim).toEqual([])
})

test('the spinning ring\'s (rainbow) shape leaves all four sides intact no matter the window width — panels land on whole pixels', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const ids = await workingGrid(page)
  /*
   * The spinning layer's color varies by angle, and one slice (300°–360°) is transparent. A plain
   * screenshot cannot tell "it broke" apart from "that angle happens to be transparent right now."
   * So the layer is instead **painted a single solid color** — the ring's shape (the mask) is left
   * untouched, and only which pixels that mask leaves lit is checked.
   */
  await page.addStyleTag({
    content: `.cc-orbit-ring-layer::before { animation: none !important; background: rgb(${ASH}, ${ASH}, ${ASH}) !important; }`,
  })

  const { dim, boxes } = await dimEdges(page, ids)
  expect(dim).toEqual([])
  // And why: the panels land on whole pixels — the condition under which this mask leaves all four sides intact
  expect(boxes.filter(offPixel)).toEqual([])
})
