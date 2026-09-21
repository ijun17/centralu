import { expect, test } from '@playwright/test'

/**
 * 상단 바 (도그푸딩 지적 2026-09-17).
 *
 * 왼쪽 여백은 창 버튼이 차지하는 만큼 비우는 값이라 플랫폼에 묻는다. 신호등이 없는 곳은
 * 0을 돌려주고, 그것은 맞는 답이다 — 비켜설 버튼이 없다. 그런데 그 값을 그대로 쓰면 이름이
 * 창 모서리에 달라붙어 바가 한쪽으로 기운 것처럼 보였다.
 *
 * 그래서 재는 것은 여백의 **크기**가 아니라 바닥이 있다는 사실 하나다. 86px 같은 숫자를
 * 박으면 신호등이 있는 곳에서는 맞고 없는 곳에서는 틀리며, 창 장식이 바뀌면 같이 썩는다.
 */
test('the title never sits closer to the edge than the right side does', async ({ page }) => {
  await page.goto('/?mock=1')
  const header = page.getByTestId('app-header')
  await expect(header).toBeVisible()

  const pad = await header.evaluate((el) => {
    const s = getComputedStyle(el)
    return { left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) }
  })

  expect(pad.right).toBeGreaterThan(0)
  expect(pad.left).toBeGreaterThanOrEqual(pad.right)
})
