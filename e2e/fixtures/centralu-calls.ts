import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * Centralu's own tool calls in a conversation (#730), driven through the mock platform with the events the host sends:
 * a start_agent call is drawn with the Centralu mark, what it did and its job, and opens the child it started; an
 * ordinary MCP call next to it stays an ordinary card.
 *
 * A function because it runs in Chromium and in WebKit (centralu-calls-webkit.spec.ts): the desktop app is WKWebView.
 */
async function emit(page: Page, sessionId: string, event: Record<string, unknown>) {
  await page.evaluate(([sid, e]) => (window as any).__mock.emit({ ...(e as object), sessionId: sid }), [sessionId, event] as const)
}

export function centraluCallTests(): void {
  test.describe("Centralu's own tool calls (#730)", () => {
    test('a start_agent call stands apart from an ordinary MCP call, and opens the child it started', async ({ page }) => {
      await setup(page, ['/tmp/consumer'])
      const child = await newSession(page, 'consumer')
      const parent = await newSession(page, 'consumer')
      await emit(page, parent, { type: 'state_change', state: 'working' })
      await emit(page, parent, {
        type: 'tool_call',
        callId: 'call-agent',
        summary: { tool: 'mcp__centralu__start_agent', title: 'write the parser (codex, heavy)', paths: [], centralu: { tool: 'start_agent', label: 'Started an agent' } },
      })
      await emit(page, parent, { type: 'tool_result', callId: 'call-agent', ok: true, summary: `the codex session "Parser" [${child}] answered, as JSON: "done"` })
      await emit(page, parent, {
        type: 'tool_call',
        callId: 'call-other',
        summary: { tool: 'mcp__browser__list_tabs', title: 'mcp__browser__list_tabs', paths: [] },
      })

      const cards = page.getByTestId('tool-card')
      await expect(cards).toHaveCount(2)
      const centralu = cards.nth(0)
      await expect(centralu).toHaveAttribute('data-centralu-call', 'centralu')
      await expect(centralu.getByTestId('centralu-call-mark')).toBeVisible()
      await expect(centralu.getByTestId('centralu-call-label')).toHaveText('Started an agent')
      await expect(centralu.getByTestId('tool-card-title')).toHaveText('write the parser (codex, heavy)')
      const ordinary = cards.nth(1)
      await expect(ordinary).not.toHaveAttribute('data-centralu-call', /.*/)
      await expect(ordinary.getByTestId('centralu-call-mark')).toHaveCount(0)
      await expect(ordinary).toContainText('mcp__browser__list_tabs')

      /*
       * A rounder card on its own tint with a stronger hairline (owner, 2026-10-18), not the signal's white (urgency is
       * told by brightness)
       */
      const look = (el: Element) => {
        const st = getComputedStyle(el)
        return { width: st.borderTopWidth, edge: st.borderTopColor, tint: st.backgroundColor }
      }
      const mine = await centralu.evaluate(look)
      const theirs = await ordinary.evaluate(look)
      expect(mine.width).toBe('1px')
      expect(mine.edge).not.toBe(theirs.edge)
      expect(mine.tint).not.toBe(theirs.tint)
      expect(mine.edge).not.toBe('rgb(255, 255, 255)')

      await centralu.getByTestId('centralu-call-open').click()
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(child)
    })
  })
}
