import { test, expect, type Page } from '@playwright/test'
import { setup, newSession, emitEvent } from './fixtures/control.js'

/**
 * The control loop's scenarios on the orchestrator and coordinators: its screen, its agent, and messages it sends. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * The orchestrator screen while disconnected (dogfooding finding, 2026-09-07: "it was
 * disconnected but the screen still looked connected, and clicking a question threw an error").
 *
 * Clicking while disconnected queues the RPC expecting a reconnect, and it fails only after
 * waiting 30 seconds — during which the screen falsely claims "starting up". Something that
 * cannot be done must say so up front.
 */
test('While disconnected, the orchestrator screen says so — questions cannot be clicked', async ({
  page,
}) => {
  await setup(page, { projects: [] })
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await expect(page.getByTestId('suggest-capabilities')).toBeEnabled()

  await page.evaluate(() => (window as never as { __mock: any }).__mock.setConnectionState('disconnected'))

  await expect(page.getByTestId('orchestrator-offline')).toBeVisible()
  await expect(page.getByTestId('suggest-capabilities')).toBeDisabled()
  // Folder picking also goes through the host — leaving only the invitation active would be the
  // same trap
  await expect(page.getByTestId('orchestrator-pick-folder')).toBeDisabled()

  // Once back online, the invitation returns too
  await page.evaluate(() => (window as never as { __mock: any }).__mock.setConnectionState('connected'))
  await expect(page.getByTestId('orchestrator-offline')).toBeHidden()
  await expect(page.getByTestId('suggest-capabilities')).toBeEnabled()
})

/**
 * The orchestrator — controlling by talking (FR-11).
 * It sits right above the grid: the two are two ways of viewing the same thing.
 */
test('The orchestrator sits above the grid and opens on click', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const orc = page.getByTestId('orchestrator-button')
  const cc = page.getByTestId('grid-button')
  await expect(orc).toBeVisible()

  // Order: the orchestrator sits above the grid
  const a = (await orc.boundingBox())!
  const b = (await cc.boundingBox())!
  expect(a.y).toBeLessThan(b.y)

  await orc.click()
  await expect(orc).toHaveAttribute('aria-pressed', 'true')
  // Opening it for the first time shows an empty conversation — the session is only born at the
  // first question (#63 lazy startup)
  await expect(page.getByTestId('orchestrator-empty')).toBeVisible()
  await expect(page.getByTestId('grid')).toBeHidden()

  // The first message creates the session, and from then on it is the same component as the
  // focus view
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('session-view')).toBeVisible()
})

/**
 * The box before the orchestrator exists is a composer like any other (#1143 U17): `/usage` opens the usage screen
 * rather than starting the orchestrator with "/usage" as its first message, and the box grows with its text.
 */
test('Before the orchestrator exists, /usage opens its screen and the box grows with its text', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('orchestrator-button').click()
  const input = page.getByTestId('orchestrator-input')
  await expect(input).toBeVisible()

  const oneLine = (await input.boundingBox())!.height
  await input.fill('line one\nline two\nline three\nline four')
  expect((await input.boundingBox())!.height).toBeGreaterThan(oneLine + 20)

  await input.fill('/usage')
  await input.press('Enter')
  await expect(page.getByTestId('usage-drop')).toBeVisible()
  // Nothing was sent: the orchestrator is still not born, and the box is empty
  await expect(page.getByTestId('orchestrator-empty')).toBeVisible()
  await expect(input).toHaveValue('')
  expect(await page.evaluate(() => (window as any).__store.getState().orchestratorId)).toBeFalsy()
})

/**
 * Neither sidebar door carries a badge any more. The grid graduated on 2026-08-27; the
 * orchestrator's "Evolving" went on 2026-10-17 (the owner's call), with the dot that marked a
 * waiting proposal: the proposal card itself waits in the orchestrator's screen.
 */
test('neither the grid nor the orchestrator button carries a badge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await expect(page.getByTestId('grid-button')).toBeVisible()
  await expect(page.getByTestId('orchestrator-button')).toHaveText('Orchestrator')
  await expect(page.getByTestId('grid-experimental')).toHaveCount(0)
  await expect(page.getByTestId('orchestrator-experimental')).toHaveCount(0)
})

test('While viewing the orchestrator, no session appears selected in the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const row = page.getByTestId(`session-row-${id}`)
  await row.click()
  const selected = (await row.getAttribute('class')) ?? ''

  await page.getByTestId('orchestrator-button').click()
  await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('aria-pressed', 'true')
  expect(await row.getAttribute('class')).not.toBe(selected)

  // Returning restores the selected appearance
  await row.click()
  expect(await row.getAttribute('class')).toBe(selected)
})

test("The orchestrator's session never joins the project list", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  await page.getByTestId('orchestrator-button').click()
  // The session is born at the first message (#63)
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('session-view')).toBeVisible()

  const orcId = await page.evaluate(() => (window as any).__store.getState().orchestratorId)
  expect(orcId).toBeTruthy()
  // Belonging to no project, it has no row under any project in the sidebar
  await expect(page.getByTestId(`session-row-${orcId}`)).toHaveCount(0)
})

/**
 * The orchestrator's `@` picks a **session**, not a file.
 * Pointing at one by name alone risks picking the wrong name, and sending work to the wrong
 * session actually changes that project.
 */
test('In the orchestrator, @ picks a session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'readme owner')
  await page.getByTestId('orchestrator-button').click()
  // The session is born at the first message (#63)
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('session-view')).toBeVisible()

  await page.getByTestId('prompt-input').fill('@readme')
  const menu = page.getByTestId('autocomplete')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('readme')
  // It is a session name, not a file path — the project name is attached as a hint
  await expect(menu).toContainText('alpha')
})

/**
 * The one remaining exception is the orchestrator — since there is exactly one per app,
 * "make a new one with a different tool" does not apply. It lives in app settings, and
 * confirmation is asked once.
 */
test("The orchestrator's agent is switched from settings", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Create the session first — if it is alive, it is swapped out in place
  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  const orcId = await page.evaluate(() => (window as any).__store.getState().orchestratorId)

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-orchestrator').click()
  await expect(page.getByTestId('orchestrator-tool-claude')).toHaveAttribute('aria-checked', 'true')

  // Merely selecting it opens a confirmation dialog — nothing changes yet
  await page.getByTestId('orchestrator-tool-codex').click()
  await expect(page.getByTestId('orchestrator-switch-confirm')).toContainText(
    'Details it remembers may be lost',
  )
  expect(await page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, orcId)).toBe(
    'claude',
  )

  await page.getByTestId('orchestrator-switch-cancel').click()
  expect(await page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, orcId)).toBe(
    'claude',
  )

  // Confirming is required for the change to take effect
  await page.getByTestId('orchestrator-tool-codex').click()
  await page.getByTestId('orchestrator-switch-confirm-btn').click()
  await expect
    .poll(async () => page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, orcId))
    .toBe('codex')

  // Whether the host cleared externalId (passing Claude's conversation id to codex would grab the
  // wrong thing)
  const ext = await page.evaluate(
    (s) => [...(window as any).__mock.sessions.values()].find((x: any) => x.id === s)?.externalId,
    orcId,
  )
  expect(ext).toBeNull()
})

/**
 * **An orchestrator never opened this run must still be switchable.**
 *
 * The test above opened the session first and only then went to settings, so `orchestratorId`
 * was always filled, and the path taken by someone who opens settings right after launching the
 * app was never exercised. On that path the value is null, so the screen flowed into
 * configureOrchestrator instead of switchTool — a value the host records as "never read again
 * once a session exists". The choice got written, nobody read it, and redrawing brought the old
 * tool right back (dogfooding finding: "switching it still comes back as codex").
 */
test("Someone who opens settings first can still switch the orchestrator's agent", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  const orcId = await page.evaluate(() => (window as any).__store.getState().orchestratorId)

  // Simulate a freshly launched app — the session exists but has not been opened this run
  await page.evaluate(() => (window as any).__store.setState({ orchestratorId: null }))

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-orchestrator').click()
  await expect(page.getByTestId('orchestrator-tool-claude')).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('orchestrator-tool-codex').click()
  await page.getByTestId('orchestrator-switch-confirm-btn').click()

  // Recording the choice must not be the end — the live session must actually change
  await expect
    .poll(async () => page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, orcId))
    .toBe('codex')
})

/**
 * The mark beside the orchestrator's agent follows what was done (#1143 U10).
 *
 * Settings read the session by hand and moved the mark itself after a switch it never checked: a switch the host
 * refused still moved it; before any session existed the choice never moved it at all (and the saved one was not shown);
 * and a failed look for the session fell through to the recorded choice, which the host ignores once a session exists.
 */
const settingsOrchestrator = async (page: Page) => {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-orchestrator').click()
}
const checked = (page: Page, tool: string) => expect(page.getByTestId(`orchestrator-tool-${tool}`))

test('A switch the host refuses leaves the mark on the agent that is still running', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  const orcId = await page.evaluate(() => (window as any).__store.getState().orchestratorId)
  // A freshly launched app: the session exists, this run has not opened it
  await page.evaluate(() => {
    const w = window as any
    w.__store.setState({ orchestratorId: null })
    w.__mock.agents.switchTool = async () => {
      throw new Error('Codex is not installed')
    }
  })
  await settingsOrchestrator(page)
  await checked(page, 'claude').toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('orchestrator-tool-codex').click()
  await page.getByTestId('orchestrator-switch-confirm-btn').click()
  await expect(page.getByTestId('toast')).toContainText('Codex is not installed')
  await checked(page, 'claude').toHaveAttribute('aria-checked', 'true')
  await checked(page, 'codex').toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate((s) => (window as any).__store.getState().sessions[s].tool, orcId)).toBe('claude')
})

test('Before the orchestrator has a session, the choice made in settings moves the mark and is still there on reopening', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await settingsOrchestrator(page)
  await checked(page, 'claude').toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('orchestrator-tool-codex').click()
  await page.getByTestId('orchestrator-switch-confirm-btn').click()
  await checked(page, 'codex').toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => (window as any).__mock.orchestratorTool)).toBe('codex')

  await page.keyboard.press('Escape')
  await settingsOrchestrator(page)
  await checked(page, 'codex').toHaveAttribute('aria-checked', 'true')
  await checked(page, 'claude').toHaveAttribute('aria-checked', 'false')
})

test('When the look for the orchestrator fails, settings say so and record no choice the host would ignore', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const w = window as any
    w.__mock.agents.orchestratorPeek = async () => {
      throw new Error('The host did not answer')
    }
    w.__recorded = 0
    const configure = w.__mock.agents.configureOrchestrator
    w.__mock.agents.configureOrchestrator = (tool: string) => {
      w.__recorded++
      return configure(tool)
    }
  })
  await settingsOrchestrator(page)
  await expect(page.getByTestId('orchestrator-peek-failed')).toContainText('The host did not answer')

  await page.getByTestId('orchestrator-tool-codex').click()
  await page.getByTestId('orchestrator-switch-confirm-btn').click()
  await expect(page.getByTestId('toast')).toContainText('The host did not answer')
  expect(await page.evaluate(() => (window as any).__recorded)).toBe(0)
  await checked(page, 'codex').toHaveAttribute('aria-checked', 'false')
})

/**
 * A message inserted by the orchestrator must also appear in the conversation.
 *
 * It used to be that the UI was the only place that produced user messages, so it was enough for
 * the UI to draw its own. Once the orchestrator became a second producer, that assumption broke
 * — an injected message **was saved but never appeared on screen** (only a restart revealed it).
 */
test('A message inserted by someone else also appears in the conversation', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'user_message', seq: 991, text: 'work the orchestrator assigned' })
  await expect(page.getByTestId('chat-stream')).toContainText('work the orchestrator assigned')
})

/**
 * A message that came in as an instruction shows its origin (FR-11).
 *
 * An orchestrator instruction was persisted and displayed, but looked like an identical bubble
 * to a human message — the screen could not answer "did I actually ask for this?" A message
 * with a `from` field carries an origin label (msg-user-from), and that label must survive the
 * restore path a restart walks too.
 */
test('A parent\'s mid-turn message appears once in the working child with its origin, and survives a restore', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'long job')
  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await emitEvent(page, 0, {
    type: 'user_message', seq: 991, text: 'Use Chromium while you keep working.',
    from: { sessionId: 'parent-session', name: 'parent session' },
  })
  await expect(page.getByTestId('msg-user-from')).toHaveCount(1)
  await expect(page.getByTestId('msg-user-from')).toContainText('parent session')
  await expect(page.getByText('Use Chromium while you keep working.', { exact: true })).toHaveCount(1)
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)
  await expect(page.getByTestId('msg-user-from')).toHaveCount(1)
  await expect(page.getByTestId('msg-user-from')).toContainText('parent session')
  await expect(page.getByText('Use Chromium while you keep working.', { exact: true })).toHaveCount(1)
})

test('A message instructed by the orchestrator carries an origin label, and it survives a restore', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, {
    type: 'user_message',
    seq: 991,
    text: 'clean up the release notes',
    from: { sessionId: 'orc-x', name: 'coordinator session' },
  })
  await expect(page.getByTestId('msg-user-from')).toContainText('coordinator session')

  // Restart leg: discard the in-memory conversation and force-read it back from the transcript
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)
  await expect(page.getByTestId('msg-user-from')).toContainText('coordinator session')
})

/**
 * Confirming by text match only holds between one's own messages — if an orchestrator
 * instruction arrives at the exact moment the person happens to have the same sentence pending,
 * it would be absorbed and its origin marker would silently disappear.
 */
test("An instructed message is not absorbed even when the person's identical sentence is pending", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('prompt-input').fill('the same sentence')
  await page.getByTestId('send').click()
  await emitEvent(page, 0, {
    type: 'user_message',
    seq: 993,
    text: 'the same sentence',
    from: { sessionId: 'orc-x', name: 'coordinator session' },
  })

  // Both the human bubble and the origin-labeled bubble must remain
  await expect(page.getByTestId('msg-user-from')).toBeVisible()
  const counts = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    const items = st.chat[st.focusedSessionId].filter((i: any) => i.kind === 'user' && i.text === 'the same sentence')
    return { total: items.length, marked: items.filter((i: any) => i.from).length }
  })
  expect(counts).toEqual({ total: 2, marked: 1 })
})

/**
 * The orchestrator must be the orchestrator screen **no matter which door it is entered through**
 * (a dogfooding bug).
 *
 * Entering via the sidebar button worked; entering via the top bar's waiting list did not: the
 * orchestrator conversation opened inside the session screen's frame, **dragging the right-side
 * evidence lane along with it** (the orchestrator has no repository to show), and the sidebar
 * button looked unpressed.
 *
 * The notice card used the same door (focusSession); it is gone (owner, 2026-10-18), and the inbox is
 * where a finished turn is opened from.
 */
test('The orchestrator is still the orchestrator screen when entered via the inbox', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // Set up the orchestrator and put it into waiting-for-input
  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('orchestrator-input').fill('show me the status')
  await page.getByTestId('orchestrator-input').press('Enter')
  const orc = await page.evaluate(
    () => [...(window as any).__mock.sessions.values()].find((s: any) => s.projectId === null).id,
  )
  await page.evaluate((id: string) => {
    const m = (window as any).__mock
    // An answer to read: the inbox lists a finished turn only while it is unread (#669)
    m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'here is the status' })
    m.emit({ type: 'state_change', sessionId: id, state: 'waiting_input' })
  }, orc)

  // While looking elsewhere — switch over to the session screen
  await newSession(page, 'alpha', 'something else')
  await expect(page.getByTestId('evidence-panel')).toBeVisible()

  // Come back via the top bar's waiting list
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  await page.getByTestId(`inbox-item-${orc}`).click()

  // The evidence lane does not drag along — the orchestrator has no repository to show
  await expect(page.getByTestId('evidence-panel')).toHaveCount(0)
  // And it appears pressed in the sidebar
  await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('orchestrator')

  /*
    The card that reported a finished reply was a second door through the same focusSession. The cards are gone
    (owner, 2026-10-18): a finished turn is written out in the inbox's capsule and opened from the inbox, the door above.
  */
})

/**
 * A coordinator the removed control app (#97) stood up as a task's foreman, the way it sits in the
 * store after the upgrade: no project, members in its scope, `appId: 'control'`. Nothing in the app
 * creates one any more, so it is planted in the mock the way the host would load it.
 */
async function plantForeman(page: Page, memberId: string, name: string): Promise<string> {
  return page.evaluate(
    ({ memberId, name }) => {
      const m = (window as any).__mock
      const member = m.sessions.get(memberId)
      const id = 'coord-foreman-1'
      const session = {
        ...member,
        id,
        projectId: null,
        kind: 'coordinator',
        name,
        autoNamed: false,
        worktree: null,
        parentSessionId: null,
        scopeSessionIds: [memberId],
        roleAppend: 'You are the foreman of the task',
        appId: 'control',
      }
      m.sessions.set(id, session)
      m.emit({ type: 'session_created', sessionId: id, session })
      return id
    },
    { memberId, name },
  )
}

/**
 * A foreman left behind by the removed control app (#97) is still reachable. It used to be drawn as
 * its task's row in the control rail, then in a "No app" list under the orchestrator row; that list
 * went too (2026-10-05), so nothing hangs under the orchestrator any more. No app claims the
 * foreman, so it has no sidebar row, and it is found by name in the palette.
 */
test('A foreman left by the removed control app has no sidebar row and opens from the palette', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session that will become a member')
  const workerId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  const foremanId = await plantForeman(page, workerId, 'Implement the skill')
  await expect.poll(() => page.evaluate((id) => !!(window as any).__store.getState().sessions[id], foremanId)).toBe(true)

  await expect(page.getByTestId('sidebar')).not.toContainText('Implement the skill')
  await expect(page.getByTestId('sidebar')).not.toContainText('No app')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('Implement the skill')
  await page.getByTestId('palette-item-session').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(foremanId)
})

/*
 * Someone else's project evidence must never stand next to a coordinator (a dogfooding finding,
 * 2026-09-06).
 *
 * A coordinator runs from the orchestrator's home with no project of its own — yet the evidence
 * panel fell back to "the project last viewed", so opening a coordinator put the last project's
 * files and git history right next to it, reading as if the coordinator had started from that
 * folder. The fallback belongs only to the state of viewing no session at all.
 */
test('Opening a coordinator session shows an empty evidence panel — it does not fall back to the last project', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session that will become a member')
  const workerId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  // Was viewing alpha — the evidence panel is drawing alpha
  await expect(page.getByTestId('evidence-panel')).toBeVisible()

  const coordinatorId = await plantForeman(page, workerId, 'Implement the skill')

  // Open the coordinator (no sidebar row; the palette and search open it this way) — with no
  // project on that session, the evidence lane itself must not exist
  await page.evaluate((id: string) => (window as any).__store.getState().focusSession(id), coordinatorId)
  await expect(page.getByTestId('session-view')).toBeVisible()
  await expect(page.getByTestId('evidence-panel')).toHaveCount(0)
  await expect(page.getByTestId('evidence-rail-shell')).toHaveCount(0)

  // Returning to the worker (alpha) brings the evidence back — it was not removed, only the
  // fallback was
  await page.evaluate((id: string) => (window as any).__store.getState().focusSession(id), workerId)
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

/**
 * What the person typed survives even if the send path fails or races (#180).
 */
test('If the orchestrator fails to come to life, the first question returns to the composer (#180)', async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(() => {
    ;(window as any).__mock.agents.orchestrator = async () => {
      throw new Error('no tool')
    }
  })
  await page.getByTestId('orchestrator-input').fill('what is running?')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('orchestrator-input')).toHaveValue('what is running?')
})

test("Turning on ⌘Enter to send also keeps the orchestrator's first composer from sending on a plain Enter (#180)", async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(() => {
    const st = (window as any).__store
    st.setState({ prefs: { ...st.getState().prefs, sendWithModifierEnter: true } })
  })
  await page.getByTestId('orchestrator-input').fill('not yet')
  await page.getByTestId('orchestrator-input').press('Enter')
  /*
   * The key was taken as a newline: a send stops the key's default and empties the box, so the
   * newline landing is the proof the Enter was handled, and handled as not a send.
   */
  await expect(page.getByTestId('orchestrator-input')).toHaveValue('not yet\n')
  await expect(page.getByTestId('orchestrator-empty')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__store.getState().orchestratorId)).toBeNull()
})
