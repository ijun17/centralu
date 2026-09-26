import { expect, test, type Page } from '@playwright/test'

/**
 * 키는 사람이 보고 있는 대상에만 간다 (#158, #181) — 목 플랫폼 위의 진짜 UI.
 *
 * 전역 키 처리(승인 카드의 y/n/a, 오버레이의 Esc)는 `window`에 달린다. 창이 지역 상태로 열리면 그 처리들은 창이 떠 있는
 * 줄을 모른다. 여기서는 창을 띄운 채 키를 보내 창 뒤의 대상이 움직이지 않는지 본다.
 */

const answers = (page: Page) => page.evaluate(() => (window as any).__mock.approvalAnswers as unknown[])

async function sessionWithApproval(page: Page): Promise<string> {
  await page.goto('/?mock=1')
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  const sessionId = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  await page.evaluate(
    (sid) => (window as any).__mock.requestApproval(sid, { kind: 'command', command: 'rm -rf build', cwd: '/tmp/alpha' }, 'r-hidden'),
    sessionId,
  )
  await expect(page.getByTestId('approval-card')).toBeVisible()
  return sessionId
}

test('삭제 확인 창이 떠 있으면 y/n/a가 창 뒤의 승인 카드에 닿지 않는다 (#158)', async ({ page }) => {
  const sessionId = await sessionWithApproval(page)

  await page.getByTestId(`session-menu-${sessionId}`).click()
  await page.getByTestId(`delete-session-${sessionId}`).click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  // 확인하려는 뜻으로 누른 y — 창 뒤의 명령을 허용하면 안 된다
  for (const k of ['y', 'n', 'a']) await page.keyboard.press(k)
  await page.waitForTimeout(200)
  expect(await answers(page)).toEqual([])

  // 창을 닫으면 카드는 그대로 남아 있고, 이제는 y가 통한다
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('confirm-delete')).toHaveCount(0)
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.keyboard.press('y')
  await expect.poll(() => answers(page)).toEqual([{ sessionId, requestId: 'r-hidden', decision: 'allow' }])
})
