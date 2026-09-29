import { test, expect, type Page } from '@playwright/test'

/**
 * The trash (#204), on the mock platform: delete → trash → read → restore → delete for good.
 *
 * The retired archive (FR-20) had a way in and no way out; these scenarios walk the ways out through the screen, so
 * a trash that only works from the store's side does not pass. The host's side (what leaves every list and search,
 * what purging removes) is held by the unit tests; the mock follows the same rules (platform.contract.test.ts).
 */

async function setup(page: Page, projects: string[]) {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  for (const [i, path] of projects.entries()) {
    await page.evaluate((p: string) => {
      ;(window as any).__mock.nextPickedDirectory = p
    }, path)
    if (i === 0) {
      await page.getByTestId('orchestrator-pick-folder').click()
      await page.getByTestId('new-session-dialog').waitFor()
      await page.keyboard.press('Escape')
    } else {
      await page.getByTestId('add-project').click()
    }
    await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
  }
}

async function newSession(page: Page, projectName: string, prompt: string): Promise<string> {
  await page.getByTestId(`project-menu-${projectName}`).click()
  await page.getByTestId(`new-session-${projectName}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  // The agent answers, so the trashed conversation has both sides to read
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: 'noted — the answer is forty-two' })
    m.emit({ type: 'turn_complete', sessionId: sid })
  }, id)
  await expect(page.getByTestId('chat-stream')).toContainText('forty-two')
  return id
}

async function deleteSession(page: Page, id: string) {
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
}

async function openTrash(page: Page) {
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-trash').click()
  await expect(page.getByTestId('settings-trash')).toBeVisible()
}

test('a deleted session waits in the trash, reads there, comes back, and is deleted for good only from there', async ({
  page,
}) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha', 'what is the answer')

  // The dialog says where it goes and the two ways out, before anything happens
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toContainText('Move this session to the trash?')
  await expect(page.getByTestId('delete-trash-note')).toContainText('Settings → Trash reads it, restores it, or deletes it for good')
  await expect(page.getByTestId('confirm-delete-yes')).toHaveText('Move to trash')
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Moved to the trash')
  // Nothing the dialog chose has happened yet: the tool's conversation file waits with it
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).toEqual([])

  // Listed with where it came from, what it holds, and what goes with it
  await openTrash(page)
  await expect(page.getByTestId('trash-total')).toContainText('1 session ·')
  const row = page.getByTestId(`trash-row-${id}`)
  await expect(row).toContainText('what is the answer')
  await expect(page.getByTestId(`trash-project-${id}`)).toHaveText('alpha')
  await expect(page.getByTestId(`trash-holds-${id}`)).toContainText('2 messages')
  await expect(page.getByTestId(`trash-holds-${id}`)).toContainText('conversation file goes too')

  // Read, without restoring
  await page.getByTestId(`trash-read-${id}`).click()
  await expect(page.getByTestId('trash-reader-messages')).toContainText('what is the answer')
  await expect(page.getByTestId('trash-reader-messages')).toContainText('the answer is forty-two')
  await page.getByTestId('trash-reader-back').click()

  // Restore: back in the sidebar with its conversation
  await page.getByTestId(`trash-restore-${id}`).click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await expect(page.getByTestId('toast')).toContainText('Restored')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('chat-stream')).toContainText('the answer is forty-two')

  // Delete again, then for good: only now does the tool's file go
  await deleteSession(page, id)
  await openTrash(page)
  await page.getByTestId(`trash-purge-${id}`).click()
  await expect(page.getByTestId('trash-confirm')).toContainText('This cannot be undone')
  await expect(page.getByTestId('trash-confirm')).toContainText('the tool’s conversation file')
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await expect(page.getByTestId('trash-total')).toContainText('0 sessions')
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).toEqual([id])
})

test('emptying the trash asks once and deletes every session in it for good', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const a = await newSession(page, 'alpha', 'first to go')
  const b = await newSession(page, 'alpha', 'second to go')
  await deleteSession(page, a)
  await deleteSession(page, b)

  await openTrash(page)
  await expect(page.getByTestId('trash-total')).toContainText('2 sessions')
  await page.getByTestId('trash-empty').click()
  await expect(page.getByTestId('trash-confirm')).toContainText('Delete all 2 for good?')
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await expect(page.getByTestId('trash-empty')).toBeDisabled()
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)
})

test('a deleted project sends its sessions to the trash, and restoring one brings the project back', async ({ page }) => {
  await setup(page, ['/tmp/alpha'])
  const id = await newSession(page, 'alpha', 'survives the project')

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('delete-project-alpha').click()
  await expect(page.getByTestId('delete-project-note')).toContainText('Its sessions go to Centralu’s trash')
  await page.getByTestId('delete-project-name-input').fill('alpha')
  await page.getByTestId('delete-project-confirm').click()
  await expect(page.getByTestId('project-alpha')).toHaveCount(0)

  await openTrash(page)
  await expect(page.getByTestId(`trash-project-${id}`)).toHaveText('alpha (project deleted)')
  // Nobody was asked about the tool's file when the project went, so it stays even when this is emptied
  await expect(page.getByTestId(`trash-holds-${id}`)).toContainText('conversation file stays')
  await page.getByTestId(`trash-restore-${id}`).click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
})
