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
 * here is only what the browser can see: whether the search field (the bar's one tall piece
 * since the title went, #727) is vertically centered in the bar. Adding inner padding can
 * silently throw this off, and that is what this test catches.
 */
test('The search field sits vertically centered inside the top bar', async ({ page }) => {
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

  // The field must also be centered within it (top/bottom margin difference within 1px)
  const field = (await page.getByTestId('search-button').boundingBox())!
  const top = field.y - box.y
  const bottom = box.y + box.height - (field.y + field.height)
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
