import { expect, test, type Frame, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * A single app view (M4 B-3c) — AppFrame + the real host's sandbox proxy + the official ext-apps
 * 2.x `App`.
 *
 * An AppFrame is mounted on a test-bed page (`/app-frame.html`) on a mock platform. The address is
 * produced by a real HostServer and ViewHost started by this worker (secret path, CSP, and
 * per-app origin ports are all the real thing). The tools and resources the view calls reach the
 * mock's `AppsPort`, so the mock records what went out under which app's name.
 *
 * Measuring the Tauri IPC block (S-2) cannot be done here — this browser has no Tauri. What is
 * measured here is only what a browser alone can measure (access to the parent/top window,
 * storage, popups, network to the host, top-level navigation). The real window's IPC is confirmed
 * through dogfooding.
 */

let fx: FixtureHost
/** The host answering the view address — a test swaps it to stand for another host behind the connection */
let serving: FixtureHost
/** How many times the page asked for a view address */
let frameCalls = 0

test.beforeAll(async () => {
  fx = await startFixtureHost({
    'fixture ui://fixture/main': { html: fixtureViewHtml() },
    'other ui://other/main': { html: fixtureViewHtml() },
    'hang ui://hang/main': { html: fixtureViewHtml({ hangTeardown: true }) },
    'fixture-port ui://fixture-port/main': { html: fixtureViewHtml() },
    'other-port ui://other-port/main': { html: fixtureViewHtml() },
    'plain ui://plain/main': { html: fixtureViewHtml({ ignoreNotifications: true }) },
  })
})

test.afterAll(async () => {
  await fx?.close()
})

test.beforeEach(async ({ page }) => {
  serving = fx
  frameCalls = 0
  // When the test-bed's mock asks for the view address, the real ViewHost answers
  await page.exposeFunction(
    '__viewFrame',
    (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => {
      frameCalls++
      return serving.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin })
    },
  )
  await page.goto('/app-frame.html')
  await page.waitForFunction(() => !!(window as any).__appFrame)
})

type Props = { appId: string; projectId?: string | null; instanceId: string; toolInput?: unknown; toolResult?: unknown; changeSignal?: number }

async function mount(page: Page, key: string, props: Props) {
  await page.evaluate(({ k, p }) => (window as any).__appFrame.mount(k, p), { k: key, p: props })
  await expect(page.getByTestId(`frame-${key}`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
}

/** The inner frame the app's HTML runs in (the outer one is the proxy) */
function view(page: Page, key: string): FrameLocator {
  return page.getByTestId(`frame-${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
}

/** One line the view logged, as JSON */
async function entry(v: FrameLocator, k: string, nth = 0): Promise<unknown> {
  const li = v.locator(`li[data-k="${k}"]`).nth(nth)
  await expect(li).toBeVisible()
  const text = (await li.textContent()) ?? ''
  return JSON.parse(text.slice(k.length + 1))
}

async function calls(page: Page) {
  return page.evaluate(() => (window as any).__mock.appToolCalls as { appId: string; tool: string; args: Record<string, unknown>; from: Record<string, unknown> }[])
}

/** Finds the inner frame by name — for when evaluate is needed (FrameLocator cannot do this) */
async function innerFrame(page: Page, key: string): Promise<Frame> {
  const outer = await page.getByTestId(`frame-${key}`).getByTestId('app-frame-iframe').elementHandle()
  const proxy = await outer!.contentFrame()
  const inner = await (await proxy!.waitForSelector('iframe'))!.contentFrame()
  await inner!.waitForSelector('li[data-k="connected"]')
  return inner!
}

test('the view initializes, receives input and a result, and a button reaches the mock\'s callTool with the result showing in the view', async ({ page }) => {
  const id = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
  await page.evaluate(() => {
    ;(window as any).__mock.appResources.set('fixture ui://fixture/data', {
      contents: [{ uri: 'ui://fixture/data', mimeType: 'application/json', text: '{"n":1}' }],
    })
  })
  await mount(page, 'a', {
    appId: 'fixture',
    projectId: 'p1',
    instanceId: id,
    toolInput: { q: 'weather' },
    toolResult: { content: [{ type: 'text', text: 'done' }], structuredContent: { answer: 42 } },
  })
  const v = view(page, 'a')

  // The spec's lifecycle messages: init → tool-input → tool-result
  expect(await entry(v, 'tool-input')).toEqual({ q: 'weather' })
  expect(await entry(v, 'tool-result')).toEqual({ answer: 42 })

  // The view's button → AppBridge.oncalltool → AppsPort.callTool (mock) → the result reaches the view
  await v.locator('#call').click()
  expect(await entry(v, 'call-result')).toEqual({ appId: 'fixture', tool: 'increment', args: { by: 2 } })
  expect(await calls(page)).toEqual([{ appId: 'fixture', tool: 'increment', args: { by: 2 }, from: { projectId: 'p1', instanceId: id } }])

  // onreadresource → AppsPort.readResource (mock)
  await v.locator('#read').click()
  expect(await entry(v, 'read-result')).toEqual([{ uri: 'ui://fixture/data', mimeType: 'application/json', text: '{"n":1}' }])
  expect(await page.evaluate(() => (window as any).__mock.appResourceReads)).toEqual([
    { appId: 'fixture', uri: 'ui://fixture/data', from: { projectId: 'p1', instanceId: id } },
  ])

  // size-changed → height
  const before = (await page.getByTestId('frame-a').getByTestId('app-frame-iframe').boundingBox())!.height
  await v.locator('#grow').click()
  await expect.poll(async () => (await page.getByTestId('frame-a').getByTestId('app-frame-iframe').boundingBox())!.height).toBeGreaterThan(before + 500)
})

test('opaque mode: the inner frame\'s origin is "null", and it cannot read the proxy\'s secret address', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  const connected = (await entry(view(page, 'a'), 'connected')) as Record<string, unknown>
  expect(connected).toMatchObject({ origin: 'null', href: 'about:srcdoc', referrer: '' })

  // The proxy comes from a different origin on the host port (not our view's origin)
  const proxy = page.frames().find((f) => f.url().includes('/views/'))!
  expect(new URL(proxy.url()).origin).toBe(`http://127.0.0.1:${fx.port}`)
  expect(new URL(proxy.url()).origin).not.toBe(new URL(page.url()).origin)
})

test('a message that claims a different app cannot change which app the call is attributed to', async ({ page }) => {
  const idA = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
  const idB = fx.open({ projectId: 'p2', appId: 'other' }, 'ui://other/main')
  await mount(page, 'a', { appId: 'fixture', projectId: 'p1', instanceId: idA })
  await mount(page, 'b', { appId: 'other', projectId: 'p2', instanceId: idB })
  const a = view(page, 'a')

  // Through the SDK: claims a different app in params and _meta
  await a.locator('#spoof').click()
  await entry(a, 'spoof-result')
  // Raw JSON-RPC: attaches fields outside the spec (appId, app, projectId)
  await a.locator('#raw').click()
  await expect.poll(async () => (await calls(page)).length).toBe(2)
  // Skipping the proxy straight to the top window — this must not be received. Once the
  // following legitimate call arrives, this message sent before it has already been dropped
  // (postMessage preserves order)
  await a.locator('#direct').click()
  await entry(a, 'direct-sent')
  await a.locator('#call').click()
  await entry(a, 'call-result')
  // The other app's view can only call under its own app name
  await view(page, 'b').locator('#call').click()
  expect(await entry(view(page, 'b'), 'call-result')).toMatchObject({ appId: 'other' })

  const seen = await calls(page)
  expect(seen.map((c) => [c.appId, c.from.projectId, c.from.instanceId, c.args])).toEqual([
    ['fixture', 'p1', idA, { by: 1 }],
    ['fixture', 'p1', idA, { raw: true }],
    ['fixture', 'p1', idA, { by: 2 }],
    ['other', 'p2', idB, { by: 2 }],
  ])
  expect(JSON.stringify(seen)).not.toContain('victim')
  expect(JSON.stringify(seen)).not.toContain('stolen')
})

/*
 * A link goes out through the platform's external-open port (system.openUrl) (#159). AppFrame
 * used to call window.open directly, and here on Chromium that passed because a new page opened,
 * but nothing opened at all on the desktop webview (WKWebView). So what is checked is not whether
 * a new page opens but **whether the port was reached**, and also that the webview did not open a
 * window on its own.
 */
test('a link opens through the platform\'s external-open port after the person confirms it, and anything that is not http(s) or mailto is refused without even asking', async ({ page, context }) => {
  const popups: string[] = []
  context.on('page', (p) => popups.push(p.url()))
  const openedUrls = () => page.evaluate(() => (window as any).__mock.openedUrls as string[])
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  const v = view(page, 'a')

  await v.locator('#bad-link').click()
  expect(await entry(v, 'bad-link-result')).toEqual({ isError: true })
  await expect(page.getByTestId('app-frame-link-ask')).toHaveCount(0)

  await v.locator('#link').click()
  await expect(page.getByTestId('app-frame-link-ask')).toContainText('https://example.test/docs?from=view')
  await page.getByTestId('app-frame-link-cancel').click()
  expect(await entry(v, 'link-result')).toEqual({ isError: true })
  expect(await openedUrls()).toEqual([])

  await v.locator('#link').click()
  await page.getByTestId('app-frame-link-open').click()
  expect(await entry(v, 'link-result', 1)).toEqual({})
  expect(await openedUrls()).toEqual(['https://example.test/docs?from=view'])
  expect(popups).toEqual([])
})

test('ui/message goes to the callback the parent supplied', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  await view(page, 'a').locator('#msg').click()
  expect(await entry(view(page, 'a'), 'msg-result')).toEqual({})
  expect(await page.evaluate(() => (window as any).__appFrame.events.filter((e: { kind: string }) => e.kind === 'message'))).toEqual([
    { kind: 'message', key: 'a', value: { role: 'user', content: [{ type: 'text', text: 'hello from the view' }] } },
  ])
})

test('theme and font size go out in the host context, and changing font size sends only the changed field through host-context-changed', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  const v = view(page, 'a')
  const connected = (await entry(v, 'connected')) as { hostContext: Record<string, any> }
  expect(connected.hostContext).toMatchObject({ theme: 'dark', displayMode: 'inline', centralu: { fontScale: 1 } })
  // Color is read from our own token for wherever the view is placed
  expect(connected.hostContext.styles.variables['--color-text-primary']).toBe('#e9e9e9')

  await page.evaluate(() => (window as any).__store.setState({ textScale: 4 }))
  expect(await entry(v, 'host-context-changed')).toEqual({ centralu: { fontScale: 1.25 } })
})

test('teardown is sent before taking a view down, and its answer is awaited — a view that does not answer is waited on only briefly', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  const hang = fx.open({ projectId: null, appId: 'hang' }, 'ui://hang/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  await mount(page, 'h', { appId: 'hang', projectId: null, instanceId: hang })

  expect(await calls(page)).toEqual([])
  expect(await page.evaluate(() => (window as any).__appFrame.close('a'))).toBe('answered')
  await expect(page.getByTestId('frame-a')).toHaveCount(0)
  // The view received the request and finished saving before it was taken down (the call reached the mock)
  expect((await calls(page)).map((c) => [c.appId, c.tool])).toEqual([['fixture', 'save-on-teardown']])

  const t0 = Date.now()
  expect(await page.evaluate(() => (window as any).__appFrame.close('h'))).toBe('timeout')
  const waited = Date.now() - t0
  expect(waited).toBeGreaterThanOrEqual(900)
  expect(waited).toBeLessThan(5000)
})

/**
 * The part of S-2 that a browser alone can measure. The attempt is made directly from the inner
 * frame (Playwright's evaluate runs as that frame's script — network requests are subject to that
 * frame's CSP as-is).
 */
test('S-2 (browser part): an app frame cannot reach the parent, the top window, storage, popups, or the host network', async ({ page, context }) => {
  const leaked: string[] = []
  await context.route('https://example.test/**', (r) => {
    leaked.push(r.request().url())
    return r.fulfill({ body: 'leak' })
  })
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  const inner = await innerFrame(page, 'a')
  const topUrl = page.url()

  const probes = await inner.evaluate(async (hostPort: number) => {
    const out: Record<string, string> = {}
    const w = window as any
    const sync = (k: string, f: () => unknown) => {
      try {
        const v = f()
        out[k] = `ok:${v === null ? 'null' : typeof v}`
      } catch (e) {
        out[k] = (e as Error).name
      }
    }
    const later = async (k: string, f: () => Promise<unknown>) => {
      try {
        const v = await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('t'), { name: 'Timeout' })), 3000))])
        out[k] = `ok:${v === null ? 'null' : typeof v}`
      } catch (e) {
        out[k] = (e as Error).name
      }
    }
    sync('parent.document', () => w.parent.document)
    sync('top.document', () => w.top.document)
    sync('top.__TAURI_INTERNALS__', () => w.top.__TAURI_INTERNALS__)
    sync('parent.location.href', () => w.parent.location.href)
    out['own tauri/ipc globals'] = Object.getOwnPropertyNames(window).filter((k) => /tauri|ipc|invoke/i.test(k)).join(',') || 'none'
    sync('localStorage', () => localStorage.setItem('k', '1'))
    sync('sessionStorage', () => sessionStorage.setItem('k', '1'))
    sync('document.cookie', () => ((document.cookie = 'k=1'), document.cookie))
    await later('indexedDB.open', () => new Promise((res, rej) => {
      const r = indexedDB.open('k')
      r.onsuccess = () => res('ok')
      r.onerror = () => rej(r.error)
    }))
    sync('window.open', () => window.open('https://example.test/popup'))
    sync('top.location', () => {
      w.top.location.href = 'https://example.test/top'
    })
    await later('fetch host port', () => fetch(`http://127.0.0.1:${hostPort}/`))
    await later('fetch example.test', () => fetch('https://example.test/fetch'))
    await later('WebSocket host', () => new Promise((res, rej) => {
      const s = new WebSocket(`ws://127.0.0.1:${hostPort}`)
      s.onopen = () => res('open')
      s.onerror = () => rej(Object.assign(new Error('ws'), { name: 'WebSocketError' }))
    }))
    await later('image from host port', () => new Promise((res, rej) => {
      const img = new Image()
      img.onload = () => res('loaded')
      img.onerror = () => rej(Object.assign(new Error('img'), { name: 'ImageError' }))
      img.src = `http://127.0.0.1:${hostPort}/x.png`
    }))
    return out
  }, fx.port)

  expect(probes).toEqual({
    'parent.document': 'SecurityError',
    'top.document': 'SecurityError',
    'top.__TAURI_INTERNALS__': 'SecurityError',
    'parent.location.href': 'SecurityError',
    'own tauri/ipc globals': 'none',
    localStorage: 'SecurityError',
    sessionStorage: 'SecurityError',
    'document.cookie': 'SecurityError',
    'indexedDB.open': 'SecurityError',
    // A popup is blocked by the sandbox (returns null)
    'window.open': 'ok:null',
    'top.location': 'SecurityError',
    'fetch host port': 'TypeError',
    'fetch example.test': 'TypeError',
    'WebSocket host': 'WebSocketError',
    'image from host port': 'ImageError',
  })
  expect(page.url()).toBe(topUrl)

  // A way to leak a value by navigating its own frame outward — the proxy's frame-src blocks this
  await inner.evaluate(() => {
    location.href = 'https://example.test/leak?secret=1'
  }).catch(() => {})
  await page.waitForTimeout(500)
  expect(leaked).toEqual([])
})

test('per-app origin mode: gets a real origin on its own port, storage is separated per app, and reopening gets the same origin', async ({ page }) => {
  const idA = fx.open({ projectId: 'p1', appId: 'fixture-port' }, 'ui://fixture-port/main')
  const idB = fx.open({ projectId: 'p1', appId: 'other-port' }, 'ui://other-port/main')
  await mount(page, 'a', { appId: 'fixture-port', projectId: 'p1', instanceId: idA })
  await mount(page, 'b', { appId: 'other-port', projectId: 'p1', instanceId: idB })

  const a = (await entry(view(page, 'a'), 'connected')) as { origin: string; href: string; referrer: string }
  const b = (await entry(view(page, 'b'), 'connected')) as { origin: string }
  const portA = Number(new URL(a.origin).port)
  expect(new URL(a.origin).hostname).toBe('127.0.0.1')
  expect(portA).toBeGreaterThanOrEqual(20000)
  expect(portA).toBeLessThanOrEqual(32767)
  expect(b.origin).not.toBe(a.origin)
  // The parent's (proxy's) address does not leak through referrer. The secret in its own address is not the host secret
  expect(a.referrer).toBe('')
  const proxySecret = new URL(page.frames().find((f) => f.url().includes('/views/') && f.url().includes(`:${fx.port}/`))!.url()).pathname.split('/')[1]!
  expect(a.href).not.toContain(proxySecret)

  // The point of this mode: storage works, and it is separated between apps
  const innerA = await innerFrame(page, 'a')
  const innerB = await innerFrame(page, 'b')
  await innerA.evaluate(() => localStorage.setItem('who', 'fixture-port'))
  expect(await innerA.evaluate(() => localStorage.getItem('who'))).toBe('fixture-port')
  expect(await innerB.evaluate(() => localStorage.getItem('who'))).toBeNull()

  // Reopening as a new instance gets the same origin and the same storage
  expect(await page.evaluate(() => (window as any).__appFrame.close('a'))).toBe('answered')
  const idA2 = fx.open({ projectId: 'p1', appId: 'fixture-port' }, 'ui://fixture-port/main')
  await mount(page, 'a2', { appId: 'fixture-port', projectId: 'p1', instanceId: idA2 })
  expect(((await entry(view(page, 'a2'), 'connected')) as { origin: string }).origin).toBe(a.origin)
  expect(await (await innerFrame(page, 'a2')).evaluate(() => localStorage.getItem('who'))).toBe('fixture-port')
})

/**
 * How open views see the same value (M4 B-3d, plan item "how open views see the same value"). The
 * host announces "it changed" every time one of an app's tool calls finishes. Here the parent
 * passes `changeSignal` directly, so only the notification rule itself is checked (the signal's
 * origin is covered by the test below). This is an extension outside the spec, so a view that does
 * not support it must see nothing happen.
 */
test('a "state changed" signal goes out over centralu/notifications/changed once per change in value after init', async ({ page }) => {
  const idA = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  const idB = fx.open({ projectId: null, appId: 'other' }, 'ui://other/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: idA, changeSignal: 5 })
  await mount(page, 'b', { appId: 'other', projectId: null, instanceId: idB, changeSignal: 1 })
  const a = view(page, 'a')
  const b = view(page, 'b')
  // The view learns from the host capabilities that it can use this extension
  expect(((await entry(a, 'connected')) as { hostCapabilities: { experimental: object } }).hostCapabilities.experimental).toEqual({
    'centralu/notifications/changed': {},
  })

  // The value at the moment it was opened is not announced — the view already reads it fresh
  // during init. One round trip is used as a checkpoint: any notification sent before it would
  // have arrived before this result
  await a.locator('#call').click()
  await entry(a, 'call-result')
  await expect(a.locator('li[data-k="notification"]')).toHaveCount(0)

  await page.evaluate(() => (window as any).__appFrame.update('a', { changeSignal: 6 }))
  expect(await entry(a, 'notification')).toEqual({ method: 'centralu/notifications/changed', params: {} })
  // The same value is not announced again, and a new value is announced once more
  await page.evaluate(() => (window as any).__appFrame.update('a', { changeSignal: 6 }))
  await page.evaluate(() => (window as any).__appFrame.update('a', { changeSignal: 7 }))
  await expect(a.locator('li[data-k="notification"]')).toHaveCount(2)
  // It does not reach a view of a different app
  await b.locator('#call').click()
  await entry(b, 'call-result')
  await expect(b.locator('li[data-k="notification"]')).toHaveCount(0)
})

/**
 * The origin of the signal above (B-5): the host's broadcast `external_app_state_changed { appId,
 * projectId }` → the store counts it per (project, app) → an AppFrame that receives no
 * `changeSignal` uses that count. Even a view with no parent wiring receives the update. An app is
 * identified by (project, id), so an app of the same name in a different project is unrelated.
 */
test('the host\'s external_app_state_changed passes through the store and reaches only the open views of that app as a notification', async ({ page }) => {
  const idA = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
  const idB = fx.open({ projectId: 'p2', appId: 'fixture' }, 'ui://fixture/main')
  const idC = fx.open({ projectId: 'p1', appId: 'other' }, 'ui://other/main')
  // No changeSignal is given
  await mount(page, 'a', { appId: 'fixture', projectId: 'p1', instanceId: idA })
  await mount(page, 'b', { appId: 'fixture', projectId: 'p2', instanceId: idB })
  await mount(page, 'c', { appId: 'other', projectId: 'p1', instanceId: idC })
  const hostSays = (appId: string, projectId: string | null) =>
    page.evaluate((e) => (window as any).__mock.emit({ type: 'external_app_state_changed', ...e }), { appId, projectId })

  await hostSays('fixture', 'p1')
  expect(await entry(view(page, 'a'), 'notification')).toEqual({ method: 'centralu/notifications/changed', params: {} })
  await hostSays('fixture', 'p1')
  await expect(view(page, 'a').locator('li[data-k="notification"]')).toHaveCount(2)
  // The user-folder fixture is unrelated too
  await hostSays('fixture', null)

  // One round trip is used as a checkpoint: any notification sent before it would have arrived before this result
  for (const key of ['b', 'c']) {
    const v = view(page, key)
    await v.locator('#call').click()
    await entry(v, 'call-result')
    await expect(v.locator('li[data-k="notification"]')).toHaveCount(0)
  }
  await expect(view(page, 'a').locator('li[data-k="notification"]')).toHaveCount(2)
})

/**
 * A view does not hear its own change played back (B-5). The host attaches the owner (`cause`) of
 * the call that produced the change, and the store keeps it alongside the counter. Measured
 * (65acb43): without this, one template view called `show` roughly 700 times a second — each
 * notification triggered a re-read, and that re-read produced another notification. A different
 * view of the same app must still receive that change (that is the whole point of the
 * notification).
 */
test('a view does not receive its own instance\'s change as a notification, but a different view of the same app does — and a burst of someone else\'s changes is not lost either', async ({ page }) => {
  const idA = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
  const idB = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: 'p1', instanceId: idA })
  await mount(page, 'b', { appId: 'fixture', projectId: 'p1', instanceId: idB })
  const a = view(page, 'a')
  const b = view(page, 'b')
  const heard = (v: FrameLocator) => v.locator('li[data-k="notification"]')
  const change = (cause?: Record<string, unknown>) => ({ type: 'external_app_state_changed', appId: 'fixture', projectId: 'p1', ...(cause ? { cause } : {}) })
  const hostSays = (...events: Record<string, unknown>[]) =>
    page.evaluate((es) => es.forEach((e) => (window as any).__mock.emit(e)), events)
  /** One round trip is used as a checkpoint: any notification sent before it would have arrived before this result */
  const roundTrip = async (v: FrameLocator, nth: number) => {
    await v.locator('#call').click()
    await entry(v, 'call-result', nth)
  }

  // A change caused by a — only b hears it
  await hostSays(change({ kind: 'view', instanceId: idA }))
  await expect(heard(b)).toHaveCount(1)
  await roundTrip(a, 0)
  await expect(heard(a)).toHaveCount(0)
  // A change caused by b — only a hears it
  await hostSays(change({ kind: 'view', instanceId: idB }))
  await expect(heard(a)).toHaveCount(1)
  await roundTrip(b, 0)
  await expect(heard(b)).toHaveCount(1)
  // A change caused by a session, and one with no owner (the host lumped mixed sources together) — both hear it
  await hostSays(change({ kind: 'session', sessionId: 's1' }))
  await expect(heard(a)).toHaveCount(2)
  await expect(heard(b)).toHaveCount(2)
  await hostSays(change())
  await expect(heard(a)).toHaveCount(3)
  await expect(heard(b)).toHaveCount(3)
  // Two arriving in a burst — b's then a's. Even though the last owner is a, a must still hear b's change
  await hostSays(change({ kind: 'view', instanceId: idB }), change({ kind: 'view', instanceId: idA }))
  await expect(heard(a)).toHaveCount(4)
  await expect(heard(b)).toHaveCount(4)
})

test('a view that does not know this extension notification simply ignores it', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'plain' }, 'ui://plain/main')
  await mount(page, 'p', { appId: 'plain', projectId: null, instanceId: id, changeSignal: 1 })
  const v = view(page, 'p')
  await entry(v, 'connected')
  await page.evaluate(() => (window as any).__appFrame.update('p', { changeSignal: 2 }))
  await page.evaluate(() => (window as any).__appFrame.update('p', { changeSignal: 3 }))
  // Even after the notification, the view calls fine and gets its result
  await v.locator('#call').click()
  expect(await entry(v, 'call-result')).toMatchObject({ appId: 'plain' })
  await expect(v.locator('li[data-k="notification"]')).toHaveCount(0)
  await expect(v.locator('li[data-k$="-error"]')).toHaveCount(0)
})

test('a view that is not open fails with a reason', async ({ page }) => {
  await page.evaluate(() => (window as any).__appFrame.mount('x', { appId: 'fixture', projectId: null, instanceId: 'A'.repeat(22) }))
  await expect(page.getByTestId('app-frame-error')).toContainText('This app view is not open')
})

/*
 * Another host behind the connection (#280 step 4): a restart, or a build switch behind the
 * keeper's front door. The mock says so the way the real client does (`resync_required`), and the
 * view asks for its address again.
 */
test.describe('after the connection comes back to another host', () => {
  const resync = (page: Page) => page.evaluate(() => (window as any).__mock.setConnectionState('resync_required'))

  test('the same address leaves the view alone: no reload, the state it built is still there, and it keeps calling', async ({ page }) => {
    const id = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
    await mount(page, 'a', { appId: 'fixture', projectId: 'p1', instanceId: id, toolInput: { q: 'kept' } })
    const v = view(page, 'a')
    await v.locator('#call').click()
    await entry(v, 'call-result')
    expect(frameCalls).toBe(1)

    await resync(page)
    await expect.poll(() => frameCalls).toBe(2)
    // A reload would have started the document over: one `connected`, and the call's line still there
    await expect(v.locator('li[data-k="connected"]')).toHaveCount(1)
    await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
    await expect(page.getByTestId('frame-a').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await v.locator('#call').click()
    await expect(v.locator('li[data-k="call-result"]')).toHaveCount(2)
  })

  test('another address is loaded, and the bridge connects to the new view the way the first load did', async ({ page }) => {
    const id = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
    await mount(page, 'a', { appId: 'fixture', projectId: 'p1', instanceId: id, toolInput: { q: 'moved' } })
    const v = view(page, 'a')
    await entry(v, 'tool-input')

    // The next host serves the same instance at its own port (a host without the keeper's front door)
    const next = await startFixtureHost({ 'fixture ui://fixture/main': { html: fixtureViewHtml() } })
    try {
      expect(next.views.restore([{ id, app: { projectId: 'p1', appId: 'fixture' }, uri: 'ui://fixture/main' }])).toEqual([id])
      serving = next
      await resync(page)
      await expect.poll(() => page.frames().some((f) => f.url().startsWith(`http://127.0.0.1:${next.port}/`))).toBe(true)
      await expect(page.getByTestId('frame-a').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      // The new document heard the input again and its calls reach the mock under this frame's app
      expect(await entry(v, 'tool-input')).toEqual({ q: 'moved' })
      await v.locator('#call').click()
      expect(await entry(v, 'call-result')).toEqual({ appId: 'fixture', tool: 'increment', args: { by: 2 } })
    } finally {
      serving = fx
      await next.close()
    }
  })

  test('a host that no longer has the view fails it with the reason, as a first load would', async ({ page }) => {
    const id = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
    await mount(page, 'a', { appId: 'fixture', projectId: 'p1', instanceId: id })
    fx.views.close(id)
    await resync(page)
    await expect(page.getByTestId('app-frame-error')).toContainText('This app view is not open')
  })
})
