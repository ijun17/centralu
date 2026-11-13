import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * A turn the network, a quit or its tool cut short (#698). The host decides why (`SessionInfo.interruption`, the
 * `interruption` event); the screen says it in the inbox, on the sidebar's tool mark and above the composer, and offers
 * Continue, which sends one message. On 2026-10-15 the internet dropped twice while several child sessions worked: the
 * Claude children ended in `error` and the person had to find each one and type "continue".
 *
 * The session the tests are about is never the one on screen, except where the conversation's own note is checked:
 * a session in front of the person is marked read by itself, which would hide the inbox rows these tests set up.
 */

type Mock = { emit(e: Record<string, unknown>): void }

const ECONNREFUSED = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'

async function emit(page: Page, events: Record<string, unknown>[]) {
  await page.evaluate((list) => {
    const m = (window as any).__mock as Mock
    for (const e of list) m.emit(e)
  }, events)
}

/** As the host sends it: the turn fails after the CLI's retries, then why */
const networkFailure = (sid: string) => [
  { type: 'state_change', sessionId: sid, state: 'working' },
  { type: 'message_delta', sessionId: sid, role: 'assistant', text: 'waiting on pnpm verify' },
  { type: 'error', sessionId: sid, error: { code: 'internal', message: ECONNREFUSED, retryable: true } },
  { type: 'interruption', sessionId: sid, interruption: { reason: 'network', at: Date.now(), detail: ECONNREFUSED } },
]

const item = (page: Page, id: string) => page.getByTestId(`inbox-item-${id}`)
const mark = (page: Page, id: string) => page.getByTestId(`session-row-${id}`).locator('[data-testid^="tool-mark-"][data-state]')

async function openInbox(page: Page) {
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox')).toBeVisible()
}

export function interruptedSessionTests() {
  test('2026-10-15: a turn the network ended says so in the inbox and on the mark, and Continue sends one message', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const child = await newSession(page, 'alpha')
    await newSession(page, 'alpha')
    await emit(page, networkFailure(child))

    await expect(mark(page, child)).toHaveAttribute('data-interruption', 'network')
    await openInbox(page)
    await expect(item(page, child)).toContainText('Stopped: network')
    await page.getByTestId(`inbox-continue-${child}`).click()

    // One message, the person's, as if typed: the agent still has its conversation
    await expect
      .poll(() =>
        page.evaluate(
          (sid) => (((window as any).__mock.messages.get(sid) ?? []) as { role: string; payload: { text?: string } }[]).filter((m) => m.role === 'user').map((m) => m.payload.text),
          child,
        ),
      )
      .toEqual(['Continue where you stopped. Check what already happened before repeating a step.'])
    await expect(item(page, child)).toHaveCount(0)
    await expect(mark(page, child)).not.toHaveAttribute('data-interruption', /.+/)
  })

  test('the conversation says why above the composer, and its Continue goes on', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    await emit(page, networkFailure(s))
    const note = page.getByTestId('interrupted-note')
    await expect(note).toContainText('A network error ended the last turn before it finished')
    await expect(note).toHaveAttribute('title', ECONNREFUSED)

    await page.getByTestId('interrupted-continue').click()
    await expect(note).toHaveCount(0)
  })

  test('a session a quit stopped is listed while its line is unread, with Continue and Done; Done keeps the mark', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    await newSession(page, 'alpha')
    // What a start sends no window, but lists: idle, the quit line unread, the reason (the mock gets it by the event)
    await emit(page, [
      { type: 'notice', sessionId: s, level: 'warning', from: 'Centralu', label: 'stopped', text: 'Centralu quit or restarted while this turn was running, so the turn stopped before it finished. Send a message to continue.' },
      { type: 'interruption', sessionId: s, interruption: { reason: 'quit', at: Date.now() } },
    ])

    await openInbox(page)
    await expect(item(page, s)).toContainText('Stopped: Centralu quit or restarted')
    await expect(page.getByTestId(`inbox-continue-${s}`)).toBeVisible()
    await page.getByTestId(`inbox-done-${s}`).click()
    await expect(item(page, s)).toHaveCount(0)
    await expect(mark(page, s)).toHaveAttribute('data-interruption', 'quit')
  })

  test("a session the computer's shutdown stopped says so in the inbox and above the composer, with the same Continue (#1397)", async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    await newSession(page, 'alpha')
    await emit(page, [
      { type: 'notice', sessionId: s, level: 'warning', from: 'Centralu', label: 'stopped', text: 'This turn stopped before it finished: the computer shut down, restarted or signed out while it was running. Send a message to continue.' },
      { type: 'interruption', sessionId: s, interruption: { reason: 'shutdown', at: Date.now() } },
    ])

    await openInbox(page)
    await expect(item(page, s)).toContainText('Stopped: the computer shut down, restarted or signed out')
    await expect(page.getByTestId(`inbox-continue-${s}`)).toBeVisible()
    await expect(mark(page, s)).toHaveAttribute('data-interruption', 'shutdown')
    await page.keyboard.press('Escape')
    await page.getByTestId(`session-row-${s}`).click()
    const note = page.getByTestId('interrupted-note')
    await expect(note).toContainText('The last turn did not finish: the computer shut down, restarted or signed out while it was running.')
    await page.getByTestId('interrupted-continue').click()
    await expect(note).toHaveCount(0)
  })

  test('a tool reconnecting for too long is listed while it lasts, with nothing to continue', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    await newSession(page, 'alpha')
    await emit(page, [
      { type: 'state_change', sessionId: s, state: 'working' },
      { type: 'activity', sessionId: s, activity: 'retrying' },
      { type: 'interruption', sessionId: s, interruption: { reason: 'reconnecting', at: Date.now() - 6 * 60_000 } },
    ])
    await openInbox(page)
    await expect(item(page, s)).toContainText('Reconnecting for 5+ min')
    await expect(page.getByTestId(`inbox-continue-${s}`)).toHaveCount(0)

    await emit(page, [{ type: 'interruption', sessionId: s, interruption: null }])
    await expect(item(page, s)).toHaveCount(0)
  })

  test("a stop Centralu continues by itself shows the wait in the header, with Continue now and Don't continue (#1415)", async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const other = await newSession(page, 'alpha')
    const s = await newSession(page, 'alpha')
    const at = new Date(2030, 0, 1, 1, 20).getTime()
    await emit(page, [{ type: 'interruption', sessionId: s, interruption: { reason: 'limit', at: Date.now(), autoContinue: { at, tries: 0 } } }])
    const wait = page.getByTestId('auto-continue-wait')
    await expect(wait).toHaveText('Usage limit · continues at 01:20')
    await expect(page.getByTestId('session-name').locator('xpath=..').getByTestId('auto-continue-now')).toBeVisible()
    // The line above the composer says the stop as before, without the header's buttons: none shows twice
    const note = page.getByTestId('interrupted-note')
    await expect(note).toContainText('Stopped: usage limit')
    await expect(page.getByTestId('interrupted-continue')).toHaveCount(0)

    // Don't continue: the wait leaves the header, and the line's Continue is back
    await page.getByTestId('auto-continue-stop').click()
    await expect(page.getByTestId('auto-continue')).toHaveCount(0)
    await expect(note).toContainText('Stopped: usage limit')
    await expect(page.getByTestId('interrupted-continue')).toHaveText('Continue')

    // The inbox row says the wait in the header's words; a network wait says what it waits for
    const failure = networkFailure(other)
    await emit(page, [...failure.slice(0, -1), { type: 'interruption', sessionId: other, interruption: { reason: 'network', at: Date.now(), autoContinue: { tries: 1 } } }])
    await openInbox(page)
    await expect(item(page, other)).toContainText('Network lost · continues when the network is back')
    await expect(page.getByTestId(`inbox-continue-${other}`)).toHaveText('Continue now')

    // Continue now in the header sends the one message, and the wait and the line go
    await page.keyboard.press('Escape')
    await emit(page, [{ type: 'interruption', sessionId: s, interruption: { reason: 'network', at: Date.now(), autoContinue: { tries: 1 } } }])
    await expect(wait).toHaveText('Network lost · continues when the network is back')
    await page.getByTestId('auto-continue-now').click()
    await expect(note).toHaveCount(0)
    await expect(page.getByTestId('auto-continue')).toHaveCount(0)
  })
}
