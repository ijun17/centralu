import { expect, test } from '@playwright/test'
import { HelloServer, NormalizedEvent, RpcMethods, type RpcMethodName } from '@cc/protocol'
import { withoutDefaultedFields } from '../packages/protocol/src/test-helpers.js'
import { RECOVERY_RELAY_PORT, Relay, freePort, hostCall, seedSession, startHost, withStore, workspace, type RealHost } from './fixtures/real-host.js'

/**
 * A window on an older host (#280). Under the keeper a window of one build can stay attached to a
 * host of an older one until the person switches, and the beta.9 window on a beta.7 host crashed:
 * the session list had no `backgroundTasks` (#305), the UI never ran results through the schema,
 * and the field's `.default([])` never applied ("undefined is not an object (evaluating
 * 'e.filter')").
 *
 * The real UI and a real host, with every frame the host sends rewritten on the way to the page as
 * a host from before every defaulted field would have sent it: each field whose schema carries a
 * `.default()` is taken out of every RPC result, every event and the handshake. A field the
 * protocol adds later always has a default (protocol.md §4), so this stands in for any older host.
 * Runs in the `recovery` project, whose UI is built against the relay on 5178.
 */

const PROJECT = 'p-older'
const SESSION = 's-older'

test('a window on an older host draws its sessions and a conversation without crashing', async ({ page }) => {
  test.setTimeout(60_000)
  const ws = workspace()
  withStore(ws.db, (store) => {
    store.setAppSetting('updates.auto', 'false')
    store.addProject({ id: PROJECT, path: ws.project, name: 'older' })
    seedSession(store, PROJECT, SESSION, 'alpha')
  })
  const port = await freePort()
  const relay = new Relay(() => port)
  const stripped = new Set<string>()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.routeWebSocket(new RegExp(`:${RECOVERY_RELAY_PORT}/?$`), (route) => {
    const server = route.connectToServer()
    const methods = new Map<string, RpcMethodName>()
    route.onMessage((m) => {
      const f = JSON.parse(String(m)) as { kind?: string; id?: string; method?: string }
      if (f.kind === 'rpc' && f.id && f.method && f.method in RpcMethods) methods.set(f.id, f.method as RpcMethodName)
      server.send(m)
    })
    server.onMessage((m) => {
      const f = JSON.parse(String(m)) as { kind?: string; id?: string; ok?: boolean; result?: unknown; event?: unknown }
      const before = JSON.stringify(f)
      let older: unknown = f
      if (f.kind === 'hello_ok') older = withoutDefaultedFields(HelloServer, f)
      if (f.kind === 'event') older = { ...f, event: withoutDefaultedFields(NormalizedEvent, f.event) }
      const method = f.kind === 'res' && f.ok && f.id ? methods.get(f.id) : undefined
      if (method) older = { ...f, result: withoutDefaultedFields(RpcMethods[method].result, f.result) }
      const after = JSON.stringify(older)
      if (after !== before) stripped.add(method ?? String(f.kind))
      route.send(after)
    })
  })

  let host!: RealHost
  try {
    host = await startHost(ws, port)
    await relay.listen(RECOVERY_RELAY_PORT)
    await page.goto('/')
    const row = page.getByTestId(`session-row-${SESSION}`)
    await expect(row).toContainText('alpha')
    // The list really arrived in the older shape — otherwise this test proves nothing
    expect(stripped).toContain('sessions.list')

    await row.click()
    await expect(page.getByTestId('session-view')).toBeVisible()
    /*
     * An event in the older shape too, about a session the screen holds. Only that it is survived
     * is checked: taking out a default that was there from the start can change what the event
     * means (`session_title` without `auto: false` reads as an automatic title, which does not
     * replace a name the person gave), and that is the stand-in's doing, not a defect.
     */
    await hostCall(port, 'sessions.rename', { sessionId: SESSION, name: 'beta' })
    await expect.poll(() => stripped.has('event')).toBe(true)

    await expect(page.getByTestId('app-crashed')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await relay.close()
    if (host) await host.kill('SIGTERM')
    ws.cleanup()
  }
})
