import { test, expect } from '@playwright/test'
import { setup } from './fixtures/control.js'

/**
 * The project's instructions for the agents its sessions start (#1161 item 2): opened from the project's menu, typed,
 * saved, and there again the next time the dialog opens. Typed with the keyboard, as a person types (CONTRIBUTING:
 * where the keyboard goes), so a dialog that did not take the caret would fail here.
 */
test("the project's instructions for agents are edited from its menu, saved, and shown again", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const stored = () =>
    page.evaluate(() => ((window as any).__mock.projectsList as { name: string; agentInstructions: string }[]).find((p) => p.name === 'alpha')!.agentInstructions)

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('agent-instructions-alpha').click()
  const dialog = page.getByTestId('agent-instructions-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('agent-instructions-note')).toContainText('every agent a session starts in this project')
  const save = page.getByTestId('agent-instructions-save')
  // Nothing changed yet: nothing to save
  await expect(save).toBeDisabled()
  await page.keyboard.type('Make your own worktree.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Never use git stash.')
  await save.click()
  await expect(dialog).toBeHidden()
  expect(await stored()).toBe('Make your own worktree.\nNever use git stash.')

  // Opened again, it shows what was saved; Escape leaves it as it was
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('agent-instructions-alpha').click()
  await expect(page.getByTestId('agent-instructions-input')).toHaveValue('Make your own worktree.\nNever use git stash.')
  await page.keyboard.type(' And more.')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await stored()).toBe('Make your own worktree.\nNever use git stash.')
})
