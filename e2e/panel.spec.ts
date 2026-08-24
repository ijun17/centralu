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

/*
 * ── 변경 목록 → diff ─────────────────────────────────────────────────
 *
 * The right-hand list stays visible while the wide view is open (#15), and that was the
 * point of leaving it there: it is where the next file comes from. So a click on it has to
 * land in the diff every time, not just the first time.
 */

test('두 번째 파일을 눌러도 diff가 따라온다 — 목록은 덮이지 않으니 계속 눌린다', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+첫째 파일의 줄'
    m.gitState.diffs['src/b.ts'] = '@@ -1 +1 @@\n+둘째 파일의 줄'
  })
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('첫째 파일의 줄')

  // 여기가 무너져 있었다: 이름은 src/b.ts로 바뀌는데 아래는 여전히 첫째 파일의 diff였다
  await page.getByTestId('evidence-file-src/b.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('둘째 파일의 줄')
  await expect(page.getByTestId('diff-view')).not.toContainText('첫째 파일의 줄')
})

test('넓은 목록에서 고른 파일을 목록 갱신이 되돌리지 않는다', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+첫째 파일의 줄'
    m.gitState.diffs['src/b.ts'] = '@@ -1 +1 @@\n+둘째 파일의 줄'
  })
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('첫째 파일의 줄')

  // 넓은 화면 자신의 목록에서 고른 것 — 여기서 스테이지하면 목록을 다시 읽는다
  await page.getByTestId('git-file-src/b.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('둘째 파일의 줄')
  await page.getByTestId('git-stage-all').click()
  await expect(page.getByTestId('git-unstage-all')).toBeVisible()
  // 목록이 새로 와도 처음 들고 온 경로로 끌려가면 안 된다
  await expect(page.getByTestId('diff-view')).toContainText('둘째 파일의 줄')
})

test('같은 파일을 다시 눌러도 열린다 — 다른 탭에 가 있어도 돌아온다', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+첫째 파일의 줄'
  })
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('첫째 파일의 줄')

  // 넓은 화면 안에서 기록을 잠깐 들여다본 뒤
  await page.getByTestId('git-sub-history').click()
  await expect(page.getByTestId('git-history')).toBeVisible()

  // 같은 파일을 다시 누른다 — 경로가 같다고 해서 "아무 일도 없었다"가 되면 안 된다
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('첫째 파일의 줄')
  await expect(page.getByTestId('git-history')).toBeHidden()
})

test('커밋도 두 번째부터 열린다 — 목록이 남아 있으니 계속 눌린다', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: '첫 커밋', author: '나', daysAgo: 0 },
    { sha: 'bbb2222', subject: '두 번째', author: '나', daysAgo: 1 },
  ])
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.diffs['aaa1111'] = '@@ -0,0 +1 @@\n+첫 커밋의 줄'
    m.gitState.diffs['bbb2222'] = '@@ -0,0 +1 @@\n+두 번째의 줄'
  })
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('diff-view')).toContainText('첫 커밋의 줄')

  await page.getByTestId('history-commit-bbb2222').click()
  await expect(page.getByTestId('diff-view')).toContainText('두 번째의 줄')
  await expect(page.getByTestId('diff-view')).not.toContainText('첫 커밋의 줄')
})

/** 저장소에 묻는 질문이므로 깃 탭과 같은 취급을 받는다 */
test('git 저장소가 아니면 기록 탭도 깃 탭처럼 비활성이다', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible()
  await page.evaluate(async () => {
    const store = (window as never as { __store: any }).__store
    const m = (window as never as { __mock: any }).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-nogit', path, name: 'nogit', defaultTool: 'claude', commands: [], git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
  await page.getByTestId('new-session-nogit').click()
  await page.getByTestId('create-session-confirm').click()

  await expect(page.getByTestId('evidence-tab-git')).toBeDisabled()
  await expect(page.getByTestId('evidence-tab-history')).toBeDisabled()
  await expect(page.getByTestId('evidence-not-repo')).toBeVisible()
})

/*
 * ── 실행 메뉴 (#44) ──────────────────────────────────────────────────
 *
 * 등록·실행·삭제가 한 메뉴 안에 있다. 여기서 보는 것은 **명령이 어디로 가는가**다 —
 * 어느 프로젝트의 셸로 갔고, 그게 사람 눈에 보이는 자리인가. 조용히 도는 명령은
 * 안 도는 것보다 나쁘다.
 */

/** 목이 받아 적은 입력 — 어느 터미널의 어느 디렉토리로 갔는지까지 */
async function typedIntoTerminals(page: Page): Promise<{ cwd: string; data: string }[]> {
  return page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    return m.terminalState.input.map((i: { terminalId: string; data: string }) => {
      for (const [cwd, list] of m.terminalState.byCwd) {
        if (list.some((t: { id: string }) => t.id === i.terminalId)) return { cwd, data: i.data }
      }
      return { cwd: '(어느 터미널인지 모름)', data: i.data }
    })
  })
}

test('실행 메뉴: 등록한 명령이 프로젝트 터미널에서 돌고, 패널이 터미널로 옮겨 간다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm test')
  await page.getByTestId('run-add').click()
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm test')

  await page.getByTestId('run-command-0').click()

  // 보이는 자리에서 돌아야 한다 — 탭이 따라오지 않으면 출력이 어디 있는지 알 수 없다
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()
  // 사람이 친 것과 구별되지 않아야 한다: 명령 뒤의 \r이 곧 엔터다
  expect(await typedIntoTerminals(page)).toEqual([{ cwd: '/tmp/alpha', data: 'pnpm test\r' }])
})

test('실행 메뉴: 등록한 명령은 메뉴를 닫았다 열어도 그대로 있다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm lint')
  await page.getByTestId('run-add').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()

  await page.getByTestId('run-open').click()
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm lint')
})

test('실행 메뉴: 지우기는 실행과 다른 과녁이다 — 지웠는데 돌면 되돌릴 수 없다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('run-open').click()
  for (const cmd of ['pnpm test', 'pnpm lint']) {
    await page.getByTestId('run-add-input').fill(cmd)
    await page.getByTestId('run-add').click()
  }
  await expect(page.getByTestId('run-command-1')).toContainText('pnpm lint')

  await page.getByTestId('run-delete-0').click()

  // 남은 것이 위로 올라온다 — 지운 자리가 빈 줄로 남으면 안 된다
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm lint')
  await expect(page.getByTestId('run-command-1')).toBeHidden()
  // 그리고 아무것도 돌지 않았다
  expect(await typedIntoTerminals(page)).toEqual([])
})

/**
 * 그리드 칸의 실행 버튼이 **그 칸의 프로젝트**로 보내는가.
 *
 * 화면에 보이는 터미널을 기준으로 삼았다면 여기서 갈린다: 그리드에는 증거 레인이 아예
 * 없고, 직전까지 보던 프로젝트는 알파다. 명령은 누른 칸의 세션이 사는 곳으로 가야 한다.
 */
test('실행 메뉴: 명령은 누른 칸의 프로젝트로 간다 — 직전에 보던 프로젝트가 아니라', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    await (window as never as { __store: any }).__store.getState().addProject('/tmp/beta')
  })
  const alpha = await newSession(page, 'alpha', 'claude', '알파 작업')
  const beta = await newSession(page, 'beta', 'claude', '베타 작업')

  // 베타 세션에 명령을 등록해 두고
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm build')
  await page.getByTestId('run-add').click()
  await page.keyboard.press('Escape')

  // 화면은 알파를 보고 있게 만든 다음 그리드로 간다
  await page.evaluate((id: string) => (window as never as { __store: any }).__store.getState().focusSession(id), alpha)
  await openGrid(page, [alpha, beta])
  await expect(page.getByTestId(`grid-panel-${beta}`)).toBeVisible()

  await page.getByTestId(`grid-panel-${beta}`).getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()

  expect(await typedIntoTerminals(page)).toEqual([{ cwd: '/tmp/beta', data: 'pnpm build\r' }])
  // 그리드에는 증거 레인이 없으므로, 보이는 곳까지 데려가야 실행이 보인다
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()
  await expect(page.getByTestId('evidence-project')).toContainText('beta')
})

test('실행 메뉴: 오케스트레이터에는 없다 — 프로젝트가 없으니 돌릴 디렉토리도 없다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')
  await expect(page.getByTestId('run-open')).toBeVisible()

  await page.evaluate(async () => {
    await (window as never as { __store: any }).__store.getState().openOrchestrator()
  })
  await expect(page.getByTestId('session-name')).toContainText('Orchestrator')
  // 열어도 아무것도 들어갈 수 없는 메뉴는 빈 메뉴보다 없는 편이 정직하다
  await expect(page.getByTestId('run-open')).toBeHidden()
})

/*
 * ── 도는 것들은 한 시계를 본다 ──────────────────────────────────────
 *
 * 사이드바 표식과 그리드 칸 테두리는 같은 궤도를 같은 1.4초로 돈다. 그런데 CSS
 * 애니메이션은 **요소가 생긴 순간**부터 세므로, 도는 중인 세션을 뒤늦게 그리드로
 * 데려오면 칸의 궤도만 거기서 0부터 시작한다. 실측 758ms — 거의 정반대였다.
 * 주기가 같아도 위상이 다르면 눈에는 그냥 따로 노는 두 개다.
 */
test('그리드 칸 테두리와 사이드바 표식은 같은 각도로 돈다 — 늦게 합류해도', async ({ page }) => {
  await setup(page)
  const id = await newSession(page, 'alpha', 'claude', '작업')

  // 먼저 포커스 뷰에서 돌기 시작한다 — 사이드바 표식의 궤도는 여기서 태어난다
  await page.getByTestId('prompt-input').fill('오래 걸리는 일')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('tool-mark-claude')).toHaveClass(/cc-orbit/)

  // ...칸은 한참 뒤에 생긴다. 고치기 전에는 이 간격이 그대로 각도 차이였다
  await page.waitForTimeout(700)
  await openGrid(page, [id])
  await expect(page.getByTestId(`grid-panel-${id}`)).toHaveClass(/cc-orbit-ring/)

  const phases = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => (a as CSSAnimation).animationName === 'cc-orbit-spin')
      .map((a) => Math.round(Number(a.currentTime))),
  )
  expect(phases).toHaveLength(2)
  // 같은 각도다. 프레임 하나(16.7ms) 안쪽이면 눈에는 같은 것이다
  expect(Math.abs(phases[0]! - phases[1]!)).toBeLessThan(17)
})
