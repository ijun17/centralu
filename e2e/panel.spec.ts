import { expect, test, type Page } from '@playwright/test'

/**
 * 우측 패널과 사용량 모달 — "화면에 여럿이 떠 있을 때 무엇을 보여주나".
 *
 * control-loop.spec.ts와 나누는 이유는 주제다. 저기는 관제 루프 한 바퀴가 도는지를 보고,
 * 여기는 **여러 개가 동시에 있을 때 화면이 무엇을 고르는가**를 본다 (#26, #21).
 */

/**
 * 움직임이 멈춘 뒤의 자리. 떠오르는 카드·내려오는 메뉴는 전환 중에 재면 **도중의 자리**를
 * 사실로 적게 된다 — 같은 값이 두 번 나올 때까지 기다린다.
 */
async function settled(loc: ReturnType<Page['getByTestId']>): Promise<{ x: number; y: number; width: number; height: number }> {
  let last: { x: number; y: number; width: number; height: number } | null = null
  for (let i = 0; i < 40; i++) {
    const box = (await loc.boundingBox())!
    if (last && Math.round(last.y) === Math.round(box.y) && Math.round(last.height) === Math.round(box.height)) return box
    last = box
    await new Promise((r) => setTimeout(r, 50))
  }
  return last!
}

/** 접힌 입력창을 띄우는 띠의 높이 (SessionView의 COMPOSER_REACH와 같은 값) */
const COMPOSER_REACH = 54

async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  // 프로젝트가 0개면 사이드바가 없다 — 첫 프로젝트는 시작 안내에서 등록한다
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('orchestrator-pick-folder').click()
  // 첫 등록은 세션 만들기로 곧장 이어진다 — 여기서는 프로젝트만 필요하므로 닫는다
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

/** 세션 하나를 만들고 그 id를 돌려준다 */
async function newSession(
  page: Page,
  project: string,
  tool: 'claude' | 'codex',
  prompt: string,
): Promise<string> {
  await page.getByTestId(`project-menu-${project}`).click()
  await page.getByTestId(`new-session-${project}`).click()
  await page.getByTestId(`tool-option-${tool}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  return page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId)
}

async function openGrid(page: Page, ids: string[]) {
  await page.evaluate(
    (l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l),
    ids,
  )
  await page.getByTestId('grid-button').click()
}

/** 기본 목은 창이 비어 있어 'usage-unavailable'만 그린다 — 도넛이 나오는 상태를 만든다 */
async function stubUsage(page: Page, windows?: unknown[]) {
  await page.evaluate((ws: unknown[] | undefined) => {
    ;(window as never as { __mock: any }).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'max',
        windows: ws ?? [{ id: 'session', label: '5 hours', percent: 41, resetsAt: null, scope: null }],
        daily: [],
      },
    }
  }, windows)
}

/**
 * 그리드의 접힌 입력창 (사용자 요청 2026-09-10).
 *
 * 두 줄짜리 그리드에서 읽는 자리가 좁았다 — 칸 370px 중 입력 영역이 95px인데 정작
 * 글자 칸은 22px이었다. 접으면 둥근 카드가 윗머리만 내밀고 있다가, 아래에 손이 오면
 * 대화 **위로 떠오른다.** 미는 게 아니라 덮으므로 읽던 줄은 움직이지 않는다.
 */
test('그리드에서 입력창은 접혀 있다가 아래에 손이 오면 떠오른다', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '하나')
  const b = await newSession(page, 'alpha', 'claude', '둘')
  await openGrid(page, [a, b])
  // 새로 만든 칸의 입력칸이 잡혀 있으면 접힘을 못 본다 — 손을 뗀다
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const chat = panel.getByTestId('chat-stream')
  await expect(shell).not.toHaveAttribute('data-up', 'true')
  const resting = (await chat.boundingBox())!.height

  // 칸의 아래쪽에 손을 올린다
  const box = (await panel.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await expect(shell).toHaveAttribute('data-up', 'true')

  // **덮는다** — 대화의 높이는 그대로다 (읽던 줄이 밀리면 안 된다)
  expect(Math.round((await chat.boundingBox())!.height)).toBe(Math.round(resting))

  // 대화 한복판으로 손을 옮기면 다시 내려간다
  await page.mouse.move(box.x + box.width / 2, box.y + 80)
  await expect(shell).not.toHaveAttribute('data-up', 'true')

  // 입력칸을 잡으면 손이 떠나도 안 내려간다 — 쓰는 도중에 발밑이 꺼지면 안 된다.
  // (잡으려면 먼저 떠올라야 한다 — 내려가 있는 입력칸은 칸 밖이라 애초에 눌리지 않는다)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await panel.getByTestId('prompt-input').click()
  await page.mouse.move(box.x + box.width / 2, box.y + 80)
  await expect(shell).toHaveAttribute('data-up', 'true')
})

/**
 * 떠오른 카드 위에 손이 있으면 내려가지 않는다 (사용자 지적 2026-09-10).
 *
 * 떠오르게 하는 띠는 칸 **아래쪽**에 있다. 카드는 그 띠보다 위로 올라오므로, 입력칸을
 * 누르러 손을 올리는 순간 띠를 벗어나 카드가 도로 내려갔다 — 누를 수가 없었다.
 */
test('떠오른 입력창 위에 손이 있으면 내려가지 않는다 — 그래서 누를 수 있다', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '하나')
  const b = await newSession(page, 'alpha', 'claude', '둘')
  await openGrid(page, [a, b])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const box = (await panel.boundingBox())!

  // 칸 아래쪽에 손을 올려 띄운다
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await expect(shell).toHaveAttribute('data-up', 'true')

  // 떠오른 카드의 윗부분(입력칸 줄)으로 손을 옮긴다 — 여기는 이미 띠 밖이다.
  // 카드는 이어서 떠오르므로(300ms) **멈춘 뒤에** 잰다 — 도중의 자리는 아직 사실이 아니다
  const up = await settled(shell)
  expect(up.y + 12).toBeLessThan(box.y + box.height - COMPOSER_REACH)
  await page.mouse.move(up.x + up.width / 2, up.y + 12)
  await expect(shell).toHaveAttribute('data-up', 'true')

  // 그리고 눌린다
  await panel.getByTestId('prompt-input').click()
  await expect(panel.getByTestId('prompt-input')).toBeFocused()
})

/**
 * 떠오르는 동안 **중간 자리들이 있어야 한다** (사용자 요청 2026-09-10: "부드럽게 올라오게").
 *
 * 처음엔 `transition-[transform,…]`이라 적었는데 한 프레임 만에 튀어 올랐다 — Tailwind v4의
 * `translate-y-*`는 `transform`이 아니라 **`translate` 속성**에 값을 싣는다. 전환이 걸린
 * 속성과 실제로 바뀌는 속성이 달라 아무것도 이어지지 않은 것이다. 그래서 여기서 재는 것은
 * "어떤 속성에 걸었나"가 아니라 **눈에 보이는 사실**이다: 도중에 여러 자리를 지나는가.
 */
test('입력창은 튀어 오르지 않고 이어서 떠오른다', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '하나')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  await expect(panel.getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')

  // 매 프레임 카드의 자리를 적는 기록기를 먼저 걸어 둔다
  await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="composer-shell"]')!
    const seen: number[] = []
    ;(window as never as { __tops: number[] }).__tops = seen
    const tick = () => {
      seen.push(Math.round(shell.getBoundingClientRect().top))
      if (seen.length < 60) requestAnimationFrame(tick)
    }
    tick()
  })

  const box = (await panel.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await page.waitForTimeout(700)

  const tops = await page.evaluate(() => (window as never as { __tops: number[] }).__tops)
  // 한 프레임에 튀면 자리는 둘뿐이다 (접힌 자리, 떠오른 자리)
  expect(new Set(tops).size).toBeGreaterThan(5)
})

/**
 * 떠오른 입력창은 **대화를 덮지 않고, 밀지도 않는다** (사용자 지적 2026-09-13).
 *
 * 원래 규칙은 "밀지 않고 덮는다"였다 — 읽으려고 손을 내리면 읽을 것이 카드 밑으로
 * 들어갔다. 반대로 떠오를 때 밀어 올리게 하면 답변 버튼이 손 앞에서 달아난다: 카드를
 * 부르는 손짓과 버튼을 누르는 손짓이 같기 때문이다. 그래서 빈 자리를 처음부터 비워 둔다.
 */
test('떠오른 입력창은 마지막 줄을 덮지도, 밀지도 않는다', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '하나')
  // 바닥에 붙을 만큼 길어야 한다 — 짧은 대화는 애초에 카드에 닿지 않는다
  await page.evaluate((sid: string) => {
    const m = (window as never as { __mock: any }).__mock
    for (let i = 0; i < 40; i++) {
      m.emit({ type: 'user_message', sessionId: sid, seq: 0, text: `물음 ${i + 1}` })
      m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: `답 ${i + 1}` })
    }
  }, a)
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  await expect(panel.getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')

  const read = () =>
    panel.evaluate((el) => {
      const sc = el.querySelector('[data-testid="chat-stream"]') as HTMLElement
      const shell = el.querySelector('[data-testid="composer-shell"]') as HTMLElement
      const pad = parseFloat(getComputedStyle(sc).paddingBottom)
      return {
        pad: Math.round(pad),
        cardTop: Math.round(shell.getBoundingClientRect().top),
        cardHeight: Math.round(shell.getBoundingClientRect().height),
        atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 2,
        // 마지막 내용의 화면상 아래끝 (여백은 내용이 아니므로 뺀다)
        lastBottom: Math.round(sc.getBoundingClientRect().top - sc.scrollTop + (sc.scrollHeight - pad)),
      }
    })

  // 최신 줄을 읽는 상태를 만든다 — 불편하다고 한 그 자리다
  await panel.evaluate((el) => {
    const sc = el.querySelector('[data-testid="chat-stream"]') as HTMLElement
    sc.scrollTop = sc.scrollHeight
    sc.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(async () => (await read()).atBottom).toBe(true)
  // 여백은 300ms에 걸쳐 자리를 잡는다 — 전환 중에 재면 도중의 값을 사실로 적는다
  await expect.poll(async () => {
    const m = await read()
    return m.pad === m.cardHeight
  }).toBe(true)
  const down = await read()

  const box = (await panel.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await expect(panel.getByTestId('composer-shell')).toHaveAttribute('data-up', 'true')
  // 전환이 끝날 때까지 기다린다 — 전환 중에 재면 도중의 자리를 사실로 적는다
  await page.waitForTimeout(700)

  const up = await read()
  // 여백은 접혀 있을 때부터 카드만큼이었고, 떠올라도 그대로다
  expect(down.pad).toBe(up.cardHeight)
  expect(up.pad).toBe(up.cardHeight)
  // 마지막 줄은 카드 위에 있다 — 덮이지 않는다
  expect(up.atBottom).toBe(true)
  expect(up.lastBottom).toBeLessThanOrEqual(up.cardTop)
  /*
   * 그리고 **한 픽셀도 안 움직였다.** 이 단언이 움직이는 과녁을 막는다 — 카드를 부르는
   * 손짓이 곧 답변 버튼을 누르러 가는 손짓이라, 여기서 밀리면 버튼이 손 앞에서 달아난다.
   */
  expect(up.lastBottom).toBe(down.lastBottom)
})

/**
 * 응답 중인 칸을 두르는 무지개 링은 **칸의 테두리**다. 칸 안에 무엇이 떠 있든 끊기면
 * 안 되는데, 접힌 입력창이 아랫변을 덮고 있었다 (사용자 지적 2026-09-10).
 */
test('접힌 입력창은 응답 중 링을 덮지 않는다 — 링이 위에 선다', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '하나')
  await openGrid(page, [a])
  const panel = page.getByTestId(`grid-panel-${a}`)
  await expect(panel.locator('.cc-orbit-ring-layer')).toBeVisible()

  // 같은 쌓임 맥락의 두 층이다 — 링이 더 위에 있어야 아랫변이 살아남는다
  const z = await panel.evaluate((el) => {
    const ring = el.querySelector('.cc-orbit-ring-layer')!
    const shell = el.querySelector('[data-testid="composer-shell"]')!
    return [getComputedStyle(ring).zIndex, getComputedStyle(shell).zIndex].map(Number)
  })
  expect(z[0]!).toBeGreaterThan(z[1]!)
})

/**
 * 접힌 입력창은 **칸을 밀어 올리지 않는다** (도그푸딩 2026-09-10: 머리글이 사라지고
 * 명령어 버튼이 첫 클릭을 먹었다).
 *
 * 접힌 입력칸은 칸 밖에 있고, 세션을 갓 만들면 거기에 포커스가 잡혀 있다. 칸이 스크롤
 * 컨테이너면 브라우저가 그 입력칸을 보여주려고 칸을 통째로 밀어 올린다 — 머리글이 위로
 * 사라지고, 그 사이에 눌린 버튼은 mousedown과 mouseup이 서로 다른 곳에서 나 클릭이
 * 통째로 없어진다. 스크롤 위치는 0이어야 한다.
 */
test('접힌 입력창은 칸을 스크롤로 밀어 올리지 않는다 — 머리글의 버튼이 한 번에 눌린다', async ({
  page,
}) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '하나')
  const b = await newSession(page, 'alpha', 'claude', '둘')
  await openGrid(page, [a, b])

  // 접혀 있는 칸(a): 밀어 올릴 자리 자체가 없어야 한다 — 밀어 보고 확인한다
  expect(
    await page.getByTestId(`grid-panel-${a}`).evaluate((el) => {
      el.scrollTop = 500
      return el.scrollTop
    }),
  ).toBe(0)

  // 그리고 방금 만들어 입력칸을 잡고 있는 칸(b)에서도 머리글 버튼이 **첫 클릭에** 열린다
  // (누르는 순간 손이 떠나 입력창이 내려가는데, 그때 칸이 밀리면 mouseup이 딴 데서 난다)
  const panel = page.getByTestId(`grid-panel-${b}`)
  await expect(panel.getByTestId('prompt-input')).toBeFocused()
  await panel.getByTestId('run-open').click()
  await expect(page.getByTestId('run-menu')).toBeVisible()
})

/**
 * 설정이 꺼져 있으면 예전 그대로 — 접기는 **선택**이다.
 * 그리고 접기는 그리드의 사정이라 포커스 뷰는 처음부터 이 문제가 없다.
 */
test('접기를 끄면 입력창이 늘 펼쳐져 있고, 포커스 뷰는 애초에 안 접힌다', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '하나')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const folded = (await panel.getByTestId('chat-stream').boundingBox())!.height

  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setFoldComposer(false))
  await expect(panel.getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')
  // 접기를 끄면 입력창이 자리를 도로 차지한다 — 그만큼 대화가 짧아진다
  const open = (await panel.getByTestId('chat-stream').boundingBox())!.height
  expect(open).toBeLessThan(folded)

  // 포커스 뷰: 설정과 무관하게 접히지 않는다
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setFoldComposer(true))
  await page.evaluate((id: string) => (window as never as { __store: any }).__store.getState().focusSession(id), a)
  await expect(page.getByTestId('session-view').getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

/*
 * ── 사용량 (#26 → 2026-09-09) ────────────────────────────────────────
 *
 * 사용량은 **계정** 단위인데 도구마다 다르다. 오래 그 답을 화면에서 추론했다(그리드에 뜬
 * 도구들). 이제 추론하지 않는다: **도구마다 도넛 하나**가 계기판에 상주하고, 어느 한도를
 * 볼지는 사람이 고른다. 그래서 여기서 볼 것은 "짐작이 맞나"가 아니라 "각 도넛이 자기
 * 도구를 말하나"다.
 */

test('사용량은 도구마다 도넛 하나 — 화면이 어느 도구인지 짐작하지 않는다', async ({ page }) => {
  await setup(page)
  await stubUsage(page)
  await newSession(page, 'alpha', 'claude', '클로드 작업')

  // 클로드 세션만 보고 있어도 코덱스 도넛은 자기 자리에 있다
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  await expect(page.getByTestId('usage-donut-codex')).toBeVisible()

  await page.getByTestId('usage-donut-codex').click()
  await expect(page.getByTestId('usage-drop')).toContainText('Codex')
  await expect(page.getByTestId('usage-drop')).not.toContainText('Claude Code')
  await expect(page.getByTestId('usage-panel')).toHaveCount(1)

  // 다른 도넛을 누르면 그 도구의 한도로 갈아탄다 (같은 자리, 다른 답)
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-drop')).toContainText('Claude Code')
})

/**
 * 연결된 에이전트만 도넛을 갖는다 (사용자 요청 2026-09-09).
 *
 * 안 쓰는 도구의 빈 고리는 아무것도 말하지 않으면서 계기판의 자리를 쓴다. 판정은
 * 설치+로그인 — 세션 만들기 창이 쓰는 것과 **같은 판정**이라, 화면 두 곳이 "이 도구를
 * 쓸 수 있나"에 다르게 답하지 않는다.
 */
test('로그인 안 된 도구는 도넛이 없다', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.detected = [
      { tool: 'claude', installed: true, loggedIn: true, detail: 'mock 2.1.0' },
      { tool: 'codex', installed: true, loggedIn: false, detail: 'not logged in' },
    ]
  })
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()

  // 상세를 여는 것이 곧 다시 묻는 것이다 (방금 로그아웃했을 수도 있으니 — 세션 창과 같은 규칙)
  await page.getByTestId('usage-donut-claude').click()

  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  await expect(page.getByTestId('usage-donut-codex')).toHaveCount(0)

  /*
   * 하나도 못 쓰면 빈 자리로 두지 않는다 — "볼 게 없다"가 아니라 **할 일이 있다**
   * (설치·로그인). 끊김을 적는 것과 같은 규칙이다.
   */
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.detected = [{ tool: 'claude', installed: true, loggedIn: false, detail: 'not logged in' }]
  })
  // 닫고(첫 클릭) 다시 열면(둘째) 그때 다시 묻는다 — 닫기는 아무것도 안 물어본다
  await page.getByTestId('usage-donut-claude').click()
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-no-agent')).toBeVisible()
})

/**
 * 모르는 것을 0%로 그리지 않는다.
 *
 * 꽉 찬 회색 고리는 "하나도 안 썼다"로 읽힌다 — 못 읽었다는 사실이 화면에서 사라지는
 * 실패다(#26이 'claude로 조용히 떨어지던' 것과 같은 종류). 모를 때는 점선이고, 이유는
 * 눌러서 여는 상세가 말한다.
 */
test('주간 한도를 모르면 도넛이 모른다고 말한다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  // 기본 목은 창이 없다 — 주간을 못 고른다
  const donut = page.getByTestId('usage-donut-claude')
  await expect(donut).toHaveAttribute('data-percent', '')

  await stubUsage(page, [{ id: 'weekly_all', label: 'Weekly', percent: 93, resetsAt: null, scope: null }])
  await donut.click()
  await expect(page.getByTestId('usage-drop')).toBeVisible()
  // 값이 오면 도넛이 그 숫자를 든다
  await expect.poll(async () => donut.getAttribute('data-percent')).toBe('93')
})


/*
 * ── 기록 탭 (#21) ────────────────────────────────────────────────────
 *
 * 깃 탭 안의 기록 띠는 커밋을 만드는 동안 곁눈질하는 맥락이라 일곱 줄에 갇혀 있다.
 * 기록을 **읽으러** 오는 것은 다른 용무라 세로 한 칸을 통째로 쓴다.
 */

/** `when`을 하루씩 뒤로 물려 커밋 목록을 만든다 (상대 날짜가 줄마다 달라지도록) */
async function seedCommits(
  page: Page,
  list: { sha: string; subject: string; author: string; daysAgo: number }[],
) {
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
    Array.from({ length: 12 }, (_, i) => ({
      sha: `c${String(i).padStart(6, '0')}`,
      subject: `커밋 ${i}`,
      author: '나',
      daysAgo: i,
    })),
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

/**
 * 줄 앞 글자는 **무슨 일이 있었나**를 말한다 (사용자 요청 2026-09-10).
 * git이 새 파일에 쓰는 `?`는 화면에서 "모른다"로 읽히지만, 실은 아는 사실이다 —
 * 새로 생긴 파일이니 A(added)다. D(삭제)·M(수정)은 git의 글자를 그대로 쓴다.
 */
test('새 파일은 A로, 지운 파일은 D로 선다', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/new.ts', staged: false, status: '?' },
      { path: 'src/gone.ts', staged: false, status: 'D' },
      { path: 'src/old.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'claude', '작업')

  const mark = async (path: string) =>
    page.getByTestId(`evidence-file-${path}`).locator('span').first().textContent()
  expect(await mark('src/new.ts')).toBe('A')
  expect(await mark('src/gone.ts')).toBe('D')
  expect(await mark('src/old.ts')).toBe('M')
})

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

  // 다음 파일도 사이드바에서 고른다 — 넓은 화면 안에 목록은 없다 (2026-09-07 좌측 열 제거)
  await page.getByTestId('evidence-file-src/b.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('둘째 파일의 줄')
  await page.getByTestId('evidence-stage-all').click()
  await expect(page.getByTestId('evidence-unstage-all')).toBeVisible()
  // 스테이징으로 목록이 갈려도 보던 diff가 처음 경로로 끌려가면 안 된다
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

  // 사이드바에서 브랜치 화면으로 갈아탄 뒤 (오버레이 안 탭은 없다 — 진입점은 사이드바뿐, 2026-09-07)
  await page.getByTestId('evidence-branch').click()
  await expect(page.getByTestId('git-branches')).toBeVisible()

  // 같은 파일을 다시 누른다 — 경로가 같다고 해서 "아무 일도 없었다"가 되면 안 된다
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('첫째 파일의 줄')
  await expect(page.getByTestId('git-branches')).toBeHidden()
})

/*
 * 커밋 diff는 여러 파일이 한 텍스트다 — 파일 경계마다 sticky 밴드가 선다
 * (사용자 선택 2026-09-07: 칩 나열은 파일이 많으면 UI가 무너진다). 표시만 밴드고
 * data-line은 그대로라 복사는 여전히 원문 `diff --git` 줄을 낸다 (#36).
 */
test('커밋 diff의 파일 경계마다 파일명 밴드가 선다', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [{ sha: 'aaa1111', subject: '두 파일 커밋', author: '나', daysAgo: 0 }])
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.diffs['aaa1111'] = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '+첫 파일 줄',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '+둘째 파일 줄',
    ].join('\n')
  })
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('diff-view')).toContainText('첫 파일 줄')

  const bands = page.getByTestId('diff-file-band')
  await expect(bands).toHaveCount(2)
  await expect(bands.nth(0)).toHaveText('src/a.ts')
  await expect(bands.nth(1)).toHaveText('src/b.ts')
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
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate(async () => {
    const store = (window as never as { __store: any }).__store
    const m = (window as never as { __mock: any }).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-nogit',
      path,
      name: 'nogit',
      defaultTool: 'claude',
      commands: [],
      git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
  await page.getByTestId('project-menu-nogit').click()
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
      key,
      running: r.running,
      history: r.history,
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

test('명령어가 도는 동안 여는 버튼이 흰색으로 선다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  const open = page.getByTestId('run-open')
  // `hover:text-chalk`가 늘 붙어 있으므로 경계를 물린다 — 느슨하면 항상 통과하는 검사가 된다
  const lit = /(^|\s)text-chalk(\s|$)/
  const dim = /(^|\s)text-slate(\s|$)/
  await expect(open).toHaveClass(dim)

  await open.click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()

  // 창을 닫아도 "돌고 있다"는 사실은 헤더에 남는다 — 문이 표시등을 겸한다
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()
  await expect(open).toHaveClass(lit)
  await expect(open).toHaveAttribute('aria-label', /running/)

  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm dev', 0)
  })
  // 끝나면 도로 회색 — 다 끝난 명령까지 켜 두면 표시등이 아니라 장식이 된다
  await expect(open).toHaveClass(dim)
  await expect(open).not.toHaveAttribute('aria-label', /running/)
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
  await page.evaluate(
    (id: string) => (window as never as { __store: any }).__store.getState().focusSession(id),
    alpha,
  )
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
    return (Object.values(s.projects) as { id: string; path: string }[]).find((p) => p.path === '/tmp/beta')!
      .id
  })
  expect(runs[0]!.key.startsWith(betaProjectId)).toBe(true)
})

test('명령어 창: 오케스트레이터에는 없다 — 프로젝트가 없으니 돌릴 디렉토리도 없다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')
  await expect(page.getByTestId('run-open')).toBeVisible()

  await page.evaluate(async () => {
    const st = (window as never as { __store: any }).__store.getState()
    await st.openOrchestrator() // 화면만 연다 — 세션은 만들지 않는다 (#63)
    await st.askOrchestrator('hello') // 첫 질문이 세션을 만든다
  })
  await expect(page.getByTestId('session-name')).toContainText('Orchestrator')
  // 열어도 아무것도 들어갈 수 없는 메뉴는 빈 메뉴보다 없는 편이 정직하다
  await expect(page.getByTestId('run-open')).toBeHidden()
})

test('명령 별칭: 이름이 앞서고 명령이 받친다 — 목록·실행 줄·터미널 패널 모두 (2026-09-06)', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add-name').fill('데브 서버')
  await page.getByTestId('run-add').click()
  // 이름을 보여주는 자리는 명령도 같이 보여준다 — 이름이 몰래 딴 명령을 뜻하게 되는 표류 방지
  await expect(page.getByTestId('run-command-0')).toContainText('데브 서버')
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm dev')

  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-selected')).toContainText('데브 서버 · pnpm dev')
  await page.keyboard.press('Escape')

  // 터미널 패널의 명령 터미널에도 둘 다
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('데브 서버')
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('pnpm dev')

  // 별칭 고치기 — hover에 나오는 버튼으로, Enter로 저장
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').hover()
  await page.getByTestId('run-rename-0').click()
  await page.getByTestId('run-rename-input-0').fill('로컬 서버')
  await page.getByTestId('run-rename-input-0').press('Enter')
  await expect(page.getByTestId('run-command-0')).toContainText('로컬 서버')
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm dev')
})

/*
 * ── 실행 중 명령의 터미널 패널 투영 (#60 최종 형태, 사용자 결정 2026-09-06) ──
 *
 * 창을 닫아도 — 그리드에서 칸을 내려도 — 돌고 있는 명령은 터미널 패널에 터미널
 * 하나로 서 있어야 한다. 그리고 어떤 이유로든 끝나면(정상·크래시·Stop) 그 터미널은
 * **내려간다**: 여기는 "지금 돌고 있는 것"의 자리고, 지난 로그의 정본은 실행 창이다.
 */

test('돌고 있는 명령은 터미널 패널에 터미널로 선다 — 끝나면 어떤 이유로든 내려간다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  // 실행 창에서 데브 서버를 켜고 창을 닫는다
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-running-0')).toBeVisible()
  await page.keyboard.press('Escape')

  // 터미널 탭: 셸 옆에 명령 터미널이 서 있고, 로그가 흐르고, 탭에 점이 남는다
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()
  await expect(page.getByTestId('terminal-tab-running')).toBeVisible()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm dev', '서버가 5173에서 듣는 중\r\n')
  })
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('5173')

  // 패널을 접어도 "돌고 있다"는 접히지 않는다 — 점을 누르면 다시 열린다
  await page.getByTestId('evidence-close').click()
  await expect(page.getByTestId('evidence-rail-running')).toBeVisible()
  await page.getByTestId('evidence-rail-running').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()

  // 크래시 — 터미널이 내려가고 뱃지도 꺼진다. 로그는 실행 창에 남는다
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm dev', 1)
  })
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeHidden()
  await expect(page.getByTestId('terminal-tab-running')).toBeHidden()

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await expect(page.getByTestId('run-exit-0')).toContainText('exit 1')
  await expect(page.getByTestId('run-log')).toContainText('5173')
})

test('명령 터미널의 ×는 정지다 — Stop의 결말(exit)로 터미널이 내려가고 셸은 산다', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await page.keyboard.press('Escape')

  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()
  await page.getByTestId('cmd-term-stop-pnpm dev').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeHidden()

  // 내려간 것은 명령 칸뿐이다 — 셸 터미널은 그대로 산다
  const shells = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-mock-term-"]')
  await expect(shells.first()).toBeVisible()
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
 * ── 고른 세션은 손을 따라간다 ──────────────────────────────────────
 *
 * 그리드 안에서는 아무도 focusedSessionId를 바꾸지 않았다 — 앱을 켤 때 복원된
 * 세션에 며칠이고 박제됐다 (도그푸딩). 다른 칸의 입력창에 손을 얹으면 고른 것도
 * 따라와야 한다: markRead와 "마지막 보던 세션"(다음 실행의 예열 대상)이 이 값에서
 * 나온다. 뷰는 그리드에 남아야 한다. (테두리로 그리지는 않는다 — 같은 도그푸딩에서
 * 표시 자체를 걷어냈다. 커서가 이미 말하는 것을 테두리가 반복할 이유가 없다.)
 */
test('그리드에서 다른 칸의 입력창을 누르면 고른 세션이 따라온다 — 뷰는 그리드 그대로', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '첫째')
  const b = await newSession(page, 'alpha', 'claude', '둘째')
  await openGrid(page, [a, b])

  // 마지막으로 고른 세션(b)에서 시작한다
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-focused', 'true')

  // 접힌 입력창은 아래쪽에 손이 와야 떠오른다 (사람이 하는 것과 같은 순서)
  const boxA = (await page.getByTestId(`grid-panel-${a}`).boundingBox())!
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height - 20)
  await page.getByTestId(`grid-panel-${a}`).getByTestId('prompt-input').click()

  await expect(page.getByTestId(`grid-panel-${a}`)).toHaveAttribute('data-focused', 'true')
  await expect(page.getByTestId(`grid-panel-${b}`)).not.toHaveAttribute('data-focused', 'true')
  // 고른 것이 바뀌었다고 포커스 뷰로 끌려가면 안 된다 (preferGrid)
  await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()
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
    [...document.querySelectorAll<HTMLElement>('[data-testid^="grid-panel-"]')].map((el) =>
      el.dataset.testid!.slice('grid-panel-'.length),
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
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: r.top + r.height / 2,
        }),
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
        new DragEvent('dragend', {
          dataTransfer: (window as never as { __dt?: DataTransfer }).__dt,
          bubbles: true,
        }),
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
    [...document.querySelectorAll<HTMLElement>('[data-testid^="evidence-tab-"]')].map((el) =>
      el.dataset.testid!.slice('evidence-tab-'.length),
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

/**
 * 탭 띠 한 줄이 두 가지를 진다 (사용자 요청 2026-09-07): 왼쪽은 어디로 갈지, 오른쪽은
 * **지금 탭의 제어 버튼**. 예전엔 탭마다 머리띠를 하나 더 그려서 띠가 두 줄이었다.
 */
test('the active tab\'s controls live in the tab strip, not in a second header', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')

  const actions = page.getByTestId('evidence-actions')
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(actions.getByTestId('terminal-add')).toBeVisible()

  // 탭을 바꾸면 버튼도 그 탭의 것으로 바뀐다 — 남의 버튼은 남지 않는다
  await page.getByTestId('evidence-tab-files').click()
  await expect(actions.getByTestId('toggle-ignored')).toBeVisible()
  await expect(actions.getByTestId('terminal-add')).toHaveCount(0)
})

/**
 * 좁아지면 양보하는 쪽은 탭이다 — 제어 버튼은 보고 있는 것에 대한 행동이라 안 접힌다.
 * 접힌 탭은 사라진 게 아니라 `…` 뒤에서 이름으로 고를 수 있다.
 */
test('when the strip runs out of room the extra tabs fold into a … menu', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('evidence-tab-terminal')).toBeVisible()

  // 'Show ignored'가 오른쪽을 차지하는 폭이면 마지막 탭이 밀려난다
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setPanelWidth(280))

  const more = page.getByTestId('evidence-tabs-more')
  await expect(more).toBeVisible()
  await expect(page.getByTestId('evidence-tab-terminal')).toHaveCount(0)
  // 고르고 있던 탭은 접히지 않는다 — 지금 어디에 있는지가 화면에서 사라지면 안 된다
  await expect(page.getByTestId('evidence-tab-files')).toBeVisible()

  await more.click()
  await page.getByTestId('evidence-overflow-tab-terminal').click()
  // 고른 탭은 자리를 얻는다 (자리를 내주는 건 그 대신 접히는 다른 탭이다)
  await expect(page.getByTestId('evidence-tab-terminal')).toBeVisible()
  await expect(page.getByTestId('evidence-actions').getByTestId('terminal-add')).toBeVisible()
})

test('tab order is dragged, and survives a relaunch — one arrangement for the whole app (#20)', async ({
  page,
}) => {
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
  // 소개 화면은 다시 나오지 않는다 — introSeen이 스냅샷(localStorage)에 남았다 (#63)
  await expect(page.getByTestId('add-project')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  await newSession(page, 'alpha', 'claude', '다시')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])
})

test('dragging a tab to the bottom half splits the panel — two tabs visible at once (#20)', async ({
  page,
}) => {
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
 * 나눈 비율 조절 (도그푸딩 요청). 반반 고정은 "터미널은 좁아도 되고 diff는 넓어야
 * 한다"를 못 담았다. 경계(아래 몸통의 윗변)를 끌면 몫이 바뀌고, 스냅샷에 실려
 * 재실행에도 남으며, 더블클릭이면 반반으로 돌아온다.
 */
test('나뉜 두 칸의 경계는 끌어서 옮긴다 — 재실행에도 남고, 더블클릭이면 반반', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', '작업')
  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  const topHeight = () =>
    page.getByTestId('evidence-body-0').evaluate((el) => el.getBoundingClientRect().height)
  const before = await topHeight()

  // 경계를 아래로 120px — 위 몸통이 커진다
  const handle = page.getByTestId('panel-split-handle')
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 120, { steps: 4 })
  await page.mouse.up()
  expect(await topHeight()).toBeGreaterThan(before + 80)
  const saved = await page.evaluate(() => (window as any).__store.getState().panelSplit)
  expect(saved).toBeGreaterThan(0.6)

  // 재실행 — 배치가 돌아오는 자리에서 비율도 같이 돌아온다
  await page.goto('/?mock=1')
  await expect(page.getByTestId('add-project')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__store.getState().panelSplit)).toBeCloseTo(saved, 5)

  // 되돌리기: 프로젝트를 다시 붙여 패널을 띄우고 더블클릭 — 반반
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()
  await newSession(page, 'alpha', 'claude', '다시')
  await page.getByTestId('panel-split-handle').dblclick()
  expect(await page.evaluate(() => (window as any).__store.getState().panelSplit)).toBe(0.5)
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
      path: `src/f${i}.ts`,
      staged: false,
      status: 'M',
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

test('dragging the bottom group‘s last tab back to the top strip closes the split (#20)', async ({
  page,
}) => {
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

test('⌘⇧1–4 keeps working after a reorder — the digit follows the tab, not the seat (#20)', async ({
  page,
}) => {
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
        [sid]: Array.from({ length: 80 }, (_, i) => ({
          kind: i % 2 ? 'assistant' : 'user',
          seq: 1000 + i,
          text: `지난 대화 ${i}`,
        })),
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
      (sid: string) =>
        document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"] [data-testid="chat-stream"]`)!
          .scrollTop,
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
        document.querySelector<HTMLElement>(
          `[data-testid="grid-panel-${sid}"] [data-testid="chat-stream"]`,
        )!.scrollTop = 40
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
    return {
      probe: panel.dataset.probe ?? null,
      scrollTop: panel.querySelector<HTMLElement>('[data-testid="chat-stream"]')!.scrollTop,
    }
  }, a)
  expect(after).toEqual({ probe: 'same-node', scrollTop: scrolled })

  await dropOnPanel(page, c, 'right', a)
  // The drop changed nothing visually — and now the store agrees with the screen
  await expect.poll(() => panelOrder(page)).toEqual([b, c, a])
  expect(await storedPanels(page)).toEqual([b, c, a])
})

/**
 * 알림에서 오는 길은 **그리드를 우선한다** (도그푸딩 요청).
 *
 * 칸에 올려 둔 것은 보려고 올린 것이다. 그 세션이 응답을 마쳤다고 해서 그리드를 걷고
 * 큰 화면 하나로 갈아치우면, 알림 하나가 나머지 칸을 전부 화면에서 치우는 셈이 된다.
 * 대신 그 칸이 밝아지고 그 칸의 입력창에 손이 얹힌다 — 온 이유가 답하러 온 것이라서다.
 */
test('알림에서 누른 세션이 그리드에 있으면 그리드의 그 칸으로 간다', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', '첫째')
  const b = await newSession(page, 'alpha', 'claude', '둘째')
  await openGrid(page, [a, b])
  await expect(page.getByTestId('grid')).toBeVisible()

  // 그리드를 보고 있는 중에 b가 응답을 마친다 — 보고 있지 않은 세션이라 카드가 뜬다
  await page.evaluate((id: string) => (window as any).__store.getState().focusSession(id), a)

  await page.evaluate((id: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'state_change', sessionId: id, state: 'working' })
    m.emit({ type: 'turn_complete', sessionId: id })
  }, b)

  await page.getByTestId('notice-open').click()

  // 그리드에 남아 있고, 온 이유인 칸이 밝다
  expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('grid')
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-focused', 'true')
  await expect(page.getByTestId(`grid-panel-${a}`)).not.toHaveAttribute('data-focused', 'true')
})

/** 그리드에 없는 세션이면 예전 그대로 — 큰 화면으로 간다 */
test('그리드에 없는 세션은 알림에서 눌러도 포커스 뷰로 간다', async ({ page }) => {
  await setup(page)
  const onGrid = await newSession(page, 'alpha', 'claude', '칸 안')
  const outside = await newSession(page, 'alpha', 'claude', '칸 밖의 세션')
  await openGrid(page, [onGrid])
  await expect(page.getByTestId('grid')).toBeVisible()

  await page.evaluate((id: string) => (window as any).__store.getState().focusSession(id), onGrid)

  await page.evaluate((id: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'state_change', sessionId: id, state: 'working' })
    m.emit({ type: 'turn_complete', sessionId: id })
  }, outside)

  await page.getByTestId('notice-open').click()
  expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('focus')
})
