import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * Opening the Assistant from a mail in the header mailbox lands on its conversation, the same screen the sidebar's button
 * gives (#1647). The mail's "Open" goes through `focusSession`, and the Assistant screen shows the session named by
 * `assistantId`, which a run learns only when it opens that screen itself: a run that has not (the app was restarted on
 * another session) showed the empty start screen until the person went to the grid and back.
 *
 * A function, like the other fixtures, because it runs in Chromium and in WebKit (the desktop app is WKWebView).
 */

type Mock = { seedMail(s: Record<string, unknown>): string }

/**
 * The Assistant has a conversation on the host and the person is on another session, in a run that has not opened the
 * assistant screen: the store holds the session's row (the list names it) but not the id the screen shows, and has not read
 * its conversation. Returns the Assistant's id.
 */
async function assistantNotOpenedThisRun(page: Page): Promise<string> {
  await setup(page, ['/tmp/alpha'])
  await page.getByTestId('assistant-button').click()
  await page.getByTestId('assistant-input').fill('hello assistant')
  await page.getByTestId('assistant-input').press('Enter')
  await expect(page.getByTestId('msg-user').first()).toBeVisible()
  const orc = await page.evaluate(() => (window as any).__store.getState().assistantId as string)
  await newSession(page, 'alpha')
  await page.evaluate((id) => {
    const store = (window as any).__store
    const { chat, history } = store.getState()
    const { [id]: _chat, ...restChat } = chat
    const { [id]: _history, ...restHistory } = history
    store.setState({ assistantId: null, chat: restChat, history: restHistory })
  }, orc)
  return orc
}

const seed = (page: Page, spec: Record<string, unknown>) =>
  page.evaluate((s) => ((window as any).__mock as Mock).seedMail(s), spec)

export function mailOpenAssistantTests() {
  test('Open on a mail from the Assistant shows its conversation, not the start screen', async ({ page }) => {
    const orc = await assistantNotOpenedThisRun(page)
    const id = await seed(page, {
      subject: 'Report from the Assistant',
      from: { address: `session:mock/${orc}`, kind: 'session', sessionId: orc, name: 'Assistant', state: 'idle' },
      body: 'done',
      kind: 'report',
    })

    await page.getByTestId('counter').click()
    await page.getByTestId(`mail-thread-${id}`).click()
    await page.getByTestId(`mail-open-${orc}`).click()

    await expect(page.getByTestId('inbox')).toBeHidden()
    await expect(page.getByTestId('assistant-button')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('msg-user').first()).toContainText('hello assistant')
    await expect(page.getByTestId('assistant-empty')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__store.getState().assistantId)).toBe(orc)
  })

  test('the sidebar button gives the same screen', async ({ page }) => {
    await assistantNotOpenedThisRun(page)
    await page.getByTestId('assistant-button').click()

    await expect(page.getByTestId('msg-user').first()).toContainText('hello assistant')
    await expect(page.getByTestId('assistant-empty')).toHaveCount(0)
  })
}
