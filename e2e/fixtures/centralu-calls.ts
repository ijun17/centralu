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

    test('a failed agent step says why, and its mark never overlaps the session pill (#1544)', async ({ page }) => {
      await setup(page, ['/tmp/consumer'])
      const child = await newSession(page, 'consumer')
      const parent = await newSession(page, 'consumer')
      await emit(page, child, { type: 'session_title', title: 'Release without bump PR (design review of the long name)', auto: false })
      await emit(page, parent, { type: 'state_change', state: 'working' })
      await emit(page, parent, {
        type: 'tool_call',
        callId: 'call-send',
        summary: {
          tool: 'mcp__centralu__agent_session',
          title: 'Good. Merge the release PR now and tell me when it is done',
          paths: [],
          centralu: { tool: 'agent_session', label: 'Sent more to an agent', sessionId: child },
        },
      })
      await emit(page, parent, {
        type: 'tool_result',
        callId: 'call-send',
        ok: false,
        summary: 'The session "Release" is busy with a turn that is not yours (working). Nothing was sent.',
      })
      const card = page.getByTestId('tool-card').first()
      for (const width of [1280, 900, 480]) {
        await page.setViewportSize({ width, height: 800 })
        const mark = card.getByTestId('centralu-call-failed')
        const pill = card.getByTestId('centralu-call-open')
        await expect(mark).toBeVisible()
        await expect(pill).toBeVisible()
        const [a, b] = await Promise.all([mark.boundingBox(), pill.boundingBox()])
        const apart = a!.x + a!.width <= b!.x + 0.5 || b!.x + b!.width <= a!.x + 0.5 || a!.y + a!.height <= b!.y + 0.5 || b!.y + b!.height <= a!.y + 0.5
        expect(apart, `at ${width}px the failed mark ${JSON.stringify(a)} overlaps the pill ${JSON.stringify(b)}`).toBe(true)
        // A zero-width box overlaps nothing: what the person reads must keep a usable width. The card itself keeps its room
        // at the widths the app really has (the project panel is open here), so narrowing it is caught too
        const cardBox = await card.boundingBox()
        const room = ({ 1280: 600, 900: 250 } as Record<number, number>)[width]
        if (room !== undefined) expect(cardBox!.width, `at ${width}px the card is ${cardBox!.width}px wide`).toBeGreaterThanOrEqual(room)
        for (const [id, least] of [['centralu-call-label', 80], ['tool-card-title', 80], ['centralu-call-reason', 100]] as const) {
          const box = await card.getByTestId(id).boundingBox()
          await expect(card.getByTestId(id)).toBeVisible()
          expect(box!.width, `at ${width}px (card ${cardBox!.width}px) ${id} is ${box!.width}px wide`).toBeGreaterThan(0)
          // Below 200px the pane has no room (the whole session pane is 0px at 480 on main too): only the words must still be there
          if (cardBox!.width >= 200) expect(box!.width, `at ${width}px (card ${cardBox!.width}px) ${id} is ${box!.width}px wide`).toBeGreaterThanOrEqual(least)
        }
      }
      await expect(card.getByTestId('centralu-call-reason')).toContainText('busy with a turn')
    })
  })
}
