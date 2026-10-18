import { expect, type Page } from '@playwright/test'
import type { Recorder } from './recorder.js'
import { seedSshConfig } from '../fixtures/ssh-hosts.js'
import { uxPending, uxTask } from './task.js'

/**
 * The core tasks (#518): what a person does with Centralu most. Each has a **discoverable** path,
 * everything it needs on screen, and where one exists a **shortcut** path, the expert's (klm.ts
 * `Access`; owner, 2026-10-12: a shortcut is known only to people who already know it, so a task is
 * judged by its discoverable path). They start in the `?demo` scene
 * (packages/platform/src/mock/demo.ts): two projects, four sessions, one waiting for approval, one
 * long conversation, and the "Finish the collapsed composer" session open.
 *
 * Only discoverable paths carry budgets. They are the baseline's numbers (docs/ux-metrics.md,
 * "Baseline"), lowered with each change that makes a task cheaper so the gain is kept (#528: the
 * composer and the typed Add machine form take the keyboard; #529: the open project's +, the Search
 * button): the operator counts exactly, the KLM time with 2% and 0.05 s of headroom, rounded up to a
 * tenth, because the pointing times follow the boxes on screen and fonts differ a little between
 * machines. A change that makes a task cost more fails here; raising a budget is a decision the pull
 * request states.
 */

const OPEN = 'Finish the collapsed composer'
const APPROVING = 'Clean up leftover processes'
const DONE = 'Optimize images'

async function demo(page: Page): Promise<void> {
  await page.goto('/?demo')
  await expect(page.getByTestId('project-centralu')).toBeVisible()
  await expect(page.getByTestId('session-name')).toHaveText(OPEN)
}

async function sessionId(page: Page, name: string): Promise<string> {
  const id = await page.evaluate(
    (n) => (Object.values((window as any).__store.getState().sessions) as { id: string; name: string }[]).find((s) => s.name === n)?.id,
    name,
  )
  if (!id) throw new Error(`no session named ${name}`)
  return id
}

/** Opens a session the way the start state needs it, not counted */
async function open(page: Page, name: string): Promise<void> {
  const id = await sessionId(page, name)
  await page.evaluate((i) => (window as any).__store.getState().focusSession(i), id)
  await expect(page.getByTestId('session-name')).toHaveText(name)
}

/** Clicks a session's row in the sidebar, labelled by the session's name rather than its id */
const clickRow = async (u: Recorder, page: Page, name: string) =>
  u.click(page.getByTestId(`session-row-${await sessionId(page, name)}`), { label: `session row "${name}"` })

/** The last thing the person said in the open session */
const lastSaid = (page: Page) => page.getByTestId('msg-user').last()

// ---------------------------------------------------------------------------------------------
// Start a new session

const startedThere = async (page: Page) => {
  await expect(page.getByTestId('session-name')).toHaveText('Fix the login bug')
  await expect(lastSaid(page)).toContainText('Fix the login bug')
}

uxTask({
  id: 'new-session.mouse',
  task: 'Start a new session in a project and give it its first instruction',
  path: 'mouse',
  access: 'discoverable',
  notes: [
    "The project menu's New session starts a session at once with the project's tool, model and effort (#543); the + on the project row is gone (owner, 2026-10-18: it moved the row's marks on hover)",
  ],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('project-menu-centralu'))
    await u.click(page.getByTestId('new-session-centralu'))
    await u.until('the new session', () => expect(page.getByTestId('prompt-input')).toBeFocused())
    await u.fill(page.getByTestId('prompt-input'), 'Fix the login bug')
    await u.press('Enter')
  },
  goal: startedThere,
  budget: { operators: 26, M: 2, H: 2, seconds: 10.6 },
})

uxTask({
  id: 'new-session.palette',
  task: 'Start a new session in a project and give it its first instruction',
  path: 'keyboard',
  access: 'shortcut',
  notes: ["⌘K / Ctrl+K, then the palette's New session (#529): it starts one in the project the person is in"],
  start: demo,
  run: async (u, page) => {
    await u.press('ControlOrMeta+k')
    await u.until('the palette', () => expect(page.getByTestId('palette-input')).toBeFocused())
    await u.type('new s', { string: 'constant' })
    await u.press('Enter', { among: page.locator('[data-testid^="palette-item-"]') })
    await u.until('the new-session dialog', () => expect(page.getByTestId('create-session-confirm')).toBeFocused())
    await u.press('Enter')
    await u.until('the new session', () => expect(page.getByTestId('new-session-dialog')).toBeHidden())
    await u.fill(page.getByTestId('prompt-input'), 'Fix the login bug')
    await u.press('Enter')
  },
  goal: startedThere,
})

// ---------------------------------------------------------------------------------------------
// Answer an approval waiting in another session

uxTask({
  id: 'approve.keyboard',
  task: 'Answer an approval waiting in another session',
  path: 'keyboard',
  access: 'shortcut',
  start: demo,
  run: async (u, page) => {
    await u.press('ControlOrMeta+Shift+a')
    await u.until('the approval card', () => expect(page.getByTestId('approval-card')).toBeVisible())
    await u.press('y')
  },
  goal: async (page) => {
    await expect(page.getByTestId('session-name')).toHaveText(APPROVING)
    await expect(page.getByTestId('approval-card')).toBeHidden()
  },
})

/**
 * The approval was allowed, by the request id the demo raised, and the session on screen is still the one the person
 * was in: answering from a row (#543) does not open the session
 */
const allowedInPlace = async (page: Page) => {
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers.map((a: { requestId: string; decision: string }) => `${a.requestId}:${a.decision}`)))
    .toEqual(['demo-approval:allow'])
  await expect(page.getByTestId('session-name')).toHaveText(OPEN)
}

uxTask({
  id: 'approve.mouse',
  task: 'Answer an approval waiting in another session',
  path: 'mouse',
  access: 'discoverable',
  notes: ["Allow on the session's sidebar row, under the command it asks to run (#543)"],
  start: demo,
  run: async (u, page) => {
    const id = await sessionId(page, APPROVING)
    await u.click(page.getByTestId(`sidebar-approve-allow-${id}`), { label: `Allow on the sidebar row "${APPROVING}"` })
  },
  goal: allowedInPlace,
  budget: { operators: 5, M: 1, H: 1, seconds: 3.3 },
})

uxTask({
  id: 'approve.mouse-inbox',
  task: 'Answer an approval waiting in another session',
  path: 'mouse',
  access: 'discoverable',
  notes: [
    'Through the waiting list (the top-bar count), the way the app points to it when the session is not in sight',
    "Allow on the row, under the command it asks to run (#543): the session is not opened",
  ],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('counter'))
    await u.until('the waiting list', () => expect(page.getByTestId('inbox')).toBeVisible())
    const id = await sessionId(page, APPROVING)
    await u.click(page.getByTestId(`inbox-approve-allow-${id}`), {
      among: page.locator('[data-testid^="inbox-item-"]'),
      label: `Allow on the waiting-list row "${APPROVING}"`,
    })
  },
  goal: allowedInPlace,
  budget: { operators: 9, M: 2, H: 1, seconds: 6.0 },
})

// The waiting list's y answers the row under its cursor (#543); the row prints it, but the list is opened by a key here
uxTask({
  id: 'approve.inbox-keyboard',
  task: 'Answer an approval waiting in another session',
  path: 'keyboard',
  access: 'shortcut',
  notes: ['⌘I / Ctrl+I opens the waiting list with its cursor on the approval (approvals come first); y allows it'],
  start: demo,
  run: async (u, page) => {
    await u.press('ControlOrMeta+i')
    const id = await sessionId(page, APPROVING)
    await u.until('the row, ready to answer', () => expect(page.getByTestId(`inbox-approve-allow-${id}`)).toBeEnabled())
    await u.press('y')
  },
  goal: allowedInPlace,
})

// ---------------------------------------------------------------------------------------------
// Answer an approval while typing in its session's composer

const DRAFT = 'Then rerun the tests and'

/** The approving session open, its composer holding a half-written message and the keyboard, not counted */
async function typingBesideCard(page: Page): Promise<void> {
  await demo(page)
  await open(page, APPROVING)
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.getByTestId('prompt-input').click()
  await page.keyboard.type(DRAFT)
}

const answeredKeepingDraft = async (page: Page) => {
  await expect(page.getByTestId('approval-card')).toBeHidden()
  await expect(page.getByTestId('prompt-input')).toHaveValue(DRAFT)
}

// The card's Allow button is on screen, one click from the composer
uxTask({
  id: 'approve-while-typing.mouse',
  task: 'Answer an approval while typing a message in its session',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The hand starts on the keyboard, mid-message; the draft stays in the composer'],
  start: typingBesideCard,
  run: async (u, page) => {
    await u.click(page.getByTestId('approve-allow'))
  },
  goal: answeredKeepingDraft,
  budget: { operators: 5, M: 1, H: 1, seconds: 3.2 },
})

// mod+⇧Y has to be known (the card prints it while the composer has the keyboard): a shortcut, so no budget
uxTask({
  id: 'approve-while-typing.keyboard',
  task: 'Answer an approval while typing a message in its session',
  path: 'keyboard',
  access: 'shortcut',
  notes: ['mod+⇧Y from the composer, where a bare y would be typed into the message'],
  start: typingBesideCard,
  run: async (u) => {
    await u.press('ControlOrMeta+Shift+y')
  },
  goal: answeredKeepingDraft,
})

// ---------------------------------------------------------------------------------------------
// Switch between two sessions

/** The person was in DONE, then opened OPEN; the task is going back to DONE */
async function twoSessions(page: Page): Promise<void> {
  await demo(page)
  await open(page, DONE)
  await open(page, OPEN)
}

const backIn = async (page: Page) => expect(page.getByTestId('session-name')).toHaveText(DONE)

/**
 * Back, as this keyboard presses it (app/keys.ts `navKeyOf`): ⌘[ on a Mac, Alt+← elsewhere. Ctrl+[ is
 * not back, so `ControlOrMeta+[` would test nothing on Linux. Two keys either way.
 */
const BACK = process.platform === 'darwin' ? 'Meta+[' : 'Alt+ArrowLeft'

uxTask({
  id: 'switch-session.keyboard-back',
  task: 'Switch back to the session you were just in',
  path: 'keyboard',
  access: 'shortcut',
  start: twoSessions,
  run: async (u) => {
    await u.press(BACK)
  },
  goal: backIn,
})

uxTask({
  id: 'switch-session.mouse-back',
  task: 'Switch back to the session you were just in',
  path: 'mouse',
  access: 'discoverable',
  notes: ["The top bar's back arrow, beside the session's name (#374)"],
  start: twoSessions,
  run: async (u, page) => {
    await u.click(page.getByTestId('nav-back'))
  },
  goal: backIn,
  budget: { operators: 5, M: 1, H: 1, seconds: 3.4 },
})

uxTask({
  id: 'switch-session.keyboard-palette',
  task: 'Switch to another session by name',
  path: 'keyboard',
  access: 'shortcut',
  start: twoSessions,
  run: async (u, page) => {
    await u.press('ControlOrMeta+k')
    await u.until('the palette', () => expect(page.getByTestId('palette-input')).toBeFocused())
    await u.type('optim')
    await u.press('Enter', { among: page.locator('[data-testid^="palette-item-"]') })
  },
  goal: backIn,
})

uxTask({
  id: 'switch-session.mouse',
  task: 'Switch to another session by name',
  path: 'mouse',
  access: 'discoverable',
  start: twoSessions,
  run: async (u, page) => {
    await clickRow(u, page, DONE)
  },
  goal: backIn,
  budget: { operators: 5, M: 1, H: 1, seconds: 3.3 },
})

// ---------------------------------------------------------------------------------------------
// Send a message to another session

const MESSAGE = 'Also convert the SVGs'

const sentThere = async (page: Page) => {
  await expect(page.getByTestId('session-name')).toHaveText(DONE)
  await expect(lastSaid(page)).toContainText(MESSAGE)
}

uxTask({
  id: 'send-to-session.keyboard',
  task: 'Send a message to another session',
  path: 'keyboard',
  access: 'shortcut',
  start: demo,
  run: async (u, page) => {
    await u.press('ControlOrMeta+k')
    await u.until('the palette', () => expect(page.getByTestId('palette-input')).toBeFocused())
    await u.type('optim')
    await u.press('Enter', { among: page.locator('[data-testid^="palette-item-"]') })
    await u.until('the session', () => expect(page.getByTestId('session-name')).toHaveText(DONE))
    await u.fill(page.getByTestId('prompt-input'), MESSAGE)
    await u.press('Enter')
  },
  goal: sentThere,
})

uxTask({
  id: 'send-to-session.mouse',
  task: 'Send a message to another session',
  path: 'mouse',
  access: 'discoverable',
  start: demo,
  run: async (u, page) => {
    await clickRow(u, page, DONE)
    await u.until('the session', () => expect(page.getByTestId('session-name')).toHaveText(DONE))
    await u.fill(page.getByTestId('prompt-input'), MESSAGE)
    await u.press('Enter')
  },
  goal: sentThere,
  budget: { operators: 36, M: 2, H: 2, seconds: 13.8 },
})

// ---------------------------------------------------------------------------------------------
// Find a past conversation

/** Something said in OPEN, found while DONE is open */
async function searchable(page: Page): Promise<void> {
  await demo(page)
  const id = await sessionId(page, OPEN)
  await page.evaluate(
    (sid) => {
      ;(window as any).__mock.searchResults = [
        { sessionId: sid, seq: 4, snippet: "The ring is the panel's border, so it has to sit above the card." },
      ]
    },
    id,
  )
  await open(page, DONE)
}

uxTask({
  id: 'find-conversation.keyboard',
  task: 'Find a past conversation by something said in it',
  path: 'keyboard',
  access: 'shortcut',
  start: searchable,
  run: async (u, page) => {
    await u.press('ControlOrMeta+k')
    await u.until('the palette', () => expect(page.getByTestId('palette-input')).toBeFocused())
    await u.type('ring')
    await u.until('the conversation hits', () => expect(page.getByTestId('palette-item-message')).toBeVisible())
    await u.press('Enter', { among: page.locator('[data-testid^="palette-item-"]') })
  },
  goal: async (page) => expect(page.getByTestId('session-name')).toHaveText(OPEN),
})

uxTask({
  id: 'find-conversation.search',
  task: 'Find a past conversation by something said in it',
  path: 'mixed',
  access: 'discoverable',
  notes: ["The search field in the middle of the top bar (#529, #727); Enter opens the highlighted hit, as the palette's footer says"],
  start: searchable,
  run: async (u, page) => {
    await u.click(page.getByTestId('search-button'))
    await u.until('the palette', () => expect(page.getByTestId('palette-input')).toBeFocused())
    await u.type('ring')
    await u.until('the conversation hits', () => expect(page.getByTestId('palette-item-message')).toBeVisible())
    await u.press('Enter', { among: page.locator('[data-testid^="palette-item-"]') })
  },
  goal: async (page) => expect(page.getByTestId('session-name')).toHaveText(OPEN),
  budget: { operators: 12, M: 2, H: 2, seconds: 6.5 },
})

// ---------------------------------------------------------------------------------------------
// Open another machine's app

const NOTES = 'box:_user/notes'

async function linkedMachine(page: Page): Promise<void> {
  await demo(page)
  await page.evaluate(async () => {
    const mock = (window as any).__mock
    await mock.machines.add({ name: 'Box', sshTarget: 'me@box', shell: 'posix' })
    mock.setExternalApps([
      ...mock.externalAppList,
      {
        appId: 'notes',
        projectId: null,
        machine: 'box',
        dir: '/home/me/.centralu/apps/notes',
        name: 'Notes',
        version: '0.1.0',
        description: null,
        home: 'home',
        trusted: true,
        status: 'stopped',
        error: null,
        warnings: [],
      },
    ])
  })
  await expect(page.getByTestId(`app-row-${NOTES}`)).toBeVisible()
}

const openedNotes = async (page: Page) => {
  await expect(page.getByTestId(`pinned-app-${NOTES}`)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.openedViews)).toContainEqual({ appId: 'notes', projectId: null, machine: 'box' })
}

uxTask({
  id: 'open-remote-app.mouse',
  task: "Open an app that lives on another machine",
  path: 'mouse',
  access: 'discoverable',
  start: linkedMachine,
  // The app's name: the row's middle is its machine's badge since #734, which opens Settings → Machines
  notes: ["Pressing the app's name; the machine badge beside it opens Settings → Machines"],
  run: async (u, page) => {
    await u.click(page.getByTestId(`app-row-${NOTES}`).locator('.truncate').first())
  },
  goal: openedNotes,
  budget: { operators: 5, M: 1, H: 1, seconds: 3.3 },
})

uxTask({
  id: 'open-remote-app.palette',
  task: 'Open an app that lives on another machine',
  path: 'keyboard',
  access: 'shortcut',
  notes: ["⌘K / Ctrl+K and the app's name: the palette lists apps (#529)"],
  start: linkedMachine,
  run: async (u, page) => {
    await u.press('ControlOrMeta+k')
    await u.until('the palette', () => expect(page.getByTestId('palette-input')).toBeFocused())
    await u.type('notes')
    await u.until('the app', () => expect(page.getByTestId('palette-item-app')).toBeVisible())
    await u.press('Enter', { among: page.locator('[data-testid^="palette-item-"]') })
  },
  goal: openedNotes,
})

// ---------------------------------------------------------------------------------------------
// Add a linked machine

uxTask({
  id: 'add-machine.mouse-manual',
  task: 'Link another machine by typing its name and ssh target',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The typed form, as the dialog opens when ~/.ssh/config has no hosts'],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('open-settings'))
    await u.until('settings', () => expect(page.getByTestId('settings')).toBeVisible())
    await u.click(page.getByTestId('settings-tab-machines'))
    await u.until('the form', () => expect(page.getByTestId('machines-add-name')).toBeVisible())
    await u.fill(page.getByTestId('machines-add-name'), 'Build box')
    await u.fill(page.getByTestId('machines-add-target'), 'me@build-box')
    await u.click(page.getByTestId('machines-add-confirm'))
  },
  goal: async (page) => expect(page.getByTestId('machine-row-build-box')).toHaveAttribute('data-status', 'connected'),
  budget: { operators: 43, M: 3, H: 5, seconds: 18.2 },
})

uxTask({
  id: 'add-machine.ssh-config',
  task: 'Link another machine picked from the ssh config',
  path: 'mouse',
  access: 'discoverable',
  notes: ['Picking the host probes it and fills the shell and the name (#514)'],
  start: async (page) => {
    await demo(page)
    await seedSshConfig(page)
  },
  run: async (u, page) => {
    await u.click(page.getByTestId('open-settings'))
    await u.until('settings', () => expect(page.getByTestId('settings')).toBeVisible())
    await u.click(page.getByTestId('settings-tab-machines'))
    await u.until('the hosts', () => expect(page.getByTestId('machines-add-hosts')).toBeVisible())
    await u.click(page.getByTestId('machines-add-host-build-box'), { among: page.locator('[data-testid^="machines-add-host-"]:not([data-testid^="machines-add-host-linked-"])') })
    await u.until('the probe', () => expect(page.getByTestId('machines-add-choice-posix')).toHaveAttribute('aria-checked', 'true'))
    await u.click(page.getByTestId('machines-add-confirm'))
  },
  goal: async (page) => expect(page.getByTestId('machine-row-build-box')).toContainText('build-box · Linux or macOS'),
  budget: { operators: 17, M: 4, H: 1, seconds: 11.4 },
})

// ---------------------------------------------------------------------------------------------
// Add or create a project

uxTask({
  id: 'add-project.mouse',
  task: 'Add an existing folder as a project',
  path: 'mouse',
  access: 'discoverable',
  notes: ["The folder picker is the system's: what the person does in it is not counted"],
  start: async (page) => {
    await demo(page)
    await page.evaluate(() => {
      ;(window as any).__mock.nextPickedDirectory = '/Users/you/code/new-thing'
    })
  },
  run: async (u, page) => {
    await u.click(page.getByTestId('add-project'))
  },
  goal: async (page) => expect(page.getByTestId('project-new-thing')).toBeVisible(),
  budget: { operators: 5, M: 1, H: 1, seconds: 3.3 },
})

// Every step is a control on screen: New folder, the name field, Create
uxTask({
  id: 'create-project.mouse',
  task: 'Create a new project (an empty folder)',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The folder goes where the dialog says, ~/Centralu by default (#515); choosing another location is not counted'],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('create-project'))
    await u.until('the create-project dialog', () => expect(page.getByTestId('create-project-dialog')).toBeVisible())
    // The name field takes the keyboard as the dialog opens
    await u.fill(page.getByTestId('create-project-name'), 'game')
    await u.until('the folder it will make', () => expect(page.getByTestId('create-project-path')).toHaveText('/Users/you/Centralu/game'))
    await u.click(page.getByTestId('create-project-confirm'))
  },
  goal: async (page) => {
    await expect(page.getByTestId('create-project-dialog')).toHaveCount(0)
    await expect(page.getByTestId('project-game')).toBeVisible()
  },
  budget: { operators: 15, M: 2, H: 3, seconds: 7.8 },
})

uxPending({
  id: 'create-project.orchestrator',
  task: 'Create a new project by asking the orchestrator',
  path: 'mouse',
  access: 'discoverable',
  waitingOn: 'a scripted orchestrator reply in the demo',
  reason: "the mock's orchestrator does not call create_project, so the card can only be raised by a test handle, not by a person",
})
