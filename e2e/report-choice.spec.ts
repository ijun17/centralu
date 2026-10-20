import { expect, test, type Page } from '@playwright/test'
import { startSession } from './fixtures/new-session.js'

/**
 * A session that owes a delegation report asks what the person's message means (#1377): "Working for <caller>" with
 * Just asking (the default), Add to the task and Take it over. The host keeps the rule (agent-host paused-reports tests);
 * this is what the composer shows and sends.
 */

const sent = (page: Page) => page.evaluate(() => (window as any).__mock.sentIntents as { sessionId: string; text: string; intent?: string }[])

async function typing(page: Page): Promise<string> {
  await page.goto('/?mock=1')
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await startSession(page, 'alpha')
  await expect(page.getByTestId('prompt-input')).toBeFocused()
  return page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
}

test('a session that owes nothing shows no choice, and sends no intent', async ({ page }) => {
  await typing(page)
  await page.keyboard.type('hello')
  await expect(page.getByTestId('report-choice')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sent(page)).map((m) => m.intent ?? null)).toEqual([null])
})

test('a session that owes a report shows who waits, defaults to Just asking, and sends the choice once', async ({ page }) => {
  const sid = await typing(page)
  await page.evaluate((id) => (window as any).__mock.reportsOwed.set(id, { callerId: 'o1', callerName: 'Orchestrator' }), sid)
  // Nothing is shown until the person types
  await expect(page.getByTestId('report-choice')).toHaveCount(0)
  await page.keyboard.type('quick question')
  await expect(page.getByTestId('report-choice-for')).toContainText('Working for Orchestrator')
  await expect(page.getByTestId('report-choice-ask')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sent(page)).map((m) => m.intent)).toEqual(['ask'])

  // The next message starts at Just asking again, whatever was chosen before
  await page.keyboard.type('also add a changelog line')
  await page.getByTestId('report-choice-task').click()
  await expect(page.getByTestId('report-choice-task')).toHaveAttribute('aria-pressed', 'true')
  // The click kept the keyboard in the message: Enter sends it
  await expect(page.getByTestId('prompt-input')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sent(page)).map((m) => m.intent)).toEqual(['ask', 'task'])

  await page.keyboard.type('I will take it from here')
  await expect(page.getByTestId('report-choice-ask')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('report-choice-takeover').click()
  // The click kept the keyboard in the message: Enter sends it
  await expect(page.getByTestId('prompt-input')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sent(page)).map((m) => m.intent)).toEqual(['ask', 'task', 'takeover'])
})

test('taking it over closes the choice at once: the next message asks nothing', async ({ page }) => {
  const sid = await typing(page)
  await page.evaluate((id) => (window as any).__mock.reportsOwed.set(id, { callerId: 'o1', callerName: 'Orchestrator' }), sid)
  await page.keyboard.type('mine now')
  await page.getByTestId('report-choice-takeover').click()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sent(page)).map((m) => m.intent)).toEqual(['takeover'])
  await expect(page.getByTestId('report-choice')).toHaveCount(0)
  await page.keyboard.type('and now?')
  await expect(page.getByTestId('report-choice')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sent(page)).map((m) => m.intent ?? null)).toEqual(['takeover', null])
})
