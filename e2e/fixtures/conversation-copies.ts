import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * The conversation shows each row once, however its rows are keyed (#64).
 *
 * The report: one passage of a reply shown four times, and selecting and copying the region gave
 * it back four times — copies in the DOM, not in paint, while storage held the passage once. The
 * mechanism was two rows of the list sharing a render key: React builds one DOM node per key, and
 * when two rows share one, the older node is neither reused nor removed as the virtual list
 * mounts and unmounts rows while scrolling. Each pass leaves another copy behind.
 *
 * Earlier probes found no copies because they only looked at the moment of the collision (one
 * row went missing) and never scrolled through it. This scenario scrolls the list end to end and
 * back, which is what a person reading the conversation does.
 *
 * A function, like `autoFollowTests`, because it runs in Chromium (conversation-copies.spec.ts)
 * and in WebKit (conversation-copies-webkit.spec.ts): the desktop app is WKWebView.
 */
export function conversationCopiesTests() {
  test('Two rows sharing a render key still leave each passage in the conversation once, after scrolling through (#64)', async ({
    page,
  }) => {
    await setup(page, ['/tmp/alpha'])
    const id = await newSession(page, 'alpha')
    /*
     * The store is meant never to hand the list two rows under one key (`rekeyAgainst`); the
     * reported session had them because a live row's key once equalled a stored row's number.
     * The list must not depend on that, so the collision is put in directly.
     */
    await page.evaluate((sid) => {
      const store = (window as any).__store
      const chat = Array.from({ length: 200 }, (_, i) => ({
        kind: 'assistant',
        seq: i + 1,
        storedSeq: i + 1,
        text: `passage ${i + 1}. ` + 'The status of the run is summarised here. '.repeat(4 + (i % 7) * 3),
      }))
      chat[150] = { ...chat[150]!, seq: 160 }
      store.setState({
        chat: { ...store.getState().chat, [sid]: chat },
        history: { ...store.getState().history, [sid]: { oldestSeq: 1, more: false, loading: false } },
      })
    }, id)
    await expect(page.getByTestId('chat-stream')).toContainText('passage 200.')

    const repeated = (page: Page) =>
      page.evaluate(() => {
        const heads = [...document.querySelectorAll('[data-testid="chat-stream"] [data-index]')].map(
          (row) => ((row as HTMLElement).innerText.match(/passage \d+\./) ?? [''])[0],
        )
        return heads.filter((h, i) => h && heads.indexOf(h) !== i)
      })
    const copies = new Set<string>()
    const scrollTo = async (step: number) => {
      await page
        .getByTestId('chat-stream')
        .evaluate(async (el, f) => {
          el.scrollTo({ top: el.scrollHeight * f })
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        }, step / 30)
      for (const h of await repeated(page)) copies.add(h)
    }
    for (let step = 0; step <= 30; step++) await scrollTo(step)
    for (let step = 30; step >= 0; step--) await scrollTo(step)

    expect([...copies]).toEqual([])
    // Both rows under the shared key are still there, each once
    await page.getByTestId('chat-stream').evaluate((el) => el.scrollTo({ top: el.scrollHeight * 0.75 }))
    await expect.poll(() => page.getByTestId('chat-stream').locator('[data-index]').filter({ hasText: /passage 151\./ }).count()).toBe(1)
    await page.getByTestId('chat-stream').evaluate((el) => el.scrollTo({ top: el.scrollHeight * 0.8 }))
    await expect.poll(() => page.getByTestId('chat-stream').locator('[data-index]').filter({ hasText: /passage 160\./ }).count()).toBe(1)
  })
}
