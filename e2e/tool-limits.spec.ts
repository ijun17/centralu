import { test, expect, type Page } from '@playwright/test'
import { setup } from './fixtures/control.js'
import { openSessionDialog } from './fixtures/new-session.js'

/**
 * A tool that declares what it cannot keep (docs/plans/acp-adapter.md §7: Cursor through ACP takes no role text, cannot
 * be kept from a project's own files, and has no `safe`) stays in the pickers, greyed, with the host's own reason
 * (`launchRefusal`), instead of failing after the person picked it. The mock's Codex plays such a tool here.
 */
const limitCodex = (page: Page) =>
  page.evaluate(() => {
    const m = (window as any).__mock
    m.capabilityLimits.codex = { presets: ['normal', 'edits', 'auto'], keepsRepoFilesOut: false, roleText: false }
  })

test('in an untrusted project the tool is shown greyed with the reason, and nothing starts with it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: false })
  await limitCodex(page)
  await openSessionDialog(page, 'alpha')
  await expect(page.getByTestId('tool-option-codex')).toHaveAttribute('title', /runs only in trusted projects/)
  await page.getByTestId('tool-option-codex').click()
  await expect(page.getByTestId('tool-blocked')).toContainText('Codex cannot be kept from reading a project')
  await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
})

test('in a trusted project it starts, and the preset it cannot keep is greyed with the reason', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await limitCodex(page)
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('tool-option-codex').click()
  await expect(page.getByTestId('tool-blocked')).toHaveCount(0)
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-preset-safe')).toBeDisabled()
  await expect(page.getByTestId('settings-preset-safe')).toHaveAttribute('title', /cannot run under Safe/)
  await expect(page.getByTestId('settings-preset-normal')).toBeEnabled()
})

test('a tool that takes no role text cannot be picked for the orchestrator, and says why', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await limitCodex(page)
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-orchestrator').click()
  await expect(page.getByTestId('orchestrator-tool-codex')).toBeDisabled()
  await expect(page.getByTestId('orchestrator-tool-codex')).toHaveAttribute('title', /cannot run the orchestrator/)
  await expect(page.getByTestId('orchestrator-tool-claude')).toBeEnabled()
})

test("the empty session's tool switch offers only the tools that keep the session's own preset", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await limitCodex(page)
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-start-tool-claude')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('session-start-tool-codex')).toBeVisible()
  // Safe: the limited tool would be saved as a session it cannot run, so the switch leaves it out (as one not installed)
  await page.getByTestId('settings-open').click()
  await page.getByTestId('settings-preset-safe').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('session-start-tool-codex')).toHaveCount(0)
})
