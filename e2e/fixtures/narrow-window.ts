import { expect, test, type Locator, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * A 420 px window (#2455): the inbox narrows to fit it, keeps Continue and Done whole, and puts a row's state and time
 * under its name; the sidebar keeps its minimum, so names read, and the conversation narrows instead.
 */

async function emit(page: Page, events: Record<string, unknown>[]) {
  await page.evaluate((list) => {
    const m = (window as any).__mock as { emit(e: Record<string, unknown>): void }
    for (const e of list) m.emit(e)
  }, events)
}

/** Wholly inside the window and inside the box that clips it, its words not cut */
async function expectWhole(page: Page, el: Locator, within: Locator) {
  const vw = page.viewportSize()!.width
  const box = (await el.boundingBox())!
  const outer = (await within.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(Math.max(0, outer.x))
  expect(box.x + box.width).toBeLessThanOrEqual(Math.min(vw, outer.x + outer.width))
  expect(await el.evaluate((e) => e.scrollWidth - e.clientWidth)).toBe(0)
}

const PROJECT = 'a-project-with-a-rather-long-name'

export function narrowWindowTests() {
  test('at 420 px the inbox fits the window, and a stopped row keeps Continue and Done whole (#2455)', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 })
    // A project name too long for the row: it is cut on the name's line, not wrapped to one of its own
    await setup(page, [`/tmp/${PROJECT}`])
    const s = await newSession(page, PROJECT)
    // Another session in front, so the stopped one stays unread and listed
    await newSession(page, PROJECT)
    await emit(page, [
      { type: 'notice', sessionId: s, level: 'warning', from: 'Centralu', label: 'stopped', text: 'Centralu quit or restarted while this turn was running, so it stopped before it finished.' },
      { type: 'interruption', sessionId: s, interruption: { reason: 'quit', at: Date.now() } },
    ])

    await page.getByTestId('counter').click()
    const inbox = page.getByTestId('inbox')
    await expect(inbox).toBeVisible()
    await expect.poll(() => inbox.evaluate((el) => el.getAnimations().every((a) => a.playState !== 'running'))).toBe(true)

    const box = (await inbox.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(420)
    for (const id of [`inbox-continue-${s}`, `inbox-done-${s}`]) await expectWhole(page, page.getByTestId(id), inbox)
    // The state and the time are whole too, on a line of their own under the name
    const name = page.getByTestId(`inbox-item-${s}`)
    const dot = (await name.locator('[data-testid^="dot-"]').boundingBox())!
    for (const part of [name.getByText('Stopped: Centralu quit or restarted'), name.locator('.readout')]) {
      await expectWhole(page, part, name)
      expect((await part.boundingBox())!.y).toBeGreaterThan(dot.y + dot.height)
    }
    const project = (await name.getByText(PROJECT).boundingBox())!
    expect(project.y).toBeLessThan(dot.y + dot.height)
  })

  test('at 420 px the sidebar keeps its 180 px, and the conversation narrows and still takes a message (#2455)', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 })
    await setup(page, ['/tmp/alpha'])
    await newSession(page, 'alpha')
    await expect(page.getByTestId('sidebar')).toHaveCSS('min-width', '180px')
    expect((await page.getByTestId('sidebar').boundingBox())!.width).toBeGreaterThanOrEqual(180)

    const input = page.getByTestId('prompt-input')
    await input.fill('still typing')
    await expect(input).toHaveValue('still typing')
    // Measured after typing: a focused field scrolls a layout wider than the window sideways
    const field = (await input.boundingBox())!
    expect(field.x + field.width).toBeLessThanOrEqual(420)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })
}
