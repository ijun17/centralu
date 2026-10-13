import { expect, test } from '@playwright/test'
import { newSession, setup } from './fixtures/project-screen.js'

/**
 * A session's settings changed by another client show without a reload (#659).
 *
 * The change is made on the mock platform itself, not through the page's store: that is what another window, a linked
 * machine or an agent calling `agents.updateSettings` does. The host answers the caller and tells every client; before
 * the fix the page kept the old model and permission preset until it re-listed sessions.
 */
test('a model and permission preset changed from outside show in the header and the settings menu', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha')
  const summary = page.getByTestId('settings-open')
  await expect(summary).toContainText('Normal')
  await expect(summary).not.toContainText('Opus')

  await page.evaluate((sid) => (window as any).__mock.agents.updateSettings(sid, { model: 'opus', permissionPreset: 'auto' }), id)

  await expect(summary).toContainText('Opus')
  await expect(summary).toContainText('Auto')
  await expect(summary).not.toContainText('Normal')
  await summary.click()
  await expect(page.getByTestId('settings-model-opus')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('settings-preset-auto')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('settings-preset-normal')).toHaveAttribute('aria-checked', 'false')
  // Nobody else's hand was involved on this screen, so nothing is announced as the orchestrator's
  await expect(page.getByTestId('toast')).toHaveCount(0)
})
