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

test('a sleeping session says so quietly, is not woken by selecting it, and wakes when its composer takes the keyboard', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const first = await newSession(page, 'alpha')
  const second = await newSession(page, 'alpha')
  await asleep(page, first)

  // The sidebar's mark fades and its tooltip names it; the second session is untouched
  const mark = page.getByTestId(`session-row-${first}`).locator('[data-asleep]')
  await expect(mark).toHaveAttribute('title', /asleep/)
  await expect(page.getByTestId(`session-row-${second}`).locator('[data-asleep]')).toHaveCount(0)

  // Selecting it shows it, asleep, and starts nothing
  await page.getByTestId(`session-row-${first}`).click()
  await expect(page.getByTestId('dormant-note')).toHaveText('Asleep — it wakes when you type to it')
  await page.getByTestId(`session-row-${second}`).click()
  await page.getByTestId(`session-row-${first}`).click()
  await expect(page.getByTestId('dormant-note')).toBeVisible()
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

test('a message to a sleeping session reads as waking, then goes through', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  // The composer has the keyboard (#528); the host puts the session to sleep while it does
  await asleep(page, id)
  await expect(page.getByTestId('dormant-note')).toHaveText('Asleep — it wakes when you type to it')
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
