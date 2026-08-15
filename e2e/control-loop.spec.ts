import { test, expect, type Page } from '@playwright/test'

/**
 * M1 Phase 5 완료 기준. mock platform(?mock)으로 UI를 구동한다.
 * 핵심은 마지막 "관제 루프" 시나리오 — §1.3의 실제 사용 흐름이 도는지.
 */

/** 브라우저 안의 mock을 조작하는 헬퍼 (window.__mock) */
async function setup(page: Page, opts: { projects?: string[] } = {}) {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  for (const path of opts.projects ?? []) {
    await page.getByTestId('add-project').click()
    await page.getByTestId('project-path-input').fill(path)
    await page.getByTestId('project-add-confirm').click()
  }
}

async function newSession(page: Page, projectName: string, prompt: string) {
  await page.getByTestId(`new-session-${projectName}`).click()
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('send').click()
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
