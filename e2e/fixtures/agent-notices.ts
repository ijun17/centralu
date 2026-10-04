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

/** The configuration warning as the host now sends it (#342): who, what kind, whose, and a plain explanation */
const CONFIG_READABLE = {
  type: 'notice',
  level: 'warning',
  text: CONFIG,
  oncePerSession: true,
  from: 'Codex',
  label: 'config warning',
  audience: 'you',
  summary: 'Codex ignored 2 settings in `~/.codex/config.toml`',
  items: ['mcp_servers.plane.type', 'mcp_servers.playwright.type'],
  hint: 'Codex already runs without them; removing them from the file only silences this notice.',
}

/** The full-history deprecation the owner saw (codex-cli 0.160.0), addressed to Centralu (#342) */
const HYDRATION = {
  type: 'notice',
  level: 'warning',
  text: 'Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.',
  oncePerSession: true,
  from: 'Codex',
  label: 'deprecation',
  audience: 'centralu',
  summary: 'Codex says Centralu loads thread history in an outdated way',
  hint: 'Nothing to do on your side; Centralu will switch to the paginated API (#342).',
}

/** The computed colour of a token, to compare a line's colour with in either theme */
async function tokenColor(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${n})`
    document.body.appendChild(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  }, name)
}

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

    test("Codex's notices say who speaks, what kind, and whose they are; Codex's words open on demand (#342)", async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const id = await newSession(page, 'alpha')
      await emit(page, id, CONFIG_READABLE)
      await emit(page, id, CONFIG_READABLE)
      await emit(page, id, HYDRATION)
      await emit(page, id, { type: 'notice', level: 'warning', text: 'Exceeded skills context budget.', from: 'Codex', label: 'warning' })

      const marks = page.getByTestId('msg-mark')
      await expect(marks).toHaveCount(3)
      const [config, hydration, unknown] = [marks.nth(0), marks.nth(1), marks.nth(2)]

      await expect(config.getByTestId('notice-head')).toHaveText('Codex · config warning')
      await expect(config.getByTestId('notice-audience')).toHaveText('for you')
      await expect(config.getByTestId('notice-summary')).toHaveText('Codex ignored 2 settings in ~/.codex/config.toml')
      // One setting per line
      const items = config.getByTestId('notice-items').locator('li')
      await expect(items).toHaveText(['mcp_servers.plane.type', 'mcp_servers.playwright.type'])
      const [first, second] = await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))
      expect(second!).toBeGreaterThan(first!)
      await expect(config.getByTestId('notice-hint')).toHaveText(
        'Codex already runs without them; removing them from the file only silences this notice.',
      )
      // Codex's own words are there on demand, not in the way
      await expect(config.getByTestId('notice-original')).toHaveCount(0)
      await config.getByTestId('notice-original-toggle').click()
      await expect(config.getByTestId('notice-original-toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(config.getByTestId('notice-original')).toContainText('`mcp_servers.plane.type` is ignored.')
      await config.getByTestId('notice-original-toggle').click()
      await expect(config.getByTestId('notice-original')).toHaveCount(0)

      await expect(hydration.getByTestId('notice-head')).toHaveText('Codex · deprecation')
      await expect(hydration.getByTestId('notice-audience')).toHaveText('for Centralu')
      await expect(hydration.getByTestId('notice-summary')).toHaveText('Codex says Centralu loads thread history in an outdated way')
      await expect(hydration.getByTestId('notice-hint')).toHaveText('Nothing to do on your side; Centralu will switch to the paginated API (#342).')
      await expect(hydration).not.toContainText('excludeTurns')

      // A notice Centralu does not know: Codex's text as it is, with the kind label, nothing to open
      await expect(unknown).toHaveText('Codex · warning — Exceeded skills context budget.')
      await expect(unknown.getByTestId('notice-original-toggle')).toHaveCount(0)

      // Quiet: no toast, nothing wider than the conversation
      await expectNoToast(page)
      const stream = page.getByTestId('chat-stream')
      expect(await stream.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

      // "for you" is the secondary ink and "for Centralu" the faint one, in the dark and the light theme alike
      const audienceColors = async () => ({
        you: await config.getByTestId('notice-audience').evaluate((el) => getComputedStyle(el).color),
        centralu: await hydration.getByTestId('notice-audience').evaluate((el) => getComputedStyle(el).color),
        muted: await tokenColor(page, '--color-ink-muted'),
        faint: await tokenColor(page, '--color-ink-faint'),
      })
      const dark = await audienceColors()
      expect(dark.you).toBe(dark.muted)
      expect(dark.centralu).toBe(dark.faint)
      await page.getByTestId('open-settings').click()
      await page.getByTestId('settings-tab-appearance').click()
      await page.getByTestId('settings-theme-mode-light').click()
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
      await page.keyboard.press('Escape')
      const light = await audienceColors()
      expect(light.you).toBe(light.muted)
      expect(light.centralu).toBe(light.faint)
      expect(light.you).not.toBe(dark.you)

      await reopen(page, id)
      await expect(marks).toHaveCount(3)
      await expect(marks.nth(0).getByTestId('notice-summary')).toHaveText('Codex ignored 2 settings in ~/.codex/config.toml')
      await expect(marks.nth(1).getByTestId('notice-audience')).toHaveText('for Centralu')
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
