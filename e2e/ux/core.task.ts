import { expect, type Page } from '@playwright/test'
import type { Recorder } from './recorder.js'
import { seedSshConfig } from '../fixtures/ssh-hosts.js'
import { uxPending, uxTask } from './task.js'

/**
 * The core tasks (#518): what a person does with Centralu most, each by the keyboard and by the
 * mouse where both exist. They start in the `?demo` scene (packages/platform/src/mock/demo.ts):
 * two projects, four sessions, one waiting for approval, one long conversation, and the
 * "Finish the collapsed composer" session open.
 *
 * The budgets are the first baseline's numbers (docs/ux-metrics.md, "Baseline"): the operator
 * counts exactly, the KLM time with 2% and 0.05 s of headroom, rounded up to a tenth, because the
 * pointing times follow the boxes on screen and fonts differ a little between machines. A change
 * that makes a task cost more fails here; raising a budget is a decision the pull request states.
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

uxTask({
  id: 'new-session.mouse',
  task: 'Start a new session in a project and give it its first instruction',
  path: 'mouse',
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('project-menu-centralu'))
    await u.click(page.getByTestId('new-session-centralu'))
    await u.until('the new-session dialog', () => expect(page.getByTestId('new-session-dialog')).toBeVisible())
    await u.click(page.getByTestId('create-session-confirm'))
    await u.until('the new session', () => expect(page.getByTestId('new-session-dialog')).toBeHidden())
    await u.fill(page.getByTestId('prompt-input'), 'Fix the login bug')
    await u.press('Enter')
  },
  goal: async (page) => {
    await expect(page.getByTestId('session-name')).toHaveText('Fix the login bug')
    await expect(lastSaid(page)).toHaveText('Fix the login bug')
  },
  budget: { operators: 37, M: 4, H: 2, seconds: 17.3 },
})

uxPending({
  id: 'new-session.keyboard',
  task: 'Start a new session in a project and give it its first instruction',
  path: 'keyboard',
  waitingOn: 'a keyboard path',
  reason: 'none exists: the palette has no "New session" action and no shortcut opens the dialog',
})

// ---------------------------------------------------------------------------------------------
// Answer an approval waiting in another session

uxTask({
  id: 'approve.keyboard',
  task: 'Answer an approval waiting in another session',
  path: 'keyboard',
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
  budget: { operators: 6, M: 2, H: 0, seconds: 4.0 },
})

uxTask({
  id: 'approve.mouse',
  task: 'Answer an approval waiting in another session',
  path: 'mouse',
  start: demo,
  run: async (u, page) => {
    await clickRow(u, page, APPROVING)
    await u.until('the approval card', () => expect(page.getByTestId('approval-card')).toBeVisible())
    await u.click(page.getByTestId('approve-allow'))
  },
  goal: async (page) => {
    await expect(page.getByTestId('session-name')).toHaveText(APPROVING)
    await expect(page.getByTestId('approval-card')).toBeHidden()
  },
  budget: { operators: 9, M: 2, H: 1, seconds: 5.8 },
})

uxTask({
  id: 'approve.mouse-inbox',
  task: 'Answer an approval waiting in another session',
  path: 'mouse',
  notes: ['Through the waiting list (the top-bar count), the way the app points to it when the session is not in sight'],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('counter'))
    await u.until('the waiting list', () => expect(page.getByTestId('inbox')).toBeVisible())
    const id = await sessionId(page, APPROVING)
    await u.click(page.getByTestId(`inbox-item-${id}`), { among: page.locator('[data-testid^="inbox-item-"]'), label: `waiting-list row "${APPROVING}"` })
    await u.until('the approval card', () => expect(page.getByTestId('approval-card')).toBeVisible())
    await u.click(page.getByTestId('approve-allow'))
  },
  goal: async (page) => {
    await expect(page.getByTestId('session-name')).toHaveText(APPROVING)
    await expect(page.getByTestId('approval-card')).toBeHidden()
  },
  budget: { operators: 13, M: 3, H: 1, seconds: 8.6 },
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
  start: twoSessions,
  run: async (u) => {
    await u.press(BACK)
  },
  goal: backIn,
  budget: { operators: 3, M: 1, H: 0, seconds: 2.0 },
})

uxTask({
  id: 'switch-session.keyboard-palette',
  task: 'Switch to another session by name',
  path: 'keyboard',
  start: twoSessions,
  run: async (u, page) => {
    await u.press('ControlOrMeta+k')
    await u.until('the palette', () => expect(page.getByTestId('palette-input')).toBeFocused())
    await u.type('optim')
    await u.press('Enter', { among: page.locator('[data-testid^="palette-item-"]') })
  },
  goal: backIn,
  budget: { operators: 10, M: 2, H: 0, seconds: 5.1 },
})

uxTask({
  id: 'switch-session.mouse',
  task: 'Switch to another session by name',
  path: 'mouse',
  start: twoSessions,
  run: async (u, page) => {
    await clickRow(u, page, DONE)
  },
  goal: backIn,
  budget: { operators: 5, M: 1, H: 1, seconds: 3.1 },
})

// ---------------------------------------------------------------------------------------------
// Send a message to another session

const MESSAGE = 'Also convert the SVGs'

const sentThere = async (page: Page) => {
  await expect(page.getByTestId('session-name')).toHaveText(DONE)
  await expect(lastSaid(page)).toHaveText(MESSAGE)
}

uxTask({
  id: 'send-to-session.keyboard',
  task: 'Send a message to another session',
  path: 'keyboard',
  notes: [
    'The palette leaves the keyboard on the page, not in the composer, and no key reliably reaches it: one Tab does in WebKit on macOS, not in WebKit on Linux or in Chromium. So this keyboard path takes the mouse for one click',
  ],
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
  budget: { operators: 42, M: 3, H: 2, seconds: 16.2 },
})

uxTask({
  id: 'send-to-session.mouse',
  task: 'Send a message to another session',
  path: 'mouse',
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
  start: searchable,
  run: async (u, page) => {
    await u.press('ControlOrMeta+k')
    await u.until('the palette', () => expect(page.getByTestId('palette-input')).toBeFocused())
    await u.type('ring')
    await u.until('the conversation hits', () => expect(page.getByTestId('palette-item-message')).toBeVisible())
    await u.press('Enter', { among: page.locator('[data-testid^="palette-item-"]') })
  },
  goal: async (page) => expect(page.getByTestId('session-name')).toHaveText(OPEN),
  budget: { operators: 9, M: 2, H: 0, seconds: 4.9 },
})

uxPending({
  id: 'find-conversation.mouse',
  task: 'Find a past conversation by something said in it',
  path: 'mouse',
  waitingOn: 'a mouse path',
  reason: 'none exists: the palette is the only search, and only ⌘K / Ctrl+K opens it',
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

uxTask({
  id: 'open-remote-app.mouse',
  task: "Open an app that lives on another machine",
  path: 'mouse',
  start: linkedMachine,
  run: async (u, page) => {
    await u.click(page.getByTestId(`app-row-${NOTES}`))
  },
  goal: async (page) => {
    await expect(page.getByTestId(`pinned-app-${NOTES}`)).toBeVisible()
    expect(await page.evaluate(() => (window as any).__mock.openedViews)).toContainEqual({ appId: 'notes', projectId: null, machine: 'box' })
  },
  budget: { operators: 5, M: 1, H: 1, seconds: 3.1 },
})

uxPending({
  id: 'open-remote-app.keyboard',
  task: 'Open an app that lives on another machine',
  path: 'keyboard',
  waitingOn: 'a keyboard path',
  reason: 'none exists: the palette does not list apps',
})

// ---------------------------------------------------------------------------------------------
// Add a linked machine

uxTask({
  id: 'add-machine.mouse-manual',
  task: 'Link another machine by typing its name and ssh target',
  path: 'mouse',
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
  budget: { operators: 46, M: 3, H: 5, seconds: 19.3 },
})

uxTask({
  id: 'add-machine.ssh-config',
  task: 'Link another machine picked from the ssh config',
  path: 'mouse',
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
  budget: { operators: 5, M: 1, H: 1, seconds: 3.1 },
})

uxPending({
  id: 'create-project.mouse',
  task: 'Create a new project (an empty folder)',
  path: 'mouse',
  waitingOn: '#515',
  reason: 'creating a project folder from the dialog is not merged yet',
})
