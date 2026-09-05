import { test, expect, type Locator, type Page } from '@playwright/test'

/**
 * M1 Phase 5 완료 기준. mock platform(?mock)으로 UI를 구동한다.
 * 핵심은 마지막 "관제 루프" 시나리오 — §1.3의 실제 사용 흐름이 도는지.
 */

/** 브라우저 안의 mock을 조작하는 헬퍼 (window.__mock) */
async function setup(page: Page, opts: { projects?: string[] } = {}) {
  await page.goto('/?mock=1')
  // 처음이면 소개 화면이 먼저다 (#63) — 오케스트레이터가 돌 도구 카드를 하나 고른다
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  // 카드 클릭은 오케스트레이터 화면(빈 대화 + 추천 질문)으로 이어진다
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  for (const [i, path] of (opts.projects ?? []).entries()) {
    if (i === 0) {
      /*
        첫 프로젝트는 빈 오케스트레이터 화면의 **탈출구**로 등록한다 (#63 —
        대화를 강요하지 않는다). 프로젝트가 0개면 사이드바에 + 버튼이 없기 때문이다.
      */
      await page.evaluate((p: string) => {
        ;(window as any).__mock.nextPickedDirectory = p
      }, path)
      await page.getByTestId('orchestrator-pick-folder').click()
      // 첫 등록은 세션 만들기로 곧장 이어진다 — 여기서는 프로젝트만 필요하므로 닫는다
      await page.getByTestId('new-session-dialog').waitFor()
      await page.keyboard.press('Escape')
    } else {
      // 폴더 선택은 앱 전체에서 네이티브 피커 하나뿐이다 (경로 타이핑 창은 없어졌다)
      await page.evaluate((p: string) => {
        ;(window as any).__mock.nextPickedDirectory = p
      }, path)
      await page.getByTestId('add-project').click()
    }
    await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
  }
}

async function newSession(page: Page, projectName: string, prompt: string) {
  // 새 세션은 다이얼로그를 거친다 (FR-7: 도구·모델·권한을 고른다)
  await page.getByTestId(`project-menu-${projectName}`).click()
  await page.getByTestId(`new-session-${projectName}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
}

/**
 * 모델·강도·권한·에이전트는 입력창 아래 **메뉴 안에** 있다 (셀렉터 네 개가 아니라).
 * `scope`를 주면 그 칸의 메뉴다 — 그리드는 칸마다 입력창을 갖는다.
 */
async function pickSetting(page: Page, testId: string, scope?: Locator) {
  const root = scope ?? page
  // 이미 열려 있으면 그대로 쓴다 — 모델을 고르면 메뉴가 열린 채 남으므로(아래 계약),
  // 무조건 누르면 토글이 메뉴를 닫아버린다
  if (!(await root.getByTestId('settings-menu').isVisible())) {
    await root.getByTestId('settings-open').click()
  }
  await expect(root.getByTestId('settings-menu')).toBeVisible()
  await root.getByTestId(testId).click()
}

/** mock에 승인 요청을 주입 */
async function injectApproval(page: Page, sessionIdx: number, detail: Record<string, unknown>) {
  return page.evaluate(
    ({ idx, d }) => {
      const m = (window as any).__mock
      const sessions = [...(m as any).sessions.values()]
      const s = sessions[idx]
      return m.requestApproval(s.id, d)
    },
    { idx: sessionIdx, d: detail },
  )
}

async function emitEvent(page: Page, sessionIdx: number, event: Record<string, unknown>) {
  await page.evaluate(
    ({ idx, e }) => {
      const m = (window as any).__mock
      const sessions = [...(m as any).sessions.values()]
      m.emit({ ...e, sessionId: sessions[idx].id })
    },
    { idx: sessionIdx, e: event },
  )
}

test('프로젝트 등록 → 사이드바 표시 (T5-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  // 브랜치는 이름 아래에 줄을 만들지 않는다 — 물어볼 때(호버) 답한다
  await page.getByTestId('project-header-alpha').hover()
  await expect(page.getByTestId('project-tip-alpha')).toContainText('main')
})

test('폴더 선택을 취소하면 아무것도 등록되지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = null
  })
  await page.getByTestId('add-project').click()
  // 창도 없고 오류도 없다 — 고르지 않았다는 것은 실패가 아니다
  await expect(page.getByTestId('toast')).toHaveCount(0)
  const count = await page.evaluate(() => Object.keys((window as any).__store.getState().projects).length)
  expect(count).toBe(1)
})

/**
 * 첫 실행 (#63): **오케스트레이터를 먼저 만난다.**
 *
 * 목표는 효율이 아니라 습관이다 — 첫 실행에서 오케스트레이터에게 물어보는 경험을
 * 겪지 않은 사람은 나중에도 누르지 않는다. 소개 화면의 카드가 곧 도구 감지 표시이고,
 * 카드 클릭은 설정만 적는다 (프로세스는 첫 질문에서야 뜬다 — 지연 기동).
 */
test('첫 실행: 소개 화면 → 카드 선택 → 빈 오케스트레이터 대화 (세션은 아직 없다)', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  // 앱이 무엇인지가 여전히 첫 문장이고, 오케스트레이터의 역할이 눈에 띄게 선다
  // 한 줄이 전부다 — 이 화면이 파는 것은 "말을 걸 상대가 있다" 하나다
  await expect(page.getByTestId('intro-role')).toContainText('orchestrator')
  // 소개를 읽는 동안에도 사이드바는 전부 살아 있다 — 흐름을 강요하지 않는다
  await expect(page.getByTestId('add-project')).toBeVisible()
  await expect(page.getByTestId('orchestrator-button')).toBeVisible()
  await expect(page.getByTestId('grid-button')).toBeVisible()
  // 나중에 바꿀 수 있다는 안내가 선택의 부담을 낮춘다
  await expect(page.getByTestId('intro')).toContainText('You can change this later')

  await page.getByTestId('intro-card-claude').click()

  // 빈 대화 + 추천 질문 3개 + 탈출구 — 그리고 **세션은 아직 만들어지지 않았다**
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await expect(page.getByTestId('suggest-create-project')).toBeVisible()
  await expect(page.getByTestId('orchestrator-pick-folder')).toBeVisible()
  const sessionCount = await page.evaluate(() => (window as any).__mock.sessions.size)
  expect(sessionCount).toBe(0)
})

test('추천 질문 클릭 = 즉시 전송 — 그 순간에야 오케스트레이터가 태어난다 (#63 지연 기동)', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-codex').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()

  await page.getByTestId('suggest-capabilities').click()

  // 질문이 사용자 메시지로 대화에 선다 (입력창 채우기 같은 중간 단계가 없다)
  await expect(page.getByTestId('msg-user').first()).toContainText('What can you do as the orchestrator?')
  // 카드는 메시지 수의 함수다 — 첫 마디가 생겼으니 사라진다
  await expect(page.getByTestId('orchestrator-suggestions')).toHaveCount(0)
  // 소개 화면에서 고른 도구가 오케스트레이터의 도구다
  const tool = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...m.sessions.values()].find((s: any) => s.projectId === null)?.tool
  })
  expect(tool).toBe('codex')
})

test('소개 화면에서도 프로젝트를 만들 수 있다 — 사이드바가 함께 선다 (#63)', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()

  // 도구 카드를 고르지 않고, 소개를 읽던 자리에서 바로 등록한다
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('add-project').click()

  // 프로젝트가 생기면 처음인 사람이 아니다 — 소개는 물러나고 보통의 앱이 선다
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  await expect(page.getByTestId('intro')).toHaveCount(0)
  await expect(page.getByTestId('orchestrator-button')).toBeVisible()
})

/**
 * 소개를 건너뛰는 길도 열려 있어야 한다 (#63).
 *
 * 한때 소개 옆 사이드바에서 뷰 전환 버튼을 뺐다 — 눌러도 화면이 안 바뀌니
 * 죽은 클릭이라는 이유였다. 진단은 맞고 처방이 틀렸다: 감출 게 아니라 동작하게
 * 하면 된다. 감추면 "대화를 강요하지 않는다"면서 '소개 읽기'를 강요하게 된다.
 */
test('소개는 건너뛸 수 있다 — 그리드 버튼이 실제로 동작한다 (#63)', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()

  // 도구 카드를 고르지 않고 그리드로 간다
  await page.getByTestId('grid-button').click()

  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('intro')).toHaveCount(0)

  // 지나온 소개는 다시 나오지 않는다 (다시 켜도)
  await page.reload()
  await expect(page.getByTestId('intro')).toHaveCount(0)
})

test('첫 실행 탈출구: 대화를 강요하지 않는다 — 폴더를 고르면 세션 만들기로 이어진다', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()

  // 등록으로 끝나지 않는다 — 다음 걸음(세션 만들기)이 그 프로젝트 자리에서 열린다
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

/**
 * 제안 (#63): propose_project는 **가리키는 것이 실행의 전부**다.
 *
 * 대화 안에 두 번째 폴더 피커를 두면 사이드바의 Add project와 같은 일을 하는 문이
 * 둘이 되고, 처음 보는 사람은 "프로젝트는 오케스트레이터에게 시키는 것"으로 배운다.
 * 문은 앱에 하나여야 하고, 오케스트레이터는 그 문이 어디인지 알려줄 뿐이다.
 */
test('프로젝트 제안: 대화에는 버튼이 없고, 사이드바의 Add project에 불이 켜진다', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await page.getByTestId('suggest-create-project').click()
  await expect(page.getByTestId('msg-user').first()).toBeVisible()

  // 불이 켜지기 전에는 평범한 버튼이다
  await expect(page.getByTestId('add-project')).not.toHaveAttribute('data-hint', 'true')

  await page.evaluate(() => {
    const m = (window as any).__mock
    const orc = [...m.sessions.values()].find((s: any) => s.projectId === null)
    m.emit({
      type: 'tool_call',
      sessionId: orc.id,
      callId: 'c-prop',
      summary: {
        tool: 'mcp__centralu__propose_project',
        title: 'so your agents have a folder to work in',
        readOnly: false,
        paths: [],
      },
    })
  })

  // 대화에 남는 것은 위치를 알려주는 한 줄이다 — 누를 것이 아니다
  await expect(page.getByTestId('project-proposal')).toContainText('Add project')
  await expect(page.getByTestId('project-proposal').locator('button')).toHaveCount(0)
  // 그리고 진짜 문에 불이 켜진다
  await expect(page.getByTestId('add-project')).toHaveAttribute('data-hint', 'true')

  // 가리킨 문으로 들어가면 불은 꺼진다 — 지나간 안내가 남아 반짝이면 잔소리다
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/proposed'
  })
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId('project-proposed')).toBeVisible()
  await expect(page.getByTestId('add-project')).not.toHaveAttribute('data-hint', 'true')
})

test('가리킨 뒤 다른 말을 걸면 불이 꺼진다 — 화제가 옮겨갔다 (#63)', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await page.getByTestId('suggest-create-project').click()
  await expect(page.getByTestId('msg-user').first()).toBeVisible()

  // 오케스트레이터가 propose_project를 부른 상황을 재현한다
  await page.evaluate(() => {
    const m = (window as any).__mock
    const orc = [...m.sessions.values()].find((s: any) => s.projectId === null)
    m.emit({
      type: 'tool_call',
      sessionId: orc.id,
      callId: 'c-prop',
      summary: {
        tool: 'mcp__centralu__propose_project',
        title: 'To give your agents a folder to work in',
        readOnly: false,
        paths: [],
      },
    })
  })
  await expect(page.getByTestId('add-project')).toHaveAttribute('data-hint', 'true')

  // 프로젝트를 만들지 않고 다른 이야기를 시작한다
  await page.getByTestId('prompt-input').fill('never mind — what can you do?')
  await page.getByTestId('prompt-input').press('Enter')

  // 안내는 여기서 끝난다. 계속 반짝이면 안내가 아니라 잔소리다
  await expect(page.getByTestId('add-project')).not.toHaveAttribute('data-hint', 'true')
})

/**
 * 마지막에 고른 도구가 그 프로젝트의 기본값이 된다.
 *
 * default_tool은 프로젝트 생성 시 'claude'로 박힌 뒤 갱신되는 자리가 없었다 —
 * codex를 쓰는 사람은 새 세션을 만들 때마다 **영원히** 필을 다시 눌러야 했다.
 * 설정 항목이 아니라 세션을 만든 행위가 이 사실을 말한다.
 */
test('앱이 마지막에 쓴 도구를 기억한다 — 다음 세션은 거기서 시작한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 두 번째 창은 codex로 열린다 (aria-pressed가 아니라 실제 생성 파라미터로 확인한다)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params.tool).toBe('codex')
})

/**
 * 누르는 곳과 나타나는 곳이 붙어 있어야 한다 (이슈 #4).
 *
 * 예전엔 상단 바 오른쪽 끝이었다 — 화면 반대편을 눌러 놓고 결과는 왼쪽에서 찾았다.
 * 눈으로만 맞추면 다시 멀어지므로 좌표로 못 박는다.
 */
test('Add project 버튼은 사이드바 안에, 프로젝트 목록 아래에 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const sidebar = (await page.getByTestId('sidebar').boundingBox())!
  const add = (await page.getByTestId('add-project').boundingBox())!
  const project = (await page.getByTestId('project-alpha').boundingBox())!

  // 사이드바 안이다 (상단 바가 아니라)
  expect(add.x).toBeGreaterThanOrEqual(sidebar.x - 1)
  expect(add.x + add.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1)
  // 새 프로젝트가 붙는 자리(목록 끝) 바로 아래다
  expect(add.y).toBeGreaterThanOrEqual(project.y + project.height - 1)
})

test('세션 생성 → 대화 스트리밍 렌더 (T5-3)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '안녕하세요')
  await expect(page.getByTestId('msg-user')).toContainText('안녕하세요')

  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: '네, ' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: '반갑습니다' })
  await expect(page.getByTestId('msg-assistant')).toContainText('네, 반갑습니다')
})

test('첫 프롬프트가 세션 이름이 된다 (T5-6, FR-18)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'auth 모듈 리팩터링')
  await expect(page.getByTestId('session-name')).toContainText('auth 모듈 리팩터링')
})

test('도구 카드: 조회성은 접힘, 변경은 펼침 (T5-3)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'c1',
    summary: { tool: 'Read', title: 'Read: a.ts', readOnly: true, paths: [] },
  })
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'c1',
    ok: true,
    summary: `첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n파일 내용 200줄`,
  })
  // 조회성 도구는 접힌 채로 시작한다 — 맛보기만 보이고 뒷부분은 감춘다
  await expect(page.getByTestId('tool-card')).toBeVisible()
  await expect(page.getByTestId('tool-card-output')).toContainText('첫 줄')
  await expect(page.getByTestId('tool-card-output')).not.toContainText('파일 내용 200줄')
  await page.getByTestId('tool-card-toggle').click()
  await expect(page.getByTestId('tool-card-output')).toContainText('파일 내용 200줄')
})

test('승인: 카드에서 키보드 y로 허용 (T5-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })

  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-detail')).toContainText('npm run build')
  await page.locator('body').click() // 입력창 밖으로 포커스
  await page.keyboard.press('y')
  await expect(page.getByTestId('approval-card')).toBeHidden()
})

test('승인: 항상 허용은 범위를 알려준다 (T5-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await injectApproval(page, 0, { kind: 'command', command: 'npm test --watch', cwd: '/tmp/alpha' })
  await page.getByTestId('approve-always').click()
  await expect(page.getByTestId('toast')).toContainText('this session')
  // 제안은 승인한 명령 그대로다 — 예전의 'npm test*' 식 확장은 rm -rf 계열에서
  // 승인 범위를 위험하게 넓혔다 (core suggestMatcher 회귀 테스트가 지킨다)
  await expect(page.getByTestId('toast')).toContainText('npm test --watch')
})

test('배너: 명령은 제자리 승인, 파일 수정은 확인 필요 (T5-4, FR-3)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A작업')
  await newSession(page, 'beta', 'B작업') // 포커스는 beta

  // alpha(비포커스)에 명령 승인 → 배너에서 바로 허용 가능
  await injectApproval(page, 0, { kind: 'command', command: 'ls -la', cwd: '/tmp/alpha' })
  await expect(page.getByTestId('approval-banner')).toBeVisible()
  await expect(page.getByTestId('banner-allow')).toBeVisible()
  await page.getByTestId('banner-allow').click()
  await expect(page.getByTestId('approval-banner')).toBeHidden()

  // 파일 수정은 diff를 봐야 하므로 "확인 필요"
  await injectApproval(page, 0, { kind: 'file_edit', path: 'src/a.ts', diffPreview: '+1', multi: false })
  await expect(page.getByTestId('banner-review')).toBeVisible()
  await expect(page.getByTestId('banner-allow')).toBeHidden()
  await page.getByTestId('banner-review').click()
  await expect(page.getByTestId('approval-card')).toBeVisible() // 점프해서 카드로
})

test('전역 카운터는 승인과 응답대기를 분리 표기한다 (T5-5, FR-12)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A')
  await newSession(page, 'alpha', 'B')

  await injectApproval(page, 0, { kind: 'command', command: 'x', cwd: '/tmp' })
  await emitEvent(page, 1, { type: 'turn_complete' })

  await expect(page.getByTestId('count-approval')).toContainText('01')
  await expect(page.getByTestId('count-input')).toContainText('01')
})

test('관제 루프: 대기 5개를 키보드만으로 비운다 (T5-5 핵심 시나리오)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  for (const [proj, name] of [
    ['alpha', 'A1'],
    ['alpha', 'A2'],
    ['alpha', 'A3'],
    ['beta', 'B1'],
    ['beta', 'B2'],
  ] as const) {
    await newSession(page, proj, name)
  }

  // 승인 2 + 응답대기 3
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })
  await injectApproval(page, 3, { kind: 'command', command: 'pytest', cwd: '/tmp/beta' })
  for (const idx of [1, 2, 4]) await emitEvent(page, idx, { type: 'turn_complete' })

  await expect(page.getByTestId('count-approval')).toContainText('02')
  await expect(page.getByTestId('count-input')).toContainText('03')

  // 인박스 열기 — 긴급도 순으로 정렬돼 있어야 한다
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  const rows = page.locator('[data-testid^="inbox-item-"]')
  await expect(rows).toHaveCount(5)
  await expect(rows.first()).toContainText('Needs approval')

  // 승인 2건을 처리 (Enter로 점프 → y)
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await page.locator('body').click()
    await page.keyboard.press('y')
    await expect(page.getByTestId('approval-card')).toBeHidden()
    await page.keyboard.press('Meta+i')
  }
  await expect(page.getByTestId('count-approval')).toContainText('00')

  /*
    남은 응답대기 3건은 **답을 해서** 비운다.
    한때 `d` 한 키로 비울 수 있었는데, 그건 세션을 아카이브하는 것이었고 되돌리는 문이
    없어서 사람 눈에는 삭제였다 (2026-09-02 폐기). 인박스는 상태의 뷰라, 비우는 방법은
    상태를 바꾸는 것 하나뿐이다 — 그게 곧 답하기다.
  */
  for (let i = 0; i < 5; i++) {
    const remaining = await page.locator('[data-testid^="inbox-item-"]').count()
    if (remaining === 0) break
    await page.keyboard.press('Enter')
    await page.getByTestId('prompt-input').fill('이어서 해줘')
    await page.getByTestId('prompt-input').press('Enter')
    await page.keyboard.press('Meta+i')
  }
  await expect(page.getByTestId('inbox-empty')).toContainText('Nothing waiting')
})

test('다음 대기로 이동 단축키는 승인부터 순회한다 (T5-5, FR-17)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '응답대기 세션')
  await newSession(page, 'alpha', '승인대기 세션')
  await emitEvent(page, 0, { type: 'turn_complete' })
  await injectApproval(page, 1, { kind: 'command', command: 'x', cwd: '/tmp' })

  // 응답대기 세션에서 출발해도 순회는 긴급도 순서(승인 먼저)를 따른다
  const firstId = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...(m as any).sessions.values()][0].id
  })
  await page.getByTestId(`session-row-${firstId}`).click()
  await expect(page.getByTestId('session-name')).toContainText('응답대기 세션')

  await page.locator('body').click()
  await page.keyboard.press('Meta+Shift+a')
  await expect(page.getByTestId('session-name')).toContainText('승인대기 세션')
})

test('안읽음 표시와 읽음 처리 (T5-6, FR-16)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A작업')
  await newSession(page, 'beta', 'B작업') // 포커스 = beta

  /*
    안읽음의 화면 표현은 **이름 밝기 하나다** (점은 지웠다 — 같은 사실을 상태 링·이름과
    세 번째로 말하는 표식이었다). 테스트는 색 클래스가 아니라 줄의 data-unread를 본다.
  */
  // 비포커스 세션에 새 내용 → 안읽음
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: '결과입니다' })
  const sessionId = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...(m as any).sessions.values()][0].id
  })
  const row = page.getByTestId(`session-row-${sessionId}`)
  await expect(row).toHaveAttribute('data-unread', 'true')

  // 포커스하면 읽음 처리 (3초 규칙)
  await row.click()
  await expect(row).not.toHaveAttribute('data-unread', 'true', { timeout: 8000 })

  /*
    **보고 있는 줄은 애초에 안읽음으로 그리지 않는다.**

    "내가 딴 데 있는 동안 움직였다"가 뜻이므로 눈앞의 대화에 붙으면 소음이다.
    그리고 실제로 붙어 있었다 — 읽음 처리 타이머가 session 객체에 매여 있어서 턴이
    도는 내내 3초를 못 채웠다 (도그푸딩: "세션 돌아갈 때 하얀 점").

    시간 제한이 그 3초 **아래**여야 한다. 기본값(5초)으로 두면 읽음 타이머가 표식을
    먼저 끄고 폴링이 그 뒤를 잡아 통과해 버린다 — 실제로 고치기 전 코드에서 통과했다.
    묻는 것은 "잠깐이라도 켜졌나"이므로 그 3초 안에 본다.
  */
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: '보는 중에 더 왔다' })
  await expect(row).not.toHaveAttribute('data-unread', 'true', { timeout: 1000 })
})

test('동시 세션 경고를 사이드바에 표시한다 (T5-6, FR-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '1번')
  await expect(page.getByTestId('concurrent-alpha')).toBeHidden()
  await newSession(page, 'alpha', '2번')

  // 데이터 유실 위험은 툴팁 뒤로 숨기지 않는다 — 이름 줄에 표식이 남는다 (FR-2)
  await expect(page.getByTestId('concurrent-alpha')).toContainText('2')
  // 무엇이 위험한지는 물어보면 답한다
  await page.getByTestId('project-header-alpha').hover()
  await expect(page.getByTestId('concurrent-detail')).toContainText('lose')
})

test('컨텍스트 게이지와 한도 표시 (FR-14, FR-9)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')

  /*
   * 한 턴도 끝나지 않은 세션은 값이 **없다** — 도구는 턴 끝에 한 번 답한다.
   * '모름'과 '0%'는 다른 말이므로 다르게 보여야 한다: 값이 없는데 0%로 그리면
   * "아직 하나도 안 썼다"는 거짓말이 된다.
   */
  await expect(page.getByTestId('context-gauge')).toContainText('—')
  await emitEvent(page, 0, { type: 'context_update', used: 0, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('0%')

  await emitEvent(page, 0, { type: 'context_update', used: 168000, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('84%')

  await emitEvent(page, 0, { type: 'limit_reached', usedPercent: 21, windowMins: 10080 })
  await expect(page.getByTestId('limit-badge')).toContainText('21%')
})

/**
 * 컨텍스트 눈금이 재시작 뒤 비어 있었다 (이슈 #48).
 *
 * 읽은 값은 처음부터 옳았다 — 아무도 적어두지 않았을 뿐이라, 다시 켜면 그 세션이
 * **다시 한 턴을 돌기 전까지** 눈금이 비어 있었다. 화면에는 고장 난 계기로 보였다.
 *
 * 저장은 host의 몫이고 그쪽은 store·manager 테스트가 지킨다. 여기서 지키는 것은 그다음
 * 한 칸이다: 목록에 실려 온 값이 **화면까지 도착하는가**. #37이 정확히 이 한 칸에서
 * 끊겼다 — attach가 목록에서 강도만 집어 오고 나머지는 기본값으로 채웠고, 그래서 DB에는
 * 멀쩡히 있는 값이 화면에서만 사라졌다. 적어두고도 아무도 안 읽으면 같은 버그다.
 */
test('앱을 다시 켜도 컨텍스트 눈금이 채워져 있다 (#48)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  await emitEvent(page, 0, { type: 'context_update', used: 168000, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('84%')

  // 앱을 다시 켠 것과 같다: 스토어가 목록을 받아 세션 요약을 처음부터 다시 세운다
  await page.evaluate(async () => {
    const w = window as any
    await w.__store.getState().attach(w.__mock)
  })

  await expect(page.getByTestId('context-gauge')).toContainText('84%')
  // 낡았을지 모른다는 표는 붙이지 않는다 — 눈금은 한 번도 '지금'을 약속한 적이 없다.
  // 값은 늘 마지막으로 끝난 턴의 것이고, 재시작은 그 간격을 늘릴 뿐이다.
  await expect(page.getByTestId('context-gauge')).toHaveText('Context 84%')
})

test('메시지 전송 직후에도 인박스 단축키가 동작한다 (회귀: 입력창이 키를 먹던 문제)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업 하나')
  await newSession(page, 'alpha', '작업 둘')
  for (const idx of [0, 1]) await emitEvent(page, idx, { type: 'turn_complete' })

  // 실제 사용 순서: 메시지를 보내면 입력창에 포커스가 남는다. body를 클릭하지 않는다.
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(2)

  // 커서 이동 키가 본문에 타이핑되면 안 된다
  await page.keyboard.press('j')
  await expect(page.getByTestId('prompt-input')).toHaveValue('')

  /*
    그리고 `d`에는 **아무것도 없어야 한다.** 예전에는 이 키가 세션을 아카이브했고,
    화면에는 "Dismiss"라고 적혀 있었다 — 대답을 안 하겠다는 뜻으로 누른 키가 세션을
    목록에서 영영 지웠다. 한 글자 뒤에 되돌릴 수 없는 일을 숨겨두지 않는다.
  */
  await page.keyboard.press('d')
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(2)
  await expect(page.getByTestId('prompt-input')).toHaveValue('')
})

test('전송 실패를 조용히 삼키지 않는다 (회귀: 세션이 죽었는데 기다리게 되던 문제)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 세션이 사라진 상황을 만든다 (host 재시작 후 복원된 세션과 같은 상태)
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    m.sessions.delete(id)
  })

  await page.getByTestId('prompt-input').fill('계속 진행해줘')
  await page.getByTestId('send').click()

  await expect(page.getByTestId('toast')).toContainText('Could not send')
  // 보내지 못한 말풍선은 남지 않는다
  await expect(page.getByTestId('msg-user').filter({ hasText: '계속 진행해줘' })).toHaveCount(0)
})

test('잠든 세션은 말을 걸면 알아서 이어진다 (C-1, FR-10)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // host 재시작 후 상태를 흉내낸다: 프로세스는 없고 기록만 남은 세션
  await page.evaluate(() => {
    const m = (window as any).__mock
    const store = (window as any).__store
    const st = store.getState()
    const id = st.focusedSessionId
    m.sessions.get(id).live = false
    store.setState({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], live: false } } })
  })

  // 막지 않는다. 잠들어 있다는 사실만 알리고 입력은 그대로 열려 있다
  await expect(page.getByTestId('dormant-note')).toBeVisible()
  await expect(page.getByTestId('prompt-input')).toBeEnabled()

  await page.getByTestId('prompt-input').fill('이어서 해줘')
  await page.getByTestId('send').click()

  // 이어가기 버튼을 누른 적이 없는데 대화가 이어진다
  await expect(page.getByTestId('chat-stream')).toContainText('이어서 해줘')
  await expect(page.getByTestId('dormant-note')).toBeHidden()
})

test('정말 이어갈 수 없으면 이유를 알린다 (조용한 실패 금지)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  await page.evaluate(() => {
    const m = (window as any).__mock
    const store = (window as any).__store
    const st = store.getState()
    const id = st.focusedSessionId
    m.unresumable.add(id) // 재개 불가로 표시
    m.sessions.get(id).live = false
    store.setState({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], live: false } } })
  })

  await page.getByTestId('prompt-input').fill('이어서 해줘')
  await page.getByTestId('send').click()

  await expect(page.getByTestId('toast')).toContainText('Could not resume')
  // 보내지 못한 말풍선은 남지 않는다
  await expect(page.getByTestId('msg-user').filter({ hasText: '이어서 해줘' })).toHaveCount(0)
})

test('긴 대화는 보이는 것만 그린다 (D-1 가상 스크롤)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '긴 작업')

  // 200턴 분량 주입
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    for (let i = 0; i < 200; i++) {
      m.emit({
        type: 'message_delta',
        sessionId: id,
        role: 'assistant',
        text: `줄 ${i} — 대화 내용입니다.\n`,
      })
      m.emit({ type: 'turn_complete', sessionId: id })
    }
  })

  // DOM에 200개가 다 그려지면 가상화가 안 된 것이다
  const rendered = await page.locator('[data-testid="chat-stream"] [data-index]').count()
  expect(rendered).toBeGreaterThan(0)
  expect(rendered).toBeLessThan(60)
})

test('위로 올려 읽는 중에는 자동 스크롤이 방해하지 않는다 (D-1)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // 세션을 만들기 **전에** 주입하면 존재하지 않는 세션으로 흘러가 화면에는 아무것도
  // 쌓이지 않는다 — 스크롤할 거리가 없어 시험이 헛돌았다. 만든 뒤에 채운다.
  await newSession(page, 'alpha', '긴 작업')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    // 연속 델타는 한 assistant 말풍선으로 합쳐지고, 홑 개행은 마크다운이 한 문단으로
    // 접는다 — 빈 줄로 문단을 끊어야 실제로 화면이 길어진다
    for (let i = 0; i < 100; i++)
      m.emit({
        type: 'message_delta',
        sessionId: id,
        role: 'assistant',
        text: `줄 ${i} — 대화 내용입니다.\n\n`,
      })
  })

  const stream = page.getByTestId('chat-stream')
  // "위로 올렸다"가 성립하려면 바닥 슬랙(scroll.ts BOTTOM_SLACK=80px)보다 훨씬 큰
  // 스크롤 범위가 필요하다 — 안 그러면 맨 위도 "바닥 근처"라 따라가는 게 정답이 되고,
  // 범위가 0이면 scrollTop이 늘 0이라 통과가 무의미하다
  await expect.poll(() => stream.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(400)
  await stream.evaluate((el) => {
    el.scrollTop = 0
  }) // 맨 위로 올려 읽는 중
  // 가상 스크롤은 올려놓은 직후 항목 실측으로 위치를 살짝 고칠 수 있다 —
  // 그 보정이 끝나 자리가 멈춘 뒤의 값을 기준으로 삼아야 "새 메시지 때문"만 잰다
  await expect
    .poll(async () => {
      const now = await stream.evaluate((el) => el.scrollTop)
      await page.waitForTimeout(120)
      return (await stream.evaluate((el) => el.scrollTop)) === now
    })
    .toBe(true)
  const before = await stream.evaluate((el) => el.scrollTop)

  // 새 메시지가 도착해도 끌어내리지 않는다
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: '새 줄\n' })
  })
  await page.waitForTimeout(300)
  expect(await stream.evaluate((el) => el.scrollTop)).toBe(before)
})

test('소개 화면: 카드가 곧 도구 감지 표시다 — 안 깔림과 로그인 안 됨은 처방이 다르다 (E-1)', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.agents.detect = async () => [
      { tool: 'claude', installed: false, loggedIn: false, detail: 'not installed' },
      { tool: 'codex', installed: true, loggedIn: false, detail: 'codex-cli 0.147' },
    ]
  })
  await page.getByTestId('redetect').click()
  // 진단은 한눈에 — 비활성 카드는 "Not connected"라고 말한다 (어둡고, 눌리지 않는다)
  await expect(page.getByTestId('intro-card-claude-status')).toContainText('Not connected')
  await expect(page.getByTestId('intro-card-claude')).toBeDisabled()
  // 처방은 상태별로: 안 깔림 → 설치 명령, 로그인 안 됨 → 로그인 명령
  await expect(page.getByTestId('intro-card-claude')).toContainText('npm i -g @anthropic-ai/claude-code')
  await expect(page.getByTestId('intro-card-codex')).toContainText('codex login')
  await expect(page.getByTestId('intro-card-codex')).not.toContainText('npm i -g')
  // 둘 다 못 쓰니 이때는 정말로 막힌 것이 맞다
  await expect(page.getByTestId('intro-blocked')).toBeVisible()
})

test('소개 화면: 하나만 준비돼 있으면 막지 않는다 — 그 카드로 지나간다 (#11)', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.agents.detect = async () => [
      { tool: 'claude', installed: true, loggedIn: false, detail: '2.1.223 · login required' },
      { tool: 'codex', installed: true, loggedIn: true, detail: 'codex-cli 0.147' },
    ]
  })
  await page.getByTestId('redetect').click()
  // 로그인 안 된 claude에게 시킬 일은 '설치'가 아니라 '로그인'이다
  await expect(page.getByTestId('intro-card-claude')).toContainText('claude auth login')
  await expect(page.getByTestId('intro-card-claude')).not.toContainText('npm i -g')
  await expect(page.getByTestId('intro-card-claude')).toBeDisabled()
  await expect(page.getByTestId('intro-blocked')).toHaveCount(0)
  // 준비된 카드는 살아 있다 — 클릭하면 앱으로 들어간다
  await page.getByTestId('intro-card-codex').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
})

test('보던 세션으로 돌아온다 (C-3 워크스페이스 스냅샷)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '첫 번째')
  await newSession(page, 'alpha', '두 번째')

  // 첫 번째 세션을 보다가 앱을 껐다고 하자
  const firstId = await page.evaluate(() => {
    const store = (window as any).__store
    const ids = Object.keys(store.getState().sessions)
    store.getState().focusSession(ids[0])
    return ids[0]
  })
  const snapshot = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snapshot?.focusedSessionId).toBe(firstId)

  // 다시 attach하면 (앱 재시작) 그 세션이 열려 있다
  await page.evaluate(async () => {
    const store = (window as any).__store
    const m = (window as any).__mock
    store.setState({ focusedSessionId: null })
    await store.getState().attach(m)
  })
  await expect(page.getByTestId('session-name')).toContainText('첫 번째')
})

test('비포커스 세션의 메시지는 잘라낸다 (D-2 윈도잉)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '긴 세션')
  await newSession(page, 'alpha', '다른 세션')

  const longId: string = (
    await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))
  )[0]!
  await page.evaluate((id) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    store.getState().focusSession(id)
    // 델타는 한 메시지로 합쳐지므로, 항목이 실제로 늘어나는 도구 호출로 채운다
    for (let i = 0; i < 300; i++) {
      m.emit({
        type: 'tool_call',
        sessionId: id,
        callId: `c${i}`,
        summary: { tool: 'Read', title: `파일 ${i}`, readOnly: true, paths: [] },
      })
    }
  }, longId)

  const before = await page.evaluate((id) => (window as any).__store.getState().chat[id].length, longId)
  expect(before).toBeGreaterThan(100)

  // 다른 세션으로 옮기면 메모리에서 잘린다
  await page.evaluate(() => {
    const store = (window as any).__store
    const ids = Object.keys(store.getState().sessions)
    store.getState().focusSession(ids[1])
  })
  const after = await page.evaluate((id) => (window as any).__store.getState().chat[id].length, longId)
  expect(after).toBeLessThanOrEqual(50)
})

test('인박스 10건을 위아래로 훑어도 커서가 목록 밖으로 나가지 않는다 (L4-3 반복 조작)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  for (let i = 0; i < 10; i++) await newSession(page, 'alpha', `작업 ${i}`)
  await page.evaluate(() => {
    const m = (window as any).__mock
    for (const id of m.sessions.keys()) m.emit({ type: 'turn_complete', sessionId: id })
  })

  await page.keyboard.press('Meta+i')
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(10)

  /*
    키보드만으로 끝까지 내려갔다 올라온다. 커서가 목록 밖을 가리키면 Enter가 아무
    세션도 열지 못하고, 그 순간 인박스는 눌러도 안 되는 창이 된다.
    (예전에는 `d`로 항목을 지워가며 이걸 확인했다 — 그 키는 세션을 아카이브했고,
     아카이브는 폐기됐다. 커서가 지켜야 할 것은 그대로다.)
  */
  for (let i = 0; i < 15; i++) await page.keyboard.press('j')
  for (let i = 0; i < 15; i++) await page.keyboard.press('k')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('inbox')).toBeHidden()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

test('좁은 창에서도 레이아웃이 깨지지 않는다 (L4-4)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 })
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 가로 스크롤이 생기면 무언가 넘친 것이다
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

/**
 * 메뉴는 **자기를 부른 버튼 옆에** 뜬다.
 *
 * 예전에는 사이드바 우상단 한 자리에 고정이었다 (positioned 조상이 없어 좌표가 사이드바
 * 기준으로 풀렸다) — 열 번째 프로젝트를 눌렀는데 답이 맨 위에서 나오니, 무엇에 대한
 * 메뉴인지 화면이 말해 주지 않았다. 아래에 자리가 없으면 위로 뒤집는다.
 */
test('프로젝트 메뉴는 누른 버튼 아래에 뜨고, 자리가 없으면 위로 뒤집는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })

  const geometry = async (name: string) => {
    await page.getByTestId(`project-header-${name}`).hover()
    await page.getByTestId(`project-menu-${name}`).click()
    const menu = page.getByTestId(`project-menu-open-${name}`)
    await expect(menu).toBeVisible()
    const b = (await page.getByTestId(`project-menu-${name}`).boundingBox())!
    const m = (await menu.boundingBox())!
    const viewport = page.viewportSize()!
    await page.keyboard.press('Escape')
    return { b, m, viewport }
  }

  const alpha = await geometry('alpha')
  // 버튼 아래에, 버튼의 오른쪽 끝에 맞춰서
  expect(alpha.m.y).toBeGreaterThanOrEqual(alpha.b.y + alpha.b.height)
  expect(Math.round(alpha.m.x + alpha.m.width)).toBe(Math.round(alpha.b.x + alpha.b.width))
  // 그리고 화면 안에 온전히 들어온다
  expect(alpha.m.y + alpha.m.height).toBeLessThanOrEqual(alpha.viewport.height)

  /*
    **확대에서도.** 잰 좌표(확대가 곱해진 화면 px)를 fixed 길이(그릴 때 확대가 또
    곱해진다)에 그대로 쓰면, 확대 1.1에서 메뉴가 버튼보다 24px 아래·103px 왼쪽에
    떴다 (실측 — 도그푸딩 "메뉴 위치가 이상해"). 확대 1.0만 재는 테스트는 이 부류를
    통째로 놓친다. 사용자의 실제 설정이 1.1이다.
  */
  await page.evaluate(() => {
    const style = document.documentElement.style as CSSStyleDeclaration & { zoom: string }
    style.zoom = '1.1'
    style.setProperty('--text-zoom', '1.1')
  })
  const zoomed = await geometry('alpha')
  const gap = zoomed.m.y - (zoomed.b.y + zoomed.b.height)
  expect(gap).toBeGreaterThanOrEqual(2)
  expect(gap).toBeLessThanOrEqual(8) // 확대가 두 번 곱해지면 여기가 24를 넘는다
  expect(Math.abs(zoomed.m.x + zoomed.m.width - (zoomed.b.x + zoomed.b.width))).toBeLessThanOrEqual(2)
  await page.evaluate(() => {
    const style = document.documentElement.style as CSSStyleDeclaration & { zoom: string }
    style.zoom = '1'
    style.setProperty('--text-zoom', '1')
  })

  /*
    아래로 펴면 넘치는 자리에서만 뒤집기가 보이고, 그 자리는 창을 낮춰야 생긴다.
    320px에서는 아직 들어갔다(메뉴 바닥 307.5 < 312) — 뒤집기가 아니라 실측이
    기준을 정한다.
  */
  await page.setViewportSize({ width: 1200, height: 240 })
  const beta = await geometry('beta')
  expect(beta.m.y + beta.m.height).toBeLessThanOrEqual(beta.b.y) // 버튼 위로 갔다
  expect(beta.m.y).toBeGreaterThanOrEqual(0)
})

/*
 * 좁은 사이드바 (도그푸딩: 사이드바를 줄이면 메뉴가 창 왼쪽 밖으로 나가 안 보였다).
 * 메뉴는 버튼의 오른쪽 끝에 맞춰 왼쪽으로 펼쳐지는데, 버튼이 창 왼쪽 근처면
 * 메뉴 폭(192px)이 최소 사이드바(180px)보다 넓어 왼쪽이 잘린다 — 세션 메뉴도
 * 같은 껍데기(RowMenu)를 쓰므로 한쪽만 재면 둘 다 잰 것이다.
 */
test('사이드바가 좁아도 줄 메뉴는 화면 안에 온전히 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '좁은 데서')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate(() => (window as any).__store.getState().setSidebarWidth(0)) // 최소로 접힌다

  await page.getByTestId('project-menu-alpha').click()
  const pm = (await page.getByTestId('project-menu-open-alpha').boundingBox())!
  expect(pm.x).toBeGreaterThanOrEqual(0)
  await page.keyboard.press('Escape')

  await page.getByTestId(`session-menu-${id}`).click()
  const sm = (await page.getByTestId(`session-menu-open-${id}`).boundingBox())!
  expect(sm.x).toBeGreaterThanOrEqual(0)
})

test('세션 생성: 도구만 고른다 — 모델·권한은 만든 뒤 헤더에서 (M2.5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  // 다이얼로그는 도구와 이어가기만 고른다 — 모델 입력도, 프롬프트 칸도 없다 (#8)
  await expect(page.getByTestId('model-input')).toHaveCount(0)
  await expect(page.getByTestId('initial-prompt')).toHaveCount(0)
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params).toMatchObject({ tool: 'claude' })
  expect(params.initialPrompt).toBeUndefined()

  // 첫 지시는 입력창에서 — 화면에 그대로 남는다
  await page.getByTestId('prompt-input').fill('첫 지시')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('msg-user')).toContainText('첫 지시')

  // 모델·권한은 입력창 아래 설정 메뉴에서 바꾼다
  await pickSetting(page, 'settings-model-haiku')
  await expect(page.getByTestId('toast')).toContainText('haiku')
  await pickSetting(page, 'settings-preset-safe')
  const sessions = await page.evaluate(() => [...(window as any).__mock.sessions.values()])
  expect(sessions[0]).toMatchObject({ model: 'haiku', permissionPreset: 'safe' })
})

test('도구를 못 쓰면 이유를 보여준다 (M2.5: 시작 버튼이 아무 반응 없던 문제)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.agents.detect = async () => [
      { tool: 'claude', installed: false, loggedIn: false, detail: 'claude CLI not found' },
      { tool: 'codex', installed: true, loggedIn: true, detail: 'codex 0.147' },
    ]
  })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  // 쓸 수 있는 쪽이 하나라도 있으면 그쪽으로 열어 준다 (#11) — 벽부터 세우지 않는다
  await expect(page.getByTestId('create-session-confirm')).toBeEnabled()
  await expect(page.getByTestId('tool-blocked')).toHaveCount(0)

  // 그래도 못 쓰는 쪽을 직접 고르면 이유를 적는다 —
  // 버튼만 죽어 있으면 '아무 동작 안 함'으로 보인다
  await page.getByTestId('tool-option-claude').click()
  await expect(page.getByTestId('tool-blocked')).toContainText('not found')
  await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
  // 쓸 수 있는 도구로 바꾸면 즉시 풀린다
  await page.getByTestId('tool-option-codex').click()
  await expect(page.getByTestId('create-session-confirm')).toBeEnabled()
})

test('로그인 안 된 도구는 설치 안 된 도구와 다르게 말한다 (#11)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.agents.detect = async () => [
      // #11 이전에는 claude가 이 상태로 잡히지 않아 이 분기에 닿을 수 없었다
      { tool: 'claude', installed: true, loggedIn: false, detail: 'claude 2.1.223 · login required' },
      { tool: 'codex', installed: false, loggedIn: false, detail: 'codex CLI not found' },
    ]
  })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  // 둘 다 못 쓰니 옮겨 앉을 곳이 없다 — 대신 claude에게 시킬 일을 정확히 적는다
  await expect(page.getByTestId('tool-blocked')).toContainText('needs a login')
  await expect(page.getByTestId('tool-blocked')).toContainText('claude auth login')
  await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
})

test('에이전트 응답이 마크다운으로 렌더된다 (M2.5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await emitEvent(page, 0, {
    type: 'message_delta',
    role: 'assistant',
    text: '## 결과\n\n- **중요** 항목\n- `코드` 조각\n\n```ts\nconst x = 1\n```',
  })
  const md = page.getByTestId('markdown')
  await expect(md.locator('h2')).toContainText('결과')
  await expect(md.locator('strong')).toContainText('중요')
  await expect(md.locator('pre code')).toContainText('const x = 1')
})

test('세션 생성 다이얼로그가 동시 세션을 경고한다 (FR-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '먼저 시작한 작업')
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('concurrent-warning')).toContainText('lose')
})

test('3레인: 증거 패널은 대화와 함께 있고 ⌘B로 접힌다 (B-0)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 깃·파일은 대화를 대신하지 않는다 — 둘이 동시에 보여야 한다
  await expect(page.getByTestId('chat-stream')).toBeVisible()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
  await expect(page.getByTestId('evidence-project')).toContainText('alpha')

  await page.keyboard.press('Meta+b')
  await expect(page.getByTestId('evidence-panel')).toBeHidden()
  // 패널을 접어도 대화는 그대로다
  await expect(page.getByTestId('chat-stream')).toBeVisible()

  // 접힌 상태가 스냅샷에 실리고 재시작 후 복원된다
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelOpen).toBe(false)

  await page.keyboard.press('Meta+b')
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

test('깃 패널: 변경 목록·diff·스테이징·커밋 (B-2, B-6)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/new.ts', staged: false, status: '?' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1,2 +1,2 @@\n-옛 줄\n+새 줄\n 그대로'
  })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-git-full').click()

  await page.getByTestId('git-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  // 무채색 diff: 색이 아니라 기호와 밝기로 구분한다
  await expect(page.locator('[data-diff="add"]')).toContainText('새 줄')
  await expect(page.locator('[data-diff="del"]')).toContainText('옛 줄')

  await page.getByTestId('git-stage-all').click()
  await page.getByTestId('commit-message').fill('테스트 커밋')
  await page.getByTestId('commit-button').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('테스트 커밋')
})

test('깃 패널: 복사한 diff는 그 diff 그대로다 (#36)', async ({ page }) => {
  const diff =
    '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-const old = 1\n+const next = 1\n   indented\n unchanged'
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate((d) => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = d
  }, diff)
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-git-full').click()
  await page.getByTestId('git-file-src/a.ts').click()
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
  await page.keyboard.press('Meta+c')

  // Whatever it looks like on screen, what comes off it is a diff you can apply: ASCII
  // markers rather than the typographic −, and indentation the DOM had already collapsed
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(diff)

  // The file header used to lose a dash to the marker-stripping, on screen too
  await expect(page.getByTestId('diff-view')).toContainText('--- a/src/a.ts')
})

test('깃 패널: 더티 상태 체크아웃은 막지 않고 결과를 먼저 보여준다 (B-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'feature/x', current: false, remote: false },
    ]
    m.gitState.dirty = ['src/a.ts']
  })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-branch').click()
  await page.getByTestId('branch-feature/x').click()

  await expect(page.getByTestId('checkout-warning')).toContainText('src/a.ts')
  await page.getByTestId('checkout-proceed').click()
  await expect(page.getByTestId('toast')).toContainText('Switched')
})

test('git 저장소가 아니면 깃 탭이 비활성 (B-1 비정상 경로)', async ({ page }) => {
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

test('파일 트리: lazy 로드 + 무시된 항목 토글 (C-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'src', path: 'src', isDir: true, ignored: false },
      { name: 'node_modules', path: 'node_modules', isDir: true, ignored: true },
      { name: 'README.md', path: 'README.md', isDir: false, ignored: false },
    ]
    m.fsState.entries['src'] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
    m.fsState.files['src/a.ts'] = '첫 줄\n둘째 줄\n셋째 줄'
  })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-tree')).toBeVisible()

  /*
    무시된 항목도 **기본으로 보인다** (이슈 #17). 숨겨 두면 걸러진 것으로 읽히지 않고
    없는 것으로 읽힌다 — 정작 열어보려던 파일이 추적되지 않는 파일인 경우가 잦다.
    끄면 사라지고, 그 선택은 남는다 (아래 시험이 그 쪽을 지킨다).
  */
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()
  await page.getByTestId('toggle-ignored').uncheck()
  await expect(page.getByTestId('dir-node_modules')).toBeHidden()
  await page.getByTestId('toggle-ignored').check()
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()

  // 하위는 열어야 읽는다 (lazy)
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

  // Shown without being asked for — and still ignored: slate says "the repo does not
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

test('코드 뷰어: 파일 열기·검색·큰 파일 (C-3, FR-6)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'big.ts', path: 'big.ts', isDir: false, ignored: false }]
    m.fsState.files['big.ts'] = Array.from({ length: 3000 }, (_, i) => `줄 ${i} 내용`).join('\n')
  })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-big.ts').click()

  // 파일을 열면 넓은 오버레이가 덮인다
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('big.ts')

  // 3000줄이어도 보이는 것만 그린다 (가상 스크롤)
  const rendered = await page.locator('[data-testid="code-viewer"] .whitespace-pre').count()
  expect(rendered).toBeLessThan(120)

  await page.getByTestId('viewer-search').fill('줄 42 ')
  await expect(page.getByTestId('viewer-match-count')).toContainText('1 line')
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
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
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
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-big.ts').click()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

test('뷰어 복사: ⌘A는 파일 전체를 준다 (#36)', async ({ page }) => {
  await openBigFile(page, 3000)

  // Nobody clicked anything: the code area takes focus when the file opens, which is what
  // gives ⌘A somewhere to land.
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+c')

  const copied = await clipboard(page)
  expect(copied.split('\n')).toHaveLength(3000)
  expect(copied.startsWith('const line0 = 0\nconst line1 = 1')).toBe(true)
  expect(copied.endsWith('const line2999 = 2999')).toBe(true)
})

test('뷰어 복사: 안 그려진 줄까지 이어서 복사한다 (#36)', async ({ page }) => {
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
  await page.keyboard.press('Meta+c')

  const rows = (await clipboard(page)).split('\n')
  // Hundreds of the lines in between were never in the DOM to be copied from
  expect(rows.length).toBeGreaterThan(300)
  expect(rows[0]).toBe('const line3 = 3')
  expect(rows[1]).toBe('const line4 = 4')
  // …the run has no gaps, and no line number rode along with any of it
  expect(rows.map((r, i) => r === `const line${i + 3} = ${i + 3}`).every(Boolean)).toBe(true)
})

test('뷰어 복사: 잘린 파일은 잘렸다고 말한다 (#36)', async ({ page }) => {
  await openBigFile(page, 200, { truncated: true })

  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+c')

  // Select-all claims "this is the file". When it is not, the clipboard says the same thing
  // the screen says rather than handing over half a file that looks whole.
  const copied = await clipboard(page)
  expect(copied).toContain('const line199 = 199')
  expect(copied.endsWith('…file is large; showing part of it. Open in your IDE to see the rest.')).toBe(true)
})

test('뷰어 복사: 검색창의 ⌘A는 그대로다 (#36)', async ({ page }) => {
  await openBigFile(page, 100)

  // The handler is the code area's, not the window's — select-all inside a text field has
  // to keep meaning select-all inside that field.
  const search = page.getByTestId('viewer-search')
  await search.fill('line1')
  await search.press('Meta+a')
  await search.type('line2')
  await expect(search).toHaveValue('line2')
})

test('뷰어: 바이너리 파일은 안내만 한다 (C-3 비정상 경로)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'logo.png', path: 'logo.png', isDir: false, ignored: false }]
    m.fs.readFile = async () => ({ text: '', truncated: false, binary: true, bytes: 20480 })
  })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-logo.png').click()
  await expect(page.getByTestId('viewer-binary')).toContainText('Binary')
})

test('첨부: 파일을 붙이면 목록에 뜨고 전송에 실린다 (D, FR-13)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  await page.getByTestId('attach-input').setInputFiles({
    name: 'screenshot.png',
    mimeType: 'image/png',
    buffer: Buffer.from('가짜 이미지 데이터'),
  })
  await expect(page.getByTestId('attachment-list')).toContainText('screenshot.png')

  await page.getByTestId('prompt-input').fill('이 화면 좀 봐줘')
  await page.getByTestId('send').click()

  const sent = await page.evaluate(() => (window as any).__mock.sentAttachments)
  expect(sent).toHaveLength(1)
  expect(sent[0].name).toBe('screenshot.png')
  // 대화창에도 첨부가 표시된다
  await expect(page.getByTestId('msg-user').last()).toContainText('screenshot.png')
})

test('첨부만으로도 보낼 수 있다 (D 비정상 경로: 빈 텍스트)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await expect(page.getByTestId('send')).toBeDisabled()
  await page.getByTestId('attach-input').setInputFiles({
    name: 'a.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.getByTestId('send')).toBeEnabled()
})

test('커맨드 팔레트 ⌘K: 세션·대화 내용을 함께 찾는다 (E-2, FR-21)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'auth 리팩터링')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const ids = [...m.sessions.keys()]
    m.searchResults = [{ sessionId: ids[0], seq: 3, snippet: '토큰 만료 처리를 고쳤습니다' }]
  })
  await newSession(page, 'alpha', '배포 스크립트')

  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()

  await page.getByTestId('palette-input').fill('토큰')
  await expect(page.getByTestId('palette-item-message')).toContainText('토큰 만료')

  await page.getByTestId('palette-item-message').click()
  await expect(page.getByTestId('session-name')).toContainText('auth 리팩터링')
})

/**
 * 상단 바는 계기판이다 — 지시문이 아니라 상태를 말한다 (이슈 #33).
 *
 * ⌘I·⌘⇧A 칩이 대기 숫자 옆에 서서 숫자와 **같은 조건으로** 밝아졌다. 뭔가 나를
 * 기다리는 순간, 즉 바가 할 말이 생기는 유일한 순간에, 밝아지는 것 셋 중 둘이
 * "이 키를 누르세요"였다는 뜻이다.
 *
 * 없앤 것은 **표시**뿐이라 그 둘을 함께 본다: 신호는 숫자가 그대로 맡고, 키는 여전히
 * 듣고, 이름과 키는 팔레트에서 찾을 수 있다 — 유일하게 보이던 언급을 지우는 것이
 * 피해야 할 실패였다.
 */
test('상단 바: 단축키 칩 대신 숫자가 신호다 (#33)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A')
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })

  // 대기가 있어도 바는 키를 광고하지 않는다 — 예전엔 바로 이때 칩이 가장 밝았다
  const bar = page.getByTestId('app-header')
  await expect(bar).toContainText('Approvals')
  await expect(bar).not.toContainText('Next item')
  await expect(bar).not.toContainText('List')

  // 밝아지는 일은 숫자가 계속 맡는다 (승인 대기 = 순백)
  await expect(page.getByTestId('count-approval')).toContainText('01')
  await expect(page.getByTestId('count-approval')).toHaveClass(/beacon/)

  // 키 자체는 그대로 듣는다 (FR-17은 안 건드렸다)
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inbox')).toBeHidden()

  // 이름과 키는 팔레트가 말한다
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('waiting')
  const actions = page.getByTestId('palette-item-action')
  await expect(actions.filter({ hasText: 'Waiting list' })).toContainText('⌘I')
  await expect(actions.filter({ hasText: 'Jump to next waiting' })).toContainText('⌘⇧A')

  // 키를 모르는 사람은 여기서 그대로 실행한다
  await actions.filter({ hasText: 'Waiting list' }).click()
  await expect(page.getByTestId('inbox')).toBeVisible()
})

/*
 * 글자 크기(zoom)와 vh의 관계 (도그푸딩: "글자 크기 키우면 세션의 입력창이 안 보이거든").
 * vh는 zoom의 영향을 안 받아서, 확대하면 100vh 셸이 창보다 커져 맨 아래(입력창)가
 * 창 밖으로 밀렸다. 셸을 % 사슬로 바꾼 뒤에는 어느 단계에서든 입력창이 창 안에 있다.
 */
test('설정: 글자 크기를 최대로 키워도 입력창이 창 안에 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-scale-4').click()
  await page.keyboard.press('Escape')

  /*
   * 한 번 재서 단언하면 배율 적용 직후의 레이아웃 정착과 경합한다 — 전체 스위트의
   * 병렬 부하에서만 간헐적으로 몇 픽셀 넘게 읽혔다 (솔로에서는 통과). 정착할 때까지
   * 폴링한다: 계약은 "정착한 화면에서 입력창이 창 안"이지 "첫 프레임부터"가 아니다.
   */
  const viewport = page.viewportSize()!
  const bottomEdge = async () => {
    const box = await page.getByTestId('prompt-input').boundingBox()
    return box ? box.y + box.height : Number.POSITIVE_INFINITY
  }
  await expect.poll(bottomEdge).toBeLessThanOrEqual(viewport.height + 1)
  // 되돌려도 창 안이다 — 커졌다 작아졌다 하며 자리를 잃지 않는다
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-scale-0').click()
  await page.keyboard.press('Escape')
  await expect.poll(bottomEdge).toBeLessThanOrEqual(viewport.height + 1)
})

/*
 * 그리드의 열 수는 글자 배율의 영향을 받지 않는다 (도그푸딩: "3에서는 1줄인데 4에서는
 * 2줄이야"). ResizeObserver 측정값은 zoom 좌표라, 실픽셀로 환산하지 않으면 배율을
 * 올릴수록 같은 창이 좁게 측정되어 열이 무너진다. 창 폭 1100은 (사이드바 240을 뺀
 * 그리드 860에서) 두 칸(MIN_PANEL_W=380)이 배율 1에서는 서고 zoom 좌표 그대로면
 * 1.25에서 무너지는(860/1.25=688 < 760), 결함이 갈리는 폭이다.
 */
test('설정: 글자 크기를 바꿔도 그리드 열 수는 그대로다', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 })
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '하나')
  await newSession(page, 'alpha', '둘')
  await page.evaluate(() => {
    const store = (window as never as { __store: any }).__store
    const ids = Object.keys(store.getState().sessions)
    store.getState().setGridPanels(ids)
  })
  await page.getByTestId('grid-button').click()

  // 열 수는 안쪽 display:grid 요소에 있다 — 바깥(data-testid="grid")은 flex 컨테이너다
  const colsOf = () =>
    page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector<HTMLElement>('[data-testid="grid"] div.grid')!,
        ).gridTemplateColumns.split(' ').length,
    )
  const before = await colsOf()
  expect(before).toBe(2)

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-scale-4').click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  expect(await colsOf()).toBe(2)
})

test('설정: 승인 규칙을 보고 지운다 (E-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.rulesList = [
      { id: 1, scope: 'session', matcher: 'npm test*', decision: 'allow', createdAt: Date.now() },
    ]
  })
  await newSession(page, 'alpha', '작업')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()

  // 규칙은 이제 Permissions 갈래에 있다 — 설정이 한 두루마리에 다 쌓이지 않는다 (이슈 #7)
  await page.getByTestId('settings-tab-permissions').click()
  await expect(page.getByTestId('rules-list')).toContainText('npm test*')
  await page.getByTestId('delete-rule-1').click()
  await expect(page.getByTestId('rules-empty')).toBeVisible()
})

test('설정: 알림 정책을 끄면 저장된다 (E-5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))

  await page.getByTestId('notify-allDone').uncheck()
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.notifyPolicy?.allDone).toBe(false)

  // 단축키 표도 여기서 확인된다 (FR-17) — Shortcuts 갈래에 있다
  await page.getByTestId('settings-tab-shortcuts').click()
  await expect(page.getByTestId('shortcut-list')).toContainText('⌘⇧1~4')
})

test('권한 거부를 "저장소 아님"과 구분해 안내한다 (F-1 실측 반영)', async ({ page }) => {
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
  // 막힌 것은 표식으로 바로 보이고, 무엇을 해야 하는지는 호버로 알려준다
  await expect(page.getByTestId('git-denied-denied')).toBeVisible()
  await page.getByTestId('project-header-denied').hover()
  await expect(page.getByTestId('git-denied')).toContainText('permission')
})

test('세션 삭제: 확인 후 목록에서 사라진다 (M2.5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '지울 세션')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  // "되돌릴 수 없습니다"는 사실이 아니다 — 무엇이 지워지고 무엇이 남는지를 말한다
  await expect(page.getByTestId('confirm-delete')).toContainText('Chat history and attachments')
  await page.getByTestId('confirm-delete-yes').click()

  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(0)
  // 기본값이 진짜 삭제다 — 도구 쪽 원본도 같이 갔다 (도그푸딩 재지적으로 기본을 뒤집었다)
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).toContain(id)
})

/*
 * 진짜 삭제 (도그푸딩): 기본 삭제는 도구 쪽 대화 원본을 남긴다("되찾을 수 있다"가
 * 안내문의 약속이다). 체크박스를 켜면 그 약속이 같은 자리에서 경고로 바뀌고,
 * 원본까지 지워진다. 안 켜면 원본은 손대지 않는다 — 양쪽 다 실측한다.
 */
test('세션 삭제: 기본은 원본까지 지운다 — 체크를 끄면 도구 쪽에 남는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '남겨둘 세션')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  // 기본: 원본까지 지운다는 경고가 서 있고 체크가 켜져 있다
  await expect(page.getByTestId('delete-external-toggle').locator('input')).toBeChecked()
  await expect(page.getByTestId('delete-external-warning')).toContainText('deleted too')
  await expect(page.getByTestId('delete-notice')).toHaveCount(0)

  // 끄면 경고가 같은 자리에서 "도구에는 남는다"로 바뀐다
  await page.getByTestId('delete-external-toggle').locator('input').uncheck()
  await expect(page.getByTestId('delete-external-warning')).toHaveCount(0)
  await expect(page.getByTestId('delete-notice')).toContainText('stays in')

  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  // 껐으니 원본은 남았다
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).not.toContain(id)
})

/*
 * 인수인계하고 새로 시작 (도그푸딩): 죽는 세션이 쓴 글이 새 세션의 첫 메시지가 되고,
 * 이름이 이어지고, 기존 세션은 원본까지 지워진다. 요청과 글은 대화에 그대로 보인다 —
 * 뒤에서 몰래 하는 단계가 없다.
 */
test('인수인계: 글을 받아 새 세션으로 갈아타고 기존 세션은 진짜로 지운다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '갈아탈 세션')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  /*
    첫 턴을 끝내 둔다 — 인수인계는 돌던 턴이 끝나기를 기다린다 (돌던 턴의 출력이
    글에 섞여 "잘린 것처럼" 읽힌 메아 실측). working 전환을 먼저 확인한다:
    종료 이벤트가 전송의 working보다 먼저 가면 영영 안 끝난 턴이 된다.
  */
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid]?.state, id))
    .toBe('working')
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'turn_complete', sessionId: sid })
    m.emit({ type: 'state_change', sessionId: sid, state: 'waiting_input' })
  }, id)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`handoff-session-${id}`).click()
  await expect(page.getByTestId('handoff-warning')).toContainText('deleted for real')
  // 받는 에이전트는 기본으로 지금 도구가 선택돼 있고, 삭제는 기본으로 켜져 있다
  await expect(page.getByTestId('handoff-tool-claude')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-delete-toggle').locator('input')).toBeChecked()
  await page.getByTestId('confirm-handoff-yes').click()

  // 인수인계 요청이 대화에 보통 메시지로 들어간다
  await expect(page.getByTestId('chat-stream')).toContainText('handoff note')

  // 죽는 세션이 글을 **파일로** 남긴다 (mock에는 모델이 없으니 손으로 흉내낸다)
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.fsState.files['.centralu-handoff.md'] = '후계자 노트: 여기까지 했다'
    m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: '파일에 남겼습니다.' })
    m.emit({ type: 'turn_complete', sessionId: sid })
    m.emit({ type: 'state_change', sessionId: sid, state: 'waiting_input' })
  }, id)

  // 새 세션이 이름을 물려받아 서고, 기존 세션은 원본까지 사라졌다
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0, { timeout: 15_000 })
  const heirId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  await expect(page.getByTestId(`session-row-${heirId}`)).toContainText('갈아탈 세션')
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).toContain(id)
  // 새 세션의 첫 메시지가 그 글이다
  await expect(page.getByTestId('chat-stream')).toContainText('후계자 노트')
})

/*
 * 죽은-에이전트 인수인계 (#78): 서비스가 중단된 세션에게 노트를 부탁할 수 없다.
 * 그 상태를 보면 대화상자의 기본값 셋이 통째로 뒤집힌다 — 모드는 기록으로,
 * 대상은 반대 도구로, 삭제는 해제로. 확인하면 죽은 세션에게 아무것도 묻지 않고
 * host의 기록이 후임자의 첫 메시지가 된다.
 */
test('죽은 세션의 인수인계: 기록 모드가 미리 서고, 묻지 않고 넘어가며, 원본은 남는다 (#78)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '죽을 세션')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  // 세션이 죽는다 — 에러 상태가 곧 "노트를 부탁할 수 없다"는 판정 근거다
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'error', sessionId: sid, error: { code: 'adapter_crashed', message: 'service down', retryable: false } })
  }, id)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`handoff-session-${id}`).click()

  // 기본값 셋이 뒤집혔다: 기록 모드 · 반대 도구 · 삭제 해제
  await expect(page.getByTestId('handoff-mode-record')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-tool-codex')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-delete-toggle').locator('input')).not.toBeChecked()
  await expect(page.getByTestId('handoff-mode-note')).toContainText('not asked')

  await page.getByTestId('confirm-handoff-yes').click()

  // 후임자가 이름을 물려받아 서고, 첫 메시지가 host의 기록이다 — 죽은 세션에겐 아무것도 안 갔다
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.sessions.size), { timeout: 15_000 })
    .toBe(2)
  await expect(page.getByTestId('chat-stream')).toContainText('Handoff Record')
  // 원본은 남는다 — 후임자가 확인될 때까지의 보존이 죽은-모드의 기본이다
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).not.toContain(id)
})

test('세션 생성이 실패하면 모달에 이유가 남는다 (M2.5: 눌러도 반응 없어 보이던 문제)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.agents.createSession = async () => {
      throw new Error('Could not start claude session: Native CLI binary not found')
    }
  })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()

  // 토스트는 사라지지만 이건 남는다
  await expect(page.getByTestId('create-session-error')).toContainText('Could not start')
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
})

test('host가 이미 준비된 뒤에 붙어도 기동한다 (회귀: 이벤트를 놓쳐 30초 멈추던 문제)', async ({ page }) => {
  // mock 플랫폼은 즉시 준비되므로, attach가 늦어도 화면이 뜨는지만 본다
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible({ timeout: 5000 })
  // 기동 실패 화면이 아니어야 한다
  await expect(page.getByText('Could not start the agent host')).toHaveCount(0)
})

test('세션 없이도 프로젝트의 깃·파일·뷰어를 볼 수 있다 (도그푸딩: 어디서 보는지 못 찾음)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
  })

  // 세션을 만들지 않은 상태에서 프로젝트 이름을 누른다
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()

  // 세션이 없어도 증거 패널은 프로젝트의 것이므로 그대로 보인다
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
  await expect(page.getByTestId('evidence-file-src/a.ts')).toBeVisible()
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-README.md')).toBeVisible()
})

test('창 드래그 영역과 오버스크롤 차단 (M2.5 창 문제)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 타이틀바를 숨겼으므로 각 레인의 헤더가 창 이동 손잡이다 (상단바·세션·증거)
  // 각 레인의 헤더가 창 이동 손잡이다 (상단바·세션·증거).
  // 속성만으로는 헤더 '안의 글자'를 잡았을 때 죽으므로 mousedown도 함께 받는다
  await expect(page.locator('[data-tauri-drag-region]')).toHaveCount(3)

  // 창 자체는 스크롤되지 않는다 (웹처럼 고무줄로 튕기면 안 된다)
  const overscroll = await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY)
  expect(overscroll).toBe('none')
  const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow)
  expect(bodyOverflow).toBe('hidden')
})

/**
 * 이전 세션 불러오기 — '+ → 도구 선택 → 이전 대화 목록'.
 * 터미널에서 하던 대화를 이어받지 못하면 이 앱은 '또 하나의 창'이 된다.
 */
async function seedPastSessions(
  page: Page,
  data: { supported: boolean; reason?: string; sessions: Record<string, unknown>[] },
  history: Record<string, { role: string; text: string }[]> = {},
) {
  await page.evaluate(
    ({ d, h }) => {
      const m = (window as any).__mock
      m.externalSessions = d
      for (const [id, msgs] of Object.entries(h)) m.externalHistory.set(id, msgs)
    },
    { d: data, h: history },
  )
}

test('세션 생성 모달에서 이전 대화를 골라 불러온다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(
    page,
    {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: '어제 하던 리팩터링',
          updatedAt: Date.now() - 3600_000,
          createdAt: null,
          branch: 'main',
          imported: false,
        },
        {
          externalId: 'ext-2',
          tool: 'claude',
          title: '빌드 깨진 것 추적',
          updatedAt: Date.now() - 86400_000,
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    },
    {
      'ext-1': [
        { role: 'user', text: '이 모듈 좀 쪼개줘' },
        { role: 'assistant', text: '세 파일로 나눴습니다' },
      ],
    },
  )

  // ext-2는 이미 불러와 둔 상태로 만든다 (목이 실제 세션을 보고 판정한다)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-2').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  // 기본은 '새 대화' — 불러오기가 기본이 되면 안 된다
  await expect(page.getByTestId('past-new')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('past-ext-1')).toContainText('어제 하던 리팩터링')
  // 제목이 '첫 메시지'인 도구(codex)에서도 최신 여부를 알 수 있어야 한다
  await expect(page.getByTestId('past-ext-1')).toContainText('last 1h ago')
  await expect(page.getByTestId('past-ext-2')).toContainText('Already open')

  await page.getByTestId('past-ext-1').click()
  // 이어가기를 골랐다는 사실은 버튼 라벨이 말한다 (Load ≠ Start) — 별도 안내문은 걷어냈다 (#8)
  await expect(page.getByTestId('create-session-confirm')).toHaveText('Load')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 지난 대화가 화면에 복원된다
  await expect(page.getByTestId('chat-stream')).toContainText('이 모듈 좀 쪼개줘')
  await expect(page.getByTestId('chat-stream')).toContainText('세 파일로 나눴습니다')

  // 이어받을 원본이 host로 전달됐는가
  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params.resumeExternalId).toBe('ext-1')
  expect(params.importHistory).toBe(true)

  // 불러온 대화를 안 읽음으로 그리지 않는다 (이미 읽은 대화다)
  const sessionId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()].at(-1))
  await expect(page.getByTestId(`session-row-${sessionId}`)).not.toHaveAttribute('data-unread', 'true')
})

test('구버전 도구는 목록을 못 줘도 새 세션을 막지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(page, {
    supported: false,
    reason: 'The installed Codex does not support listing past sessions (update codex)',
    sessions: [],
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-unsupported')).toContainText('update codex')
  // 이유는 보이되 길은 열려 있어야 한다
  await expect(page.getByTestId('create-session-confirm')).toHaveText('Start')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill('그래도 새로 시작')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('chat-stream')).toContainText('그래도 새로 시작')
})

test('이전 대화가 없으면 없다고 말한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(page, { supported: true, sessions: [] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-empty')).toBeVisible()
})

/**
 * 증거 → 자세히 보기의 연결.
 * 우측은 목록만, 자세히 보는 일은 넓은 오버레이에서 한다 (340px에서 diff는 못 읽는다).
 */
test('변경 파일을 누르면 넓은 오버레이에 diff가 펴지고 esc로 대화가 그대로 돌아온다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n-old()\n+next()'
  })
  await newSession(page, 'alpha', '이 함수 고쳐줘')

  await expect(page.getByTestId('evidence-change-count')).toHaveText('1')
  await page.getByTestId('evidence-file-src/a.ts').click()

  // 오버레이가 덮이고, 누른 파일의 diff부터 펴진다 (목록을 다시 찾게 하지 않는다)
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('next()')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('overlay')).toBeHidden()
  // 걷으면 대화가 그대로 — 다시 찾아 들어가지 않아도 된다
  await expect(page.getByTestId('chat-stream')).toContainText('이 함수 고쳐줘')
})

test('파일 트리에서 연 파일도 같은 오버레이에 뜬다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
    m.fsState.files['README.md'] = '# Alpha\n읽을 수 있어야 한다'
  })
  await newSession(page, 'alpha', '작업')

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
test('오버레이는 대화만 덮는다 — 다음 파일을 여는 손잡이가 남아 있어야 한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'a.ts', path: 'a.ts', isDir: false, ignored: false },
      { name: 'b.ts', path: 'b.ts', isDir: false, ignored: false },
    ]
    m.fsState.files['a.ts'] = '첫 파일'
    m.fsState.files['b.ts'] = '둘째 파일'
  })
  await newSession(page, 'alpha', '작업')

  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-a.ts').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('a.ts')

  // 오버레이의 오른쪽 끝이 증거 패널의 왼쪽 끝을 넘지 않는다
  const edges = async () => {
    const o = (await page.getByTestId('overlay').boundingBox())!
    const p = (await page.getByTestId('evidence-panel').boundingBox())!
    return { overlayRight: o.x + o.width, panelLeft: p.x }
  }
  const viewerEdges = await edges()
  expect(viewerEdges.overlayRight).toBeLessThanOrEqual(viewerEdges.panelLeft + 1)

  // esc 없이 트리에서 바로 다음 파일로 — 덮여 있으면 이 클릭이 통하지 않는다
  await page.getByTestId('file-b.ts').click()
  await expect(page.getByTestId('viewer-path')).toContainText('b.ts')
})

/**
 * 같은 규칙이 diff에도 적용된다 (이슈 #15). 오히려 여기가 더 아프다 — 변경 목록은
 * 하나씩 훑어 내려가는 목록이라, 한 파일을 볼 때마다 목록이 사라지면 그 훑기가 끊긴다.
 * diff는 unified라 좁아진 폭에서도 열은 그대로고 줄 폭만 준다.
 */
test('깃 오버레이도 마찬가지다 — 변경 목록을 덮지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n-old()\n+first()'
    m.fsState.entries[''] = [{ name: 'notes.md', path: 'notes.md', isDir: false, ignored: false }]
    m.fsState.files['notes.md'] = '읽을 수 있어야 한다'
  })
  await newSession(page, 'alpha', '두 파일 고쳐줘')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('first()')

  const o = (await page.getByTestId('overlay').boundingBox())!
  const p = (await page.getByTestId('evidence-panel').boundingBox())!
  expect(o.x + o.width).toBeLessThanOrEqual(p.x + 1)

  // 패널이 살아 있다 — 덮여 있으면 이 클릭들이 오버레이에 가로막힌다
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-notes.md').click()
  await expect(page.getByTestId('viewer-path')).toContainText('notes.md')
})

test('세션을 바꾸면 덮어둔 것은 걷힌다 — 새 대화가 먼저 보여야 한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'a.ts', path: 'a.ts', isDir: false, ignored: false }]
    m.fsState.files['a.ts'] = 'x'
  })
  await newSession(page, 'alpha', '첫 번째')
  await newSession(page, 'alpha', '두 번째')

  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-a.ts').click()
  await expect(page.getByTestId('overlay')).toBeVisible()

  const first = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  await page.getByTestId(`session-row-${first}`).click()
  await expect(page.getByTestId('overlay')).toBeHidden()
  await expect(page.getByTestId('chat-stream')).toContainText('첫 번째')
})

/** 증거 패널: 탭으로 갈리고, 접어도 되살릴 길이 남는다 */
test('증거 패널 탭: 깃은 변경만, 기록은 기록 탭에서 그래프와 함께', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: '첫 커밋', author: '나', when: Date.now(), parents: [] },
      {
        sha: 'bbb222',
        shortSha: 'bbb222',
        subject: '두 번째',
        author: '나',
        when: Date.now(),
        parents: ['a', 'b'],
      },
    ]
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', '작업')

  // 깃 탭이 기본 — 변경만 있다. 기록 스트립은 분할(#20)에서 이웃 탭 스트립을 덮어 떠났다
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await expect(page.getByTestId('evidence-file-src/a.ts')).toBeVisible()
  await expect(page.getByTestId('evidence-tree')).toHaveCount(0)

  // 기록은 기록 탭에서 — 스트립에 살던 레인 그래프도 여기로 이사했다
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-aaa111')).toContainText('첫 커밋')
  await expect(page.getByTestId('history-commit-bbb222')).toContainText('merge')
  await expect(page.getByTestId('commit-graph-aaa111')).toBeVisible()

  // 파일 탭으로 가면 트리만
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-README.md')).toBeVisible()
  await expect(page.getByTestId('evidence-git')).toBeHidden()

  // 고른 탭은 스냅샷에 실린다
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelTab).toBe('files')
})

test('기록에서 커밋을 누르면 넓은 곳에서 펼쳐진다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: '첫 커밋', author: '나', when: Date.now(), parents: [] },
    ]
    m.gitState.diffs['aaa111'] = '@@ -0,0 +1 @@\n+새 줄'
  })
  await newSession(page, 'alpha', '작업')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa111').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('새 줄')
})

test('패널을 접으면 띠가 남고 거기서 다시 편다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', '작업')

  await page.getByTestId('evidence-close').click()
  await expect(page.getByTestId('evidence-panel')).toBeHidden()

  // 사라진 것과 접힌 것은 다르다 — 띠가 남고 변경 수는 접힌 채로도 읽힌다
  await expect(page.getByTestId('evidence-rail')).toBeVisible()
  await expect(page.getByTestId('evidence-rail-count')).toHaveText('2')

  await page.getByTestId('evidence-open').click()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

test('좁은 패널에서도 올리고 커밋할 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
  })
  await newSession(page, 'alpha', '작업')

  // 스테이지 전에는 커밋할 수 없다 (올릴 것이 없는데 커밋 버튼이 살아 있으면 거짓말이다)
  await page.getByTestId('evidence-commit-message').fill('패널에서 커밋')
  await expect(page.getByTestId('evidence-commit')).toBeDisabled()

  await page.getByTestId('evidence-stage-all').click()
  await page.getByTestId('evidence-commit').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('패널에서 커밋')
})

/** M2.6 도그푸딩: 숨김/삭제·재시작·첨부·압축된 옛 대화 */
test('삭제는 우리 기록만 지운다 — 도구에는 남는다고 분명히 말한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '지울 세션')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()

  // 기본은 원본까지 지운다 (2b60589) — 그때는 빨간 경고가 선다
  await expect(page.getByTestId('delete-external-warning')).toContainText('deleted too')
  // **남기기로 고르면** 무섭지 않게 말한다 — 실제보다 무섭게 말하면 사람은 정리하지 못하고 목록만 쌓인다
  await page.getByTestId('delete-external-toggle').locator('input').uncheck()
  await expect(page.getByTestId('delete-notice')).toContainText('stays in Claude Code')
  await expect(page.getByTestId('delete-notice')).toContainText('Past conversations')

  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toBeHidden()

  // 치우기 버튼은 없다 — 삭제 하나만 남겼다
  await expect(page.getByTestId(`hide-session-${id}`)).toHaveCount(0)
})

test('새로고침은 에이전트만 다시 시작하고 대화는 남긴다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '이 대화는 남아야 한다')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId('restart-session').click()
  await expect(page.getByTestId('toast')).toContainText('Agent restarted')

  expect(await page.evaluate(() => (window as any).__mock.restarted)).toContain(id)
  await expect(page.getByTestId('chat-stream')).toContainText('이 대화는 남아야 한다')
})

/**
 * 재시작은 몇 초짜리 일이다 — 그동안 화면이 조용하면 한 번 더 누르게 되고,
 * **두 번째 누름은 방금 뜬 프로세스를 다시 죽인다.** 고치려고 누른 버튼이
 * 고장을 만드는 자리였다. 도는 아이콘은 장식이 아니라 "받았다"는 응답이다.
 */
test('재시작하는 동안 아이콘이 돌고 버튼은 다시 눌리지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 실물처럼 시간이 걸리게 만든다 — 즉시 끝나면 이 버그는 재현되지 않는다
  await page.evaluate(() => {
    const m = (window as any).__mock
    const real = m.agents.restartSession.bind(m.agents)
    m.agents.restartSession = async (id: string) => {
      await new Promise((r) => setTimeout(r, 1200))
      return real(id)
    }
  })

  const button = page.getByTestId('restart-session')
  await button.click()

  // 도는 중이고, 잠겨 있다
  await expect(page.getByTestId('restart-spinning')).toBeVisible()
  await expect(button).toBeDisabled()

  // 그 사이 다시 누르려 해도 두 번째 재시작은 일어나지 않는다
  await button.click({ force: true })
  await expect(page.getByTestId('toast')).toContainText('Agent restarted')
  const count = await page.evaluate(() => (window as any).__mock.restarted.length)
  expect(count).toBe(1)

  // 끝나면 원래대로 — 다음에 또 고칠 수 있어야 한다
  await expect(button).toBeEnabled()
  await expect(page.getByTestId('restart-spinning')).toHaveCount(0)
})

test('드래그해서 떨어뜨려도 첨부된다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 웹뷰가 드롭을 가로채지 않는다는 전제 아래, 떨어뜨린 파일이 첨부로 잡히는지
  const dt = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['스크린샷 내용'], 'shot.png', { type: 'image/png' }))
    return data
  })
  await page.getByTestId('input-dropzone').dispatchEvent('drop', { dataTransfer: dt })

  await expect(page.getByTestId('attachment-list')).toContainText('shot.png')
  await page.getByTestId('send').click()
  const sent = await page.evaluate(() => (window as any).__mock.sentAttachments)
  expect(sent.at(-1).name).toBe('shot.png')
})

test('압축돼도 옛 대화는 거슬러 읽을 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 저장소에는 250줄이 있고 화면에는 최근 한 페이지(HISTORY_PAGE=100)만 있다
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = Array.from({ length: 250 }, (_, i) => ({
      sessionId: sid,
      seq: i + 1,
      role: i % 2 ? 'assistant' : 'user',
      kind: 'text',
      payload: { text: `옛 대화 ${i + 1}` },
      ts: Date.now(),
    }))
    m.messages.set(sid, rows)
  }, id)
  // 앱을 다시 열어 그 세션을 펼친 상황 (메모리에 든 대화 없이 저장소에서 읽는다)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  // 압축 지점은 대화에 표시된다 (모델은 잊었지만 기록은 남아 있다는 사실)
  await page.evaluate((sid) => (window as any).__mock.emit({ type: 'compaction', sessionId: sid }), id)
  await expect(page.getByTestId('msg-mark')).toContainText('compacted')

  // 화면에는 최근 한 페이지만 있다 (가상 스크롤이라 실제로 그려지는 건 더 적다)
  const loaded = (sid: string) => (window as any).__store.getState().chat[sid].length
  expect(await page.evaluate(loaded, id)).toBe(101) // 100 + 압축 표식

  // 버튼이 아니라 위로 올리면 알아서 이어붙인다. 한 번 불러오면 위치 보정이
  // 읽던 자리를 지키느라 꼭대기에서 내려오므로(#61), 사람처럼 다시 올린다.
  await expect(async () => {
    await page.getByTestId('chat-stream').evaluate((el) => el.scrollTo({ top: 0 }))
    await expect(page.getByTestId('load-older')).toBeHidden({ timeout: 500 }) // 더 거슬러 갈 곳이 없다
  }).toPass()

  // 압축으로 모델이 잊은 대화도 우리 기록에는 남아 있다
  expect(await page.evaluate(loaded, id)).toBe(251)
  const first = await page.evaluate((sid: string) => (window as any).__store.getState().chat[sid][0].text, id)
  expect(first).toBe('옛 대화 1')
})

/*
 * 스크롤이 아니라 **클릭으로도** 옛 대화를 불러온다 (도그푸딩 2026-09-04: 실물
 * WKWebView에서 위 스크롤이 옛 페이지를 안 실었다 — 관찰자가 안 깨어나는 환경이
 * 있어도 사람 손은 남아야 한다).
 */
test('옛 대화는 버튼 클릭으로도 이어붙는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = Array.from({ length: 250 }, (_, i) => ({
      sessionId: sid, seq: i + 1, role: i % 2 ? 'assistant' : 'user', kind: 'text',
      payload: { text: `옛 대화 ${i + 1}` }, ts: Date.now(),
    }))
    m.messages.set(sid, rows)
  }, id)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  const loaded = (sid: string) => (window as any).__store.getState().chat[sid].length
  expect(await page.evaluate(loaded, id)).toBe(100)
  /*
   * 위로 올리고 버튼을 누른다 — 스크롤 트리거·IO·클릭 셋 중 무엇이 깨져도
   * 나머지가 끝까지 데려간다는 계약이다 (100에서 멈추는 "벽"이 그 버그였다).
   */
  await page.getByTestId('chat-stream').evaluate((el) => el.scrollTo({ top: 0 }))
  await page.getByTestId('load-older').getByRole('button').click()
  await expect.poll(() => page.evaluate(loaded, id)).toBe(250)
  // 다 불러오면 버튼도 물러난다
  await expect(page.getByTestId('load-older')).toBeHidden()
})

/**
 * 대화가 뭉개져 보이던 문제 (도그푸딩 4차).
 * 저장된 기록의 seq와 실시간 항목의 seq가 따로 세어져 React key가 겹쳤고,
 * 가상 스크롤이 겹친 항목을 같은 자리에 그리면서 글자가 이어붙었다.
 */
test('기록을 불러온 세션에 새 말이 붙어도 항목 번호가 겹치지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 저장소에 seq 1..5로 기록이 있는 세션을 새로 펼친다
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    m.messages.set(
      sid,
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: sid,
        seq: i + 1,
        role: i % 2 ? 'assistant' : 'user',
        kind: 'text',
        payload: { text: `기록 ${i + 1}` },
        ts: Date.now(),
      })),
    )
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  // 그 위에 실시간 대화가 이어진다 (예전에는 여기서 seq가 1부터 다시 셌다)
  await page.getByTestId('prompt-input').fill('새로 한 말')
  await page.getByTestId('send').click()
  await page.evaluate(
    (sid) =>
      (window as any).__mock.emit({
        type: 'message_delta',
        sessionId: sid,
        role: 'assistant',
        text: '새 답',
      }),
    id,
  )

  const seqs = await page.evaluate(
    (sid) => (window as any).__store.getState().chat[sid].map((c: { seq: number }) => c.seq),
    id,
  )
  expect(new Set(seqs).size).toBe(seqs.length)

  // 겹치지 않으니 옛 기록과 새 말이 각자 제자리에 보인다
  await expect(page.getByTestId('chat-stream')).toContainText('기록 5')
  await expect(page.getByTestId('chat-stream')).toContainText('새로 한 말')
})

test('도구 카드는 안쪽 스크롤 없이 접고 편다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.emit({
      type: 'tool_call',
      sessionId: sid,
      callId: 'c1',
      summary: { tool: 'Bash', title: 'pnpm test', readOnly: true, paths: [] },
    })
    m.emit({
      type: 'tool_result',
      sessionId: sid,
      callId: 'c1',
      ok: true,
      summary: Array.from({ length: 40 }, (_, i) => `출력 ${i + 1}`).join('\n'),
    })
  }, id)

  const output = page.getByTestId('tool-card-output')
  await expect(output).toBeVisible()

  // 조회성 도구는 접힌 채로 시작하고, 맛보기만 보인다
  await expect(output).toContainText('출력 1')
  await expect(output).not.toContainText('출력 40')
  await expect(page.getByTestId('tool-card-more')).toContainText('37 more lines')

  // 대화 스크롤을 가로챌 안쪽 스크롤러가 없다
  const scrollable = await output.evaluate((el) => {
    const s = getComputedStyle(el)
    return s.overflowY === 'auto' || s.overflowY === 'scroll' || el.scrollHeight > el.clientHeight + 1
  })
  expect(scrollable).toBe(false)

  await page.getByTestId('tool-card-more').click()
  await expect(output).toContainText('출력 40')
  const stillScrollable = await output.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(stillScrollable).toBe(false)
})

/**
 * 증거 패널 폭 조절 + 터미널 (M2.7).
 * 터미널의 정체성은 cwd다 — 세션을 바꿔도 같은 터미널이 이어져야 한다.
 */
test('증거 패널 폭을 끌어서 조절하고 재시작 후에도 유지한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

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

  // 폭은 스냅샷에 실린다 (다음에 열면 그대로)
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelWidth).toBeGreaterThan(before + 100)

  // 더블클릭으로 기본값 복귀 — 잘못 끌어놓고 되돌릴 길이 있어야 한다.
  // 폭이 미끄러지므로(열고 닫힘 전환) 곧바로 재면 중간값이 잡힌다 — 멈출 때까지 기다린다.
  await handle.dblclick()
  await expect.poll(async () => (await panel.boundingBox())!.width, { timeout: 2000 }).toBeCloseTo(340, -1)
})

test('터미널은 프로젝트의 것이라 세션을 바꿔도 이어진다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '첫 세션')
  await newSession(page, 'alpha', '두 번째 세션')

  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  // 터미널이 뭔가 출력한 상태를 만든다
  const termId = await page.evaluate(() => {
    const m = (window as any).__mock
    const t = [...m.terminalState.byCwd.values()][0][0]
    m.emitTerminal(t.id, 'hello from alpha\r\n')
    return t.id
  })

  // 세션을 바꿔도 같은 터미널에 붙는다 (돌려놓은 dev 서버가 죽으면 안 된다)
  const first = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  await page.getByTestId(`session-row-${first}`).click()
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  const sameTerminal = await page.evaluate(() => {
    const lists = [...(window as any).__mock.terminalState.byCwd.values()]
    return lists.length === 1 && lists[0].length === 1 && lists[0][0].id
  })
  expect(sameTerminal).toBe(termId)

  // 다시 붙을 때 지금까지의 출력을 되살린다 (빈 화면이면 터미널이 아니다)
  await expect(page.getByTestId(`terminal-surface-${termId}`)).toContainText('hello from alpha')
})

test('키보드 입력이 셸로 간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  const id = await page.evaluate(() => [...(window as any).__mock.terminalState.byCwd.values()][0][0].id)
  await page.getByTestId(`terminal-surface-${id}`).click()
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')

  const sent = await page.evaluate(() =>
    (window as any).__mock.terminalState.input.map((i: { data: string }) => i.data).join(''),
  )
  expect(sent).toContain('ls')
  expect(sent).toContain('\r')
})

test('사이드바는 프로젝트당 한 줄만 쓴다 (세로 공간)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 프로젝트 헤더가 세션 한 줄보다 크게 부풀지 않아야 목록이 밀리지 않는다
  const header = (await page.getByTestId('project-header-alpha').boundingBox())!
  expect(header.height).toBeLessThan(28)

  // 평소에는 배경 정보가 자리를 차지하지 않는다
  await expect(page.getByTestId('project-tip-alpha')).toBeHidden()
  await page.getByTestId('project-header-alpha').hover()
  await expect(page.getByTestId('project-tip-alpha')).toBeVisible()
  await expect(page.getByTestId('project-tip-alpha')).toContainText('/tmp/alpha')
})

test('터미널을 여러 개 열고 닫는다 (세로로 쌓인다)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-terminal').click()

  // 처음 열면 하나는 있다 — 빈 화면에 버튼만 있으면 한 단계가 더 든다
  await expect(page.getByTestId('terminal-stack').locator('[data-testid^="terminal-surface-"]')).toHaveCount(
    1,
  )

  await page.getByTestId('terminal-add').click()
  await page.getByTestId('terminal-add').click()
  const surfaces = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-surface-"]')
  await expect(surfaces).toHaveCount(3)

  // 세로로 쌓인다 (가로가 아니라)
  const first = (await surfaces.nth(0).boundingBox())!
  const second = (await surfaces.nth(1).boundingBox())!
  expect(second.y).toBeGreaterThan(first.y)
  expect(Math.abs(second.x - first.x)).toBeLessThan(2)

  // 가운데를 닫으면 번호가 다시 매겨진다
  const ids = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { id: string }) => t.id),
  )
  await page.getByTestId(`terminal-close-${ids[1]}`).click()
  await expect(surfaces).toHaveCount(2)
  const titles = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { title: string }) => t.title),
  )
  expect(titles).toEqual(['Terminal 1', 'Terminal 2'])
})

test('좌우 패널 폭을 조절해도 화면이 옆으로 밀리지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 사이드바 폭 조절
  const sidebar = page.getByTestId('sidebar')
  const before = (await sidebar.boundingBox())!.width
  const handle = page.getByTestId('sidebar-resize')
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + 1, hb.y + 200)
  await page.mouse.down()
  await page.mouse.move(hb.x + 120, hb.y + 200, { steps: 8 })
  await page.mouse.up()
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(before + 60)

  // 우측 패널을 최대한 넓혀도 가로 스크롤이 생기면 안 된다
  const panelHandle = page.getByTestId('evidence-resize')
  const pb = (await panelHandle.boundingBox())!
  await page.mouse.move(pb.x + 1, pb.y + 200)
  await page.mouse.down()
  await page.mouse.move(10, pb.y + 200, { steps: 12 })
  await page.mouse.up()

  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)

  // 대화 레인이 최소 폭을 지켜서 살아 있다
  expect((await page.getByTestId('chat-stream').boundingBox())!.width).toBeGreaterThan(200)
})

/** 슬래시·@ 자동완성 (M2.8) */
test('슬래시를 치면 스킬이, @를 치면 파일이 뜬다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.commandState = {
      ready: true,
      commands: [
        { name: 'review', description: '변경을 검토합니다', argumentHint: '<path>' },
        { name: 'commit', description: '커밋합니다', argumentHint: '' },
      ],
    }
    m.fsState.entries[''] = [
      { name: 'SessionView.tsx', path: 'src/SessionView.tsx', isDir: false, ignored: false },
      { name: 'store.ts', path: 'src/store.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'alpha', '작업')

  // 슬래시 — 맨 앞에서만
  await page.getByTestId('prompt-input').fill('/rev')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('/review')
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('<path>')

  // Enter로 고르면 입력창에 들어간다
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('prompt-input')).toHaveValue('/review ')
  await expect(page.getByTestId('autocomplete')).toBeHidden()

  // @ — 파일
  await page.getByTestId('prompt-input').fill('이거 봐줘 @Session')
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('SessionView.tsx')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('prompt-input')).toHaveValue('이거 봐줘 @src/SessionView.tsx ')
})

test('스킬을 아직 못 불러왔으면 없다고 하지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    // 세션을 막 만들면 CLI가 뜨는 중이라 물어볼 수 없다
    ;(window as any).__mock.commandState = { ready: false, commands: [] }
  })
  await newSession(page, 'alpha', '작업')

  await page.getByTestId('prompt-input').fill('/')
  await expect(page.getByTestId('autocomplete-loading')).toContainText('Loading skills')
})

test('문장 중간의 슬래시는 명령으로 보지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.commandState = {
      ready: true,
      commands: [{ name: 'review', description: '', argumentHint: '' }],
    }
  })
  await newSession(page, 'alpha', '작업')

  await page.getByTestId('prompt-input').fill('경로는 src/rev 입니다')
  await expect(page.getByTestId('autocomplete')).toBeHidden()
})

test('이미 열려 있는 대화를 다시 고르면 새로 만들지 않고 그 세션으로 간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: '어제 하던 일',
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    m.externalHistory.set('ext-1', [{ role: 'user', text: '어제 하던 일' }])
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-1').click()
  await page.getByTestId('create-session-confirm').click()
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 다시 열면 '이미 열려 있음'으로 표시되고, 누르면 만들지 않고 이동한다
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-ext-1')).toContainText('Already open')
  await page.getByTestId('past-ext-1').click()

  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  expect(await page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(id)
  // 세션이 하나 더 생기지 않았다
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(1)
})

/**
 * 터미널을 닫으면 남은 것들의 높이가 늘어난다. 그때 **다시 만들어지면 안 된다** —
 * 새로 만든 xterm은 기본 크기로 시작했다가 곧바로 실제 크기로 맞춰지고,
 * 그 resize가 셸의 프롬프트를 다시 그려서 줄이 늘어난 것처럼 보인다.
 */
test('터미널 하나를 닫아도 남은 터미널은 다시 만들어지지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-terminal').click()
  await page.getByTestId('terminal-add').click()

  const ids = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { id: string }) => t.id),
  )
  await expect(page.getByTestId(`terminal-surface-${ids[0]}`)).toBeVisible()

  // 살아남을 터미널이 출력을 갖게 한다 — 닫은 뒤 목록을 다시 읽으면
  // 이 터미널의 history 스냅샷이 달라지고, 그게 재생성을 부르던 조건이다
  await page.evaluate((id) => (window as any).__mock.emitTerminal(id, 'dev server running\r\n'), ids[0])

  // 살아남을 터미널의 실제 DOM에 표식을 남긴다
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="terminal-surface-${id}"] .xterm`) as HTMLElement & {
      __kept?: boolean
    }
    el.__kept = true
  }, ids[0])

  await page.getByTestId(`terminal-close-${ids[1]}`).click()
  await expect(page.getByTestId(`terminal-surface-${ids[1]}`)).toHaveCount(0)

  // 같은 DOM 노드가 그대로면 다시 만들어지지 않은 것이다
  const kept = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="terminal-surface-${id}"] .xterm`) as
      (HTMLElement & { __kept?: boolean }) | null
    return el?.__kept === true
  }, ids[0])
  expect(kept).toBe(true)
})

/** 사용량 (FR-9) — 구독 한도만 다룬다 */
test('사용량 모달: 창마다 도넛, 호버하면 초기화 시각까지', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'max',
        windows: [
          {
            id: 'session',
            label: '5 hours',
            percent: 8,
            resetsAt: new Date(Date.now() + 7_800_000).toISOString(),
            scope: null,
          },
          {
            id: 'weekly_all',
            label: 'Weekly',
            percent: 93,
            resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
            scope: null,
          },
        ],
        daily: [],
      },
    }
  })

  await page.getByTestId('open-usage').click()
  await expect(page.getByTestId('usage-plan')).toContainText('max')
  await expect(page.getByTestId('usage-window-session')).toContainText('8%')
  await expect(page.getByTestId('usage-window-weekly_all')).toContainText('93%')

  // 자세한 건 물어볼 때 답한다
  await page.getByTestId('usage-window-weekly_all').hover()
  await expect(page.getByTestId('usage-tip-weekly_all')).toContainText('reset')
  /*
   * 그리고 **잘리지 않는다** (도그푸딩: 도넛이 모달 스크롤 상자의 바닥 근처라 absolute
   * 툴팁은 아래가 잘려 보였다). 잘림의 원인 — 스크롤 상자 안의 absolute — 이 제거됐는지와
   * (체크박스 테스트와 같은 문법: 크로미움 rect는 잘려도 그대로라 증상 대신 원인을 잰다),
   * 창 안에 온전히 있는지를 함께 본다.
   */
  const tip = page.getByTestId('usage-tip-weekly_all')
  expect(await tip.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
  const tb = (await tip.boundingBox())!
  expect(tb.y + tb.height).toBeLessThanOrEqual(page.viewportSize()!.height)

  // 일간을 못 주는 도구면 그 줄을 접는다 (Claude에는 일간 창이 없다)
  await expect(page.getByTestId('usage-daily')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('usage-modal')).toBeHidden()
})

test('일별 토큰을 주는 도구면 함께 보여준다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'pro',
        windows: [{ id: 'primary', label: '1 week', percent: 22, resetsAt: null, scope: null }],
        daily: [
          { date: '2026-08-15', tokens: 115640 },
          { date: '2026-08-16', tokens: 9005155 },
        ],
      },
    }
  })
  await page.getByTestId('open-usage').click()
  await expect(page.getByTestId('usage-daily')).toContainText('Today 9.0M')
})

test('사용량을 못 읽으면 이유를 말한다 (빈 화면으로 두지 않는다)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: false,
      reason: 'The installed Claude Code SDK does not support usage queries',
      usage: null,
    }
  })
  await page.getByTestId('open-usage').click()
  await expect(page.getByTestId('usage-unavailable')).toContainText('does not support usage queries')
})

/**
 * 모달은 조상의 사정과 무관하게 창 전체를 덮어야 한다.
 * 사이드바에 폭 조절 손잡이를 넣느라 relative를 붙였더니, 그 안에서 열리던
 * 세션 생성 모달이 사이드바 폭 안에 갇혔다 (도그푸딩에서 지적됨).
 */
test('모달은 사이드바 안에 갇히지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const sidebarWidth = (await page.getByTestId('sidebar').boundingBox())!.width
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  const dialog = (await page.getByTestId('new-session-dialog').boundingBox())!
  const viewport = page.viewportSize()!
  // 덮개가 창 전체다 (사이드바 폭이 아니라)
  expect(dialog.width).toBeGreaterThan(sidebarWidth * 2)
  expect(Math.round(dialog.width)).toBe(viewport.width)

  // body 바로 아래에 붙는다 — 조상 positioning에 휘둘리지 않는다
  const parentIsBody = await page.evaluate(
    () => document.querySelector('[data-testid="new-session-dialog"]')?.parentElement === document.body,
  )
  expect(parentIsBody).toBe(true)
})

test('같은 대화를 두 세션이 열지 않는다 (도구가 거부하기 전에 우리가 막는다)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: '하나뿐인 대화',
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    m.externalHistory.set('ext-1', [{ role: 'user', text: '하나뿐인 대화' }])
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-1').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 다시 열면 '이미 열려 있음'이라 새로 만들지 않고 그 세션으로 간다
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-ext-1')).toContainText('Already open')
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(1)
})

/**
 * 긴 대화를 불러오면 **맨 아래(최신)** 가 보여야 한다.
 * 위쪽에 머물면 옛 대화만 보여서 "최신을 안 가져왔다"로 읽힌다 (도그푸딩 지적).
 */
test('불러온 대화는 최신부터 보인다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-long',
          tool: 'claude',
          title: '아주 오래된 첫 질문',
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    // 200줄짜리 긴 대화 — 마지막이 가장 최신이다
    m.externalHistory.set(
      'ext-long',
      Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        text: i === 199 ? '가장 최신 메시지' : `옛 대화 ${i + 1}`,
      })),
    )
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-long').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 맨 아래(최신)가 화면에 있어야 한다
  await expect(page.getByTestId('chat-stream')).toContainText('가장 최신 메시지')

  const atBottom = await page
    .getByTestId('chat-stream')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  expect(atBottom).toBe(true)
})

test('밖에서 이어간 대화가 돌아오면 화면에 붙는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // host가 따라잡아 저장소에 넣은 상황을 만든다
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = m.messages.get(sid) ?? []
    m.messages.set(sid, [
      ...rows,
      {
        sessionId: sid,
        seq: rows.length + 1,
        role: 'user',
        kind: 'text',
        payload: { text: '터미널에서 한 말' },
        ts: Date.now(),
      },
      {
        sessionId: sid,
        seq: rows.length + 2,
        role: 'assistant',
        kind: 'text',
        payload: { text: '터미널 답' },
        ts: Date.now(),
      },
    ])
    m.emit({ type: 'history_synced', sessionId: sid, added: 2 })
  }, id)

  // 이벤트를 받으면 화면을 다시 읽는다
  await expect(page.getByTestId('chat-stream')).toContainText('터미널에서 한 말')
  await expect(page.getByTestId('chat-stream')).toContainText('터미널 답')
})

test('긴 URL·경로가 대화창을 가로로 밀지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const long = `https://example.com/${'very-long-segment'.repeat(20)}`
  await page.getByTestId('prompt-input').fill(long)
  await page.getByTestId('send').click()
  await page.evaluate(
    ({ sid, text }) =>
      (window as any).__mock.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text }),
    { sid: id, text: `참고: ${long}` },
  )
  await expect(page.getByTestId('msg-assistant').last()).toBeVisible()

  // 대화창이 가로로 스크롤되면 안 된다
  const stream = await page.getByTestId('chat-stream').evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(stream.scroll).toBeLessThanOrEqual(stream.client + 1)

  // 창 전체도 마찬가지
  const page2 = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(page2.scroll).toBeLessThanOrEqual(page2.client)
})

/**
 * 깨우기가 실패하면 "메시지를 보내면 자동으로 이어집니다"는 **사실이 아니게 된다.**
 * 그 상태로 두면 사용자는 왜 안 되는지 알 길이 없다 (도그푸딩 지적).
 */
test('깨우지 못하면 이유를 그 자리에 적고 다시 시도할 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 잠든 상태 + 깨울 수 없는 상황을 만든다
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    m.sessions.get(sid).live = false
    m.unresumable.add(sid)
    store.setState({
      sessions: { ...store.getState().sessions, [sid]: { ...store.getState().sessions[sid], live: false } },
    })
  }, id)

  // 다시 고르면 깨우기를 시도하고, 실패 이유가 남는다
  await page.getByTestId('project-header-alpha').click()
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('dormant-note')).toContainText('Could not resume')
  await expect(page.getByTestId('dormant-note')).toContainText('cannot be resumed')

  // 원인을 고치고 다시 시도하면 살아난다
  await page.evaluate((sid) => (window as any).__mock.unresumable.delete(sid), id)
  await page.getByTestId('dormant-retry').click()
  await expect(page.getByTestId('dormant-note')).toBeHidden()
})

/**
 * 제목이 비슷한 두 세션을 다른 도구로 착각한 일이 있었다 (도그푸딩).
 * 목록에서 어느 도구인지 보여야 하고, 헤더·사용량도 **그 세션의** 도구를 써야 한다.
 */
test('세션 목록과 헤더가 각 세션의 도구를 보여준다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill('클로드 쪽 작업')
  await page.getByTestId('prompt-input').press('Enter')

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill('코덱스 쪽 작업')
  await page.getByTestId('prompt-input').press('Enter')

  // 목록에서 도구가 구분된다
  await expect(page.getByTestId('tool-mark-claude')).toHaveCount(1)
  await expect(page.getByTestId('tool-mark-codex')).toHaveCount(1)

  // 지금 보고 있는 건 codex 세션 — 사용량도 그 도구를 물어야 한다
  await page.getByTestId('open-usage').click()
  await expect(page.getByTestId('usage-modal')).toContainText('Codex')
})

/**
 * "지금 로딩이 안떠서 작업 중인지 멈춘 건지 헷갈린다" (도그푸딩).
 * 보낸 순간부터 답이 올 때까지 살아 있다는 표시가 있어야 하고, 거기서 멈출 수 있어야 한다.
 */
test('응답을 기다리는 동안 표시가 뜨고 거기서 중지할 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill('오래 걸리는 일')
  await page.getByTestId('prompt-input').press('Enter')

  await page.getByTestId('prompt-input').fill('한참 걸리는 걸 해줘')
  await page.getByTestId('send').click()

  // 보낸 즉시 보인다 — host 응답을 기다리지 않는다
  await expect(page.getByTestId('activity-row')).toBeVisible()

  await page.getByTestId('activity-interrupt').click()
  await expect(page.getByTestId('activity-row')).toBeHidden()
})

/**
 * "컴팩트 할 때 응답 기다리는 거랑 UI가 똑같아서, 응답을 하고 있는 건지
 *  컴팩트 중이라 오래 걸리는 건지 모르겠다" (도그푸딩).
 *
 * 프로브로 재보니 수동 압축 한 번이 39초였다. 그동안 화면이 '응답 대기'와
 * 한 글자도 다르지 않으면 기다리는 사람에게는 판단할 근거가 없다.
 */
test('압축 중은 응답 대기와 다르게 보인다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '시작')

  await page.getByTestId('prompt-input').fill('대화를 정리해줘')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')

  await emitEvent(page, 0, { type: 'activity', activity: 'compacting' })
  await expect(page.getByTestId('activity-label')).toHaveText('Compacting context')

  // 압축이 끝나면 평범한 대기로 돌아온다 — 상태는 내내 working이었다
  await emitEvent(page, 0, { type: 'activity', activity: null })
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')
})

/**
 * The elapsed count used to restart whenever the row was remounted (issue #23): a turn
 * three minutes old read as if it had just begun. The lie ran in the worst direction —
 * the longer the wait, the more it understated it.
 *
 * The count is derived from a start instant on the store now, so this ages the turn by
 * moving that instant rather than by actually waiting. Switching to the grid and back tears
 * the row down and builds it again, which is precisely what used to reset it.
 */
test('the elapsed count survives a view change — the start instant is what is stored', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'start')

  await page.getByTestId('prompt-input').fill('something slow')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('activity-row')).toBeVisible()

  const id = await page.evaluate(() => {
    const store = (window as any).__store
    const sessionId = store.getState().focusedSessionId as string
    // Three minutes and five seconds ago. Nothing else feeds the count
    store.setState({ workingSince: { [sessionId]: Date.now() - 185_000 } })
    return sessionId
  })
  await expect(page.getByTestId('activity-elapsed')).toHaveText(/^3m/)

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('activity-row')).toBeHidden()

  // Back to the focus view: a brand new row, still counting from the same instant
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('activity-row')).toBeVisible()
  await expect(page.getByTestId('activity-elapsed')).toHaveText(/^3m/)
})

/**
 * 압축 실패는 지금까지 통째로 삼켜졌다 (실측: "Not enough messages to compact.").
 * 컨텍스트가 그대로인데 화면에는 아무 일도 없었던 것처럼 보이면 안 된다.
 */
test('압축이 실패하면 대화에 그 사실이 남는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '시작')

  await emitEvent(page, 0, { type: 'compaction', failed: true, reason: 'Not enough messages to compact.' })
  await expect(page.getByText('Compaction failed — Not enough messages to compact.')).toBeVisible()
})

/**
 * 깃 탭 — VSCode처럼 스테이지된 것과 아닌 것을 나눠 보여준다.
 * 커밋 직전에 알아야 할 유일한 사실이 "무엇이 실리나"인데,
 * 한 목록에 섞여 있으면 그걸 줄 끝의 작은 꼬리표로 읽어야 했다.
 */
test('깃 패널이 스테이지됨과 변경됨을 나눠 보여주고 파일 하나씩 올릴 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: true, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', '작업')

  await expect(page.getByTestId('evidence-group-staged')).toContainText('src/a.ts')
  await expect(page.getByTestId('evidence-group-changed')).toContainText('src/b.ts')

  // 파일 하나만 올린다 — "이것만 빼고 커밋"을 하려고 터미널로 나가지 않아도 된다
  await page.getByTestId('evidence-stage-src/b.ts').click({ force: true })
  await expect(page.getByTestId('evidence-group-changed')).toBeHidden()
  await expect(page.getByTestId('evidence-group-staged')).toContainText('src/b.ts')
})

/** 점만 있으면 목록이지 트리가 아니다 — 갈라짐과 합쳐짐이 선으로 보여야 한다 */
test('깃 기록이 커밋을 선으로 잇는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.commits = [
      { sha: 'm', shortSha: 'mmmmmmm', subject: '병합', author: 'a', when: 0, parents: ['x', 'y'] },
      { sha: 'x', shortSha: 'xxxxxxx', subject: '본류', author: 'a', when: 0, parents: ['z'] },
      { sha: 'y', shortSha: 'yyyyyyy', subject: '가지', author: 'a', when: 0, parents: ['z'] },
      { sha: 'z', shortSha: 'zzzzzzz', subject: '뿌리', author: 'a', when: 0, parents: [] },
    ]
  })
  await newSession(page, 'alpha', '작업')
  // 그래프는 기록 탭에 산다 — 깃 탭의 스트립은 분할에서 이웃을 덮어 떠났다
  await page.getByTestId('evidence-tab-history').click()

  // 병합 커밋에서 두 갈래가 뻗는다 (직선 하나 + 갈라지는 곡선 하나)
  const merge = page.getByTestId('commit-graph-mmmmmmm')
  await expect(merge).toBeVisible()
  expect(await merge.locator('path').count()).toBeGreaterThan(0)

  // 가지가 본류로 합쳐지므로 뿌리에는 선이 하나만 내려온다
  await expect(page.getByTestId('commit-graph-zzzzzzz')).toBeVisible()
})

/**
 * 세션 표식 하나가 도구와 상태를 같이 말한다.
 * 점을 따로 두면 표식 바로 옆에서 둘이 겹쳐 읽혀 오히려 둘 다 흐려진다.
 */
test('작업 중인 세션은 표식 테두리가 돈다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  const mark = page.getByTestId('tool-mark-claude')
  await expect(mark).toHaveAttribute('data-state', /idle|waiting_input|working/)

  await page.getByTestId('prompt-input').fill('오래 걸리는 일')
  await page.getByTestId('send').click()

  await expect(mark).toHaveAttribute('data-state', 'working')
  await expect(mark).toHaveClass(/cc-orbit/)
})

/**
 * 모델 목록을 하드코딩하고 있었더니 Fable이 나왔는데 고를 수가 없었다.
 * 이제 도구의 공식 API가 주는 목록을 그대로 보여주고, 강도도 모델에 붙어서 온다.
 */
test('모델 목록은 도구가 알려주는 것을 쓰고, 강도는 지원하는 모델에만 뜬다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  const menu = page.getByTestId('settings-menu')

  // 우리가 적은 목록이 아니라 host가 준 목록이다
  await page.getByTestId('settings-open').click()
  await expect(menu).toContainText('Fable')

  /*
    모델을 골라도 메뉴는 열린 채다 (도그푸딩 요청) — 강도·속도 묶음이 고른 모델을
    따라 바뀌므로, 모델을 고른 사람의 일은 보통 아직 안 끝났다. 예전에는 여기서
    메뉴를 다시 여는 클릭이 줄마다 끼어 있었다 — 그 춤이 곧 불편의 증거였다.
  */
  // 강도를 지원하지 않는 모델에는 강도 묶음이 없다 — 아무 효과 없는 칸을 띄우면 거짓말이다
  await menu.getByTestId('settings-model-haiku').click()
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText('Effort')

  await menu.getByTestId('settings-model-fable').click()
  await expect(menu).toContainText('Effort')
  await menu.getByTestId('settings-effort-xhigh').click()
  // 강도는 그 자체로 끝인 선택이다 — 고르면 닫힌다
  await expect(menu).toBeHidden()

  const settings = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId]
  })
  expect(settings.model).toBe('fable')
  expect(settings.effort).toBe('xhigh')
})

/**
 * 응답 속도 (codex의 service_tier — 실측: gpt-5.4+에 "Fast, 1.5x speed" 하나).
 * 티어를 주는 모델에서만 묶음이 뜨고, 티어 없는 모델로 바꾸면 값도 함께 초기화된다.
 */
test('속도(Fast)는 티어를 주는 모델에서만 뜨고, 고른 값이 세션에 남는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 티어는 codex의 것 — codex 세션을 만든다 (세션 메뉴에는 도구 바꾸기가 없다)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  const menu = page.getByTestId('settings-menu')
  // 모델을 고르면 메뉴가 열린 채라 Speed 묶음이 그 자리에서 이어진다
  await pickSetting(page, 'settings-model-gpt-5.6-terra')
  await expect(menu).toContainText('Speed')
  await menu.getByTestId('settings-tier-priority').click()

  const tier = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].serviceTier
  })
  expect(tier).toBe('priority')

  // 티어 없는 모델로 바꾸면 묶음이 없고 값도 초기화된다 — 지원하지 않는 조합이 조용히 남으면 안 된다
  await pickSetting(page, 'settings-model-gpt-5.6-terra-mini')
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText('Speed')
  const tier2 = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].serviceTier
  })
  expect(tier2).toBeNull()
})

/** 모델을 바꾸면 강도는 초기화된다 — 모델마다 단계가 달라서 옛 값이 남으면 안 된다 */
test('모델을 바꾸면 추론 강도가 초기화된다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  await pickSetting(page, 'settings-model-fable')
  await pickSetting(page, 'settings-effort-max')
  await pickSetting(page, 'settings-model-sonnet')

  // sonnet에는 max가 없다 — 남겨두면 지원하지 않는 조합이 조용히 유지된다
  const effort = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].effort
  })
  expect(effort).toBeNull()
})

/*
 * 앱을 다시 켜면 설정이 초기화된 것처럼 보였다 (이슈 #37).
 *
 * 저장은 처음부터 멀쩡했다 — DB에도 host 목록에도 고른 값이 그대로 있었다.
 * 초기화된 건 화면이었다: 시작 경로가 목록에서 강도만 집어 오고 모델·권한은
 * 기본값으로 채워서, 입력창 아래 버튼이 "Default · Normal"이라고 말했다.
 * 그래서 여기서는 스토어 값이 아니라 **버튼이 읽어주는 글자**를 본다.
 */
test('앱을 다시 켜도 고른 모델과 권한이 그대로 보인다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  await pickSetting(page, 'settings-model-fable')
  await pickSetting(page, 'settings-effort-high')
  await pickSetting(page, 'settings-preset-auto')
  await expect(page.getByTestId('settings-open')).toHaveText(/Fable · high · Auto/)

  /*
   * 앱을 다시 켠 것과 같다: host(mock)는 그대로 살아 있고, 스토어만 목록을 받아
   * 세션 요약을 처음부터 다시 세운다 — 재시작이 실제로 도는 경로가 이 attach다.
   */
  await page.evaluate(async () => {
    const w = window as any
    await w.__store.getState().attach(w.__mock)
  })

  await expect(page.getByTestId('settings-open')).toHaveText(/Fable · high · Auto/)
})

/** 펼침 표시는 접힘=오른쪽, 펼침=아래쪽. 같은 글리프를 돌려서 두 상태가 어긋나지 않게 한다 */
test('파일 트리 폴더 화살표가 열고 닫힐 때 방향을 바꾼다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'src', path: 'src', isDir: true, ignored: false }]
    m.fsState.entries['src'] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-files').click()

  const dir = page.getByTestId('dir-src').locator('svg')
  await expect(dir).not.toHaveClass(/rotate-90/)

  await page.getByTestId('dir-src').click()
  await expect(dir).toHaveClass(/rotate-90/)

  await page.getByTestId('dir-src').click()
  await expect(dir).not.toHaveClass(/rotate-90/)
})

/**
 * 상단 바는 macOS 신호등 버튼과 같은 축에 있어야 한다.
 *
 * 버튼 위치는 tauri.conf.json의 trafficLightPosition으로 우리가 정하고,
 * **바 높이와의 관계**는 tooling/styles.test.ts가 검사한다.
 * 여기서는 브라우저가 볼 수 있는 것만 본다: 바 안에서 글자가 가운데인가.
 * 안쪽에 패딩을 더하다 보면 소리 없이 어긋나는데, 그때 여기서 걸린다.
 */
test('상단 바 안에서 제목이 세로 가운데에 선다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const bar = page.getByTestId('app-header')
  const box = (await bar.boundingBox())!
  // 아래 테두리 1px까지
  expect(box.height).toBeLessThanOrEqual(37)
  expect(box.y).toBe(0)

  // 글자도 그 안에서 가운데여야 한다 (위아래 여백 차이가 1px 이내)
  const text = (await page.getByTestId('app-title').boundingBox())!
  const top = text.y - box.y
  const bottom = box.y + box.height - (text.y + text.height)
  expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1.5)
})

/**
 * 빈 입력창이 커진 채로 서 있던 문제 (도그푸딩).
 * 높이를 타이핑 이벤트에서만 계산하면, 보낸 뒤 값만 비고 높이는 남는다.
 */
test('메시지를 보낸 뒤 입력창 높이가 한 줄로 돌아온다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  const input = page.getByTestId('prompt-input')
  const oneLine = (await input.boundingBox())!.height

  await input.fill('첫 줄\n둘째 줄\n셋째 줄\n넷째 줄')
  const grown = (await input.boundingBox())!.height
  expect(grown).toBeGreaterThan(oneLine + 20)

  await page.getByTestId('send').click()
  await expect(input).toHaveValue('')

  // 값이 비었으면 높이도 한 줄이어야 한다 — 아무것도 안 쳤는데 높은 칸이 남으면 안 된다
  expect((await input.boundingBox())!.height).toBeCloseTo(oneLine, 0)
})

/**
 * 반대 방향도 값에서 나와야 한다: 자동완성이 긴 경로를 넣으면 칸도 따라 커진다.
 *
 * `fill()`은 input 이벤트를 쏘므로 옛 코드에서도 통과한다 — 그래서 **자동완성으로 고르는
 * 진짜 경로**를 쓴다. 그 길은 React 상태만 바꾸고 DOM 이벤트를 만들지 않는다.
 */
test('자동완성으로 넣은 값에도 입력창 높이가 따라온다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'a'.repeat(120) + '.ts', path: 'src/' + 'a'.repeat(120) + '.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'alpha', '작업')

  const input = page.getByTestId('prompt-input')

  await input.fill('@a')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  const beforePick = (await input.boundingBox())!.height
  await page.keyboard.press('Tab')

  // 고른 순간 값이 길어졌으니 칸도 커져야 한다
  await expect(input).not.toHaveValue('@a')
  expect((await input.boundingBox())!.height).toBeGreaterThan(beforePick)
})

/**
 * 긴 응답을 읽는 동안 "이게 뭘 물어본 답이었지"를 위로 되돌아가 찾게 하지 않는다.
 * 가상 스크롤이라 CSS sticky를 못 쓰므로 스크롤 위치로 계산해 얹는다 —
 * 그 계산이 맞는지를 여기서 본다.
 */
test('스크롤하면 지금 보고 있는 턴의 내 메시지가 위에 붙는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  const input = page.getByTestId('prompt-input')
  // 스크롤이 생길 만큼 길게 — 짧으면 지나갈 것 자체가 없다
  await input.fill('첫 번째 질문\n' + '내용\n'.repeat(40))
  await page.getByTestId('send').click()
  // 두 번째도 길게 — 아래 내용이 화면 하나를 넘어야 첫 번째가 '완전히 지나간' 상태가 된다
  await input.fill('두 번째 질문\n' + '내용\n'.repeat(40))
  await page.getByTestId('send').click()

  const stream = page.getByTestId('chat-stream')

  /*
    **먼저 자리를 잡을 때까지 기다린다.** 보낸 직후에는 아직 바닥으로 내려가는 중이라,
    그 전에 맨 위로 올리면 뒤늦게 도착한 자동 스크롤이 우리를 다시 바닥으로 데려간다 —
    그러면 "맨 위인데 왜 붙어 있냐"로 보이지만 사실은 맨 위가 아니었다.
    (전체 스위트에서 간헐적으로 그렇게 실패했다.)
  */
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(80)

  /*
    맨 위에서는 붙일 것이 없다 (내 메시지가 아직 화면 위로 지나가지 않았다).

    **기다렸다가 본다.** 가상 스크롤은 줄 높이를 다음 프레임에 재고, 그 측정이
    끝나야 "무엇이 위로 지나갔나"가 확정된다. 곧바로 단언하면 측정이 끝나기 전
    한 프레임을 잡아 간헐적으로 실패한다 (전체 스위트에서 실제로 그랬다).
  */
  await stream.evaluate((el) => (el.scrollTop = 0))
  await expect(page.getByTestId('sticky-user')).toBeHidden({ timeout: 3000 })

  /*
    아래로 내리면 지나간 내 메시지가 붙는다.
    어느 것이 붙는지는 "완전히 지나갔는가"로 정해지고 그건 줄 높이에 달렸다 —
    테스트가 그 산수를 따라 하면 레이아웃이 조금만 바뀌어도 깨진다.
    여기서 지킬 계약은 둘이다: 맨 위에선 안 뜬다, 내리면 내가 한 말이 뜬다.
  */
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(page.getByTestId('sticky-user')).toBeVisible()
  await expect(page.getByTestId('sticky-user')).toContainText(/작업|첫 번째 질문/)

  /*
    **띠는 말풍선과 같은 자리, 같은 폭을 갖는다.**

    전체 폭이던 시절 도그푸딩에서 "위에 딱 안 붙었다"고 읽혔다. 실측하면 천장과의
    간격은 0px였고(확대 0.9~1.2 전부), 떨어져 보이게 한 것은 위치가 아니라 모양이었다 —
    오른쪽 75% 말풍선이 갑자기 좌우 끝까지 뻗으면 내 말이 아니라 머리말 아래 떠 있는
    도구 띠로 보인다. 그래서 두 가지를 계약으로 남긴다: 오른쪽 끝이 같을 것,
    75%를 넘지 않을 것. (등장 애니메이션이 끝난 뒤에 잰다 — 도는 동안은 몇 px 아래다.)
  */
  await page.evaluate(
    () =>
      new Promise<void>((r) => {
        const el = document.querySelector('[data-testid="sticky-user"] .cc-hang')
        void Promise.all((el?.getAnimations?.() ?? []).map((a) => a.finished.catch(() => {}))).then(() => r())
      }),
  )
  const shape = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="chat-stream"]') as HTMLElement
    const btn = document.querySelector('[data-testid="sticky-user"] button') as HTMLElement
    const cs = getComputedStyle(s)
    const rowWidth = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const b = btn.getBoundingClientRect()
    return {
      gapFromCeiling: Math.round(b.top - s.getBoundingClientRect().top),
      rightInset: Math.round(s.getBoundingClientRect().right - parseFloat(cs.paddingRight) - b.right),
      widthRatio: b.width / rowWidth,
    }
  })
  /*
    이제 **일부러 6px 떠 있다** (SessionView의 -top-[10px] 주석 — 딱 붙이기는 실제
    WKWebView의 합성 반올림에 두 번 졌고, 실금을 디자인 간격 안에 삼키는 쪽으로
    바꿨다). 계약은 "의도한 간격 근처(4~8px)"다 — 0이면 붙이기로 회귀한 것이고,
    크면 떠내려간 것이다.
  */
  expect(shape.gapFromCeiling).toBeGreaterThanOrEqual(4)
  expect(shape.gapFromCeiling).toBeLessThanOrEqual(8)
  expect(shape.rightInset).toBe(0)
  expect(shape.widthRatio).toBeLessThanOrEqual(0.76)

  /*
    배너가 말하는 동안 원본은 숨는다 (도그푸딩: "같은 말이 두 번 보인다").
    배너 자체가 흐름에 자리를 차지해 리스트를 밀어내므로, "완전히 지나갔다"고
    판정된 원본이 배너 밑으로 되밀려 내려와 보였다. visibility로 숨겨 자리는
    지키되 눈에는 안 보이게 한다.

    조금씩 내리며 배너가 '첫 번째 질문'을 잡는 지점을 찾는다 — 그 지점에서는
    원본 줄이 화면 가장자리(오버스캔)에 아직 렌더되어 있어 둘을 함께 볼 수 있다.
  */
  /*
    잘게 나눠 내리면 안 된다: 아직 안 잰 줄은 추정 높이로 좌표가 잡혀 있다가
    화면에 들어오는 순간 실측으로 바뀌며 좌표가 통째로 밀린다 — 그 순간을 폴링이
    잡으면 "붙었다"가 한 프레임 뒤에 "안 붙었다"로 뒤집힌다 (실제로 그랬다).
    방금 바닥까지 다녀왔으므로 모든 줄은 실측 완료 — 그 지오메트리로 한 번에 간다.
  */
  await stream.evaluate((el) => (el.scrollTop = 0))
  const q1End = await stream.evaluate((el) => {
    const rows = [...el.querySelectorAll('div[data-index]')] as HTMLElement[]
    const row = rows.find((r) => (r.textContent ?? '').includes('첫 번째 질문'))!
    const y = new DOMMatrixReadOnly(getComputedStyle(row).transform).m42
    return y + row.offsetHeight
  })
  // +80: 배너가 흐름에 자리를 차지하며 리스트를 제 키만큼 밀어내는 것을 넉넉히 덮는다
  await stream.evaluate((el, y) => (el.scrollTop = y + 80), q1End)
  await expect(page.getByTestId('sticky-user')).toContainText('첫 번째 질문')
  // 원본 줄은 화면 가장자리(오버스캔)에 아직 렌더되어 있다 — 렌더는 되지만 보이지 않아야 한다
  await expect
    .poll(() =>
      stream.evaluate((el) => {
        const rows = [...el.querySelectorAll('div[data-index]')] as HTMLElement[]
        const row = rows.find((r) => (r.textContent ?? '').includes('첫 번째 질문'))
        return row ? getComputedStyle(row).visibility : 'gone'
      }),
    )
    .toBe('hidden')

  /*
    누르면 펼쳐진다 — 전문은 접힌 줄 위에 **겹쳐서** 나온다. 흐름에서 키를 키우면
    아래 가상 스크롤 좌표가 통째로 밀리기 때문에, 접힌 줄의 자리는 그대로여야 한다.
  */
  const collapsed = page.getByTestId('sticky-user').getByRole('button').first()
  const collapsedBox = (await collapsed.boundingBox())!
  await collapsed.click()
  const expanded = page.getByTestId('sticky-user-expanded')
  await expect(expanded).toBeVisible()
  // 여러 줄이 펼쳐졌고(접힌 한 줄보다 확실히 크다), 접힌 줄의 자리는 안 변했다
  expect((await expanded.boundingBox())!.height).toBeGreaterThan(collapsedBox.height * 2)
  // 정확 일치가 아니라 근사 — WebKit이 같은 줄을 39.125 vs 39.12499237로 답해 플레이크가 났다 (실측 2회)
  expect((await collapsed.boundingBox())!.height).toBeCloseTo(collapsedBox.height, 1)
  // 다시 누르면 접힌다
  await expanded.click()
  await expect(page.getByTestId('sticky-user-expanded')).toBeHidden()
})

/**
 * 에이전트가 내놓은 이미지 (#40) — 스크린샷·이미지 Read가 대화에 실제로 보인다.
 * 저장하지 않는다는 결정(표시 전용, 2026-08-24)은 kind 맵(null)이 지키고,
 * 여기서 보는 계약은 둘이다: 이미지는 그려진다, 못 그린 이미지는 조용한 공백이
 * 아니라 이유 있는 상자다.
 */
test('에이전트가 보낸 이미지가 대화에 그려진다 — 실패는 이유를 말한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(
    () => (window as never as { __store: any }).__store.getState().focusedSessionId,
  )
  // 8×8 픽셀짜리 진짜 PNG — 가짜 문자열이면 "그려졌다"를 잴 수 없다
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFtFEIAJ2yAhH+Iz4jAAAAAElFTkSuQmCC'
  await page.evaluate(
    ({ sid, png }: { sid: string; png: string }) => {
      const mock = (window as never as { __mock: any }).__mock
      mock.emit({
        type: 'message_image',
        sessionId: sid,
        mime: 'image/png',
        data: png,
        path: '/tmp/shot.png',
      })
      mock.emit({
        type: 'message_image',
        sessionId: sid,
        mime: '',
        data: '',
        path: '/tmp/big.png',
        note: '이미지가 너무 큽니다 (12MB)',
      })
    },
    { sid: id, png: PNG },
  )
  const img = page.getByTestId('msg-image').locator('img')
  await expect(img).toBeVisible()
  // 실제로 디코드됐는지 본다 — 소스가 깨졌으면 naturalWidth는 0이다
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByTestId('msg-image-missing')).toContainText('너무 큽니다')
  await expect(page.getByTestId('msg-image-missing')).toContainText('/tmp/big.png')

  /*
   * 영속 (#40 2차 결정: 표시만 → 남긴다, 총량 500MB). 메모리의 대화를 버리고
   * 기록에서 강제로 다시 읽어도 이미지가 되살아나야 한다 — 재시작이 걷는 길과 같다.
   */
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid, true)
  }, id)
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByTestId('msg-image-missing')).toContainText('너무 큽니다')
})

/** 경로를 외워서 치지 않아도 되게 — 트리에서 끌어다 입력창에 놓는다 */
test('파일 트리에서 끌어다 놓으면 입력창에 @경로가 들어간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-tab-files').click()

  await page.getByTestId('prompt-input').fill('이거 봐줘')
  await page.dragAndDrop('[data-testid="file-src/a.ts"]', '[data-testid="input-dropzone"]')

  // 자동완성이 넣는 것과 같은 모양이어야 한다
  await expect(page.getByTestId('prompt-input')).toHaveValue('이거 봐줘 @src/a.ts ')
})

/**
 * 같은 델타가 여러 번 적용되던 문제 (도그푸딩: "호호스트가스트가...").
 *
 * attach가 구독을 끊지 않아서, 두 번 붙으면 이벤트가 두 번 적용됐다.
 * 스트리밍 델타는 누적이라 한 번 어긋나면 그 뒤가 전부 어긋난다.
 */
test('두 번 붙여도 스트리밍 글자가 곱해지지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 앱이 다시 붙는 상황(호스트 재연결·재마운트)을 그대로 재현한다
  await page.evaluate(async () => {
    const s = (window as any).__store.getState()
    await s.attach(s.platform)
  })

  // 델타를 한 번만 흘린다 — 구독이 겹쳤다면 화면에는 두 번 쌓인다
  await page.evaluate(() => {
    const s = (window as any).__store.getState()
    ;(window as any).__mock.emit({
      type: 'message_delta',
      sessionId: s.focusedSessionId,
      role: 'assistant',
      text: '가나다',
    })
  })

  const reply = page.getByTestId('msg-assistant').last()
  await expect(reply).toHaveText('가나다')
})

/**
 * 바닥에 붙어 있으면 스트리밍 응답을 따라 내려간다.
 *
 * 스트리밍은 **항목 수가 안 늘고 마지막 항목이 길어진다.** 그래서 항목 수를
 * 기준으로 삼으면 답이 길어지는 동안 화면이 멈춘다 — 총 높이를 봐야 두 경우가
 * 한 기준으로 묶인다.
 *
 * 주의: 이 테스트는 mock 위에서 **옛 로직으로도 통과한다.** 브라우저의 스크롤
 * 앵커링이 가려주는 것으로 보인다. 그래서 이건 회귀를 잡는 그물이 아니라
 * "따라 내려간다"는 계약을 적어둔 것이다 — 실제 증상은 앱에서 확인해야 한다.
 */
test('바닥에 있으면 길어지는 응답을 따라 내려간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  const stream = page.getByTestId('chat-stream')
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))

  // 항목 하나가 길어지기만 한다 — 개수는 그대로다
  // 화면을 확실히 넘기도록 충분히 길게 — 안 넘으면 스크롤 자체가 없어 검사가 무의미하다
  for (let i = 0; i < 150; i++) {
    await page.evaluate((n) => {
      const s = (window as any).__store.getState()
      ;(window as any).__mock.emit({
        type: 'message_delta',
        sessionId: s.focusedSessionId,
        role: 'assistant',
        text: `line ${n}\n`,
      })
    }, i)
  }

  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 3000,
    })
    .toBeLessThan(40)
})

/**
 * 아이콘만 있는 버튼은 **무슨 버튼인지 물어볼 방법**이 있어야 한다.
 * 하나씩 만들면 어떤 건 툴팁이 있고 어떤 건 없는 상태가 된다 — 실제로 그랬다.
 */
test('아이콘 버튼은 호버하면 설명이 뜬다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('send').hover()
  await expect(page.getByRole('tooltip')).toContainText('Send')

  await page.getByTestId('restart-session').hover()
  await expect(page.getByRole('tooltip')).toContainText('Restart')

  // 마우스뿐 아니라 포커스에도 떠야 한다 — 키보드로만 도는 사람에게도 같은 정보가 필요하다
  await page.getByTestId('restart-session').focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
})

/**
 * host가 죽으면 수퍼바이저가 다시 띄우지만, 새 host는 살아 있던 에이전트를
 * 하나도 모른다 — 프로세스가 함께 죽었기 때문이다. 그래서 화면에는 세션이 전부
 * 잠든 채로 남았고 사람이 하나씩 눌러 깨워야 했다.
 * 무엇이 돌고 있었는지는 UI가 아니까, 그걸 근거로 되살린다.
 */
test('끊겼다 돌아오면 돌던 세션이 스스로 되살아난다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // host가 죽었다: 프로세스가 사라지고 연결이 끊긴다
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.sessions.get(sid).live = false
    m.setConnectionState('disconnected')
  }, id)
  await expect
    .poll(async () => page.evaluate(() => (window as any).__store.getState().connection))
    .not.toBe('connected')

  // 수퍼바이저가 다시 띄웠다
  await page.evaluate(() => (window as any).__mock.setConnectionState('connected'))

  /*
    UI의 live 플래그는 끊긴 뒤에도 낡은 채로 true라 그것만 보면 아무것도 검사하지 못한다.
    **host 쪽 실제 상태**가 다시 살아났는지를 본다 — 되살리기가 정말 일어났다는 증거다.
  */
  await expect
    .poll(async () => page.evaluate((sid) => (window as any).__mock.sessions.get(sid).live, id), {
      timeout: 5000,
    })
    .toBe(true)
})

/** 다른 프로젝트의 세션으로 옮기면 파일 트리도 따라가야 한다 */
test('프로젝트를 바꾸면 파일 트리도 바뀐다', async ({ page }) => {
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

  // 두 번째 프로젝트는 다른 파일을 갖는다
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
 * 숫자만 있고 단위가 없는 표식은 "이게 뭐지?"가 나온다 (실제로 나왔다).
 * 브라우저 기본 title은 1~2초를 기다려야 떠서, 그 순간에는 없는 것과 같다.
 */
test('프로젝트 표식은 호버하면 무엇인지 알려준다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
    ]
  })
  // 변경 수는 프로젝트 목록에서 온다 — 다시 읽게 한다
  await page.evaluate(() => (window as any).__store.getState().refreshProjects?.())

  const mark = page.getByTestId('mark-changed-alpha')
  if (await mark.count()) {
    await mark.hover()
    await expect(page.getByRole('tooltip')).toContainText('uncommitted')
  }

  // 동시 세션 경고는 데이터 유실 위험이라 무엇인지 반드시 읽혀야 한다
  await newSession(page, 'alpha', 'one')
  await newSession(page, 'alpha', 'two')
  await page.getByTestId('concurrent-alpha').hover()
  await expect(page.getByRole('tooltip')).toContainText('same folder')
})

/** 사이드바 순서는 사람이 정한다 — 끌어서 옮기고, 다시 켜도 그대로여야 한다 */
test('세션을 끌어서 순서를 바꾼다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  const order = async () =>
    page.evaluate(() => {
      const s = (window as any).__store.getState()
      return Object.values(s.sessions).map((x: any) => x.name)
    })
  expect(await order()).toEqual(['first', 'second'])

  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))
  await page.dragAndDrop(`[data-testid="session-row-${ids[1]}"]`, `[data-testid="session-row-${ids[0]}"]`, {
    targetPosition: { x: 10, y: 2 }, // 위쪽 절반에 놓으면 앞으로 간다
  })

  await expect.poll(order).toEqual(['second', 'first'])
})

test('프로젝트를 끌어서 순서를 바꾼다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })

  const order = async () =>
    page.evaluate(() => Object.values((window as any).__store.getState().projects).map((p: any) => p.name))
  expect(await order()).toEqual(['alpha', 'beta'])

  await page.dragAndDrop('[data-testid="project-header-beta"]', '[data-testid="project-alpha"]', {
    targetPosition: { x: 10, y: 2 },
  })

  await expect.poll(order).toEqual(['beta', 'alpha'])
})

/**
 * 사이드바의 + 와 ✕ 는 같은 세로줄에 선다.
 *
 * 눈으로만 맞추면 한쪽 여백을 고칠 때 다시 어긋난다 — 실제로 4px과 12px로
 * 벌어져 있었다. 오른쪽 끝의 실제 좌표를 재서 못 박는다.
 */
test('사이드바의 프로젝트 메뉴와 삭제 버튼이 같은 세로줄에 선다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 둘 다 호버해야 나타난다 — 프로젝트 줄의 메뉴도 이제 감춰져 있다
  await page.getByTestId('project-header-alpha').hover()
  await page.getByTestId(`session-row-${id}`).hover()

  const plus = (await page.getByTestId('project-menu-alpha').boundingBox())!
  const dots = (await page.getByTestId(`session-menu-${id}`).boundingBox())!

  expect(Math.abs(plus.x + plus.width - (dots.x + dots.width))).toBeLessThanOrEqual(1)
})

/**
 * 세션 이름을 사람이 바꾼다 (이슈 #5).
 *
 * 자동 이름은 첫 프롬프트를 잘라 쓴다. 재개·불러오기로 만든 세션은 첫 마디가 다 같아서
 * `This session is being continued…`짜리 세션이 목록에 넷씩 나란히 섰다 —
 * 이름으로는 아무것도 못 고르고 본문을 뒤져야 했다.
 */
test('사이드바에서 세션 이름을 바꾼다 — 그 뒤 자동 이름이 덮지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'This session is being continued from a previous conversation')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const row = page.getByTestId(`session-row-${id}`)
  await expect(row).toContainText('This session is being continued')

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`rename-session-${id}`).click()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('가드 MCP')
  await input.press('Enter')

  await expect(page.getByTestId(`session-row-${id}`)).toContainText('가드 MCP')

  // 자동 이름이 다시 덮으면 안 된다 — 도구가 제목을 알려와도 사람이 정한 이름이 이긴다
  await emitEvent(page, 0, { type: 'session_title', title: 'This session is being continued…', auto: true })
  await expect(page.getByTestId(`session-row-${id}`)).toContainText('가드 MCP')
})

test('이름 고치다 Escape를 누르면 옛 이름이 그대로다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '원래 이름')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 이름을 두 번 누르는 것도 같은 입구다 (탭 이름의 관행)
  await page.getByTestId(`session-row-${id}`).dblclick()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('버린 이름')
  await input.press('Escape')

  await expect(page.getByTestId(`session-row-${id}`)).toContainText('원래 이름')
})

/**
 * **조용한 실패를 만들지 않는다.** 이름 바꾸기가 실패했는데 목록만 새 이름으로
 * 바뀌면, 다음에 목록을 다시 받는 순간 아무 설명 없이 되돌아간다.
 */
test('이름 바꾸기가 실패하면 목록은 그대로 두고 사람에게 알린다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '원래 이름')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // host가 거절하는 상황을 만든다 — 세션이 사라진 뒤에 이름을 고치는 것이 실제 경로다
  await page.evaluate((sid: string) => {
    ;(window as any).__mock.sessions.delete(sid)
  }, id)

  await page.getByTestId(`session-row-${id}`).dblclick()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('새 이름')
  await input.press('Enter')

  await expect(page.getByTestId('toast')).toContainText('Could not rename')
  await expect(page.getByTestId(`session-row-${id}`)).toContainText('원래 이름')
})

/** 입력창의 첨부·보내기도 같은 부품이라 크기와 높이가 같아야 한다 */
test('입력창의 첨부와 보내기 버튼이 같은 크기·같은 높이다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  const attach = (await page.getByTestId('attach-open').boundingBox())!
  const send = (await page.getByTestId('send').boundingBox())!

  expect(Math.abs(attach.width - send.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(attach.height - send.height)).toBeLessThanOrEqual(1)
  // 아래쪽 끝이 같은 줄에 선다 (입력창이 커져도 나란히 남는다)
  expect(Math.abs(attach.y + attach.height - (send.y + send.height))).toBeLessThanOrEqual(1)
})

/**
 * 놓을 자리 표시가 목록을 밀면 안 된다.
 *
 * border로 그리면 요소가 1px 커져서, 표시가 줄을 옮길 때마다 목록 전체가 밀린다 —
 * 끌고 다니면 딸깍딸깍 튀고, 손이 노리는 지점도 계속 움직인다.
 */
test('끌어서 옮기는 동안 목록이 밀리지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))

  const rowBox = async () => (await page.getByTestId(`session-row-${ids[1]}`).boundingBox())!
  const before = await rowBox()

  // 놓기 표시가 켜진 상태를 만든다 (dragover만 발생시킨다)
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="session-row-${id}"]`)!.parentElement!
    const dt = new DataTransfer()
    dt.setData('application/x-cc-session', 'other')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }),
    )
  }, ids[0])

  const after = await rowBox()
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5)
})

/**
 * 그리드 — 여러 세션을 한 화면에서.
 *
 * 사양서 §5.4가 v1에서 보류했던 그리드다. 되살리면서 지킨 것:
 * 패널이 최소 폭 아래로 내려가지 않게 열 수를 폭에서 계산하고,
 * 칸은 포커스 뷰와 **같은 부품**을 써서 설정이 갈라지지 않게 한다.
 */
test('세션을 끌어다 놓으면 그리드에 올라간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')

  // 끌어온 김에 화면까지 열린다 — 열고 다시 끌면 두 번 일이다
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  // 우측 증거 패널은 없다 (§5.4: 한 레인 더 떼면 패널이 최소 폭 아래로 간다)
  await expect(page.getByTestId('evidence-panel')).toBeHidden()
})

test('그리드 칸과 포커스 뷰가 같은 설정을 본다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  // 그리드 칸에서 모델을 바꾸고
  await pickSetting(page, 'settings-model-opus', page.getByTestId(`grid-panel-${id}`))

  // 포커스 뷰로 돌아오면 그대로여야 한다 — 복사본이면 여기서 갈라진다
  // (나가는 방법은 '다른 것을 고르는 것'이다. 그리드 버튼은 토글이 아니다)
  await page.getByTestId(`session-row-${id}`).click()
  // 지금 값은 메뉴를 열지 않아도 버튼에 적혀 있다
  await expect(page.getByTestId('settings-open')).toContainText('Opus')
})

test('그리드에서 빼도 세션은 사이드바에 남는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await page.getByTestId(`grid-remove-${id}`).click()

  await expect(page.getByTestId(`grid-panel-${id}`)).toBeHidden()
  // 화면에서만 내린 것이다 — 세션은 그대로 돌아간다
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
})

/**
 * 그리드 칸에 대화가 쌓여도 입력창은 자리를 지켜야 한다 (도그푸딩).
 *
 * flex 자식의 min-height 기본값은 auto라 내용보다 작아지지 못한다. 그래서 대화가
 * 길어지면 칸이 통째로 늘어나 입력창을 칸 밖으로 밀어냈다 — "쭉 내려가다 멈추고
 * 입력창이 안 나온다"가 그 증상이다. 칸 높이가 정해진 그리드에서 먼저 드러났다.
 */
test('그리드 칸은 대화가 길어져도 입력창을 밀어내지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 칸 높이를 확실히 넘기는 분량
  await page.evaluate((sid) => {
    const store = (window as any).__store
    const items = Array.from({ length: 60 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      text: `긴 대화 ${i}`,
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  // 입력창이 칸 **안에** 있어야 한다. 보이기만 해서는 부족하다 — 밀려난 것도 '보인다'
  const composer = panel.getByTestId('prompt-input')
  await expect(composer).toBeVisible()
  const box = (await composer.boundingBox())!
  const card = (await panel.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(card.y + card.height + 1)
})

/**
 * 그리드를 열어둔 채 다른 세션을 골라도 화면이 그대로였다 (도그푸딩).
 * 고른 것은 바뀌었는데 보이는 것이 안 바뀌면, 누른 사람에게는 아무 일도 안 일어난 것이다.
 */
test('그리드에서 세션을 고르면 그 세션으로 넘어간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  await page.getByTestId(`session-row-${ids[0]}`).click()
  await expect(page.getByTestId('grid')).toBeHidden()
  await expect(page.getByTestId('session-view')).toBeVisible()
})

/**
 * 칸을 열면 **최신 대화가 먼저** 보여야 한다 (도그푸딩:
 * "스크롤이 아래에서부터 시작하는 게 아니라 위에서부터 시작해서 쭉 내려가다 이상해진다").
 *
 * 원인은 입력창이 밀려난 것과 같았다. 대화 영역이 줄어들지 못하고 내용만큼 늘어나면
 * scrollHeight와 clientHeight가 같아진다 — **스크롤이 아예 성립하지 않는다.**
 * 그래서 두 가지를 함께 본다: 정말 스크롤되는가, 그리고 바닥에 서 있는가.
 */
test('그리드 칸을 열면 최신 대화가 먼저 보인다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid) => {
    const store = (window as any).__store
    const items = Array.from({ length: 80 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      text: `긴 대화 ${i} `.repeat(6),
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  const box = await page
    .getByTestId(`grid-panel-${id}`)
    .getByTestId('chat-stream')
    .evaluate((el) => ({
      top: el.scrollTop,
      h: el.scrollHeight,
      c: el.clientHeight,
    }))
  // 칸 안에서 스크롤이 성립해야 한다 (늘어나 버리면 이 둘이 같아진다)
  expect(box.h).toBeGreaterThan(box.c)
  // 그리고 맨 아래에 서 있어야 한다
  expect(box.h - box.c - box.top).toBeLessThanOrEqual(40)
})

/**
 * "아래에 공간이 있어도 안 늘어나서 보기 불편하다" (도그푸딩).
 * 높이를 52vh로 못박아 뒀더니 칸이 하나여도 아래가 비었다.
 * 줄 높이를 minmax(최소, 1fr)로 두면 남는 공간을 칸이 나눠 갖는다.
 */
test('그리드 칸은 남는 세로 공간을 채운다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  const card = (await panel.boundingBox())!
  const area = (await page.getByTestId('grid').boundingBox())!
  // 여백(p-2)을 빼면 화면을 거의 다 쓴다 — 아래가 남으면 안 된다
  expect(card.height).toBeGreaterThan(area.height - 24)
})

/**
 * 그리드는 스크롤하지 않는다.
 * 아래에 더 있을지 모른다면 그건 목록이지 관제탑이 아니다 —
 * 화면에 있는 것이 전부여야 "한눈에 본다"가 성립한다.
 */
test('칸이 많아져도 화면에 딱 맞고 스크롤이 생기지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const ids: string[] = []
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await newSession(page, 'alpha', name)
    ids.push(await page.evaluate(() => (window as any).__store.getState().focusedSessionId))
  }
  await page.evaluate((list) => (window as any).__store.getState().setGridPanels(list), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[4]}`)).toBeVisible()

  const scroll = await page.getByTestId('grid').evaluate((el) => ({
    h: el.scrollHeight,
    c: el.clientHeight,
  }))
  expect(scroll.h).toBeLessThanOrEqual(scroll.c + 1)

  // 마지막 칸까지 화면 안에 들어와 있다
  const area = (await page.getByTestId('grid').boundingBox())!
  const last = (await page.getByTestId(`grid-panel-${ids[4]}`).boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(area.y + area.height + 1)
})

/**
 * "대화를 드래그하면 칸이 이동해서 텍스트 선택이 안 된다" (도그푸딩).
 * draggable인 조상이 있으면 브라우저가 그 안의 글자를 못 고르게 한다.
 */
test('그리드 칸에서 대화 텍스트를 고를 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({
      chat: {
        ...store.getState().chat,
        [sid]: [{ kind: 'assistant', seq: 1, text: '고를 수 있어야 하는 문장' }],
      },
    })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  // 끌기 시작을 막는 조상이 없어야 한다
  const draggableAncestor = await panel.getByTestId('chat-stream').evaluate((el) => {
    for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
      if (n.getAttribute('draggable') === 'true') return n.getAttribute('data-testid') ?? 'unknown'
    }
    return null
  })
  expect(draggableAncestor).toBeNull()
})

/**
 * "세션 패널 탭으로 드래그하면 창 자체가 이동한다" (도그푸딩).
 * 포커스 뷰에서는 머리글이 곧 타이틀바지만, 그리드 칸에서는 아니다.
 */
test('그리드 칸의 머리글을 끌어도 앱 창이 움직이지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const header = page.getByTestId(`grid-panel-${id}`).getByTestId('pane-header')
  await expect(header).toBeVisible()

  await page.evaluate(() => ((window as any).__mock.windowDrags = 0))
  const box = (await header.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40)
  await page.mouse.up()

  expect(await page.evaluate(() => (window as any).__mock.windowDrags)).toBe(0)
  // 대신 칸을 옮기는 손잡이여야 한다
  await expect(header).toHaveAttribute('draggable', 'true')
})

/**
 * "사이드바에서 직접 세션에 안 들어가면 그리드에서 대화가 안 뜬다" (도그푸딩).
 *
 * 기록 불러오기가 focusSession에만 매달려 있었다. 포커스 뷰는 고르는 것과 보는 것이
 * 같은 동작이라 티가 안 났지만, 그리드는 **고르지 않고 보는** 화면이다.
 */
test('한 번도 들어가 본 적 없는 세션도 그리드에서 대화가 뜬다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 저장소에는 기록이 있고, 화면에는 아직 안 올라온 상태 (앱을 막 켠 세션)
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.messages.set(sid, [
      {
        sessionId: sid,
        seq: 1,
        role: 'user',
        kind: 'text',
        payload: { text: '저장된 옛 질문' },
        ts: Date.now(),
      },
      {
        sessionId: sid,
        seq: 2,
        role: 'assistant',
        kind: 'text',
        payload: { text: '저장된 옛 답' },
        ts: Date.now(),
      },
    ])
    const store = (window as any).__store
    store.setState({ chat: {}, focusedSessionId: null })
  }, id)

  // 사이드바를 거치지 않고 곧바로 그리드에 올린다
  await page.evaluate((sid) => (window as any).__store.getState().setGridPanels([sid]), id)
  await page.getByTestId('grid-button').click()

  await expect(page.getByTestId(`grid-panel-${id}`)).toContainText('저장된 옛 답')
})

/**
 * 그리드 칸의 '치우기'와 '재시작'이 크기도 높이도 따로 놀았다 (도그푸딩).
 * 치우기만 칸 위에 절대좌표로 얹혀 있었기 때문이다 — 다른 흐름에 있으면 맞을 리가 없다.
 * 같은 줄에 넣으면 맞출 것 자체가 없어진다.
 */
test('그리드 칸의 재시작과 치우기 버튼이 같은 크기·같은 줄에 선다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  const restart = (await panel.getByTestId('restart-session').boundingBox())!
  const remove = (await page.getByTestId(`grid-remove-${id}`).boundingBox())!

  expect(Math.abs(restart.width - remove.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(restart.height - remove.height)).toBeLessThanOrEqual(1)
  // 세로 중심이 같은 줄에 선다
  expect(Math.abs(restart.y + restart.height / 2 - (remove.y + remove.height / 2))).toBeLessThanOrEqual(1)
})

/**
 * 그리드 버튼은 토글이 아니라 선택이다.
 * 껐다 켜는 스위치로 두면 "이전 화면 위에 잠깐 덮은 것"처럼 읽힌다 — 실제로 그렇게 오해를 샀다.
 */
test('그리드 버튼은 눌러도 꺼지지 않는다 — 나가려면 다른 것을 고른다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // 한 번 더 눌러도 머문다
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // 나가는 방법은 다른 것을 고르는 것뿐
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('grid')).toBeHidden()
})

/**
 * "A에 쓰던 글이 B의 입력창에 앉아 있다" — 그대로 보내면 엉뚱한 세션에 간다 (실측 확인).
 * 원인은 쓰다 만 글이 세션이 아니라 화면의 그 자리에 붙어 있던 것.
 */
test('쓰다 만 글은 세션을 따라다니지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'second')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId(`session-row-${a}`).click()
  await page.getByTestId('prompt-input').fill('A에게 하려던 말')

  // B의 입력창은 비어 있어야 한다
  await page.getByTestId(`session-row-${b}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('')

  // A로 돌아오면 쓰던 글이 그대로 있어야 한다
  await page.getByTestId(`session-row-${a}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('A에게 하려던 말')
})

/**
 * 화면을 갈아 끼우는 그리드에서는 반대 증상이 났다 — 부품이 사라지며 글도 같이 사라졌다.
 */
test('그리드에서 쓰다 만 글은 화면을 바꿨다 돌아와도 남아 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await panel.getByTestId('prompt-input').fill('그리드에서 쓰던 글')

  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('그리드에서 쓰던 글')

  await page.getByTestId('grid-button').click()
  await expect(panel.getByTestId('prompt-input')).toHaveValue('그리드에서 쓰던 글')
})

/**
 * "세션 선택했다가 그리드 들어가도 세션 선택한 UI가 남아 있다" (도그푸딩).
 * 화면에 밝은 것이 둘이면 어느 쪽을 보고 있는지 화면이 스스로 모순된다.
 */
test('그리드에 들어가면 사이드바에서 고른 것은 그리드뿐이다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const row = page.getByTestId(`session-row-${id}`)
  await row.click()
  const focusedClass = (await row.getAttribute('class')) ?? ''

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // 세션 줄은 더 이상 골라진 모양이 아니어야 한다
  expect(await row.getAttribute('class')).not.toBe(focusedClass)
  await expect(page.getByTestId('grid-button')).toHaveAttribute('aria-pressed', 'true')

  // 돌아오면 다시 골라진 모양
  await row.click()
  expect(await row.getAttribute('class')).toBe(focusedClass)
})

/**
 * 도구 카드는 기본으로 접힌다 (도그푸딩: "배시·에딧·MCP 기본값 닫힌 상태로").
 * 몇 번만 써도 대화가 출력으로 뒤덮여 정작 답을 못 읽는다.
 */
test('도구 카드는 배시든 에딧이든 접힌 채로 나온다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'c1',
    summary: { tool: 'Bash', title: 'npm run build', readOnly: false, paths: [] },
  })
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'c1',
    ok: true,
    summary: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8',
  })

  const card = page.getByTestId('tool-card').first()
  await expect(card).toBeVisible()
  await expect(card.getByTestId('tool-card-toggle')).toHaveAttribute('aria-expanded', 'false')
  // 접혀도 무엇을 했는지는 보인다
  await expect(card).toContainText('npm run build')

  // 누르면 펴진다
  await card.getByTestId('tool-card-toggle').click()
  await expect(card.getByTestId('tool-card-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(id).toBeTruthy()
})

/**
 * 끌 때 어디에 놓일지 보여야 한다 (도그푸딩:
 * "위치 표시자가 안 보여서 탭을 드랍하면 어디에 위치할지 모르겠다").
 *
 * Playwright의 dragAndDrop은 한 번에 끝나 중간을 못 본다.
 * 그래서 드래그 이벤트를 직접 만들어 **끄는 도중**의 화면을 확인한다.
 */
test('칸을 끄는 동안 놓일 자리가 좌우로 표시된다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'a')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'b')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids), [a, b])
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()

  /** 대상 칸의 왼쪽/오른쪽 위에서 dragover를 일으킨다 */
  const hover = (side: 'left' | 'right') =>
    page.evaluate(
      ({ from, to, where }: { from: string; to: string; where: string }) => {
        const dt = new DataTransfer()
        const header = document
          .querySelector(`[data-testid="grid-panel-${from}"]`)!
          .querySelector('[data-testid="pane-header"]')!
        header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
        const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
        const r = card.getBoundingClientRect()
        const x = where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8
        card.dispatchEvent(
          new DragEvent('dragover', {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: r.top + 10,
          }),
        )
      },
      { from: a!, to: b!, where: side },
    )

  await hover('left')
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-drop', 'before')

  await hover('right')
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-drop', 'after')

  // 끌고 있는 원본은 흐려져 "이게 움직이는 중"임을 보인다
  const cls = (await page.getByTestId(`grid-panel-${a}`).getAttribute('class')) ?? ''
  expect(cls).toContain('opacity-40')

  /*
   * 끌리는 그림은 **칸**이어야 한다.
   * draggable인 요소가 머리글이라 브라우저는 기본적으로 머리글만 찍어 들고 다닌다 —
   * 칸은 제자리에 있고 얇은 띠만 따라다니니 무엇을 옮기는지 알 수 없다.
   */
  const lifted = await page.evaluate((from: string) => {
    let captured: string | null = null
    const real = DataTransfer.prototype.setDragImage
    DataTransfer.prototype.setDragImage = function (el: Element, x: number, y: number) {
      captured = (el as HTMLElement).getAttribute('data-testid')
      return real.call(this, el, x, y)
    }
    const header = document
      .querySelector(`[data-testid="grid-panel-${from}"]`)!
      .querySelector('[data-testid="pane-header"]')!
    header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: new DataTransfer(), bubbles: true }))
    DataTransfer.prototype.setDragImage = real
    return captured
  }, a!)
  expect(lifted).toBe(`grid-panel-${a}`)
})

/**
 * 오케스트레이터 — 말로 관제 (FR-11).
 * 그리드 바로 위에 선다: 둘은 같은 것을 보는 두 방식이다.
 */
test('오케스트레이터는 그리드 위에 있고 눌러서 연다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const orc = page.getByTestId('orchestrator-button')
  const cc = page.getByTestId('grid-button')
  await expect(orc).toBeVisible()

  // 순서: 오케스트레이터가 그리드보다 위
  const a = (await orc.boundingBox())!
  const b = (await cc.boundingBox())!
  expect(a.y).toBeLessThan(b.y)

  await orc.click()
  await expect(orc).toHaveAttribute('aria-pressed', 'true')
  // 처음 열면 빈 대화가 선다 — 세션은 첫 질문에서야 태어난다 (#63 지연 기동)
  await expect(page.getByTestId('orchestrator-empty')).toBeVisible()
  await expect(page.getByTestId('grid')).toBeHidden()

  // 첫 마디가 세션을 만들고, 그 뒤로는 포커스 뷰와 같은 부품이다
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('session-view')).toBeVisible()
})

/**
 * 오케스트레이터는 아직 실험 중이다 (이슈 #1).
 *
 * 표식은 **누르기 전에** 보여야 한다 — 막으려는 피해가 "모른 채 누르는 것"이라
 * 화면 안에 두면 이미 늦는다. 그리고 팔레트 규칙을 어기면 안 된다:
 * 밝히면 그리드보다 급해 보이는 거짓말이 되고, 유채색은 애초에 금지다.
 */
test('오케스트레이터 버튼은 누르기 전에 실험 중이라고 말한다 — 밝기를 쓰지 않고', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const mark = page.getByTestId('orchestrator-experimental')
  await expect(mark).toBeVisible()
  // 'Experimental'(경고) → 'Evolving'(정체성) (도그푸딩 2026-09-05): 스킬·MCP·앱을
  // 스스로 얻는 기능이라 "깨질 수 있음"보다 "자라는 중"이 진실에 가깝다
  await expect(mark).toHaveText('Evolving')

  const rgb = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number)
  const style = (testId: string, prop: string) =>
    page.getByTestId(testId).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)

  // 무채색이다 (R=G=B) — 이 앱에서 유채색은 diff 본문의 몫이다
  const markColor = rgb(await style('orchestrator-experimental', 'color'))
  expect(new Set(markColor).size).toBe(1)

  // 라벨보다 **어둡다**. 밝히면 "지금 나를 기다리는 것"의 자리를 훔친다
  const labelColor = rgb(await style('orchestrator-button', 'color'))
  expect(markColor[0]!).toBeLessThan(labelColor[0]!)

  /*
   * 이 자리에는 "테두리가 점선이다"가 있었다. 근거는 사이드바를 좁히면 글자가 잘려
   * 사라지므로 형태가 남아야 한다는 것이었는데, 재보니 글자는 잘리지 않는다 — 배지가
   * `shrink-0`이라 가장 좁은 폭에서도 그대로다. 그래서 점선을 걷어냈고, 대신 **정말로
   * 지켜야 하는 것**을 여기서 붙잡는다: 좁혀도 이 말이 화면에 남아 있는가.
   */
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setSidebarWidth(180))
  await expect(mark).toBeVisible()
  await expect(mark).toHaveText('Evolving')
})

/**
 * The grid graduated (2026-08-27, the user's call). The Experimental badge went up when the
 * view shipped ahead of its spec (issue #25); weeks of dogfooding later it is simply how
 * sessions get watched side by side, and a warning that no longer warns anyone is clutter
 * on the one lane that is always on screen. This pins the removal — and that the
 * orchestrator's badge, whose surface still earns its mark, did not vanish with it.
 */
test('the grid no longer calls itself experimental — the orchestrator still does', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await expect(page.getByTestId('grid-button')).toBeVisible()
  await expect(page.getByTestId('grid-experimental')).toHaveCount(0)
  await expect(page.getByTestId('orchestrator-experimental')).toBeVisible()
})

test('오케스트레이터를 보는 동안에는 사이드바에서 세션이 골라져 보이지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const row = page.getByTestId(`session-row-${id}`)
  await row.click()
  const selected = (await row.getAttribute('class')) ?? ''

  await page.getByTestId('orchestrator-button').click()
  await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('aria-pressed', 'true')
  expect(await row.getAttribute('class')).not.toBe(selected)

  // 돌아오면 다시 골라진 모양
  await row.click()
  expect(await row.getAttribute('class')).toBe(selected)
})

test('오케스트레이터 세션은 프로젝트 목록에 끼지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  await page.getByTestId('orchestrator-button').click()
  // 세션은 첫 마디에서 태어난다 (#63)
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('session-view')).toBeVisible()

  const orcId = await page.evaluate(() => (window as any).__store.getState().orchestratorId)
  expect(orcId).toBeTruthy()
  // 프로젝트에 속하지 않으므로 사이드바 어느 프로젝트 밑에도 줄이 없다
  await expect(page.getByTestId(`session-row-${orcId}`)).toHaveCount(0)
})

/**
 * 오케스트레이터의 `@`는 파일이 아니라 **세션**을 집는다.
 * 말로만 지목하면 이름을 잘못 짚을 수 있고, 엉뚱한 세션에 일이 가면
 * 그 프로젝트가 실제로 바뀐다.
 */
test('오케스트레이터에서 @는 세션을 집는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'readme 담당')
  await page.getByTestId('orchestrator-button').click()
  // 세션은 첫 마디에서 태어난다 (#63)
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('session-view')).toBeVisible()

  await page.getByTestId('prompt-input').fill('@readme')
  const menu = page.getByTestId('autocomplete')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('readme')
  // 파일 경로가 아니라 세션 이름이다 — 프로젝트 이름이 힌트로 붙는다
  await expect(menu).toContainText('alpha')
})

/**
 * 세션 메뉴에는 **에이전트 바꾸기가 없다** (도그푸딩 판정).
 *
 * 대화가 이어지지 않으니 거기서의 '바꾸기'는 '새 대화 시작'과 같은 말이었고,
 * 그건 세션 만들기가 이미 더 정직하게 한다. 같은 일을 하는 두 번째 문을 없앤다.
 */
test('세션 설정 메뉴에서 에이전트는 못 바꾼다 — 새로 만들면 되는 일이다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  // 모델·권한은 그대로 있다 — 저 둘은 같은 대화를 이어가며 바뀐다
  await expect(page.getByTestId('settings-menu')).toContainText('Permissions')
  await expect(page.getByTestId('settings-tool-codex')).toHaveCount(0)
  await expect(page.getByTestId('settings-menu')).not.toContainText('starts a fresh conversation')
})

/**
 * 남은 예외는 오케스트레이터 하나 — 앱에 하나뿐이라 "다른 도구로 새로 만든다"가
 * 성립하지 않는다. 자리는 앱 설정이고, 확인을 한 번 받는다.
 */
test('오케스트레이터의 에이전트는 설정에서 바꾼다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // 세션을 만들어 둔다 — 살아 있으면 그 자리에서 갈아 끼운다
  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  const orcId = await page.evaluate(() => (window as any).__store.getState().orchestratorId)

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-orchestrator').click()
  await expect(page.getByTestId('orchestrator-tool-claude')).toHaveAttribute('aria-checked', 'true')

  // 고르기만 하면 확인 창이 뜬다 — 아직 바뀌지 않는다
  await page.getByTestId('orchestrator-tool-codex').click()
  await expect(page.getByTestId('orchestrator-switch-confirm')).toContainText(
    'Details it remembers may be lost',
  )
  expect(await page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, orcId)).toBe(
    'claude',
  )

  await page.getByTestId('orchestrator-switch-cancel').click()
  expect(await page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, orcId)).toBe(
    'claude',
  )

  // 확인해야 바뀐다
  await page.getByTestId('orchestrator-tool-codex').click()
  await page.getByTestId('orchestrator-switch-confirm-btn').click()
  await expect
    .poll(async () => page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, orcId))
    .toBe('codex')

  // host가 externalId를 끊었는지 (codex에 Claude의 대화 id를 넘기면 엉뚱한 것을 잡는다)
  const ext = await page.evaluate(
    (s) => [...(window as any).__mock.sessions.values()].find((x: any) => x.id === s)?.externalId,
    orcId,
  )
  expect(ext).toBeNull()
})

/**
 * 오케스트레이터가 넣어준 말도 대화창에 나타나야 한다.
 *
 * 예전에는 사용자 메시지를 만드는 곳이 UI 하나뿐이라, UI가 자기 것을 스스로 그리는
 * 것으로 충분했다. 오케스트레이터가 두 번째 생산자가 되면서 그 가정이 깨졌다 —
 * 주입된 말은 **저장은 되는데 화면에는 영영 안 나타났다** (앱을 다시 켜야 보였다).
 */
test('남이 넣어준 말도 대화창에 뜬다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'user_message', seq: 991, text: '오케스트레이터가 시킨 일' })
  await expect(page.getByTestId('chat-stream')).toContainText('오케스트레이터가 시킨 일')
})

/**
 * 시켜서 들어온 말은 출처가 보인다 (FR-11).
 *
 * 오케스트레이터의 지시는 저장·표시까지는 됐지만 사람 말과 똑같은 말풍선이었다 —
 * "내가 이런 걸 시켰던가?"를 화면이 답하지 못했다. from이 달린 말은
 * 출처 라벨(msg-user-from)을 달고, 재시작이 걷는 복원 경로에서도 라벨이 남아야 한다.
 */
test('오케스트레이터가 시킨 말에는 출처 라벨이 붙고, 복원해도 남는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, {
    type: 'user_message',
    seq: 991,
    text: '릴리즈 노트를 정리해줘',
    from: { sessionId: 'orc-x', name: '지휘 세션' },
  })
  await expect(page.getByTestId('msg-user-from')).toContainText('지휘 세션')

  // 재시작 레그: 메모리의 대화를 버리고 기록에서 강제로 다시 읽는다
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid, true)
  }, id)
  await expect(page.getByTestId('msg-user-from')).toContainText('지휘 세션')
})

/**
 * 텍스트 일치 확정은 내 말끼리만 성립한다 — 사람이 우연히 같은 문장을 pending으로
 * 띄워 둔 순간 오케스트레이터의 지시가 오면, 흡수되어 출처 표식이 조용히 사라진다.
 */
test('사람의 같은 문장이 대기 중이어도 시킨 말은 흡수되지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('prompt-input').fill('같은 문장')
  await page.getByTestId('send').click()
  await emitEvent(page, 0, {
    type: 'user_message',
    seq: 993,
    text: '같은 문장',
    from: { sessionId: 'orc-x', name: '지휘 세션' },
  })

  // 사람 말풍선 + 출처 달린 말풍선, 둘 다 남아야 한다
  await expect(page.getByTestId('msg-user-from')).toBeVisible()
  const counts = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    const items = st.chat[st.focusedSessionId].filter((i: any) => i.kind === 'user' && i.text === '같은 문장')
    return { total: items.length, marked: items.filter((i: any) => i.from).length }
  })
  expect(counts).toEqual({ total: 2, marked: 1 })
})

/**
 * 추론이 보인다 (#58 실측 기반).
 * codex는 요약 텍스트가 스트리밍되므로 회색 블록으로 대화에 남고,
 * claude는 본문이 암호화라 "Thinking · ~N tokens" 진행 표시만 가능하다 —
 * 없는 내용을 있는 척하지 않는 것까지가 계약이다.
 */
test('codex 추론 요약이 회색 블록으로 보이고 복원해도 남는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'reasoning_delta', text: '**경로 제약을 검토 중**' })
  await emitEvent(page, 0, { type: 'reasoning_delta', text: '\n\n**최소 횟수 확인**' })
  await expect(page.getByTestId('msg-reasoning')).toContainText('경로 제약을 검토 중')
  await expect(page.getByTestId('msg-reasoning')).toContainText('최소 횟수 확인')

  // 복원 레그: 메모리의 대화를 버리고 기록에서 강제로 다시 읽는다
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid, true)
  }, id)
  await expect(page.getByTestId('msg-reasoning')).toContainText('경로 제약을 검토 중')
})

test('claude의 생각은 양으로 보인다 — Thinking · ~N tokens, 턴이 끝나면 사라진다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await emitEvent(page, 0, { type: 'reasoning_delta', estTokens: 500 })
  await emitEvent(page, 0, { type: 'reasoning_delta', estTokens: 1000 })
  await expect(page.getByTestId('activity-label')).toContainText('Thinking · ~1.5k tokens')

  // 대화에는 아무것도 남지 않는다 — 내용이 없었으므로
  await expect(page.getByTestId('msg-reasoning')).toHaveCount(0)

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('activity-row')).toHaveCount(0)
})

/**
 * 계획이 보인다 (#58 실측, codex turn/plan/updated).
 * 실측에서 계획은 item으로 안 왔다 — 이 알림을 버리면 codex의 계획 도구 사용이
 * 화면 어디에도 나타나지 않는다. 스냅샷 교체·turn 종료 시 소멸까지가 계약이다.
 */
test('codex 계획이 체크리스트로 보이고, 갱신은 교체이며, 턴이 끝나면 사라진다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await emitEvent(page, 0, {
    type: 'plan_update',
    steps: [
      { text: '명령 실행 준비', status: 'inProgress' },
      { text: '명령 실행', status: 'pending' },
    ],
  })
  await expect(page.getByTestId('activity-plan')).toBeVisible()
  await expect(page.getByTestId('plan-step-0')).toHaveAttribute('data-status', 'inProgress')
  await expect(page.getByTestId('plan-step-1')).toContainText('명령 실행')

  // 갱신은 델타 합성이 아니라 스냅샷 교체다
  await emitEvent(page, 0, {
    type: 'plan_update',
    steps: [
      { text: '명령 실행 준비', status: 'completed' },
      { text: '명령 실행', status: 'inProgress' },
    ],
  })
  await expect(page.getByTestId('plan-step-0')).toHaveAttribute('data-status', 'completed')
  await expect(page.getByTestId('plan-step-1')).toHaveAttribute('data-status', 'inProgress')

  // 진행 표시일 뿐이라 턴이 끝나면 계획도 함께 사라진다 (activity와 같은 수명)
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('activity-plan')).toHaveCount(0)
})

/**
 * 실행 중 출력이 보인다 (#58 실측, codex item/commandExecution/outputDelta).
 * 조각의 합은 전체가 아니다(실측: 첫 조각 유실) — 그래서 살아있는 동안은 꼬리만 보여주고,
 * 완료되면 전체를 실은 result가 조각을 대체한다.
 */
test('실행 중 도구 출력이 꼬리로 흐르고, 완료되면 result로 바뀐다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'exec-1',
    summary: {
      tool: 'Bash',
      title: 'for i in 1 2 3; do echo tick $i; sleep 1; done',
      readOnly: false,
      paths: [],
    },
  })
  await emitEvent(page, 0, { type: 'tool_output_delta', callId: 'exec-1', text: 'tick 2\n' })
  await emitEvent(page, 0, { type: 'tool_output_delta', callId: 'exec-1', text: 'tick 3\n' })
  await expect(page.getByTestId('tool-card-live')).toContainText('tick 3')

  // 완료: 전체 출력이 result로 오고, 라이브 꼬리는 역할이 끝나 사라진다
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'exec-1',
    ok: true,
    summary: 'tick 1\ntick 2\ntick 3',
  })
  await expect(page.getByTestId('tool-card-live')).toHaveCount(0)
  await expect(page.getByTestId('tool-card-output')).toContainText('tick 1')
})

test('내가 보낸 말이 두 번 그려지지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('prompt-input').fill('같은 말')
  await page.getByTestId('send').click()
  // host가 "그 말이 더해졌다"고 알려온다 — 이미 그려둔 것이므로 확정만 되어야 한다
  await emitEvent(page, 0, { type: 'user_message', seq: 992, text: '같은 말' })

  const count = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    const id = st.focusedSessionId
    return st.chat[id].filter((i: any) => i.kind === 'user' && i.text === '같은 말').length
  })
  expect(count).toBe(1)
})

/**
 * 바람이 **한 번이라도 떴는가**를 촘촘히 본다.
 *
 * `toHaveCount(0)`으로는 못 잡는다 — 그건 자동 재시도라 바람이 떴다가 사라지기만 하면
 * 통과한다("끝내 0"이지 "한 번도 안 뜸"이 아니다). 실제로 이 함정 때문에 트리거 버그를
 * 잡는 테스트가 통과해 버렸다.
 */
async function blew(page: import('@playwright/test').Page, ms = 900): Promise<boolean> {
  for (let i = 0; i < ms / 50; i++) {
    if ((await page.getByTestId('gust').count()) > 0) return true
    await page.waitForTimeout(50)
  }
  return false
}

/**
 * 응답이 끝나면 화면을 한 번 쓸고 가는 바람.
 * 글자로 "끝났습니다"라고 적는 대신 화면이 한 번 숨을 쉰다.
 */
test('보고 있는 세션이 끝나면 바람이 한 번 불고 사라진다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await expect(page.getByTestId('gust')).toHaveCount(0)
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('gust')).toBeVisible()

  /*
   * 지나간 뒤에는 DOM에서 걷는다. 투명한 채로 남겨두면 화면 전체를 덮는 요소가
   * 항상 하나 떠 있게 된다 — 언젠가 무언가를 가린다.
   */
  await expect(page.getByTestId('gust')).toHaveCount(0, { timeout: 3000 })
})

test('화면 밖 세션이 끝나면 불지 않는다 — 그건 카드의 몫이다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // 이쪽을 보고 있다

  // 0번(보고 있지 않은 세션)이 끝난다
  await emitEvent(page, 0, { type: 'turn_complete' })
  expect(await blew(page)).toBe(false)
  // 지나가는 신호 대신 남는 신호가 온다 — 안 보고 있었으니 지나가면 놓친다
  await expect(page.getByTestId('notice')).toHaveCount(1)
})

/*
 * 알림 카드 — 자리를 비운 사람을 위한 것.
 *
 * OS 배너는 몇 초 뒤 걷히므로, 정작 자리를 비웠을 때 온 것은 돌아오면 이미 없다.
 * macOS에서는 배너 경로 자체가 죽어 있기까지 하다 (플러그인이 2018년에 deprecated된
 * NSUserNotification을 탄다). 그래서 이 카드가 본진이고, 남는 것이 요점이다.
 */
/*
 * 도그푸딩 신고: "지금 카드도 안 보여."
 *
 * "보인다"의 판정이 **앱 자체를 보지 않았다.** isOnScreen은 어느 세션이 UI에 떠 있는지만
 * 보므로 앱이 다른 창 뒤에 있어도 참이었다. 그래서 자리를 비운 사이 보고 있던 세션이
 * 끝나면 바람이 빈 방에서 불고 카드는 만들어지지 않았다 — 알림이 가장 필요한 그 경우에
 * 정확히 아무 일도 일어나지 않았다.
 */
test('앱이 뒤에 있으면 보고 있던 세션이 끝나도 카드가 남는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work') // 이 세션을 보고 있다

  // 다른 앱으로 넘어간다
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))

  await emitEvent(page, 0, { type: 'turn_complete' })

  // 보고 있는 창이 아니므로 바람은 아무도 못 본다 → 남는 신호여야 한다
  expect(await blew(page)).toBe(false)
  await expect(page.getByTestId('notice')).toHaveCount(1)

  // 돌아오면 그때 보게 되는 것이므로 걷힌다
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('notice')).toHaveCount(0)
})

test('자리를 비운 사이 끝나면 소리로도 부른다 — 전부 끝나기를 기다리지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await emitEvent(page, 0, { type: 'turn_complete' })

  await expect
    .poll(() =>
      page.evaluate(() => (window as never as { __mock: { alerts: { kind: string }[] } }).__mock.alerts),
    )
    .toEqual([{ kind: 'done', sound: true }])
})

test('눈앞에 있으면 카드만 남고 소리는 나지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // 이쪽을 보고 있다 → first는 화면 밖

  await emitEvent(page, 0, { type: 'turn_complete' })

  // 못 봤으니 카드는 남는다. 그러나 눈앞에 있는 사람을 소리로 부르는 건 소음이다.
  await expect(page.getByTestId('notice')).toHaveCount(1)
  await page.waitForTimeout(300)
  expect(
    await page.evaluate(() => (window as never as { __mock: { alerts: unknown[] } }).__mock.alerts.length),
  ).toBe(0)
})

test('카드는 시간이 지나도 스스로 사라지지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('notice')).toHaveCount(1)

  // 토스트는 2.5초에 걷힌다. 그보다 넉넉히 기다려도 이건 남아 있어야 한다.
  await page.waitForTimeout(4000)
  await expect(page.getByTestId('notice')).toHaveCount(1)
})

test('그 세션을 보게 되면 카드가 걷힌다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 0, { type: 'turn_complete' })
  const card = page.getByTestId('notice')
  await expect(card).toHaveCount(1)
  const target = await card.getAttribute('data-session')

  await page.evaluate((id) => {
    const st = (window as never as { __store: { getState(): Record<string, never> } }).__store.getState()
    ;(st as unknown as { focusSession(id: string): void }).focusSession(id!)
  }, target)

  await expect(page.getByTestId('notice')).toHaveCount(0)
})

test('카드를 누르면 그 세션으로 간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 0, { type: 'turn_complete' })
  const target = await page.getByTestId('notice').getAttribute('data-session')

  await page.getByTestId('notice-open').click()

  const focused = await page.evaluate(
    () =>
      (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState()
        .focusedSessionId,
  )
  expect(focused).toBe(target)
  // 갔으면 부를 이유가 없다
  await expect(page.getByTestId('notice')).toHaveCount(0)
})

test('×를 누르면 그 세션으로 가지 않고 카드만 걷힌다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  const before = await page.evaluate(
    () =>
      (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState()
        .focusedSessionId,
  )
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('notice')).toHaveCount(1)

  await page.getByTestId('notice-close').click()

  await expect(page.getByTestId('notice')).toHaveCount(0)
  const after = await page.evaluate(
    () =>
      (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState()
        .focusedSessionId,
  )
  // 치우기만 한 것이지 가겠다는 뜻이 아니다
  expect(after).toBe(before)
})

/*
 * 바쁜 세션 하나가 카드를 스무 장 만들면 나머지 세션이 화면 밖으로 밀린다 —
 * 그러면 카드가 많아질수록 쓸모가 줄어든다.
 */
/*
 * 소리와 독은 **배너가 죽은 자리를 대신한다.**
 *
 * 배너 경로(tauri-plugin-notification)는 데스크톱에서 권한 상태를 상수로 돌려주고
 * 전달 실패를 통째로 버려서, 한 통도 못 나가도 앱이 알 수 없었다. 그래서 실제로
 * 나가는 쪽을 테스트가 붙잡는다 — 여기가 조용해지면 자리 비움이 다시 깜깜해진다.
 */
test('승인 대기가 생기면 소리·독으로도 부른다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  // 알림 정책은 "눈앞에 있으면 알리지 않는다" — 테스트 창은 늘 포커스이므로 그 조건을 연다
  await page.evaluate(() => {
    const st = (window as never as { __store: { getState(): Record<string, never> } }).__store.getState()
    const s = st as unknown as { notifyPolicy: Record<string, boolean>; setNotifyPolicy(p: unknown): void }
    s.setNotifyPolicy({ ...s.notifyPolicy, whenFocused: true, sound: true })
  })

  await injectApproval(page, 0, { tool: 'Bash', command: 'rm -rf /tmp/x' })

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as never as { __mock: { alerts: { kind: string; sound: boolean }[] } }).__mock.alerts,
      ),
    )
    .toEqual([{ kind: 'approval', sound: true }])
})

/*
 * 설정은 갈래로 나뉜다 (이슈 #7).
 *
 * 예전엔 세 묶음이 한 두루마리에 쌓여 있었다. 셋일 땐 읽히지만 설정은 늘 늘어나기만 하고,
 * 여덟이 되는 순간 찾는 것이 스크롤 어딘가에 묻힌다. 갈래는 **사람이 무엇을 찾으러 왔는가**로
 * 나눈다 — 그만 좀 울리게(Notifications), 아까 그 자동 허용 취소(Permissions), 그 키가 뭐였지
 * (Shortcuts). 한 번에 한 갈래만 그리므로, 고르지 않은 갈래는 화면에 없어야 한다.
 */
test('설정은 갈래로 나뉘고 한 번에 한 갈래만 보인다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('open-settings').click()

  // 열면 알림부터다 — 가장 자주 오는 용건이다
  await expect(page.getByTestId('notify-approval')).toBeVisible()
  await expect(page.getByTestId('shortcut-list')).toBeHidden()

  await page.getByTestId('settings-tab-shortcuts').click()
  await expect(page.getByTestId('shortcut-list')).toContainText('⌘K')
  // 다른 갈래는 접히는 게 아니라 없다 — 안 보이는 채로 남아 있으면 탭이 아니라 장식이다
  await expect(page.getByTestId('notify-approval')).toBeHidden()

  await page.getByTestId('settings-tab-permissions').click()
  await expect(page.getByTestId('rules-empty')).toBeVisible()
  await expect(page.getByTestId('shortcut-list')).toBeHidden()
})

test('설정은 상단 바에서 바로 열린다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // 단축키 표가 이 안에 있다 — 단축키를 알아야만 열 수 있으면 안 된다
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings')).toBeVisible()
})

/*
 * 설정 메뉴 줄에서 **이름이 설명에 밀려 사라지면 안 된다** (도그푸딩: 권한 묶음에서
 * Normal이 안 보였다). 힌트가 shrink-0이라 좁은 메뉴(w-56)에서 라벨이 0까지
 * 줄어들었다 — 설명은 남고 고를 이름이 사라진 줄이었다. 세 줄 모두 라벨이
 * 잘리지 않았는지를 직접 잰다.
 */
test('권한 프리셋 이름은 설명에 밀려 잘리지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '첫 지시')
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  for (const v of ['safe', 'normal', 'auto']) {
    const label = page.getByTestId(`settings-preset-${v}`).locator('span').nth(1)
    await expect(label, v).not.toBeEmpty()
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), `${v} label clipped`).toBe(true)
  }
})

/*
 * 체크박스는 우리가 그린다 (도그푸딩: 창이 키를 잃으면 체크의 배경색이 OS 손에서
 * 회색으로 바뀌었다 — accent-color로는 그 비활성 칠을 못 이긴다). 크로미움은
 * macOS의 비활성 칠을 재현하지 못하므로, 여기서는 그 원인 — 그리기를 OS에
 * 맡겼다는 사실 — 이 제거됐는지를 본다.
 */
test('체크박스는 네이티브 그리기를 쓰지 않는다 — 창 활성/비활성이 같은 픽셀이다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('open-settings').click()
  const box = page.getByTestId('notify-approval')
  await expect(box).toBeVisible()
  expect(await box.evaluate((el) => getComputedStyle(el).appearance)).toBe('none')
  // 그리기를 가져왔으면 체크 표시도 우리 것이어야 한다 — 없으면 켠 것이 안 보인다
  expect(await box.evaluate((el) => getComputedStyle(el, '::after').borderRightWidth)).not.toBe('0px')
})

test('같은 세션이 여러 번 끝나도 카드는 한 장이다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'turn_complete' })

  await expect(page.getByTestId('notice')).toHaveCount(1)
})

/*
 * 신고: "세션 창 이동할 때도 막 나고".
 *
 * 끝난 것은 아까 한 번이고 그 사이에 끝난 것은 없다. 그런데 그 세션으로 옮겨 가면
 * 바람이 분다 — 바람은 '끝났다'는 사건이 아니라 '끝나 있다'는 값에 걸려 있다.
 */
test('이미 끝나 있던 세션으로 옮겨 가도 바람이 불지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // 이쪽을 보고 있다

  await emitEvent(page, 0, { type: 'turn_complete' }) // 안 보이는 쪽이 끝난다
  await page.waitForTimeout(200)
  await expect(page.getByTestId('gust')).toHaveCount(0)

  // 끝난 그 세션으로 옮겨 간다 — 새로 끝난 것은 아무것도 없다
  const moved = await page.evaluate(() => {
    const store = (window as never as { __store: { getState(): Record<string, never> } }).__store
    const st = store.getState() as unknown as {
      sessions: Record<string, { id: string }>
      focusedSessionId: string
      focusSession(id: string): void
    }
    // 아까 끝난 그 세션 = 지금 보고 있지 않은 쪽
    const target = Object.values(st.sessions).find((x) => x.id !== st.focusedSessionId)!.id
    st.focusSession(target)
    const after = (store.getState() as unknown as { focusedSessionId: string }).focusedSessionId
    return { target, after }
  })
  // **옮겨 갔는지 먼저 확인한다** — 안 옮겨 갔으면 "안 불었다"는 아무 의미가 없다
  expect(moved.after).toBe(moved.target)

  expect(await blew(page)).toBe(false)
})

/*
 * 그리고 한 번 끝난 것으로 **몇 번이고** 분다 — 오갈 때마다 다시 분다.
 */
test('오갔다고 해서 지난 완료가 다시 불지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 1, { type: 'turn_complete' }) // 보고 있는 쪽이 끝난다 — 여기서 한 번 부는 게 맞다
  await expect(page.getByTestId('gust')).toBeVisible()
  await expect(page.getByTestId('gust')).toHaveCount(0, { timeout: 3000 })

  const swap = (i: number) =>
    page.evaluate((idx) => {
      const st = (window as never as { __store: { getState(): Record<string, never> } }).__store.getState()
      const list = Object.values(st.sessions as unknown as Record<string, { id: string }>)
      ;(st as unknown as { focusSession(id: string): void }).focusSession(list[idx]!.id)
    }, i)

  await swap(0)
  expect(await blew(page, 300)).toBe(false)
  await swap(1) // 돌아왔다. 그 사이 끝난 것은 없다
  expect(await blew(page, 300)).toBe(false)
})

/**
 * 에이전트가 내민 선택지 (AskUserQuestion).
 *
 * 표시만 되고 답이 안 가면 반쪽이다 — 승인 카드가 정확히 그래서 먹통이 됐다.
 * 그래서 매번 **답이 세션까지 갔는지**까지 본다.
 */
const QUESTIONS = [
  {
    question: '점심 뭐 먹을까?',
    header: '점심',
    options: [
      { label: '김밥', description: '빠르다' },
      { label: '라면', description: '따뜻하다' },
    ],
    multiSelect: false,
  },
  {
    question: '음료는?',
    header: '음료',
    options: [
      { label: '물', description: '무난하다' },
      { label: '커피', description: '깨어난다' },
    ],
    multiSelect: false,
  },
]

test('선택지를 눌러 답하면 그 답이 세션으로 간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await expect(page.getByTestId('question-card')).toBeVisible()
  // 설명이 판단 근거다 — 잘리면 이 기능이 죽는다 (실제로 그래서 못 썼다)
  await expect(page.getByTestId('question-card')).toContainText('따뜻하다')

  await page.getByTestId('question-option').filter({ hasText: '라면' }).click()
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('답 받음: 라면')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
})

test('질문이 여러 개면 탭으로 나뉘고, 다 답해야 보낼 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: QUESTIONS })

  // 질문이 여럿이면 쌓지 않고 탭이다 (#8) — 두 번째 질문은 제 탭으로 가야 보인다
  await expect(page.getByTestId('question-tabs')).toBeVisible()
  await expect(page.getByTestId('question-card')).not.toContainText('음료는?')

  // 반만 보내면 모델이 나머지를 지어낸다 — 그래서 다 고르기 전엔 잠가 둔다
  await page.getByTestId('question-option').filter({ hasText: '김밥' }).click()
  await expect(page.getByTestId('question-submit')).toBeDisabled()
  // 어느 탭이 아직 비었는지는 탭 줄에서 읽힌다 — 그러라고 쌓기를 버린 것이다
  await expect(page.getByTestId('question-tab-0')).toHaveAttribute('data-answered', 'true')
  await expect(page.getByTestId('question-tab-1')).not.toHaveAttribute('data-answered', 'true')

  await page.getByTestId('question-tab-1').click()
  await page.getByTestId('question-option').filter({ hasText: '커피' }).click()
  await expect(page.getByTestId('question-submit')).toBeEnabled()
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('답 받음: 김밥 | 커피')
})

/**
 * 탭을 오가는 것은 공짜여야 한다. 숨김이 unmount였다면 옆 질문을 잠깐 보고 온 사이
 * 반쯤 쓴 직접 입력이 사라진다 — 쌓기를 탭으로 바꾸며 새로 생기면 안 되는 유일한 비용이다.
 */
test('탭을 오가도 고른 것과 쓰던 답이 남는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: QUESTIONS })

  await page.getByTestId('question-other').click()
  await page.getByTestId('question-other-input').fill('쓰다 만 답')
  await page.getByTestId('question-tab-1').click()
  await page.getByTestId('question-tab-0').click()
  await expect(page.getByTestId('question-other-input')).toHaveValue('쓰다 만 답')
})

/*
 * 도구 스키마가 못 박아 둔 것: "There should be no 'Other' option, that will be
 * provided automatically." 그 자리는 화면이 만들어 주기로 되어 있다.
 * 없으면 사람은 내민 둘 중 하나로만 답할 수 있어 셋째 답이 있을 때 할 말이 없어진다.
 */
test('기타를 골라 직접 쓴 답도 그대로 간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await page.getByTestId('question-other').click()
  await page.getByTestId('question-other-input').fill('둘 다 말고 국수')
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('답 받음: 둘 다 말고 국수')
})

test('기타를 골라 놓고 비워 두면 보낼 수 없다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await page.getByTestId('question-other').click()
  await expect(page.getByTestId('question-submit')).toBeDisabled()
})

/**
 * 워크트리 옵션 (FR-2).
 *
 * 스펙의 원칙은 "원본 디렉토리에서 직접 작업"이고 워크트리는 **원하는 사람만** 켠다.
 * 그래서 화면이 지켜야 할 것은 둘이다: 기본은 꺼져 있을 것, 켰으면 그 사실이 보일 것.
 */
test('워크트리는 기본으로 꺼져 있고, 켜면 세션에 브랜치가 표시된다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  const toggle = page.getByTestId('worktree-toggle').locator('input')
  await expect(toggle).not.toBeChecked()

  await toggle.check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill('격리해서 고쳐줘')
  await page.getByTestId('prompt-input').press('Enter')

  // 다른 디렉토리에서 돈다는 사실이 안 보이면 "왜 프로젝트 폴더가 안 바뀌지"를 겪는다
  await expect(page.getByTestId('worktree-badge')).toBeVisible()
  await expect(page.getByTestId('worktree-badge')).toContainText('centralu/')
})

test('워크트리를 안 켠 세션에는 표시가 없다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '그냥 여기서 해줘')

  await expect(page.getByTestId('worktree-badge')).toHaveCount(0)
})

/**
 * 워크트리는 **세션과 수명이 다르다.** 에이전트가 몇 시간 작업한 결과가 거기 있을 수 있어
 * 기본은 남기는 쪽이고, 지우려면 사람이 무엇을 잃는지 읽고 직접 켠다.
 */
test('워크트리 세션을 지울 때는 물어보고, 켜야 지운다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill('격리 세션')
  await page.getByTestId('prompt-input').press('Enter')

  // 커밋 안 된 변경이 있는 상태를 만든다 — 그때 무엇을 잃는지 말해야 한다
  await page.evaluate(() => {
    ;(window as any).__mock.mockWorktreeDirty = true
  })

  /*
   * 워크트리 세션은 이제 매니저 아래 들여 그려진다 (#69) — 목록의 첫 줄은 매니저다.
   * `.first()`로 잡으면 매니저의 삭제를 누르게 되므로, 들여진 줄을 집는다.
   */
  await page
    .locator('li[data-nested]')
    .getByTestId(/^session-menu-/)
    .click()
  await page
    .locator('li[data-nested]')
    .getByTestId(/^delete-session-/)
    .click()

  const panel = page.getByTestId('delete-worktree')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('worktree-dirty')).toContainText('2')

  // 기본은 끄져 있다 — 지우는 쪽이 기본이면 되돌릴 수 없는 일이 조용히 일어난다
  await expect(page.getByTestId('delete-worktree-toggle')).not.toBeChecked()
})

test('워크트리가 아닌 세션을 지울 때는 워크트리 이야기를 꺼내지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '보통 세션')

  await page
    .getByTestId(/^session-menu-/)
    .first()
    .click()
  await page
    .getByTestId(/^delete-session-/)
    .first()
    .click()

  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await expect(page.getByTestId('delete-worktree')).toHaveCount(0)
})

/**
 * 그리드에서 응답 중인 칸은 **테두리가 돈다.**
 *
 * 칸이 여럿일 때 머리글의 작은 표식 하나로는 어느 것이 도는지 눈이 못 따라간다.
 * 그리드는 읽는 화면이 아니라 보는 화면이라, 신호가 칸 전체 크기로 있어야 곁눈에 잡힌다.
 */
test('그리드: 응답 중인 칸만 테두리가 돈다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '첫째')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', '둘째')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${a}"]`, '[data-testid="grid-button"]')
  await page.dragAndDrop(`[data-testid="session-row-${b}"]`, '[data-testid="grid-button"]')

  const panelA = page.getByTestId(`grid-panel-${a}`)
  const panelB = page.getByTestId(`grid-panel-${b}`)

  // 첫 프롬프트로 둘 다 일하는 중이다 — 끝내고 나서 비교한다
  for (const idx of [0, 1]) await emitEvent(page, idx, { type: 'turn_complete' })
  await expect(panelA).not.toHaveClass(/cc-orbit-ring/)
  await expect(panelB).not.toHaveClass(/cc-orbit-ring/)

  // a에게만 일을 시킨다
  await page.getByTestId(`grid-panel-${a}`).getByTestId('prompt-input').fill('오래 걸리는 일')
  await page.getByTestId(`grid-panel-${a}`).getByTestId('send').click()

  await expect(panelA).toHaveClass(/cc-orbit-ring/)
  // 옆 칸까지 돌면 "무엇이 바쁜가"를 못 읽는다 — 신호가 아니라 장식이 된다
  await expect(panelB).not.toHaveClass(/cc-orbit-ring/)
})

/**
 * A conversation long enough that the panel scrolls and the virtualiser has real work to
 * do, left where a reader would leave it — at the newest line.
 *
 * The pinning loop at the end is setup, not the behaviour under test. Dropping eighty
 * turns into a view somebody is already looking at is not something a person can do, and
 * the view is entitled to end up somewhere odd afterwards; the tests below are about what
 * happens to a position you actually held.
 */
async function seedLongChat(page: Page, sessionId: string) {
  await page.evaluate((sid: string) => {
    const store = (window as any).__store
    const items = Array.from({ length: 80 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      // Well past the virtualiser's 64px guess — that gap is where #31 lived
      text: `line ${i} `.repeat(60),
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, sessionId)

  const stream = page.getByTestId('chat-stream')
  await expect
    .poll(async () => {
      await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
      return distanceFromBottom(stream)
    })
    .toBeLessThanOrEqual(80)
}

/** How far the stream is from its own bottom, in px. `< BOTTOM_SLACK` means "at the bottom" */
function distanceFromBottom(stream: Locator): Promise<number> {
  return stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
}

/**
 * Scroll survives leaving a grid panel and coming back (issue #31).
 *
 * Fourth time this shape has bitten: draft text, expanded folders, the elapsed count, and
 * now this. What is preserved is **"was I stuck to the bottom"**, not a pixel offset — a
 * `scrollTop` restored into a virtualiser that has not measured its rows yet lands *near*
 * the right place, which was the reported symptom rather than a cure for it.
 *
 * Note this one **passes against the old code on a quiet machine**, and fails on a busy
 * one (measured 339px short, repeatedly, with the suite running in parallel). The gap it
 * is about opens while rows are being measured, so how much of it you see depends on how
 * many frames the measuring takes. So: a contract written down, not a net. The net for
 * this pair is the test below, which fails on the old code every time.
 */
test('stuck to the bottom of a grid panel, still there after looking away (#31)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const stream = page.getByTestId(`grid-panel-${id}`).getByTestId('chat-stream')
  await expect(stream).toBeVisible()
  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)

  // Away to the focus view and back — the panel is torn down and built again
  await page.getByTestId(`session-row-${id}`).click()
  await page.getByTestId('grid-button').click()
  await expect(stream).toBeVisible()

  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)
})

/**
 * The other half: reading something further up is also a position worth keeping.
 *
 * We cannot promise the exact spot back — that is the offset problem above — but being
 * yanked to the newest message is a decision the app makes *against* you, and it used to
 * make it every single time, because the flag was born `true` with the component.
 */
test('scrolled up to read, a grid panel does not yank you back down (#31)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const stream = page.getByTestId(`grid-panel-${id}`).getByTestId('chat-stream')
  await expect(stream).toBeVisible()
  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)

  // Scroll up by hand — the wheel, so it is a real user scroll and not an assignment
  await stream.hover()
  await page.mouse.wheel(0, -4000)
  await expect.poll(() => distanceFromBottom(stream)).toBeGreaterThan(80)

  await page.getByTestId(`session-row-${id}`).click()
  await page.getByTestId('grid-button').click()
  await expect(stream).toBeVisible()

  // Give the follow logic every chance to drag us down before we believe it did not
  await page.waitForTimeout(300)
  expect(await distanceFromBottom(stream)).toBeGreaterThan(80)
})

/**
 * #61: 돌아왔을 때 **읽던 자리**여야 한다 — "바닥은 아니었다"만으로는 부족하다.
 *
 * #31이 지킨 것은 "바닥으로 끌어내리지 않는다"까지였다. 그런데 아무것도 남기지
 * 않았으므로 브라우저는 새 요소를 scrollTop 0에서 시작했고, 결과는 매번 **맨 위**였다 —
 * 80턴짜리 대화에서 중간을 읽다 나갔다 오면 처음으로 되돌아가 있었다.
 * 이제 떠날 때 화면 맨 위에 걸친 줄(seq)을 남기고, 돌아오면 그 줄로 되돌아간다.
 */
test('읽던 자리로 돌아온다 — 맨 위가 아니라 (#61)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)

  const stream = page.getByTestId('chat-stream')
  // 중간쯤으로 올라가 읽는다 (바닥도 꼭대기도 아닌 자리라야 이 버그가 산다)
  await stream.hover()
  await page.mouse.wheel(0, -3000)
  await expect.poll(() => distanceFromBottom(stream)).toBeGreaterThan(80)
  const before = await stream.evaluate((el) => el.scrollTop)
  expect(before).toBeGreaterThan(200)

  // 화면을 떠났다 돌아온다 (그리드는 칸을 통째로 버리고 다시 만든다)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()
  await page.getByTestId(`session-row-${id}`).click()
  await expect(stream).toBeVisible()

  // 자리를 잡는 동안 중간 위치가 그려지지 않는다 — 재는 동안은 감춘 채로 잰다
  await expect(stream).not.toHaveAttribute('data-settling', 'true')

  // 같은 줄 언저리다. 픽셀까지 같기를 요구하지 않는 이유는 줄을 다시 재기 때문 —
  // 하지만 "맨 위로 돌아갔다"와는 확실히 구별된다
  const after = await stream.evaluate((el) => el.scrollTop)
  expect(Math.abs(after - before)).toBeLessThan(120)
})

/**
 * 같은 일이 그리드 없이도 일어난다 (사용자 지적): 포커스 뷰에서 세션만 바꿔도
 * 같은 컴포넌트가 sessionId만 갈아 끼우므로, 남긴 것이 없으면 자리를 잃는다.
 */
test('세션을 바꿨다 돌아와도 읽던 자리다 (#61)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, a)
  await newSession(page, 'alpha', 'second')

  await page.getByTestId(`session-row-${a}`).click()
  const stream = page.getByTestId('chat-stream')
  await stream.hover()
  await page.mouse.wheel(0, -3000)
  await expect.poll(() => distanceFromBottom(stream)).toBeGreaterThan(80)
  const before = await stream.evaluate((el) => el.scrollTop)

  // 옆 세션에 들렀다 온다 — 화면 종류는 그대로이고 sessionId만 바뀐다
  const b = await page.evaluate(
    (aId: string) => Object.keys((window as any).__store.getState().sessions).find((x) => x !== aId),
    a,
  )
  await page.getByTestId(`session-row-${b}`).click()
  await page.getByTestId(`session-row-${a}`).click()
  await expect(stream).toBeVisible()

  const after = await stream.evaluate((el) => el.scrollTop)
  expect(Math.abs(after - before)).toBeLessThan(120)
})

/** 보내고 대화창에 실제로 붙은 것까지 확인한다 — 기록은 붙은 것에서 나온다 (#38) */
async function sendMessage(page: Page, body: string) {
  const seen = await page.getByTestId('msg-user').count()
  await page.getByTestId('prompt-input').fill(body)
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('msg-user')).toHaveCount(seen + 1)
}

/**
 * 화살표로 보낸 말을 되불러온다 (#38).
 *
 * 셸이 하는 그대로다. 기록은 따로 저장하지 않는다 — 대화에 이미 내 말이 다 있다.
 */
test('arrow up walks back through what you sent, arrow down walks forward (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '첫 프롬프트')
  await sendMessage(page, '둘째로 보낸 말')
  await sendMessage(page, '셋째로 보낸 말')

  const input = page.getByTestId('prompt-input')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('셋째로 보낸 말')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('둘째로 보낸 말')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('첫 프롬프트')

  // 가장 오래된 것에서 더 위로 눌러도 그 자리다 — 커서가 움직이면 "안 먹는다"로 읽힌다
  await input.press('ArrowUp')
  await expect(input).toHaveValue('첫 프롬프트')

  await input.press('ArrowDown')
  await expect(input).toHaveValue('둘째로 보낸 말')
})

/**
 * 쓰다 만 글은 화살표 한 번에 잃을 수 있는 것이 아니다.
 *
 * 이 앱이 계속 고쳐 온 종류의 손실이라, 되불러오는 동안 초안은 아예 건드리지 않는다.
 */
test('arrow down past the newest gives the unsent draft back (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '보낸 말')

  const input = page.getByTestId('prompt-input')
  await input.fill('아직 안 보낸 글')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('보낸 말')

  await input.press('ArrowDown')
  await expect(input).toHaveValue('아직 안 보낸 글')
})

/** 되불러오기는 지금 이 대화의 것이다 — 남의 말이 내 입력창에 앉으면 그대로 보내진다 */
test('recall does not reach into another session (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A에게 한 말')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'B에게 한 말')

  const input = page.getByTestId('prompt-input')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('B에게 한 말')

  // 세션을 바꾸면 꺼내둔 것도 따라가지 않는다
  await page.getByTestId(`session-row-${a}`).click()
  await expect(input).toHaveValue('')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('A에게 한 말')
})

/**
 * 자동완성이 열려 있는 동안 화살표는 목록의 것이다.
 *
 * 둘 다 화살표를 원하는데, 열려 있는 쪽이 이긴다 — 목록을 띄워 놓고 고르는 중에
 * 입력창이 통째로 옛 메시지로 바뀌면 무슨 일이 일어난 건지 알 길이 없다.
 */
test('the autocomplete list keeps the arrows while it is open (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.commandState = {
      ready: true,
      commands: [
        { name: 'review', description: '변경을 검토합니다', argumentHint: '' },
        { name: 'restart', description: '다시 시작합니다', argumentHint: '' },
      ],
    }
  })
  await newSession(page, 'alpha', '보낸 말')

  const input = page.getByTestId('prompt-input')
  await input.fill('/re')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  await expect(page.getByTestId('autocomplete-item-0')).toHaveAttribute('aria-selected', 'true')

  await input.press('ArrowDown')
  // 골라진 줄이 옮겨갔고, 입력창은 내가 친 그대로다
  await expect(page.getByTestId('autocomplete-item-1')).toHaveAttribute('aria-selected', 'true')
  await expect(input).toHaveValue('/re')

  await input.press('ArrowUp')
  await expect(page.getByTestId('autocomplete-item-0')).toHaveAttribute('aria-selected', 'true')
  await expect(input).toHaveValue('/re')
})

/**
 * 여러 줄을 쓰는 중이면 화살표는 먼저 커서의 것이다.
 *
 * 첫 줄에서 위로, 마지막 줄에서 아래로 — 그때만 기록이 나선다. 손이 이미 알고 있는
 * 규칙이라(셸·devtools) 따로 배울 것이 없다.
 */
test('in a multi-line draft the arrows move the caret first (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '보낸 말')

  const input = page.getByTestId('prompt-input')
  await input.fill('첫 줄\n둘째 줄')

  // 커서는 끝(= 마지막 줄)에 있다 — 위 화살표는 커서를 올린다
  await input.press('ArrowUp')
  await expect(input).toHaveValue('첫 줄\n둘째 줄')

  // 이제 첫 줄이다 — 여기서 한 번 더 누르면 기록이 온다
  await input.press('ArrowUp')
  await expect(input).toHaveValue('보낸 말')
})

/**
 * 조합 중인 화살표는 후보 목록의 키다 (#12).
 *
 * 한글·일본어·중국어를 치는 사람에게는 방향키가 글자를 고르는 키이기도 하다.
 * 여기서 가로채면 고르던 글자가 통째로 사라진다 — 키보드 이벤트를 직접 만들어
 * 조합 중이라고 말해 준다. 사람 손으로는 재현할 수 없는 상태다.
 */
test('arrows do not recall while an IME is composing (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '보낸 말')

  const input = page.getByTestId('prompt-input')
  await input.fill('ㅎ')
  await input.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true }))
  })
  await expect(input).toHaveValue('ㅎ')

  // 조합이 끝나면 같은 키가 기록을 부른다
  await input.press('ArrowUp')
  await expect(input).toHaveValue('보낸 말')
})

/**
 * 되불러온 글도 친 글과 똑같이 입력창을 키운다.
 *
 * 높이는 값에서 나오게 만들어 뒀으므로 새 경로가 하나 늘어도 저절로 따라와야 한다 —
 * "따라올 것이다"와 "따라온다"는 다르므로 재 본다.
 */
test('a recalled multi-line message grows the composer (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '한 줄')

  const input = page.getByTestId('prompt-input')
  await sendMessage(page, '첫 줄\n둘째 줄\n셋째 줄')
  const short = await input.evaluate((el) => el.clientHeight)

  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('첫 줄\n둘째 줄\n셋째 줄')
  expect(await input.evaluate((el) => el.clientHeight)).toBeGreaterThan(short)
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
  await newSession(page, 'alpha', '작업')

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
 * Committing from inside the app left the sidebar's count on its old value (#49).
 *
 * #41 gave that count three ways to hear that a tree had moved, and every one of them is a
 * guess that something probably happened somewhere else. The git panel meanwhile went
 * straight to `platform.git` and told only itself — so the one change we make **on purpose,
 * knowing exactly which repo it lands in**, was the only one the sidebar never heard.
 *
 * The baseline here comes through #41's own path, so what this test adds is the second half:
 * a commit, and a number beside the project name that follows it.
 */
test('깃 패널에서 커밋하면 사이드바의 변경 수도 함께 움직인다 (#49)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: true, status: 'M' },
      { path: 'src/b.ts', staged: true, status: 'M' },
      { path: 'src/c.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', '작업')

  // 기준은 #41이 놓아둔 신호로 만든다 — 여기까지는 예전에도 맞았다
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('3')

  await page.getByTestId('evidence-git-full').click()
  await page.getByTestId('commit-message').fill('올린 둘만 커밋')
  await page.getByTestId('commit-button').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')

  // 올린 둘이 나갔다 — 사이드바가 그 사실을 아는지가 이 이슈의 전부다
  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('1')
})

/**
 * 좁은 패널의 커밋도 같은 길로 간다 (#49).
 *
 * 이쪽이 더 두드러진다: 이 버튼은 사이드바 **바로 옆**에 있어서, 커밋하고 나면
 * 몇 픽셀 왼쪽의 숫자가 옛 값을 붙들고 있는 것이 한눈에 보였다.
 */
test('좁은 패널에서 커밋해도 사이드바의 변경 수가 따라온다 (#49)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: true, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', '작업')
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('2')

  await page.getByTestId('evidence-commit-message').fill('패널에서 커밋')
  await page.getByTestId('evidence-commit').click()

  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('1')
})

/**
 * 커밋만이 아니라 **저장소를 바꾸는 것 전부**가 알린다 (#49).
 *
 * 스테이징은 대개 숫자를 안 움직이고(porcelain은 올렸든 아니든 경로당 한 줄이다),
 * 브랜치 전환은 숫자가 아니라 **이름**을 바꾼다. 그래서 화면의 숫자로는 둘 다 확인할 수
 * 없다 — 대신 스토어가 다시 재어봤는지를 센다. 어느 쪽이든 무엇이 바뀌었는지 짐작해서
 * 거르는 규칙을 두지 않는 것이 요점이다: 그런 규칙은 조용히 틀린 채로 오래 간다.
 *
 * `push`는 일부러 빠져 있다. 사이드바가 보여주는 것(브랜치·변경 수·저장소 여부) 중
 * 어느 것도 움직이지 않으므로, 재는 일은 답이 같을 수밖에 없는 호출이 된다.
 */
test('스테이징과 브랜치 전환도 사이드바에 알린다 — 푸시는 아니다 (#49)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'feature', current: false, remote: false },
    ]
  })
  await newSession(page, 'alpha', '작업')
  await page.getByTestId('evidence-git-full').click()

  await page.evaluate(() => ((window as any).__mock.gitStatusCalls = 0))
  await page.getByTestId('git-stage-all').click()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(1)

  await page.getByTestId('push-button').click()
  await expect(page.getByTestId('toast')).toContainText('Pushed')
  // 푸시는 아무것도 안 물어본다 — 위의 한 번 그대로다
  expect(await page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(1)

  await page.getByTestId('git-sub-branches').click()
  await page.getByTestId('branch-feature').click()
  await expect(page.getByTestId('toast')).toContainText('Switched to feature')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(2)
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
 * 업데이트: 알리기만 하고, 사람이 누를 때만 설치한다 (이슈 #43).
 *
 * The whole shape of this feature is in one run: a quiet line appears when the registry
 * has something newer, clicking it is the consent, and the app stops at "restart" rather
 * than replacing itself out from under the person. Driven entirely through the mock —
 * `npm i -g` is never run by a test.
 */
test('새 버전이 있으면 조용한 줄이 뜨고, 눌러야 설치된다 (#43)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // 아직 아무 소식이 없을 때는 계기판에 줄이 없다 — 할 말이 있을 때만 나타난다
  await expect(page.getByTestId('update-line')).toBeHidden()

  // 레지스트리에 새 버전이 올라왔다
  await page.evaluate(() => (window as any).__mock.offerUpdate('9.9.9'))
  const line = page.getByTestId('update-line')
  await expect(line).toContainText('9.9.9')

  // 누르는 것이 곧 동의다 — 그전까지 아무 일도 일어나지 않는다
  await line.click()
  /*
   * 끝나도 **다시 시작하지는 않는다.** 도는 앱을 갈아 끼우는 것은 사람이 정할 일이고,
   * 이 줄이 그 말을 하는 자리다.
   */
  await expect(line).toContainText('Restart')
})

/**
 * 설정에 'Updates'가 생겼다 (이슈 #43 / #7이 열어 둔 네 번째 갈래).
 *
 * 자동 확인은 **기본으로 켜져 있다** — 읽기 전용이고 실패를 삼키므로 켜 두어 잃는 것이
 * 없는 반면, 꺼 두면 설정을 한 번도 안 여는 사람이 영원히 옛 버전에 남는다.
 * 끄면 진짜로 안 묻는다는 것까지 여기서 확인한다: 안 그러면 이 체크상자는 장식이다.
 */
test('설정 > Updates: 지금 확인 · 자동 확인 (#43)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-updates').click()

  /*
   * 지금 도는 것이 무엇인지부터 말한다 — 비교의 한쪽이 안 보이면 나머지도 못 읽는다.
   *
   * 버전 문자열을 여기 적어두면 **릴리스마다 이 줄이 빨개진다.** 실제로 그랬다:
   * 0.1.0-beta.3으로 올린 커밋이 이 줄을 깨뜨렸는데, CI가 릴리스 앞에서 돌리는 것은
   * `pnpm verify`(단위까지)라 아무도 못 봤다. 확인하려는 것은 버전 번호가 아니라
   * **번호가 화면에 실려 나온다는 것**이므로, 모양만 본다.
   */
  await expect(page.getByTestId('update-current')).toContainText(/Running \d+\.\d+\.\d+/)
  await expect(page.getByTestId('update-auto')).toBeChecked()

  await page.evaluate(() => {
    ;(window as any).__mock.registryVersion = '9.9.9'
  })
  await page.getByTestId('update-check-now').click()
  await expect(page.getByTestId('update-state')).toContainText('9.9.9')

  // 꺼 두면 레지스트리에 묻지 않는다
  await page.getByTestId('update-auto').uncheck()
  const asked = await page.evaluate(async () => {
    const m = (window as any).__mock
    m.registryVersion = null // 이제 물어보면 '못 닿음'이 될 것이다
    await (window as any).__store.getState().checkUpdate(false)
    return (window as any).__store.getState().update.latest
  })
  // 자동 확인이 꺼진 채로 온 자동 호출은 아무 데도 안 갔다 — 알던 답이 그대로 남는다
  expect(asked).toBe('9.9.9')
})

/**
 * 입력창 포커스가 잠든 세션을 깨운다.
 *
 * 사이드바에서 고르면 이미 깨어난다 (focusSession → wake). 그런데 고르지 **않고**
 * 입력창에 닿는 길이 둘 있다 — 그리드 칸, 그리고 재시작이 복원해 준 포커스 세션.
 * 둘 다 보내기 전까지 잠들어 있어서, 재개의 몇 초가 보내기 버튼 뒤에서 흘렀고
 * 슬래시 목록은 디스크 캐시(지워진 플러그인의 명령을 며칠씩 보여주던 그것)로만 답했다.
 */
test('입력창을 포커스하면 잠든 세션이 깨어난다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 잠든 상태를 만든다 — 앱 재시작이 복원한 포커스 세션이 정확히 이 모양이다
  await page.evaluate((sid: string) => {
    const st = (window as any).__store
    const m = (window as any).__mock
    ;[...m.sessions.values()].find((x: any) => x.id === sid)!.live = false
    st.setState({
      sessions: { ...st.getState().sessions, [sid]: { ...st.getState().sessions[sid], live: false } },
    })
  }, id)

  // 헬퍼가 입력창에 포커스를 남겨두므로 한 번 떠났다가 돌아온다 —
  // 깨우기는 포커스 '이벤트'에 걸려 있어서, 이미 포커스면 focus()가 아무것도 안 쏜다
  await page.getByTestId('prompt-input').blur()
  await page.getByTestId('prompt-input').focus()
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid].live, id))
    .toBe(true)
  // 조용히 — 깨어났다는 토스트도, 실패 토스트도 없다
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

/**
 * 보던 화면이 재시작을 넘어온다 (C-3의 남은 반쪽).
 *
 * 세션은 돌아오는데 보는 **방식**은 돌아오지 않았다 — 그리드에서 껐는데 포커스 뷰로
 * 켜졌다. 복원 순서(focusSession이 view를 focus로 강제한다)는 단위 테스트가 지키고,
 * 여기는 실제 리로드로 한 바퀴 돈다. mock의 재시작 규칙은 #20의 relaunch 테스트와
 * 같다: localStorage(스냅샷의 대역)만 살아남고, 프로젝트는 다시 등록해야 한다.
 */
test('그리드에서 껐다 켜면 그리드로 돌아온다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => (window as any).__store.getState().setGridPanels([sid]), id)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // 재시작 — 스냅샷만 살아남는다. 소개 화면은 다시 나오지 않는다 (introSeen도 스냅샷에 남았다)
  await page.goto('/?mock=1')
  await expect(page.getByTestId('add-project')).toBeVisible()
  await expect(page.getByTestId('intro')).toHaveCount(0)
  await page.evaluate((p: string) => {
    ;(window as any).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()

  // 프로젝트가 돌아오는 순간, 화면은 포커스 뷰가 아니라 **그리드**여야 한다
  await expect(page.getByTestId('grid')).toBeVisible()
})

/**
 * 세션 트리 (#69): 워크트리 세션은 매니저 아래에 들여 그려진다.
 *
 * 계급은 사이드바에만 산다 — 매니저는 자식을 가진 보통 세션이고, 워크트리 세션을
 * 만들면 매니저가 없던 프로젝트에도 매니저 줄이 생긴다 (행만, 프로세스는 없다).
 */
test('워크트리 세션은 사이드바에서 매니저 아래에 선다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 매니저 줄이 생겼고, 워크트리 세션이 그 아래에 들여 그려진다
  const manager = page.getByText('Worktrees', { exact: true })
  await expect(manager).toBeVisible()
  const nested = page.locator('li[data-nested]')
  await expect(nested).toHaveCount(1)

  // 매니저 줄의 ⋯ 메뉴에 있다 — 누르면 워크트리가 켜진 채 새 세션 창이 열린다
  const mgrRow = page.locator('li', { has: manager })
  await mgrRow.locator('[data-testid^="session-menu-"]').click()
  await mgrRow.locator('[data-testid^="new-worktree-session-"]').click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await expect(page.getByTestId('worktree-toggle').locator('input')).toBeChecked()

  // 그 창으로 하나 더 만들면 같은 매니저 아래에 선다 — 매니저는 프로젝트당 하나면 충분하다
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('li[data-nested]')).toHaveCount(2)
  await expect(page.getByText('Worktrees', { exact: true })).toHaveCount(1)
})

/**
 * 매니저를 **먼저** 만든다 (#76).
 *
 * 여기서 확인하는 것은 순서다: 자식이 하나도 없는 상태에서 자리가 서고, 그 뒤에 만든
 * 워크트리가 그 자리 아래로 들어간다. 그리고 자리가 생기면 만들기 버튼은 사라진다 —
 * 같은 일을 하는 문이 둘이 되지 않아야 한다.
 */
test('워크트리 매니저를 먼저 만들면 그 아래로 워크트리가 들어간다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('start-worktree-manager-alpha').click()
  // 줄기는 현재 브랜치가 채워져 있다 — 짐작을 사람 눈앞에 놓고 확인받는다
  await expect(page.getByTestId('worktree-trunk-input')).toHaveValue('main')
  await page.getByTestId('worktree-manager-confirm').click()
  await expect(page.getByTestId('worktree-manager-dialog')).toBeHidden()

  /*
    자리가 섰고 — 자식은 하나도 없다. 그리고 만들자마자 그 자리를 열어 준다:
    방금 만든 상대와 이야기하려고 만드는 것이라, 목록에 줄만 늘고 끝나면 절반이다.
  */
  // 사이드바로 좁혀서 센다 — 매니저를 열어 둔 상태라 대화창 머리에도 같은 이름이 있다
  const sidebar = page.getByTestId('sidebar')
  await expect(sidebar.getByText('Worktrees', { exact: true })).toHaveCount(1)
  await expect(page.getByTestId('session-name')).toHaveText('Worktrees')
  await expect(page.locator('li[data-nested]')).toHaveCount(0)
  // 자리가 생겼으니 만들기 문은 닫힌다 — 메뉴를 열어도 그 줄이 없다
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('start-worktree-manager-alpha')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // 이제 만든 워크트리는 먼저 선 자리 아래로 들어간다 — 두 번째 매니저가 생기지 않는다
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('li[data-nested]')).toHaveCount(1)
  await expect(sidebar.getByText('Worktrees', { exact: true })).toHaveCount(1)
})

test('프로젝트 헤더의 +로 열면 워크트리는 여전히 꺼져 있다 — 예열은 매니저 줄의 +만 한다', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // 먼저 매니저 줄의 +로 한 번 열었다 닫는다 — 예열 상태가 새어 남지 않아야 한다
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  const manager = page.getByText('Worktrees', { exact: true })
  await page.locator('li', { has: manager }).locator('[data-testid^="session-menu-"]').click()
  await page.locator('li', { has: manager }).locator('[data-testid^="new-worktree-session-"]').click()
  await page.keyboard.press('Escape')

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-toggle').locator('input')).not.toBeChecked()
})

test('워크트리 브랜치 이름을 정하면 세션 이름이 된다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  // 브랜치 칸은 워크트리를 켜기 전엔 없다 — 꺼진 옵션의 세부를 미리 펼치지 않는다
  await expect(page.getByTestId('worktree-branch-input')).toHaveCount(0)
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/login-fix')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 세션 이름 = 브랜치 이름 — 사이드바의 들여진 줄에 그 이름이 선다
  await expect(page.locator('li[data-nested]').getByText('feat/login-fix')).toBeVisible()
})

/**
 * 매니저의 워크트리 제안 (#69) — propose-not-power의 세 번째 사례.
 * 제안 줄이 대화에 남고, + 버튼이 밝아지고, 열면 브랜치 이름이 채워져 있다.
 * 만드는 것은 끝까지 사람이다.
 */
test('워크트리 제안: 대화에 줄이 남고, +가 밝아지고, 창에 이름이 채워진다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // 매니저와 자식을 만든다 (매니저 세션은 목록 순서상 0번이 아니라 이름으로 집는다)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 매니저 세션을 열고, 매니저가 제안했다고 친다 — 브랜치 이름은 제목에 실려 온다
  await page.getByText('Worktrees', { exact: true }).click()
  await page.evaluate(() => {
    const m = (window as any).__mock
    const manager = [...m.sessions.values()].find((s: any) => s.name === 'Worktrees')
    m.emit({
      type: 'tool_call',
      sessionId: manager.id,
      callId: 'c-prop',
      summary: {
        tool: 'mcp__centralu__propose_worktree_session',
        title: 'feat/proposed-work',
        readOnly: false,
        paths: [],
      },
    })
  })

  // 대화에 제안 줄 — 도구 카드가 아니라 가리키는 한 줄이다
  await expect(page.getByTestId('worktree-proposal')).toContainText('feat/proposed-work')
  // 이 프로젝트의 + 버튼이 밝아진다
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(1)

  // 그 문을 열면: 워크트리 켜짐 + 브랜치 이름 채워짐
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-toggle').locator('input')).toBeChecked()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/proposed-work')

  // 제안은 여는 순간 소비된다 — 닫고 다시 열면 보통의 빈 창이다
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(0)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-toggle').locator('input')).not.toBeChecked()
})

/**
 * 워크트리 프로비저닝 (#69) — 첫 사용은 펼쳐진 입력칸, 저장 후엔 접힌 요약.
 * 설정은 만들기 전에 저장된다 (host가 생성 중에 읽어 돌리므로).
 */
test('워크트리 셋업: 처음엔 입력칸, 저장 뒤엔 요약으로 접힌다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  // 저장된 설정이 없으니 입력칸이 펼쳐져 있다
  await expect(page.getByTestId('worktree-setup-edit')).toBeVisible()
  await page.getByTestId('worktree-setup-command').fill('pnpm install')
  await page.getByTestId('worktree-copy-files').fill('.env.local, .env')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 저장됐다 — 목이 실물과 같은 정규화를 했는지까지 본다
  const saved = await page.evaluate(() => {
    const m = (window as any).__mock
    return m.projectsList?.[0]?.worktreeSetup ?? [...(m.projectsList ?? [])][0]?.worktreeSetup
  })
  expect(saved).toEqual({ command: 'pnpm install', copyFiles: ['.env.local', '.env'] })

  // 다음에 열면 접힌 요약 한 줄 — 누르면 다시 편집할 수 있다
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await expect(page.getByTestId('worktree-setup-summary')).toContainText('setup: pnpm install')
  await expect(page.getByTestId('worktree-setup-summary')).toContainText('copies: .env.local, .env')
  await page.getByTestId('worktree-setup-summary').click()
  await expect(page.getByTestId('worktree-setup-command')).toHaveValue('pnpm install')
})

/**
 * 복사 후보 (#76) — 앱은 **짚어만 준다.**
 *
 * "무시된 건 전부 복사"를 기본값으로 삼지 않는 이유가 이 화면에 그대로 있다: 목록에
 * node_modules 637MB가 크기와 함께 서 있고, 누를지는 사람이 정한다.
 */
test('워크트리 셋업: gitignored 후보를 짚어 주고, 눌러서 넣고 뺀다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.gitState.ignored = [
      { path: 'node_modules/', bytes: 668213248 },
      { path: '.env.local', bytes: 24 },
      { path: 'weird/', bytes: null },
    ]
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()

  // 크기가 함께 보인다 — 이 목록에서 사람이 하는 판단이 "이건 너무 크다"라서다
  await expect(page.getByTestId('ignored-node_modules/')).toContainText('637MB')
  // 크기를 못 잰 것도 목록에는 선다 (크기는 거들 뿐이다)
  await expect(page.getByTestId('ignored-weird/')).toBeVisible()

  await page.getByTestId('ignored-.env.local').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('.env.local')
  await page.getByTestId('ignored-node_modules/').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('.env.local, node_modules/')
  // 다시 누르면 빠진다 — 칸이 여전히 진실이라 손으로 친 것과 갈리지 않는다
  await page.getByTestId('ignored-.env.local').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('node_modules/')

  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  const saved = await page.evaluate(() => (window as any).__mock.projectsList[0].worktreeSetup)
  expect(saved).toEqual({ command: '', copyFiles: ['node_modules/'] })
})

/** 병합 배지 (#69) — 사실의 통지가 배지가 되고, 정리는 사람이 삭제 대화에서 한다 */
test('브랜치가 병합되면 사이드바 줄에 merged 배지가 선다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/badge')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(0)

  // host의 감지가 이 이벤트를 흘린다 — 터미널에서 병합해도 같은 길이다
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({ type: 'worktree_merged', sessionId: child.id })
  })

  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(1)
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveText('merged')
})

/** PR 칩 (#76 stage 3) — gh가 측정한 PR 상태가 칩이 되고, 병합되면 merged 배지에 자리를 내준다 */
test('PR이 열리면 PR 칩이 서고, 병합되면 merged 배지가 대신 선다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/pr-chip')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveCount(0)

  // host의 gh 측정이 이 이벤트를 흘린다 — 스쿼시 병합의 사각지대를 메우는 그 신호
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({
      type: 'worktree_pr',
      sessionId: child.id,
      pr: { number: 12, state: 'open', url: 'https://github.com/x/y/pull/12' },
    })
  })
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveText('PR #12')

  // 병합되면 결말은 한 번만 말한다 — merged 배지가 서고 PR 칩은 물러난다
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({ type: 'worktree_merged', sessionId: child.id })
  })
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(1)
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveCount(0)
})

/** #75: 첨부를 실은 말은 한 번만 그려진다 — text가 보낸 원문 그대로라 확정이 맞물린다 */
test('첨부와 함께 보낸 말은 한 번만 그려진다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '첫 인사')

  // 첨부를 실어 보낸다 — 목이 실물 host처럼 원문만 담긴 user_message를 돌려준다
  await page.evaluate(async () => {
    const store = (window as any).__store.getState()
    const sid = Object.keys(store.sessions).find((id: string) => store.sessions[id].name !== 'Orchestrator')
    await store.send(sid, '이 이미지 봐줘', [
      { kind: 'image', path: '/tmp/att/shot.png', name: 'shot.png', mime: 'image/png', bytes: 10 },
    ])
  })

  const bubbles = page.getByText('이 이미지 봐줘')
  await expect(bubbles).toHaveCount(1)
  // 바이트 없는 첨부는 이름 칩으로 눕는다 — 무엇을 보냈는지는 남는다
  await expect(page.getByTestId('msg-user-attachment')).toContainText('shot.png')
})

/** 이미지 첨부는 실물 썸네일로 서고, 누르면 에이전트 이미지와 같은 확대가 열린다 */
test('보낸 이미지는 말풍선에 실물로 보이고 눌러 확대된다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // 진짜 1×1 PNG — 가짜 바이트면 <img>가 깨져 칩으로 눕는 경로를 타 버린다
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  await page.getByTestId('attach-input').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1PX, 'base64'),
  })
  await expect(page.getByTestId('attachment-list')).toContainText('pixel.png')
  await page.getByTestId('prompt-input').fill('이거 봐줘')
  await page.getByTestId('send').click()

  const thumb = page.getByTestId('msg-user-attachment')
  await expect(thumb.locator('img')).toBeVisible()
  await thumb.locator('img').click()
  await expect(page.getByTestId('image-lightbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('image-lightbox')).toHaveCount(0)

  // 저장소에서 다시 불러도 썸네일이 되살아난다 — host가 파일에서 바이트를 다시 싣는 규칙 (재시작과 같은 길)
  await page.evaluate(async () => {
    const store = (window as any).__store.getState()
    await store.loadHistory(store.focusedSessionId, true)
  })
  await expect(page.getByTestId('msg-user-attachment').locator('img')).toBeVisible()
})

/** #69 도그푸딩 ③: 제안은 큐다 — 둘을 제안받으면 +를 두 번 열어 둘 다 소비한다 */
test('워크트리 제안 둘은 창을 두 번 열어 순서대로 채워진다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await page.evaluate(() => {
    const m = (window as any).__mock
    const manager = [...m.sessions.values()].find((s: any) => s.name === 'Worktrees')
    for (const branch of ['feat/first', 'feat/second']) {
      m.emit({
        type: 'tool_call',
        sessionId: manager.id,
        callId: 'c-' + branch,
        summary: {
          tool: 'mcp__centralu__propose_worktree_session',
          title: branch,
          readOnly: false,
          paths: [],
        },
      })
    }
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/first')
  await page.keyboard.press('Escape')
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/second')
  await page.keyboard.press('Escape')
  // 큐가 비었다 — 글로우도 꺼지고 다음 창은 보통 창이다
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(0)
})

/**
 * 프로젝트 삭제 (도그푸딩 요청).
 *
 * 지키는 것 넷:
 *  1. 메뉴는 **평소에 없다** — 프로젝트 줄을 읽는 데 버튼이 끼어들지 않는다
 *  2. 이름을 정확히 쳐야 삭제가 열린다 — 손이 기억으로 지나갈 수 있는 길을 두지 않는다
 *  3. 파일 체크박스를 켜면 **설명이 경고로 바뀐다** — 무엇이 달라졌는지 같은 자리에서 읽힌다
 *  4. 지우면 프로젝트도 그 세션도 사이드바에서 사라진다
 */
test('프로젝트 삭제: 이름을 쳐야 열리고, 파일 체크는 경고로 바뀐다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '무슨 일이든')

  // 1. 메뉴 버튼은 감춰져 있다 (DOM에는 있고 눈에는 없다 — 호버·포커스로 나온다).
  //    세션을 만드느라 방금 이 버튼을 눌렀으므로 포인터를 먼저 치운다 — 안 그러면 호버가 남아 있다
  await page.mouse.move(0, 0)
  const actions = page.getByTestId('project-actions-alpha')
  await expect(actions).toHaveCSS('opacity', '0')
  await page.getByTestId('project-header-alpha').hover()
  await expect(actions).toHaveCSS('opacity', '1')

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('delete-project-alpha').click()

  // 2. 이름을 치기 전에는 못 지운다
  const confirm = page.getByTestId('delete-project-confirm')
  await expect(confirm).toBeDisabled()
  // 기본은 "이 앱의 기록만" — 폴더는 그대로다
  await expect(page.getByTestId('delete-project-note')).toContainText('folder on disk is left alone')
  await expect(page.getByTestId('delete-project-warning')).toHaveCount(0)

  await page.getByTestId('delete-project-name-input').fill('alph')
  await expect(confirm).toBeDisabled()
  await page.getByTestId('delete-project-name-input').fill('alpha')
  await expect(confirm).toBeEnabled()

  // 3. 파일까지 지운다고 켜면 설명이 사라지고 경고가 그 자리에 선다
  await page.getByTestId('delete-project-files-toggle').locator('input').check()
  await expect(page.getByTestId('delete-project-note')).toHaveCount(0)
  await expect(page.getByTestId('delete-project-warning')).toContainText('/tmp/alpha')
  await expect(confirm).toHaveText('Delete and trash folder')
  // 경고는 삭제 팔레트로 선다 (도그푸딩: 위험한 자리는 빨갛게) — diff의 del 색 그대로다
  await expect(page.getByTestId('delete-project-warning')).toHaveCSS('background-color', 'rgb(43, 21, 23)')
  await expect(confirm).toHaveCSS('color', 'rgb(255, 161, 152)')

  // 4. 지운다 — 프로젝트도 세션도 사라지고, 폴더는 휴지통으로 갔다
  await confirm.click()
  await expect(page.getByTestId('delete-project-dialog')).toBeHidden()
  await expect(page.getByTestId('project-alpha')).toHaveCount(0)
  await expect(page.getByTestId('sidebar').getByTestId(/^session-row-/)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual(['.'])
})

/** 파일을 안 켜면 폴더는 손대지 않는다 — 기본값이 정말 기본값인지 (경고문이 아니라 동작으로) */
test('프로젝트 삭제: 파일 체크를 안 하면 폴더는 그대로다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-header-alpha').hover()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('delete-project-alpha').click()
  await page.getByTestId('delete-project-name-input').fill('alpha')
  await page.getByTestId('delete-project-confirm').click()

  await expect(page.getByTestId('project-alpha')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual([])
})

/**
 * 오케스트레이터를 **어느 문으로 들어가든** 오케스트레이터 화면이어야 한다 (도그푸딩 버그).
 *
 * 사이드바 버튼으로 들어가면 맞았고, 상단 바의 응답 대기 목록으로 들어가면 틀렸다:
 * 오케스트레이터 대화가 세션 화면의 틀 안에서 열려 **오른쪽 증거 레인이 딸려 나왔고**
 * (오케스트레이터에는 볼 저장소가 없다), 사이드바 버튼은 안 눌린 것처럼 보였다.
 *
 * 알림 카드도 같은 문(focusSession)을 쓰므로 같이 못 박는다 — 원인이 하나면 증상도
 * 하나로 끝나야 하고, 그 사실은 두 입구를 모두 눌러 봐야만 증명된다.
 */
test('오케스트레이터는 인박스로 들어가도 오케스트레이터 화면이다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // 오케스트레이터를 세우고 응답 대기로 만든다
  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('orchestrator-input').fill('상태 좀 보여줘')
  await page.getByTestId('orchestrator-input').press('Enter')
  const orc = await page.evaluate(
    () => [...(window as any).__mock.sessions.values()].find((s: any) => s.projectId === null).id,
  )
  await page.evaluate((id: string) => {
    ;(window as any).__mock.emit({ type: 'state_change', sessionId: id, state: 'waiting_input' })
  }, orc)

  // 다른 데를 보고 있다가 — 세션 화면으로 옮겨 둔다
  await newSession(page, 'alpha', '딴 일')
  await expect(page.getByTestId('evidence-panel')).toBeVisible()

  // 상단 바의 응답 대기 목록으로 돌아온다
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  await page.getByTestId(`inbox-item-${orc}`).click()

  // 증거 레인은 딸려 나오지 않는다 — 오케스트레이터에는 볼 저장소가 없다
  await expect(page.getByTestId('evidence-panel')).toHaveCount(0)
  // 그리고 사이드바에서 눌린 것으로 보인다
  await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('orchestrator')

  /*
    두 번째 문: 응답이 끝났다고 알리는 카드 (도그푸딩에서 함께 물은 것).
    같은 focusSession을 부르므로 원인은 하나지만, "원인이 하나였다"는 것은
    두 입구를 다 눌러 봐야 사실이 된다.
  */
  // 다시 세션 화면으로 옮겨 둔다 — 카드는 보고 있지 않은 세션에만 뜬다
  await page.locator('[data-testid^="session-row-"]').first().click()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
  await page.evaluate((id: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'state_change', sessionId: id, state: 'working' })
    m.emit({ type: 'turn_complete', sessionId: id })
  }, orc)
  await page.getByTestId('notice-open').click()
  await expect(page.getByTestId('evidence-panel')).toHaveCount(0)
  await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('aria-pressed', 'true')
})

/*
 * 관제 레일 (#80·#81) — 사람의 작업대. 내 차례가 줄로 서고, 한 줄짜리 답은
 * 줄 안에서 끝나며, 기계의 알림(control_notify)이 꽂히고, 토글이 흔적 없이 끈다.
 */
test('관제 레일: 내 차례 즉답·알림·토글이 오케스트레이터 화면에서 돈다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '레일 시험')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  // 턴을 끝내 세션을 "내 차례"로 — working 확인 후 끝낸다 (이벤트 역전 방지)
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid]?.state, id))
    .toBe('working')
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'turn_complete', sessionId: sid })
    m.emit({ type: 'state_change', sessionId: sid, state: 'waiting_input' })
  }, id)

  await page.getByTestId('orchestrator-button').click()
  await expect(page.getByTestId('control-rail')).toBeVisible()

  // 내 차례에 줄이 서고, 줄 안 즉답이 세션에 닿는다 — 세션을 열지 않고 기어를 돌린다
  await expect(page.getByTestId(`rail-turn-${id}`)).toBeVisible()
  await page.getByTestId(`rail-input-${id}`).fill('이어서 진행해')
  await page.getByTestId(`rail-input-${id}`).press('Enter')
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid]?.state, id))
    .toBe('working')

  // 진행 중 줄은 **말이 정본, 도구는 보조** — 툴 제목이 서사를 덮으면 맥락이 사라진다
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: '정렬 문제를 고치는 중입니다' })
    m.emit({ type: 'tool_call', sessionId: sid, callId: 'c9', summary: { tool: 'Bash', title: 'pnpm verify', readOnly: false, paths: [] } })
  }, id)
  await expect(page.getByTestId(`rail-running-${id}`)).toContainText('정렬 문제를 고치는 중입니다')
  await expect(page.getByTestId(`rail-running-${id}`)).toContainText('Bash: pnpm verify')

  // 즉답은 판정 숫자로 남는다 — "계속 쓰는가"는 감이 아니라 숫자다
  await expect
    .poll(() => page.evaluate(() => ((window as any).__store.getState().apps['control']?.doc?.metrics ?? {}).inlineReplies ?? 0))
    .toBeGreaterThan(0)

  // 기계의 알림 — 사람이 읽고 지운다
  await page.evaluate(() => {
    void (window as any).__store.getState().setAppDoc('control', {
      notifies: [{ id: 'n1', text: '세션3이 외부 조건에 막혔습니다', priority: 'high', ts: 1 }],
    })
  })
  await expect(page.getByTestId('rail-notify-n1')).toContainText('막혔습니다')
  await page.getByTestId('rail-notify-dismiss-n1').click()
  await expect(page.getByTestId('rail-notify-n1')).toHaveCount(0)

  // 폭 조절 — 왼 모서리 끌기, 더블클릭 = 기본 폭. 보는 방식이라 워크스페이스에 남는다
  const railBox = async () => (await page.getByTestId('app-rails').boundingBox())!
  const before = (await railBox()).width
  const handle = (await page.getByTestId('rail-resize').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + 100)
  await page.mouse.up()
  expect((await railBox()).width).toBeGreaterThan(before + 60)
  await page.getByTestId('rail-resize').dblclick()
  expect(Math.abs((await railBox()).width - before)).toBeLessThan(4)

  // 토글 오프 = 레일이 흔적 없이 물러난다 (지워지는 게 아니라)
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-apps').click()
  // 감시 선언 편집기 (#80 체크포인트 v1) — 패턴이 문서에 남는다 (판정은 host 관찰 훅의 몫)
  await page.getByTestId('watch-pattern').fill('git commit')
  await page.getByTestId('watch-add').click()
  await expect
    .poll(() => page.evaluate(() => ((window as any).__store.getState().apps['control']?.doc?.watches ?? []).length))
    .toBe(1)
  await page.locator('[data-testid^="watch-remove-"]').click()
  await expect
    .poll(() => page.evaluate(() => ((window as any).__store.getState().apps['control']?.doc?.watches ?? []).length))
    .toBe(0)

  await page.getByTestId('app-toggle-control').locator('input').uncheck()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('control-rail')).toHaveCount(0)
})
