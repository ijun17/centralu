import { test, expect, type Page } from '@playwright/test'
import { setup } from './fixtures/control.js'

/**
 * A program's call waiting for the person (#1405): something that is not the window, holding the limited credential,
 * asked to delete for good, and the host holds it until the person answers here. The mock stands in for the host:
 * `raiseHostRequest` is its `host_request` event.
 */

const QUESTION = 'Delete the trashed session "Fix the parser" on the linked machine "Laptop" for good? Its 4 messages (2.0 KB) leave this computer. This cannot be undone.'

async function raise(page: Page, question: string, client: string | null = null): Promise<string> {
  return page.evaluate(({ q, c }) => (window as any).__mock.raiseHostRequest(q, { client: c }), { q: question, c: client })
}

const answers = (page: Page) => page.evaluate(() => (window as any).__mock.hostRequestAnswers as { requestId: string; decision: string }[])

test('a host request names what goes and who asked, and Allow answers it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await raise(page, QUESTION, '"host-rpc"')
  const card = page.getByTestId('host-request-card')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('host-request-detail')).toHaveText(QUESTION)
  await expect(page.getByTestId('host-request-from')).toContainText('"host-rpc"')
  await page.getByTestId('host-request-allow').click()
  await expect(card).toBeHidden()
  expect(await answers(page)).toEqual([{ requestId: id, decision: 'allow' }])
})

test('a host request is never answered by a key: y in the window allows nothing', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await raise(page, QUESTION)
  await expect(page.getByTestId('host-request-card')).toBeVisible()
  await page.locator('body').click()
  await page.keyboard.press('y')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('host-request-card')).toBeVisible()
  expect(await answers(page)).toEqual([])
})

test('host requests stand one at a time, oldest first; Deny moves to the next, and a withdrawn one goes', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const first = await raise(page, 'Delete "one" for good?')
  const second = await raise(page, 'Delete "two" for good?')
  await raise(page, 'Delete "three" for good?')
  await expect(page.getByTestId('host-request-detail')).toHaveText('Delete "one" for good?')
  await expect(page.getByTestId('host-request-more')).toHaveText('2 more wait')
  await page.getByTestId('host-request-deny').click()
  await expect(page.getByTestId('host-request-detail')).toHaveText('Delete "two" for good?')
  // The program behind the second went away
  await page.evaluate((r) => (window as any).__mock.withdrawHostRequest(r), second)
  await expect(page.getByTestId('host-request-detail')).toHaveText('Delete "three" for good?')
  await expect(page.getByTestId('host-request-more')).toBeHidden()
  expect(await answers(page)).toEqual([{ requestId: first, decision: 'deny' }])
})

test('the next card does not take a click meant for the last: its buttons wait a moment', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const first = await raise(page, 'Delete "one" for good?')
  await raise(page, 'Delete "two" for good?')
  await page.getByTestId('host-request-deny').click()
  await expect(page.getByTestId('host-request-detail')).toHaveText('Delete "two" for good?')
  // Standing where the first was, the second's buttons take no click yet, then do
  await expect(page.getByTestId('host-request-allow')).toBeDisabled()
  await page.getByTestId('host-request-allow').click({ force: true })
  expect(await answers(page)).toEqual([{ requestId: first, decision: 'deny' }])
  await expect(page.getByTestId('host-request-allow')).toBeEnabled()
})

test('a long question shows whole: a line of parameters with no spaces wraps instead of running off the card', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const params = `{"projectId":"p1","note":"${'x'.repeat(1500)}","tail":"END"}`
  await raise(page, `Allow projects.delete? A program on this computer called it with ${JSON.stringify(params)}.`)
  const detail = page.getByTestId('host-request-detail')
  await expect(detail).toContainText('END')
  // Scrolled to its end, the last word lies within the card's width: the line wrapped rather than running off it.
  // (scrollWidth is no measure here: WebKit counts a vertical scrollbar's width in it)
  const inside = await detail.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    const node = [...el.childNodes].find((n) => n.textContent?.includes('END'))
    if (!node) return false
    const range = document.createRange()
    const at = node.textContent!.indexOf('END')
    range.setStart(node, at)
    range.setEnd(node, at + 3)
    const word = range.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    return word.width > 0 && word.left >= box.left && word.right <= box.right
  })
  expect(inside).toBe(true)
})
