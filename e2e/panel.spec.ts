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
 * ── 자주 쓰는 명령어 (#44 → #60에서 창으로) ──────────────────────────
 *
 * 등록·실행·삭제·로그가 한 창 안에 있다. 터미널 탭과는 별개의 실행 경로다:
 * 명령별 프로세스 하나, 마지막 실행 로그 하나. 여기서 보는 것은 **명령이 어느
 * 프로젝트로 가는가**와 **로그가 약속대로 남는가**다.
 */

/** 목의 실행 장부 — 어느 프로젝트의 어떤 명령이 돌(았)는지 */
async function commandRuns(page: Page): Promise<{ key: string; running: boolean; history: string }[]> {
  return page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    return [...m.commandRuns.entries()].map(([key, r]: [string, any]) => ({
      key, running: r.running, history: r.history,
    }))
  })
}

test('명령어 창: 등록 → 선택 → 실행이면 로그가 흐르고, 끝나면 종료 코드가 남는다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm test')
  await page.getByTestId('run-add').click()
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm test')

  // 선택은 실행이 아니다 — 실행 버튼이 따로 있다 (#60 설계)
  await page.getByTestId('run-command-0').click()
  expect(await commandRuns(page)).toEqual([])
  await page.getByTestId('run-exec').click()

  // 돌고 있다는 표시 + 로그 스트림
  await expect(page.getByTestId('run-running-0')).toBeVisible()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm test', '테스트 3개 통과\r\n')
  })
  await expect(page.getByTestId('run-log')).toContainText('테스트 3개 통과')

  // 단발성의 결말: 끝나면 종료 코드가 뱃지로 남는다
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm test', 0)
  })
  await expect(page.getByTestId('run-exit-0')).toContainText('exit 0')

  // 로그는 창을 닫았다 열어도 남는다 — 같은 명령을 다시 실행하기 전까지 (사용자 결정)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await expect(page.getByTestId('run-log')).toContainText('테스트 3개 통과')

  // 재실행은 로그를 교체한다 — 옛 로그가 새 실행 앞에 섞이면 안 된다
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-log')).not.toContainText('테스트 3개 통과')
  await expect(page.getByTestId('run-running-0')).toBeVisible()
})

test('명령어 창: 데브 서버는 Stop으로 끄고, 로그는 남는다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm dev', '서버가 5173에서 듣는 중\r\n')
  })
  await expect(page.getByTestId('run-log')).toContainText('5173')

  await page.getByTestId('run-stop').click()
  // 멈추면 실행 중 표시가 내려가고, 로그는 그대로다 — 종료도 결과다
  await expect(page.getByTestId('run-exit-0')).toBeVisible()
  await expect(page.getByTestId('run-log')).toContainText('5173')
})

test('명령어 창: 등록한 명령은 창을 닫았다 열어도 그대로 있다', async ({ page }) => {
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

test('명령어 창: 지우기는 실행과 다른 과녁이다 — 지웠는데 돌면 되돌릴 수 없다', async ({ page }) => {
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
  expect(await commandRuns(page)).toEqual([])
})

/**
 * 그리드 칸의 실행 버튼이 **그 칸의 프로젝트**로 보내는가.
 *
 * 화면에 보이는 터미널을 기준으로 삼았다면 여기서 갈린다: 그리드에는 증거 레인이 아예
 * 없고, 직전까지 보던 프로젝트는 알파다. 명령은 누른 칸의 세션이 사는 곳으로 가야 한다.
 */
test('명령어 창: 명령은 누른 칸의 프로젝트로 간다 — 직전에 보던 프로젝트가 아니라', async ({ page }) => {
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
  await page.getByTestId('run-exec').click()

  // 베타의 것으로 기록됐다 — 로그도 그 칸 안에서 보이므로 화면을 옮길 필요가 없다 (#60)
  const runs = await commandRuns(page)
  expect(runs).toHaveLength(1)
  const betaProjectId = await page.evaluate(() => {
    const s = (window as never as { __store: any }).__store.getState()
    return (Object.values(s.projects) as { id: string; path: string }[]).find((p) => p.path === '/tmp/beta')!.id
  })
  expect(runs[0]!.key.startsWith(betaProjectId)).toBe(true)
})

test('명령어 창: 오케스트레이터에는 없다 — 프로젝트가 없으니 돌릴 디렉토리도 없다', async ({ page }) => {
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

/*
 * ── Grid: live reflow while dragging (#53) ──────────────────────────
 *
 * The old edge line said "before/after this neighbour", but the grid reflows on drop —
 * the line pointed at a layout that stopped existing the moment you let go. Now the grid
 * rearranges live while dragging, so the drop changes nothing visually. What has to hold:
 * the preview is *only* a preview (nothing persists, cancel restores), cells never change
 * size mid-drag, and panels move as the same DOM nodes (a remount would drop scroll state).
 *
 * Playwright's dragAndDrop is atomic — it cannot look at the screen mid-drag. So the drag
 * events are dispatched by hand, sharing one DataTransfer the way a real drag does
 * (same technique as control-loop.spec.ts).
 */

/** The panel order as the user sees it — DOM order is React's render order */
async function panelOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="grid-panel-"]')].map(
      (el) => el.dataset.testid!.slice('grid-panel-'.length),
    ),
  )
}

async function startDrag(page: Page, from: string) {
  await page.evaluate((id: string) => {
    const w = window as never as { __dt?: DataTransfer }
    w.__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="grid-panel-${id}"] [data-testid="pane-header"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true }))
  }, from)
}

/** dragover on the left (20%) or right (80%) half of a panel, like a pointer passing over it */
async function hoverPanel(page: Page, target: string, side: 'left' | 'right') {
  await page.evaluate(
    ({ to, where }: { to: string; where: string }) => {
      const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
      const r = card.getBoundingClientRect()
      const x = where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8
      card.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: (window as never as { __dt?: DataTransfer }).__dt,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: r.top + r.height / 2,
        }),
      )
    },
    { to: target, where: side },
  )
}

/** drop on a panel, then dragend on the source — the order the browser fires them in */
async function dropOnPanel(page: Page, target: string, side: 'left' | 'right', from: string) {
  await page.evaluate(
    ({ to, where, src }: { to: string; where: string; src: string }) => {
      const dt = (window as never as { __dt?: DataTransfer }).__dt
      const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
      const r = card.getBoundingClientRect()
      const x = where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8
      card.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height / 2 }),
      )
      document
        .querySelector(`[data-testid="grid-panel-${src}"] [data-testid="pane-header"]`)!
        .dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    },
    { to: target, where: side, src: from },
  )
}

/** Escape and dropping outside the window both surface as dragend without a drop */
async function cancelDrag(page: Page, from: string) {
  await page.evaluate((src: string) => {
    document
      .querySelector(`[data-testid="grid-panel-${src}"] [data-testid="pane-header"]`)!
      .dispatchEvent(
        new DragEvent('dragend', { dataTransfer: (window as never as { __dt?: DataTransfer }).__dt, bubbles: true }),
      )
  }, from)
}

const storedPanels = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as never as { __store: any }).__store.getState().gridPanels)

/*
 * ── Panel tabs: reorder, split, and one global arrangement (#20) ─────
 *
 * The tabs can be dragged into a new order, and dragged into the bottom half of the
 * body to split the panel into two stacked groups. The arrangement is global — one for
 * the whole app, surviving a relaunch — because the panel is a way of looking, not
 * project state. Drags are dispatched by hand with one shared DataTransfer, the same
 * technique as the grid tests above (Playwright's dragAndDrop is atomic).
 */

/** The strip order as the user sees it — every tab button, in DOM order */
async function tabOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="evidence-tab-"]')].map(
      (el) => el.dataset.testid!.slice('evidence-tab-'.length),
    ),
  )
}

async function startTabDrag(page: Page, tab: string) {
  await page.evaluate((t: string) => {
    const w = window as never as { __dt?: DataTransfer }
    w.__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="evidence-tab-${t}"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true }))
  }, tab)
}

/** dragover then drop on the left (20%) or right (80%) half of another tab */
async function dropOnTab(page: Page, target: string, side: 'left' | 'right') {
  await page.evaluate(
    ({ to, where }: { to: string; where: string }) => {
      const dt = (window as never as { __dt?: DataTransfer }).__dt
      const el = document.querySelector(`[data-testid="evidence-tab-${to}"]`)!
      const r = el.getBoundingClientRect()
      const opts = {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8,
        clientY: r.top + r.height / 2,
      }
      el.dispatchEvent(new DragEvent('dragover', opts))
      el.dispatchEvent(new DragEvent('drop', opts))
    },
    { to: target, where: side },
  )
}

/** dragover then drop on the bottom half of the top group's body — the split gesture */
async function dropOnBodyBottom(page: Page) {
  await page.evaluate(() => {
    const dt = (window as never as { __dt?: DataTransfer }).__dt
    const el = document.querySelector('[data-testid="evidence-body-0"]')!
    const r = el.getBoundingClientRect()
    const opts = {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height * 0.8,
    }
    el.dispatchEvent(new DragEvent('dragover', opts))
    el.dispatchEvent(new DragEvent('drop', opts))
  })
}

test('tab order is dragged, and survives a relaunch — one arrangement for the whole app (#20)', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')
  expect(await tabOrder(page)).toEqual(['git', 'history', 'files', 'terminal'])

  await startTabDrag(page, 'terminal')
  await dropOnTab(page, 'git', 'left')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])

  /*
   * A relaunch: fresh page, fresh store, fresh mock — only localStorage survives, which
   * is the mock's stand-in for the host's on-disk snapshot. The project has to be added
   * again (the mock's projects are in-memory), and the arrangement must already be back.
   */
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('first-run-pick').click()
  await newSession(page, 'alpha', 'claude', '다시')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])
})

test('dragging a tab to the bottom half splits the panel — two tabs visible at once (#20)', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)

  // Git stays on top, the file tree opens below it — both on screen at the same time
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await expect(page.getByTestId('file-tree')).toBeVisible()
  // The bottom group has its own strip, holding the tab that moved down
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()
  await expect(page.getByTestId('evidence-tabs-1').getByTestId('evidence-tab-files')).toBeVisible()
  // The top strip gave that tab up — a tab lives in exactly one group
  expect(await tabOrder(page)).toEqual(['git', 'history', 'terminal', 'files'])
})

/*
 * The dogfooding overlap: git on top, another tab split below, and the top group's
 * content painted over the bottom group's tab strip. Two causes, both fixed — the git
 * tab's fixed-height history strip (removed; history lives in its own tab) and the
 * group body clipping nothing (overflow-hidden now). The hit test is the claim: if
 * anything overlaps the strip, the point under its tab resolves to the intruder.
 */
test('a tall top group never paints over the bottom group‘s tab strip', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = Array.from({ length: 80 }, (_, i) => ({
      path: `src/f${i}.ts`, staged: false, status: 'M',
    }))
  })
  await newSession(page, 'alpha', 'claude', '작업')

  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="evidence-tabs-1"]')!
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
  })
  expect(hit).toBe(true)
})

test('dragging the bottom group‘s last tab back to the top strip closes the split (#20)', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')
  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  await startTabDrag(page, 'files')
  await dropOnTab(page, 'terminal', 'right')

  await expect(page.getByTestId('evidence-tabs-1')).toBeHidden()
  await expect.poll(() => tabOrder(page)).toEqual(['git', 'history', 'terminal', 'files'])
  // One body again, showing the tab that just landed (dropping it is picking it)
  await expect(page.getByTestId('file-tree')).toBeVisible()
  await expect(page.getByTestId('evidence-git')).toBeHidden()
})

test('⌘⇧1–4 keeps working after a reorder — the digit follows the tab, not the seat (#20)', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await startTabDrag(page, 'terminal')
  await dropOnTab(page, 'git', 'left')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])

  /*
   * Identity mapping (1 git · 2 history · 3 files · 4 terminal): the Settings list is
   * static text, so only a mapping a reorder does not move can stay truthful — and
   * muscle memory should not be silently retargeted by a drag.
   */
  await page.keyboard.press('ControlOrMeta+Shift+Digit3')
  await expect(page.getByTestId('file-tree')).toBeVisible()

  // 4 is still the terminal even though the terminal now sits first in the strip
  await page.keyboard.press('ControlOrMeta+Shift+Digit4')
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+Shift+Digit1')
  await expect(page.getByTestId('evidence-git')).toBeVisible()
})

test('끄는 동안 격자가 미리 재배열된다 — 칸 크기는 그대로, 저장은 아직', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '첫째')
  const b = await newSession(page, 'alpha', 'claude', '둘째')
  const c = await newSession(page, 'alpha', 'claude', '셋째')
  await openGrid(page, [a, b, c])
  await expect(page.getByTestId(`grid-panel-${c}`)).toBeVisible()
  const sizeBefore = await page.getByTestId(`grid-panel-${b}`).boundingBox()

  await startDrag(page, a)
  await hoverPanel(page, c, 'right')
  // The screen already shows the outcome — this is the whole point of #53.
  // (Polled: React flushes dragover updates at continuous priority, a beat after the event)
  await expect.poll(() => panelOrder(page)).toEqual([b, c, a])
  // ...but it is only a preview: the committed order must not move until the drop
  expect(await storedPanels(page)).toEqual([a, b, c])

  // Cells must not change size mid-drag, or the cell the hand is aiming at moves
  const sizeDuring = await page.getByTestId(`grid-panel-${b}`).boundingBox()
  expect(sizeDuring!.width).toBe(sizeBefore!.width)
  expect(sizeDuring!.height).toBe(sizeBefore!.height)

  // Hovering the other half previews the other outcome — the preview follows the pointer
  await hoverPanel(page, c, 'left')
  await expect.poll(() => panelOrder(page)).toEqual([b, a, c])

  await cancelDrag(page, a)
  await expect.poll(() => panelOrder(page)).toEqual([a, b, c])
  expect(await storedPanels(page)).toEqual([a, b, c])
})

test('놓으면 미리 보던 그대로 남는다 — 칸은 같은 노드로 이동한다 (스크롤이 산다)', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '첫째')
  const b = await newSession(page, 'alpha', 'claude', '둘째')
  const c = await newSession(page, 'alpha', 'claude', '셋째')
  await openGrid(page, [a, b, c])
  await expect(page.getByTestId(`grid-panel-${c}`)).toBeVisible()

  // Give the dragged panel a conversation long enough to scroll, and scroll it
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({
      chat: {
        ...store.getState().chat,
        [sid]: Array.from({ length: 80 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', seq: 1000 + i, text: `지난 대화 ${i}` })),
      },
    })
  }, a)
  await page.evaluate((sid: string) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"]`)!
    panel.dataset.probe = 'same-node'
    panel.querySelector<HTMLElement>('[data-testid="chat-stream"]')!.scrollTop = 40
  }, a)
  /*
   * The chat adjusts its own scroll for a few frames after content lands (virtualised rows
   * re-measure). Wait for it to settle and take *that* value as the baseline — pinning the
   * 40 set above races the chat's measurement pass and fails on a number like 8.
   */
  const readScroll = () =>
    page.evaluate(
      (sid: string) => document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"] [data-testid="chat-stream"]`)!.scrollTop,
      a,
    )
  /*
   * Setting 40 once is not enough: if the pane's landing pass is still running it takes
   * the value straight back (the test died on its own precondition, ~1 in 3 under a full
   * parallel run — same failure on unmodified main). Write until it holds, the same
   * pattern the fs-watch tests use for slow observers.
   */
  await expect
    .poll(async () => {
      await page.evaluate((sid: string) => {
        document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"] [data-testid="chat-stream"]`)!.scrollTop = 40
      }, a)
      await page.waitForTimeout(80)
      return readScroll()
    })
    .toBeGreaterThan(0)
  let scrolled = await readScroll()
  for (let prev = -1; scrolled !== prev; scrolled = await readScroll()) {
    prev = scrolled
    await page.waitForTimeout(50)
  }
  expect(scrolled).toBeGreaterThan(0) // the pane really is scrolled — otherwise the check below proves nothing

  await startDrag(page, a)
  await hoverPanel(page, c, 'right')
  await expect.poll(() => panelOrder(page)).toEqual([b, c, a])

  /*
   * Two separate things must hold here, because they fail separately:
   * - the marker proves key={id} made React *move* the pane, not remake it — a remount
   *   would discard the old node and the marker with it;
   * - the scrollTop proves GridView put the conversation scroll back. Moving a node resets
   *   its scrollable descendants to 0 even *without* a remount (scroll is layout state,
   *   not a DOM property — measured 40 → 0 before GridView restored it), so without the
   *   restore every reflow step would kick the conversation back to the top.
   */
  const after = await page.evaluate((sid: string) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"]`)!
    return { probe: panel.dataset.probe ?? null, scrollTop: panel.querySelector<HTMLElement>('[data-testid="chat-stream"]')!.scrollTop }
  }, a)
  expect(after).toEqual({ probe: 'same-node', scrollTop: scrolled })

  await dropOnPanel(page, c, 'right', a)
  // The drop changed nothing visually — and now the store agrees with the screen
  await expect.poll(() => panelOrder(page)).toEqual([b, c, a])
  expect(await storedPanels(page)).toEqual([b, c, a])
})

