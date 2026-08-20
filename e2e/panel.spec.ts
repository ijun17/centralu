import { expect, test, type Page } from '@playwright/test'

/**
 * 우측 패널과 사용량 모달 — "화면에 여럿이 떠 있을 때 무엇을 보여주나".
 *
 * control-loop.spec.ts와 나누는 이유는 주제다. 저기는 관제 루프 한 바퀴가 도는지를 보고,
 * 여기는 **여러 개가 동시에 있을 때 화면이 무엇을 고르는가**를 본다 (#26, #21).
 */

async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible()
  // 프로젝트가 0개면 사이드바가 없다 — 첫 프로젝트는 시작 안내에서 등록한다
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('first-run-pick').click()
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

/** 세션 하나를 만들고 그 id를 돌려준다 */
async function newSession(page: Page, project: string, tool: 'claude' | 'codex', prompt: string): Promise<string> {
  await page.getByTestId(`new-session-${project}`).click()
  await page.getByTestId(`tool-option-${tool}`).click()
  await page.getByTestId('initial-prompt').fill(prompt)
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  return page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId)
}

async function openGrid(page: Page, ids: string[]) {
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l), ids)
  await page.getByTestId('grid-button').click()
}

/** 기본 목은 창이 비어 있어 'usage-unavailable'만 그린다 — 도넛이 나오는 상태를 만든다 */
async function stubUsage(page: Page) {
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'max',
        windows: [{ id: 'session', label: '5 hours', percent: 41, resetsAt: null, scope: null }],
        daily: [],
      },
    }
  })
}

/*
 * ── 사용량 (#26) ─────────────────────────────────────────────────────
 *
 * 사용량은 **계정** 단위인데 도구마다 다르다. 그래서 답해야 할 질문은 하나뿐이다:
 * 지금 화면에 어느 도구가 떠 있나. 그리드는 그 답이 여럿인 유일한 화면이다.
 */

test('그리드: 화면에 뜬 도구마다 한 칸씩 나온다', async ({ page }) => {
  await setup(page)
  await stubUsage(page)
  const claude = await newSession(page, 'alpha', 'claude', '클로드 작업')
  const codex = await newSession(page, 'alpha', 'codex', '코덱스 작업')
  await openGrid(page, [claude, codex])
  await expect(page.getByTestId(`grid-panel-${codex}`)).toBeVisible()

  await page.getByTestId('open-usage').click()
  await expect(page.getByTestId('usage-section-claude')).toContainText('Claude Code')
  await expect(page.getByTestId('usage-section-codex')).toContainText('Codex')
  // 두 칸 다 실제로 숫자를 그린다 — 제목만 있고 속이 비면 반쪽이다
  await expect(page.getByTestId('usage-panel')).toHaveCount(2)
})

test('그리드: 같은 도구 둘은 한 칸으로 합친다 — 계정이 하나라 숫자도 하나다', async ({ page }) => {
  await setup(page)
  await stubUsage(page)
  const a = await newSession(page, 'alpha', 'claude', '첫째')
  const b = await newSession(page, 'alpha', 'claude', '둘째')
  await openGrid(page, [a, b])
  await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()

  await page.getByTestId('open-usage').click()
  // 41%가 두 번 적히면 예산이 둘인 것처럼 읽힌다
  await expect(page.getByTestId('usage-panel')).toHaveCount(1)
  await expect(page.getByTestId('usage-modal')).toContainText('Claude Code')
})

/**
 * 예전에는 도구를 못 정하면 조용히 `'claude'`로 떨어졌다.
 * 그러면 '알 수 없음'이 사용자에게 '틀린 값'으로 도착한다 — 틀렸다는 사실조차 화면에 없이.
 */
test('그리드가 비어 있으면 짐작하지 않고 모른다고 말한다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')
  await openGrid(page, [])
  await expect(page.getByTestId('grid-empty')).toBeVisible()

  await page.getByTestId('open-usage').click()
  await expect(page.getByTestId('usage-no-tool')).toContainText('per tool')
  // 짐작한 도구 이름이 머리글에 남아 있으면 안 된다
  await expect(page.getByTestId('usage-modal')).not.toContainText('Claude Code')
})

test('포커스 뷰는 그대로 — 보고 있는 세션의 도구 하나만', async ({ page }) => {
  await setup(page)
  await stubUsage(page)
  await newSession(page, 'alpha', 'claude', '클로드 작업')
  await newSession(page, 'alpha', 'codex', '코덱스 작업')

  await page.getByTestId('open-usage').click()
  await expect(page.getByTestId('usage-modal')).toContainText('Codex')
  await expect(page.getByTestId('usage-panel')).toHaveCount(1)
  // 옆 세션이 클로드라고 해서 그 한도가 딸려 오면 안 된다
  await expect(page.getByTestId('usage-modal')).not.toContainText('Claude Code')
})

/*
 * ── 기록 탭 (#21) ────────────────────────────────────────────────────
 *
 * 깃 탭 안의 기록 띠는 커밋을 만드는 동안 곁눈질하는 맥락이라 일곱 줄에 갇혀 있다.
 * 기록을 **읽으러** 오는 것은 다른 용무라 세로 한 칸을 통째로 쓴다.
 */

/** `when`을 하루씩 뒤로 물려 커밋 목록을 만든다 (상대 날짜가 줄마다 달라지도록) */
async function seedCommits(page: Page, list: { sha: string; subject: string; author: string; daysAgo: number }[]) {
  await page.evaluate((rows: typeof list) => {
    ;(window as never as { __mock: any }).__mock.gitState.commits = rows.map((r) => ({
      sha: r.sha,
      shortSha: r.sha.slice(0, 7),
      subject: r.subject,
      author: r.author,
      when: Date.now() - r.daysAgo * 86_400_000,
      parents: [],
    }))
  }, list)
}

test('기록은 깃 옆의 탭이고, 짧은 해시와 얼마나 됐나를 함께 적는다', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: '첫 커밋', author: '나', daysAgo: 0 },
    { sha: 'bbb2222', subject: '두 번째', author: '나', daysAgo: 3 },
  ])
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('evidence-history')).toBeVisible()
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('첫 커밋')
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('aaa1111')
  await expect(page.getByTestId('history-commit-bbb2222')).toContainText('3d ago')

  // 고른 탭은 다음에 열 때를 위해 스냅샷에 실린다
  const snap = await page.evaluate(() => (window as never as { __mock: any }).__mock.workspaceSnapshot)
  expect(snap?.panelTab).toBe('history')
})

test('혼자 쓰는 저장소면 이름을 반복하지 않고, 여럿이면 적는다', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: '혼자 한 일', author: '나', daysAgo: 1 },
    { sha: 'bbb2222', subject: '그것도 혼자', author: '나', daysAgo: 2 },
  ])
  await newSession(page, 'alpha', 'claude', '작업')
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('1d ago')
  // 340px에서 매 줄 같은 이름은 정보가 아니라 소음이다
  await expect(page.getByTestId('history-commit-aaa1111')).not.toContainText('나')

  // 구별할 사람이 생기면 그때 자리를 내준다
  await seedCommits(page, [
    { sha: 'aaa1111', subject: '내가 한 일', author: '나', daysAgo: 1 },
    { sha: 'bbb2222', subject: '네가 한 일', author: '너', daysAgo: 2 },
  ])
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-bbb2222')).toContainText('너')
})

test('커밋을 누르면 넓은 곳에서 diff가 펼쳐진다', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [{ sha: 'aaa1111', subject: '첫 커밋', author: '나', daysAgo: 0 }])
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.gitState.diffs['aaa1111'] = '@@ -0,0 +1 @@\n+새 줄'
  })
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('새 줄')
})

/** 조용히 끊긴 목록은 "더 오래된 커밋이 없다"고 거짓말하는 목록이다 */
test('100개에서 끊기고, 끊겼다고 화면에 적는다', async ({ page }) => {
  await setup(page)
  await seedCommits(
    page,
    Array.from({ length: 130 }, (_, i) => ({
      sha: `c${String(i).padStart(6, '0')}`,
      subject: `커밋 ${i}`,
      author: '나',
      daysAgo: i,
    })),
  )
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.locator('[data-testid^="history-commit-"]')).toHaveCount(100)
  await expect(page.getByTestId('evidence-history-cap')).toContainText('Newest 100 commits')
})

test('상한에 못 미치면 끊겼다는 말도 하지 않는다', async ({ page }) => {
  await setup(page)
  await seedCommits(
    page,
    Array.from({ length: 12 }, (_, i) => ({ sha: `c${String(i).padStart(6, '0')}`, subject: `커밋 ${i}`, author: '나', daysAgo: i })),
  )
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.locator('[data-testid^="history-commit-"]')).toHaveCount(12)
  await expect(page.getByTestId('evidence-history-cap')).toBeHidden()
})

/** 저장소에 묻는 질문이므로 깃 탭과 같은 취급을 받는다 */
test('git 저장소가 아니면 기록 탭도 깃 탭처럼 비활성이다', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible()
  await page.evaluate(async () => {
    const store = (window as never as { __store: any }).__store
    const m = (window as never as { __mock: any }).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-nogit', path, name: 'nogit', defaultTool: 'claude', git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
  await page.getByTestId('new-session-nogit').click()
  await page.getByTestId('create-session-confirm').click()

  await expect(page.getByTestId('evidence-tab-git')).toBeDisabled()
  await expect(page.getByTestId('evidence-tab-history')).toBeDisabled()
  await expect(page.getByTestId('evidence-not-repo')).toBeVisible()
})
