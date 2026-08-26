import { expect, test, type Page } from '@playwright/test'

/**
 * IME composition in the composer (issue #12).
 *
 * Playwright cannot drive a real input method, so these tests reproduce its *shape* instead,
 * which is the part the app actually has to answer to: one Korean syllable arrives as several
 * `input` events between `compositionstart` and `compositionend` (`한` is `ㅎ`, then `하`, then
 * `한`), and the key that ends a composition is delivered with `isComposing` set.
 *
 * What is asserted here is **which events the app treats as its own**, not how long anything
 * takes. #12 was never measured — the probe written for it hit a frame-wait floor that its own
 * do-nothing control hit too — so these tests deliberately claim only the work that stops
 * happening, which is a fact, and never a duration, which is not.
 */

async function setup(page: Page) {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible()
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('first-run-pick').click()
  // 첫 등록은 세션 만들기로 곧장 이어진다 — 여기서는 프로젝트만 필요하므로 닫는다
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-alpha')).toBeVisible()
}

async function newSession(page: Page, prompt: string) {
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
}

/**
 * One step of a composition: the box's value becomes `value` and the page is told a composition
 * produced it.
 *
 * Each step is its own round trip, and each waits a frame plus a task before returning. A real
 * input method leaves whole frames between jamo; firing them back to back in one synchronous
 * block would let React coalesce the renders, and the count this file cares about would come out
 * low for the *wrong* reason — which would make the test pass against the code it exists to fail
 * against.
 */
async function composeStep(page: Page, value: string, opts: { start?: boolean } = {}) {
  await page.evaluate(
    async ({ value, start }: { value: string; start: boolean }) => {
      const el = document.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement
      if (start) el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      // React tracks the last value it wrote, so the value has to be set the way the browser
      // sets it — through the prototype's setter — or React sees no change and onChange never runs
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setValue.call(el, value)
      el.selectionStart = el.selectionEnd = value.length
      el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: value.slice(-1) }))
      await new Promise((done) => requestAnimationFrame(() => setTimeout(done)))
    },
    { value, start: !!opts.start },
  )
}

async function endComposition(page: Page, data: string) {
  await page.evaluate(async (data: string) => {
    const el = document.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data }))
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done)))
  }, data)
}

/**
 * Every query the composer asked the file index for, in order.
 *
 * Counting the searches is the point: it is the one piece of per-keystroke work in the composer
 * that is unbounded — it leaves the process — and it is the piece a half-formed syllable has no
 * use for.
 */
async function fileSearches(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as never as { __searches: string[] }).__searches)
}

async function recordFileSearches(page: Page) {
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __searches: string[] }
    w.__searches = []
    // Something has to come back, or the menu never opens and "the menu closed" would be
    // indistinguishable from "the menu was never there"
    w.__mock.fsState.entries[''] = [{ name: '한글문서.md', path: '한글문서.md', isDir: false, ignored: false }]
    const real = w.__mock.fs.search.bind(w.__mock.fs)
    w.__mock.fs.search = async (projectId: string, query: string, limit?: number) => {
      w.__searches.push(query)
      return real(projectId, query, limit)
    }
  })
}

test('a syllable still being formed is not a file query', async ({ page }) => {
  await setup(page)
  await newSession(page, '작업')
  await recordFileSearches(page)

  await page.getByTestId('prompt-input').click()
  await page.getByTestId('prompt-input').pressSequentially('@')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  expect(await fileSearches(page)).toEqual([''])

  // `한`, as an input method delivers it
  await composeStep(page, '@ㅎ', { start: true })
  await composeStep(page, '@하')
  await composeStep(page, '@한')

  // The character has to be on screen while it is being formed — that is not negotiable, and it
  // is the thing a naive "do nothing until compositionend" would break
  await expect(page.getByTestId('prompt-input')).toHaveValue('@한')
  // …but nothing went looking for `ㅎ` or `하`, neither of which is a filename anyone typed
  expect(await fileSearches(page)).toEqual([''])
  await expect(page.getByTestId('autocomplete')).toBeHidden()

  await endComposition(page, '한')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('한글문서.md')
  expect(await fileSearches(page)).toEqual(['', '한'])
})

test('the Enter that finishes a syllable does not send the message', async ({ page }) => {
  await setup(page)
  await newSession(page, '작업')
  await page.getByTestId('prompt-input').click()

  await composeStep(page, '안', { start: true })
  await composeStep(page, '안녕')

  // The keystroke that commits a composition carries `isComposing`; the browser gives it to the
  // input method, and so must we
  await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done)))
  })

  // Still in the box. Sent here, the word would have gone out half-written
  await expect(page.getByTestId('prompt-input')).toHaveValue('안녕')

  await endComposition(page, '녕')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('prompt-input')).toHaveValue('')
  await expect(page.getByTestId('msg-user').last()).toContainText('안녕')
})
