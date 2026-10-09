import { createHmac, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { createHttpHandler, type HttpRoute } from '../transport/http.js'
import { withDragRelay } from './drag-relay.js'
import { allowAttribute, approvedPermissions, buildProxyCsp, buildViewCsp, type ViewCspDomains, type ViewPermissions } from './csp.js'
import type { OriginPorts } from './origin-ports.js'
import { PROXY_SCRIPT_HASH, proxyPageHtml } from './proxy-page.js'
import { viewDocumentFromResource, type ViewDocument } from './view-document.js'

/**
 * App view hosting (M4 B-3a).
 *
 * A single view is **an instance created by one tool call** (per the spec: a view has no state of
 * its own). When the app runtime sees `_meta.ui.resourceUri` in a result, it creates the instance
 * with `open()`, and that id goes to the UI. The UI gets the address with `frame()` (RPC
 * `apps.viewFrame`) and loads the sandbox proxy. Every route to that address sits behind the host
 * port's secret path (transport/http.ts).
 *
 * This layer does not know the app process. Reading the document is left to `ViewSource` (filled
 * in by the runtime); interpreting the spec (what counts as a view, CSP, permissions) happens
 * here.
 */

/** One app. If the same id exists in two projects, they are different apps. `projectId: null` is a user-folder app */
export type AppRef = { projectId: string | null; appId: string }

/**
 * A view's origin method.
 *   opaque  the default. The inner frame has no `allow-same-origin`. Storage never mixes between apps.
 *   app     per-app origin. Opens only for an app that was imported or that requested it (S-1, S-8: apps that break under an opaque origin).
 */
export type OriginMode = 'opaque' | 'app'

/** The side the app runtime fills in (on the host, app-view-source.ts wires this to the runtime) */
export interface ViewSource {
  /** The MCP `resources/read` answer, as is. Starting up the app the first time it is needed is also this side's job */
  readResource(app: AppRef, uri: string): Promise<unknown>
  /** Opaque if absent. Left with only a default here, since this is a call for the manifest or import to make */
  originMode?(app: AppRef): OriginMode
  /**
   * One view holds an app open. An app with an open view is not shut down as idle (A-3). The
   * returned function releases it. Throws if the app does not exist — the view of a nonexistent
   * app never opens.
   */
  retain?(app: AppRef): () => void
}

export type ViewFrame = {
  /** The proxy page's address. Carries the secret path — never write this to a log */
  url: string
  /** The outer iframe's `allow` (the inner one receives the same value) */
  allow: string
  /** What the host accepted. Reported to the view as `hostCapabilities.sandbox` */
  sandbox: { csp: Required<ViewCspDomains>; permissions: ViewPermissions }
}

/**
 * An open instance as one host hands it to the next (view-handover.ts): what it takes to serve it
 * again. `leased`: a window holds it under a lease (`hold`), and the next host keeps it only as
 * long as a window claims it again.
 */
export type OpenView = { id: string; app: AppRef; uri: string; leased?: boolean }

/**
 * Which window holds a leased instance (#392). `holder` is the connection that opened or last
 * claimed it; null once that connection is gone, from `orphanSince`.
 */
type Lease = { holder: number | null; orphanSince: number | null }

type Instance = {
  id: string
  app: AppRef
  uri: string
  doc: ViewDocument | null
  /** Releases the hold on the runtime. Called by every path where the instance disappears (close, pushed out by the cap, shutdown) */
  release: (() => void) | null
  /** null: no window leases it (a view inside a conversation, or one an older window opened), and it lives until closed */
  lease: Lease | null
}

export type ViewHostOptions = {
  /** The host port's HTTP secret (transport/http.ts). The per-app origin secret is also derived from this */
  secret: string
  /** The allow list of parent origins the proxy can exchange messages with. The same list as WebSocket */
  allowedOrigins: readonly string[]
  /** null if the runtime does not exist yet. In that case a view request fails with a reason */
  source: ViewSource | null
  ports: OriginPorts
  /**
   * The port the view's address points at. Only decided after listen(). Under the keeper this is
   * the front door's port rather than the host's own (swap-control.ts `viewPort`), so an address
   * given out by one host still reaches whichever host is current after a swap
   */
  hostPort: () => number | null
  log?: (line: string) => void
  /** How long a leased instance may go unclaimed before it is closed (`LEASE_GRACE_MS`; tests use less) */
  leaseGraceMs?: number
}

/**
 * The instance cap. Keeps the host's memory from growing without bound even if the runtime forgets
 * to close one. The oldest is dropped first. Reopening a dropped instance's view gets a 404. Since
 * only a handful of views stay alive within a conversation at once (the plan's "two places a view
 * is born"), reaching this number is rare.
 */
export const MAX_INSTANCES = 1000

/**
 * How long a leased view outlives the window that held it (#392).
 *
 * A fixed view is closed by the window that opened it (`apps.closeView`). A window that reloads
 * or closes never says so: the new page starts with no views and opens its own, and the old
 * instances held their apps open (no idle shutdown, A-3) for the rest of the host's life. Reloads
 * repeat, so each one added a set. So a view opened with a lease belongs to the connection that
 * opened it, and once that connection ends the view waits this long for a window to claim it again
 * (`apps.holdViews`, sent after every reconnect) before it is closed.
 *
 * Five minutes covers what ends a connection without ending the window: a network blip, the host
 * swapped behind the front door (the next host restores the view and waits the same time), a
 * sleeping laptop whose host slept too (timers stop with it). A window that comes back later
 * finds the view gone and opens it again, as after an app restart.
 */
export const LEASE_GRACE_MS = 5 * 60_000

const INSTANCE_ID = /^[A-Za-z0-9_-]{16,64}$/

/** The inner frame's sandbox. Neither has `allow-popups` or `allow-top-navigation` */
const SANDBOX_OPAQUE = 'allow-scripts allow-forms'
const SANDBOX_APP = 'allow-scripts allow-same-origin allow-forms'

function sameApp(a: AppRef, b: AppRef): boolean {
  return a.appId === b.appId && (a.projectId ?? null) === (b.projectId ?? null)
}

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'internal' })
}

export class ViewHost {
  private readonly instances = new Map<string, Instance>()
  private readonly origins = new Map<string, Promise<{ port: number; server: Server }>>()
  private readonly allowed: ReadonlySet<string>
  private readonly log: (line: string) => void
  private disposed = false
  private readonly leaseGraceMs: number
  private sweepTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: ViewHostOptions) {
    this.allowed = new Set(opts.allowedOrigins.filter((o) => o !== '' && o !== 'null'))
    this.log = opts.log ?? ((line) => console.error(line))
    this.leaseGraceMs = opts.leaseGraceMs ?? LEASE_GRACE_MS
  }

  /**
   * The key for a per-app origin. Also the key in the port assignment table. The project is
   * included: the `notes` app in two different projects is a different app in each, so its storage
   * has to differ too.
   */
  static originKey(app: AppRef): string {
    return `${app.projectId ?? '_user'}/${app.appId}`
  }

  /**
   * Opens a view instance. While it is open, the app is never treated as idle (plan A-3: shut down
   * only once there is neither an open view nor a call in progress). If the app were shut down just
   * because a person left a view open and untouched for a few minutes, the next click would have to
   * wait for the app to start back up.
   */
  open(app: AppRef, uri: string, holder?: number): { instanceId: string } {
    const ref = { projectId: app.projectId ?? null, appId: app.appId }
    // Holding the app open comes first. If the app does not exist, this throws here, and no instance is created
    const release = this.opts.source?.retain?.(ref) ?? null
    const id = randomBytes(16).toString('base64url')
    if (this.instances.size >= MAX_INSTANCES) {
      const oldest = this.instances.keys().next().value
      if (oldest !== undefined) this.drop(oldest)
    }
    const lease = holder === undefined ? null : { holder, orphanSince: null }
    this.instances.set(id, { id, app: ref, uri, doc: null, release, lease })
    return { instanceId: id }
  }

  close(instanceId: string): void {
    this.drop(instanceId)
  }

  /**
   * A window claims the leased views it shows (RPC `apps.holdViews`, #392): each becomes the
   * calling connection's, and stops waiting to be closed. Returns the ids that are not open (closed
   * while the window was away), which the window opens again. An instance with no lease is left as
   * it is: a view inside a conversation is closed by its own layer (inline-views.ts).
   */
  hold(instanceIds: readonly string[], holder: number): string[] {
    const missing: string[] = []
    for (const id of instanceIds) {
      const inst = this.instances.get(id)
      if (!inst) missing.push(id)
      else if (inst.lease) inst.lease = { holder, orphanSince: null }
    }
    return missing
  }

  /** A connection ended (#392): the views it held wait `leaseGraceMs` for a window to claim them */
  holderGone(holder: number, now = Date.now()): void {
    let orphaned = false
    for (const inst of this.instances.values()) {
      if (inst.lease?.holder !== holder) continue
      inst.lease = { holder: null, orphanSince: now }
      orphaned = true
    }
    if (orphaned) this.scheduleSweep()
  }

  /** Closes the leased views nobody claimed within the grace. Returns how many */
  sweepUnclaimed(now = Date.now()): number {
    let closed = 0
    for (const inst of [...this.instances.values()]) {
      const since = inst.lease?.orphanSince
      if (since === null || since === undefined || now - since < this.leaseGraceMs) continue
      this.drop(inst.id)
      closed++
    }
    if (closed > 0) this.log(`[agent-host] closed ${closed} app view${closed === 1 ? '' : 's'} no window claimed`)
    if ([...this.instances.values()].some((i) => i.lease?.orphanSince != null)) this.scheduleSweep()
    return closed
  }

  /** One timer at a time, unref'd: a pending sweep never keeps the host alive */
  private scheduleSweep(): void {
    if (this.sweepTimer || this.disposed) return
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null
      this.sweepUnclaimed()
    }, this.leaseGraceMs + 1000)
    this.sweepTimer.unref?.()
  }

  /** Every open instance, oldest first — what a planned hand-over records (view-handover.ts) */
  list(): OpenView[] {
    return [...this.instances.values()].map((i) => ({ id: i.id, app: { ...i.app }, uri: i.uri, ...(i.lease ? { leased: true } : {}) }))
  }

  /**
   * Opens again, **under their old ids**, the instances a previous host handed over (#280: a build
   * switch replaces the host while the window stays open). The id is what the UI holds; keeping it
   * means an open view's next call, or its next `apps.viewFrame`, finds its instance as if no swap
   * had happened.
   *
   * Each one holds its app again, exactly as `open()` does, and one whose app no longer exists is
   * skipped (`retain` throws) — its view gets "not open" and the UI's failure path, as before. An
   * id that is malformed or already open is skipped too: the record is a file, and an id must
   * never be shared by two instances. Returns the ids opened.
   */
  restore(views: readonly OpenView[], now = Date.now()): string[] {
    const opened: string[] = []
    for (const v of views) {
      if (typeof v?.id !== 'string' || !INSTANCE_ID.test(v.id) || this.instances.has(v.id)) continue
      if (typeof v.uri !== 'string' || typeof v.app?.appId !== 'string') continue
      if (this.instances.size >= MAX_INSTANCES) break
      const ref = { projectId: v.app.projectId ?? null, appId: v.app.appId }
      let release: (() => void) | null
      try {
        release = this.opts.source?.retain?.(ref) ?? null
      } catch (err) {
        this.log(`[agent-host] view ${v.uri} (${ViewHost.originKey(ref)}) not restored: ${(err as Error).message}`)
        continue
      }
      // A leased view belonged to a connection of the previous host: no one holds it until a window claims it
      const lease = v.leased === true ? { holder: null, orphanSince: now } : null
      this.instances.set(v.id, { id: v.id, app: ref, uri: v.uri, doc: null, release, lease })
      opened.push(v.id)
    }
    if (opened.some((id) => this.instances.get(id)?.lease)) this.scheduleSweep()
    return opened
  }

  /**
   * The app and view of an open instance — null if none exists (closed or an unknown id). This is
   * decided by **the instance**, not by whatever app the caller claims: the statement "this came
   * from this view" (C-5's header, B-4's fixed-view message) is checked against this (#93, #94).
   */
  describe(instanceId: string): { app: AppRef; uri: string } | null {
    const inst = this.instances.get(instanceId)
    return inst ? { app: { ...inst.app }, uri: inst.uri } : null
  }

  /**
   * The address the UI loads the view at (RPC `apps.viewFrame`).
   *
   * **The instance decides the app.** The `app` the caller provides is only checked against the
   * instance's own app; a mismatch is treated as nonexistent. So claiming app B's name with app
   * A's view id opens nothing.
   *
   * The document is read once here and stored on the instance. Reopening the view (calling
   * `frame()` again) reads it fresh — this is meant to keep a reopened view from showing stale HTML
   * after the app has been edited.
   */
  async frame(p: { app: AppRef; instanceId: string; hostOrigin: string }): Promise<ViewFrame> {
    const inst = this.instances.get(p.instanceId)
    if (!inst || !sameApp(inst.app, p.app)) fail('This app view is not open')
    if (!this.allowed.has(p.hostOrigin)) fail(`App views cannot be shown from origin ${p.hostOrigin}`)
    const port = this.opts.hostPort()
    if (port === null) fail('The host is not listening yet')
    inst.doc = await this.readDocument(inst)
    const csp = buildViewCsp(inst.doc.csp)
    if (csp.dropped.length) {
      this.log(`[agent-host] view ${inst.uri} (${ViewHost.originKey(inst.app)}): CSP entries not allowed: ${csp.dropped.join(', ')}`)
    }
    // Under a per-app origin, that port has to be up **before** the address is given out — the proxy goes straight there
    if (this.originMode(inst.app) === 'app') await this.originServer(ViewHost.originKey(inst.app))
    return {
      url: `http://127.0.0.1:${port}/${this.opts.secret}/views/${inst.id}/?${new URLSearchParams({ host: p.hostOrigin })}`,
      allow: allowAttribute(inst.doc.permissions),
      sandbox: { csp: csp.approved, permissions: approvedPermissions(inst.doc.permissions) },
    }
  }

  /**
   * A view reads its own app's resource (RPC `apps.readResource`, the bridge's `onreadresource`).
   * If an instance is given, it has to match that instance's own app.
   */
  async readResource(app: AppRef, uri: string, instanceId?: string): Promise<unknown> {
    if (instanceId !== undefined) {
      const inst = this.instances.get(instanceId)
      if (!inst || !sameApp(inst.app, app)) fail('This app view is not open')
    }
    return this.source().readResource(app, uri)
  }

  /** Routes attached to the host port. All of them sit behind the secret path (HostServer applies the gate) */
  get routes(): HttpRoute[] {
    return [
      {
        method: 'GET',
        path: /\/views\/([A-Za-z0-9_-]+)\//,
        handle: (req) => this.proxyPage(req.params[0] ?? '', req.query.get('host')),
      },
    ]
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    this.sweepTimer = null
    for (const id of [...this.instances.keys()]) this.drop(id)
    const servers = await Promise.allSettled([...this.origins.values()])
    this.origins.clear()
    await Promise.all(
      servers.map((s) =>
        s.status === 'fulfilled'
          ? new Promise<void>((r) => {
              s.value.server.closeAllConnections()
              s.value.server.close(() => r())
            })
          : undefined,
      ),
    )
  }

  /** Deletes the instance and releases the app it held. Calling this twice still releases only once */
  private drop(instanceId: string): void {
    const inst = this.instances.get(instanceId)
    if (!inst) return
    this.instances.delete(instanceId)
    inst.release?.()
  }

  private source(): ViewSource {
    return this.opts.source ?? fail('App views are unavailable: the app runtime is not running')
  }

  private originMode(app: AppRef): OriginMode {
    return this.opts.source?.originMode?.(app) === 'app' ? 'app' : 'opaque'
  }

  private async readDocument(inst: Instance): Promise<ViewDocument> {
    return viewDocumentFromResource(await this.source().readResource(inst.app, inst.uri), inst.uri)
  }

  /** A nonexistent instance, a disallowed parent, or a document that fails to read are all 404s — this route explains nothing */
  private async proxyPage(instanceId: string, hostOrigin: string | null) {
    if (!INSTANCE_ID.test(instanceId)) return null
    const inst = this.instances.get(instanceId)
    if (!inst || hostOrigin === null || !this.allowed.has(hostOrigin)) return null
    const doc = inst.doc ?? (await this.readDocument(inst).catch(() => null))
    if (!doc) return null
    const allow = allowAttribute(doc.permissions)
    if (this.originMode(inst.app) === 'app') {
      const key = ViewHost.originKey(inst.app)
      const { port } = await this.originServer(key)
      const appOrigin = `http://127.0.0.1:${port}`
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildProxyCsp(PROXY_SCRIPT_HASH, appOrigin) },
        body: proxyPageHtml({
          mode: 'app',
          hostOrigin,
          sandbox: SANDBOX_APP,
          allow,
          appOrigin,
          src: `${appOrigin}/${this.originSecret(key)}/views/${inst.id}/view`,
        }),
      }
    }
    return {
      status: 200,
      // The srcdoc document inherits this response's policy — this is where the view's CSP is applied
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildViewCsp(doc.csp).policy },
      // The drag relay goes into every view (drag-relay.ts): a drag out of a view reaches the page no other way
      body: proxyPageHtml({ mode: 'opaque', hostOrigin, sandbox: SANDBOX_OPAQUE, allow, html: withDragRelay(doc.html) }),
    }
  }

  /**
   * The secret for a per-app origin. Derived from the host secret, per key.
   *
   * Under this method a view has a real origin, so it reads its own address with `location.href`.
   * If the host port's secret were left in that address as is, a single view would then know
   * every app's proxy path. The derived value only works on that one app's port.
   */
  private originSecret(key: string): string {
    return createHmac('sha256', this.opts.secret).update(`view-origin\0${key}`).digest('base64url')
  }

  /** The per-app origin server for a key. Started the first time it is needed (fixed port, origin-ports.ts) */
  private originServer(key: string): Promise<{ port: number; server: Server }> {
    if (this.disposed) fail('The host is shutting down')
    let pending = this.origins.get(key)
    if (!pending) {
      const handler = createHttpHandler({
        secret: this.originSecret(key),
        routes: [
          {
            method: 'GET',
            path: /\/views\/([A-Za-z0-9_-]+)\/view/,
            handle: (req) => this.originDocument(key, req.params[0] ?? ''),
          },
        ],
      })
      pending = this.opts.ports.serve(key, handler)
      // A failure is not remembered — the next request tries again (the program holding the port may have left)
      pending.catch(() => this.origins.delete(key))
      this.origins.set(key, pending)
    }
    return pending
  }

  /** The view document served from a per-app origin port. An instance not belonging to that port's app is treated as nonexistent */
  private async originDocument(key: string, instanceId: string) {
    if (!INSTANCE_ID.test(instanceId)) return null
    const inst = this.instances.get(instanceId)
    if (!inst || ViewHost.originKey(inst.app) !== key) return null
    const doc = inst.doc ?? (await this.readDocument(inst).catch(() => null))
    if (!doc) return null
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildViewCsp(doc.csp).policy },
      body: withDragRelay(doc.html),
    }
  }
}
