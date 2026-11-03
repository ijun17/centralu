import { expect, test, type Page } from '@playwright/test'
import { setup } from './control.js'
import { addOn, link } from './sidebar-machines.js'

/**
 * A linked machine whose host an update restarted (#1902): its terminals begin again at 1 and its Run commands start with new
 * run ids, while the window (the hub's) stays connected to this computer's host and is told only by the machine's
 * `machine_resync`. The panel has to read both again: an old tab must never be left drawing another shell under its name, and the
 * Run panel must show the run that is running now with the line saying why it started. On the mock platform, which is told
 * what the machine's host holds; the link itself is exercised against real hosts elsewhere. A function, because it runs in
 * Chromium and in WebKit: the desktop app is WKWebView.
 */

type MockWindow = { __mock: any; __store: any }

const CWD = '/srv/app'


/** A linked machine with a project at CWD, which the window has focused with its panel open on the terminal tab */
async function openRemoteTerminal(page: Page): Promise<string> {
  await setup(page, { projects: ['/tmp/alpha'] })
  const machine = await link(page, 'Box')
  await addOn(page, machine, CWD)
  const projectId = await page.evaluate((cwd) => {
    const s = (window as unknown as MockWindow).__store
    const projects = s.getState().projects as Record<string, { id: string; path: string }>
    return Object.values(projects).find((p) => p.path === cwd)!.id
  }, CWD)
  await page.evaluate((id) => {
    const w = window as unknown as MockWindow
    w.__mock.terminalState.byCwd.set('/srv/app', [{ id: 'box.term-2', title: 'Terminal 1', history: 'old one> ', alive: true }, { id: 'box.term-3', title: 'Terminal 2', history: 'old two> ', alive: true }])
    w.__store.getState().focusProject(id)
    w.__store.getState().togglePanel(true)
  }, projectId)
  await page.getByTestId('evidence-tab-terminal').click()
  return projectId
}

export function updateResyncTests(): void {
  test('a machine whose host was updated: the terminal tabs are read again, and none is left over another shell', async ({ page }) => {
    await openRemoteTerminal(page)
    const surfaces = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-surface-"]')
    await expect(surfaces).toHaveCount(2)
    await expect(page.getByTestId('terminal-surface-box.term-2')).toBeVisible()
    await expect(page.getByTestId('terminal-surface-box.term-3')).toBeVisible()

    // The update: the machine's host starts over and reopens two shells, numbered from 1 again; the window hears the machine's resync
    await page.evaluate(() => {
      const w = window as unknown as MockWindow
      w.__mock.terminalState.byCwd.set('/srv/app', [{ id: 'box.term-1', title: 'Terminal 1', history: 'new one> ', alive: true }, { id: 'box.term-2', title: 'Terminal 2', history: 'new two> ', alive: true }])
      w.__mock.emit({ type: 'machine_resync', machineId: 'box' })
    })

    // Both are the new host's, each on its own tab: the one with the id that was not there before is no longer invisible, and the old third is gone
    await expect(page.getByTestId('terminal-surface-box.term-1')).toBeVisible()
    await expect(page.getByTestId('terminal-surface-box.term-3')).toHaveCount(0)
    await expect(surfaces).toHaveCount(2)
    // What a tab shows is the new shell's screen, not the old one's
    await expect(page.getByTestId('terminal-surface-box.term-2')).toContainText('new two>')
    await expect(page.getByTestId('terminal-surface-box.term-1')).toContainText('new one>')
  })

  test('a machine that was not the one updated leaves this machine’s tabs as they are', async ({ page }) => {
    await openRemoteTerminal(page)
    await expect(page.getByTestId('terminal-surface-box.term-3')).toBeVisible()
    await page.evaluate(() => (window as unknown as MockWindow).__mock.emit({ type: 'machine_resync', machineId: 'other' }))
    // The views are the same ones: still the old text, nothing mounted again
    await expect(page.getByTestId('terminal-surface-box.term-3')).toContainText('old two>')
    expect(await page.evaluate(() => (window as unknown as MockWindow).__store.getState().machineResyncs)).toEqual({ other: 1 })
  })

  test('a Run command the update started again shows in the open Run panel, with the line saying why', async ({ page }) => {
    const projectId = await openRemoteTerminal(page)
    await page.evaluate(async (id) => (window as unknown as MockWindow).__mock.commands.run(id, 'pnpm dev', 100, 30), projectId)
    await page.evaluate((id) => (window as unknown as MockWindow).__store.getState().loadCommandRuns(id), projectId)
    await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()
    const was = await page.evaluate((id) => (window as unknown as MockWindow).__store.getState().commandRuns[id]['pnpm dev'].runId as string, projectId)
    await expect(page.getByTestId(`cmd-log-surface-${was}`)).toBeVisible()

    // The update: the machine's host starts the run again, a new run whose log opens with the line
    const now = await page.evaluate(async (id) => {
      const mock = (window as unknown as MockWindow).__mock
      const run = (await mock.commands.run(id, 'pnpm dev', 100, 30)) as { runId: string }
      mock.commandRuns.get(`${id}\u0000pnpm dev`).history = 'Started again after the update.\r\nready\r\n'
      mock.emit({ type: 'machine_resync', machineId: 'box' })
      return run.runId
    }, projectId)
    expect(now).not.toBe(was)

    await expect(page.getByTestId(`cmd-log-surface-${now}`)).toBeVisible()
    await expect(page.getByTestId(`cmd-log-surface-${was}`)).toHaveCount(0)
    await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('Started again after the update.')
  })
}
