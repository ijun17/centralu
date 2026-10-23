import { test, expect } from '@playwright/test'
import { tokenColor } from './fixtures/tokens.js'
import { setup, newSession, pickSetting } from './fixtures/control.js'
import { openSessionDialog, startSession } from './fixtures/new-session.js'

/**
 * The control loop's scenarios on a session from creation to deletion: names, waking, restarts, handoff, disconnects and the palette. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * The last tool picked becomes that project's default.
 *
 * default_tool used to be hardcoded to 'claude' at project creation with no place that updated
 * it afterward — a person using codex had to reselect it **forever**, every time they created a
 * new session. The act of creating a session records this fact, not a settings field.
 */
test('The app remembers the last tool used — the next session starts from there', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await openSessionDialog(page, 'alpha')
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // The second window opens with codex (checked via the actual creation parameters, not
  // aria-pressed)
  await startSession(page, 'alpha')
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params.tool).toBe('codex')
})

test('The first prompt becomes the session name (T5-6, FR-18)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'auth module refactor')
  await expect(page.getByTestId('session-name')).toContainText('auth module refactor')
})

test('A failed send is not swallowed silently (regression: waiting on a session that had died)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Create a situation where the session is gone (the same state as a session restored after a
  // host restart)
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    m.sessions.delete(id)
  })

  await page.getByTestId('prompt-input').fill('go on')
  await page.getByTestId('send').click()

  await expect(page.getByTestId('toast')).toContainText('Could not send')
  // No bubble is left behind for a message that failed to send
  await expect(page.getByTestId('msg-user').filter({ hasText: 'go on' })).toHaveCount(0)
})

test('A dormant session automatically resumes when spoken to (C-1, FR-10)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Simulate the state after a host restart: no process, only the transcript remains for the
  // session
  await page.evaluate(() => {
    const m = (window as any).__mock
    const store = (window as any).__store
    const st = store.getState()
    const id = st.focusedSessionId
    m.sessions.get(id).live = false
    store.setState({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], live: false } } })
  })

  // It does not block, and says nothing about sleep (owner, 2026-10-18): input stays open
  await expect(page.locator('[data-asleep]')).toHaveCount(1)
  await expect(page.getByTestId('dormant-note')).toHaveCount(0)
  await expect(page.getByTestId('prompt-input')).toBeEnabled()

  await page.getByTestId('prompt-input').fill('keep going')
  await page.getByTestId('send').click()

  // No "resume" button was ever clicked, yet the conversation continues
  await expect(page.getByTestId('chat-stream')).toContainText('keep going')
  await expect(page.getByTestId('dormant-note')).toBeHidden()
})

test('When resuming truly is not possible, the reason is announced (no silent failure)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await page.evaluate(() => {
    const m = (window as any).__mock
    const store = (window as any).__store
    const st = store.getState()
    const id = st.focusedSessionId
    m.unresumable.add(id) // Mark it as not resumable
    m.sessions.get(id).live = false
    store.setState({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], live: false } } })
  })

  await page.getByTestId('prompt-input').fill('keep going')
  await page.getByTestId('send').click()

  await expect(page.getByTestId('toast')).toContainText('Could not resume')
  // No bubble is left behind for a message that failed to send
  await expect(page.getByTestId('msg-user').filter({ hasText: 'keep going' })).toHaveCount(0)
})

test('Returns to the session that was being viewed (C-3 workspace snapshot)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  // Say the app was closed while viewing the first session
  const firstId = await page.evaluate(() => {
    const store = (window as any).__store
    const ids = Object.keys(store.getState().sessions)
    store.getState().focusSession(ids[0])
    return ids[0]
  })
  const snapshot = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snapshot?.focusedSessionId).toBe(firstId)

  // Reattaching (an app restart) leaves that session open
  await page.evaluate(async () => {
    const store = (window as any).__store
    const m = (window as any).__mock
    store.setState({ focusedSessionId: null })
    await store.getState().attach(m)
  })
  await expect(page.getByTestId('session-name')).toContainText('first')
})

test('Creating a session: only the tool is picked — model and permission are set after, in the header (M2.5)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await openSessionDialog(page, 'alpha')
  // The dialog only lets the person pick the tool and resumption — no model input, no prompt field (#8)
  await expect(page.getByTestId('model-input')).toHaveCount(0)
  await expect(page.getByTestId('initial-prompt')).toHaveCount(0)
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params).toMatchObject({ tool: 'claude' })
  expect(params.initialPrompt).toBeUndefined()

  // The first instruction goes in the composer — it stays on screen as is
  await page.getByTestId('prompt-input').fill('first instruction')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('msg-user')).toContainText('first instruction')

  // Model and permission are changed in the settings menu below the composer
  await pickSetting(page, 'settings-model-haiku')
  await expect(page.getByTestId('toast')).toContainText('haiku')
  await pickSetting(page, 'settings-preset-safe')
  const sessions = await page.evaluate(() => [...(window as any).__mock.sessions.values()])
  expect(sessions[0]).toMatchObject({ model: 'haiku', permissionPreset: 'safe' })
})

test('The create-session dialog warns about concurrent sessions (FR-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'the task that started first')
  await openSessionDialog(page, 'alpha')
  await expect(page.getByTestId('concurrent-warning')).toContainText('lose')
})

test('Command palette ⌘K: searches sessions and conversation content together (E-2, FR-21)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'auth refactor')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const ids = [...m.sessions.keys()]
    m.searchResults = [{ sessionId: ids[0], seq: 3, snippet: 'Fixed token expiry handling' }]
  })
  await newSession(page, 'alpha', 'deploy script')

  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()

  await page.getByTestId('palette-input').fill('token')
  await expect(page.getByTestId('palette-item-message')).toContainText('token expiry')

  await page.getByTestId('palette-item-message').click()
  await expect(page.getByTestId('session-name')).toContainText('auth refactor')
})

/**
 * Enter never opens a conversation hit from an earlier query (#1143 U15): type "token", see its hit, type one more
 * letter and press Enter before the answer. The hit of "token" is still the first row, and it used to open.
 */
test('Command palette: Enter waits for the search of the latest keystroke instead of opening an earlier hit', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'auth refactor')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const ids = [...m.sessions.keys()]
    m.searchResults = [{ sessionId: ids[0], seq: 3, snippet: 'Fixed token expiry handling' }]
  })
  await newSession(page, 'alpha', 'deploy script')
  const focused = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.keyboard.press('Meta+k')
  const input = page.getByTestId('palette-input')
  await input.fill('token')
  await expect(page.getByTestId('palette-item-message')).toContainText('token expiry')

  // The next answer is held, so the hit of "token" is what is on screen when Enter is pressed
  await page.evaluate(() => {
    ;(window as any).__mock.searchHold = new Promise<void>((resolve) => ((window as any).__releaseSearch = resolve))
  })
  await input.pressSequentially('z')
  await expect(input).toHaveValue('tokenz')
  await input.press('Enter')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(focused)

  // The answer comes: nothing matches "tokenz", and the old hit is gone
  await page.evaluate(() => (window as any).__releaseSearch())
  await expect(page.getByTestId('palette-empty')).toBeVisible()
})

/** Picking a project with no sessions from the palette also navigates to that project (#183) — it used to just close the palette */
test('Command palette: picking a project with no sessions navigates to that project (#183)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'task')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('beta')
  await page.getByTestId('palette-item-project').click()

  await expect(page.getByTestId('command-palette')).toBeHidden()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const st = (window as any).__store.getState()
        return st.projects[st.focusedProjectId]?.name ?? null
      }),
    )
    .toBe('beta')
})

test('deleting a session: once confirmed it leaves the list and goes to the session archive (M2.5, #204)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session to delete')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  // "Cannot be undone" is not the truth — where it goes, and how it comes back or goes for good
  await expect(page.getByTestId('delete-trash-note')).toContainText(
    'Chat history and attachments stay in Centralu’s session archive',
  )
  await expect(page.getByTestId('delete-trash-note')).toContainText(
    'Settings → Archive reads it, restores it, or deletes it for good',
  )
  await page.getByTestId('confirm-delete-yes').click()

  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Archived')
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(0)
  // The default deletes the tool file too (dogfooding asked for it), but only once it is deleted for good; until then it waits
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).not.toContain(id)
  expect(
    await page.evaluate((sid: string) => (window as any).__mock.trashBin.get(sid)?.removeExternal, id),
  ).toBe(true)
})

/*
 * Actual deletion (dogfooding finding): the default delete leaves the tool's own conversation
 * original intact ("this can be recovered" is the notice's promise). Checking the box flips that
 * same notice into a warning, and the original gets deleted too. Leaving it unchecked never
 * touches the original — both paths are checked directly.
 */
test("Deleting a session: by default the original is deleted too — unchecking the box leaves it on the tool's side", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session to keep')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  // Default: a warning that the original will be deleted too is shown, and the checkbox is checked
  await expect(page.getByTestId('delete-external-toggle').locator('input')).toBeChecked()
  await expect(page.getByTestId('delete-external-warning')).toContainText('deleted too')
  await expect(page.getByTestId('delete-notice')).toHaveCount(0)

  // Unchecking flips the same notice into "stays with the tool"
  await page.getByTestId('delete-external-toggle').locator('input').uncheck()
  await expect(page.getByTestId('delete-external-warning')).toHaveCount(0)
  await expect(page.getByTestId('delete-notice')).toContainText('stays in')

  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  // Unchecked, so the original remains
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).not.toContain(id)
})

/*
 * Handoff and start fresh (dogfooding finding): the note the departing session writes becomes
 * the new session's first message, the name carries over, and the old session is deleted
 * including its original (since #204: it moves to the session archive, and the tool file goes when it is
 * deleted for good). The request and the note are both visible in the conversation as they
 * happen — there is no hidden step behind the scenes.
 */
test('handoff: the note starts a new session and the old one moves to the session archive (#204)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session to switch to')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  /*
    Finish the first turn first — a handoff waits for the running turn to finish (measured
    finding: output from a still-running turn mixed into the note and read as "cut off"). Confirm
    the transition to working first: if the completion event goes out before the send's working
    state, the turn never finishes.
  */
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid]?.state, id))
    .toBe('working')
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'turn_complete', sessionId: sid })
    m.emit({ type: 'state_change', sessionId: sid, state: 'waiting_input' })
  }, id)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`handoff-session-${id}`).click()
  // The receiving agent defaults to the current tool. The note comes from the record by default, for a live session
  // too, and the original is kept by default, as the record has always been (#694): asking the agent and deleting are chosen
  await expect(page.getByTestId('handoff-tool-claude')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-mode-record')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-delete-toggle').locator('input')).not.toBeChecked()
  await expect(page.getByTestId('handoff-keep-note')).toBeVisible()
  await page.getByTestId('handoff-mode-agent').click()
  await page.getByTestId('handoff-delete-toggle').locator('input').check()
  await expect(page.getByTestId('handoff-warning')).toContainText('is archived')
  await page.getByTestId('confirm-handoff-yes').click()

  // The handoff request enters the conversation as an ordinary message
  await expect(page.getByTestId('chat-stream')).toContainText('handoff note')

  // The departing session writes the note **as a reply** (there is no model in the mock, so this
  // simulates it by hand). The file is placed by the host in the data folder (#142) — nothing is
  // written to the person's own repository. The location varies per handing-off session (#104).
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: 'Successor note: got this far' })
    m.emit({ type: 'turn_complete', sessionId: sid })
    m.emit({ type: 'state_change', sessionId: sid, state: 'waiting_input' })
  }, id)

  // The new session takes the name; the old one is in the session archive, its tool file marked to go when it is deleted for good (#204)
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0, { timeout: 15_000 })
  const heirId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  await expect(page.getByTestId(`session-row-${heirId}`)).toContainText('session to switch to')
  expect(
    await page.evaluate((sid: string) => (window as any).__mock.trashBin.get(sid)?.removeExternal, id),
  ).toBe(true)
  // The new session's first message is that note
  await expect(page.getByTestId('chat-stream')).toContainText('Successor note')
  expect(await page.evaluate(() => [...(window as any).__mock.handoffNotes.values()])).toEqual([
    'Successor note: got this far',
  ])
  expect(
    await page.evaluate(() =>
      Object.keys((window as any).__mock.fsState.files).filter((p) => p.includes('handoff')),
    ),
  ).toEqual([])
})

/*
 * Handoff from a dead agent (#78): a session whose service has crashed cannot be asked to write
 * a note. The note comes from the record and the original is kept (every session's defaults since
 * #694), and seeing that state flips the target to the opposite tool. Confirming asks the dead session
 * for nothing at all, and the host's record becomes the successor's first message.
 */
test('Handoff from a dead session: record mode is preselected, nothing is asked, and the original remains (#78)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session about to die')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  // The session dies — the error state is exactly the basis for deciding "cannot be asked for a note"
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({
      type: 'error',
      sessionId: sid,
      error: { code: 'adapter_crashed', message: 'service down', retryable: false },
    })
  }, id)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`handoff-session-${id}`).click()

  // Record mode and keeping the original (every session's defaults since #694), and the opposite tool
  await expect(page.getByTestId('handoff-mode-record')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-tool-codex')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-delete-toggle').locator('input')).not.toBeChecked()
  await expect(page.getByTestId('handoff-mode-note')).toContainText('not asked')

  await page.getByTestId('confirm-handoff-yes').click()

  // The successor is created inheriting the name, and its first message is the host's record —
  // nothing was ever sent to the dead session
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.sessions.size), { timeout: 15_000 })
    .toBe(2)
  await expect(page.getByTestId('chat-stream')).toContainText('Handoff Record')
  // The original remains — preserving it until the successor is confirmed is the default for the
  // dead-agent mode
  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).__mock.externallyDeleted)).not.toContain(id)
})

test('When session creation fails, the reason stays in the modal (M2.5: used to look like clicking did nothing)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.agents.createSession = async () => {
      throw new Error('Could not start claude session: Native CLI binary not found')
    }
  })
  // The menu's New session starts at once (owner, 2026-10-18); when that fails, the dialog opens and a toast says why
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await expect(page.getByTestId('toast')).toContainText('Could not start a session')
  await page.getByTestId('create-session-confirm').click()

  // The toast disappears, but this stays
  await expect(page.getByTestId('create-session-error')).toContainText('Could not start')
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
})

test('Startup works even when attaching after the host is already ready (regression: missing an event used to hang for 30 seconds)', async ({
  page,
}) => {
  // The mock platform is ready instantly, so this only checks that the screen appears even if attach is late
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible({ timeout: 5000 })
  // It must not be the "could not start" failure screen
  await expect(page.getByText('Could not start the agent host')).toHaveCount(0)
})

test('Switching sessions clears whatever was overlaid — the new conversation must show first', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'a.ts', path: 'a.ts', isDir: false, ignored: false }]
    m.fsState.files['a.ts'] = 'x'
  })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-a.ts').click()
  await expect(page.getByTestId('overlay')).toBeVisible()

  const first = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  await page.getByTestId(`session-row-${first}`).click()
  await expect(page.getByTestId('overlay')).toBeHidden()
  await expect(page.getByTestId('chat-stream')).toContainText('first')
})

/** M2.6 dogfooding: hide/delete, restart, attachments, and compacted old conversations */
test('Deleting removes only our own record — the notice states plainly that it remains with the tool', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session to delete')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()

  // By default the original is deleted too (2b60589) — a red warning appears in that case
  await expect(page.getByTestId('delete-external-warning')).toContainText('deleted too')
  // **Choosing to keep it** speaks without alarm — overstating the danger just means the person
  // never cleans up and the list keeps growing
  await page.getByTestId('delete-external-toggle').locator('input').uncheck()
  await expect(page.getByTestId('delete-notice')).toContainText('stays in Claude Code')
  await expect(page.getByTestId('delete-notice')).toContainText('Past conversations')

  await page.getByTestId('confirm-delete-yes').click()
  await expect(page.getByTestId(`session-row-${id}`)).toBeHidden()

  // There is no separate "hide" button — only delete remains
  await expect(page.getByTestId(`hide-session-${id}`)).toHaveCount(0)
})

test('Refresh restarts only the agent and keeps the conversation', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'this conversation must survive')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId('restart-session').click()
  await expect(page.getByTestId('toast')).toContainText('Agent restarted')

  expect(await page.evaluate(() => (window as any).__mock.restarted)).toContain(id)
  await expect(page.getByTestId('chat-stream')).toContainText('this conversation must survive')
})

/**
 * A restart takes a few seconds — if the screen stays quiet during that time, the person clicks
 * again, and **the second click kills the process that just started.** The button pressed to fix
 * something was the very spot that broke it. The spinning icon is not decoration, it is the
 * "received" acknowledgment.
 */
test('While restarting, the icon spins and the button cannot be pressed again', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Make it take real time — if it finishes instantly, this bug never reproduces
  await page.evaluate(() => {
    const m = (window as any).__mock
    const real = m.agents.restartSession.bind(m.agents)
    m.agents.restartSession = async (id: string) => {
      await new Promise((r) => setTimeout(r, 1200))
      return real(id)
    }
  })

  const button = page.getByTestId('restart-session')
  await button.click()

  // It is spinning, and it is locked
  await expect(page.getByTestId('restart-spinning')).toBeVisible()
  await expect(button).toBeDisabled()

  // Trying to click again during that time does not trigger a second restart
  await button.click({ force: true })
  await expect(page.getByTestId('toast')).toContainText('Agent restarted')
  const count = await page.evaluate(() => (window as any).__mock.restarted.length)
  expect(count).toBe(1)

  // Once finished, it returns to normal — the person must be able to fix it again next time
  await expect(button).toBeEnabled()
  await expect(page.getByTestId('restart-spinning')).toHaveCount(0)
})

/**
 * If waking a session fails, "sending a message automatically resumes it" **stops being true.**
 * Leaving it that way gives the person no way to know why it is not working (pointed out during
 * dogfooding).
 */
test('When a session cannot be woken, the reason is shown right there with a way to retry', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Set up a dormant session that also cannot be woken
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    m.sessions.get(sid).live = false
    m.unresumable.add(sid)
    store.setState({
      sessions: { ...store.getState().sessions, [sid]: { ...store.getState().sessions[sid], live: false } },
    })
  }, id)

  // Selecting it again only shows it (#568); its composer taking the keyboard attempts to wake it, and the failure
  // reason remains
  await page.getByTestId('project-header-alpha').click()
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('chat-stream')).toBeVisible()
  await expect(page.getByTestId('dormant-note')).toHaveCount(0)
  await page.getByTestId('prompt-input').click()
  await expect(page.getByTestId('dormant-note')).toContainText('Could not resume')
  await expect(page.getByTestId('dormant-note')).toContainText('cannot be resumed')

  // Fixing the cause and retrying brings it back to life
  await page.evaluate((sid) => (window as any).__mock.unresumable.delete(sid), id)
  await page.getByTestId('dormant-retry').click()
  await expect(page.getByTestId('dormant-note')).toBeHidden()
})

/**
 * Two sessions with similar titles were once mistaken for using different tools (dogfooding
 * finding). The list must show which tool each one uses, and the header and usage must use
 * **that session's own** tool as well.
 */
test("The session list and header show each session's own tool", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await openSessionDialog(page, 'alpha')
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill("Claude's task")
  await page.getByTestId('prompt-input').press('Enter')

  await openSessionDialog(page, 'alpha')
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill("Codex's task")
  await page.getByTestId('prompt-input').press('Enter')

  // The tool is distinguished in the list
  await expect(page.getByTestId('tool-mark-claude')).toHaveCount(1)
  await expect(page.getByTestId('tool-mark-codex')).toHaveCount(1)

  /*
   * Usage is now **one donut per tool** (requested by the person, 2026-09-09) — the person picks
   * which tool's limit to see, rather than the screen guessing. The single letter in the middle
   * matches the sidebar chip, so it reads without a legend.
   */
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  await page.getByTestId('usage-donut-codex').click()
  await expect(page.getByTestId('usage-drop')).toContainText('Codex')
})

/**
 * The opposite direction must also follow from the value: when autocomplete inserts a long path,
 * the box grows to match.
 *
 * `fill()` fires an input event, so it would pass even with the old code — so this uses **the
 * real autocomplete-picking path** instead. That path only changes React state and creates no
 * DOM event.
 */
/*
 * The goal badge (2026-09-07 — claude's /goal, codex's thread/goal/*).
 * The goal status as judged by the tool shows in the header: iteration count and a status
 * summary, with the condition and shortfall reason on hover. It disappears once cleared
 * (including on success) — judgment belongs to the tool, and the badge is only a notification.
 */
test('A goal badge appears in the header once a goal is set, and disappears once it is cleared', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid: string) => {
    ;(window as any).__store.getState().dispatchEvent({
      type: 'goal',
      sessionId: sid,
      goal: { objective: 'All tests green', status: 'active', iterations: 3, reason: '2 failing' },
    })
  }, id)
  await expect(page.getByTestId('goal-badge')).toContainText('GOAL · 3')
  await expect(page.getByTestId('goal-badge')).toHaveAttribute('title', /All tests green/)

  // codex's vocabulary (blocked, etc.) passes through unchanged
  await page.evaluate((sid: string) => {
    ;(window as any).__store.getState().dispatchEvent({
      type: 'goal',
      sessionId: sid,
      goal: { objective: 'Build green', status: 'blocked' },
    })
  }, id)
  await expect(page.getByTestId('goal-badge')).toContainText('GOAL · blocked')

  await page.evaluate((sid: string) => {
    ;(window as any).__store.getState().dispatchEvent({ type: 'goal', sessionId: sid, goal: null })
  }, id)
  await expect(page.getByTestId('goal-badge')).toBeHidden()
})

/**
 * When the host dies, the supervisor relaunches it, but the new host knows nothing of the agents
 * that were alive — their processes died along with it. So every session used to sit dormant on
 * screen, and the person had to click each one to wake it. The UI is the one thing that knows
 * what was running, so this uses that to bring them back automatically.
 */
test('Working sessions revive on their own after a disconnect and reconnect', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // The host died: the process is gone and the connection drops
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.sessions.get(sid).live = false
    m.setConnectionState('disconnected')
  }, id)
  await expect
    .poll(async () => page.evaluate(() => (window as any).__store.getState().connection))
    .not.toBe('connected')

  // The supervisor relaunched it
  await page.evaluate(() => (window as any).__mock.setConnectionState('connected'))

  /*
    The UI's live flag stays stale at true even after the disconnect, so checking only that would
    prove nothing. This checks whether **the host's own actual state** has come back to life —
    proof that revival really happened.
  */
  await expect
    .poll(async () => page.evaluate((sid) => (window as any).__mock.sessions.get(sid).live, id), {
      timeout: 5000,
    })
    .toBe(true)
})

/**
 * Deleting a project (requested during dogfooding).
 *
 * Four things are guarded:
 *  1. The menu is **absent by default** — no button gets in the way of reading the project row
 *  2. Deletion only unlocks by typing the exact name — no path lets the hand slip through from memory
 *  3. Checking the file checkbox **turns the description into a warning** — what changed reads in the same spot
 *  4. Deleting removes both the project and its sessions from the sidebar
 */
test('Deleting a project: unlocks only by typing the name, and the file checkbox turns into a warning', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'any task at all')

  // 1. The menu button stays hidden (present in the DOM, invisible on screen — it appears on
  //    hover/focus). Since creating the session just clicked this button, move the pointer away
  //    first — otherwise the hover state lingers
  await page.mouse.move(0, 0)
  const actions = page.getByTestId('project-actions-alpha')
  await expect(actions).toHaveCSS('opacity', '0')
  await page.getByTestId('project-header-alpha').hover()
  await expect(actions).toHaveCSS('opacity', '1')

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('delete-project-alpha').click()

  // 2. It cannot be deleted before the name is typed
  const confirm = page.getByTestId('delete-project-confirm')
  await expect(confirm).toBeDisabled()
  // The default is "only this app's record" — the folder is left untouched
  await expect(page.getByTestId('delete-project-note')).toContainText('folder on disk is left alone')
  await expect(page.getByTestId('delete-project-warning')).toHaveCount(0)

  await page.getByTestId('delete-project-name-input').fill('alph')
  await expect(confirm).toBeDisabled()
  await page.getByTestId('delete-project-name-input').fill('alpha')
  await expect(confirm).toBeEnabled()

  // 3. Turning on "delete files too" removes the description and a warning takes its place
  await page.getByTestId('delete-project-files-toggle').locator('input').check()
  await expect(page.getByTestId('delete-project-note')).toHaveCount(0)
  await expect(page.getByTestId('delete-project-warning')).toContainText('/tmp/alpha')
  await expect(confirm).toHaveText('Delete and trash folder')
  // The warning uses the danger palette (dogfooding: dangerous spots are red) — today the same
  // values as a diff's deletion
  await expect(page.getByTestId('delete-project-warning')).toHaveCSS('background-color', await tokenColor(page, '--color-danger-bg'))
  await expect(confirm).toHaveCSS('color', await tokenColor(page, '--color-danger'))

  // 4. Delete it — both the project and its sessions disappear, and the folder went to the trash
  await confirm.click()
  await expect(page.getByTestId('delete-project-dialog')).toBeHidden()
  await expect(page.getByTestId('project-alpha')).toHaveCount(0)
  await expect(page.getByTestId('sidebar').getByTestId(/^session-row-/)).toHaveCount(0)
  // Through the project folder's own door (#838): the file tree's trash never reaches the project folder
  expect(await page.evaluate(() => (window as any).__mock.trashedProjects)).toHaveLength(1)
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual([])
})

/** With the files option off, the folder is left untouched — confirming the default is really the default (through behavior, not just the warning text) */
test('Deleting a project: leaving the file checkbox off keeps the folder untouched', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-header-alpha').hover()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('delete-project-alpha').click()
  await page.getByTestId('delete-project-name-input').fill('alpha')
  await page.getByTestId('delete-project-confirm').click()

  await expect(page.getByTestId('project-alpha')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.trashedProjects)).toEqual([])
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual([])
})

/**
 * A folder of the user folder registered in place as a project (#1141) may be moved to app-trash/ by the host once nothing can
 * restore it (#1204), so "The folder on disk is left alone." would be wrong for it (#1301). The dialog asks the host when it opens
 * (`projects.deleteOutlook`, real paths); a host without the call leaves the list's mark (`ProjectInfo.fromUserFolder`) deciding,
 * and a host without the mark, like an ordinary project, keeps today's sentence.
 */
test('Deleting a project that is an app folder: the dialog asks the host and says the folder may move; an ordinary one keeps its sentence', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta', '/tmp/gamma', '/tmp/delta'] })
  const open = async (name: string) => {
    await page.getByTestId(`project-header-${name}`).hover()
    await page.getByTestId(`project-menu-${name}`).click()
    await page.getByTestId(`delete-project-${name}`).click()
  }
  const close = async () => {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('delete-project-dialog')).toBeHidden()
  }
  const idOf = (name: string) => page.evaluate((n) => Object.values<any>((window as any).__store.getState().projects).find((p) => p.name === n).id, name)
  const note = page.getByTestId('delete-project-folder-note')
  const alpha = await idOf('alpha')
  const gamma = await idOf('gamma')
  const delta = await idOf('delta')
  // The host's answers: alpha is an app folder reached by a junction the list's mark does not see, gamma lies inside one, delta is marked
  // by the list but the host says its folder stays (the folder is not the one the adoption recorded)
  await page.evaluate(
    ([a, g, d]) => {
      const m = (window as any).__mock
      m.deleteOutlooks.set(a, 'may_move')
      m.deleteOutlooks.set(g, 'around_may_move')
      m.deleteOutlooks.set(d, 'stays')
    },
    [alpha, gamma, delta],
  )
  await page.evaluate((d) => {
    const store = (window as any).__store
    store.setState((s: any) => ({ projects: { ...s.projects, [d]: { ...s.projects[d], fromUserFolder: true } } }))
  }, delta)

  // 1. Unmarked in the list, an app folder by the host's real-path answer: it may move, never put as certain
  await open('alpha')
  await expect(note).toContainText('The host may move the folder to app-trash/')
  await expect(note).toContainText('Nothing is deleted')
  await expect(note).toContainText('no other project is at the folder')
  await expect(page.getByTestId('delete-project-note')).not.toContainText('left alone')
  await close()
  // 2. Inside an app folder: not called one
  await open('gamma')
  await expect(note).toContainText('This project lies inside an app folder')
  await expect(note).not.toContainText('This project is an app folder')
  await close()
  // 3. Marked in the list, but the host's answer is the one that counts
  await open('delta')
  await expect(note).toHaveText('The folder on disk is left alone.')
  await close()
  // 4. An ordinary project keeps today's sentence
  await open('beta')
  await expect(note).toHaveText('The folder on disk is left alone.')
  await close()
  // Asked once for each time the dialog opened
  expect(await page.evaluate(() => (window as any).__mock.deleteOutlooksAsked.length)).toBe(4)
})

test('Deleting a project waits for the host\'s answer about the folder: nothing is said on a guess, and Delete is not offered until it comes', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.deleteOutlookHold = new Promise<void>((release) => ((window as any).__release = release))
    m.deleteOutlooks.set(Object.values<any>((window as any).__store.getState().projects)[0].id, 'around_may_move')
  })
  await page.getByTestId('project-header-alpha').hover()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('delete-project-alpha').click()
  const note = page.getByTestId('delete-project-folder-note')
  await expect(note).toHaveText('Checking what happens to the folder…')
  await page.getByTestId('delete-project-name-input').fill('alpha')
  await expect(page.getByTestId('delete-project-confirm')).toBeDisabled()
  await page.evaluate(() => (window as any).__release())
  await expect(note).toContainText('This project lies inside an app folder')
  await expect(page.getByTestId('delete-project-confirm')).toBeEnabled()
})

test('Deleting a project from a host without the call: the list\'s mark decides, and an unmarked project keeps its sentence', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await page.evaluate(() => {
    const store = (window as any).__store
    ;(window as any).__mock.deleteOutlookUnknown = true
    const alpha = Object.values<any>(store.getState().projects).find((p) => p.name === 'alpha')
    store.setState((s: any) => ({ projects: { ...s.projects, [alpha.id]: { ...alpha, fromUserFolder: true } } }))
  })
  const open = async (name: string) => {
    await page.getByTestId(`project-header-${name}`).hover()
    await page.getByTestId(`project-menu-${name}`).click()
    await page.getByTestId(`delete-project-${name}`).click()
  }
  await open('alpha')
  await expect(page.getByTestId('delete-project-folder-note')).toContainText('The host may move the folder to app-trash/')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('delete-project-dialog')).toBeHidden()
  await open('beta')
  await expect(page.getByTestId('delete-project-folder-note')).toHaveText('The folder on disk is left alone.')
})

/**
 * "Connected" is never written; it speaks up **only when disconnected** (requested by the
 * person, 2026-09-09).
 *
 * A status indicator that takes up space when everything is normal is decoration, not a
 * dashboard. But a disconnect cannot stay quiet — at that point the rest of the screen can turn
 * into a lie (the orchestrator screen incident of 2026-09-07).
 */
test('Being connected stays quiet, and a disconnect states itself where the donuts would be', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await expect(page.getByTestId('connection')).toHaveCount(0)
  await expect(page.getByTestId('usage-donuts')).toBeVisible()

  await page.evaluate(() => (window as never as { __mock: any }).__mock.setConnectionState('disconnected'))

  /*
   * With no host, there is simply no way to reach any agent — leaving the donuts empty would
   * read as "there are no tools at all", which is not the fact, it is **not knowing**. The same
   * spot states the reason.
   */
  await expect(page.getByTestId('connection')).toContainText('Disconnected')
  await expect(page.getByTestId('usage-donuts')).toHaveCount(0)

  await page.evaluate(() => (window as never as { __mock: any }).__mock.setConnectionState('connected'))
  await expect(page.getByTestId('connection')).toHaveCount(0)
  await expect(page.getByTestId('usage-donuts')).toBeVisible()
})
