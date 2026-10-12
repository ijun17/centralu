import { expect, test, type Page } from '@playwright/test'

/**
 * Answering an approval while typing: with the keyboard in the session's composer, y/n/a are letters of the message,
 * so the card takes mod+⇧Y (allow), mod+⇧D (deny) and mod+⇧L (always) there, and shows those on its buttons. Outside a
 * text field the bare letters answer as before. Typed with `page.keyboard`, the way a person types (CONTRIBUTING).
 */

const answers = (page: Page) => page.evaluate(() => (window as any).__mock.approvalAnswers as unknown[])

async function sessionTyping(page: Page): Promise<string> {
  await page.goto('/?mock=1')
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  // A new session's composer has the keyboard (#528)
  await expect(page.getByTestId('prompt-input')).toBeFocused()
  return page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
}

const raise = (page: Page, sessionId: string, requestId: string) =>
  page.evaluate(
    ([sid, rid]) => (window as any).__mock.requestApproval(sid, { kind: 'command', command: 'rm -rf build', cwd: '/tmp/alpha' }, rid),
    [sessionId, requestId] as const,
  )

test('in the composer, y/n/a are typed and mod+⇧Y / mod+⇧D / mod+⇧L answer the card, which shows them', async ({ page }) => {
  const sid = await sessionTyping(page)
  const input = page.getByTestId('prompt-input')
  const card = page.getByTestId('approval-card')

  await page.keyboard.type('yes')
  await raise(page, sid, 'r1')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-keys', 'composer')
  await expect(card.getByTestId('approve-allow')).toContainText('⌘⇧Y')
  await expect(card.getByTestId('approve-deny')).toContainText('⌘⇧D')
  await expect(card.getByTestId('approve-always')).toContainText('⌘⇧L')

  // The letters go into the message and answer nothing
  await page.keyboard.type(' no and')
  await expect(input).toHaveValue('yes no and')
  await page.waitForTimeout(200)
  expect(await answers(page)).toEqual([])

  await page.keyboard.press('ControlOrMeta+Shift+Y')
  await expect.poll(() => answers(page)).toEqual([{ sessionId: sid, requestId: 'r1', decision: 'allow' }])
  // Nothing typed by the combo, and the keyboard is still in the composer
  await expect(input).toHaveValue('yes no and')
  await page.keyboard.type(' more')
  await expect(input).toHaveValue('yes no and more')

  await raise(page, sid, 'r2')
  await expect(card).toHaveAttribute('data-keys', 'composer')
  await page.keyboard.press('ControlOrMeta+Shift+D')
  await expect.poll(() => answers(page)).toHaveLength(2)
  expect((await answers(page))[1]).toEqual({ sessionId: sid, requestId: 'r2', decision: 'deny' })

  await raise(page, sid, 'r3')
  await expect(card).toHaveAttribute('data-keys', 'composer')
  await page.keyboard.press('ControlOrMeta+Shift+L')
  await expect.poll(() => answers(page)).toHaveLength(3)
  expect((await answers(page))[2]).toEqual({ sessionId: sid, requestId: 'r3', decision: 'always' })
  await expect(input).toHaveValue('yes no and more')
})

test('out of the composer the card shows y/n/a again, and a bare y answers it', async ({ page }) => {
  const sid = await sessionTyping(page)
  const card = page.getByTestId('approval-card')
  await raise(page, sid, 'r1')
  await expect(card).toHaveAttribute('data-keys', 'composer')

  // The keyboard leaves the field: the hints follow it
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(card).toHaveAttribute('data-keys', 'bare')
  await expect(card.getByTestId('approve-allow')).toContainText('y')
  await expect(card.getByTestId('approve-allow')).not.toContainText('⌘')
  await page.keyboard.press('y')
  await expect.poll(() => answers(page)).toEqual([{ sessionId: sid, requestId: 'r1', decision: 'allow' }])
})

test("the card's visible button answers it with the keyboard still in the composer", async ({ page }) => {
  const sid = await sessionTyping(page)
  await page.keyboard.type('half a thought')
  await raise(page, sid, 'r1')
  await page.getByTestId('approve-allow').click()
  await expect.poll(() => answers(page)).toEqual([{ sessionId: sid, requestId: 'r1', decision: 'allow' }])
  await expect(page.getByTestId('prompt-input')).toHaveValue('half a thought')
})
