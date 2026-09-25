import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { HostServer } from '../../packages/agent-host/src/transport/server.js'
import { ViewHost, type AppRef, type OriginMode, type ViewSource } from '../../packages/agent-host/src/views/view-host.js'
import { OriginPorts } from '../../packages/agent-host/src/views/origin-ports.js'
import { VIEW_MIME_TYPE } from '../../packages/agent-host/src/views/view-document.js'

/**
 * 앱 화면 e2e의 host 쪽 (M4 B-3).
 *
 * 앱 런타임은 이 브랜치에 없다. 그래서 문서를 읽는 쪽(`ViewSource`)만 대역이고, 나머지는
 * 진짜 host 코드다. 같은 비밀 게이트의 HostServer, 같은 ViewHost(프록시 페이지, CSP, 앱별
 * 출처 포트)를 쓴다. 화면 HTML은 공식 ext-apps 2.x의 `App`을 쓰는 작은 앱이다. 번들을 그대로
 * 안에 싣는다. 규격의 기본 CSP는 바깥 스크립트를 막으므로 실제 앱도 이렇게 한 파일로 온다(S-6).
 */

const uiRequire = createRequire(new URL('../../packages/ui/package.json', import.meta.url))

/** `app-with-deps.js`의 마지막 `export{…}`를 풀어 `App`을 지역 이름으로 꺼낸다 */
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
 * 시험용 앱 화면. 받은 것은 모두 `#log`에 한 줄씩 적는다(시험이 프레임 안을 읽는다).
 * 단추는 화면이 host에 부탁할 수 있는 것을 하나씩 해 본다.
 */
export function fixtureViewHtml(opts: { hangTeardown?: boolean; ignoreNotifications?: boolean } = {}): string {
  bundle ??= extAppsInline()
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture view</title></head>
<body style="margin:0;padding:8px;font:12px sans-serif;background:#fff;color:#000">
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
app.onhostcontextchanged = (p) => log('host-context-changed', p)
// 실제 앱이 teardown에서 하는 일: 저장하고 답한다. 저장이 목에 닿으면 화면이 요청을 받은 것이다
app.onteardown = ${opts.hangTeardown ? '() => new Promise(() => {})' : "async () => { await app.callServerTool({ name: 'save-on-teardown', arguments: {} }); log('teardown', {}); return {} }"}
// 우리 템플릿이 하는 일: 모르는 알림을 받아 본다. 다른 호스트용 앱은 이 줄이 없다(ignoreNotifications)
${opts.ignoreNotifications ? '' : "app.fallbackNotificationHandler = async (n) => log('notification', { method: n.method, params: n.params })"}
const on = (id, fn) => document.getElementById(id).addEventListener('click', () => fn().catch((e) => log(id + '-error', String(e && e.message || e))))
on('call', async () => log('call-result', (await app.callServerTool({ name: 'increment', arguments: { by: 2 } })).structuredContent))
// 메시지 안에 다른 앱을 적어 본다 — params와 _meta 양쪽에
on('spoof', async () => log('spoof-result', (await app.callServerTool({ name: 'increment', arguments: { by: 1 }, appId: 'victim', projectId: 'p-victim', _meta: { appId: 'victim', projectId: 'p-victim', instanceId: 'stolen' } })).structuredContent))
// SDK를 거치지 않은 날 JSON-RPC — 규격 밖의 칸을 마음대로 붙여 보낸다
on('raw', async () => { window.parent.postMessage({ jsonrpc: '2.0', id: 900001, method: 'tools/call', params: { name: 'increment', arguments: { raw: true }, appId: 'victim', app: 'victim', projectId: 'p-victim' } }, '*'); log('raw-sent', {}) })
// 프록시를 건너뛰고 최상위 창에 곧바로
on('direct', async () => { window.top.postMessage({ jsonrpc: '2.0', id: 900002, method: 'tools/call', params: { name: 'increment', arguments: { direct: true } } }, '*'); log('direct-sent', {}) })
on('link', async () => log('link-result', await app.openLink({ url: 'https://example.test/docs?from=view' })))
on('bad-link', async () => log('bad-link-result', await app.openLink({ url: 'javascript:alert(1)' })))
on('msg', async () => log('msg-result', await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello from the view' }] })))
on('read', async () => log('read-result', (await app.readServerResource({ uri: 'ui://fixture/data' })).contents))
on('grow', async () => { document.getElementById('spacer').style.height = '600px' })
await app.connect()
log('connected', { origin: self.origin, href: location.href, referrer: document.referrer, hostContext: app.getHostContext(), hostCapabilities: app.getHostCapabilities() })
</script></body></html>`
}

type Served = { html: string }

export type FixtureHost = {
  views: ViewHost
  port: number
  /** 화면 인스턴스를 연다 — 도구 결과가 `_meta.ui.resourceUri`를 실었을 때 런타임이 하는 일 */
  open(app: AppRef, uri: string): string
  close(): Promise<void>
}

/**
 * 진짜 HostServer + ViewHost. 앱별 출처 방식은 appId가 `-port`로 끝나는 앱에만 연다(대역의 규칙).
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
