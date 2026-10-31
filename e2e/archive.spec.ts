import { test, expect, type Page } from '@playwright/test'
import { newSession, setup } from './fixtures/control.js'

/**
 * The session archive (#204), on the mock platform: archive → read → restore → delete for good.
 *
 * The retired hide-a-session feature (FR-20) had a way in and no way out; these scenarios walk the ways out through the screen, so
 * an archive that only works from the store's side does not pass. The host's side (what leaves every list and search,
 * what purging removes) is held by the unit tests; the mock follows the same rules (platform.contract.test.ts).
 */

/** A session in `projectName` that the agent has answered, so the archived conversation has both sides to read */
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

/** Archives a session from its row's menu: the dialog asks first, also for an idle one (#1589) */
async function deleteSession(page: Page, id: string) {
  await page.getByTestId(`session-menu-${id}`).click()
  await expect(page.getByTestId(`delete-session-${id}`)).toHaveText('Archive session…')
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
}

async function openArchive(page: Page) {
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-archive').click()
  await expect(page.getByTestId('settings-trash')).toBeVisible()
}

test('a deleted session waits in the session archive, reads there, comes back, and is deleted for good only from there', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')

  // The dialog says where it goes and the two ways out, before anything happens; the conversation file is ticked to go with it
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toContainText('Archive this session?')
  await expect(page.getByTestId('delete-trash-note')).toContainText('Settings → Archive reads it, restores it, or deletes it for good')
  await expect(page.getByTestId('confirm-delete-yes')).toHaveText('Archive')
  await expect(page.getByTestId('delete-external-toggle').locator('input')).toBeChecked()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Archived')
  await expect(page.getByTestId('toast-action')).toHaveText('Undo')
  // Nothing the dialog chose has happened yet: the tool's conversation file waits with it, marked to go when deleted for good
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).toEqual([])
  expect(await page.evaluate((sid: string) => (window as any).__mock.trashBin.get(sid)?.removeExternal, id)).toBe(true)

  // Listed with where it came from, what it holds, and what goes with it
  await openArchive(page)
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
  await openArchive(page)
  await page.getByTestId(`trash-purge-${id}`).click()
  await expect(page.getByTestId('trash-confirm')).toContainText('This cannot be undone')
  await expect(page.getByTestId('trash-confirm')).toContainText('the tool’s conversation file')
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await expect(page.getByTestId('trash-total')).toContainText('0 sessions')
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).toEqual([id])
})

// #1589: every archive from the window asks first, also for an idle session; Undo on the toast after it puts it back
test('an idle session asks first, Cancel archives nothing, and Undo on the toast after Archive brings it back; a busy one asks too', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('confirm-delete')).toHaveCount(0)
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)
  await expect(page.getByTestId('toast')).toHaveCount(0)

  await deleteSession(page, id)
  await expect(page.getByTestId('toast')).toContainText('Archived')
  await page.getByTestId('toast-action').click()
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
  await expect(page.getByTestId('toast')).toContainText('Restored')
  await expect(page.getByTestId('toast-action')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)

  // A turn under way is cut short by the archive: that one asks
  await page.evaluate((sid: string) => (window as any).__mock.emit({ type: 'state_change', sessionId: sid, state: 'working' }), id)
  await page.getByTestId(`session-menu-${id}`).click()
  await expect(page.getByTestId(`delete-session-${id}`)).toHaveText('Archive session…')
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toContainText('Archive this session?')
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
  // The person's Archive moves it, once, and no losses are listed (the real host answers a session in a turn with no lines, which the store tests cover)
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('confirm-delete')).toHaveCount(0)
  await expect(page.getByTestId('delete-losses')).toHaveCount(0)
})

// #1595: what an archive would lose is read when the dialog opens, so it is on screen before the person decides, whichever way the worktree box is ticked
test('a session the host says would lose something shows it as the dialog opens, and one Archive moves it; Cancel archives nothing', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')
  // The mock host stands for the real one's rule: a session an agent started owes that agent a report (the mailbox, waits and cards say the same)
  await page.evaluate((sid: string) => ((window as any).__mock.store.sessions.get(sid).askedBy = 'an-agent'), id)
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await expect(page.getByTestId('delete-losses')).toContainText('owes it a report')
  await expect(page.getByTestId('delete-losses')).toContainText('Undo does not bring them back')
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('confirm-delete')).toHaveCount(0)
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('delete-losses')).toBeVisible()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('toast-action')).toHaveText('Undo')
  // The choice made in the dialog (the conversation file ticked) came along
  expect(await page.evaluate((sid: string) => (window as any).__mock.trashBin.get(sid)?.removeExternal, id)).toBe(true)
})

test('with the worktree box ticked the losses show all the same, and one Archive moves the session with its worktree; the unticked file stays at purge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')
  // The mock host stands for the real one's rule: a session an agent started owes that agent a report (the mailbox, waits and cards say the same)
  await page.evaluate((sid: string) => ((window as any).__mock.store.sessions.get(sid).askedBy = 'an-agent'), id)
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.store.sessions.get(sid).worktree = { path: '/tmp/alpha-wt', branch: 'feat/x' }
    ;(window as any).__store.setState((st: any) => ({ sessions: { ...st.sessions, [sid]: { ...st.sessions[sid], worktree: { path: '/tmp/alpha-wt', branch: 'feat/x' } } } }))
  }, id)
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('delete-losses')).toContainText('owes it a report')
  await page.getByTestId('delete-worktree-toggle').check()
  await expect(page.getByTestId('delete-losses')).toContainText('owes it a report')
  await page.getByTestId('delete-external-toggle').locator('input').uncheck()
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  expect(await page.evaluate((sid: string) => (window as any).__mock.trashBin.get(sid), id)).toMatchObject({ removeWorktree: true, removeExternal: false })
  await openArchive(page)
  await page.getByTestId(`trash-purge-${id}`).click()
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).toEqual([])
})

test('a loss that appears after the dialog opened is shown at Archive, which moves nothing; the next Archive moves it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')
  // The read at opening finds nothing; by the time of Archive the session owes a report
  await page.evaluate(() => {
    ;(window as any).__mock.agents.archiveLosses = async () => []
  })
  // The mock host stands for the real one's rule: a session an agent started owes that agent a report (the mailbox, waits and cards say the same)
  await page.evaluate((sid: string) => ((window as any).__mock.store.sessions.get(sid).askedBy = 'an-agent'), id)
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await expect(page.getByTestId('delete-losses')).toHaveCount(0)
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId('delete-losses')).toContainText('owes it a report')
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
})

test('a dialog put away while the losses are being read moves nothing, also with the worktree box ticked', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.store.sessions.get(sid).worktree = { path: '/tmp/alpha-wt', branch: 'feat/x' }
    ;(window as any).__store.setState((st: any) => ({ sessions: { ...st.sessions, [sid]: { ...st.sessions[sid], worktree: { path: '/tmp/alpha-wt', branch: 'feat/x' } } } }))
    const release: (() => void)[] = []
    ;(window as any).__release = () => release.splice(0).forEach((r) => r())
    m.agents.archiveLosses = () => new Promise<string[]>((resolve) => release.push(() => resolve([])))
  }, id)
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await page.getByTestId('delete-worktree-toggle').check()
  await page.getByTestId('confirm-delete-yes').click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('confirm-delete')).toHaveCount(0)
  await page.evaluate(() => (window as any).__release())
  await page.waitForTimeout(300)
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)
})

test('Archive is never held up by the read of the losses', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')
  await page.evaluate(() => {
    ;(window as any).__mock.agents.archiveLosses = () => new Promise(() => {})
  })
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
})

// Owner rule, 2026-10-26: what appears is animated, briefly, and not at all under reduced motion
for (const reduced of [false, true]) {
  test(`the losses open downward in place (${reduced ? 'no animation under reduced motion' : 'cc-expand'})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
    await setup(page, { projects: ['/tmp/alpha'] })
    const id = await answeredSession(page, 'alpha', 'what is the answer')
    // The mock host stands for the real one's rule: a session an agent started owes that agent a report (the mailbox, waits and cards say the same)
    await page.evaluate((sid: string) => ((window as any).__mock.store.sessions.get(sid).askedBy = 'an-agent'), id)
    await page.getByTestId(`session-menu-${id}`).click()
    await page.getByTestId(`delete-session-${id}`).click()
    const box = page.getByTestId('delete-losses')
    await expect(box).toBeVisible()
    const name = () => box.evaluate((el) => getComputedStyle(el.parentElement!.parentElement!).animationName)
    expect(await name()).toBe(reduced ? 'none' : 'cc-expand')
  })
}

test('the file left unticked stays at the first Archive too, and the ticked one goes only at purge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const keep = await answeredSession(page, 'alpha', 'keep my file')
  await page.getByTestId(`session-menu-${keep}`).click()
  await page.getByTestId(`delete-session-${keep}`).click()
  await page.getByTestId('delete-external-toggle').locator('input').uncheck()
  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${keep}`)).toHaveCount(0)
  expect(await page.evaluate((sid: string) => (window as any).__mock.trashBin.get(sid)?.removeExternal, keep)).toBe(false)
  await openArchive(page)
  await page.getByTestId(`trash-purge-${keep}`).click()
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).toEqual([])
})

test('the dialog of a session whose worktree holds uncommitted work says so', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.store.sessions.get(sid).worktree = { path: '/tmp/alpha-wt', branch: 'feat/x' }
    m.mockWorktreeDirty = true
    ;(window as any).__store.setState((st: any) => ({ sessions: { ...st.sessions, [sid]: { ...st.sessions[sid], worktree: { path: '/tmp/alpha-wt', branch: 'feat/x' } } } }))
  }, id)
  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await expect(page.getByTestId('worktree-dirty')).toContainText('uncommitted')
})

// Pressing Undo or Dismiss removes the element under the pointer or the focus, which never says it left: the toast after it must still go by itself
test.describe('a toast goes by itself after Undo or Dismiss took the previous one away', () => {
  async function archived(page: Page) {
    await setup(page, { projects: ['/tmp/alpha'] })
    const id = await answeredSession(page, 'alpha', 'what is the answer')
    await deleteSession(page, id)
    await expect(page.getByTestId('toast-action')).toHaveText('Undo')
    return id
  }

  test('Undo clicked', async ({ page }) => {
    const id = await archived(page)
    await page.getByTestId('toast-action').click()
    await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
    await page.mouse.move(5, 5)
    await expect(page.getByTestId('toast')).toContainText('Restored')
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 6000 })
  })

  test('Undo pressed with the keyboard', async ({ page }) => {
    const id = await archived(page)
    await page.mouse.move(5, 5)
    await page.getByTestId('toast-action').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
    await expect(page.getByTestId('toast')).toContainText('Restored')
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 6000 })
  })

  test('Dismiss clicked, then a toast that only says something', async ({ page }) => {
    await archived(page)
    await page.getByTestId('toast-dismiss').click()
    await expect(page.getByTestId('toast')).toHaveCount(0)
    await page.mouse.move(5, 5)
    await page.evaluate(() => (window as any).__store.getState().setToast('Something else happened'))
    await expect(page.getByTestId('toast')).toContainText('Something else happened')
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 6000 })
  })

  test('while the pointer rests on a toast with an Undo, it stays past its time', async ({ page }) => {
    // The 8 s are the page's clock, run forward here: waiting them out took 20 s on a CI runner, which is the test's own limit
    await page.clock.install()
    await archived(page)
    await page.getByTestId('toast').hover()
    await page.clock.runFor(9000)
    await expect(page.getByTestId('toast-action')).toBeVisible()
    await page.mouse.move(5, 5)
    await page.clock.runFor(9000)
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })
})

test('deleting all archived sessions asks once and deletes every session in it for good', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const a = await answeredSession(page, 'alpha', 'first to go')
  const b = await answeredSession(page, 'alpha', 'second to go')
  await deleteSession(page, a)
  await deleteSession(page, b)

  await openArchive(page)
  await expect(page.getByTestId('trash-total')).toContainText('2 sessions')
  await page.getByTestId('trash-empty').click()
  await expect(page.getByTestId('trash-confirm')).toContainText('Delete all 2 for good?')
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await expect(page.getByTestId('trash-empty')).toBeDisabled()
  expect(await page.evaluate(() => (window as any).__mock.trashBin.size)).toBe(0)
})

test('a deleted project sends its sessions to the session archive, and restoring one brings the project back', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'survives the project')

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('delete-project-alpha').click()
  await expect(page.getByTestId('delete-project-note')).toContainText('Its sessions go to Centralu’s session archive')
  await page.getByTestId('delete-project-name-input').fill('alpha')
  await page.getByTestId('delete-project-confirm').click()
  await expect(page.getByTestId('project-alpha')).toHaveCount(0)

  await openArchive(page)
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
  // The host's restore and recovery are covered with real git in manager-worktree.test.ts. Here the
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
  await openArchive(page)
  await page.getByTestId(`trash-restore-${id}`).click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('msg-mark')).toContainText('/tmp/recovery/0.patch')
  await expect(page.getByTestId('msg-mark')).toContainText('/tmp/recovery/0.bundle')
  await expect(page.getByTestId('msg-mark')).toContainText('git apply')
})

/*
 * App-agent run records (#378): a session an app stood up with run_agent is deleted once its run ends cleanly, and what
 * it did waits in the session archive, grouped by app. The host's side (when a session goes, what the record keeps) is held by
 * app-agents.test.ts; the mock never runs an app's agent, so the records are put in it directly.
 */
test('the records of finished app-agent runs are listed by app, read, and deleted for good from the session archive', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const mock = (window as any).__mock
    const project = mock.projectsList[0]
    const msg = (seq: number, role: string, kind: string, payload: unknown) => ({ sessionId: 's-gone', seq, role, kind, payload, ts: 1 })
    for (const [runId, ask, at] of [['run_a', 'Summarize the notes', 2], ['run_b', 'List the open tasks', 3]] as const) {
      mock.keepRun({
        run: { runId, app: { id: 'notes', name: 'Notes', projectId: project.id, projectName: 'alpha' }, sessionName: `Notes · agent 10:0${at}`,
          tool: 'claude', status: 'ok', startedAt: Date.now(), keptAt: at, durationMs: 4000, tokens: { input: 1200, output: 80 } },
        request: ask,
        answer: `Answer to: ${ask}`,
        messages: [msg(1, 'user', 'text', { text: ask }), msg(2, 'assistant', 'tool_call', { callId: 'c1', summary: { tool: 'Read', title: 'Read notes.md', readOnly: true, paths: [] } }),
          msg(3, 'assistant', 'text', { text: `Answer to: ${ask}` })],
      })
    }
  })
  await openArchive(page)
  await expect(page.getByTestId('trash-total')).toContainText('0 sessions · 2 app runs')
  const group = page.getByTestId(`trash-runs-app-${await page.evaluate(() => (window as any).__mock.projectsList[0].id)}/notes`)
  await expect(group).toContainText('Notes')
  await expect(group).toContainText('2 runs')
  await expect(page.getByTestId('trash-run-request-run_a')).toHaveText('Summarize the notes')

  // Read: what the app asked, what came back, and the conversation between
  await page.getByTestId('trash-run-read-run_a').click()
  await expect(page.getByTestId('trash-run-asked')).toHaveText('Summarize the notes')
  await expect(page.getByTestId('trash-run-answer')).toContainText('Answer to: Summarize the notes')
  await expect(page.getByTestId('trash-reader-messages')).toContainText('Read notes.md')
  await page.getByTestId('trash-reader-back').click()

  // One for good, then the session archive emptied takes the other with it
  await page.getByTestId('trash-run-purge-run_a').click()
  await expect(page.getByTestId('trash-confirm')).toContainText('This cannot be undone')
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-run-run_a')).toHaveCount(0)
  await expect(page.getByTestId('trash-total')).toContainText('1 app run')
  await page.getByTestId('trash-empty').click()
  await page.getByTestId('trash-confirm-yes').click()
  await expect(page.getByTestId('trash-list-empty')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.keptRuns.size)).toBe(0)
})

/*
 * #1143 (rows U11, U12 of the audit): the list is read by `useLoad`, "Load earlier messages" merges pages by `seq` and
 * ignores a press while a page is on its way, and one confirmation is open on the screen at a time.
 */
test('an archive that could not be read says so and offers a retry, instead of loading for good', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await answeredSession(page, 'alpha', 'what is the answer')
  await deleteSession(page, id)
  await page.evaluate(() => {
    const mock = (window as any).__mock
    mock.realTrashList = mock.trash.list
    mock.trash.list = async () => {
      throw new Error('the host went away')
    }
  })
  await openArchive(page)
  await expect(page.getByTestId('trash-load-error')).toContainText('Could not read the archive: the host went away')
  // The total does not say "Loading…" next to the failure
  await expect(page.getByTestId('trash-total')).not.toContainText('Loading')

  await page.evaluate(() => {
    const mock = (window as any).__mock
    mock.trash.list = mock.realTrashList
  })
  await page.getByTestId('trash-load-error-retry').click()
  await expect(page.getByTestId('trash-total')).toContainText('1 session ·')
  await expect(page.getByTestId('trash-load-error')).toHaveCount(0)
  await expect(page.getByTestId(`trash-row-${id}`)).toBeVisible()
})

/** A archived session holding `count` messages numbered from 1, each saying `said <seq>.` */
async function archivedLongSession(page: Page, count: number): Promise<string> {
  const id = await answeredSession(page, 'alpha', 'a long one')
  await deleteSession(page, id)
  await page.evaluate(
    ([sid, n]) => {
      const bin = (window as any).__mock.trashBin.get(sid)
      bin.messages = Array.from({ length: n as number }, (_, i) => ({
        sessionId: sid, seq: i + 1, role: 'user', kind: 'text', payload: { text: `said ${i + 1}.` }, ts: 1,
      }))
    },
    [id, count] as const,
  )
  return id
}

test('pressing "Load earlier messages" twice in a row reads one page and shows each message once', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await archivedLongSession(page, 450)
  await page.evaluate(() => {
    const mock = (window as any).__mock
    const read = mock.trash.read
    mock.readsBefore = []
    mock.trash.read = async (sessionId: string, limit: number, beforeSeq?: number) => {
      mock.readsBefore.push(beforeSeq ?? null)
      await new Promise((r) => setTimeout(r, 300))
      return read(sessionId, limit, beforeSeq)
    }
  })
  await openArchive(page)
  await page.getByTestId(`trash-read-${id}`).click()
  const older = page.getByTestId('trash-reader-older')
  await expect(older).toBeVisible()
  const messages = page.getByTestId('trash-reader-messages')
  await expect(messages.getByText('said 450.', { exact: true })).toBeVisible()

  await older.dblclick()
  await expect(messages.getByText('said 51.', { exact: true })).toBeVisible()
  // The second press found a page on its way and asked for nothing
  expect(await page.evaluate(() => (window as any).__mock.readsBefore)).toEqual([null, 251])
  await expect(messages.getByText('said 100.', { exact: true })).toHaveCount(1)
  await expect(messages.getByText('said 251.', { exact: true })).toHaveCount(1)
  await expect(messages.locator('li')).toHaveCount(400)
})

test('an earlier page that overlaps what is shown does not draw a message twice', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await archivedLongSession(page, 450)
  await page.evaluate(() => {
    const mock = (window as any).__mock
    const read = mock.trash.read
    // A page that reaches five messages past the cursor, as an archive that gained rows between two reads would answer
    mock.trash.read = async (sessionId: string, limit: number, beforeSeq?: number) =>
      read(sessionId, limit, beforeSeq === undefined ? undefined : beforeSeq + 5)
  })
  await openArchive(page)
  await page.getByTestId(`trash-read-${id}`).click()
  const messages = page.getByTestId('trash-reader-messages')
  await expect(messages.getByText('said 450.', { exact: true })).toBeVisible()
  await page.getByTestId('trash-reader-older').click()
  await expect(messages.getByText('said 56.', { exact: true })).toBeVisible()
  await expect(messages.getByText('said 253.', { exact: true })).toHaveCount(1)
  await expect(messages.locator('li')).toHaveCount(395)
})

test('"Delete all archived sessions" and a "Delete for good" of subagent steps or app runs are never open together', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const sessionId = await newSession(page, 'alpha', 'look into the boundaries test')
  await page.evaluate((sid: string) => {
    const mock = (window as any).__mock
    mock.emit({ type: 'tool_call', sessionId: sid, callId: 'toolu_agent', summary: { tool: 'Agent', title: 'Research', paths: [] } })
    mock.emit({
      type: 'subagent_event', sessionId: sid, parentCallId: 'toolu_agent',
      step: { sessionId: sid, type: 'message_delta', role: 'assistant', text: 'The boundaries test holds.' },
    })
    mock.emit({ type: 'turn_complete', sessionId: sid })
    const project = mock.projectsList[0]
    mock.keepRun({
      run: { runId: 'run_a', app: { id: 'notes', name: 'Notes', projectId: project.id, projectName: 'alpha' }, sessionName: 'Notes · agent',
        tool: 'claude', status: 'ok', startedAt: Date.now(), keptAt: 2, durationMs: 4000, tokens: { input: 1, output: 1 } },
      request: 'Summarize the notes', answer: 'Done',
      messages: [{ sessionId: 's-gone', seq: 1, role: 'user', kind: 'text', payload: { text: 'Summarize the notes' }, ts: 1 }],
    })
  }, sessionId)
  await openArchive(page)
  await page.getByTestId(`subagent-steps-move-${sessionId}`).click()
  await expect(page.getByTestId(`trash-steps-row-${sessionId}`)).toBeVisible()

  const confirm = page.getByTestId('trash-confirm')
  // A steps row's confirmation, then Delete all archived sessions: only the latter stays
  await page.getByTestId(`trash-steps-purge-${sessionId}`).click()
  await expect(confirm).toContainText('subagent steps of')
  await page.getByTestId('trash-empty').click()
  await expect(confirm).toHaveCount(1)
  await expect(confirm).toContainText('Delete all 2 for good?')

  // Delete all archived sessions, then an app run's: only the run's stays
  await page.getByTestId('trash-run-purge-run_a').click()
  await expect(confirm).toHaveCount(1)
  await expect(confirm).toContainText('Delete this run of Notes for good?')

  // And a steps row's again takes over from the run's
  await page.getByTestId(`trash-steps-purge-${sessionId}`).click()
  await expect(confirm).toHaveCount(1)
  await expect(confirm).toContainText('subagent steps of')
})
