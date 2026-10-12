import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { appScreenHtml, startFixtureHost, type FixtureHost } from './app-views.js'

/**
 * The project board's reader (an issue read inside the view instead of the browser) and its answer
 * box, run in Chromium (board-reader.spec.ts) and WebKit (board-reader-webkit.spec.ts).
 *
 * The board's real screen runs in a real frame from the fixture host (the sandbox proxy, an opaque
 * inner frame) on the AppFrame test bed. Its tool calls are answered by the mock as the server would
 * answer them (tooling/project-board-reader.test.ts runs the server itself against a fake gh), and
 * recorded, so a test sees exactly what the view asked for. Keys are typed with `page.keyboard`, so
 * where the keyboard really is decides what happens (CONTRIBUTING.md).
 */

const BOARD = new URL('../../.centralu/apps/project-board/', import.meta.url)
const URI = 'ui://project-board/index.html'
const REPO = 'someone/centralu'
const issueUrl = (n: number) => `https://example.test/issues/${n}`

const item = (number: number, title: string, status: string, extra: Record<string, unknown> = {}) => ({
  itemId: `item-${number}`,
  status,
  priority: 'High',
  area: 'ui',
  number,
  title,
  url: issueUrl(number),
  type: 'issue',
  draft: false,
  repository: REPO,
  ...extra,
})

const BOARD_STATE = {
  ok: true,
  project: { title: 'Centralu', url: 'https://example.test/project', number: 1, owner: 'someone' },
  repository: REPO,
  fetchedAt: '2026-10-12T09:00:00Z',
  options: { area: ['ui'], priority: ['High', 'Medium'] },
  columns: ['Needs decision', 'Ready', 'Done'],
  decisionStatus: 'Needs decision',
  items: [item(113, 'Narrow-window reading', 'Needs decision'), item(101, 'Worktree management', 'Needs decision', { priority: 'Medium' }), item(8, 'Polish the design', 'Ready')],
}

// What read_item answers: the server's rendered HTML, plus three things a renderer bug could let
// through, which the view's own cleaning has to stop
const HOSTILE = '<img src="x" onerror="window.__pwned = 1"><a href="javascript:window.__pwned = 2">bad link</a><script>window.__pwned = 3</script>'
const thread = (number: number, title: string, status: string, comments: { id: string; author: string; html: string }[], needsDecision: boolean) => ({
  content: [{ type: 'text', text: `#${number} ${title}` }],
  structuredContent: {
    ok: true,
    item: {
      ref: `#${number}`,
      type: 'issue',
      repository: REPO,
      number,
      title,
      url: issueUrl(number),
      state: 'OPEN',
      stateReason: null,
      draft: false,
      author: 'someone',
      createdAt: '2026-09-30T08:00:00Z',
      labels: ['enhancement', 'ui'],
      inProject: true,
      status,
      priority: 'High',
      area: 'ui',
      html: `<p>The body of #${number}, see <a href="https://github.com/${REPO}/issues/8" class="ref" data-item="${REPO}#8">#8</a>.</p><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><pre><code>${'x'.repeat(300)}</code></pre>${HOSTILE}`,
    },
    comments: comments.map((c, n) => ({ ...c, url: `${issueUrl(number)}#c${n}`, createdAt: `2026-10-0${n + 1}T08:00:00Z` })),
    totalComments: comments.length,
    loadedComments: comments.length,
    needsDecision,
    decisionStatus: 'Needs decision',
    decision: needsDecision
      ? { date: '2026-10-12', question: 'Fold it into <strong>#406</strong>?', options: 'A · B', recommendation: 'A, the smaller change.', url: null, answered: null }
      : null,
  },
})

const THREADS: Record<string, unknown> = {
  [`${REPO}#113`]: thread(113, 'Narrow-window reading', 'Needs decision', [
    { id: 'IC_1', author: 'coordinator', html: '<h2>Decision needed (summary, 2026-10-12)</h2><p><strong>Question:</strong> fold it?</p>' },
    { id: 'IC_2', author: 'someone', html: '<p>The newest comment.</p>' },
  ], true),
  [`${REPO}#8`]: thread(8, 'Polish the design', 'Ready', [], false),
}

const SUMMARIES = {
  content: [{ type: 'text', text: '2 items' }],
  structuredContent: {
    ok: true,
    decisionStatus: 'Needs decision',
    fetchedAt: '2026-10-12T09:00:00Z',
    items: [
      { ref: '#113', repository: REPO, number: 113, title: 'Narrow-window reading', decision: { date: '2026-10-12', question: 'Fold it into <strong>#406</strong>?', options: 'A · B', recommendation: 'A, the smaller change.', url: null, answered: null } },
      { ref: '#101', repository: REPO, number: 101, title: 'Worktree management', decision: { date: '2026-10-11', question: 'Ours or the agent’s?', options: null, recommendation: 'Ours.', url: null, answered: '2026-10-12T09:30:00Z' } },
    ],
  },
}

let fx: FixtureHost

/** The board on the test bed, its tool calls answered as the server would. `failPosts`: how many posts fail first */
async function showBoard(page: Page, { failPosts = 0 } = {}) {
  await page.evaluate(
    ({ board, threads, summaries, failPosts }) => {
      const w = window as any
      let failures = failPosts
      let words: string[] = ['Moonbase']
      const wordList = () => ({ content: [{ type: 'text', text: `${words.length} private words.` }], structuredContent: { count: words.length, words } })
      w.__mock.appToolHandler = async (_app: string, tool: string, args: any) => {
        if (tool === 'show') return { content: [{ type: 'text', text: 'board' }], structuredContent: board }
        if (tool === 'private_words') return wordList()
        // Where the release stands, a step further on each read (an agent tagged in between)
        if (tool === 'release_status') {
          w.__releaseReads = (w.__releaseReads ?? 0) + 1
          return w.__releaseReads === 1
            ? { content: [{ type: 'text', text: 'x' }], structuredContent: { ok: true, phase: 'ready-to-tag', summary: 'main at abc1234 carries 0.1.0-beta.17: not tagged yet (last release v0.1.0-beta.16). Next: Tag v0.1.0-beta.17.', lines: ['CI on main at abc1234: green.', 'Merged since v0.1.0-beta.16 (1):', '- fix: two (#11)'] } }
            : { content: [{ type: 'text', text: 'x' }], structuredContent: { ok: true, phase: 'waiting-approval', summary: 'main at abc1234 carries 0.1.0-beta.17: v0.1.0-beta.17 is waiting for approval.', lines: ['Waiting for approval on npm-publish: linux-x64, darwin-arm64.'] } }
        }
        if (tool === 'edit_private_words') {
          words = [...words.filter((x) => !(args.remove ?? []).includes(x)), ...(args.add ?? [])].sort()
          return wordList()
        }
        // The server's check, as preview_answer answers it for a private word
        if (tool === 'preview_answer' && /moonbase/i.test(args.body))
          return { content: [{ type: 'text', text: 'Not ready' }], structuredContent: { ok: false, ref: '#113', problems: ['The comment contains a word from the private list: "Moonbase". Leave it out or say it in general terms.'], html: '' } }
        if (tool === 'read_item') return threads[args.item] ?? { content: [{ type: 'text', text: 'missing' }], structuredContent: { ok: false, error: { kind: 'not-found', message: `${args.item} is not there.` } } }
        if (tool === 'decision_summaries') return summaries
        if (tool === 'preview_answer')
          return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true, ref: '#113', problems: [], html: `<p>${args.body.replace(/[<>&]/g, '')}</p>` } }
        if (tool === 'post_answer') {
          if (failures-- > 0) return { isError: true, content: [{ type: 'text', text: 'GitHub refused the comment: it is locked.' }], structuredContent: { summary: 'x', error: { kind: 'github', message: 'GitHub refused the comment: it is locked.' } } }
          return {
            content: [{ type: 'text', text: 'Posted' }],
            structuredContent: { ok: true, ref: '#113', comment: { id: 'IC_new', url: 'https://example.test/issues/113#new', author: 'owner', createdAt: '2026-10-12T10:00:00Z', html: `<p>${args.body.replace(/[<>&]/g, '')}</p>` } },
          }
        }
        return { content: [{ type: 'text', text: 'ok' }] }
      }
    },
    { board: BOARD_STATE, threads: THREADS, summaries: SUMMARIES, failPosts },
  )
  const instanceId = fx.open({ projectId: null, appId: 'project-board' }, URI)
  await page.evaluate((p) => (window as any).__appFrame.mount('a', p), { appId: 'project-board', projectId: null, instanceId, fill: true, className: 'flex flex-col', changeSignal: 1 })
  await page.getByTestId('frame-a').getByTestId('app-frame').evaluate((el: HTMLElement) => (el.style.height = '640px'))
  await expect(page.getByTestId('frame-a').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  const v = view(page)
  await expect(v.locator('.card')).toHaveCount(BOARD_STATE.items.length)
  return v
}

function view(page: Page): FrameLocator {
  return page.getByTestId('frame-a').getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
}

/** The calls the view made to one tool, with their arguments */
const callsTo = (page: Page, tool: string) =>
  page.evaluate((t) => ((window as any).__mock.appToolCalls as { tool: string; args: unknown }[]).filter((c) => c.tool === t).map((c) => c.args), tool)

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function boardReaderTests(): void {
  test.describe('the project board reads an item in place and answers a decision', () => {
    test.beforeAll(async () => {
      fx = await startFixtureHost({ [`project-board ${URI}`]: { html: appScreenHtml(BOARD) } })
    })
    test.afterAll(async () => {
      await fx?.close()
    })
    test.beforeEach(async ({ page }) => {
      await page.exposeFunction('__viewFrame', (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
        fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
      )
      await page.goto('/app-frame.html')
      await page.waitForFunction(() => !!(window as any).__appFrame)
    })

    test('a card opens its item in the reader, rendered and cleaned, and Esc gives the keyboard back to the card', async ({ page }) => {
      const v = await showBoard(page)
      const title = v.locator('.card[data-number="113"] .title')
      await title.click()
      const reader = v.locator('dialog#reader')
      await expect(reader).toBeVisible()
      await expect(v.locator('#reader-title')).toHaveText('Narrow-window reading')
      expect(await callsTo(page, 'read_item')).toEqual([{ item: `${REPO}#113` }])
      // The body and the comments, newest last, with the item's labels and board fields
      await expect(reader.locator('.post')).toHaveCount(3)
      await expect(reader.locator('.post').last()).toContainText('The newest comment.')
      await expect(reader.locator('.post').first().locator('table td')).toHaveText(['1', '2'])
      await expect(v.locator('#reader-meta .tag')).toHaveText(['enhancement', 'ui', 'Needs decision', 'High', 'ui'])
      await expect(v.locator('#reader-meta')).toContainText('Open on GitHub')
      // What the server would never send is still stopped here: no handler, no script, no javascript: link
      await expect(reader.locator('[onerror], script, a[href^="javascript"]')).toHaveCount(0)
      await expect(reader.locator('a', { hasText: 'bad link' })).not.toHaveAttribute('href')
      expect(await v.locator('body').evaluate(() => (window as any).__pwned ?? null)).toBeNull()
      // A script is dropped whole, not shown as its source
      await expect(reader.locator('.post').first()).not.toContainText('__pwned')
      // A long code line scrolls inside its block: nothing overflows the reader sideways
      expect(await v.locator('#reader-scroll').evaluate((s) => s.scrollWidth - s.clientWidth)).toBeLessThanOrEqual(0)

      // Esc closes it, and the keyboard is back on the card: Enter reads the same item again
      await page.keyboard.press('Escape')
      await expect(reader).toBeHidden()
      await expect(title).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(reader).toBeVisible()
      await expect(v.locator('#reader-title')).toHaveText('Narrow-window reading')
      await page.keyboard.press('Escape')
      await expect(title).toBeFocused()
    })

    /*
     * Someone else moved an item while the reader was open: the board read itself again and its
     * cards are new elements. The card the reader came from is gone from the page, so the keyboard
     * goes to the card that stands for the same item (a dialog's own focus return would leave it
     * nowhere).
     */
    test('when the board reads itself again behind the reader, Esc still returns to the same item\'s card, and the reader reads it again too', async ({ page }) => {
      const v = await showBoard(page)
      const title = v.locator('.card[data-number="113"] .title')
      await title.click()
      await expect(v.locator('#reader-title')).toHaveText('Narrow-window reading')
      const before = await title.elementHandle()
      await page.evaluate(() => (window as any).__appFrame.update('a', { changeSignal: 2 }))
      await expect.poll(async () => (await callsTo(page, 'show')).length).toBe(2)
      await expect.poll(async () => (await callsTo(page, 'read_item')).length).toBe(2)
      await expect.poll(() => before!.evaluate((n) => n.isConnected)).toBe(false)
      await page.keyboard.press('Escape')
      await expect(v.locator('dialog#reader')).toBeHidden()
      await expect(title).toBeFocused()
    })

    test('a reference inside an item opens that item in the same reader, and Esc returns to the card it started from', async ({ page }) => {
      const v = await showBoard(page)
      const title = v.locator('.card[data-number="113"] .title')
      await title.focus()
      await page.keyboard.press('Enter')
      await expect(v.locator('#reader-title')).toHaveText('Narrow-window reading')
      await v.locator('#reader-thread a[data-item]', { hasText: '#8' }).first().click()
      await expect(v.locator('#reader-title')).toHaveText('Polish the design')
      // #8 waits on nobody: no answer box
      await expect(v.locator('#answer')).toBeHidden()
      await page.keyboard.press('Escape')
      await expect(v.locator('dialog#reader')).toBeHidden()
      await expect(title).toBeFocused()
    })

    test('a decision is answered from the reader: prefilled, reviewed, confirmed and shown where it was posted', async ({ page }) => {
      const v = await showBoard(page, { failPosts: 1 })
      await v.locator('.card[data-number="113"] .title').click()
      const text = v.locator('#answer-text')
      await expect(text).toBeVisible()
      const prefill = `**Decision (owner, ${today()}):** `
      await expect(text).toHaveValue(prefill)
      await expect(v.locator('.r-summary')).toContainText('Fold it into #406?')

      // Typed the way a person does: into the field, then Ctrl+Enter to review it
      await text.click()
      await text.press('End')
      await page.keyboard.type('A, fold it into #406.')
      await page.keyboard.press('Control+Enter')
      await expect(v.locator('#answer-confirm')).toBeVisible()
      await expect(v.locator('#answer-preview p')).toHaveText(`**Decision (owner, ${today()}):** A, fold it into #406.`)
      expect(await callsTo(page, 'post_answer')).toEqual([])
      await expect(v.locator('#answer-post')).toBeFocused()

      // Esc steps back to editing, with the reader still open and the keyboard in the answer
      await page.keyboard.press('Escape')
      await expect(v.locator('dialog#reader')).toBeVisible()
      await expect(v.locator('#answer-confirm')).toBeHidden()
      await expect(text).toBeFocused()
      await page.keyboard.type(' Thanks.')
      const body = `${prefill}A, fold it into #406. Thanks.`
      await expect(text).toHaveValue(body)

      // A Ctrl+Enter the input method took (ending a Korean syllable) is not a review: Playwright has
      // no input method, so the key is sent as the event an engine gives for it
      await text.evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }))
      })
      await expect(v.locator('#answer-confirm')).toBeHidden()
      expect(await callsTo(page, 'preview_answer')).toHaveLength(1)

      // A post GitHub refuses says why and keeps the answer; the second goes through
      await v.locator('#answer-review').click()
      await v.locator('#answer-post').click()
      await expect(v.locator('#answer-error')).toHaveText('Not posted: GitHub refused the comment: it is locked.')
      await expect(v.locator('#answer-post')).toBeEnabled()
      await v.locator('#answer-post').click()
      const posted = v.locator('.post.posted')
      await expect(posted).toContainText('A, fold it into #406. Thanks.')
      await expect(posted).toBeFocused()
      expect(await callsTo(page, 'post_answer')).toEqual([
        { item: `${REPO}#113`, body },
        { item: `${REPO}#113`, body },
      ])
      expect(await callsTo(page, 'preview_answer')).toEqual([
        { item: `${REPO}#113`, body: `${prefill}A, fold it into #406.` },
        { item: `${REPO}#113`, body },
      ])
      // Ready for the next answer
      await expect(v.locator('#answer-confirm')).toBeHidden()
      await expect(text).toHaveValue(prefill)
    })

    test('the Needs decision view shows what each item asks, and Read and answer puts the keyboard in the answer', async ({ page }) => {
      const v = await showBoard(page)
      await expect(v.locator('#mode-decisions')).toContainText('Needs decision2')
      await v.locator('#mode-decisions').click()
      await expect(v.locator('#board')).toBeHidden()
      const cards = v.locator('.dcard')
      await expect(cards).toHaveCount(2)
      await expect(cards.first()).toContainText('Fold it into #406?')
      await expect(cards.first()).toContainText('A, the smaller change.')
      await expect(cards.nth(1)).toContainText('Answered 2026-10-12')
      expect(await callsTo(page, 'decision_summaries')).toEqual([{}])

      const answer = cards.first().getByRole('button', { name: 'Read and answer' })
      await answer.click()
      await expect(v.locator('dialog#reader')).toBeVisible()
      await expect(v.locator('#answer-text')).toBeFocused()
      await page.keyboard.type('B')
      await expect(v.locator('#answer-text')).toHaveValue(`**Decision (owner, ${today()}):** B`)
      // Closed, the draft waits, and the keyboard is back on the button
      await page.keyboard.press('Escape')
      await expect(answer).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(v.locator('#answer-text')).toHaveValue(`**Decision (owner, ${today()}):** B`)
      await page.keyboard.press('Escape')

      await v.locator('#mode-board').click()
      await expect(v.locator('#board')).toBeVisible()
      await expect(v.locator('#decisions')).toBeHidden()
    })

    test('an answer the rules refuse says why before any confirmation, and nothing is posted', async ({ page }) => {
      const v = await showBoard(page)
      await v.locator('.card[data-number="113"] .title').click()
      const text = v.locator('#answer-text')
      await text.click()
      await text.press('End')
      await page.keyboard.type('Tested on the Moonbase build.')
      await v.locator('#answer-review').click()
      await expect(v.locator('#answer-error')).toHaveText('The comment contains a word from the private list: "Moonbase". Leave it out or say it in general terms.')
      await expect(v.locator('#answer-confirm')).toBeHidden()
      expect(await callsTo(page, 'post_answer')).toEqual([])
    })

    test('the private word list is edited from the board: added by typing, removed by its button, and Esc gives the keyboard back', async ({ page }) => {
      const v = await showBoard(page)
      const opener = v.locator('#words-open')
      await opener.click()
      await expect(v.locator('#words-list li')).toHaveText(['MoonbaseRemove'])
      // The field takes the next keystroke
      await expect(v.locator('#words-input')).toBeFocused()
      await page.keyboard.type('Side Quest')
      await page.keyboard.press('Enter')
      await expect(v.locator('#words-list li span')).toHaveText(['Moonbase', 'Side Quest'])
      await expect(v.locator('#words-input')).toHaveValue('')
      await expect(v.locator('#words-input')).toBeFocused()
      expect(await callsTo(page, 'edit_private_words')).toEqual([{ add: ['Side Quest'] }])
      await v.getByRole('button', { name: 'Remove Moonbase' }).click()
      await expect(v.locator('#words-list li span')).toHaveText(['Side Quest'])
      await expect(v.locator('#words-status')).toContainText('Removed "Moonbase".')
      await page.keyboard.press('Escape')
      await expect(v.locator('dialog#words')).toBeHidden()
      await expect(opener).toBeFocused()
    })

    test('the release dialog shows where the release stands, reads again on demand, and Esc gives the keyboard back', async ({ page }) => {
      const v = await showBoard(page)
      const opener = v.locator('#release-open')
      await opener.click()
      await expect(v.locator('dialog#release')).toBeVisible()
      await expect(v.locator('#release-summary')).toHaveText('main at abc1234 carries 0.1.0-beta.17: not tagged yet (last release v0.1.0-beta.16). Next: Tag v0.1.0-beta.17.')
      await expect(v.locator('#release-lines li')).toHaveText(['CI on main at abc1234: green.', 'Merged since v0.1.0-beta.16 (1):', '- fix: two (#11)'])
      await v.locator('#release-refresh').click()
      await expect(v.locator('#release-lines li')).toHaveText(['Waiting for approval on npm-publish: linux-x64, darwin-arm64.'])
      expect(await callsTo(page, 'release_status')).toEqual([{}, {}])
      await page.keyboard.press('Escape')
      await expect(v.locator('dialog#release')).toBeHidden()
      await expect(opener).toBeFocused()
    })

    test('in a panel-narrow view the reader fills the panel and nothing in it overflows sideways', async ({ page }) => {
      await page.setViewportSize({ width: 412, height: 900 })
      const v = await showBoard(page)
      await v.locator('.card[data-number="113"] .title').click()
      await expect(v.locator('#answer-text')).toBeVisible()
      const box = await v.locator('body').evaluate(() => {
        const d = document.querySelector('dialog#reader')!.getBoundingClientRect()
        const s = document.querySelector('#reader-scroll')!
        return { width: document.documentElement.clientWidth, left: d.left, right: d.right, overflow: s.scrollWidth - s.clientWidth }
      })
      expect(box.width).toBeLessThan(400)
      expect(box.left).toBe(0)
      expect(Math.round(box.right)).toBe(box.width)
      expect(box.overflow).toBeLessThanOrEqual(0)
    })
  })
}
