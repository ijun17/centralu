import { test, expect, type Page } from '@playwright/test'
import { newSession, setup as setupProjects } from './fixtures/control.js'

/**
 * A native subagent's steps under the card that launched it (#222).
 *
 * The conversation is the parent's: the subagent's calls and words never become rows of it (#98). They are kept by
 * the host, read only when the person opens the launch card's steps, and drawn there with the conversation's own
 * rows. Driven through the mock platform, which keeps the steps the way the host does (`subagent_event` → a launch
 * card's rows, `messages.subagent` → `loadSubagentMessages`).
 */

/** The project alpha with one session on screen, already asked something */
async function setup(page: Page) {
  await setupProjects(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'look into the boundaries test')
}

/** An event for the session on screen, as the host would send it */
async function emit(page: Page, event: Record<string, unknown>) {
  await page.evaluate((e) => {
    const id = (window as any).__store.getState().focusedSessionId
    const withSession = (x: Record<string, unknown>) => ({ ...x, sessionId: id })
    ;(window as any).__mock.emit(withSession({ ...e, ...(e.step ? { step: withSession(e.step as Record<string, unknown>) } : {}) }))
  }, event)
}

const AGENT = 'toolu_agent_launch'
const step = (s: Record<string, unknown>) => ({ type: 'subagent_event', parentCallId: AGENT, step: s })

test('a subagent\'s steps stay out of the conversation and open under its launch card', async ({ page }) => {
  await setup(page)
  await emit(page, { type: 'tool_call', callId: AGENT, summary: { tool: 'Agent', title: 'Research the boundaries', paths: [] } })
  await emit(page, { type: 'tool_output_delta', callId: AGENT, text: 'Bash: rg boundaries\n' })
  await emit(page, step({ type: 'reasoning_delta', text: 'Start from the test file.' }))
  await emit(page, step({ type: 'tool_call', callId: 'toolu_sub', summary: { tool: 'Bash', title: 'rg boundaries', paths: [] } }))
  await emit(page, step({ type: 'tool_result', callId: 'toolu_sub', ok: true, summary: 'tooling/boundaries.test.ts' }))
  await emit(page, step({ type: 'message_delta', role: 'assistant', text: 'The boundaries test holds.' }))

  const card = page.getByTestId('tool-card').filter({ hasText: 'Research the boundaries' })
  // The conversation holds the launch card alone — not the subagent's Bash, not its words
  await expect(card).toBeVisible()
  await expect(page.getByTestId('tool-card')).toHaveCount(1)
  await expect(page.getByText('The boundaries test holds.')).toHaveCount(0)
  // The running agent's one line per step is on the card once it is opened (owner, 2026-10-18: output only when open)
  await expect(card.getByTestId('tool-card-live')).toHaveCount(0)
  await card.getByTestId('tool-card-toggle').first().click()
  await expect(card.getByTestId('tool-card-live')).toContainText('Bash: rg boundaries')

  // Collapsed, and nothing read until it is opened
  const toggle = card.getByTestId('subagent-steps-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(card.getByTestId('subagent-steps-list')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.subagentReads)).toBe(0)

  await toggle.click()
  const list = card.getByTestId('subagent-steps-list')
  await expect(list.getByTestId('msg-reasoning')).toContainText('Start from the test file.')
  const sub = list.getByTestId('tool-card').filter({ hasText: 'rg boundaries' })
  await expect(sub).toBeVisible()
  await expect(sub.getByTestId('tool-card-output')).toHaveCount(0)
  await sub.getByTestId('tool-card-toggle').click()
  await expect(sub.getByTestId('tool-card-output')).toContainText('tooling/boundaries.test.ts')
  await expect(list.getByTestId('msg-assistant')).toContainText('The boundaries test holds.')
  expect(await page.evaluate(() => (window as any).__mock.subagentReads)).toBe(1)

  // A later step joins the open card live, still not the conversation
  await emit(page, step({ type: 'message_delta', role: 'assistant', text: 'One more thing checked.' }))
  await expect(list.getByTestId('msg-assistant')).toHaveCount(2)
  await expect(list.getByTestId('msg-assistant').last()).toContainText('One more thing checked.')
  await expect(page.getByTestId('msg-assistant').filter({ hasText: 'One more thing checked.' })).toHaveCount(1)

  // Closing it puts it away; opening it again does not read it again
  await toggle.click()
  await expect(card.getByTestId('subagent-steps-list')).toHaveCount(0)
  await toggle.click()
  await expect(list.getByTestId('msg-assistant')).toHaveCount(2)
  expect(await page.evaluate(() => (window as any).__mock.subagentReads)).toBe(1)
})

test('only a launch card offers steps, and one with none recorded says so', async ({ page }) => {
  await setup(page)
  await emit(page, { type: 'tool_call', callId: 'toolu_bash', summary: { tool: 'Bash', title: 'git status', paths: [] } })
  await emit(page, { type: 'tool_call', callId: 'toolu_old_agent', summary: { tool: 'Agent', title: 'An agent from before', paths: [] } })
  await emit(page, { type: 'tool_result', callId: 'toolu_old_agent', ok: true, summary: '3 tool uses · 12s\n\nDone.' })

  await expect(page.getByTestId('tool-card').filter({ hasText: 'git status' }).getByTestId('subagent-steps-toggle')).toHaveCount(0)
  const old = page.getByTestId('tool-card').filter({ hasText: 'An agent from before' })
  await old.getByTestId('subagent-steps-toggle').click()
  await expect(old.getByTestId('subagent-steps-empty')).toBeVisible()
})

/**
 * #418: a session's subagent steps go to the session archive without the session, from Settings → Archive, where what they take is
 * shown; the launch card then says where they went, and they come back under it or leave for good from the session archive.
 */
test("a session's subagent steps go to the session archive and back from Settings, and the card says where they are", async ({ page }) => {
  await setup(page)
  const sessionId = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  await emit(page, { type: 'tool_call', callId: AGENT, summary: { tool: 'Agent', title: 'Research the boundaries', paths: [] } })
  await emit(page, step({ type: 'message_delta', role: 'assistant', text: 'The boundaries test holds.' }))
  await emit(page, step({ type: 'tool_call', callId: 'toolu_sub', summary: { tool: 'Bash', title: 'rg boundaries', paths: [] } }))
  await emit(page, { type: 'turn_complete' })

  const card = page.getByTestId('tool-card').filter({ hasText: 'Research the boundaries' })
  await card.getByTestId('subagent-steps-toggle').click()
  const list = card.getByTestId('subagent-steps-list')
  await expect(list.getByTestId('msg-assistant')).toContainText('The boundaries test holds.')

  const openArchive = async () => {
    await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
    await page.getByTestId('settings-tab-archive').click()
    await expect(page.getByTestId('settings-trash')).toBeVisible()
  }
  const closeSettings = () => page.evaluate(() => (window as any).__store.getState().toggleSettings(false))

  // What the session's steps take, and the way to move them
  await openArchive()
  await expect(page.getByTestId(`subagent-steps-take-${sessionId}`)).toContainText('1 run · 2 steps ·')
  // Archived at once (#1512): no question, and the toast offers Undo
  await page.getByTestId(`subagent-steps-move-${sessionId}`).click()
  await expect(page.getByTestId('subagent-steps-confirm')).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('subagent step')
  await expect(page.getByTestId('toast-action')).toHaveText('Undo')
  await expect(page.getByTestId('subagent-steps-held-empty')).toBeVisible()
  const row = page.getByTestId(`trash-steps-row-${sessionId}`)
  await expect(row).toContainText('Subagent steps of')
  await expect(page.getByTestId(`trash-steps-holds-${sessionId}`)).toContainText('1 run · 2 steps ·')
  await expect(page.getByTestId('trash-total')).toContainText('0 sessions · subagent steps of 1 session')

  // The session and its conversation stayed; the open card says where its steps went
  await closeSettings()
  await expect(page.getByTestId(`session-row-${sessionId}`)).toBeVisible()
  await expect(card.getByTestId('subagent-steps-trashed')).toHaveText('The steps were archived. Settings → Archive restores them.')
  await expect(list.getByTestId('msg-assistant')).toHaveCount(0)

  // Restored, they are under the card again
  await openArchive()
  await page.getByTestId(`trash-steps-restore-${sessionId}`).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId(`subagent-steps-take-${sessionId}`)).toContainText('1 run · 2 steps ·')
  await closeSettings()
  await expect(list.getByTestId('msg-assistant')).toContainText('The boundaries test holds.')
  await expect(card.getByTestId('subagent-steps-trashed')).toHaveCount(0)

  // Moved again; then another window moves a later step there, after this screen read the session archive
  await openArchive()
  await page.getByTestId(`subagent-steps-move-${sessionId}`).click()
  await expect(page.getByTestId(`trash-steps-holds-${sessionId}`)).toContainText('1 run · 2 steps ·')
  await emit(page, { ...step({ type: 'message_delta', role: 'assistant', text: 'One more thing.' }), parentCallId: 'toolu_later' })
  await page.evaluate((id: string) => (window as any).__mock.trash.trashSubagentSteps(id), sessionId)

  // Emptying the session archive deletes what this screen listed, never the step moved since (#418 review)
  await page.getByTestId('trash-empty').click()
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId(`trash-steps-holds-${sessionId}`)).toContainText('1 run · 1 step ·')

  // Deleted for good from its row: the session still stands
  await page.getByTestId(`trash-steps-purge-${sessionId}`).click()
  await expect(page.getByTestId('trash-confirm')).toContainText('the session and its conversation stay')
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await closeSettings()
  await expect(page.getByTestId(`session-row-${sessionId}`)).toBeVisible()
})
