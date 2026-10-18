import { test, expect, type Page } from '@playwright/test'
import { setup } from './fixtures/control.js'
import { startSession } from './fixtures/new-session.js'

/**
 * A new session's empty screen (SessionStart): the project menu's New session starts a session at once, and before its first message
 * the screen offers the other tool and the project's past conversations of this tool. Picking a past conversation
 * resumes it as a new session and removes the empty one; one already open is a jump to it; picking the other tool
 * switches this same session.
 */

const PAST = (tool: string, externalId: string, title: string) => ({
  externalId,
  tool,
  title,
  updatedAt: Date.now() - 3600_000,
  createdAt: null,
  branch: 'main',
  imported: false,
  importedAs: null,
})

async function seed(page: Page, sessions: Record<string, unknown>[], history: Record<string, { role: string; text: string }[]> = {}) {
  await page.evaluate(
    ({ sessions, history }) => {
      const m = (window as any).__mock
      m.externalSessions = { supported: true, sessions }
      for (const [id, msgs] of Object.entries(history)) m.externalHistory.set(id, msgs)
    },
    { sessions, history },
  )
}

/** Every toast the screen raised from here on */
async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__toasts = []
    w.__store.setState({ toast: null })
    w.__store.subscribe((s: { toast: string | null }, prev: { toast: string | null }) => {
      if (s.toast && s.toast !== prev.toast) w.__toasts.push(s.toast)
    })
  })
}
const toasts = (page: Page) => page.evaluate(() => (window as any).__toasts as string[])

const focused = (page: Page) => page.evaluate(() => (window as any).__store.getState().focusedSessionId as string | null)
const stored = (page: Page, id: string) => page.evaluate((s) => (window as any).__store.getState().sessions[s] ?? null, id)
const inMock = (page: Page, id: string) => page.evaluate((s) => (window as any).__mock.sessions.has(s) as boolean, id)

/** The project menu's New session, then the empty session it made */
async function plus(page: Page): Promise<string> {
  const id = await startSession(page, 'alpha')
  await expect(page.getByTestId('session-start')).toBeVisible()
  return id
}

test("the empty screen lists the project's past conversations, and picking one resumes it in place of the empty session", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seed(page, [PAST('claude', 'ext-1', "yesterday's refactor"), PAST('codex', 'ext-x', 'a codex thread')], {
    'ext-1': [
      { role: 'user', text: 'split this module up' },
      { role: 'assistant', text: 'Split into three files' },
    ],
  })
  await recordToasts(page)
  const empty = await plus(page)
  const list = page.getByTestId('past-conversations')
  await expect(list.getByTestId('past-conversation-ext-1')).toContainText("yesterday's refactor")
  // Only this tool's conversations
  await expect(list.getByTestId('past-conversation-ext-x')).toHaveCount(0)

  await list.getByTestId('past-conversation-ext-1').click()
  await expect.poll(() => focused(page)).not.toBe(empty)
  const resumed = (await focused(page))!
  expect(await page.evaluate(() => (window as any).__mock.lastCreateParams)).toMatchObject({
    tool: 'claude',
    resumeExternalId: 'ext-1',
    importHistory: true,
  })
  await expect(page.getByTestId('msg-user')).toContainText('split this module up')
  // The empty one held nothing: it is gone from the host and the screen, without a word about the trash
  await expect.poll(() => inMock(page, empty)).toBe(false)
  await expect.poll(() => stored(page, empty)).toBeNull()
  expect(await stored(page, resumed)).not.toBeNull()
  expect(await toasts(page)).toEqual([])
  // A session with history offers nothing to start from
  await expect(page.getByTestId('session-start')).toHaveCount(0)
})

test('a past conversation already open is a jump to its session, and the empty one goes', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seed(page, [PAST('claude', 'ext-1', "yesterday's work")], { 'ext-1': [{ role: 'user', text: "yesterday's work" }] })
  await plus(page)
  await page.getByTestId('past-conversation-ext-1').click()
  await expect(page.getByTestId('msg-user')).toContainText("yesterday's work")
  const open = (await focused(page))!
  const count = await page.evaluate(() => (window as any).__mock.sessions.size as number)

  await recordToasts(page)
  const empty = await plus(page)
  const row = page.getByTestId('past-conversation-ext-1')
  await expect(row).toContainText('Already open')
  await row.click()
  await expect.poll(() => focused(page)).toBe(open)
  await expect.poll(() => inMock(page, empty)).toBe(false)
  // No second copy was made: the only change is the empty session gone
  expect(await page.evaluate(() => (window as any).__mock.sessions.size as number)).toBe(count)
  expect(await toasts(page)).toEqual([])
})

test('the tool buttons switch the same session, keep a typed draft, and read that tool\'s past conversations', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seed(page, [PAST('claude', 'ext-1', 'a claude thread'), PAST('codex', 'ext-x', 'a codex thread')])
  const id = await plus(page)
  const count = await page.evaluate(() => (window as any).__mock.sessions.size as number)
  await expect(page.getByTestId('session-start-tool-claude')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('past-conversation-ext-1')).toBeVisible()
  await page.getByTestId('prompt-input').fill('half a thought')

  await page.getByTestId('session-start-tool-codex').click()
  await expect(page.getByTestId('session-start-tool-codex')).toHaveAttribute('aria-checked', 'true')
  expect(await focused(page)).toBe(id)
  expect((await stored(page, id))?.tool).toBe('codex')
  expect(await page.evaluate(() => (window as any).__mock.sessions.size as number)).toBe(count)
  await expect(page.getByTestId('prompt-input')).toHaveValue('half a thought')
  await expect(page.getByTestId('past-conversation-ext-x')).toBeVisible()
  await expect(page.getByTestId('past-conversation-ext-1')).toHaveCount(0)
})

for (const { status, reason } of [
  { status: { installed: false, loggedIn: false }, reason: 'Codex is not installed' },
  { status: { installed: true, loggedIn: false }, reason: 'Codex needs a login' },
]) {
  test(`a tool that cannot run here is dimmed with its reason: ${reason}`, async ({ page }) => {
    await setup(page, { projects: ['/tmp/alpha'] })
    await page.evaluate((st) => {
      const m = (window as any).__mock
      m.detected = m.detected.map((t: { name: string }) => (t.name === 'codex' ? { ...t, ...st } : t))
    }, status)
    const id = await plus(page)
    const codex = page.getByTestId('session-start-tool-codex')
    await expect(codex).toBeDisabled()
    await expect(codex).toHaveAttribute('title', reason)
    await expect(page.getByTestId('session-start-tool-claude')).toBeEnabled()
    expect((await stored(page, id))?.tool).toBe('claude')
  })
}

test('the past conversations show their shape while they are read, for each tool picked', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seed(page, [PAST('claude', 'ext-1', 'a claude thread'), PAST('codex', 'ext-x', 'a codex thread')])
  await page.evaluate(() => ((window as any).__mock.holdExternalSessions = true))
  await plus(page)
  await expect(page.getByTestId('past-conversations-loading')).toBeVisible()
  await expect(page.getByTestId('past-conversations')).toHaveCount(0)
  await page.evaluate(() => (window as any).__mock.releaseExternalSessions())
  await expect(page.getByTestId('past-conversation-ext-1')).toBeVisible()
  await expect(page.getByTestId('past-conversations-loading')).toHaveCount(0)

  // Read again for the other tool: the shape stands there meanwhile, not the last tool's list
  await page.evaluate(() => ((window as any).__mock.holdExternalSessions = true))
  await page.getByTestId('session-start-tool-codex').click()
  await expect(page.getByTestId('past-conversations-loading')).toBeVisible()
  await expect(page.getByTestId('past-conversation-ext-1')).toHaveCount(0)
  await page.evaluate(() => (window as any).__mock.releaseExternalSessions())
  await expect(page.getByTestId('past-conversation-ext-x')).toBeVisible()
})
