import { expect, test, type Page } from '@playwright/test'
import { newSession, seedLongChat, setup } from './fixtures/control.js'

/**
 * The conversation's edges fade where more of it lies beyond them (#1706, owner 2026-11-03): a line the edge cuts reads
 * as scrolling. None at the very top, none at the very end (the newest line stays plain), full in the middle. The fades
 * are overlays under the pinned question, so that and the rows stay as they are.
 */

const fades = (page: Page) =>
  page.evaluate(() => ({
    top: Number(getComputedStyle(document.querySelector('[data-testid=chat-fade-top]')!).opacity),
    bottom: Number(getComputedStyle(document.querySelector('[data-testid=chat-fade-bottom]')!).opacity),
  }))

const scrollTo = (page: Page, where: 'top' | 'middle' | 'end') =>
  page.getByTestId('chat-stream').evaluate((el, w) => {
    el.scrollTop = w === 'top' ? 0 : w === 'end' ? el.scrollHeight : (el.scrollHeight - el.clientHeight) / 2
  }, where)

/** Scrolls there, again until the rows measured late no longer move the end, then reads the fades */
const fadesAt = (page: Page, where: 'top' | 'middle' | 'end') =>
  expect.poll(async () => {
    await scrollTo(page, where)
    return fades(page)
  })

test('the top and bottom edges fade only where more conversation lies beyond them', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await seedLongChat(page, sid)
  const stream = page.getByTestId('chat-stream')
  const box = (await stream.boundingBox())!

  // Seeded at the end: the newest line is plain, the older conversation above fades
  await expect.poll(() => fades(page)).toEqual({ top: 1, bottom: 0 })

  await fadesAt(page, 'top').toEqual({ top: 0, bottom: 1 })

  await fadesAt(page, 'middle').toEqual({ top: 1, bottom: 1 })

  await fadesAt(page, 'end').toEqual({ top: 1, bottom: 0 })

  // Nothing moved, and the fades take no pointer
  expect(await stream.boundingBox()).toEqual(box)
  const pointer = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=chat-fade-top]')!).pointerEvents)
  expect(pointer).toBe('none')
})

test('the fade ramps with the distance from the top and lies under the pinned question', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await seedLongChat(page, sid)
  await fadesAt(page, 'middle').toEqual({ top: 1, bottom: 1 })

  // The pinned question sits inside the scroller; the fades are its siblings, so a lower z-index keeps them under it
  await expect(page.getByTestId('sticky-user')).toBeVisible()
  const z = await page.evaluate(() => {
    const level = (id: string) => Number(getComputedStyle(document.querySelector(`[data-testid=${id}]`)!).zIndex)
    return { banner: level('sticky-user'), top: level('chat-fade-top'), bottom: level('chat-fade-bottom') }
  })
  expect(z.banner).toBeGreaterThan(z.top)
  expect(z.banner).toBeGreaterThan(z.bottom)

  // 14 px from the top is half way: the fade comes in with the distance and is not switched on
  await fadesAt(page, 'top').toEqual({ top: 0, bottom: 1 })
  await expect
    .poll(async () => {
      await page.getByTestId('chat-stream').evaluate((el) => (el.scrollTop = 15))
      return (await fades(page)).top
    })
    .toBeCloseTo(0.5, 1)
})

test('the newest line is never faded while an answer streams in at the end', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sid = await newSession(page, 'alpha')
  await seedLongChat(page, sid)
  await fadesAt(page, 'end').toEqual({ top: 1, bottom: 0 })
  // Every opacity the bottom fade is given from here on
  await page.evaluate(() => {
    const seen: number[] = []
    ;(window as any).__bottomFade = seen
    new MutationObserver(() => seen.push(Number(getComputedStyle(document.querySelector('[data-testid=chat-fade-bottom]')!).opacity))).observe(
      document.querySelector('[data-testid=chat-fade-bottom]')!,
      { attributes: true },
    )
  })
  for (let i = 0; i < 12; i++) {
    await page.evaluate(
      ([s, n]) => (window as any).__mock.emit({ type: 'message_delta', sessionId: s, role: 'assistant', text: `streamed line ${n}\n\n` }),
      [sid, i] as const,
    )
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
  }
  await expect(page.getByText('streamed line 11')).toBeVisible()
  await fadesAt(page, 'end').toEqual({ top: 1, bottom: 0 })
  expect(await page.evaluate(() => Math.max(0, ...((window as any).__bottomFade as number[])))).toBe(0)
})
