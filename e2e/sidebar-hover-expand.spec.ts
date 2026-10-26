import { test, expect, type Page } from '@playwright/test'
import { setup, newSession } from './fixtures/control.js'

/**
 * Hover expansion of a folded project (#1578, owner 2026-10-26). The 0.2 s rest runs on Playwright's clock, so the tests
 * wait for no wall-clock time: the clock is paused after setup and moved by hand.
 */
const rows = (page: Page, project: string) => page.getByTestId(`project-${project}`).locator('[data-testid^="session-row-"]')
const name = (page: Page, project: string) => page.getByTestId(`project-header-${project}`)

async function foldedProjects(page: Page, names: string[]) {
  await page.clock.install()
  await setup(page, { projects: names.map((n) => `/tmp/${n}`) })
  for (const n of names) {
    await newSession(page, n, 'task')
    await page.getByTestId(`project-fold-${n}`).click()
    await expect(rows(page, n)).toHaveCount(0)
  }
  // Away from every project, then stop time
  await page.mouse.move(900, 600)
  await page.clock.pauseAt(new Date(Date.now() + 60_000))
}

test('Hover: resting 0.2 s on a folded name expands it, leaving the block folds it; the saved fold is untouched', async ({ page }) => {
  await foldedProjects(page, ['alpha', 'beta'])
  await name(page, 'alpha').hover()
  await page.clock.runFor(199)
  await expect(rows(page, 'alpha')).toHaveCount(0)
  await page.clock.runFor(2)
  await expect(rows(page, 'alpha')).toHaveCount(1)
  // Still folded as saved, and the arrow still says "Expand"
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects?.length)).toBe(2)
  await expect(page.getByTestId('project-fold-alpha')).toHaveAttribute('aria-label', 'Expand alpha')
  // Into its session rows: stays open
  await rows(page, 'alpha').first().hover()
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(1)
  // Out of the block: folds
  await page.mouse.move(900, 600)
  await expect(rows(page, 'alpha')).toHaveCount(0)
})

test('Hover: passing over a name does not expand it', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await name(page, 'alpha').hover()
  await page.clock.runFor(150)
  await expect(rows(page, 'alpha')).toHaveCount(0)
  await page.mouse.move(900, 600)
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(0)
})

test('Hover: moving down across three folded projects expands none of them', async ({ page }) => {
  await foldedProjects(page, ['alpha', 'beta', 'gamma'])
  for (const n of ['alpha', 'beta', 'gamma']) {
    await name(page, n).hover()
    await page.clock.runFor(100)
    // Checked while the pointer is still on the name: a project that expanded and folded again would pass the final check
    await expect(rows(page, n)).toHaveCount(0)
  }
  await page.mouse.move(900, 600)
  await page.clock.runFor(1000)
  for (const n of ['alpha', 'beta', 'gamma']) await expect(rows(page, n)).toHaveCount(0)
})

test('Hover: a click-expanded project never folds on hover or on leaving', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await page.getByTestId('project-fold-alpha').click()
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await name(page, 'alpha').hover()
  await page.clock.runFor(1000)
  await page.mouse.move(900, 600)
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await expect(page.getByTestId('project-alpha')).not.toHaveAttribute('data-folded', 'true')
})

test('Hover: pressing the arrow of a hover-expanded project makes it stay', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await name(page, 'alpha').hover()
  await page.clock.runFor(250)
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await page.getByTestId('project-fold-alpha').click()
  await page.mouse.move(900, 600)
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects?.length)).toBe(0)
})

test('Hover: pressing the name of a hover-expanded project opens its screen and makes it stay', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await name(page, 'alpha').hover()
  await page.clock.runFor(250)
  await name(page, 'alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await page.mouse.move(900, 600)
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(1)
})

test('Hover: pressing the name of a folded project before the rest is over leaves it folded', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await name(page, 'alpha').click()
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(0)
})

test('Hover: an open project menu keeps a hover-expanded project until it closes', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await name(page, 'alpha').hover()
  await page.clock.runFor(250)
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('project-menu-open-alpha')).toBeVisible()
  await page.mouse.move(900, 600)
  await page.clock.runFor(500)
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(rows(page, 'alpha')).toHaveCount(0)
})

test('Hover: keyboard focus on a folded name does not expand it', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await name(page, 'alpha').focus()
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(0)
})
