import { expect, test, type Page } from '@playwright/test'

/**
 * Two windows on one machine raise one OS notification for one event (#2168). Every window hears the host's events, and
 * each raised its own banner and sound. Two pages of one browser context share their origin's storage and locks, as the
 * desktop app's windows do; each page's mock host sends it the same event a real host sends every window.
 */

type Mock = { emit(e: Record<string, unknown>): void; notifications: unknown[]; alerts: unknown[] }

const PARSER = { address: 'session:mock/s1', kind: 'session', sessionId: 's1', name: 'Parser', state: 'idle' }

async function openWindow(page: Page): Promise<void> {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  // Behind another window, where the default switches notify
  await page.evaluate(() => (window as any).__store.getState().setAppFocused(false))
}

const emit = (page: Page, e: Record<string, unknown>) => page.evaluate((ev) => ((window as any).__mock as Mock).emit(ev), e)
const raised = (page: Page) => page.evaluate(() => ({ notifications: ((window as any).__mock as Mock).notifications.length, alerts: ((window as any).__mock as Mock).alerts.length }))

const mail = (messageId: string) => ({ type: 'mail_changed', threadId: 't1', toPerson: true, arrived: { messageId, from: PARSER, kind: 'notice', preview: 'Done.' } })

test('two windows raise one notification for one mail, and none for a change that is no new mail', async ({ page, context }) => {
  const other = await context.newPage()
  await openWindow(page)
  await openWindow(other)

  for (const w of [page, other]) await emit(w, mail('m1'))
  // A read mark, a close, the person's own message: no `arrived`, so nothing to raise
  for (const w of [page, other]) await emit(w, { type: 'mail_changed', threadId: 't1', toPerson: false })
  await expect.poll(async () => ((await raised(page)).alerts + (await raised(other)).alerts)).toBe(1)

  // Each mail is its own event: the next one is raised once too, by whichever window takes it first
  for (const w of [other, page]) await emit(w, mail('m2'))
  await expect.poll(async () => ((await raised(page)).alerts + (await raised(other)).alerts)).toBe(2)
  const both = [await raised(page), await raised(other)]
  expect(both.reduce((n, r) => n + r.notifications, 0)).toBe(2)
})
