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
    const note = page.getByTestId('stop-note')
    // In the inbox's words, without the tool's, which the conversation's line keeps
    await expect(note).toHaveText(/^Stopped: network/)
    await expect(note).not.toContainText('ECONNREFUSED')

    await page.getByTestId('stop-note-continue').click()
    await expect(note).toHaveCount(0)
  })

  test('a session a quit stopped is listed while its line is unread, with Continue and Done; Done keeps the mark', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    await newSession(page, 'alpha')
    // What a start sends no window, but lists: idle, the quit line unread, the reason (the mock gets it by the event)
    await emit(page, [
      { type: 'notice', sessionId: s, level: 'warning', from: 'Centralu', label: 'stopped', text: 'Centralu quit or restarted while this turn was running, so it stopped before it finished.' },
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
      { type: 'notice', sessionId: s, level: 'warning', from: 'Centralu', label: 'stopped', text: 'The computer shut down, restarted or signed out while this turn was running, so it stopped before it finished.' },
      { type: 'interruption', sessionId: s, interruption: { reason: 'shutdown', at: Date.now() } },
    ])

    await openInbox(page)
    await expect(item(page, s)).toContainText('Stopped: the computer shut down, restarted or signed out')
    await expect(page.getByTestId(`inbox-continue-${s}`)).toBeVisible()
    await expect(mark(page, s)).toHaveAttribute('data-interruption', 'shutdown')
    await page.keyboard.press('Escape')
    await page.getByTestId(`session-row-${s}`).click()
    const note = page.getByTestId('stop-note')
    await expect(note).toContainText('Stopped: the computer shut down, restarted or signed out')
    await page.getByTestId('stop-note-continue').click()
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

  test("a stop Centralu continues by itself shows the wait above the composer, with Continue now and Don't continue (#1415)", async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const other = await newSession(page, 'alpha')
    const s = await newSession(page, 'alpha')
    const at = new Date(2030, 0, 1, 1, 20).getTime()
    await emit(page, [{ type: 'interruption', sessionId: s, interruption: { reason: 'limit', at: Date.now(), autoContinue: { at, tries: 0 } } }])
    // The line above the composer says the wait in place of the stop, with the wait's buttons and not its own Continue
    const note = page.getByTestId('stop-note')
    const wait = note.getByTestId('auto-continue-wait')
    await expect(wait).toHaveText('Usage limit · continues at Jan 1, 2030, 01:20')
    await expect(note.getByTestId('auto-continue-now')).toBeVisible()
    await expect(note.getByTestId('auto-continue-stop')).toBeVisible()
    await expect(page.getByTestId('stop-note-continue')).toHaveCount(0)
    await expect(note).not.toContainText('Stopped: usage limit')
    // Where it fits, the words and both buttons share one row
    const middles = await Promise.all(
      [wait, note.getByTestId('auto-continue-now'), note.getByTestId('auto-continue-stop')].map(async (l) => {
        const box = (await l.boundingBox())!
        return box.y + box.height / 2
      }),
    )
    expect(Math.max(...middles) - Math.min(...middles)).toBeLessThan(2)
    // The header shows nothing of it
    await expect(page.getByTestId('session-name').locator('xpath=..').getByTestId('auto-continue')).toHaveCount(0)

    // Don't continue: the wait leaves, and the line says the stop with its Continue
    await page.getByTestId('auto-continue-stop').click()
    await expect(page.getByTestId('auto-continue')).toHaveCount(0)
    await expect(note).toContainText('Stopped: usage limit')
    await expect(page.getByTestId('stop-note-continue')).toHaveText('Continue')

    // The inbox row says the wait in the line's words; a network wait says what it waits for
    const failure = networkFailure(other)
    await emit(page, [...failure.slice(0, -1), { type: 'interruption', sessionId: other, interruption: { reason: 'network', at: Date.now(), autoContinue: { tries: 1 } } }])
    await openInbox(page)
    await expect(item(page, other)).toContainText('Network lost · continues when the network is back')
    await expect(page.getByTestId(`inbox-continue-${other}`)).toHaveText('Continue now')

    // Continue now sends the one message, and the wait and the line go
    await page.keyboard.press('Escape')
    await emit(page, [{ type: 'interruption', sessionId: s, interruption: { reason: 'network', at: Date.now(), autoContinue: { tries: 1 } } }])
    await expect(wait).toHaveText('Network lost · continues when the network is back')
    await expect(page.getByTestId('stop-note-continue')).toHaveCount(0)
    await page.getByTestId('auto-continue-now').click()
    await expect(note).toHaveCount(0)
    await expect(page.getByTestId('auto-continue')).toHaveCount(0)
  })

  test('one note above the composer says why the turn stopped, with only what applies, without the tool’s words again (#1415)', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    const note = page.getByTestId('stop-note')
    const buttons = () => note.getByRole('button').allTextContents()
    const codex = "You've hit your usage limit. Upgrade to Pro or try again at Nov 23rd, 2030 5:02 PM."
    const failWith = (message: string) => [
      { type: 'state_change', sessionId: s, state: 'working' },
      { type: 'error', sessionId: s, error: { code: 'internal', message, retryable: true } },
    ]

    // A limit stop nothing continues: the reset the host parsed from the tool's words, Continue, and Done for the error
    await emit(page, [...failWith(codex), { type: 'interruption', sessionId: s, interruption: { reason: 'limit', at: Date.now(), detail: codex, resetAt: new Date(2030, 10, 23, 17, 2).getTime() } }])
    await expect(note).toHaveCount(1)
    await expect(note.getByTestId('stop-note-words')).toHaveText('Stopped: usage limit · resets at Nov 23, 2030, 17:02')
    await expect.poll(buttons).toEqual(['Continue', 'Done'])
    await expect(note).not.toContainText('Upgrade to Pro')
    // Done takes the error's mark off; the stop and its Continue stay
    await page.getByTestId('stop-note-done').click()
    await expect.poll(buttons).toEqual(['Continue'])

    // An error no continue fixes: the one line, with Done only
    await emit(page, [...failWith('Invalid API key · Please run /login'), { type: 'interruption', sessionId: s, interruption: null }])
    await expect(note.getByTestId('stop-note-words')).toHaveText('Stopped: error')
    await expect.poll(buttons).toEqual(['Done'])
    await expect(note).not.toContainText('/login')
    await page.getByTestId('stop-note-done').click()
    await expect(note).toHaveCount(0)
  })

  test('a refused model: the line keeps the tool’s words, the note offers another model before Done (#2360)', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    const note = page.getByTestId('stop-note')
    const buttons = () => note.getByRole('button').allTextContents()
    const words = "Codex refused the model gpt-5.5: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."
    await emit(page, [
      { type: 'state_change', sessionId: s, state: 'working' },
      { type: 'error', sessionId: s, error: { code: 'internal', message: words, retryable: false, data: { reason: 'model_rejected', model: 'gpt-5.5' } } },
    ])
    await expect(page.locator('[data-testid="msg-mark"][data-mark="failed"]')).toHaveText(words)
    await expect(note.getByTestId('stop-note-words')).toHaveText('Stopped: error · pick another model')
    await expect.poll(buttons).toEqual(['Pick another model', 'Done'])
    await page.getByTestId('stop-note-pick-model').click()
    await expect(page.getByTestId('settings-menu')).toBeVisible()

    // Another failure after the person's next message is not a refusal: the plain note
    await page.keyboard.press('Escape')
    await emit(page, [
      { type: 'user_message', sessionId: s, seq: 50, text: 'try again' },
      { type: 'state_change', sessionId: s, state: 'working' },
      { type: 'error', sessionId: s, error: { code: 'internal', message: 'app-server exited (code 0)', retryable: true } },
    ])
    await expect(note.getByTestId('stop-note-words')).toHaveText('Stopped: error')
    await expect.poll(buttons).toEqual(['Done'])
  })

  test('the wait above the composer reads whole at a narrow window and a large text size, both buttons in full (#1415)', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 })
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    await page.evaluate(() => (document.documentElement.style.fontSize = '24px'))
    const at = new Date(2030, 0, 1, 1, 20).getTime()
    // The limit's wait, then the network's, the longest words a wait has
    for (const [interruption, words] of [
      [{ reason: 'limit', at: Date.now(), autoContinue: { at, tries: 0 } }, 'Usage limit · continues at Jan 1, 2030, 01:20'],
      [{ reason: 'network', at: Date.now(), autoContinue: { tries: 1 } }, 'Network lost · continues when the network is back'],
    ] as const) {
      await emit(page, [{ type: 'interruption', sessionId: s, interruption }])
      await expect(page.getByTestId('auto-continue-wait')).toHaveText(words)
      await expectWaitWhole(page)
    }
  })
}

/** The wait above the composer: its words not cut and inside the line, both buttons wholly in the window and pressable */
async function expectWaitWhole(page: Page) {
  const wait = page.getByTestId('auto-continue-wait')
  // Measured once the line has faded in
  await expect.poll(() => page.getByTestId('stop-note').evaluate((el) => el.getAnimations({ subtree: true }).every((x) => x.playState !== 'running'))).toBe(true)

  /*
   * The words are not cut: nothing overflows their box, and every line of them is drawn inside the line above the
   * composer. Not the window: at 360 px the sidebar and the pane's own minimum width put the pane's right edge past the
   * window, which is the app's layout and not this line's (#2362)
   */
  const words = await wait.evaluate((el) => {
    const note = el.closest('[data-testid="stop-note"]')!.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(el)
    const lines = [...range.getClientRects()]
    return {
      overflow: el.scrollWidth - el.clientWidth,
      inside: lines.length > 0 && lines.every((r) => r.left >= Math.max(0, note.left) && r.right <= note.right),
    }
  })
  expect(words).toEqual({ overflow: 0, inside: true })

  // Each button is wholly in the window, its label on one line and not cut, and a press at any corner reaches it
  for (const id of ['auto-continue-now', 'auto-continue-stop']) {
    const button = page.getByTestId(id)
    const seen = await button.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const inside = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
      const corners = [
        [r.left + 2, r.top + 2],
        [r.right - 2, r.top + 2],
        [r.left + 2, r.bottom - 2],
        [r.right - 2, r.bottom - 2],
      ]
      const reached = corners.every(([x, y]) => {
        const hit = document.elementFromPoint(x!, y!)
        return !!hit && (hit === el || el.contains(hit))
      })
      const label = document.createRange()
      label.selectNodeContents(el)
      const lines = new Set([...label.getClientRects()].map((l) => Math.round(l.top))).size
      return { inside, reached, overflow: el.scrollWidth - el.clientWidth, lines }
    })
    expect(seen, id).toEqual({ inside: true, reached: true, overflow: 0, lines: 1 })
  }
}

/** The header's limit badge keeps its gauge, and leaves the reset to the note while the note says a time (#1415) */
export function limitBadgeTests() {
  test("the header's limit badge drops its reset while the note says a time, and keeps it when the note says none", async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    const at = new Date(2030, 0, 1, 1, 20)
    await emit(page, [
      { type: 'state_change', sessionId: s, state: 'working' },
      { type: 'limit_reached', sessionId: s, usedPercent: 100, resumeAt: at.toISOString() },
    ])
    const badge = page.getByTestId('limit-badge')
    await expect(badge).toHaveText('Limit 100% · resets Jan 1, 2030, 01:20')
    await emit(page, [{ type: 'interruption', sessionId: s, interruption: { reason: 'limit', at: Date.now(), resetAt: at.getTime(), autoContinue: { at: at.getTime() + 60_000, tries: 0 } } }])
    await expect(page.getByTestId('auto-continue-wait')).toBeVisible()
    await expect(badge).toHaveText('Limit 100%')
    await page.getByTestId('auto-continue-stop').click()
    await expect(page.getByTestId('stop-note-words')).toHaveText('Stopped: usage limit · resets at Jan 1, 2030, 01:20')
    await expect(badge).toHaveText('Limit 100%')
    // A stop that says no time (an older host, which sends no reset): the badge keeps the reset, so it is said somewhere
    await emit(page, [{ type: 'interruption', sessionId: s, interruption: { reason: 'limit', at: Date.now() } }])
    await expect(page.getByTestId('stop-note-words')).toHaveText('Stopped: usage limit')
    await expect(badge).toHaveText('Limit 100% · resets Jan 1, 2030, 01:20')
  })

  test('"Limit reached" with no percentage leaves the header while the note says the limit stop (#2360)', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const s = await newSession(page, 'alpha')
    const at = new Date(2030, 0, 1, 1, 20)
    await emit(page, [
      { type: 'state_change', sessionId: s, state: 'working' },
      { type: 'limit_reached', sessionId: s, resumeAt: at.toISOString() },
    ])
    const badge = page.getByTestId('limit-badge')
    await expect(badge).toHaveText('Limit reached · resets Jan 1, 2030, 01:20')
    await emit(page, [{ type: 'interruption', sessionId: s, interruption: { reason: 'limit', at: Date.now(), resetAt: at.getTime() } }])
    await expect(page.getByTestId('stop-note-words')).toHaveText('Stopped: usage limit · resets at Jan 1, 2030, 01:20')
    await expect(badge).toHaveCount(0)
    // A note that says no time: the badge keeps the reset, so it is said somewhere
    await emit(page, [{ type: 'interruption', sessionId: s, interruption: { reason: 'limit', at: Date.now() } }])
    await expect(page.getByTestId('stop-note-words')).toHaveText('Stopped: usage limit')
    await expect(badge).toHaveText('Limit reached · resets Jan 1, 2030, 01:20')
  })
}
