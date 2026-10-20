import { test, expect, type Page } from '@playwright/test'
import { setup, newSession, injectApproval, emitEvent } from './fixtures/control.js'

/**
 * The control loop's scenarios on the evidence panel: the sidebar's changed count, kept in step
 * with git (#41, #49). Moved out of control-evidence-git-files.spec.ts by subject; the shared
 * helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * The changed count lives in the project's tooltip (owner, 2026-10-20: the name line no longer carries it), drawn into
 * the body while the pointer or the keyboard is on the project's name. This hovers the name and returns the count's row.
 */
async function changedRow(page: Page, project: string) {
  await page.getByTestId(`project-header-${project}`).hover()
  return page.getByTestId(`project-detail-changed-${project}`)
}

/**
 * The sidebar's changed count was read once, at attach, and never again (#41).
 *
 * So an agent could edit ten files and commit them while the number beside the project
 * name sat on whatever it had been at app start — the most visible of the three stale
 * git surfaces, because it is on screen in every view.
 *
 * A turn ending is the cheap, strong signal that the tree moved: it means an agent just
 * stopped editing in that folder. Which is also why a burst of them has to cost **one**
 * `git status` — two sessions in one project finishing together are one piece of news.
 */
test('a finished turn moves the sidebar changed count, once per burst (#41)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'one')
  await newSession(page, 'alpha', 'two')

  // The working tree moved while the agents worked
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitStatusCalls = 0
    m.gitState.files = [
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
      { path: 'c.ts', staged: false, status: 'M' },
    ]
  })

  // Both sessions of the project finish in the same instant — the burst the debounce is for
  await page.evaluate(() => {
    const m = (window as any).__mock
    for (const s of [...m.sessions.values()] as any[]) m.emit({ type: 'turn_complete', sessionId: s.id })
  })

  await expect(page.getByTestId('mark-changed-alpha')).toHaveCount(0)
  await expect(await changedRow(page, 'alpha')).toContainText('3 uncommitted files')

  // Two turns, one measurement (800ms per project)
  expect(await page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(1)
})

/**
 * Waiting for `turn_complete` alone freezes the count for as long as the turn runs — ten
 * minutes of watching an agent edit files while the sidebar insists nothing has changed.
 * Letting an edit through says the tree is about to move, so it counts as news too (#41).
 */
test('granting a file edit refreshes the project count before the turn ends (#41)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await injectApproval(page, 0, { kind: 'file_edit', path: 'src/a.ts', diffPreview: '+one', multi: false })
  await page.evaluate(() => {
    const m = (window as any).__mock
    // The edit lands in the moment after the click — the refresh has to measure after it
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
  })

  await page.getByTestId('approve-allow').click()
  await expect(await changedRow(page, 'alpha')).toContainText('1 uncommitted file')
})

/**
 * A commit from the narrow panel goes through the same path (#49).
 *
 * This case stands out even more: the button sits **right next to** the sidebar, so after
 * committing, the number a few pixels to the left holding onto its old value was visible at a
 * glance.
 */
test("Committing from the narrow panel still updates the sidebar's changed count (#49)", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: true, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'task')
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(await changedRow(page, 'alpha')).toContainText('2 uncommitted files')

  await page.getByTestId('evidence-commit-message').fill('commit from the panel')
  await page.getByTestId('evidence-commit').click()

  await expect(await changedRow(page, 'alpha')).toContainText('1 uncommitted file')
})

/**
 * Not just commits — **anything that changes the repository** reports in (#49).
 *
 * Staging usually does not move the count (porcelain shows one line per path whether staged or
 * not), and switching branches changes the **name**, not the count. So neither can be confirmed
 * from an on-screen number — instead this counts whether the store re-measured at all. The point
 * is not to guess what changed and filter based on that in either case: a rule like that stays
 * silently wrong for a long time.
 *
 * `push` is deliberately left out. None of what the sidebar shows (branch, change count, whether
 * it is a repo) moves, so re-measuring would just be a call guaranteed to return the same answer.
 */
test('Staging and switching branches notify the sidebar too — push does not (#49)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'feature', current: false, remote: false },
    ]
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-git-full').click()

  await page.evaluate(() => ((window as any).__mock.gitStatusCalls = 0))
  await page.getByTestId('evidence-stage-all').click()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(1)

  await page.getByTestId('evidence-push').click()
  await expect(page.getByTestId('toast')).toContainText('Pushed')
  // Push queries nothing — it stays at the one call from above
  expect(await page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(1)

  // Entering branches goes through the sidebar's branch button (there is no tab inside the
  // overlay, 2026-09-07)
  await page.getByTestId('evidence-branch').click()
  await page.getByTestId('branch-feature').click()
  await expect(page.getByTestId('toast')).toContainText('Switched to feature')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(2)
})

/**
 * Nothing in the app watches the filesystem, so work done **outside** it — a commit typed
 * into a terminal, a rebase, a `git clean` — is invisible until we come back and ask (#41).
 * Returning to the window is that moment, and it is the only signal we get for it.
 */
test('returning to the window re-reads every project (#41)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })

  await page.evaluate(() => {
    const store = (window as any).__store.getState()
    store.setAppFocused(false)
    // Someone committed in a terminal while the app was in the background
    ;(window as any).__mock.gitState.files = [
      { path: 'x.ts', staged: false, status: 'M' },
      { path: 'y.ts', staged: false, status: 'M' },
    ]
    store.setAppFocused(true)
  })

  await expect(await changedRow(page, 'alpha')).toContainText('2 uncommitted files')
  await expect(await changedRow(page, 'beta')).toContainText('2 uncommitted files')
})
