import { test, expect, type Page } from '@playwright/test'

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
  await expect(page.getByTestId('project-alpha')).toContainText('main')
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
  await emitEvent(page, 0, { type: 'tool_result', callId: 'c1', ok: true, summary: '파일 내용 200줄' })
  // 접혀 있으므로 결과가 안 보인다
  await expect(page.getByTestId('tool-card')).toBeVisible()
  await expect(page.getByText('파일 내용 200줄')).toBeHidden()
  await page.getByTestId('tool-card').getByRole('button').first().click()
  await expect(page.getByText('파일 내용 200줄')).toBeVisible()
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
  await expect(page.getByTestId('toast')).toContainText('이 세션')
  await expect(page.getByTestId('toast')).toContainText('npm test*') // 패턴 제안
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
  await expect(rows.first()).toContainText('승인 필요')

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
  await expect(page.getByTestId('inbox-empty')).toContainText('기다리는 항목이 없습니다')
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
  await expect(page.getByTestId('concurrent-alpha')).toContainText('동시 세션 2개')
})

test('컨텍스트 게이지와 한도 표시 (FR-14, FR-9)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
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

  await expect(page.getByTestId('toast')).toContainText('새 세션')
  // 보내지 못한 말풍선은 남지 않는다
  await expect(page.getByTestId('msg-user').filter({ hasText: '계속 진행해줘' })).toHaveCount(0)
})

test('죽은 세션은 이어가기를 권한다 (C-1, FR-10)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  // host 재시작 후 상태를 흉내낸다: 프로세스는 없고 기록만 남은 세션
  await page.evaluate(() => {
    const store = (window as any).__store
    const st = store.getState()
    const id = st.focusedSessionId
    store.setState({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], live: false } } })
  })

  await expect(page.getByTestId('resume-bar')).toBeVisible()
  await page.getByTestId('resume-session').click()
  // 되살아나면 안내가 사라진다
  await expect(page.getByTestId('resume-bar')).toBeHidden()
})

test('이어갈 수 없으면 이유를 알린다 (C-1 폴백, 조용한 실패 금지)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  await page.evaluate(() => {
    const m = (window as any).__mock
    const store = (window as any).__store
    const st = store.getState()
    const id = st.focusedSessionId
    m.unresumable.add(id) // 재개 불가로 표시
    store.setState({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], live: false } } })
  })

  await page.getByTestId('resume-session').click()
  await expect(page.getByTestId('toast')).toContainText('이어갈 수 없습니다')
  await expect(page.getByTestId('resume-bar')).toBeVisible() // 여전히 안내가 남는다
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
  await newSession(page, 'alpha', '긴 작업')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    for (let i = 0; i < 100; i++) m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `줄 ${i}\n` })
  })

  const stream = page.getByTestId('chat-stream')
  await stream.evaluate((el) => { el.scrollTop = 0 }) // 맨 위로 올려 읽는 중
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
      { tool: 'claude', installed: false, loggedIn: false, detail: '설치되지 않음' },
      { tool: 'codex', installed: true, loggedIn: false, detail: 'codex-cli 0.147' },
    ]
  })
  await page.getByTestId('redetect').click()
  await expect(page.getByTestId('tool-claude')).toContainText('npm i -g @anthropic-ai/claude-code')
  await expect(page.getByTestId('tool-codex')).toContainText('로그인')
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

  // 모델·권한은 세션 헤더에서 바꾼다
  await page.getByTestId('model-select').selectOption('haiku')
  await expect(page.getByTestId('toast')).toContainText('haiku')
  await page.getByTestId('preset-select').selectOption('safe')
  const sessions = await page.evaluate(() => [...(window as any).__mock.sessions.values()])
  expect(sessions[0]).toMatchObject({ model: 'haiku', permissionPreset: 'safe' })
})

test('도구를 못 쓰면 이유를 보여준다 (M2.5: 시작 버튼이 아무 반응 없던 문제)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.agents.detect = async () => [
      { tool: 'claude', installed: false, loggedIn: false, detail: 'claude CLI를 찾을 수 없습니다' },
      { tool: 'codex', installed: true, loggedIn: true, detail: 'codex 0.147' },
    ]
  })
  await page.getByTestId('new-session-alpha').click()
  // 버튼만 죽어 있으면 '아무 동작 안 함'으로 보인다 — 이유를 적는다
  await expect(page.getByTestId('tool-blocked')).toContainText('찾을 수 없습니다')
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
  await expect(page.getByTestId('concurrent-warning')).toContainText('유실')
})

test('탭 셸: ⌘⇧1~4로 전환하고 재시작 후 복원한다 (B-0)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')

  await expect(page.getByTestId('tab-bar')).toBeVisible()
  await page.keyboard.press('Meta+Shift+3')
  await expect(page.getByTestId('git-panel')).toBeVisible()

  // 스냅샷에 탭이 실리고, 다시 attach하면 그 탭으로 돌아온다
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.tab).toBe('git')

  await page.evaluate(async () => {
    const store = (window as any).__store
    store.setState({ tab: 'chat', focusedSessionId: null })
    await store.getState().attach((window as any).__mock)
  })
  await expect(page.getByTestId('git-panel')).toBeVisible()
})

test('깃 패널: 변경 목록·diff·스테이징·커밋 (B-2, B-6)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/new.ts', staged: false, status: '?' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1,2 +1,2 @@\n-옛 줄\n+새 줄\n 그대로'
  })
  await page.keyboard.press('Meta+Shift+3')

  await page.getByTestId('git-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  // 무채색 diff: 색이 아니라 기호와 밝기로 구분한다
  await expect(page.locator('[data-diff="add"]')).toContainText('새 줄')
  await expect(page.locator('[data-diff="del"]')).toContainText('옛 줄')

  await page.getByTestId('git-올리기-all').click()
  await page.getByTestId('commit-message').fill('테스트 커밋')
  await page.getByTestId('commit-button').click()
  await expect(page.getByTestId('toast')).toContainText('커밋')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('테스트 커밋')
})

test('깃 패널: 더티 상태 체크아웃은 막지 않고 결과를 먼저 보여준다 (B-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'feature/x', current: false, remote: false },
    ]
    m.gitState.dirty = ['src/a.ts']
  })
  await page.keyboard.press('Meta+Shift+3')
  await page.getByTestId('git-sub-branches').click()
  await page.getByTestId('branch-feature/x').click()

  await expect(page.getByTestId('checkout-warning')).toContainText('src/a.ts')
  await page.getByTestId('checkout-proceed').click()
  await expect(page.getByTestId('toast')).toContainText('전환')
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
  await expect(page.getByTestId('tab-git')).toBeDisabled()
})

test('파일 트리: lazy 로드 + 무시된 항목 토글 (C-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
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
  await page.keyboard.press('Meta+Shift+2')
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
  await newSession(page, 'alpha', '작업')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'big.ts', path: 'big.ts', isDir: false, ignored: false }]
    m.fsState.files['big.ts'] = Array.from({ length: 3000 }, (_, i) => `줄 ${i} 내용`).join('\n')
  })
  await page.keyboard.press('Meta+Shift+2')
  await page.getByTestId('file-big.ts').click()

  // 파일을 열면 뷰어 탭으로 전환된다
  await expect(page.getByTestId('code-viewer')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('big.ts')

  // 3000줄이어도 보이는 것만 그린다 (가상 스크롤)
  const rendered = await page.locator('[data-testid="code-viewer"] .whitespace-pre').count()
  expect(rendered).toBeLessThan(120)

  await page.getByTestId('viewer-search').fill('줄 42 ')
  await expect(page.getByTestId('viewer-match-count')).toContainText('1줄')
})

test('뷰어: 바이너리 파일은 안내만 한다 (C-3 비정상 경로)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'logo.png', path: 'logo.png', isDir: false, ignored: false }]
    m.fs.readFile = async () => ({ text: '', truncated: false, binary: true, bytes: 20480 })
  })
  await page.keyboard.press('Meta+Shift+2')
  await page.getByTestId('file-logo.png').click()
  await expect(page.getByTestId('viewer-binary')).toContainText('바이너리')
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
  await newSession(page, 'alpha', '배포 스크립트')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const ids = [...m.sessions.keys()]
    m.searchResults = [{ sessionId: ids[0], seq: 3, snippet: '토큰 만료 처리를 고쳤습니다' }]
  })

  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()

  await page.getByTestId('palette-input').fill('토큰')
  await expect(page.getByTestId('palette-item-message')).toContainText('토큰 만료')

  await page.getByTestId('palette-item-message').click()
  await expect(page.getByTestId('session-name')).toContainText('auth 리팩터링')
})

test('설정: 승인 규칙을 보고 지운다 (E-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '작업')
  await page.evaluate(() => {
    ;(window as any).__mock.rulesList = [
      { id: 1, scope: 'session', matcher: 'npm test*', decision: 'allow', createdAt: Date.now() },
    ]
  })

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('설정')
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
  await expect(page.getByTestId('git-denied')).toContainText('권한')
})

test('세션 삭제: 확인 후 목록에서 사라진다 (M2.5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', '지울 세션')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toContainText('되돌릴 수 없습니다')
  await page.getByTestId('confirm-delete-yes').click()

  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(0)
})

test('세션 생성이 실패하면 모달에 이유가 남는다 (M2.5: 눌러도 반응 없어 보이던 문제)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.agents.createSession = async () => {
      throw new Error('claude 세션을 시작하지 못했습니다: Native CLI binary not found')
    }
  })
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()

  // 토스트는 사라지지만 이건 남는다
  await expect(page.getByTestId('create-session-error')).toContainText('시작하지 못했습니다')
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
})

test('host가 이미 준비된 뒤에 붙어도 기동한다 (회귀: 이벤트를 놓쳐 30초 멈추던 문제)', async ({ page }) => {
  // mock 플랫폼은 즉시 준비되므로, attach가 늦어도 화면이 뜨는지만 본다
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible({ timeout: 5000 })
  // 기동 실패 화면이 아니어야 한다
  await expect(page.getByText('에이전트 호스트를 시작하지 못했습니다')).toHaveCount(0)
})
