import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * The inbox's capsule writes a new notice out (owner, 2026-10-18; features/inbox/InboxPill.tsx): the cards that stood
 * in the top right are gone, and a turn that finished, an approval or an error is one line that grows out of the
 * capsule for 5 s (PEEK_MS; 4 s until 2026-10-20) and folds back into the count. A finished turn on screen is judged seen when that line
 * folds (features/notices/Notices.tsx); one that arrives while the window is behind waits until the person is back.
 *
 * The page's clock is held, so "5 s" is read off the clock the app reads, not off a machine under load.
 */

const peek = (page: Page) => page.getByTestId('inbox-peek')
const notices = (page: Page) =>
  page.evaluate(() => ((window as any).__store.getState().notices as { sessionId: string; kind: string }[]).map((n) => `${n.sessionId}:${n.kind}`))
const nameOf = (page: Page, id: string) => page.evaluate((s) => (window as any).__store.getState().sessions[s].name as string, id)

async function finish(page: Page, id: string) {
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: 'done' })
    m.emit({ type: 'turn_complete', sessionId: sid })
  }, id)
}

/** Two sessions in alpha, the second on screen; the page's clock held from here on */
async function twoSessions(page: Page): Promise<{ away: string; shown: string }> {
  await page.clock.install()
  await setup(page, ['/tmp/alpha'])
  const away = await newSession(page, 'alpha')
  const shown = await newSession(page, 'alpha')
  await page.evaluate(() => (window as any).__store.setState({ appFocused: true }))
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000)
  return { away, shown }
}

test('a turn that finished is written out in the capsule for 5 s, then folds back into the count', async ({ page }) => {
  const { away } = await twoSessions(page)
  await expect(peek(page)).not.toHaveAttribute('data-open')

  await finish(page, away)
  // The line grows on the next frame
  await page.clock.runFor(50)
  await expect(peek(page)).toHaveAttribute('data-open', 'true')
  await expect(peek(page)).toHaveText(`${await nameOf(page, away)} finished`)
  await expect(page.getByTestId('notice')).toHaveCount(0)
  await expect(page.getByTestId('notices')).toHaveCount(0)

  // Still there just before 5 s, folded just after
  await page.clock.runFor(4_850)
  await expect(peek(page)).toHaveAttribute('data-open', 'true')
  await page.clock.runFor(200)
  await expect(peek(page)).not.toHaveAttribute('data-open')
  // Off screen, the notice stays in the inbox after its line has folded
  expect(await notices(page)).toEqual([`${away}:done`])
})

test('a turn that finished on screen is told too, and done with once its line has folded', async ({ page }) => {
  const { shown } = await twoSessions(page)
  await finish(page, shown)
  await page.clock.runFor(50)
  await expect(peek(page)).toHaveText(`${await nameOf(page, shown)} finished`)
  expect(await notices(page)).toEqual([`${shown}:done`])

  await page.clock.runFor(5_200)
  await expect(peek(page)).not.toHaveAttribute('data-open')
  await expect.poll(() => notices(page)).toEqual([])
})

test('a notice that arrived while the window was behind is written out when the person comes back, with how many more', async ({ page }) => {
  const { away, shown } = await twoSessions(page)
  await page.evaluate(() => (window as any).__store.setState({ appFocused: false }))
  await finish(page, away)
  await page.clock.runFor(100)
  await finish(page, shown)
  await page.clock.runFor(5_000)
  // Nothing grew behind the window, where nobody could see it fold
  await expect(peek(page)).not.toHaveAttribute('data-open')

  await page.evaluate(() => (window as any).__store.setState({ appFocused: true }))
  await page.clock.runFor(50)
  await expect(peek(page)).toHaveAttribute('data-open', 'true')
  await expect(peek(page)).toHaveText(`${await nameOf(page, shown)} finished · 1 more`)
  await page.clock.runFor(5_200)
  await expect(peek(page)).not.toHaveAttribute('data-open')
})
