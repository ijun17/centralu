import { test, expect, type Page } from '@playwright/test'
import { setup, newSession, injectApproval, emitEvent } from './fixtures/control.js'

/**
 * The control loop's scenarios on approvals and the waiting list: answering cards, the top-bar count, the inbox and its keys. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * The session finishes a turn with an answer the person has not read: text, then the end of the turn.
 * The inbox lists a finished turn only while it is unread (#669), and a bare `turn_complete` carries nothing to read.
 */
async function finishTurnUnread(page: Page, sessionIdx: number) {
  await emitEvent(page, sessionIdx, { type: 'message_delta', role: 'assistant', text: 'done, over to you' })
  await emitEvent(page, sessionIdx, { type: 'turn_complete' })
}

test('Approval: pressing y on the card approves it (T5-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })

  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-detail')).toContainText('npm run build')
  await page.locator('body').click() // Move focus outside the composer
  await page.keyboard.press('y')
  await expect(page.getByTestId('approval-card')).toBeHidden()
})

test('Approval: "always allow" states its scope (T5-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await injectApproval(page, 0, { kind: 'command', command: 'npm test --watch', cwd: '/tmp/alpha' })
  await page.getByTestId('approve-always').click()
  await expect(page.getByTestId('toast')).toContainText('this session')
  // The suggestion is exactly the approved command — the old 'npm test*'-style expansion
  // dangerously widened the approval scope for commands like rm -rf (guarded by the core
  // suggestMatcher regression test)
  await expect(page.getByTestId('toast')).toContainText('npm test --watch')
})

/**
 * An approval from another session is answered **on that session's own card** (requested by the
 * person, 2026-09-10).
 *
 * There used to be a banner at the top of the window — a place to approve a request from an
 * unfocused session right there. Every time it appeared or disappeared, **the whole screen
 * shifted** (layout shift), moving the line being read and the button about to be clicked. Now
 * that the banner is gone, there is one path: the inbox. The count announces it, clicking lands
 * on that session, and the card is where the person answers.
 */
test('An approval from another session is answered on that session card via the inbox', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A task')
  await newSession(page, 'beta', 'B task') // Focus is on beta

  await injectApproval(page, 0, { kind: 'command', command: 'ls -la', cwd: '/tmp/alpha' })

  // No banner interrupts at the top of the screen — instead the dashboard's count goes up
  await expect(page.getByTestId('approval-banner')).toHaveCount(0)
  await page.getByTestId('counter').click()
  await page.locator('[data-testid^="inbox-item-"]').first().click()

  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-detail')).toContainText('ls -la')
  await page.getByTestId('approve-allow').click()
  await expect(page.getByTestId('approval-card')).toBeHidden()
})

/**
 * The list appears **directly below where the person clicked** (requested by the person,
 * 2026-09-09). While it was a centered modal, the single action of seeing the count and opening
 * the list made the eyes move twice.
 */
test('The waiting list drops down below the top-bar count', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A')
  await emitEvent(page, 0, { type: 'turn_complete' })

  await page.getByTestId('counter').click()
  const panel = page.getByTestId('inbox')
  await expect(panel).toBeVisible()

  /*
   * Measure only after the drop-down animation (cc-drop) finishes — measuring mid-animation
   * still catches it hanging over the button. poll() waits it out (a rule set after measuring:
   * the starting position really was over the button).
   */
  const gap = async () => {
    const c = (await page.getByTestId('counter').boundingBox())!
    const d = (await panel.boundingBox())!
    return { below: Math.round(d.y - (c.y + c.height)), dx: Math.round(Math.abs(d.x - c.x)) }
  }
  await expect.poll(async () => (await gap()).below).toBeGreaterThanOrEqual(0)
  const g = await gap()
  expect(g.below).toBeLessThan(24) // It is adjacent (not a modal off in the distance)
  expect(g.dx).toBeLessThan(24) // The left edge lines up with the button
})

/**
 * The dashboard has a single count (requested by the person, 2026-09-09 — FR-12's separate
 * counts were dropped). The kind is told by each row in the list, and the top bar conveys
 * **urgency through brightness**.
 */
test('The global counter counts everything waiting as one, and brightness signals urgency', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A')
  await newSession(page, 'alpha', 'B')

  await injectApproval(page, 0, { kind: 'command', command: 'x', cwd: '/tmp' })
  await finishTurnUnread(page, 1)

  const count = page.getByTestId('count-waiting')
  await expect(count).toContainText('02')
  // Pure white if even one approval is pending — pure white is reserved for what is blocking the person
  await expect(count).toHaveClass(/(^|\s)signal(\s|$)/)
})

test('Control loop: clearing five waiting items using only the keyboard (T5-5 core scenario)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  for (const [proj, name] of [
    ['alpha', 'A1'],
    ['alpha', 'A2'],
    ['alpha', 'A3'],
    ['beta', 'B1'],
    ['beta', 'B2'],
  ] as const) {
    await newSession(page, proj, name)
  }

  // 2 approvals + 3 replies waiting
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })
  await injectApproval(page, 3, { kind: 'command', command: 'pytest', cwd: '/tmp/beta' })
  for (const idx of [1, 2, 4]) await finishTurnUnread(page, idx)

  await expect(page.getByTestId('count-waiting')).toContainText('05')

  // Open the inbox — it must be sorted by urgency
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  const rows = page.locator('[data-testid^="inbox-item-"]')
  await expect(rows).toHaveCount(5)
  await expect(rows.first()).toContainText('Needs approval')

  // Handle the 2 approvals (jump with Enter -> y)
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await page.locator('body').click()
    await page.keyboard.press('y')
    await expect(page.getByTestId('approval-card')).toBeHidden()
    await page.keyboard.press('Meta+i')
  }
  /*
   * Once every approval is handled, **the pure white goes away** — meaning whatever was blocking
   * the person is gone. The exact count is not pinned down here: if an approved session
   * immediately starts waiting for the next reply, it gets counted again, and that is not the
   * fact this test is checking (whether anything urgent remains).
   */
  await expect(page.getByTestId('count-waiting')).not.toHaveClass(/(^|\s)signal(\s|$)/)

  /*
    Clear the remaining 3 items waiting for a reply by **actually replying**.
    There used to be a single `d` key that cleared them, but that archived the session with no
    way back, so to the person it looked like deletion (dropped 2026-09-02). The inbox is a view
    over state, so the only way to clear it is to change the state — which means replying.
  */
  for (let i = 0; i < 5; i++) {
    const remaining = await page.locator('[data-testid^="inbox-item-"]').count()
    if (remaining === 0) break
    await page.keyboard.press('Enter')
    await page.getByTestId('prompt-input').fill('keep going')
    await page.getByTestId('prompt-input').press('Enter')
    await page.keyboard.press('Meta+i')
  }
  await expect(page.getByTestId('inbox-empty')).toContainText('Nothing waiting')
})

test('The "jump to next waiting" shortcut cycles through approvals first (T5-5, FR-17)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Awaiting-reply session')
  await newSession(page, 'alpha', 'Awaiting-approval session')
  await emitEvent(page, 0, { type: 'turn_complete' })
  await injectApproval(page, 1, { kind: 'command', command: 'x', cwd: '/tmp' })

  // Even starting from the reply-waiting session, cycling follows urgency order (approvals first)
  const firstId = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...(m as any).sessions.values()][0].id
  })
  await page.getByTestId(`session-row-${firstId}`).click()
  await expect(page.getByTestId('session-name')).toContainText('Awaiting-reply session')

  await page.locator('body').click()
  await page.keyboard.press('Meta+Shift+a')
  await expect(page.getByTestId('session-name')).toContainText('Awaiting-approval session')
})

test('The inbox shortcut works right after sending a message (regression: the composer was swallowing the key)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task one')
  await newSession(page, 'alpha', 'task two')
  for (const idx of [0, 1]) await finishTurnUnread(page, idx)

  // Actual usage order: after sending a message, focus stays in the composer. Do not click body.
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(2)

  // The cursor-movement key must not get typed into the composer
  await page.keyboard.press('j')
  await expect(page.getByTestId('prompt-input')).toHaveValue('')

  /*
    And `d` must not archive the session. It used to, and the screen read "Dismiss" — a key pressed to
    mean "I am not answering right now" permanently removed the session from the app. An irreversible
    action must not hide behind a single letter. Now `d` is Done (#669): it marks the row under the cursor
    read, which takes it off this list and nothing more. Both sessions are still there, and nothing typed.
  */
  await page.keyboard.press('d')
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(1)
  await expect(page.getByTestId('prompt-input')).toHaveValue('')
  expect(await page.evaluate(() => Object.keys((window as any).__store.getState().sessions).length)).toBe(2)
})

test('Scrubbing up and down through 10 inbox items never pushes the cursor out of the list (L4-3 repeated operation)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  for (let i = 0; i < 10; i++) await newSession(page, 'alpha', `task ${i}`)
  await page.evaluate(() => {
    const m = (window as any).__mock
    for (const id of m.sessions.keys()) {
      m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'done, over to you' })
      m.emit({ type: 'turn_complete', sessionId: id })
    }
  })

  await page.keyboard.press('Meta+i')
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(10)

  /*
    Go all the way down and back up using only the keyboard. If the cursor ever points outside
    the list, Enter opens no session, and at that moment the inbox becomes a window that does not
    respond to input.
    (This used to be checked by deleting items with `d` — that key archived the session, and
    archiving has since been dropped. What the cursor must uphold has not changed.)
  */
  for (let i = 0; i < 15; i++) await page.keyboard.press('j')
  for (let i = 0; i < 15; i++) await page.keyboard.press('k')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('inbox')).toBeHidden()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

/**
 * The top bar is a dashboard — it states status, not instructions (issue #33).
 *
 * The ⌘I/⌘⇧A chips used to sit next to the waiting count and light up under **the same
 * condition** as the count. That meant that at the one moment the bar has something to say —
 * something is waiting on the person — two out of the three things that lit up said "press this
 * key".
 *
 * Only the **display** was removed, so both sides are checked together: the count alone still
 * carries the signal, the keys still work, and their name and key can be found in the palette —
 * removing the only visible mention of them would have been the failure to avoid.
 */
test('Top bar: the count is the signal, not a shortcut chip (#33)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A')
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })

  // Even with something waiting, the bar does not advertise a key — this used to be exactly when
  // the chip was brightest
  const bar = page.getByTestId('app-header')
  await expect(bar).toContainText('Waiting for input')
  await expect(bar).not.toContainText('Next item')
  await expect(bar).not.toContainText('List')

  // Lighting up remains the count's job (an approval waiting = pure white)
  await expect(page.getByTestId('count-waiting')).toContainText('01')
  await expect(page.getByTestId('count-waiting')).toHaveClass(/(^|\s)signal(\s|$)/)

  /*
   * The glow belongs to the number alone (pointed out by the person, 2026-09-12). Because
   * `signal`'s text-shadow is inherited, the label — which only overrides color — was wearing a
   * white halo on its dark text as well. Instead of looking luminous, it just looked out of
   * focus.
   */
  const halo = await page.getByTestId('count-waiting').evaluate((el) => ({
    label: getComputedStyle(el.firstElementChild!).textShadow,
    value: getComputedStyle(el.lastElementChild!).textShadow,
  }))
  expect(halo.label).toBe('none')
  expect(halo.value).not.toBe('none')

  // The keys themselves still work (FR-17 was left untouched)
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inbox')).toBeHidden()

  // The palette states the name and the key
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('waiting')
  const actions = page.getByTestId('palette-item-action')
  await expect(actions.filter({ hasText: 'Waiting list' })).toContainText('⌘I')
  await expect(actions.filter({ hasText: 'Jump to next waiting' })).toContainText('⌘⇧A')

  // Someone who does not know the key can run it right from here
  await actions.filter({ hasText: 'Waiting list' }).click()
  await expect(page.getByTestId('inbox')).toBeVisible()
})
