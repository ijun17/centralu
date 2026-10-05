import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { APP_VERSION } from '../../packages/protocol/src/brand.js'
import { Relay } from './real-host.js'
import { LINKED_RELAY_PORT, MACHINE, restartRemote, startPair, type LinkedPair } from './linked-hosts.js'
import { hubCall } from './linked-hosts-scenarios.js'

/**
 * The linked-hosts UI of phase 1 (#82, docs/plans/remote-hub.md §7): the real web UI on a hub and a second host, each on
 * its own temporary data folder. Adding a machine goes through Settings → Machines with the manual endpoint
 * `direct:<port>` (linked-host-main.ts), the one thing that differs from an ssh link. A function, because it runs in
 * Chromium and in WebKit: the desktop app is WKWebView.
 */

type Machine = { id: string; name: string; status: string }

async function machines(pair: LinkedPair): Promise<Machine[]> {
  return (await hubCall(pair.hub.port, 'machines.list', {})) as Machine[]
}

/** Every RPC the page sends, by method, counted at the page's socket */
function watchCalls(page: Page): { method: string; params: Record<string, unknown> }[] {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const frame = JSON.parse(String(f.payload)) as { kind?: string; method?: string; params?: Record<string, unknown> }
        if (frame.kind === 'rpc' && frame.method) calls.push({ method: frame.method, params: frame.params ?? {} })
      } catch {
        // Not JSON
      }
    }),
  )
  return calls
}

async function addMachine(page: Page, name: string, target: string): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-machines').click()
  const open = page.getByTestId('machines-add-open')
  if (await open.isVisible()) await open.click()
  await page.getByTestId('machines-add-name').fill(name)
  await page.getByTestId('machines-add-target').fill(target)
  await page.getByTestId('machines-add-confirm').click()
  await expect(page.getByTestId('machines-add-form')).toHaveCount(0)
}

async function send(page: Page, text: string) {
  await page.getByTestId('prompt-input').fill(text)
  await page.getByTestId('prompt-input').press('Enter')
}

async function withPair(opts: Parameters<typeof startPair>[0], body: (pair: LinkedPair, relay: Relay) => Promise<void>): Promise<void> {
  const pair = await startPair(opts)
  const relay = new Relay(() => pair.hub.port)
  try {
    await relay.listen(LINKED_RELAY_PORT)
    await body(pair, relay)
  } catch (err) {
    console.log(`--- hub stderr ---\n${pair.hub.stderr()}\n--- remote stderr ---\n${pair.remote.stderr()}`)
    throw err
  } finally {
    await relay.close()
    await pair.cleanup()
  }
}

export function linkedHostsUiTests(): void {
  test('a machine added in Settings: grouped in the sidebar, a session created, sent to and approved on it', async ({ page }) => {
    test.setTimeout(120_000)
    await withPair({ link: false }, async (pair) => {
      const calls = watchCalls(page)
      await page.goto('/')
      await expect(page.getByTestId('project-hub-project')).toBeVisible()
      // No machine yet: the list is as it always was, with no group headers
      await expect(page.getByTestId('machine-header-local')).toHaveCount(0)

      await test.step('add the machine in Settings → Machines', async () => {
        await addMachine(page, 'Remote box', `direct:${pair.remotePort}`)
        await expect(page.getByTestId('machine-row-remote-box')).toHaveAttribute('data-status', 'connected', { timeout: 15_000 })
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('settings')).toHaveCount(0)
      })

      await test.step('the sidebar groups by machine: this computer first, then the machine', async () => {
        const local = page.getByTestId('machine-header-local')
        const remote = page.getByTestId('machine-header-remote-box')
        await expect(local).toBeVisible()
        await expect(remote).toContainText('Remote box')
        await expect(page.getByTestId('machine-status-remote-box')).toHaveAttribute('data-status', 'connected')
        const group = page.getByTestId('machine-group-remote-box')
        await expect(group.getByTestId('project-remote-project')).toBeVisible()
        await expect(group.getByTestId('project-hub-project')).toHaveCount(0)
        expect((await local.boundingBox())!.y).toBeLessThan((await remote.boundingBox())!.y)
      })

      await test.step('add a folder on the machine as a project, by its path there', async () => {
        const folder = join(pair.remoteSide.dir, 'second-project')
        mkdirSync(folder)
        await page.getByTestId('add-remote-project-remote-box').click()
        await page.getByTestId('add-remote-project-path').fill(folder)
        await page.getByTestId('add-remote-project-confirm').click()
        await expect(page.getByTestId('machine-group-remote-box').getByTestId('project-second-project')).toBeVisible()
        expect(calls.find((c) => c.method === 'projects.add')?.params).toEqual({ path: folder, machine: 'remote-box' })
      })

      let id = ''
      await test.step('create a session there: the dialog asks that machine which agents it has', async () => {
        await page.getByTestId('project-menu-remote-project').click()
        await page.getByTestId('new-session-remote-project').click()
        await expect(page.getByTestId('new-session-machine')).toHaveText('Remote box')
        await expect.poll(() => calls.some((c) => c.method === 'agents.detect' && c.params.machine === 'remote-box')).toBe(true)
        await page.getByTestId('create-session-confirm').click()
        await expect(page.getByTestId('new-session-dialog')).toBeHidden()
        await expect
          .poll(async () => ((await hubCall(pair.hub.port, 'sessions.list', {})) as { id: string; machine?: string }[]).filter((s) => s.machine === 'remote-box'))
          .toHaveLength(1)
        id = ((await hubCall(pair.hub.port, 'sessions.list', {})) as { id: string; machine?: string }[]).find((s) => s.machine === 'remote-box')!.id
        await expect(page.getByTestId('machine-group-remote-box').getByTestId(`session-row-${id}`)).toBeVisible()
        await expect(page.getByTestId('session-machine')).toHaveText('Remote box')
      })

      await test.step('send, and the reply streams back', async () => {
        await send(page, 'hello there')
        await expect(page.getByTestId('chat-stream')).toContainText('echo: hello there')
      })

      await test.step('an approval waits in the inbox labelled with its machine, and is answered', async () => {
        await send(page, 'please approve this')
        await expect(page.getByTestId('approval-card')).toBeVisible()
        await page.getByTestId('counter').click()
        await expect(page.getByTestId(`inbox-machine-${id}`)).toHaveText('Remote box')
        await page.getByTestId(`inbox-item-${id}`).click()
        await page.getByTestId('approval-card').getByTestId('approve-allow').click()
        await expect(page.getByTestId('approval-card')).toBeHidden()
        await expect(page.getByTestId('chat-stream')).toContainText('approved')
      })
    })
  })

  test('a machine that goes away is dimmed and never woken; when it comes back its live sessions are', async ({ page }) => {
    test.setTimeout(120_000)
    await withPair({}, async (pair) => {
      const connected = () => expect.poll(async () => (await machines(pair))[0]?.status, { timeout: 20_000 }).toBe('connected')
      await connected()
      const project = ((await hubCall(pair.hub.port, 'projects.list', {})) as { id: string; path: string; machine?: string }[]).find(
        (p) => p.machine === MACHINE,
      )!
      const create = async () =>
        (await hubCall(pair.hub.port, 'agents.createSession', { projectId: project.id, cwd: project.path, tool: 'claude' })) as { id: string }
      // A dormant session: created, then its host restarted under it (a live one is never woken by anything, guard or not)
      const dormant = await create()
      await pair.remote.kill('SIGKILL')
      await restartRemote(pair)
      await connected()
      const live = await create()
      const calls = watchCalls(page)
      await page.goto('/')
      await expect(page.getByTestId(`session-row-${live.id}`)).toBeVisible()
      await expect(page.getByTestId('machine-status-m1')).toHaveAttribute('data-status', 'connected')

      await test.step('the machine stops: its rows stay, dimmed, and nothing wakes them, not even opening one', async () => {
        await pair.remote.kill('SIGKILL')
        await expect(page.getByTestId('machine-status-m1')).toHaveAttribute('data-status', 'unreachable', { timeout: 15_000 })
        await expect(page.getByTestId('project-remote-project')).toHaveAttribute('data-away', 'true')
        await page.getByTestId(`session-row-${dormant.id}`).click()
        await expect(page.getByTestId('away-note')).toBeVisible()
        await page.getByTestId('prompt-input').focus()
        await page.waitForTimeout(1000)
        expect(calls.filter((c) => c.method === 'agents.resumeSession')).toEqual([])
      })

      await test.step('it comes back: the machine resyncs, and only the session it held live is woken', async () => {
        await restartRemote(pair)
        await expect(page.getByTestId('machine-status-m1')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 })
        await expect(page.getByTestId('project-remote-project')).not.toHaveAttribute('data-away', 'true')
        // The remote host restarted: the live one's process is gone and is asked for again; the dormant one stays as it was
        await expect.poll(() => calls.filter((c) => c.method === 'agents.resumeSession').map((c) => c.params.sessionId)).toEqual([live.id])
        await expect(page.getByTestId('away-note')).toHaveCount(0)
      })
    })
  })

  test('versions that differ: the prompt names the command for the older machine, and connects anyway when asked', async ({ page }) => {
    test.setTimeout(120_000)
    // This hub claims a newer release of the same channel, so the machine (APP_VERSION) is the older side
    const newer = `99.0.0-${APP_VERSION.split('-')[1]?.split('.')[0] ?? 'beta'}.1`
    await withPair({ link: false, hubVersion: newer }, async (pair) => {
      await page.goto('/')
      await expect(page.getByTestId('project-hub-project')).toBeVisible()

      await test.step('another protocol: refused, with no way to connect anyway', async () => {
        await addMachine(page, 'Old protocol', `direct:${pair.remotePort}:protocol=999`)
        const row = page.getByTestId('machine-row-old-protocol')
        await expect(row).toHaveAttribute('data-status', 'versions_differ', { timeout: 15_000 })
        await expect(page.getByTestId('machine-versions-refused-old-protocol')).toBeVisible()
        await expect(page.getByTestId('machine-accept-versions-old-protocol')).toHaveCount(0)
        await page.getByTestId('machine-remove-old-protocol').click()
        await page.getByTestId('machine-remove-yes-old-protocol').click()
        await expect(row).toHaveCount(0)
      })

      await test.step('one protocol, an older machine: the prompt, the exact command, and nothing listed yet', async () => {
        await page.getByTestId('machines-add-open').click()
        await page.getByTestId('machines-add-name').fill('Remote box')
        await page.getByTestId('machines-add-target').fill(`direct:${pair.remotePort}`)
        await page.getByTestId('machines-add-confirm').click()
        await expect(page.getByTestId('machine-row-remote-box')).toHaveAttribute('data-status', 'versions_differ', { timeout: 15_000 })
        await expect(page.getByTestId('machine-versions-text-remote-box')).toContainText(`older than this computer's ${newer}`)
        await expect(page.getByTestId('machine-update-command-remote-box')).toHaveText(`npm i -g centralu@${newer}`)
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('machine-status-remote-box')).toHaveAttribute('data-status', 'versions_differ')
        await expect(page.getByTestId('project-remote-project')).toHaveCount(0)
      })

      await test.step('the machine header leads back to the prompt; connect anyway', async () => {
        await page.getByTestId('machine-name-remote-box').click()
        await expect(page.getByTestId('settings-machines')).toBeVisible()
        await page.getByTestId('machine-accept-versions-remote-box').click()
        await expect(page.getByTestId('machine-row-remote-box')).toHaveAttribute('data-status', 'connected', { timeout: 15_000 })
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('machine-group-remote-box').getByTestId('project-remote-project')).toBeVisible()
      })
    })
  })
}
