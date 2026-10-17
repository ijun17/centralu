import { test, expect } from '@playwright/test'
import { setup, newSession, emitEvent, QUESTIONS } from './fixtures/control.js'

/**
 * The control loop's scenarios on an agent's questions: single and multiple choice, Other, and text typed as an answer. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('Clicking the option of a single-choice question answers at once, with no Answer click (#543)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await expect(page.getByTestId('question-card')).toBeVisible()
  // The description is the basis for deciding — if it clips, this feature is dead (it actually
  // went unused for exactly that reason)
  await expect(page.getByTestId('question-card')).toContainText('Warm')

  await page.getByTestId('question-option').filter({ hasText: 'Ramen' }).click()

  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Ramen')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
})

test('Enter on a focused option of a single-choice question answers it (#543)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  /*
   * Visible first (#790). The conversation is hidden (visibility: hidden) for the few frames it takes to settle at the
   * bottom after its first message, and a hidden button cannot take focus: `focus()` then did nothing, and Enter went
   * to the page (2 of 20 WebKit runs). A person cannot focus what is not drawn either, so the test waits for what they
   * would see, and checks the option holds focus before pressing Enter.
   */
  const option = page.getByTestId('question-option').filter({ hasText: 'Kimbap' })
  await expect(option).toBeVisible()
  await option.focus()
  await expect(option).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Kimbap')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
})

test('Two clicks, or a click and Enter, on a single-choice option send one answer even on a slow host (#543)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  // A host that takes its time: the card stays up while the answer is on its way
  await page.evaluate(() => {
    const m = (window as any).__mock
    const calls: unknown[] = []
    ;(window as any).__answerCalls = calls
    const real = m.agents.answerQuestion.bind(m.agents)
    m.agents.answerQuestion = async (...args: unknown[]) => {
      calls.push(args)
      await new Promise((r) => setTimeout(r, 400))
      return real(...args)
    }
  })
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  // Both land before React has re-rendered, so state alone could not tell the second one apart
  await page.getByTestId('question-option').filter({ hasText: 'Kimbap' }).evaluate((el) => {
    ;(el as HTMLButtonElement).click()
    ;(el as HTMLButtonElement).click()
  })
  // A later click on the other option and Enter on the first one, still while it is sending
  await page.getByTestId('question-option').filter({ hasText: 'Ramen' }).click()
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Kimbap')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__answerCalls.length)).toBe(1)
  await expect(page.getByTestId('chat-stream')).not.toContainText('Answer received: Ramen')
})

test('A single-choice question still opens "Other" without sending, and Answer sends the typed text (#543)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await page.getByTestId('question-other').click()
  await expect(page.getByTestId('question-other-input')).toBeFocused()
  await expect(page.getByTestId('question-card')).toBeVisible()
  await expect(page.getByTestId('chat-stream')).not.toContainText('Answer received')

  await page.getByTestId('question-other-input').fill('Something else')
  await page.getByTestId('question-submit').click()
  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Something else')
})

test('A multiple-choice question keeps Answer: picking options sends nothing (#543)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, {
    type: 'question_request',
    requestId: 'q1',
    questions: [{ ...QUESTIONS[0], multiSelect: true }],
  })

  await page.getByTestId('question-option').filter({ hasText: 'Kimbap' }).click()
  await page.getByTestId('question-option').filter({ hasText: 'Ramen' }).click()
  await expect(page.getByTestId('question-card')).toBeVisible()
  await expect(page.getByTestId('chat-stream')).not.toContainText('Answer received')

  await page.getByTestId('question-submit').click()
  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Kimbap+Ramen')
})

test('Multiple questions split into tabs, and sending requires answering all of them', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: QUESTIONS })

  // Multiple questions use tabs, not stacking (#8) — the second question only becomes visible by
  // switching to its own tab
  await expect(page.getByTestId('question-tabs')).toBeVisible()
  await expect(page.getByTestId('question-card')).not.toContainText('What about something to drink?')

  // Sending half-answered lets the model invent the rest — so it stays locked until everything is
  // picked
  await page.getByTestId('question-option').filter({ hasText: 'Kimbap' }).click()
  await expect(page.getByTestId('question-submit')).toBeDisabled()
  // Which tab is still empty reads off the tab row — that is exactly why stacking was dropped
  await expect(page.getByTestId('question-tab-0')).toHaveAttribute('data-answered', 'true')
  await expect(page.getByTestId('question-tab-1')).not.toHaveAttribute('data-answered', 'true')

  await page.getByTestId('question-tab-1').click()
  await page.getByTestId('question-option').filter({ hasText: 'Coffee' }).click()
  await expect(page.getByTestId('question-submit')).toBeEnabled()
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Kimbap | Coffee')
})

/**
 * Switching tabs must be free. If hiding meant unmounting, a half-typed custom answer would
 * vanish after briefly glancing at another question — the one cost that switching from stacking
 * to tabs must never introduce.
 */
test('Switching tabs keeps what was picked and what was being typed', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: QUESTIONS })

  await page.getByTestId('question-other').click()
  await page.getByTestId('question-other-input').fill('a half-typed answer')
  await page.getByTestId('question-tab-1').click()
  await page.getByTestId('question-tab-0').click()
  await expect(page.getByTestId('question-other-input')).toHaveValue('a half-typed answer')
})

/*
 * What the tool schema pins down: "There should be no 'Other' option, that will be provided
 * automatically." That slot is the screen's own responsibility to create. Without it, the
 * person can only answer with one of the two offered choices, leaving nothing to say when a
 * third answer exists.
 */
test('Picking "Other" and typing a custom answer sends exactly that', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await page.getByTestId('question-other').click()
  await page.getByTestId('question-other-input').fill('Neither — noodles instead')
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Neither — noodles instead')
})

test('Picking "Other" and leaving it empty cannot be sent', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await page.getByTestId('question-other').click()
  await expect(page.getByTestId('question-submit')).toBeDisabled()
})

/**
 * While a question is open, whatever is typed into the composer becomes **the answer to that
 * question** (#125).
 *
 * A real incident, 2026-09-23: with the card still open, typing "can you ask that again?" made
 * the question disappear for no stated reason and broke the turn with error_during_execution. The
 * stored tool_result still held the exact phrase Claude Code emits when a tool use is refused.
 * Instead of blocking input, this accepts it as meaning the same thing as the card's own "Other —
 * write your own".
 */
test('While a question is open, text typed into the composer becomes its answer (#125)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })
  await expect(page.getByTestId('question-card')).toBeVisible()

  // States what will happen before it is submitted
  await expect(page.getByTestId('prompt-input')).toHaveAttribute('placeholder', /answer to the question/i)

  await page.getByTestId('prompt-input').fill('can you ask that again?')
  await page.getByTestId('prompt-input').press('Enter')

  // The mock echoes the received answer back exactly — if it were refused, this line would not exist
  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: can you ask that again?')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
})

test('With multiple questions, sent text becomes a new turn, and a line records what was dropped (#174)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q2', questions: QUESTIONS })
  await expect(page.getByTestId('prompt-input')).toHaveAttribute('placeholder', /drops the question card/i)

  await page.getByTestId('prompt-input').fill('just handle it')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('chat-stream')).toContainText('Questions dropped')
  await expect(page.getByTestId('chat-stream')).toContainText('"What should we have for lunch?", "What about something to drink?"')
})

test('A session with an open question cannot be asked for a handoff note, but record mode still works (#174)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q3', questions: [QUESTIONS[0]] })
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`handoff-session-${id}`).click()
  // The record is the default (#694), which asks nothing, so nothing blocks it
  await expect(page.getByTestId('handoff-mode-record')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-blocked')).toHaveCount(0)
  await page.getByTestId('handoff-mode-agent').click()
  await expect(page.getByTestId('handoff-blocked')).toContainText('waiting on a question')
  await expect(page.getByTestId('confirm-handoff-yes')).toBeDisabled()
  await page.getByTestId('handoff-mode-record').click()
  await expect(page.getByTestId('handoff-blocked')).toHaveCount(0)
  await expect(page.getByTestId('confirm-handoff-yes')).toBeEnabled()
})
