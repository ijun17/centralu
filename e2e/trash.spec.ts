import { test, expect, type Page } from '@playwright/test'
import { newSession, setup } from './fixtures/control.js'

/**
 * The trash (#204), on the mock platform: delete → trash → read → restore → delete for good.
 *
 * The retired archive (FR-20) had a way in and no way out; these scenarios walk the ways out through the screen, so
 * a trash that only works from the store's side does not pass. The host's side (what leaves every list and search,
 * what purging removes) is held by the unit tests; the mock follows the same rules (platform.contract.test.ts).
 */

/** A session in `projectName` that the agent has answered, so the trashed conversation has both sides to read */
async function answeredSession(page: Page, projectName: string, prompt: string): Promise<string> {
  const id = await newSession(page, projectName, prompt)
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
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')

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
  await setup(page, { projects: ['/tmp/alpha'] })
  const a = await answeredSession(page, 'alpha', 'first to go')
  const b = await answeredSession(page, 'alpha', 'second to go')
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
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'survives the project')

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

test('restoring a worktree session offers its recovery patch and bundle in the conversation', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'keep the local work')
  await deleteSession(page, id)
  // The host's restore and recovery are covered with real git in manager.test.ts. Here the
  // port returns the same notice so the path from Settings to the offered files is exercised.
  await page.evaluate(() => {
    const mock = (window as any).__mock
    const restore = mock.trash.restore
    mock.trash.restore = async (sessionId: string) => {
      const back = await restore(sessionId)
      mock.emit({
        type: 'notice', sessionId, level: 'info', from: 'Centralu', label: 'worktree recovery',
        text: 'Restored branch feat/work. Recovery files remain at /tmp/recovery/0.patch and /tmp/recovery/0.bundle. Apply patches with git apply; fetch bundles with git fetch <bundle> HEAD:<branch>.',
      })
      return back
    }
  })
  await openTrash(page)
  await page.getByTestId(`trash-restore-${id}`).click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('msg-mark')).toContainText('/tmp/recovery/0.patch')
  await expect(page.getByTestId('msg-mark')).toContainText('/tmp/recovery/0.bundle')
  await expect(page.getByTestId('msg-mark')).toContainText('git apply')
})
