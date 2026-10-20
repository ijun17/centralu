import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * A session that runs an older agent CLI than the one installed (#297), driven through the mock platform, which keeps
 * the installed versions the way the host does and restarts an idle session on the installed one the way the host
 * does (`applyVersions`: idle by the shared rule, busy otherwise).
 *
 * A function because it runs in Chromium and in WebKit (agent-versions-webkit.spec.ts) — the desktop app is
 * WKWebView, and the notice shares the header's one row with the name and the buttons.
 */

async function emit(page: Page, sessionId: string, event: Record<string, unknown>) {
  await page.evaluate(([sid, e]) => (window as any).__mock.emit({ ...(e as object), sessionId: sid }), [sessionId, event] as const)
}

async function installed(page: Page, versions: Record<string, string | null>) {
  await page.evaluate((v) => (window as any).__mock.setInstalledVersions(v), versions)
}

/** One session whose process says it runs Claude Code 2.1.282 */
async function start(page: Page): Promise<string> {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  await emit(page, id, { type: 'agent_version', version: '2.1.282' })
  return id
}

export function agentVersionsTests(): void {
  test.describe('agent CLI versions (#297)', () => {
    test('the header says quietly when the installed CLI is newer than the one the session runs, and nothing otherwise', async ({ page }) => {
      const id = await start(page)
      const notice = page.getByTestId('agent-version-notice')
      // Same version installed: nothing to say
      await installed(page, { claude: '2.1.282' })
      await expect(notice).toHaveCount(0)

      await installed(page, { claude: '2.1.290' })
      await expect(page.getByTestId('agent-version-text')).toHaveText('Claude Code 2.1.290 installed — this session runs 2.1.282')
      // It shares the header's row: the session's name and the restart button are still whole and on it
      const header = await page.getByTestId('session-name').boundingBox()
      const text = await page.getByTestId('agent-version-text').boundingBox()
      expect(Math.abs(text!.y + text!.height / 2 - (header!.y + header!.height / 2))).toBeLessThan(4)
      await expect(page.getByTestId('restart-session')).toBeVisible()

      // Unknown on the session's side says nothing either (a process that never reported)
      await page.evaluate((sid) => (window as any).__store.setState((s: any) => ({ sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], agentVersion: null } } })), id)
      await expect(notice).toHaveCount(0)
    })

    test('"Update idle sessions" restarts the idle one on the installed CLI, says so in the conversation, and leaves a busy one', async ({ page }) => {
      const id = await start(page)
      await installed(page, { claude: '2.1.290' })
      await expect(page.getByTestId('agent-version-notice')).toBeVisible()

      // Working: it keeps its version and the line
      await emit(page, id, { type: 'message_delta', role: 'assistant', text: 'Working on it' })
      await page.getByTestId('agent-version-apply').click()
      await expect(page.getByTestId('toast')).toContainText('Nothing restarted: 1 session busy keeps its version for now')
      await expect(page.getByTestId('agent-version-notice')).toBeVisible()

      // The turn ends: now it moves
      await emit(page, id, { type: 'turn_complete' })
      await page.getByTestId('agent-version-apply').click()
      await expect(page.getByTestId('toast')).toContainText('Restarted 1 session on the installed version')
      await expect(page.getByTestId('agent-version-notice')).toHaveCount(0)
      await expect(page.getByTestId('msg-mark').last()).toContainText('Claude Code restarted on 2.1.290 (was 2.1.282). The conversation continues.')
    })

    test('Settings lists the installed CLIs, and moving idle sessions by itself is on by default and can be turned off', async ({ page }) => {
      await start(page)
      await installed(page, { claude: '2.1.290', codex: null })
      await page.getByTestId('open-settings').click()
      await page.getByTestId('settings-tab-updates').click()
      await expect(page.getByTestId('agent-versions-installed')).toHaveText('Installed: Claude Code 2.1.290')
      const box = page.getByTestId('agent-versions-auto-apply')
      await expect(box).toBeChecked()

      await box.uncheck()
      await expect(box).not.toBeChecked()
      // The host holds it (here, the mock): what it answers is what the screen shows
      expect(await page.evaluate(() => (window as any).__mock.agentVersions.autoApply)).toBe(false)
      await box.check()
      expect(await page.evaluate(() => (window as any).__mock.agentVersions.autoApply)).toBe(true)
      // The header's tooltip says what the setting does for this session
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('agent-version-text')).toHaveAttribute('title', /restarts on 2\.1\.290 by itself once it is idle/)
    })
  })
}
