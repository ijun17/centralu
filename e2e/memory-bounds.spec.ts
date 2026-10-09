import { expect, test } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * What the window holds for rows it no longer shows (#392).
 *
 * The focus view draws every session through one conversation pane, and its virtual scroller
 * keeps a measured height per row key with no path that removes one. Before the pane pruned it,
 * reading through a long session and moving on left every one of those heights behind, for as
 * long as the window stayed open.
 */
test('The conversation keeps row heights only for the rows of the session it shows (#392)', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const long = await newSession(page, 'alpha')
  await page.evaluate((sid) => {
    const store = (window as any).__store
    const chat = Array.from({ length: 200 }, (_, i) => ({
      kind: 'assistant',
      seq: 1000 + i,
      storedSeq: 1000 + i,
      text: `passage ${i + 1}. ` + 'The status of the run is summarised here. '.repeat(2 + (i % 5)),
    }))
    store.setState({
      chat: { ...store.getState().chat, [sid]: chat },
      history: { ...store.getState().history, [sid]: { oldestSeq: 1000, more: false, loading: false } },
    })
  }, long)
  const stream = page.getByTestId('chat-stream')
  await expect(stream).toContainText('passage 200.')
  // Read it end to end, the way a person does, so the scroller measures the rows it passes
  for (let step = 30; step >= 0; step--) {
    await stream.evaluate(async (el, f) => {
      el.scrollTo({ top: el.scrollHeight * f })
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    }, step / 30)
  }
  const sized = () => stream.locator('[data-sized-rows]').getAttribute('data-sized-rows').then(Number)
  await expect.poll(sized).toBeGreaterThan(100)

  const short = await newSession(page, 'alpha')
  expect(short).not.toBe(long)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    const chat = [1, 2, 3].map((seq) => ({ kind: 'assistant', seq, storedSeq: seq, text: `short ${seq}.` }))
    store.setState({
      chat: { ...store.getState().chat, [sid]: chat },
      history: { ...store.getState().history, [sid]: { oldestSeq: 1, more: false, loading: false } },
    })
  }, short)
  await expect(stream).toContainText('short 3.')
  await expect.poll(sized).toBeLessThanOrEqual(3)
})
