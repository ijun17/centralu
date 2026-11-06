import { expect, test, type Page } from '@playwright/test'
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
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight / 2))
  // A line the list has on the page near the middle; it is found again by its row, since the list moves its rows
  await expect(page.getByTestId('fold-line').first()).toBeVisible()
  const at = await page.getByTestId('fold-line').first().getAttribute('data-fold-at')
  const line = page.locator('[data-testid=fold-line][data-fold-at="' + at + '"]')
  await line.scrollIntoViewIfNeeded()
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
