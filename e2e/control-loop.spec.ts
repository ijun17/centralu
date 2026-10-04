import { test, expect, type Locator, type Page } from '@playwright/test'

/**
 * Meets the M1 Phase 5 completion criteria. Drives the UI with the mock platform (?mock).
 * The core is the final "control loop" scenario — whether the actual usage flow from §1.3 runs.
 */

/** Helper that drives the mock inside the browser (window.__mock) */
async function setup(page: Page, opts: { projects?: string[] } = {}) {
  await page.goto('/?mock=1')
  // On first run the intro screen comes first (#63) — pick one tool card for the orchestrator to run
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  // Clicking the card leads to the orchestrator screen (empty conversation + suggested questions)
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  for (const [i, path] of (opts.projects ?? []).entries()) {
    if (i === 0) {
      /*
        Register the first project as the **escape hatch** from the empty orchestrator screen
        (#63 — do not force a conversation). With zero projects there is no + button in the sidebar.
      */
      await page.evaluate((p: string) => {
        ;(window as any).__mock.nextPickedDirectory = p
      }, path)
      await page.getByTestId('orchestrator-pick-folder').click()
      // The first registration leads straight into creating a session — here only the project is
      // needed, so close it
      await page.getByTestId('new-session-dialog').waitFor()
      await page.keyboard.press('Escape')
    } else {
      // Folder selection is a single native picker across the whole app (the path-typing dialog is
      // gone)
      await page.evaluate((p: string) => {
        ;(window as any).__mock.nextPickedDirectory = p
      }, path)
      await page.getByTestId('add-project').click()
    }
    await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
  }
}

async function newSession(page: Page, projectName: string, prompt: string) {
  // A new session goes through a dialog (FR-7: pick the tool, model and permission)
  await page.getByTestId(`project-menu-${projectName}`).click()
  await page.getByTestId(`new-session-${projectName}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
}

/**
 * The model, effort, permission and agent all live **inside a menu** below the composer (not
 * four separate selectors). When `scope` is given, it is that panel's menu — the grid gives each
 * panel its own composer.
 */
async function pickSetting(page: Page, testId: string, scope?: Locator) {
  const root = scope ?? page
  // If it is already open, use it as is — picking a model leaves the menu open (the contract
  // below), so clicking unconditionally would let the toggle close the menu
  if (!(await root.getByTestId('settings-menu').isVisible())) {
    await root.getByTestId('settings-open').click()
  }
  await expect(root.getByTestId('settings-menu')).toBeVisible()
  await root.getByTestId(testId).click()
}

/** Inject an approval request into the mock */
async function injectApproval(page: Page, sessionIdx: number, detail: Record<string, unknown>) {
  return page.evaluate(
    ({ idx, d }) => {
      const m = (window as any).__mock
      const sessions = [...(m as any).sessions.values()]
      const s = sessions[idx]
      return m.requestApproval(s.id, d)
    },
    { idx: sessionIdx, d: detail },
  )
}

async function emitEvent(page: Page, sessionIdx: number, event: Record<string, unknown>) {
  await page.evaluate(
    ({ idx, e }) => {
      const m = (window as any).__mock
      const sessions = [...(m as any).sessions.values()]
      m.emit({ ...e, sessionId: sessions[idx].id })
    },
    { idx: sessionIdx, e: event },
  )
}

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

/**
 * Proposal (#63): for propose_project, **pointing is the entire action**.
 *
 * Putting a second folder picker inside the conversation would create two doors that do the
 * same thing as the sidebar's Add project, and a first-time person would learn that "a project
 * is something you ask the orchestrator to do". There must be one door in the app, and the
 * orchestrator only tells the person where it is.
 */
test('Project proposal: no button in the conversation, but the sidebar Add project lights up', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await page.getByTestId('suggest-create-project').click()
  await expect(page.getByTestId('msg-user').first()).toBeVisible()

  // Before it lights up, it is an ordinary button
  await expect(page.getByTestId('add-project')).not.toHaveAttribute('data-hint', 'true')

  await page.evaluate(() => {
    const m = (window as any).__mock
    const orc = [...m.sessions.values()].find((s: any) => s.projectId === null)
    m.emit({
      type: 'tool_call',
      sessionId: orc.id,
      callId: 'c-prop',
      summary: {
        tool: 'mcp__centralu__propose_project',
        title: 'so your agents have a folder to work in',
        readOnly: false,
        paths: [],
      },
    })
  })

  // What remains in the conversation is one line pointing to the location — not something to click
  await expect(page.getByTestId('project-proposal')).toContainText('Add project')
  await expect(page.getByTestId('project-proposal').locator('button')).toHaveCount(0)
  // And the real door lights up
  await expect(page.getByTestId('add-project')).toHaveAttribute('data-hint', 'true')

  // Once the pointed-to door is used, the light turns off — a hint that keeps blinking after it
  // has done its job is nagging
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/proposed'
  })
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId('project-proposed')).toBeVisible()
  await expect(page.getByTestId('add-project')).not.toHaveAttribute('data-hint', 'true')
})

test('Starting a different topic after the pointer turns the light off — the subject has moved on (#63)', async ({
  page,
}) => {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await page.getByTestId('suggest-create-project').click()
  await expect(page.getByTestId('msg-user').first()).toBeVisible()

  // Reproduce the situation where the orchestrator has called propose_project
  await page.evaluate(() => {
    const m = (window as any).__mock
    const orc = [...m.sessions.values()].find((s: any) => s.projectId === null)
    m.emit({
      type: 'tool_call',
      sessionId: orc.id,
      callId: 'c-prop',
      summary: {
        tool: 'mcp__centralu__propose_project',
        title: 'To give your agents a folder to work in',
        readOnly: false,
        paths: [],
      },
    })
  })
  await expect(page.getByTestId('add-project')).toHaveAttribute('data-hint', 'true')

  // Start a different conversation without creating the project
  await page.getByTestId('prompt-input').fill('never mind — what can you do?')
  await page.getByTestId('prompt-input').press('Enter')

  // The hint ends here. If it keeps blinking, it is nagging, not a hint.
  await expect(page.getByTestId('add-project')).not.toHaveAttribute('data-hint', 'true')
})

/**
 * The last tool picked becomes that project's default.
 *
 * default_tool used to be hardcoded to 'claude' at project creation with no place that updated
 * it afterward — a person using codex had to reselect it **forever**, every time they created a
 * new session. The act of creating a session records this fact, not a settings field.
 */
test('The app remembers the last tool used — the next session starts from there', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // The second window opens with codex (checked via the actual creation parameters, not
  // aria-pressed)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params.tool).toBe('codex')
})

/**
 * Where the person clicks and where the result appears must be adjacent (issue #4).
 *
 * It used to be at the far right of the top bar — the person clicked one side of the screen and
 * had to find the result on the other side. Relying on visual judgment alone lets them drift
 * apart again, so this pins it down with coordinates.
 */
test('The Add project button sits inside the sidebar, below the project list', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const sidebar = (await page.getByTestId('sidebar').boundingBox())!
  const add = (await page.getByTestId('add-project').boundingBox())!
  const project = (await page.getByTestId('project-alpha').boundingBox())!

  // It is inside the sidebar (not the top bar)
  expect(add.x).toBeGreaterThanOrEqual(sidebar.x - 1)
  expect(add.x + add.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1)
  // Right below where a new project is appended (the end of the list)
  expect(add.y).toBeGreaterThanOrEqual(project.y + project.height - 1)
})

test('Creating a session renders the conversation stream (T5-3)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Hello')
  await expect(page.getByTestId('msg-user')).toContainText('Hello')

  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'Yes, ' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'nice to meet you' })
  await expect(page.getByTestId('msg-assistant')).toContainText('Yes, nice to meet you')
})

/*
 * Two replies with no human message between them are two separate chunks (#77). When a
 * background task finished and a new turn started, it used to butt up against the previous
 * reply with no space, showing as "...still running.All six reviews are in." This must look
 * the same whether received live or redrawn from the transcript.
 */
test('Two replies with no human message between them render as two chunks — live and from the transcript alike (#77)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Run the review')
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'One review ' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'is still running.' })
  // The turn ends, and a new turn starts with no human message
  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'All six reviews are in.' })
  await expect(page.getByTestId('msg-assistant')).toHaveText([
    'One review is still running.',
    'All six reviews are in.',
  ])

  // Open a session where two adjacent replies are stored at the end of the transcript — the shape
  // produced when history import writes one row per reply
  const id = await page.evaluate(async () => {
    const m = (window as any).__mock
    const project = Object.values((window as any).__store.getState().projects)[0] as {
      id: string
      path: string
    }
    const info = await m.agents.createSession({ projectId: project.id, cwd: project.path, tool: 'claude' })
    m.emit({ type: 'session_created', sessionId: info.id, session: info })
    const row = (seq: number, role: string, text: string) => ({
      sessionId: info.id,
      seq,
      role,
      kind: 'text',
      payload: { text },
      ts: Date.now(),
    })
    m.messages.set(info.id, [
      row(1, 'user', 'Imported question'),
      row(2, 'assistant', 'First imported reply.'),
      row(3, 'assistant', 'Second imported reply.'),
    ])
    return info.id as string
  })
  await page.evaluate((sid) => (window as any).__store.getState().focusSession(sid), id)
  await expect(page.getByTestId('msg-user')).toHaveText('Imported question')
  await expect(page.getByTestId('msg-assistant')).toHaveText([
    'First imported reply.',
    'Second imported reply.',
  ])
})

test('The first prompt becomes the session name (T5-6, FR-18)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'auth module refactor')
  await expect(page.getByTestId('session-name')).toContainText('auth module refactor')
})

test('Tool card: read-only calls are collapsed, mutating calls are expanded (T5-3)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'c1',
    summary: { tool: 'Read', title: 'Read: a.ts', readOnly: true, paths: [] },
  })
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'c1',
    ok: true,
    summary: `line one\nline two\nline three\nline four\n200 lines of file content`,
  })
  // Read-only tools start collapsed — only a preview shows, the rest stays hidden
  await expect(page.getByTestId('tool-card')).toBeVisible()
  await expect(page.getByTestId('tool-card-output')).toContainText('line one')
  await expect(page.getByTestId('tool-card-output')).not.toContainText('200 lines of file content')
  await page.getByTestId('tool-card-toggle').click()
  await expect(page.getByTestId('tool-card-output')).toContainText('200 lines of file content')
})

test('Approval: pressing y on the card approves it (T5-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })

  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-detail')).toContainText('npm run build')
  await page.locator('body').click() // Move focus outside the composer
  await page.keyboard.press('y')
  await expect(page.getByTestId('approval-card')).toBeHidden()
})

test('Approval: "always allow" states its scope (T5-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await injectApproval(page, 0, { kind: 'command', command: 'npm test --watch', cwd: '/tmp/alpha' })
  await page.getByTestId('approve-always').click()
  await expect(page.getByTestId('toast')).toContainText('this session')
  // The suggestion is exactly the approved command — the old 'npm test*'-style expansion
  // dangerously widened the approval scope for commands like rm -rf (guarded by the core
  // suggestMatcher regression test)
  await expect(page.getByTestId('toast')).toContainText('npm test --watch')
})

/**
 * An approval from another session is answered **on that session's own card** (requested by the
 * person, 2026-09-10).
 *
 * There used to be a banner at the top of the window — a place to approve a request from an
 * unfocused session right there. Every time it appeared or disappeared, **the whole screen
 * shifted** (layout shift), moving the line being read and the button about to be clicked. Now
 * that the banner is gone, there is one path: the inbox. The count announces it, clicking lands
 * on that session, and the card is where the person answers.
 */
test('An approval from another session is answered on that session card via the inbox', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A task')
  await newSession(page, 'beta', 'B task') // Focus is on beta

  await injectApproval(page, 0, { kind: 'command', command: 'ls -la', cwd: '/tmp/alpha' })

  // No banner interrupts at the top of the screen — instead the dashboard's count goes up
  await expect(page.getByTestId('approval-banner')).toHaveCount(0)
  await page.getByTestId('counter').click()
  await page.locator('[data-testid^="inbox-item-"]').first().click()

  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-detail')).toContainText('ls -la')
  await page.getByTestId('approve-allow').click()
  await expect(page.getByTestId('approval-card')).toBeHidden()
})

/**
 * The list appears **directly below where the person clicked** (requested by the person,
 * 2026-09-09). While it was a centered modal, the single action of seeing the count and opening
 * the list made the eyes move twice.
 */
test('The waiting list drops down below the top-bar count', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A')
  await emitEvent(page, 0, { type: 'turn_complete' })

  await page.getByTestId('counter').click()
  const panel = page.getByTestId('inbox')
  await expect(panel).toBeVisible()

  /*
   * Measure only after the drop-down animation (cc-drop) finishes — measuring mid-animation
   * still catches it hanging over the button. poll() waits it out (a rule set after measuring:
   * the starting position really was over the button).
   */
  const gap = async () => {
    const c = (await page.getByTestId('counter').boundingBox())!
    const d = (await panel.boundingBox())!
    return { below: Math.round(d.y - (c.y + c.height)), dx: Math.round(Math.abs(d.x - c.x)) }
  }
  await expect.poll(async () => (await gap()).below).toBeGreaterThanOrEqual(0)
  const g = await gap()
  expect(g.below).toBeLessThan(24) // It is adjacent (not a modal off in the distance)
  expect(g.dx).toBeLessThan(24) // The left edge lines up with the button
})

/**
 * The dashboard has a single count (requested by the person, 2026-09-09 — FR-12's separate
 * counts were dropped). The kind is told by each row in the list, and the top bar conveys
 * **urgency through brightness**.
 */
test('The global counter counts everything waiting as one, and brightness signals urgency', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A')
  await newSession(page, 'alpha', 'B')

  await injectApproval(page, 0, { kind: 'command', command: 'x', cwd: '/tmp' })
  await emitEvent(page, 1, { type: 'turn_complete' })

  const count = page.getByTestId('count-waiting')
  await expect(count).toContainText('02')
  // Pure white if even one approval is pending — pure white is reserved for what is blocking the person
  await expect(count).toHaveClass(/beacon/)
})

test('Control loop: clearing five waiting items using only the keyboard (T5-5 core scenario)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  for (const [proj, name] of [
    ['alpha', 'A1'],
    ['alpha', 'A2'],
    ['alpha', 'A3'],
    ['beta', 'B1'],
    ['beta', 'B2'],
  ] as const) {
    await newSession(page, proj, name)
  }

  // 2 approvals + 3 replies waiting
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })
  await injectApproval(page, 3, { kind: 'command', command: 'pytest', cwd: '/tmp/beta' })
  for (const idx of [1, 2, 4]) await emitEvent(page, idx, { type: 'turn_complete' })

  await expect(page.getByTestId('count-waiting')).toContainText('05')

  // Open the inbox — it must be sorted by urgency
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  const rows = page.locator('[data-testid^="inbox-item-"]')
  await expect(rows).toHaveCount(5)
  await expect(rows.first()).toContainText('Needs approval')

  // Handle the 2 approvals (jump with Enter -> y)
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await page.locator('body').click()
    await page.keyboard.press('y')
    await expect(page.getByTestId('approval-card')).toBeHidden()
    await page.keyboard.press('Meta+i')
  }
  /*
   * Once every approval is handled, **the pure white goes away** — meaning whatever was blocking
   * the person is gone. The exact count is not pinned down here: if an approved session
   * immediately starts waiting for the next reply, it gets counted again, and that is not the
   * fact this test is checking (whether anything urgent remains).
   */
  await expect(page.getByTestId('count-waiting')).not.toHaveClass(/beacon/)

  /*
    Clear the remaining 3 items waiting for a reply by **actually replying**.
    There used to be a single `d` key that cleared them, but that archived the session with no
    way back, so to the person it looked like deletion (dropped 2026-09-02). The inbox is a view
    over state, so the only way to clear it is to change the state — which means replying.
  */
  for (let i = 0; i < 5; i++) {
    const remaining = await page.locator('[data-testid^="inbox-item-"]').count()
    if (remaining === 0) break
    await page.keyboard.press('Enter')
    await page.getByTestId('prompt-input').fill('keep going')
    await page.getByTestId('prompt-input').press('Enter')
    await page.keyboard.press('Meta+i')
  }
  await expect(page.getByTestId('inbox-empty')).toContainText('Nothing waiting')
})

test('The "jump to next waiting" shortcut cycles through approvals first (T5-5, FR-17)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Awaiting-reply session')
  await newSession(page, 'alpha', 'Awaiting-approval session')
  await emitEvent(page, 0, { type: 'turn_complete' })
  await injectApproval(page, 1, { kind: 'command', command: 'x', cwd: '/tmp' })

  // Even starting from the reply-waiting session, cycling follows urgency order (approvals first)
  const firstId = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...(m as any).sessions.values()][0].id
  })
  await page.getByTestId(`session-row-${firstId}`).click()
  await expect(page.getByTestId('session-name')).toContainText('Awaiting-reply session')

  await page.locator('body').click()
  await page.keyboard.press('Meta+Shift+a')
  await expect(page.getByTestId('session-name')).toContainText('Awaiting-approval session')
})

test('Unread indicator and marking as read (T5-6, FR-16)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A task')
  await newSession(page, 'beta', 'B task') // Focus = beta

  /*
    The on-screen representation of unread is **the name's brightness alone** (the dot was
    removed — it was a third way of saying the same fact already told by the status ring and the
    name). The test checks the row's data-unread attribute, not a color class.
  */
  // New content in an unfocused session -> unread
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'Here are the results' })
  const sessionId = await page.evaluate(() => {
    const m = (window as any).__mock
    return [...(m as any).sessions.values()][0].id
  })
  const row = page.getByTestId(`session-row-${sessionId}`)
  await expect(row).toHaveAttribute('data-unread', 'true')

  // Focusing marks it read (the 3-second rule)
  await row.click()
  await expect(row).not.toHaveAttribute('data-unread', 'true', { timeout: 8000 })

  /*
    **The row currently being watched is never drawn as unread in the first place.**

    Unread means "this moved while I was elsewhere", so attaching it to the conversation in front
    of the person is noise. And it really did happen — the read-marking timer was tied to the
    session object, so it never accumulated the 3 seconds while a turn was running (dogfooding
    finding: "the white dot while the session is running").

    The test's time limit must be **below** that 3 seconds. Leaving it at the default (5 seconds)
    lets the read timer clear the marker first and the poll catch it afterward and pass — that is
    exactly what happened with the code before the actual fix. What is being asked is "did it turn
    on even briefly", so this checks within those 3 seconds.
  */
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'more came in while watching' })
  await expect(row).not.toHaveAttribute('data-unread', 'true', { timeout: 1000 })
})

test('Context gauge and limit display (FR-14, FR-9)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')

  /*
   * A session where no turn has finished yet has **no value** — the tool reports once per
   * finished turn. "Unknown" and "0%" are different statements and must look different: drawing
   * 0% when there is no value would falsely claim "nothing has been used yet".
   */
  await expect(page.getByTestId('context-gauge')).toContainText('—')
  await emitEvent(page, 0, { type: 'context_update', used: 0, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('0%')

  await emitEvent(page, 0, { type: 'context_update', used: 168000, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('84%')

  await emitEvent(page, 0, { type: 'limit_reached', usedPercent: 21, windowMins: 10080 })
  await expect(page.getByTestId('limit-badge')).toContainText('21%')
})

/**
 * The context gauge was empty after a restart (issue #48).
 *
 * The read value was correct from the start — it simply was not persisted anywhere, so on
 * restart the gauge stayed empty until that session **ran another turn**. On screen it looked
 * like a broken gauge.
 *
 * Persisting it is the host's job, and the store/manager tests guard that side. What is guarded
 * here is the next step: does the value carried in the list **actually reach the screen**? #37
 * broke at exactly this step — attach picked only the effort level off the list and filled
 * everything else with defaults, so a value that was perfectly fine in the DB disappeared only
 * on screen. Persisting it and having nobody read it back is the same bug.
 */
test('The context gauge stays filled in after restarting the app (#48)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await emitEvent(page, 0, { type: 'context_update', used: 168000, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('84%')

  // Equivalent to restarting the app: the store receives the list and rebuilds the session
  // summary from scratch
  await page.evaluate(async () => {
    const w = window as any
    await w.__store.getState().attach(w.__mock)
  })

  await expect(page.getByTestId('context-gauge')).toContainText('84%')
  // No "this might be stale" marker is attached — the gauge never promised to reflect "right
  // now". The value is always from the last finished turn, and a restart only widens that gap.
  await expect(page.getByTestId('context-gauge')).toHaveText('Context 84%')
})

test('The inbox shortcut works right after sending a message (regression: the composer was swallowing the key)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task one')
  await newSession(page, 'alpha', 'task two')
  for (const idx of [0, 1]) await emitEvent(page, idx, { type: 'turn_complete' })

  // Actual usage order: after sending a message, focus stays in the composer. Do not click body.
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(2)

  // The cursor-movement key must not get typed into the composer
  await page.keyboard.press('j')
  await expect(page.getByTestId('prompt-input')).toHaveValue('')

  /*
    And `d` must **do nothing at all.** It used to archive the session, and the screen read
    "Dismiss" — a key pressed to mean "I am not answering right now" permanently removed the
    session from the list. An irreversible action must not hide behind a single letter.
  */
  await page.keyboard.press('d')
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(2)
  await expect(page.getByTestId('prompt-input')).toHaveValue('')
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

  // It does not block. It only announces that the session is dormant, and input stays open
  await expect(page.getByTestId('dormant-note')).toBeVisible()
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

test('A long conversation renders only what is visible (D-1 virtual scroll)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'long task')

  // Inject 200 turns worth
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    for (let i = 0; i < 200; i++) {
      m.emit({
        type: 'message_delta',
        sessionId: id,
        role: 'assistant',
        text: `line ${i} — this is the conversation content.\n`,
      })
      m.emit({ type: 'turn_complete', sessionId: id })
    }
  })

  // If all 200 are rendered into the DOM, virtualization is not working
  const rendered = await page.locator('[data-testid="chat-stream"] [data-index]').count()
  expect(rendered).toBeGreaterThan(0)
  expect(rendered).toBeLessThan(60)
})

test('Auto-scroll does not interrupt while scrolled up reading (D-1)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Injecting **before** the session is created sends events to a session that does not exist
  // yet, so nothing accumulates on screen — there is nothing to scroll and the test spins
  // uselessly. Fill it in only after creating the session.
  await newSession(page, 'alpha', 'long task')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    // Consecutive deltas merge into one assistant bubble, and a single newline is collapsed into
    // one paragraph by markdown — only a blank line actually breaks the paragraph and makes the
    // screen grow taller
    for (let i = 0; i < 100; i++)
      m.emit({
        type: 'message_delta',
        sessionId: id,
        role: 'assistant',
        text: `line ${i} — this is the conversation content.\n\n`,
      })
  })

  const stream = page.getByTestId('chat-stream')
  // For "scrolled up" to be a meaningful state, the scrollable range must be far larger than the
  // bottom slack (scroll.ts BOTTOM_SLACK=80px) — otherwise even the very top counts as "near the
  // bottom" and following it would be correct, and with zero range scrollTop is always 0, making
  // the check pass vacuously
  await expect.poll(() => stream.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(400)
  await stream.evaluate((el) => {
    el.scrollTop = 0
  }) // Scrolled to the very top, reading
  // Virtual scroll can nudge the position slightly right after scrolling, once it measures the
  // actual item sizes — the baseline must be taken only after that correction settles, so this
  // measures the effect of the new message alone
  await expect
    .poll(async () => {
      const now = await stream.evaluate((el) => el.scrollTop)
      await page.waitForTimeout(120)
      return (await stream.evaluate((el) => el.scrollTop)) === now
    })
    .toBe(true)
  const before = await stream.evaluate((el) => el.scrollTop)

  // A new message arriving does not pull the scroll back down
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'new line\n' })
  })
  await page.waitForTimeout(300)
  expect(await stream.evaluate((el) => el.scrollTop)).toBe(before)
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

test('Messages in unfocused sessions are trimmed (D-2 windowing)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'long session')
  await newSession(page, 'alpha', 'another session')

  const longId: string = (
    await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))
  )[0]!
  await page.evaluate((id) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    store.getState().focusSession(id)
    // Deltas merge into one message, so fill it with tool calls, which actually add distinct entries
    for (let i = 0; i < 300; i++) {
      m.emit({
        type: 'tool_call',
        sessionId: id,
        callId: `c${i}`,
        summary: { tool: 'Read', title: `file ${i}`, readOnly: true, paths: [] },
      })
    }
  }, longId)

  const before = await page.evaluate((id) => (window as any).__store.getState().chat[id].length, longId)
  expect(before).toBeGreaterThan(100)

  // Switching to another session trims it from memory
  await page.evaluate(() => {
    const store = (window as any).__store
    const ids = Object.keys(store.getState().sessions)
    store.getState().focusSession(ids[1])
  })
  const after = await page.evaluate((id) => (window as any).__store.getState().chat[id].length, longId)
  expect(after).toBeLessThanOrEqual(50)
})

test('Scrubbing up and down through 10 inbox items never pushes the cursor out of the list (L4-3 repeated operation)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  for (let i = 0; i < 10; i++) await newSession(page, 'alpha', `task ${i}`)
  await page.evaluate(() => {
    const m = (window as any).__mock
    for (const id of m.sessions.keys()) m.emit({ type: 'turn_complete', sessionId: id })
  })

  await page.keyboard.press('Meta+i')
  await expect(page.locator('[data-testid^="inbox-item-"]')).toHaveCount(10)

  /*
    Go all the way down and back up using only the keyboard. If the cursor ever points outside
    the list, Enter opens no session, and at that moment the inbox becomes a window that does not
    respond to input.
    (This used to be checked by deleting items with `d` — that key archived the session, and
    archiving has since been dropped. What the cursor must uphold has not changed.)
  */
  for (let i = 0; i < 15; i++) await page.keyboard.press('j')
  for (let i = 0; i < 15; i++) await page.keyboard.press('k')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('inbox')).toBeHidden()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

test('The layout does not break even in a narrow window (L4-4)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 })
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // If horizontal scroll appears, something overflowed
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

/**
 * The menu appears **right next to the button that opened it**.
 *
 * It used to be fixed at one spot in the top right of the sidebar (with no positioned ancestor,
 * its coordinates resolved relative to the sidebar) — clicking the tenth project produced a
 * response at the very top, and the screen gave no clue which button the menu belonged to. When
 * there is no room below, it flips upward.
 */
test('The project menu opens below the clicked button, and flips upward when there is no room', async ({
  page,
}) => {
  /*
    There are three projects because the flipped menu needs **room to fit entirely above**. Once
    "New app..." was added to the menu (M4 C-1), the menu grew one line taller, and it no longer
    fits above the second project's button (it hits the top edge and covers the button). What
    this test checks is the flip itself, not the second row's coordinates — it measures against
    the third row, which does have room above it.
  */
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta', '/tmp/gamma'] })

  const geometry = async (name: string) => {
    await page.getByTestId(`project-header-${name}`).hover()
    await page.getByTestId(`project-menu-${name}`).click()
    const menu = page.getByTestId(`project-menu-open-${name}`)
    await expect(menu).toBeVisible()
    const b = (await page.getByTestId(`project-menu-${name}`).boundingBox())!
    const m = (await menu.boundingBox())!
    const viewport = page.viewportSize()!
    await page.keyboard.press('Escape')
    return { b, m, viewport }
  }

  const alpha = await geometry('alpha')
  // Below the button, aligned with the button's right edge
  expect(alpha.m.y).toBeGreaterThanOrEqual(alpha.b.y + alpha.b.height)
  expect(Math.round(alpha.m.x + alpha.m.width)).toBe(Math.round(alpha.b.x + alpha.b.width))
  // And it fits entirely within the screen
  expect(alpha.m.y + alpha.m.height).toBeLessThanOrEqual(alpha.viewport.height)

  /*
    **Under zoom too.** Using a measured coordinate (screen px already multiplied by zoom)
    directly as a fixed length (which gets multiplied by zoom again when drawn) put the menu 24px
    below and 103px to the left of the button at 1.1x zoom (measured — a dogfooding finding: "the
    menu position looks wrong"). A test that only measures at 1.0x zoom misses this whole class of
    bug. The person's actual setting is 1.1x.
  */
  await page.evaluate(() => {
    const style = document.documentElement.style as CSSStyleDeclaration & { zoom: string }
    style.zoom = '1.1'
    style.setProperty('--text-zoom', '1.1')
  })
  const zoomed = await geometry('alpha')
  const gap = zoomed.m.y - (zoomed.b.y + zoomed.b.height)
  expect(gap).toBeGreaterThanOrEqual(2)
  expect(gap).toBeLessThanOrEqual(8) // If zoom gets multiplied in twice, this exceeds 24
  expect(Math.abs(zoomed.m.x + zoomed.m.width - (zoomed.b.x + zoomed.b.width))).toBeLessThanOrEqual(2)
  await page.evaluate(() => {
    const style = document.documentElement.style as CSSStyleDeclaration & { zoom: string }
    style.zoom = '1'
    style.setProperty('--text-zoom', '1')
  })

  /*
    The flip is only visible where opening downward would overflow, and that spot only appears by
    shrinking the window. At 320px it still fits (menu bottom at 307.5 < 312) — the threshold is
    set by measurement, not by assuming the flip.
  */
  await page.setViewportSize({ width: 1200, height: 240 })
  const gamma = await geometry('gamma')
  expect(gamma.m.y + gamma.m.height).toBeLessThanOrEqual(gamma.b.y) // It went above the button
  expect(gamma.m.y).toBeGreaterThanOrEqual(0)
})

/*
 * A narrow sidebar (dogfooding finding: shrinking the sidebar pushed the menu off the left edge
 * of the window, out of sight). The menu aligns with the button's right edge and opens leftward,
 * so when the button sits near the left edge of the window, the menu's width (192px) exceeds the
 * minimum sidebar width (180px) and gets clipped on the left — the session menu uses the same
 * shell (RowMenu), so measuring one side effectively measures both.
 */
test('A row menu stays fully on screen even when the sidebar is narrow', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'in a narrow spot')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate(() => (window as any).__store.getState().setSidebarWidth(0)) // Collapses to the minimum

  await page.getByTestId('project-menu-alpha').click()
  const pm = (await page.getByTestId('project-menu-open-alpha').boundingBox())!
  expect(pm.x).toBeGreaterThanOrEqual(0)
  await page.keyboard.press('Escape')

  await page.getByTestId(`session-menu-${id}`).click()
  const sm = (await page.getByTestId(`session-menu-open-${id}`).boundingBox())!
  expect(sm.x).toBeGreaterThanOrEqual(0)
})

test('Creating a session: only the tool is picked — model and permission are set after, in the header (M2.5)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
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
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
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
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  // With neither usable there is nowhere else to move to — instead, state exactly what claude needs
  await expect(page.getByTestId('tool-blocked')).toContainText('needs a login')
  await expect(page.getByTestId('tool-blocked')).toContainText('claude auth login')
  await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
})

test('Agent replies render as markdown (M2.5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await emitEvent(page, 0, {
    type: 'message_delta',
    role: 'assistant',
    text: '## Result\n\n- **Important** item\n- a `code` snippet\n\n```ts\nconst x = 1\n```',
  })
  const md = page.getByTestId('markdown')
  await expect(md.locator('h2')).toContainText('Result')
  await expect(md.locator('strong')).toContainText('Important')
  await expect(md.locator('pre code')).toContainText('const x = 1')
})

test('The create-session dialog warns about concurrent sessions (FR-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'the task that started first')
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('concurrent-warning')).toContainText('lose')
})

test('3-lane layout: the evidence panel sits alongside the conversation and collapses with ⌘B (B-0)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Git and files do not replace the conversation — both must be visible at once
  await expect(page.getByTestId('chat-stream')).toBeVisible()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
  await expect(page.getByTestId('evidence-project')).toContainText('alpha')

  await page.keyboard.press('Meta+b')
  await expect(page.getByTestId('evidence-panel')).toBeHidden()
  // Collapsing the panel leaves the conversation untouched
  await expect(page.getByTestId('chat-stream')).toBeVisible()

  // The collapsed state is captured in the snapshot and restored after a restart
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelOpen).toBe(false)

  await page.keyboard.press('Meta+b')
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

test('Git: the diff gets the wide area; the list, staging and commit live in the sidebar (B-2, B-6 — left column removed 2026-09-07)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/new.ts', staged: false, status: '?' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged'
  })
  await newSession(page, 'alpha', 'task')

  // Clicking a file in the sidebar opens the wide diff — the wide area has no list in it
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  await expect(page.getByTestId('git-panel').locator('[data-testid^="git-file-"]')).toHaveCount(0)
  // The diff is achromatic: distinguished by symbol and brightness, not color
  await expect(page.locator('[data-diff="add"]')).toContainText('new line')
  await expect(page.locator('[data-diff="del"]')).toContainText('old line')

  // The sidebar is the source of truth for staging and commit (visible even with an overlay open — #15)
  await page.getByTestId('evidence-stage-all').click()
  await page.getByTestId('evidence-commit-message').fill('test commit')
  await page.getByTestId('evidence-commit').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('test commit')
})

test('Git panel: a copied diff comes out exactly as that diff (#36)', async ({ page }) => {
  const diff =
    '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-const old = 1\n+const next = 1\n   indented\n unchanged'
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate((d) => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = d
  }, diff)
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()

  // Drag the whole diff. Nothing here is virtualized, so every row is under the pointer —
  // what went wrong is the marker: it lives in its own select-none span, and here the
  // browser honours that and drops it, leaving added and removed lines identical.
  const rows = page.locator('[data-testid="diff-view"] [data-diff]')
  const first = (await rows.first().boundingBox())!
  const last = (await rows.last().boundingBox())!
  // From the very left edge — the marker column, which is the start of the line
  await page.mouse.move(first.x + 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(last.x + last.width - 4, last.y + last.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.keyboard.press('Meta+c')

  // Whatever it looks like on screen, what comes off it is a diff you can apply: ASCII
  // markers rather than the typographic −, and indentation the DOM had already collapsed
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(diff)

  // The file header used to lose a dash to the marker-stripping, on screen too
  await expect(page.getByTestId('diff-view')).toContainText('--- a/src/a.ts')
})

test('Git panel: checking out with a dirty working tree is not blocked — the result is shown first (B-4)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'feature/x', current: false, remote: false },
      { name: 'origin/main', current: false, remote: true },
    ]
    m.gitState.dirty = ['src/a.ts']
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-branch').click()
  // The panels split by the remote flag the host provides — a `/` in the name cannot distinguish
  // local feature/x from remote origin/main (#175)
  await expect(page.getByTestId('branches-remote').getByTestId('branch-origin/main')).toBeVisible()
  await expect(page.getByTestId('branches-local').getByTestId('branch-feature/x')).toBeVisible()
  await page.getByTestId('branch-feature/x').click()

  await expect(page.getByTestId('checkout-warning')).toContainText('src/a.ts')
  await page.getByTestId('checkout-proceed').click()
  await expect(page.getByTestId('toast')).toContainText('Switched')
})

test('The Git tab is disabled when the project is not a git repository (B-1 abnormal path)', async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(async () => {
    const store = (window as any).__store
    const m = (window as any).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-nogit',
      path,
      name: 'nogit',
      defaultTool: 'claude',
      git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
  await page.getByTestId('project-menu-nogit').click()
  await page.getByTestId('new-session-nogit').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('evidence-tab-git')).toBeDisabled()
  await expect(page.getByTestId('evidence-not-repo')).toBeVisible()
})

test('File tree: lazy loading + toggling ignored entries (C-2)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'src', path: 'src', isDir: true, ignored: false },
      { name: 'node_modules', path: 'node_modules', isDir: true, ignored: true },
      { name: 'README.md', path: 'README.md', isDir: false, ignored: false },
    ]
    m.fsState.entries['src'] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
    m.fsState.files['src/a.ts'] = 'line one\nline two\nline three'
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-tree')).toBeVisible()

  /*
    Ignored entries are also **visible by default** (issue #17). Hiding them reads not as
    "filtered out" but as "does not exist" — and the file someone actually opened the tree to
    find is often the untracked one. Turning it off makes them disappear, and that choice
    persists (guarded by the test below).
  */
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()
  await page.getByTestId('toggle-ignored').uncheck()
  await expect(page.getByTestId('dir-node_modules')).toBeHidden()
  await page.getByTestId('toggle-ignored').check()
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()

  // Children are read only once opened (lazy)
  await expect(page.getByTestId('file-src/a.ts')).toBeHidden()
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
})

/**
 * "Can't see ignored files" (issue #17) turned out to mean two things at once, and both
 * are pinned here.
 *
 * The default is **on**: hiding them made the tree look like the file was not there rather
 * than filtered out, and the untracked file is often the one you opened the tree to find.
 *
 * The switch stays, for node_modules and build output — thousands of rows that sort in
 * among src. So the choice that a person actually makes here is *off*, and off is what has
 * to survive. It used to be component state, so leaving for the Git tab put it straight
 * back; the only way to notice a toggle exists is to still be looking at it.
 */
test('hiding ignored files is remembered — it is a way of looking, not a per-visit choice', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'src', path: 'src', isDir: true, ignored: false },
      { name: 'node_modules', path: 'node_modules', isDir: true, ignored: true },
    ]
  })
  await newSession(page, 'alpha', 'work')
  await page.getByTestId('evidence-tab-files').click()

  // Shown without being asked for — and still ignored: slate says "the repo does not
  // track this" without shouting it
  await expect(page.getByTestId('toggle-ignored')).toBeChecked()
  await expect(page.getByTestId('dir-node_modules')).toBeVisible()
  const tone = await page
    .getByTestId('dir-node_modules')
    .locator('span:not(:has(svg))')
    .evaluate((el) => getComputedStyle(el).color)
  const dir = await page.getByTestId('dir-src').evaluate((el) => getComputedStyle(el).color)
  const rgb = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number)
  expect(rgb(tone)[0]!).toBeLessThan(rgb(dir)[0]!)

  await page.getByTestId('toggle-ignored').uncheck()
  await expect(page.getByTestId('dir-node_modules')).toBeHidden()

  // The Git tab takes the tree off screen entirely — this is where it used to be forgotten
  await page.getByTestId('evidence-tab-git').click()
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await page.getByTestId('evidence-tab-files').click()

  await expect(page.getByTestId('toggle-ignored')).not.toBeChecked()
  await expect(page.getByTestId('dir-node_modules')).toBeHidden()
  // The tree is still there, so "hidden" is the filter and not an empty panel
  await expect(page.getByTestId('dir-src')).toBeVisible()

  // …and it is the stored choice, not just this component's memory
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.showIgnored).toBe(false)
})

test('Code viewer: opening a file, search, and large files (C-3, FR-6)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'big.ts', path: 'big.ts', isDir: false, ignored: false }]
    m.fsState.files['big.ts'] = Array.from({ length: 3000 }, (_, i) => `line ${i} content`).join('\n')
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-big.ts').click()

  // Opening a file covers the screen with a wide overlay
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('big.ts')

  // Even with 3000 lines, only what is visible gets rendered (virtual scroll)
  const rendered = await page.locator('[data-testid="code-viewer"] .whitespace-pre').count()
  expect(rendered).toBeLessThan(120)

  await page.getByTestId('viewer-search').fill('line 42 ')
  await expect(page.getByTestId('viewer-match-count')).toContainText('1 line')

  // Enter/Shift+Enter move between matches — bringing off-screen matches into view too (#183)
  const search = page.getByTestId('viewer-search')
  await search.fill('line 2999 ')
  await expect(page.getByTestId('viewer-match-count')).toContainText('1 line')
  await search.fill('9 content')
  await search.press('Enter')
  await expect(page.getByTestId('viewer-match-count')).toHaveText('1/300')
  await expect(page.locator('[data-current-match]')).toContainText('line 9 content')
  await search.press('Shift+Enter')
  await expect(page.getByTestId('viewer-match-count')).toHaveText('300/300')
  await expect(page.locator('[data-current-match]')).toContainText('line 2999 content')
})

/**
 * Copying out of the viewer (issue #36).
 *
 * The viewer is virtualized, so only ~40 rows exist in the DOM at any moment, and each row
 * carries its line number as a sibling span. A browser left to itself therefore copies a
 * fragment of the selection with the numbers mixed in. These tests read the real clipboard,
 * because the payload is the whole point — the on-screen highlight is not what was broken.
 */
async function openBigFile(page: Page, lines: number, opts: { truncated?: boolean } = {}) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(
    ({ n, truncated }) => {
      const m = (window as any).__mock
      m.fsState.entries[''] = [{ name: 'big.ts', path: 'big.ts', isDir: false, ignored: false }]
      const text = Array.from({ length: n }, (_, i) => `const line${i} = ${i}`).join('\n')
      m.fs.readFile = async () => ({ text, truncated, binary: false, bytes: text.length })
    },
    { n: lines, truncated: !!opts.truncated },
  )
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-big.ts').click()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

test('Viewer copy: ⌘A gives the whole file (#36)', async ({ page }) => {
  await openBigFile(page, 3000)

  // Nobody clicked anything: the code area takes focus when the file opens, which is what
  // gives ⌘A somewhere to land.
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+c')

  const copied = await clipboard(page)
  expect(copied.split('\n')).toHaveLength(3000)
  expect(copied.startsWith('const line0 = 0\nconst line1 = 1')).toBe(true)
  expect(copied.endsWith('const line2999 = 2999')).toBe(true)
})

test('Viewer copy: copying continues through lines that were never rendered (#36)', async ({ page }) => {
  await openBigFile(page, 3000)

  // Drag from line 3 and hold the pointer past the bottom edge so the list autoscrolls —
  // the way anyone selects a long stretch. Row 3 is recycled almost immediately, and from
  // there the browser walks the anchor out of the rows and into the app chrome: left alone,
  // ⌘C copies "Files / esc back to chat / Open in IDE" and none of the file.
  const start = (await page.locator('[data-testid="code-viewer"] .whitespace-pre').nth(3).boundingBox())!
  const view = (await page.getByTestId('code-viewer').boundingBox())!
  await page.mouse.move(start.x + 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(view.x + 60, view.y + view.height + 40, { steps: 5 })
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100)
    await page.mouse.move(view.x + 60 + (i % 2), view.y + view.height + 40)
  }
  await page.mouse.up()
  await page.keyboard.press('Meta+c')

  const rows = (await clipboard(page)).split('\n')
  // Hundreds of the lines in between were never in the DOM to be copied from
  expect(rows.length).toBeGreaterThan(300)
  expect(rows[0]).toBe('const line3 = 3')
  expect(rows[1]).toBe('const line4 = 4')
  // …the run has no gaps, and no line number rode along with any of it
  expect(rows.map((r, i) => r === `const line${i + 3} = ${i + 3}`).every(Boolean)).toBe(true)
})

test('Viewer copy: a truncated file says it was truncated (#36)', async ({ page }) => {
  await openBigFile(page, 200, { truncated: true })

  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+c')

  // Select-all claims "this is the file". When it is not, the clipboard says the same thing
  // the screen says rather than handing over half a file that looks whole.
  const copied = await clipboard(page)
  expect(copied).toContain('const line199 = 199')
  expect(copied.endsWith('…file is large; showing part of it. Open in your IDE to see the rest.')).toBe(true)
})

test('Viewer copy: ⌘A inside the search box behaves normally (#36)', async ({ page }) => {
  await openBigFile(page, 100)

  // The handler is the code area's, not the window's — select-all inside a text field has
  // to keep meaning select-all inside that field.
  const search = page.getByTestId('viewer-search')
  await search.fill('line1')
  await search.press('Meta+a')
  await search.type('line2')
  await expect(search).toHaveValue('line2')
})

/** A file containing one minified 4,000-character line — this is the only way to reveal whether the viewer scrolls horizontally (#139) */
async function openMinifiedFile(page: Page) {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'min.js', path: 'min.js', isDir: false, ignored: false }]
    const text = ['// head', `var a=${'b'.repeat(4_000)}`, 'short()'].join('\n')
    m.fs.readFile = async () => ({ text, truncated: false, binary: false, bytes: text.length })
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-min.js').click()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
  await expect(page.locator('[data-line="1"]')).toBeVisible()
}

const VIEWER_SCROLLER = '[data-testid="code-viewer"] .overflow-auto'

/**
 * The viewer also scrolls horizontally — so it must be reachable by keyboard (#139).
 * With `tabIndex={-1}`, once the focus received when the file opened is lost there is no way
 * back in, and a keyboard-only person can never reach the right end of a long line.
 */
test('Viewer: the scroll area is a named region, reachable by Tab and moved by the arrow keys (#139)', async ({
  page,
}) => {
  await openMinifiedFile(page)

  // Measure first: if there is no horizontal scroll, this test asserts nothing
  const overflow = await page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel)!
    return root.scrollWidth - root.clientWidth
  }, VIEWER_SCROLLER)
  expect(overflow).toBeGreaterThan(1_000)

  // Discard the focus received when the file opened, and tab in from the last button in the header
  await page.getByTestId('viewer-open-ide').focus()
  await page.keyboard.press('Tab')
  const focused = await page.evaluate((sel) => {
    const el = document.activeElement
    return {
      isScroller: el === document.querySelector(sel),
      role: el?.getAttribute('role') ?? null,
      label: el?.getAttribute('aria-label') ?? null,
    }
  }, VIEWER_SCROLLER)
  expect(focused).toEqual({ isScroller: true, role: 'region', label: 'Code' })

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() => page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollLeft, VIEWER_SCROLLER))
    .toBeGreaterThan(0)
})

/** If a row is `w-full`, scrolling horizontally drags its background left with it, so it no longer covers the visible width (#139) */
test('Viewer: the row background still covers the visible width even after scrolling horizontally (#139)', async ({
  page,
}) => {
  await openMinifiedFile(page)
  // Paint the short line (line 3) as a match — a long line is covered by `w-max` alone, but a
  // short line used to end within the visible width and drag the line number out with it
  // (measured: right edge at -1,500, line number at -848)
  await page.getByTestId('viewer-search').fill('short')
  await expect(page.locator('[data-line="2"]')).toHaveClass(/bg-graphite/)

  const seen = await page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel)!
    root.scrollLeft = 1_500
    const r = root.getBoundingClientRect()
    const box = (line: number) => {
      const b = document.querySelector(`[data-line="${line}"]`)!.getBoundingClientRect()
      return { left: b.left - r.left, right: b.right - (r.left + root.clientWidth) }
    }
    const gutter = document.querySelector('[data-line="2"] > span')!.getBoundingClientRect()
    return { scrollLeft: root.scrollLeft, long: box(1), short: box(2), gutterLeft: gutter.left - r.left }
  }, VIEWER_SCROLLER)

  // The horizontal scroll must actually happen for this test to assert anything
  expect(seen.scrollLeft).toBe(1_500)
  for (const row of [seen.long, seen.short]) {
    expect(row.left).toBeLessThanOrEqual(1)
    expect(row.right).toBeGreaterThanOrEqual(-1)
  }
  // The line number does not get dragged out and stays on the left
  expect(Math.abs(seen.gutterLeft)).toBeLessThanOrEqual(1)
})

test('Viewer: a binary file just gets a notice (C-3 abnormal path)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'logo.png', path: 'logo.png', isDir: false, ignored: false }]
    m.fs.readFile = async () => ({ text: '', truncated: false, binary: true, bytes: 20480 })
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-logo.png').click()
  await expect(page.getByTestId('viewer-binary')).toContainText('Binary')
})

test('Viewer: a supported image is previewed from its raw bytes', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'logo.png', path: 'logo.png', isDir: false, ignored: false }]
    m.fs.readFile = async () => ({
      text: '',
      truncated: false,
      binary: true,
      bytes: 68,
      image: {
        mime: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFpEAAAAAASUVORK5CYII=',
      },
    })
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-logo.png').click()
  await expect(page.getByTestId('viewer-image')).toBeVisible()
  const image = page.getByTestId('viewer-image-content')
  await expect(image).toHaveAttribute(
    'src',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFpEAAAAAASUVORK5CYII=',
  )
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
  await expect(page.getByTestId('viewer-search')).toHaveCount(0)
})

test('Viewer: SVG toggles between the rendered image and raw source', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
  await page.evaluate((text: string) => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'logo.svg', path: 'logo.svg', isDir: false, ignored: false }]
    m.fs.readFile = async () => ({
      text,
      truncated: false,
      binary: false,
      bytes: text.length,
      image: { mime: 'image/svg+xml', data: btoa(text) },
    })
  }, svg)
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-logo.svg').click()

  await expect(page.getByTestId('viewer-image')).toBeVisible()
  await page.getByTestId('viewer-svg-text').click()
  await expect(page.getByTestId('viewer-image')).toHaveCount(0)
  await expect(page.getByTestId('code-viewer')).toContainText(svg)
  await expect(page.getByTestId('viewer-search')).toBeVisible()
  await page.getByTestId('viewer-svg-preview').click()
  await expect(page.getByTestId('viewer-image')).toBeVisible()
})

test('Attachments: attaching a file shows it in the list and rides along with the send (D, FR-13)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('attach-input').setInputFiles({
    name: 'screenshot.png',
    mimeType: 'image/png',
    buffer: Buffer.from('fake image data'),
  })
  await expect(page.getByTestId('attachment-list')).toContainText('screenshot.png')

  await page.getByTestId('prompt-input').fill('take a look at this screen')
  await page.getByTestId('send').click()

  const sent = await page.evaluate(() => (window as any).__mock.sentAttachments)
  expect(sent).toHaveLength(1)
  expect(sent[0].name).toBe('screenshot.png')
  // The attachment also shows up in the conversation
  await expect(page.getByTestId('msg-user').last()).toContainText('screenshot.png')
})

test('Sending with only an attachment and no text works (D abnormal path: empty text)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await expect(page.getByTestId('send')).toBeDisabled()
  await page.getByTestId('attach-input').setInputFiles({
    name: 'a.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.getByTestId('send')).toBeEnabled()
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

/**
 * The top bar is a dashboard — it states status, not instructions (issue #33).
 *
 * The ⌘I/⌘⇧A chips used to sit next to the waiting count and light up under **the same
 * condition** as the count. That meant that at the one moment the bar has something to say —
 * something is waiting on the person — two out of the three things that lit up said "press this
 * key".
 *
 * Only the **display** was removed, so both sides are checked together: the count alone still
 * carries the signal, the keys still work, and their name and key can be found in the palette —
 * removing the only visible mention of them would have been the failure to avoid.
 */
test('Top bar: the count is the signal, not a shortcut chip (#33)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'A')
  await injectApproval(page, 0, { kind: 'command', command: 'npm run build', cwd: '/tmp/alpha' })

  // Even with something waiting, the bar does not advertise a key — this used to be exactly when
  // the chip was brightest
  const bar = page.getByTestId('app-header')
  await expect(bar).toContainText('Waiting for input')
  await expect(bar).not.toContainText('Next item')
  await expect(bar).not.toContainText('List')

  // Lighting up remains the count's job (an approval waiting = pure white)
  await expect(page.getByTestId('count-waiting')).toContainText('01')
  await expect(page.getByTestId('count-waiting')).toHaveClass(/beacon/)

  /*
   * The glow belongs to the number alone (pointed out by the person, 2026-09-12). Because
   * `beacon`'s text-shadow is inherited, the label — which only overrides color — was wearing a
   * white halo on its dark text as well. Instead of looking luminous, it just looked out of
   * focus.
   */
  const halo = await page.getByTestId('count-waiting').evaluate((el) => ({
    label: getComputedStyle(el.firstElementChild!).textShadow,
    value: getComputedStyle(el.lastElementChild!).textShadow,
  }))
  expect(halo.label).toBe('none')
  expect(halo.value).not.toBe('none')

  // The keys themselves still work (FR-17 was left untouched)
  await page.keyboard.press('Meta+i')
  await expect(page.getByTestId('inbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inbox')).toBeHidden()

  // The palette states the name and the key
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('waiting')
  const actions = page.getByTestId('palette-item-action')
  await expect(actions.filter({ hasText: 'Waiting list' })).toContainText('⌘I')
  await expect(actions.filter({ hasText: 'Jump to next waiting' })).toContainText('⌘⇧A')

  // Someone who does not know the key can run it right from here
  await actions.filter({ hasText: 'Waiting list' }).click()
  await expect(page.getByTestId('inbox')).toBeVisible()
})

/**
 * A switch to turn off the spinning indicator (requested by the person, 2026-09-13).
 *
 * This is about power, not taste — a single ceaseless animation pins the screen to its maximum
 * refresh rate (measured: app CPU went from 7.0% to 2.9% while one session was working). Turning
 * it off does not remove the indicator, it stops it: a plain bright-gray layer remains, still
 * saying "this is currently working".
 */
test('Settings: turning off the spinning indicator stops it, leaving only a brightness cue', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  await page.evaluate((sid) => {
    ;(window as any).__mock.emit({ type: 'state_change', sessionId: sid, state: 'working' })
  }, id)
  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  /** The number of orbits actually spinning right now — counts animations, not classes */
  const spinning = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => (a as CSSAnimation).animationName === 'cc-orbit-spin' && a.playState === 'running')
          .length,
    )
  /** What the ring is painted with (::before is the actual layer) */
  const ringPaint = () =>
    page.evaluate(() => {
      const el = document.querySelector('.cc-orbit-ring-layer')!
      const s = getComputedStyle(el, '::before')
      return { image: s.backgroundImage, color: s.backgroundColor }
    })

  expect(await spinning()).toBeGreaterThan(0)
  expect((await ringPaint()).image).toContain('conic-gradient')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-spin-grid').uncheck()
  await page.getByTestId('settings-spin-icon').uncheck()
  await page.keyboard.press('Escape')

  // Nothing is spinning — this is the condition that saves power
  await expect.poll(spinning).toBe(0)
  // The indicator still remains: a plain bright-gray layer instead of the rainbow — this is the
  // panel's own border, not a drawn-on ring (#208)
  await expect(page.locator('.cc-orbit-ring-layer')).toBeHidden()
  await expect(panel).toHaveCSS('border-top-color', 'rgb(144, 144, 144)')
  // The fact that the panel is working is still readable as a value (for tests and assistive technology)
  await expect(panel).toHaveClass(/cc-orbit-ring/)

  // Turning it back on brings it back — and it survives a restart too (workspace snapshot)
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-spin-grid').check()
  await page.keyboard.press('Escape')
  await expect.poll(spinning).toBeGreaterThan(0)
})

/*
 * The send key (setting: Send with ⌘/Ctrl+Enter).
 *
 * The pure decision logic lives in composerKeys.test.ts; what is checked here is whether that
 * decision **actually reaches the real composer**. There are two things a unit-level value
 * cannot tell: whether a plain Enter, once the setting is on, really inserts a newline (the
 * textarea only does that if nothing intercepts it), and whether the setting arrives before the
 * screen renders.
 */
test('Send key: with the default setting, Enter sends', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first instruction')

  // This is the composer for someone who has never opened settings — any change here is a regression
  const input = page.getByTestId('prompt-input')
  await input.fill('just enter')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('msg-user').last()).toContainText('just enter')
})

test('Send key: once enabled, Enter inserts a newline and the modifier+Enter sends', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first instruction')

  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-send-with-mod-enter').check()
  await page.keyboard.press('Escape')

  const input = page.getByTestId('prompt-input')
  await input.fill('line one')
  await input.press('Enter')
  // Only a line was added — nothing was sent
  await expect(input).toHaveValue('line one\n')
  await input.pressSequentially('line two')
  await expect(page.getByTestId('msg-user').filter({ hasText: 'line one' })).toHaveCount(0)

  // ⌘ (on Mac) and Ctrl (elsewhere) are treated as one decision, so both send — the UI does not
  // know which platform it is on
  await input.press('Meta+Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('msg-user').last()).toContainText('line two')

  await input.fill('with ctrl too')
  await input.press('Control+Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('msg-user').last()).toContainText('with ctrl too')

  // Reloading keeps the chosen value — if the setting were not remembered, this feature would
  // have to be re-enabled every time
  await page.reload()
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-appearance').click()
  await expect(page.getByTestId('settings-send-with-mod-enter')).toBeChecked()
})

/*
 * The relationship between text size (zoom) and vh (dogfooding finding: "when I bump up the text
 * size, the session's composer disappears"). vh is not affected by zoom, so zooming in made the
 * 100vh shell taller than the window and pushed the bottom (the composer) outside it. After
 * switching the shell to a chain of percentages, the composer stays inside the window at every
 * zoom level.
 */
test('Settings: the composer stays inside the window even at the maximum text size', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-scale-4').click()
  await page.keyboard.press('Escape')

  /*
   * Asserting from a single measurement races the layout settling right after the scale is
   * applied — under the full suite's parallel load it intermittently read a few pixels over
   * (passed when run alone). Poll until it settles: the contract is "the composer is inside the
   * window once the layout has settled", not "from the very first frame".
   */
  const viewport = page.viewportSize()!
  const bottomEdge = async () => {
    const box = await page.getByTestId('prompt-input').boundingBox()
    return box ? box.y + box.height : Number.POSITIVE_INFINITY
  }
  await expect.poll(bottomEdge).toBeLessThanOrEqual(viewport.height + 1)
  // Reverting stays inside the window too — growing and shrinking never loses its place
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-scale-0').click()
  await page.keyboard.press('Escape')
  await expect.poll(bottomEdge).toBeLessThanOrEqual(viewport.height + 1)
})

/*
 * The grid's column count is not affected by the text scale (dogfooding finding: "it is one row
 * at scale 3 but two rows at scale 4"). ResizeObserver measurements are in zoom coordinates, so
 * without converting to real pixels, the same window measures narrower as the scale goes up and
 * columns collapse. A window width of 1100 (860 for the grid after subtracting the 240 sidebar)
 * is exactly the width where the bug shows up: two panels (MIN_PANEL_W=380) fit at scale 1, but
 * using the raw zoom coordinate collapses them at 1.25 (860/1.25=688 < 760).
 */
test("Settings: changing the text size does not change the grid's column count", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 })
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'one')
  await newSession(page, 'alpha', 'two')
  await page.evaluate(() => {
    const store = (window as never as { __store: any }).__store
    const ids = Object.keys(store.getState().sessions)
    store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId })))
  })
  await page.getByTestId('grid-button').click()

  // The column count lives on the inner display:grid element — the outer element
  // (data-testid="grid") is a flex container
  const colsOf = () =>
    page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector<HTMLElement>('[data-testid="grid"] div.grid')!,
        ).gridTemplateColumns.split(' ').length,
    )
  const before = await colsOf()
  expect(before).toBe(2)

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-scale-4').click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  expect(await colsOf()).toBe(2)
})

test('Settings: viewing and deleting approval rules (E-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.rulesList = [
      { id: 1, scope: 'session', matcher: 'npm test*', decision: 'allow', createdAt: Date.now() },
    ]
  })
  await newSession(page, 'alpha', 'task')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()

  // Rules now live under the Permissions tab — settings are not all stacked into one long scroll (issue #7)
  await page.getByTestId('settings-tab-permissions').click()
  await expect(page.getByTestId('rules-list')).toContainText('npm test*')
  await page.getByTestId('delete-rule-1').click()
  await expect(page.getByTestId('rules-empty')).toBeVisible()
})

/** The same rule from two different projects does not look like an identical row — each row states its owner (#183) */
test('Settings: an approval rule row shows which project or session it belongs to (#183)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'task')
  await page.evaluate(() => {
    const st = (window as any).__store.getState()
    const id = (name: string) =>
      Object.values(st.projects as Record<string, any>).find((p) => p.name === name)!.id
    ;(window as any).__mock.rulesList = [
      {
        id: 1,
        scope: 'project',
        matcher: 'pnpm test',
        decision: 'allow',
        createdAt: 1,
        projectId: id('alpha'),
        sessionId: null,
      },
      {
        id: 2,
        scope: 'project',
        matcher: 'pnpm test',
        decision: 'allow',
        createdAt: 2,
        projectId: id('beta'),
        sessionId: null,
      },
      {
        id: 3,
        scope: 'session',
        matcher: 'git push',
        decision: 'allow',
        createdAt: 3,
        projectId: null,
        sessionId: st.focusedSessionId,
      },
    ]
    st.toggleSettings(true)
  })
  await page.getByTestId('settings-tab-permissions').click()

  await expect(page.getByTestId('rule-owner-1')).toHaveText('alpha')
  await expect(page.getByTestId('rule-owner-2')).toHaveText('beta')
  await expect(page.getByTestId('rule-owner-3')).toHaveText('task')
})

test('Settings: turning off a notification policy is persisted (E-5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))

  await page.getByTestId('notify-allDone').uncheck()
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.notifyPolicy?.allDone).toBe(false)

  // The shortcuts table is also checked here (FR-17) — it lives under the Shortcuts tab
  await page.getByTestId('settings-tab-shortcuts').click()
  await expect(page.getByTestId('shortcut-list')).toContainText('⌘⇧1~4')
})

test('A permission denial is explained separately from "not a repository" (F-1, reflecting what was actually measured)', async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(async () => {
    const m = (window as any).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-denied',
      path,
      name: 'denied',
      defaultTool: 'claude',
      git: { branch: '', changedFiles: 0, isRepo: true, denied: true },
    })
    await (window as any).__store.getState().addProject('/Users/me/Desktop/proj')
  })
  // Being blocked shows immediately as a marker, and hovering explains what to do about it
  await expect(page.getByTestId('git-denied-denied')).toBeVisible()
  await page.getByTestId('project-header-denied').hover()
  await expect(page.getByTestId('git-denied')).toContainText('permission')
})

test('deleting a session: once confirmed it leaves the list and goes to the trash (M2.5, #204)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session to delete')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`delete-session-${id}`).click()
  // "Cannot be undone" is not the truth — where it goes, and how it comes back or goes for good
  await expect(page.getByTestId('delete-trash-note')).toContainText(
    'Chat history and attachments stay in Centralu’s trash',
  )
  await expect(page.getByTestId('delete-trash-note')).toContainText(
    'Settings → Trash reads it, restores it, or deletes it for good',
  )
  await page.getByTestId('confirm-delete-yes').click()

  await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Moved to the trash')
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
 * including its original (since #204: it moves to the trash, and the tool file goes when it is
 * deleted for good). The request and the note are both visible in the conversation as they
 * happen — there is no hidden step behind the scenes.
 */
test('handoff: the note starts a new session and the old one moves to the trash (#204)', async ({ page }) => {
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
  await expect(page.getByTestId('handoff-warning')).toContainText('moves to the trash')
  // The receiving agent defaults to the current tool, and deletion defaults to on
  await expect(page.getByTestId('handoff-tool-claude')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('handoff-delete-toggle').locator('input')).toBeChecked()
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

  // The new session takes the name; the old one is in the trash, its tool file marked to go when it is deleted for good (#204)
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
 * a note. Seeing that state flips all three dialog defaults at once — mode becomes record, the
 * target becomes the opposite tool, and deletion becomes off. Confirming asks the dead session
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

  // All three defaults are flipped: record mode, the opposite tool, deletion off
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
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
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

test('Clicking a project name while viewing one of its sessions opens the project screen (reported by the person, 2026-09-28)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'task')
  await expect(page.getByTestId('prompt-input')).toBeVisible()
  await expect(page.getByTestId('project-view')).toHaveCount(0)

  // The same project's name — the session used to stay put
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(page.getByTestId('project-view-name')).toHaveText('alpha')

  // Going back to a session and then to another project already worked before — this checks it
  // still does
  await page.getByTestId('project-alpha').locator('[data-testid^="session-row-"]').first().click()
  await expect(page.getByTestId('project-view')).toHaveCount(0)
  await page.getByTestId('project-header-beta').click()
  await expect(page.getByTestId('project-view-name')).toHaveText('beta')
})

/*
 * Sidebar folding (#205). The only way to fold is the arrow on the name row, and the name still
 * opens the project screen. Folding is remembered per project and survives a restart, and a
 * folded row reports the count of sessions waiting in the same shape as the session marker.
 * Navigating to that session from outside, as from the inbox, unfolds it.
 */
const sessionRows = (page: Page, project: string) =>
  page.getByTestId(`project-${project}`).locator('[data-testid^="session-row-"]')

test("Sidebar: the arrow folds and unfolds a project's session rows (#205)", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'task')
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)

  await page.getByTestId('project-fold-alpha').click()
  await expect(sessionRows(page, 'alpha')).toHaveCount(0)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  // The name row stays, and the other project is untouched
  await expect(page.getByTestId('project-header-alpha')).toBeVisible()
  await expect(page.getByTestId('project-beta')).not.toHaveAttribute('data-folded', 'true')

  await page.getByTestId('project-fold-alpha').click()
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)
  await expect(page.getByTestId('project-alpha')).not.toHaveAttribute('data-folded', 'true')

  // Fold all at once — leave only the project whose menu was opened expanded, and fold the rest
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('fold-others-alpha').click()
  await expect(page.getByTestId('project-beta')).toHaveAttribute('data-folded', 'true')
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)
})

test('Sidebar: clicking the name opens the project screen instead of folding (#205)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await expect(page.getByTestId('project-view')).toHaveCount(0)

  // Expanded, click the name — the project screen opens and the row stays as is
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)

  // Go back to the session, fold it, then click the name — still the project screen, and it does
  // not unfold either
  await sessionRows(page, 'alpha').first().click()
  await expect(page.getByTestId('project-view')).toHaveCount(0)
  await page.getByTestId('project-fold-alpha').click()
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  await expect(sessionRows(page, 'alpha')).toHaveCount(0)
})

test('Sidebar: folding survives a restart (#205)', async ({ page }) => {
  /*
   * Skip the intro with the grid button — not waking the orchestrator keeps the mock's id
   * counting the same across both runs. The real host keeps project ids in the DB, so they stay
   * the same across a restart; the mock forgets projects on reload, so this re-registers the
   * same folder in the same order to recover the same id (checked below).
   */
  const register = async () => {
    await page.evaluate(() => {
      ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
    })
    await page.getByTestId('add-project').click()
    await expect(page.getByTestId('project-alpha')).toBeVisible()
    if (await page.getByTestId('new-session-dialog').isVisible()) await page.keyboard.press('Escape')
    return page.evaluate(() => Object.keys((window as any).__store.getState().projects)[0] as string)
  }
  await page.goto('/?mock=1')
  await page.getByTestId('grid-button').click()
  const id = await register()

  await page.getByTestId('project-fold-alpha').click()
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects)).toEqual([id])

  await page.reload()
  // This must be the same project for the test to assert anything
  expect(await register()).toBe(id)
  await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
  await expect(page.getByTestId('project-fold-alpha')).toHaveAttribute('aria-label', 'Expand alpha')
})

test("Sidebar: a marker appears on the name row when a folded project's session is waiting for approval (#205)", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A task')
  await newSession(page, 'beta', 'B task') // Focus is on beta
  await page.getByTestId('project-fold-alpha').click()
  await expect(sessionRows(page, 'alpha')).toHaveCount(0)

  await injectApproval(page, 0, { kind: 'command', command: 'ls -la', cwd: '/tmp/alpha' })

  // The same chip shape as the session row marker — an approval is a pure-white (beacon) ring,
  // with a count where the label would be
  const mark = page.getByTestId('fold-summary-alpha').locator('[data-state="waiting_approval"]')
  await expect(mark).toHaveText('1')
  await expect(mark).toHaveAttribute('style', /--color-beacon/)
  await page.getByTestId('fold-summary-alpha').hover()
  await expect(page.getByTestId('fold-summary-tip-alpha')).toContainText('1 awaiting approval')
  // An expanded project has no summary — each row's own marker already says it
  await expect(page.getByTestId('fold-summary-beta')).toHaveCount(0)
})

test('Sidebar: navigating from the inbox to a session in a folded project unfolds it (#205)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'A task')
  await newSession(page, 'beta', 'B task') // Focus is on beta
  await page.getByTestId('project-fold-alpha').click()
  await injectApproval(page, 0, { kind: 'command', command: 'ls -la', cwd: '/tmp/alpha' })

  await page.getByTestId('counter').click()
  await page.locator('[data-testid^="inbox-item-"]').first().click()

  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('project-alpha')).not.toHaveAttribute('data-folded', 'true')
  await expect(sessionRows(page, 'alpha')).toHaveCount(1)
  // The unfolded state is remembered — the arrow always reflects exactly what is on screen
  expect(await page.evaluate(() => (window as any).__mock.workspaceSnapshot?.foldedProjects)).toEqual([])
})

test("A project's git, files and viewer can be viewed without any session (dogfooding finding: could not find where to look)", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
  })

  // Click the project name without creating a session
  await page.getByTestId('project-header-alpha').click()
  await expect(page.getByTestId('project-view')).toBeVisible()

  // Even with no session, the evidence panel belongs to the project, so it still shows
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
  await expect(page.getByTestId('evidence-file-src/a.ts')).toBeVisible()
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-README.md')).toBeVisible()
})

test('Window drag regions and blocked overscroll (M2.5 window issue)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // With the title bar hidden, each lane's header is the window-move handle (top bar, session,
  // evidence)
  // Each lane's header is the window-move handle (top bar, session, evidence).
  // The attribute alone breaks when text 'inside' the header is grabbed, so mousedown is also handled
  await expect(page.locator('[data-tauri-drag-region]')).toHaveCount(3)

  // The window itself does not scroll (must not rubber-band like a web page)
  const overscroll = await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY)
  expect(overscroll).toBe('none')
  const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow)
  expect(bodyOverflow).toBe('hidden')
})

/**
 * Loading a past session — '+ -> pick a tool -> list of past conversations'.
 * If a conversation started in the terminal cannot be picked up here, this app is just
 * 'one more window'.
 */
async function seedPastSessions(
  page: Page,
  data: { supported: boolean; reason?: string; sessions: Record<string, unknown>[] },
  history: Record<string, { role: string; text: string }[]> = {},
) {
  await page.evaluate(
    ({ d, h }) => {
      const m = (window as any).__mock
      m.externalSessions = d
      for (const [id, msgs] of Object.entries(h)) m.externalHistory.set(id, msgs)
    },
    { d: data, h: history },
  )
}

test('Picking and loading a past conversation from the create-session modal', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(
    page,
    {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: "yesterday's refactor",
          updatedAt: Date.now() - 3600_000,
          createdAt: null,
          branch: 'main',
          imported: false,
        },
        {
          externalId: 'ext-2',
          tool: 'claude',
          title: 'track down the broken build',
          updatedAt: Date.now() - 86400_000,
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    },
    {
      'ext-1': [
        { role: 'user', text: 'split this module up' },
        { role: 'assistant', text: 'Split into three files' },
      ],
    },
  )

  // Set ext-2 up as already loaded (the mock decides by looking at actual sessions)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-2').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  // The default is 'new conversation' — loading must never be the default
  await expect(page.getByTestId('past-new')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('past-ext-1')).toContainText("yesterday's refactor")
  // Even for a tool (codex) whose title is 'the first message', recency must still be visible
  await expect(page.getByTestId('past-ext-1')).toContainText('last 1h ago')
  await expect(page.getByTestId('past-ext-2')).toContainText('Already open')

  await page.getByTestId('past-ext-1').click()
  // The button label itself states that resuming was chosen (Load ≠ Start) — a separate notice
  // was removed (#8)
  await expect(page.getByTestId('create-session-confirm')).toHaveText('Load')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // The past conversation is restored on screen
  await expect(page.getByTestId('chat-stream')).toContainText('split this module up')
  await expect(page.getByTestId('chat-stream')).toContainText('Split into three files')

  // Was the original to resume passed through to the host?
  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params.resumeExternalId).toBe('ext-1')
  expect(params.importHistory).toBe(true)

  // A loaded conversation is not drawn as unread (it has already been read)
  const sessionId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()].at(-1))
  await expect(page.getByTestId(`session-row-${sessionId}`)).not.toHaveAttribute('data-unread', 'true')
})

test('An older tool version that cannot list past sessions does not block creating a new one', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(page, {
    supported: false,
    reason: 'The installed Codex does not support listing past sessions (update codex)',
    sessions: [],
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-unsupported')).toContainText('update codex')
  // The reason is shown, but the path must stay open
  await expect(page.getByTestId('create-session-confirm')).toHaveText('Start')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill('start fresh anyway')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('chat-stream')).toContainText('start fresh anyway')
})

test('When there are no past conversations, it says so', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(page, { supported: true, sessions: [] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-empty')).toBeVisible()
})

/**
 * The link between evidence and viewing detail.
 * The right side only holds lists; viewing detail happens in a wide overlay (a diff is
 * unreadable at 340px).
 */
test('Clicking a changed file opens the diff in a wide overlay, and Escape returns to the untouched conversation', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n-old()\n+next()'
  })
  await newSession(page, 'alpha', 'fix this function')

  await expect(page.getByTestId('evidence-change-count')).toHaveText('1')
  await page.getByTestId('evidence-file-src/a.ts').click()

  // The overlay covers the screen, opening directly to the diff for the clicked file (no need to
  // find it again in the list)
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('next()')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('overlay')).toBeHidden()
  // Closing it leaves the conversation untouched — there is no need to navigate back in
  await expect(page.getByTestId('chat-stream')).toContainText('fix this function')
})

test('A file opened from the file tree appears in the same overlay', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
    m.fsState.files['README.md'] = '# Alpha\nThis needs to be readable'
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-README.md').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('README.md')

  await page.getByTestId('overlay-close').click()
  await expect(page.getByTestId('overlay')).toBeHidden()
})

/**
 * The overlay covers the conversation, not the evidence lane (issue #15).
 *
 * It used to cover both, so opening a second file meant escape-and-find-it-again: the tree
 * you clicked from vanished under an opaque panel the moment it did its job. The assertions
 * below are the two halves of that. Geometry, because "visible" is not enough — the panel
 * was never unmounted, only hidden behind something painted over it, and Playwright's
 * visibility check does not see occlusion. Then a second click without an escape first,
 * because being uncovered is not the point either: the point is that the loop is now one
 * click long, and Playwright will not click through anything that gets in the way.
 */
test('The overlay covers only the conversation — the handle to open the next file must remain', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'a.ts', path: 'a.ts', isDir: false, ignored: false },
      { name: 'b.ts', path: 'b.ts', isDir: false, ignored: false },
    ]
    m.fsState.files['a.ts'] = 'first file'
    m.fsState.files['b.ts'] = 'second file'
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-a.ts').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('a.ts')

  // The overlay's right edge does not cross the evidence panel's left edge
  const edges = async () => {
    const o = (await page.getByTestId('overlay').boundingBox())!
    const p = (await page.getByTestId('evidence-panel').boundingBox())!
    return { overlayRight: o.x + o.width, panelLeft: p.x }
  }
  const viewerEdges = await edges()
  expect(viewerEdges.overlayRight).toBeLessThanOrEqual(viewerEdges.panelLeft + 1)

  // Go straight to the next file in the tree without Escape — if it were covered, this click
  // would not land
  await page.getByTestId('file-b.ts').click()
  await expect(page.getByTestId('viewer-path')).toContainText('b.ts')
})

/**
 * The same rule applies to diffs (issue #15). If anything, this hurts more — the change list is
 * something the person scans one file after another, and if the list disappears every time a
 * file is viewed, that scan is interrupted. The diff is unified, so a narrower width just shrinks
 * the line width and keeps the columns intact.
 */
test('The Git overlay follows the same rule — it does not cover the change list', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n-old()\n+first()'
    m.fsState.entries[''] = [{ name: 'notes.md', path: 'notes.md', isDir: false, ignored: false }]
    m.fsState.files['notes.md'] = 'This needs to be readable'
  })
  await newSession(page, 'alpha', 'fix both files')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('first()')

  const o = (await page.getByTestId('overlay').boundingBox())!
  const p = (await page.getByTestId('evidence-panel').boundingBox())!
  expect(o.x + o.width).toBeLessThanOrEqual(p.x + 1)

  // The panel stays alive — if it were covered, these clicks would be blocked by the overlay
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('file-notes.md').click()
  await expect(page.getByTestId('viewer-path')).toContainText('notes.md')
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

/** Evidence panel: split by tabs, and collapsing still leaves a way to bring it back */
test('Evidence panel tabs: Git shows only changes, and History shows the graph in its own tab', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: 'First commit', author: 'me', when: Date.now(), parents: [] },
      {
        sha: 'bbb222',
        shortSha: 'bbb222',
        subject: 'second',
        author: 'me',
        when: Date.now(),
        parents: ['a', 'b'],
      },
    ]
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'task')

  // The Git tab is the default — only changes. The history strip was moved off, covering the
  // neighboring tab strip during the split (#20)
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await expect(page.getByTestId('evidence-file-src/a.ts')).toBeVisible()
  await expect(page.getByTestId('evidence-tree')).toHaveCount(0)

  // History lives under the History tab — the lane graph that used to live in the strip moved
  // here too
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-aaa111')).toContainText('First commit')
  await expect(page.getByTestId('history-commit-bbb222')).toContainText('merge')
  await expect(page.getByTestId('commit-graph-aaa111')).toBeVisible()

  // Switching to the Files tab shows only the tree
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-README.md')).toBeVisible()
  await expect(page.getByTestId('evidence-git')).toBeHidden()

  // The chosen tab is recorded in the snapshot
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelTab).toBe('files')
})

test('Clicking a commit in History opens it in the wide area', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: 'First commit', author: 'me', when: Date.now(), parents: [] },
    ]
    m.gitState.diffs['aaa111'] = '@@ -0,0 +1 @@\n+new line'
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa111').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('new line')
})

test('Collapsing the panel leaves a rail, and it re-expands from there', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('evidence-close').click()
  await expect(page.getByTestId('evidence-panel')).toBeHidden()

  // Gone and collapsed are different — the rail stays, and the change count is readable even
  // while collapsed
  await expect(page.getByTestId('evidence-rail')).toBeVisible()
  await expect(page.getByTestId('evidence-rail-count')).toHaveText('2')

  await page.getByTestId('evidence-open').click()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

test('Staging and committing still work in a narrow panel', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
  })
  await newSession(page, 'alpha', 'task')

  // Commit is disabled before staging (a live commit button with nothing staged would be a lie)
  await page.getByTestId('evidence-commit-message').fill('commit from the panel')
  await expect(page.getByTestId('evidence-commit')).toBeDisabled()

  await page.getByTestId('evidence-stage-all').click()
  await page.getByTestId('evidence-commit').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('commit from the panel')
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

test('Dragging and dropping also attaches a file', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // On the assumption that the webview does not intercept the drop, checks whether the dropped
  // file is captured as an attachment
  const dt = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['screenshot content'], 'shot.png', { type: 'image/png' }))
    return data
  })
  await page.getByTestId('input-dropzone').dispatchEvent('drop', { dataTransfer: dt })

  await expect(page.getByTestId('attachment-list')).toContainText('shot.png')
  await page.getByTestId('send').click()
  const sent = await page.evaluate(() => (window as any).__mock.sentAttachments)
  expect(sent.at(-1).name).toBe('shot.png')
})

/**
 * #116 — a drop that **missed** the composer used to overwrite the entire app.
 *
 * Because Tauri does not intercept drops (dragDropEnabled: false), a drop nobody handles falls
 * through to the webview's default behavior: navigate to the dropped file. One PDF filled the
 * whole window, and the only way back was the browser's back button.
 *
 * A real OS drag cannot be automated, so this constructs a DataTransfer and fires it directly —
 * what the app sees (the event and the types on it) is the same either way.
 */
const dropFile = (page: Page, name: string, type = 'application/pdf') =>
  page.evaluateHandle(
    ({ n, t }: { n: string; t: string }) => {
      const data = new DataTransfer()
      data.items.add(new File(['content'], n, { type: t }))
      return data
    },
    { n: name, t: type },
  )

test('Drag-and-drop defaults to rejection across the whole window — even where there is no drop target', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const before = page.url()

  /*
    This check stands **separately** from the attachment feature. What is checked here is not
    "did it attach" but "did the browser refrain from deciding on its own", so it deliberately
    picks **spots that receive nothing** — the sidebar background and the document background.
    These are exactly the spots where a PDF used to cover the window.

    preventDefault means "the webview will not open this". All three must be checked: dragover
    and dragenter are the answer to "can something be dropped here", and if that is not blocked,
    the decision falls to the browser.
  */
  const floor = await page.evaluate(() => {
    const out: Record<string, boolean[]> = {}
    for (const where of ['sidebar', 'body']) {
      const el = where === 'body' ? document.body : document.querySelector('[data-testid="sidebar"]')!
      const data = new DataTransfer()
      data.items.add(new File(['report'], 'report.pdf', { type: 'application/pdf' }))
      out[where] = ['dragenter', 'dragover', 'drop'].map((type) => {
        const e = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true })
        el.dispatchEvent(e)
        return e.defaultPrevented
      })
    }
    return out
  })
  expect(floor).toEqual({ sidebar: [true, true, true], body: [true, true, true] })

  // And the app stays exactly where it was — this bug's symptom was "the app disappears"
  expect(page.url()).toBe(before)

  /*
    There is exactly one narrow exception. **Text dropped over a text field** is allowed through,
    as an editing action — blocking even dragging selected text into a search box would let the
    floor built for files also sweep away text. **Files are still blocked even over a text
    field**: dropping a PDF on a search box is just as much a path for the webview to open the
    file.
  */
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  const overInput = await page.evaluate(() => {
    // The text field must not preventDefault on its own, so that this measures the **global
    // floor**. The composer's own form already preventDefaults its own spot, so measuring there
    // would pass even with the guard removed, proving nothing.
    const el = document.querySelector('[data-testid="palette-input"]')!
    const drag = (kind: 'text' | 'file') => {
      const data = new DataTransfer()
      if (kind === 'file') data.items.add(new File(['report'], 'report.pdf', { type: 'application/pdf' }))
      else data.setData('text/plain', 'dragged-in text')
      const e = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      return e.defaultPrevented
    }
    return { text: drag('text'), file: drag('file') }
  })
  expect(overInput.file).toBe(true)
  expect(overInput.text).toBe(false)
  await expect(page.getByTestId('session-view')).toBeVisible()
})

test('Dropping anywhere in the panel, not just the composer, still attaches', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // The middle of the conversation — a spot that does not overlap the composer. This is exactly
  // where this bug lived.
  await page
    .getByTestId('chat-stream')
    .dispatchEvent('drop', { dataTransfer: await dropFile(page, 'report.pdf') })

  await expect(page.getByTestId('attachment-list')).toContainText('report.pdf')
  await page.getByTestId('send').click()
  const sent = await page.evaluate(() => (window as any).__mock.sentAttachments)
  expect(sent.at(-1).name).toBe('report.pdf')
})

test('Grid — a collapsed composer expands in the panel it was dropped into', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'a')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'b')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId }))), [a, b])
  await page.getByTestId('grid-button').click()
  const cell = page.getByTestId(`grid-panel-${a}`)
  await expect(cell).toBeVisible()

  /*
    The other half of this bug is that the composer defaults to collapsed (foldComposer) — the
    one spot that can receive a drop was usually off-screen. If an attachment landed there, it
    would be indistinguishable from nothing happening at all, so it must expand the moment
    something attaches.
  */
  const shell = cell.getByTestId('composer-shell')
  await expect(shell).not.toHaveAttribute('data-up', 'true')

  // The header — the spot inside the panel farthest from the composer
  await cell
    .getByTestId('pane-header')
    .dispatchEvent('drop', { dataTransfer: await dropFile(page, 'report.pdf') })

  await expect(shell).toHaveAttribute('data-up', 'true')
  await expect(cell.getByTestId('attachment-list')).toContainText('report.pdf')

  // What it attaches to is **the session of the panel it was dropped in** — not the focused
  // session (b)
  const where = await page.evaluate(() => {
    const drafts = (window as any).__store.getState().drafts
    const out: Record<string, string[]> = {}
    for (const [id, d] of Object.entries(drafts as Record<string, any>)) {
      out[id] = d.attachments.map((x: any) => x.name)
    }
    return out
  })
  expect(where[a!]).toEqual(['report.pdf'])
  expect(where[b!] ?? []).toEqual([])
})

test('Grid — making the panel a drop target does not break reordering sessions', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'a')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'b')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId }))), [a, b])
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()

  /*
    Dropping a file and reordering now end up on **the same surface**. This checks that the
    panel accepts only files (only when Files is present in types) — otherwise the panel
    silently swallows a drop meant to reorder, and that only shows up as "it sometimes does not
    move".
  */
  await page.evaluate(
    ({ from, to }: { from: string; to: string }) => {
      const dt = new DataTransfer()
      const header = document.querySelector(`[data-testid="grid-panel-${from}"] [data-testid="pane-header"]`)!
      header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
      const r = card.getBoundingClientRect()
      /*
        Where it drops is **inside** the panel — over the conversation. That is where a real
        drop actually lands, so the event bubbles up through the session screen to the panel.
        Firing directly at the card would skip the session screen and fail to check the very
        thing being checked: "does it pass the event through".
      */
      const inside = card.querySelector('[data-testid="chat-stream"]')!
      // The right half — it goes behind b
      const at = { clientX: r.left + r.width * 0.8, clientY: r.top + 10 }
      const init = { dataTransfer: dt, bubbles: true, cancelable: true, ...at }
      inside.dispatchEvent(new DragEvent('dragover', init))
      inside.dispatchEvent(new DragEvent('drop', init))
    },
    { from: a!, to: b! },
  )

  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().gridPanels.map((p: any) => p.sessionId))).toEqual([b, a])
})

test('Old conversation can still be read back through even after compaction', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // The store holds 250 lines while the screen holds only the most recent page (HISTORY_PAGE=100)
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = Array.from({ length: 250 }, (_, i) => ({
      sessionId: sid,
      seq: i + 1,
      role: i % 2 ? 'assistant' : 'user',
      kind: 'text',
      payload: { text: `old message ${i + 1}` },
      ts: Date.now(),
    }))
    m.messages.set(sid, rows)
  }, id)
  // Simulates reopening the app and expanding that session (reading from the store with nothing
  // in memory)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  // The compaction point is marked in the conversation (the fact that the model forgot, but the
  // record remains)
  await page.evaluate((sid) => (window as any).__mock.emit({ type: 'compaction', sessionId: sid }), id)
  await expect(page.getByTestId('msg-mark')).toContainText('compacted')

  // Only the most recent page is on screen (with virtual scroll, what actually renders is fewer
  // still)
  const loaded = (sid: string) => (window as any).__store.getState().chat[sid].length
  expect(await page.evaluate(loaded, id)).toBe(101) // 100 + the compaction marker

  // Scrolling up loads more automatically, without a button. Once a page loads, position
  // correction pulls the view down from the top to preserve the reading spot (#61), so this
  // scrolls up again like a person would.
  await expect(async () => {
    await page.getByTestId('chat-stream').evaluate((el) => el.scrollTo({ top: 0 }))
    await expect(page.getByTestId('load-older')).toBeHidden({ timeout: 500 }) // There is nothing further back to load
  }).toPass()

  // Even a conversation the model forgot through compaction still remains in our own record
  expect(await page.evaluate(loaded, id)).toBe(251)
  const first = await page.evaluate((sid: string) => (window as any).__store.getState().chat[sid][0].text, id)
  expect(first).toBe('old message 1')
})

/*
 * Old conversation also loads by **clicking**, not just scrolling (dogfooding finding,
 * 2026-09-04: on the actual WKWebView, scrolling up did not load the older page — even in an
 * environment where the observer does not wake up, a manual way must remain).
 */
test('Older conversation also loads by clicking a button', async ({ page }) => {
  /*
   * The observer can be switched off mid-test, to stand in for the WKWebView whose observer
   * never woke. It has to be wrapped before the app loads: the sentinel builds its observer
   * from whatever `IntersectionObserver` is at the time.
   */
  await page.addInitScript(() => {
    const Real = window.IntersectionObserver
    window.IntersectionObserver = class extends Real {
      constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        super((entries, observer) => {
          if (!(window as any).__observerDead) cb(entries, observer)
        }, opts)
      }
    }
  })
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = Array.from({ length: 250 }, (_, i) => ({
      sessionId: sid,
      seq: i + 1,
      role: i % 2 ? 'assistant' : 'user',
      kind: 'text',
      payload: { text: `old message ${i + 1}` },
      ts: Date.now(),
    }))
    m.messages.set(sid, rows)
  }, id)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  const loaded = (sid: string) => (window as any).__store.getState().chat[sid].length
  expect(await page.evaluate(loaded, id)).toBe(100)
  /*
   * Scroll up and click the button — the contract is that if any one of the scroll trigger,
   * IntersectionObserver, or click breaks, the others still carry it through to the end (the
   * "wall" stopping at 100 was that bug).
   */
  // Scrolling up loads the first batch (100->200) on its own
  await page.getByTestId('chat-stream').evaluate((el) => el.scrollTo({ top: 0 }))
  await expect.poll(() => page.evaluate(loaded, id)).toBe(200)
  await expect
    .poll(() => page.evaluate((sid) => (window as any).__store.getState().history[sid].loading, id))
    .toBe(false)

  /*
   * Then both automatic routes die, so the rest (200->250) can only be the button's.
   *
   * Clicking is itself a scroll to the top: Playwright scrolls the button into view first, and
   * that scroll is one of the two automatic triggers. Whichever ran first decided the test.
   * When the scroll event came first, it loaded the last page, the button retired because
   * nothing older remained, and the click waited on a detached element until the timeout
   * (measured 2026-10-03: 7 in 50 in Chromium, 50 in 50 in WebKit, and in every traced failure
   * the scroll handler was the caller). When the click came first it passed — and it also
   * passed with the button's click handler removed (1 in 10), because the scroll then loaded
   * the page in its place.
   *
   * Scroll events on the conversation stop at the window, before the sentinel's listener
   * hears them, and the observer is switched off.
   */
  await page.evaluate(() => {
    ;(window as any).__observerDead = true
    window.addEventListener(
      'scroll',
      (e) => {
        if ((e.target as HTMLElement).dataset?.testid === 'chat-stream') e.stopPropagation()
      },
      { capture: true },
    )
  })
  /*
   * The routes really are dead: at the top with the button on screen, nothing loads. Two frames
   * is long enough for both a scroll event and an observer callback to have been delivered.
   */
  await page.getByTestId('chat-stream').evaluate(async (el) => {
    el.scrollTo({ top: 0 })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  expect(await page.evaluate(loaded, id)).toBe(200)

  await page.getByTestId('load-older').getByRole('button').click()
  await expect.poll(() => page.evaluate(loaded, id)).toBe(250)
  // Once everything is loaded, the button retires too
  await expect(page.getByTestId('load-older')).toBeHidden()
})

/*
 * A session whose events arrive before the screen does (#79). A session the host creates behind
 * the scenes (an agent the app asked for) can finish its work before the person ever opens it.
 * The transcript must still stand even when only viewed as a grid panel (there must be a path to
 * "older conversation"), and opening it for the first time must not show the same line twice —
 * measured (2026-09-25), the prompt and the Read/Write cards each showed up twice.
 */
test('A session whose events arrive first: an older-conversation path stands even in a grid panel, and opening it shows each line only once (#79)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // The host creates two sessions behind the scenes — the UI only learns of it via session_created
  const [g, f] = await page.evaluate(async (): Promise<[string, string]> => {
    const m = (window as any).__mock
    const project = Object.values((window as any).__store.getState().projects)[0] as {
      id: string
      path: string
    }
    const made: string[] = []
    for (let i = 0; i < 2; i++) {
      const info = await m.agents.createSession({ projectId: project.id, cwd: project.path, tool: 'claude' })
      m.emit({ type: 'session_created', sessionId: info.id, session: info })
      made.push(info.id)
    }
    return [made[0]!, made[1]!]
  })
  await page.evaluate(
    ({ g, f }) => {
      const m = (window as any).__mock
      // A session shown only in a panel: 250 stored lines, plus one reply that arrived before it was opened
      m.messages.set(
        g,
        Array.from({ length: 250 }, (_, i) => ({
          sessionId: g,
          seq: i + 1,
          role: 'user',
          kind: 'text',
          payload: { text: `entry ${i + 1}` },
          ts: Date.now(),
        })),
      )
      m.emit({ type: 'message_delta', sessionId: g, role: 'assistant', text: 'reply that arrived before opening' })
      // An agent the app asked for: request -> Read -> Write -> reply, all before the person ever opened it
      m.emit({
        type: 'user_message',
        sessionId: f,
        seq: 0,
        text: 'Make a note',
        fromApp: { appId: 'notes', projectId: null, name: 'Notes' },
      })
      m.emit({
        type: 'tool_call',
        sessionId: f,
        callId: 'r',
        summary: { tool: 'Read', title: 'Read note.md', readOnly: true, paths: [] },
      })
      m.emit({ type: 'tool_result', sessionId: f, callId: 'r', ok: true, summary: 'empty' })
      m.emit({
        type: 'tool_call',
        sessionId: f,
        callId: 'w',
        summary: { tool: 'Write', title: 'Write note.md', readOnly: false, paths: [] },
      })
      m.emit({ type: 'tool_result', sessionId: f, callId: 'w', ok: true, summary: 'written' })
      m.emit({ type: 'message_delta', sessionId: f, role: 'assistant', text: 'Noted.' })
      m.emit({ type: 'turn_complete', sessionId: f })
    },
    { g, f },
  )

  // View only through a grid panel — never focus it
  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId }))), [a, g])
  await page.getByTestId('grid-button').click()
  const cell = page.getByTestId(`grid-panel-${g}`)
  await expect(cell.getByTestId('chat-stream')).toContainText('reply that arrived before opening')
  await expect(cell.getByTestId('load-older')).toBeVisible()
  // Reading all the way back, every stored line shows exactly once and in order
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const store = (window as any).__store
        await store.getState().loadOlder(id)
        return store.getState().history[id].more
      }, g),
    )
    .toBe(false)
  const texts = await page.evaluate(
    (id) => (window as any).__store.getState().chat[id].map((c: { text: string }) => c.text),
    g,
  )
  expect(texts).toEqual([...Array.from({ length: 250 }, (_, i) => `entry ${i + 1}`), 'reply that arrived before opening'])

  // Open the app-requested agent's session for the first time from the sidebar
  await page.getByTestId(`session-row-${f}`).click()
  const stream = page.getByTestId('chat-stream')
  await expect(stream).toContainText('Noted.')
  await expect
    .poll(() => page.evaluate((id) => (window as any).__store.getState().history[id], f))
    .toMatchObject({ loading: false, more: false })
  await expect(page.getByTestId('load-older')).toBeHidden()
  await expect(stream.getByTestId('msg-user').filter({ hasText: 'Make a note' })).toHaveCount(1)
  await expect(stream.getByTestId('tool-card').filter({ hasText: 'Read note.md' })).toHaveCount(1)
  await expect(stream.getByTestId('tool-card').filter({ hasText: 'Write note.md' })).toHaveCount(1)
})

/**
 * The conversation used to render garbled (4th round of dogfooding).
 * The stored transcript's seq and the live items' seq were counted separately, so React keys
 * collided, and virtual scroll drew the colliding items on top of each other, running the text
 * together.
 */
test('New messages added to a session loaded from history do not collide with existing item numbers', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Open a fresh session whose store already has a transcript with seq 1..5
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    m.messages.set(
      sid,
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: sid,
        seq: i + 1,
        role: i % 2 ? 'assistant' : 'user',
        kind: 'text',
        payload: { text: `entry ${i + 1}` },
        ts: Date.now(),
      })),
    )
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  // A live conversation continues on top of that (seq used to restart from 1 here)
  await page.getByTestId('prompt-input').fill('a fresh message')
  await page.getByTestId('send').click()
  await page.evaluate(
    (sid) =>
      (window as any).__mock.emit({
        type: 'message_delta',
        sessionId: sid,
        role: 'assistant',
        text: 'a new reply',
      }),
    id,
  )

  const seqs = await page.evaluate(
    (sid) => (window as any).__store.getState().chat[sid].map((c: { seq: number }) => c.seq),
    id,
  )
  expect(new Set(seqs).size).toBe(seqs.length)

  // With no collision, the old record and the new message each show in their own place
  await expect(page.getByTestId('chat-stream')).toContainText('entry 5')
  await expect(page.getByTestId('chat-stream')).toContainText('a fresh message')
})

test('Tool cards collapse and expand without an inner scrollbar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.emit({
      type: 'tool_call',
      sessionId: sid,
      callId: 'c1',
      summary: { tool: 'Bash', title: 'pnpm test', readOnly: true, paths: [] },
    })
    m.emit({
      type: 'tool_result',
      sessionId: sid,
      callId: 'c1',
      ok: true,
      summary: Array.from({ length: 40 }, (_, i) => `output ${i + 1}`).join('\n'),
    })
  }, id)

  const output = page.getByTestId('tool-card-output')
  await expect(output).toBeVisible()

  // Read-only tools start collapsed, showing only a preview
  await expect(output).toContainText('output 1')
  await expect(output).not.toContainText('output 40')
  await expect(page.getByTestId('tool-card-more')).toContainText('37 more lines')

  // There is no inner scroller to intercept the conversation's scroll
  const scrollable = await output.evaluate((el) => {
    const s = getComputedStyle(el)
    return s.overflowY === 'auto' || s.overflowY === 'scroll' || el.scrollHeight > el.clientHeight + 1
  })
  expect(scrollable).toBe(false)

  await page.getByTestId('tool-card-more').click()
  await expect(output).toContainText('output 40')
  const stillScrollable = await output.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(stillScrollable).toBe(false)
})

/**
 * The preview counts by **visible lines** (pointed out by the person, 2026-09-12).
 *
 * A single blob of JSON with no newlines (a resource-upload response) counted as 1 line by
 * counting newlines, so nothing got truncated, and on screen it wrapped into dozens of lines,
 * with the "collapsed" card covering the entire conversation.
 */
test('A single blob with no newlines still stops at three lines when collapsed', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.emit({
      type: 'tool_call',
      sessionId: sid,
      callId: 'c1',
      summary: { tool: 'mcp__resource__upload', title: 'upload', readOnly: false, paths: [] },
    })
    // A response with not a single newline — logically 1 line, dozens on screen
    const blob = JSON.stringify({
      resourceList: Array.from({ length: 30 }, (_, i) => ({
        ruid: `e0665a7978ed49539afab9544eec53${i}`,
        name: 'msa_532_5341503_icon_icon_c09af380e8',
        size: 1013,
      })),
    })
    m.emit({ type: 'tool_result', sessionId: sid, callId: 'c1', ok: true, summary: blob })
  }, id)

  const output = page.getByTestId('tool-card-output')
  await expect(output).toBeVisible()

  const collapsed = await output.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(el).lineHeight),
    full: el.scrollHeight,
  }))
  // Never taller than three lines (1px accounts for rounding)
  expect(collapsed.height).toBeLessThanOrEqual(collapsed.line * 3 + 1)
  // Also record that it was far taller before collapsing — proof the cap is actually doing something
  expect(collapsed.full).toBeGreaterThan(collapsed.line * 10)

  // Line counting cannot say "how many more lines" (hidden === 0) — it must still say there is more to expand
  await expect(page.getByTestId('tool-card-more')).toContainText('Show all')

  await page.getByTestId('tool-card-more').click()
  const opened = await output.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    scrollable: el.scrollHeight > el.clientHeight + 1,
  }))
  expect(opened.height).toBeGreaterThan(collapsed.line * 10)
  expect(opened.scrollable).toBe(false)
})

/**
 * Resizing the evidence panel + the terminal (M2.7).
 * A terminal's identity is its cwd — switching sessions must keep the same terminal alive.
 */
test('Dragging to resize the evidence panel persists after a restart', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const panel = page.getByTestId('evidence-panel')
  const before = (await panel.boundingBox())!.width

  const handle = page.getByTestId('evidence-resize')
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x - 160, box.y + 200, { steps: 8 })
  await page.mouse.up()

  const after = (await panel.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 100)

  // The width is captured in the snapshot (unchanged the next time it opens)
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelWidth).toBeGreaterThan(before + 100)

  // Double-click restores the default — there must be a way back after dragging it too far.
  // The width slides (an open/close transition), so measuring right away catches a mid-animation
  // value — wait for it to settle.
  await handle.dblclick()
  await expect.poll(async () => (await panel.boundingBox())!.width, { timeout: 2000 }).toBeCloseTo(340, -1)
})

test('A terminal belongs to the project, so it persists across switching sessions', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first session')
  await newSession(page, 'alpha', 'second session')

  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  // Get the terminal into a state where it has output something
  const termId = await page.evaluate(() => {
    const m = (window as any).__mock
    const t = [...m.terminalState.byCwd.values()][0][0]
    m.emitTerminal(t.id, 'hello from alpha\r\n')
    return t.id
  })

  // Switching sessions still attaches to the same terminal (a running dev server must not die)
  const first = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  await page.getByTestId(`session-row-${first}`).click()
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  const sameTerminal = await page.evaluate(() => {
    const lists = [...(window as any).__mock.terminalState.byCwd.values()]
    return lists.length === 1 && lists[0].length === 1 && lists[0][0].id
  })
  expect(sameTerminal).toBe(termId)

  // Reattaching restores the output so far (an empty screen would not be a real terminal)
  await expect(page.getByTestId(`terminal-surface-${termId}`)).toContainText('hello from alpha')
})

test('Keyboard input goes to the shell', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  const id = await page.evaluate(() => [...(window as any).__mock.terminalState.byCwd.values()][0][0].id)
  await page.getByTestId(`terminal-surface-${id}`).click()
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')

  const sent = await page.evaluate(() =>
    (window as any).__mock.terminalState.input.map((i: { data: string }) => i.data).join(''),
  )
  expect(sent).toContain('ls')
  expect(sent).toContain('\r')
})

test('The sidebar uses only one row per project (vertical space)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // The project header must not grow taller than one session row, or the list would be pushed down
  const header = (await page.getByTestId('project-header-alpha').boundingBox())!
  expect(header.height).toBeLessThan(28)

  // Background info does not take up space under normal conditions
  await expect(page.getByTestId('project-tip-alpha')).toBeHidden()
  await page.getByTestId('project-header-alpha').hover()
  await expect(page.getByTestId('project-tip-alpha')).toBeVisible()
  await expect(page.getByTestId('project-tip-alpha')).toContainText('/tmp/alpha')
})

test('Opening and closing multiple terminals (stacked vertically)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-terminal').click()

  // One already exists when first opened — an empty screen with just a button would add an extra step
  await expect(page.getByTestId('terminal-stack').locator('[data-testid^="terminal-surface-"]')).toHaveCount(
    1,
  )

  await page.getByTestId('terminal-add').click()
  await page.getByTestId('terminal-add').click()
  const surfaces = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-surface-"]')
  await expect(surfaces).toHaveCount(3)

  // Stacked vertically (not horizontally)
  const first = (await surfaces.nth(0).boundingBox())!
  const second = (await surfaces.nth(1).boundingBox())!
  expect(second.y).toBeGreaterThan(first.y)
  expect(Math.abs(second.x - first.x)).toBeLessThan(2)

  // Closing the middle one renumbers the rest
  const ids = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { id: string }) => t.id),
  )
  await page.getByTestId(`terminal-close-${ids[1]}`).click()
  await expect(surfaces).toHaveCount(2)
  const titles = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { title: string }) => t.title),
  )
  expect(titles).toEqual(['Terminal 1', 'Terminal 2'])
})

test('Resizing the left and right panels does not push the screen sideways', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Resize the sidebar width
  const sidebar = page.getByTestId('sidebar')
  const before = (await sidebar.boundingBox())!.width
  const handle = page.getByTestId('sidebar-resize')
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + 1, hb.y + 200)
  await page.mouse.down()
  await page.mouse.move(hb.x + 120, hb.y + 200, { steps: 8 })
  await page.mouse.up()
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(before + 60)

  // Even maximizing the right panel's width must not create horizontal scroll
  const panelHandle = page.getByTestId('evidence-resize')
  const pb = (await panelHandle.boundingBox())!
  await page.mouse.move(pb.x + 1, pb.y + 200)
  await page.mouse.down()
  await page.mouse.move(10, pb.y + 200, { steps: 12 })
  await page.mouse.up()

  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)

  // The conversation lane keeps its minimum width and stays usable
  expect((await page.getByTestId('chat-stream').boundingBox())!.width).toBeGreaterThan(200)
})

/** Slash/@ autocomplete (M2.8) */
test('Typing a slash shows skills, and @ shows files', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.commandState = {
      ready: true,
      commands: [
        { name: 'review', description: 'Reviews the changes', argumentHint: '<path>' },
        { name: 'commit', description: 'Commits', argumentHint: '' },
      ],
    }
    m.fsState.entries[''] = [
      { name: 'SessionView.tsx', path: 'src/SessionView.tsx', isDir: false, ignored: false },
      { name: 'store.ts', path: 'src/store.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'alpha', 'task')

  // Slash — only at the very start
  await page.getByTestId('prompt-input').fill('/rev')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('/review')
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('<path>')

  // Picking with Enter fills the composer
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('prompt-input')).toHaveValue('/review ')
  await expect(page.getByTestId('autocomplete')).toBeHidden()

  // @ — files
  await page.getByTestId('prompt-input').fill('take a look at this @Session')
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('SessionView.tsx')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('prompt-input')).toHaveValue('take a look at this @src/SessionView.tsx ')
})

test('When skills have not loaded yet, it does not claim there are none', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    // Right after creating a session, the CLI is still starting up and cannot be queried yet
    ;(window as any).__mock.commandState = { ready: false, commands: [] }
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('prompt-input').fill('/')
  await expect(page.getByTestId('autocomplete-loading')).toContainText('Loading skills')
})

test('A slash in the middle of a sentence is not treated as a command', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.commandState = {
      ready: true,
      commands: [{ name: 'review', description: '', argumentHint: '' }],
    }
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('prompt-input').fill('the path is src/rev')
  await expect(page.getByTestId('autocomplete')).toBeHidden()
})

/**
 * Even with a session still running, this window's scroll stays put (dogfooding finding,
 * 2026-09-07: "when I turn on a worktree and the modal gets longer, scrolling it drifts back to
 * the top after a moment").
 *
 * The cause was an inline `ref` callback attached to every row: its identity changed on every
 * render, so React kept detaching and reattaching it, and each time, the selected row called
 * scrollIntoView. This window subscribes to the store, so even one session running re-renders it
 * on every event — which is why the list kept getting pulled back.
 */
test("The new-session window's scroll stays put even while session events keep arriving", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await newSession(page, 'alpha', 'work').then(() =>
    page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId),
  )
  // Long enough for the list to overflow the collapsed panel
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.externalSessions = {
      supported: true,
      sessions: Array.from({ length: 30 }, (_, i) => ({
        externalId: `ext-${i}`,
        tool: 'claude',
        title: `past conversation ${i}`,
        updatedAt: Date.now() - i * 60_000,
        createdAt: null,
        branch: null,
        imported: false,
        importedAs: null,
      })),
    }
  })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  const list = page.getByTestId('past-sessions')
  await expect(page.getByTestId('past-ext-0')).toBeVisible()

  const bottom = await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight
    return Math.round(el.scrollTop)
  })
  expect(bottom).toBeGreaterThan(0) // The test only sees something meaningful once it overflows the collapsed panel

  // The session is working — events keep re-rendering the window
  for (let i = 0; i < 3; i++) {
    await page.evaluate(
      (sid: string) =>
        (window as never as { __mock: any }).__mock.emit({
          type: 'message_delta',
          sessionId: sid,
          role: 'assistant',
          text: 'In progress… ',
        }),
      id,
    )
  }
  await page.waitForTimeout(300)
  await expect.poll(async () => list.evaluate((el) => Math.round(el.scrollTop))).toBe(bottom)

  // The arrow-selected row still stays in view — the side that must not be lost while fixing this
  await page.getByTestId('past-new').click()
  await page.keyboard.press('ArrowDown')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="past-sessions"] [aria-pressed="true"]')!
        const row = el.getBoundingClientRect()
        const box = el.parentElement!.getBoundingClientRect()
        return row.top >= box.top - 1 && row.bottom <= box.bottom + 1
      }),
    )
    .toBe(true)
})

test('Picking an already-open conversation again navigates to that session instead of creating a new one', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: "yesterday's work",
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    m.externalHistory.set('ext-1', [{ role: 'user', text: "yesterday's work" }])
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-1').click()
  await page.getByTestId('create-session-confirm').click()
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Opening it again shows "Already open", and clicking it navigates instead of creating
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-ext-1')).toContainText('Already open')
  await page.getByTestId('past-ext-1').click()

  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  expect(await page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(id)
  // No extra session was created
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(1)
})

/**
 * Closing a terminal makes the remaining ones grow taller. When that happens, they must **not be
 * recreated** — a freshly created xterm starts at a default size before immediately being
 * resized to fit, and that resize redraws the shell's prompt, which can look like extra lines
 * appeared.
 */
test('Closing one terminal does not recreate the remaining ones', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-terminal').click()
  await page.getByTestId('terminal-add').click()

  const ids = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { id: string }) => t.id),
  )
  await expect(page.getByTestId(`terminal-surface-${ids[0]}`)).toBeVisible()

  // Give the surviving terminal some output — re-reading the list after closing one changes this
  // terminal's history snapshot, and that was the condition that triggered recreation
  await page.evaluate((id) => (window as any).__mock.emitTerminal(id, 'dev server running\r\n'), ids[0])

  // Leave a marker on the actual DOM of the surviving terminal
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="terminal-surface-${id}"] .xterm`) as HTMLElement & {
      __kept?: boolean
    }
    el.__kept = true
  }, ids[0])

  await page.getByTestId(`terminal-close-${ids[1]}`).click()
  await expect(page.getByTestId(`terminal-surface-${ids[1]}`)).toHaveCount(0)

  // If the same DOM node is still there, it was never recreated
  const kept = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="terminal-surface-${id}"] .xterm`) as
      (HTMLElement & { __kept?: boolean }) | null
    return el?.__kept === true
  }, ids[0])
  expect(kept).toBe(true)
})

/** Usage (FR-9) — covers subscription limits only */
test('Usage modal: a donut per window, and hovering shows the reset time', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'max',
        windows: [
          {
            id: 'session',
            label: '5 hours',
            percent: 8,
            resetsAt: new Date(Date.now() + 7_800_000).toISOString(),
            scope: null,
          },
          {
            id: 'weekly_all',
            label: 'Weekly',
            percent: 93,
            resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
            scope: null,
          },
        ],
        daily: [],
      },
    }
  })

  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-plan')).toContainText('max')
  await expect(page.getByTestId('usage-window-session')).toContainText('8%')
  await expect(page.getByTestId('usage-window-weekly_all')).toContainText('93%')

  // Details are answered only when asked
  await page.getByTestId('usage-window-weekly_all').hover()
  await expect(page.getByTestId('usage-tip-weekly_all')).toContainText('reset')
  /*
   * And it is **not clipped** (dogfooding finding: because the donut sits near the bottom of the
   * modal's scroll box, an absolutely positioned tooltip looked cut off at the bottom). This
   * checks both whether the cause of the clipping — absolute positioning inside a scroll box —
   * has been removed (same idiom as the checkbox test: Chromium's rect stays the same even when
   * clipped, so this measures the cause rather than the symptom), and whether it fits entirely
   * within the window.
   */
  const tip = page.getByTestId('usage-tip-weekly_all')
  expect(await tip.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
  const tb = (await tip.boundingBox())!
  expect(tb.y + tb.height).toBeLessThanOrEqual(page.viewportSize()!.height)

  // A tool that cannot provide daily data collapses that row (Claude has no daily window)
  await expect(page.getByTestId('usage-daily')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('usage-drop')).toBeHidden()
})

test('A tool that provides daily tokens shows them alongside', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'pro',
        windows: [{ id: 'primary', label: '1 week', percent: 22, resetsAt: null, scope: null }],
        daily: [
          { date: '2026-08-15', tokens: 115640 },
          { date: '2026-08-16', tokens: 9005155 },
        ],
      },
    }
  })
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-daily')).toContainText('Today 9.0M')
})

test('When usage cannot be read, the reason is stated (never left as a blank screen)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: false,
      reason: 'The installed Claude Code SDK does not support usage queries',
      usage: null,
    }
  })
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-unavailable')).toContainText('does not support usage queries')
})

/**
 * A modal must cover the entire window regardless of its ancestors' positioning.
 * Adding `relative` to the sidebar to support its resize handle trapped the create-session
 * modal, which opened inside it, within the sidebar's width (pointed out during dogfooding).
 */
test('A modal is not trapped inside the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const sidebarWidth = (await page.getByTestId('sidebar').boundingBox())!.width
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  const dialog = (await page.getByTestId('new-session-dialog').boundingBox())!
  const viewport = page.viewportSize()!
  // The overlay covers the whole window (not just the sidebar's width)
  expect(dialog.width).toBeGreaterThan(sidebarWidth * 2)
  expect(Math.round(dialog.width)).toBe(viewport.width)

  // It attaches directly under body — unaffected by ancestor positioning
  const parentIsBody = await page.evaluate(
    () => document.querySelector('[data-testid="new-session-dialog"]')?.parentElement === document.body,
  )
  expect(parentIsBody).toBe(true)
})

test('Two sessions cannot open the same conversation (blocked here before the tool would refuse it)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: 'the only conversation',
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    m.externalHistory.set('ext-1', [{ role: 'user', text: 'the only conversation' }])
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-1').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // Opening it again shows "Already open" and navigates to that session instead of creating a new one
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('past-ext-1')).toContainText('Already open')
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(1)
})

/**
 * Loading a long conversation must show **the bottom (most recent) part**.
 * Staying at the top only shows old messages, which reads as "the latest was not fetched"
 * (pointed out during dogfooding).
 */
test('A loaded conversation shows the most recent messages first', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-long',
          tool: 'claude',
          title: 'a very old first question',
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    // A 200-line long conversation — the last one is the most recent
    m.externalHistory.set(
      'ext-long',
      Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        text: i === 199 ? 'the most recent message' : `old message ${i + 1}`,
      })),
    )
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('past-ext-long').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // The bottom (most recent) must be visible on screen
  await expect(page.getByTestId('chat-stream')).toContainText('the most recent message')

  const atBottom = await page
    .getByTestId('chat-stream')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  expect(atBottom).toBe(true)
})

test('A conversation continued externally shows up on screen once it comes back', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Simulate the host catching up and writing it into the store
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = m.messages.get(sid) ?? []
    m.messages.set(sid, [
      ...rows,
      {
        sessionId: sid,
        seq: rows.length + 1,
        role: 'user',
        kind: 'text',
        payload: { text: 'said in the terminal' },
        ts: Date.now(),
      },
      {
        sessionId: sid,
        seq: rows.length + 2,
        role: 'assistant',
        kind: 'text',
        payload: { text: 'reply from the terminal' },
        ts: Date.now(),
      },
    ])
    m.emit({ type: 'history_synced', sessionId: sid, added: 2 })
  }, id)

  // Receiving the event makes the screen re-read the store
  await expect(page.getByTestId('chat-stream')).toContainText('said in the terminal')
  await expect(page.getByTestId('chat-stream')).toContainText('reply from the terminal')
})

test('A long URL or path does not push the conversation panel sideways', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const long = `https://example.com/${'very-long-segment'.repeat(20)}`
  await page.getByTestId('prompt-input').fill(long)
  await page.getByTestId('send').click()
  await page.evaluate(
    ({ sid, text }) =>
      (window as any).__mock.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text }),
    { sid: id, text: `Note: ${long}` },
  )
  await expect(page.getByTestId('msg-assistant').last()).toBeVisible()

  // The conversation panel must not scroll horizontally
  const stream = await page.getByTestId('chat-stream').evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(stream.scroll).toBeLessThanOrEqual(stream.client + 1)

  // The same goes for the whole window
  const page2 = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(page2.scroll).toBeLessThanOrEqual(page2.client)
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

  // Selecting it again attempts to wake it, and the failure reason remains
  await page.getByTestId('project-header-alpha').click()
  await page.getByTestId(`session-row-${id}`).click()
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

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill("Claude's task")
  await page.getByTestId('prompt-input').press('Enter')

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
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
 * "There is no loading indicator right now, so I cannot tell if it is working or stuck"
 * (dogfooding finding). There must be a live indicator from the moment something is sent until
 * the reply arrives, and it must be possible to stop from there.
 */
test('An indicator shows while waiting for a response, with a way to stop from there', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill('something that takes a while')
  await page.getByTestId('prompt-input').press('Enter')

  await page.getByTestId('prompt-input').fill('do something that takes forever')
  await page.getByTestId('send').click()

  // Appears the instant it is sent — it does not wait for the host's response
  await expect(page.getByTestId('activity-row')).toBeVisible()

  await page.getByTestId('activity-interrupt').click()
  await expect(page.getByTestId('activity-row')).toBeHidden()
})

/**
 * "The UI looks identical during compaction and while waiting for a response, so I cannot tell
 * whether it is replying or just taking a while to compact" (dogfooding finding).
 *
 * Measured with a probe, one manual compaction took 39 seconds. If the screen does not differ
 * from "waiting for response" by even one character during that time, the person waiting has no
 * way to judge what is happening.
 */
test('Compacting looks different from waiting for a response', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Start')

  await page.getByTestId('prompt-input').fill('clean up the conversation')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')

  await emitEvent(page, 0, { type: 'activity', activity: 'compacting' })
  await expect(page.getByTestId('activity-label')).toHaveText('Compacting context')

  // Once compaction ends, it returns to ordinary waiting — the state was working the whole time
  await emitEvent(page, 0, { type: 'activity', activity: null })
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')
})

// Codex reconnecting on its own (#168) is a wait of several attempts, not a failure — it says so while it lasts
test('Reconnecting looks different from waiting for a response, and leaves no failure line', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Start')

  await page.getByTestId('prompt-input').fill('say hi')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')

  await emitEvent(page, 0, { type: 'activity', activity: 'retrying' })
  await expect(page.getByTestId('activity-label')).toHaveText('Reconnecting')

  await emitEvent(page, 0, { type: 'activity', activity: null })
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')
  await expect(page.getByText('could not finish this turn')).toHaveCount(0)
})

/*
 * A lock found after a slow background resume had already handed the session back (#168, item 5).
 * It arrives as an event, not as the wake result — the fork offer has to appear all the same.
 */
test('A lock error that arrives after the session was handed back offers Continue in a fork', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Start')
  await expect(page.getByTestId('dormant-note')).toBeHidden()

  await emitEvent(page, 0, {
    type: 'error',
    error: { code: 'conversation_locked', message: 'This conversation is already open elsewhere', retryable: true },
  })
  await expect(page.getByTestId('dormant-note')).toContainText('already open elsewhere')
  await expect(page.getByTestId('dormant-fork')).toBeVisible()
  await expect(page.getByText('Could not open this conversation — This conversation is already open elsewhere')).toBeVisible()
})

/**
 * The elapsed count used to restart whenever the row was remounted (issue #23): a turn
 * three minutes old read as if it had just begun. The lie ran in the worst direction —
 * the longer the wait, the more it understated it.
 *
 * The count is derived from a start instant on the store now, so this ages the turn by
 * moving that instant rather than by actually waiting. Switching to the grid and back tears
 * the row down and builds it again, which is precisely what used to reset it.
 */
test('the elapsed count survives a view change — the start instant is what is stored', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'start')

  await page.getByTestId('prompt-input').fill('something slow')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('activity-row')).toBeVisible()

  const id = await page.evaluate(() => {
    const store = (window as any).__store
    const sessionId = store.getState().focusedSessionId as string
    // Three minutes and five seconds ago. Nothing else feeds the count
    store.setState({ workingSince: { [sessionId]: Date.now() - 185_000 } })
    return sessionId
  })
  await expect(page.getByTestId('activity-elapsed')).toHaveText(/^3m/)

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('activity-row')).toBeHidden()

  // Back to the focus view: a brand new row, still counting from the same instant
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('activity-row')).toBeVisible()
  await expect(page.getByTestId('activity-elapsed')).toHaveText(/^3m/)
})

/**
 * A failed compaction used to be swallowed entirely (measured: "Not enough messages to
 * compact."). The context stays unchanged, and the screen must not look as if nothing happened.
 */
test('A failed compaction leaves that fact visible in the conversation', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Start')

  await emitEvent(page, 0, { type: 'compaction', failed: true, reason: 'Not enough messages to compact.' })
  await expect(page.getByText('Compaction failed — Not enough messages to compact.')).toBeVisible()
})

/**
 * The Git tab — like VSCode, shows staged and unstaged changes separately.
 * The one fact that matters right before a commit is "what is going in", and mixing everything
 * into a single list meant reading that off a small tag at the end of each row.
 */
test('The Git panel separates staged from changed and lets each file be staged individually', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: true, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'task')

  await expect(page.getByTestId('evidence-group-staged')).toContainText('src/a.ts')
  await expect(page.getByTestId('evidence-group-changed')).toContainText('src/b.ts')

  // Stage only one file — no need to drop into the terminal just to "commit everything but this"
  await page.getByTestId('evidence-stage-src/b.ts').click({ force: true })
  await expect(page.getByTestId('evidence-group-changed')).toBeHidden()
  await expect(page.getByTestId('evidence-group-staged')).toContainText('src/b.ts')
})

/** Dots alone make a list, not a tree — branching and merging must be shown as lines */
test('Git history connects commits with lines', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.commits = [
      { sha: 'm', shortSha: 'mmmmmmm', subject: 'Merge', author: 'a', when: 0, parents: ['x', 'y'] },
      { sha: 'x', shortSha: 'xxxxxxx', subject: 'Trunk', author: 'a', when: 0, parents: ['z'] },
      { sha: 'y', shortSha: 'yyyyyyy', subject: 'Branch', author: 'a', when: 0, parents: ['z'] },
      { sha: 'z', shortSha: 'zzzzzzz', subject: 'Root', author: 'a', when: 0, parents: [] },
    ]
  })
  await newSession(page, 'alpha', 'task')
  // The graph lives in the History tab — the Git tab's strip was moved off, covering its neighbor
  // during the split
  await page.getByTestId('evidence-tab-history').click()

  // Two branches extend from the merge commit (one straight line + one curving line)
  const merge = page.getByTestId('commit-graph-mmmmmmm')
  await expect(merge).toBeVisible()
  expect(await merge.locator('path').count()).toBeGreaterThan(0)

  // Since the branch merges into the trunk, only one line comes down to the root
  await expect(page.getByTestId('commit-graph-zzzzzzz')).toBeVisible()
})

/**
 * A single session marker states both the tool and the state.
 * A separate dot right next to the marker would overlap in reading and blur both.
 */
test('A working session has a spinning marker border', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const mark = page.getByTestId('tool-mark-claude')
  await expect(mark).toHaveAttribute('data-state', /idle|waiting_input|working/)

  await page.getByTestId('prompt-input').fill('something that takes a while')
  await page.getByTestId('send').click()

  await expect(mark).toHaveAttribute('data-state', 'working')
  await expect(mark).toHaveClass(/cc-orbit/)
})

/**
 * The model list used to be hardcoded, so when Fable was released it could not be selected.
 * Now the list comes straight from the tool's official API, and effort levels arrive attached to
 * each model.
 */
test('The model list comes from what the tool reports, and effort only appears for models that support it', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const menu = page.getByTestId('settings-menu')

  // Not a list we wrote — the list the host provides
  await page.getByTestId('settings-open').click()
  await expect(menu).toContainText('Fable')

  /*
    Picking a model leaves the menu open (a dogfooding request) — the effort/speed group changes
    to match the chosen model, so someone who just picked a model is usually not done yet. It
    used to take a re-opening click after every single row — that dance was itself the evidence
    of the friction.
  */
  // A model that does not support effort has no effort group — showing a control with no effect
  // would be a lie
  await menu.getByTestId('settings-model-haiku').click()
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText('Effort')

  await menu.getByTestId('settings-model-fable').click()
  await expect(menu).toContainText('Effort')
  await menu.getByTestId('settings-effort-xhigh').click()
  // The menu never closes on selection (2026-09-06) — the only ways to close it are an outside
  // click, Esc, or the toggle
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  const settings = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId]
  })
  expect(settings.model).toBe('fable')
  expect(settings.effort).toBe('xhigh')
})

/**
 * Response speed (codex's service_tier — measured: gpt-5.4+ offers exactly one, "Fast, 1.5x
 * speed"). The group only appears for models that offer a tier, and switching to a model with no
 * tier resets the value along with it.
 */
test('Speed (Fast) only appears for models that offer a tier, and the chosen value stays on the session', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Tier belongs to codex — create a codex session (the session menu has no way to switch tools)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  const menu = page.getByTestId('settings-menu')
  // Picking a model leaves the menu open, so the Speed group appears right there
  await pickSetting(page, 'settings-model-gpt-5.6-terra')
  await expect(menu).toContainText('Speed')
  await menu.getByTestId('settings-tier-priority').click()

  const tier = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].serviceTier
  })
  expect(tier).toBe('priority')

  // Switching to a model with no tier removes the group and resets the value — an unsupported
  // combination must not linger silently
  await pickSetting(page, 'settings-model-gpt-5.6-terra-mini')
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText('Speed')
  const tier2 = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].serviceTier
  })
  expect(tier2).toBeNull()
})

/** Switching models resets effort — the steps differ per model, so the old value must not persist */
test('Switching models resets the reasoning effort', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await pickSetting(page, 'settings-model-fable')
  await pickSetting(page, 'settings-effort-max')
  await pickSetting(page, 'settings-model-sonnet')

  // sonnet has no max — leaving it would silently keep an unsupported combination
  const effort = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].effort
  })
  expect(effort).toBeNull()
})

/*
 * Restarting the app made the settings look like they had been reset (issue #37).
 *
 * Persistence was fine from the start — the chosen value was intact in both the DB and the
 * host's list. What got reset was the screen: the startup path picked only the effort level off
 * the list and filled model and permission with their defaults, so the button under the composer
 * read "Default · Normal". So this checks **the text the button actually reads**, not the store
 * value.
 */
test('The chosen model and permission stay visible even after restarting the app', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await pickSetting(page, 'settings-model-fable')
  await pickSetting(page, 'settings-effort-high')
  await pickSetting(page, 'settings-preset-auto')
  await expect(page.getByTestId('settings-open')).toHaveText(/Fable · high · Auto/)

  /*
   * Equivalent to restarting the app: the host (mock) stays alive, and only the store receives
   * the list and rebuilds the session summary from scratch — this attach is the actual path a
   * restart runs through.
   */
  await page.evaluate(async () => {
    const w = window as any
    await w.__store.getState().attach(w.__mock)
  })

  await expect(page.getByTestId('settings-open')).toHaveText(/Fable · high · Auto/)
})

/** The expand indicator is collapsed=right, expanded=down. The same glyph rotates, so the two states never drift apart */
test('The file tree folder arrow changes direction when opened and closed', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'src', path: 'src', isDir: true, ignored: false }]
    m.fsState.entries['src'] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()

  const dir = page.getByTestId('dir-src').locator('svg')
  await expect(dir).not.toHaveClass(/rotate-90/)

  await page.getByTestId('dir-src').click()
  await expect(dir).toHaveClass(/rotate-90/)

  await page.getByTestId('dir-src').click()
  await expect(dir).not.toHaveClass(/rotate-90/)
})

/**
 * The top bar must sit on the same axis as the macOS traffic-light buttons.
 *
 * The button position is set by us via trafficLightPosition in tauri.conf.json, and its
 * **relationship to the bar's height** is checked by tooling/styles.test.ts. What is checked
 * here is only what the browser can see: whether the title is vertically centered in the bar.
 * Adding inner padding can silently throw this off, and that is what this test catches.
 */
test('The title sits vertically centered inside the top bar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const bar = page.getByTestId('app-header')
  const box = (await bar.boundingBox())!
  // Up to the 1px bottom border
  expect(box.height).toBeLessThanOrEqual(37)
  expect(box.y).toBe(0)

  // The text must also be centered within it (top/bottom margin difference within 1px)
  const text = (await page.getByTestId('app-title').boundingBox())!
  const top = text.y - box.y
  const bottom = box.y + box.height - (text.y + text.height)
  expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1.5)
})

/**
 * An empty composer used to stay stuck at its grown height (dogfooding finding).
 * Computing height only on typing events leaves the value empty after sending but keeps the
 * height.
 */
test('The composer height returns to one line after sending a message', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const input = page.getByTestId('prompt-input')
  const oneLine = (await input.boundingBox())!.height

  await input.fill('line one\nline two\nline three\nline four')
  const grown = (await input.boundingBox())!.height
  expect(grown).toBeGreaterThan(oneLine + 20)

  await page.getByTestId('send').click()
  await expect(input).toHaveValue('')

  // If the value is empty, the height must also be one line — a tall box must not linger with nothing typed
  expect((await input.boundingBox())!.height).toBeCloseTo(oneLine, 0)
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

/*
 * GUI slash commands (2026-09-07): `/usage` is a client-side command with no reply in the SDK
 * protocol — pressing Enter opens an app screen instead of sending a message. Recognizing it is
 * our own registry's job (the SDK has no concept of a "client command"), and the interception
 * happens before it ever reaches the adapter, so it is tool-agnostic.
 */
test('Pressing Enter on /usage opens the usage screen instead of sending it — with an argument it becomes a message', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // It appears in autocomplete alongside session commands — the hint states its origin
  await page.getByTestId('prompt-input').fill('/usa')
  await expect(page.getByTestId('autocomplete')).toContainText('/usage')
  await expect(page.getByTestId('autocomplete')).toContainText('opens in app')

  const userCount = (sid: string) =>
    ((window as any).__store.getState().chat[sid] ?? []).filter((i: any) => i.kind === 'user').length
  const before = await page.evaluate(userCount, id)

  await page.getByTestId('prompt-input').fill('/usage')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('usage-drop')).toBeVisible()
  // No message was sent, and the composer is empty
  expect(await page.evaluate(userCount, id)).toBe(before)
  await expect(page.getByTestId('prompt-input')).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('usage-drop')).toBeHidden()

  // Anything following the name means it is talking to the session — it goes out as an ordinary message
  await page.getByTestId('prompt-input').fill('/usage summarize last week')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('usage-drop')).toBeHidden()
  await expect.poll(() => page.evaluate(userCount, id)).toBe(before + 1)

  // /model's CLI screen already exists here — it opens this session's settings menu
  await page.getByTestId('prompt-input').fill('/model')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  expect(await page.evaluate(userCount, id)).toBe(before + 1)
})

test('The composer height also follows a value inserted by autocomplete', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'a'.repeat(120) + '.ts', path: 'src/' + 'a'.repeat(120) + '.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'alpha', 'task')

  const input = page.getByTestId('prompt-input')

  await input.fill('@a')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  const beforePick = (await input.boundingBox())!.height
  await page.keyboard.press('Tab')

  // Once picked, the value is longer, so the box must grow too
  await expect(input).not.toHaveValue('@a')
  expect((await input.boundingBox())!.height).toBeGreaterThan(beforePick)
})

/**
 * While reading a long reply, the person should not have to scroll back up to find "what was
 * this answering". Because this is a virtual scroll, CSS sticky cannot be used, so the position
 * is computed from the scroll offset instead — this checks that computation.
 */
test("Scrolling pins the current turn's own message to the top", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const input = page.getByTestId('prompt-input')
  // Long enough to create scroll — too short and there would be nothing to scroll past
  await input.fill('first question\n' + 'content\n'.repeat(40))
  await page.getByTestId('send').click()
  // The second one is long too — the content below must exceed one screen for the first to count
  // as "fully scrolled past"
  await input.fill('second question\n' + 'content\n'.repeat(40))
  await page.getByTestId('send').click()
  /*
    And the second question gets an answer much taller than the screen, so that at the bottom
    the last question has fully scrolled past with room to spare: the banner there pins it, and
    there is no next user message for it to step aside from.

    Without the answer, the bottom is no such place. The second question is taller than the
    screen and never fully scrolls past, so the banner there pins the first question and the
    second question crosses it — the banner is stepped aside (`cc-hang-out-up`,
    pointer-events: none). The checks below that need a banner a person can see and click used
    to run there anyway, and passed or failed by timing (2026-10-03, Chromium):
    - the expand check opened it with a DOM click, which ignores pointer-events, and its real
      click was then intercepted by the second question's row. Playwright scrolled the list
      itself looking for a clickable spot — sometimes landing in the ~6px window where the
      banner was back, sometimes far enough that the first question no longer counted as
      scrolled past, the pinned turn changed, and the expanded card was unmounted mid-click
      ("element was detached from the DOM", 3 runs in 40);
    - the shape check measured the banner while it was stepping out, and read a gap from the
      ceiling of -2px (the 6px gap minus the 8px it rises) whenever the exit animation won.
  */
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    for (let i = 0; i < 60; i++)
      m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `answer line ${i}\n\n` })
    m.emit({ type: 'turn_complete', sessionId: id })
  })

  const stream = page.getByTestId('chat-stream')
  const banner = page.getByTestId('sticky-user')
  // The banner moves while it enters or steps aside — positions are read only once it holds still
  const bannerAtRest = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) => {
          const card = document.querySelector('[data-testid="sticky-user"] > div')
          void Promise.all((card?.getAnimations() ?? []).map((a) => a.finished.catch(() => {}))).then(() => r())
        }),
    )

  /*
    **Wait for it to settle first.** Right after sending, it is still animating down to the
    bottom — scrolling to the top before that finishes lets the belated auto-scroll pull it back
    down, which would look like "it is at the top, so why is it still pinned" when it was
    actually never at the top.
    (This intermittently failed exactly this way under the full suite.)

    The test takes itself to the bottom rather than waiting for the auto-scroll to get there,
    and waits until the height stops changing — every row measured, nothing left to follow.
    Following is not what this test is about. The answer lands as one burst right behind the
    send, and in WebKit that burst used to make the auto-scroll let go of the bottom on its own
    (2 runs in 30, 914px short): the virtual scroller compensated the answer row from a stale
    offset and put the view 54px up, which read as the person scrolling up. That is fixed and
    guarded on its own in fixtures/auto-follow.ts.
  */
  let lastHeight = -1
  await expect
    .poll(async () => {
      const height = await stream.evaluate((el) => {
        el.scrollTop = el.scrollHeight
        return el.scrollHeight
      })
      const steady = height === lastHeight
      lastHeight = height
      return steady
    })
    .toBe(true)

  /*
    There is nothing to pin at the top (this own message has not scrolled past the top of the
    screen yet).

    **Check only after waiting.** Virtual scroll measures row heights on the next frame, and only
    once that measurement finishes is "what scrolled past the top" settled. Asserting immediately
    can catch a frame before that measurement finishes and fail intermittently (this actually
    happened under the full suite).
  */
  await stream.evaluate((el) => (el.scrollTop = 0))
  await expect(page.getByTestId('sticky-user')).toBeHidden({ timeout: 3000 })

  /*
    Scrolling down pins the own message that has scrolled past — at the bottom, the last one.
    Naming it exactly is not row-height arithmetic: its answer is about three screens tall, so
    no layout change short of a broken one leaves it on screen there. Nothing follows it, so it
    has no reason to step aside. (`data-obscured` lives on the card inside the banner.)
  */
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('second question')
  await expect(banner.locator('[data-obscured="true"]')).toHaveCount(0)

  /*
    **The banner shares the same position and the same width as the chat bubble.**

    Back when it was full width, dogfooding read it as "not flush with the top". Measured, the
    gap from the ceiling was actually 0px (across zoom 0.9-1.2) — what made it look detached was
    shape, not position. A bubble that normally spans 75% on the right suddenly stretching edge
    to edge reads not as my own message but as a tool banner floating below the header. So two
    things are kept as a contract: the right edge matches, and it never exceeds 75%. (Measured
    only after the entrance animation finishes — while it is still moving it sits a few px lower.)
  */
  await bannerAtRest()
  const shape = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="chat-stream"]') as HTMLElement
    const btn = document.querySelector('[data-testid="sticky-user"] button') as HTMLElement
    /*
      The right edge is compared with a rendered bubble, not with the stream's own box. The
      stream's border box includes its scrollbar, which headless Chromium hides but WebKit lays
      out at the 10px that index.css gives it — measured against the box, WebKit reported an
      inset of 10 on every run while the banner and the bubble both ended at x=914.
    */
    const bubble = s.querySelector('[data-index]:not(.invisible) [data-testid="msg-user"]') as HTMLElement
    const cs = getComputedStyle(s)
    const rowWidth = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const b = btn.getBoundingClientRect()
    return {
      gapFromCeiling: Math.round(b.top - s.getBoundingClientRect().top),
      rightInset: Math.round(bubble.getBoundingClientRect().right - b.right),
      widthRatio: b.width / rowWidth,
    }
  })
  /*
    It now **deliberately sits 6px off** (see SessionView's -top-[10px] comment — pinning it
    flush lost twice to compositor rounding on the actual WKWebView, so this now folds that
    hairline gap into the design spacing instead). The contract is "close to the intended gap
    (4-8px)" — 0 would mean a regression back to flush, and a large value would mean it has
    drifted away.
  */
  expect(shape.gapFromCeiling).toBeGreaterThanOrEqual(4)
  expect(shape.gapFromCeiling).toBeLessThanOrEqual(8)
  expect(shape.rightInset).toBe(0)
  expect(shape.widthRatio).toBeLessThanOrEqual(0.76)

  /*
    The original is hidden while the banner speaks for it (dogfooding finding: "the same message
    shows twice"). Because the banner itself takes up space in the flow and pushes the list down,
    the original — already judged to have "fully scrolled past" — was pushed back down below the
    banner and became visible again. Hiding it via visibility keeps its spot in layout while
    keeping it invisible.

    This scrolls down little by little to find the point where the banner picks up "the first
    question" — at that point the original row is still rendered at the screen's edge (overscan),
    so both can be observed together.
  */
  /*
    Scrolling in small increments does not work: a row not yet measured is positioned by an
    estimated height until it enters view, at which point it switches to a measured height and
    every coordinate below it shifts — if polling catches that moment, "pinned" flips to "not
    pinned" one frame later (this actually happened). Having just visited the bottom, every row
    is already measured, so this jumps straight there using that final geometry.
  */
  await stream.evaluate((el) => (el.scrollTop = 0))
  const q1End = await stream.evaluate((el) => {
    const rows = [...el.querySelectorAll('div[data-index]')] as HTMLElement[]
    const row = rows.find((r) => (r.textContent ?? '').includes('first question'))!
    const y = new DOMMatrixReadOnly(getComputedStyle(row).transform).m42
    return y + row.offsetHeight
  })
  // +80: comfortably covers the banner taking up space in the flow and pushing the list down by
  // its own height
  await stream.evaluate((el, y) => (el.scrollTop = y + 80), q1End)
  await expect(page.getByTestId('sticky-user')).toContainText('first question')
  // When the next user question rises to the banner's spot, the banner retreats upward before it
  // covers that question.
  await expect(page.getByTestId('sticky-user').locator('[data-obscured="true"]')).toHaveClass(
    /cc-hang-out-up/,
  )
  // The original row is still rendered at the screen's edge (overscan) — rendered but must remain
  // invisible
  await expect
    .poll(() =>
      stream.evaluate((el) => {
        const rows = [...el.querySelectorAll('div[data-index]')] as HTMLElement[]
        const row = rows.find((r) => (r.textContent ?? '').includes('first question'))
        return row ? getComputedStyle(row).visibility : 'gone'
      }),
    )
    .toBe('hidden')

  /*
    Clicking it expands — the full text appears **layered on top of** the collapsed row. Growing
    its height within the flow would shift every virtual-scroll coordinate below it, so the
    collapsed row's own position must stay exactly where it was.
  */
  // At the bottom again: the last question is pinned, nothing below it to step aside for
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(banner).toContainText('second question')
  await expect(banner.locator('[data-obscured="true"]')).toHaveCount(0)
  /*
    Real clicks, not DOM clicks: what is kept is that a person can click it. They wait for the
    banner's entrance animation to end — a click started while it ran had Playwright's
    scroll-into-view step move the list itself (in WebKit 249-504px up, 6 runs in 6, 1-3ms
    before the pointerdown), which no person's click does.
  */
  await bannerAtRest()
  const settledTop = await stream.evaluate((el) => el.scrollTop)
  const collapsed = banner.getByRole('button').first()
  const collapsedBox = (await collapsed.boundingBox())!
  await collapsed.click()
  const expanded = page.getByTestId('sticky-user-expanded')
  await expect(expanded).toBeVisible()
  // Multiple lines expanded (clearly taller than the one collapsed line), and the collapsed row's
  // position did not change
  expect((await expanded.boundingBox())!.height).toBeGreaterThan(collapsedBox.height * 2)
  // Approximate, not exact — WebKit reported the same row as 39.125 vs 39.12499237, causing flakes
  // (measured twice)
  expect((await collapsed.boundingBox())!.height).toBeCloseTo(collapsedBox.height, 1)
  // Clicking it again collapses it
  await expanded.click()
  await expect(page.getByTestId('sticky-user-expanded')).toBeHidden()
  /*
    Neither click moved the list. If one had, Playwright had to scroll to find something
    clickable, and a pass would mean only that its scrolling got lucky — the way this test
    used to pass.
  */
  expect(await stream.evaluate((el) => el.scrollTop)).toBe(settledTop)
})

/**
 * Images produced by the agent (#40) — screenshots and image Reads actually show up in the
 * conversation. The decision not to persist them (display-only, 2026-08-24) is upheld by the
 * kind map (null), and two contracts are checked here: an image renders, and an image that
 * cannot render is a box with a reason, not a silent blank.
 */
test('An image sent by the agent renders in the conversation — a failure states its reason', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(
    () => (window as never as { __store: any }).__store.getState().focusedSessionId,
  )
  // An actual 8x8 pixel PNG — a fake string would make it impossible to measure "did it render"
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFtFEIAJ2yAhH+Iz4jAAAAAElFTkSuQmCC'
  await page.evaluate(
    ({ sid, png }: { sid: string; png: string }) => {
      const mock = (window as never as { __mock: any }).__mock
      mock.emit({
        type: 'message_image',
        sessionId: sid,
        mime: 'image/png',
        data: png,
        path: '/tmp/shot.png',
      })
      mock.emit({
        type: 'message_image',
        sessionId: sid,
        mime: '',
        data: '',
        path: '/tmp/big.png',
        note: 'Image is too large (12MB)',
      })
    },
    { sid: id, png: PNG },
  )
  const img = page.getByTestId('msg-image').locator('img')
  await expect(img).toBeVisible()
  // Checks whether it actually decoded — naturalWidth is 0 if the source is broken
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByTestId('msg-image-missing')).toContainText('too large')
  await expect(page.getByTestId('msg-image-missing')).toContainText('/tmp/big.png')

  /*
   * Persistence (#40's second decision: display-only -> kept, capped at 500MB total). The image
   * must come back even after discarding the in-memory conversation and force-reading it back
   * from the transcript — the same path a restart walks.
   */
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByTestId('msg-image-missing')).toContainText('too large')
})

/** So a path never has to be memorized and typed — drag it from the tree and drop it on the composer */
test('Dragging from the file tree drops an @path into the composer', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()

  await page.getByTestId('prompt-input').fill('take a look at this')
  await page.dragAndDrop('[data-testid="file-src/a.ts"]', '[data-testid="input-dropzone"]')

  // Must be the same shape autocomplete would insert
  await expect(page.getByTestId('prompt-input')).toHaveValue('take a look at this @src/a.ts ')
})

/**
 * The same delta used to get applied multiple times (dogfooding finding: "hohosthosthost...").
 *
 * attach never tore down its subscription, so attaching twice applied every event twice.
 * Streaming deltas accumulate, so one misalignment throws off everything after it.
 */
test('Streaming text is not duplicated even after attaching twice', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Reproduce exactly the situation of the app reattaching (host reconnect / remount)
  await page.evaluate(async () => {
    const s = (window as any).__store.getState()
    await s.attach(s.platform)
  })

  // Emit the delta exactly once — if subscriptions overlapped, it stacks twice on screen
  await page.evaluate(() => {
    const s = (window as any).__store.getState()
    ;(window as any).__mock.emit({
      type: 'message_delta',
      sessionId: s.focusedSessionId,
      role: 'assistant',
      text: 'abc',
    })
  })

  const reply = page.getByTestId('msg-assistant').last()
  await expect(reply).toHaveText('abc')
})

/**
 * Staying pinned to the bottom follows a streaming reply down as it grows.
 *
 * Streaming has **a fixed item count with the last item growing.** So using the item count as
 * the yardstick freezes the screen while the reply grows longer — only the total height brings
 * both cases under one measure.
 *
 * Note: on the mock, this test **also passes with the old, buggy logic.** The browser's scroll
 * anchoring appears to mask it. So this is not a net that catches the regression — it records
 * the "follows it down" contract, and the actual symptom has to be confirmed in the real app.
 */
test('Staying at the bottom follows a growing reply down', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  const stream = page.getByTestId('chat-stream')
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))

  // Only one item keeps growing — the count stays the same
  // Long enough to reliably overflow the screen — without overflow there is no scroll and the
  // check means nothing
  for (let i = 0; i < 150; i++) {
    await page.evaluate((n) => {
      const s = (window as any).__store.getState()
      ;(window as any).__mock.emit({
        type: 'message_delta',
        sessionId: s.focusedSessionId,
        role: 'assistant',
        text: `line ${n}\n`,
      })
    }, i)
  }

  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 3000,
    })
    .toBeLessThan(40)
})

/**
 * An icon-only button must have **some way to ask what it does.**
 * Building them one at a time leads to some having a tooltip and others not — this actually
 * happened.
 */
test('Hovering an icon button shows its description', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('send').hover()
  await expect(page.getByRole('tooltip')).toContainText('Send')

  await page.getByTestId('restart-session').hover()
  await expect(page.getByRole('tooltip')).toContainText('Restart')

  // Must appear on focus too, not just hover — someone navigating by keyboard alone needs the same information
  await page.getByTestId('restart-session').focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
})

/**
 * The window survives even when rendering blows up (dogfooding finding, 2026-09-07: "it said an
 * error happened and then the screen went blank").
 *
 * When React hits an exception with nothing to catch it, it tears down the entire tree — leaving
 * a blank screen indistinguishable from "the app has died". What breaks here is the shape of a
 * single session, which is an honest choice of test material: it is something that can actually
 * happen if the host sends something malformed.
 */
test('When the screen breaks, it shows what happened instead of a blank page', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(
    () => (window as never as { __store: any }).__store.getState().focusedSessionId,
  )

  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    const s = store.getState()
    // If a spot meant to be an array is empty, the rendering side throws
    store.setState({ sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], touchedPaths: undefined } } })
  }, id)

  await expect(page.getByTestId('app-crashed')).toBeVisible()
  await expect(page.getByTestId('app-crashed-reload')).toBeVisible()
})

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

/** Moving to a session in a different project must update the file tree too */
test('Switching projects also switches the file tree', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'only-in-alpha.ts', path: 'only-in-alpha.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'alpha', 'work a')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-only-in-alpha.ts')).toBeVisible()

  // The second project has different files
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'only-in-beta.ts', path: 'only-in-beta.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'beta', 'work b')

  await expect(page.getByTestId('file-only-in-beta.ts')).toBeVisible()
  await expect(page.getByTestId('file-only-in-alpha.ts')).toBeHidden()
})

/**
 * Expanded folders used to live in the tree rows, so switching sessions collapsed them and
 * you dug down the same path again (issue #16).
 *
 * They belong to the **project**, which is the half this test is really about: within one
 * repo the tree holds, and crossing to another repo it does not. That is the difference
 * from drafts, which moved onto the session — a draft is something you were saying to one
 * agent, while an open folder is a fact about the code every session in that repo shares.
 */
test('expanded folders follow the project, not the session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'src', path: 'src', isDir: true, ignored: false }]
    m.fsState.entries['src'] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'first')
  const first = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  await page.getByTestId('evidence-tab-files').click()

  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()

  /*
    Leaving for the Git tab tears the whole tree down. This is the step that reproduces the
    original complaint: nothing about switching sessions unmounted these rows on its own,
    so the state only vanished once something actually took them off screen.
  */
  await page.getByTestId('evidence-tab-git').click()
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()

  // Another session in the same repo — same code, so the same tree
  await newSession(page, 'alpha', 'second')
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()

  // A different repo starts closed: this belongs to the project, it is not a global setting
  await newSession(page, 'beta', 'elsewhere')
  await expect(page.getByTestId('dir-src')).toBeVisible()
  await expect(page.getByTestId('file-src/a.ts')).toBeHidden()

  // ...and alpha still has it open when we come back
  await page.getByTestId(`session-row-${first}`).click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
})

/**
 * A marker with a bare number and no unit prompts "what is this?" (it actually did). The
 * browser's default title takes 1-2 seconds to appear, which is as good as not being there in
 * that moment.
 */
test('Hovering the project marker explains what it is', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
    ]
  })
  // The change count comes from the project list — force it to re-read
  await page.evaluate(() => (window as any).__store.getState().refreshProjects?.())

  const mark = page.getByTestId('mark-changed-alpha')
  if (await mark.count()) {
    await mark.hover()
    await expect(page.getByRole('tooltip')).toContainText('uncommitted')
  }
})

/** The sidebar order is decided by the person — drag to reorder, and it must survive a restart */
/**
 * The drop-position line sits **on the boundary** (dogfooding finding, 2026-09-10: "it is the
 * same spot but the line jitters up and down slightly").
 *
 * One boundary is shared by two rows — the "bottom" for the row above, the "top" for the row
 * below. If each is drawn inside its own row, they mean the same thing but appear a few px
 * apart. What this measures is whether the two representations point to **the same pixel**.
 */
test("The row above's bottom line and the row below's top line land at the same spot", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const ids = await page.evaluate(() =>
    Object.keys((window as never as { __store: any }).__store.getState().sessions),
  )

  /** Fires dragover on that row and measures the on-screen y of the line it produces */
  const lineY = async (id: string, half: 'top' | 'bottom') =>
    page.evaluate(
      async ({ sel, half }: { sel: string; half: 'top' | 'bottom' }) => {
        // The row (li) is what draws the line — the testid is on the button inside it
        const el = (document.querySelector(sel) as HTMLElement).closest('li') as HTMLElement
        const r = el.getBoundingClientRect()
        const over = () => {
          const dt = new DataTransfer()
          dt.setData('application/x-cc-session', 'dragged')
          el.dispatchEvent(
            new DragEvent('dragover', {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt,
              clientY: half === 'top' ? r.top + 2 : r.bottom - 2,
            }),
          )
        }
        /*
         * The line is attached via React state — **wait until it is actually drawn.** Counting a
         * fixed number of frames can measure a line that does not exist yet when the machine is
         * busy and produce NaN (this actually happened under parallel runs). A real drag keeps
         * firing dragover continuously too, so firing it again here matches that exactly.
         */
        let cs = getComputedStyle(el, '::after')
        for (let i = 0; i < 30 && cs.content === 'none'; i++) {
          over()
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
          cs = getComputedStyle(el, '::after')
        }
        if (cs.content !== 'none') {
          const h = parseFloat(cs.height) || 0
          // For a top line, top comes back numeric; for a bottom line, bottom does
          return cs.top !== 'auto' && cs.top !== ''
            ? r.top + parseFloat(cs.top)
            : r.bottom - parseFloat(cs.bottom) - h
        }
        /*
         * Measure the **position** regardless of how the line is drawn — using the same yardstick
         * even from when it was drawn with a box-shadow is what makes "fixing it passes,
         * reverting it fails" hold (a test of the fact, not the implementation).
         */
        const inset = /(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+\d/.exec(getComputedStyle(el).boxShadow)
        if (!inset) return Number.NaN
        const dy = parseFloat(inset[2]!)
        return dy > 0 ? r.top : r.bottom + dy
      },
      { sel: `[data-testid="session-row-${id}"]`, half },
    )

  const below = await lineY(ids[0]!, 'bottom')
  const above = await lineY(ids[1]!, 'top')
  expect(Math.abs(below - above)).toBeLessThanOrEqual(1)
})

test('Dragging a session reorders it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  const order = async () =>
    page.evaluate(() => {
      const s = (window as any).__store.getState()
      return Object.values(s.sessions).map((x: any) => x.name)
    })
  expect(await order()).toEqual(['first', 'second'])

  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))
  await page.dragAndDrop(`[data-testid="session-row-${ids[1]}"]`, `[data-testid="session-row-${ids[0]}"]`, {
    targetPosition: { x: 10, y: 2 }, // Dropping on the top half moves it earlier
  })

  await expect.poll(order).toEqual(['second', 'first'])
})

test('Dragging a project reorders it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })

  const order = async () =>
    page.evaluate(() => Object.values((window as any).__store.getState().projects).map((p: any) => p.name))
  expect(await order()).toEqual(['alpha', 'beta'])

  await page.dragAndDrop('[data-testid="project-header-beta"]', '[data-testid="project-alpha"]', {
    targetPosition: { x: 10, y: 2 },
  })

  await expect.poll(order).toEqual(['beta', 'alpha'])
})

/**
 * The sidebar's + and ✕ align on the same vertical line.
 *
 * Relying on visual judgment alone lets them drift apart again the next time a margin is
 * touched — they were actually off by 4px vs 12px at one point. This pins it down by measuring
 * the actual right-edge coordinates.
 */
test("The sidebar's project menu and delete button align on the same vertical line", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Both must be hovered to appear — the project row's menu is now hidden too
  await page.getByTestId('project-header-alpha').hover()
  await page.getByTestId(`session-row-${id}`).hover()

  const plus = (await page.getByTestId('project-menu-alpha').boundingBox())!
  const dots = (await page.getByTestId(`session-menu-${id}`).boundingBox())!

  expect(Math.abs(plus.x + plus.width - (dots.x + dots.width))).toBeLessThanOrEqual(1)
})

/**
 * The person can rename a session (issue #5).
 *
 * The automatic name is truncated from the first prompt. Sessions created by resuming or loading
 * a conversation all share the same first line, so four sessions named `This session is being
 * continued...` stood side by side in the list — the name told nothing apart, and the only way
 * to tell them apart was digging into the content.
 */
test('Renaming a session in the sidebar sticks — the automatic name never overwrites it afterward', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'This session is being continued from a previous conversation')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const row = page.getByTestId(`session-row-${id}`)
  await expect(row).toContainText('This session is being continued')

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`rename-session-${id}`).click()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('Guard MCP')
  await input.press('Enter')

  await expect(page.getByTestId(`session-row-${id}`)).toContainText('Guard MCP')

  // The automatic name must never overwrite it again — even when the tool reports a title, the
  // person's chosen name wins
  await emitEvent(page, 0, { type: 'session_title', title: 'This session is being continued…', auto: true })
  await expect(page.getByTestId(`session-row-${id}`)).toContainText('Guard MCP')
})

test('Pressing Escape while editing the name leaves the old name unchanged', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'original name')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Double-clicking the name is the same entry point too (the usual tab-name convention)
  await page.getByTestId(`session-row-${id}`).dblclick()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('abandoned name')
  await input.press('Escape')

  await expect(page.getByTestId(`session-row-${id}`)).toContainText('original name')
})

/**
 * **No silent failure.** If a rename fails but the list has already switched to the new name, it
 * would revert with no explanation the next time the list refreshes.
 */
test('When a rename fails, the list stays unchanged and the person is told', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'original name')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Set up a situation where the host refuses — renaming after the session has disappeared is
  // the real-world path
  await page.evaluate((sid: string) => {
    ;(window as any).__mock.sessions.delete(sid)
  }, id)

  await page.getByTestId(`session-row-${id}`).dblclick()
  const input = page.getByTestId(`session-name-input-${id}`)
  await input.fill('new name')
  await input.press('Enter')

  await expect(page.getByTestId('toast')).toContainText('Could not rename')
  await expect(page.getByTestId(`session-row-${id}`)).toContainText('original name')
})

/** The composer's attach and send are the same kind of part, so their size and height must match */
test("The composer's attach and send buttons share the same size and height", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  const attach = (await page.getByTestId('attach-open').boundingBox())!
  const send = (await page.getByTestId('send').boundingBox())!

  expect(Math.abs(attach.width - send.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(attach.height - send.height)).toBeLessThanOrEqual(1)
  // Their bottom edges align on the same line (they stay side by side even as the composer grows)
  expect(Math.abs(attach.y + attach.height - (send.y + send.height))).toBeLessThanOrEqual(1)
})

/**
 * The drop-position indicator must not push the list around.
 *
 * Drawing it with a border grows the element by 1px, so the whole list shifts every time the
 * indicator moves to a new row — dragging it around makes everything jitter, and the spot the
 * hand is aiming for keeps moving.
 */
test('The list does not shift while dragging to reorder', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))

  const rowBox = async () => (await page.getByTestId(`session-row-${ids[1]}`).boundingBox())!
  const before = await rowBox()

  // Trigger the drop indicator's on state (just fire a dragover)
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="session-row-${id}"]`)!.parentElement!
    const dt = new DataTransfer()
    dt.setData('application/x-cc-session', 'other')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }),
    )
  }, ids[0])

  const after = await rowBox()
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5)
})

/**
 * The grid — several sessions on one screen.
 *
 * This is the grid that spec §5.4 held back for v1. What was preserved when bringing it back:
 * the column count is computed from the width so panels never shrink below the minimum width,
 * and each panel uses **the same component** as the focus view so their settings never diverge.
 */
test('Dragging a session onto the grid button adds it to the grid', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')

  // Dragging it also opens the grid screen — opening it and then dragging separately would be two steps
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  // There is no right-side evidence panel (§5.4: adding one more lane would push the panel below
  // its minimum width)
  await expect(page.getByTestId('evidence-panel')).toBeHidden()
})

test('A grid panel and the focus view see the same settings', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  // Change the model from the grid panel
  await pickSetting(page, 'settings-model-opus', page.getByTestId(`grid-panel-${id}`))

  // It must stay the same when returning to the focus view — a copy would diverge right here
  // (the way out is 'picking something else'. The grid button is not a toggle)
  await page.getByTestId(`session-row-${id}`).click()
  // The current value is written on the button without needing to open the menu
  await expect(page.getByTestId('settings-open')).toContainText('Opus')
})

test('Removing a session from the grid leaves it in the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await page.getByTestId(`grid-remove-${id}`).click()

  await expect(page.getByTestId(`grid-panel-${id}`)).toBeHidden()
  // It only came off the screen — the session keeps running as before
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
})

/**
 * Even as a conversation piles up in a grid panel, the composer must hold its place (dogfooding
 * finding).
 *
 * A flex child's default min-height is auto, so it cannot shrink below its content. As the
 * conversation grew, the whole panel grew with it and pushed the composer outside the panel —
 * "it keeps scrolling and stops, and the composer never appears" was the symptom. This surfaced
 * first in the grid, where panel height is fixed.
 */
test("A grid panel's composer is not pushed out even as the conversation grows longer", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Enough content to reliably exceed the panel's height
  await page.evaluate((sid) => {
    const store = (window as any).__store
    const items = Array.from({ length: 60 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      text: `long conversation ${i}`,
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  // The composer must be **inside** the panel. Merely being visible is not enough — something
  // pushed out of view is still "visible"
  const composer = panel.getByTestId('prompt-input')
  await expect(composer).toBeVisible()
  /*
   * Measure **only after the position settles** (2026-09-13).
   *
   * In the very first frame the panel exists, the card's absolute position is not yet final —
   * measured, it sits about 10px lower than the panel for a frame or two before settling into
   * place. Measuring during that frame made this assertion pass sometimes and fail other times
   * (three runs of the same code failed three times, then passed once). What this test is meant
   * to state is a property of the **settled state** — "the composer is never pushed outside the
   * panel even in a long conversation" — so it reads the value only after it stops moving.
   */
  const overflow = async () => {
    const box = (await composer.boundingBox())!
    const card = (await panel.boundingBox())!
    return Math.round(box.y + box.height - (card.y + card.height))
  }
  await expect.poll(overflow, { timeout: 2000 }).toBeLessThanOrEqual(1)
})

/**
 * With the grid open, picking a different session left the screen unchanged (dogfooding
 * finding). If the selection changed but the display did not, then to the person who clicked,
 * nothing happened.
 */
test('Picking a session from the grid navigates to that session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  await page.getByTestId(`session-row-${ids[0]}`).click()
  await expect(page.getByTestId('grid')).toBeHidden()
  await expect(page.getByTestId('session-view')).toBeVisible()
})

/**
 * Opening a panel must show **the most recent conversation first** (dogfooding finding: "the
 * scroll does not start at the bottom, it starts at the top and scrolling down gets weird").
 *
 * The cause was the same as the composer being pushed out. If the conversation area cannot
 * shrink and instead grows with its content, scrollHeight ends up equal to clientHeight —
 * **there is no scroll to speak of.** So this checks two things together: does it actually
 * scroll, and is it sitting at the bottom.
 */
test('Opening a grid panel shows the most recent conversation first', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid) => {
    const store = (window as any).__store
    const items = Array.from({ length: 80 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      text: `long conversation ${i} `.repeat(6),
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  const box = await page
    .getByTestId(`grid-panel-${id}`)
    .getByTestId('chat-stream')
    .evaluate((el) => ({
      top: el.scrollTop,
      h: el.scrollHeight,
      c: el.clientHeight,
    }))
  // Scroll must be meaningful inside the panel (if it just grows, these two become equal)
  expect(box.h).toBeGreaterThan(box.c)
  // And it must be sitting at the very bottom
  expect(box.h - box.c - box.top).toBeLessThanOrEqual(40)
})

/**
 * "It does not grow to fill space below, so it looks awkward" (dogfooding finding).
 * Pinning the height at 52vh left empty space below even with a single panel.
 * Setting row height to minmax(minimum, 1fr) lets panels share the remaining space.
 */
test('A grid panel fills the remaining vertical space', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  const card = (await panel.boundingBox())!
  const area = (await page.getByTestId('grid').boundingBox())!
  // After subtracting the padding (p-2), it uses almost the entire screen — nothing should
  // remain below
  expect(card.height).toBeGreaterThan(area.height - 24)
})

/**
 * The grid does not scroll.
 * If there might be more below, that makes it a list, not a control tower —
 * "seeing everything at a glance" only holds if what is on screen is everything there is.
 */
test('Even with many panels, they fit the screen exactly and no scroll appears', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const ids: string[] = []
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await newSession(page, 'alpha', name)
    ids.push(await page.evaluate(() => (window as any).__store.getState().focusedSessionId))
  }
  await page.evaluate((list) => (window as any).__store.getState().setGridPanels(list.map((sessionId: string) => ({ kind: 'session', sessionId }))), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[4]}`)).toBeVisible()

  const scroll = await page.getByTestId('grid').evaluate((el) => ({
    h: el.scrollHeight,
    c: el.clientHeight,
  }))
  expect(scroll.h).toBeLessThanOrEqual(scroll.c + 1)

  // Even the last panel fits entirely within the screen
  const area = (await page.getByTestId('grid').boundingBox())!
  const last = (await page.getByTestId(`grid-panel-${ids[4]}`).boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(area.y + area.height + 1)
})

/**
 * "Dragging the conversation moves the panel instead, so text cannot be selected" (dogfooding
 * finding). A draggable ancestor stops the browser from letting text inside it be selected.
 */
test('Conversation text can be selected inside a grid panel', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({
      chat: {
        ...store.getState().chat,
        [sid]: [{ kind: 'assistant', seq: 1, text: 'a sentence that must be selectable' }],
      },
    })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  // There must be no ancestor that starts a drag
  const draggableAncestor = await panel.getByTestId('chat-stream').evaluate((el) => {
    for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
      if (n.getAttribute('draggable') === 'true') return n.getAttribute('data-testid') ?? 'unknown'
    }
    return null
  })
  expect(draggableAncestor).toBeNull()
})

/**
 * "Dragging by the session panel's tab moves the entire window" (dogfooding finding).
 * In the focus view, the header doubles as the title bar, but not in a grid panel.
 */
test("Dragging a grid panel's header does not move the app window", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const header = page.getByTestId(`grid-panel-${id}`).getByTestId('pane-header')
  await expect(header).toBeVisible()

  await page.evaluate(() => ((window as any).__mock.windowDrags = 0))
  const box = (await header.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40)
  await page.mouse.up()

  expect(await page.evaluate(() => (window as any).__mock.windowDrags)).toBe(0)
  // It must instead be the handle for moving the panel
  await expect(header).toHaveAttribute('draggable', 'true')
})

/**
 * "If I never open the session directly from the sidebar, the conversation never shows up in the
 * grid" (dogfooding finding).
 *
 * Loading history was hooked only into focusSession. In the focus view, selecting and viewing
 * are the same action, so this never showed — but the grid is a screen people **view
 * without selecting**.
 */
test('A session never opened before still shows its conversation in the grid', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // The store has the transcript, but the screen has not loaded it yet (a session right after the
  // app started)
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.messages.set(sid, [
      {
        sessionId: sid,
        seq: 1,
        role: 'user',
        kind: 'text',
        payload: { text: 'a saved old question' },
        ts: Date.now(),
      },
      {
        sessionId: sid,
        seq: 2,
        role: 'assistant',
        kind: 'text',
        payload: { text: 'a saved old answer' },
        ts: Date.now(),
      },
    ])
    const store = (window as any).__store
    // A freshly started app has neither the conversation nor a history cursor — the panel
    // decides "has this been read" by whether a cursor exists (#79)
    store.setState({ chat: {}, history: {}, focusedSessionId: null })
  }, id)

  // Add it to the grid directly, without going through the sidebar
  await page.evaluate((sid) => (window as any).__store.getState().setGridPanels([{ kind: 'session', sessionId: sid }]), id)
  await page.getByTestId('grid-button').click()

  await expect(page.getByTestId(`grid-panel-${id}`)).toContainText('a saved old answer')
})

/**
 * A grid panel's "remove" and "restart" buttons used to differ in both size and height
 * (dogfooding finding). "Remove" alone was placed on the panel with absolute coordinates —
 * there was no reason for it to line up with something in a different flow. Putting it in the
 * same row removes the need to align them at all.
 */
test("A grid panel's restart and remove buttons share the same size and the same row", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  const restart = (await panel.getByTestId('restart-session').boundingBox())!
  const remove = (await page.getByTestId(`grid-remove-${id}`).boundingBox())!

  expect(Math.abs(restart.width - remove.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(restart.height - remove.height)).toBeLessThanOrEqual(1)
  // Their vertical centers align on the same line
  expect(Math.abs(restart.y + restart.height / 2 - (remove.y + remove.height / 2))).toBeLessThanOrEqual(1)
})

/**
 * The grid button is a selection, not a toggle.
 * Leaving it as an on/off switch reads as "a temporary overlay on top of the previous screen" —
 * that misreading actually happened.
 */
test('Clicking the grid button again does not turn it off — leaving requires picking something else', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // Clicking it again still stays
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // The only way out is to pick something else
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('grid')).toBeHidden()
})

/**
 * "What I was typing to A is sitting in B's composer" — sending it as-is would go to the wrong
 * session (confirmed by measurement). The cause: an unfinished draft was attached to that spot
 * on screen rather than to the session.
 */
test('An unfinished draft does not follow the wrong session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'second')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId(`session-row-${a}`).click()
  await page.getByTestId('prompt-input').fill('what I meant to say to A')

  // B's composer must be empty
  await page.getByTestId(`session-row-${b}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('')

  // Returning to A, the unfinished draft must still be there
  await page.getByTestId(`session-row-${a}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('what I meant to say to A')
})

/**
 * In the grid, which swaps whole screens in and out, the opposite symptom appeared — the
 * component unmounted and the draft disappeared along with it.
 */
test('A draft in the grid survives switching screens and coming back', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await panel.getByTestId('prompt-input').fill('text being written in the grid')

  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('text being written in the grid')

  await page.getByTestId('grid-button').click()
  await expect(panel.getByTestId('prompt-input')).toHaveValue('text being written in the grid')
})

/**
 * "Even after entering the grid, the UI still shows the previously selected session as
 * selected" (dogfooding finding). With two things lit up at once, the screen contradicts itself
 * about which one is being viewed.
 */
test('Entering the grid leaves only the grid marked as selected in the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const row = page.getByTestId(`session-row-${id}`)
  await row.click()
  const focusedClass = (await row.getAttribute('class')) ?? ''

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // The session row must no longer look selected
  expect(await row.getAttribute('class')).not.toBe(focusedClass)
  await expect(page.getByTestId('grid-button')).toHaveAttribute('aria-pressed', 'true')

  // Returning restores the selected appearance
  await row.click()
  expect(await row.getAttribute('class')).toBe(focusedClass)
})

/**
 * Tool cards are collapsed by default (dogfooding: "Bash, Edit, MCP should default to closed").
 * Even a few uses buries the conversation in output, making the actual reply unreadable.
 */
test('Tool cards appear collapsed whether Bash or Edit', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'c1',
    summary: { tool: 'Bash', title: 'npm run build', readOnly: false, paths: [] },
  })
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'c1',
    ok: true,
    summary: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8',
  })

  const card = page.getByTestId('tool-card').first()
  await expect(card).toBeVisible()
  await expect(card.getByTestId('tool-card-toggle')).toHaveAttribute('aria-expanded', 'false')
  // Even collapsed, what it did remains visible
  await expect(card).toContainText('npm run build')

  // Clicking expands it
  await card.getByTestId('tool-card-toggle').click()
  await expect(card.getByTestId('tool-card-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(id).toBeTruthy()
})

/**
 * Where a drag will land must be visible while dragging (dogfooding: "there is no position
 * indicator, so dropping a tab leaves me unsure where it will go").
 *
 * Playwright's dragAndDrop finishes in one step and skips over the middle, so this fires the
 * drag events by hand to check the screen **mid-drag**.
 */
test('The drop position is shown left or right while dragging a panel', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'a')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'b')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId }))), [a, b])
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()

  /** Fires dragover over the left/right half of the target panel */
  const hover = (side: 'left' | 'right') =>
    page.evaluate(
      ({ from, to, where }: { from: string; to: string; where: string }) => {
        const dt = new DataTransfer()
        const header = document
          .querySelector(`[data-testid="grid-panel-${from}"]`)!
          .querySelector('[data-testid="pane-header"]')!
        header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
        const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
        const r = card.getBoundingClientRect()
        const x = where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8
        card.dispatchEvent(
          new DragEvent('dragover', {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: r.top + 10,
          }),
        )
      },
      { from: a!, to: b!, where: side },
    )

  await hover('left')
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-drop', 'before')

  await hover('right')
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-drop', 'after')

  // The original being dragged dims to show "this is what is moving"
  const cls = (await page.getByTestId(`grid-panel-${a}`).getAttribute('class')) ?? ''
  expect(cls).toContain('opacity-40')

  /*
   * The dragged image must be **the panel itself**.
   * Since the draggable element is the header, the browser by default only lifts the header —
   * the panel stays put while a thin strip follows the cursor, leaving no clue what is being
   * moved.
   */
  const lifted = await page.evaluate((from: string) => {
    let captured: string | null = null
    const real = DataTransfer.prototype.setDragImage
    DataTransfer.prototype.setDragImage = function (el: Element, x: number, y: number) {
      captured = (el as HTMLElement).getAttribute('data-testid')
      return real.call(this, el, x, y)
    }
    const header = document
      .querySelector(`[data-testid="grid-panel-${from}"]`)!
      .querySelector('[data-testid="pane-header"]')!
    header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: new DataTransfer(), bubbles: true }))
    DataTransfer.prototype.setDragImage = real
    return captured
  }, a!)
  expect(lifted).toBe(`grid-panel-${a}`)
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
 * The orchestrator is still experimental (issue #1).
 *
 * The marker must be visible **before it is clicked** — the harm being prevented is "clicking
 * without knowing", so putting it inside the screen would already be too late. It also must not
 * break the palette rule: making it bright would falsely claim more urgency than the grid, and
 * color is off-limits from the start.
 */
test('The orchestrator button states it is experimental before it is clicked — without using brightness', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  const mark = page.getByTestId('orchestrator-experimental')
  await expect(mark).toBeVisible()
  // 'Experimental' (a warning) -> 'Evolving' (an identity) (dogfooding, 2026-09-05): since it is
  // a feature that picks up skills, MCP servers and apps on its own, "still growing" is closer to
  // the truth than "might break"
  await expect(mark).toHaveText('Evolving')

  const rgb = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number)
  const style = (testId: string, prop: string) =>
    page.getByTestId(testId).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)

  // It is achromatic (R=G=B) — in this app, color is reserved for diff content
  const markColor = rgb(await style('orchestrator-experimental', 'color'))
  expect(new Set(markColor).size).toBe(1)

  // **Darker** than the label. Making it brighter would steal the spot reserved for "something is
  // waiting on me right now"
  const labelColor = rgb(await style('orchestrator-button', 'color'))
  expect(markColor[0]!).toBeLessThan(labelColor[0]!)

  /*
   * There used to be a "dashed border" check here. The reasoning was that narrowing the sidebar
   * would clip and hide the text, so a shape needed to remain — but measured, the text never
   * clips: the badge is `shrink-0`, so it stays intact even at the narrowest width. So the dashed
   * border check was dropped, and this instead holds onto **what actually needs guarding**:
   * whether this text stays on screen even when narrowed.
   */
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setSidebarWidth(180))
  await expect(mark).toBeVisible()
  await expect(mark).toHaveText('Evolving')
})

/**
 * The grid graduated (2026-08-27, the user's call). The Experimental badge went up when the
 * view shipped ahead of its spec (issue #25); weeks of dogfooding later it is simply how
 * sessions get watched side by side, and a warning that no longer warns anyone is clutter
 * on the one lane that is always on screen. This pins the removal — and that the
 * orchestrator's badge, whose surface still earns its mark, did not vanish with it.
 */
test('the grid no longer calls itself experimental — the orchestrator still does', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await expect(page.getByTestId('grid-button')).toBeVisible()
  await expect(page.getByTestId('grid-experimental')).toHaveCount(0)
  await expect(page.getByTestId('orchestrator-experimental')).toBeVisible()
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
 * The session menu has **no way to switch agents** (a dogfooding decision).
 *
 * Since the conversation cannot carry over, "switching" there meant the same thing as "starting
 * a new conversation", and creating a session already does that more honestly. This removes the
 * second door that did the same thing.
 */
test('The session settings menu cannot switch agents — creating a new one covers that', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  // Model and permission remain — those two can change while the conversation continues
  await expect(page.getByTestId('settings-menu')).toContainText('Permissions')
  await expect(page.getByTestId('settings-tool-codex')).toHaveCount(0)
  await expect(page.getByTestId('settings-menu')).not.toContainText('starts a fresh conversation')
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
 * Reasoning is visible (based on #58's measured findings).
 * codex streams summary text, so it stays in the conversation as a gray block; claude's content
 * is encrypted, so only a "Thinking · ~N tokens" progress indicator is possible — not pretending
 * to show content that does not exist is part of the contract too.
 */
test("codex's reasoning summary shows as a gray block and survives a restore", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'reasoning_delta', text: '**Reviewing path constraints**' })
  await emitEvent(page, 0, { type: 'reasoning_delta', text: '\n\n**Checking the minimum count**' })
  await expect(page.getByTestId('msg-reasoning')).toContainText('Reviewing path constraints')
  await expect(page.getByTestId('msg-reasoning')).toContainText('Checking the minimum count')

  // Restore leg: discard the in-memory conversation and force-read it back from the transcript
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)
  await expect(page.getByTestId('msg-reasoning')).toContainText('Reviewing path constraints')
})

test("claude's thinking shows as a quantity — Thinking · ~N tokens, and disappears when the turn ends", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await emitEvent(page, 0, { type: 'reasoning_delta', estTokens: 500 })
  await emitEvent(page, 0, { type: 'reasoning_delta', estTokens: 1000 })
  await expect(page.getByTestId('activity-label')).toContainText('Thinking · ~1.5k tokens')

  // Nothing remains in the conversation — there was never any content
  await expect(page.getByTestId('msg-reasoning')).toHaveCount(0)

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('activity-row')).toHaveCount(0)
})

/**
 * A plan is visible (measured for #58, codex's turn/plan/updated).
 * Measured, a plan never arrives as an item — dropping this notification would mean codex's use
 * of the plan tool never appears anywhere on screen. The contract covers snapshot replacement and
 * disappearing when the turn ends.
 */
test("codex's plan shows as a checklist, updates replace the snapshot, and it disappears when the turn ends", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await emitEvent(page, 0, {
    type: 'plan_update',
    steps: [
      { text: 'Prepare to run the command', status: 'inProgress' },
      { text: 'Run the command', status: 'pending' },
    ],
  })
  await expect(page.getByTestId('activity-plan')).toBeVisible()
  await expect(page.getByTestId('plan-step-0')).toHaveAttribute('data-status', 'inProgress')
  await expect(page.getByTestId('plan-step-1')).toContainText('Run the command')

  // An update is a full snapshot replacement, not delta merging
  await emitEvent(page, 0, {
    type: 'plan_update',
    steps: [
      { text: 'Prepare to run the command', status: 'completed' },
      { text: 'Run the command', status: 'inProgress' },
    ],
  })
  await expect(page.getByTestId('plan-step-0')).toHaveAttribute('data-status', 'completed')
  await expect(page.getByTestId('plan-step-1')).toHaveAttribute('data-status', 'inProgress')

  // Being only a progress indicator, the plan disappears along with the turn's end (the same
  // lifetime as activity)
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('activity-plan')).toHaveCount(0)
})

/**
 * Live execution output is visible (measured for #58, codex's item/commandExecution/outputDelta).
 * The sum of the chunks is not the whole thing (measured: the first chunk gets lost) — so while
 * running, only the tail is shown, and once complete, a result carrying the full output replaces
 * the chunks.
 */
test('Live tool output streams as a tail, and switches to the result once complete', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'exec-1',
    summary: {
      tool: 'Bash',
      title: 'for i in 1 2 3; do echo tick $i; sleep 1; done',
      readOnly: false,
      paths: [],
    },
  })
  await emitEvent(page, 0, { type: 'tool_output_delta', callId: 'exec-1', text: 'tick 2\n' })
  await emitEvent(page, 0, { type: 'tool_output_delta', callId: 'exec-1', text: 'tick 3\n' })
  await expect(page.getByTestId('tool-card-live')).toContainText('tick 3')

  // Completion: the full output arrives as a result, and the live tail, its job done, disappears
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'exec-1',
    ok: true,
    summary: 'tick 1\ntick 2\ntick 3',
  })
  await expect(page.getByTestId('tool-card-live')).toHaveCount(0)
  await expect(page.getByTestId('tool-card-output')).toContainText('tick 1')
})

test('My own sent message does not render twice', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('prompt-input').fill('the same words')
  await page.getByTestId('send').click()
  // The host reports "that message was added" — since it is already drawn, this must only
  // confirm it
  await emitEvent(page, 0, { type: 'user_message', seq: 992, text: 'the same words' })

  const count = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    const id = st.focusedSessionId
    return st.chat[id].filter((i: any) => i.kind === 'user' && i.text === 'the same words').length
  })
  expect(count).toBe(1)
})

/**
 * Checks closely whether the gust **ever appeared at all**, even once.
 *
 * `toHaveCount(0)` cannot catch it — that auto-retries, so it passes as soon as the gust appears
 * and then disappears ("eventually 0", not "never appeared"). This gap actually let a test meant
 * to catch a trigger bug pass anyway.
 */
async function blew(page: import('@playwright/test').Page, ms = 900): Promise<boolean> {
  for (let i = 0; i < ms / 50; i++) {
    if ((await page.getByTestId('gust').count()) > 0) return true
    await page.waitForTimeout(50)
  }
  return false
}

/**
 * A gust that sweeps across the screen once a reply finishes.
 * Instead of writing "done" in text, the screen takes one breath.
 */
test('A gust blows once and disappears when the session being watched finishes', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await expect(page.getByTestId('gust')).toHaveCount(0)
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('gust')).toBeVisible()

  /*
   * Once it passes, it is removed from the DOM. Leaving it transparent would leave a
   * full-screen-covering element sitting there permanently — eventually it would obscure
   * something.
   */
  await expect(page.getByTestId('gust')).toHaveCount(0, { timeout: 3000 })
})

test("A gust does not blow when an off-screen session finishes — that is the card's job", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // Watching this one

  // Session 0 (not being watched) finishes
  await emitEvent(page, 0, { type: 'turn_complete' })
  expect(await blew(page)).toBe(false)
  // A lingering signal arrives instead of a passing one — since it was not being watched, a
  // passing signal would be missed
  await expect(page.getByTestId('notice')).toHaveCount(1)
})

/*
 * The notice card — for someone who stepped away.
 *
 * An OS banner clears after a few seconds, so something that arrived while the person was away
 * would already be gone by the time they return. On macOS the banner path is even dead outright
 * (the plugin rides on NSUserNotification, deprecated since 2018). So this card is the real
 * mechanism, and persisting is the whole point.
 */
/*
 * Dogfooding report: "Now even the card does not show up."
 *
 * The judgment of "is it visible" **never looked at the app itself.** isOnScreen only checks
 * which session is displayed in the UI, so it stayed true even with the app behind another
 * window. So if the session being watched finished while the person was away, the gust blew in
 * an empty room and no card was ever created — in exactly the case a notification is needed
 * most, exactly nothing happened.
 */
test('When the app is in the background, the card persists even if the session being watched finishes', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work') // Watching this session

  // Switch to another app
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))

  await emitEvent(page, 0, { type: 'turn_complete' })

  // Not the window being watched, so nobody sees the gust -> it must be a lingering signal
  expect(await blew(page)).toBe(false)
  await expect(page.getByTestId('notice')).toHaveCount(1)

  // Returning means it is being seen then, so it clears
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('notice')).toHaveCount(0)
})

test('Finishing while away also calls out with a sound — it does not wait for everything to finish', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await emitEvent(page, 0, { type: 'turn_complete' })

  await expect
    .poll(() =>
      page.evaluate(() => (window as never as { __mock: { alerts: { kind: string }[] } }).__mock.alerts),
    )
    .toEqual([{ kind: 'done', sound: true }])
})

test('When it is right in front of the person, only the card stays and no sound plays', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // Watching this one -> first is off-screen

  await emitEvent(page, 0, { type: 'turn_complete' })

  // Unseen, so the card stays. But calling with a sound at someone right in front of it is just noise.
  await expect(page.getByTestId('notice')).toHaveCount(1)
  await page.waitForTimeout(300)
  expect(
    await page.evaluate(() => (window as never as { __mock: { alerts: unknown[] } }).__mock.alerts.length),
  ).toBe(0)
})

test('The card does not disappear on its own over time', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('notice')).toHaveCount(1)

  // A toast clears at 2.5 seconds. Even waiting comfortably longer than that, this must remain.
  await page.waitForTimeout(4000)
  await expect(page.getByTestId('notice')).toHaveCount(1)
})

test('The card clears once that session is being viewed', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 0, { type: 'turn_complete' })
  const card = page.getByTestId('notice')
  await expect(card).toHaveCount(1)
  const target = await card.getAttribute('data-session')

  await page.evaluate((id) => {
    const st = (window as never as { __store: { getState(): Record<string, never> } }).__store.getState()
    ;(st as unknown as { focusSession(id: string): void }).focusSession(id!)
  }, target)

  await expect(page.getByTestId('notice')).toHaveCount(0)
})

test('Clicking the card navigates to that session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 0, { type: 'turn_complete' })
  const target = await page.getByTestId('notice').getAttribute('data-session')

  await page.getByTestId('notice-open').click()

  const focused = await page.evaluate(
    () =>
      (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState()
        .focusedSessionId,
  )
  expect(focused).toBe(target)
  // Having navigated there, there is no reason to keep calling out
  await expect(page.getByTestId('notice')).toHaveCount(0)
})

test('Clicking × clears only the card without navigating to that session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  const before = await page.evaluate(
    () =>
      (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState()
        .focusedSessionId,
  )
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('notice')).toHaveCount(1)

  await page.getByTestId('notice-close').click()

  await expect(page.getByTestId('notice')).toHaveCount(0)
  const after = await page.evaluate(
    () =>
      (window as never as { __store: { getState(): { focusedSessionId: string } } }).__store.getState()
        .focusedSessionId,
  )
  // It only dismissed the card — it does not mean navigating there
  expect(after).toBe(before)
})

/*
 * If one busy session generates twenty cards, the rest get pushed off screen — so the more
 * cards there are, the less useful they become.
 */
/*
 * Sound and the dock badge **stand in where the banner has died.**
 *
 * The banner path (tauri-plugin-notification) returns a hardcoded permission state on desktop
 * and swallows delivery failures entirely, so the app has no way to know even if not a single
 * notification went out. So this test grabs the side that actually fires — if it ever goes
 * silent here, being away from the app goes dark again.
 */
test('A pending approval also calls out with sound and the dock badge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  // The notification policy says "do not notify if it is in front of the person" — since the test
  // window is always focused, this opens that condition
  await page.evaluate(() => {
    const st = (window as never as { __store: { getState(): Record<string, never> } }).__store.getState()
    const s = st as unknown as { notifyPolicy: Record<string, boolean>; setNotifyPolicy(p: unknown): void }
    s.setNotifyPolicy({ ...s.notifyPolicy, whenFocused: true, sound: true })
  })

  await injectApproval(page, 0, { tool: 'Bash', command: 'rm -rf /tmp/x' })

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as never as { __mock: { alerts: { kind: string; sound: boolean }[] } }).__mock.alerts,
      ),
    )
    .toEqual([{ kind: 'approval', sound: true }])
})

/*
 * Settings are split into tabs (issue #7).
 *
 * Three groups used to be stacked into one long scroll. That reads fine at three, but settings
 * only ever grow, and by eight, finding what the person wants gets buried somewhere in the scroll. The
 * tabs are split by **what the person came looking for** — make it stop pinging me
 * (Notifications), undo that auto-allow from earlier (Permissions), what was that key again
 * (Shortcuts). Only one tab is rendered at a time, so a tab not selected must not be on screen.
 */
test('Settings are split into tabs, and only one tab shows at a time', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('open-settings').click()

  // Opening it starts on Notifications — the most frequent reason to come here
  await expect(page.getByTestId('notify-approval')).toBeVisible()
  await expect(page.getByTestId('shortcut-list')).toBeHidden()

  await page.getByTestId('settings-tab-shortcuts').click()
  await expect(page.getByTestId('shortcut-list')).toContainText('⌘K')
  // Other tabs are not collapsed, they are absent — staying invisible in the DOM would make this
  // decoration, not a tab
  await expect(page.getByTestId('notify-approval')).toBeHidden()

  await page.getByTestId('settings-tab-permissions').click()
  await expect(page.getByTestId('rules-empty')).toBeVisible()
  await expect(page.getByTestId('shortcut-list')).toBeHidden()
})

test('Settings opens directly from the top bar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // The shortcuts table lives inside here — it must not require already knowing a shortcut to open
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings')).toBeVisible()
})

/*
 * In a settings menu row, **the name must never get squeezed out by the description**
 * (dogfooding finding: "Normal" was invisible in the permission group). Because the hint is
 * shrink-0, the label shrank all the way to 0 in the narrow menu (w-56) — a row with the
 * description intact and the very name to pick gone. This directly measures whether the label
 * is clipped in all three rows.
 */
test('Permission preset names are never squeezed out by their descriptions', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first instruction')
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  for (const v of ['safe', 'normal', 'auto']) {
    const label = page.getByTestId(`settings-preset-${v}`).locator('span').nth(1)
    await expect(label, v).not.toBeEmpty()
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), `${v} label clipped`).toBe(true)
  }
})

/*
 * Checkboxes are drawn by us (dogfooding finding: when the window loses key focus, the check's
 * background color turned gray under the OS's hand — accent-color cannot override that inactive
 * paint). Chromium cannot reproduce macOS's inactive paint, so this instead checks whether the
 * cause — leaving the drawing to the OS — has been removed.
 */
test('Checkboxes do not use native rendering — active and inactive windows produce the same pixels', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('open-settings').click()
  const box = page.getByTestId('notify-approval')
  await expect(box).toBeVisible()
  expect(await box.evaluate((el) => getComputedStyle(el).appearance)).toBe('none')
  // Having taken over the drawing, the checkmark must be ours too — without it, "checked" would
  // be invisible
  expect(await box.evaluate((el) => getComputedStyle(el, '::after').borderRightWidth)).not.toBe('0px')
})

test('The same session finishing multiple times still produces only one card', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'turn_complete' })

  await expect(page.getByTestId('notice')).toHaveCount(1)
})

/*
 * Report: "it also blows just from switching session windows".
 *
 * It finished once earlier, and nothing finished again in between. Yet moving to that session
 * triggers a gust — the gust was wired to the value "is finished" rather than the event "just
 * finished".
 */
test('Moving to an already-finished session does not trigger a gust', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second') // Watching this one

  await emitEvent(page, 0, { type: 'turn_complete' }) // The unseen one finishes
  await page.waitForTimeout(200)
  await expect(page.getByTestId('gust')).toHaveCount(0)

  // Move to that finished session — nothing new has finished
  const moved = await page.evaluate(() => {
    const store = (window as never as { __store: { getState(): Record<string, never> } }).__store
    const st = store.getState() as unknown as {
      sessions: Record<string, { id: string }>
      focusedSessionId: string
      focusSession(id: string): void
    }
    // The session that finished earlier = the one not currently being watched
    const target = Object.values(st.sessions).find((x) => x.id !== st.focusedSessionId)!.id
    st.focusSession(target)
    const after = (store.getState() as unknown as { focusedSessionId: string }).focusedSessionId
    return { target, after }
  })
  // **Confirm the move happened first** — if it never moved, "no gust" proves nothing
  expect(moved.after).toBe(moved.target)

  expect(await blew(page)).toBe(false)
})

/*
 * And from one completion, it used to blow again and again — blowing anew every time the person
 * moved away and back.
 */
test('Moving away and back does not make a past completion blow again', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')

  await emitEvent(page, 1, { type: 'turn_complete' }) // The one being watched finishes — blowing once here is correct
  await expect(page.getByTestId('gust')).toBeVisible()
  await expect(page.getByTestId('gust')).toHaveCount(0, { timeout: 3000 })

  const swap = (i: number) =>
    page.evaluate((idx) => {
      const st = (window as never as { __store: { getState(): Record<string, never> } }).__store.getState()
      const list = Object.values(st.sessions as unknown as Record<string, { id: string }>)
      ;(st as unknown as { focusSession(id: string): void }).focusSession(list[idx]!.id)
    }, i)

  await swap(0)
  expect(await blew(page, 300)).toBe(false)
  await swap(1) // Back again. Nothing finished in between.
  expect(await blew(page, 300)).toBe(false)
})

/**
 * A choice the agent presents (AskUserQuestion).
 *
 * Displaying it is only half the job if the answer never goes anywhere — that is exactly how the
 * approval card once went unresponsive. So every test here also checks **whether the answer
 * actually reached the session**.
 */
const QUESTIONS = [
  {
    question: 'What should we have for lunch?',
    header: 'Lunch',
    options: [
      { label: 'Kimbap', description: 'Fast' },
      { label: 'Ramen', description: 'Warm' },
    ],
    multiSelect: false,
  },
  {
    question: 'What about something to drink?',
    header: 'Drink',
    options: [
      { label: 'Water', description: 'A safe choice' },
      { label: 'Coffee', description: 'Wakes you up' },
    ],
    multiSelect: false,
  },
]

test('Clicking an option to answer sends that answer to the session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await expect(page.getByTestId('question-card')).toBeVisible()
  // The description is the basis for deciding — if it clips, this feature is dead (it actually
  // went unused for exactly that reason)
  await expect(page.getByTestId('question-card')).toContainText('Warm')

  await page.getByTestId('question-option').filter({ hasText: 'Ramen' }).click()
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Ramen')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
})

test('Multiple questions split into tabs, and sending requires answering all of them', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: QUESTIONS })

  // Multiple questions use tabs, not stacking (#8) — the second question only becomes visible by
  // switching to its own tab
  await expect(page.getByTestId('question-tabs')).toBeVisible()
  await expect(page.getByTestId('question-card')).not.toContainText('What about something to drink?')

  // Sending half-answered lets the model invent the rest — so it stays locked until everything is
  // picked
  await page.getByTestId('question-option').filter({ hasText: 'Kimbap' }).click()
  await expect(page.getByTestId('question-submit')).toBeDisabled()
  // Which tab is still empty reads off the tab row — that is exactly why stacking was dropped
  await expect(page.getByTestId('question-tab-0')).toHaveAttribute('data-answered', 'true')
  await expect(page.getByTestId('question-tab-1')).not.toHaveAttribute('data-answered', 'true')

  await page.getByTestId('question-tab-1').click()
  await page.getByTestId('question-option').filter({ hasText: 'Coffee' }).click()
  await expect(page.getByTestId('question-submit')).toBeEnabled()
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Kimbap | Coffee')
})

/**
 * Switching tabs must be free. If hiding meant unmounting, a half-typed custom answer would
 * vanish after briefly glancing at another question — the one cost that switching from stacking
 * to tabs must never introduce.
 */
test('Switching tabs keeps what was picked and what was being typed', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: QUESTIONS })

  await page.getByTestId('question-other').click()
  await page.getByTestId('question-other-input').fill('a half-typed answer')
  await page.getByTestId('question-tab-1').click()
  await page.getByTestId('question-tab-0').click()
  await expect(page.getByTestId('question-other-input')).toHaveValue('a half-typed answer')
})

/*
 * What the tool schema pins down: "There should be no 'Other' option, that will be provided
 * automatically." That slot is the screen's own responsibility to create. Without it, the
 * person can only answer with one of the two offered choices, leaving nothing to say when a
 * third answer exists.
 */
test('Picking "Other" and typing a custom answer sends exactly that', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await page.getByTestId('question-other').click()
  await page.getByTestId('question-other-input').fill('Neither — noodles instead')
  await page.getByTestId('question-submit').click()

  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: Neither — noodles instead')
})

test('Picking "Other" and leaving it empty cannot be sent', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })

  await page.getByTestId('question-other').click()
  await expect(page.getByTestId('question-submit')).toBeDisabled()
})

/**
 * The worktree option (FR-2).
 *
 * The spec's principle is "work directly in the original directory", and a worktree is turned on
 * only by **the person who wants one**. So the screen has to hold two things: it defaults to
 * off, and once it is on, that fact must be visible.
 */
test('The worktree defaults to off, and turning it on shows the branch on the session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  const toggle = page.getByTestId('worktree-toggle').locator('input')
  await expect(toggle).not.toBeChecked()

  await toggle.check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill('fix it in isolation')
  await page.getByTestId('prompt-input').press('Enter')

  // If it stays invisible that this runs in a different directory, the person hits "why isn't my
  // project folder changing"
  await expect(page.getByTestId('worktree-badge')).toBeVisible()
  await expect(page.getByTestId('worktree-badge')).toContainText('centralu/')
})

test('A session with the worktree off has no badge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'just do it here')

  await expect(page.getByTestId('worktree-badge')).toHaveCount(0)
})

/**
 * A worktree's **lifetime differs from the session's.** Hours of an agent's work can be sitting
 * in it, so the default is to keep it, and deleting it requires the person to read what would be
 * lost and turn that on themselves.
 */
test('Deleting a worktree session asks first, and deletion requires opting in', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill('isolated session')
  await page.getByTestId('prompt-input').press('Enter')

  // Set up uncommitted changes — the dialog must state what would be lost in that case
  await page.evaluate(() => {
    ;(window as any).__mock.mockWorktreeDirty = true
  })

  /*
   * Worktree sessions are now drawn nested under a manager (#69) — the first row in the list is
   * the manager. Grabbing `.first()` would click the manager's own delete, so this picks the
   * nested row instead.
   */
  await page
    .locator('li[data-nested]')
    .getByTestId(/^session-menu-/)
    .click()
  await page
    .locator('li[data-nested]')
    .getByTestId(/^delete-session-/)
    .click()

  const panel = page.getByTestId('delete-worktree')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('worktree-dirty')).toContainText('2')

  // Off by default — if deleting were the default, an irreversible action would happen quietly
  await expect(page.getByTestId('delete-worktree-toggle')).not.toBeChecked()
})

test('Deleting a non-worktree session never mentions worktrees', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'regular session')

  await page
    .getByTestId(/^session-menu-/)
    .first()
    .click()
  await page
    .getByTestId(/^delete-session-/)
    .first()
    .click()

  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await expect(page.getByTestId('delete-worktree')).toHaveCount(0)
})

/**
 * In the grid, a panel that is responding has a **spinning border.**
 *
 * With several panels, a small marker in the header alone is too small for the eye to track
 * which one is working. The grid is a screen to glance at, not read, so the signal has to be the
 * size of the whole panel to catch peripheral vision.
 */
test('Grid: only the responding panel has a spinning border', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'second')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${a}"]`, '[data-testid="grid-button"]')
  await page.dragAndDrop(`[data-testid="session-row-${b}"]`, '[data-testid="grid-button"]')

  const panelA = page.getByTestId(`grid-panel-${a}`)
  const panelB = page.getByTestId(`grid-panel-${b}`)

  // Both are working from their first prompt — compare only after they finish
  for (const idx of [0, 1]) await emitEvent(page, idx, { type: 'turn_complete' })
  await expect(panelA).not.toHaveClass(/cc-orbit-ring/)
  await expect(panelB).not.toHaveClass(/cc-orbit-ring/)

  // Only give work to a
  await page.getByTestId(`grid-panel-${a}`).getByTestId('prompt-input').fill('something that takes a while')
  await page.getByTestId(`grid-panel-${a}`).getByTestId('send').click()

  await expect(panelA).toHaveClass(/cc-orbit-ring/)
  // If the neighboring panel spins too, "which one is busy" cannot be read — it becomes
  // decoration, not a signal
  await expect(panelB).not.toHaveClass(/cc-orbit-ring/)
})

/**
 * A conversation long enough that the panel scrolls and the virtualiser has real work to
 * do, left where a reader would leave it — at the newest line.
 *
 * The pinning loop at the end is setup, not the behaviour under test. Dropping eighty
 * turns into a view somebody is already looking at is not something a person can do, and
 * the view is entitled to end up somewhere odd afterwards; the tests below are about what
 * happens to a position you actually held.
 */
async function seedLongChat(page: Page, sessionId: string) {
  await page.evaluate((sid: string) => {
    const store = (window as any).__store
    const items = Array.from({ length: 80 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      // Well past the virtualiser's 64px guess — that gap is where #31 lived
      text: `line ${i} `.repeat(60),
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, sessionId)

  const stream = page.getByTestId('chat-stream')
  await expect
    .poll(async () => {
      await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
      return distanceFromBottom(stream)
    })
    .toBeLessThanOrEqual(80)
}

/** How far the stream is from its own bottom, in px. `< BOTTOM_SLACK` means "at the bottom" */
function distanceFromBottom(stream: Locator): Promise<number> {
  return stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
}

/**
 * Scroll survives leaving a grid panel and coming back (issue #31).
 *
 * Fourth time this shape has bitten: draft text, expanded folders, the elapsed count, and
 * now this. What is preserved is **"was I stuck to the bottom"**, not a pixel offset — a
 * `scrollTop` restored into a virtualiser that has not measured its rows yet lands *near*
 * the right place, which was the reported symptom rather than a cure for it.
 *
 * Note this one **passes against the old code on a quiet machine**, and fails on a busy
 * one (measured 339px short, repeatedly, with the suite running in parallel). The gap it
 * is about opens while rows are being measured, so how much of it you see depends on how
 * many frames the measuring takes. So: a contract written down, not a net. The net for
 * this pair is the test below, which fails on the old code every time.
 */
test('stuck to the bottom of a grid panel, still there after looking away (#31)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const stream = page.getByTestId(`grid-panel-${id}`).getByTestId('chat-stream')
  await expect(stream).toBeVisible()
  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)

  // Away to the focus view and back — the panel is torn down and built again
  await page.getByTestId(`session-row-${id}`).click()
  await page.getByTestId('grid-button').click()
  await expect(stream).toBeVisible()

  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)
})

/**
 * The other half: reading something further up is also a position worth keeping.
 *
 * We cannot promise the exact spot back — that is the offset problem above — but being
 * yanked to the newest message is a decision the app makes *against* you, and it used to
 * make it every single time, because the flag was born `true` with the component.
 */
test('scrolled up to read, a grid panel does not yank you back down (#31)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const stream = page.getByTestId(`grid-panel-${id}`).getByTestId('chat-stream')
  await expect(stream).toBeVisible()
  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)

  // Scroll up by hand — the wheel, so it is a real user scroll and not an assignment
  await stream.hover()
  await page.mouse.wheel(0, -4000)
  await expect.poll(() => distanceFromBottom(stream)).toBeGreaterThan(80)

  await page.getByTestId(`session-row-${id}`).click()
  await page.getByTestId('grid-button').click()
  await expect(stream).toBeVisible()

  // Give the follow logic every chance to drag us down before we believe it did not
  await page.waitForTimeout(300)
  expect(await distanceFromBottom(stream)).toBeGreaterThan(80)
})

/**
 * #61: on returning, it must be **the spot being read** — "it was not the bottom" is not enough.
 *
 * What #31 guaranteed only went as far as "does not pull you down to the bottom". But since
 * nothing was preserved, the browser started the new element at scrollTop 0, so the result was
 * always **the very top** — leaving mid-read in an 80-turn conversation and coming back landed
 * right at the beginning. Now, on leaving, the row (seq) straddling the top of the screen is
 * recorded, and returning scrolls back to that row.
 */
test('Returns to the spot being read — not the top (#61)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)

  const stream = page.getByTestId('chat-stream')
  // Scroll up to somewhere in the middle to read (the bug only lives in a spot that is neither
  // the bottom nor the top)
  await stream.hover()
  await page.mouse.wheel(0, -3000)
  await expect.poll(() => distanceFromBottom(stream)).toBeGreaterThan(80)
  const before = await stream.evaluate((el) => el.scrollTop)
  expect(before).toBeGreaterThan(200)

  // Leave the screen and come back (the grid discards the panel entirely and rebuilds it)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()
  await page.getByTestId(`session-row-${id}`).click()
  await expect(stream).toBeVisible()

  // The intermediate position is never drawn while settling — it stays hidden while being measured
  await expect(stream).not.toHaveAttribute('data-settling', 'true')

  // It lands near the same row. Not requiring pixel-exact equality is because rows get
  // re-measured — but this is clearly distinguishable from "it went back to the top"
  const after = await stream.evaluate((el) => el.scrollTop)
  expect(Math.abs(after - before)).toBeLessThan(120)
})

/**
 * The same thing happens without the grid too (pointed out by the person): even just switching
 * sessions in the focus view reuses the same component with only sessionId swapped, so without
 * something preserved, the position is lost.
 */
test('Switching sessions and returning keeps the spot being read (#61)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, a)
  await newSession(page, 'alpha', 'second')

  await page.getByTestId(`session-row-${a}`).click()
  const stream = page.getByTestId('chat-stream')
  await stream.hover()
  await page.mouse.wheel(0, -3000)
  await expect.poll(() => distanceFromBottom(stream)).toBeGreaterThan(80)
  const before = await stream.evaluate((el) => el.scrollTop)

  // Visit a neighboring session and come back — the screen type stays the same, only sessionId
  // changes
  const b = await page.evaluate(
    (aId: string) => Object.keys((window as any).__store.getState().sessions).find((x) => x !== aId),
    a,
  )
  await page.getByTestId(`session-row-${b}`).click()
  await page.getByTestId(`session-row-${a}`).click()
  await expect(stream).toBeVisible()

  const after = await stream.evaluate((el) => el.scrollTop)
  expect(Math.abs(after - before)).toBeLessThan(120)
})

/** Confirms that sending actually attaches to the conversation — history is drawn from what attached (#38) */
async function sendMessage(page: Page, body: string) {
  const seen = await page.getByTestId('msg-user').count()
  await page.getByTestId('prompt-input').fill(body)
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('msg-user')).toHaveCount(seen + 1)
}

/**
 * Arrow keys recall what was sent (#38).
 *
 * Exactly like a shell. No separate history is stored — the conversation itself already holds
 * everything said.
 */
test('arrow up walks back through what you sent, arrow down walks forward (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first prompt')
  await sendMessage(page, 'second thing sent')
  await sendMessage(page, 'third thing sent')

  const input = page.getByTestId('prompt-input')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('third thing sent')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('second thing sent')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('first prompt')

  // Pressing further up from the oldest entry stays at that entry — if the cursor moved, it reads
  // as "not registering"
  await input.press('ArrowUp')
  await expect(input).toHaveValue('first prompt')

  await input.press('ArrowDown')
  await expect(input).toHaveValue('second thing sent')
})

/**
 * An unfinished draft is not something a single arrow key press can lose.
 *
 * This is exactly the kind of loss this app has fixed repeatedly, so the draft is never touched
 * at all while recalling.
 */
test('arrow down past the newest gives the unsent draft back (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  await input.fill('not yet sent text')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('sent message')

  await input.press('ArrowDown')
  await expect(input).toHaveValue('not yet sent text')
})

/** Recall belongs to the current conversation — if someone else's message sat in my composer it would be sent as-is */
test('recall does not reach into another session (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'what I said to A')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'what I said to B')

  const input = page.getByTestId('prompt-input')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('what I said to B')

  // Switching sessions does not carry the recalled text along
  await page.getByTestId(`session-row-${a}`).click()
  await expect(input).toHaveValue('')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('what I said to A')
})

/**
 * While autocomplete is open, the arrows belong to the list.
 *
 * Both want the arrows, and whichever is open wins — if the composer swapped to an old message
 * entirely while a list was open and being navigated, there would be no way to know what just
 * happened.
 */
test('the autocomplete list keeps the arrows while it is open (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.commandState = {
      ready: true,
      commands: [
        { name: 'review', description: 'Reviews the changes', argumentHint: '' },
        { name: 'restart', description: 'Restarts', argumentHint: '' },
      ],
    }
  })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  await input.fill('/re')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  await expect(page.getByTestId('autocomplete-item-0')).toHaveAttribute('aria-selected', 'true')

  await input.press('ArrowDown')
  // The selected row moved, and the composer keeps exactly what was typed
  await expect(page.getByTestId('autocomplete-item-1')).toHaveAttribute('aria-selected', 'true')
  await expect(input).toHaveValue('/re')

  await input.press('ArrowUp')
  await expect(page.getByTestId('autocomplete-item-0')).toHaveAttribute('aria-selected', 'true')
  await expect(input).toHaveValue('/re')
})

/**
 * While writing multiple lines, the arrows belong to the caret first.
 *
 * Only up from the first line, or down from the last line, brings up history. The hand already
 * knows this rule (from shells and devtools), so there is nothing new to learn.
 */
test('in a multi-line draft the arrows move the caret first (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  await input.fill('line one\nline two')

  // The caret sits at the end (= the last line) — up moves the caret
  await input.press('ArrowUp')
  await expect(input).toHaveValue('line one\nline two')

  // Now it is on the first line — pressing once more here brings up history
  await input.press('ArrowUp')
  await expect(input).toHaveValue('sent message')
})

/**
 * Even in a single line wrapped into several visual lines, the arrows belong to the caret first
 * (pointed out by the person, 2026-09-07).
 *
 * There is no newline, but the eye sees three lines. It used to count only newlines, so pressing
 * from any line counted as "the first line" and brought up history — the text being written
 * appeared to vanish.
 */
test('a long wrapped line moves the caret before it recalls history (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  // A single line, no newlines, wide enough to wrap the composer's width several times
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
  await input.fill(long)

  // First confirm it actually wrapped into multiple lines — without wrapping this test sees nothing
  const rows = await input.evaluate((el: HTMLTextAreaElement) => {
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16
    return Math.round(el.scrollHeight / lh)
  })
  expect(rows).toBeGreaterThan(1)

  // The caret sits at the end (= the last wrapped line) — up moves the caret, not history
  await input.press('ArrowUp')
  await expect(input).toHaveValue(long)
  const moved = await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)
  expect(moved).toBeLessThan(long.length)

  // Once it reaches the very top line, history takes over from there (no matter how many times it
  // wrapped, pressing up repeatedly reaches it)
  for (let i = 0; i < rows + 1; i++) await input.press('ArrowUp')
  await expect(input).toHaveValue('sent message')
})

/**
 * An arrow key while composing belongs to the candidate list (#12).
 *
 * For someone typing Korean, Japanese, or Chinese, the arrow keys also pick among candidate
 * characters. Intercepting it here would wipe out the character being chosen entirely — this
 * constructs the keyboard event by hand to declare composition is in progress, a state that
 * cannot be reproduced by an actual human hand.
 */
test('arrows do not recall while an IME is composing (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  await input.fill('ㅎ')
  await input.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true }))
  })
  await expect(input).toHaveValue('ㅎ')

  // Once composition ends, the same key brings up history
  await input.press('ArrowUp')
  await expect(input).toHaveValue('sent message')
})

/**
 * A recalled message grows the composer exactly like typed text does.
 *
 * Height is derived from the value, so adding one more path should follow automatically — but
 * "it should follow" and "it does follow" are different claims, so this measures it.
 */
test('a recalled multi-line message grows the composer (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'one line')

  const input = page.getByTestId('prompt-input')
  await sendMessage(page, 'line one\nline two\nline three')
  const short = await input.evaluate((el) => el.clientHeight)

  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('line one\nline two\nline three')
  expect(await input.evaluate((el) => el.clientHeight)).toBeGreaterThan(short)
})

/**
 * The sidebar's changed count was read once, at attach, and never again (#41).
 *
 * So an agent could edit ten files and commit them while the number beside the project
 * name sat on whatever it had been at app start — the most visible of the three stale
 * git surfaces, because it is on screen in every view.
 *
 * A turn ending is the cheap, strong signal that the tree moved: it means an agent just
 * stopped editing in that folder. Which is also why a burst of them has to cost **one**
 * `git status` — two sessions in one project finishing together are one piece of news.
 */
test('a finished turn moves the sidebar changed count, once per burst (#41)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'one')
  await newSession(page, 'alpha', 'two')

  // The working tree moved while the agents worked
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitStatusCalls = 0
    m.gitState.files = [
      { path: 'a.ts', staged: false, status: 'M' },
      { path: 'b.ts', staged: false, status: 'M' },
      { path: 'c.ts', staged: false, status: 'M' },
    ]
  })

  // Both sessions of the project finish in the same instant — the burst the debounce is for
  await page.evaluate(() => {
    const m = (window as any).__mock
    for (const s of [...m.sessions.values()] as any[]) m.emit({ type: 'turn_complete', sessionId: s.id })
  })

  const mark = page.getByTestId('mark-changed-alpha')
  await expect(mark).toHaveText('3')
  await mark.hover()
  await expect(page.getByRole('tooltip')).toContainText('3 uncommitted files')

  // Two turns, one measurement (800ms per project)
  expect(await page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(1)
})

/**
 * Waiting for `turn_complete` alone freezes the count for as long as the turn runs — ten
 * minutes of watching an agent edit files while the sidebar insists nothing has changed.
 * Letting an edit through says the tree is about to move, so it counts as news too (#41).
 */
test('granting a file edit refreshes the project count before the turn ends (#41)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await injectApproval(page, 0, { kind: 'file_edit', path: 'src/a.ts', diffPreview: '+one', multi: false })
  await page.evaluate(() => {
    const m = (window as any).__mock
    // The edit lands in the moment after the click — the refresh has to measure after it
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
  })

  await page.getByTestId('approve-allow').click()
  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('1')
})

/**
 * A commit from the narrow panel goes through the same path (#49).
 *
 * This case stands out even more: the button sits **right next to** the sidebar, so after
 * committing, the number a few pixels to the left holding onto its old value was visible at a
 * glance.
 */
test("Committing from the narrow panel still updates the sidebar's changed count (#49)", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: true, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'task')
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('2')

  await page.getByTestId('evidence-commit-message').fill('commit from the panel')
  await page.getByTestId('evidence-commit').click()

  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('1')
})

/**
 * Not just commits — **anything that changes the repository** reports in (#49).
 *
 * Staging usually does not move the count (porcelain shows one line per path whether staged or
 * not), and switching branches changes the **name**, not the count. So neither can be confirmed
 * from an on-screen number — instead this counts whether the store re-measured at all. The point
 * is not to guess what changed and filter based on that in either case: a rule like that stays
 * silently wrong for a long time.
 *
 * `push` is deliberately left out. None of what the sidebar shows (branch, change count, whether
 * it is a repo) moves, so re-measuring would just be a call guaranteed to return the same answer.
 */
test('Staging and switching branches notify the sidebar too — push does not (#49)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'feature', current: false, remote: false },
    ]
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-git-full').click()

  await page.evaluate(() => ((window as any).__mock.gitStatusCalls = 0))
  await page.getByTestId('evidence-stage-all').click()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(1)

  await page.getByTestId('evidence-push').click()
  await expect(page.getByTestId('toast')).toContainText('Pushed')
  // Push queries nothing — it stays at the one call from above
  expect(await page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(1)

  // Entering branches goes through the sidebar's branch button (there is no tab inside the
  // overlay, 2026-09-07)
  await page.getByTestId('evidence-branch').click()
  await page.getByTestId('branch-feature').click()
  await expect(page.getByTestId('toast')).toContainText('Switched to feature')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.gitStatusCalls)).toBe(2)
})

/**
 * Three spots in the Git tab (#160).
 *
 * The moment everything was committed and the list emptied, Push disappeared along with it; the
 * panel's list only re-read when the count of files the agent touched changed, missing terminal
 * commits, Bash commits, re-editing the same file, and returning to the window; and a partially
 * staged file opened the staged diff even when clicked from Changed.
 */
test('Git tab: Push remains even when clean, the list re-reads on window return, and clicking opens the diff for the clicked group (#160)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await expect(page.getByTestId('evidence-clean')).toBeVisible()
  await expect(page.getByTestId('evidence-push')).toBeVisible()

  // Partially staged one file from outside the app — the count of files the agent touched is unchanged
  await page.evaluate(() => {
    const store = (window as any).__store.getState()
    store.setAppFocused(false)
    ;(window as any).__mock.gitState.files = [
      { path: 'a.ts', staged: true, status: 'M' },
      { path: 'a.ts', staged: false, status: 'M' },
    ]
    store.setAppFocused(true)
  })
  const changed = page.getByTestId('evidence-group-changed').getByTestId('evidence-file-a.ts')
  await expect(changed).toBeVisible()

  await changed.click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.gitDiffCalls.at(-1)))
    .toEqual({ path: 'a.ts', staged: false })
})

/**
 * Nothing in the app watches the filesystem, so work done **outside** it — a commit typed
 * into a terminal, a rebase, a `git clean` — is invisible until we come back and ask (#41).
 * Returning to the window is that moment, and it is the only signal we get for it.
 */
test('returning to the window re-reads every project (#41)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })

  await page.evaluate(() => {
    const store = (window as any).__store.getState()
    store.setAppFocused(false)
    // Someone committed in a terminal while the app was in the background
    ;(window as any).__mock.gitState.files = [
      { path: 'x.ts', staged: false, status: 'M' },
      { path: 'y.ts', staged: false, status: 'M' },
    ]
    store.setAppFocused(true)
  })

  await expect(page.getByTestId('mark-changed-alpha')).toHaveText('2')
  await expect(page.getByTestId('mark-changed-beta')).toHaveText('2')
})

/**
 * Updates: only notify, and install only when the person clicks (issue #43).
 *
 * The whole shape of this feature is in one run: a quiet line appears when the registry
 * has something newer, clicking it is the consent, and the app stops at "restart" rather
 * than replacing itself out from under the person. Driven entirely through the mock —
 * `npm i -g` is never run by a test.
 */
test('A quiet line appears when a new version exists, and installing requires a click (#43)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // With no news yet, there is no line in the dashboard — it appears only when there is something
  // to say
  await expect(page.getByTestId('update-line')).toBeHidden()

  // A new version has been published to the registry
  await page.evaluate(() => (window as any).__mock.offerUpdate('9.9.9'))
  const line = page.getByTestId('update-line')
  await expect(line).toContainText('9.9.9')

  // Clicking it is the consent — nothing happens before that
  await line.click()
  /*
   * Even once it finishes, it **does not restart on its own.** Swapping out the running app is
   * the person's call to make, and this line is where it says so.
   */
  await expect(line).toContainText('Restart')
})

/**
 * Settings gained an 'Updates' tab (issue #43 / the fourth tab #7 opened up).
 *
 * Automatic checking is **on by default** — it is read-only and swallows failures, so leaving it
 * on costs nothing, while leaving it off would strand someone who never opens settings on an old
 * version forever. This also confirms that turning it off genuinely stops asking: otherwise this
 * checkbox is decoration.
 */
test('Settings > Updates: check now and automatic checking (#43)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-updates').click()

  /*
   * States what is currently running first — without one side of the comparison visible, the
   * rest cannot be read either.
   *
   * Writing a literal version string here would turn this line red **on every release.** It
   * actually happened: the commit that bumped to 0.1.0-beta.3 broke this line, and nobody saw it
   * because what CI runs before a release is `pnpm verify` (up through unit tests only). What is
   * being confirmed is not the version number but **that a number is carried onto the screen at
   * all**, so this checks only the shape.
   */
  await expect(page.getByTestId('update-current')).toContainText(/Running \d+\.\d+\.\d+/)
  await expect(page.getByTestId('update-auto')).toBeChecked()

  await page.evaluate(() => {
    ;(window as any).__mock.registryVersion = '9.9.9'
  })
  await page.getByTestId('update-check-now').click()
  await expect(page.getByTestId('update-state')).toContainText('9.9.9')

  // With it off, it never asks the registry
  await page.getByTestId('update-auto').uncheck()
  const asked = await page.evaluate(async () => {
    const m = (window as any).__mock
    m.registryVersion = null // Asking now would come back as "unreachable"
    await (window as any).__store.getState().checkUpdate(false)
    return (window as any).__store.getState().update.latest
  })
  // An automatic call arriving with auto-check turned off went nowhere — the previously known
  // answer just stays
  expect(asked).toBe('9.9.9')
})

/**
 * Focusing the composer wakes a dormant session.
 *
 * Selecting it from the sidebar already wakes it (focusSession -> wake). But there are two paths
 * that reach the composer **without** selecting — a grid panel, and the focused session a
 * restart restores. Both stayed dormant until sending, so the few seconds of resuming ran hidden
 * behind the send button, and the slash list only answered from the disk cache (the same one
 * that kept showing a removed plugin's commands for days).
 */
test('Focusing the composer wakes a dormant session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Set up the dormant state — the focused session a restart restores is exactly this shape
  await page.evaluate((sid: string) => {
    const st = (window as any).__store
    const m = (window as any).__mock
    ;[...m.sessions.values()].find((x: any) => x.id === sid)!.live = false
    st.setState({
      sessions: { ...st.getState().sessions, [sid]: { ...st.getState().sessions[sid], live: false } },
    })
  }, id)

  // Since the helper leaves focus in the composer, this leaves and comes back once —
  // waking is wired to the focus 'event', so if it is already focused, focus() fires nothing
  await page.getByTestId('prompt-input').blur()
  await page.getByTestId('prompt-input').focus()
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid].live, id))
    .toBe(true)
  // Quietly — no "woke up" toast and no failure toast either
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

/**
 * The screen being viewed carries over a restart (the remaining half of C-3).
 *
 * The session came back, but the **way** it was viewed did not — closed from the grid, it
 * reopened in the focus view. The restore order (focusSession forces the view to focus) is
 * guarded by unit tests; this one runs through an actual reload. The mock's restart rule matches
 * #20's relaunch test: only localStorage (standing in for the snapshot) survives, and projects
 * have to be re-registered.
 */
test('Closing and restarting from the grid returns to the grid', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => (window as any).__store.getState().setGridPanels([{ kind: 'session', sessionId: sid }]), id)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // Restart — only the snapshot survives. The intro screen does not come back (introSeen also
  // lives in the snapshot)
  await page.goto('/?mock=1')
  await expect(page.getByTestId('add-project')).toBeVisible()
  await expect(page.getByTestId('intro')).toHaveCount(0)
  await page.evaluate((p: string) => {
    ;(window as any).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()

  // The moment the project comes back, the screen must be **the grid**, not the focus view
  await expect(page.getByTestId('grid')).toBeVisible()
})

/**
 * The session tree (#69): worktree sessions are drawn nested under a manager.
 *
 * The hierarchy lives only in the sidebar — the manager is an ordinary session with children,
 * and creating a worktree session adds a manager row even to a project that had none (only a
 * row, no process).
 */
test('Worktree sessions sit nested under the manager in the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // A manager row was created, and the worktree session is drawn nested under it
  const manager = page.getByText('Worktree manager', { exact: true })
  await expect(manager).toBeVisible()
  const nested = page.locator('li[data-nested]')
  await expect(nested).toHaveCount(1)

  // It lives in the manager row's ⋯ menu — clicking it opens a new session dialog with the
  // worktree already on
  const mgrRow = page.locator('li', { has: manager })
  await mgrRow.locator('[data-testid^="session-menu-"]').click()
  await mgrRow.locator('[data-testid^="new-worktree-session-"]').click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await expect(page.getByTestId('worktree-toggle').locator('input')).toBeChecked()

  // Creating one more through that dialog places it under the same manager — one manager per
  // project is enough
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('li[data-nested]')).toHaveCount(2)
  await expect(page.getByText('Worktree manager', { exact: true })).toHaveCount(1)
})

/**
 * Creating the manager **first** (#76).
 *
 * What is checked here is the order: the slot gets created with zero children, and a worktree
 * created afterward goes into that slot. And once the slot exists, the "create manager" button
 * disappears — there must never be two doors doing the same thing.
 */
test('Creating the worktree manager first places later worktrees under it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('start-worktree-manager-alpha').click()
  // The trunk field is filled with the current branch — the guess is put in front of the person
  // for confirmation
  await expect(page.getByTestId('worktree-trunk-input')).toHaveValue('main')
  await page.getByTestId('worktree-manager-confirm').click()
  await expect(page.getByTestId('worktree-manager-dialog')).toBeHidden()

  /*
    The slot exists — with zero children. And the moment it is created, it opens right up: the
    reason to create it is to talk to the thing just created, so merely adding a row to the list
    and stopping there is only half the job.
  */
  // Scope the count to the sidebar — with the manager open, the same name also appears in the
  // conversation header
  const sidebar = page.getByTestId('sidebar')
  await expect(sidebar.getByText('Worktree manager', { exact: true })).toHaveCount(1)
  await expect(page.getByTestId('session-name')).toHaveText('Worktree manager')
  await expect(page.locator('li[data-nested]')).toHaveCount(0)
  // Now that the slot exists, the "create" door closes — that row is gone even with the menu open
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('start-worktree-manager-alpha')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // The worktree created now goes under the slot that already exists — no second manager is created
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('li[data-nested]')).toHaveCount(1)
  await expect(sidebar.getByText('Worktree manager', { exact: true })).toHaveCount(1)
})

test('Opening via the project header + still leaves the worktree off — only the manager row + pre-warms it', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // First open once via the manager row's + and close it — the pre-warmed state must not leak
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  const manager = page.getByText('Worktree manager', { exact: true })
  await page.locator('li', { has: manager }).locator('[data-testid^="session-menu-"]').click()
  await page.locator('li', { has: manager }).locator('[data-testid^="new-worktree-session-"]').click()
  await page.keyboard.press('Escape')

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-toggle').locator('input')).not.toBeChecked()
})

test('Naming the worktree branch becomes the session name', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  // The branch field does not exist before the worktree is turned on — details of an off option
  // are never expanded ahead of time
  await expect(page.getByTestId('worktree-branch-input')).toHaveCount(0)
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/login-fix')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // Session name = branch name — that name appears on the nested row in the sidebar
  await expect(page.locator('li[data-nested]').getByText('feat/login-fix')).toBeVisible()
})

/**
 * Where it branches from (pointed out by the person, 2026-09-07: "when creating a worker there
 * is no way to say which branch to base it on").
 *
 * It used to be a fact nowhere on screen — the host quietly branched from the trunk (or HEAD if
 * there was none). Now that default is written in a field, and it can be changed.
 */
test('Turning on the worktree shows where it branches from, and it can be changed before sending', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'release', current: false, remote: false },
    ]
  })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  // Details of an off option are never expanded ahead of time — the same rule as the branch field
  await expect(page.getByTestId('worktree-base-input')).toHaveCount(0)
  await page.getByTestId('worktree-toggle').locator('input').check()

  // The default is exactly what used to happen quietly (the project's current branch)
  await expect(page.getByTestId('worktree-base-input')).toHaveValue('main')

  await page.getByTestId('worktree-base-input').fill('release')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // The choice actually reached the host — a field that exists only on screen would mean nothing
  // was actually changed
  await expect
    .poll(async () =>
      page.evaluate(() => (window as never as { __mock: any }).__mock.lastCreateParams?.worktreeBase),
    )
    .toBe('release')
})

/**
 * The manager's worktree proposal (#69) — the third case of propose-not-power.
 * A proposal line stays in the conversation, the + button lights up, and opening it comes with
 * the branch name already filled in. Creating it remains, to the end, the person's own act.
 */
test('Worktree proposal: a line stays in the conversation, + lights up, and the dialog comes pre-filled with the name', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // Create a manager and a child (the manager session is picked by name, not by list index 0)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // Open the manager session and simulate the manager proposing — the branch name arrives in the
  // title
  await page.getByText('Worktree manager', { exact: true }).click()
  await page.evaluate(() => {
    const m = (window as any).__mock
    const manager = [...m.sessions.values()].find((s: any) => s.name === 'Worktree manager')
    m.emit({
      type: 'tool_call',
      sessionId: manager.id,
      callId: 'c-prop',
      summary: {
        tool: 'mcp__centralu__propose_worktree_session',
        title: 'feat/proposed-work',
        readOnly: false,
        paths: [],
      },
    })
  })

  // The proposal line in the conversation — one line that points, not a tool card
  await expect(page.getByTestId('worktree-proposal')).toContainText('feat/proposed-work')
  // This project's + button lights up
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(1)

  // Opening that door: worktree turned on + branch name filled in
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-toggle').locator('input')).toBeChecked()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/proposed-work')

  // The proposal is consumed the moment it is opened — closing and reopening gives an ordinary
  // empty dialog
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(0)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-toggle').locator('input')).not.toBeChecked()
})

/**
 * Worktree provisioning (#69) — expanded input fields on first use, a collapsed summary after
 * saving. The setup is persisted before creation (since the host reads and runs it during
 * creation).
 */
test('Worktree setup: input fields at first, collapsing into a summary once saved', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  // With no saved setup, the input fields stay expanded
  await expect(page.getByTestId('worktree-setup-edit')).toBeVisible()
  await page.getByTestId('worktree-setup-command').fill('pnpm install')
  await page.getByTestId('worktree-copy-files').fill('.env.local, .env')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // It was saved — this also checks whether the mock normalized it the same way the real thing does
  const saved = await page.evaluate(() => {
    const m = (window as any).__mock
    return m.projectsList?.[0]?.worktreeSetup ?? [...(m.projectsList ?? [])][0]?.worktreeSetup
  })
  expect(saved).toEqual({ command: 'pnpm install', copyFiles: ['.env.local', '.env'] })

  // Opening it next time shows one collapsed summary line — clicking it allows editing again
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await expect(page.getByTestId('worktree-setup-summary')).toContainText('setup: pnpm install')
  await expect(page.getByTestId('worktree-setup-summary')).toContainText('copies: .env.local, .env')
  await page.getByTestId('worktree-setup-summary').click()
  await expect(page.getByTestId('worktree-setup-command')).toHaveValue('pnpm install')
})

/**
 * Copy candidates (#76) — the app only **points them out.**
 *
 * The reason "copy everything ignored" is never the default is right there on this screen:
 * node_modules at 637MB sits in the list with its size shown, and whether to click it is for the
 * person to decide.
 */
test('Worktree setup: gitignored candidates are pointed out, and clicking adds or removes them', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.gitState.ignored = [
      { path: 'node_modules/', bytes: 668213248 },
      { path: '.env.local', bytes: 24 },
      { path: 'weird/', bytes: null },
    ]
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()

  // The size shows alongside — the judgment a person makes from this list is "this is too big"
  await expect(page.getByTestId('ignored-node_modules/')).toContainText('637MB')
  // Something whose size could not be measured still appears in the list (the size is only a hint)
  await expect(page.getByTestId('ignored-weird/')).toBeVisible()

  await page.getByTestId('ignored-.env.local').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('.env.local')
  await page.getByTestId('ignored-node_modules/').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('.env.local, node_modules/')
  // Clicking it again removes it — the field remains the source of truth, so it never diverges
  // from what was typed by hand
  await page.getByTestId('ignored-.env.local').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('node_modules/')

  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  const saved = await page.evaluate(() => (window as any).__mock.projectsList[0].worktreeSetup)
  expect(saved).toEqual({ command: '', copyFiles: ['node_modules/'] })
})

/** The merged badge (#69) — reporting the fact becomes a badge, and cleanup is left to the person via the delete dialog */
test('Merging a branch shows a merged badge on the sidebar row', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/badge')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(0)

  // The host's own detection emits this event — merging from the terminal follows the same path
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({ type: 'worktree_merged', sessionId: child.id })
  })

  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(1)
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveText('merged')
})

/** The PR chip (#76 stage 3) — the PR state measured by gh becomes a chip, and it yields its spot to the merged badge once merged */
test('Opening a PR shows a PR chip, and merging replaces it with the merged badge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/pr-chip')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveCount(0)

  // The host's gh measurement emits this event — the signal that covers the blind spot of a
  // squash merge
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({
      type: 'worktree_pr',
      sessionId: child.id,
      pr: { number: 12, state: 'open', url: 'https://github.com/x/y/pull/12' },
    })
  })
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveText('PR #12')

  // Once merged, the outcome is stated only once — the merged badge appears and the PR chip steps
  // aside
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({ type: 'worktree_merged', sessionId: child.id })
  })
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(1)
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveCount(0)
})

/** #75: a message carrying an attachment renders only once — since text stays exactly as sent, confirmation matches up cleanly */
test('A message sent with an attachment renders only once', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first greeting')

  // Send with an attachment — the mock echoes back a user_message with just the raw text, the
  // same as the real host
  await page.evaluate(async () => {
    const store = (window as any).__store.getState()
    const sid = Object.keys(store.sessions).find((id: string) => store.sessions[id].name !== 'Orchestrator')
    await store.send(sid, 'take a look at this image', [
      { kind: 'image', path: '/tmp/att/shot.png', name: 'shot.png', mime: 'image/png', bytes: 10 },
    ])
  })

  const bubbles = page.getByText('take a look at this image')
  await expect(bubbles).toHaveCount(1)
  // An attachment with no bytes lies flat as a name chip — what was sent remains visible
  await expect(page.getByTestId('msg-user-attachment')).toContainText('shot.png')
})

/** An image attachment shows as a real thumbnail, and clicking opens the same zoom as an agent image */
test('A sent image shows as itself in the bubble and zooms on click', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // An actual 1x1 PNG — fake bytes would break the <img> and fall through to the flat-chip path
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  await page.getByTestId('attach-input').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1PX, 'base64'),
  })
  // The composer already shows it as a thumbnail (#284)
  await expect(page.getByTestId('attachment-thumb').locator('img')).toHaveAttribute('alt', 'pixel.png')
  await page.getByTestId('prompt-input').fill('take a look at this')
  await page.getByTestId('send').click()

  const thumb = page.getByTestId('msg-user-attachment')
  await expect(thumb.locator('img')).toBeVisible()
  await thumb.locator('img').click()
  await expect(page.getByTestId('image-lightbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('image-lightbox')).toHaveCount(0)

  // The thumbnail comes back even reloaded from the store — the rule that the host reloads bytes
  // from the file (the same path as a restart)
  await page.evaluate(async () => {
    const store = (window as any).__store.getState()
    await store.loadHistory(store.focusedSessionId)
  })
  await expect(page.getByTestId('msg-user-attachment').locator('img')).toBeVisible()
})

/** #69 dogfooding finding 3: proposals are a queue — receiving two, opening + twice consumes both */
test('Two worktree proposals fill in order across two dialog openings', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await page.evaluate(() => {
    const m = (window as any).__mock
    const manager = [...m.sessions.values()].find((s: any) => s.name === 'Worktree manager')
    for (const branch of ['feat/first', 'feat/second']) {
      m.emit({
        type: 'tool_call',
        sessionId: manager.id,
        callId: 'c-' + branch,
        summary: {
          tool: 'mcp__centralu__propose_worktree_session',
          title: branch,
          readOnly: false,
          paths: [],
        },
      })
    }
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/first')
  await page.keyboard.press('Escape')
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/second')
  await page.keyboard.press('Escape')
  // The queue is empty — the glow turns off, and the next dialog is an ordinary one
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(0)
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
  // The warning uses the delete palette (dogfooding: dangerous spots are red) — the same color as
  // a diff's deletion
  await expect(page.getByTestId('delete-project-warning')).toHaveCSS('background-color', 'rgb(43, 21, 23)')
  await expect(confirm).toHaveCSS('color', 'rgb(255, 161, 152)')

  // 4. Delete it — both the project and its sessions disappear, and the folder went to the trash
  await confirm.click()
  await expect(page.getByTestId('delete-project-dialog')).toBeHidden()
  await expect(page.getByTestId('project-alpha')).toHaveCount(0)
  await expect(page.getByTestId('sidebar').getByTestId(/^session-row-/)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual(['.'])
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
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual([])
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
 * The notice card uses the same door (focusSession), so this pins that down too — if there is
 * one cause, there should be only one symptom, and that claim is only proven by clicking through
 * both entrances.
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
    ;(window as any).__mock.emit({ type: 'state_change', sessionId: id, state: 'waiting_input' })
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
    The second door: the card that reports a reply has finished (asked about together during
    dogfooding). Since it calls the same focusSession, there is one cause, but "there was one
    cause" only becomes fact by clicking through both entrances.
  */
  // Switch back over to the session screen — the card only appears for a session not being watched
  await page.locator('[data-testid^="session-row-"]').first().click()
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
  await page.evaluate((id: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'state_change', sessionId: id, state: 'working' })
    m.emit({ type: 'turn_complete', sessionId: id })
  }, orc)
  await page.getByTestId('notice-open').click()
  await expect(page.getByTestId('evidence-panel')).toHaveCount(0)
  await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('aria-pressed', 'true')
})

/*
 * The control rail (#80/#81) — the person's workbench. Turns awaiting me line up as rows, a
 * one-line reply is settled right in the row, machine notifications (control_notify) plug in,
 * and the toggle turns it off without a trace.
 */
test('Control rail: inline replies for my turn, notifications, and the toggle all work from the orchestrator screen', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'rail test')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  // End the turn to put the session into "my turn" — end only after confirming working (to avoid
  // reversing event order)
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid]?.state, id))
    .toBe('working')
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'turn_complete', sessionId: sid })
    m.emit({ type: 'state_change', sessionId: sid, state: 'waiting_input' })
  }, id)

  await page.getByTestId('orchestrator-button').click()
  await expect(page.getByTestId('control-rail')).toBeVisible()

  // A row appears for my turn, and an inline reply in that row reaches the session — turning the
  // gears without ever opening the session
  await expect(page.getByTestId(`rail-turn-${id}`)).toBeVisible()
  await page.getByTestId(`rail-input-${id}`).fill('keep going')
  await page.getByTestId(`rail-input-${id}`).press('Enter')
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid]?.state, id))
    .toBe('working')

  // In a running row, **the words are the source of truth, the tool is secondary** — letting a
  // tool title bury the narrative loses the context
  await page.evaluate((sid: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: 'Fixing the sorting issue' })
    m.emit({
      type: 'tool_call',
      sessionId: sid,
      callId: 'c9',
      summary: { tool: 'Bash', title: 'pnpm verify', readOnly: false, paths: [] },
    })
  }, id)
  await expect(page.getByTestId(`rail-running-${id}`)).toContainText('Fixing the sorting issue')
  await expect(page.getByTestId(`rail-running-${id}`)).toContainText('Bash: pnpm verify')

  // An inline reply is recorded as a measured count — "is this still being used" is a number, not
  // a feeling
  await expect
    .poll(() =>
      page.evaluate(
        () => ((window as any).__store.getState().apps['control']?.doc?.metrics ?? {}).inlineReplies ?? 0,
      ),
    )
    .toBeGreaterThan(0)

  // A machine notification — the person reads it and dismisses it
  await page.evaluate(() => {
    void (window as any).__store.getState().setAppDoc('control', {
      notifies: [{ id: 'n1', text: 'Session 3 is blocked on an external condition', priority: 'high', ts: 1 }],
    })
  })
  await expect(page.getByTestId('rail-notify-n1')).toContainText('blocked')
  await page.getByTestId('rail-notify-dismiss-n1').click()
  await expect(page.getByTestId('rail-notify-n1')).toHaveCount(0)

  // Resizing — drag the left edge, double-click resets to the default width. Since this is a way
  // of viewing, it persists in the workspace
  const railBox = async () => (await page.getByTestId('app-rails').boundingBox())!
  const before = (await railBox()).width
  const handle = (await page.getByTestId('rail-resize').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + 100)
  await page.mouse.up()
  expect((await railBox()).width).toBeGreaterThan(before + 60)
  await page.getByTestId('rail-resize').dblclick()
  expect(Math.abs((await railBox()).width - before)).toBeLessThan(4)

  // Toggling off = the rail withdraws without a trace (it is not deleted)
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-apps').click()
  // The watch-declaration editor (#80 checkpoint v1) — the pattern persists in the document
  // (judging it is the host's observation hook's job)
  await page.getByTestId('watch-pattern').fill('git commit')
  await page.getByTestId('watch-add').click()
  await expect
    .poll(() =>
      page.evaluate(() => ((window as any).__store.getState().apps['control']?.doc?.watches ?? []).length),
    )
    .toBe(1)
  await page.locator('[data-testid^="watch-remove-"]').click()
  await expect
    .poll(() =>
      page.evaluate(() => ((window as any).__store.getState().apps['control']?.doc?.watches ?? []).length),
    )
    .toBe(0)

  await page.getByTestId('app-toggle-control').locator('input').uncheck()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('control-rail')).toHaveCount(0)
})

/*
 * Creating a task (#80 purpose 2): picking members creates a coordinator, reachable from both
 * the sidebar and the rail. The core creation logic lives in the host's app tool (covered by
 * unit tests) — this checks the wiring of the human path.
 */
test('Creating a task: rail dialog -> coordinator session -> appears in the sidebar and the rail', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session that will become a member')
  const workerId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('rail-new-task').click()
  await page.getByTestId('task-title').fill('Implement the skill')
  await page.getByTestId('task-goal').fill('See skill X all the way through')
  await page.getByTestId(`task-member-${workerId}`).check()
  await page.getByTestId('task-create').click()
  await expect(page.getByTestId('new-task-dialog')).toBeHidden()

  // It went through the same door (control_create_task) — the human path is also just one host tool
  const invoke = await page.evaluate(() => (window as any).__mock.lastInvoke)
  expect(invoke.name).toBe('control_create_task')
  expect(invoke.args.memberSessionIds).toEqual([workerId])

  /*
   * The coordinator appears **only in its own app's row** (requested by the person, 2026-09-09).
   * It used to also show up in the sidebar as the same thing under a different-looking row, so
   * both grew longer together as tasks piled up.
   */
  await expect(page.getByTestId('rail-tasks')).toContainText('Implement the skill')
  await expect(page.locator('[data-testid^="homeless-row-"]')).toHaveCount(0)

  // Members appear by name (2026-09-06) — a bare count did not say which sessions the task
  // belonged to
  await expect(page.getByTestId('rail-tasks')).toContainText('session that will become a member')
  // Clicking the chip navigates to that session
  await page.locator(`[data-testid^="rail-task-member-"][data-testid$="-${workerId}"]`).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId))
    .toBe(workerId)
  // The coordinator does not appear in the rail's "my turn"/"running" rows — the meta layer
  // belongs to the Tasks section
  await expect(page.locator('[data-testid^="rail-turn-coord"]')).toHaveCount(0)
})

/**
 * The model list is **a tool's own vocabulary** (dogfooding, 2026-09-09: "this is a claude
 * session, but codex models are showing").
 *
 * Even briefly leaving another tool's list in place offers something the screen cannot actually
 * pick — 'sonnet' and 'gpt-5.6-terra' are not two names for the same slot, they are words absent
 * from each other's dictionary. While the new list is loading, being **empty** is correct.
 */
test("Switching sessions does not leave the previous tool's model list behind", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'claude session')
  const claudeId = await page.evaluate(
    () => (window as never as { __store: any }).__store.getState().focusedSessionId,
  )

  // Create a codex session and open its menu to populate the list
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu').getByTestId('settings-model-gpt-5.6-terra')).toBeVisible()
  await page.keyboard.press('Escape')

  /*
   * Hold the list **until the test releases it.** Creating a window using a delay lets that
   * window get swallowed by some other wait (a name changing), turning this into a test that
   * passes whether or not the fix exists — that actually happened at first. Holding it and
   * releasing it lets the test decide exactly when that window is.
   */
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __releaseModels?: () => void }
    const real = w.__mock.agents.models.bind(w.__mock.agents)
    w.__mock.agents.models = async (tool: string) => {
      await new Promise<void>((r) => {
        w.__releaseModels = r
      })
      return real(tool)
    }
  })

  await page.evaluate(
    (id: string) => (window as never as { __store: any }).__store.getState().focusSession(id),
    claudeId,
  )
  // Open only after the screen has switched to that session — otherwise this would still be
  // opening the codex session's menu
  await expect(page.getByTestId('session-name')).toHaveText('claude session')
  await page.getByTestId('settings-open').click()
  const menu = page.getByTestId('settings-menu')
  await expect(menu.getByTestId('settings-model-gpt-5.6-terra')).toHaveCount(0)

  // Once released, this tool's own list appears
  await page.evaluate(() => (window as never as { __releaseModels?: () => void }).__releaseModels?.())
  await expect(menu.getByTestId('settings-model-haiku')).toBeVisible()
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

/**
 * Turning off an app hands its sessions over to the sidebar (requested by the person,
 * 2026-09-09).
 *
 * There is one rule: the app that gave it meaning is its home, and with no home, the sidebar
 * takes it in. Without this, a single toggle would wipe a session off the screen entirely —
 * there would be no way left to talk to it.
 */
test('Turning off the control app moves the coordinator session down to the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'session that will become a member')
  const workerId = await page.evaluate(
    () => [...(window as never as { __mock: any }).__mock.sessions.keys()][0],
  )

  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('rail-new-task').click()
  await page.getByTestId('task-title').fill('Implement the skill')
  await page.getByTestId('task-goal').fill('See skill X all the way through')
  await page.getByTestId(`task-member-${workerId}`).check()
  await page.getByTestId('task-create').click()
  await expect(page.getByTestId('new-task-dialog')).toBeHidden()
  // While the app is on, it lives only in the app's own row
  await expect(page.locator('[data-testid^="homeless-row-"]')).toHaveCount(0)

  await page.evaluate(() =>
    (window as never as { __store: any }).__store.getState().setAppEnabled('control', false),
  )

  // With its home gone, the sidebar takes it in — it must be findable and openable by name
  await expect(page.getByTestId('homeless-sessions')).toContainText('Implement the skill')
  await page.locator('[data-testid^="homeless-row-"]').first().click()
  await expect(page.getByTestId('session-view')).toBeVisible()
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

  await page.getByTestId('orchestrator-button').click()
  await page.getByTestId('rail-new-task').click()
  await page.getByTestId('task-title').fill('Implement the skill')
  await page.getByTestId('task-goal').fill('See skill X all the way through')
  await page.getByTestId(`task-member-${workerId}`).check()
  await page.getByTestId('task-create').click()

  // Open the coordinator (the task row is the coordinator) — with no project on that session, the
  // evidence lane itself must not exist
  await page.locator('[data-testid^="rail-task-open-"]').first().click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  await expect(page.getByTestId('evidence-panel')).toHaveCount(0)
  await expect(page.getByTestId('evidence-rail-shell')).toHaveCount(0)

  // Returning to the worker (alpha) brings the evidence back — it was not removed, only the
  // fallback was
  await page.evaluate((id: string) => (window as any).__store.getState().focusSession(id), workerId)
  await expect(page.getByTestId('evidence-panel')).toBeVisible()
})

/**
 * A spinning panel's rotating border is **the panel's own border** — it must never cover
 * anything outside the panel.
 *
 * The ring sits at z-30, a value raised because the collapsed composer (z-20) inside the panel
 * once covered its bottom edge. But if the panel does not establish its own stacking context,
 * that 30 is still 30 outside the panel too, and a rainbow line got drawn over the files/git
 * screen (z-20) (pointed out by the person).
 *
 * Rather than comparing numbers, this checks **what actually sits on top of that pixel**. A z
 * value means something different in every stacking context, so the bare fact that 30 > 20 says
 * nothing about what is actually visible.
 */
test("A spinning panel's border does not leak over the files/git screen", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)

  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.getState().setGridPanels([{ kind: 'session', sessionId: sid }])
    store.setState((s: any) => ({
      sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], state: 'working' } },
    }))
  }, id)
  await page.getByTestId('grid-button').click()
  await expect(page.locator('.cc-orbit-ring-layer')).toBeVisible()

  await page.evaluate(() => (window as any).__store.getState().openGit())
  await expect(page.getByTestId('overlay')).toBeVisible()

  const topAtRing = await page.evaluate(() => {
    const ring = document.querySelector('.cc-orbit-ring-layer') as HTMLElement | null
    if (!ring) return { found: false, inOverlay: false }
    /*
     * The ring lets clicks pass through it (pointer-events: none), so it is normally invisible to
     * a hit-test. Asking directly would measure "does a click land" instead of "is it covered",
     * and that passes even while the ring is spilling over the screen. This turns pointer events
     * on only while measuring, to ask about **paint order** instead.
     */
    const before = ring.style.pointerEvents
    ring.style.pointerEvents = 'auto'
    const r = ring.getBoundingClientRect()
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 1))
    ring.style.pointerEvents = before
    return { found: true, inOverlay: !!el?.closest('[data-testid="overlay"]') }
  })
  expect(topAtRing.found).toBe(true)
  expect(topAtRing.inOverlay).toBe(true)
})

/**
 * A long error sentence does not create horizontal scroll in the conversation (#107 follow-up).
 *
 * The divider label was built to hold short text like "conversation compacted here", and
 * `shrink-0` was the right value for that. Once failed turns started landing on screen, long
 * sentences like a token expiring landed in the same spot, and that line pushed the panel wide
 * enough to shift the whole conversation sideways (a dogfooding finding). A sentence put up for
 * the person to read is pointless if it sits off screen.
 *
 * What is measured is not the class name but **the width**. Only that answers whether scroll
 * actually appeared.
 */
test('A long error sentence does not push the conversation sideways', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  const long =
    'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'
  await page.evaluate(
    ([sid, message]: [string, string]) => {
      const m = (window as any).__mock
      m.emit({ type: 'error', sessionId: sid, error: { code: 'internal', message, retryable: false } })
    },
    [id, long] as [string, string],
  )

  const mark = page.getByTestId('msg-mark').last()
  await expect(mark).toContainText('refresh token was revoked')

  const overflow = await page.getByTestId('chat-stream').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
})

/**
 * While a question is open, whatever is typed into the composer becomes **the answer to that
 * question** (#125).
 *
 * A real incident, 2026-09-23: with the card still open, typing "can you ask that again?" made
 * the question disappear for no stated reason and broke the turn with error_during_execution. The
 * stored tool_result still held the exact phrase Claude Code emits when a tool use is refused.
 * Instead of blocking input, this accepts it as meaning the same thing as the card's own "Other —
 * write your own".
 */
test('While a question is open, text typed into the composer becomes its answer (#125)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })
  await expect(page.getByTestId('question-card')).toBeVisible()

  // States what will happen before it is submitted
  await expect(page.getByTestId('prompt-input')).toHaveAttribute('placeholder', /answer to the question/i)

  await page.getByTestId('prompt-input').fill('can you ask that again?')
  await page.getByTestId('prompt-input').press('Enter')

  // The mock echoes the received answer back exactly — if it were refused, this line would not exist
  await expect(page.getByTestId('chat-stream')).toContainText('Answer received: can you ask that again?')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
})

/**
 * The rest of #125 (#174): when text cannot be the answer (multiple questions, or an attachment
 * present), the composer says so before it is sent, and if sending drops the question anyway, a
 * line stays in the conversation. While the hint never checked attachments, attaching a file
 * under a "write your answer" hint sent the text as a new turn and silently dropped the question.
 */
test('The composer states first that text cannot answer once any file is attached to a question (#174)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })
  await expect(page.getByTestId('prompt-input')).toHaveAttribute('placeholder', /answer to the question/i)

  // Attaching a file makes it unable to answer — the hint changes immediately
  await page
    .getByTestId('attach-input')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
  await expect(page.getByTestId('attachment-list')).toContainText('notes.txt')
  await expect(page.getByTestId('prompt-input')).toHaveAttribute('placeholder', /drops the question card/i)
})

test('With multiple questions, sent text becomes a new turn, and a line records what was dropped (#174)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q2', questions: QUESTIONS })
  await expect(page.getByTestId('prompt-input')).toHaveAttribute('placeholder', /drops the question card/i)

  await page.getByTestId('prompt-input').fill('just handle it')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('chat-stream')).toContainText('Questions dropped')
  await expect(page.getByTestId('chat-stream')).toContainText('"What should we have for lunch?", "What about something to drink?"')
})

test('A session with an open question cannot be asked for a handoff note, but record mode still works (#174)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q3', questions: [QUESTIONS[0]] })
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)

  await page.getByTestId(`session-menu-${id}`).click()
  await page.getByTestId(`handoff-session-${id}`).click()
  await expect(page.getByTestId('handoff-blocked')).toContainText('waiting on a question')
  await expect(page.getByTestId('confirm-handoff-yes')).toBeDisabled()
  await page.getByTestId('handoff-mode-record').click()
  await expect(page.getByTestId('handoff-blocked')).toHaveCount(0)
  await expect(page.getByTestId('confirm-handoff-yes')).toBeEnabled()
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
  await page.waitForTimeout(200)
  await expect(page.getByTestId('orchestrator-empty')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__store.getState().orchestratorId)).toBeNull()
})

test('If the worktree manager cannot be created, the dialog stays open and states why (#180)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.projects.createWorktreeManager = async () => {
      throw new Error('not a git repository')
    }
  })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('start-worktree-manager-alpha').click()
  await page.getByTestId('worktree-manager-confirm').click()
  await expect(page.getByTestId('worktree-manager-dialog')).toContainText('not a git repository')
  await expect(page.getByTestId('worktree-trunk-input')).toHaveValue('main')
})

test('Nothing sends while an attachment is uploading, and it goes out with the text once it finishes (#180)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.evaluate(() => {
    const w = window as any
    const save = w.__mock.agents.saveAttachment
    w.__release = null
    w.__mock.agents.saveAttachment = async (...a: unknown[]) => {
      await new Promise<void>((r) => (w.__release = r))
      return save(...a)
    }
  })
  await page
    .getByTestId('attach-input')
    .setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('png') })
  // Keep the picked file pending and clear the field — picking the same file again still fires a
  // change event
  await expect(page.getByTestId('attach-input')).toHaveValue('')
  await expect(page.getByTestId('attachment-uploading')).toBeVisible()

  await page.getByTestId('prompt-input').fill('take a look at this')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('send')).toBeDisabled()
  await expect(page.getByTestId('prompt-input')).toHaveValue('take a look at this')
  expect(await page.evaluate(() => (window as any).__mock.sentAttachments.length)).toBe(0)

  await page.evaluate(() => (window as any).__release())
  await expect(page.getByTestId('attachment-list')).toContainText('shot.png')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('msg-user').last()).toContainText('shot.png')
  expect(
    await page.evaluate(() => (window as any).__mock.sentAttachments.map((a: { name: string }) => a.name)),
  ).toEqual(['shot.png'])
})
