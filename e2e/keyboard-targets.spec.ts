import { expect, test, type Page } from '@playwright/test'

/**
 * Keys go only to what the person is looking at (#158, #181) — real UI on a mock platform.
 *
 * Global key handling (y/n/a on the approval card, Esc on the overlay) is attached to `window`.
 * When a dialog opens as local state, those handlers have no idea a dialog is on top. Here a
 * dialog is opened and keys are sent while it is up, checking that the target behind it does
 * not move.
 */

const answers = (page: Page) => page.evaluate(() => (window as any).__mock.approvalAnswers as unknown[])

async function sessionWithApproval(page: Page): Promise<string> {
  await page.goto('/?mock=1')
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  const sessionId = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  await page.evaluate(
    (sid) => (window as any).__mock.requestApproval(sid, { kind: 'command', command: 'rm -rf build', cwd: '/tmp/alpha' }, 'r-hidden'),
    sessionId,
  )
  await expect(page.getByTestId('approval-card')).toBeVisible()
  return sessionId
}

test('while the delete-confirmation dialog is open, y/n/a do not reach the approval card behind it (#158)', async ({ page }) => {
  const sessionId = await sessionWithApproval(page)

  await page.getByTestId(`session-menu-${sessionId}`).click()
  await page.getByTestId(`delete-session-${sessionId}`).click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  // A y pressed meaning "confirm the deletion" — it must not allow the command behind the dialog
  for (const k of ['y', 'n', 'a']) await page.keyboard.press(k)
  await page.waitForTimeout(200)
  expect(await answers(page)).toEqual([])

  // Closing the dialog leaves the card in place, and now y goes through
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('confirm-delete')).toHaveCount(0)
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.keyboard.press('y')
  await expect.poll(() => answers(page)).toEqual([{ sessionId, requestId: 'r-hidden', decision: 'allow' }])
})

async function freshSession(page: Page): Promise<string> {
  await page.goto('/?mock=1')
  await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
  await page.getByTestId('add-project').click()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  return page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
}

test('↑/↓ pressed inside a field of the new-session dialog do not select a past conversation (#181)', async ({ page }) => {
  await freshSession(page)
  await page.evaluate(() => {
    ;(window as any).__mock.externalSessions = {
      supported: true,
      sessions: [
        { externalId: 'ext-0', tool: 'claude', title: '지난 대화', updatedAt: Date.now(), createdAt: null, branch: null, imported: false, importedAs: null },
      ],
    }
  })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-ext-0')).toBeVisible()
  await page.getByTestId('worktree-toggle').click()
  await page.getByTestId('worktree-branch-input').fill('feature/x')
  await page.getByTestId('worktree-branch-input').press('ArrowDown')
  // The new conversation is still selected — an arrow key outside the field still moves the list selection
  await expect(page.getByTestId('past-new')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('past-ext-0')).not.toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('create-session-confirm').focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('past-ext-0')).toHaveAttribute('aria-pressed', 'true')
})

test('an Enter that ends an IME composition in the run dialog does not save the command (#181)', async ({ page }) => {
  await freshSession(page)
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add-name').fill('데브 서')
  // The Enter an IME sends to end a composition — isComposing is true
  await page.getByTestId('run-add-name').evaluate((el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })),
  )
  await page.waitForTimeout(100)
  await expect(page.getByTestId('run-command-0')).toHaveCount(0)
  await page.getByTestId('run-add-name').fill('데브 서버')
  await page.getByTestId('run-add-name').press('Enter')
  await expect(page.getByTestId('run-command-0')).toContainText('데브 서버')
})

test('even with the overlay open, Esc in the terminal beside it goes to the terminal, and Esc in the settings dialog above it goes to the dialog (#181)', async ({ page }) => {
  await freshSession(page)
  await page.getByTestId('evidence-tab-terminal').click()
  await page.getByTestId('terminal-add').click()
  const termId = await page.evaluate(() => [...(window as any).__mock.terminalState.byCwd.values()][0][0].id as string)
  await expect(page.getByTestId(`terminal-surface-${termId}`)).toBeVisible()
  await page.evaluate(() => (window as any).__store.getState().openFile('README.md'))
  await expect(page.getByTestId('overlay')).toBeVisible()

  await page.getByTestId(`terminal-surface-${termId}`).click()
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.terminalState.input.map((x: { data: string }) => x.data).join('')))
    .toContain('\x1b')
  await expect(page.getByTestId('overlay')).toBeVisible()

  // The settings dialog opens with ⌘, — focus is outside the terminal (the document, here)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await expect(page.getByTestId('settings')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).toHaveCount(0)
  await expect(page.getByTestId('overlay')).toBeVisible()
})
