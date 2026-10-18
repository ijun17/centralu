import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * Idle sessions put to sleep by the host (#568), on the mock platform: the host's `session_live` event is what the
 * mock sends, the way the host does when it ends an idle session's process. What the screen owes the person: the asleep
 * state said quietly, no wake for looking at a session, a wake when they type to it, and a short "waking" while it
 * starts.
 */

const asleep = (page: Page, sessionId: string) =>
  page.evaluate((id) => (window as any).__mock.emit({ type: 'session_live', sessionId: id, live: false, reason: 'asleep' }), sessionId)
const resumeCalls = (page: Page) => page.evaluate(() => [...(window as any).__mock.resumeCalls] as string[])

/*
 * Sleep is not shown (owner, 2026-10-18): it needs nothing from the person and typing wakes it, so neither the mark, its
 * tooltip nor a line under the conversation says it. What is said is that a session is waking, and why it could not.
 */
test('a sleeping session says nothing, is not woken by selecting it, and wakes when its composer takes the keyboard', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const first = await newSession(page, 'alpha')
  const second = await newSession(page, 'alpha')
  await asleep(page, first)

  // The sidebar's mark keeps its look and its tooltip does not name sleep (the hook stays for tests); the second is untouched
  const mark = page.getByTestId(`session-row-${first}`).locator('[data-asleep]')
  await mark.hover()
  await expect(page.getByTestId('tool-mark-tip-claude')).toBeVisible()
  await expect(page.getByTestId('tool-mark-tip-claude')).not.toContainText('asleep')
  await expect(page.getByTestId(`session-row-${second}`).locator('[data-asleep]')).toHaveCount(0)

  // Selecting it shows it, with no line about sleep, and starts nothing
  await page.getByTestId(`session-row-${first}`).click()
  await expect(page.getByTestId('chat-stream')).toBeVisible()
  await expect(page.getByTestId('dormant-note')).toHaveCount(0)
  await page.getByTestId(`session-row-${second}`).click()
  await page.getByTestId(`session-row-${first}`).click()
  await expect(page.getByTestId('dormant-note')).toHaveCount(0)
  expect(await resumeCalls(page)).toEqual([])

  // The composer taking the keyboard wakes it; the line says so while it starts
  await page.evaluate(() => ((window as any).__mock.wakeDelayMs = 1500))
  await page.getByTestId('prompt-input').click()
  await expect(page.getByTestId('dormant-note')).toHaveText('Waking session…')
  await expect(page.getByTestId('dormant-note')).toBeHidden()
  await expect(mark).toHaveCount(0)
  expect(await resumeCalls(page)).toEqual([first])

  // Keys typed meanwhile went into the composer, as they would on any session
  await page.keyboard.type('next step')
  await expect(page.getByTestId('prompt-input')).toHaveValue('next step')
})

// What the mark looks like, as the browser computes it: its look (#736), the ring and the chip's fill and opacity
const markEl = (page: Page, sessionId: string) => page.getByTestId(`session-row-${sessionId}`).getByTestId('tool-mark-claude')
const look = async (page: Page, sessionId: string) => {
  const mark = markEl(page, sessionId)
  return {
    look: await mark.getAttribute('data-look'),
    ...(await mark.evaluate((n) => {
      const ring = getComputedStyle(n)
      const chip = getComputedStyle(n.querySelector('span')!)
      return { ring: `${ring.backgroundColor} ${ring.borderTopStyle} ${ring.borderTopWidth}`, fill: chip.backgroundColor, opacity: chip.opacity }
    })),
  }
}
// Through the legal path (idle → working → the state), as the state machine only follows those
const setState = (page: Page, sessionId: string, state: string) =>
  page.evaluate(
    ([id, st]) => {
      const mock = (window as any).__mock
      if (st !== 'error') mock.emit({ type: 'state_change', sessionId: id, state: 'working' })
      mock.emit({ type: 'state_change', sessionId: id, state: st })
    },
    [sessionId, state],
  )

test('an asleep mark looks exactly like the same session awake, its tooltip too, and an error still stands out (#670)', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const awake = await newSession(page, 'alpha')
  const sleeper = await newSession(page, 'alpha')
  const failed = await newSession(page, 'alpha')
  for (const id of [awake, sleeper]) await setState(page, id, 'waiting_input')
  await setState(page, failed, 'error')
  const markOf = (id: string) => page.getByTestId(`session-row-${id}`).getByTestId('tool-mark-claude')
  await expect(markOf(awake)).toHaveAttribute('data-state', 'waiting_input')
  await expect(markOf(sleeper)).toHaveAttribute('data-state', 'waiting_input')
  await expect(markOf(failed)).toHaveAttribute('data-state', 'error')
  await asleep(page, sleeper)
  await asleep(page, failed)
  await expect(page.getByTestId(`session-row-${sleeper}`).locator('[data-asleep]')).toHaveCount(1)

  // A finished turn looks like a finished turn, asleep or not
  expect(await look(page, sleeper)).toEqual(await look(page, awake))
  expect((await look(page, sleeper)).opacity).toBe('1')
  await expect(markOf(sleeper)).toHaveAttribute('data-state', 'waiting_input')

  // An error keeps its own look (stopped: a dashed ring on a grey chip), asleep or awake
  expect((await look(page, failed)).look).toBe('stopped')
  expect(await look(page, failed)).not.toEqual(await look(page, sleeper))

  // Not even the tooltip says it (owner, 2026-10-18): it reads as the same session awake
  await markOf(awake).hover()
  const awakeTip = (await page.getByTestId('tool-mark-tip-claude').textContent())!
  await page.mouse.move(0, 0)
  await markOf(sleeper).hover()
  await expect(page.getByTestId('tool-mark-tip-claude')).toHaveText(awakeTip)
  expect(awakeTip).not.toContain('asleep')
})

test('a message to a sleeping session reads as waking, then goes through', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  // The composer has the keyboard (#528); the host puts the session to sleep while it does
  await asleep(page, id)
  await expect(page.getByTestId(`session-row-${id}`).locator('[data-asleep]')).toHaveCount(1)
  await expect(page.getByTestId('dormant-note')).toHaveCount(0)
  await page.evaluate(() => ((window as any).__mock.wakeDelayMs = 1500))
  // The first key wakes it: the composer kept the keyboard while it fell asleep
  await page.keyboard.type('are you there?')
  await expect(page.getByTestId('dormant-note')).toHaveText('Waking session…')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('chat-stream')).toContainText('are you there?')
  await expect(page.getByTestId('dormant-note')).toBeHidden()
  expect(await resumeCalls(page)).toEqual([id])
})

test('a session kept awake by a /loop wake-up says why on its background mark', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  // What the Claude adapter reports for a pending ScheduleWakeup (normalize.ts, ClaudeSchedules)
  await page.evaluate(
    (sid) =>
      (window as any).__mock.emit({
        type: 'background_tasks',
        sessionId: sid,
        live: [{ id: 'schedule-wakeup-w1', kind: 'other', description: 'Wakes itself at 14:05 (/loop): poll CI', stoppable: false, status: 'running' }],
      }),
    id,
  )
  const mark = page.getByTestId(`background-mark-${id}`)
  await expect(mark).toHaveText('1 bg')
  await expect(mark).toHaveAttribute('title', /stays awake until it ends\n· Wakes itself at 14:05 \(\/loop\): poll CI/)
})

test('"Put idle sessions to sleep after" is 15 minutes by default, and saves through the host', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-background').click()
  const select = page.getByTestId('settings-sleep-after')
  await expect(select).toHaveValue('15')
  await expect(page.getByTestId('settings-sleep')).toContainText('wakes when you type to it')
  await select.selectOption('60')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.sleepPolicy.afterMinutes)).toBe(60)
  await select.selectOption('never')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.sleepPolicy.afterMinutes)).toBeNull()

  // Read back from the host, not from the control's own memory
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-background').click()
  await expect(page.getByTestId('settings-sleep-after')).toHaveValue('never')
})
