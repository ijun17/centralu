import { expect, test, type Page } from '@playwright/test'
import { setup } from './control.js'
import { openSessionDialog } from './new-session.js'

/**
 * Phase 2 of linked machines on the mock platform (#82, docs/plans/remote-hub.md §6): usage gauges per machine, and
 * opening a linked machine's project in VS Code over Remote-SSH. The link itself is exercised against two real hosts in
 * `linked-hosts*.ts`; what is asked here is what the screen does with the machines it is told about. A function,
 * because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 */

type MockWindow = { __mock: any; __store: any }

const WEEKLY = (percent: number) => ({
  supported: true,
  usage: { plan: 'max', windows: [{ id: 'weekly_all', label: 'Weekly', percent, resetsAt: null, scope: null }], daily: [] },
})

/** Links a mock machine: it stands as connected at once and its `machine_status` reaches the store */
async function link(page: Page, spec: { name: string; sshTarget: string; shell?: 'posix' | 'powershell' | 'wsl' }): Promise<void> {
  await page.evaluate((s) => (window as unknown as MockWindow).__mock.machines.add({ shell: 'posix', ...s }), spec)
}

/** Moves a mock machine's link to another state, as the hub's `machine_status` does */
async function setMachine(page: Page, id: string, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(([i, p]) => (window as unknown as MockWindow).__mock.machineRow(i, p), [id, patch] as const)
}

/** The host connection dropping and coming back: the moment every machine is asked again */
async function reconnectHost(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
  await expect(page.getByTestId('connection')).toBeVisible()
  await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
  await expect(page.getByTestId('connection')).toHaveCount(0)
}

async function usageCalls(page: Page, machine: string | null): Promise<number> {
  return page.evaluate(
    (m) => ((window as unknown as MockWindow).__mock.usageCalls as { machine: string | null }[]).filter((c) => c.machine === m).length,
    machine,
  )
}

export function remoteMachineToolsTests(): void {
  test.describe('usage per machine (#82)', () => {
    test('each connected machine gets its own donuts after this computer, and a machine that is away is left out, not asked', async ({ page }) => {
      await page.clock.install()
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate((w) => {
        const m = (window as unknown as MockWindow).__mock
        m.usageState = w.here
        m.machineUsage = { box: w.box, laptop: w.laptop }
      }, { here: WEEKLY(12), box: WEEKLY(61), laptop: WEEKLY(88) })
      await reconnectHost(page)
      // Before any machine: the bar is as it always was, with no machine group
      await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
      await expect(page.locator('[data-testid^="usage-machine-"]')).toHaveCount(0)

      await link(page, { name: 'Box', sshTarget: 'me@box' })
      await link(page, { name: 'Laptop', sshTarget: 'laptop' })
      await setMachine(page, 'laptop', { status: 'unreachable' })

      await test.step('this computer first, then each machine behind its name', async () => {
        const box = page.getByTestId('usage-machine-box')
        await expect(box).toHaveAttribute('data-status', 'connected')
        await expect(box).toContainText('Box')
        await expect(page.getByTestId('usage-donut-box.claude')).toHaveAttribute('data-percent', '61')
        await expect(page.getByTestId('usage-donut-claude')).toHaveAttribute('data-percent', '12')
        const here = (await page.getByTestId('usage-donut-claude').boundingBox())!
        const there = (await page.getByTestId('usage-donut-box.claude').boundingBox())!
        expect(here.x).toBeLessThan(there.x)
        await expect(page.getByTestId('usage-donut-box.claude')).toHaveAttribute('aria-label', /on Box/)
      })

      /*
       * Only a machine with a tool that can run there shows (owner, 2026-10-18): one that is not connected is left out,
       * not drawn as "away"; Settings → Machines still lists it with its state
       */
      await test.step('a machine that is away is left out, and is never asked', async () => {
        await expect(page.getByTestId('usage-machine-box')).toBeVisible()
        await expect(page.getByTestId('usage-machine-laptop')).toHaveCount(0)
        await expect(page.getByTestId('usage-machine-state-laptop')).toHaveCount(0)
        await expect(page.locator('[data-testid^="usage-donut-laptop."]')).toHaveCount(0)
      })

      await test.step('the 5-minute refresh asks this computer and every connected machine again, and still not the away one', async () => {
        const here = await usageCalls(page, null)
        const box = await usageCalls(page, 'box')
        const laptopBefore = await usageCalls(page, 'laptop')
        await page.clock.fastForward('05:01')
        await expect.poll(() => usageCalls(page, null)).toBeGreaterThan(here)
        await expect.poll(() => usageCalls(page, 'box')).toBeGreaterThan(box)
        // Laptop was connected for the moment between being linked and going away, so it may have been asked then; never since
        expect(await usageCalls(page, 'laptop')).toBe(laptopBefore)
      })

      await test.step('a machine whose link comes back is asked then, not at the next tick', async () => {
        const before = await usageCalls(page, 'laptop')
        await setMachine(page, 'laptop', { status: 'connected' })
        await expect.poll(() => usageCalls(page, 'laptop')).toBeGreaterThan(before)
        // Connected again, it is back in the bar
        await expect(page.getByTestId('usage-machine-laptop')).toBeVisible()
        await expect(page.getByTestId('usage-donut-laptop.claude')).toHaveAttribute('data-percent', '88')
      })

      await test.step("a machine's donut opens that machine's detail", async () => {
        await page.getByTestId('usage-donut-box.claude').click()
        const drop = page.getByTestId('usage-drop')
        await expect(drop).toHaveAttribute('data-machine', 'box')
        await expect(page.getByTestId('usage-drop-machine')).toHaveText('on Box')
        await expect(page.getByTestId('usage-window-weekly_all')).toContainText('61%')
        // Switching to this computer's donut is one click, and its detail is this computer's
        await page.getByTestId('usage-donut-claude').click()
        await expect(drop).not.toHaveAttribute('data-machine', /.+/)
        await expect(page.getByTestId('usage-drop-machine')).toHaveCount(0)
        await expect(page.getByTestId('usage-window-weekly_all')).toContainText('12%')
        await page.keyboard.press('Escape')
        await expect(drop).toBeHidden()
      })
    })

    test('a machine logged in to the same account says so, and one that cannot be read gives its reason, not a blank meter (#726)', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate((w) => {
        const m = (window as unknown as MockWindow).__mock
        m.usageState = w.here
        m.machineUsage = {
          box: { ...w.here, sameAccountAsHub: true },
          laptop: { supported: false, reason: 'Claude Code is not logged in on this computer', usage: null },
        }
      }, { here: WEEKLY(12) })
      await link(page, { name: 'Box', sshTarget: 'me@box' })
      await link(page, { name: 'Laptop', sshTarget: 'laptop' })

      await test.step('the donut and its detail say whose numbers they are', async () => {
        await expect(page.getByTestId('usage-donut-box.claude')).toHaveAttribute('data-percent', '12')
        await page.getByTestId('usage-donut-box.claude').hover()
        await expect(page.getByTestId('usage-donut-same-box.claude')).toHaveText('Same account as this computer')
        await page.getByTestId('usage-donut-box.claude').click()
        await expect(page.getByTestId('usage-same-account')).toHaveText('Same account as this computer')
        await expect(page.getByTestId('usage-window-weekly_all')).toContainText('12%')
        await page.keyboard.press('Escape')
        // This computer's own detail does not carry the label
        await page.getByTestId('usage-donut-claude').click()
        await expect(page.getByTestId('usage-window-weekly_all')).toBeVisible()
        await expect(page.getByTestId('usage-same-account')).toHaveCount(0)
        await page.keyboard.press('Escape')
      })

      await test.step('a machine whose limits cannot be read says why in one line', async () => {
        await expect(page.getByTestId('usage-donut-laptop.claude')).toHaveAttribute('data-percent', '')
        await page.getByTestId('usage-donut-laptop.claude').hover()
        await expect(page.getByTestId('usage-donut-reason-laptop.claude')).toHaveText('Claude Code is not logged in on this computer')
        await page.getByTestId('usage-donut-laptop.claude').click()
        await expect(page.getByTestId('usage-unavailable')).toContainText('Claude Code is not logged in on this computer')
      })
    })

    test('a hidden window is not polled, a tool that is not logged in is not asked, and the window in view again is asked at once (#726)', async ({ page }) => {
      await page.clock.install()
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        // Codex is installed but signed out here: it has no limits to read, and reading it could start a process
        m.detected = m.detected.map((t: any) => (t.name === 'codex' ? { ...t, installed: true, loggedIn: false } : t))
        // Only what is asked from here on: the first load, before codex was signed out, asked it too
        m.usageCalls.length = 0
      })
      await reconnectHost(page)
      await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
      const tools = () =>
        page.evaluate(() => [...new Set(((window as unknown as MockWindow).__mock.usageCalls as { tool: string }[]).map((c) => c.tool))])
      expect(await tools()).toEqual(['claude'])

      const hide = (hidden: boolean) =>
        page.evaluate((h) => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
          document.dispatchEvent(new Event('visibilitychange'))
        }, hidden)
      await hide(true)
      const before = await usageCalls(page, null)
      await page.clock.fastForward('10:01')
      expect(await usageCalls(page, null)).toBe(before)

      await hide(false)
      await expect.poll(() => usageCalls(page, null)).toBeGreaterThan(before)
    })

    test('a machine with no usable agent is left out, and this computer with none keeps its mark beside the machines', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.machineDetected = { box: [] }
        // Which machines were asked, so the absence below is read after the answer, not before the question
        const real = m.agents.detect.bind(m.agents)
        m.asked = []
        m.agents.detect = async (machine?: string) => {
          const out = await real(machine)
          m.asked.push(machine ?? null)
          return out
        }
      })
      await link(page, { name: 'Box', sshTarget: 'me@box' })
      // Asked, and nothing there can run: no group, no "No agent" words (owner, 2026-10-18)
      await expect.poll(() => page.evaluate(() => (window as unknown as MockWindow).__mock.asked.includes('box'))).toBe(true)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
      await expect(page.getByTestId('usage-machine-box')).toHaveCount(0)
      await expect(page.getByTestId('usage-machine-no-agent-box')).toHaveCount(0)

      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        const claude = m.detected.find((t: any) => t.name === 'claude')
        m.machineDetected = { box: [claude] }
        m.detected = [{ ...claude, loggedIn: false }]
      })
      await reconnectHost(page)
      // This computer with no tool keeps its local No agent mark, the machine its donuts
      await expect(page.getByTestId('usage-no-agent')).toBeVisible()
      await expect(page.getByTestId('usage-machine-box')).toBeVisible()
      await expect(page.getByTestId('usage-donut-box.claude')).toBeVisible()
      await expect(page.getByTestId('usage-donut-claude')).toHaveCount(0)
    })
  })

  test.describe('open a linked machine project in VS Code over Remote-SSH (#82)', () => {
    async function remoteProject(page: Page, spec: { name: string; sshTarget: string; shell?: 'posix' | 'powershell' | 'wsl' }, path: string) {
      await link(page, spec)
      const id = spec.name.toLowerCase()
      await page.getByTestId('add-project').click()
      await page.getByTestId(`add-project-on-${id}`).click()
      await page.getByTestId('add-remote-project-path').fill(path)
      await page.getByTestId('add-remote-project-confirm').click()
      await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
    }

    async function openSession(page: Page, project: string) {
      await openSessionDialog(page, project)
      await page.getByTestId('tool-option-claude').click()
      await page.getByTestId('create-session-confirm').click()
      await expect(page.getByTestId('new-session-dialog')).toBeHidden()
      await page.getByTestId('prompt-input').fill('look around')
      await page.getByTestId('prompt-input').press('Enter')
    }

    const opened = (page: Page) => page.evaluate(() => (window as unknown as MockWindow).__mock.openedUrls as string[])

    test('the project, a folder, a file and a diff line each open on the machine; nothing opens on this computer', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.fsState.entries[''] = [{ name: 'src', path: 'src', isDir: true, ignored: false }]
        m.fsState.entries['src'] = [{ name: 'a b.ts', path: 'src/a b.ts', isDir: false, ignored: false }]
        m.gitState.files = [{ path: 'src/a b.ts', staged: false, status: 'M' }]
        m.gitState.diffs['src/a b.ts'] = '@@ -1 +1 @@\n-old()\n+next()'
      })
      await remoteProject(page, { name: 'Box', sshTarget: 'me@box' }, '/home/me/proj')
      await openSession(page, 'proj')

      await test.step('the project itself, from its menu in the sidebar', async () => {
        await page.getByTestId('project-menu-proj').click()
        await page.getByTestId('open-vscode-proj').click()
        await expect.poll(() => opened(page)).toEqual(['vscode://vscode-remote/ssh-remote+me@box/home/me/proj'])
        // This computer's projects keep their own actions and get no Remote-SSH entry
        await page.getByTestId('project-menu-alpha').click()
        await expect(page.getByTestId('new-session-alpha')).toBeVisible()
        await expect(page.getByTestId('open-vscode-alpha')).toHaveCount(0)
        await page.keyboard.press('Escape')
        await page.getByTestId('evidence-tab-files').click()
      })

      await test.step("a folder and a file from the row menu, which has no Finder or Trash for another machine's files", async () => {
        await page.getByTestId('dir-src').click({ button: 'right' })
        await expect(page.getByTestId('file-menu-reveal')).toHaveCount(0)
        await expect(page.getByTestId('file-menu-trash')).toHaveCount(0)
        await page.getByTestId('file-menu-vscode').click()
        await page.getByTestId('dir-src').click()
        await page.getByTestId('file-src/a b.ts').click({ button: 'right' })
        await page.getByTestId('file-menu-vscode').click()
        await expect.poll(() => opened(page)).toEqual([
          'vscode://vscode-remote/ssh-remote+me@box/home/me/proj',
          'vscode://vscode-remote/ssh-remote+me@box/home/me/proj/src',
          'vscode://vscode-remote/ssh-remote+me@box/home/me/proj/src/a%20b.ts:1',
        ])
      })

      await test.step('the viewer and the diff open the file, the diff at its line', async () => {
        await page.getByTestId('file-src/a b.ts').click()
        await expect(page.getByTestId('viewer-open-ide')).toHaveText('Open in VS Code')
        await page.getByTestId('viewer-open-ide').click()
        await expect.poll(async () => (await opened(page)).at(-1)).toBe('vscode://vscode-remote/ssh-remote+me@box/home/me/proj/src/a%20b.ts:1')
        await page.keyboard.press('Escape')

        await page.getByTestId('evidence-tab-git').click()
        await page.getByTestId('evidence-file-src/a b.ts').click()
        await expect(page.getByTestId('open-in-ide')).toHaveText('Open in VS Code')
        await expect(page.getByTestId('open-in-ide')).toHaveAttribute('title', /Box.*Remote-SSH.*me@box/)
        const before = (await opened(page)).length
        await page.getByTestId('open-in-ide').click()
        await expect.poll(async () => (await opened(page)).length).toBe(before + 1)
        expect((await opened(page)).at(-1)).toBe('vscode://vscode-remote/ssh-remote+me@box/home/me/proj/src/a%20b.ts:1')
      })

      // This computer's IDE was never handed the other machine's path
      expect(await page.evaluate(() => (window as unknown as MockWindow).__mock.opened)).toEqual([])
    })

    test('a WSL machine offers nothing: Remote-SSH reaches the Windows side, not the distro', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.fsState.entries[''] = [{ name: 'a.ts', path: 'a.ts', isDir: false, ignored: false }]
      })
      await remoteProject(page, { name: 'Box', sshTarget: 'me@box' }, '/home/me/proj')
      await openSession(page, 'proj')
      await page.getByTestId('evidence-tab-files').click()
      await page.getByTestId('file-a.ts').click({ button: 'right' })
      await expect(page.getByTestId('file-menu-vscode')).toBeVisible()
      await page.keyboard.press('Escape')

      await setMachine(page, 'box', { shell: 'wsl', wslDistro: 'Ubuntu' })
      await page.getByTestId('project-menu-proj').click()
      await expect(page.getByTestId('new-session-proj')).toBeVisible()
      await expect(page.getByTestId('open-vscode-proj')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await page.getByTestId('file-a.ts').click({ button: 'right' })
      await expect(page.getByTestId('file-menu')).toHaveCount(0)
    })
  })
}
