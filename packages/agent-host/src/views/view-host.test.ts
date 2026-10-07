/**
 * App view hosting (M4 B-3a) — on top of a real HostServer.
 *
 * Here `ViewSource` is a test stand-in. What the stand-in returns is exactly the shape of an MCP
 * `resources/read` answer. The seam where the real runtime meets a real app process is covered by
 * `app-views.test.ts`, and whether it actually comes up in a browser is covered by e2e
 * (app-frame.spec.ts).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { HostServer } from '../transport/server.js'
import { OriginPorts, type PortBook } from './origin-ports.js'
import { DRAG_RELAY_SCRIPT, withDragRelay } from './drag-relay.js'
import { PROXY_SCRIPT, PROXY_SCRIPT_HASH } from './proxy-page.js'
import { MAX_INSTANCES, ViewHost, type AppRef, type OriginMode, type ViewSource } from './view-host.js'
import { VIEW_MIME_TYPE } from './view-document.js'
import { createHash } from 'node:crypto'
import { connect, createServer, type Server as NetServer } from 'node:net'

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

async function start(source: ViewSource | null, opts: { addressPort?: () => number } = {}) {
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
    hostPort: () => opts.addressPort?.() ?? port,
    log: () => {},
  })
  server = new HostServer({ port: 0, token: 'tok', onRpc: async () => ({}), http: { secret: SECRET, routes: views.routes } })
  port = await server.listen()
  return { views, port, book }
}

function get(url: string) {
  return new Promise<{ status: number; body: string; csp: string | undefined; referrer: string | undefined }>((resolve, reject) => {
    const u = new URL(url)
    // Each request on its own connection: a kept-alive one may be a relay to a host the test has just closed
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', agent: false }, (res) => {
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

/** The config JSON embedded in the proxy page */
function pageConfig(body: string): Record<string, string> {
  const m = /<script type="application\/json" id="cc-view-config">(.*?)<\/script>/s.exec(body)
  if (!m?.[1]) throw new Error('no config block')
  return JSON.parse(m[1]) as Record<string, string>
}

describe('ViewHost — opaque origin (default)', () => {
  it("the view's address sits behind the secret path, and the proxy page carries the view's CSP and document together", async () => {
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
    // The policy the srcdoc document inherits — only the declared connect, everything else blocked
    expect(page.csp).toContain('connect-src https://api.example.com')
    expect(page.csp).toContain("frame-src 'none'")
    const cfg = pageConfig(page.body)
    expect(cfg).toMatchObject({ mode: 'opaque', hostOrigin: HOST_ORIGIN, sandbox: 'allow-scripts allow-forms' })
    // The app's HTML is embedded escaped inside the JSON — it cannot escape the block with `</script>`.
    // The host's drag relay rides along at its end (#308)
    expect(cfg.html).toBe(withDragRelay('<p>board</p></script><script>alert(1)</script>'))
    expect(cfg.html).toContain(DRAG_RELAY_SCRIPT)
    expect(page.body.match(/<\/script>/g)).toHaveLength(2)
    // The document is read once in frame(), and the proxy page uses that
    expect(reads).toEqual(['p1/notes ui://notes/board'])
  })

  it('the restrictive default goes out in the header when nothing is declared', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: '<p>x</p>' } })
    const { views: v } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    const page = await get((await v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).url)
    expect(page.csp).toContain("connect-src 'none'")
    expect(page.csp).toContain("default-src 'none'")
  })

  it('the instance decides which app the view belongs to — presenting a different app name or project does not open it', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: 'x' } })
    const { views: v } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    await expect(v.frame({ app: OTHER, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(v.frame({ app: { projectId: 'p2', appId: 'notes' }, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(v.frame({ app: { projectId: null, appId: 'notes' }, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(v.readResource(OTHER, 'ui://notes/board', instanceId)).rejects.toThrow(/not open/)
  })

  it('gives no address to a parent origin outside the allow list, and 404s even when the address is tampered with', async () => {
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

  it('a closed instance no longer serves', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: 'x' } })
    const { views: v } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    const { url } = await v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })
    v.close(instanceId)
    expect((await get(url)).status).toBe(404)
    await expect(v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
  })

  it('fails with a reason when the runtime is absent', async () => {
    const { views: v } = await start(null)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    await expect(v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/runtime is not running/)
    await expect(v.readResource(NOTES, 'ui://notes/x')).rejects.toThrow(/runtime is not running/)
  })

  it('does not render a resource that is not a view', async () => {
    const source: ViewSource = { readResource: async (_a, uri) => ({ contents: [{ uri, mimeType: 'text/html', text: '<p>' }] }) }
    const { views: v } = await start(source)
    const { instanceId } = v.open(NOTES, 'ui://notes/board')
    await expect(v.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not an app view/)
  })
})

describe('ViewHost — per-app origin', () => {
  it("the proxy points to the app's fixed port, and that port serves only that app's view, behind a derived secret", async () => {
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
    // The proxy's own policy: only its own script (hash) and that one app's origin
    expect(page.csp).toContain(`script-src '${PROXY_SCRIPT_HASH}'`)
    expect(page.csp).toContain(`frame-src ${appOrigin}`)
    expect(PROXY_SCRIPT_HASH).toBe(`sha256-${createHash('sha256').update(PROXY_SCRIPT).digest('base64')}`)

    // The view's address carries a derived secret, not the host secret (this is the value the view reads via location.href)
    const src = new URL(cfg.src!)
    expect(src.origin).toBe(appOrigin)
    expect(src.pathname).not.toContain(SECRET)
    const doc = await get(cfg.src!)
    expect(doc.status).toBe(200)
    // The per-app origin's document carries the drag relay too (#308)
    expect(doc.body).toBe(withDragRelay('<p>notes</p>'))
    expect(doc.body).toContain(DRAG_RELAY_SCRIPT)
    expect(doc.csp).toContain('script-src \'unsafe-inline\' https://cdn.example.com')
    expect(doc.csp).toContain("connect-src 'none'")

    // That port does not serve another app's instance, and does not open with the host secret either
    expect((await get(cfg.src!.replace(notes.instanceId, other.instanceId))).status).toBe(404)
    expect((await get(`${appOrigin}/${SECRET}/views/${notes.instanceId}/view`)).status).toBe(404)
    // A derived secret does not work on the host port
    const derived = src.pathname.split('/')[1]!
    expect((await get(`http://127.0.0.1:${port}/${derived}/views/${notes.instanceId}/?host=${encodeURIComponent(HOST_ORIGIN)}`)).status).toBe(404)

    // A different app gets a different port and a different secret
    const otherCfg = pageConfig((await get((await v.frame({ app: OTHER, instanceId: other.instanceId, hostOrigin: HOST_ORIGIN })).url)).body)
    expect(otherCfg.appOrigin).not.toBe(appOrigin)
    expect(new URL(otherCfg.src!).pathname.split('/')[1]).not.toBe(derived)
  })

  it('the same app gets the same port even after the host restarts', async () => {
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

describe('ViewHost — an open view holds the app open', () => {
  /**
   * Counts holds per app. The release function counts every time it is called — the runtime's
   * retainView ignores a second release, but releasing exactly once is something ViewHost itself
   * has to guarantee (a different ViewSource could behave differently).
   */
  function holdingSource() {
    const held = new Map<string, number>()
    const bump = (app: AppRef, by: number) => held.set(ViewHost.originKey(app), (held.get(ViewHost.originKey(app)) ?? 0) + by)
    const source: ViewSource = {
      readResource: async (_a, uri) => ({ contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: 'x' }] }),
      retain(app) {
        if (app.appId === 'ghost') throw new Error('no such app')
        bump(app, 1)
        return () => void bump(app, -1)
      },
    }
    return { source, held }
  }

  it('holds the app open on open, and releases it on close — closing twice releases only once', async () => {
    const { source, held } = holdingSource()
    const { views: v } = await start(source)
    const a = v.open(NOTES, 'ui://notes/board')
    const b = v.open(NOTES, 'ui://notes/board')
    expect(held.get('p1/notes')).toBe(2)
    v.close(a.instanceId)
    v.close(a.instanceId)
    expect(held.get('p1/notes')).toBe(1)
    v.close(b.instanceId)
    expect(held.get('p1/notes')).toBe(0)
  })

  it('a nonexistent app neither opens nor creates an instance', async () => {
    const { source } = holdingSource()
    const { views: v } = await start(source)
    expect(() => v.open({ projectId: 'p1', appId: 'ghost' }, 'ui://ghost/main')).toThrow(/no such app/)
    expect((v as unknown as { instances: Map<string, unknown> }).instances.size).toBe(0)
  })

  it('releases a view pushed out by the cap, and any views still open when it shuts down', async () => {
    const { source, held } = holdingSource()
    const { views: v } = await start(source)
    v.open(OTHER, 'ui://other/main')
    for (let i = 0; i < MAX_INSTANCES; i++) v.open(NOTES, 'ui://notes/board')
    // The oldest one (other) was pushed out
    expect(held.get('p1/other')).toBe(0)
    expect(held.get('p1/notes')).toBe(MAX_INSTANCES)
    await v.dispose()
    expect(held.get('p1/notes')).toBe(0)
  })
})

/**
 * The keeper's front door as far as views care (apps/desktop/src-tauri/keeper/src/keeper/front_door.rs):
 * one loopback port that relays bytes, unread, to whichever host is current.
 */
async function frontDoor(): Promise<{ port: number; pointAt(port: number): void; close(): Promise<void> }> {
  let target = 0
  const door: NetServer = createServer((client) => {
    const host = connect(target, '127.0.0.1')
    client.pipe(host).pipe(client)
    // One side gone closes the other, as the keeper closes what is relayed through it on a swap
    client.on('close', () => host.destroy())
    host.on('close', () => client.destroy())
    client.on('error', () => {})
    host.on('error', () => {})
  })
  await new Promise<void>((r) => door.listen(0, '127.0.0.1', () => r()))
  const port = (door.address() as { port: number }).port
  return {
    port,
    pointAt: (p) => void (target = p),
    close: () => new Promise<void>((r) => door.close(() => r())),
  }
}

describe('ViewHost — a planned hand-over (#280 step 4)', () => {
  it('a view handed to the next host behind the same front door keeps its id and its address, and that address still serves it', async () => {
    const { source } = fakeSource({ 'notes ui://notes/board': { html: '<p>board</p>' } })
    const door = await frontDoor()
    try {
      const first = await start(source, { addressPort: () => door.port })
      door.pointAt(first.port)
      const { instanceId } = first.views.open(NOTES, 'ui://notes/board')
      const before = await first.views.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })
      expect(new URL(before.url).port).toBe(String(door.port))
      expect((await get(before.url)).status).toBe(200)
      const handed = first.views.list()
      await views!.dispose()
      await server!.close()

      // The next host: the same derived secret, behind the same door
      const second = await start(source, { addressPort: () => door.port })
      door.pointAt(second.port)
      expect(second.port).not.toBe(first.port)
      expect(second.views.restore(handed)).toEqual([instanceId])
      // The address the UI already holds is served by the new host, and asking again gives the same one
      const page = await get(before.url)
      expect(page.status).toBe(200)
      expect(pageConfig(page.body).html).toBe(withDragRelay('<p>board</p>'))
      expect((await second.views.frame({ app: NOTES, instanceId, hostOrigin: HOST_ORIGIN })).url).toBe(before.url)
      expect(second.views.describe(instanceId)).toEqual({ app: NOTES, uri: 'ui://notes/board' })
    } finally {
      await door.close()
    }
  })

  it('a restored view holds its app again; an app that no longer exists, a malformed id and an id already open are skipped', async () => {
    const held = new Map<string, number>()
    const source: ViewSource = {
      readResource: async (_a, uri) => ({ contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: 'x' }] }),
      retain(app) {
        if (app.appId === 'ghost') throw new Error('no such app')
        held.set(app.appId, (held.get(app.appId) ?? 0) + 1)
        return () => void held.set(app.appId, (held.get(app.appId) ?? 0) - 1)
      },
    }
    const { views: v } = await start(source)
    const open = v.open(OTHER, 'ui://other/main').instanceId
    const restored = v.restore([
      { id: 'a'.repeat(22), app: NOTES, uri: 'ui://notes/board' },
      { id: 'b'.repeat(22), app: { projectId: 'p1', appId: 'ghost' }, uri: 'ui://ghost/main' },
      { id: 'not/an/id', app: NOTES, uri: 'ui://notes/board' },
      { id: open, app: NOTES, uri: 'ui://notes/board' },
    ])
    expect(restored).toEqual(['a'.repeat(22)])
    expect(held.get('notes')).toBe(1)
    // The id already open still belongs to the app it was opened for
    expect(v.describe(open)?.app).toEqual(OTHER)
    expect(v.describe('b'.repeat(22))).toBeNull()
    v.close('a'.repeat(22))
    expect(held.get('notes')).toBe(0)
  })
})
