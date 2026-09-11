import { expect, test, type Page } from '@playwright/test'

const MAX_RENDERED_DIFF_ROWS = 1_000
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

test('newline-dense working diff is row-capped, visibly truncated, copy-bounded, and responsive', async ({
  page,
}) => {
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
  await expect(diffView.getByTestId('diff-truncation')).toBeVisible()
  await expect(diffView.getByTestId('diff-truncation')).toContainText('diff is too large')
  await expect(page.locator('[data-testid="diff-view"] [data-diff]')).toHaveCount(MAX_RENDERED_DIFF_ROWS)

  const frameDelayMs = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const startedAt = performance.now()
        requestAnimationFrame(() => resolve(performance.now() - startedAt))
      }),
  )
  expect(frameDelayMs).toBeLessThan(1_000)

  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    const range = document.createRange()
    range.selectNodeContents(root)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.keyboard.press('ControlOrMeta+c')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied.startsWith('+row-00000\n+row-00001')).toBe(true)
  expect(copied).toContain('+row-00999')
  expect(copied).not.toContain('+row-01000')
  expect(copied).not.toContain('+row-37235')
})

test('normal working diff renders completely without a truncation notice', async ({ page }) => {
  const diff = '@@ -1,2 +1,2 @@\n-old()\n+next()\n unchanged'
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
  await expect(page.getByTestId('diff-truncation')).toHaveCount(0)
  await expect(page.locator('[data-testid="diff-view"] [data-diff]')).toHaveCount(4)
})

test('newline-dense commit diff uses the same row cap and truncation notice', async ({ page }) => {
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
  await expect(diffView.getByTestId('diff-truncation')).toBeVisible()
  await expect(diffView.getByTestId('diff-truncation')).toContainText('diff is too large')
  await expect(page.locator('[data-testid="diff-view"] [data-diff]')).toHaveCount(MAX_RENDERED_DIFF_ROWS)
})
