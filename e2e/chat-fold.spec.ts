import { expect, test, type Locator, type Page } from '@playwright/test'
import { emitEvent, newSession, QUESTIONS, setup } from './fixtures/control.js'

/**
 * Thinking and tool calls between the agent's answer bubbles fold into one line a run (#2007, owner, 2026-11-06).
 * The rules behind the runs are unit-tested in foldRuns.test.ts; this is what the conversation draws from them.
 */

type Row = Record<string, unknown>
const user = (seq: number, text = 'question'): Row => ({ kind: 'user', seq, storedSeq: seq, text })
const said = (seq: number, text = 'An answer.'): Row => ({ kind: 'assistant', seq, storedSeq: seq, text })
const thought = (seq: number, text = 'Thinking it through'): Row => ({ kind: 'reasoning', seq, storedSeq: seq, text })
const tool = (seq: number, over: Row = {}): Row => ({ kind: 'tool', seq, storedSeq: seq, tool: 'Bash', title: `step ${seq}`, callId: `c${seq}`, result: 'ok', ok: true, ...over })

/**
 * Waits until the list has come to rest: its position, its height and the rows it has measured unchanged for ten frames
 * in a row. Counted in frames, since a list that is still measuring moves once per frame and a busy machine can let a
 * fixed wait pass without one. Rows are measured a frame after they mount, and the list holds the view still as they are,
 * so a position read before that is not the one the rows settle on.
 */
const rest = (stream: Locator) =>
  stream.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        const state = () => `${el.scrollTop}/${el.scrollHeight}/${el.querySelector('[data-sized-rows]')?.getAttribute('data-sized-rows')}`
        let last = state()
        let still = 0
        const frame = () => {
          const now = state()
          still = now === last ? still + 1 : 0
          last = now
          if (still >= 10) resolve()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }),
  )

async function seed(page: Page, sid: string, items: Row[]) {
  await page.evaluate(
    ({ s, rows }) => {
      const store = (window as any).__store
      store.setState({ chat: { ...store.getState().chat, [s]: rows } })
    },
    { s: sid, rows: items },
  )
}

test('a run between two bubbles is one line that opens in place and folds again', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await seed(page, sid, [user(1), said(2, 'Reading first.'), thought(3), tool(4), tool(5), said(6, 'Done.')])

  const line = page.getByTestId('fold-line')
  await expect(line).toHaveCount(1)
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('fold-summary')).toHaveText('1 thought · 2 tools')
  // The words stay; what the agent did is on the line, not on the page
  await expect(page.getByTestId('msg-assistant')).toHaveCount(2)
  await expect(page.getByTestId('tool-card')).toHaveCount(0)
  await expect(page.getByTestId('msg-reasoning')).toHaveCount(0)

  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('tool-card')).toHaveCount(2)
  await expect(page.getByTestId('msg-reasoning')).toContainText('Thinking it through')

  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('tool-card')).toHaveCount(0)
  await expect(page.getByTestId('msg-reasoning')).toHaveCount(0)
})

/**
 * The line of a run stands close to the bubbles around it (owner, 2026-11-07): about 8px of space between its words and
 * the bubble above, and the same below, half of the 16px it had. The line's press area stays as tall as before (its
 * words and 4px each side), and two bubbles with no line between keep the 12px they stand apart by.
 */
test('a run\'s line stands 8px from the bubbles around it, and its press area keeps its height', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await seed(page, sid, [user(1), said(2, 'Reading first.'), thought(3), tool(4), tool(5), said(6, 'Done.'), user(7, 'again'), said(8, 'Alone.')])
  await expect(page.getByTestId('fold-line')).toHaveCount(1)
  await rest(page.getByTestId('chat-stream'))

  const m = await page.evaluate(() => {
    const top = (e: Element) => e.getBoundingClientRect().top
    const bottom = (e: Element) => e.getBoundingClientRect().bottom
    const bubbles = [...document.querySelectorAll('[data-bubble]')]
    const words = document.querySelector('[data-testid="fold-summary"]')!
    const line = document.querySelector('[data-testid="fold-line"]')!
    const rowOf = (e: Element) => e.closest('[data-index]') as HTMLElement
    return {
      above: top(words) - bottom(bubbles[0]!),
      below: top(bubbles[1]!) - bottom(words),
      press: bottom(line) - top(line),
      words: bottom(words) - top(words),
      // The row of a bubble with no line beside it keeps the gap bubbles stand apart by
      plainPad: getComputedStyle(rowOf(bubbles[2]!)).paddingBottom,
    }
  })
  expect(m.above).toBeGreaterThan(7)
  expect(m.above).toBeLessThan(9)
  expect(m.below).toBeGreaterThan(7)
  expect(m.below).toBeLessThan(9)
  // Words and 4px each side: the line is at least as tall as it was
  expect(m.press).toBeGreaterThanOrEqual(m.words + 8 - 0.5)
  expect(m.plainPad).toBe('12px')
})

test('a decided approval, a marker, an image and an app view stay on the page and split the run', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await page.evaluate((s) => {
    const store = (window as any).__store
    // A view the host parked as a placeholder: the call that opened it is the app's, not a step
    store.setState({
      inlineViews: {
        ...store.getState().inlineViews,
        [s]: { c7: { callId: 'c7', appId: 'viewer', projectId: null, tool: 'viewer', state: 'parked', instanceId: null, kept: false, liveAt: 1 } },
      },
    })
  }, sid)
  await seed(page, sid, [
    user(1),
    tool(2),
    { kind: 'approval', seq: 3, storedSeq: 3, requestId: 'r1', summary: 'Bash: rm -rf build', decision: 'deny' },
    tool(4),
    { kind: 'mark', seq: 5, storedSeq: 5, text: 'The turn failed: usage limit' },
    thought(6),
    { kind: 'image', seq: 7, storedSeq: 7, mime: 'image/png', data: '', note: 'the file is gone' },
    tool(8, { callId: 'c7', title: 'viewer call' }),
    tool(9),
    said(10),
  ])

  // Four runs: the first tool, the one after the approval, the thought after the marker, the one after the view
  await expect(page.getByTestId('fold-line')).toHaveCount(4)
  await expect(page.getByTestId('msg-approval-log')).toBeVisible()
  await expect(page.getByTestId('msg-mark')).toContainText('usage limit')
  await expect(page.getByTestId('msg-image-missing')).toBeVisible()
  // The app's call is drawn as it was; the steps around it are folded
  await expect(page.getByTestId('tool-card')).toHaveCount(1)
  await expect(page.getByTestId('tool-card')).toContainText('viewer call')
  await expect(page.getByTestId('msg-reasoning')).toHaveCount(0)
})

test('a question waiting on the person is on the page, not in the run before it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await seed(page, sid, [user(1), tool(2), tool(3)])
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await expect(page.getByTestId('fold-line')).toHaveCount(1)
  await expect(page.getByTestId('tool-card')).toHaveCount(0)
  await expect(page.getByText('What should we have for lunch?')).toBeVisible()
})

test("a live run's line says the step it is on, and marks a failed call", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'run it')
  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await emitEvent(page, 0, { type: 'tool_call', callId: 'b1', summary: { tool: 'Bash', title: 'npm run build', paths: [] } })

  const line = page.getByTestId('fold-line')
  await expect(line).toHaveCount(1)
  await expect(page.getByTestId('fold-step')).toHaveText('Bash: npm run build')
  await expect(page.getByTestId('fold-failed')).toHaveCount(0)

  await emitEvent(page, 0, { type: 'tool_result', callId: 'b1', ok: false, summary: 'exit 1' })
  await emitEvent(page, 0, { type: 'tool_call', callId: 'b2', summary: { tool: 'Read', title: 'Read: a.ts', paths: [] } })
  // The step moves with the turn, and the failure stays on the line even though the card is folded
  await expect(page.getByTestId('fold-step')).toHaveText('Read: Read: a.ts')
  await expect(page.getByTestId('fold-failed')).toHaveText('1 failed')
  await expect(page.getByTestId('tool-card')).toHaveCount(0)

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('fold-step')).toHaveCount(0)
  await expect(page.getByTestId('fold-failed')).toHaveText('1 failed')
})

test('a search hit inside a folded run opens it, and closing it again is allowed', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await seed(page, sid, [user(1), said(2), tool(3), tool(4, { title: 'the needle' }), said(5)])
  await expect(page.getByTestId('tool-card')).toHaveCount(0)

  await page.evaluate((s) => (window as any).__store.getState().openSearchHit(s, 4), sid)
  await expect(page.getByTestId('tool-card')).toHaveCount(2)
  await expect(page.locator('[data-search-hit="true"]')).toContainText('the needle')

  // Pressing the line folds it for good: the hit does not hold it open
  await page.getByTestId('fold-line').click()
  await expect(page.getByTestId('tool-card')).toHaveCount(0)
})

test('an opened run stays open when the list detaches it on a scroll away and back, and when the session is left', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  const rows: Row[] = [user(1), said(2, 'Opening words.'), thought(3, 'Early thought'), tool(4, { title: 'early tool' })]
  for (let i = 0; i < 40; i++) rows.push(said(10 + i * 2, `line ${i} `.repeat(60)), tool(11 + i * 2))
  await seed(page, sid, rows)
  const stream = page.getByTestId('chat-stream')
  // The list lands at the end of the conversation first; a move to the top before that is undone by the landing
  await rest(stream)
  await stream.evaluate((el) => (el.scrollTop = 0))
  // The run's first row is the third of the conversation (the list's own index)
  const first = page.locator('[data-testid=fold-line][data-fold-at="2"]')
  await expect(first).toContainText('1 thought · 1 tool')
  await first.click()
  await expect(page.getByText('early tool')).toBeVisible()

  // Far enough away that the list drops the run's rows from the page
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(page.getByText('early tool')).toHaveCount(0)
  await stream.evaluate((el) => (el.scrollTop = 0))
  await expect(page.getByText('early tool')).toBeVisible()
  await expect(first).toHaveAttribute('aria-expanded', 'true')

  // Another session, and back: the mock keeps no transcript for the seeded rows, so they are laid down again as a re-read would
  await newSession(page, 'alpha', 'second')
  await page.evaluate((s) => (window as any).__store.getState().focusSession(s), sid)
  await seed(page, sid, rows)
  await stream.evaluate((el) => (el.scrollTop = 0))
  await expect(first).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('early tool')).toBeVisible()
})

test('opening a run keeps the line where it was under the pointer', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  const rows: Row[] = [user(1)]
  for (let i = 0; i < 12; i++) rows.push(said(10 + i * 4, `line ${i} `.repeat(30)), thought(11 + i * 4), tool(12 + i * 4), tool(13 + i * 4))
  await seed(page, sid, rows)
  const stream = page.getByTestId('chat-stream')
  await rest(stream)
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight / 2))
  await rest(stream)
  // A line the list has on the page near the middle; it is found again by its row, since the list moves its rows
  await expect(page.getByTestId('fold-line').first()).toBeVisible()
  const at = await page.getByTestId('fold-line').first().getAttribute('data-fold-at')
  const line = page.locator('[data-testid=fold-line][data-fold-at="' + at + '"]')
  // In the middle of the pane, clear of its edges: the first line on the page can stand under the pinned copy of the
  // question at the top, which takes the pointer, and Playwright then scrolls the line clear before it presses (the
  // log said "sticky-user intercepts pointer events"), so the place measured here would no longer be where it is pressed
  await line.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await rest(stream)
  const before = (await line.boundingBox())!.y
  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => Math.round((await line.boundingBox())!.y - before)).toBe(0)
})

test('opening the run at the end of a conversation does not pull the view down after it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  const rows: Row[] = [user(1)]
  for (let i = 0; i < 10; i++) rows.push(said(10 + i, `line ${i} `.repeat(30)))
  // The last run ends the conversation and the view stands at the end, where it follows what comes
  rows.push(thought(30), tool(31), tool(32), tool(33))
  await seed(page, sid, rows)
  const line = page.locator('[data-testid=fold-line][data-fold-at="11"]')
  await expect(line).toBeVisible()
  const before = (await line.boundingBox())!.y
  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('tool-card')).not.toHaveCount(0)
  // The line is where the person pressed it; the opened cards are below it
  await expect.poll(async () => Math.round((await line.boundingBox())!.y - before)).toBe(0)
})

test('an ask_project call stays on the page until it is answered, then folds with the run', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  const ask = { tool: 'mcp__centralu__ask_project', title: 'Ask the sprite project', callId: 'ask1', result: undefined, ok: undefined }
  await seed(page, sid, [user(1), said(2), tool(3), tool(4, ask), tool(5), said(6)])
  // Two runs, the call between them
  await expect(page.getByTestId('fold-line')).toHaveCount(2)
  await expect(page.getByTestId('ask-project-card')).toHaveCount(1)

  await seed(page, sid, [user(1), said(2), tool(3), tool(4, { ...ask, result: 'done', ok: true }), tool(5), said(6)])
  await expect(page.getByTestId('fold-line')).toHaveCount(1)
  await expect(page.getByTestId('ask-project-card')).toHaveCount(0)
})

test('a press while the rows still fade out opens the run again, it never waits', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await seed(page, sid, [user(1), said(2), thought(3), tool(4), said(5)])
  const line = page.getByTestId('fold-line')
  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  // Close and press again at once, inside the fade
  await line.click()
  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(400)
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('tool-card')).toHaveCount(1)
})
