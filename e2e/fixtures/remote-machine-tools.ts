import { expect, test, type Page } from '@playwright/test'

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

async function setup(page: Page): Promise<void> {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate(() => {
    ;(window as unknown as MockWindow).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-alpha')).toBeVisible()
}

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
    test('each connected machine gets its own donuts after this computer, and a machine that is away is named, not asked', async ({ page }) => {
      await page.clock.install()
      await setup(page)
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

      await test.step('a machine that is away says so, and is never asked', async () => {
        await expect(page.getByTestId('usage-machine-laptop')).toHaveAttribute('data-status', 'unreachable')
        await expect(page.getByTestId('usage-machine-state-laptop')).toHaveText('away')
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

    test('a machine with no usable agent says so in its group, and this computer with none still shows the machines', async ({ page }) => {
      await setup(page)
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.machineDetected = { box: [] }
      })
      await link(page, { name: 'Box', sshTarget: 'me@box' })
      await expect(page.getByTestId('usage-machine-no-agent-box')).toHaveText('No agent')

      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        const claude = m.detected.find((t: any) => t.name === 'claude')
        m.machineDetected = { box: [claude] }
        m.detected = [{ ...claude, loggedIn: false }]
      })
      await reconnectHost(page)
      await expect(page.getByTestId('usage-no-agent')).toBeVisible()
      await expect(page.getByTestId('usage-donut-box.claude')).toBeVisible()
      await expect(page.getByTestId('usage-donut-claude')).toHaveCount(0)
    })
  })

  test.describe('open a linked machine project in VS Code over Remote-SSH (#82)', () => {
    async function remoteProject(page: Page, spec: { name: string; sshTarget: string; shell?: 'posix' | 'powershell' | 'wsl' }, path: string) {
      await link(page, spec)
      const id = spec.name.toLowerCase()
      await page.getByTestId(`add-remote-project-${id}`).click()
      await page.getByTestId('add-remote-project-path').fill(path)
      await page.getByTestId('add-remote-project-confirm').click()
      await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
    }

    async function openSession(page: Page, project: string) {
      await page.getByTestId(`project-menu-${project}`).click()
      await page.getByTestId(`new-session-${project}`).click()
      await page.getByTestId('tool-option-claude').click()
      await page.getByTestId('create-session-confirm').click()
      await expect(page.getByTestId('new-session-dialog')).toBeHidden()
      await page.getByTestId('prompt-input').fill('look around')
      await page.getByTestId('prompt-input').press('Enter')
    }

    const opened = (page: Page) => page.evaluate(() => (window as unknown as MockWindow).__mock.openedUrls as string[])

    test('the project, a folder, a file and a diff line each open on the machine; nothing opens on this computer', async ({ page }) => {
      await setup(page)
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.fsState.entries[''] = [{ name: 'src', path: 'src', isDir: true, ignored: false }]
        m.fsState.entries['src'] = [{ name: 'a b.ts', path: 'src/a b.ts', isDir: false, ignored: false }]
        m.gitState.files = [{ path: 'src/a b.ts', staged: false, status: 'M' }]
        m.gitState.diffs['src/a b.ts'] = '@@ -1 +1 @@\n-old()\n+next()'
      })
      await remoteProject(page, { name: 'Box', sshTarget: 'me@box' }, '/home/me/proj')
      await openSession(page, 'proj')

      await test.step('the project itself, from the file tree', async () => {
        await page.getByTestId('evidence-tab-files').click()
        await expect(page.getByTestId('file-tree-open-vscode')).toHaveText('Open in VS Code')
        await page.getByTestId('file-tree-open-vscode').click()
        await expect.poll(() => opened(page)).toEqual(['vscode://vscode-remote/ssh-remote+me@box/home/me/proj'])
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
      await setup(page)
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.fsState.entries[''] = [{ name: 'a.ts', path: 'a.ts', isDir: false, ignored: false }]
      })
      await remoteProject(page, { name: 'Box', sshTarget: 'me@box' }, '/home/me/proj')
      await openSession(page, 'proj')
      await page.getByTestId('evidence-tab-files').click()
      await expect(page.getByTestId('file-tree-open-vscode')).toBeVisible()

      await setMachine(page, 'box', { shell: 'wsl', wslDistro: 'Ubuntu' })
      await expect(page.getByTestId('file-tree-open-vscode')).toHaveCount(0)
      await page.getByTestId('file-a.ts').click({ button: 'right' })
      await expect(page.getByTestId('file-menu')).toHaveCount(0)
    })
  })
}
