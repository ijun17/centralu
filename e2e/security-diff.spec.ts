import { expect, test, type Page } from '@playwright/test'

const HOSTILE_DIFF_ROWS = 37_236

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

test('hostile fixture stays within the 400KiB audit-input cap', () => {
  expect(new TextEncoder().encode(hostileDiff()).length).toBeLessThanOrEqual(400 * 1024)
})

test('newline-dense working diff is virtualized without losing tail rows', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
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
  await expect(diffView).toContainText('row-37235')

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
    .toEqual([{ path: '/mock-project/src/small.ts' }])

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
  await expect(diffView).toContainText('row-37235')
})
