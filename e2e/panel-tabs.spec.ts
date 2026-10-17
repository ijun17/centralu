import { expect, test, type Page } from '@playwright/test'
import { setup, newSession } from './fixtures/panel.js'

/**
 * The right-hand panel and the grid around it: the panel's tabs — reorder, split and one global
 * arrangement (#20). Moved out of panel.spec.ts by subject; the shared helpers (setup, newSession,
 * openGrid) are in fixtures/panel.ts.
 */

/*
 * ── Panel tabs: reorder, split, and one global arrangement (#20) ─────
 *
 * The tabs can be dragged into a new order, and dragged into the bottom half of the
 * body to split the panel into two stacked groups. The arrangement is global — one for
 * the whole app, surviving a relaunch — because the panel is a way of looking, not
 * project state. Drags are dispatched by hand with one shared DataTransfer, the same
 * technique as the grid tests above (Playwright's dragAndDrop is atomic).
 */

/** The strip order as the user sees it — every tab button, in DOM order */
async function tabOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="evidence-tab-"]')].map((el) =>
      el.dataset.testid!.slice('evidence-tab-'.length),
    ),
  )
}

async function startTabDrag(page: Page, tab: string) {
  await page.evaluate((t: string) => {
    const w = window as never as { __dt?: DataTransfer }
    w.__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="evidence-tab-${t}"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true }))
  }, tab)
}

/** dragover then drop on the left (20%) or right (80%) half of another tab */
async function dropOnTab(page: Page, target: string, side: 'left' | 'right') {
  await page.evaluate(
    ({ to, where }: { to: string; where: string }) => {
      const dt = (window as never as { __dt?: DataTransfer }).__dt
      const el = document.querySelector(`[data-testid="evidence-tab-${to}"]`)!
      const r = el.getBoundingClientRect()
      const opts = {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8,
        clientY: r.top + r.height / 2,
      }
      el.dispatchEvent(new DragEvent('dragover', opts))
      el.dispatchEvent(new DragEvent('drop', opts))
    },
    { to: target, where: side },
  )
}

/** dragover then drop on the bottom half of the top group's body — the split gesture */
async function dropOnBodyBottom(page: Page) {
  await page.evaluate(() => {
    const dt = (window as never as { __dt?: DataTransfer }).__dt
    const el = document.querySelector('[data-testid="evidence-body-0"]')!
    const r = el.getBoundingClientRect()
    const opts = {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height * 0.8,
    }
    el.dispatchEvent(new DragEvent('dragover', opts))
    el.dispatchEvent(new DragEvent('drop', opts))
  })
}

/**
 * One tab-strip row carries two things (user request, 2026-09-07): the left side for where to go,
 * the right side for **the current tab's controls**. It used to draw an extra header per tab,
 * making the strip two rows.
 */
test('the active tab\'s controls live in the tab strip, not in a second header', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  const actions = page.getByTestId('evidence-actions')
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(actions.getByTestId('terminal-add')).toBeVisible()

  // Switching tabs also switches the buttons to that tab's own — no leftover button from another tab
  await page.getByTestId('evidence-tab-files').click()
  await expect(actions.getByTestId('toggle-ignored')).toBeVisible()
  await expect(actions.getByTestId('terminal-add')).toHaveCount(0)
})

/**
 * When space runs short, tabs are the side that yields — control buttons act on what is being
 * viewed, so they never fold. A folded tab has not disappeared; it can still be picked by name
 * behind the `…`.
 */
test('when the strip runs out of room the extra tabs fold into a … menu', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('evidence-tab-terminal')).toBeVisible()

  // At a width where 'Show ignored' takes up the right side, the last tab gets pushed out
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setPanelWidth(280))

  const more = page.getByTestId('evidence-tabs-more')
  await expect(more).toBeVisible()
  await expect(page.getByTestId('evidence-tab-terminal')).toHaveCount(0)
  // The tab currently selected does not fold — the screen must never lose track of where the person currently is
  await expect(page.getByTestId('evidence-tab-files')).toBeVisible()

  await more.click()
  await page.getByTestId('evidence-overflow-tab-terminal').click()
  // The picked tab gets a slot (a different tab folds instead to make room)
  await expect(page.getByTestId('evidence-tab-terminal')).toBeVisible()
  await expect(page.getByTestId('evidence-actions').getByTestId('terminal-add')).toBeVisible()
})

test('tab order is dragged, and survives a relaunch — one arrangement for the whole app (#20)', async ({
  page,
}) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  expect(await tabOrder(page)).toEqual(['git', 'history', 'files', 'terminal'])

  await startTabDrag(page, 'terminal')
  await dropOnTab(page, 'git', 'left')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])

  /*
   * A relaunch: fresh page, fresh store, fresh mock — only localStorage survives, which
   * is the mock's stand-in for the host's on-disk snapshot. The project has to be added
   * again (the mock's projects are in-memory), and the arrangement must already be back.
   */
  await page.goto('/?mock=1')
  // The intro screen does not appear again — introSeen was saved in the snapshot (localStorage) (#63)
  await expect(page.getByTestId('add-project')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  await newSession(page, 'alpha', 'claude', 'again')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])
})

test('dragging a tab to the bottom half splits the panel — two tabs visible at once (#20)', async ({
  page,
}) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)

  // Git stays on top, the file tree opens below it — both on screen at the same time
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await expect(page.getByTestId('file-tree')).toBeVisible()
  // The bottom group has its own strip, holding the tab that moved down
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()
  await expect(page.getByTestId('evidence-tabs-1').getByTestId('evidence-tab-files')).toBeVisible()
  // The top strip gave that tab up — a tab lives in exactly one group
  expect(await tabOrder(page)).toEqual(['git', 'history', 'terminal', 'files'])
})

/*
 * Adjusting the split ratio (dogfooding request). A fixed 50/50 split could not express "the
 * terminal can be narrow but the diff needs to be wide." Dragging the boundary (the top edge of
 * the bottom body) changes the ratio, which is carried in the snapshot and survives a relaunch,
 * and a double-click resets it to 50/50.
 */
test('the boundary between two split panels is dragged to move it — it survives a relaunch, and a double-click resets it to 50/50', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  const topHeight = () =>
    page.getByTestId('evidence-body-0').evaluate((el) => el.getBoundingClientRect().height)
  const before = await topHeight()

  // The boundary moves down 120px — the top body grows
  const handle = page.getByTestId('panel-split-handle')
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 120, { steps: 4 })
  await page.mouse.up()
  expect(await topHeight()).toBeGreaterThan(before + 80)
  const saved = await page.evaluate(() => (window as any).__store.getState().panelSplit)
  expect(saved).toBeGreaterThan(0.6)

  // A relaunch — the ratio comes back right where the layout comes back
  await page.goto('/?mock=1')
  await expect(page.getByTestId('add-project')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__store.getState().panelSplit)).toBeCloseTo(saved, 5)

  // Resetting: re-add the project to bring the panel up, then double-click — back to 50/50
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()
  await newSession(page, 'alpha', 'claude', 'again')
  await page.getByTestId('panel-split-handle').dblclick()
  expect(await page.evaluate(() => (window as any).__store.getState().panelSplit)).toBe(0.5)
})

/*
 * The dogfooding overlap: git on top, another tab split below, and the top group's
 * content painted over the bottom group's tab strip. Two causes, both fixed — the git
 * tab's fixed-height history strip (removed; history lives in its own tab) and the
 * group body clipping nothing (overflow-hidden now). The hit test is the claim: if
 * anything overlaps the strip, the point under its tab resolves to the intruder.
 */
test('a tall top group never paints over the bottom group‘s tab strip', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = Array.from({ length: 80 }, (_, i) => ({
      path: `src/f${i}.ts`,
      staged: false,
      status: 'M',
    }))
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="evidence-tabs-1"]')!
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
  })
  expect(hit).toBe(true)
})

test('dragging the bottom group‘s last tab back to the top strip closes the split (#20)', async ({
  page,
}) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  await startTabDrag(page, 'files')
  await dropOnTab(page, 'terminal', 'right')

  await expect(page.getByTestId('evidence-tabs-1')).toBeHidden()
  await expect.poll(() => tabOrder(page)).toEqual(['git', 'history', 'terminal', 'files'])
  // One body again, showing the tab that just landed (dropping it is picking it)
  await expect(page.getByTestId('file-tree')).toBeVisible()
  await expect(page.getByTestId('evidence-git')).toBeHidden()
})

test('⌘⇧1–4 keeps working after a reorder — the digit follows the tab, not the seat (#20)', async ({
  page,
}) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await startTabDrag(page, 'terminal')
  await dropOnTab(page, 'git', 'left')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])

  /*
   * Identity mapping (1 git · 2 history · 3 files · 4 terminal): the Settings list is
   * static text, so only a mapping a reorder does not move can stay truthful — and
   * muscle memory should not be silently retargeted by a drag.
   */
  await page.keyboard.press('ControlOrMeta+Shift+Digit3')
  await expect(page.getByTestId('file-tree')).toBeVisible()

  // 4 is still the terminal even though the terminal now sits first in the strip
  await page.keyboard.press('ControlOrMeta+Shift+Digit4')
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+Shift+Digit1')
  await expect(page.getByTestId('evidence-git')).toBeVisible()
})
