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
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha', 'write the files')
  const name = await page.evaluate((s: string) => (window as any).__store.getState().sessions[s].name as string, sid)
  await page.evaluate((s: string) => (window as any).__mock.emit({ type: 'state_change', sessionId: s, state: 'working' }), sid)
  const helper = { ...PARSER, address: `session:mock/${sid}`, sessionId: sid, name }
  const id = await seed(page, { subject: 'Write the files', from: { ...PARSER, address: 'session:mock/s0', sessionId: 's0', name: 'Boss' }, body: 'please', kind: 'assign', state: 'running', assignee: helper, working: true })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await expect(page.getByTestId('mail-thread-state')).toHaveText('Running')

  await page.getByTestId('mail-drop').click()
  await expect(page.getByTestId('mail-stop-confirm')).toContainText(`${name} is working on this. Stop its work and close the thread?`)
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
  // The session's turn on it was stopped, and Centralu told it so in its conversation
  expect(await page.evaluate(() => (window as any).__mock.mockMail.calls as string[])).toEqual([`stop:${sid}`])
  await expect.poll(() => page.evaluate((s: string) => (window as any).__store.getState().sessions[s].state as string, sid)).not.toBe('working')
  await page.getByTestId(`mail-open-${sid}`).click()
  await expect(page.getByText('✉ Centralu told it a thread of its was closed')).toBeVisible()
})

test('Mail: the state pill says Running while the work goes and In review once it is reported', async ({ page }) => {
  await setup(page)
  const running = await seed(page, { subject: 'Running work', from: PARSER, body: 'on it', kind: 'assign', state: 'running', assignee: PARSER })
  const review = await seed(page, { subject: 'Reported work', from: PARSER, body: 'done, have a look', kind: 'report', state: 'review', assignee: PARSER })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${running}`).click()
  await expect(page.getByTestId('mail-thread-state')).toHaveText('Running')
  await page.getByTestId('mail-back').click()
  await page.getByTestId(`mail-thread-${review}`).click()
  await expect(page.getByTestId('mail-thread-state')).toHaveText('In review')
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

test('Mail: an open thread offers no way to give its work to another session and no Unblock (both went with threads)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Clean up')
  const id = await seed(page, { subject: 'Land #12', from: PARSER, body: 'ready for review', kind: 'report' })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await expect(page.getByTestId('mail-finish')).toBeVisible()
  await expect(page.getByTestId('mail-give')).toHaveCount(0)
  await expect(page.getByTestId('mail-reassign')).toHaveCount(0)
  await expect(page.getByTestId('mail-blockers')).toHaveCount(0)
  await expect(page.getByText('Give to another session')).toHaveCount(0)
  await expect(page.getByText('Unblock')).toHaveCount(0)
})

// #1772: however much mail there is, the panel stays inside the window and the mail scrolls inside it
test('Mail: a pile of threads and held mail scrolls inside the panel, and nothing else on screen moves', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 1100, height: 560 })
  for (let i = 0; i < 24; i++) await seed(page, { subject: `Question ${i}`, from: PARSER, body: 'x' })
  for (let i = 0; i < 8; i++) {
    await seed(page, { subject: `Held ${i}`, from: { ...PARSER, address: 'session:mock/s0', sessionId: 's0', name: 'Boss' }, body: 'y', kind: 'assign', held: { reason: 'loop', recipient: PARSER } })
  }
  const frame = () =>
    page.evaluate(() => {
      const box = (id: string) => {
        const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
      }
      const doc = document.scrollingElement!
      return { counter: box('counter'), doc: { top: doc.scrollTop, height: doc.scrollHeight, view: window.innerHeight }, inbox: box('inbox') }
    })
  const before = await frame()
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox-mail')).toBeVisible()

  const after = await frame()
  // The panel ends inside the window, the page itself does not scroll, and the top bar stays where it was
  expect(after.inbox!.y + after.inbox!.h).toBeLessThanOrEqual(after.doc.view)
  expect(after.doc.height).toBeLessThanOrEqual(after.doc.view)
  expect(after.doc.top).toBe(0)
  expect(after.counter).toEqual(before.counter)
  // The mail is what scrolls: the thread list holds more than it shows
  const list = page.getByTestId('inbox-mail').locator('ul').last().locator('..')
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
})
