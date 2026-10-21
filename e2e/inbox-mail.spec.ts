import { test, expect, type Page } from '@playwright/test'
import { setup, newSession } from './fixtures/control.js'

/**
 * The mailbox in the inbox (#1347, docs/plans/mailbox.md §10.1): a question from a session lists under Mail and counts at the
 * top bar, opens as a thread, takes the person's answer, and the mail held for the person is freed from the list. The host is the mock
 * (`window.__mock.seedMail`); what the real host does with an answer is in agent-host's mail tests.
 */

const PARSER = { address: 'session:mock/s1', kind: 'session', sessionId: 's1', name: 'Parser', state: 'idle' }

const seed = (page: Page, spec: Record<string, unknown>) =>
  page.evaluate((s) => (window as unknown as { __mock: { seedMail(s: Record<string, unknown>): string } }).__mock.seedMail(s), spec)

test('Mail: a question counts, lists, opens, and takes the person’s answer as theirs', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Which branch?', from: PARSER, body: 'main or release?' })

  await expect(page.getByTestId('count-waiting')).toHaveText('1')
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox-mail')).toBeVisible()
  // Mail alone is no reason for the empty state
  await expect(page.getByTestId('inbox-empty')).toHaveCount(0)
  await expect(page.getByTestId(`mail-thread-${id}`)).toContainText('Which branch?')
  await expect(page.getByTestId(`mail-thread-${id}`)).toContainText('Parser')

  await page.getByTestId(`mail-thread-${id}`).click()
  await expect(page.getByTestId('mail-thread')).toBeVisible()
  await expect(page.getByTestId('mail-message-1')).toContainText('main or release?')
  // Read for the person: the count falls
  await expect(page.getByTestId('count-waiting')).toHaveText('0')

  await page.getByTestId('mail-reply').fill('the release branch')
  await page.getByTestId('mail-send').click()
  await expect(page.getByTestId('mail-message-2')).toContainText('the release branch')
  // The person's words are marked as theirs, and the box is empty again
  await expect(page.getByTestId('mail-message-2')).toContainText('You · answer')
  await expect(page.getByTestId('mail-reply')).toHaveValue('')

  // Esc goes back to the list, not out of the inbox
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('mail-thread')).toHaveCount(0)
  await expect(page.getByTestId('inbox')).toBeVisible()
})

test('Mail: closing a thread ends the reply box, and a thread left open is not there the next time', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Land #12', from: PARSER, body: 'ready for review', kind: 'report' })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()

  await page.getByTestId('mail-finish').click()
  await expect(page.getByTestId('mail-thread-state')).toHaveText('Done')
  await expect(page.getByTestId('mail-reply')).toHaveCount(0)
  await expect(page.getByTestId('mail-done-note')).toBeVisible()

  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inbox')).toHaveCount(0)
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('mail-thread')).toHaveCount(0)
})

test('Mail: Drop and Mark done ask first when the helper is working on the thread, and offer no way to close and leave it running (3.10)', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Write the files', from: { ...PARSER, address: 'session:mock/s0', sessionId: 's0', name: 'Boss' }, body: 'please', kind: 'assign', state: 'running', assignee: PARSER, working: true })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()

  await page.getByTestId('mail-drop').click()
  await expect(page.getByTestId('mail-stop-confirm')).toContainText('Parser is working on this. Stop its work and close the thread?')
  await expect(page.getByTestId('mail-thread-state')).not.toHaveText('Done')
  // Cancel leaves it as it was
  await page.getByTestId('mail-stop-cancel').click()
  await expect(page.getByTestId('mail-stop-confirm')).toHaveCount(0)
  await expect(page.getByTestId('mail-thread-state')).not.toHaveText('Done')

  // Mark done asks the same, and the one answer that closes it says it stops
  await page.getByTestId('mail-finish').click()
  await expect(page.getByTestId('mail-stop-confirm')).toBeVisible()
  await expect(page.getByTestId('mail-stop-close')).toHaveText('Stop and close')
  await page.getByTestId('mail-stop-close').click()
  await expect(page.getByTestId('mail-thread-state')).toHaveText('Done')
})

test('Mail: a thread whose helper is not working closes at once, without asking', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Land #12', from: PARSER, body: 'ready for review', kind: 'report' })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await page.getByTestId('mail-drop').click()
  await expect(page.getByTestId('mail-stop-confirm')).toHaveCount(0)
  await expect(page.getByTestId('mail-thread-state')).toHaveText('Done (dropped)')
})

test('Mail: held mail says why and is freed from the list; a crowd of sleeping sessions asks once', async ({ page }) => {
  await setup(page)
  const boss = { ...PARSER, address: 'session:mock/s0', sessionId: 's0', name: 'Boss' }
  await seed(page, { subject: 'Do the thing', from: boss, body: 'please', kind: 'assign', held: { reason: 'loop', recipient: PARSER } })
  await page.evaluate(() => {
    ;(window as unknown as { __mock: { mockMail: { waiting: number } } }).__mock.mockMail.waiting = 3
  })
  await seed(page, { subject: 'Another', from: boss, body: 'x' })

  await page.getByTestId('counter').click()
  await expect(page.getByTestId('mail-held')).toContainText('Paused: this thread started many turns without a word from you')
  await expect(page.getByTestId('mail-crowd')).toContainText('3 sessions have mail from while Centralu was off')

  await page.getByTestId('mail-crowd-leave').click()
  await expect(page.getByTestId('mail-crowd')).toHaveCount(0)
  await page.locator('[data-testid^="mail-release-"]').click()
  await expect(page.getByTestId('mail-held')).toHaveCount(0)
})

test('Mail: work is offered only to the sessions the host would accept it for', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Clean up')
  const id = await seed(page, { subject: 'Land #12', from: PARSER, body: 'ready for review', kind: 'report' })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await page.getByTestId('mail-give').click()
  const options = await page.getByTestId('mail-reassign-to').locator('option').allTextContents()
  // The ordinary session in a project is offered; the orchestrator is not
  expect(options.slice(1)).toHaveLength(1)
  expect(options.slice(1)[0]?.trim()).toBeTruthy()
})
