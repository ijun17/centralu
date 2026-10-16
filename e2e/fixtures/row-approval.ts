import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * Answering an approval from a list row (#543, audit items 1 and 2): the waiting list's row and the sidebar's row of a
 * session waiting on an approval show what it asks (the verb and the command or path, the card's own text in the
 * tooltip), and offer Allow and Deny when the card's question is a plain yes or no. A card that offers more (start an
 * agent, reach another project, several files, a question beside it) shows Open instead.
 *
 * The answer goes through the card's own path (`respondApproval`) with the request id the row shows, so a request the
 * host has replaced is refused there and nothing else is answered.
 *
 * A function, like the other fixtures, because it runs in Chromium (row-approval.spec.ts) and in WebKit
 * (row-approval-webkit.spec.ts): the desktop app is WKWebView.
 */

type Mock = {
  emit(e: Record<string, unknown>): void
  requestApproval(id: string, d: Record<string, unknown>, requestId?: string): string
  replaceApprovalUnseen(id: string, d: Record<string, unknown>, requestId: string): void
  approvalAnswers: { sessionId: string; requestId: string; decision: string }[]
  sessions: Map<string, { pendingApproval: { requestId: string } | null }>
}

const COMMAND = 'kill -TERM 40321 && rm -rf ./tmp/orphans'
/** Short enough for the sidebar's 240 px row: a command is answered from a row only when it fits whole */
const SHORT = 'kill -TERM 40321'
const CWD = '/tmp/alpha'

/** Two sessions in alpha; the second is on screen. Returns the first (the one the tests are about) and the second. */
async function twoSessions(page: Page): Promise<{ target: string; shown: string }> {
  await setup(page, ['/tmp/alpha'])
  const target = await newSession(page, 'alpha')
  const shown = await newSession(page, 'alpha')
  return { target, shown }
}

async function ask(page: Page, id: string, detail: Record<string, unknown>, requestId = 'r1') {
  await page.evaluate(
    ({ sid, d, rid }) => void ((window as any).__mock as Mock).requestApproval(sid, d, rid),
    { sid: id, d: detail, rid: requestId },
  )
}

const answers = (page: Page) => page.evaluate(() => ((window as any).__mock as Mock).approvalAnswers.slice())
const focused = (page: Page) => page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
const hostPending = (page: Page, id: string) =>
  page.evaluate((sid) => ((window as any).__mock as Mock).sessions.get(sid)?.pendingApproval?.requestId ?? null, id)

async function openInbox(page: Page) {
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox')).toBeVisible()
}

export function rowApprovalTests() {
  test('the waiting list row shows the command and allows it without opening the session', async ({ page }) => {
    const { target, shown } = await twoSessions(page)
    await ask(page, target, { kind: 'command', command: COMMAND, cwd: CWD })
    await openInbox(page)

    // What is being approved stands on the row: the verb and the command, not only the session's name
    const what = page.getByTestId(`inbox-approval-what-${target}`)
    await expect(what).toContainText('Run')
    await expect(what).toContainText(COMMAND)
    // The tooltip is the card's own text: the command and the folder it runs in
    await what.hover()
    await expect(page.getByTestId(`inbox-approval-tip-${target}`)).toContainText(COMMAND)
    await expect(page.getByTestId(`inbox-approval-tip-${target}`)).toContainText(CWD)

    await page.getByTestId(`inbox-approve-allow-${target}`).click()

    await expect.poll(() => answers(page)).toEqual([{ sessionId: target, requestId: 'r1', decision: 'allow' }])
    // Not opened: the session on screen is still the other one, and the list stays open for the next row
    expect(await focused(page)).toBe(shown)
    await expect(page.getByTestId('inbox')).toBeVisible()
    await expect(page.getByTestId(`inbox-approval-${target}`)).toHaveCount(0)
  })

  test('in the waiting list, y allows and n denies the row under the cursor, printed on its buttons', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const a = await newSession(page, 'alpha')
    const b = await newSession(page, 'alpha')
    await newSession(page, 'alpha') // on screen
    await ask(page, a, { kind: 'command', command: 'ls', cwd: CWD }, 'ra')
    await ask(page, b, { kind: 'file_edit', path: 'src/app.ts', diffPreview: '+x', multi: false }, 'rb')
    await page.keyboard.press('Meta+i')
    await expect(page.locator('[data-testid^="inbox-approval-what-"]')).toHaveCount(2)

    // The cursor's row prints the keys; j moves it, as before
    const first = await page.locator('[data-testid^="inbox-item-"]').first().getAttribute('data-testid')
    const firstId = first!.slice('inbox-item-'.length)
    const secondId = firstId === a ? b : a
    await expect(page.getByTestId(`inbox-approve-allow-${firstId}`)).toContainText('y')
    await page.keyboard.press('j')
    await expect(page.getByTestId(`inbox-approve-deny-${secondId}`)).toContainText('n')
    // The rows answer once they have stood still a moment (a row that just slid under the cursor is not answered)
    await expect(page.getByTestId(`inbox-approve-deny-${secondId}`)).toBeEnabled()
    await page.keyboard.press('n')
    await expect.poll(() => answers(page)).toEqual([{ sessionId: secondId, requestId: secondId === a ? 'ra' : 'rb', decision: 'deny' }])

    await page.keyboard.press('k')
    await expect(page.getByTestId(`inbox-approve-allow-${firstId}`)).toContainText('y')
    await expect(page.getByTestId(`inbox-approve-allow-${firstId}`)).toBeEnabled()
    await page.keyboard.press('y')
    await expect.poll(async () => (await answers(page)).length).toBe(2)
    expect((await answers(page))[1]).toEqual({ sessionId: firstId, requestId: firstId === a ? 'ra' : 'rb', decision: 'allow' })
  })

  test('the sidebar row of a waiting session shows the command and answers it in place', async ({ page }) => {
    const { target, shown } = await twoSessions(page)
    await ask(page, target, { kind: 'command', command: SHORT, cwd: CWD })

    const what = page.getByTestId(`sidebar-approval-what-${target}`)
    await expect(what).toContainText(SHORT)
    await what.hover()
    await expect(page.getByTestId(`sidebar-approval-tip-${target}`)).toContainText(CWD)

    await page.getByTestId(`sidebar-approve-deny-${target}`).click()

    await expect.poll(() => answers(page)).toEqual([{ sessionId: target, requestId: 'r1', decision: 'deny' }])
    expect(await focused(page)).toBe(shown)
    // Only while it waits: the line goes once the approval is answered
    await expect(page.getByTestId(`sidebar-approval-${target}`)).toHaveCount(0)
  })

  // #683 review: the list listens on the window; a key typed into a layer over it, or composing, is not the list's
  test('typing in the palette over the waiting list, or composing a syllable, answers nothing', async ({ page }) => {
    const { target } = await twoSessions(page)
    await ask(page, target, { kind: 'command', command: 'rm -rf build', cwd: CWD })
    await page.keyboard.press('Meta+i')
    await expect(page.getByTestId(`inbox-approve-allow-${target}`)).toBeEnabled()

    // ⌘K over the open list: its field takes "yarn", and the row under the cursor is not allowed
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('palette-input')).toBeFocused()
    await page.keyboard.type('yarn')
    // Nothing answered (without the guard, the y allowed the row and the n went on to the next)
    await expect(page.getByTestId('palette-input')).toBeFocused()
    expect(await answers(page)).toEqual([])
    await expect(page.getByTestId('palette-input')).toHaveValue('yarn')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('palette-input')).toHaveCount(0)

    // A Korean ㅛ on the Y key while an input method composes, and a held y, are not an answer either
    await expect(page.getByTestId('inbox')).toBeVisible()
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ㅛ', code: 'KeyY', isComposing: true, bubbles: true, cancelable: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', repeat: true, bubbles: true, cancelable: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(await answers(page)).toEqual([])
    expect(await hostPending(page, target)).toBe('r1')

    // The plain key, with nothing over the list, still answers
    await page.keyboard.press('y')
    await expect.poll(() => answers(page)).toEqual([{ sessionId: target, requestId: 'r1', decision: 'allow' }])
  })

  // #683 review: a cut line can hide what matters, so a command that does not fit opens the session
  test('a command too long for the row shows Open there; an edit shows its file name first', async ({ page }) => {
    const { target } = await twoSessions(page)
    // Longer than the sidebar's row, short enough for the waiting list's
    await ask(page, target, { kind: 'command', command: COMMAND, cwd: CWD })
    // The sidebar's row is too narrow for it: Open, and the tooltip has it whole
    await expect(page.getByTestId(`sidebar-approve-open-${target}`)).toBeVisible()
    await expect(page.getByTestId(`sidebar-approve-allow-${target}`)).toHaveCount(0)
    await page.getByTestId(`sidebar-approval-what-${target}`).hover()
    await expect(page.getByTestId(`sidebar-approval-tip-${target}`)).toContainText(COMMAND)
    // The waiting list's wider row fits it whole, and answers it there
    await openInbox(page)
    await expect(page.getByTestId(`inbox-approve-allow-${target}`)).toBeEnabled()
    await page.keyboard.press('Escape')

    await page.evaluate(({ sid }) => ((window as any).__mock as Mock).emit({ type: 'approval_resolved', sessionId: sid, requestId: 'r1', decision: 'deny' }), { sid: target })
    await ask(page, target, { kind: 'file_edit', path: '/tmp/alpha/packages/ui/src/features/approval/RowApproval.tsx', diffPreview: '+x', multi: false }, 'r2')
    // The name stands whole at the front; the folder, relative to the project, gives way
    await expect(page.getByTestId(`sidebar-approval-file-${target}`)).toHaveText('RowApproval.tsx')
    await expect(page.getByTestId(`sidebar-approval-what-${target}`)).toContainText('packages/ui/')
    await expect(page.getByTestId(`sidebar-approval-what-${target}`)).not.toContainText('/tmp/alpha')
    await expect(page.getByTestId(`sidebar-approve-allow-${target}`)).toBeEnabled()
  })

  // #683 review: requests whose line says nothing, or that carry a risk the line does not show
  test('a network approval, an edit naming no file, a delete, a command outside the sandbox and a path climbing out show Open', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const ids = [await newSession(page, 'alpha'), await newSession(page, 'alpha'), await newSession(page, 'alpha'), await newSession(page, 'alpha'), await newSession(page, 'alpha')]
    await newSession(page, 'alpha') // on screen
    await ask(page, ids[0]!, { kind: 'command', command: '', cwd: CWD, network: { host: 'docs.example.com', protocol: 'https' } })
    await ask(page, ids[1]!, { kind: 'file_edit', path: '(no path)', diffPreview: '', multi: false })
    await ask(page, ids[2]!, { kind: 'file_edit', path: '/tmp/alpha/old.ts', diffPreview: '-x', multi: false, change: 'delete' })
    await ask(page, ids[3]!, { kind: 'command', command: 'curl x', cwd: CWD, unsandboxed: true })
    // #683 re-review: a path that starts in the project and climbs out of it
    await ask(page, ids[4]!, { kind: 'file_edit', path: '/tmp/alpha/src/../../../etc/zshrc', diffPreview: '+x', multi: false })
    for (const id of ids) {
      await expect(page.getByTestId(`sidebar-approve-open-${id}`)).toBeVisible()
      await expect(page.getByTestId(`sidebar-approve-allow-${id}`)).toHaveCount(0)
    }
    await expect(page.getByTestId(`sidebar-approval-what-${ids[0]}`)).toContainText('network access to docs.example.com')
    await expect(page.getByTestId(`sidebar-approval-what-${ids[2]}`)).toContainText('Delete')
    // Shown where it really lands, not as a file of the project
    await expect(page.getByTestId(`sidebar-approval-what-${ids[4]}`)).toContainText('zshrc/etc/')
    // The card says it too
    await page.getByTestId(`sidebar-approve-open-${ids[3]}`).click()
    await expect(page.getByTestId('approval-detail')).toContainText('Runs outside the sandbox')
  })

  test('a row that just appeared or moved does not answer until the rows stand still', async ({ page }) => {
    const { target } = await twoSessions(page)
    // Read in the page, on the first frame the row is drawn: well inside the settle time, whatever the machine's load
    const disabledWhenDrawn = await page.evaluate(async ({ sid }) => {
      ;((window as any).__mock as Mock).requestApproval(sid, { kind: 'command', command: 'ls', cwd: '/tmp/alpha' }, 'r1')
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => requestAnimationFrame(r))
        const b = document.querySelector<HTMLButtonElement>(`[data-testid="sidebar-approve-allow-${sid}"]`)
        if (b) return b.disabled
      }
      return null
    }, { sid: target })
    expect(disabledWhenDrawn).toBe(true)
    // Then it settles and answers
    await expect(page.getByTestId(`sidebar-approve-allow-${target}`)).toBeEnabled()
    await page.getByTestId(`sidebar-approve-allow-${target}`).click()
    await expect.poll(() => answers(page)).toEqual([{ sessionId: target, requestId: 'r1', decision: 'allow' }])
  })

  test('a row whose request the host has replaced is refused there, and the new request is not answered', async ({ page }) => {
    const { target } = await twoSessions(page)
    await ask(page, target, { kind: 'command', command: 'ls', cwd: CWD }, 'old')
    await expect(page.getByTestId(`sidebar-approval-what-${target}`)).toContainText('ls')

    // The host moved on to another request whose event has not reached this window yet
    await page.evaluate(
      ({ sid }) => ((window as any).__mock as Mock).replaceApprovalUnseen(sid, { kind: 'command', command: 'rm -rf /', cwd: '/' }, 'new'),
      { sid: target },
    )
    await page.getByTestId(`sidebar-approve-allow-${target}`).click()

    // Refused by the id the row carried: said so, and nothing was answered
    await expect(page.getByTestId('toast')).toContainText('already gone')
    expect(await answers(page)).toEqual([])
    expect(await hostPending(page, target)).toBe('new')

    // When the new request arrives, the row shows its own command, and only then can it be answered
    await page.evaluate(
      ({ sid }) => ((window as any).__mock as Mock).emit({ type: 'approval_request', sessionId: sid, requestId: 'new', detail: { kind: 'command', command: 'rm -rf /', cwd: '/' } }),
      { sid: target },
    )
    await expect(page.getByTestId(`sidebar-approval-what-${target}`)).toContainText('rm -rf /')
  })

  test('a card that offers more than allow and deny shows Open on its row, which opens the session', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const agents = await newSession(page, 'alpha')
    const files = await newSession(page, 'alpha')
    const asking = await newSession(page, 'alpha')
    await newSession(page, 'alpha') // on screen
    // Starting an agent has scopes to pick
    await ask(page, agents, {
      kind: 'agent_start',
      project: { id: 'p', name: 'alpha' },
      tool: 'Codex',
      preset: 'safe',
      text: 'write the parser',
    }, 'ra')
    // Several files in one edit
    await ask(page, files, { kind: 'file_edit', path: 'a.ts, b.ts', diffPreview: '+x', multi: true }, 'rf')
    // An approval with a question beside it: two things pending
    await ask(page, asking, { kind: 'command', command: 'ls', cwd: CWD }, 'rq')
    await page.evaluate(
      ({ sid }) =>
        ((window as any).__mock as Mock).emit({
          type: 'question_request',
          sessionId: sid,
          requestId: 'q1',
          questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
        }),
      { sid: asking },
    )

    for (const id of [agents, files, asking]) {
      await expect(page.getByTestId(`sidebar-approve-open-${id}`)).toBeVisible()
      await expect(page.getByTestId(`sidebar-approve-allow-${id}`)).toHaveCount(0)
    }
    // Still says what it asks
    await expect(page.getByTestId(`sidebar-approval-what-${agents}`)).toContainText('Start Codex in "alpha"')

    await openInbox(page)
    for (const id of [agents, files, asking]) {
      await expect(page.getByTestId(`inbox-approve-open-${id}`)).toBeVisible()
      await expect(page.getByTestId(`inbox-approve-allow-${id}`)).toHaveCount(0)
    }
    // y on such a row answers nothing
    await page.keyboard.press('y')
    await page.getByTestId(`inbox-approve-open-${agents}`).click()

    await expect(page.getByTestId('inbox')).toBeHidden()
    expect(await focused(page)).toBe(agents)
    await expect(page.getByTestId('approval-card')).toBeVisible()
    expect(await answers(page)).toEqual([])
  })
}
