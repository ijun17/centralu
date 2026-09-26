import { expect, test, type Frame, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * 앱 화면 한 장 (M4 B-3c) — AppFrame + 진짜 host의 샌드박스 프록시 + 공식 ext-apps 2.x `App`.
 *
 * 목 플랫폼 위의 시험대 페이지(`/app-frame.html`)에 AppFrame을 세운다. 주소는 이 워커가 띄운
 * 진짜 HostServer·ViewHost가 만든다(비밀 경로, CSP, 앱별 출처 포트 모두 실물). 화면이 부르는
 * 도구와 리소스는 목의 `AppsPort`에 닿는다. 그래서 "무엇이 어느 앱 이름으로 나갔나"를 목이
 * 적어 둔다.
 *
 * Tauri IPC 차단(S-2)의 실측은 여기서 할 수 없다. 이 브라우저에는 Tauri가 없다. 여기서는
 * 브라우저만으로 잴 수 있는 것(부모·최상위 창 접근, 저장소, 팝업, host로의 네트워크, 최상위
 * 이동)을 잰다. 진짜 창의 IPC는 도그푸딩에서 확인한다.
 */

let fx: FixtureHost

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
  // 시험대의 목이 화면 주소를 물으면 진짜 ViewHost가 답한다
  await page.exposeFunction(
    '__viewFrame',
    (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
      fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
  )
  await page.goto('/app-frame.html')
  await page.waitForFunction(() => !!(window as any).__appFrame)
})

type Props = { appId: string; projectId?: string | null; instanceId: string; toolInput?: unknown; toolResult?: unknown; changeSignal?: number }

async function mount(page: Page, key: string, props: Props) {
  await page.evaluate(({ k, p }) => (window as any).__appFrame.mount(k, p), { k: key, p: props })
  await expect(page.getByTestId(`frame-${key}`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
}

/** 앱의 HTML이 도는 안쪽 프레임 (바깥은 프록시) */
function view(page: Page, key: string): FrameLocator {
  return page.getByTestId(`frame-${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
}

/** 화면이 적은 줄 하나를 JSON으로 */
async function entry(v: FrameLocator, k: string, nth = 0): Promise<unknown> {
  const li = v.locator(`li[data-k="${k}"]`).nth(nth)
  await expect(li).toBeVisible()
  const text = (await li.textContent()) ?? ''
  return JSON.parse(text.slice(k.length + 1))
}

async function calls(page: Page) {
  return page.evaluate(() => (window as any).__mock.appToolCalls as { appId: string; tool: string; args: Record<string, unknown>; from: Record<string, unknown> }[])
}

/** 이름으로 안쪽 프레임을 찾는다 — evaluate가 필요할 때 (FrameLocator로는 못 한다) */
async function innerFrame(page: Page, key: string): Promise<Frame> {
  const outer = await page.getByTestId(`frame-${key}`).getByTestId('app-frame-iframe').elementHandle()
  const proxy = await outer!.contentFrame()
  const inner = await (await proxy!.waitForSelector('iframe'))!.contentFrame()
  await inner!.waitForSelector('li[data-k="connected"]')
  return inner!
}

test('화면이 초기화되고, 입력·결과를 받고, 단추가 목의 callTool에 닿아 결과가 화면에 보인다', async ({ page }) => {
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

  // 규격의 수명 메시지: 초기화 → tool-input → tool-result
  expect(await entry(v, 'tool-input')).toEqual({ q: 'weather' })
  expect(await entry(v, 'tool-result')).toEqual({ answer: 42 })

  // 화면의 단추 → AppBridge.oncalltool → AppsPort.callTool (목) → 결과가 화면으로
  await v.locator('#call').click()
  expect(await entry(v, 'call-result')).toEqual({ appId: 'fixture', tool: 'increment', args: { by: 2 } })
  expect(await calls(page)).toEqual([{ appId: 'fixture', tool: 'increment', args: { by: 2 }, from: { projectId: 'p1', instanceId: id } }])

  // onreadresource → AppsPort.readResource (목)
  await v.locator('#read').click()
  expect(await entry(v, 'read-result')).toEqual([{ uri: 'ui://fixture/data', mimeType: 'application/json', text: '{"n":1}' }])
  expect(await page.evaluate(() => (window as any).__mock.appResourceReads)).toEqual([
    { appId: 'fixture', uri: 'ui://fixture/data', from: { projectId: 'p1', instanceId: id } },
  ])

  // size-changed → 높이
  const before = (await page.getByTestId('frame-a').getByTestId('app-frame-iframe').boundingBox())!.height
  await v.locator('#grow').click()
  await expect.poll(async () => (await page.getByTestId('frame-a').getByTestId('app-frame-iframe').boundingBox())!.height).toBeGreaterThan(before + 500)
})

test('불투명 방식: 안쪽 프레임의 출처는 "null"이고, 프록시의 비밀 주소를 읽지 못한다', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  const connected = (await entry(view(page, 'a'), 'connected')) as Record<string, unknown>
  expect(connected).toMatchObject({ origin: 'null', href: 'about:srcdoc', referrer: '' })

  // 프록시는 host 포트의 다른 출처에서 온다 (우리 화면의 출처가 아니다)
  const proxy = page.frames().find((f) => f.url().includes('/views/'))!
  expect(new URL(proxy.url()).origin).toBe(`http://127.0.0.1:${fx.port}`)
  expect(new URL(proxy.url()).origin).not.toBe(new URL(page.url()).origin)
})

test('다른 앱을 적은 메시지는 호출의 앱을 바꾸지 못한다', async ({ page }) => {
  const idA = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
  const idB = fx.open({ projectId: 'p2', appId: 'other' }, 'ui://other/main')
  await mount(page, 'a', { appId: 'fixture', projectId: 'p1', instanceId: idA })
  await mount(page, 'b', { appId: 'other', projectId: 'p2', instanceId: idB })
  const a = view(page, 'a')

  // SDK로: params와 _meta에 남의 앱을 적는다
  await a.locator('#spoof').click()
  await entry(a, 'spoof-result')
  // 날 JSON-RPC로: 규격 밖 칸(appId, app, projectId)을 붙인다
  await a.locator('#raw').click()
  await expect.poll(async () => (await calls(page)).length).toBe(2)
  // 프록시를 건너뛰고 최상위 창에 곧바로 — 받아서는 안 된다. 뒤이은 정상 호출이 도착하면
  // 그보다 먼저 부친 이 메시지는 이미 버려진 것이다 (postMessage는 순서를 지킨다)
  await a.locator('#direct').click()
  await entry(a, 'direct-sent')
  await a.locator('#call').click()
  await entry(a, 'call-result')
  // 다른 앱의 화면은 자기 앱 이름으로만 부른다
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
 * 링크는 플랫폼의 바깥 열기(system.openUrl)로 간다 (#159). 예전에는 AppFrame이 window.open을 직접 불렀고,
 * 여기(Chromium)서는 새 페이지가 떠서 초록이었지만 데스크톱 웹뷰(WKWebView)에서는 아무것도 열리지 않았다.
 * 그래서 새 페이지가 뜨는지가 아니라 **포트에 닿았는지**를 보고, 웹뷰가 스스로 창을 띄우지 않았는지도 본다.
 */
test('링크는 사람이 확인한 뒤 플랫폼의 바깥 열기로 열고, http(s)·mailto가 아니면 묻지도 않고 거절한다', async ({ page, context }) => {
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

test('ui/message는 부모가 준 콜백으로 간다', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  await view(page, 'a').locator('#msg').click()
  expect(await entry(view(page, 'a'), 'msg-result')).toEqual({})
  expect(await page.evaluate(() => (window as any).__appFrame.events.filter((e: { kind: string }) => e.kind === 'message'))).toEqual([
    { kind: 'message', key: 'a', value: { role: 'user', content: [{ type: 'text', text: 'hello from the view' }] } },
  ])
})

test('테마와 글자 크기가 host context로 가고, 글자 크기를 바꾸면 바뀐 칸만 host-context-changed로 간다', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  const v = view(page, 'a')
  const connected = (await entry(v, 'connected')) as { hostContext: Record<string, any> }
  expect(connected.hostContext).toMatchObject({ theme: 'dark', displayMode: 'inline', centralu: { fontScale: 1 } })
  // 색은 화면이 놓인 자리의 우리 토큰에서 읽는다
  expect(connected.hostContext.styles.variables['--color-text-primary']).toBe('#e9e9e9')

  await page.evaluate(() => (window as any).__store.setState({ textScale: 4 }))
  expect(await entry(v, 'host-context-changed')).toEqual({ centralu: { fontScale: 1.25 } })
})

test('내리기 전에 teardown을 보내고 답을 받는다 — 답하지 않는 화면은 잠깐만 기다린다', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  const hang = fx.open({ projectId: null, appId: 'hang' }, 'ui://hang/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: id })
  await mount(page, 'h', { appId: 'hang', projectId: null, instanceId: hang })

  expect(await calls(page)).toEqual([])
  expect(await page.evaluate(() => (window as any).__appFrame.close('a'))).toBe('answered')
  await expect(page.getByTestId('frame-a')).toHaveCount(0)
  // 화면은 요청을 받았고, 내려가기 전에 저장까지 마쳤다 (그 호출이 목에 닿았다)
  expect((await calls(page)).map((c) => [c.appId, c.tool])).toEqual([['fixture', 'save-on-teardown']])

  const t0 = Date.now()
  expect(await page.evaluate(() => (window as any).__appFrame.close('h'))).toBe('timeout')
  const waited = Date.now() - t0
  expect(waited).toBeGreaterThanOrEqual(900)
  expect(waited).toBeLessThan(5000)
})

/**
 * S-2 중 브라우저만으로 잴 수 있는 것. 안쪽 프레임에서 직접 시도한다(Playwright의 evaluate는
 * 그 프레임의 스크립트로 돈다 — 네트워크는 그 프레임의 CSP를 그대로 받는다).
 */
test('S-2 (브라우저 부분): 앱 프레임은 부모·최상위·저장소·팝업·host 네트워크에 닿지 못한다', async ({ page, context }) => {
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
    // 팝업은 sandbox가 막는다 (null을 돌려준다)
    'window.open': 'ok:null',
    'top.location': 'SecurityError',
    'fetch host port': 'TypeError',
    'fetch example.test': 'TypeError',
    'WebSocket host': 'WebSocketError',
    'image from host port': 'ImageError',
  })
  expect(page.url()).toBe(topUrl)

  // 제 프레임을 바깥으로 보내 값을 흘리는 길 — 프록시의 frame-src가 막는다
  await inner.evaluate(() => {
    location.href = 'https://example.test/leak?secret=1'
  }).catch(() => {})
  await page.waitForTimeout(500)
  expect(leaked).toEqual([])
})

test('앱별 출처 방식: 자기 포트의 진짜 출처를 받고, 저장소는 앱마다 나뉘며, 다시 열어도 같은 출처다', async ({ page }) => {
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
  // 부모(프록시)의 주소는 referrer로 새지 않는다. 자기 주소의 비밀은 host 비밀이 아니다
  expect(a.referrer).toBe('')
  const proxySecret = new URL(page.frames().find((f) => f.url().includes('/views/') && f.url().includes(`:${fx.port}/`))!.url()).pathname.split('/')[1]!
  expect(a.href).not.toContain(proxySecret)

  // 이 방식의 목적: 저장소가 되고, 앱끼리는 나뉜다
  const innerA = await innerFrame(page, 'a')
  const innerB = await innerFrame(page, 'b')
  await innerA.evaluate(() => localStorage.setItem('who', 'fixture-port'))
  expect(await innerA.evaluate(() => localStorage.getItem('who'))).toBe('fixture-port')
  expect(await innerB.evaluate(() => localStorage.getItem('who'))).toBeNull()

  // 새 인스턴스로 다시 열면 같은 출처, 같은 저장소
  expect(await page.evaluate(() => (window as any).__appFrame.close('a'))).toBe('answered')
  const idA2 = fx.open({ projectId: 'p1', appId: 'fixture-port' }, 'ui://fixture-port/main')
  await mount(page, 'a2', { appId: 'fixture-port', projectId: 'p1', instanceId: idA2 })
  expect(((await entry(view(page, 'a2'), 'connected')) as { origin: string }).origin).toBe(a.origin)
  expect(await (await innerFrame(page, 'a2')).evaluate(() => localStorage.getItem('who'))).toBe('fixture-port')
})

/**
 * 열린 화면이 같은 값을 보는 법 (M4 B-3d, 플랜 "열린 화면이 같은 값을 보는 법"). 앱의 도구
 * 호출이 끝날 때마다 host가 "바뀌었다"를 알린다. 여기서는 부모가 `changeSignal`을 직접 넘겨
 * 알림의 규칙만 본다(신호의 출처는 아래 시험). 표준 밖의 확장이라, 받지 않는 화면에는 아무 일도
 * 없어야 한다.
 */
test('상태가 바뀌었다는 신호는 초기화 뒤 값이 바뀔 때마다 한 번씩 centralu/notifications/changed로 간다', async ({ page }) => {
  const idA = fx.open({ projectId: null, appId: 'fixture' }, 'ui://fixture/main')
  const idB = fx.open({ projectId: null, appId: 'other' }, 'ui://other/main')
  await mount(page, 'a', { appId: 'fixture', projectId: null, instanceId: idA, changeSignal: 5 })
  await mount(page, 'b', { appId: 'other', projectId: null, instanceId: idB, changeSignal: 1 })
  const a = view(page, 'a')
  const b = view(page, 'b')
  // 화면은 이 확장을 쓸 수 있다는 것을 host 능력에서 안다
  expect(((await entry(a, 'connected')) as { hostCapabilities: { experimental: object } }).hostCapabilities.experimental).toEqual({
    'centralu/notifications/changed': {},
  })

  // 연 순간의 값은 알리지 않는다 — 화면은 초기화하면서 이미 새로 읽는다. 왕복 하나를 기준점으로
  // 삼는다: 그 전에 부친 알림이 있었다면 결과보다 먼저 도착했을 것이다
  await a.locator('#call').click()
  await entry(a, 'call-result')
  await expect(a.locator('li[data-k="notification"]')).toHaveCount(0)

  await page.evaluate(() => (window as any).__appFrame.update('a', { changeSignal: 6 }))
  expect(await entry(a, 'notification')).toEqual({ method: 'centralu/notifications/changed', params: {} })
  // 같은 값은 다시 알리지 않고, 새 값은 한 번 더
  await page.evaluate(() => (window as any).__appFrame.update('a', { changeSignal: 6 }))
  await page.evaluate(() => (window as any).__appFrame.update('a', { changeSignal: 7 }))
  await expect(a.locator('li[data-k="notification"]')).toHaveCount(2)
  // 다른 앱의 화면에는 가지 않는다
  await b.locator('#call').click()
  await entry(b, 'call-result')
  await expect(b.locator('li[data-k="notification"]')).toHaveCount(0)
})

/**
 * 위 신호의 출처 (B-5): host의 방송 `external_app_state_changed { appId, projectId }` → 스토어가
 * (프로젝트, 앱)마다 센다 → `changeSignal`을 받지 않은 AppFrame이 그 수를 쓴다. 부모 배선이 없는
 * 화면도 갱신을 받는다. 앱은 (프로젝트, id)로 하나라 다른 프로젝트의 같은 이름 앱은 남이다.
 */
test('host의 external_app_state_changed가 스토어를 지나 그 앱의 열린 화면에만 알림으로 간다', async ({ page }) => {
  const idA = fx.open({ projectId: 'p1', appId: 'fixture' }, 'ui://fixture/main')
  const idB = fx.open({ projectId: 'p2', appId: 'fixture' }, 'ui://fixture/main')
  const idC = fx.open({ projectId: 'p1', appId: 'other' }, 'ui://other/main')
  // changeSignal을 주지 않는다
  await mount(page, 'a', { appId: 'fixture', projectId: 'p1', instanceId: idA })
  await mount(page, 'b', { appId: 'fixture', projectId: 'p2', instanceId: idB })
  await mount(page, 'c', { appId: 'other', projectId: 'p1', instanceId: idC })
  const hostSays = (appId: string, projectId: string | null) =>
    page.evaluate((e) => (window as any).__mock.emit({ type: 'external_app_state_changed', ...e }), { appId, projectId })

  await hostSays('fixture', 'p1')
  expect(await entry(view(page, 'a'), 'notification')).toEqual({ method: 'centralu/notifications/changed', params: {} })
  await hostSays('fixture', 'p1')
  await expect(view(page, 'a').locator('li[data-k="notification"]')).toHaveCount(2)
  // 사용자 폴더의 fixture도 남이다
  await hostSays('fixture', null)

  // 왕복 하나를 기준점으로 삼는다: 그 전에 부친 알림이 있었다면 결과보다 먼저 도착했을 것이다
  for (const key of ['b', 'c']) {
    const v = view(page, key)
    await v.locator('#call').click()
    await entry(v, 'call-result')
    await expect(v.locator('li[data-k="notification"]')).toHaveCount(0)
  }
  await expect(view(page, 'a').locator('li[data-k="notification"]')).toHaveCount(2)
})

/**
 * 화면은 자기가 낸 바뀜을 다시 듣지 않는다 (B-5). host는 그 바뀜을 낸 호출의 주인(`cause`)을 싣고, 스토어가
 * 카운터 곁에 둔다. 실측(65acb43): 이것이 없을 때 템플릿 화면 하나가 초당 약 700번 `show`를 불렀다 — 알림마다
 * 다시 읽고, 그 읽기가 또 알림을 냈다. 같은 앱의 다른 화면은 그 바뀜을 받아야 한다(그것이 알림의 쓸모다).
 */
test('화면은 자기 인스턴스가 낸 바뀜을 알림으로 받지 않고, 같은 앱의 다른 화면은 받는다 — 몰려 온 남의 바뀜도 잃지 않는다', async ({ page }) => {
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
  /** 왕복 하나를 기준점으로 삼는다: 그 전에 부친 알림이 있었다면 결과보다 먼저 도착했을 것이다 */
  const roundTrip = async (v: FrameLocator, nth: number) => {
    await v.locator('#call').click()
    await entry(v, 'call-result', nth)
  }

  // a가 낸 바뀜 — b만 듣는다
  await hostSays(change({ kind: 'view', instanceId: idA }))
  await expect(heard(b)).toHaveCount(1)
  await roundTrip(a, 0)
  await expect(heard(a)).toHaveCount(0)
  // b가 낸 바뀜 — a만 듣는다
  await hostSays(change({ kind: 'view', instanceId: idB }))
  await expect(heard(a)).toHaveCount(1)
  await roundTrip(b, 0)
  await expect(heard(b)).toHaveCount(1)
  // 세션이 낸 바뀜, 주인이 없는 바뀜(host가 섞인 것을 모았다) — 둘 다 듣는다
  await hostSays(change({ kind: 'session', sessionId: 's1' }))
  await expect(heard(a)).toHaveCount(2)
  await expect(heard(b)).toHaveCount(2)
  await hostSays(change())
  await expect(heard(a)).toHaveCount(3)
  await expect(heard(b)).toHaveCount(3)
  // 한 번에 몰려 온 둘 — b의 것 다음에 a의 것. 마지막 주인이 a여도 a는 b의 바뀜을 들어야 한다
  await hostSays(change({ kind: 'view', instanceId: idB }), change({ kind: 'view', instanceId: idA }))
  await expect(heard(a)).toHaveCount(4)
  await expect(heard(b)).toHaveCount(4)
})

test('확장 알림을 모르는 화면은 그냥 지나간다', async ({ page }) => {
  const id = fx.open({ projectId: null, appId: 'plain' }, 'ui://plain/main')
  await mount(page, 'p', { appId: 'plain', projectId: null, instanceId: id, changeSignal: 1 })
  const v = view(page, 'p')
  await entry(v, 'connected')
  await page.evaluate(() => (window as any).__appFrame.update('p', { changeSignal: 2 }))
  await page.evaluate(() => (window as any).__appFrame.update('p', { changeSignal: 3 }))
  // 알림 뒤에도 화면은 멀쩡히 호출하고 답을 받는다
  await v.locator('#call').click()
  expect(await entry(v, 'call-result')).toMatchObject({ appId: 'plain' })
  await expect(v.locator('li[data-k="notification"]')).toHaveCount(0)
  await expect(v.locator('li[data-k$="-error"]')).toHaveCount(0)
})

test('열리지 않은 화면은 이유와 함께 실패한다', async ({ page }) => {
  await page.evaluate(() => (window as any).__appFrame.mount('x', { appId: 'fixture', projectId: null, instanceId: 'A'.repeat(22) }))
  await expect(page.getByTestId('app-frame-error')).toContainText('This app view is not open')
})
