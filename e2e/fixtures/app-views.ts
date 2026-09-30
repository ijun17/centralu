import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { HostServer } from '../../packages/agent-host/src/transport/server.js'
import { ViewHost, type AppRef, type OriginMode, type ViewSource } from '../../packages/agent-host/src/views/view-host.js'
import { OriginPorts } from '../../packages/agent-host/src/views/origin-ports.js'
import { VIEW_MIME_TYPE } from '../../packages/agent-host/src/views/view-document.js'

/**
 * The host side of the app-view e2e (M4 B-3).
 *
 * Only the document-reading side (`ViewSource`) is a stand-in, so as to avoid starting an app
 * process (the seam with the runtime is covered with a real app by agent-host's
 * app-views.test.ts); everything else is real host code. It uses the same secret-gated
 * HostServer, the same ViewHost (proxy page, CSP, per-app origin ports). The view HTML is a small
 * app that uses `App` from the official ext-apps 2.x, with the bundle inlined as-is. The spec's
 * default CSP blocks outside scripts, so real apps ship the same way, as a single file (S-6).
 */

const uiRequire = createRequire(new URL('../../packages/ui/package.json', import.meta.url))

/** Unpacks `app-with-deps.js`'s trailing `export{…}` to pull out `App` under its local name */
function extAppsInline(): string {
  const src = readFileSync(uiRequire.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8')
  const m = /export\{([^}]*)\};?\s*$/.exec(src)
  if (!m?.[1]) throw new Error('ext-apps bundle shape changed: no trailing export list')
  const local = m[1]
    .split(',')
    .map((e) => e.trim().split(/\s+as\s+/))
    .find(([, exported]) => exported === 'App')?.[0]
  if (!local) throw new Error('ext-apps bundle does not export App')
  if (src.includes('</script')) throw new Error('ext-apps bundle would close the inline script')
  return `${src.slice(0, m.index)}\nconst App = ${local};`
}

let bundle: string | null = null

/**
 * The test app view. Everything it receives is written to `#log` one line at a time (the test
 * reads inside the frame). Each button exercises one thing the view can ask the host to do.
 * `marker` writes which build of this HTML is loaded onto the screen — the test uses it to check
 * whether the view picked up the new HTML after the app restarted with new code (M4 C-4).
 */
export function fixtureViewHtml(opts: { hangTeardown?: boolean; ignoreNotifications?: boolean; marker?: string } = {}): string {
  bundle ??= extAppsInline()
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture view</title></head>
<body style="margin:0;padding:8px;font:12px sans-serif;background:#fff;color:#000">
${opts.marker ? `<p id="marker" data-testid="marker">${opts.marker}</p>` : ''}
<div>
  <button id="call">call</button>
  <button id="spoof">spoof</button>
  <button id="raw">raw</button>
  <button id="direct">direct</button>
  <button id="link">link</button>
  <button id="bad-link">bad-link</button>
  <button id="msg">msg</button>
  <button id="read">read</button>
  <button id="grow">grow</button>
  <button id="slow">slow</button>
</div>
<ul id="log" data-testid="log"></ul>
<div id="spacer"></div>
<script type="module">
${bundle}
const log = (k, v) => {
  const li = document.createElement('li')
  li.dataset.k = k
  li.textContent = k + ' ' + JSON.stringify(v)
  document.getElementById('log').append(li)
}
const app = new App({ name: 'fixture', version: '1.0.0' }, {}, { autoResize: true })
app.ontoolinput = (p) => log('tool-input', p.arguments)
app.ontoolresult = (p) => log('tool-result', p.structuredContent ?? p.content)
app.ontoolcancelled = (p) => log('tool-cancelled', p.reason ?? null)
app.onhostcontextchanged = (p) => log('host-context-changed', p)
// What a real app does in teardown: save, then respond. Once the save reaches the host, the
// view has received the request.
app.onteardown = ${opts.hangTeardown ? '() => new Promise(() => {})' : "async () => { await app.callServerTool({ name: 'save-on-teardown', arguments: {} }); log('teardown', {}); return {} }"}
// What our template does: listen for unknown notifications. Apps built for other hosts do not
// have this line (ignoreNotifications).
${opts.ignoreNotifications ? '' : "app.fallbackNotificationHandler = async (n) => log('notification', { method: n.method, params: n.params })"}
const on = (id, fn) => document.getElementById(id).addEventListener('click', () => fn().catch((e) => log(id + '-error', String(e && e.message || e))))
on('call', async () => log('call-result', (await app.callServerTool({ name: 'increment', arguments: { by: 2 } })).structuredContent))
// Try claiming a different app inside the message — in both params and _meta
on('spoof', async () => log('spoof-result', (await app.callServerTool({ name: 'increment', arguments: { by: 1 }, appId: 'victim', projectId: 'p-victim', _meta: { appId: 'victim', projectId: 'p-victim', instanceId: 'stolen' } })).structuredContent))
// Raw JSON-RPC that bypasses the SDK — attach arbitrary fields the spec does not define
on('raw', async () => { window.parent.postMessage({ jsonrpc: '2.0', id: 900001, method: 'tools/call', params: { name: 'increment', arguments: { raw: true }, appId: 'victim', app: 'victim', projectId: 'p-victim' } }, '*'); log('raw-sent', {}) })
// Skip the proxy and go straight to the top-level window
on('direct', async () => { window.top.postMessage({ jsonrpc: '2.0', id: 900002, method: 'tools/call', params: { name: 'increment', arguments: { direct: true } } }, '*'); log('direct-sent', {}) })
on('link', async () => log('link-result', await app.openLink({ url: 'https://example.test/docs?from=view' })))
on('bad-link', async () => log('bad-link-result', await app.openLink({ url: 'javascript:alert(1)' })))
on('msg', async () => log('msg-result', await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello from the view' }] })))
on('read', async () => log('read-result', (await app.readServerResource({ uri: 'ui://fixture/data' })).contents))
on('grow', async () => { document.getElementById('spacer').style.height = '600px' })
// Every progress notification that arrives on the wire — the SDK does not forward notifications
// for a request that already finished to its handler, so whether the host has stopped is counted
// on the wire instead
window.addEventListener('message', (e) => { if (e.data && e.data.method === 'notifications/progress') log('progress-wire', e.data.params) })
// A slow tool — resets the clock on progress notifications the way ext-apps has it wired,
// swapping in only our own onprogress
on('slow', async () => log('slow-result', (await app.callServerTool({ name: 'slow', arguments: {} }, { onprogress: (p) => log('progress', p) })).structuredContent))
await app.connect()
log('connected', { origin: self.origin, href: location.href, referrer: document.referrer, hostContext: app.getHostContext(), hostCapabilities: app.getHostCapabilities() })
</script></body></html>`
}

type Served = { html: string }

export type FixtureHost = {
  views: ViewHost
  port: number
  /** Opens a view instance — what the runtime does when a tool result carries `_meta.ui.resourceUri` */
  open(app: AppRef, uri: string): string
  close(): Promise<void>
}

/**
 * A real HostServer + ViewHost. The per-app origin mode is turned on only for apps whose appId
 * ends in `-port` (a rule of this stand-in).
 */
export async function startFixtureHost(docs: Record<string, Served>): Promise<FixtureHost> {
  const secret = `e2e-${Math.random().toString(36).slice(2)}-${'x'.repeat(40)}`.replace(/[^A-Za-z0-9_-]/g, 'x')
  let port: number | null = null
  let book: string | null = null
  const source: ViewSource = {
    async readResource(app, uri) {
      const doc = docs[`${app.appId} ${uri}`]
      if (!doc) throw new Error(`no resource ${uri}`)
      return { contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: doc.html }] }
    },
    originMode: (app): OriginMode => (app.appId.endsWith('-port') ? 'app' : 'opaque'),
  }
  const views = new ViewHost({
    secret,
    allowedOrigins: ['http://127.0.0.1:5174', 'http://localhost:5174'],
    source,
    ports: new OriginPorts({ load: () => (book ? JSON.parse(book) : null), save: (b) => void (book = JSON.stringify(b)) }, { log: () => {} }),
    hostPort: () => port,
    log: () => {},
  })
  const server = new HostServer({ port: 0, token: 'e2e-token', onRpc: async () => ({}), http: { secret, routes: views.routes } })
  port = await server.listen()
  return {
    views,
    port,
    open: (app, uri) => views.open(app, uri).instanceId,
    close: async () => {
      await views.dispose()
      await server.close()
    },
  }
}
