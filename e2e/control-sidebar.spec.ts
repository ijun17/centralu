import { test, expect, type Page } from '@playwright/test'
import { tokenColor } from './fixtures/tokens.js'
import { setup, newSession, injectApproval, emitEvent } from './fixtures/control.js'

/**
 * The control loop's scenarios on the sidebar: projects and session rows, folding, menus, renaming and reordering. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * Where the person clicks and where the result appears must be adjacent (issue #4).
 *
 * It used to be at the far right of the top bar — the person clicked one side of the screen and
 * had to find the result on the other side. Relying on visual judgment alone lets them drift
 * apart again, so this pins it down with coordinates.
 */
test('The Add project button sits inside the sidebar, below the project list', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const sidebar = (await page.getByTestId('sidebar').boundingBox())!
  const add = (await page.getByTestId('add-project').boundingBox())!
  const project = (await page.getByTestId('project-alpha').boundingBox())!

  // It is inside the sidebar (not the top bar)
  expect(add.x).toBeGreaterThanOrEqual(sidebar.x - 1)
  expect(add.x + add.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1)
  // Right below where a new project is appended (the end of the list)
  expect(add.y).toBeGreaterThanOrEqual(project.y + project.height - 1)
  // New folder (#515) stands beside it, on the same row and inside the sidebar too
  const create = (await page.getByTestId('create-project').boundingBox())!
  expect(Math.abs(create.y - add.y)).toBeLessThanOrEqual(1)
  expect(create.x).toBeGreaterThan(add.x + add.width - 1)
  expect(create.x + create.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1)
})

/**
 * The menu appears **right next to the button that opened it**.
 *
 * It used to be fixed at one spot in the top right of the sidebar (with no positioned ancestor,
 * its coordinates resolved relative to the sidebar) — clicking the tenth project produced a
 * response at the very top, and the screen gave no clue which button the menu belonged to. When
 * there is no room below, it flips upward.
 */
test('The project menu opens below the clicked button, and flips upward when there is no room', async ({
  page,
}) => {
  /*
    There are three projects because the flipped menu needs **room to fit entirely above**. Once
    "New app..." was added to the menu (M4 C-1), the menu grew one line taller, and it no longer
    fits above the second project's button (it hits the top edge and covers the button). What
    this test checks is the flip itself, not the second row's coordinates — it measures against
    the third row, which does have room above it.
  */
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta', '/tmp/gamma'] })

  const geometry = async (name: string) => {
    await page.getByTestId(`project-header-${name}`).hover()
    await page.getByTestId(`project-menu-${name}`).click()
    const menu = page.getByTestId(`project-menu-open-${name}`)
    await expect(menu).toBeVisible()
    const b = (await page.getByTestId(`project-menu-${name}`).boundingBox())!
    const m = (await menu.boundingBox())!
    const viewport = page.viewportSize()!
    await page.keyboard.press('Escape')
    return { b, m, viewport }
  }

  const alpha = await geometry('alpha')
  // Below the button, aligned with the button's right edge
  expect(alpha.m.y).toBeGreaterThanOrEqual(alpha.b.y + alpha.b.height)
  expect(Math.round(alpha.m.x + alpha.m.width)).toBe(Math.round(alpha.b.x + alpha.b.width))
  // And it fits entirely within the screen
  expect(alpha.m.y + alpha.m.height).toBeLessThanOrEqual(alpha.viewport.height)

  /*
    **Under zoom too.** Using a measured coordinate (screen px already multiplied by zoom)
    directly as a fixed length (which gets multiplied by zoom again when drawn) put the menu 24px
    below and 103px to the left of the button at 1.1x zoom (measured — a dogfooding finding: "the
    menu position looks wrong"). A test that only measures at 1.0x zoom misses this whole class of
    bug. The person's actual setting is 1.1x.
  */
  await page.evaluate(() => {
    const style = document.documentElement.style as CSSStyleDeclaration & { zoom: string }
    style.zoom = '1.1'
    style.setProperty('--text-zoom', '1.1')
  })
  const zoomed = await geometry('alpha')
  const gap = zoomed.m.y - (zoomed.b.y + zoomed.b.height)
  expect(gap).toBeGreaterThanOrEqual(2)
  expect(gap).toBeLessThanOrEqual(8) // If zoom gets multiplied in twice, this exceeds 24
  expect(Math.abs(zoomed.m.x + zoomed.m.width - (zoomed.b.x + zoomed.b.width))).toBeLessThanOrEqual(2)
  await page.evaluate(() => {
    const style = document.documentElement.style as CSSStyleDeclaration & { zoom: string }
    style.zoom = '1'
    style.setProperty('--text-zoom', '1')
  })

  /*
    The flip is only visible where opening downward would overflow, and that spot only appears by
    shrinking the window. At 356px it still fits (menu bottom at 343.5 < 348) — the threshold is
    set by measurement, not by assuming the flip. Both heights grew by 36px with the Search button
    at the top of the sidebar (#529): any shorter and gamma's row is scrolled to the middle of the
    lane, where the menu has room neither below nor above.
  */
  await page.setViewportSize({ width: 1200, height: 276 })
  const gamma = await geometry('gamma')
  expect(gamma.m.y + gamma.m.height).toBeLessThanOrEqual(gamma.b.y) // It went above the button
  expect(gamma.m.y).toBeGreaterThanOrEqual(0)
})

/*
 * A narrow sidebar (dogfooding finding: shrinking the sidebar pushed the menu off the left edge
 * of the window, out of sight). The menu aligns with the button's right edge and opens leftward,
 * so when the button sits near the left edge of the window, the menu's width (192px) exceeds the
 * minimum sidebar width (180px) and gets clipped on the left — the session menu uses the same
 * shell (RowMenu), so measuring one side effectively measures both.
 */
test('A row menu stays fully on screen even when the sidebar is narrow', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'in a narrow spot')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate(() => (window as any).__store.getState().setSidebarWidth(0)) // Collapses to the minimum

  await page.getByTestId('project-menu-alpha').click()
  const pm = (await page.getByTestId('project-menu-open-alpha').boundingBox())!
  expect(pm.x).toBeGreaterThanOrEqual(0)
  await page.keyboard.press('Escape')

  await page.getByTestId(`session-menu-${id}`).click()
  const sm = (await page.getByTestId(`session-menu-open-${id}`).boundingBox())!
  expect(sm.x).toBeGreaterThanOrEqual(0)
})

test('Clicking a project name while viewing one of its sessions opens the project screen (reported by the person, 2026-09-28)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'task')
  await expect(page.getByTestId('prompt-input')).toBeVisible()
  await expect(page.getByTestId('project-view')).toHaveCount(0)

  // The same project's name — the session used to stay put
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(page.getByTestId('project-view-name')).toHaveText('alpha')

  // Going back to a session and then to another project already worked before — this checks it
  // still does
  await page.getByTestId('project-alpha').locator('[data-testid^="session-row-"]').first().click()
  await expect(page.getByTestId('project-view')).toHaveCount(0)
  await page.getByTestId('project-header-beta').click()
  await expect(page.getByTestId('project-view-name')).toHaveText('beta')
})

/*
 * Sidebar folding (#205). The only way to fold is the arrow on the name row, and the name still
 * opens the project screen. Folding is remembered per project and survives a restart, and a
 * folded row reports the count of sessions waiting in the same shape as the session marker.
 * Navigating to that session from outside, as from the inbox, unfolds it.
 */
const sessionRows = (page: Page, project: string) =>
  page.getByTestId(`project-${project}`).locator('[data-testid^="session-row-"]')

test("Sidebar: the arrow folds and unfolds a project's session rows (#205)", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'task')
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)

  await page.getByTestId('project-fold-alpha').click()
  await expect(sessionRows(page, 'alpha')).toHaveCount(0)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  // The name row stays, and the other project is untouched
  await expect(page.getByTestId('project-header-alpha')).toBeVisible()
  await expect(page.getByTestId('project-beta')).not.toHaveAttribute('data-folded', 'true')

  await page.getByTestId('project-fold-alpha').click()
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)
  await expect(page.getByTestId('project-alpha')).not.toHaveAttribute('data-folded', 'true')
})

test('Sidebar: clicking the name opens the project screen instead of folding (#205)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await expect(page.getByTestId('project-view')).toHaveCount(0)

  // Expanded, click the name — the project screen opens and the row stays as is
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)

  // Go back to the session, fold it, then click the name — still the project screen, and it does
  // not unfold either
  await sessionRows(page, 'alpha').first().click()
  await expect(page.getByTestId('project-view')).toHaveCount(0)
  await page.getByTestId('project-fold-alpha').click()
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  await expect(sessionRows(page, 'alpha')).toHaveCount(0)
})

test('Sidebar: folding survives a restart (#205)', async ({ page }) => {
  /*
   * Skip the intro with the grid button — not waking the orchestrator keeps the mock's id
   * counting the same across both runs. The real host keeps project ids in the DB, so they stay
   * the same across a restart; the mock forgets projects on reload, so this re-registers the
   * same folder in the same order to recover the same id (checked below).
   */
  const register = async () => {
    await page.evaluate(() => {
      ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
    })
    await page.getByTestId('add-project').click()
    await expect(page.getByTestId('project-alpha')).toBeVisible()
    if (await page.getByTestId('new-session-dialog').isVisible()) await page.keyboard.press('Escape')
    return page.evaluate(() => Object.keys((window as any).__store.getState().projects)[0] as string)
  }
  await page.goto('/?mock=1')
  await page.getByTestId('grid-button').click()
  const id = await register()

  await page.getByTestId('project-fold-alpha').click()
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects)).toEqual([id])

  await page.reload()
  // This must be the same project for the test to assert anything
  expect(await register()).toBe(id)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  await expect(page.getByTestId('project-fold-alpha')).toHaveAttribute('aria-label', 'Expand alpha')
})

test("Sidebar: a marker appears on the name row when a folded project's session is waiting for approval (#205)", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A task')
  await newSession(page, 'beta', 'B task') // Focus is on beta
  await page.getByTestId('project-fold-alpha').click()
  await expect(sessionRows(page, 'alpha')).toHaveCount(0)

  await injectApproval(page, 0, { kind: 'command', command: 'ls -la', cwd: '/tmp/alpha' })

  // The same chip and look as the session row marker (#736): an approval wears the waiting look, a pure-white
  // (ink-signal) ring, with a count where the label would be
  const mark = page.getByTestId('fold-summary-alpha').locator('[data-state="waiting_approval"]')
  await expect(mark).toHaveText('1')
  await expect(mark).toHaveAttribute('data-look', 'waiting')
  await expect(mark).toHaveCSS('background-color', await tokenColor(page, '--color-ink-signal'))
  await page.getByTestId('fold-summary-alpha').hover()
  await expect(page.getByTestId('fold-summary-tip-alpha')).toContainText('1 awaiting approval')
  // An expanded project has no summary — each row's own marker already says it
  await expect(page.getByTestId('fold-summary-beta')).toHaveCount(0)
})

test('Sidebar: navigating from the inbox to a session in a folded project unfolds it (#205)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A task')
  await newSession(page, 'beta', 'B task') // Focus is on beta
  await page.getByTestId('project-fold-alpha').click()
  await injectApproval(page, 0, { kind: 'command', command: 'ls -la', cwd: '/tmp/alpha' })

  await page.getByTestId('counter').click()
  await page.locator('[data-testid^="inbox-item-"]').first().click()

  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('project-alpha')).not.toHaveAttribute('data-folded', 'true')
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)
  // The unfolded state is remembered — the arrow always reflects exactly what is on screen
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects)).toEqual([])
})

test('The sidebar uses only one row per project (vertical space)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // The project header must not grow taller than one session row, or the list would be pushed down
  const header = (await page.getByTestId('project-header-alpha').boundingBox())!
  const row = (await page.locator('[data-testid^="session-row-"]').first().boundingBox())!
  expect(header.height).toBeLessThanOrEqual(row.height)

  // Background info does not take up space under normal conditions
  await expect(page.getByTestId('project-tip-alpha')).toBeHidden()
  await page.getByTestId('project-header-alpha').hover()
  await expect(page.getByTestId('project-tip-alpha')).toBeVisible()
  await expect(page.getByTestId('project-tip-alpha')).toContainText('/tmp/alpha')
})

/**
 * A marker with a bare number and no unit prompts "what is this?" (it actually did). The
 * browser's default title takes 1-2 seconds to appear, which is as good as not being there in
 * that moment.
 */
test('Hovering the project marker explains what it is', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
    ]
  })
  // The change count comes from the project list — force it to re-read
  await page.evaluate(() => (window as any).__store.getState().refreshProjects?.())

  const mark = page.getByTestId('mark-changed-alpha')
  if (await mark.count()) {
    await mark.hover()
    await expect(page.getByRole('tooltip')).toContainText('uncommitted')
  }
})

/** The sidebar order is decided by the person — drag to reorder, and it must survive a restart */
/**
 * The drop-position line sits **on the boundary** (dogfooding finding, 2026-09-10: "it is the
 * same spot but the line jitters up and down slightly").
 *
 * One boundary is shared by two rows — the "bottom" for the row above, the "top" for the row
 * below. If each is drawn inside its own row, they mean the same thing but appear a few px
 * apart. What this measures is whether the two representations point to **the same pixel**.
 */
test("The row above's bottom line and the row below's top line land at the same spot", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const ids = await page.evaluate(() =>
    Object.keys((window as never as { __store: any }).__store.getState().sessions),
  )

  /** Fires dragover on that row and measures the on-screen y of the line it produces */
  const lineY = async (id: string, half: 'top' | 'bottom') =>
    page.evaluate(
      async ({ sel, half }: { sel: string; half: 'top' | 'bottom' }) => {
        // The row (li) is what draws the line — the testid is on the button inside it
        const el = (document.querySelector(sel) as HTMLElement).closest('li') as HTMLElement
        const r = el.getBoundingClientRect()
        const over = () => {
          const dt = new DataTransfer()
          dt.setData('application/x-cc-session', 'dragged')
          el.dispatchEvent(
            new DragEvent('dragover', {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt,
              clientY: half === 'top' ? r.top + 2 : r.bottom - 2,
            }),
          )
        }
        /*
         * The line is attached via React state — **wait until it is actually drawn.** Counting a
         * fixed number of frames can measure a line that does not exist yet when the machine is
         * busy and produce NaN (this actually happened under parallel runs). A real drag keeps
         * firing dragover continuously too, so firing it again here matches that exactly.
         */
        let cs = getComputedStyle(el, '::after')
        for (let i = 0; i < 30 && cs.content === 'none'; i++) {
          over()
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
          cs = getComputedStyle(el, '::after')
        }
        if (cs.content !== 'none') {
          const h = parseFloat(cs.height) || 0
          // For a top line, top comes back numeric; for a bottom line, bottom does
          return cs.top !== 'auto' && cs.top !== ''
            ? r.top + parseFloat(cs.top)
            : r.bottom - parseFloat(cs.bottom) - h
        }
        /*
         * Measure the **position** regardless of how the line is drawn — using the same yardstick
         * even from when it was drawn with a box-shadow is what makes "fixing it passes,
         * reverting it fails" hold (a test of the fact, not the implementation).
         */
        const inset = /(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+\d/.exec(getComputedStyle(el).boxShadow)
        if (!inset) return Number.NaN
        const dy = parseFloat(inset[2]!)
        return dy > 0 ? r.top : r.bottom + dy
      },
      { sel: `[data-testid="session-row-${id}"]`, half },
    )

  const below = await lineY(ids[0]!, 'bottom')
  const above = await lineY(ids[1]!, 'top')
  expect(Math.abs(below - above)).toBeLessThanOrEqual(1)
})

test('Dragging a session reorders it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  const order = async () =>
    page.evaluate(() => {
      const s = (window as any).__store.getState()
      return Object.values(s.sessions).map((x: any) => x.name)
    })
  expect(await order()).toEqual(['first', 'second'])

  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))
  await page.dragAndDrop(`[data-testid="session-row-${ids[1]}"]`, `[data-testid="session-row-${ids[0]}"]`, {
    targetPosition: { x: 10, y: 2 }, // Dropping on the top half moves it earlier
  })

  await expect.poll(order).toEqual(['second', 'first'])
})

test('Dragging a project reorders it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })

  const order = async () =>
    page.evaluate(() => Object.values((window as any).__store.getState().projects).map((p: any) => p.name))
  expect(await order()).toEqual(['alpha', 'beta'])

  await page.dragAndDrop('[data-testid="project-header-beta"]', '[data-testid="project-alpha"]', {
    targetPosition: { x: 10, y: 2 },
  })

  await expect.poll(order).toEqual(['beta', 'alpha'])
})

/**
 * The sidebar's + and ✕ align on the same vertical line.
 *
 * Relying on visual judgment alone lets them drift apart again the next time a margin is
 * touched — they were actually off by 4px vs 12px at one point. This pins it down by measuring
 * the actual right-edge coordinates.
 */
test("The sidebar's project menu and delete button align on the same vertical line", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Both must be hovered to appear — the project row's menu is now hidden too
  await page.getByTestId('project-header-alpha').hover()
  await page.getByTestId(`session-row-${id}`).hover()

  const plus = (await page.getByTestId('project-menu-alpha').boundingBox())!
  const dots = (await page.getByTestId(`session-menu-${id}`).boundingBox())!

  expect(Math.abs(plus.x + plus.width - (dots.x + dots.width))).toBeLessThanOrEqual(1)
})

/**
 * The person can rename a session (issue #5).
 *
 * The automatic name is truncated from the first prompt. Sessions created by resuming or loading
 * a conversation all share the same first line, so four sessions named `This session is being
 * continued...` stood side by side in the list — the name told nothing apart, and the only way
 * to tell them apart was digging into the content.
 */
test('Renaming a session in the sidebar sticks — the automatic name never overwrites it afterward', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'This session is being continued from a previous conversation')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const row = page.getByTestId(`session-row-${id}`)
  await expect(row).toContainText('This session is being continued')

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`rename-session-${id}`).click()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('Guard MCP')
  await input.press('Enter')

  await expect(page.getByTestId(`session-row-${id}`)).toContainText('Guard MCP')

  // The automatic name must never overwrite it again — even when the tool reports a title, the
  // person's chosen name wins
  await emitEvent(page, 0, { type: 'session_title', title: 'This session is being continued…', auto: true })
  await expect(page.getByTestId(`session-row-${id}`)).toContainText('Guard MCP')
})

test('Switching away from the window mid-rename keeps the edit open, and saves nothing half-typed (#842 item 14)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'original name')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId(`session-row-${id}`).dblclick()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('half')
  // ⌘Tab to another app: the window loses focus, and the field blurs with it
  await page.evaluate(() => {
    const real = document.hasFocus.bind(document)
    ;(window as any).__realHasFocus = real
    document.hasFocus = () => false
    ;(document.activeElement as HTMLElement).blur()
  })
  await expect(input).toBeVisible()
  expect(await page.evaluate((sid) => (window as any).__store.getState().sessions[sid].name, id)).toBe('original name')

  // Back in the window: the field has focus again, and the name is finished there
  await page.evaluate(() => {
    document.hasFocus = (window as any).__realHasFocus
  })
  // As the window gives it back: the caret where it was, nothing selected
  await input.focus()
  await page.keyboard.type(' done')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId(`session-row-${id}`)).toContainText('half done')
})

test('Pressing Escape while editing the name leaves the old name unchanged', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'original name')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Double-clicking the name is the same entry point too (the usual tab-name convention)
  await page.getByTestId(`session-row-${id}`).dblclick()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('abandoned name')
  await input.press('Escape')

  await expect(page.getByTestId(`session-row-${id}`)).toContainText('original name')
})

/**
 * **No silent failure.** If a rename fails but the list has already switched to the new name, it
 * would revert with no explanation the next time the list refreshes.
 */
test('When a rename fails, the list stays unchanged and the person is told', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'original name')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Set up a situation where the host refuses — renaming after the session has disappeared is
  // the real-world path
  await page.evaluate((sid: string) => {
    ;(window as any).__mock.sessions.delete(sid)
  }, id)

  await page.getByTestId(`session-row-${id}`).dblclick()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('new name')
  await input.press('Enter')

  await expect(page.getByTestId('toast')).toContainText('Could not rename')
  await expect(page.getByTestId(`session-row-${id}`)).toContainText('original name')
})

/**
 * The drop-position indicator must not push the list around.
 *
 * Drawing it with a border grows the element by 1px, so the whole list shifts every time the
 * indicator moves to a new row — dragging it around makes everything jitter, and the spot the
 * hand is aiming for keeps moving.
 */
test('The list does not shift while dragging to reorder', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))

  const rowBox = async () => (await page.getByTestId(`session-row-${ids[1]}`).boundingBox())!
  const before = await rowBox()

  // Trigger the drop indicator's on state (just fire a dragover)
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="session-row-${id}"]`)!.parentElement!
    const dt = new DataTransfer()
    dt.setData('application/x-cc-session', 'other')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }),
    )
  }, ids[0])

  const after = await rowBox()
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5)
})
