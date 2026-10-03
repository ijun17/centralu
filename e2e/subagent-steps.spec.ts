import { test, expect, type Page } from '@playwright/test'

/**
 * A native subagent's steps under the card that launched it (#222).
 *
 * The conversation is the parent's: the subagent's calls and words never become rows of it (#98). They are kept by
 * the host, read only when the person opens the launch card's steps, and drawn there with the conversation's own
 * rows. Driven through the mock platform, which keeps the steps the way the host does (`subagent_event` → a launch
 * card's rows, `messages.subagent` → `loadSubagentMessages`).
 */

async function setup(page: Page) {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('prompt-input').fill('look into the boundaries test')
  await page.getByTestId('prompt-input').press('Enter')
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
  await emit(page, { type: 'tool_call', callId: AGENT, summary: { tool: 'Agent', title: 'Research the boundaries', readOnly: true, paths: [] } })
  await emit(page, { type: 'tool_output_delta', callId: AGENT, text: 'Bash: rg boundaries\n' })
  await emit(page, step({ type: 'reasoning_delta', text: 'Start from the test file.' }))
  await emit(page, step({ type: 'tool_call', callId: 'toolu_sub', summary: { tool: 'Bash', title: 'rg boundaries', readOnly: false, paths: [] } }))
  await emit(page, step({ type: 'tool_result', callId: 'toolu_sub', ok: true, summary: 'tooling/boundaries.test.ts' }))
  await emit(page, step({ type: 'message_delta', role: 'assistant', text: 'The boundaries test holds.' }))

  const card = page.getByTestId('tool-card').filter({ hasText: 'Research the boundaries' })
  // The conversation holds the launch card alone — not the subagent's Bash, not its words
  await expect(card).toBeVisible()
  await expect(page.getByTestId('tool-card')).toHaveCount(1)
  await expect(page.getByText('The boundaries test holds.')).toHaveCount(0)
  // The running agent's one line per step is still on the card
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
  await emit(page, { type: 'tool_call', callId: 'toolu_bash', summary: { tool: 'Bash', title: 'git status', readOnly: false, paths: [] } })
  await emit(page, { type: 'tool_call', callId: 'toolu_old_agent', summary: { tool: 'Agent', title: 'An agent from before', readOnly: true, paths: [] } })
  await emit(page, { type: 'tool_result', callId: 'toolu_old_agent', ok: true, summary: '3 tool uses · 12s\n\nDone.' })

  await expect(page.getByTestId('tool-card').filter({ hasText: 'git status' }).getByTestId('subagent-steps-toggle')).toHaveCount(0)
  const old = page.getByTestId('tool-card').filter({ hasText: 'An agent from before' })
  await old.getByTestId('subagent-steps-toggle').click()
  await expect(old.getByTestId('subagent-steps-empty')).toBeVisible()
})
