import { expect, test, type Page } from '@playwright/test'

/**
 * 키는 사람이 보고 있는 대상에만 간다 (#158, #181) — 목 플랫폼 위의 진짜 UI.
 *
 * 전역 키 처리(승인 카드의 y/n/a, 오버레이의 Esc)는 `window`에 달린다. 창이 지역 상태로 열리면 그 처리들은 창이 떠 있는
 * 줄을 모른다. 여기서는 창을 띄운 채 키를 보내 창 뒤의 대상이 움직이지 않는지 본다.
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

test('삭제 확인 창이 떠 있으면 y/n/a가 창 뒤의 승인 카드에 닿지 않는다 (#158)', async ({ page }) => {
  const sessionId = await sessionWithApproval(page)

  await page.getByTestId(`session-menu-${sessionId}`).click()
  await page.getByTestId(`delete-session-${sessionId}`).click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  // 확인하려는 뜻으로 누른 y — 창 뒤의 명령을 허용하면 안 된다
  for (const k of ['y', 'n', 'a']) await page.keyboard.press(k)
  await page.waitForTimeout(200)
  expect(await answers(page)).toEqual([])

  // 창을 닫으면 카드는 그대로 남아 있고, 이제는 y가 통한다
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

test('새 세션 창의 입력칸 안에서 누른 ↑/↓는 지난 대화를 고르지 않는다 (#181)', async ({ page }) => {
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
  // 새 대화가 그대로 골라져 있다 — 칸 밖에서의 화살표는 여전히 목록을 고른다
  await expect(page.getByTestId('past-new')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('past-ext-0')).not.toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('create-session-confirm').focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('past-ext-0')).toHaveAttribute('aria-pressed', 'true')
})

test('명령 창에서 조합을 끝내는 Enter는 명령을 저장하지 않는다 (#181)', async ({ page }) => {
  await freshSession(page)
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add-name').fill('데브 서')
  // IME가 조합을 끝내며 보내는 Enter — isComposing이 참이다
  await page.getByTestId('run-add-name').evaluate((el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })),
  )
  await page.waitForTimeout(100)
  await expect(page.getByTestId('run-command-0')).toHaveCount(0)
  await page.getByTestId('run-add-name').fill('데브 서버')
  await page.getByTestId('run-add-name').press('Enter')
  await expect(page.getByTestId('run-command-0')).toContainText('데브 서버')
})

test('오버레이가 열려 있어도 옆 터미널의 Esc는 터미널로, 위에 뜬 설정 창의 Esc는 설정 창으로 간다 (#181)', async ({ page }) => {
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

  // 설정 창은 ⌘,로 열린다 — 포커스는 터미널 밖(여기서는 문서)에 있다
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await expect(page.getByTestId('settings')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).toHaveCount(0)
  await expect(page.getByTestId('overlay')).toBeVisible()
})
