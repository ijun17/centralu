import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * What the agent tools tell the person, on screen (#304), driven through the mock platform, which records the new
 * markers and the switch the way the host does.
 *
 * The texts are the measured ones: Claude Code's `/clear` (`conversation_reset {trigger: 'clear'}`) and a
 * `UserPromptSubmit` hook's block reason (`system/informational`, CLI 2.1.289), and Codex's configuration warning
 * (codex-cli 0.160.0), which arrives on every start and is kept once per session.
 *
 * A function because it runs in Chromium and in WebKit (agent-notices-webkit.spec.ts) — the desktop app is WKWebView,
 * and a long notice has to wrap inside the conversation instead of widening it.
 */

const HOOK =
  'UserPromptSubmit operation blocked by hook:\n[node /tmp/cc304/block-hook.mjs]: Prompts containing BLOCKME are not allowed here.\n\nOriginal prompt: BLOCKME reply with ok'
const CONFIG =
  'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n' +
  '  user (/Users/someone/.codex/config.toml): `mcp_servers.plane.type` is ignored.\n' +
  '  user (/Users/someone/.codex/config.toml): `mcp_servers.playwright.type` is ignored.'

async function emit(page: Page, sessionId: string, event: Record<string, unknown>) {
  await page.evaluate(([sid, e]) => (window as any).__mock.emit({ ...(e as object), sessionId: sid }), [sessionId, event] as const)
}

/**
 * No toast went up. Checked once, not polled: a toast leaves by itself after 2.5 seconds, so a retrying
 * `toHaveCount(0)` passes by waiting it out (it did, with the toast suppression removed).
 */
async function expectNoToast(page: Page) {
  expect(await page.evaluate(() => (window as any).__store.getState().toast)).toBeNull()
  expect(await page.getByTestId('toast').count()).toBe(0)
}

/** Reopens the session from the record, as after an app restart: nothing in memory, the history read back */
async function reopen(page: Page, sessionId: string) {
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, sessionId)
}

export function agentNoticesTests(): void {
  test.describe('what the agent tools tell the person (#304)', () => {
    test('/clear leaves a line and empties the context gauge; it is still there after reopening', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const id = await newSession(page, 'alpha')
      await emit(page, id, { type: 'context_update', used: 15967, window: 200000, exactness: 'exact' })
      await expect(page.getByTestId('context-gauge')).toContainText('8%')

      await emit(page, id, { type: 'conversation_reset', trigger: 'clear' })
      const marks = page.getByTestId('msg-mark')
      await expect(marks).toHaveText(['Conversation cleared — the agent remembers nothing above this line'])
      await expect(page.getByTestId('context-gauge')).toContainText('—')
      // The tool reports the new conversation's size when the command's turn ends (measured: 14,093)
      await emit(page, id, { type: 'context_update', used: 14093, window: 200000, exactness: 'exact' })
      await expect(page.getByTestId('context-gauge')).toContainText('7%')

      await reopen(page, id)
      await expect(marks).toHaveText(['Conversation cleared — the agent remembers nothing above this line'])
    })

    test("a hook's block reason and a configuration warning are one quiet line each, the repeated warning once", async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const id = await newSession(page, 'alpha')
      await emit(page, id, { type: 'notice', level: 'warning', text: HOOK })
      // Codex sends the same warning as configWarning and as warning, and again on every start
      await emit(page, id, { type: 'notice', level: 'warning', text: CONFIG, oncePerSession: true })
      await emit(page, id, { type: 'notice', level: 'warning', text: CONFIG, oncePerSession: true })

      const marks = page.getByTestId('msg-mark')
      await expect(marks).toHaveCount(2)
      await expect(marks.nth(0)).toContainText('Prompts containing BLOCKME are not allowed here.')
      await expect(marks.nth(1)).toContainText('`mcp_servers.plane.type` is ignored.')
      // Nothing interrupts: no toast, and the long line wraps instead of widening the conversation
      await expectNoToast(page)
      const stream = page.getByTestId('chat-stream')
      expect(await stream.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

      await reopen(page, id)
      await expect(marks).toHaveCount(2)
    })

    test('a model switch the tool made changes the model shown, without a toast; its notice says why', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const id = await newSession(page, 'alpha')
      await emit(page, id, {
        type: 'notice',
        level: 'warning',
        text: 'claude-opus-4-8 declined to answer, so Claude Code switched this session to claude-sonnet-4-6',
      })
      await emit(page, id, { type: 'settings_changed', model: 'claude-sonnet-4-6', effort: null, verbosity: null, serviceTier: null, by: 'tool' })
      await expectNoToast(page)

      await expect(page.getByTestId('settings-open')).toContainText('claude-sonnet-4-6')
      await expect(page.getByTestId('msg-mark')).toContainText(['switched this session to claude-sonnet-4-6'])
    })
  })
}
