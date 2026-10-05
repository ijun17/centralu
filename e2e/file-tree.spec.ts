import { expect, test, type Page } from '@playwright/test'

/**
 * The side of the file tree that **changes** files (#18, #19).
 *
 * Up to now the tree only displayed things. What is asked here is whether four things actually
 * happen, and more importantly, whether they do **not** happen when they should not: does it
 * refuse to overwrite an occupied spot, does it say where a deleted file went so it can be
 * recovered, and did the drag that already existed (dropping a path into the composer) get
 * pushed aside by the new drag.
 *
 * That is also why this is its own file. control-loop watches one lap of the control loop, and
 * panel watches what the screen picks when several are open. This one watches only **whether
 * files move**.
 */

async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as any).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('orchestrator-pick-folder').click()
  // Registering a project the first time leads straight into creating a session — this test
  // only needs the project, so close it
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

/** Draws the mock's file tree. `entries` is "parent path → the items inside it" */
async function seedTree(page: Page, entries: Record<string, { name: string; isDir?: boolean; ignored?: boolean }[]>) {
  await page.evaluate((e: Record<string, { name: string; isDir?: boolean; ignored?: boolean }[]>) => {
    const m = (window as any).__mock
    for (const [dir, items] of Object.entries(e)) {
      m.fsState.entries[dir] = items.map((i) => ({
        name: i.name,
        path: dir ? `${dir}/${i.name}` : i.name,
        isDir: !!i.isDir,
        ignored: !!i.ignored,
      }))
      for (const i of items) if (i.isDir) m.fsState.entries[dir ? `${dir}/${i.name}` : i.name] ??= []
    }
  }, entries)
}

async function openTree(page: Page, prompt = 'work') {
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes through the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-tree')).toBeVisible()
}

/*
 * ── What right-click opens ────────────────────────────────────────────
 */

/**
 * Deleting means **sending it somewhere it can be recovered from** (#18).
 *
 * There being no confirmation dialog is a decision, not an oversight, so the toast has to say
 * where the file went — a row simply vanishing communicates only "it is gone," nothing more.
 */
test('right-click → Trash: the row disappears, and it says where it went', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'a.ts' }, { name: 'keep.ts' }] })
  await openTree(page)

  await expect(page.getByTestId('file-a.ts')).toBeVisible()
  await page.getByTestId('file-a.ts').click({ button: 'right' })
  await expect(page.getByTestId('file-menu')).toBeVisible()
  await page.getByTestId('file-menu-trash').click()

  await expect(page.getByTestId('file-a.ts')).toBeHidden()
  // The neighboring row must stay put — the whole list vanishing is not the same as one row going away
  await expect(page.getByTestId('file-keep.ts')).toBeVisible()
  await expect(page.getByTestId('toast')).toContainText('Trash')

  // Did it go to the real OS trash (not a hard delete) — check what the port received
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual(['a.ts'])
})

/** The label reads however this desktop names it — the UI never asks which OS it is (same rule as #32) */
test('right-click → reveal in file manager', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'a.ts' }] })
  await openTree(page)

  await page.getByTestId('file-a.ts').click({ button: 'right' })
  await expect(page.getByTestId('file-menu-reveal')).toContainText('Reveal in Finder')
  await page.getByTestId('file-menu-reveal').click()

  await expect(page.getByTestId('file-menu')).toBeHidden()
  expect(await page.evaluate(() => (window as any).__mock.revealed)).toEqual(['a.ts'])
})

/** An ignored file is still just a file (#17) — if it is visible, it must be actionable too */
test('a file caught by .gitignore can still be sent to Trash', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: '.env.local', ignored: true }] })
  await openTree(page)

  await page.getByTestId('file-.env.local').click({ button: 'right' })
  await page.getByTestId('file-menu-trash').click()
  await expect(page.getByTestId('toast')).toContainText('.env.local')
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual(['.env.local'])
})

/*
 * ── Drag and drop: the same gesture means different things depending on where it lands ──────────
 */

test('dropping onto a folder moves the file into it', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'src', isDir: true }, { name: 'a.ts' }], src: [] })
  await openTree(page)

  await page.getByTestId('file-a.ts').dragTo(page.getByTestId('dir-src'))

  await expect(page.getByTestId('file-a.ts')).toBeHidden()
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
})

/**
 * **There is no overwriting** — the file sitting there could be the very one the agent is
 * currently editing, and a silent swap is the one outcome that has no way back at all.
 */
test('when the spot is occupied, nothing moves and it says what it collided with', async ({ page }) => {
  await setup(page)
  await seedTree(page, {
    '': [{ name: 'src', isDir: true }, { name: 'a.ts' }],
    src: [{ name: 'a.ts' }],
  })
  await openTree(page)

  await page.getByTestId('file-a.ts').dragTo(page.getByTestId('dir-src'))

  await expect(page.getByTestId('toast')).toContainText('src/a.ts already exists')
  // The original stays put — a half-moved state is the worst outcome
  await expect(page.getByTestId('file-a.ts')).toBeVisible()
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
})

/** Moving something out of a folder again — the root has no row of its own, so empty space stands in for it */
test('dropping into the tree\'s empty space moves the file to the project root', async ({ page }) => {
  await setup(page)
  await seedTree(page, {
    '': [{ name: 'src', isDir: true }],
    src: [{ name: 'a.ts' }],
  })
  await openTree(page)
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()

  await page.getByTestId('file-src/a.ts').dragTo(page.getByTestId('file-drop-root'), {
    // Drop into the empty space below the list, not onto a folder row
    targetPosition: { x: 40, y: 120 },
  })

  await expect(page.getByTestId('file-a.ts')).toBeVisible()
  await expect(page.getByTestId('file-src/a.ts')).toBeHidden()
})

/**
 * A file dragged in from outside (the second half of #19).
 *
 * An OS drop can only be produced by a human hand, so the event is constructed and dispatched
 * directly here — what is being checked is not the browser's drag implementation but **how the
 * app tells apart a drop that carries `Files`**. Unlike a drop from the tree, it has no MIME of
 * ours, and that is the only distinction.
 */
test('a file dragged in from Finder lands in the folder it was dropped on', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'src', isDir: true }], src: [] })
  await openTree(page)

  const dt = await page.evaluateHandle(() => {
    const t = new DataTransfer()
    t.items.add(new File(['shot'], 'dropped.png', { type: 'image/png' }))
    return t
  })
  await page.dispatchEvent('[data-testid="file-drop-src"]', 'dragover', { dataTransfer: dt })
  await page.dispatchEvent('[data-testid="file-drop-src"]', 'drop', { dataTransfer: dt })

  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/dropped.png')).toBeVisible()
})

/**
 * Whether the drag that already existed still works (what #19 explicitly worried about).
 *
 * One gesture, dragging the same row, now means two different things. What tells them apart is
 * **where it is dropped**: the composer inserts the path into the sentence, and the tree moves
 * the file. Adding move support touched the drag's own property (`effectAllowed`), so this checks
 * that the composer side did not die quietly — and a quiet death looks exactly like "nothing
 * happens," which the eye alone cannot catch.
 */
test('dropping onto the composer still inserts the path into the sentence, as before', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'a.ts' }] })
  await openTree(page)

  await page.getByTestId('file-a.ts').dragTo(page.getByTestId('input-dropzone'))

  await expect(page.getByTestId('input-dropzone').locator('textarea')).toHaveValue('@a.ts ')
  // It was referenced, not moved — the file must still be there
  await expect(page.getByTestId('file-a.ts')).toBeVisible()
})

/**
 * The "Edited by agent" indicator attaches only to files a session of this project touched
 * (#185). Paths are relative to the project, so pooling sessions from every project into one set
 * made it attach to a path of the same name in a different project too.
 */
test('the touched-file indicator attaches only to files touched by a session of this project (#185)', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'a.ts' }, { name: 'b.ts' }] })
  await openTree(page)
  await page.evaluate(() => {
    const w = window as any
    const st = w.__store.getState()
    const sid = st.focusedSessionId
    w.__mock.emit({ type: 'files_touched', sessionId: sid, paths: ['b.ts'] })
    // A session in a different project touched a path with the same name
    const other = { ...st.sessions[sid], id: 'other-project-session', projectId: 'other-project', touchedPaths: ['a.ts'] }
    w.__store.setState({ sessions: { ...w.__store.getState().sessions, [other.id]: other } })
  })

  await expect(page.getByTestId('file-b.ts').getByTitle('Edited by agent')).toBeVisible()
  await expect(page.getByTestId('file-a.ts').getByTitle('Edited by agent')).toHaveCount(0)
})

/**
 * Even with text scaled up, the menu appears where it was clicked and stays inside the window
 * (#183). Click coordinates are screen px already multiplied by the zoom, but a fixed length gets
 * the zoom multiplied into it a second time, so at 1.25x zoom the menu was pushed down and to the
 * right, and at the window's right edge it landed entirely outside the window.
 */
test('with text zoomed in, the right-click menu still appears where clicked and stays inside the window (#183)', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'a.ts' }] })
  await openTree(page)
  await page.evaluate(() => (window as any).__store.getState().setPrefs({ textSize: 1.25 }))
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-zoom').trim())).toBe('1.25')

  const row = (await page.getByTestId('file-a.ts').boundingBox())!
  const at = { x: row.x + row.width - 10, y: row.y + row.height / 2 }
  await page.mouse.click(at.x, at.y, { button: 'right' })
  const menu = (await page.getByTestId('file-menu').boundingBox())!
  const viewport = page.viewportSize()!

  expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width)
  expect(Math.abs(menu.y - at.y)).toBeLessThanOrEqual(4)
})
