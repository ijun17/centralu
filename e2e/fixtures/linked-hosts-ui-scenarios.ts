import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { APP_VERSION } from '../../packages/protocol/src/brand.js'
import { Relay } from './real-host.js'
import { LINKED_RELAY_PORT, MACHINE, restartRemote, startPair, type LinkedPair } from './linked-hosts.js'
import { hubCall } from './linked-hosts-scenarios.js'
import { dragRowToGrid } from './grid-apps.js'

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

/** The app's own document inside a pinned view: the proxy frame, then the app's frame inside it */
function appView(page: Page, key: string) {
  return page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
}

export function linkedHostsUiTests(): void {
  test('another machine’s apps open here through the hub: a project app, one with its own origin, and a user-folder app', async ({ page }) => {
    test.setTimeout(150_000)
    await withPair({ apps: true }, async (pair) => {
      await expect.poll(async () => (await machines(pair))[0]?.status, { timeout: 20_000 }).toBe('connected')
      const calls = watchCalls(page)
      await page.goto('/')
      await expect(page.getByTestId('machine-status-m1')).toHaveAttribute('data-status', 'connected')

      await test.step('a project app of the machine opens, from the hub’s own door, and its tool calls reach the machine', async () => {
        const key = `${MACHINE}.p-remote/board`
        await page.getByTestId(`app-row-${key}`).click()
        const view = appView(page, key)
        await expect(view.locator('#count')).toHaveText('0', { timeout: 30_000 })
        // The address is the hub's: its port, and the instance qualified by the machine (the machine never sees that id)
        const src = (await page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe').getAttribute('src'))!
        expect(src.startsWith(`http://127.0.0.1:${pair.hub.port}/`)).toBe(true)
        expect(src).toMatch(new RegExp(`/views/${MACHINE}\\.[A-Za-z0-9_-]{16,}/`))
        expect(src).not.toContain(`:${pair.remotePort}/`)
        await view.locator('#increment').click()
        await expect(view.locator('#count')).toHaveText('1')
        expect(calls.find((c) => c.method === 'apps.invoke')?.params).toMatchObject({ appId: 'board', projectId: `${MACHINE}.p-remote` })
      })

      await test.step('an app that asks for its own origin gets one of the hub’s per-app ports', async () => {
        const key = `${MACHINE}.p-remote/board-own`
        await page.getByTestId(`app-row-${key}`).click()
        await expect(appView(page, key).locator('#count')).toHaveText('0', { timeout: 30_000 })
        const inner = page.frames().find((f) => new RegExp(`/views/${MACHINE}\\.[A-Za-z0-9_-]{16,}/view$`).test(f.url()))
        expect(inner, 'the per-app origin document, served by the hub').toBeTruthy()
        const origin = Number(new URL(inner!.url()).port)
        expect(origin).toBeGreaterThanOrEqual(20000)
        expect(origin).toBeLessThanOrEqual(32767)
        expect([pair.hub.port, pair.remotePort]).not.toContain(origin)
      })

      await test.step('the machine’s user-folder app opens by its machine, apart from this computer’s app of the same id', async () => {
        await page.getByTestId(`app-row-${MACHINE}:_user/notes`).click()
        await expect(page.getByTestId(`pinned-app-${MACHINE}:_user/notes`).getByTestId('pinned-title')).toHaveText('Remote notes')
        await expect(appView(page, `${MACHINE}:_user/notes`).locator('#count')).toHaveText('0', { timeout: 30_000 })
        // The window sends a lease and a fresh logical-open key; only the lease is stripped at the hub.
        const openKey = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
        expect(calls.filter((c) => c.method === 'apps.openView' && c.params.appId === 'notes').map((c) => c.params)).toEqual([
          { appId: 'notes', projectId: null, machine: MACHINE, lease: true, openKey },
        ])

        await page.getByTestId('app-row-_user/notes').click()
        await expect(page.getByTestId('pinned-app-_user/notes').getByTestId('pinned-title')).toHaveText('Hub notes')
        await expect(appView(page, '_user/notes').locator('#count')).toHaveText('0', { timeout: 30_000 })
        expect(calls.filter((c) => c.method === 'apps.openView' && c.params.appId === 'notes').map((c) => c.params)).toEqual([
          { appId: 'notes', projectId: null, machine: MACHINE, lease: true, openKey },
          { appId: 'notes', projectId: null, lease: true, openKey },
        ])
      })

      await test.step('each logical-open key recovers the original instance on its owning host', async () => {
        const opens = calls.filter((c) => c.method === 'apps.openView')
        expect(opens).toHaveLength(4)
        expect(new Set(opens.map((c) => c.params.openKey)).size).toBe(4)
        expect(calls.filter((c) => c.method === 'apps.recoverView')).toEqual([])
        for (const { params } of opens) {
          // This is a read-only probe: do not take the browser's lease when querying the result.
          const { lease: _lease, ...query } = params
          const recovered = await hubCall(pair.hub.port, 'apps.recoverView', query) as { instanceId: string }
          const key = params.projectId ? `${params.projectId}/${params.appId}` : `${params.machine ? `${params.machine}:` : ''}_user/${params.appId}`
          const src = await page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe').getAttribute('src')
          expect(src).toContain(`/views/${recovered.instanceId}/`)
        }
      })
    })
  })

  test('another machine’s user-folder app has its own panels: its runs and versions are that machine’s, not this computer’s', async ({ page }) => {
    test.setTimeout(150_000)
    await withPair({ apps: true }, async (pair) => {
      await expect.poll(async () => (await machines(pair))[0]?.status, { timeout: 20_000 }).toBe('connected')
      const calls = watchCalls(page)
      await page.goto('/')
      await expect(page.getByTestId('machine-status-m1')).toHaveAttribute('data-status', 'connected')
      const theirs = `${MACHINE}:_user/notes`
      const tools = (key: string) => page.getByTestId(`pinned-app-${key}`).getByTestId('runs-panel').getByTestId('run-tool')

      await test.step('their notes: two calls from the view, and the Runs panel lists them from that machine', async () => {
        await page.getByTestId(`app-row-${theirs}`).click()
        const view = appView(page, theirs)
        await expect(view.locator('#count')).toHaveText('0', { timeout: 30_000 })
        await view.locator('#increment').click()
        await expect(view.locator('#count')).toHaveText('1')
        await view.locator('#increment').click()
        await expect(view.locator('#count')).toHaveText('2')
        await page.getByTestId(`pinned-app-${theirs}`).getByTestId('pinned-runs-toggle').click()
        await expect.poll(async () => (await tools(theirs).allTextContents()).filter((t) => t === 'increment').length).toBe(2)
        expect(calls.find((c) => c.method === 'apps.runs')?.params).toMatchObject({ appId: 'notes', projectId: null, machine: MACHINE })
      })

      await test.step('their Versions panel asks that machine', async () => {
        await page.getByTestId(`pinned-app-${theirs}`).getByTestId('pinned-versions-toggle').click()
        await expect(page.getByTestId(`pinned-app-${theirs}`).getByTestId('versions-panel')).toBeVisible()
        await expect(page.getByTestId('versions-error')).toHaveCount(0)
        await expect.poll(() => calls.find((c) => c.method === 'apps.versions')?.params).toMatchObject({ appId: 'notes', projectId: null, machine: MACHINE })
      })

      await test.step('this computer’s notes keeps its own runs: none of their calls', async () => {
        await page.getByTestId('app-row-_user/notes').click()
        await expect(appView(page, '_user/notes').locator('#count')).toHaveText('0', { timeout: 30_000 })
        await page.getByTestId('pinned-app-_user/notes').getByTestId('pinned-runs-toggle').click()
        await expect.poll(async () => (await tools('_user/notes').allTextContents()).length).toBeGreaterThan(0)
        expect((await tools('_user/notes').allTextContents()).filter((t) => t === 'increment')).toEqual([])
      })
    })
  })

  test('removing another machine’s user-folder app removes it there only: its views and panel go, this computer’s app of the same id stays', async ({ page }) => {
    test.setTimeout(150_000)
    await withPair({ apps: true }, async (pair) => {
      await expect.poll(async () => (await machines(pair))[0]?.status, { timeout: 20_000 }).toBe('connected')
      const calls = watchCalls(page)
      await page.goto('/')
      await expect(page.getByTestId('machine-status-m1')).toHaveAttribute('data-status', 'connected')
      const theirs = `${MACHINE}:_user/notes`
      const theirFolder = join(pair.remoteSide.dir, 'data', 'apps', 'notes')
      const ourFolder = join(pair.hubSide.dir, 'data', 'apps', 'notes')
      const gridView = (key: string) =>
        page.getByTestId(`pinned-app-grid:${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()

      await test.step('both notes stand on the grid and in their own pinned views', async () => {
        await page.getByTestId('grid-button').click()
        await expect(page.getByTestId('grid')).toBeVisible()
        await dragRowToGrid(page, page.getByTestId(`app-row-${theirs}`), 'padding')
        await expect(page.getByTestId(`grid-panel-app:${theirs}`)).toBeVisible()
        await dragRowToGrid(page, page.getByTestId('app-row-_user/notes'), { panel: `app:${theirs}`, side: 'after' })
        await expect(page.getByTestId('grid-panel-app:_user/notes')).toBeVisible()
        await expect(gridView('_user/notes').locator('#count')).toHaveText('0', { timeout: 30_000 })
        await page.getByTestId(`app-row-${theirs}`).click()
        await expect(appView(page, theirs).locator('#count')).toHaveText('0', { timeout: 30_000 })
        await page.getByTestId('app-row-_user/notes').click()
        await expect(appView(page, '_user/notes').locator('#count')).toHaveText('0', { timeout: 30_000 })
      })

      await test.step('Settings → Apps removes theirs, saying where', async () => {
        await page.getByTestId('open-settings').click()
        await page.getByTestId('settings-tab-apps').click()
        const row = page.getByTestId(`external-app-${theirs}`)
        await row.getByTestId('external-app-remove').click()
        await expect(row.getByTestId('external-app-remove-confirm')).toContainText('from Remote box')
        await row.getByTestId('external-app-remove-yes').click()
        await expect(row).toHaveCount(0, { timeout: 15_000 })
        // Removed there, by name of that machine; this computer's app was never asked
        expect(calls.filter((c) => c.method === 'apps.remove').map((c) => c.params)).toEqual([{ appId: 'notes', projectId: null, machine: MACHINE }])
        expect(existsSync(theirFolder)).toBe(false)
        expect(existsSync(ourFolder)).toBe(true)
        await expect(page.getByTestId('external-app-_user/notes')).toBeVisible()
        await page.keyboard.press('Escape')
      })

      await test.step('their views and panel go; this computer’s notes keeps its row, view and panel', async () => {
        await expect(page.getByTestId(`app-row-${theirs}`)).toHaveCount(0)
        await expect(page.getByTestId(`pinned-app-${theirs}`)).toHaveCount(0)
        await expect(page.getByTestId('app-row-_user/notes')).toBeVisible()
        await expect(appView(page, '_user/notes').locator('#count')).toHaveText('0')
        await page.getByTestId('grid-button').click()
        await expect(page.getByTestId('grid')).toBeVisible()
        await expect(page.getByTestId(`grid-panel-app:${theirs}`)).toHaveCount(0)
        await expect(page.getByTestId(`pinned-app-grid:${theirs}`)).toHaveCount(0)
        await expect(page.getByTestId('grid-panel-app:_user/notes')).toBeVisible()
        await expect(gridView('_user/notes').locator('#count')).toHaveText('0')
      })
    })
  })

  test('another machine’s apps stand on the grid: dragged there, each with its own view, kept by the hub across a reload', async ({ page }) => {
    test.setTimeout(150_000)
    await withPair({ apps: true }, async (pair) => {
      await expect.poll(async () => (await machines(pair))[0]?.status, { timeout: 20_000 }).toBe('connected')
      const calls = watchCalls(page)
      await page.goto('/')
      await expect(page.getByTestId('machine-status-m1')).toHaveAttribute('data-status', 'connected')
      await page.getByTestId('grid-button').click()
      await expect(page.getByTestId('grid')).toBeVisible()
      const board = `${MACHINE}.p-remote/board`
      const theirNotes = `${MACHINE}:_user/notes`
      const gridView = (key: string) =>
        page.getByTestId(`pinned-app-grid:${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()

      await test.step('a project app of the machine, dropped on the empty grid, shows its view', async () => {
        await dragRowToGrid(page, page.getByTestId(`app-row-${board}`), 'padding')
        await expect(page.getByTestId(`grid-panel-app:${board}`)).toBeVisible()
        // The window shows a drop at once; the hub's answer is what stays
        await expect
          .poll(() => hubCall(pair.hub.port, 'grid.get', { tagged: true }))
          .toEqual([{ kind: 'app', projectId: `${MACHINE}.p-remote`, appId: 'board' }])
        await expect(gridView(board).locator('#count')).toHaveText('0', { timeout: 30_000 })
      })

      await test.step('the machine’s user-folder app and this computer’s app of the same id are two panels', async () => {
        await dragRowToGrid(page, page.getByTestId(`app-row-${theirNotes}`), { panel: `app:${board}`, side: 'after' })
        await expect(page.getByTestId(`grid-panel-app:${theirNotes}`)).toBeVisible()
        await dragRowToGrid(page, page.getByTestId('app-row-_user/notes'), { panel: `app:${theirNotes}`, side: 'after' })
        await expect(page.getByTestId('grid-panel-app:_user/notes')).toBeVisible()
        await expect(gridView(theirNotes).locator('#count')).toHaveText('0', { timeout: 30_000 })
        await expect(gridView('_user/notes').locator('#count')).toHaveText('0', { timeout: 30_000 })
        // Theirs was opened on that machine, this computer's here
        await expect
          .poll(() => calls.filter((c) => c.method === 'apps.openView' && c.params.appId === 'notes').map((c) => c.params.machine ?? null).sort())
          .toEqual([MACHINE, null].sort())
      })

      await test.step('the hub keeps the panels, and a reload brings them back where they stood', async () => {
        const expected = [
          { kind: 'app', projectId: `${MACHINE}.p-remote`, appId: 'board' },
          { kind: 'app', projectId: null, appId: 'notes', machine: MACHINE },
          { kind: 'app', projectId: null, appId: 'notes' },
        ]
        await expect.poll(() => hubCall(pair.hub.port, 'grid.get', { tagged: true })).toEqual(expected)
        await page.reload()
        await expect(page.getByTestId('grid')).toBeVisible()
        await expect
          .poll(() =>
            page.evaluate(() =>
              [...document.querySelectorAll('[data-testid="grid"] [data-testid^="grid-panel-"]')].map((el) => el.getAttribute('data-testid')),
            ),
          )
          .toEqual([`grid-panel-app:${board}`, `grid-panel-app:${theirNotes}`, 'grid-panel-app:_user/notes'])
        await expect(gridView(theirNotes).locator('#count')).toHaveText('0', { timeout: 30_000 })
      })
    })
  })

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

      await test.step("create a new folder there (#515): that machine's host names its ~/Centralu, makes it if missing, and the folder", async () => {
        const centralu = join(pair.remoteSide.home, 'Centralu')
        await page.getByTestId('add-remote-project-remote-box').click()
        const dialog = page.getByTestId('add-remote-project-dialog')
        await dialog.getByTestId('add-remote-project-mode-new').click()
        await expect(dialog.getByTestId('create-project-parent-shown')).toHaveText(centralu)
        await dialog.getByTestId('create-project-name').fill('fresh')
        await expect(dialog.getByTestId('create-project-path')).toHaveText(join(centralu, 'fresh'))
        await dialog.getByTestId('create-project-confirm').click()
        await expect(page.getByTestId('machine-group-remote-box').getByTestId('project-fresh')).toBeVisible()
        expect(readdirSync(join(centralu, 'fresh'))).toEqual([])
        expect(calls.find((c) => c.method === 'projects.create')?.params).toEqual({ name: 'fresh', machine: 'remote-box' })
        // A second one of the same name is refused before anything is made
        await page.getByTestId('add-remote-project-remote-box').click()
        await dialog.getByTestId('add-remote-project-mode-new').click()
        await dialog.getByTestId('create-project-name').fill('fresh')
        await expect(dialog.getByTestId('create-project-error')).toContainText('already in')
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
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

  test('versions that differ: the prompt offers to update the older machine from here, and connects anyway when asked', async ({ page }) => {
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

      await test.step('a machine that runs a command of its own: this computer cannot update it, so the prompt names the command', async () => {
        await page.getByTestId('machines-add-open').click()
        await page.getByTestId('machines-add-name').fill('Own command')
        await page.getByTestId('machines-add-target').fill(`direct:${pair.remotePort}`)
        await page.getByText('Command (optional)').click()
        await page.getByTestId('machines-add-command').fill('~/bin/centralu')
        await page.getByTestId('machines-add-confirm').click()
        const row = page.getByTestId('machine-row-own-command')
        await expect(row).toHaveAttribute('data-status', 'versions_differ', { timeout: 15_000 })
        await expect(page.getByTestId('machine-versions-text-own-command')).toContainText(`older than this computer's ${newer}. Update it there`)
        await expect(page.getByTestId('machine-update-command-own-command')).toHaveText(`npm i -g centralu@${newer}`)
        await expect(page.getByTestId('machine-update-remote-own-command')).toHaveCount(0)
        await page.getByTestId('machine-remove-own-command').click()
        await page.getByTestId('machine-remove-yes-own-command').click()
        await expect(row).toHaveCount(0)
      })

      await test.step('one protocol, an older machine: the prompt offers the update from here, and nothing listed yet', async () => {
        await page.getByTestId('machines-add-open').click()
        await page.getByTestId('machines-add-name').fill('Remote box')
        await page.getByTestId('machines-add-target').fill(`direct:${pair.remotePort}`)
        await page.getByTestId('machines-add-confirm').click()
        await expect(page.getByTestId('machine-row-remote-box')).toHaveAttribute('data-status', 'versions_differ', { timeout: 15_000 })
        await expect(page.getByTestId('machine-versions-text-remote-box')).toContainText(`older than this computer's ${newer}. Update it, or`)
        // This computer runs a release (not a dev build) and the machine no command of its own: a button, no command line
        await expect(page.getByTestId('machine-update-command-remote-box')).toHaveCount(0)
        await expect(page.getByTestId('machine-update-remote-remote-box')).toHaveText(`Update Remote box to ${newer}`)
        // Before anything stops there the prompt says what stops; Cancel stops nothing
        await page.getByTestId('machine-update-remote-remote-box').click()
        await expect(page.getByTestId('machine-stop-text-remote-box')).toBeVisible()
        await page.getByTestId('machine-stop-confirm-remote-box').getByRole('button', { name: 'Cancel' }).click()
        await expect(page.getByTestId('machine-stop-confirm-remote-box')).toHaveCount(0)
        await expect(page.getByTestId('machine-update-remote-remote-box')).toBeVisible()
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
