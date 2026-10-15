import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * An orchestrator proposal (an MCP server or a skill) waits on the person like an approval does (#703).
 *
 * The card stands on the orchestrator's own screen, so the scenarios put the person on another session and check that
 * the wait is still seen: the orchestrator's sidebar row, the count, the waiting list, and the jump to the card. The
 * first one is the race the owner met: the orchestrator's `tool_call` reaches the screen **before** the host saves the
 * proposal, and the card must still appear without a reload.
 *
 * A function, like the other fixtures, because it runs in Chromium and in WebKit (the desktop app is WKWebView).
 */

type Mock = {
  emit(e: Record<string, unknown>): void
  saveProposal(spec: Record<string, unknown>): void
}

/** The orchestrator has a conversation, and the person is looking at another session */
async function orchestratorAndElsewhere(page: Page) {
  await setup(page, ['/tmp/alpha'])
  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('msg-user').first()).toBeVisible()
  const orc = await page.evaluate(() => (window as any).__store.getState().orchestratorId as string)
  const other = await newSession(page, 'alpha')
  expect(other).not.toBe(orc)
  return { orc, other }
}

/** The order the host really has: the call starts and its event goes out, then the proposal is saved and announced */
async function proposeAfterToolCall(page: Page, orc: string, spec: Record<string, unknown>, tool: string) {
  await page.evaluate(
    ({ sid, t }) =>
      ((window as any).__mock as Mock).emit({
        type: 'tool_call', sessionId: sid, callId: `call-${t}`, summary: { tool: t, title: t, readOnly: true, paths: [] },
      }),
    { sid: orc, t: tool },
  )
  // The screen has read the lists in response to the tool_call, if it ever does, and they are still empty; nothing is saved yet
  await expect
    .poll(() => page.evaluate(() => { const st = (window as any).__store.getState(); return st.mcpProposals.length + st.skillProposals.length }))
    .toBe(0)
  await page.evaluate((s) => ((window as any).__mock as Mock).saveProposal(s), spec)
}

export function proposalWaitingTests() {
  test('a proposal saved after its tool_call shows the card without a reload', async ({ page }) => {
    const { orc } = await orchestratorAndElsewhere(page)
    await proposeAfterToolCall(
      page, orc, { mcp: { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: 'drive a browser' } },
      'mcp__centralu__propose_mcp_server',
    )

    await page.getByTestId('orchestrator-button').click()
    await expect(page.getByTestId('mcp-proposal-playwright')).toBeVisible()
    await expect(page.getByTestId('mcp-proposal-playwright')).toContainText('drive a browser')
  })

  test('a skill proposal saved after its tool_call shows the card without a reload', async ({ page }) => {
    const { orc } = await orchestratorAndElsewhere(page)
    await proposeAfterToolCall(
      page, orc, { skill: { name: 'weekly-report', content: 'Every Friday, write the summary.' } },
      'mcp__centralu__propose_skill',
    )

    await page.getByTestId('orchestrator-button').click()
    await expect(page.getByTestId('skill-proposal-weekly-report')).toBeVisible()
  })

  test('from another session the wait is seen on the orchestrator row, in the count and in the waiting list, and the list leads to the card', async ({ page }) => {
    const { orc, other } = await orchestratorAndElsewhere(page)
    await expect(page.getByTestId('orchestrator-proposal-waiting')).toHaveCount(0)
    await expect(page.getByTestId('count-waiting')).toContainText('0')

    await proposeAfterToolCall(
      page, orc, { mcp: { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] } },
      'mcp__centralu__propose_mcp_server',
    )

    // Still on the other session: the orchestrator's row says something waits, like a session waiting on an approval
    expect(await page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(other)
    await expect(page.getByTestId('orchestrator-proposal-waiting')).toBeVisible()
    await expect(page.getByTestId('orchestrator-proposal-waiting').getByTestId('dot-waiting_approval')).toBeVisible()
    await expect(page.getByTestId('count-waiting')).toContainText('1')

    await page.getByTestId('counter').click()
    const row = page.getByTestId('inbox-item-proposal:mcp:playwright')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Install MCP server playwright')
    await expect(row).toContainText('Needs your answer')
    await row.click()

    // The jump lands on the orchestrator's screen, where the card stands
    await expect(page.getByTestId('inbox')).toBeHidden()
    await expect(page.getByTestId('mcp-proposal-playwright')).toBeVisible()
    await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('aria-pressed', 'true')
  })

  test('answering the card takes the wait off the row, the count and the list', async ({ page }) => {
    const { orc } = await orchestratorAndElsewhere(page)
    await proposeAfterToolCall(
      page, orc, { skill: { name: 'weekly-report', content: 'Every Friday, write the summary.' } },
      'mcp__centralu__propose_skill',
    )
    await expect(page.getByTestId('orchestrator-proposal-waiting')).toBeVisible()

    await page.getByTestId('orchestrator-button').click()
    await page.getByTestId('skill-dismiss-weekly-report').click()

    await expect(page.getByTestId('skill-proposal-weekly-report')).toHaveCount(0)
    await expect(page.getByTestId('orchestrator-proposal-waiting')).toHaveCount(0)
    await expect(page.getByTestId('count-waiting')).toContainText('0')
    await page.getByTestId('counter').click()
    await expect(page.getByTestId('inbox-empty')).toBeVisible()
  })
}
