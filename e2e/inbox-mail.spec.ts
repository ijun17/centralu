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

test('Mail: a question with choices lists them, a press answers once with its words, however often it is pressed, and locks the list (#1630)', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Settings file format', from: PARSER, body: 'How should I handle that?', choices: ['Keep the old format', 'Switch now', 'Ask me again'] })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()

  const choices = page.getByTestId('mail-choices-1')
  await expect(choices).toContainText('Choose one')
  await expect(page.getByTestId('mail-choices-1-2')).toContainText('2.Switch now')
  await expect(page.getByTestId('mail-reply')).toBeVisible()

  // The host answers slowly: what the window does with a second press, and with the reply box, while the first is on its way
  await page.evaluate(() => {
    const w = window as unknown as { __held: (() => void)[]; __calls: number; __store: { getState(): { platform: { mail: { reply: (...a: unknown[]) => Promise<unknown> } } } } }
    const mail = w.__store.getState().platform.mail
    const real = mail.reply.bind(mail)
    w.__held = []
    w.__calls = 0
    mail.reply = (...a) => {
      w.__calls++
      return new Promise((resolve) => w.__held.push(() => resolve(real(...a))))
    }
  })
  await page.getByTestId('mail-choices-1-2').click()
  await expect(page.getByTestId('mail-choices-1-1')).toBeDisabled()
  await page.getByTestId('mail-choices-1-1').click({ force: true })
  await page.getByTestId('mail-reply').fill('words of my own')
  await expect(page.getByTestId('mail-send')).toBeDisabled()
  await page.getByTestId('mail-reply').press('Enter')
  expect(await page.evaluate(() => (window as unknown as { __calls: number }).__calls)).toBe(1)
  await page.evaluate(() => (window as unknown as { __held: (() => void)[] }).__held.forEach((release) => release()))
  await expect(page.getByTestId('mail-message-2')).toContainText('Switch now')
  await expect(page.getByTestId('mail-message-2')).toContainText('You · answer')
  await expect(page.getByTestId('mail-message-3')).toHaveCount(0)
  // Said what was chosen; no row takes another press, and the picked one stays lit
  await expect(page.getByTestId('mail-choices-1-label')).toHaveText('You chose')
  for (const n of [1, 2, 3]) await expect(page.getByTestId(`mail-choices-1-${n}`)).toBeDisabled()
  await expect(page.getByTestId('mail-choices-1-2')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('mail-choices-1-1')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('mail-choices-1-1').click({ force: true })
  await expect(page.getByTestId('mail-message-3')).toHaveCount(0)
})

test('Mail: an answer in the reply box answers a question with choices too, and the list says it was answered', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Settings file format', from: PARSER, body: 'How should I handle that?', choices: ['Keep the old format', 'Switch now'] })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await page.getByTestId('mail-reply').fill('Neither: ask the owner')
  await page.getByTestId('mail-send').click()
  await expect(page.getByTestId('mail-message-2')).toContainText('Neither: ask the owner')
  await expect(page.getByTestId('mail-choices-1-label')).toHaveText('Answered')
  await expect(page.getByTestId('mail-choices-1-1')).toBeDisabled()
  await expect(page.getByTestId('mail-choices-1-1')).toHaveAttribute('aria-pressed', 'false')
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

test('Mail: Drop and Mark done close at once while the helper is working, tell it, and leave its turn running (C12)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha', 'write the files')
  const name = await page.evaluate((s: string) => (window as any).__store.getState().sessions[s].name as string, sid)
  await page.evaluate((s: string) => (window as any).__mock.emit({ type: 'state_change', sessionId: s, state: 'working' }), sid)
  const helper = { ...PARSER, address: `session:mock/${sid}`, sessionId: sid, name }
  const id = await seed(page, { subject: 'Write the files', from: { ...PARSER, address: 'session:mock/s0', sessionId: 's0', name: 'Boss' }, body: 'please', kind: 'assign', state: 'running', assignee: helper, working: true })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await expect(page.getByTestId('mail-thread-state')).toHaveText('Running')

  // No question first and no Stop beside it: one press closes it
  await page.getByTestId('mail-drop').click()
  await expect(page.getByTestId('mail-thread-state')).toHaveText('Done (dropped)')
  await expect(page.getByText('Stop and close')).toHaveCount(0)
  await expect(page.getByTestId('mail-done-note')).toBeVisible()
  await expect(page.getByTestId('mail-reply')).toHaveCount(0)
  // Its turn was not stopped, and Centralu told it in its conversation
  expect(await page.evaluate(() => (window as any).__mock.mockMail.calls as string[])).toEqual([])
  expect(await page.evaluate((s: string) => (window as any).__store.getState().sessions[s].state as string, sid)).toBe('working')
  await page.getByTestId(`mail-open-${sid}`).click()
  await expect(page.getByText('✉ Centralu told it the person closed its work')).toBeVisible()
})

test('Mail: a chain of mail between sessions that is only held for the person has no reply box, and keeps Mark done and Drop', async ({ page }) => {
  await setup(page)
  const boss = { ...PARSER, address: 'session:mock/s0', sessionId: 's0', name: 'Boss' }
  const id = await seed(page, { subject: 'Look at the branch', from: boss, body: 'please', kind: 'assign', onlyHeld: true, held: { reason: 'budget', recipient: PARSER } })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await expect(page.getByTestId('mail-thread')).toBeVisible()
  await expect(page.getByTestId('mail-reply')).toHaveCount(0)
  await expect(page.getByTestId('mail-finish')).toBeVisible()
})

test('Mail: the reply box says Reply', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Which branch?', from: PARSER, body: 'main or release?' })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await expect(page.getByTestId('mail-reply')).toHaveAttribute('placeholder', 'Reply')
  await expect(page.getByTestId('mail-reply')).toHaveAttribute('aria-label', 'Your reply')
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

test('Mail: a conversation whose helper is not working closes at once too', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Land #12', from: PARSER, body: 'ready for review', kind: 'report' })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await page.getByTestId('mail-drop').click()
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
  await expect(page.getByTestId('mail-held')).toContainText('Paused: these messages started many turns without a word from you')
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
