import { expect, test, type Page } from '@playwright/test'
import { setup } from './project-screen.js'

/**
 * Settings → Machines → Add a machine from the ssh config (#514), against the mock: the hosts of
 * `~/.ssh/config` are listed, picking one probes it, and the rows it offers link it with the right
 * shell without typing. The host's side (the config read as OpenSSH reads it, the probe's one
 * command) is links/ssh-config.test.ts and links/probe.test.ts. A function, because it runs in
 * Chromium and in WebKit: the desktop app is WKWebView.
 */

/** What the mock's host "reads" in ~/.ssh/config, and what each host answers to the probe */
export async function seedSshConfig(page: Page): Promise<void> {
  await page.evaluate(() => {
    const mock = (window as any).__mock
    mock.sshConfig = {
      configFile: '~/.ssh/config',
      hosts: [
        { alias: 'ijun1', hostName: 'jun.example.ts.net', user: 'ijun1', port: 38222, source: '~/.ssh/config:4', linked: [] },
        { alias: 'build-box', hostName: '10.0.0.5', user: 'me', port: 22, source: '~/.ssh/config.d/work:1', linked: [] },
        { alias: 'lab', hostName: 'lab.internal', user: null, port: 22, source: '~/.ssh/config.d/work:7', linked: [] },
      ],
      notes: ['A Match block (~/.ssh/config:12) is not listed; ssh still applies it'],
    }
    mock.probeAnswers = {
      ijun1: { reachable: true, os: 'windows', windowsShell: 'cmd', wslDistros: [{ name: 'Ubuntu', default: true }], error: null },
      'build-box': { reachable: true, os: 'posix', windowsShell: null, wslDistros: [], error: null },
    }
  })
}

async function openMachines(page: Page): Promise<void> {
  await setup(page, ['/tmp/alpha'])
  await seedSshConfig(page)
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-machines').click()
  await expect(page.getByTestId('machines-add-hosts')).toBeVisible()
}

export function sshHostsTests(): void {
  test('lists the ssh config’s hosts and links a Windows PC and its WSL distro without typing', async ({ page }) => {
    await openMachines(page)

    await test.step('the hosts, what ssh resolves them to, and what was left out', async () => {
      await expect(page.getByTestId('machines-add-host-ijun1')).toContainText('ijun1@jun.example.ts.net:38222')
      await expect(page.getByTestId('machines-add-host-build-box')).toContainText('me@10.0.0.5')
      await expect(page.getByTestId('machines-add-notes')).toContainText('Match block')
      // Nothing is asked of a host until it is picked
      await expect(page.getByTestId('machines-add-probe')).toHaveCount(0)
      await expect(page.getByTestId('machines-add-confirm')).toBeDisabled()
    })

    await test.step('picking one probes it: Windows under cmd.exe, and WSL (Ubuntu), Windows chosen and named', async () => {
      await page.getByTestId('machines-add-host-ijun1').click()
      await expect(page.getByTestId('machines-add-choice-windows')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('machines-add-choice-windows')).toContainText('cmd.exe answers ssh')
      await expect(page.getByTestId('machines-add-choice-wsl:Ubuntu')).toContainText('The default distro')
      await expect(page.getByTestId('machines-add-name')).toHaveValue('ijun1')
      await page.getByTestId('machines-add-confirm').click()
      await expect(page.getByTestId('machines-add-form')).toHaveCount(0)
      await expect(page.getByTestId('machine-row-ijun1')).toContainText('ijun1 · Windows')
    })

    await test.step('opened again: the host says it is linked, Windows is not offered again, WSL is', async () => {
      await page.getByTestId('machines-add-open').click()
      await expect(page.getByTestId('machines-add-host-linked-ijun1')).toHaveText('linked as ijun1')
      await page.getByTestId('machines-add-host-ijun1').click()
      await expect(page.getByTestId('machines-add-choice-windows')).toBeDisabled()
      await expect(page.getByTestId('machines-add-choice-windows')).toContainText('Linked as ijun1')
      await expect(page.getByTestId('machines-add-choice-wsl:Ubuntu')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('machines-add-name')).toHaveValue('ijun1 Ubuntu')
      await page.getByTestId('machines-add-confirm').click()
      await expect(page.getByTestId('machine-row-ijun1-ubuntu')).toContainText('ijun1 · WSL on Windows · Ubuntu')
    })
  })

  test('says why a host could not be asked, and the target can still be typed', async ({ page }) => {
    await openMachines(page)
    await page.getByTestId('machines-add-host-lab').click()
    await expect(page.getByTestId('machines-add-probe-problem')).toContainText('The name lab does not resolve to a machine')
    await expect(page.getByTestId('machines-add-choices')).toHaveCount(0)
    await expect(page.getByTestId('machines-add-confirm')).toBeDisabled()

    await page.getByTestId('machines-add-by-hand').click()
    await expect(page.getByTestId('machines-add-target')).toHaveValue('lab')
    await expect(page.getByTestId('machines-add-name')).toHaveValue('lab')
    await page.getByTestId('machines-add-target').fill('me@lab.example.com')
    await page.getByTestId('machines-add-confirm').click()
    await expect(page.getByTestId('machine-row-lab')).toContainText('me@lab.example.com · Linux or macOS')
  })

  test('a probe that answers after another host was picked does not take over the dialog', async ({ page }) => {
    await openMachines(page)
    // ijun1's answer is held back until build-box has been picked and has answered
    await page.evaluate(() => {
      const mock = (window as any).__mock
      const real = mock.machines.probe
      const w = window as any
      w.__releaseIjun1 = null
      mock.machines.probe = async (target: string) => {
        if (target === 'ijun1') await new Promise<void>((r) => (w.__releaseIjun1 = r))
        return real(target)
      }
    })
    await page.getByTestId('machines-add-host-ijun1').click()
    await expect(page.getByTestId('machines-add-probing')).toContainText('ijun1')
    await page.getByTestId('machines-add-host-build-box').click()
    await expect(page.getByTestId('machines-add-choice-posix')).toHaveAttribute('aria-checked', 'true')
    await page.evaluate(() => (window as any).__releaseIjun1())
    // Long enough for the held answer to land, were it taken
    await page.waitForTimeout(200)
    await expect(page.getByTestId('machines-add-choice-windows')).toHaveCount(0)
    await expect(page.getByTestId('machines-add-choice-posix')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('machines-add-name')).toHaveValue('build-box')
    await page.getByTestId('machines-add-confirm').click()
    await expect(page.getByTestId('machine-row-build-box')).toContainText('build-box · Linux or macOS')
  })

  test('with no hosts in the config, the dialog asks for a target as before', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-machines').click()
    await expect(page.getByTestId('machines-add-no-hosts')).toContainText('No hosts in ~/.ssh/config')
    await expect(page.getByTestId('machines-add-hosts')).toHaveCount(0)
    await expect(page.getByTestId('machines-add-target')).toBeVisible()
  })
}
