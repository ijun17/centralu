import { test, expect } from '@playwright/test'
import { setup } from './fixtures/control.js'
import { openSessionDialog } from './fixtures/new-session.js'

/**
 * The control loop's scenarios on the first run: the intro screen, its tool cards, and registering the first project. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('Registering a project shows it in the sidebar (T5-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  // The branch does not add a line under the name — it answers only when asked (hover)
  await page.getByTestId('project-header-alpha').hover()
  await expect(page.getByTestId('project-tip-alpha')).toContainText('main')
})

test('Canceling the folder picker registers nothing', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = null
  })
  await page.getByTestId('add-project').click()
  // No dialog and no error — not picking anything is not a failure
  await expect(page.getByTestId('toast')).toHaveCount(0)
  const count = await page.evaluate(() => Object.keys((window as any).__store.getState().projects).length)
  expect(count).toBe(1)
})

/**
 * First run (#63): **the person meets the orchestrator first.**
 *
 * The goal is a habit, not efficiency — someone who never has the experience of asking the
 * orchestrator a question on first run will not click it later either. The cards on the intro
 * screen double as the tool-detection display, and clicking a card only records the setting
 * (the process only starts at the first question — lazy startup).
 */
test('First run: intro screen -> pick a card -> empty orchestrator conversation (no session yet)', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  // What the app is remains the first sentence, and the orchestrator's role stands out clearly
  // One line is all there is — what this screen sells is just "there is someone to talk to"
  await expect(page.getByTestId('intro-role')).toContainText('orchestrator')
  // The sidebar stays fully live even while reading the intro — it does not force the flow
  await expect(page.getByTestId('add-project')).toBeVisible()
  await expect(page.getByTestId('orchestrator-button')).toBeVisible()
  await expect(page.getByTestId('grid-button')).toBeVisible()
  // Telling the person they can change this later lowers the weight of the choice
  await expect(page.getByTestId('intro')).toContainText('You can change this later')

  await page.getByTestId('intro-card-claude').click()

  // An empty conversation + three suggested questions + the escape hatch — and **no session has
  // been created yet**
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await expect(page.getByTestId('suggest-create-project')).toBeVisible()
  await expect(page.getByTestId('orchestrator-pick-folder')).toBeVisible()
  const sessionCount = await page.evaluate(() => (window as any).__mock.sessions.size)
  expect(sessionCount).toBe(0)
})

test('Clicking a suggested question sends it immediately — only then is the orchestrator born (#63 lazy startup)', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-codex').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()

  await page.getByTestId('suggest-capabilities').click()

  // The question lands in the conversation as a user message (no intermediate step like filling
  // the composer)
  await expect(page.getByTestId('msg-user').first()).toContainText('What can you do as the orchestrator?')
  // The card is a function of the message count — now that a first message exists, it disappears
  await expect(page.getByTestId('orchestrator-suggestions')).toHaveCount(0)
  // The tool picked on the intro screen is the orchestrator's tool
  const tool = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...m.sessions.values()].find((s: any) => s.projectId === null)?.tool
  })
  expect(tool).toBe('codex')
})

test('A project can be created from the intro screen too — the sidebar appears alongside it (#63)', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()

  // Without picking a tool card, register right from where the intro was being read
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('add-project').click()

  // Once a project exists, this is no longer a first-time person — the intro steps back and the
  // ordinary app appears
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  await expect(page.getByTestId('intro')).toHaveCount(0)
  await expect(page.getByTestId('orchestrator-button')).toBeVisible()
})

/**
 * A way to skip the intro must also stay open (#63).
 *
 * At one point the view-switch buttons were removed from the sidebar next to the intro — the
 * reasoning was that clicking them did not change the screen, so they were dead clicks. The
 * diagnosis was right and the fix was wrong: the answer is not to hide them but to make them
 * work. Hiding them means forcing "reading the intro" while claiming "we do not force a
 * conversation".
 */
test('The intro can be skipped — the grid button actually works (#63)', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()

  // Go to the grid without picking a tool card
  await page.getByTestId('grid-button').click()

  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('intro')).toHaveCount(0)

  // The intro that has already been passed does not come back (even after reloading)
  await page.reload()
  await expect(page.getByTestId('intro')).toHaveCount(0)
})

test('First-run escape hatch: does not force a conversation — picking a folder leads into creating a session', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()

  // It does not stop at registration — the next step (creating a session) opens right there for
  // that project
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

test('Intro screen: the card doubles as the tool-detection display — "not installed" and "not logged in" get different remedies (E-1)', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const m = (window as any).__mock
    // Keep the mock's tool description (name, display name, install/login commands) as is, only
    // change the state
    const as = (name: string, s: object) => ({ ...m.detected.find((t: any) => t.name === name), ...s })
    const list = [
      as('claude', { installed: false, loggedIn: false, detail: 'not installed' }),
      as('codex', { installed: true, loggedIn: false, detail: 'codex-cli 0.147' }),
    ]
    m.agents.detect = async () => list
  })
  await page.getByTestId('redetect').click()
  // The diagnosis is visible at a glance — a disabled card says "Not connected" (dimmed, unclickable)
  await expect(page.getByTestId('intro-card-claude-status')).toContainText('Not connected')
  await expect(page.getByTestId('intro-card-claude')).toBeDisabled()
  // The remedy depends on the state: not installed -> install command, not logged in -> login command
  await expect(page.getByTestId('intro-card-claude')).toContainText('npm i -g @anthropic-ai/claude-code')
  await expect(page.getByTestId('intro-card-codex')).toContainText('codex login')
  await expect(page.getByTestId('intro-card-codex')).not.toContainText('npm i -g')
  // With neither usable, being truly blocked here is correct
  await expect(page.getByTestId('intro-blocked')).toBeVisible()
})

test('Intro screen: does not block when only one tool is ready — proceed through that card (#11)', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const as = (name: string, s: object) => ({ ...m.detected.find((t: any) => t.name === name), ...s })
    const list = [
      as('claude', { installed: true, loggedIn: false, detail: '2.1.223 · login required' }),
      as('codex', { installed: true, loggedIn: true, detail: 'codex-cli 0.147' }),
    ]
    m.agents.detect = async () => list
  })
  await page.getByTestId('redetect').click()
  // What an unauthenticated claude needs is "log in", not "install"
  await expect(page.getByTestId('intro-card-claude')).toContainText('claude auth login')
  await expect(page.getByTestId('intro-card-claude')).not.toContainText('npm i -g')
  await expect(page.getByTestId('intro-card-claude')).toBeDisabled()
  await expect(page.getByTestId('intro-blocked')).toHaveCount(0)
  // The ready card stays active — clicking it enters the app
  await page.getByTestId('intro-card-codex').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
})

test('When a tool cannot be used, the reason is shown (M2.5: the start button used to do nothing)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    const as = (name: string, s: object) => ({ ...m.detected.find((t: any) => t.name === name), ...s })
    const list = [
      as('claude', { installed: false, loggedIn: false, detail: 'claude CLI not found' }),
      as('codex', { installed: true, loggedIn: true, detail: 'codex 0.147' }),
    ]
    m.agents.detect = async () => list
  })
  await openSessionDialog(page, 'alpha')
  // If even one tool is usable, open with that one (#11) — do not put up a wall first
  await expect(page.getByTestId('create-session-confirm')).toBeEnabled()
  await expect(page.getByTestId('tool-blocked')).toHaveCount(0)

  // If the person still picks the unusable one directly, state the reason —
  // a merely disabled button looks like "nothing happened"
  await page.getByTestId('tool-option-claude').click()
  await expect(page.getByTestId('tool-blocked')).toContainText('not found')
  await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
  // Switching to a usable tool unblocks it immediately
  await page.getByTestId('tool-option-codex').click()
  await expect(page.getByTestId('create-session-confirm')).toBeEnabled()
})

test('An unauthenticated tool is described differently from an uninstalled one (#11)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    const as = (name: string, s: object) => ({ ...m.detected.find((t: any) => t.name === name), ...s })
    const list = [
      // Before #11, claude was never detected in this state, so this branch was unreachable
      as('claude', { installed: true, loggedIn: false, detail: 'claude 2.1.223 · login required' }),
      as('codex', { installed: false, loggedIn: false, detail: 'codex CLI not found' }),
    ]
    m.agents.detect = async () => list
  })
  await openSessionDialog(page, 'alpha')
  // With neither usable there is nowhere else to move to — instead, state exactly what claude needs
  await expect(page.getByTestId('tool-blocked')).toContainText('needs a login')
  await expect(page.getByTestId('tool-blocked')).toContainText('claude auth login')
  await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
})
