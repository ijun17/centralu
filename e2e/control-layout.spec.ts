import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setup, newSession } from './fixtures/control.js'
import { openSessionDialog } from './fixtures/new-session.js'

/**
 * The control loop's scenarios on layout that must hold at any size: narrow windows, resizing, the top bar and modals. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('The layout does not break even in a narrow window (L4-4)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 })
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // If horizontal scroll appears, something overflowed
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

/**
 * The side panels give way before the session does (#1561): at 480 px the sidebar and the evidence panel used to keep
 * their stored widths and left the session 0 px. 900 and 1280 px keep the layout they always had.
 */
for (const [width, session] of [
  [480, 300],
  [900, 320],
  [1280, 700],
] as const) {
  test(`At ${width} px wide the session pane is ${width === 480 ? 'still usable' : 'laid out as before'} (#1561)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 })
    await setup(page, { projects: ['/tmp/alpha'] })
    await newSession(page, 'alpha', 'task')
    const pane = (await page.getByTestId('session-view').boundingBox())!.width
    if (width === 480) expect(pane).toBeGreaterThanOrEqual(session)
    else expect(Math.round(pane)).toBe(session)
    await page.getByTestId('prompt-input').fill('still typing')
    await expect(page.getByTestId('prompt-input')).toHaveValue('still typing')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)
  })
}

test('Window drag regions and blocked overscroll (M2.5 window issue)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // With the title bar hidden, each lane's header is the window-move handle (top bar, session,
  // evidence)
  // Each lane's header is the window-move handle (top bar, session, evidence).
  // The attribute alone breaks when text 'inside' the header is grabbed, so mousedown is also handled
  // The top bar carries it twice (the bar and its right-hand controls, whose own gaps are bar too, #727)
  await expect(page.locator('[data-tauri-drag-region]')).toHaveCount(4)

  // The window itself does not scroll (must not rubber-band like a web page)
  const overscroll = await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY)
  expect(overscroll).toBe('none')
  const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow)
  expect(bodyOverflow).toBe('hidden')
})

test('Resizing the left and right panels does not push the screen sideways', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Resize the sidebar width
  const sidebar = page.getByTestId('sidebar')
  const before = (await sidebar.boundingBox())!.width
  const handle = page.getByTestId('sidebar-resize')
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + 1, hb.y + 200)
  await page.mouse.down()
  await page.mouse.move(hb.x + 120, hb.y + 200, { steps: 8 })
  await page.mouse.up()
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(before + 60)

  // Even maximizing the right panel's width must not create horizontal scroll
  const panelHandle = page.getByTestId('evidence-resize')
  const pb = (await panelHandle.boundingBox())!
  await page.mouse.move(pb.x + 1, pb.y + 200)
  await page.mouse.down()
  await page.mouse.move(10, pb.y + 200, { steps: 12 })
  await page.mouse.up()

  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)

  // The conversation lane keeps its minimum width and stays usable
  expect((await page.getByTestId('chat-stream').boundingBox())!.width).toBeGreaterThan(200)
})

/**
 * A modal must cover the entire window regardless of its ancestors' positioning.
 * Adding `relative` to the sidebar to support its resize handle trapped the create-session
 * modal, which opened inside it, within the sidebar's width (pointed out during dogfooding).
 */
test('A modal is not trapped inside the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const sidebarWidth = (await page.getByTestId('sidebar').boundingBox())!.width
  await openSessionDialog(page, 'alpha')
  const dialog = (await page.getByTestId('new-session-dialog').boundingBox())!
  const viewport = page.viewportSize()!
  // The overlay covers the whole window (not just the sidebar's width)
  expect(dialog.width).toBeGreaterThan(sidebarWidth * 2)
  expect(Math.round(dialog.width)).toBe(viewport.width)

  // It attaches directly under body — unaffected by ancestor positioning
  const parentIsBody = await page.evaluate(
    () => document.querySelector('[data-testid="new-session-dialog"]')?.parentElement === document.body,
  )
  expect(parentIsBody).toBe(true)
})

/**
 * The top bar must sit on the same axis as the macOS traffic-light buttons.
 *
 * The button position is set by us via trafficLightPosition in tauri.conf.json, and its
 * **relationship to the bar's height** is checked by tooling/styles.test.ts. What is checked
 * here is only what the browser can see: whether the count (the bar's tallest piece on the
 * left since the title went, #727, and the search field went to the sidebar, 2026-11-05) is vertically centered in the bar. Adding inner padding can
 * silently throw this off, and that is what this test catches.
 */
test('The count sits vertically centered inside the top bar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const bar = page.getByTestId('app-header')
  const box = (await bar.boundingBox())!
  /*
   * The bar's height, up to its 1px bottom border, is the one the desktop shell keeps the traffic lights centred on
   * (traffic_lights.rs HEADER_H; tooling/styles.test.ts checks it against App.tsx and tauri.conf.json). Read from
   * there rather than written here a fourth time.
   */
  const rust = readFileSync(fileURLToPath(new URL('../apps/desktop/src-tauri/src/traffic_lights.rs', import.meta.url)), 'utf8')
  const headerH = Number(/const HEADER_H: f64 = ([\d.]+);/.exec(rust)![1])
  expect(box.height).toBeLessThanOrEqual(headerH + 1)
  expect(box.y).toBe(0)

  // The count must also be centered within it (top/bottom margin difference within 1px)
  const count = (await page.getByTestId('counter').boundingBox())!
  const top = count.y - box.y
  const bottom = box.y + box.height - (count.y + count.height)
  expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1.5)
})

/* #842 item 11: what starts a drag, what ends one, and the keyboard */
test('a right-click on a resize handle does not start a drag that follows the pointer', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const sidebar = page.getByTestId('sidebar')
  const before = (await sidebar.boundingBox())!.width
  const hb = (await page.getByTestId('sidebar-resize').boundingBox())!
  await page.mouse.move(hb.x + 1, hb.y + 200)
  await page.mouse.down({ button: 'right' })
  // The context menu takes the release; the pointer then moves with no button held
  await page.mouse.move(hb.x + 120, hb.y + 200, { steps: 8 })
  expect((await sidebar.boundingBox())!.width).toBe(before)
  await page.mouse.up({ button: 'right' })
})

test('closing the evidence panel in the middle of a drag gives its width animation back', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const panel = page.getByTestId('evidence-panel')
  await expect(panel).toHaveClass(/transition-\[width\]/)
  const pb = (await page.getByTestId('evidence-resize').boundingBox())!
  await page.mouse.move(pb.x + 1, pb.y + 200)
  await page.mouse.down()
  await page.mouse.move(pb.x - 40, pb.y + 200, { steps: 4 })
  await expect(panel).not.toHaveClass(/transition-\[width\]/)
  // The panel closes under the handle (⌘B), and the release never reaches it
  await page.evaluate(() => (window as any).__store.getState().togglePanel())
  await page.mouse.up()
  await expect(page.getByTestId('evidence-rail-shell')).toHaveClass(/transition-\[width\]/)
})

test('the keyboard resizes the sidebar from its handle', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const sidebar = page.getByTestId('sidebar')
  const before = (await sidebar.boundingBox())!.width
  await page.getByTestId('sidebar-resize').focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(before) + 16)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(before))
  await expect(page.getByTestId('sidebar-resize')).toHaveAttribute('aria-valuenow', String(Math.round(before)))
})

// Owner, 2026-11-02: the window has an edge in the default border colour, and it takes no room: the top bar stays at y = 0,
// where the desktop shell centres the native window controls
test('The window has a hairline edge that moves nothing', async ({ page }) => {
  await setup(page)
  const edge = page.getByTestId('app-edge')
  // Four strips, each a border of its own, not a bordered box the size of the window (#2034: that box was a layer of its own, as large as the window)
  const look = await edge.evaluate((el) => {
    const line = getComputedStyle(document.documentElement).getPropertyValue('--color-line').trim()
    const probe = document.createElement('span')
    probe.style.color = line
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    const [top, bottom, left, right] = [...el.children].map((c) => getComputedStyle(c)) as [CSSStyleDeclaration, CSSStyleDeclaration, CSSStyleDeclaration, CSSStyleDeclaration]
    return {
      color,
      count: el.children.length,
      top: [top.borderTopWidth, top.borderTopColor],
      bottom: [bottom.borderTopWidth, bottom.borderTopColor],
      left: [left.borderLeftWidth, left.borderLeftColor],
      right: [right.borderLeftWidth, right.borderLeftColor],
    }
  })
  expect(look.color).not.toBe('rgba(0, 0, 0, 0)')
  expect(look.count).toBe(4)
  for (const side of [look.top, look.bottom, look.left, look.right]) expect(side).toEqual(['1px', look.color])
  const win = page.viewportSize()!
  expect(await edge.boundingBox()).toMatchObject({ x: 0, y: 0, width: win.width, height: win.height })
  // top, bottom, left, right: one pixel thick, along the whole side
  const boxes = await edge.locator('> span').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))
  expect(boxes[0]).toMatchObject({ x: 0, y: 0, width: win.width, height: 1 })
  expect(boxes[1]).toMatchObject({ x: 0, y: win.height - 1, width: win.width, height: 1 })
  expect(boxes[2]).toMatchObject({ x: 0, y: 0, width: 1, height: win.height })
  expect(boxes[3]).toMatchObject({ x: win.width - 1, y: 0, width: 1, height: win.height })
  expect((await page.getByTestId('app-header').boundingBox())!.y).toBe(0)
  // It lets the pointer through to what is under it
  expect(await edge.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
})
