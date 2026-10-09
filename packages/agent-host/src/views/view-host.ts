import { createHmac, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { MACHINE_ID_RE } from '@cc/protocol'
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
 *
 * A hub also serves the views of its linked machines (#82, docs/plans/remote-hub.md §11): an
 * instance id of the form `<machine>.<id>` is open on that machine, which hands over the app's raw
 * document (`RemoteViews`), and everything else (the address, the proxy page, the CSP, the per-app
 * origin port from this host's own book) is this host's, exactly as for its own instances.
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

/** An open instance as one host hands it to the next (view-handover.ts): what it takes to serve it again */
export type OpenView = { id: string; app: AppRef; uri: string }

/**
 * A view open on a linked machine, as that machine describes it (`apps.viewDocument`), in this host's terms: a project
 * app's `projectId` carries the machine's prefix, a user-folder app's is null. `resource` is the app's
 * `resources/read` answer as is; this host reads the view out of it and applies its own rules.
 */
export type RemoteViewDocument = { app: AppRef; uri: string; origin: OriginMode; resource: unknown }

/**
 * The views of linked machines, which this host serves in its own window (#82, docs/plans/remote-hub.md §11). The
 * instance stays open on its own machine and holds its app there; this host only asks for its document when the
 * window loads it, so nothing here outlives a link drop or a host swap.
 */
export interface RemoteViews {
  /** By the instance's qualified id (`<machine>.<id>`). Throws when the machine cannot be reached or the instance is not open there */
  document(instanceId: string): Promise<RemoteViewDocument>
}

type Instance = {
  id: string
  app: AppRef
  uri: string
  doc: ViewDocument | null
  /** Releases the hold on the runtime. Called by every path where the instance disappears (close, pushed out by the cap, shutdown) */
  release: (() => void) | null
}

/** One view as it is about to be served: this host's own instance, or a linked machine's */
type Shown = { app: AppRef; uri: string; doc: ViewDocument; mode: OriginMode; key: string }

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
  /** The views of linked machines (links/linked-views.ts). Absent: an id of another machine is never open here */
  remote?: RemoteViews | null
  log?: (line: string) => void
}

/**
 * The instance cap. Keeps the host's memory from growing without bound even if the runtime forgets
 * to close one. The oldest is dropped first. Reopening a dropped instance's view gets a 404. Since
 * only a handful of views stay alive within a conversation at once (the plan's "two places a view
 * is born"), reaching this number is rare.
 */
export const MAX_INSTANCES = 1000

const INSTANCE_ID = /^[A-Za-z0-9_-]{16,64}$/
/**
 * An instance of a linked machine, as the window holds it: `<machine>.<that machine's instance id>` (remote-hub.md
 * §3.3). The machine is the first capture. Still nothing but URL-safe characters and one dot, so it can stand in a path
 * segment, and `..` can never form.
 */
const REMOTE_INSTANCE_ID = new RegExp(`^(${MACHINE_ID_RE.source.replace(/^\^|\$$/g, '')})\\.[A-Za-z0-9_-]{16,64}$`)

/**
 * How long a linked machine's document is reused, and for how many views at once. Loading a view asks for it up to
 * three times in a row (the address, the proxy page, the per-app origin's document); within this window they are one
 * question over the link. Kept short, because an instance closed there should stop being served here soon after.
 */
const REMOTE_DOC_TTL_MS = 15_000
const REMOTE_DOC_CAP = 64

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
  /** Linked machines' documents as last read, by qualified instance id, oldest first (`REMOTE_DOC_TTL_MS`) */
  private readonly remoteDocs = new Map<string, { shown: Shown; at: number }>()
  private readonly allowed: ReadonlySet<string>
  private readonly log: (line: string) => void
  private disposed = false

  constructor(private readonly opts: ViewHostOptions) {
    this.allowed = new Set(opts.allowedOrigins.filter((o) => o !== '' && o !== 'null'))
    this.log = opts.log ?? ((line) => console.error(line))
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
  open(app: AppRef, uri: string): { instanceId: string } {
    const ref = { projectId: app.projectId ?? null, appId: app.appId }
    // Holding the app open comes first. If the app does not exist, this throws here, and no instance is created
    const release = this.opts.source?.retain?.(ref) ?? null
    const id = randomBytes(16).toString('base64url')
    if (this.instances.size >= MAX_INSTANCES) {
      const oldest = this.instances.keys().next().value
      if (oldest !== undefined) this.drop(oldest)
    }
    this.instances.set(id, { id, app: ref, uri, doc: null, release })
    return { instanceId: id }
  }

  close(instanceId: string): void {
    this.drop(instanceId)
  }

  /** Every open instance, oldest first — what a planned hand-over records (view-handover.ts) */
  list(): OpenView[] {
    return [...this.instances.values()].map((i) => ({ id: i.id, app: { ...i.app }, uri: i.uri }))
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
  restore(views: readonly OpenView[]): string[] {
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
      this.instances.set(v.id, { id: v.id, app: ref, uri: v.uri, doc: null, release })
      opened.push(v.id)
    }
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
    const remote = REMOTE_INSTANCE_ID.test(p.instanceId)
    const inst = remote ? undefined : this.instances.get(p.instanceId)
    if (!remote && (!inst || !sameApp(inst.app, p.app))) fail('This app view is not open')
    if (!this.allowed.has(p.hostOrigin)) fail(`App views cannot be shown from origin ${p.hostOrigin}`)
    const port = this.opts.hostPort()
    if (port === null) fail('The host is not listening yet')
    // Read fresh in both cases, so a reopened view never shows stale HTML (see above)
    const shown = inst ? await this.localShown(inst, true) : await this.remoteShown(p.instanceId)
    // A linked machine's instance is checked against what that machine says it is, as an own one is against itself
    if (!sameApp(shown.app, p.app)) fail('This app view is not open')
    const csp = buildViewCsp(shown.doc.csp)
    if (csp.dropped.length) {
      this.log(`[agent-host] view ${shown.uri} (${shown.key}): CSP entries not allowed: ${csp.dropped.join(', ')}`)
    }
    // Under a per-app origin, that port has to be up **before** the address is given out — the proxy goes straight there
    if (shown.mode === 'app') await this.originServer(shown.key)
    return {
      url: `http://127.0.0.1:${port}/${this.opts.secret}/views/${p.instanceId}/?${new URLSearchParams({ host: p.hostOrigin })}`,
      allow: allowAttribute(shown.doc.permissions),
      sandbox: { csp: csp.approved, permissions: approvedPermissions(shown.doc.permissions) },
    }
  }

  /**
   * What an own open instance shows, for a hub that serves it in its window (RPC `apps.viewDocument`, remote-hub.md
   * §11). The resource is read fresh and handed over as the app gave it: the hub applies its own CSP, sandbox and
   * origin rules to it, exactly as this host does to its own views.
   */
  async document(instanceId: string): Promise<RemoteViewDocument> {
    const inst = INSTANCE_ID.test(instanceId) ? this.instances.get(instanceId) : undefined
    if (!inst) fail('This app view is not open')
    const resource = await this.source().readResource(inst.app, inst.uri)
    return { app: { ...inst.app }, uri: inst.uri, origin: this.originMode(inst.app), resource }
  }

  /**
   * The per-app origin key of a linked machine's app: that machine's own key (`originKey`) behind its prefix. A
   * project app's id already carries the prefix; a user-folder app's `_user` gets it here, so the `notes` app of two
   * machines never shares an origin in this window, nor with this computer's own `notes`.
   */
  static remoteOriginKey(machine: string, app: AppRef): string {
    return app.projectId !== null ? `${app.projectId}/${app.appId}` : `${machine}._user/${app.appId}`
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
        // A dot for a linked machine's instance (`<machine>.<id>`); each id is checked against its exact shape below
        path: /\/views\/([A-Za-z0-9_.-]+)\//,
        handle: (req) => this.proxyPage(req.params[0] ?? '', req.query.get('host')),
      },
    ]
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const id of [...this.instances.keys()]) this.drop(id)
    this.remoteDocs.clear()
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

  /** An own instance as it is served. `fresh` reads the document again (`frame()`); otherwise the one read last is reused */
  private async localShown(inst: Instance, fresh: boolean): Promise<Shown> {
    const doc = fresh || !inst.doc ? await this.readDocument(inst) : inst.doc
    inst.doc = doc
    return { app: inst.app, uri: inst.uri, doc, mode: this.originMode(inst.app), key: ViewHost.originKey(inst.app) }
  }

  /**
   * A linked machine's instance as it is served, asked of that machine (`RemoteViews`). Everything that decides the
   * view's reach is this host's: the document is read out of the app's raw answer here, and the CSP, sandbox, drag
   * relay and per-app origin port are applied by the same code as an own view's. The one thing taken from the machine
   * is which origin method its app's manifest asks for, which this host takes from an app of its own too.
   */
  private async remoteShown(instanceId: string): Promise<Shown> {
    const machine = REMOTE_INSTANCE_ID.exec(instanceId)?.[1]
    const remote = this.opts.remote
    if (!machine || !remote) fail('This app view is not open')
    const d = await remote.document(instanceId)
    const app = { projectId: d.app.projectId ?? null, appId: d.app.appId }
    // A project of another machine would put this view under that machine's origin: the answer must name its own
    if (app.projectId !== null && !app.projectId.startsWith(`${machine}.`)) fail('This app view is not open')
    const shown: Shown = {
      app,
      uri: d.uri,
      doc: viewDocumentFromResource(d.resource, d.uri),
      mode: d.origin === 'app' ? 'app' : 'opaque',
      key: ViewHost.remoteOriginKey(machine, app),
    }
    this.remoteDocs.delete(instanceId)
    this.remoteDocs.set(instanceId, { shown, at: Date.now() })
    while (this.remoteDocs.size > REMOTE_DOC_CAP) {
      const oldest = this.remoteDocs.keys().next().value
      if (oldest === undefined) break
      this.remoteDocs.delete(oldest)
    }
    return shown
  }

  /** The view a page route serves: the one read last if recent enough, else read now. null when it cannot be served */
  private async servedView(instanceId: string): Promise<Shown | null> {
    if (INSTANCE_ID.test(instanceId)) {
      const inst = this.instances.get(instanceId)
      return inst ? this.localShown(inst, false).catch(() => null) : null
    }
    if (!REMOTE_INSTANCE_ID.test(instanceId)) return null
    const cached = this.remoteDocs.get(instanceId)
    if (cached && Date.now() - cached.at < REMOTE_DOC_TTL_MS) return cached.shown
    return this.remoteShown(instanceId).catch(() => null)
  }

  /** A nonexistent instance, a disallowed parent, or a document that fails to read are all 404s — this route explains nothing */
  private async proxyPage(instanceId: string, hostOrigin: string | null) {
    if (hostOrigin === null || !this.allowed.has(hostOrigin)) return null
    const shown = await this.servedView(instanceId)
    if (!shown) return null
    const { doc } = shown
    const allow = allowAttribute(doc.permissions)
    if (shown.mode === 'app') {
      const { port } = await this.originServer(shown.key)
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
          src: `${appOrigin}/${this.originSecret(shown.key)}/views/${instanceId}/view`,
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
            path: /\/views\/([A-Za-z0-9_.-]+)\/view/,
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
    // An own instance of another app is turned away before its document is read
    const inst = INSTANCE_ID.test(instanceId) ? this.instances.get(instanceId) : undefined
    if (inst && ViewHost.originKey(inst.app) !== key) return null
    const shown = await this.servedView(instanceId)
    if (!shown || shown.key !== key) return null
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildViewCsp(shown.doc.csp).policy },
      body: withDragRelay(shown.doc.html),
    }
  }
}
