import { test, expect, type Page } from '@playwright/test'
import { setup, newSession } from './fixtures/control.js'

/**
 * Project row folding on click (never on hover): clicking the project row background or chevron toggles the saved fold,
 * while clicking the project name opens the project screen without toggling the fold.
 */
const rows = (page: Page, project: string) => page.getByTestId(`project-${project}`).locator('[data-testid^="session-row-"]')
const header = (page: Page, project: string) => page.getByTestId(`project-${project}`).locator('header')
const name = (page: Page, project: string) => page.getByTestId(`project-header-${project}`)

/** A list that folds stays 150 ms (usePresence) on the fake clock: wait until it is leaving, then let the exit end */
async function exitEnds(page: Page, project: string) {
  await expect(page.getByTestId(`project-rows-${project}`)).toHaveAttribute('data-fold', 'closing')
  await page.clock.runFor(151)
}

async function clickRowBackground(page: Page, project: string) {
  const box = (await header(page, project).boundingBox())!
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height / 2)
}

async function foldedProjects(page: Page, names: string[]) {
  await page.clock.install()
  await setup(page, { projects: names.map((n) => `/tmp/${n}`) })
  for (const n of names) {
    await newSession(page, n, 'task')
    await page.getByTestId(`project-fold-${n}`).click()
    await expect(rows(page, n)).toHaveCount(0)
  }
  await page.mouse.move(900, 600)
  await page.clock.pauseAt(new Date(Date.now() + 60_000))
}

test('Project row: hovering a folded project name or row background never expands it', async ({ page }) => {
  await foldedProjects(page, ['alpha', 'beta'])
  await name(page, 'alpha').hover()
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(0)
  const box = (await header(page, 'alpha').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2)
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects?.length)).toBe(2)
})

test('Project row: clicking the row background toggles fold open and closed without opening the project screen', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await expect(page.getByTestId('project-view')).toHaveCount(0)
  // Expand via row background click
  await clickRowBackground(page, 'alpha')
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await expect(page.getByTestId('project-alpha')).not.toHaveAttribute('data-folded', 'true')
  await expect(page.getByTestId('project-fold-alpha')).toHaveAttribute('aria-label', 'Collapse alpha')
  await expect(page.getByTestId('project-view')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects?.length)).toBe(0)
  // Leaving the row keeps it open
  await page.mouse.move(900, 600)
  await page.clock.runFor(1000)
  await expect(rows(page, 'alpha')).toHaveCount(1)
  // Collapse via row background click again
  await clickRowBackground(page, 'alpha')
  await exitEnds(page, 'alpha')
  await expect(rows(page, 'alpha')).toHaveCount(0)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  await expect(page.getByTestId('project-fold-alpha')).toHaveAttribute('aria-label', 'Expand alpha')
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects?.length)).toBe(1)
})

test('Project row: clicking the project name opens the project screen without toggling fold', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  // Folded: clicking name opens project screen and keeps it folded
  await name(page, 'alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(page.getByTestId('project-view-name')).toHaveText('alpha')
  await expect(rows(page, 'alpha')).toHaveCount(0)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  // Expand via row background, then click name again: stays expanded
  await clickRowBackground(page, 'alpha')
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await name(page, 'alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await expect(page.getByTestId('project-alpha')).not.toHaveAttribute('data-folded', 'true')
})

test('Project row: clicking the chevron toggles once without double-toggling from the header handler', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await page.getByTestId('project-fold-alpha').click()
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await expect(page.getByTestId('project-alpha')).not.toHaveAttribute('data-folded', 'true')
  await page.getByTestId('project-fold-alpha').click()
  await exitEnds(page, 'alpha')
  await expect(rows(page, 'alpha')).toHaveCount(0)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
})

test('Project row: clicking the status summary chips toggles fold', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  // Make the session working so FoldSummary renders a chip
  await page.evaluate(() => {
    const s = Object.values((window as any).__store.getState().sessions)[0] as { id: string }
    ;(window as any).__mock.emit({ type: 'state_change', sessionId: s.id, state: 'working' })
  })
  const summary = page.getByTestId('fold-summary-alpha')
  await expect(summary).toBeVisible()
  await summary.click()
  await expect(rows(page, 'alpha')).toHaveCount(1)
  await summary.click()
  await exitEnds(page, 'alpha')
  await expect(rows(page, 'alpha')).toHaveCount(0)
})

test('Project row: clicking the menu button or an item inside the menu does not toggle fold', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('project-menu-open-alpha')).toBeVisible()
  await expect(rows(page, 'alpha')).toHaveCount(0)
  // Clicking a menu item must not bubble into <header> and expand the folded project
  await page.getByTestId('agent-instructions-alpha').click()
  await expect(rows(page, 'alpha')).toHaveCount(0)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
})

test('Project row: clicking the root app button opens the app without toggling fold', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await page.evaluate(() => {
    const pid = Object.keys((window as any).__store.getState().projects)[0]!
    ;(window as any).__mock.setExternalApps([
      {
        appId: 'root-app',
        projectId: pid,
        dir: '/tmp/alpha',
        name: 'Alpha App',
        version: '0.1.0',
        description: null,
        home: 'home',
        root: true,
        trusted: true,
        status: 'stopped',
        error: null,
        warnings: [],
      },
    ])
  })
  await page.getByTestId('project-app-alpha').click()
  await expect(rows(page, 'alpha')).toHaveCount(0)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
})

test('Project row: hovering row background lights the chevron and row tint, while hovering the name or machine badge does not', async ({ page }) => {
  await foldedProjects(page, ['alpha'])
  await page.evaluate(() => {
    const store = (window as any).__store
    const pid = Object.keys(store.getState().projects)[0]!
    const project = store.getState().projects[pid]
    store.setState({
      machines: {
        ...store.getState().machines,
        'remote-box': { id: 'remote-box', name: 'remote-box', sshTarget: 'dev@remote', status: 'connected' },
      },
      projects: {
        ...store.getState().projects,
        [pid]: { ...project, machine: 'remote-box' },
      },
    })
  })
  const hdr = header(page, 'alpha')
  const foldBtn = page.getByTestId('project-fold-alpha')
  const nameBtn = name(page, 'alpha')
  const machineBtn = page.getByTestId('project-machine-alpha')

  // Wait for both header and chevron transitions to settle after setup moves the pointer away
  await expect(hdr).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.poll(() => foldBtn.evaluate((el) => el.getAnimations().length)).toBe(0)
  const idleChevron = await foldBtn.evaluate((el) => getComputedStyle(el).color)

  // Hover row background: tint appears, chevron brightens, name is not underlined
  const box = (await hdr.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height / 2)
  await expect.poll(() => hdr.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await expect.poll(() => foldBtn.evaluate((el) => getComputedStyle(el).color)).not.toBe(idleChevron)
  await expect(nameBtn).not.toHaveCSS('text-decoration-line', /underline/)

  // Hover project name: name underlines, row tint and chevron return to idle
  await nameBtn.hover()
  await expect(nameBtn).toHaveCSS('text-decoration-line', /underline/)
  await expect(hdr).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.poll(() => foldBtn.evaluate((el) => getComputedStyle(el).color)).toBe(idleChevron)

  // Hover machine badge: row tint and chevron stay idle (and clicking it does not toggle fold)
  await machineBtn.hover()
  await expect(hdr).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.poll(() => foldBtn.evaluate((el) => getComputedStyle(el).color)).toBe(idleChevron)
  await machineBtn.click()
  await expect(page.getByTestId('machine-menu-remote-box')).toBeVisible()
  await expect(rows(page, 'alpha')).toHaveCount(0)
})
