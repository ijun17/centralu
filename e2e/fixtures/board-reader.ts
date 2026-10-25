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
  [`${REPO}#101`]: thread(101, 'Worktree management', 'Needs decision', [], true),
}

const RECORDED = {
  key: `${REPO}#101`,
  answer: { text: '우리 쪽으로.', savedAt: '2026-10-12T09:00:00Z', updatedAt: '2026-10-12T09:00:00Z', recordedAt: '2026-10-12T09:30:00Z', recordedUrl: 'https://example.test/issues/101#issuecomment-1' },
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

/** What merge_queue answers (#956): one item in each of the screen's groups */
const QUEUE = {
  content: [{ type: 'text', text: 'queue' }],
  structuredContent: {
    summary: 'Merge queue: 1 need attention, 2 in CI, 1 waiting, 1 merged. Driven by the board app.',
    items: [],
    queue: [
      { repo: REPO, pr: 120, ref: '#120', title: 'fix(ui): keep focus', state: 'attention', lowers: [], reason: { kind: 'dirty', text: '#120 conflicts with main (GitHub: DIRTY) at c0ffee0. Rebase it onto main and push.' }, head: 'c0ffee0000', commit: null },
      { repo: REPO, pr: 121, ref: '#121', title: 'feat(apps): a stack top', state: 'ci', lowers: [119], reason: null, head: 'beef000000', commit: null },
      { repo: REPO, pr: 123, ref: '#123', title: 'fix(apps): tested in a batch', state: 'ci', lowers: [], reason: null, head: 'feed000000', commit: null, batch: { id: 3, branch: 'queue/batch-3', state: 'ci' } },
      { repo: REPO, pr: 122, ref: '#122', title: 'docs: a note', state: 'waiting', lowers: [], reason: null, head: null, commit: null },
      { repo: REPO, pr: 118, ref: '#118', title: 'fix(host): a merged one', state: 'merged', lowers: [], reason: null, head: 'abc', commit: 'abcdef1234' },
    ],
  },
}

/** The board on the test bed, its tool calls answered as the server would. `failSaves`: how many saves fail first; `queue`: what merge_queue answers */
async function showBoard(page: Page, { failSaves = 0, queue = null as typeof QUEUE | null } = {}) {
  await page.evaluate(
    ({ board, threads, summaries, failSaves, recorded, queue }) => {
      const w = window as any
      let failures = failSaves
      // #101's last answer was recorded by an agent already
      const saved: Record<string, any> = { [recorded.key]: recorded.answer }
      let words: string[] = ['Moonbase']
      const wordList = () => ({ content: [{ type: 'text', text: `${words.length} private words.` }], structuredContent: { count: words.length, words } })
      w.__mock.appToolHandler = async (_app: string, tool: string, args: any) => {
        if (tool === 'show') return { content: [{ type: 'text', text: 'board' }], structuredContent: board }
        if (tool === 'merge_queue' && queue) return queue
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
        // The owner's answers, as the server keeps them on this computer (save_answer, delete_answer)
        const withAnswer = (t: any, key: string) => ({ ...t, structuredContent: { ...t.structuredContent, ownerAnswer: saved[key] ?? null } })
        if (tool === 'read_item') return threads[args.item] ? withAnswer(threads[args.item], args.item) : { content: [{ type: 'text', text: 'missing' }], structuredContent: { ok: false, error: { kind: 'not-found', message: `${args.item} is not there.` } } }
        if (tool === 'decision_summaries')
          return { ...summaries, structuredContent: { ...summaries.structuredContent, items: summaries.structuredContent.items.map((i: any) => ({ ...i, ownerAnswer: saved[`${i.repository}#${i.number}`] ?? null })) } }
        if (tool === 'save_answer') {
          if (failures-- > 0) return { isError: true, content: [{ type: 'text', text: 'x' }], structuredContent: { summary: 'x', error: { kind: 'internal', message: 'the data folder could not be written.' } } }
          const at = '2026-10-12T10:00:00Z'
          saved[args.item] = { text: args.text.trim(), savedAt: saved[args.item]?.savedAt ?? at, updatedAt: at, recordedAt: null, recordedUrl: null }
          return { content: [{ type: 'text', text: 'Saved' }], structuredContent: { ok: true, ref: '#113', answer: saved[args.item] } }
        }
        if (tool === 'delete_answer') {
          delete saved[args.item]
          return { content: [{ type: 'text', text: 'Deleted' }], structuredContent: { ok: true, ref: '#113', answer: null } }
        }
        return { content: [{ type: 'text', text: 'ok' }] }
      }
    },
    { board: BOARD_STATE, threads: THREADS, summaries: SUMMARIES, failSaves, recorded: RECORDED, queue },
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

    /*
     * The repository is public: the owner's answer is saved on this computer and never posted as
     * written. An agent records the decision in English; until then the answer can be changed or
     * deleted on the item.
     */
    test('a decision is answered from the reader: saved on this computer, never posted, then changed and deleted', async ({ page }) => {
      const v = await showBoard(page, { failSaves: 1 })
      await v.locator('.card[data-number="113"] .title').click()
      const text = v.locator('#answer-text')
      await expect(text).toBeVisible()
      await expect(text).toHaveValue('')
      await expect(v.locator('#answer-hint')).toHaveText('Saved on this computer only, never posted to GitHub as you write it. An agent records the decision on #113 in English.')
      await expect(v.locator('.r-summary')).toContainText('Fold it into #406?')

      // Typed the way a person does, then Ctrl+Enter
      await text.click()
      await page.keyboard.type('A로 갑니다. #406에 합칩니다.')
      // A Ctrl+Enter the input method took (ending a Korean syllable) is not a save: Playwright has
      // no input method, so the key is sent as the event an engine gives for it
      await text.evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }))
      })
      expect(await callsTo(page, 'save_answer')).toEqual([])
      // A save that fails says why and keeps the text; the second goes through
      await page.keyboard.press('Control+Enter')
      await expect(v.locator('#answer-error')).toHaveText('Not saved: the data folder could not be written.')
      await expect(text).toHaveValue('A로 갑니다. #406에 합칩니다.')
      await v.locator('#answer-save').click()
      const saved = v.locator('#answer-saved')
      await expect(saved).toBeVisible()
      await expect(saved).toBeFocused()
      await expect(v.locator('#answer-saved-text')).toHaveText('A로 갑니다. #406에 합칩니다.')
      await expect(v.locator('#answer-saved-state')).toContainText('not recorded yet')
      await expect(v.locator('#answer-note')).toHaveText(
        'Saved on this computer; nothing was posted to GitHub. The agent will record the decision on #113 in English. Until then you can edit or delete it here.',
      )
      await expect(v.locator('#answer-edit')).toBeHidden()
      expect(await callsTo(page, 'save_answer')).toEqual([
        { item: `${REPO}#113`, text: 'A로 갑니다. #406에 합칩니다.', title: 'Narrow-window reading' },
        { item: `${REPO}#113`, text: 'A로 갑니다. #406에 합칩니다.', title: 'Narrow-window reading' },
      ])
      // Nothing on the screen can post to GitHub
      const tools = await page.evaluate(() => ((window as any).__mock.appToolCalls as { tool: string }[]).map((c) => c.tool))
      expect(tools.filter((t) => /post|comment|preview/.test(t))).toEqual([])

      // Edit opens it in the box; Esc steps back out of the change, the saved answer as it was
      await v.locator('#answer-change').click()
      await expect(text).toBeFocused()
      await expect(text).toHaveValue('A로 갑니다. #406에 합칩니다.')
      await page.keyboard.type(' 아니요')
      await page.keyboard.press('Escape')
      await expect(v.locator('dialog#reader')).toBeVisible()
      await expect(v.locator('#answer-saved-text')).toHaveText('A로 갑니다. #406에 합칩니다.')
      await expect(v.locator('#answer-change')).toBeFocused()
      // Changed and saved
      await page.keyboard.press('Enter')
      await text.press('End')
      await page.keyboard.type(' B도 괜찮습니다.')
      await v.locator('#answer-save').click()
      await expect(v.locator('#answer-saved-text')).toHaveText('A로 갑니다. #406에 합칩니다. B도 괜찮습니다.')
      // Deleted: the box takes a new answer
      await v.locator('#answer-delete').click()
      await expect(saved).toBeHidden()
      await expect(v.locator('#answer-note')).toHaveText('Deleted the saved answer.')
      await expect(text).toBeFocused()
      await expect(text).toHaveValue('')
      expect(await callsTo(page, 'delete_answer')).toEqual([{ item: `${REPO}#113` }])
    })

    test('the Needs decision view shows what each item asks and which answers wait to be recorded', async ({ page }) => {
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
      // Closed, the draft waits, and the keyboard is back on the button
      await page.keyboard.press('Escape')
      await expect(answer).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(v.locator('#answer-text')).toHaveValue('B')
      await page.keyboard.press('Control+Enter')
      await expect(v.locator('#answer-saved')).toBeFocused()
      await page.keyboard.press('Escape')
      // The card says the answer waits for an agent
      await expect(cards.first()).toContainText('Answered, not recorded yet')
      await expect(cards.first().getByRole('button', { name: 'Read your answer' })).toBeVisible()

      // An answer an agent recorded shows with its decision comment, and a new one can be written
      await cards.nth(1).getByRole('button').click()
      await expect(v.locator('#answer-saved-title')).toHaveText('Your last answer')
      await expect(v.locator('#answer-saved-state')).toContainText('recorded in English')
      await expect(v.locator('#answer-saved-state a')).toHaveAttribute('href', 'https://example.test/issues/101#issuecomment-1')
      await expect(v.locator('#answer-saved-actions')).toBeHidden()
      await expect(v.locator('#answer-text')).toBeVisible()
      await page.keyboard.press('Escape')

      await v.locator('#mode-board').click()
      await expect(v.locator('#board')).toBeVisible()
      await expect(v.locator('#decisions')).toBeHidden()
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

    test('the merge queue shows above the board in its groups, attention first with why, and Unqueue takes an item out', async ({ page }) => {
      const v = await showBoard(page, { queue: QUEUE })
      const queue = v.locator('#queue')
      await expect(queue).toBeVisible()
      // Merged items are history: collapsed under a toggle until it is clicked
      await expect(queue.locator('.q-group .q-label')).toHaveText(['Needs attention1', 'CI2', 'Waiting1'])
      await queue.locator('#queue-merged-toggle').click()
      await expect(queue.locator('.q-group .q-label')).toHaveText(['Needs attention1', 'CI2', 'Waiting1', 'Merged1'])
      const attention = queue.locator('.q-row[data-state="attention"]')
      await expect(attention).toContainText('fix(ui): keep focus')
      await expect(attention.locator('.why')).toHaveText('#120 conflicts with main (GitHub: DIRTY) at c0ffee0. Rebase it onto main and push.')
      await expect(queue.locator(`.q-row[data-ref="${REPO}#121"] .tag`)).toHaveText('stack over #119')
      // In a batch (#962): which one, so a pull request whose own run was cancelled says why
      await expect(queue.locator(`.q-row[data-ref="${REPO}#123"] .tag`)).toHaveText('batch 3')
      await expect(queue.locator(`.q-row[data-ref="${REPO}#123"] .tag`)).toHaveAttribute('title', 'Tested together with others on queue/batch-3')
      await expect(queue.locator('.q-row[data-state="merged"]')).toContainText('merged as abcdef1')
      await expect(queue.locator('.q-row[data-state="merged"] button')).toHaveCount(0)
      // A title reads the pull request in place, like a card's
      await attention.locator('.title').click()
      expect(await callsTo(page, 'read_item')).toEqual([{ item: `${REPO}#120` }])
      await page.keyboard.press('Escape')
      await attention.getByRole('button', { name: 'Unqueue' }).click()
      await expect.poll(() => callsTo(page, 'unqueue')).toEqual([{ pr: `${REPO}#120` }])
    })

    const mergedItems = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ repo: REPO, pr: 200 + i, ref: `#${200 + i}`, title: `fix(host): merged change number ${i}, with a title long enough to wrap`, state: 'merged', lowers: [], reason: null, head: 'abc', commit: 'abcdef1234' }))
    const queueOf = (queue: any[], summary: string) => ({ ...QUEUE, structuredContent: { ...QUEUE.structuredContent, summary, queue } })

    test('with nothing queued and 13 merged, the queue is one line and the board shows below it in a narrow pane', async ({ page }) => {
      await page.setViewportSize({ width: 380, height: 700 })
      const v = await showBoard(page, { queue: queueOf(mergedItems(13), 'Merge queue: nothing queued, 13 merged.') })
      const queue = v.locator('#queue')
      await expect(queue).toBeVisible()
      await expect(queue.locator('.q-row')).toHaveCount(0)
      const toggle = queue.locator('#queue-merged-toggle')
      await expect(toggle).toHaveText('Merged (13)')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      const at = await v.locator('body').evaluate(() => {
        const q = document.querySelector('#queue')!.getBoundingClientRect()
        const c = document.querySelector('.card')!.getBoundingClientRect()
        return { queueHeight: q.height, cardBottom: c.bottom, view: window.innerHeight, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }
      })
      expect(at.queueHeight).toBeLessThan(100) // a header of at most two lines
      expect(at.cardBottom).toBeLessThanOrEqual(at.view)
      expect(at.sideways).toBeLessThanOrEqual(0)
      // Opening it lists them, and the section scrolls inside itself instead of growing past a third of the view
      await toggle.focus()
      await page.keyboard.press('Enter')
      await expect(queue.locator('.q-row[data-state="merged"]')).toHaveCount(13)
      await expect(toggle).toBeFocused()
      const open = await v.locator('body').evaluate(() => ({ height: document.querySelector('#queue')!.getBoundingClientRect().height, view: window.innerHeight }))
      expect(open.height).toBeLessThanOrEqual(open.view / 3 + 2)
      await toggle.click()
      await expect(queue.locator('.q-row')).toHaveCount(0)
    })

    test('an item that needs attention shows without a click among merged ones', async ({ page }) => {
      await page.setViewportSize({ width: 380, height: 700 })
      const v = await showBoard(page, { queue: queueOf([QUEUE.structuredContent.queue[0], ...mergedItems(13)], 'Merge queue: 1 needs attention, 13 merged.') })
      const queue = v.locator('#queue')
      await expect(queue.locator('.q-row[data-state="attention"]')).toBeVisible()
      await expect(queue.locator('.q-row[data-state="attention"] .why')).toContainText('conflicts with main')
      await expect(queue.locator('.q-row[data-state="merged"]')).toHaveCount(0)
      await expect(queue.locator('#queue-merged-toggle')).toHaveText('Merged (13)')
    })

    test('the release dialog shows where the release stands, reads again on demand, and Esc gives the keyboard back', async ({ page }) => {
      const v = await showBoard(page)
      // Nothing queued (#956): no queue section at all
      await expect(v.locator('#queue')).toBeHidden()
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
