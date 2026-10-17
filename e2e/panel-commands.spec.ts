import { expect, test, type Page } from '@playwright/test'
import { setup, newSession, openGrid } from './fixtures/panel.js'

/**
 * The right-hand panel and the grid around it: frequently used commands, the run dialog and their
 * terminal panels. Moved out of panel.spec.ts by subject; the shared helpers (setup, newSession,
 * openGrid) are in fixtures/panel.ts.
 */

/*
 * ── Frequently used commands (#44 → moved into a dialog in #60) ──────────────────────────
 *
 * Registering, running, deleting, and the log all live in one dialog. This is a run path separate
 * from the terminal tab: one process per command, one log of the last run. What is checked here is
 * **which project a command goes to** and **whether the log persists as promised**.
 */

/** The mock's run ledger — which command of which project ran, or is running */
async function commandRuns(page: Page): Promise<{ key: string; running: boolean; history: string }[]> {
  return page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    return [...m.commandRuns.entries()].map(([key, r]: [string, any]) => ({
      key,
      running: r.running,
      history: r.history,
    }))
  })
}

test('the run dialog: register → select → run streams the log, and finishing leaves the exit code', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm test')
  await page.getByTestId('run-add').click()
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm test')

  // Selecting is not running — there is a separate run button (#60 design)
  await page.getByTestId('run-command-0').click()
  expect(await commandRuns(page)).toEqual([])
  await page.getByTestId('run-exec').click()

  // A running indicator + the log stream
  await expect(page.getByTestId('run-running-0')).toBeVisible()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm test', '3 tests passed\r\n')
  })
  await expect(page.getByTestId('run-log')).toContainText('3 tests passed')

  // The ending of a one-off run: finishing leaves the exit code as a badge
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm test', 0)
  })
  await expect(page.getByTestId('run-exit-0')).toContainText('exit 0')

  // The log survives closing and reopening the dialog — until the same command is run again (user decision)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await expect(page.getByTestId('run-log')).toContainText('3 tests passed')

  // Rerunning replaces the log — the old log must not mix in ahead of the new run
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-log')).not.toContainText('3 tests passed')
  await expect(page.getByTestId('run-running-0')).toBeVisible()
})

test('the run dialog: a dev server is stopped with Stop, and its log is kept', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm dev', 'Server listening on 5173\r\n')
  })
  await expect(page.getByTestId('run-log')).toContainText('5173')

  await page.getByTestId('run-stop').click()
  // Stopping clears the running indicator, and the log stays — stopping is a result too
  await expect(page.getByTestId('run-exit-0')).toBeVisible()
  await expect(page.getByTestId('run-log')).toContainText('5173')
})

/**
 * Makes every following read of a command's stored log wait until `failLogReads` rejects it — a read that timed
 * out, or a connection that dropped mid-reconnect. A view holds live output until that read answers.
 */
async function holdLogReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __logReads: ((e: Error) => void)[] }
    w.__logReads = []
    w.__mock.commands.log = () => new Promise((_resolve, reject) => w.__logReads.push(reject))
  })
}

async function failLogReads(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as never as { __logReads: unknown[] }).__logReads.length)).toBeGreaterThan(0)
  await page.evaluate(() => {
    for (const reject of (window as never as { __logReads: ((e: Error) => void)[] }).__logReads) reject(new Error('timed out'))
  })
}

async function emitDevOutput(page: Page, data: string): Promise<void> {
  await page.evaluate((d: string) => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm dev', d)
  }, data)
}

test('the run dialog: output still shows when the stored log cannot be read, under a line saying so', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await holdLogReads(page)
  await page.getByTestId('run-exec').click()

  await emitDevOutput(page, 'Server listening on 5173\r\n')
  await failLogReads(page)
  await expect(page.getByTestId('run-log')).toContainText('5173')
  // A pane that starts mid-run says so, rather than passing for the whole log
  await expect(page.getByTestId('run-log')).toContainText('earlier output could not be read')
  await emitDevOutput(page, 'GET / 200\r\n')
  await expect(page.getByTestId('run-log')).toContainText('GET / 200')
})

test('the terminal panel: a running command\'s output still shows when its stored log cannot be read, under a line saying so', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-running-0')).toBeVisible()
  await page.keyboard.press('Escape')

  await holdLogReads(page)
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()
  await emitDevOutput(page, 'Server listening on 5173\r\n')
  await failLogReads(page)
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('5173')
  // A pane that starts mid-run says so, rather than passing for the whole log
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('earlier output could not be read')
  await emitDevOutput(page, 'GET / 200\r\n')
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('GET / 200')
})

test('the open button turns white while a command is running', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  const open = page.getByTestId('run-open')
  // `hover:text-ink` is always attached, so the check anchors on a word boundary — loose matching would always pass
  const lit = /(^|\s)text-ink(\s|$)/
  const dim = /(^|\s)text-ink-faint(\s|$)/
  await expect(open).toHaveClass(dim)

  await open.click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()

  // Closing the dialog leaves the fact that "it is running" showing in the header — the door doubles as an indicator light
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()
  await expect(open).toHaveClass(lit)
  await expect(open).toHaveAttribute('aria-label', /running/)

  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm dev', 0)
  })
  // Turns gray again once finished — leaving a finished command lit turns the indicator into decoration
  await expect(open).toHaveClass(dim)
  await expect(open).not.toHaveAttribute('aria-label', /running/)
})

test('the run dialog: a registered command survives closing and reopening the dialog', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm lint')
  await page.getByTestId('run-add').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()

  await page.getByTestId('run-open').click()
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm lint')
})

test('the run dialog: deleting targets something different from running — a running command that gets deleted cannot be undone', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  for (const cmd of ['pnpm test', 'pnpm lint']) {
    await page.getByTestId('run-add-input').fill(cmd)
    await page.getByTestId('run-add').click()
  }
  await expect(page.getByTestId('run-command-1')).toContainText('pnpm lint')

  await page.getByTestId('run-delete-0').click()

  // What remains moves up — the deleted spot must not stay as an empty row
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm lint')
  await expect(page.getByTestId('run-command-1')).toBeHidden()
  // And nothing was running
  expect(await commandRuns(page)).toEqual([])
})

/**
 * Does a grid panel's run button send its command to **that panel's project**.
 *
 * If it were keyed off whichever terminal happened to be on screen, this is where it would
 * diverge: the grid has no evidence rail at all, and the project last looked at is alpha. A
 * command must go to wherever the clicked panel's session lives.
 */
test('the run dialog: a command goes to the clicked panel\'s project — not whichever project was viewed last', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    await (window as never as { __store: any }).__store.getState().addProject('/tmp/beta')
  })
  const alpha = await newSession(page, 'alpha', 'claude', 'alpha task')
  const beta = await newSession(page, 'beta', 'claude', 'beta task')

  // Register a command on the beta session
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm build')
  await page.getByTestId('run-add').click()
  await page.keyboard.press('Escape')

  // Set the screen to be looking at alpha, then go to the grid
  await page.evaluate(
    (id: string) => (window as never as { __store: any }).__store.getState().focusSession(id),
    alpha,
  )
  await openGrid(page, [alpha, beta])
  await expect(page.getByTestId(`grid-panel-${beta}`)).toBeVisible()

  await page.getByTestId(`grid-panel-${beta}`).getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()

  // It was recorded as beta's — the log is also visible inside that panel, so there is no need to switch screens (#60)
  const runs = await commandRuns(page)
  expect(runs).toHaveLength(1)
  const betaProjectId = await page.evaluate(() => {
    const s = (window as never as { __store: any }).__store.getState()
    return (Object.values(s.projects) as { id: string; path: string }[]).find((p) => p.path === '/tmp/beta')!
      .id
  })
  expect(runs[0]!.key.startsWith(betaProjectId)).toBe(true)
})

test('the run dialog: absent from the orchestrator — with no project there is no directory to run in', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  await expect(page.getByTestId('run-open')).toBeVisible()
  // The status dot is retired from the header, and the fact that it is responding is carried by the grid border and sidebar instead.
  await expect(page.getByTestId('dot-idle')).toHaveCount(0)

  await page.evaluate(async () => {
    const st = (window as never as { __store: any }).__store.getState()
    await st.openOrchestrator() // Opens only the screen — no session is created (#63)
    await st.askOrchestrator('hello') // The first question creates the session
  })
  await expect(page.getByTestId('session-name')).toContainText('Orchestrator')
  await expect(page.getByTestId('session-header-crown')).toBeVisible()
  // A menu that opens to nothing that can go into it is more honest absent than empty
  await expect(page.getByTestId('run-open')).toBeHidden()
})

test('command aliases: the name leads and the command backs it up — in the list, the selected-run row, and the terminal panel (2026-09-06)', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add-name').fill('Dev server')
  await page.getByTestId('run-add').click()
  // Wherever the name is shown, the command shows alongside it — this prevents the name from silently drifting to mean a different command
  await expect(page.getByTestId('run-command-0')).toContainText('Dev server')
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm dev')

  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-selected')).toContainText('Dev server · pnpm dev')
  await page.keyboard.press('Escape')

  // Both show in the command terminal of the terminal panel too
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('Dev server')
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('pnpm dev')

  // Editing the alias — using the button that appears on hover, saved with Enter
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').hover()
  await page.getByTestId('run-rename-0').click()
  await page.getByTestId('run-rename-input-0').fill('Local server')
  await page.getByTestId('run-rename-input-0').press('Enter')
  await expect(page.getByTestId('run-command-0')).toContainText('Local server')
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm dev')
})

/*
 * ── The terminal panel projection of a running command (#60's final form, user decision 2026-09-06) ──
 *
 * Closing the dialog — or taking a panel down from the grid — must still leave a running command
 * standing as one terminal in the terminal panel. And once it finishes for any reason (a clean
 * exit, a crash, or Stop), that terminal **goes down**: this is the place for "what is running
 * right now," and the run dialog is the source of truth for past logs.
 */

test('a running command shows as a terminal in the terminal panel — and goes down for any reason it finishes', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  // Start a dev server from the run dialog and close the dialog
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-running-0')).toBeVisible()
  await page.keyboard.press('Escape')

  // Terminal tab: a command terminal stands next to the shell, the log streams, and a dot stays on the tab
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()
  await expect(page.getByTestId('terminal-tab-running')).toBeVisible()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm dev', 'Server listening on 5173\r\n')
  })
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('5173')

  // Collapsing the panel does not collapse "it is running" — clicking the dot reopens it
  await page.getByTestId('evidence-close').click()
  await expect(page.getByTestId('evidence-rail-running')).toBeVisible()
  await page.getByTestId('evidence-rail-running').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()

  // A crash — the terminal goes down and the badge clears too. The log survives in the run dialog
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm dev', 1)
  })
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeHidden()
  await expect(page.getByTestId('terminal-tab-running')).toBeHidden()

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await expect(page.getByTestId('run-exit-0')).toContainText('exit 1')
  await expect(page.getByTestId('run-log')).toContainText('5173')
})

test('the × on a command terminal means stop — the resulting exit takes the terminal down and the shell survives', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await page.keyboard.press('Escape')

  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()
  await page.getByTestId('cmd-term-stop-pnpm dev').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeHidden()

  // Only the command panel goes down — the shell terminal survives untouched
  const shells = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-mock-term-"]')
  await expect(shells.first()).toBeVisible()
})
