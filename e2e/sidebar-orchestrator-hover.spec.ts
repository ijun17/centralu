import { test, expect, type Page } from '@playwright/test'
import { setup } from './fixtures/control.js'

/**
 * The orchestrator's children fold under its button and open on a mouse rest (#1591, owner 2026-10-26), by the rule of a
 * folded project's name (#1578). The 0.2 s rest runs on Playwright's clock: the clock is paused after setup and moved by hand.
 */
const list = (page: Page) => page.getByTestId('orchestrator-children')
const button = (page: Page) => page.getByTestId('orchestrator-button')
const away = (page: Page) => page.mouse.move(900, 600)

/** An orchestrator with children (`current`, started by it) and `earlier` ones (started by an orchestrator that is gone) */
async function withChildren(page: Page, opts: { current?: string[]; earlier?: string[] } = { current: ['alpha', 'beta'] }): Promise<Record<string, unknown> & { id: string }> {
  await page.clock.install()
  await setup(page, { projects: ['/tmp/consumer'] })
  const orc = await page.evaluate(async () => (await (window as any).__mock.agents.orchestrator()) as Record<string, unknown>)
  await page.evaluate(
    ([o, current, earlier]) => {
      const add = (name: string, askedBy: string) => {
        const child = { ...(o as object), id: `orc-child-${name}`, kind: 'worker', name, askedBy }
        ;(window as any).__mock.emit({ type: 'session_created', sessionId: child.id, session: child })
      }
      for (const n of current) add(n, (o as { id: string }).id)
      for (const n of earlier) add(n, 'orc-gone')
    },
    [orc, opts.current ?? [], opts.earlier ?? []] as const,
  )
  await away(page)
  await page.clock.pauseAt(new Date(Date.now() + 60_000))
  return orc as Record<string, unknown> & { id: string }
}

const row = (page: Page, name: string) => page.getByTestId(`orchestrator-child-row-orc-child-${name}`)

test('Orchestrator children: folded at rest, open after a mouse rest on the button, folded when the pointer leaves the block', async ({ page }) => {
  await withChildren(page)
  await expect(button(page)).toBeVisible()
  await expect(list(page)).toHaveCount(0)
  await button(page).hover()
  await page.clock.runFor(199)
  await expect(list(page)).toHaveCount(0)
  await page.clock.runFor(2)
  await expect(list(page)).toBeVisible()
  await expect(row(page, 'alpha')).toBeVisible()
  await expect(row(page, 'beta')).toBeVisible()
  // Into the list (still the block): it stays
  await row(page, 'beta').hover()
  await page.clock.runFor(1000)
  await expect(list(page)).toBeVisible()
  // Out of the whole block: it folds
  await away(page)
  await expect(list(page)).toHaveCount(0)
})

test('Orchestrator children: nothing on the folded button says how many there are', async ({ page }) => {
  await withChildren(page)
  await expect(list(page)).toHaveCount(0)
  await expect(button(page)).toHaveText('Orchestrator')
  await expect(button(page).locator('[data-testid]')).toHaveCount(0)
})

test('Orchestrator children: passing over the button does not open them', async ({ page }) => {
  await withChildren(page)
  await button(page).hover()
  await page.clock.runFor(150)
  await expect(list(page)).toHaveCount(0)
  await away(page)
  await page.clock.runFor(1000)
  await expect(list(page)).toHaveCount(0)
})

test('Orchestrator children: clicking the button opens the screen and pins nothing', async ({ page }) => {
  await withChildren(page)
  await button(page).hover()
  await page.clock.runFor(250)
  await expect(list(page)).toBeVisible()
  await button(page).click()
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
  await away(page)
  await page.clock.runFor(1000)
  await expect(list(page)).toHaveCount(0)
})

test('Orchestrator children: an open child keeps the list shown, and the pointer leaving does not fold it', async ({ page }) => {
  await withChildren(page)
  await button(page).hover()
  await page.clock.runFor(250)
  await row(page, 'alpha').click()
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe('orc-child-alpha')
  await away(page)
  await page.clock.runFor(1000)
  await expect(list(page)).toBeVisible()
  await expect(row(page, 'alpha')).toHaveAttribute('aria-current', 'page')
  // Another sibling is hidden no more than the list as a whole: it is one list
  await expect(row(page, 'beta')).toBeVisible()
})

test('Orchestrator children: the earlier orchestrator group folds and opens with the rest', async ({ page }) => {
  await withChildren(page, { current: [], earlier: ['gamma'] })
  await expect(page.getByTestId('orchestrator-children-earlier')).toHaveCount(0)
  await expect(row(page, 'gamma')).toHaveCount(0)
  await button(page).hover()
  await page.clock.runFor(250)
  await expect(page.getByTestId('orchestrator-children-earlier')).toHaveText('Started by an earlier orchestrator')
  await expect(row(page, 'gamma')).toBeVisible()
  await away(page)
  await expect(row(page, 'gamma')).toHaveCount(0)
})

test("Orchestrator children: an open row menu holds the list until it closes", async ({ page }) => {
  await withChildren(page)
  await button(page).hover()
  await page.clock.runFor(250)
  await row(page, 'alpha').hover()
  await page.getByTestId('session-menu-orc-child-alpha').click()
  await expect(page.getByTestId('session-menu-open-orc-child-alpha')).toBeVisible()
  await away(page)
  await page.clock.runFor(500)
  await expect(list(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list(page)).toHaveCount(0)
})

test('Orchestrator children: keyboard focus on the button does not open them', async ({ page }) => {
  await withChildren(page)
  await button(page).focus()
  await page.clock.runFor(1000)
  await expect(list(page)).toHaveCount(0)
})

test('Orchestrator children: a child that starts while the pointer rests on the button is shown at once', async ({ page }) => {
  const orc = await withChildren(page, { current: ['alpha'] })
  await button(page).hover()
  await page.clock.runFor(250)
  await expect(row(page, 'alpha')).toBeVisible()
  await page.evaluate((o) => {
    const child = { ...o, id: 'orc-child-late', kind: 'worker', name: 'late', askedBy: o.id }
    ;(window as any).__mock.emit({ type: 'session_created', sessionId: child.id, session: child })
  }, orc)
  await expect(row(page, 'late')).toBeVisible()
  await away(page)
  await expect(list(page)).toHaveCount(0)
})
