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
