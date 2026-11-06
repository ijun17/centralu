import { test, expect, type Page } from '@playwright/test'
import { setup, newSession, injectApproval, emitEvent } from './fixtures/control.js'

/*
 * Throwaway (P11 options for the owner): one scene, the Inbox drawn as it is today and as each option, screenshots in WebKit.
 * Not for main.
 */
test.use({ browserName: 'webkit' })

const seed = (page: Page, spec: Record<string, unknown>) =>
  page.evaluate((s) => (window as unknown as { __mock: { seedMail(s: Record<string, unknown>): string } }).__mock.seedMail(s), spec)
const PARSER = { address: 'session:mock/s2', kind: 'session', sessionId: 's2', name: 'Parser', state: 'idle' }
const REVIEW = { address: 'session:mock/s3', kind: 'session', sessionId: 's3', name: 'Reviewer', state: 'idle' }

async function scene(page: Page, option: string) {
  await page.addInitScript((o) => localStorage.setItem('cc.proto.inbox', o), option)
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'build the parser')
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })
  await newSession(page, 'beta', 'write the docs')
  await emitEvent(page, 1, { type: 'message_delta', role: 'assistant', text: 'done, over to you' })
  await emitEvent(page, 1, { type: 'turn_complete' })
  await seed(page, { subject: 'Which branch?', from: PARSER, body: 'main or release?' })
  await seed(page, { subject: 'Land #12', from: REVIEW, body: 'ready for review', kind: 'report' })
  await seed(page, { subject: 'Look at the branch', from: REVIEW, body: 'please', kind: 'assign', onlyHeld: true, held: { reason: 'failed', recipient: PARSER } })
  await page.locator('body').click()
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox')).toBeVisible()
  await page.waitForTimeout(400)
}

for (const option of ['today', 'a', 'b']) {
  test(`P11 option ${option}`, async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 })
    await scene(page, option)
    await page.getByTestId('inbox').screenshot({ path: `test-results/p11-${option}.png` })
  })
}
