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
    // `@@ -1 +1 @@`의 첫 줄이 맨 위에 있으니 1번 줄이다 — `line`이 빠지면 여기서 걸린다
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

/**
 * 아래는 #122의 "Diff pane" 항목들 — 전부 **보이는 것**에 대한 주장이라,
 * 각 시험은 CSS를 읽는 대신 실제로 스크롤시키고 상자를 잰다.
 */

/** 한 파일짜리 작업 diff를 열기까지. 아래 시험들이 매번 되풀이하던 여섯 줄이다. */
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
 * 밴드는 `sticky top-0`만 걸려 있었다 — 가로로 밀면 같이 밀려 나갔다 (#122).
 * 압축된 한 줄을 읽으려고 오른쪽으로 가는 순간, 어느 파일인지 말해 주던 띠가 사라진다.
 */
test('가로로 밀어도 파일 밴드와 행 배경이 보이는 폭을 덮는다', async ({ page }) => {
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

  // 가로 스크롤이 실제로 일어나야 이 시험이 무언가를 주장한다
  expect(seen.scrollLeft).toBe(1_500)
  expect(seen.band.left).toBeGreaterThanOrEqual(-1)
  expect(seen.band.right).toBeGreaterThanOrEqual(-1)
  expect(seen.row.left).toBeLessThanOrEqual(1)
  expect(seen.row.right).toBeGreaterThanOrEqual(-1)
})

/** 9칸 들여쓴 줄과 8칸 들여쓴 줄이 같은 자리에서 시작하면 diff는 거짓말을 한다 (#122) */
test('들여쓰기 한 칸 차이가 화면에서도 한 칸이다', async ({ page }) => {
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

  // 9칸이 8칸보다 정확히 한 글자 오른쪽에 있어야 한다 (11px 모노스페이스 ≈ 6.6px)
  expect(lefts[0]! - lefts[1]!).toBeGreaterThan(3)
})

/** 밴드와 목록 안 `diff --git` 행은 눈에는 하나지만 스크린 리더에는 둘이었다 (#122) */
test('파일 이름이 접근성 트리에 한 번만 나온다', async ({ page }) => {
  await openWorkingDiff(page, 'src/min.js', MINIFIED_DIFF)
  await expect(page.getByTestId('diff-current-file-band')).toContainText('src/min.js')
  await expect(page.getByTestId('diff-file-band')).toBeVisible()

  /*
   * 헤더가 한 번 — 그건 이 화면의 제목이다. 목록 안 `diff --git` 행이 한 번 — 그게
   * 진짜 내용이다. 밴드는 그 행을 눈으로 따라가는 장치라 여기 또 나오면 세 번이 된다.
   */
  const snapshot = await page.getByTestId('diff-view').ariaSnapshot()
  expect(snapshot.split('src/min.js').length - 1).toBe(2)
})

/** Tab이 이름 없는 `<div>`에 떨어지면 거기가 어딘지 말해 줄 방법이 없다 (#122) */
test('스크롤 칸은 이름 있는 region이고 Tab으로 닿는다', async ({ page }) => {
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
  // 이름에 파일까지 넣으면 헤더와 겹쳐 같은 이름을 또 읽는다 — 바로 위 시험의 그 문제다
  expect(focused.label).toBe('Diff')
})

/** ⌘A가 담아 준 것은 patch여야 한다 — 사람에게 하는 안내문은 `git apply`를 깨뜨린다 (#122) */
test('잘린 diff를 ⌘A로 복사해도 안내문이 클립보드에 섞이지 않는다', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
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
  // 화면에는 여전히 안내문이 떠 있어야 한다 — 잘렸다는 사실은 사라지지 않는다
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

/** 보고 있던 줄이 아니라 1번 줄이 열리면 "IDE로 나가서 보라"는 말이 반쪽이다 (#122) */
test('IDE는 지금 보고 있는 줄에서 열린다', async ({ page }) => {
  const body = Array.from({ length: 400 }, (_, i) => `+line-${String(i).padStart(3, '0')}`).join('\n')
  const diff = ['diff --git a/src/long.ts b/src/long.ts', '@@ -0,0 +1,400 @@', body].join('\n')
  await openWorkingDiff(page, 'src/long.ts', diff)

  // 행 0은 `diff --git`, 행 1은 `@@`, 행 2가 새 파일의 1번 줄이다
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="diff-view"] .overflow-auto')
    if (!root) throw new Error('diff scroll root not found')
    root.scrollTop = 2_000
  })
  // 가상 스크롤은 scrollTop을 준 뒤 한 번 더 그린다 — 그리기 전에 재면 보이는 행이 없다.
  // "맨 위"의 기준은 칸의 위쪽 가장자리가 아니라 **밴드 아래**다: 그 위는 밴드가 덮는다.
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
 * 커밋 diff의 "Open in IDE"는 `async () => {}`에 연결돼 있어 눌러도 조용했다 (#122).
 * 커밋 화면은 파일이 여럿이라, 어느 파일인지는 밴드가 가리키는 그것이어야 한다.
 */
test('커밋 diff에서도 Open in IDE가 지금 보고 있는 파일과 줄을 연다', async ({ page }) => {
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

  // 두 번째 파일의 행 번호는 82(`diff --git`)·83(`@@`)부터라, 새 파일 줄 = 행 - 83
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
