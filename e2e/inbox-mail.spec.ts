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
  await expect(page.getByTestId('inbox-list')).toBeVisible()
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

test('Mail: with picks on two questions of one thread in flight, the reply box waits for both (#1630)', async ({ page }) => {
  await setup(page)
  const other = { ...PARSER, address: 'session:mock/s2', sessionId: 's2', name: 'Builder' }
  const id = await seed(page, { subject: 'Two questions', from: PARSER, body: 'First?', choices: ['a1', 'a2'] })
  await page.evaluate(([thread, from]) => (window as any).__mock.seedMailMessage(thread, { from, body: 'Second?', choices: ['b1', 'b2'] }), [id, other] as const)
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await expect(page.getByTestId('mail-choices-2')).toBeVisible()

  await page.evaluate(() => {
    const w = window as any
    const mail = w.__store.getState().platform.mail
    const real = mail.reply.bind(mail)
    w.__held = []
    mail.reply = (...a: unknown[]) => new Promise((resolve) => w.__held.push(() => resolve(real(...a))))
  })
  await page.getByTestId('mail-choices-1-1').click()
  await page.getByTestId('mail-choices-2-1').click()
  await page.getByTestId('mail-reply').fill('words of my own')
  await expect(page.getByTestId('mail-send')).toBeDisabled()
  // The first comes back: the second is still on its way, so the box still waits
  await page.evaluate(() => (window as any).__held[0]())
  await expect(page.getByTestId('mail-message-3')).toContainText('a1')
  await expect(page.getByTestId('mail-send')).toBeDisabled()
  await page.evaluate(() => (window as any).__held[1]())
  await expect(page.getByTestId('mail-message-4')).toContainText('b1')
  await expect(page.getByTestId('mail-send')).toBeEnabled()
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
  await expect(page.getByTestId('inbox-list')).toBeVisible()

  const after = await frame()
  // The panel ends inside the window, the page itself does not scroll, and the top bar stays where it was
  expect(after.inbox!.y + after.inbox!.h).toBeLessThanOrEqual(after.doc.view)
  expect(after.doc.height).toBeLessThanOrEqual(after.doc.view)
  expect(after.doc.top).toBe(0)
  expect(after.counter).toEqual(before.counter)
  // The list is what scrolls: it holds more than it shows, and the header above it stays
  const list = page.getByTestId('inbox-list')
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
})

// #2213: nothing waits when every thread is read; they are folded under Earlier, and the list says so
test('Inbox: with only read threads, the list says nothing waits and keeps them under Earlier', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Already read', from: PARSER, body: 'x' })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await page.getByTestId('mail-back').click()
  await expect(page.getByTestId('mail-thread')).toHaveCount(0)
  await expect(page.getByTestId('inbox-empty')).toContainText('Nothing waiting')
  await expect(page.getByTestId('inbox-earlier-toggle')).toContainText('Earlier')
  await expect(page.getByTestId(`mail-thread-${id}`)).toHaveCount(0)
  await page.getByTestId('inbox-earlier-toggle').click()
  await expect(page.getByTestId(`mail-thread-${id}`)).toBeVisible()
})

// #2213 (owner, 2026-11-12): newest first, mail that was not delivered pinned on top, what is read folded under Earlier
test('Inbox: undelivered mail is pinned on top of the list, and a read thread folds under Earlier (order among rows: inboxList.test.ts)', async ({ page }) => {
  await setup(page)
  const boss = { ...PARSER, address: 'session:mock/s0', sessionId: 's0', name: 'Boss' }
  const read = await seed(page, { subject: 'Already read', from: PARSER, body: 'x' })
  const fresh = await seed(page, { subject: 'Fresh question', from: PARSER, body: 'y' })
  await seed(page, { subject: 'Do the thing', from: boss, body: 'please', kind: 'assign', onlyHeld: true, held: { reason: 'failed', recipient: PARSER } })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${read}`).click()
  await expect(page.getByTestId('mail-thread')).toBeVisible()
  await page.getByTestId('mail-back').click()
  await expect(page.getByTestId('mail-thread')).toHaveCount(0)

  const y = async (testId: string) => (await page.getByTestId(testId).boundingBox())!.y
  // The held mail is above the thread that waits
  await expect(page.getByTestId('mail-held')).toBeVisible()
  expect(await y('mail-held')).toBeLessThan(await y(`mail-thread-${fresh}`))
  // The read thread is not in the list until Earlier is opened, and then it is below the rest
  await expect(page.getByTestId(`mail-thread-${read}`)).toHaveCount(0)
  await expect(page.getByTestId('inbox-earlier-toggle')).toHaveAttribute('aria-expanded', 'false')
  await page.getByTestId('inbox-earlier-toggle').click()
  await expect(page.getByTestId('inbox-earlier')).toHaveAttribute('data-fold', 'open')
  expect(await y(`mail-thread-${read}`)).toBeGreaterThan(await y(`mail-thread-${fresh}`))
})

// #2213 follow-up: one cursor over the one list. It takes the top row when the list opens and stays on that row as waits arrive above
// it; ↑ and ↓ stop on mail rows too, and ↵ opens the row it is on, a thread as well as a session
test('Inbox: the cursor takes the top row on open, follows it as rows arrive, and walks the mail rows too', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const done = async (id: string) =>
    page.evaluate((sid) => {
      const m = (window as any).__mock
      m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: 'done, over to you' })
      m.emit({ type: 'turn_complete', sessionId: sid })
    }, id)
  const older = await newSession(page, 'alpha', 'older task')
  await done(older)
  const thread = await seed(page, { subject: 'Which branch?', from: PARSER, body: 'main or release?' })
  await page.getByTestId('counter').click()
  const cursorOn = (testId: string) => expect(page.locator('[data-cursor]').getByTestId(testId)).toHaveCount(1)
  // The newest is the thread: the cursor is on it, not on a session by default
  await cursorOn(`mail-thread-${thread}`)

  // A wait arrives above it: the cursor stays on the thread
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inbox')).toBeHidden()
  const newer = await newSession(page, 'alpha', 'newer task')
  await done(newer)
  await page.getByTestId('counter').click()
  await cursorOn(`inbox-item-${newer}`)
  await page.keyboard.press('j')
  await cursorOn(`mail-thread-${thread}`)
  await page.keyboard.press('j')
  await cursorOn(`inbox-item-${older}`)
  await page.keyboard.press('k')
  await cursorOn(`mail-thread-${thread}`)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('mail-thread')).toBeVisible()
})

// The cursor's place follows its row as rows arrive above it, so a row that is done hands the cursor to its neighbour, not to the new top row
test('Inbox: a wait arriving above the cursor, then the cursor row done: the cursor lands on that row neighbour', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const done = async (id: string) =>
    page.evaluate((sid) => {
      const m = (window as any).__mock
      m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: 'done, over to you' })
      m.emit({ type: 'turn_complete', sessionId: sid })
    }, id)
  const oldest = await newSession(page, 'alpha', 'oldest task')
  await done(oldest)
  const middle = await newSession(page, 'alpha', 'middle task')
  await done(middle)
  const arriving = await newSession(page, 'alpha', 'arriving task')
  await page.getByTestId('counter').click()
  const cursorOn = (id: string) => expect(page.locator('[data-cursor]').getByTestId(`inbox-item-${id}`)).toHaveCount(1)
  await cursorOn(middle)
  await done(arriving)
  await expect(page.getByTestId(`inbox-item-${arriving}`)).toBeVisible()
  await cursorOn(middle)
  // The cursor row is done: the row at its place (the oldest), not the wait that arrived on top
  await page.keyboard.press('d')
  await cursorOn(oldest)
})
