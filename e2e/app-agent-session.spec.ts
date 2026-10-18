import { test, expect, type Page } from '@playwright/test'
import { newSession, setup } from './fixtures/control.js'

/**
 * An app's agent session the person opens (#378 review), on the mock platform.
 *
 * The host deletes an app-agent session once its run ends cleanly, unless the person opened it or wrote to it. It
 * hears "opened" through `markRead`, which the window used to send only with something unread and only after 3
 * seconds on screen. The app's request is read as it arrives, so opening a fresh one told the host nothing, and a short
 * run then deleted the session in front of the person, with what they were typing in it.
 */

/** Turns a session into an app's agent session with nothing unread, on both sides, and records the markRead calls */
async function asAppAgentSession(page: Page, id: string) {
  await page.evaluate((sid: string) => {
    const w = window as any
    const m = w.__mock
    const host = m.sessions.get(sid)
    Object.assign(host, { appId: 'notes', lastReadSeq: host.lastSeq })
    const st = w.__store.getState()
    w.__store.setState({ sessions: { ...st.sessions, [sid]: { ...st.sessions[sid], appId: 'notes', lastReadSeq: st.sessions[sid].lastSeq } } })
    w.__marks = []
    const markRead = m.agents.markRead
    m.agents.markRead = (sessionId: string, seq: number) => {
      w.__marks.push([sessionId, seq])
      return markRead(sessionId, seq)
    }
  }, id)
}

test('opening an app-agent session with nothing unread tells the host it is open', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const agent = await newSession(page, 'alpha', 'summarise the notes')
  const other = await newSession(page, 'alpha', 'something else')
  expect(other).not.toBe(agent)
  await asAppAgentSession(page, agent)

  await page.evaluate((sid: string) => (window as any).__store.getState().focusSession(sid), agent)
  await expect(page.getByTestId('chat-stream')).toContainText('summarise the notes')
  await expect.poll(() => page.evaluate(() => (window as any).__marks as [string, number][])).toContainEqual([agent, expect.any(Number)])
})

test('a draft in a session that is deleted is kept, to be copied', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await newSession(page, 'alpha', 'summarise the notes')
  await page.getByTestId('prompt-input').fill('and the second list too')
  await expect.poll(() => page.evaluate((sid: string) => (window as any).__store.getState().drafts[sid]?.text, id)).toBe('and the second list too')

  // The host deletes it, as it does an app's agent session whose run is over
  await page.evaluate((sid: string) => (window as any).__mock.emit({ type: 'session_deleted', sessionId: sid }), id)
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('kept-draft')).toContainText('was deleted. Your draft is kept here.')
  await expect(page.getByTestId('kept-draft-text')).toHaveText('and the second list too')
  await expect(page.getByTestId('kept-draft-copy')).toBeVisible()

  await page.getByTestId('kept-draft-dismiss').click()
  await expect(page.getByTestId('kept-draft')).toHaveCount(0)
})
