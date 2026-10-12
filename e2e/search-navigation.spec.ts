import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * Search gives the stored sequence, not an offset in the loaded page. These scenarios put the
 * match before the ordinary newest page, so they fail if the palette only focuses the session.
 */
async function longSearchableSession(page: Page, needle = 'needle from the early conversation') {
  await setup(page, ['/tmp/alpha'])
  const target = await newSession(page, 'alpha')
  const other = await newSession(page, 'alpha')
  await page.evaluate(
    ({ target, needle }) => {
      const m = (window as any).__mock
      m.messages.set(
        target,
        Array.from({ length: 260 }, (_, i) => ({
          sessionId: target,
          seq: i + 1,
          role: 'assistant',
          kind: 'text',
          payload: { text: i === 39 ? needle : `conversation row ${i + 1}` },
          ts: i + 1,
        })),
      )
      m.searchResults = [{ sessionId: target, seq: 40, snippet: needle }]
    },
    { target, needle },
  )
  await page.getByTestId(`session-row-${other}`).click()
  return { target, other, needle }
}

async function openHit(page: Page, needle: string) {
  await page.getByTestId('search-button').click()
  await page.getByTestId('palette-input').fill('needle')
  await page.getByTestId('palette-item-message').click()
  await expect(page.getByTestId('command-palette')).toBeHidden()
  await expect(page.locator('[data-search-hit="true"]')).toContainText(needle)
}

async function expectLandedOnHit(page: Page, needle: string) {
  const hit = page.locator('[data-search-hit="true"]')
  await expect(hit).toBeInViewport()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stream = document.querySelector<HTMLElement>('[data-testid="chat-stream"]')!
        return stream.scrollHeight - stream.scrollTop - stream.clientHeight
      }),
    )
    .toBeGreaterThan(200)
  await expect(hit).toContainText(needle)
}

test('a search hit beyond the newest history page loads, highlights, and holds its message (#590)', async ({ page }) => {
  const { target, needle } = await longSearchableSession(page)
  await openHit(page, needle)
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(target)
  await expectLandedOnHit(page, needle)

  // An arriving line may remeasure the virtual list but cannot pull the reader to its end.
  await page.evaluate((sessionId) => (window as any).__mock.emit({ type: 'message_delta', sessionId, role: 'assistant', text: 'later line' }), target)
  await expectLandedOnHit(page, needle)
})

test('a search hit opens an asleep session without waking it (#590)', async ({ page }) => {
  const { target, needle } = await longSearchableSession(page)
  // Asleep on both sides, as control-loop does: the mock's record too, so a refetch on opening cannot bring it back live
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    m.sessions.get(sid).live = false
    store.setState({ sessions: { ...store.getState().sessions, [sid]: { ...store.getState().sessions[sid], live: false } } })
  }, target)

  await openHit(page, needle)
  expect(await page.evaluate(() => [...(window as any).__mock.resumeCalls])).toEqual([])
  await expect(page.getByTestId('dormant-note')).toContainText('Asleep')
  await expectLandedOnHit(page, needle)
})

test('a search hit repositions an already open session and clears only when it is scrolled (#590)', async ({ page }) => {
  const { target, needle } = await longSearchableSession(page)
  await page.getByTestId(`session-row-${target}`).click()
  await expect(page.getByTestId('chat-stream')).toBeVisible()

  await openHit(page, needle)
  await expectLandedOnHit(page, needle)

  await page.getByTestId('chat-stream').hover()
  await page.mouse.wheel(0, 240)
  await expect(page.locator('[data-search-hit="true"]')).toHaveCount(0)
})
