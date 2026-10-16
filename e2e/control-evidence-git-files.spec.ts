import { test, expect, type Page } from '@playwright/test'
import { copied, pressCopy, watchCopies } from './fixtures/clipboard.js'
import { setup, newSession, injectApproval, emitEvent } from './fixtures/control.js'

/**
 * The control loop's scenarios on the evidence panel: git changes and history, the file tree, the viewer and the wide overlay. Moved out of control-loop.spec.ts by subject (#845); the
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

test('Git: the diff gets the wide area; the list, staging and commit live in the sidebar (B-2, B-6 — left column removed 2026-09-07)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/new.ts', staged: false, status: '?' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged'
  })
  await newSession(page, 'alpha', 'task')

  // Clicking a file in the sidebar opens the wide diff — the wide area has no list in it
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  await expect(page.getByTestId('git-panel').locator('[data-testid^="git-file-"]')).toHaveCount(0)
  // The diff is achromatic: distinguished by symbol and brightness, not color
  await expect(page.locator('[data-diff="add"]')).toContainText('new line')
  await expect(page.locator('[data-diff="del"]')).toContainText('old line')

  // The sidebar is the source of truth for staging and commit (visible even with an overlay open — #15)
  await page.getByTestId('evidence-stage-all').click()
  await page.getByTestId('evidence-commit-message').fill('test commit')
  await page.getByTestId('evidence-commit').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('test commit')
})

test('Git panel: a copied diff comes out exactly as that diff (#36)', async ({ page }) => {
  const diff =
    '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-const old = 1\n+const next = 1\n   indented\n unchanged'
  await watchCopies(page)
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate((d) => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = d
  }, diff)
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()

  // Drag the whole diff. Nothing here is virtualized, so every row is under the pointer —
  // what went wrong is the marker: it lives in its own select-none span, and here the
  // browser honours that and drops it, leaving added and removed lines identical.
  const rows = page.locator('[data-testid="diff-view"] [data-diff]')
  const first = (await rows.first().boundingBox())!
  const last = (await rows.last().boundingBox())!
  // From the very left edge — the marker column, which is the start of the line
  await page.mouse.move(first.x + 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(last.x + last.width - 4, last.y + last.height / 2, { steps: 10 })
  await page.mouse.up()
  await pressCopy(page)

  // Whatever it looks like on screen, what comes off it is a diff you can apply: ASCII
  // markers rather than the typographic −, and indentation the DOM had already collapsed
  expect(await copied(page)).toBe(diff)

  // The file header used to lose a dash to the marker-stripping, on screen too
  await expect(page.getByTestId('diff-view')).toContainText('--- a/src/a.ts')
})

test('Git panel: checking out with a dirty working tree is not blocked — the result is shown first (B-4)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'feature/x', current: false, remote: false },
      { name: 'origin/main', current: false, remote: true },
    ]
    m.gitState.dirty = ['src/a.ts']
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-branch').click()
  // The panels split by the remote flag the host provides — a `/` in the name cannot distinguish
  // local feature/x from remote origin/main (#175)
  await expect(page.getByTestId('branches-remote').getByTestId('branch-origin/main')).toBeVisible()
  await expect(page.getByTestId('branches-local').getByTestId('branch-feature/x')).toBeVisible()
  await page.getByTestId('branch-feature/x').click()

  await expect(page.getByTestId('checkout-warning')).toContainText('src/a.ts')
  await page.getByTestId('checkout-proceed').click()
  await expect(page.getByTestId('toast')).toContainText('Switched')
})

test('The Git tab is disabled when the project is not a git repository (B-1 abnormal path)', async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(async () => {
    const store = (window as any).__store
    const m = (window as any).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-nogit',
      path,
      name: 'nogit',
      defaultTool: 'claude',
      git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
  await page.getByTestId('project-menu-nogit').click()
  await page.getByTestId('new-session-nogit').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('evidence-tab-git')).toBeDisabled()
  await expect(page.getByTestId('evidence-not-repo')).toBeVisible()
})

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

test('A permission denial is explained separately from "not a repository" (F-1, reflecting what was actually measured)', async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(async () => {
    const m = (window as any).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-denied',
      path,
      name: 'denied',
      defaultTool: 'claude',
      git: { branch: '', changedFiles: 0, isRepo: true, denied: true },
    })
    await (window as any).__store.getState().addProject('/Users/me/Desktop/proj')
  })
  // Being blocked shows immediately as a marker, and hovering explains what to do about it
  await expect(page.getByTestId('git-denied-denied')).toBeVisible()
  await page.getByTestId('project-header-denied').hover()
  await expect(page.getByTestId('git-denied')).toContainText('permission')
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

/** Evidence panel: split by tabs, and collapsing still leaves a way to bring it back */
test('Evidence panel tabs: Git shows only changes, and History shows the graph in its own tab', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: 'First commit', author: 'me', when: Date.now(), parents: [] },
      {
        sha: 'bbb222',
        shortSha: 'bbb222',
        subject: 'second',
        author: 'me',
        when: Date.now(),
        parents: ['a', 'b'],
      },
    ]
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'task')

  // The Git tab is the default — only changes. The history strip was moved off, covering the
  // neighboring tab strip during the split (#20)
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await expect(page.getByTestId('evidence-file-src/a.ts')).toBeVisible()
  await expect(page.getByTestId('evidence-tree')).toHaveCount(0)

  // History lives under the History tab — the lane graph that used to live in the strip moved
  // here too
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-aaa111')).toContainText('First commit')
  await expect(page.getByTestId('history-commit-bbb222')).toContainText('merge')
  await expect(page.getByTestId('commit-graph-aaa111')).toBeVisible()

  // Switching to the Files tab shows only the tree
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-README.md')).toBeVisible()
  await expect(page.getByTestId('evidence-git')).toBeHidden()

  // The chosen tab is recorded in the snapshot
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelTab).toBe('files')
})

test('Clicking a commit in History opens it in the wide area', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: 'First commit', author: 'me', when: Date.now(), parents: [] },
    ]
    m.gitState.diffs['aaa111'] = '@@ -0,0 +1 @@\n+new line'
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa111').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('new line')
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

  await page.getByTestId('evidence-close').click()
  await expect(page.getByTestId('evidence-panel')).toBeHidden()

  // Gone and collapsed are different — the rail stays, and the change count is readable even
  // while collapsed
  await expect(page.getByTestId('evidence-rail')).toBeVisible()
  await expect(page.getByTestId('evidence-rail-count')).toHaveText('2')

  await page.getByTestId('evidence-open').click()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

test('Staging and committing still work in a narrow panel', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
  })
  await newSession(page, 'alpha', 'task')

  // Commit is disabled before staging (a live commit button with nothing staged would be a lie)
  await page.getByTestId('evidence-commit-message').fill('commit from the panel')
  await expect(page.getByTestId('evidence-commit')).toBeDisabled()

  await page.getByTestId('evidence-stage-all').click()
  await page.getByTestId('evidence-commit').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('commit from the panel')
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
 * The Git tab — like VSCode, shows staged and unstaged changes separately.
 * The one fact that matters right before a commit is "what is going in", and mixing everything
 * into a single list meant reading that off a small tag at the end of each row.
 */
test('The Git panel separates staged from changed and lets each file be staged individually', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: true, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'task')

  await expect(page.getByTestId('evidence-group-staged')).toContainText('src/a.ts')
  await expect(page.getByTestId('evidence-group-changed')).toContainText('src/b.ts')

  // Stage only one file — no need to drop into the terminal just to "commit everything but this"
  await page.getByTestId('evidence-stage-src/b.ts').click({ force: true })
  await expect(page.getByTestId('evidence-group-changed')).toBeHidden()
  await expect(page.getByTestId('evidence-group-staged')).toContainText('src/b.ts')
})

/** Dots alone make a list, not a tree — branching and merging must be shown as lines */
test('Git history connects commits with lines', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.commits = [
      { sha: 'm', shortSha: 'mmmmmmm', subject: 'Merge', author: 'a', when: 0, parents: ['x', 'y'] },
      { sha: 'x', shortSha: 'xxxxxxx', subject: 'Trunk', author: 'a', when: 0, parents: ['z'] },
      { sha: 'y', shortSha: 'yyyyyyy', subject: 'Branch', author: 'a', when: 0, parents: ['z'] },
      { sha: 'z', shortSha: 'zzzzzzz', subject: 'Root', author: 'a', when: 0, parents: [] },
    ]
  })
  await newSession(page, 'alpha', 'task')
  // The graph lives in the History tab — the Git tab's strip was moved off, covering its neighbor
  // during the split
  await page.getByTestId('evidence-tab-history').click()

  // Two branches extend from the merge commit (one straight line + one curving line)
  const merge = page.getByTestId('commit-graph-mmmmmmm')
  await expect(merge).toBeVisible()
  expect(await merge.locator('path').count()).toBeGreaterThan(0)

  // Since the branch merges into the trunk, only one line comes down to the root
  await expect(page.getByTestId('commit-graph-zzzzzzz')).toBeVisible()
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

  const mark = page.getByTestId('mark-changed-alpha')
  await expect(mark).toHaveText('3')
  await mark.hover()
  await expect(page.getByRole('tooltip')).toContainText('3 uncommitted files')

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
  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('1')
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
  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('2')

  await page.getByTestId('evidence-commit-message').fill('commit from the panel')
  await page.getByTestId('evidence-commit').click()

  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('1')
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
 * Three spots in the Git tab (#160).
 *
 * The moment everything was committed and the list emptied, Push disappeared along with it; the
 * panel's list only re-read when the count of files the agent touched changed, missing terminal
 * commits, Bash commits, re-editing the same file, and returning to the window; and a partially
 * staged file opened the staged diff even when clicked from Changed.
 */
test('Git tab: Push remains even when clean, the list re-reads on window return, and clicking opens the diff for the clicked group (#160)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await expect(page.getByTestId('evidence-clean')).toBeVisible()
  await expect(page.getByTestId('evidence-push')).toBeVisible()

  // Partially staged one file from outside the app — the count of files the agent touched is unchanged
  await page.evaluate(() => {
    const store = (window as any).__store.getState()
    store.setAppFocused(false)
    ;(window as any).__mock.gitState.files = [
      { path: 'a.ts', staged: true, status: 'M' },
      { path: 'a.ts', staged: false, status: 'M' },
    ]
    store.setAppFocused(true)
  })
  const changed = page.getByTestId('evidence-group-changed').getByTestId('evidence-file-a.ts')
  await expect(changed).toBeVisible()

  await changed.click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.gitDiffCalls.at(-1)))
    .toEqual({ path: 'a.ts', staged: false })
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

  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('2')
  await expect(page.getByTestId('mark-changed-beta')).toHaveText('2')
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
