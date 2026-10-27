import { test, expect, type Locator, type Page } from '@playwright/test'
import { setup, newSession } from './control.js'

/**
 * The folds of the sidebar: a folded project opens from its whole name row, and a project's rows and the orchestrator's
 * children slide open and closed (#1605). Run in Chromium (sidebar-fold.spec.ts) and in WebKit (sidebar-fold-webkit.spec.ts):
 * the desktop app is WKWebView, and a height animation has to be smooth there too.
 *
 * The 0.1 s rest and the exit (`usePresence`, 150 ms) run on Playwright's clock, which the tests move by hand; the
 * transition itself runs on the browser's own time. A fold is waited on by its end state (`data-fold` on the list's
 * `Fold`), never by a sleep.
 */

/** How long a leaving list stays: LEAVE_MS in components/presence.ts */
const LEAVE_MS = 150
/** Just over the rest the pointer needs on a row: HOVER_EXPAND_MS in features/sidebar/fold.ts */
const REST_MS = 101

const rows = (page: Page, project: string) => page.getByTestId(`project-${project}`).locator('[data-testid^="session-row-"]')
const header = (page: Page, project: string) => page.getByTestId(`project-${project}`).locator('header')
const region = (page: Page, project: string) => page.getByTestId(`project-rows-${project}`)
const away = (page: Page) => page.mouse.move(900, 600)

async function foldedProject(page: Page, opts: { sessions?: number } = {}) {
  await page.clock.install()
  await setup(page, { projects: ['/tmp/alpha'] })
  for (let i = 0; i < (opts.sessions ?? 1); i++) await newSession(page, 'alpha', `task ${i + 1}`)
  await page.getByTestId('project-fold-alpha').click()
  await expect(rows(page, 'alpha')).toHaveCount(0)
  await away(page)
  await page.clock.pauseAt(new Date(Date.now() + 60_000))
}

/** The pointer on the row's empty space: right of the name, left of the menu button. Returns what is under it. */
async function restOnEmptySpace(page: Page): Promise<string> {
  const box = (await header(page, 'alpha').boundingBox())!
  const x = box.x + box.width * 0.62
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py)
    return el?.closest('button') ? 'a button' : el?.tagName.toLowerCase() === 'header' ? 'the row' : (el?.tagName ?? 'nothing')
  }, [x, y] as const)
}

/** The list's height, sampled as fast as the page answers until it has stopped changing (for a list that must not move at all) */
async function heightsWhileMoving(list: Locator, final?: number): Promise<number[]> {
  const seen: number[] = []
  let still = 0
  for (let i = 0; i < 400 && still < 8; i++) {
    const h = (await list.boundingBox())?.height ?? 0
    still = seen.length > 0 && h === seen[seen.length - 1] && (final === undefined || h === final) ? still + 1 : 0
    seen.push(h)
  }
  return seen
}

/** Slows every fold to 4 s, so a test can take hold of its transition before it ends */
const slowFolds = (page: Page) => page.addStyleTag({ content: '.cc-fold, .cc-fold[data-drawn] { transition-duration: 4s !important; }' })

/**
 * Takes hold of the list's running transition of the grid track and reads its height at 0, 1/4, 1/2, 3/4 and the end of it:
 * what the engine draws along the way, without depending on how fast the page answers. A track that did not interpolate
 * (WebKit before it could) would show 0 and the full height only.
 */
async function heightsAlongTransition(list: Locator): Promise<{ property: string; heights: number[] }> {
  return list.evaluate((el) => {
    const t = el.getAnimations().filter((a) => a instanceof CSSTransition && a.transitionProperty === 'grid-template-rows')
    if (t.length !== 1) throw new Error(`expected one grid-template-rows transition, found ${t.length}`)
    const a = t[0] as CSSTransition
    a.pause()
    const total = Number(a.effect?.getComputedTiming().endTime)
    const heights = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      a.currentTime = f * total
      return el.getBoundingClientRect().height
    })
    return { property: a.transitionProperty, heights }
  })
}

/** Whether the list is still part way: shorter than the rows it holds */
const stillMoving = (list: Locator) => list.evaluate((el) => el.getBoundingClientRect().height < (el.firstElementChild?.scrollHeight ?? 0))

const nondecreasing = (hs: number[]) => hs.every((h, i) => i === 0 || h >= hs[i - 1]!)
const nonincreasing = (hs: number[]) => hs.every((h, i) => i === 0 || h <= hs[i - 1]!)
/** Strictly part way at the middle three samples: it interpolates, it does not jump */
const smooth = (hs: number[]) => hs.slice(1, 4).every((h) => h > hs[0]! && h < hs[4]!) || hs.slice(1, 4).every((h) => h < hs[0]! && h > hs[4]!)

export function sidebarFoldTests() {
  test('Fold: resting on the empty space of a folded project row expands it', async ({ page }) => {
    await foldedProject(page)
    // Over the row itself, not over its name or a button
    expect(await restOnEmptySpace(page)).toBe('the row')
    await page.clock.runFor(REST_MS - 2)
    await expect(rows(page, 'alpha')).toHaveCount(0)
    await page.clock.runFor(3)
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-hover-expanded', 'true')
    // The saved fold is untouched
    await expect(page.getByTestId('project-fold-alpha')).toHaveAttribute('aria-label', 'Expand alpha')
  })

  test('Fold: resting on a button of the row expands it too; a press before the rest is over does not', async ({ page }) => {
    await foldedProject(page)
    await page.getByTestId('project-menu-alpha').hover()
    await page.clock.runFor(REST_MS)
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await away(page)
    // The exit's timer starts once the list has been told to leave: wait for that, then move the clock
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'closing')
    await page.clock.runFor(LEAVE_MS + 1)
    await expect(rows(page, 'alpha')).toHaveCount(0)
    // A press is a decision not to wait: the menu opens and the rest that was running does not expand the project
    await page.getByTestId('project-menu-alpha').click()
    await page.clock.runFor(REST_MS * 3)
    await expect(page.getByTestId('project-menu-open-alpha')).toBeVisible()
    await expect(rows(page, 'alpha')).toHaveCount(0)
  })

  test('Fold: a pass over the empty space shorter than the rest does nothing', async ({ page }) => {
    await foldedProject(page)
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS - 30)
    await away(page)
    await page.clock.runFor(1000)
    await expect(rows(page, 'alpha')).toHaveCount(0)
  })

  test('Fold: the rows stay in the page while they leave, and go when the exit ends', async ({ page }) => {
    await foldedProject(page)
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS)
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await away(page)
    // Folded as far as the project goes, but nothing is taken away yet: no blink
    await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'closing')
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await page.clock.runFor(LEAVE_MS - 1)
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await page.clock.runFor(2)
    await expect(rows(page, 'alpha')).toHaveCount(0)
    await expect(region(page, 'alpha')).toHaveCount(0)
  })

  test('Fold: coming back while the rows leave opens them again', async ({ page }) => {
    await foldedProject(page)
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'opening')
    await away(page)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'closing')
    // Back on the row before the exit ends: the saved fold is folded, so it takes a new rest
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'opening')
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await page.clock.runFor(1000)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'open')
    await expect(rows(page, 'alpha')).toHaveCount(1)
  })

  test('Fold: the height grows and shrinks in steps, never jumping', async ({ page }) => {
    await foldedProject(page, { sessions: 3 })
    await slowFolds(page)
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS)
    const opening = await heightsAlongTransition(region(page, 'alpha'))
    // From nothing to the full list, part way in between and never back: it did not arrive in one frame
    expect(opening.heights[0]).toBe(0)
    expect(opening.heights[4]).toBeGreaterThan(60)
    expect(nondecreasing(opening.heights)).toBe(true)
    expect(smooth(opening.heights)).toBe(true)
    await away(page)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'closing')
    const closing = await heightsAlongTransition(region(page, 'alpha'))
    expect(closing.heights[0]).toBe(opening.heights[4])
    expect(closing.heights[4]).toBe(0)
    expect(nonincreasing(closing.heights)).toBe(true)
    expect(smooth(closing.heights)).toBe(true)
  })

  test('Fold: a click on a row while the list is still opening lands', async ({ page }) => {
    await foldedProject(page, { sessions: 2 })
    await slowFolds(page)
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'opening')
    // The second session is the open one; the first is pressed while the list is still moving
    const first = rows(page, 'alpha').first()
    await expect(first).not.toHaveAttribute('aria-current', 'page')
    await first.click()
    expect(await stillMoving(region(page, 'alpha'))).toBe(true)
    await expect(first).toHaveAttribute('aria-current', 'page')
    // And the saved fold was left as it is, as it is for any row of a hover-expanded project
    expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects?.length)).toBe(1)
  })

  test('Fold: a click on the arrow while the list is opening makes it stay', async ({ page }) => {
    await foldedProject(page)
    await slowFolds(page)
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'opening')
    await page.getByTestId('project-fold-alpha').click()
    expect(await stillMoving(region(page, 'alpha'))).toBe(true)
    await away(page)
    await page.clock.runFor(1000)
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'open')
  })

  test('Fold: the arrow opens and closes a project with the same slide', async ({ page }) => {
    await foldedProject(page)
    await page.getByTestId('project-fold-alpha').click()
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'opening')
    await page.getByTestId('project-fold-alpha').click()
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'closing')
    await expect(rows(page, 'alpha')).toHaveCount(1)
    await page.clock.runFor(LEAVE_MS + 1)
    await expect(rows(page, 'alpha')).toHaveCount(0)
  })

  test('Fold: a list on its way out takes no presses and no focus', async ({ page }) => {
    await foldedProject(page)
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'opening')
    await page.clock.runFor(300)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'open')
    await away(page)
    await expect(region(page, 'alpha')).toHaveAttribute('data-fold', 'closing')
    await expect(region(page, 'alpha')).toHaveJSProperty('inert', true)
  })

  test('Fold: before the saved folds are read, a fold neither slides nor waits', async ({ page }) => {
    await page.clock.install()
    await setup(page, { projects: ['/tmp/alpha'] })
    await newSession(page, 'alpha', 'task')
    await page.evaluate(() => (window as any).__store.setState({ workspaceReady: false }))
    await away(page)
    await page.clock.pauseAt(new Date(Date.now() + 60_000))
    await page.getByTestId('project-fold-alpha').click()
    // The clock is paused and never moved: a list that waited for a timer would still be here
    await expect(region(page, 'alpha')).toHaveCount(0)
    await expect(rows(page, 'alpha')).toHaveCount(0)
  })

  test('Fold: with reduced motion the list does not travel, it only fades', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await foldedProject(page, { sessions: 3 })
    await restOnEmptySpace(page)
    await page.clock.runFor(REST_MS)
    const list = region(page, 'alpha')
    await expect(rows(page, 'alpha')).toHaveCount(3)
    await expect(list).toHaveCSS('transition-property', 'opacity')
    // Full height from the first frame: no frame of it is part way
    const opening = await heightsWhileMoving(list)
    expect(new Set(opening).size).toBe(1)
    const full = opening[0]!
    expect(full).toBeGreaterThan(60)
    await away(page)
    // Fading out in place: as tall as before until the rows are taken away, then gone at once
    await expect(list).toHaveAttribute('data-fold', 'closing')
    expect((await heightsWhileMoving(list, full)).every((h) => h === full)).toBe(true)
    await expect(rows(page, 'alpha')).toHaveCount(3)
    await page.clock.runFor(LEAVE_MS + 1)
    await expect(rows(page, 'alpha')).toHaveCount(0)
  })
}

/** An orchestrator with children (`current`, started by it) and `earlier` ones; the clock is paused after setup and moved by hand */
export async function orchestratorWithChildren(page: Page, opts: { current?: string[]; earlier?: string[] } = { current: ['alpha', 'beta'] }): Promise<Record<string, unknown> & { id: string }> {
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

export function orchestratorFoldTests() {
  const fold = (page: Page) => page.getByTestId('orchestrator-fold')
  const button = (page: Page) => page.getByTestId('orchestrator-button')
  const row = (page: Page, name: string) => page.getByTestId(`orchestrator-child-row-orc-child-${name}`)

  test('Fold: the orchestrator children grow in steps, never jumping', async ({ page }) => {
    await orchestratorWithChildren(page, { current: ['alpha', 'beta', 'gamma'] })
    await slowFolds(page)
    await button(page).hover()
    await page.clock.runFor(REST_MS)
    const opening = await heightsAlongTransition(fold(page))
    expect(opening.heights[0]).toBe(0)
    expect(opening.heights[4]).toBeGreaterThan(60)
    expect(nondecreasing(opening.heights)).toBe(true)
    expect(smooth(opening.heights)).toBe(true)
  })

  test('Fold: a press on an orchestrator child while the list is still opening lands', async ({ page }) => {
    await orchestratorWithChildren(page, { current: ['alpha', 'beta', 'gamma'] })
    await slowFolds(page)
    await button(page).hover()
    await page.clock.runFor(REST_MS)
    await expect(fold(page)).toHaveAttribute('data-fold', 'opening')
    await row(page, 'alpha').click()
    expect(await stillMoving(fold(page))).toBe(true)
    await expect(row(page, 'alpha')).toHaveAttribute('aria-current', 'page')
  })

  test('Fold: the orchestrator children stay in the page until their exit ends', async ({ page }) => {
    await orchestratorWithChildren(page)
    await button(page).hover()
    await page.clock.runFor(REST_MS)
    await expect(row(page, 'alpha')).toBeVisible()
    await away(page)
    await expect(fold(page)).toHaveAttribute('data-fold', 'closing')
    await expect(row(page, 'alpha')).toHaveCount(1)
    await page.clock.runFor(LEAVE_MS - 1)
    await expect(row(page, 'alpha')).toHaveCount(1)
    await page.clock.runFor(2)
    await expect(row(page, 'alpha')).toHaveCount(0)
    await expect(fold(page)).toHaveCount(0)
  })

  test('Fold: the orchestrator children fade in place with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await orchestratorWithChildren(page)
    await button(page).hover()
    await page.clock.runFor(REST_MS)
    await expect(row(page, 'alpha')).toBeVisible()
    await expect(fold(page)).toHaveCSS('transition-property', 'opacity')
    expect(new Set(await heightsWhileMoving(fold(page))).size).toBe(1)
  })
}
