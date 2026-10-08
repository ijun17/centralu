import { expect, test, type Page } from '@playwright/test'
import { grantClipboard } from './fixtures/clipboard.js'
import { GIT_DIFF_MAX_CHARS } from '../packages/agent-host/src/dev-services/git.js'

/**
 * The real host's diff cap (`gitDiff`/`gitCommitDetail`) — the exact value the host emits (#134).
 * What it measures is **character count**.
 */
const HOST_DIFF_MAX_CHARS = GIT_DIFF_MAX_CHARS
/* Each row is 11 characters (`+row-00000` plus a newline), so the nastiest input just under the cap is this many rows (36,363 rows for a 400,000-character cap) */
const HOSTILE_DIFF_ROWS = Math.floor(HOST_DIFF_MAX_CHARS / 11)
const HOSTILE_LAST_ROW = `row-${String(HOSTILE_DIFF_ROWS - 1).padStart(5, '0')}`
const DIFF_TRUNCATED_MESSAGE = '…diff is too large; showing part of it. Open in your IDE to see the rest.'

async function setup(page: Page): Promise<void> {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate(() => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.nextPickedDirectory = '/tmp/security-diff'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-security-diff')).toBeVisible()
}

async function newSession(page: Page): Promise<void> {
  await page.getByTestId('project-menu-security-diff').click()
  await page.getByTestId('new-session-security-diff').click()
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('prompt-input').fill('inspect diff')
  await page.getByTestId('prompt-input').press('Enter')
}

function hostileDiff(): string {
  return Array.from({ length: HOSTILE_DIFF_ROWS }, (_, i) => `+row-${String(i).padStart(5, '0')}`).join('\n')
}

test('hostile fixture stays within the audit-input cap the host actually applies', () => {
  // While this was measured against 400KiB (409,600), the name was a lie — this input would have been truncated by the real host (#121)
  expect(hostileDiff().length).toBeLessThanOrEqual(HOST_DIFF_MAX_CHARS)
})

test('newline-dense working diff is virtualized without losing tail rows', async ({ page }) => {
  await grantClipboard(page)
  await setup(page)
  await page.evaluate((diff) => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.files = [{ path: 'src/bomb.ts', staged: false, status: 'M' }]
    mock.gitState.diffs['src/bomb.ts'] = diff
  }, hostileDiff())
  await newSession(page)

  await page.getByTestId('evidence-file-src/bomb.ts').click()
  const diffView = page.getByTestId('diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView.getByTestId('diff-truncation')).toHaveCount(0)
  const mountedRows = page.locator('[data-testid="diff-view"] [data-diff]')
  await expect.poll(() => mountedRows.count()).toBeLessThan(200)

  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    root.scrollTop = root.scrollHeight
  })
  await expect(diffView).toContainText(HOSTILE_LAST_ROW)

  // Select all means the complete backing diff, not only the virtual rows on screen.
  await diffView.locator('.overflow-auto').click({ position: { x: 100, y: 100 } })
  await page.keyboard.press('ControlOrMeta+a')
  const copied = await diffView.locator('.overflow-auto').evaluate((root) => {
    const clipboardData = new DataTransfer()
    root.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
    return clipboardData.getData('text/plain')
  })
  expect(copied).toBe(hostileDiff())
})

test('sticky current-file band follows the visible file while virtualized', async ({ page }) => {
  const first = Array.from({ length: 80 }, (_, i) => `+first-${String(i).padStart(2, '0')}`).join('\n')
  const second = Array.from({ length: 80 }, (_, i) => `+second-${String(i).padStart(2, '0')}`).join('\n')
  const diff = [
    'diff --git a/src/first.ts b/src/first.ts',
    first,
    'diff --git a/src/second.ts b/src/second.ts',
    second,
  ].join('\n')
  await setup(page)
  await page.evaluate((d) => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.files = [{ path: 'src/multi.ts', staged: false, status: 'M' }]
    mock.gitState.diffs['src/multi.ts'] = d
  }, diff)
  await newSession(page)

  await page.getByTestId('evidence-file-src/multi.ts').click()
  await expect(page.getByTestId('diff-current-file-band')).toContainText('src/first.ts')
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    root.scrollTop = 1_700
  })
  await expect(page.getByTestId('diff-current-file-band')).toContainText('src/second.ts')
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    root.scrollTop = root.scrollHeight
  })
  await expect(page.getByTestId('diff-current-file-band')).toContainText('src/second.ts')
})

test('normal working diff renders completely without a truncation notice', async ({ page }) => {
  const diff = 'diff --git a/src/small.ts b/src/small.ts\n@@ -1,2 +1,2 @@\n-old()\n+next()\n unchanged'
  await setup(page)
  await page.evaluate((d) => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.files = [{ path: 'src/small.ts', staged: false, status: 'M' }]
    mock.gitState.diffs['src/small.ts'] = d
  }, diff)
  await newSession(page)

  await page.getByTestId('evidence-file-src/small.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('next()')
  await expect(page.getByTestId('diff-current-file-band')).toContainText('src/small.ts')
  await expect(page.getByTestId('diff-truncation')).toHaveCount(0)
  await expect(page.locator('[data-testid="diff-view"] [data-diff]')).toHaveCount(5)
})

/**
 * The `toHaveCount(0)` assertions above were, for a long time, **statements that could never
 * fail**: the mock hardcoded truncated to false, so the case where the notice appears never
 * existed at all (#121). Only once this case, where it does appear, is exercised does the "it
 * does not appear" case become a real claim.
 */
test('working diff cut at the host cap says so', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.files = [{ path: 'src/huge.ts', staged: false, status: 'M' }]
    mock.gitState.diffs['src/huge.ts'] = '@@ -1 +1 @@\n-old()\n+next()'
    mock.gitState.truncated = ['src/huge.ts']
  })
  await newSession(page)

  await page.getByTestId('evidence-file-src/huge.ts').click()
  await expect(page.getByTestId('diff-truncation')).toHaveText(DIFF_TRUNCATED_MESSAGE)
})

test('working diff opens IDE through host-resolved absolute handoff and reports resolve failures', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.files = [{ path: 'src/small.ts', staged: false, status: 'M' }]
    mock.gitState.diffs['src/small.ts'] = '@@ -1 +1 @@\n-old()\n+next()'
  })
  await newSession(page)

  await page.getByTestId('evidence-file-src/small.ts').click()
  await page.getByTestId('open-in-ide').click()
  await expect
    .poll(() => page.evaluate(() => window.__mock?.opened ?? []))
    // `@@ -1 +1 @@`'s first line is at the top, so it is line 1 — a missing `line` gets caught here
    .toEqual([{ path: '/mock-project/src/small.ts', line: 1 }])

  await page.evaluate(() => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.fs.resolve = async () => {
      throw new Error('resolve blocked')
    }
  })
  await page.getByTestId('open-in-ide').click()
  await expect(page.getByTestId('toast')).toContainText('Could not open in IDE: resolve blocked')
})

test('newline-dense commit diff is virtualized without a lossy row cap', async ({ page }) => {
  await setup(page)
  await page.evaluate((diff) => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.commits = [
      { sha: 'deadbee', shortSha: 'deadbee', subject: 'large commit', author: 'me', when: Date.now(), parents: [] },
    ]
    mock.gitState.diffs.deadbee = diff
  }, hostileDiff())
  await newSession(page)

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-deadbee').click()
  const diffView = page.getByTestId('diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView.getByTestId('diff-truncation')).toHaveCount(0)
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    root.scrollTop = root.scrollHeight
  })
  await expect(diffView).toContainText(HOSTILE_LAST_ROW)
})

/* commitDetail.truncated was wired up but had not a single passing test exercising it (#121) */
test('commit diff cut at the host cap says so', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.commits = [
      { sha: 'cafebab', shortSha: 'cafebab', subject: 'huge commit', author: 'me', when: Date.now(), parents: [] },
    ]
    mock.gitState.diffs.cafebab = '@@ -1 +1 @@\n-old()\n+next()'
    mock.gitState.truncated = ['cafebab']
  })
  await newSession(page)

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-cafebab').click()
  await expect(page.getByTestId('diff-truncation')).toHaveText(DIFF_TRUNCATED_MESSAGE)
})

/**
 * A person who picks a file from the sidebar also copies the whole diff with ⌘A (#118).
 *
 * The tests above **click** the diff pane before copying, so they only covered the case where
 * focus is on the pane. What a person actually does — pick a file from the evidence sidebar and
 * immediately press ⌘A — was never exercised. On that path, focus stayed on the sidebar button,
 * ⌘A went to the document, and the copy listener attached to the pane, holding only the mounted
 * rows, also suppressed the default action, turning 37,236 rows into 60.
 */
test('pressing ⌘A right after picking a file in the sidebar still copies the whole diff (#118)', async ({ page }) => {
  await grantClipboard(page)
  await setup(page)
  await page.evaluate((diff) => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.files = [{ path: 'src/bomb.ts', staged: false, status: 'M' }]
    mock.gitState.diffs['src/bomb.ts'] = diff
  }, hostileDiff())
  await newSession(page)

  // Do not click the pane — picking it from the sidebar is all that happens
  await page.getByTestId('evidence-file-src/bomb.ts').click()
  const diffView = page.getByTestId('diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView).toContainText('row-00000')

  await page.keyboard.press('ControlOrMeta+a')
  const copied = await diffView.locator('.overflow-auto').evaluate((root) => {
    const clipboardData = new DataTransfer()
    root.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
    return clipboardData.getData('text/plain')
  })
  expect(copied.split('\n').length).toBe(hostileDiff().split('\n').length)
  expect(copied).toBe(hostileDiff())
})

/**
 * What follows are the "Diff pane" items from #122 — all claims about what is **visible**, so
 * each test actually scrolls and measures bounding boxes rather than reading CSS.
 */

/** Gets to a single-file working diff being open. The six lines the tests below used to repeat every time. */
async function openWorkingDiff(page: Page, path: string, diff: string): Promise<void> {
  await setup(page)
  await page.evaluate(
    ([p, d]) => {
      const mock = window.__mock
      if (!mock) throw new Error('mock platform is required')
      mock.gitState.files = [{ path: p!, staged: false, status: 'M' }]
      mock.gitState.diffs[p!] = d!
    },
    [path, diff],
  )
  await newSession(page)
  await page.getByTestId(`evidence-file-${path}`).click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
}

const MINIFIED_DIFF = [
  'diff --git a/src/min.js b/src/min.js',
  '@@ -1 +1 @@',
  `-${'a'.repeat(4_000)}`,
  `+${'b'.repeat(4_000)}`,
].join('\n')

/**
 * The band only had `sticky top-0` set — scrolling it sideways pushed it out along with everything
 * else (#122). The moment someone scrolls right to read a minified line, the strip that told them
 * which file this was disappears.
 */
test('the file band and row backgrounds still cover the visible width after scrolling horizontally', async ({ page }) => {
  await openWorkingDiff(page, 'src/min.js', MINIFIED_DIFF)
  await expect(page.getByTestId('diff-current-file-band')).toContainText('src/min.js')

  const seen = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    root.scrollLeft = 1_500
    const band = document.querySelector('[data-testid="diff-current-file-band"]')
    const row = document.querySelector('[data-diff="add"]')
    if (!band || !row) throw new Error('band or row not mounted')
    const r = root.getBoundingClientRect()
    const b = band.getBoundingClientRect()
    const w = row.getBoundingClientRect()
    return {
      scrollLeft: root.scrollLeft,
      band: { left: b.left - r.left, right: b.right - r.right },
      row: { left: w.left - r.left, right: w.right - r.right },
    }
  })

  // The horizontal scroll has to actually happen for this test to claim anything
  expect(seen.scrollLeft).toBe(1_500)
  expect(seen.band.left).toBeGreaterThanOrEqual(-1)
  expect(seen.band.right).toBeGreaterThanOrEqual(-1)
  expect(seen.row.left).toBeLessThanOrEqual(1)
  expect(seen.row.right).toBeGreaterThanOrEqual(-1)
})

/** If a line indented 9 spaces and one indented 8 spaces start at the same position, the diff is lying (#122) */
test('a one-space difference in indentation is still one space on screen', async ({ page }) => {
  const diff = [
    'diff --git a/src/indent.ts b/src/indent.ts',
    '@@ -1,2 +1,2 @@',
    `+${' '.repeat(9)}same()`,
    `+${' '.repeat(8)}same()`,
  ].join('\n')
  await openWorkingDiff(page, 'src/indent.ts', diff)

  const lefts = await page.evaluate(() =>
    [2, 3].map((line) => {
      const code = document.querySelector(`[data-line="${line}"] [data-code]`)
      const text = code?.firstChild
      if (!text) throw new Error(`row ${line} has no code text`)
      const range = document.createRange()
      range.setStart(text, (text.textContent ?? '').length - 'same()'.length)
      range.setEnd(text, (text.textContent ?? '').length)
      return range.getBoundingClientRect().left
    }),
  )

  // The 9-space line has to sit exactly one character to the right of the 8-space line (11px monospace ≈ 6.6px)
  expect(lefts[0]! - lefts[1]!).toBeGreaterThan(3)
})

/** The band and the `diff --git` row in the list look like one thing to the eye but were two to a screen reader (#122) */
test('the file name appears only once in the accessibility tree', async ({ page }) => {
  await openWorkingDiff(page, 'src/min.js', MINIFIED_DIFF)
  await expect(page.getByTestId('diff-current-file-band')).toContainText('src/min.js')
  await expect(page.getByTestId('diff-file-band')).toBeVisible()

  /*
   * The header once — that is this view's title. The `diff --git` row in the list once — that is
   * the actual content. The band is a device for tracking that row visually, so if it appeared
   * here too, that would make three.
   */
  const snapshot = await page.getByTestId('diff-view').ariaSnapshot()
  expect(snapshot.split('src/min.js').length - 1).toBe(2)
})

/** If Tab lands on an unnamed `<div>`, there is no way to say where it landed (#122) */
test('the scroll pane is a named region and is reachable by Tab', async ({ page }) => {
  await openWorkingDiff(page, 'src/min.js', MINIFIED_DIFF)

  await page.getByTestId('open-in-ide').focus()
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => {
    const el = document.activeElement
    return {
      isScroller: el === document.querySelector('[data-testid="diff-view"] .overflow-auto'),
      role: el?.getAttribute('role') ?? null,
      label: el?.getAttribute('aria-label') ?? null,
    }
  })
  expect(focused.isScroller).toBe(true)
  expect(focused.role).toBe('region')
  // Adding the file name to the label would overlap the header and get read twice — the same problem as the test right above
  expect(focused.label).toBe('Diff')
})

/** What ⌘A puts on the clipboard has to be the patch — a notice meant for a person breaks `git apply` (#122) */
test('copying a truncated diff with ⌘A does not mix the notice into the clipboard', async ({ page }) => {
  await grantClipboard(page)
  const diff = 'diff --git a/src/huge.ts b/src/huge.ts\n@@ -1 +1 @@\n-old()\n+next()'
  await setup(page)
  await page.evaluate((d) => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.files = [{ path: 'src/huge.ts', staged: false, status: 'M' }]
    mock.gitState.diffs['src/huge.ts'] = d
    mock.gitState.truncated = ['src/huge.ts']
  }, diff)
  await newSession(page)

  await page.getByTestId('evidence-file-src/huge.ts').click()
  // The notice must still be showing on screen — the fact that it was truncated does not disappear
  await expect(page.getByTestId('diff-truncation')).toHaveText(DIFF_TRUNCATED_MESSAGE)

  const diffView = page.getByTestId('diff-view')
  await page.keyboard.press('ControlOrMeta+a')
  const copied = await diffView.locator('.overflow-auto').evaluate((root) => {
    const clipboardData = new DataTransfer()
    root.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
    return clipboardData.getData('text/plain')
  })
  expect(copied).toBe(diff)
})

/** If it opens at line 1 instead of the line that was being looked at, "go open it in your IDE" is only half true (#122) */
test('the IDE opens at the line currently being viewed', async ({ page }) => {
  const body = Array.from({ length: 400 }, (_, i) => `+line-${String(i).padStart(3, '0')}`).join('\n')
  const diff = ['diff --git a/src/long.ts b/src/long.ts', '@@ -0,0 +1,400 @@', body].join('\n')
  await openWorkingDiff(page, 'src/long.ts', diff)

  // Row 0 is `diff --git`, row 1 is `@@`, row 2 is line 1 of the new file
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    root.scrollTop = 2_000
  })
  // Virtual scroll re-renders once more after scrollTop is set — measuring before that render finds no visible rows.
  // The reference for "top" is not the pane's upper edge but **below the band**: the band covers everything above it.
  const topRow = await page
    .locator('[data-testid="diff-view"] .overflow-auto')
    .evaluate(async (root) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const band = root.querySelector('[data-testid="diff-current-file-band"]')
      const top = (band ?? root).getBoundingClientRect().bottom
      const rows = [...root.querySelectorAll<HTMLElement>('[data-line]')]
        .filter((r) => r.getBoundingClientRect().bottom > top + 0.5)
        .map((r) => Number(r.dataset.line))
      if (rows.length === 0) throw new Error('no diff row is visible after scrolling')
      return Math.min(...rows)
    })
  expect(topRow).toBeGreaterThan(50)

  await page.getByTestId('open-in-ide').click()
  await expect
    .poll(() => page.evaluate(() => window.__mock?.opened ?? []))
    .toEqual([{ path: '/mock-project/src/long.ts', line: topRow - 1 }])
})

/**
 * "Open in IDE" on a commit diff was wired to `async () => {}`, so clicking it did nothing quietly
 * (#122). A commit view has several files, so which file it opens has to be whichever one the
 * band is pointing at.
 */
test('Open in IDE also opens the file and line currently being viewed in a commit diff', async ({ page }) => {
  const rows = (name: string) =>
    Array.from({ length: 80 }, (_, i) => `+${name}-${String(i).padStart(2, '0')}`).join('\n')
  const diff = [
    'diff --git a/src/first.ts b/src/first.ts',
    '@@ -0,0 +1,80 @@',
    rows('first'),
    'diff --git a/src/second.ts b/src/second.ts',
    '@@ -0,0 +1,80 @@',
    rows('second'),
  ].join('\n')
  await setup(page)
  await page.evaluate((d) => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.commits = [
      { sha: 'deadbee', shortSha: 'deadbee', subject: 'two files', author: 'me', when: Date.now(), parents: [] },
    ]
    mock.gitState.diffs.deadbee = d
  }, diff)
  await newSession(page)

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-deadbee').click()
  await expect(page.getByTestId('diff-view')).toContainText('first-00')

  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    root.scrollTop = 1_700
  })
  await expect(page.getByTestId('diff-current-file-band')).toContainText('src/second.ts')

  // The second file's rows start at 82 (`diff --git`) and 83 (`@@`), so new-file line = row − 83
  const topRow = await page
    .locator('[data-testid="diff-view"] .overflow-auto')
    .evaluate(async (root) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const band = root.querySelector('[data-testid="diff-current-file-band"]')
      const top = (band ?? root).getBoundingClientRect().bottom
      const lines = [...root.querySelectorAll<HTMLElement>('[data-line]')]
        .filter((r) => r.getBoundingClientRect().bottom > top + 0.5)
        .map((r) => Number(r.dataset.line))
      if (lines.length === 0) throw new Error('no diff row is visible after scrolling')
      return Math.min(...lines)
    })
  expect(topRow).toBeGreaterThan(83)

  await page.getByTestId('open-in-ide').click()
  await expect
    .poll(() => page.evaluate(() => window.__mock?.opened ?? []))
    .toEqual([{ path: '/mock-project/src/second.ts', line: topRow - 83 }])
})
