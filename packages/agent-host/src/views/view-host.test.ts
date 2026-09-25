/**
 * 앱 화면 호스팅 (M4 B-3a) — 진짜 HostServer 위에서.
 *
 * 앱 런타임은 이 브랜치에 없으므로 `ViewSource`는 시험 대역이다. 대역이 돌려주는 것은 MCP
 * `resources/read`의 답 모양 그대로다. 브라우저에서 실제로 뜨는지는 e2e(app-frame.spec.ts)가 본다.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { HostServer } from '../transport/server.js'
import { OriginPorts, type PortBook } from './origin-ports.js'
import { PROXY_SCRIPT, PROXY_SCRIPT_HASH } from './proxy-page.js'
import { ViewHost, type AppRef, type OriginMode, type ViewSource } from './view-host.js'
import { VIEW_MIME_TYPE } from './view-document.js'
import { createHash } from 'node:crypto'

const SECRET = 'view-host-test-secret-0123456789abcdef'
const HOST_ORIGIN = 'http://127.0.0.1:5174'
const NOTES: AppRef = { projectId: 'p1', appId: 'notes' }
const OTHER: AppRef = { projectId: 'p1', appId: 'other' }

let server: HostServer | null = null
let views: ViewHost | null = null
afterEach(async () => {
  await views?.dispose()
  await server?.close()
  server = null
  views = null
})

type Doc = { html: string; csp?: object; permissions?: object }

function fakeSource(docs: Record<string, Doc>, modes: Record<string, OriginMode> = {}) {
  const reads: string[] = []
  const source: ViewSource = {
    async readResource(app, uri) {
      reads.push(`${app.projectId}/${app.appId} ${uri}`)
      const doc = docs[`${app.appId} ${uri}`]
      if (!doc) throw new Error(`no such resource ${uri}`)
      return { contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: doc.html, _meta: { ui: { csp: doc.csp, permissions: doc.permissions } } }] }
    },
    originMode: (app) => modes[app.appId] ?? 'opaque',
  }
  return { source, reads }
}

async function start(source: ViewSource | null) {
  let port: number | null = null
  const book: { raw: string | null } = { raw: null }
  views = new ViewHost({
    secret: SECRET,
    allowedOrigins: [HOST_ORIGIN, 'tauri://localhost'],
    source,
    ports: new OriginPorts(
      {
        load: () => (book.raw ? (JSON.parse(book.raw) as PortBook) : null),
        save: (b) => void (book.raw = JSON.stringify(b)),
      },
      { log: () => {} },
    ),
    hostPort: () => port,
    log: () => {},
  })
  server = new HostServer({ port: 0, token: 'tok', onRpc: async () => ({}), http: { secret: SECRET, routes: views.routes } })
  port = await server.listen()
  return { views, port, book }
}

function get(url: string) {
  return new Promise<{ status: number; body: string; csp: string | undefined; referrer: string | undefined }>((resolve, reject) => {
    const u = new URL(url)
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          csp: res.headers['content-security-policy'] as string | undefined,
          referrer: res.headers['referrer-policy'] as string | undefined,
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

/** 프록시 페이지에 실린 설정 JSON */
function pageConfig(body: string): Record<string, string> {
  const m = /<script type="application\/json" id="cc-view-config">(.*?)<\/script>/s.exec(body)
  if (!m?.[1]) throw new Error('no config block')
  return JSON.parse(m[1]) as Record<string, string>
}

describe('ViewHost — 불투명 출처 (기본)', () => {
  it('화면 주소는 비밀 칸 뒤에 있고, 프록시 페이지가 화면의 CSP와 문서를 함께 싣는다', async () => {
    const { source, reads } = fakeSource({
      'notes ui://notes/board': { html: '<p>board</p></script><script>alert(1)</script>', csp: { connectDomains: ['https://api.example.com'] } },
    })
    const { views: v, port } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')

    const frame = await v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })
    expect(frame.url.startsWith(`http://127.0.0.1:${port}/${SECRET}/views/${instanceId}/?`)).toBe(true)
    expect(frame.sandbox.csp.connectDomains).toEqual(['https://api.example.com'])

    const page = await get(frame.url)
    expect(page.status).toBe(200)
    expect(page.referrer).toBe('no-referrer')
    // srcdoc 문서가 물려받을 정책이다 — 선언한 connect만, 나머지는 막힘
    expect(page.csp).toContain('connect-src https://api.example.com')
    expect(page.csp).toContain("frame-src 'none'")
    const cfg = pageConfig(page.body)
    expect(cfg).toMatchObject({ mode: 'opaque', hostOrigin: HOST_ORIGIN, sandbox: 'allow-scripts allow-forms' })
    // 앱의 HTML은 JSON 안에 이스케이프되어 실린다 — `</script>`로 블록을 빠져나오지 못한다
    expect(cfg.html).toBe('<p>board</p></script><script>alert(1)</script>')
    expect(page.body.match(/<\/script>/g)).toHaveLength(2)
    // 문서는 frame()에서 한 번 읽고, 프록시 페이지는 그것을 쓴다
    expect(reads).toEqual(['p1/notes ui://notes/board'])
  })

  it('선언이 없으면 제한 기본값이 헤더로 나간다', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: '<p>x</p>' } })
    const { views: v } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    const page = await get((await v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).url)
    expect(page.csp).toContain("connect-src 'none'")
    expect(page.csp).toContain("default-src 'none'")
  })

  it('화면의 앱은 인스턴스가 정한다 — 다른 앱 이름이나 다른 프로젝트를 대면 열리지 않는다', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: 'x' } })
    const { views: v } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    await expect(v.frame({ app: OTHER, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(v.frame({ app: { projectId: 'p2', appId: 'notes' }, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(v.frame({ app: { projectId: null, appId: 'notes' }, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(v.readResource(OTHER, 'ui://notes/board', instanceId)).rejects.toThrow(/not open/)
  })

  it('허용 목록 밖의 부모 출처에는 주소를 주지 않고, 주소를 비틀어도 404다', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: 'x' } })
    const { views: v, port } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    for (const origin of ['http://evil.example', 'null', '']) {
      await expect(v.frame({ app: NOTES, instanceId, hostOrigin: origin })).rejects.toThrow(/cannot be shown/)
    }
    const good = await v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })
    const base = `http://127.0.0.1:${port}`
    for (const url of [
      good.url.replace(encodeURIComponent(HOST_ORIGIN), encodeURIComponent('http://evil.example')),
      good.url.replace(/\?.*$/, ''),
      good.url.replace(SECRET, SECRET.slice(0, -1) + 'x'),
      good.url.replace(`/${SECRET}`, ''),
      `${base}/${SECRET}/views/${'A'.repeat(22)}/?host=${encodeURIComponent(HOST_ORIGIN)}`,
      `${base}/${SECRET}/views/..%2f..%2f/?host=${encodeURIComponent(HOST_ORIGIN)}`,
    ]) {
      expect((await get(url)).status, url.replace(SECRET, '<secret>')).toBe(404)
    }
    expect((await get(good.url)).status).toBe(200)
  })

  it('닫은 인스턴스는 더 이상 서빙하지 않는다', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: 'x' } })
    const { views: v } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    const { url } = await v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })
    v.close(instanceId)
    expect((await get(url)).status).toBe(404)
    await expect(v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
  })

  it('런타임이 없으면 이유와 함께 실패한다', async () => {
    const { views: v } = await start(null)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    await expect(v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/runtime is not running/)
    await expect(v.readResource(NOTES, 'ui://notes/x')).rejects.toThrow(/runtime is not running/)
  })

  it('화면이 아닌 리소스는 띄우지 않는다', async () => {
    const source: ViewSource = { readResource: async (_a, uri) => ({ contents: [{ uri, mimeType: 'text/html', text: '<p>' }] }) }
    const { views: v } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    await expect(v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not an app view/)
  })
})

describe('ViewHost — 앱별 출처', () => {
  it('프록시는 앱의 고정 포트를 가리키고, 그 포트는 그 앱의 화면만 파생 비밀 뒤에서 서빙한다', async () => {
    const { source } = fakeSource(
      {
        'notes ui://notes/board': { html: '<p>notes</p>', csp: { resourceDomains: ['https://cdn.example.com'] } },
        'other ui://other/main': { html: '<p>other</p>' },
      },
      { notes: 'app', other: 'app' },
    )
    const { views: v, port, book } = await start(source)
    const notes = v.open(NOTES, 'ui://notes/board')
    const other = v.open(OTHER, 'ui://other/main')

    const frame = await v.frame({ app: NOTES, instanceId: notes.instanceId, hostOrigin: HOST_ORIGIN })
    const page = await get(frame.url)
    expect(page.status).toBe(200)
    const cfg = pageConfig(page.body)
    const appPort = (JSON.parse(book.raw!) as PortBook).assigned['p1/notes']
    expect(appPort).toBeGreaterThanOrEqual(20000)
    expect(appPort).toBeLessThanOrEqual(32767)
    const appOrigin = `http://127.0.0.1:${appPort}`
    expect(cfg).toMatchObject({ mode: 'app', appOrigin, sandbox: 'allow-scripts allow-same-origin allow-forms' })
    // 프록시 자신의 정책: 자기 스크립트(해시)와 그 앱의 출처 하나만
    expect(page.csp).toContain(`script-src '${PROXY_SCRIPT_HASH}'`)
    expect(page.csp).toContain(`frame-src ${appOrigin}`)
    expect(PROXY_SCRIPT_HASH).toBe(`sha256-${createHash('sha256').update(PROXY_SCRIPT).digest('base64')}`)

    // 화면의 주소에는 host 비밀이 아니라 파생 비밀이 있다 (화면이 location.href로 읽는 값이다)
    const src = new URL(cfg.src!)
    expect(src.origin).toBe(appOrigin)
    expect(src.pathname).not.toContain(SECRET)
    const doc = await get(cfg.src!)
    expect(doc.status).toBe(200)
    expect(doc.body).toBe('<p>notes</p>')
    expect(doc.csp).toContain('script-src \'unsafe-inline\' https://cdn.example.com')
    expect(doc.csp).toContain("connect-src 'none'")

    // 그 포트는 다른 앱의 인스턴스를 서빙하지 않고, host 비밀로도 열리지 않는다
    expect((await get(cfg.src!.replace(notes.instanceId, other.instanceId))).status).toBe(404)
    expect((await get(`${appOrigin}/${SECRET}/views/${notes.instanceId}/view`)).status).toBe(404)
    // 파생 비밀은 host 포트에서 통하지 않는다
    const derived = src.pathname.split('/')[1]!
    expect((await get(`http://127.0.0.1:${port}/${derived}/views/${notes.instanceId}/?host=${encodeURIComponent(HOST_ORIGIN)}`)).status).toBe(404)

    // 다른 앱은 다른 포트, 다른 비밀
    const otherCfg = pageConfig((await get((await v.frame({ app: OTHER, instanceId: other.instanceId, hostOrigin: HOST_ORIGIN })).url)).body)
    expect(otherCfg.appOrigin).not.toBe(appOrigin)
    expect(new URL(otherCfg.src!).pathname.split('/')[1]).not.toBe(derived)
  })

  it('같은 앱은 host를 다시 띄워도 같은 포트를 받는다', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: 'x' } }, { notes: 'app' })
    const first = await start(source)
    const i1 = first.views.open(NOTES, 'ui://notes/board')
    const cfg1 = pageConfig((await get((await first.views.frame({ app: NOTES, instanceId: i1.instanceId, hostOrigin: HOST_ORIGIN })).url)).body)
    const saved = first.book.raw
    await views!.dispose()
    await server!.close()

    const second = await start(source)
    second.book.raw = saved
    const i2 = second.views.open(NOTES, 'ui://notes/board')
    const cfg2 = pageConfig((await get((await second.views.frame({ app: NOTES, instanceId: i2.instanceId, hostOrigin: HOST_ORIGIN })).url)).body)
    expect(cfg2.appOrigin).toBe(cfg1.appOrigin)
  })
})
