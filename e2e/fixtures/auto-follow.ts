import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * The conversation follows an answer down while it is at the bottom, and lets go the moment the
 * person scrolls up — and only then.
 *
 * A function, like `sidebarSelectionTests`, because it runs in Chromium (auto-follow.spec.ts) and
 * in WebKit (auto-follow-webkit.spec.ts). The desktop app is WKWebView, and the release nobody
 * asked for below only ever showed there.
 */

const stream = (page: Page) => page.getByTestId('chat-stream')
const distanceFromBottom = (page: Page) =>
  stream(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

/** Streams `count` answer paragraphs into the focused session, all in one go */
const burst = (page: Page, count: number, from = 0) =>
  page.evaluate(
    ({ count, from }) => {
      const m = (window as any).__mock
      const id = (window as any).__store.getState().focusedSessionId
      for (let i = from; i < from + count; i++)
        m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `answer line ${i}\n\n` })
    },
    { count, from },
  )

/** Waits until the list's height has stopped changing — every row measured, nothing left to follow */
async function settled(page: Page) {
  let last = -1
  await expect
    .poll(async () => {
      const height = await stream(page).evaluate((el) => el.scrollHeight)
      const steady = height === last
      last = height
      return steady
    })
    .toBe(true)
}

/** A session with an answer long enough to scroll, followed to its bottom */
async function streamingAtBottom(page: Page) {
  await setup(page, ['/tmp/alpha'])
  await newSession(page, 'alpha')
  await page.getByTestId('prompt-input').fill('task')
  await page.getByTestId('prompt-input').press('Enter')
  await burst(page, 60)
  await settled(page)
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(80)
}

/** Lets later answer lines land, then asserts the view stayed where the person left it */
async function staysPut(page: Page) {
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(80)
  // The scroll has to have come to rest before the baseline is taken (keyboard scrolling animates)
  await expect
    .poll(async () => {
      const now = await stream(page).evaluate((el) => el.scrollTop)
      await page.waitForTimeout(120)
      return (await stream(page).evaluate((el) => el.scrollTop)) === now
    })
    .toBe(true)
  const before = await stream(page).evaluate((el) => el.scrollTop)
  await burst(page, 20, 60)
  await expect(page.getByText('answer line 79')).toBeAttached()
  await page.waitForTimeout(300)
  expect(await stream(page).evaluate((el) => el.scrollTop)).toBe(before)
  expect(await distanceFromBottom(page)).toBeGreaterThan(80)
}

export function autoFollowTests(): void {
  test.describe('following the bottom of the conversation', () => {
    /*
     * The burst from "Scrolling pins the current turn's own message to the top" (control-loop):
     * two long questions, then a 60-paragraph answer emitted in one go. In WebKit the list let go
     * of the bottom on its own in about 1 run in 30 and stopped 914px short. The virtual
     * scroller's compensation for the answer row measuring 860px taller was written from a scroll
     * offset a frame stale — 54px up from where following had just put the view — and both the
     * landing loop and the scroll handler read that as the person scrolling up. Nobody touched the
     * list here, so nothing may let go.
     */
    test('a large answer landing in one burst is followed to its end — nobody touched the list', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')
      const input = page.getByTestId('prompt-input')
      await input.fill('first question\n' + 'content\n'.repeat(40))
      await page.getByTestId('send').click()
      await input.fill('second question\n' + 'content\n'.repeat(40))
      await page.getByTestId('send').click()
      await burst(page, 60)
      await page.evaluate(() => {
        const s = (window as any).__store.getState()
        ;(window as any).__mock.emit({ type: 'turn_complete', sessionId: s.focusedSessionId })
      })

      await settled(page)
      expect(await distanceFromBottom(page)).toBeLessThan(80)
      await expect(page.getByText('answer line 59')).toBeInViewport()
    })

    // The other half: what is the person's still lets go, whatever the fix above ignores
    test('a wheel up while an answer streams lets go, and later lines do not pull it back', async ({ page }) => {
      await streamingAtBottom(page)
      await stream(page).hover()
      await page.mouse.wheel(0, -600)
      await staysPut(page)
    })

    test('PageUp on the conversation lets go, and later lines do not pull it back', async ({ page }) => {
      await streamingAtBottom(page)
      // A click on the conversation's text puts the keyboard on it — the composer keeps PageUp otherwise
      await page.getByText('answer line 55', { exact: true }).click()
      await page.keyboard.press('PageUp')
      await page.keyboard.press('PageUp')
      await staysPut(page)
    })
  })
}
