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
  await openTrash(page)
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
 * it did waits in the trash, grouped by app. The host's side (when a session goes, what the record keeps) is held by
 * app-agents.test.ts; the mock never runs an app's agent, so the records are put in it directly.
 */
test('the records of finished app-agent runs are listed by app, read, and deleted for good from the trash', async ({ page }) => {
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
  await openTrash(page)
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

  // One for good, then the trash emptied takes the other with it
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
test('a trash that could not be read says so and offers a retry, instead of loading for good', async ({ page }) => {
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
  await openTrash(page)
  await expect(page.getByTestId('trash-load-error')).toContainText('Could not read the trash: the host went away')
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

/** A trashed session holding `count` messages numbered from 1, each saying `said <seq>.` */
async function trashedLongSession(page: Page, count: number): Promise<string> {
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
  const id = await trashedLongSession(page, 450)
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
  await openTrash(page)
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
  const id = await trashedLongSession(page, 450)
  await page.evaluate(() => {
    const mock = (window as any).__mock
    const read = mock.trash.read
    // A page that reaches five messages past the cursor, as a trash that gained rows between two reads would answer
    mock.trash.read = async (sessionId: string, limit: number, beforeSeq?: number) =>
      read(sessionId, limit, beforeSeq === undefined ? undefined : beforeSeq + 5)
  })
  await openTrash(page)
  await page.getByTestId(`trash-read-${id}`).click()
  const messages = page.getByTestId('trash-reader-messages')
  await expect(messages.getByText('said 450.', { exact: true })).toBeVisible()
  await page.getByTestId('trash-reader-older').click()
  await expect(messages.getByText('said 56.', { exact: true })).toBeVisible()
  await expect(messages.getByText('said 253.', { exact: true })).toHaveCount(1)
  await expect(messages.locator('li')).toHaveCount(395)
})

test('"Empty trash" and a "Delete for good" of subagent steps or app runs are never open together', async ({ page }) => {
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
  await openTrash(page)
  await page.getByTestId(`subagent-steps-move-${sessionId}`).click()
  await page.getByTestId('subagent-steps-confirm-yes').click()
  await expect(page.getByTestId(`trash-steps-row-${sessionId}`)).toBeVisible()

  const confirm = page.getByTestId('trash-confirm')
  // A steps row's confirmation, then Empty trash: only the latter stays
  await page.getByTestId(`trash-steps-purge-${sessionId}`).click()
  await expect(confirm).toContainText('subagent steps of')
  await page.getByTestId('trash-empty').click()
  await expect(confirm).toHaveCount(1)
  await expect(confirm).toContainText('Delete all 2 for good?')

  // Empty trash, then an app run's: only the run's stays
  await page.getByTestId('trash-run-purge-run_a').click()
  await expect(confirm).toHaveCount(1)
  await expect(confirm).toContainText('Delete this run of Notes for good?')

  // And a steps row's again takes over from the run's
  await page.getByTestId(`trash-steps-purge-${sessionId}`).click()
  await expect(confirm).toHaveCount(1)
  await expect(confirm).toContainText('subagent steps of')
})
