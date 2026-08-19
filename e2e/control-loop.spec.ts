import { test, expect, type Locator, type Page } from '@playwright/test'

/**
 * M1 Phase 5 완료 기준. mock platform(?mock)으로 UI를 구동한다.
 * 핵심은 마지막 "관제 루프" 시나리오 — §1.3의 실제 사용 흐름이 도는지.
 */

/** 브라우저 안의 mock을 조작하는 헬퍼 (window.__mock) */
async function setup(page: Page, opts: { projects?: string[] } = {}) {
  await page.goto('/?mock=1')
  // 프로젝트가 없으면 시작 안내가 먼저 나온다 (FR-19)
  await expect(page.getByTestId('first-run')).toBeVisible()
  for (const path of opts.projects ?? []) {
    await page.getByTestId('add-project').click()
    await page.getByTestId('project-path-input').fill(path)
    await page.getByTestId('project-add-confirm').click()
  }
}

async function newSession(page: Page, projectName: string, prompt: string) {
  // 새 세션은 다이얼로그를 거친다 (FR-7: 도구·모델·권한을 고른다)
  await page.getByTestId(`new-session-${projectName}`).click()
  await page.getByTestId('initial-prompt').fill(prompt)
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
}

/**
 * 모델·강도·권한·에이전트는 입력창 아래 **메뉴 안에** 있다 (셀렉터 네 개가 아니라).
 * `scope`를 주면 그 칸의 메뉴다 — 그리드는 칸마다 입력창을 갖는다.
 */
async function pickSetting(page: Page, testId: string, scope?: Locator) {
  const root = scope ?? page
  await root.getByTestId('settings-open').click()
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

test('없는 경로는 오류를 보여준다 (첫 실행 경험)', async ({ page }) => {
  await setup(page)
  await page.getByTestId('add-project').click()
  await page.getByTestId('project-path-input').fill('')
  await expect(page.getByTestId('project-add-confirm')).toBeDisabled()
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
    type: 'tool_call', callId: 'c1',
    summary: { tool: 'Read', title: 'Read: a.ts', readOnly: true, paths: [] },
  })
  await emitEvent(page, 0, {
    type: 'tool_result', callId: 'c1', ok: true,
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
    ['alpha', 'A1'], ['alpha', 'A2'], ['alpha', 'A3'], ['beta', 'B1'], ['beta', 'B2'],
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

  // 남은 응답대기 3건은 d(아카이브)로 비운다
  for (let i = 0; i < 5; i++) {
    const remaining = await page.locator('[data-testid^="inbox-item-"]').count()
    if (remaining === 0) break
    await page.keyboard.press('d')
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

  // 비포커스 세션에 새 내용 → 안읽음
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: '결과입니다' })
  const sessionId = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...(m as any).sessions.values()][0].id
  })
  await expect(page.getByTestId(`unread-${sessionId}`)).toBeVisible()

  // 포커스하면 읽음 처리 (3초 규칙)
  await page.getByTestId(`session-row-${sessionId}`).click()
  await expect(page.getByTestId(`unread-${sessionId}`)).toBeHidden({ timeout: 8000 })
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
   * 아직 턴이 끝나지 않았으면 값이 **없다** (context는 SessionInfo에도 DB에도 없어서
   * 앱을 껐다 켜면 늘 이 상태다). '모름'과 '0%'는 다른 말이므로 다르게 보여야 한다 —
   * 값이 없는데 0%로 그리면 "아직 하나도 안 썼다"는 거짓말이 된다.
   */
  await expect(page.getByTestId('context-gauge')).toContainText('—')
  await emitEvent(page, 0, { type: 'context_update', used: 0, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('0%')

  await emitEvent(page, 0, { type: 'context_update', used: 168000, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('84%')

  await emitEvent(page, 0, { type: 'limit_reached', usedPercent: 21, windowMins: 10080 })
  await expect(page.getByTestId('limit-badge')).toContainText('21%')
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

  // 아카이브도 동작해야 한다
  await page.keyboard.press('d')
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(1)
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
      m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `줄 ${i} — 대화 내용입니다.\n` })
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
    for (let i = 0; i < 100; i++) m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `줄 ${i} — 대화 내용입니다.\n\n` })
  })

  const stream = page.getByTestId('chat-stream')
  // "위로 올렸다"가 성립하려면 바닥 슬랙(scroll.ts BOTTOM_SLACK=80px)보다 훨씬 큰
  // 스크롤 범위가 필요하다 — 안 그러면 맨 위도 "바닥 근처"라 따라가는 게 정답이 되고,
  // 범위가 0이면 scrollTop이 늘 0이라 통과가 무의미하다
  await expect.poll(() => stream.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(400)
  await stream.evaluate((el) => { el.scrollTop = 0 }) // 맨 위로 올려 읽는 중
  // 가상 스크롤은 올려놓은 직후 항목 실측으로 위치를 살짝 고칠 수 있다 —
  // 그 보정이 끝나 자리가 멈춘 뒤의 값을 기준으로 삼아야 "새 메시지 때문"만 잰다
  await expect.poll(async () => {
    const now = await stream.evaluate((el) => el.scrollTop)
    await page.waitForTimeout(120)
    return (await stream.evaluate((el) => el.scrollTop)) === now
  }).toBe(true)
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

test('첫 실행: 도구 상태를 보여주고 다음 행동을 알려준다 (E-1, FR-19)', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible()
  await expect(page.getByTestId('tool-claude')).toContainText('Claude Code')

  // 디렉토리 선택 → 프로젝트 등록 → 관제 화면으로 전환
  await page.getByTestId('first-run-pick').click()
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect(page.getByTestId('project-picked')).toBeVisible()
})

test('첫 실행: 도구가 준비 안 됐으면 설치 명령을 보여준다 (E-1)', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.agents.detect = async () => [
      { tool: 'claude', installed: false, loggedIn: false, detail: 'not installed' },
      { tool: 'codex', installed: true, loggedIn: false, detail: 'codex-cli 0.147' },
    ]
  })
  await page.getByTestId('redetect').click()
  await expect(page.getByTestId('tool-claude')).toContainText('npm i -g @anthropic-ai/claude-code')
  await expect(page.getByTestId('tool-codex')).toContainText('log in')
  await expect(page.getByTestId('first-run-blocked')).toBeVisible()
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

  const longId: string = (await page.evaluate(() => Object.keys((window as any).__store.getState().sessions)))[0]!
  await page.evaluate((id) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    store.getState().focusSession(id)
    // 델타는 한 메시지로 합쳐지므로, 항목이 실제로 늘어나는 도구 호출로 채운다
    for (let i = 0; i < 300; i++) {
      m.emit({
        type: 'tool_call', sessionId: id, callId: `c${i}`,
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

test('인박스 10건을 연속 처리해도 커서가 어긋나지 않는다 (L4-3 반복 조작)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  for (let i = 0; i < 10; i++) await newSession(page, 'alpha', `작업 ${i}`)
  await page.evaluate(() => {
    const m = (window as any).__mock
    for (const id of m.sessions.keys()) m.emit({ type: 'turn_complete', sessionId: id })
  })

  await page.keyboard.press('Meta+i')
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(10)

  // 키보드만으로 전부 정리 — 중간에 커서가 빈 자리를 가리키면 여기서 깨진다
  for (let i = 0; i < 10; i++) await page.keyboard.press('d')
  await expect(page.getByTestId('inbox-empty')).toBeVisible()
  await expect(page.getByTestId('count-input')).toContainText('00')
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

test('세션 생성: 도구만 고른다 — 모델·권한은 만든 뒤 헤더에서 (M2.5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('new-session-alpha').click()

  // 다이얼로그가 단순해졌다: 도구 + 시작 프롬프트뿐
  await expect(page.getByTestId('model-input')).toHaveCount(0)
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('initial-prompt').fill('첫 지시')
  await page.getByTestId('create-session-confirm').click()

  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params).toMatchObject({ tool: 'claude', initialPrompt: '첫 지시' })
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
  await page.getByTestId('new-session-alpha').click()
  // 버튼만 죽어 있으면 '아무 동작 안 함'으로 보인다 — 이유를 적는다
  await expect(page.getByTestId('tool-blocked')).toContainText('not found')
  await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
  // 쓸 수 있는 도구로 바꾸면 즉시 풀린다
  await page.getByTestId('tool-option-codex').click()
  await expect(page.getByTestId('create-session-confirm')).toBeEnabled()
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
      id: 'p-nogit', path, name: 'nogit', defaultTool: 'claude', git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
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

  // 무시된 항목은 기본으로 숨는다
  await expect(page.getByTestId('dir-node_modules')).toBeHidden()
  await page.getByTestId('toggle-ignored').check()
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()

  // 하위는 열어야 읽는다 (lazy)
  await expect(page.getByTestId('file-src/a.ts')).toBeHidden()
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
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
    name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x'),
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

  // 단축키 표도 여기서 확인된다 (FR-17)
  await expect(page.getByTestId('shortcut-list')).toContainText('⌘⇧1~4')
})

test('권한 거부를 "저장소 아님"과 구분해 안내한다 (F-1 실측 반영)', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const m = (window as any).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-denied', path, name: 'denied', defaultTool: 'claude',
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

  await page.getByTestId(`delete-session-${id}`).click()
  // "되돌릴 수 없습니다"는 사실이 아니다 — 무엇이 지워지고 무엇이 남는지를 말한다
  await expect(page.getByTestId('confirm-delete')).toContainText('Chat history and attachments')
  await page.getByTestId('confirm-delete-yes').click()

  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(0)
})

test('세션 생성이 실패하면 모달에 이유가 남는다 (M2.5: 눌러도 반응 없어 보이던 문제)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.agents.createSession = async () => {
      throw new Error('Could not start claude session: Native CLI binary not found')
    }
  })
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()

  // 토스트는 사라지지만 이건 남는다
  await expect(page.getByTestId('create-session-error')).toContainText('Could not start')
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
})

test('host가 이미 준비된 뒤에 붙어도 기동한다 (회귀: 이벤트를 놓쳐 30초 멈추던 문제)', async ({ page }) => {
  // mock 플랫폼은 즉시 준비되므로, attach가 늦어도 화면이 뜨는지만 본다
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible({ timeout: 5000 })
  // 기동 실패 화면이 아니어야 한다
  await expect(page.getByText('Could not start the agent host')).toHaveCount(0)
})

test('세션 없이도 프로젝트의 깃·파일·뷰어를 볼 수 있다 (도그푸딩: 어디서 보는지 못 찾음)', async ({ page }) => {
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
        { externalId: 'ext-1', tool: 'claude', title: '어제 하던 리팩터링', updatedAt: Date.now() - 3600_000, createdAt: null, branch: 'main', imported: false },
        { externalId: 'ext-2', tool: 'claude', title: '빌드 깨진 것 추적', updatedAt: Date.now() - 86400_000, createdAt: null, branch: null, imported: false, importedAs: null },
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
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-2').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await page.getByTestId('new-session-alpha').click()
  // 기본은 '새 대화' — 불러오기가 기본이 되면 안 된다
  await expect(page.getByTestId('past-new')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('past-ext-1')).toContainText('어제 하던 리팩터링')
  // 제목이 '첫 메시지'인 도구(codex)에서도 최신 여부를 알 수 있어야 한다
  await expect(page.getByTestId('past-ext-1')).toContainText('last 1h ago')
  await expect(page.getByTestId('past-ext-2')).toContainText('Already open')

  await page.getByTestId('past-ext-1').click()
  await expect(page.getByTestId('resume-note')).toBeVisible()
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

  // 불러온 대화로 안 읽음 배지를 띄우지 않는다 (이미 읽은 대화다)
  const sessionId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()].at(-1))
  await expect(page.getByTestId(`unread-${sessionId}`)).toHaveCount(0)
})

test('구버전 도구는 목록을 못 줘도 새 세션을 막지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(page, {
    supported: false,
    reason: 'The installed Codex does not support listing past sessions (update codex)',
    sessions: [],
  })

  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-unsupported')).toContainText('update codex')
  // 이유는 보이되 길은 열려 있어야 한다
  await expect(page.getByTestId('create-session-confirm')).toHaveText('Start')
  await page.getByTestId('initial-prompt').fill('그래도 새로 시작')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.getByTestId('chat-stream')).toContainText('그래도 새로 시작')
})

test('이전 대화가 없으면 없다고 말한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(page, { supported: true, sessions: [] })
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
test('증거 패널 탭: 깃은 위가 변경·아래가 기록, 파일 탭은 트리', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: '첫 커밋', author: '나', when: Date.now(), parents: [] },
      { sha: 'bbb222', shortSha: 'bbb222', subject: '두 번째', author: '나', when: Date.now(), parents: ['a', 'b'] },
    ]
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', '작업')

  // 깃 탭이 기본 — 위는 변경, 아래는 기록
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await expect(page.getByTestId('evidence-file-src/a.ts')).toBeVisible()
  await expect(page.getByTestId('evidence-tree')).toBeVisible()
  await expect(page.getByTestId('evidence-commit-aaa111')).toContainText('첫 커밋')
  await expect(page.getByTestId('evidence-commit-bbb222')).toContainText('merge')

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

  await page.getByTestId('evidence-commit-aaa111').click()
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

  await page.getByTestId(`delete-session-${id}`).click()

  // 실제보다 무섭게 말하면 사람은 정리하지 못하고 목록만 쌓인다
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

  // 저장소에는 250줄이 있고 화면에는 최근 200줄만 있다
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = Array.from({ length: 250 }, (_, i) => ({
      sessionId: sid, seq: i + 1, role: i % 2 ? 'assistant' : 'user',
      kind: 'text', payload: { text: `옛 대화 ${i + 1}` }, ts: Date.now(),
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

  // 화면에는 최근 200줄만 있다 (가상 스크롤이라 실제로 그려지는 건 더 적다)
  const loaded = (sid: string) => (window as any).__store.getState().chat[sid].length
  expect(await page.evaluate(loaded, id)).toBe(201) // 200 + 압축 표식

  // 버튼이 아니라 위로 올리면 알아서 이어붙인다
  await page.getByTestId('chat-stream').evaluate((el) => el.scrollTo({ top: 0 }))
  await expect(page.getByTestId('load-older')).toBeHidden() // 더 거슬러 갈 곳이 없다

  // 압축으로 모델이 잊은 대화도 우리 기록에는 남아 있다
  expect(await page.evaluate(loaded, id)).toBe(251)
  const first = await page.evaluate((sid: string) => (window as any).__store.getState().chat[sid][0].text, id)
  expect(first).toBe('옛 대화 1')
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
        sessionId: sid, seq: i + 1, role: i % 2 ? 'assistant' : 'user',
        kind: 'text', payload: { text: `기록 ${i + 1}` }, ts: Date.now(),
      })),
    )
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  // 그 위에 실시간 대화가 이어진다 (예전에는 여기서 seq가 1부터 다시 셌다)
  await page.getByTestId('prompt-input').fill('새로 한 말')
  await page.getByTestId('send').click()
  await page.evaluate(
    (sid) => (window as any).__mock.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: '새 답' }),
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
      type: 'tool_call', sessionId: sid, callId: 'c1',
      summary: { tool: 'Bash', title: 'pnpm test', readOnly: true, paths: [] },
    })
    m.emit({
      type: 'tool_result', sessionId: sid, callId: 'c1', ok: true,
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
  await expect
    .poll(async () => (await panel.boundingBox())!.width, { timeout: 2000 })
    .toBeCloseTo(340, -1)
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
  await expect(page.getByTestId('terminal-stack').locator('[data-testid^="terminal-surface-"]')).toHaveCount(1)

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
        { externalId: 'ext-1', tool: 'claude', title: '어제 하던 일', updatedAt: Date.now(), createdAt: null, branch: null, imported: false, importedAs: null },
      ],
    }
    m.externalHistory.set('ext-1', [{ role: 'user', text: '어제 하던 일' }])
  })

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-1').click()
  await page.getByTestId('create-session-confirm').click()
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 다시 열면 '이미 열려 있음'으로 표시되고, 누르면 만들지 않고 이동한다
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
      | (HTMLElement & { __kept?: boolean })
      | null
    return el?.__kept === true
  }, ids[0])
  expect(kept).toBe(true)
})

/** 사용량 (FR-9) — 구독 한도만 다룬다 */
test('사용량 모달: 창마다 도넛, 호버하면 초기화 시각까지', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'max',
        windows: [
          { id: 'session', label: '5 hours', percent: 8, resetsAt: new Date(Date.now() + 7_800_000).toISOString(), scope: null },
          { id: 'weekly_all', label: 'Weekly', percent: 93, resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString(), scope: null },
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

  // 일간을 못 주는 도구면 그 줄을 접는다 (Claude에는 일간 창이 없다)
  await expect(page.getByTestId('usage-daily')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('usage-modal')).toBeHidden()
})

test('일별 토큰을 주는 도구면 함께 보여준다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
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
        { externalId: 'ext-1', tool: 'claude', title: '하나뿐인 대화', updatedAt: Date.now(), createdAt: null, branch: null, imported: false, importedAs: null },
      ],
    }
    m.externalHistory.set('ext-1', [{ role: 'user', text: '하나뿐인 대화' }])
  })

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-1').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 다시 열면 '이미 열려 있음'이라 새로 만들지 않고 그 세션으로 간다
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
        { externalId: 'ext-long', tool: 'claude', title: '아주 오래된 첫 질문', updatedAt: Date.now(), createdAt: null, branch: null, imported: false, importedAs: null },
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

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-long').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 맨 아래(최신)가 화면에 있어야 한다
  await expect(page.getByTestId('chat-stream')).toContainText('가장 최신 메시지')

  const atBottom = await page.getByTestId('chat-stream').evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80,
  )
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
      { sessionId: sid, seq: rows.length + 1, role: 'user', kind: 'text', payload: { text: '터미널에서 한 말' }, ts: Date.now() },
      { sessionId: sid, seq: rows.length + 2, role: 'assistant', kind: 'text', payload: { text: '터미널 답' }, ts: Date.now() },
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

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('initial-prompt').fill('클로드 쪽 작업')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('initial-prompt').fill('코덱스 쪽 작업')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

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
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('initial-prompt').fill('오래 걸리는 일')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

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

  // 병합 커밋에서 두 갈래가 뻗는다 (직선 하나 + 갈라지는 곡선 하나)
  const merge = page.getByTestId('commit-graph-mmmmmmm')
  await expect(merge).toBeVisible()
  expect(await merge.locator('path').count()).toBeGreaterThan(0)

  // 가지가 본류로 합쳐지므로 뿌리에는 선이 하나만 내려온다
  await expect(page.getByTestId('commit-graph-zzzzzzz')).toBeVisible()
})

/** 커밋 목록과 기록 중 무엇을 더 볼지는 그때그때 다르다 */
test('깃 패널의 변경과 기록 사이 높이를 조절할 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  const before = (await page.getByTestId('evidence-tree').boundingBox())!.height
  const handle = page.getByTestId('evidence-tree-resize')
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y - 80)
  await page.mouse.up()

  const after = (await page.getByTestId('evidence-tree').boundingBox())!.height
  expect(after).toBeGreaterThan(before + 40)
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

  // 강도를 지원하지 않는 모델에는 강도 묶음이 없다 — 아무 효과 없는 칸을 띄우면 거짓말이다
  await menu.getByTestId('settings-model-haiku').click()
  await page.getByTestId('settings-open').click()
  // 메뉴가 실제로 열려 있는 것을 먼저 확인한다 — 안 열린 화면에서 "없다"는 아무 증명이 아니다
  await expect(menu).toContainText('Haiku')
  await expect(menu).not.toContainText('Effort')

  await menu.getByTestId('settings-model-fable').click()
  await page.getByTestId('settings-open').click()
  await expect(menu).toContainText('Effort')
  await menu.getByTestId('settings-effort-xhigh').click()

  const settings = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId]
  })
  expect(settings.model).toBe('fable')
  expect(settings.effort).toBe('xhigh')
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
    m.fsState.entries[''] = [{ name: 'a'.repeat(120) + '.ts', path: 'src/' + 'a'.repeat(120) + '.ts', isDir: false, ignored: false }]
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
  await input.fill('두 번째 질문')
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
  await expect.poll(async () => page.evaluate(() => (window as any).__store.getState().connection)).not.toBe('connected')

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
    m.fsState.entries[''] = [{ name: 'only-in-alpha.ts', path: 'only-in-alpha.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'work a')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-only-in-alpha.ts')).toBeVisible()

  // 두 번째 프로젝트는 다른 파일을 갖는다
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'only-in-beta.ts', path: 'only-in-beta.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'beta', 'work b')

  await expect(page.getByTestId('file-only-in-beta.ts')).toBeVisible()
  await expect(page.getByTestId('file-only-in-alpha.ts')).toBeHidden()
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
    page.evaluate(() =>
      Object.values((window as any).__store.getState().projects).map((p: any) => p.name),
    )
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
test('사이드바의 + 와 삭제 버튼이 같은 세로줄에 선다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 삭제는 호버해야 나타난다
  await page.getByTestId(`session-row-${id}`).hover()

  const plus = (await page.getByTestId('new-session-alpha').boundingBox())!
  const del = (await page.getByTestId(`delete-session-${id}`).boundingBox())!

  expect(Math.abs(plus.x + plus.width - (del.x + del.width))).toBeLessThanOrEqual(1)
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
      kind: i % 2 ? 'assistant' : 'user', seq: 1000 + i, text: `긴 대화 ${i}`,
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
  const ids = await page.evaluate(() =>
    Object.keys((window as any).__store.getState().sessions),
  )

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
      kind: i % 2 ? 'assistant' : 'user', seq: 1000 + i, text: `긴 대화 ${i} `.repeat(6),
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  const box = await page.getByTestId(`grid-panel-${id}`).getByTestId('chat-stream').evaluate((el) => ({
    top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight,
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
    h: el.scrollHeight, c: el.clientHeight,
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
    store.setState({ chat: { ...store.getState().chat, [sid]: [{ kind: 'assistant', seq: 1, text: '고를 수 있어야 하는 문장' }] } })
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
      { sessionId: sid, seq: 1, role: 'user', kind: 'text', payload: { text: '저장된 옛 질문' }, ts: Date.now() },
      { sessionId: sid, seq: 2, role: 'assistant', kind: 'text', payload: { text: '저장된 옛 답' }, ts: Date.now() },
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
    type: 'tool_call', callId: 'c1',
    summary: { tool: 'Bash', title: 'npm run build', readOnly: false, paths: [] },
  })
  await emitEvent(page, 0, { type: 'tool_result', callId: 'c1', ok: true, summary: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8' })

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
          new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: r.top + 10 }),
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
  // 세션 하나짜리 화면이 뜬다 (포커스 뷰와 같은 부품)
  await expect(page.getByTestId('session-view')).toBeVisible()
  await expect(page.getByTestId('grid')).toBeHidden()
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
  await expect(page.getByTestId('session-view')).toBeVisible()

  await page.getByTestId('prompt-input').fill('@readme')
  const menu = page.getByTestId('autocomplete')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('readme')
  // 파일 경로가 아니라 세션 이름이다 — 프로젝트 이름이 힌트로 붙는다
  await expect(menu).toContainText('alpha')
})

/**
 * 에이전트 바꾸기 (claude ↔ codex).
 *
 * 모델·권한과 나란히 있지만 성질이 다르다 — 대화가 끊긴다.
 * 그래서 **확인 없이는 바뀌지 않는다.**
 */
test('에이전트를 바꾸려면 대화가 끊긴다는 것을 확인해야 한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // 메뉴 안에서도 지금 도구가 무엇인지 읽힌다
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-tool-claude')).toHaveAttribute('aria-checked', 'true')
  // 같은 메뉴에 있어도 같은 무게가 아니다 — 무슨 일이 일어나는지 먼저 적혀 있다
  await expect(page.getByTestId('settings-menu')).toContainText('starts a fresh conversation')

  // 고르기만 하면 확인 창이 뜬다 — 아직 바뀌지 않는다
  await page.getByTestId('settings-tool-codex').click()
  await expect(page.getByTestId('tool-switch-confirm')).toBeVisible()
  await expect(page.getByTestId('tool-switch-confirm')).toContainText('will not have this conversation')
  expect(await page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, id)).toBe('claude')

  // 취소하면 그대로
  await page.getByTestId('tool-switch-cancel').click()
  expect(await page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, id)).toBe('claude')

  // 확인해야 바뀐다
  await pickSetting(page, 'settings-tool-codex')
  await page.getByTestId('tool-switch-confirm-btn').click()
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-tool-codex')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  expect(await page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, id)).toBe('codex')
  // 사이드바 표식도 따라온다
  await expect(page.getByTestId('tool-mark-codex')).toBeVisible()
})

test('에이전트를 바꾸면 이어갈 실마리를 끊는다 — 새 도구는 옛 대화를 모른다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await pickSetting(page, 'settings-tool-codex')
  await page.getByTestId('tool-switch-confirm-btn').click()
  await expect
    .poll(async () => page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, id))
    .toBe('codex')

  // host가 externalId를 끊었는지 (codex에 Claude의 대화 id를 넘기면 엉뚱한 것을 잡는다)
  const ext = await page.evaluate(
    (s) => [...(window as any).__mock.sessions.values()].find((x: any) => x.id === s)?.externalId,
    id,
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
  await newSession(page, 'alpha', 'second')  // 이쪽을 보고 있다

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
    .poll(() => page.evaluate(() => (window as never as { __mock: { alerts: { kind: string }[] } }).__mock.alerts))
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
  expect(await page.evaluate(() => (window as never as { __mock: { alerts: unknown[] } }).__mock.alerts.length)).toBe(0)
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
    () => (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState().focusedSessionId,
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
    () => (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState().focusedSessionId,
  )
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('notice')).toHaveCount(1)

  await page.getByTestId('notice-close').click()

  await expect(page.getByTestId('notice')).toHaveCount(0)
  const after = await page.evaluate(
    () => (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState().focusedSessionId,
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
      page.evaluate(() => (window as never as { __mock: { alerts: { kind: string; sound: boolean }[] } }).__mock.alerts),
    )
    .toEqual([{ kind: 'approval', sound: true }])
})

/*
 * 도그푸딩 신고: "소리는 들리는데 토스트가 안 뜬다."
 *
 * 원인은 시험 버튼이 소리와 독만 울리고 카드를 만들지 않은 것이었다. **절반만 시험하는
 * 시험 버튼**은 없는 증상을 만든다 — 확인하라고 둔 것이 오해를 낳으면 없느니만 못하다.
 */
test('Test it은 소리·독·카드를 다 태운다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // 이쪽을 보고 있다 → first가 화면 밖

  await page.getByTestId('open-settings').click()
  await page.getByTestId('notify-test').click()

  // 소리·독
  await expect
    .poll(() =>
      page.evaluate(() => (window as never as { __mock: { alerts: unknown[] } }).__mock.alerts.length),
    )
    .toBe(1)
  // 카드. 설정 창은 비켜야 한다 — 그 뒤에 뜨면 있어도 못 본다
  await expect(page.getByTestId('settings')).toHaveCount(0)
  await expect(page.getByTestId('notice')).toHaveCount(1)
})

test('볼 수 없는 세션이 없으면 카드가 없는 이유를 말한다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'only') // 하나뿐이고 그것을 보고 있다

  await page.getByTestId('open-settings').click()
  await page.getByTestId('notify-test').click()

  // 조용히 넘기면 "카드가 안 뜬다"가 되고, 원인을 엉뚱한 데서 찾게 된다
  await expect(page.getByTestId('toast')).toContainText('off screen')
  await expect(page.getByTestId('notice')).toHaveCount(0)
})

test('설정은 상단 바에서 바로 열린다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // 단축키 표가 이 안에 있다 — 단축키를 알아야만 열 수 있으면 안 된다
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings')).toBeVisible()
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

test('질문이 여러 개면 다 답해야 보낼 수 있다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: QUESTIONS })

  // 반만 보내면 모델이 나머지를 지어낸다 — 그래서 다 고르기 전엔 잠가 둔다
  await page.getByTestId('question-option').filter({ hasText: '김밥' }).click()
  await expect(page.getByTestId('question-submit')).toBeDisabled()

  await page.getByTestId('question-option').filter({ hasText: '커피' }).click()
  await expect(page.getByTestId('question-submit')).toBeEnabled()
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('답 받음: 김밥 | 커피')
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

  await page.getByTestId('new-session-alpha').click()
  const toggle = page.getByTestId('worktree-toggle').locator('input')
  await expect(toggle).not.toBeChecked()

  await toggle.check()
  await page.getByTestId('initial-prompt').fill('격리해서 고쳐줘')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

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

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('initial-prompt').fill('격리 세션')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // 커밋 안 된 변경이 있는 상태를 만든다 — 그때 무엇을 잃는지 말해야 한다
  await page.evaluate(() => {
    ;(window as any).__mock.mockWorktreeDirty = true
  })

  const row = page.getByTestId(/^session-row-/).first()
  await row.hover()
  await page.getByTestId(/^delete-session-/).first().click()

  const panel = page.getByTestId('delete-worktree')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('worktree-dirty')).toContainText('2')

  // 기본은 끄져 있다 — 지우는 쪽이 기본이면 되돌릴 수 없는 일이 조용히 일어난다
  await expect(page.getByTestId('delete-worktree-toggle')).not.toBeChecked()
})

test('워크트리가 아닌 세션을 지울 때는 워크트리 이야기를 꺼내지 않는다', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '보통 세션')

  await page.getByTestId(/^session-row-/).first().hover()
  await page.getByTestId(/^delete-session-/).first().click()

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
