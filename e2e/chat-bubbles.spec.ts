import { expect, test } from '@playwright/test'
import { emitEvent, newSession, setup } from './fixtures/control.js'

/**
 * The conversation as a chat (owner, 2026-10-18): the agent's words stand in an answer bubble on the left, drawn in
 * pieces across the virtual list's rows; tool calls and reasoning stand outside it and split it; the time is written
 * under the person's bubble and under the answer's last bubble; a divider names the day; and the conversation's
 * scrollbar is drawn over its content, the native one taking no width. The rules behind the pieces are unit-tested in
 * answerBubble.test.ts; this is what the page draws from them.
 */

const bubbles = (page: import('@playwright/test').Page) =>
  page.locator('[data-bubble]').evaluateAll((els) => els.map((el) => el.getAttribute('data-bubble')))

test("the agent's words share a bubble that a tool call or reasoning splits, and its time goes under the last one", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'look into it')

  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'Reading the file first.' })
  // A turn that ends and goes on with no message between: two replies, two rows, one bubble (#77)
  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'Then the test.' })
  await emitEvent(page, 0, { type: 'tool_call', callId: 't1', summary: { tool: 'Read', title: 'Read: a.ts', paths: [] } })
  await emitEvent(page, 0, { type: 'tool_result', callId: 't1', ok: true, summary: 'ok' })
  await emitEvent(page, 0, { type: 'reasoning_delta', text: 'Checking the edge case' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'All good.' })

  // Two rows of words in one bubble, then the tool card and the reasoning outside it, then a bubble of its own
  await expect.poll(() => bubbles(page)).toEqual(['first', 'last', 'solo'])
  await expect(page.locator('[data-bubble]').getByTestId('tool-card')).toHaveCount(0)
  await expect(page.locator('[data-bubble]').getByTestId('msg-reasoning')).toHaveCount(0)

  // The time: under the person's message, and once under the answer — not under each of its bubbles
  const times = page.getByTestId('said-at')
  await expect(times).toHaveCount(2)
  await expect(page.getByTestId('msg-user').getByTestId('said-at')).toHaveText(/^\d{1,2}:\d{2}\s[AP]M$/)
  const lastBubble = page.locator('[data-bubble="solo"]')
  const underIt = (await lastBubble.boundingBox())!
  const time = (await times.last().boundingBox())!
  expect(time.y).toBeGreaterThanOrEqual(underIt.y + underIt.height - 1)

  // One day so far: one divider naming it, in English
  await expect(page.getByTestId('day-divider')).toHaveCount(1)
  await expect(page.getByTestId('day-divider')).toHaveText(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d{1,2}, \d{4}$/)
})

test('a conversation read back over two days is divided by day, each message with its time', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const day1 = new Date(2026, 9, 17, 9, 5).getTime()
  const day2 = new Date(2026, 9, 18, 15, 42).getTime()
  const id = await page.evaluate(
    async ({ d1, d2 }) => {
      const m = (window as any).__mock
      const project = Object.values((window as any).__store.getState().projects)[0] as { id: string; path: string }
      const info = await m.agents.createSession({ projectId: project.id, cwd: project.path, tool: 'claude' })
      m.emit({ type: 'session_created', sessionId: info.id, session: info })
      const row = (seq: number, role: string, text: string, ts: number) => ({ sessionId: info.id, seq, role, kind: 'text', payload: { text }, ts })
      m.messages.set(info.id, [
        row(1, 'user', "Yesterday's question", d1),
        row(2, 'assistant', "Yesterday's answer", d1 + 60_000),
        row(3, 'user', "Today's question", d2),
        row(4, 'assistant', "Today's answer", d2 + 60_000),
      ])
      return info.id as string
    },
    { d1: day1, d2: day2 },
  )
  await page.evaluate((sid) => (window as any).__store.getState().focusSession(sid), id)
  await expect(page.getByTestId('day-divider')).toHaveText(['Saturday, October 17, 2026', 'Sunday, October 18, 2026'])
  await expect(page.getByTestId('said-at')).toHaveText([/^9:05\sAM$/, /^9:06\sAM$/, /^3:42\sPM$/, /^3:43\sPM$/])
})

test("the conversation's scrollbar is drawn over its content, and the native one takes no width", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'a long one')
  for (let i = 0; i < 40; i++) {
    await emitEvent(page, 0, { type: 'tool_call', callId: `c${i}`, summary: { tool: 'Bash', title: `step ${i}`, paths: [] } })
  }
  const bar = page.getByTestId('chat-scrollbar')
  await expect(bar).toBeVisible()
  const scroller = page.getByTestId('chat-stream')
  const native = await scroller.evaluate((el) => (el as HTMLElement).offsetWidth - (el as HTMLElement).clientWidth)
  expect(native).toBe(0)
  // Over the content's right edge, inside the scroller's box
  const box = (await scroller.boundingBox())!
  const thumb = (await bar.boundingBox())!
  expect(thumb.x + thumb.width).toBeLessThanOrEqual(box.x + box.width + 1)
  expect(thumb.x).toBeGreaterThan(box.x + box.width - 20)
})
