import { test, expect, type Page } from '@playwright/test'
import { copied, pressCopy, watchCopies } from './fixtures/clipboard.js'
import { setup, newSession } from './fixtures/control.js'

/**
 * The control loop's scenarios on the evidence panel: the file tree and the viewer. Moved out of
 * control-evidence-git-files.spec.ts by subject; the shared helpers (setup, newSession, emitEvent
 * and the rest) are in fixtures/control.ts.
 */

test('File tree: lazy loading + toggling ignored entries (C-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'src', path: 'src', isDir: true, ignored: false },
      { name: 'node_modules', path: 'node_modules', isDir: true, ignored: true },
      { name: 'README.md', path: 'README.md', isDir: false, ignored: false },
    ]
    m.fsState.entries['src'] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
    m.fsState.files['src/a.ts'] = 'line one\nline two\nline three'
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-tree')).toBeVisible()

  /*
    Ignored entries are also **visible by default** (issue #17). Hiding them reads not as
    "filtered out" but as "does not exist" — and the file someone actually opened the tree to
    find is often the untracked one. Turning it off makes them disappear, and that choice
    persists (guarded by the test below).
  */
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()
  await page.getByTestId('toggle-ignored').uncheck()
  await expect(page.getByTestId('dir-node_modules')).toBeHidden()
  await page.getByTestId('toggle-ignored').check()
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()

  // Children are read only once opened (lazy)
  await expect(page.getByTestId('file-src/a.ts')).toBeHidden()
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
})

/**
 * "Can't see ignored files" (issue #17) turned out to mean two things at once, and both
 * are pinned here.
 *
 * The default is **on**: hiding them made the tree look like the file was not there rather
 * than filtered out, and the untracked file is often the one you opened the tree to find.
 *
 * The switch stays, for node_modules and build output — thousands of rows that sort in
 * among src. So the choice that a person actually makes here is *off*, and off is what has
 * to survive. It used to be component state, so leaving for the Git tab put it straight
 * back; the only way to notice a toggle exists is to still be looking at it.
 */
test('hiding ignored files is remembered — it is a way of looking, not a per-visit choice', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'src', path: 'src', isDir: true, ignored: false },
      { name: 'node_modules', path: 'node_modules', isDir: true, ignored: true },
    ]
  })
  await newSession(page, 'alpha', 'work')
  await page.getByTestId('evidence-tab-files').click()

  // Shown without being asked for — and still ignored: ink-faint says "the repo does not
  // track this" without shouting it
  await expect(page.getByTestId('toggle-ignored')).toBeChecked()
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()
  const tone = await page
    .getByTestId('dir-node_modules')
    .locator('span:not(:has(svg))')
    .evaluate((el) => getComputedStyle(el).color)
  const dir = await page.getByTestId('dir-src').evaluate((el) => getComputedStyle(el).color)
  const rgb = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number)
  expect(rgb(tone)[0]!).toBeLessThan(rgb(dir)[0]!)

  await page.getByTestId('toggle-ignored').uncheck()
  await expect(page.getByTestId('dir-node_modules')).toBeHidden()

  // The Git tab takes the tree off screen entirely — this is where it used to be forgotten
  await page.getByTestId('evidence-tab-git').click()
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await page.getByTestId('evidence-tab-files').click()

  await expect(page.getByTestId('toggle-ignored')).not.toBeChecked()
  await expect(page.getByTestId('dir-node_modules')).toBeHidden()
  // The tree is still there, so "hidden" is the filter and not an empty panel
  await expect(page.getByTestId('dir-src')).toBeVisible()

  // …and it is the stored choice, not just this component's memory
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.showIgnored).toBe(false)
})

test('Code viewer: opening a file, search, and large files (C-3, FR-6)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'big.ts', path: 'big.ts', isDir: false, ignored: false }]
    m.fsState.files['big.ts'] = Array.from({ length: 3000 }, (_, i) => `line ${i} content`).join('\n')
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-big.ts').click()

  // Opening a file covers the screen with a wide overlay
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('big.ts')

  // Even with 3000 lines, only what is visible gets rendered (virtual scroll)
  const rendered = await page.locator('[data-testid="code-viewer"] .whitespace-pre').count()
  expect(rendered).toBeLessThan(120)

  await page.getByTestId('viewer-search').fill('line 42 ')
  await expect(page.getByTestId('viewer-match-count')).toContainText('1 line')

  // Enter/Shift+Enter move between matches — bringing off-screen matches into view too (#183)
  const search = page.getByTestId('viewer-search')
  await search.fill('line 2999 ')
  await expect(page.getByTestId('viewer-match-count')).toContainText('1 line')
  await search.fill('9 content')
  await search.press('Enter')
  await expect(page.getByTestId('viewer-match-count')).toHaveText('1/300')
  await expect(page.locator('[data-current-match]')).toContainText('line 9 content')
  await search.press('Shift+Enter')
  await expect(page.getByTestId('viewer-match-count')).toHaveText('300/300')
  await expect(page.locator('[data-current-match]')).toContainText('line 2999 content')
})

/**
 * Copying out of the viewer (issue #36).
 *
 * The viewer is virtualized, so only ~40 rows exist in the DOM at any moment, and each row
 * carries its line number as a sibling span. A browser left to itself therefore copies a
 * fragment of the selection with the numbers mixed in. These tests read the real clipboard,
 * because the payload is the whole point — the on-screen highlight is not what was broken.
 */
async function openBigFile(page: Page, lines: number, opts: { truncated?: boolean } = {}) {
  await watchCopies(page)
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(
    ({ n, truncated }) => {
      const m = (window as any).__mock
      m.fsState.entries[''] = [{ name: 'big.ts', path: 'big.ts', isDir: false, ignored: false }]
      const text = Array.from({ length: n }, (_, i) => `const line${i} = ${i}`).join('\n')
      m.fs.readFile = async () => ({ text, truncated, binary: false, bytes: text.length })
    },
    { n: lines, truncated: !!opts.truncated },
  )
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-big.ts').click()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
}

const clipboard = copied

test('Viewer copy: ⌘A gives the whole file (#36)', async ({ page }) => {
  await openBigFile(page, 3000)

  // Nobody clicked anything: the code area takes focus when the file opens, which is what
  // gives ⌘A somewhere to land.
  await page.keyboard.press('ControlOrMeta+a')
  await pressCopy(page)

  const copied = await clipboard(page)
  expect(copied.split('\n')).toHaveLength(3000)
  expect(copied.startsWith('const line0 = 0\nconst line1 = 1')).toBe(true)
  expect(copied.endsWith('const line2999 = 2999')).toBe(true)
})

/*
 * ⌘A's claim outlives the rows it painted (#842 review of item 9). Scrolling to the end recycles every painted row, and
 * the live range collapses with them; the claim used to end there, and ⌘C copied the rows that happened to be mounted.
 */
test('Viewer copy: ⌘A, then scrolling to the end, still copies the whole file (#36, #842)', async ({ page }) => {
  await openBigFile(page, 3000)
  await page.keyboard.press('ControlOrMeta+a')
  const scroller = page.getByTestId('code-viewer').getByRole('region', { name: 'Code' })
  for (let i = 0; i < 6; i++) {
    await scroller.evaluate((el, step) => (el.scrollTop = ((step + 1) / 6) * el.scrollHeight), i)
    await page.waitForTimeout(50)
  }
  await expect(page.locator('[data-testid="code-viewer"] [data-line="2999"]')).toBeVisible()
  await expect(page.locator('[data-testid="code-viewer"] [data-line="0"]')).toHaveCount(0)
  await pressCopy(page)

  const copied = await clipboard(page)
  expect(copied.split('\n')).toHaveLength(3000)
  expect(copied.startsWith('const line0 = 0\n')).toBe(true)
  expect(copied.endsWith('const line2999 = 2999')).toBe(true)
})

test('Viewer copy: copying continues through lines that were never rendered (#36)', async ({ page }) => {
  await openBigFile(page, 3000)

  // Drag from line 3 and hold the pointer past the bottom edge so the list autoscrolls —
  // the way anyone selects a long stretch. Row 3 is recycled almost immediately, and from
  // there the browser walks the anchor out of the rows and into the app chrome: left alone,
  // ⌘C copies "Files / esc back to chat / Open in IDE" and none of the file.
  const start = (await page.locator('[data-testid="code-viewer"] .whitespace-pre').nth(3).boundingBox())!
  const view = (await page.getByTestId('code-viewer').boundingBox())!
  await page.mouse.move(start.x + 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(view.x + 60, view.y + view.height + 40, { steps: 5 })
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100)
    await page.mouse.move(view.x + 60 + (i % 2), view.y + view.height + 40)
  }
  await page.mouse.up()
  await pressCopy(page)

  const rows = (await clipboard(page)).split('\n')
  // More lines than the DOM ever holds at once: the ones in between were never there to be
  // copied from. (A count, not a number of lines: WebKit autoscrolls slower than Chromium.)
  const mounted = await page.locator('[data-testid="code-viewer"] [data-line]').count()
  expect(rows.length).toBeGreaterThan(mounted)
  expect(rows[0]).toBe('const line3 = 3')
  expect(rows[1]).toBe('const line4 = 4')
  // …the run has no gaps, and no line number rode along with any of it
  expect(rows.map((r, i) => r === `const line${i + 3} = ${i + 3}`).every(Boolean)).toBe(true)
})

test('Viewer copy: a truncated file says it was truncated (#36)', async ({ page }) => {
  await openBigFile(page, 200, { truncated: true })

  await page.keyboard.press('ControlOrMeta+a')
  await pressCopy(page)

  // Select-all claims "this is the file". When it is not, the clipboard says the same thing
  // the screen says rather than handing over half a file that looks whole.
  const copied = await clipboard(page)
  expect(copied).toContain('const line199 = 199')
  expect(copied.endsWith('…file is large; showing part of it. Open in your IDE to see the rest.')).toBe(true)
})

test('Viewer copy: ⌘A inside the search box behaves normally (#36)', async ({ page }) => {
  await openBigFile(page, 100)

  // The handler is the code area's, not the window's — select-all inside a text field has
  // to keep meaning select-all inside that field.
  const search = page.getByTestId('viewer-search')
  await search.fill('line1')
  await search.press('ControlOrMeta+a')
  await search.type('line2')
  await expect(search).toHaveValue('line2')
})

/** A file containing one minified 4,000-character line — this is the only way to reveal whether the viewer scrolls horizontally (#139) */
async function openMinifiedFile(page: Page) {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'min.js', path: 'min.js', isDir: false, ignored: false }]
    const text = ['// head', `var a=${'b'.repeat(4_000)}`, 'short()'].join('\n')
    m.fs.readFile = async () => ({ text, truncated: false, binary: false, bytes: text.length })
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-min.js').click()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
  await expect(page.locator('[data-line="1"]')).toBeVisible()
}

const VIEWER_SCROLLER = '[data-testid="code-viewer"] .overflow-auto'

/**
 * The viewer also scrolls horizontally — so it must be reachable by keyboard (#139).
 * With `tabIndex={-1}`, once the focus received when the file opened is lost there is no way
 * back in, and a keyboard-only person can never reach the right end of a long line.
 */
test('Viewer: the scroll area is a named region, reachable by Tab and moved by the arrow keys (#139)', async ({
  page,
}) => {
  await openMinifiedFile(page)

  // Measure first: if there is no horizontal scroll, this test asserts nothing
  const overflow = await page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel)!
    return root.scrollWidth - root.clientWidth
  }, VIEWER_SCROLLER)
  expect(overflow).toBeGreaterThan(1_000)

  // Discard the focus received when the file opened, and tab in from the last button in the header
  await page.getByTestId('viewer-open-ide').focus()
  await page.keyboard.press('Tab')
  const focused = await page.evaluate((sel) => {
    const el = document.activeElement
    return {
      isScroller: el === document.querySelector(sel),
      role: el?.getAttribute('role') ?? null,
      label: el?.getAttribute('aria-label') ?? null,
    }
  }, VIEWER_SCROLLER)
  expect(focused).toEqual({ isScroller: true, role: 'region', label: 'Code' })

  // Held like a finger holds a key: WebKit scrolls by keyboard from keydown to keyup, and a press
  // with no time between the two left the area where it was (#424)
  await page.keyboard.press('ArrowRight', { delay: 100 })
  await page.keyboard.press('ArrowRight', { delay: 100 })
  await expect
    .poll(() => page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollLeft, VIEWER_SCROLLER))
    .toBeGreaterThan(0)
})

/** If a row is `w-full`, scrolling horizontally drags its background left with it, so it no longer covers the visible width (#139) */
test('Viewer: the row background still covers the visible width even after scrolling horizontally (#139)', async ({
  page,
}) => {
  await openMinifiedFile(page)
  // Paint the short line (line 3) as a match — a long line is covered by `w-max` alone, but a
  // short line used to end within the visible width and drag the line number out with it
  // (measured: right edge at -1,500, line number at -848)
  await page.getByTestId('viewer-search').fill('short')
  await expect(page.locator('[data-line="2"]')).toHaveClass(/bg-surface-hover/)

  const seen = await page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel)!
    root.scrollLeft = 1_500
    const r = root.getBoundingClientRect()
    const box = (line: number) => {
      const b = document.querySelector(`[data-line="${line}"]`)!.getBoundingClientRect()
      return { left: b.left - r.left, right: b.right - (r.left + root.clientWidth) }
    }
    const gutter = document.querySelector('[data-line="2"] > span')!.getBoundingClientRect()
    return { scrollLeft: root.scrollLeft, long: box(1), short: box(2), gutterLeft: gutter.left - r.left }
  }, VIEWER_SCROLLER)

  // The horizontal scroll must actually happen for this test to assert anything
  expect(seen.scrollLeft).toBe(1_500)
  for (const row of [seen.long, seen.short]) {
    expect(row.left).toBeLessThanOrEqual(1)
    expect(row.right).toBeGreaterThanOrEqual(-1)
  }
  // The line number does not get dragged out and stays on the left
  expect(Math.abs(seen.gutterLeft)).toBeLessThanOrEqual(1)
})

test('Viewer: a binary file just gets a notice (C-3 abnormal path)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'logo.png', path: 'logo.png', isDir: false, ignored: false }]
    m.fs.readFile = async () => ({ text: '', truncated: false, binary: true, bytes: 20480 })
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-logo.png').click()
  await expect(page.getByTestId('viewer-binary')).toContainText('Binary')
})

test('Viewer: a supported image is previewed from its raw bytes', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'logo.png', path: 'logo.png', isDir: false, ignored: false }]
    m.fs.readFile = async () => ({
      text: '',
      truncated: false,
      binary: true,
      bytes: 68,
      image: {
        mime: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFpEAAAAAASUVORK5CYII=',
      },
    })
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-logo.png').click()
  await expect(page.getByTestId('viewer-image')).toBeVisible()
  const image = page.getByTestId('viewer-image-content')
  await expect(image).toHaveAttribute(
    'src',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFpEAAAAAASUVORK5CYII=',
  )
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
  await expect(page.getByTestId('viewer-search')).toHaveCount(0)
})

test('Viewer: SVG toggles between the rendered image and raw source', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
  await page.evaluate((text: string) => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'logo.svg', path: 'logo.svg', isDir: false, ignored: false }]
    m.fs.readFile = async () => ({
      text,
      truncated: false,
      binary: false,
      bytes: text.length,
      image: { mime: 'image/svg+xml', data: btoa(text) },
    })
  }, svg)
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-logo.svg').click()

  await expect(page.getByTestId('viewer-image')).toBeVisible()
  await page.getByTestId('viewer-svg-text').click()
  await expect(page.getByTestId('viewer-image')).toHaveCount(0)
  await expect(page.getByTestId('code-viewer')).toContainText(svg)
  await expect(page.getByTestId('viewer-search')).toBeVisible()
  await page.getByTestId('viewer-svg-preview').click()
  await expect(page.getByTestId('viewer-image')).toBeVisible()
})

/** The expand indicator is collapsed=right, expanded=down. The same glyph rotates, so the two states never drift apart */
test('The file tree folder arrow changes direction when opened and closed', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'src', path: 'src', isDir: true, ignored: false }]
    m.fsState.entries['src'] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()

  const dir = page.getByTestId('dir-src').locator('svg')
  await expect(dir).not.toHaveClass(/rotate-90/)

  await page.getByTestId('dir-src').click()
  await expect(dir).toHaveClass(/rotate-90/)

  await page.getByTestId('dir-src').click()
  await expect(dir).not.toHaveClass(/rotate-90/)
})

/** Moving to a session in a different project must update the file tree too */
test('Switching projects also switches the file tree', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'only-in-alpha.ts', path: 'only-in-alpha.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'alpha', 'work a')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-only-in-alpha.ts')).toBeVisible()

  // The second project has different files
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'only-in-beta.ts', path: 'only-in-beta.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'beta', 'work b')

  await expect(page.getByTestId('file-only-in-beta.ts')).toBeVisible()
  await expect(page.getByTestId('file-only-in-alpha.ts')).toBeHidden()
})

/**
 * Expanded folders used to live in the tree rows, so switching sessions collapsed them and
 * you dug down the same path again (issue #16).
 *
 * They belong to the **project**, which is the half this test is really about: within one
 * repo the tree holds, and crossing to another repo it does not. That is the difference
 * from drafts, which moved onto the session — a draft is something you were saying to one
 * agent, while an open folder is a fact about the code every session in that repo shares.
 */
test('expanded folders follow the project, not the session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'src', path: 'src', isDir: true, ignored: false }]
    m.fsState.entries['src'] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'first')
  const first = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  await page.getByTestId('evidence-tab-files').click()

  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()

  /*
    Leaving for the Git tab tears the whole tree down. This is the step that reproduces the
    original complaint: nothing about switching sessions unmounted these rows on its own,
    so the state only vanished once something actually took them off screen.
  */
  await page.getByTestId('evidence-tab-git').click()
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()

  // Another session in the same repo — same code, so the same tree
  await newSession(page, 'alpha', 'second')
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()

  // A different repo starts closed: this belongs to the project, it is not a global setting
  await newSession(page, 'beta', 'elsewhere')
  await expect(page.getByTestId('dir-src')).toBeVisible()
  await expect(page.getByTestId('file-src/a.ts')).toBeHidden()

  // ...and alpha still has it open when we come back
  await page.getByTestId(`session-row-${first}`).click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
})
