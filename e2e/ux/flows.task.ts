import { expect, type Page } from '@playwright/test'
import type { Recorder } from './recorder.js'
import { uxTask } from './task.js'

/**
 * Frequent flows beyond the core tasks (#518, the 2026-10 audit in docs/ux-metrics.md): opening a
 * diff or a file, attaching a file, renaming, stopping, deleting and restoring a session, a worktree
 * session, the grid, a remote project, updating the app, usage, the theme, the terminal, reordering
 * projects, a question card, handing a session to another tool, a saved command, a commit and the
 * model. Each is measured on its **discoverable** path, the one the screen shows, in the `?demo`
 * scene (packages/platform/src/mock/demo.ts).
 *
 * Their budgets are looser than the core tasks': the operator count with two to spare, the M's
 * exactly, and the KLM time plus 10%, rounded up to a tenth. They were written to find what costs
 * too much, not to hold a gain yet; the margin keeps a pixel from failing CI, while a change that
 * adds a decision (an M) or a step (four operators) still fails. A pull request that makes one of
 * these cheaper tightens its budget to the new numbers.
 */

const OPEN = 'Finish the collapsed composer'
const QUESTION = 'Pick the hero copy'
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

/**
 * A session's ⋯ menu, as a person reaches it: the ⋯ shows only while the pointer is over the row,
 * so the pointer goes to the row first, then to the ⋯, then to the item.
 */
async function sessionMenu(u: Recorder, page: Page, name: string, item: 'rename' | 'handoff' | 'delete'): Promise<string> {
  const id = await sessionId(page, name)
  await u.point(page.getByTestId(`session-row-${id}`), { label: `session row "${name}" (hover reveals ⋯)` })
  await u.click(page.getByTestId(`session-menu-${id}`), { label: `⋯ of "${name}"` })
  await u.until('the menu', () => expect(page.getByTestId(`session-menu-open-${id}`)).toBeVisible())
  await u.click(page.getByTestId(`${item}-session-${id}`), { among: page.getByTestId(`session-menu-open-${id}`).getByRole('button') })
  return id
}

// ---------------------------------------------------------------------------------------------
// Files and changes

uxTask({
  id: 'open-diff.mouse',
  task: 'See what the agent changed in a file',
  path: 'mouse',
  access: 'discoverable',
  notes: ["The changed file's row in the evidence panel's Git tab, open by default"],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('evidence-file-packages/ui/src/features/session/SessionView.tsx'))
  },
  goal: async (page) => expect(page.getByTestId('diff-view')).toBeVisible(),
  budget: { operators: 7, M: 1, seconds: 3.5 },
})

const STYLES = 'packages/ui/src/styles/index.css'

/** A project tree shaped like a small monorepo, folder by folder down to the file */
const TREE: Record<string, { name: string; isDir?: boolean }[]> = {
  '': [{ name: 'docs', isDir: true }, { name: 'e2e', isDir: true }, { name: 'packages', isDir: true }, { name: 'package.json' }, { name: 'README.md' }],
  packages: ['agent-host', 'core', 'platform', 'protocol', 'ui'].map((name) => ({ name, isDir: true })),
  'packages/ui': [{ name: 'src', isDir: true }, { name: 'package.json' }],
  'packages/ui/src': ['app', 'components', 'features', 'store', 'styles'].map((name) => ({ name, isDir: true })),
  'packages/ui/src/styles': [{ name: 'index.css' }],
}

async function withFile(page: Page): Promise<void> {
  await demo(page)
  await page.evaluate(
    ({ path, sid, tree }) => {
      const m = (window as any).__mock
      for (const [dir, items] of Object.entries(tree)) {
        m.fsState.entries[dir] = items.map((i) => ({ name: i.name, path: dir ? `${dir}/${i.name}` : i.name, isDir: !!i.isDir, ignored: false }))
      }
      m.fsState.files = { ...m.fsState.files, [path]: ':root {\n  --ring: 1;\n}\n' }
      m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: `\n\nThe ring's layer is set in \`${path}\`.` })
    },
    { path: STYLES, sid: await sessionId(page, OPEN), tree: TREE },
  )
  await expect(page.getByTestId('file-link')).toBeVisible()
}

const viewing = async (page: Page) => {
  await expect(page.getByTestId('viewer-path')).toContainText(STYLES)
  await expect(page.getByTestId('code-viewer')).toContainText('--ring')
}

uxTask({
  id: 'open-file.mouse-link',
  task: 'Open a file the agent named',
  path: 'mouse',
  access: 'discoverable',
  notes: ['A backticked path in the reply is a link (#39); the path in a tool card ("Read packages/…") is not'],
  start: withFile,
  run: async (u, page) => {
    await u.click(page.getByTestId('file-link'))
  },
  goal: viewing,
  budget: { operators: 7, M: 1, seconds: 3.5 },
})

uxTask({
  id: 'open-file.mouse-tree',
  task: 'Open a file the agent named',
  path: 'mouse',
  access: 'discoverable',
  notes: ['Through the Files tab, folder by folder: what a person does when the path is in a tool card, not a link'],
  start: withFile,
  run: async (u, page) => {
    await u.click(page.getByTestId('evidence-tab-files'))
    for (const dir of ['packages', 'packages/ui', 'packages/ui/src', 'packages/ui/src/styles']) {
      await u.until(`the folder ${dir}`, () => expect(page.getByTestId(`dir-${dir}`)).toBeVisible())
      const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
      await u.click(page.getByTestId(`dir-${dir}`), { among: TREE[parent]!.length })
    }
    await u.until('the file', () => expect(page.getByTestId(`file-${STYLES}`)).toBeVisible())
    await u.click(page.getByTestId(`file-${STYLES}`))
  },
  goal: viewing,
  budget: { operators: 27, M: 6, seconds: 17.5 },
})

uxTask({
  id: 'attach-file.mouse',
  task: 'Attach a file to a message',
  path: 'mouse',
  access: 'discoverable',
  notes: ["The composer's +; the file picker is the system's, and what the person does in it is not counted"],
  start: async (page) => {
    await demo(page)
    page.on('filechooser', (chooser) => void chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') }))
  },
  run: async (u, page) => {
    await u.click(page.getByTestId('attach-open'))
  },
  goal: async (page) => expect(page.getByTestId('attachment-chip')).toBeVisible(),
  budget: { operators: 7, M: 1, seconds: 3.5 },
})

uxTask({
  id: 'commit.mouse',
  task: "Commit the session's changes with a message",
  path: 'mouse',
  access: 'discoverable',
  notes: ['The commit box under the changes in the evidence panel; Commit stays disabled until something is staged'],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('evidence-stage-all'))
    await u.until('staged', () => expect(page.getByTestId('evidence-group-staged')).toBeVisible())
    await u.fill(page.getByTestId('evidence-commit-message'), 'Raise the ring above the card')
    await u.click(page.getByTestId('evidence-commit'))
  },
  goal: async (page) => expect(page.getByTestId('evidence-commit-message')).toHaveValue(''),
  budget: { operators: 46, M: 2, seconds: 18.0 },
})

// ---------------------------------------------------------------------------------------------
// A session's life

uxTask({
  id: 'stop-session.mouse',
  task: 'Stop a session that is working',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The Stop beside "Waiting for response" at the end of the conversation'],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('activity-interrupt'))
  },
  goal: async (page) => expect(page.getByTestId('activity-interrupt')).toBeHidden(),
  budget: { operators: 7, M: 1, seconds: 3.5 },
})

uxTask({
  id: 'rename-session.mouse',
  task: 'Rename a session',
  path: 'mouse',
  access: 'discoverable',
  notes: ["The row's ⋯ menu, Rename; double-clicking the name also renames, but nothing on screen says so"],
  start: demo,
  run: async (u, page) => {
    const id = await sessionMenu(u, page, DONE, 'rename')
    const field = page.getByTestId(`session-name-input-${id}`)
    // The field opens with the old name selected, so typing replaces it
    await u.until('the name field', () => expect(field).toBeFocused())
    await u.type('Compress the images')
    await u.press('Enter')
  },
  goal: async (page) => expect(page.getByTestId(`session-row-${await sessionId(page, 'Compress the images')}`)).toBeVisible(),
  budget: { operators: 35, M: 3, seconds: 15.5 },
})

uxTask({
  id: 'delete-session.mouse',
  task: 'Delete a session (to the trash)',
  path: 'mouse',
  access: 'discoverable',
  start: demo,
  run: async (u, page) => {
    await sessionMenu(u, page, DONE, 'delete')
    await u.until('the confirmation', () => expect(page.getByTestId('confirm-delete')).toBeVisible())
    await u.click(page.getByTestId('confirm-delete-yes'))
  },
  goal: async (page) => expect(page.getByTestId('confirm-delete')).toBeHidden(),
  budget: { operators: 16, M: 3, seconds: 10.1 },
})

uxTask({
  id: 'restore-session.mouse',
  task: 'Bring back a session deleted by mistake',
  path: 'mouse',
  access: 'discoverable',
  notes: ['Settings, then Trash: the delete dialog and its toast say where it went'],
  start: async (page) => {
    await demo(page)
    const id = await sessionId(page, DONE)
    await page.getByTestId(`session-menu-${id}`).click()
    await page.getByTestId(`delete-session-${id}`).click()
    await page.getByTestId('confirm-delete-yes').click()
    await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
    await expect(page.getByTestId('toast')).toBeHidden({ timeout: 15_000 })
  },
  run: async (u, page) => {
    await u.click(page.getByTestId('open-settings'))
    await u.until('settings', () => expect(page.getByTestId('settings')).toBeVisible())
    await u.click(page.getByTestId('settings-tab-trash'))
    await u.until('the trash', () => expect(page.getByTestId('settings-trash')).toBeVisible())
    await u.click(page.locator('[data-testid^="trash-restore-"]').first(), { label: 'trash-restore' })
  },
  goal: async (page) => expect(page.getByTestId('trash-list-empty')).toBeVisible(),
  budget: { operators: 15, M: 3, seconds: 9.4 },
})

uxTask({
  id: 'worktree-session.mouse',
  task: 'Start a session in its own git worktree',
  path: 'mouse',
  access: 'discoverable',
  notes: ["The project's +, then the dialog's worktree box; the branch left blank takes the default name"],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('project-new-session-centralu'))
    await u.until('the new-session dialog', () => expect(page.getByTestId('new-session-dialog')).toBeVisible())
    await u.click(page.getByTestId('worktree-toggle'))
    await u.until('the worktree options', () => expect(page.getByTestId('worktree-options')).toBeVisible())
    await u.click(page.getByTestId('create-session-confirm'))
  },
  goal: async (page) => {
    await expect(page.getByTestId('new-session-dialog')).toBeHidden()
    await expect(page.getByTestId('worktree-badge').first()).toBeVisible()
  },
  budget: { operators: 15, M: 3, seconds: 9.5 },
})

uxTask({
  id: 'answer-question.mouse',
  task: 'Answer a question an agent asked in another session',
  path: 'mouse',
  access: 'discoverable',
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId(`session-row-${await sessionId(page, QUESTION)}`), { label: `session row "${QUESTION}"` })
    await u.until('the question', () => expect(page.getByTestId('question-card')).toBeVisible())
    await u.click(page.getByTestId('question-option').first(), { among: page.getByTestId('question-option') })
    await u.click(page.getByTestId('question-submit'))
  },
  goal: async (page) => expect(page.getByTestId('question-card')).toBeHidden(),
  budget: { operators: 15, M: 3, seconds: 8.9 },
})

uxTask({
  id: 'handoff.mouse',
  task: 'Continue a session in the other tool (hand off from Codex to Claude Code)',
  path: 'mouse',
  access: 'discoverable',
  start: demo,
  run: async (u, page) => {
    await sessionMenu(u, page, DONE, 'handoff')
    await u.until('the hand-off dialog', () => expect(page.getByTestId('confirm-handoff')).toBeVisible())
    await u.click(page.getByTestId('handoff-tool-claude'), { among: page.locator('[data-testid^="handoff-tool-"]') })
    await u.click(page.getByTestId('confirm-handoff-yes'))
  },
  goal: async (page) => {
    await expect(page.getByTestId('confirm-handoff')).toBeHidden()
    await expect(page.getByTestId('chat-stream')).toContainText('handoff note')
  },
  budget: { operators: 20, M: 4, seconds: 12.9 },
})

uxTask({
  id: 'change-model.mouse',
  task: "Change a session's model",
  path: 'mouse',
  access: 'discoverable',
  notes: ["The model and permission chip under the composer (\"Default · Normal\")"],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('settings-open'))
    await u.until('the menu', () => expect(page.getByTestId('settings-menu')).toBeVisible())
    await u.click(page.getByTestId('settings-model-opus'), { among: page.locator('[data-testid^="settings-model-"]') })
  },
  goal: async (page) => expect(page.getByTestId('settings-open')).toContainText(/opus/i),
  budget: { operators: 11, M: 2, seconds: 6.5 },
})

uxTask({
  id: 'run-command.mouse',
  task: "Run one of the project's saved commands",
  path: 'mouse',
  access: 'discoverable',
  notes: ['The ▶ in the session header lists the saved commands; picking one selects it, and Run runs it (#60)'],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('run-open'))
    await u.until('the commands', () => expect(page.getByTestId('run-menu')).toBeVisible())
    await u.click(page.getByTestId('run-command-0'), { among: page.locator('[data-testid^="run-command-"]') })
    await u.click(page.getByTestId('run-exec'))
  },
  goal: async (page) => expect(page.getByTestId('run-running-0')).toBeVisible(),
  budget: { operators: 15, M: 3, seconds: 9.1 },
})

uxTask({
  id: 'open-terminal.mouse',
  task: "Open a terminal in the session's project",
  path: 'mouse',
  access: 'discoverable',
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('evidence-tab-terminal'))
  },
  goal: async (page) => expect(page.locator('[data-testid^="terminal-surface-"]').first()).toBeVisible(),
  budget: { operators: 7, M: 1, seconds: 3.5 },
})

// ---------------------------------------------------------------------------------------------
// The grid

const SLIDER = '_user/slider'

async function withApp(page: Page): Promise<void> {
  await demo(page)
  await page.evaluate(() =>
    (window as any).__mock.setExternalApps([
      {
        appId: 'slider',
        projectId: null,
        dir: '/Users/you/.centralu/apps/slider',
        name: 'Slider',
        version: '0.1.0',
        description: null,
        home: 'home',
        trusted: true,
        status: 'stopped',
        error: null,
        warnings: [],
      },
    ]),
  )
  await expect(page.getByTestId(`app-row-${SLIDER}`)).toBeVisible()
}

uxTask({
  id: 'grid-app.mouse',
  task: 'Put an app on the grid',
  path: 'mouse',
  access: 'discoverable',
  notes: ['Open the grid, then drag the app\'s sidebar row onto it, as the empty grid says ("Drag sessions and apps here from the sidebar")'],
  start: withApp,
  run: async (u, page) => {
    await u.click(page.getByTestId('grid-button'))
    await u.until('the grid', () => expect(page.getByTestId('grid')).toBeVisible())
    await u.drag(page.getByTestId(`app-row-${SLIDER}`), page.getByTestId('grid'))
  },
  goal: async (page) => expect(page.getByTestId(`grid-panel-app:${SLIDER}`)).toBeVisible(),
  budget: { operators: 12, M: 2, seconds: 7.3 },
})

uxTask({
  id: 'grid-session.mouse',
  task: 'Put a session on the grid beside the others',
  path: 'mouse',
  access: 'discoverable',
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('grid-button'))
    await u.until('the grid', () => expect(page.getByTestId('grid')).toBeVisible())
    await u.drag(page.getByTestId(`session-row-${await sessionId(page, DONE)}`), page.getByTestId('grid'), { label: `session row "${DONE}" → grid` })
  },
  goal: async (page) => expect(page.getByTestId(`grid-panel-${await sessionId(page, DONE)}`)).toBeVisible(),
  budget: { operators: 12, M: 2, seconds: 7.3 },
})

// ---------------------------------------------------------------------------------------------
// Projects and machines

uxTask({
  id: 'reorder-projects.mouse',
  task: 'Move a project to the top of the sidebar',
  path: 'mouse',
  access: 'discoverable',
  notes: ['Dragging the project by its name; nothing on screen says the list can be reordered'],
  start: demo,
  run: async (u, page) => {
    await u.drag(page.getByTestId('project-header-landing-site'), page.getByTestId('project-centralu'), { at: { x: 10, y: 2 } })
  },
  goal: async (page) =>
    expect
      .poll(() => page.evaluate(() => Object.values((window as any).__store.getState().projects).map((p: any) => p.name)))
      .toEqual(['landing-site', 'centralu']),
  budget: { operators: 8, M: 1, seconds: 4.4 },
})

uxTask({
  id: 'add-remote-project.mouse',
  task: 'Add a folder on a linked machine as a project',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The machine group\'s "Add project on…"; the path is typed, there is no picker for the other machine'],
  start: async (page) => {
    await demo(page)
    await page.evaluate(() => (window as any).__mock.machines.add({ name: 'Box', sshTarget: 'me@box', shell: 'posix' }))
    await expect(page.getByTestId('add-remote-project-box')).toBeVisible()
  },
  run: async (u, page) => {
    await u.click(page.getByTestId('add-remote-project-box'))
    await u.until('the dialog', () => expect(page.getByTestId('add-remote-project-dialog')).toBeVisible())
    await u.fill(page.getByTestId('add-remote-project-path'), '/home/me/api')
    await u.click(page.getByTestId('add-remote-project-confirm'))
  },
  goal: async (page) => expect(page.getByTestId('machine-group-box').getByTestId('project-api')).toBeVisible(),
  budget: { operators: 25, M: 2, seconds: 11.0 },
})

// ---------------------------------------------------------------------------------------------
// The app itself

uxTask({
  id: 'update-app.mouse',
  task: 'Update the app when a new version is out',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The "Update to …" line in the top bar installs; "Apply now" relaunches into it (#352)'],
  start: async (page) => {
    await demo(page)
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.relaunchCheck = { ready: true }
      m.offerUpdate('9.9.9')
    })
    await expect(page.getByTestId('update-line')).toContainText('9.9.9')
  },
  run: async (u, page) => {
    await u.click(page.getByTestId('update-line'))
    await u.until('installed', () => expect(page.getByTestId('update-apply-now')).toBeVisible())
    await u.click(page.getByTestId('update-apply-now'))
  },
  goal: async (page) => expect.poll(() => page.evaluate(() => (window as any).__mock.relaunches)).toBe(1),
  budget: { operators: 10, M: 2, seconds: 5.3 },
})

uxTask({
  id: 'view-usage.mouse',
  task: 'See how much of the weekly limit is used',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The ring shows the percentage at a glance; the click opens the windows and the daily use'],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('usage-donut-claude'))
  },
  goal: async (page) => expect(page.getByTestId('usage-panel')).toBeVisible(),
  budget: { operators: 7, M: 1, seconds: 3.5 },
})

uxTask({
  id: 'view-cache.mouse',
  task: 'See how much of the input came from the prompt cache, and which session rebuilt it',
  path: 'mouse',
  access: 'discoverable',
  notes: [
    "The donut's tooltip says the hit rate on hover (no click, not counted); the click opens the breakdown and the sessions that wrote most",
  ],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('usage-donut-claude'))
  },
  goal: async (page) => {
    await expect(page.getByTestId('usage-cache-rate')).toBeVisible()
    await expect(page.getByTestId('usage-cache-sessions')).toBeVisible()
  },
  budget: { operators: 5, M: 1, seconds: 3.3 },
})

uxTask({
  id: 'change-theme.mouse',
  task: 'Switch to the light theme',
  path: 'mouse',
  access: 'discoverable',
  notes: ['Settings, Appearance, Light; closing settings afterwards is not counted'],
  start: demo,
  run: async (u, page) => {
    await u.click(page.getByTestId('open-settings'))
    await u.until('settings', () => expect(page.getByTestId('settings')).toBeVisible())
    await u.click(page.getByTestId('settings-tab-appearance'), { among: page.locator('[data-testid^="settings-tab-"]') })
    await u.until('appearance', () => expect(page.getByTestId('settings-theme')).toBeVisible())
    await u.click(page.getByTestId('settings-theme-mode-light'))
  },
  goal: async (page) => expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light'),
  budget: { operators: 15, M: 3, seconds: 9.3 },
})
