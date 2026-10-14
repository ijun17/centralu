import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * The inbox lists a finished turn (`waiting_input`) only while it is unread, and Done marks one read without
 * opening it (#669). Approvals and errors stay listed whatever the read mark says.
 *
 * A function, like the other fixtures, because it runs in Chromium (inbox-done.spec.ts) and in WebKit
 * (inbox-done-webkit.spec.ts): the keys and the row's two buttons are what the desktop app's WKWebView has to get right.
 *
 * Every session here but the last one made is **not** the one on screen: a session in front of the person is
 * marked read by itself after a moment, which would hide the unread state these tests set up.
 */

type Mock = {
  emit(e: Record<string, unknown>): void
  requestApproval(id: string, d: Record<string, unknown>): Promise<unknown>
  sessions: Map<string, { lastSeq: number; lastReadSeq: number }>
}

/** Two sessions in alpha; the second is on screen. Returns the first (the one the tests are about) and the second. */
async function twoSessions(page: Page): Promise<{ target: string; shown: string }> {
  await setup(page, ['/tmp/alpha'])
  const target = await newSession(page, 'alpha')
  const shown = await newSession(page, 'alpha')
  return { target, shown }
}

/** The session answers: some text, then the end of the turn → `waiting_input` with something new to read */
async function answer(page: Page, id: string, text: string) {
  await page.evaluate(
    ({ sid, t }) => {
      const m = (window as any).__mock as Mock
      m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: t })
      m.emit({ type: 'turn_complete', sessionId: sid })
    },
    { sid: id, t: text },
  )
}

/** What the host holds for the session — the record a reload or a restart reads back */
const hostRead = (page: Page, id: string) =>
  page.evaluate((sid) => {
    const s = ((window as any).__mock as Mock).sessions.get(sid)!
    return { lastSeq: s.lastSeq, lastReadSeq: s.lastReadSeq }
  }, id)

const item = (page: Page, id: string) => page.getByTestId(`inbox-item-${id}`)
const waitingCount = (page: Page) => page.getByTestId('count-waiting')

async function openInbox(page: Page) {
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox')).toBeVisible()
}

export function inboxDoneTests() {
  test('an unread finished turn is listed and counted; opening it and reading it takes it off', async ({ page }) => {
    const { target } = await twoSessions(page)
    await answer(page, target, 'finished while you were elsewhere')
    await expect(waitingCount(page)).toContainText('1')

    await openInbox(page)
    await expect(item(page, target)).toBeVisible()
    await item(page, target).click()
    await expect(page.getByTestId('session-view')).toContainText('finished while you were elsewhere')

    // Reading marks it read on the host; the row and the count follow
    await expect.poll(async () => (await hostRead(page, target)).lastReadSeq).toBe((await hostRead(page, target)).lastSeq)
    await expect(waitingCount(page)).toContainText('0')
    await openInbox(page)
    await expect(item(page, target)).toHaveCount(0)
    await expect(page.getByTestId('inbox-empty')).toBeVisible()
  })

  test('Done by mouse takes the row off without opening the session, and the host keeps the read mark', async ({ page }) => {
    const { target, shown } = await twoSessions(page)
    await answer(page, target, 'a finished answer')
    await openInbox(page)
    expect((await hostRead(page, target)).lastReadSeq).toBeLessThan((await hostRead(page, target)).lastSeq)

    await page.getByTestId(`inbox-done-${target}`).click()

    await expect(item(page, target)).toHaveCount(0)
    await expect(waitingCount(page)).toContainText('0')
    // Not opened: the session on screen is still the other one, and the list is still open
    expect(await page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(shown)
    await expect(page.getByTestId('inbox')).toBeVisible()
    // The same record a reload reads back: Done is the existing read mark, not state kept in the screen
    const after = await hostRead(page, target)
    expect(after.lastReadSeq).toBe(after.lastSeq)
    // A fresh snapshot of the host's sessions agrees, so the row does not come back on a reconnect
    await page.evaluate(async () => {
      const st = (window as any).__store.getState()
      const list = await st.platform.agents.listSessions()
      ;(window as any).__listed = list
    })
    const listed = await page.evaluate((sid) => (window as any).__listed.find((s: any) => s.id === sid), target)
    expect(listed.lastReadSeq).toBe(listed.lastSeq)
  })

  test('Done by keyboard: d on the row under the cursor, without opening it', async ({ page }) => {
    const { target, shown } = await twoSessions(page)
    await answer(page, target, 'a finished answer')
    await page.keyboard.press('Meta+i')
    await expect(item(page, target)).toBeVisible()

    await page.keyboard.press('d')

    await expect(item(page, target)).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(shown)
    expect((await hostRead(page, target)).lastReadSeq).toBe((await hostRead(page, target)).lastSeq)
    await expect(page.getByTestId('inbox-empty')).toBeVisible()
  })

  test('Done leaves the cursor on a row, and a second d takes the next one', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const a = await newSession(page, 'alpha')
    const b = await newSession(page, 'alpha')
    await newSession(page, 'alpha')
    await answer(page, a, 'first')
    await answer(page, b, 'second')
    await page.keyboard.press('Meta+i')
    await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(2)

    await page.keyboard.press('j') // to the last row
    await page.keyboard.press('d')
    await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(1)
    await page.keyboard.press('d') // the cursor stayed on the one row left
    await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(0)
  })

  test('a new answer brings a done session back', async ({ page }) => {
    const { target } = await twoSessions(page)
    await answer(page, target, 'first answer')
    await openInbox(page)
    await page.getByTestId(`inbox-done-${target}`).click()
    await expect(item(page, target)).toHaveCount(0)
    await expect(waitingCount(page)).toContainText('0')

    // The person sends nothing; the agent comes back with something new (a new lastSeq)
    await answer(page, target, 'second answer')

    await expect(item(page, target)).toBeVisible()
    await expect(waitingCount(page)).toContainText('1')
  })

  test('approvals and errors are listed whether read or not, and have no Done', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const approval = await newSession(page, 'alpha')
    const error = await newSession(page, 'alpha')
    await newSession(page, 'alpha') // on screen
    await page.evaluate(
      ({ a, e }) => {
        const m = (window as any).__mock as Mock
        void m.requestApproval(a, { kind: 'command', command: 'ls', cwd: '/tmp/alpha' })
        m.emit({ type: 'message_delta', sessionId: e, role: 'assistant', text: 'about to fail' })
        m.emit({ type: 'error', sessionId: e, error: { code: 'internal', message: 'boom', retryable: false } })
      },
      { a: approval, e: error },
    )
    // Read both, as opening them would
    await page.evaluate(async ({ a, e }) => {
      const st = (window as any).__store.getState()
      await st.markRead(a)
      await st.markRead(e)
    }, { a: approval, e: error })
    expect((await hostRead(page, error)).lastReadSeq).toBe((await hostRead(page, error)).lastSeq)

    await expect(waitingCount(page)).toContainText('2')
    await openInbox(page)
    await expect(item(page, approval)).toBeVisible()
    await expect(item(page, error)).toBeVisible()
    await expect(page.getByTestId(`inbox-done-${approval}`)).toHaveCount(0)
    await expect(page.getByTestId(`inbox-done-${error}`)).toHaveCount(0)
    // d on an approval or an error does nothing
    await page.keyboard.press('d')
    await expect(item(page, approval)).toBeVisible()
    await expect(item(page, error)).toBeVisible()
  })
}
