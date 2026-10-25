import { test, expect, type Page } from '@playwright/test'
import { setup, newSession, injectApproval, emitEvent, watchAppearance } from './fixtures/control.js'

/**
 * The control loop's scenarios on unread marks and the finished notices: when they appear, call out, and clear. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 *
 * The cards that stood in the top right are gone (owner, 2026-10-18): a notice is kept in the store (`notices`), written
 * out in the inbox's capsule for 4 s (InboxPill, inbox-peek.spec.ts) and listed in the inbox. So these read the notices
 * the store keeps, and check that no card covers the page.
 */

async function sessionIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as any).__mock.sessions.values()].map((s: { id: string }) => s.id))
}

/** The sessions with a "finished" notice, in the order they were made */
const doneNotices = (page: Page) =>
  page.evaluate(() =>
    ((window as any).__store.getState().notices as { sessionId: string; kind: string }[])
      .filter((n) => n.kind === 'done')
      .map((n) => n.sessionId),
  )

test('Unread indicator and marking as read (T5-6, FR-16)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A task')
  await newSession(page, 'beta', 'B task') // Focus = beta

  /*
    The on-screen representation of unread is **the name's brightness alone** (the dot was
    removed — it was a third way of saying the same fact already told by the status ring and the
    name). The test checks the row's data-unread attribute, not a color class.
  */
  // New content in an unfocused session -> unread
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'Here are the results' })
  const sessionId = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...(m as any).sessions.values()][0].id
  })
  const row = page.getByTestId(`session-row-${sessionId}`)
  await expect(row).toHaveAttribute('data-unread', 'true')

  // Focusing marks it read (the 3-second rule)
  await row.click()
  await expect(row).not.toHaveAttribute('data-unread', 'true', { timeout: 8000 })

  /*
    **The row currently being watched is never drawn as unread in the first place.**

    Unread means "this moved while I was elsewhere", so attaching it to the conversation in front
    of the person is noise. And it really did happen — the read-marking timer was tied to the
    session object, so it never accumulated the 3 seconds while a turn was running (dogfooding
    finding: "the white dot while the session is running").

    What is being asked is "did it turn on even briefly", and a poll cannot answer that: the read
    timer clears the marker after 3 seconds, so a poll that comes late (a loaded machine) sees it
    off and passes, which is exactly what happened with the code before the actual fix. An
    observer installed before the events records every value the attribute takes.

    The new content has to be a new row. One more chunk of the message already streaming grows
    that row and carries its number, so it never makes anything unread to begin with (#845): a
    tool call closes the row, and the text after it starts another.
  */
  const seqOf = () => page.evaluate((id) => (window as any).__store.getState().sessions[id] as { lastSeq: number }, sessionId)
  const before = await seqOf()
  await row.evaluate((el) => {
    const w = window as any
    w.__unreadSeen = el.getAttribute('data-unread') === 'true'
    new MutationObserver(() => {
      if (el.getAttribute('data-unread') === 'true') w.__unreadSeen = true
    }).observe(el, { attributes: true, attributeFilter: ['data-unread'] })
  })
  await emitEvent(page, 0, { type: 'tool_call', callId: 'watch-1', summary: { tool: 'Read', title: 'Read: b.ts', paths: [] } })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'more came in while watching' })
  await expect(page.getByText('more came in while watching')).toBeVisible()
  // New rows, so the store did count something unread: only the screen keeps it off the row being watched
  expect((await seqOf()).lastSeq).toBeGreaterThan(before.lastSeq)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  expect(await page.evaluate(() => (window as any).__unreadSeen)).toBe(false)
  expect(await row.evaluate((el) => el.isConnected)).toBe(true)
})

/**
 * Whether the gust **ever appeared at all**, even once, from now on: install it before the cause.
 *
 * `toHaveCount(0)` cannot catch it — that auto-retries, so it passes as soon as the gust appears
 * and then disappears ("eventually 0", not "never appeared"). This gap actually let a test meant
 * to catch a trigger bug pass anyway. Polling for it for a while instead (it used to look every
 * 50ms for 900ms) passes on a machine slow enough that the gust comes after the polling stops.
 * Each check below first waits for what the same cause did draw (the card, the session it moved
 * to): the gust is decided in that same store update and drawn within a frame of it.
 */
const watchGust = (page: Page) => watchAppearance(page, 'gust')

/**
 * A gust that sweeps across the screen once a reply finishes.
 * Instead of writing "done" in text, the screen takes one breath.
 */
test('A gust blows once and disappears when the session being watched finishes', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await expect(page.getByTestId('gust')).toHaveCount(0)
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('gust')).toBeVisible()

  /*
   * Once it passes, it is removed from the DOM. Leaving it transparent would leave a
   * full-screen-covering element sitting there permanently — eventually it would obscure
   * something.
   */
  await expect(page.getByTestId('gust')).toHaveCount(0, { timeout: 3000 })
})

test("A gust does not blow when an off-screen session finishes — that is the notice's job", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // Watching this one
  const [first] = (await sessionIds(page)) as [string]

  // Session 0 (not being watched) finishes
  const blew = await watchGust(page)
  await emitEvent(page, 0, { type: 'turn_complete' })
  // A lingering signal arrives instead of a passing one — since it was not being watched, a
  // passing signal would be missed. It is written out in the capsule and covers nothing
  await expect.poll(() => doneNotices(page)).toEqual([first])
  await expect(page.getByTestId('inbox-peek')).toHaveText(/ finished$/)
  await expect(page.getByTestId('notice')).toHaveCount(0)
  expect(await blew()).toBe(false)
})

/*
 * A "Finished" notice stops being true when its session is given more work or goes away (#674).
 */

test('A finished notice goes away when that session starts another turn', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // Watching this one
  const [first] = (await sessionIds(page)) as [string]

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect.poll(() => doneNotices(page)).toEqual([first])

  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await expect.poll(() => doneNotices(page)).toEqual([])
})

test('A finished notice goes away when that session is deleted', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const [first] = (await sessionIds(page)) as [string]

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect.poll(() => doneNotices(page)).toEqual([first])

  await page.getByTestId(`session-menu-${first}`).click()
  // Finished, so idle: archived at once, with no question (#1512)
  await page.getByTestId(`delete-session-${first}`).click()
  await expect(page.getByTestId(`session-row-${first}`)).toBeHidden()

  await expect.poll(() => doneNotices(page)).toEqual([])
})

test("Another session's finished notice stays when this session starts working or is deleted", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  await newSession(page, 'alpha', 'third') // Watching this one
  const [first, second] = (await sessionIds(page)) as [string, string]

  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 1, { type: 'turn_complete' })
  await expect.poll(() => doneNotices(page)).toEqual([first, second])

  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await expect.poll(() => doneNotices(page)).toEqual([second])

  await page.getByTestId(`session-menu-${first}`).click()
  await page.getByTestId(`delete-session-${first}`).click()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${first}`)).toBeHidden()
  await expect.poll(() => doneNotices(page)).toEqual([second])
})

/*
 * The notice card — for someone who stepped away.
 *
 * An OS banner clears after a few seconds, so something that arrived while the person was away
 * would already be gone by the time they return. On macOS the banner path is even dead outright
 * (the plugin rides on NSUserNotification, deprecated since 2018). So this card is the real
 * mechanism, and persisting is the whole point.
 */
/*
 * Dogfooding report: "Now even the card does not show up."
 *
 * The judgment of "is it visible" **never looked at the app itself.** isOnScreen only checks
 * which session is displayed in the UI, so it stayed true even with the app behind another
 * window. So if the session being watched finished while the person was away, the gust blew in
 * an empty room and no card was ever created — in exactly the case a notification is needed
 * most, exactly nothing happened.
 */
test('When the app is in the background, the notice persists even if the session being watched finishes', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work') // Watching this session

  // Switch to another app
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))

  const blew = await watchGust(page)
  await emitEvent(page, 0, { type: 'turn_complete' })

  // Not the window being watched, so nobody sees the gust -> it must be a lingering signal
  const [work] = (await sessionIds(page)) as [string]
  await expect.poll(() => doneNotices(page)).toEqual([work])
  expect(await blew()).toBe(false)

  // Returning means it is being seen then: its line is written out, and once it folds (4 s) it is done with
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('inbox-peek')).toHaveText(/ finished$/)
  await expect.poll(() => doneNotices(page), { timeout: 15_000 }).toEqual([])
})

test('Finishing while away also calls out with a sound — it does not wait for everything to finish', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await emitEvent(page, 0, { type: 'turn_complete' })

  await expect
    .poll(() =>
      page.evaluate(() => (window as never as { __mock: { alerts: { kind: string }[] } }).__mock.alerts),
    )
    .toEqual([{ kind: 'done', sound: true }])
})

test('When it is right in front of the person, only the notice stays and no sound plays', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // Watching this one -> first is off-screen

  await emitEvent(page, 0, { type: 'turn_complete' })

  // Unseen, so the notice stays. But calling with a sound at someone right in front of it is just noise.
  // The notice and any sound are decided in the same handling of the event (store/events/notices.ts),
  // and the mock records an alert as it is asked for, so once the notice is kept the count is final.
  await expect.poll(async () => (await doneNotices(page)).length).toBe(1)
  expect(
    await page.evaluate(() => (window as never as { __mock: { alerts: unknown[] } }).__mock.alerts.length),
  ).toBe(0)
})

test('The notice of a session off screen does not disappear on its own over time', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const [first] = (await sessionIds(page)) as [string]

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect.poll(() => doneNotices(page)).toEqual([first])

  /*
   * It must outlast the capsule's 4 s line. A fixed wait measured the test's clock, not the page's: on a loaded machine
   * the page may have run far less of it, and the check passed without the time having passed there (#845). Two toasts
   * in a row, each cleared by the page's own 2.5 s timer, are 5 s the page did run.
   */
  for (let i = 0; i < 2; i++) {
    await page.evaluate((n) => (window as any).__store.getState().setToast(`time passing ${n}`), i)
    await expect(page.getByTestId('toast')).toBeVisible()
    await expect(page.getByTestId('toast')).toBeHidden({ timeout: 30_000 })
    expect(await doneNotices(page)).toEqual([first])
  }
})

test('The notice is done with once that session is being viewed and its line has folded', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const [first] = (await sessionIds(page)) as [string]

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect.poll(() => doneNotices(page)).toEqual([first])

  await page.evaluate((id) => (window as any).__store.getState().focusSession(id), first)
  await expect.poll(() => doneNotices(page), { timeout: 15_000 }).toEqual([])
})

test('The inbox opens a finished session, and no card stands over the page', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const [first] = (await sessionIds(page)) as [string]

  // An answer to read: the inbox lists a finished turn only while it is unread (#669)
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'all done here' })
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect.poll(() => doneNotices(page)).toEqual([first])
  await expect(page.getByTestId('notice')).toHaveCount(0)
  await expect(page.getByTestId('notices')).toHaveCount(0)

  await page.getByTestId('counter').click()
  await page.getByTestId(`inbox-item-${first}`).click()
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(first)
  // Having navigated there, there is no reason to keep calling out
  await expect.poll(() => doneNotices(page), { timeout: 15_000 }).toEqual([])
})

/*
 * If one busy session generates twenty cards, the rest get pushed off screen — so the more
 * cards there are, the less useful they become.
 */
/*
 * Sound and the dock badge **stand in where the banner has died.**
 *
 * The banner path (tauri-plugin-notification) returns a hardcoded permission state on desktop
 * and swallows delivery failures entirely, so the app has no way to know even if not a single
 * notification went out. So this test grabs the side that actually fires — if it ever goes
 * silent here, being away from the app goes dark again.
 */
test('A pending approval also calls out with sound and the dock badge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  // The notification policy says "do not notify if it is in front of the person" — since the test
  // window is always focused, this opens that condition
  await page.evaluate(() => {
    const st = (window as never as { __store: { getState(): Record<string, never> } }).__store.getState()
    const s = st as unknown as { notifyPolicy: Record<string, boolean>; setNotifyPolicy(p: unknown): void }
    s.setNotifyPolicy({ ...s.notifyPolicy, whenFocused: true, sound: true })
  })

  await injectApproval(page, 0, { tool: 'Bash', command: 'rm -rf /tmp/x' })

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as never as { __mock: { alerts: { kind: string; sound: boolean }[] } }).__mock.alerts,
      ),
    )
    .toEqual([{ kind: 'approval', sound: true }])
})

test('The same session finishing multiple times still produces only one notice', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const [first] = (await sessionIds(page)) as [string]

  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'turn_complete' })

  await expect.poll(() => doneNotices(page)).toEqual([first])
})

/*
 * Report: "it also blows just from switching session windows".
 *
 * It finished once earlier, and nothing finished again in between. Yet moving to that session
 * triggers a gust — the gust was wired to the value "is finished" rather than the event "just
 * finished".
 */
test('Moving to an already-finished session does not trigger a gust', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // Watching this one

  const blewAtFinish = await watchGust(page)
  await emitEvent(page, 0, { type: 'turn_complete' }) // The unseen one finishes
  await expect.poll(async () => (await doneNotices(page)).length).toBe(1)
  expect(await blewAtFinish()).toBe(false)

  // Move to that finished session — nothing new has finished
  const blew = await watchGust(page)
  const moved = await page.evaluate(() => {
    const store = (window as never as { __store: { getState(): Record<string, never> } }).__store
    const st = store.getState() as unknown as {
      sessions: Record<string, { id: string }>
      focusedSessionId: string
      focusSession(id: string): void
    }
    // The session that finished earlier = the one not currently being watched
    const target = Object.values(st.sessions).find((x) => x.id !== st.focusedSessionId)!.id
    st.focusSession(target)
    const after = (store.getState() as unknown as { focusedSessionId: string }).focusedSessionId
    return { target, after }
  })
  // **Confirm the move happened first** — if it never moved, "no gust" proves nothing
  expect(moved.after).toBe(moved.target)
  // ...and that the screen shows it, which is the render a gust tied to "is finished" would come with
  await expect(page.getByTestId('chat-stream')).toContainText('first')

  expect(await blew()).toBe(false)
})

/*
 * And from one completion, it used to blow again and again — blowing anew every time the person
 * moved away and back.
 */
test('Moving away and back does not make a past completion blow again', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 1, { type: 'turn_complete' }) // The one being watched finishes — blowing once here is correct
  await expect(page.getByTestId('gust')).toBeVisible()
  await expect(page.getByTestId('gust')).toHaveCount(0, { timeout: 3000 })

  const swap = (i: number) =>
    page.evaluate((idx) => {
      const st = (window as never as { __store: { getState(): Record<string, never> } }).__store.getState()
      const list = Object.values(st.sessions as unknown as Record<string, { id: string }>)
      ;(st as unknown as { focusSession(id: string): void }).focusSession(list[idx]!.id)
    }, i)

  let blew = await watchGust(page)
  await swap(0)
  await expect(page.getByTestId('chat-stream')).toContainText('first')
  expect(await blew()).toBe(false)
  blew = await watchGust(page)
  await swap(1) // Back again. Nothing finished in between.
  await expect(page.getByTestId('chat-stream')).toContainText('second')
  expect(await blew()).toBe(false)
})
