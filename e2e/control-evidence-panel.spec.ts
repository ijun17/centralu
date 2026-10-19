import { test, expect } from '@playwright/test'
import { setup, newSession } from './fixtures/control.js'

/**
 * The control loop's scenarios on the evidence panel: its place beside the conversation, the wide
 * overlay, the rail and its width. Moved out of control-evidence-git-files.spec.ts by subject; the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('3-lane layout: the evidence panel sits alongside the conversation and collapses with ⌘B (B-0)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Git and files do not replace the conversation — both must be visible at once
  await expect(page.getByTestId('chat-stream')).toBeVisible()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
  await expect(page.getByTestId('evidence-project')).toContainText('alpha')

  await page.keyboard.press('Meta+b')
  await expect(page.getByTestId('evidence-panel')).toBeHidden()
  // Collapsing the panel leaves the conversation untouched
  await expect(page.getByTestId('chat-stream')).toBeVisible()

  // The collapsed state is captured in the snapshot and restored after a restart
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelOpen).toBe(false)

  await page.keyboard.press('Meta+b')
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

test("A project's git, files and viewer can be viewed without any session (dogfooding finding: could not find where to look)", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
  })

  // Click the project name without creating a session
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()

  // Even with no session, the evidence panel belongs to the project, so it still shows
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
  await expect(page.getByTestId('evidence-file-src/a.ts')).toBeVisible()
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-README.md')).toBeVisible()
})

/**
 * The link between evidence and viewing detail.
 * The right side only holds lists; viewing detail happens in a wide overlay (a diff is
 * unreadable at 340px).
 */
test('Clicking a changed file opens the diff in a wide overlay, and Escape returns to the untouched conversation', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n-old()\n+next()'
  })
  await newSession(page, 'alpha', 'fix this function')

  await expect(page.getByTestId('evidence-change-count')).toHaveText('1')
  await page.getByTestId('evidence-file-src/a.ts').click()

  // The overlay covers the screen, opening directly to the diff for the clicked file (no need to
  // find it again in the list)
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('next()')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('overlay')).toBeHidden()
  // Closing it leaves the conversation untouched — there is no need to navigate back in
  await expect(page.getByTestId('chat-stream')).toContainText('fix this function')
})

test('A file opened from the file tree appears in the same overlay', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
    m.fsState.files['README.md'] = '# Alpha\nThis needs to be readable'
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-README.md').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('README.md')

  await page.getByTestId('overlay-close').click()
  await expect(page.getByTestId('overlay')).toBeHidden()
})

/**
 * The overlay covers the conversation, not the evidence lane (issue #15).
 *
 * It used to cover both, so opening a second file meant escape-and-find-it-again: the tree
 * you clicked from vanished under an opaque panel the moment it did its job. The assertions
 * below are the two halves of that. Geometry, because "visible" is not enough — the panel
 * was never unmounted, only hidden behind something painted over it, and Playwright's
 * visibility check does not see occlusion. Then a second click without an escape first,
 * because being uncovered is not the point either: the point is that the loop is now one
 * click long, and Playwright will not click through anything that gets in the way.
 */
test('The overlay covers only the conversation — the handle to open the next file must remain', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'a.ts', path: 'a.ts', isDir: false, ignored: false },
      { name: 'b.ts', path: 'b.ts', isDir: false, ignored: false },
    ]
    m.fsState.files['a.ts'] = 'first file'
    m.fsState.files['b.ts'] = 'second file'
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-a.ts').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('a.ts')

  // The overlay's right edge does not cross the evidence panel's left edge
  const edges = async () => {
    const o = (await page.getByTestId('overlay').boundingBox())!
    const p = (await page.getByTestId('evidence-panel').boundingBox())!
    return { overlayRight: o.x + o.width, panelLeft: p.x }
  }
  const viewerEdges = await edges()
  expect(viewerEdges.overlayRight).toBeLessThanOrEqual(viewerEdges.panelLeft + 1)

  // Go straight to the next file in the tree without Escape — if it were covered, this click
  // would not land
  await page.getByTestId('file-b.ts').click()
  await expect(page.getByTestId('viewer-path')).toContainText('b.ts')
})

/**
 * The same rule applies to diffs (issue #15). If anything, this hurts more — the change list is
 * something the person scans one file after another, and if the list disappears every time a
 * file is viewed, that scan is interrupted. The diff is unified, so a narrower width just shrinks
 * the line width and keeps the columns intact.
 */
test('The Git overlay follows the same rule — it does not cover the change list', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n-old()\n+first()'
    m.fsState.entries[''] = [{ name: 'notes.md', path: 'notes.md', isDir: false, ignored: false }]
    m.fsState.files['notes.md'] = 'This needs to be readable'
  })
  await newSession(page, 'alpha', 'fix both files')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('first()')

  const o = (await page.getByTestId('overlay').boundingBox())!
  const p = (await page.getByTestId('evidence-panel').boundingBox())!
  expect(o.x + o.width).toBeLessThanOrEqual(p.x + 1)

  // The panel stays alive — if it were covered, these clicks would be blocked by the overlay
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-notes.md').click()
  await expect(page.getByTestId('viewer-path')).toContainText('notes.md')
})

test('Collapsing the panel leaves a rail, and it re-expands from there', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'task')

  const collapse = (await page.getByTestId('evidence-close').boundingBox())!
  await page.getByTestId('evidence-close').click()
  await expect(page.getByTestId('evidence-panel')).toBeHidden()

  // Gone and collapsed are different — the rail stays, and it is the expand button alone (owner, 2026-10-19):
  // no change count, no running dot and no label; the sidebar's changes capsule says what changed
  const rail = page.getByTestId('evidence-rail')
  await expect(rail).toBeVisible()
  await expect(rail.getByTestId('evidence-open')).toBeVisible()
  await expect(rail.locator('button')).toHaveCount(1)
  await expect(rail.getByTestId('evidence-rail-count')).toHaveCount(0)
  await expect(rail.getByTestId('evidence-rail-running')).toHaveCount(0)
  // No label of its own. The pointer is still where the collapse button was, which is where the expand button now
  // stands, so its tooltip ("Expand panel (⌘B)") may be up: move away and wait for it to go before reading the text
  await page.mouse.move(0, 0)
  await expect(rail.getByRole('tooltip')).toHaveCount(0)
  await expect(rail).toHaveText('')
  // It stands at the height of the collapse button and is the same size
  const expand = (await page.getByTestId('evidence-open').boundingBox())!
  expect(expand.width).toBeCloseTo(collapse.width, 0)
  expect(expand.height).toBeCloseTo(collapse.height, 0)
  // (the header's own bottom border takes the half pixel the rail, which has none, does not)
  expect(Math.abs(expand.y + expand.height / 2 - (collapse.y + collapse.height / 2))).toBeLessThanOrEqual(1)

  await page.getByTestId('evidence-open').click()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

/**
 * Resizing the evidence panel + the terminal (M2.7).
 * A terminal's identity is its cwd — switching sessions must keep the same terminal alive.
 */
test('Dragging to resize the evidence panel persists after a restart', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const panel = page.getByTestId('evidence-panel')
  const before = (await panel.boundingBox())!.width

  const handle = page.getByTestId('evidence-resize')
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x - 160, box.y + 200, { steps: 8 })
  await page.mouse.up()

  const after = (await panel.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 100)

  // The width is captured in the snapshot (unchanged the next time it opens)
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelWidth).toBeGreaterThan(before + 100)

  // Double-click restores the default — there must be a way back after dragging it too far.
  // The width slides (an open/close transition), so measuring right away catches a mid-animation
  // value — wait for it to settle.
  await handle.dblclick()
  await expect.poll(async () => (await panel.boundingBox())!.width, { timeout: 2000 }).toBeCloseTo(340, -1)
})

/**
 * A panel's thick border is **the panel's own border** — it must never cover anything outside the panel.
 *
 * The ring used to be a layer at z-30, raised because the collapsed composer (z-20) inside the panel once
 * covered its bottom edge; when the panel did not establish its own stacking context, that 30 was still 30
 * outside the panel too, and a line got drawn over the files/git screen (z-20) (pointed out by the person).
 * It is a real border now (#736), and this keeps it that way.
 *
 * Rather than comparing numbers, this checks **what actually sits on top of that pixel**. A z
 * value means something different in every stacking context.
 */
test("An answering panel's border does not leak over the files/git screen", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)

  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.getState().setGridPanels([{ kind: 'session', sessionId: sid }])
    store.setState((s: any) => ({
      sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], state: 'working' } },
    }))
  }, id)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${id}`)).toHaveAttribute('data-look', 'answering')

  await page.evaluate(() => (window as any).__store.getState().openGit())
  await expect(page.getByTestId('overlay')).toBeVisible()

  const topAtBorder = await page.evaluate((sid) => {
    const panel = document.querySelector(`[data-testid="grid-panel-${sid}"]`) as HTMLElement | null
    if (!panel) return { found: false, inOverlay: false }
    const r = panel.getBoundingClientRect()
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 1))
    return { found: true, inOverlay: !!el?.closest('[data-testid="overlay"]') }
  }, id)
  expect(topAtBorder.found).toBe(true)
  expect(topAtBorder.inOverlay).toBe(true)
})
