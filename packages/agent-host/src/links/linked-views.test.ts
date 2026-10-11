/**
 * App views of a linked machine, served by the hub (#82, docs/plans/remote-hub.md §11).
 *
 * Two real ViewHosts: the machine's, which holds the instance and reads its app (a stand-in `ViewSource`, as in
 * view-host.test.ts), and the hub's, behind a real HostServer, which serves the view in its own window. Between them
 * the real router, qualifier and `linkedViews`; only the link itself is a stand-in that calls the machine's ViewHost
 * the way its RPC handler does (`apps.viewDocument` in rpc.ts).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { HostServer } from '../transport/server.js'
import { OriginPorts, type PortBook } from '../views/origin-ports.js'
import { ViewHost, type AppRef, type OriginMode, type RemoteViews, type ViewSource } from '../views/view-host.js'
import { VIEW_MIME_TYPE } from '../views/view-document.js'
import { linkedViews } from './linked-views.js'
import { Qualifier } from './qualifier.js'
import { Router, type RoutedMachine } from './router.js'

const HUB_SECRET = 'linked-views-hub-secret-0123456789abcdef'
const REMOTE_SECRET = 'linked-views-remote-secret-0123456789abc'
const HOST_ORIGIN = 'http://127.0.0.1:5174'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

type Doc = { html: string; csp?: object }

function source(docs: Record<string, Doc>, modes: Record<string, OriginMode>): ViewSource {
  return {
    async readResource(app, uri) {
      const doc = docs[`${app.projectId ?? '_user'}/${app.appId} ${uri}`]
      if (!doc) throw new Error(`no such resource ${uri}`)
      return { contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: doc.html, _meta: { ui: { csp: doc.csp } } }] }
    },
    originMode: (app) => modes[`${app.projectId ?? '_user'}/${app.appId}`] ?? 'opaque',
  }
}

function memoryBook() {
  const book: { raw: string | null } = { raw: null }
  const ports = new OriginPorts(
    { load: () => (book.raw ? (JSON.parse(book.raw) as PortBook) : null), save: (b) => void (book.raw = JSON.stringify(b)) },
    { log: () => {} },
  )
  return { ports, assigned: () => (book.raw ? (JSON.parse(book.raw) as PortBook).assigned : {}) }
}

/** The machine `m1`: its own ViewHost, never listening (nothing of it is reached over HTTP) */
function machine(docs: Record<string, Doc>, modes: Record<string, OriginMode> = {}) {
  const book = memoryBook()
  const views = new ViewHost({ secret: REMOTE_SECRET, allowedOrigins: [HOST_ORIGIN], source: source(docs, modes), ports: book.ports, hostPort: () => 17175, log: () => {} })
  closers.push(() => views.dispose())
  const m: RoutedMachine & { reachable: boolean; asked: unknown[]; answer?: (p: { instanceId: string }) => unknown } = {
    id: 'm1',
    name: 'Remote box',
    q: new Qualifier('m1', 1),
    reachable: true,
    asked: [],
    async call(method, params) {
      if (method !== 'apps.viewDocument') throw new Error(`unexpected ${method}`)
      this.asked.push(params)
      const p = params as { instanceId: string }
      if (this.answer) return this.answer(p)
      // What rpc.ts's handler answers
      const d = await views.document(p.instanceId)
      return { appId: d.app.appId, projectId: d.app.projectId, uri: d.uri, origin: d.origin, resource: d.resource }
    },
    lastKnown: () => null,
    observe: () => {},
    hides: () => false,
  }
  return { views, m, book }
}

/** The hub: its own apps, the router in front of its handler, and its ViewHost on a real door */
async function hub(m: RoutedMachine, own: { docs?: Record<string, Doc>; modes?: Record<string, OriginMode>; remote?: RemoteViews; port?: number } = {}) {
  const router = new Router({ local: async () => Promise.reject(new Error('This app view is not open')), machines: () => [m] })
  const book = memoryBook()
  let port: number | null = null
  const views = new ViewHost({
    secret: HUB_SECRET,
    allowedOrigins: [HOST_ORIGIN],
    source: source(own.docs ?? {}, own.modes ?? {}),
    ports: book.ports,
    hostPort: () => port,
    remote: own.remote ?? linkedViews((method, params) => router.handle(method, params)),
    log: () => {},
  })
  const server = new HostServer({ port: own.port ?? 0, token: 'tok', onRpc: async () => ({}), http: { secret: HUB_SECRET, routes: views.routes } })
  port = await server.listen()
  closers.push(async () => {
    await views.dispose()
    await server.close()
  })
  return { views, port, book }
}

function get(url: string) {
  return new Promise<{ status: number; body: string; csp: string | undefined }>((resolve, reject) => {
    const u = new URL(url)
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', agent: false }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, csp: res.headers['content-security-policy'] as string | undefined }))
    })
    req.on('error', reject)
    req.end()
  })
}

function pageConfig(body: string): Record<string, string> {
  const m = /<script type="application\/json" id="cc-view-config">(.*?)<\/script>/s.exec(body)
  if (!m?.[1]) throw new Error('no config block')
  return JSON.parse(m[1]) as Record<string, string>
}

const BOARD: AppRef = { projectId: 'p1', appId: 'board' }
const HUB_BOARD: AppRef = { projectId: 'm1.p1', appId: 'board' }

describe('the hub serves a linked machine’s app views (plan §11)', () => {
  it('from its own door, with the machine’s document under the hub’s own CSP, and nothing of the machine’s address', async () => {
    const remote = machine({
      'p1/board ui://board/main': {
        html: '<p id="from-the-machine">board</p>',
        csp: { connectDomains: ['https://api.example.com', 'http://127.0.0.1:17175'] },
      },
    })
    const { instanceId } = remote.views.open(BOARD, 'ui://board/main')
    const h = await hub(remote.m)

    const frame = await h.views.frame({ app: HUB_BOARD, instanceId: `m1.${instanceId}`, hostOrigin: HOST_ORIGIN })
    expect(frame.url.startsWith(`http://127.0.0.1:${h.port}/${HUB_SECRET}/views/m1.${instanceId}/?`)).toBe(true)
    // Loopback is refused by the hub's own CSP rules, whatever the machine's app declared
    expect(frame.sandbox.csp.connectDomains).toEqual(['https://api.example.com'])
    expect(remote.m.asked).toEqual([{ instanceId }])

    const page = await get(frame.url)
    expect(page.status).toBe(200)
    expect(page.csp).toContain('connect-src https://api.example.com')
    expect(page.csp).not.toContain('127.0.0.1')
    const cfg = pageConfig(page.body)
    expect(cfg).toMatchObject({ mode: 'opaque', hostOrigin: HOST_ORIGIN, sandbox: 'allow-scripts allow-forms' })
    expect(cfg.html).toContain('from-the-machine')
    // The drag relay goes into a remote view as into an own one
    expect(cfg.html).toContain('<script')
    for (const text of [frame.url, page.body]) {
      expect(text).not.toContain(REMOTE_SECRET)
      expect(text).not.toContain('17175')
    }
    // The machine never bound a port for it
    expect(remote.book.assigned()).toEqual({})
  })

  it('gives each machine’s per-app origin a port of the hub’s own, apart from the hub’s app of the same name', async () => {
    const html = (who: string) => ({ html: `<p>${who}</p>` })
    const remote = machine(
      { 'p1/board ui://board/main': html('remote project board'), '_user/board ui://board/main': html('remote user board') },
      { 'p1/board': 'app', '_user/board': 'app' },
    )
    const h = await hub(remote.m, {
      docs: { 'p1/board ui://board/main': html('hub project board'), '_user/board ui://board/main': html('hub user board') },
      modes: { 'p1/board': 'app', '_user/board': 'app' },
    })
    const remoteProject = `m1.${remote.views.open(BOARD, 'ui://board/main').instanceId}`
    const remoteUser = `m1.${remote.views.open({ projectId: null, appId: 'board' }, 'ui://board/main').instanceId}`
    const hubProject = h.views.open(BOARD, 'ui://board/main').instanceId
    const hubUser = h.views.open({ projectId: null, appId: 'board' }, 'ui://board/main').instanceId

    const served: Record<string, { appOrigin: string; src: string; body: string }> = {}
    for (const [name, app, id] of [
      ['remoteProject', HUB_BOARD, remoteProject],
      ['remoteUser', { projectId: null, appId: 'board' }, remoteUser],
      ['hubProject', BOARD, hubProject],
      ['hubUser', { projectId: null, appId: 'board' }, hubUser],
    ] as const) {
      const frame = await h.views.frame({ app, instanceId: id, hostOrigin: HOST_ORIGIN })
      const cfg = pageConfig((await get(frame.url)).body)
      expect(cfg.mode).toBe('app')
      const inner = await get(cfg.src!)
      expect(inner.status).toBe(200)
      served[name] = { appOrigin: cfg.appOrigin!, src: cfg.src!, body: inner.body }
    }
    expect(served.remoteProject!.body).toContain('remote project board')
    expect(served.remoteUser!.body).toContain('remote user board')
    expect(served.hubProject!.body).toContain('hub project board')
    // Four apps, four origins: storage never mixes across machines in this window
    expect(new Set(Object.values(served).map((s) => s.appOrigin)).size).toBe(4)
    expect(Object.keys(h.book.assigned()).sort()).toEqual(['_user/board', 'm1._user/board', 'm1.p1/board', 'p1/board'])
    expect(remote.book.assigned()).toEqual({})

    // One app's origin never serves another's document, a machine's or an own one
    const swap = (src: string, id: string) => src.replace(/\/views\/[^/]+\/view$/, `/views/${id}/view`)
    expect((await get(swap(served.hubProject!.src, remoteProject))).status).toBe(404)
    expect((await get(swap(served.remoteProject!.src, hubProject))).status).toBe(404)
    expect((await get(swap(served.remoteProject!.src, remoteUser))).status).toBe(404)
  })

  it('the instance decides the app, and a machine’s answer has to name its own machine', async () => {
    const remote = machine({ 'p1/board ui://board/main': { html: '<p>b</p>' } })
    const id = `m1.${remote.views.open(BOARD, 'ui://board/main').instanceId}`
    const h = await hub(remote.m)
    await expect(h.views.frame({ app: { projectId: 'm1.p1', appId: 'other' }, instanceId: id, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    await expect(h.views.frame({ app: BOARD, instanceId: id, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)

    // A machine claiming a project of another machine would get that machine's origin here
    const liar: RemoteViews = {
      document: async () => ({
        app: { projectId: 'm2.p1', appId: 'board' },
        uri: 'ui://board/main',
        origin: 'app',
        resource: { contents: [{ uri: 'ui://board/main', mimeType: VIEW_MIME_TYPE, text: '<p>b</p>' }] },
      }),
    }
    const h2 = await hub(remote.m, { remote: liar })
    await expect(h2.views.frame({ app: { projectId: 'm2.p1', appId: 'board' }, instanceId: id, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    expect(h2.book.assigned()).toEqual({})
  })

  it('an instance closed on its machine is no longer served', async () => {
    const remote = machine({ 'p1/board ui://board/main': { html: '<p>b</p>' } })
    const { instanceId } = remote.views.open(BOARD, 'ui://board/main')
    remote.views.close(instanceId)
    const h = await hub(remote.m)
    await expect(h.views.frame({ app: HUB_BOARD, instanceId: `m1.${instanceId}`, hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    const page = await get(`http://127.0.0.1:${h.port}/${HUB_SECRET}/views/m1.${instanceId}/?host=${encodeURIComponent(HOST_ORIGIN)}`)
    expect(page.status).toBe(404)
  })

  it('a hub that never gave the address out serves it all the same: nothing is held on the hub (a swap)', async () => {
    const remote = machine({ 'p1/board ui://board/main': { html: '<p id="still">b</p>' } })
    const id = `m1.${remote.views.open(BOARD, 'ui://board/main').instanceId}`
    const first = await hub(remote.m)
    const url = (await first.views.frame({ app: HUB_BOARD, instanceId: id, hostOrigin: HOST_ORIGIN })).url
    // The next host behind the same address (under the keeper: the front door's port, the same derived secret)
    const next = await hub(remote.m)
    const page = await get(url.replace(`:${first.port}/`, `:${next.port}/`))
    expect(page.status).toBe(200)
    expect(pageConfig(page.body).html).toContain('still')
  })

  it('a machine that is away: the address fails, saying to retry, and the page is a 404', async () => {
    const remote = machine({ 'p1/board ui://board/main': { html: '<p>b</p>' } })
    const id = `m1.${remote.views.open(BOARD, 'ui://board/main').instanceId}`
    const h = await hub(remote.m)
    remote.m.reachable = false
    const err = await h.views.frame({ app: HUB_BOARD, instanceId: id, hostOrigin: HOST_ORIGIN }).catch((e: unknown) => e)
    expect(err).toMatchObject({ retryable: true, data: { machine: 'm1', reason: 'unreachable' } })
    expect((await get(`http://127.0.0.1:${h.port}/${HUB_SECRET}/views/${id}/?host=${encodeURIComponent(HOST_ORIGIN)}`)).status).toBe(404)
  })

  it('a machine on a Centralu from before this says what would fix it', async () => {
    const remote = machine({})
    remote.m.answer = () => {
      throw new Error('Unknown method: apps.viewDocument. This Centralu host does not have it; the window may be from another build.')
    }
    const h = await hub(remote.m)
    await expect(h.views.frame({ app: HUB_BOARD, instanceId: 'm1.aaaaaaaaaaaaaaaaaaaaaa', hostOrigin: HOST_ORIGIN })).rejects.toThrow(/Update Centralu there/)
  })

  it('an id of a machine that is not linked is not open, and nothing is asked', async () => {
    const remote = machine({})
    const h = await hub(remote.m)
    await expect(h.views.frame({ app: { projectId: 'm9.p1', appId: 'board' }, instanceId: 'm9.aaaaaaaaaaaaaaaaaaaaaa', hostOrigin: HOST_ORIGIN })).rejects.toThrow(/not open/)
    expect(remote.m.asked).toEqual([])
  })
})
