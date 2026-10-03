import { expect, test, type Page } from '@playwright/test'
import {
  RECOVERY_RELAY_PORT,
  Relay,
  freePort,
  hostCall,
  seedSession,
  startHost,
  storedUserLine,
  withStore,
  workspace,
  type RealHost,
} from './fixtures/real-host.js'

/**
 * The real UI against a real host, through a dropped socket and a host restart (#82).
 *
 * Every other spec runs the UI on the mock platform; this one runs the web platform's real
 * RpcClient against `main.ts`, because what is under test is the seam between them: the
 * handshake, the replay cursor and the host lifetime it belongs to. Its own vite server
 * (playwright.config.ts, project `recovery`) is built pointing at the relay on 5178.
 */

const PROJECT = 'p-recovery'
const SESSION = 's-recovery'

const connectionBanner = (page: Page) => page.getByTestId('connection')
const row = (page: Page) => page.getByTestId(`session-row-${SESSION}`)

test('the UI recovers from a dropped socket and from a host restart, re-reading what it missed', async ({ page }) => {
  test.setTimeout(120_000)
  const ws = workspace()
  withStore(ws.db, (store) => {
    store.setAppSetting('updates.auto', 'false')
    store.addProject({ id: PROJECT, path: ws.project, name: 'recovery' })
    seedSession(store, PROJECT, SESSION, 'alpha')
  })
  const port = await freePort()
  let host: RealHost = await startHost(ws, port)
  const relay = new Relay(() => port)
  await relay.listen(RECOVERY_RELAY_PORT)

  try {
    await page.goto('/')
    await expect(row(page)).toContainText('alpha')
    await expect(connectionBanner(page)).toHaveCount(0)
    await hostCall(port, 'sessions.rename', { sessionId: SESSION, name: 'beta' })
    await expect(row(page)).toContainText('beta')

    await test.step('a dropped socket: the host stays up, and what happened meanwhile arrives after reconnecting', async () => {
      relay.closed = true
      relay.drop()
      await expect(connectionBanner(page)).toBeVisible()
      await hostCall(port, 'sessions.rename', { sessionId: SESSION, name: 'gamma' })
      relay.closed = false
      await expect(connectionBanner(page)).toHaveCount(0, { timeout: 15_000 })
      await expect(row(page)).toContainText('gamma')
    })

    await row(page).click()
    await expect(page.getByTestId('session-view')).toBeVisible()

    await test.step('a host restart at the same address: a new lifetime, a resync, and the gap read from the store', async () => {
      // How far the old lifetime numbered — the page's cursor is at most this
      const { currentSeq: oldWatermark } = await hostCall(port, 'sessions.list', {})
      relay.closed = true
      // A crash, not a shutdown: the ownership lock must be released by the operating system
      await host.kill('SIGKILL')
      await expect(connectionBanner(page)).toBeVisible()

      // While nothing runs, a line lands in the stored conversation — no event will ever announce it
      withStore(ws.db, (store) => storedUserLine(store, SESSION, 'written while the host was down'))
      host = await startHost(ws, port)
      // The new lifetime numbers past the page's old cursor before the page is back: on main the
      // page took these as "what it missed" and never re-read the conversation
      let newWatermark = 0
      for (let i = 0; newWatermark <= oldWatermark + 2; i++) {
        await hostCall(port, 'sessions.rename', { sessionId: SESSION, name: `omega-${i}` })
        ;({ currentSeq: newWatermark } = await hostCall(port, 'sessions.list', {}))
      }
      await hostCall(port, 'sessions.rename', { sessionId: SESSION, name: 'omega' })

      relay.closed = false
      await expect(connectionBanner(page)).toHaveCount(0, { timeout: 15_000 })
      await expect(page.getByTestId('session-view')).toContainText('written while the host was down')
      await expect(row(page)).toContainText('omega')
    })
  } finally {
    await relay.close()
    await host.kill('SIGTERM')
    ws.cleanup()
  }
})
