import { expect, test, type Page } from '@playwright/test'

/**
 * 실물 host의 diff 상한 (`gitDiff`/`gitCommitDetail`, packages/agent-host/src/dev-services/git.ts).
 * 이름은 400KiB라고 불렀지만 host가 재는 것은 **문자 수**이고 값은 400,000이다.
 */
const HOST_DIFF_MAX_CHARS = 400_000
/* 한 줄이 11자(`+row-00000` + 줄바꿈)라, 상한 바로 아래에서 가장 험한 입력이 이만큼이다 */
const HOSTILE_DIFF_ROWS = 36_363
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
  // 400KiB(409,600)로 재던 동안 이 이름은 거짓이었다 — 실물이라면 잘렸을 입력이었다 (#121)
  expect(hostileDiff().length).toBeLessThanOrEqual(HOST_DIFF_MAX_CHARS)
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
 * 위의 `toHaveCount(0)`들은 오래도록 **실패할 수 없는 문장**이었다: 목이 truncated를
 * false로 못박아 둬서, 안내가 뜨는 경우가 아예 존재하지 않았다 (#121). 여기서 뜨는
 * 쪽을 한 번 지나가야 안 뜨는 쪽도 비로소 주장이 된다.
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
  await expect(diffView).toContainText(HOSTILE_LAST_ROW)
})

/* commitDetail.truncated는 배선만 되고 지나가는 시험이 하나도 없었다 (#121) */
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
 * 사이드바에서 파일을 고른 사람도 ⌘A로 전체를 복사한다 (#118).
 *
 * 위 시험은 복사 전에 diff 칸을 **클릭**한다. 그래서 포커스가 칸에 있는 경우만 덮었고,
 * 실제로 사람이 하는 일 — 증거 사이드바에서 파일을 고르고 곧바로 ⌘A — 은 한 번도 지나가지
 * 않았다. 그 경로에서는 포커스가 사이드바 버튼에 남아 ⌘A가 문서로 갔고, 칸에 걸린 copy
 * 리스너가 마운트된 행만 담은 채 기본 동작까지 막아 37,236행이 60행이 됐다.
 */
test('사이드바에서 고른 뒤 바로 ⌘A를 눌러도 전체가 복사된다 (#118)', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await setup(page)
  await page.evaluate((diff) => {
    const mock = window.__mock
    if (!mock) throw new Error('mock platform is required')
    mock.gitState.files = [{ path: 'src/bomb.ts', staged: false, status: 'M' }]
    mock.gitState.diffs['src/bomb.ts'] = diff
  }, hostileDiff())
  await newSession(page)

  // 칸을 클릭하지 않는다 — 사이드바에서 고르는 것이 전부다
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
