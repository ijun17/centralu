import { test, expect, type Page } from '@playwright/test'
import { assistantWithChildren as withChildren } from './fixtures/sidebar-fold.js'

/**
 * The Assistant's children fold under its button while elsewhere, expand when entering the Assistant page (and stay
 * expanded while one of its children is the open session), and fold again when leaving to another view. Never on hover.
 */
const list = (page: Page) => page.getByTestId('assistant-children')
const button = (page: Page) => page.getByTestId('assistant-button')
const grid = (page: Page) => page.getByTestId('grid-button')

/** A list that folds stays 150 ms (usePresence) on the fake clock: wait until it is leaving, then let the exit end */
async function exitEnds(page: Page) {
  await expect(page.getByTestId('assistant-fold')).toHaveAttribute('data-fold', 'closing')
  await page.clock.runFor(151)
}

const row = (page: Page, name: string) => page.getByTestId(`assistant-child-row-orc-child-${name}`)

test('Assistant children: folded at rest, hovering or focusing the button never expands them', async ({ page }) => {
  await withChildren(page)
  await expect(button(page)).toBeVisible()
  await expect(list(page)).toHaveCount(0)
  await button(page).hover()
  await page.clock.runFor(1000)
  await expect(list(page)).toHaveCount(0)
  await button(page).focus()
  await page.clock.runFor(1000)
  await expect(list(page)).toHaveCount(0)
})

test('Assistant children: entering the Assistant page expands them, leaving folds them', async ({ page }) => {
  await withChildren(page)
  await expect(list(page)).toHaveCount(0)
  await button(page).click()
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(list(page)).toBeVisible()
  await expect(row(page, 'alpha')).toBeVisible()
  await expect(row(page, 'beta')).toBeVisible()
  // Moving the pointer away keeps them open while still on the Assistant page
  await page.mouse.move(900, 600)
  await page.clock.runFor(1000)
  await expect(list(page)).toBeVisible()
  // Leaving to another view folds them
  await grid(page).click()
  await exitEnds(page)
  await expect(list(page)).toHaveCount(0)
})

test('Assistant children: nothing on the folded button says how many there are', async ({ page }) => {
  await withChildren(page)
  await expect(list(page)).toHaveCount(0)
  await expect(button(page)).toHaveText('Assistant')
  await expect(button(page).locator('[data-testid]')).toHaveCount(0)
})

test('Assistant children: opening a child keeps the list shown, and leaving to another view folds it', async ({ page }) => {
  await withChildren(page)
  await button(page).click()
  await expect(list(page)).toBeVisible()
  await row(page, 'alpha').click()
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe('orc-child-alpha')
  await page.mouse.move(900, 600)
  await page.clock.runFor(1000)
  await expect(list(page)).toBeVisible()
  await expect(row(page, 'alpha')).toHaveAttribute('aria-current', 'page')
  await expect(row(page, 'beta')).toBeVisible()
  // Leaving to a project folds the Assistant children
  await page.getByTestId('project-header-consumer').click()
  await exitEnds(page)
  await expect(list(page)).toHaveCount(0)
})

test('Assistant children: the earlier assistant group folds and expands with the rest', async ({ page }) => {
  await withChildren(page, { current: [], earlier: ['gamma'] })
  await expect(page.getByTestId('assistant-children-earlier')).toHaveCount(0)
  await expect(row(page, 'gamma')).toHaveCount(0)
  await button(page).click()
  await expect(page.getByTestId('assistant-children-earlier')).toHaveText('Started by an earlier assistant')
  await expect(row(page, 'gamma')).toBeVisible()
  await grid(page).click()
  await exitEnds(page)
  await expect(row(page, 'gamma')).toHaveCount(0)
})

test('Assistant children: a child that starts while on the Assistant page is shown at once', async ({ page }) => {
  const orc = await withChildren(page, { current: ['alpha'] })
  await button(page).click()
  await expect(row(page, 'alpha')).toBeVisible()
  await page.evaluate((o) => {
    const child = { ...o, id: 'orc-child-late', kind: 'worker', name: 'late', askedBy: o.id }
    ;(window as any).__mock.emit({ type: 'session_created', sessionId: child.id, session: child })
  }, orc)
  await expect(row(page, 'late')).toBeVisible()
  await grid(page).click()
  await exitEnds(page)
  await expect(list(page)).toHaveCount(0)
})

test('Assistant children: archiving a child keeps its dialog through the losses step and removes the child', async ({ page }) => {
  await withChildren(page)
  // The mock host holds no such child; say what a real host would list for one that owes its starter a report
  await page.evaluate(() => {
    ;(window as any).__mock.agents.archiveIfAtRest = async () => ({ archived: false, asks: ['It owes the Assistant a report; it will not be told, and the report is dropped.'] })
  })
  await button(page).click()
  await expect(row(page, 'alpha')).toBeVisible()
  await row(page, 'alpha').hover()
  await page.getByTestId('session-menu-orc-child-alpha').click()
  await page.getByTestId('delete-session-orc-child-alpha').click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await expect(page.getByTestId('delete-losses')).toHaveCount(0)
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId('delete-losses')).toContainText('owes the Assistant a report')
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId('confirm-delete')).toHaveCount(0)
  await expect(row(page, 'alpha')).toHaveCount(0)
  await expect(row(page, 'beta')).toBeVisible()
})
