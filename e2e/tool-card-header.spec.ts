import { expect, test } from '@playwright/test'
import { emitEvent, newSession, setup } from './fixtures/control.js'

/**
 * A tool card's header is one line however long its words are (owner, 2026-11-06): the chevron stays at the right end
 * and the long part (the title, the session's name, the tool's own name) is cut with an ellipsis, its whole text in the
 * tooltip. A Centralu call's header used to wrap, so the chevron dropped to a second line under a long session name.
 */
const LONG_NAME = '무한모드 정산 잔여 E2E 검증과 릴리스 전 마지막 점검 항목 모두 정리하기'
const LONG_PATH = `Read: /tmp/alpha/${'very-long-directory-name/'.repeat(8)}file.ts`

for (const width of [1280, 900, 480, 360]) {
  test(`a long target or title keeps the chevron on the card's first line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await setup(page, { projects: ['/tmp/alpha'] })
    await newSession(page, 'alpha')
    await newSession(page, 'alpha')
    const child = await page.evaluate(() => [...(window as any).__mock.sessions.values()][0].id as string)
    await emitEvent(page, 0, { type: 'session_title', title: LONG_NAME, auto: false })
    await emitEvent(page, 1, { type: 'state_change', state: 'working' })
    await emitEvent(page, 1, {
      type: 'tool_call',
      callId: 'a1',
      summary: { tool: 'mcp__centralu__agent_session', title: 'Read the session', paths: [], centralu: { tool: 'agent_session', label: 'Read a session', sessionId: child } },
    })
    await emitEvent(page, 1, { type: 'tool_result', callId: 'a1', ok: true, summary: 'ok' })
    await emitEvent(page, 1, { type: 'tool_call', callId: 'a2', summary: { tool: 'mcp__a_server_with_a_very_long_name__and_a_long_tool_name', title: LONG_PATH, paths: [] } })
    await emitEvent(page, 1, { type: 'tool_result', callId: 'a2', ok: false, summary: 'exit 1' })
    await emitEvent(page, 1, { type: 'tool_call', callId: 'a3', summary: { tool: 'Read', title: LONG_PATH, paths: ['/tmp/alpha/x'] } })

    const cards = page.getByTestId('tool-card')
    await expect(cards).toHaveCount(3)
    for (let i = 0; i < 3; i++) {
      const card = cards.nth(i)
      const box = (await card.boundingBox())!
      // The chevron is the card's last control, drawn inside the card's right edge
      const chevron = card.locator('svg').last()
      const c = (await chevron.boundingBox())!
      expect(c.x + c.width, `card ${i} chevron inside the card`).toBeLessThanOrEqual(box.x + box.width + 0.5)
      // It stands level with the middle of the header, as one row of controls does: a wrapped header leaves it on a line under the words
      expect(Math.abs(c.y + c.height / 2 - (box.y + box.height / 2)), `card ${i} chevron level with the header`).toBeLessThanOrEqual(3)
      // And the card is as tall as its words (a Centralu call has two lines of its own): nothing wrapped under them
      expect(box.height, `card ${i} is one row`).toBeLessThanOrEqual(i === 0 ? 62 : 42)
    }
    // The long words are still all there for a hover
    await expect(cards.nth(0).getByTestId('centralu-call-open')).toHaveAttribute('title', `Open ${LONG_NAME}`)
  })
}
