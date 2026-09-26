import { expect, test, type Page } from '@playwright/test'

/**
 * 읽음은 사람이 본 것만 (#161) — 목 플랫폼 위의 진짜 UI.
 *
 * 포커스된 세션의 읽음 타이머는 3초 뒤 읽음으로 처리한다. 앱이 다른 창 뒤에 있으면 사람은 결과를 보지 않았으므로
 * 읽음이 되면 안 되고, 앱으로 돌아온 순간부터 3초를 다시 센다.
 */

const read = (page: Page, id: string) =>
  page.evaluate((sid) => {
    const s = (window as any).__store.getState().sessions[sid]
    return { lastSeq: s.lastSeq as number, lastReadSeq: s.lastReadSeq as number }
  }, id)

test('앱이 다른 창 뒤에 있는 동안 끝난 답은 읽음이 되지 않고, 돌아온 뒤 3초가 지나야 읽음이 된다', async ({ page }) => {
  test.setTimeout(30000)
  await page.goto('/?mock=1')
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)

  // 다른 창으로 옮겼다 — 그 사이 에이전트의 답이 도착한다
  await page.evaluate(() => (window as any).__store.getState().setAppFocused(false))
  await page.evaluate(
    (sid) => (window as any).__mock.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: 'finished while you were away' }),
    id,
  )
  await expect(page.getByTestId('session-view')).toContainText('finished while you were away')
  const before = await read(page, id)
  expect(before.lastSeq).toBeGreaterThan(before.lastReadSeq)
  await page.waitForTimeout(3600)
  expect(await read(page, id)).toEqual(before)

  // 돌아왔다 — 이제 보고 있으므로 3초 뒤 읽음이 된다
  await page.evaluate(() => (window as any).__store.getState().setAppFocused(true))
  await expect.poll(() => read(page, id), { timeout: 6000 }).toEqual({ lastSeq: before.lastSeq, lastReadSeq: before.lastSeq })
})
