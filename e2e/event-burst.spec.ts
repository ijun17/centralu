import { test, expect } from '@playwright/test'
import { newSession, setup } from './fixtures/control.js'

/**
 * A burst of streamed events that reaches the page with no task between them (#2059). A WebSocket hands the frames it
 * has read over in one task, a microtask checkpoint after each (measured in WebKit and Chromium: 299 of 299 gaps with no
 * task in between), as it does a recorded Codex answer of one line per delta, or the events a reconnect replays
 * (`afterSeq`). Each event is a store update, so each is a commit; the update a chat effect schedules after a commit waits
 * for a task of its own, and React counts every commit that leaves one waiting as a nested update. The 51st throws
 * "Maximum update depth exceeded" from the store's next update, the throw goes to the host connection's `deliver`, and
 * what follows the update in `conversationEvent` is skipped.
 */
test('a burst of events with no task between them is all drawn, and the turn ends', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await newSession(page, 'alpha', 'count up')

  await page.evaluate(async (sid: string) => {
    const mock = (window as any).__mock
    mock.emit({ type: 'state_change', sessionId: sid, state: 'working' })
    // One event per microtask: nothing else runs until the last one is in, as when the socket delivers them in one go
    let chain: Promise<void> = Promise.resolve()
    for (let i = 1; i <= 300; i++) {
      chain = chain.then(() => mock.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: `${i}\n`, messageId: `m${i}` }))
    }
    await chain.then(() => mock.emit({ type: 'turn_complete', sessionId: sid }))
  }, id)

  await expect(page.getByTestId('msg-assistant').last()).toHaveText('300')
  await expect(page.getByTestId('activity-row')).toHaveCount(0)
  // The prompt scrolled off the top during the burst, so the pinned copy had to set a new index in the middle of it
  await expect(page.getByTestId('sticky-user')).toBeVisible()
  expect(errors.filter((e) => /Maximum update depth|subscriber of the host connection threw/.test(e))).toEqual([])
})
