import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * A session's background work on screen (#290), driven through the mock platform, which keeps the list the way the
 * host does (`applyBackgroundTasks`) and stops tasks the way the tools were measured to: an interrupt ends the tasks
 * that stop with the turn, a per-task stop ends that one.
 *
 * The tasks are shaped like a Claude session's (scripts/probe-background-tasks.mts): a background subagent that
 * stops with the turn, a backgrounded shell that survives it, and an ambient watcher that is not activity.
 *
 * A function because it runs in Chromium and in WebKit (background-tasks-webkit.spec.ts) — the desktop app is
 * WKWebView, and the list is a popover laid over the header.
 */

const AGENT = { id: 'a202e1fd007fa1e73', kind: 'agent', description: 'Measure the sleep probe', parentCallId: 'toolu_agent', stopsWithTurn: true, stoppable: true }
const SHELL = { id: 'bzztskv5d', kind: 'shell', description: 'sleep 191; echo bg-shell-done', parentCallId: 'toolu_shell', stopsWithTurn: false, stoppable: true }
const WATCH = { id: 'w1', kind: 'mcp', description: 'Watch the logs', ambient: true, stoppable: true }

async function emit(page: Page, sessionId: string, event: Record<string, unknown>) {
  await page.evaluate(([sid, e]) => (window as any).__mock.emit({ ...(e as object), sessionId: sid }), [sessionId, event] as const)
}

async function start(page: Page): Promise<string> {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  // A turn running, with the agent's launch card in the conversation — the card whose steps the list links to
  await emit(page, id, { type: 'tool_call', callId: AGENT.parentCallId, summary: { tool: 'Agent', title: AGENT.description, readOnly: true, paths: [] } })
  await emit(page, id, { type: 'subagent_event', parentCallId: AGENT.parentCallId, step: { type: 'message_delta', sessionId: id, role: 'assistant', text: 'Sleeping for the probe.' } })
  await emit(page, id, { type: 'background_tasks', live: [AGENT, SHELL, WATCH] })
  return id
}

export function backgroundTasksTests(): void {
  test.describe('background tasks (#290)', () => {
    test('the header counts the running tasks, ambient ones excluded, and the sidebar row carries the same mark', async ({ page }) => {
      const id = await start(page)
      const badge = page.getByTestId('background-badge')
      await expect(badge).toHaveAttribute('data-count', '2')
      await expect(badge).toContainText('2 background')
      await expect(page.getByTestId(`background-mark-${id}`)).toHaveText('2 bg')
    })

    test('the list names each task, what Stop on the turn does to it, and stops one on its own', async ({ page }) => {
      const id = await start(page)
      await page.getByTestId('background-badge').click()
      const list = page.getByTestId('background-list')
      await expect(list).toBeVisible()
      await expect(list.getByTestId(`background-task-${AGENT.id}`)).toContainText(AGENT.description)
      await expect(page.getByTestId(`background-note-${AGENT.id}`)).toHaveText('stops with the turn')
      await expect(page.getByTestId(`background-note-${SHELL.id}`)).toHaveText('survives Stop')
      await expect(page.getByTestId(`background-status-${WATCH.id}`)).toHaveText('ambient')

      await page.getByTestId(`background-stop-${SHELL.id}`).click()
      await expect.poll(() => page.evaluate(() => (window as any).__mock.stoppedTasks)).toEqual([SHELL.id])
      await expect(page.getByTestId(`background-task-${SHELL.id}`)).toHaveAttribute('data-status', 'stopped')
      await expect(page.getByTestId(`background-stop-${SHELL.id}`)).toHaveCount(0)
      await expect(page.getByTestId('background-badge')).toHaveAttribute('data-count', '1')
      await expect(page.getByTestId(`background-mark-${id}`)).toHaveText('1 bg')
    })

    test('Stop on the turn says which tasks it stops and which keep running, and the stopped agent stays listed with its steps', async ({ page }) => {
      const id = await start(page)
      await expect.poll(() => page.evaluate((sid) => (window as any).__store.getState().sessions[sid]?.state, id)).toBe('working')
      await expect(page.getByTestId('interrupt-background-note')).toHaveText('Also stops 1 background task · 1 background task keeps running')

      await page.getByTestId('activity-interrupt').click()
      await expect.poll(() => page.evaluate(() => (window as any).__mock.interrupts.length)).toBe(1)
      // The shell survived, as measured; the agent ended with the turn
      await expect(page.getByTestId('background-badge')).toHaveAttribute('data-count', '1')
      await page.getByTestId('background-badge').click()
      await expect(page.getByTestId(`background-task-${AGENT.id}`)).toHaveAttribute('data-status', 'stopped')
      await expect(page.getByTestId(`background-task-${SHELL.id}`)).toHaveAttribute('data-status', 'running')

      // The stopped agent's record is one click away: the steps its launch card keeps (#222)
      const steps = page.getByTestId(`background-steps-${AGENT.id}`)
      await steps.getByTestId('subagent-steps-toggle').click()
      await expect(steps.getByTestId('subagent-steps-list')).toContainText('Sleeping for the probe.')

      // Cleared, the ended ones go and the running one stays
      await page.getByTestId('background-clear').click()
      await expect(page.getByTestId(`background-task-${AGENT.id}`)).toHaveCount(0)
      await expect(page.getByTestId(`background-task-${SHELL.id}`)).toBeVisible()
    })

    test('with only ended tasks left the header still opens them, and says how they ended', async ({ page }) => {
      const id = await start(page)
      await emit(page, id, {
        type: 'background_tasks',
        live: [WATCH],
        ended: [
          { ...AGENT, status: 'failed', summary: 'API Error: 529 overloaded' },
          { ...SHELL, status: 'stopped' },
        ],
      })
      const badge = page.getByTestId('background-badge')
      await expect(badge).toHaveAttribute('data-count', '0')
      await expect(badge).toContainText('background · 1 failed · 1 stopped')
      await expect(page.getByTestId(`background-mark-${id}`)).toHaveCount(0)
      await badge.click()
      await expect(page.getByTestId(`background-note-${AGENT.id}`)).toHaveText('API Error: 529 overloaded')
      // Clearing everything ended takes the badge away — an ambient watcher alone is not activity
      await page.getByTestId('background-clear').click()
      await expect(badge).toHaveCount(0)
    })

    test('the control rail lists a session whose turn ended while its background work runs, with the mark', async ({ page }) => {
      const id = await start(page)
      await emit(page, id, { type: 'turn_complete' })
      await expect.poll(() => page.evaluate((sid) => (window as any).__store.getState().sessions[sid]?.state, id)).toBe('waiting_input')
      // Nothing about the turn's Stop is left behind once the turn is over
      await expect(page.getByTestId('interrupt-background-note')).toHaveCount(0)
      await page.getByTestId('orchestrator-button').click()
      await expect(page.getByTestId('control-rail')).toBeVisible()
      await expect(page.getByTestId(`rail-background-${id}`)).toHaveText('2 bg')
      await expect(page.getByTestId(`rail-running-${id}`)).toBeVisible()
    })
  })
}
