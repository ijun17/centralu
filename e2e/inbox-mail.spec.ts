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
  await expect(page.getByTestId(`mail-ask-${id}`)).toContainText('Which branch?')
  await expect(page.getByTestId(`mail-ask-${id}`)).toContainText('Parser asks you')

  await page.getByTestId(`mail-thread-${id}`).click()
  await expect(page.getByTestId('mail-thread')).toBeVisible()
  await expect(page.getByTestId('mail-message-1')).toContainText('main or release?')
  // Read, but still a question waiting for an answer: it stays counted until it is answered
  await expect(page.getByTestId('count-waiting')).toHaveText('1')

  await page.getByTestId('mail-reply').fill('the release branch')
  await page.getByTestId('mail-send').click()
  await expect(page.getByTestId('mail-message-2')).toContainText('the release branch')
  await expect(page.getByTestId('count-waiting')).toHaveText('0')
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

test('Mail: with two questions open the reply box says which one its words answer, and switching changes it (#2191)', async ({ page }) => {
  await setup(page)
  const other = { ...PARSER, address: 'session:mock/s2', sessionId: 's2', name: 'Builder' }
  const id = await seed(page, { subject: 'Two questions', from: PARSER, body: 'Which branch should I build on?', choices: ['main', 'release'] })
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  // One question open: the box is as it always was
  await expect(page.getByTestId('mail-answering')).toHaveCount(0)
  await page.evaluate(([thread, from]) => (window as any).__mock.seedMailMessage(thread, { from, body: 'Keep the old settings format?', choices: ['Keep it', 'Switch now'] }), [id, other] as const)

  // The newest is the default, and the rest are counted
  await expect(page.getByTestId('mail-answering-target')).toHaveText('Builder · “Keep the old settings format?”')
  await expect(page.getByTestId('mail-answering-others')).toHaveText('1 other open')
  // Words with the default target answer the newest question and leave the other open
  await page.getByTestId('mail-reply').fill('Yes, keep it for one release')
  await page.getByTestId('mail-send').click()
  await expect(page.getByTestId('mail-message-3')).toContainText('Yes, keep it for one release')
  await expect(page.getByTestId('mail-choices-2-label')).toHaveText('Answered')
  await expect(page.getByTestId('mail-choices-1-label')).toHaveText('Choose one')
  // One left open: the box says nothing of a target again
  await expect(page.getByTestId('mail-answering')).toHaveCount(0)
})

test('Mail: switching the question the reply box answers sends the words to that question (#2191)', async ({ page }) => {
  await setup(page)
  const other = { ...PARSER, address: 'session:mock/s2', sessionId: 's2', name: 'Builder' }
  const id = await seed(page, { subject: 'Two questions', from: PARSER, body: 'Which branch should I build on?', choices: ['main', 'release'] })
  await page.evaluate(([thread, from]) => (window as any).__mock.seedMailMessage(thread, { from, body: 'Keep the old settings format?', choices: ['Keep it', 'Switch now'] }), [id, other] as const)
  await page.getByTestId('counter').click()
  await page.getByTestId(`mail-thread-${id}`).click()
  await page.getByTestId('mail-answering-button').click()
  await expect(page.getByTestId('mail-answering-list')).toBeVisible()
  await page.getByTestId('mail-answering-1').click()
  await expect(page.getByTestId('mail-answering-target')).toHaveText('Parser · “Which branch should I build on?”')
  await page.getByTestId('mail-reply').fill('the release branch, please')
  await page.getByTestId('mail-send').click()
  await expect(page.getByTestId('mail-message-3')).toContainText('the release branch, please')
  // The older question was answered, the newer one was not
  await expect(page.getByTestId('mail-choices-1-label')).toHaveText('Answered')
  await expect(page.getByTestId('mail-choices-2-label')).toHaveText('Choose one')
})

test('Inbox: Done on a mail row closes the thread from the list, and a failed close says why (#2226)', async ({ page }) => {
  await setup(page)
  // A note: Done on a card (a question waiting on the person) opens it instead, see below
  const id = await seed(page, { subject: 'Which branch?', from: PARSER, kind: 'note', body: 'main or release?' })
  await page.getByTestId('counter').click()
  await expect(page.getByTestId(`mail-thread-${id}`)).toBeVisible()
  await page.evaluate(() => {
    const w = window as any
    const mail = w.__store.getState().platform.mail
    const real = mail.close.bind(mail)
    w.__fail = true
    mail.close = (...a: unknown[]) => (w.__fail ? Promise.reject(new Error('the link is down')) : real(...a))
  })
  await page.keyboard.press('d')
  await expect(page.getByTestId('toast')).toContainText('Could not close this mail: the link is down')
  await expect(page.getByTestId(`mail-thread-${id}`)).toBeVisible()
  await page.evaluate(() => ((window as any).__fail = false))
  await page.keyboard.press('d')
  // Done leaves the list of what waits at once (a read, finished thread folds under Earlier), with nothing opened
  await expect(page.getByTestId(`mail-thread-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('mail-thread')).toHaveCount(0)
})

test('Inbox: a question waiting on the person is a card above the rows, a pick answers it without opening, and the card leaves (#2229)', async ({ page }) => {
  await setup(page)
  const note = await seed(page, { subject: 'Release notes', from: PARSER, kind: 'note', body: 'Drafted. Nothing for you to do.' })
  const asked = await seed(page, { subject: 'Settings file format', from: PARSER, body: 'How should I handle that?', choices: ['Keep the old format', 'Switch now'] })
  await page.getByTestId('counter').click()
  const card = page.getByTestId(`mail-ask-${asked}`)
  await expect(card).toContainText('Parser asks you')
  await expect(page.getByTestId(`mail-state-${asked}`)).toHaveText('Waiting on you')
  // The ordinary thread stays a row, below the card, and says Open
  await expect(page.getByTestId(`mail-state-${note}`)).toHaveText('Open')
  expect(await page.locator('[data-testid^="mail-ask-"], [data-testid^="mail-thread-"]').first().getAttribute('data-testid')).toBe(`mail-ask-${asked}`)
  // The badge's edge is solid while the answer waits
  await expect(page.getByTestId('counter')).toHaveAttribute('data-edge', 'question')
  // A pick answers it from the list: nothing opens, and the card is gone once the host has the answer
  await page.getByTestId(`mail-ask-choices-${asked}-2`).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('mail-thread')).toHaveCount(0)
  await expect(page.getByTestId('counter')).not.toHaveAttribute('data-edge', 'question')
})

test('Inbox: words written on a question card answer that question, as the card’s pick would, and the card leaves (#2327)', async ({ page }) => {
  await setup(page)
  const asked = await seed(page, { subject: 'Settings file format', from: PARSER, body: 'How should I handle that?', choices: ['Keep the old format', 'Switch now'] })
  await page.getByTestId('counter').click()
  const card = page.getByTestId(`mail-ask-${asked}`)
  const field = page.getByTestId(`mail-ask-answer-${asked}`)
  await expect(page.getByTestId(`mail-ask-send-${asked}`)).toBeDisabled()
  // The host answers when told to: what the card does while the words are on their way
  await page.evaluate(() => {
    const w = window as any
    const mail = w.__store.getState().platform.mail
    const real = mail.reply.bind(mail)
    w.__held = []
    w.__calls = []
    mail.reply = (...a: unknown[]) => {
      w.__calls.push(a)
      return new Promise((resolve) => w.__held.push(() => resolve(real(...a))))
    }
  })
  // The question the card shows, as the host named it
  const question = await page.evaluate((t) => (window as any).__store.getState().mail.threads.find((x: { id: string }) => x.id === t).ask.id as string, asked)
  await field.fill('Neither: ask the owner, option ')
  // A number typed in the field is a word, not a pick: the list's keys are off while a field has the keyboard
  await field.press('2')
  await expect(field).toHaveValue('Neither: ask the owner, option 2')
  await expect(page.getByTestId(`mail-ask-choices-${asked}-label`)).toHaveText('Choose one')
  expect(await page.evaluate(() => (window as any).__calls)).toEqual([])
  await field.press('End')
  await page.keyboard.type(' breaks the tests')
  await field.press('Enter')
  // One question, one answer: the choices lock and say so, and the words cannot be sent twice
  await expect(page.getByTestId(`mail-ask-choices-${asked}-label`)).toHaveText('Answered')
  await expect(page.getByTestId(`mail-ask-choices-${asked}-1`)).toBeDisabled()
  await expect(page.getByTestId(`mail-ask-send-${asked}`)).toBeDisabled()
  await field.press('Enter')
  expect(await page.evaluate(() => (window as any).__calls)).toEqual([[asked, 'Neither: ask the owner, option 2 breaks the tests', 'answer', question]])
  await page.evaluate(() => (window as any).__held.forEach((release: () => void) => release()))
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('count-waiting')).toHaveText('0')
  // In the thread the words are the answer to that question, not a new message
  await page.getByTestId('inbox-earlier-toggle').click()
  await page.getByTestId(`mail-thread-${asked}`).click()
  await expect(page.getByTestId('mail-message-2')).toContainText('Neither: ask the owner')
  await expect(page.getByTestId('mail-message-2')).toContainText('You · answer')
  await expect(page.getByTestId('mail-choices-1-label')).toHaveText('Answered')
  await expect(page.getByTestId('mail-choices-1-2')).toHaveAttribute('aria-pressed', 'false')
})

test('Inbox: a question card without choices takes the answer in words alone, and a refused answer keeps them with the host’s words (#2327)', async ({ page }) => {
  await setup(page)
  const asked = await seed(page, { subject: 'Commit message', from: PARSER, body: 'Should it say what changed, or why?' })
  await page.getByTestId('counter').click()
  const card = page.getByTestId(`mail-ask-${asked}`)
  await expect(page.getByTestId(`mail-ask-choices-${asked}`)).toHaveCount(0)
  await page.evaluate(() => {
    const w = window as any
    const mail = w.__store.getState().platform.mail
    const real = mail.reply.bind(mail)
    w.__fail = true
    mail.reply = (...a: unknown[]) => (w.__fail ? Promise.reject(new Error('the link is down')) : real(...a))
  })
  const field = page.getByTestId(`mail-ask-answer-${asked}`)
  await field.fill('Why, in one line')
  await page.getByTestId(`mail-ask-send-${asked}`).click()
  await expect(page.getByTestId('toast')).toContainText('the link is down')
  await expect(field).toHaveValue('Why, in one line')
  await expect(field).not.toHaveAttribute('readonly')
  await expect(card).toBeVisible()
  await page.evaluate(() => ((window as any).__fail = false))
  await page.getByTestId(`mail-ask-send-${asked}`).click()
  await expect(card).toHaveCount(0)
  await page.getByTestId('inbox-earlier-toggle').click()
  await page.getByTestId(`mail-thread-${asked}`).click()
  await expect(page.getByTestId('mail-message-2')).toContainText('Why, in one line')
  await expect(page.getByTestId('mail-message-2')).toContainText('You · answer')
})

test('Inbox: the Enter that finishes a syllable in a question card’s field does not send the answer (#2327)', async ({ page }) => {
  await setup(page)
  const asked = await seed(page, { subject: 'Commit message', from: PARSER, body: 'Should it say what changed, or why?' })
  await page.getByTestId('counter').click()
  await page.evaluate(() => {
    const w = window as any
    const mail = w.__store.getState().platform.mail
    const real = mail.reply.bind(mail)
    w.__calls = 0
    mail.reply = (...a: unknown[]) => {
      w.__calls++
      return real(...a)
    }
  })
  const field = page.getByTestId(`mail-ask-answer-${asked}`)
  await field.fill('안녕')
  // The keystroke that commits a composition carries `isComposing`: it is the input method's (composition.spec.ts)
  await page.evaluate(async (id) => {
    const el = document.querySelector(`[data-testid="mail-ask-answer-${CSS.escape(id)}"]`) as HTMLInputElement
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done)))
  }, asked)
  expect(await page.evaluate(() => (window as any).__calls)).toBe(0)
  await expect(field).toHaveValue('안녕')
  await expect(page.getByTestId(`mail-ask-${asked}`)).toBeVisible()
  // The Enter after the composition sends
  await field.press('Enter')
  await expect(page.getByTestId(`mail-ask-${asked}`)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__calls)).toBe(1)
})

test('Inbox: while a pick on a card is on its way, its words wait: the field takes no answer of its own (#2327)', async ({ page }) => {
  await setup(page)
  const asked = await seed(page, { subject: 'Settings file format', from: PARSER, body: 'How should I handle that?', choices: ['Keep the old format', 'Switch now'] })
  await page.getByTestId('counter').click()
  await page.evaluate(() => {
    const w = window as any
    const mail = w.__store.getState().platform.mail
    const real = mail.reply.bind(mail)
    w.__held = []
    w.__calls = 0
    mail.reply = (...a: unknown[]) => {
      w.__calls++
      return new Promise((resolve) => w.__held.push(() => resolve(real(...a))))
    }
  })
  const field = page.getByTestId(`mail-ask-answer-${asked}`)
  await field.fill('words of my own')
  await page.getByTestId(`mail-ask-choices-${asked}-2`).click()
  await expect(page.getByTestId(`mail-ask-choices-${asked}-label`)).toHaveText('You chose')
  await expect(page.getByTestId(`mail-ask-send-${asked}`)).toBeDisabled()
  await field.press('Enter')
  expect(await page.evaluate(() => (window as any).__calls)).toBe(1)
  await page.evaluate(() => (window as any).__held.forEach((release: () => void) => release()))
  await expect(page.getByTestId(`mail-ask-${asked}`)).toHaveCount(0)
})

test('Inbox: words typed on a card belong to its question: answered from elsewhere, the thread’s next question takes the card with an empty field (#2327)', async ({ page }) => {
  await setup(page)
  const other = { ...PARSER, address: 'session:mock/s2', sessionId: 's2', name: 'Builder' }
  const id = await seed(page, { subject: 'Two questions', from: PARSER, body: 'Which branch?', choices: ['main', 'release'] })
  await page.evaluate(([thread, from]) => (window as any).__mock.seedMailMessage(thread, { from, body: 'Keep the old format?', choices: ['Keep it', 'Switch now'] }), [id, other] as const)
  await page.getByTestId('counter').click()
  const card = page.getByTestId(`mail-ask-${id}`)
  await expect(card).toContainText('Keep the old format?')
  const field = page.getByTestId(`mail-ask-answer-${id}`)
  await field.fill('Keep it until the release')
  // Another window answers the question on the card
  await page.evaluate(async (thread) => {
    const st = (window as any).__store.getState()
    const ask = st.mail.threads.find((t: { id: string }) => t.id === thread).ask.id
    await st.platform.mail.reply(thread, 'Switch now', 'answer', ask)
    await st.loadMail()
  }, id)
  await expect(card).toContainText('Which branch?')
  await expect(field).toHaveValue('')
  await expect(page.getByTestId(`mail-ask-send-${id}`)).toBeDisabled()
})

test('Inbox: the number keys pick a choice on the card the keyboard is on, never on the one under the pointer (#2229)', async ({ page }) => {
  await setup(page)
  const under = await seed(page, { subject: 'Older question', from: PARSER, body: 'Ship it?', choices: ['Yes', 'No'] })
  const asked = await seed(page, { subject: 'Settings file format', from: PARSER, body: 'How should I handle that?', choices: ['Keep the old format', 'Switch now'] })
  await page.getByTestId('counter').click()
  await expect(page.getByTestId(`mail-ask-${asked}`)).toBeVisible()
  // The hint names the keys while the selected card has choices
  await expect(page.getByTestId('inbox')).toContainText('1-2 Choose')
  // The pointer rests on the other card; the key still answers the selected one (the top, where the cursor opened)
  await page.getByTestId(`mail-ask-${under}`).hover()
  await page.keyboard.press('2')
  await expect(page.getByTestId(`mail-ask-${asked}`)).toHaveCount(0)
  await expect(page.getByTestId(`mail-ask-${under}`)).toBeVisible()
  await expect(page.getByTestId(`mail-ask-choices-${under}-1`)).toBeEnabled()
  await page.getByTestId('inbox-earlier-toggle').click()
  await page.getByTestId(`mail-thread-${asked}`).click()
  await expect(page.getByTestId('mail-message-2')).toContainText('Switch now')
  await expect(page.getByTestId('mail-choices-1-2')).toHaveAttribute('aria-pressed', 'true')
})

test('Inbox: D on a card opens the thread and closes nothing: a question is answered, not closed by a key (#2233)', async ({ page }) => {
  await setup(page)
  const asked = await seed(page, { subject: 'Settings file format', from: PARSER, body: 'How should I handle that?', choices: ['Keep the old format', 'Switch now'] })
  await page.getByTestId('counter').click()
  await expect(page.getByTestId(`mail-ask-${asked}`)).toBeVisible()
  await page.keyboard.press('d')
  await expect(page.getByTestId('mail-thread')).toBeVisible()
  await expect(page.getByTestId('mail-thread-state')).not.toContainText('Done')
  await expect(page.getByTestId('mail-reply')).toBeVisible()
})

test('Inbox: a question read but not answered stays a card, and a second question in its thread takes the card, unlocked, once the first is answered (#2233)', async ({ page }) => {
  await setup(page)
  const other = { ...PARSER, address: 'session:mock/s2', sessionId: 's2', name: 'Builder' }
  const id = await seed(page, { subject: 'Two questions', from: PARSER, body: 'Which branch?', choices: ['main', 'release'] })
  await page.evaluate(([thread, from]) => (window as any).__mock.seedMailMessage(thread, { from, body: 'Keep the old format?', choices: ['Keep it', 'Switch now'] }), [id, other] as const)
  await page.getByTestId('counter').click()
  const card = page.getByTestId(`mail-ask-${id}`)
  await expect(card).toContainText('Keep the old format?')
  await expect(card).toContainText('1 other waiting in this thread')
  await expect(page.getByTestId(`mail-ask-others-${id}`)).toHaveAttribute('data-fold', 'open')
  // Opened and left again: read, and still waiting on an answer, so still a card above the rows, never under Earlier
  await page.getByTestId(`mail-thread-${id}`).click()
  await page.getByTestId('mail-back').click()
  await expect(card).toBeVisible()
  await expect(page.getByTestId('inbox-earlier-toggle')).toHaveCount(0)
  await expect(page.getByTestId('count-waiting')).toHaveText('1')
  // A click answers the newest; the card then shows the first question, with its choices to press
  await page.getByTestId(`mail-ask-choices-${id}-2`).click()
  await expect(card).toContainText('Which branch?')
  // Nothing else waits in the thread: the line saying so folds away (#2327), and is gone once it has
  await expect(page.getByTestId(`mail-ask-others-${id}`)).toHaveCount(0)
  await expect(page.getByTestId(`mail-ask-choices-${id}-1`)).toBeEnabled()
  await expect(page.getByTestId(`mail-ask-choices-${id}-2`)).toBeEnabled()
  // And so does a key
  await page.keyboard.press('2')
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('count-waiting')).toHaveText('0')
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
  const id = await seed(page, { subject: 'Look at the branch', from: boss, body: 'please', kind: 'assign', onlyHeld: true, held: { reason: 'failed', recipient: PARSER } })
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

// #2213: nothing waits when every thread is read (a note: a question not answered yet still waits, #2233); they are folded under Earlier, and the list says so
test('Inbox: with only read threads, the list says nothing waits and keeps them under Earlier', async ({ page }) => {
  await setup(page)
  const id = await seed(page, { subject: 'Already read', from: PARSER, kind: 'note', body: 'x' })
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
  const read = await seed(page, { subject: 'Already read', from: PARSER, kind: 'note', body: 'x' })
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
  // A note, so it is a row among the rows: a question waiting on the person is a card, and goes first (#2229)
  const thread = await seed(page, { subject: 'Which branch?', from: PARSER, kind: 'note', body: 'main or release?' })
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

// #2258 item 3 (owner 2026-11-14, option A): the assignee's live state before its name, only when it says something
test('Mail: a row and an ask card show the dot of a session that is working, has an error or waits on an approval, and none for one that is idle', async ({ page }) => {
  await setup(page)
  const YOU = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
  const working = await seed(page, { subject: 'Port the docs', from: YOU, body: 'Translate the guide', kind: 'assign', assignee: { ...PARSER, state: 'working' } })
  const idle = await seed(page, { subject: 'Rename the tokens', from: YOU, body: 'Rename them', kind: 'assign', assignee: { ...PARSER, sessionId: 's2', name: 'Styles', state: 'idle' } })
  const asked = await seed(page, { subject: 'Which branch?', from: { ...PARSER, sessionId: 's3', name: 'Tests', state: 'error' }, body: 'main or release?' })
  await page.getByTestId('counter').click()
  await expect(page.getByTestId(`mail-people-${working}`).getByTestId('dot-working')).toBeVisible()
  await expect(page.getByTestId(`mail-people-${idle}`)).toContainText('Styles')
  await expect(page.getByTestId(`mail-people-${idle}`).locator('[data-testid^="dot-"]')).toHaveCount(0)
  await expect(page.getByTestId(`mail-ask-from-${asked}`).getByTestId('dot-error')).toBeVisible()
  // The giver's state draws nothing: the dot is the assignee's
  await expect(page.getByTestId(`mail-people-${working}`).locator('[data-testid^="dot-"]')).toHaveCount(1)
})

// #2258: on a crowded row the preview gives up its width before the subject and the names do
test('Mail: a crowded row cuts the preview, not the subject or the names', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const row = await seed(page, {
    subject: 'Mac signing',
    kind: 'assign',
    from: { ...PARSER, sessionId: 's5', name: 'release', state: 'waiting_approval' },
    assignee: { ...PARSER, sessionId: 's6', name: 'mac-builder', state: 'working' },
    body: 'Sign the Mac build with the new certificate, then tell the release session which identity it used and where the notarized build is.',
  })
  await page.getByTestId('counter').click()
  const cut = (id: string) => page.getByTestId(id).evaluate((el) => el.scrollWidth > el.clientWidth)
  await expect(page.getByTestId(`mail-preview-${row}`)).toBeVisible()
  expect(await cut(`mail-preview-${row}`)).toBe(true)
  expect(await cut(`mail-subject-${row}`)).toBe(false)
  expect(await cut(`mail-people-${row}`)).toBe(false)
  await expect(page.getByTestId(`mail-people-${row}`)).toContainText('mac-builder')
})

// A line longer than the panel is cut in both lists, never a wider row: the two lists share one grid cell for the switch's fade, whose column is the panel's
// width (an `auto` one grew to the widest line, and a long command on an approval row then measured as fitting, #683)
test('Mail and Tasks: a subject longer than the panel is cut, and neither list grows wider than the panel', async ({ page }) => {
  await setup(page)
  const LONG = 'Move the release signing, the notarization and the upload of every platform build to the new pipeline, and say which identity each used'
  const row = await seed(page, { subject: LONG, kind: 'assign', from: PARSER, assignee: { ...PARSER, sessionId: 's6', name: 'Builder' }, body: 'Move it' })
  await page.evaluate(
    (s) => (window as unknown as { __mock: { seedTask(s: Record<string, unknown>): string } }).__mock.seedTask(s),
    { subject: LONG, owner: { ...PARSER, sessionId: 's9', name: 'Lead', address: 'session:mock/s9' }, assignee: PARSER, state: 'running' },
  )
  await page.getByTestId('counter').click()
  const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth
  const widerThanPanel = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => el.getBoundingClientRect().width > (document.querySelector('[data-testid="inbox"]')?.clientWidth ?? 0) + 1)
  await expect(page.getByTestId(`mail-subject-${row}`)).toBeVisible()
  expect(await page.getByTestId(`mail-subject-${row}`).evaluate(cut)).toBe(true)
  expect(await widerThanPanel('inbox-list')).toBe(false)
  await page.getByTestId('inbox-tab-tasks').click()
  const subject = page.getByTestId('inbox-tasks').locator('[data-testid^="task-subject-"]')
  await expect(subject).toBeVisible()
  expect(await subject.evaluate(cut)).toBe(true)
  expect(await widerThanPanel('inbox-tasks')).toBe(false)
})

// #1577 (owner 2026-11-14, option C): Waiting | Tasks inside the Inbox, the host's work grouped by who acts next
test('Tasks: the switch lists the host’s work by who acts next, opens a chain between sessions read-only, and folds Done', async ({ page }) => {
  await setup(page)
  const YOU = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
  const LEAD = { ...PARSER, sessionId: 's9', name: 'Lead', address: 'session:mock/s9' }
  const seedTask = (spec: Record<string, unknown>) =>
    page.evaluate((s) => (window as unknown as { __mock: { seedTask(s: Record<string, unknown>): string } }).__mock.seedTask(s), spec)
  await seedTask({ subject: 'Which branch?', owner: PARSER, assignee: YOU, kind: 'question' })
  const between = await seedTask({ subject: 'Port the docs', owner: LEAD, assignee: PARSER, state: 'running', body: 'Translate the guide' })
  await seedTask({ subject: 'Fix the sidebar fold', owner: LEAD, assignee: PARSER, state: 'released' })
  await seedTask({ subject: 'Cache headers', owner: YOU, assignee: PARSER, state: 'done', outcome: 'reported' })

  // A host with more open work than it lists says so (`capped`)
  await page.evaluate(() => ((window as unknown as { __mock: { mockMail: { tasksCapped: number | null } } }).__mock.mockMail.tasksCapped = 2000))
  // The host's first answer is held back: the switch shows no count before it, as the list draws nothing then
  await page.evaluate(() => {
    type Held = { __mock: { mail: { tasks: () => Promise<unknown> } }; __answerTasks?: () => void }
    const w = window as unknown as Held
    const real = w.__mock.mail.tasks
    w.__mock.mail.tasks = () =>
      new Promise((resolve) => {
        w.__answerTasks = () => {
          w.__mock.mail.tasks = real
          resolve(real())
        }
      })
  })
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox-tab-tasks')).toHaveText('Tasks')
  await expect(page.getByTestId('inbox-tasks-count')).toHaveCount(0)
  await page.waitForFunction(() => typeof (window as unknown as { __answerTasks?: unknown }).__answerTasks === 'function')
  await page.evaluate(() => (window as unknown as { __answerTasks: () => void }).__answerTasks())
  await expect(page.getByTestId('inbox-tasks-count')).toHaveText('3')
  await page.getByTestId('inbox-tab-tasks').click()
  await expect(page.getByTestId('tasks-needs-you')).toContainText('Which branch?')
  await expect(page.getByTestId('tasks-waiting-on-others')).toContainText('Port the docs')
  await expect(page.getByTestId('tasks-unassigned')).toContainText('Fix the sidebar fold')
  // Done is folded until pressed
  await expect(page.getByTestId('tasks-done-toggle')).toContainText('Done1')
  await expect(page.getByText('Cache headers')).toHaveCount(0)

  // The keys walk the rows: the cursor starts on Needs you, ↓ goes to the work between sessions, ↵ opens it to read and nothing more
  await expect(page.locator('[data-cursor]')).toContainText('Which branch?')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-cursor]')).toContainText('Port the docs')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('mail-thread')).toBeVisible()
  await expect(page.getByTestId('mail-message-1')).toContainText('Translate the guide')
  await expect(page.getByTestId('mail-reply')).toHaveCount(0)
  await expect(page.getByTestId('mail-finish')).toHaveCount(0)
  // Back on the list, Done unfolds when pressed (↵ on a focused button presses the button, as on Waiting)
  await page.getByTestId('mail-back').click()
  await page.getByTestId('tasks-done-toggle').click()
  await expect(page.getByTestId('tasks-done')).toContainText('Cache headers')
  // A done task reads like read mail (ink-muted), and the list says where it stops
  await expect(page.getByTestId('tasks-done').locator('[data-testid^="task-subject-"]')).toHaveClass(/text-ink-muted/)
  await expect(page.getByTestId('tasks-capped')).toHaveText('Showing the newest 2,000 open tasks.')
  // The switch back: Tasks fades out in place while Waiting comes in (design-system §9), then goes
  const leaving = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        document.querySelector<HTMLElement>('[data-testid="inbox-tab-waiting"]')?.click()
        requestAnimationFrame(() => resolve(document.querySelector('[data-testid="inbox-tasks"]')?.closest('.cc-fade-out') != null))
      }),
  )
  expect(leaving).toBe(true)
  await expect(page.getByTestId('inbox-tasks')).toHaveCount(0)
  // Mail between sessions is not the person's own: it never lists under Waiting
  await expect(page.getByTestId(`mail-thread-${between}`)).toHaveCount(0)
  // The Inbox opens on Waiting again
  await page.keyboard.press('Escape')
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox-tab-waiting')).toHaveAttribute('aria-checked', 'true')
})

test('Tasks: a held request needs the person, and its row leads to Waiting’s held row; the arrow keys stay on the switch', async ({ page }) => {
  await setup(page)
  const LEAD = { ...PARSER, sessionId: 's9', name: 'Lead', address: 'session:mock/s9' }
  await page.evaluate(
    (s) => (window as unknown as { __mock: { seedTask(s: Record<string, unknown>): string } }).__mock.seedTask(s),
    { subject: 'Deploy the site', owner: LEAD, assignee: PARSER, held: 'policy' },
  )
  await page.getByTestId('counter').click()
  // The arrows move along the switch and stay on it, both ways (a radio group's keys)
  await page.getByTestId('inbox-tab-waiting').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('inbox-tab-tasks')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('inbox-tab-tasks')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('inbox-tab-waiting')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('inbox-tab-tasks').click()
  const row = page.getByTestId('tasks-needs-you').locator('button[data-testid^="task-"]', { hasText: 'Deploy the site' })
  await expect(row).toContainText('Held')
  await row.click()
  // Where the person can act on it: Waiting, its held row and the button that frees it
  await expect(page.getByTestId('inbox-tab-waiting')).toHaveAttribute('aria-checked', 'true')
  const held = page.locator('[data-testid^="mail-held-"]', { hasText: 'Deploy the site' })
  await expect(held).toBeInViewport()
  await expect(held.locator('[data-testid^="mail-release-"]')).toBeVisible()
  await expect(page.getByTestId('mail-thread')).toHaveCount(0)
})

test('Tasks: a host older than Tasks lists none, and Waiting works as before', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => ((window as unknown as { __mock: { mockMail: { knowsTasks: boolean } } }).__mock.mockMail.knowsTasks = false))
  await seed(page, { subject: 'Which branch?', from: PARSER, body: 'main or release?' })
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox-count')).toHaveText('1')
  await page.getByTestId('inbox-tab-tasks').click()
  await expect(page.getByTestId('inbox-tasks-empty')).toHaveText('No tasks')
})

// #2268: on a hub, a linked machine whose tasks could not be read is named under the list, folding in and out (design-system §9)
test('Tasks: a machine that could not be reached is named under the list, and the line folds in and out', async ({ page }) => {
  await setup(page)
  type Mock = { __mock: { seedTask(s: Record<string, unknown>): string; mockMail: { tasksUnreached: { machineId: string; name: string }[] } } }
  const LEAD = { ...PARSER, sessionId: 's9', name: 'Lead', address: 'session:mock/s9' }
  const seedTask = (subject: string) => page.evaluate((s) => (window as unknown as Mock).__mock.seedTask(s), { subject, owner: LEAD, assignee: PARSER, state: 'running' })
  const unreached = (machines: { machineId: string; name: string }[]) =>
    page.evaluate((m) => ((window as unknown as Mock).__mock.mockMail.tasksUnreached = m), machines)
  await seedTask('Port the docs')
  await page.getByTestId('counter').click()
  await page.getByTestId('inbox-tab-tasks').click()
  await expect(page.getByTestId('inbox-tasks').locator('[data-testid^="task-subject-"]')).toHaveCount(1)
  await expect(page.getByTestId('tasks-unreached')).toHaveCount(0)

  // The next read names the machine: the line folds in and settles open
  await unreached([{ machineId: 'm1', name: 'Build box' }])
  await seedTask('Cache headers')
  const line = page.getByTestId('tasks-unreached')
  await expect(line).toHaveText('Not listed: the tasks on Build box, which could not be reached just now.')
  const fold = line.locator('xpath=ancestor::div[contains(@class, "cc-fold")][1]')
  await expect(fold).toHaveAttribute('data-fold', 'open')

  // Read again with every machine answering: it folds out, keeping its words while it leaves, and is gone
  await unreached([])
  await seedTask('Sidebar fold')
  await expect(fold).toHaveAttribute('data-fold', 'closing')
  await expect(line).toHaveText('Not listed: the tasks on Build box, which could not be reached just now.')
  await expect(page.getByTestId('tasks-unreached')).toHaveCount(0)
})
