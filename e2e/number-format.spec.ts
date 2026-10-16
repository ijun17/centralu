import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * Sizes and counts are written by one rule (`app/format.ts`, #428). The cases that went wrong, on screen: a token count
 * past a million came out as "2500.0k", and a context gauge for a model with no window as "Infinity%".
 */

async function emit(page: Page, sessionId: string, event: Record<string, unknown>) {
  await page.evaluate(([sid, e]) => (window as any).__mock.emit({ ...(e as object), sessionId: sid }), [sessionId, event] as const)
}

test('a count past a million is written in M, in the thinking notice and the compaction marker', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  await emit(page, id, { type: 'state_change', state: 'working' })
  await emit(page, id, { type: 'reasoning_delta', estTokens: 2_500_000 })
  await expect(page.getByTestId('activity-label')).toContainText('Thinking · ~2.5M tokens')

  await emit(page, id, { type: 'compaction', before: 2_500_000, after: 999_600 })
  await expect(page.getByTestId('chat-stream')).toContainText('Context compacted here · 2.5M → 1M')
})

test('a context gauge for a window of 0 says unknown, not Infinity%', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  await emit(page, id, { type: 'context_update', used: 5000, window: 0, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toHaveAttribute('title', /Context 5k \/ 0 tokens/)
  await expect(page.getByTestId('context-gauge')).toHaveText('Context —')
})
