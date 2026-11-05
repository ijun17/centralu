import { test, expect, type Page } from '@playwright/test'
import { setup } from './fixtures/control.js'

// Scratch (not committed): the open mail with its reply box, dark and light, for the before/after screenshots
const DIR = process.env.SHOT_DIR ?? 'shots'
const PARSER = { address: 'session:mock/s1', kind: 'session', sessionId: 's1', name: 'Parser', state: 'idle' }
const seed = (page: Page, spec: Record<string, unknown>) =>
  page.evaluate((s) => (window as unknown as { __mock: { seedMail(s: Record<string, unknown>): string } }).__mock.seedMail(s), spec)

for (const mode of ['dark', 'light'] as const) {
  test(`shot ${mode}`, async ({ page }) => {
    await page.addInitScript((p) => localStorage.setItem('cc-mock-prefs', JSON.stringify(p)), mode === 'light' ? { themeMode: 'light', themeLight: 'light' } : { themeMode: 'dark', themeDark: 'dark' })
    await page.setViewportSize({ width: 1100, height: 760 })
    await setup(page)
    const id = await seed(page, { subject: 'Which branch?', from: PARSER, body: 'Should I base the parser work on main or on the release branch?', kind: 'question', state: 'running', assignee: PARSER, working: true })
    await page.getByTestId('counter').click()
    await page.getByTestId(`mail-thread-${id}`).click()
    await expect(page.getByTestId('mail-reply')).toBeVisible()
    await page.waitForTimeout(400)
    await page.getByTestId('inbox').screenshot({ path: `${DIR}/open-mail-${mode}.png`, animations: 'disabled', caret: 'hide' })
  })
}
