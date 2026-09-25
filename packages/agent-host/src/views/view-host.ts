import { createHmac, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { createHttpHandler, type HttpRoute } from '../transport/http.js'
import { allowAttribute, approvedPermissions, buildProxyCsp, buildViewCsp, type ViewCspDomains, type ViewPermissions } from './csp.js'
import type { OriginPorts } from './origin-ports.js'
import { PROXY_SCRIPT_HASH, proxyPageHtml } from './proxy-page.js'
import { viewDocumentFromResource, type ViewDocument } from './view-document.js'

/**
 * 앱 화면 호스팅 (M4 B-3a).
 *
 * 화면 하나는 **도구 호출 한 번이 만든 인스턴스**다(규격: 화면에는 상태가 없다). 앱 런타임이
 * 결과에서 `_meta.ui.resourceUri`를 보면 `open()`으로 인스턴스를 만들고, 그 id가 UI로 간다.
 * UI는 `frame()`(RPC `apps.viewFrame`)으로 주소를 받아 샌드박스 프록시를 띄운다. 그 주소의
 * 길은 모두 host 포트의 비밀 칸 뒤에 있다(transport/http.ts).
 *
 * 이 층은 앱 프로세스를 모른다. 문서를 읽는 일은 `ViewSource`(런타임이 채운다)에게 맡기고,
 * 규격을 해석하는 일(무엇이 화면인가, CSP, 권한)은 여기서 한다.
 */

/** 앱 하나. 같은 id가 두 프로젝트에 있으면 둘은 다른 앱이다. `projectId: null`은 사용자 폴더 앱 */
export type AppRef = { projectId: string | null; appId: string }

/**
 * 화면의 출처 방식.
 *   opaque  기본. 안쪽 프레임에 `allow-same-origin`이 없다. 앱끼리 저장소가 섞이지 않는다.
 *   app     앱별 출처. 가져온 앱이나 요청한 앱에만 연다(S-1·S-8: 불투명 출처에서 깨지는 앱).
 */
export type OriginMode = 'opaque' | 'app'

/** 앱 런타임이 채우는 쪽 */
export interface ViewSource {
  /** MCP `resources/read`의 답을 그대로. 앱을 처음 필요할 때 띄우는 것도 저쪽의 일이다 */
  readResource(app: AppRef, uri: string): Promise<unknown>
  /** 없으면 불투명이다. 매니페스트나 가져오기가 정할 일이라 여기서는 기본만 둔다 */
  originMode?(app: AppRef): OriginMode
}

export type ViewFrame = {
  /** 프록시 페이지 주소. 비밀 칸이 들어 있다 — 로그에 적지 않는다 */
  url: string
  /** 바깥 iframe의 `allow` (안쪽도 같은 값을 받는다) */
  allow: string
  /** 호스트가 받아들인 것. 화면에 `hostCapabilities.sandbox`로 알려 준다 */
  sandbox: { csp: Required<ViewCspDomains>; permissions: ViewPermissions }
}

type Instance = { id: string; app: AppRef; uri: string; doc: ViewDocument | null }

export type ViewHostOptions = {
  /** host 포트의 HTTP 비밀 (transport/http.ts). 앱별 출처의 비밀도 여기서 파생한다 */
  secret: string
  /** 프록시가 메시지를 주고받을 부모 출처의 허용 목록. WebSocket과 같은 목록이다 */
  allowedOrigins: readonly string[]
  /** 런타임이 아직 없으면 null. 그때 화면 요청은 이유와 함께 실패한다 */
  source: ViewSource | null
  ports: OriginPorts
  /** listen() 뒤에야 정해진다 */
  hostPort: () => number | null
  log?: (line: string) => void
}

/**
 * 인스턴스 상한. 런타임이 닫는 것을 잊어도 host 메모리가 끝없이 늘지 않게 한다. 가장 오래된
 * 것부터 버린다. 버린 인스턴스의 화면은 다시 열 때 404를 받는다. 대화 안에서 살아 있는 화면은
 * 최근 몇 개뿐이라(플랜 "화면이 뜨는 두 자리") 이 수에 닿을 일이 드물다.
 */
const MAX_INSTANCES = 1000

const INSTANCE_ID = /^[A-Za-z0-9_-]{16,64}$/

/** 안쪽 프레임의 sandbox. `allow-popups`·`allow-top-navigation`은 어느 쪽에도 없다 */
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

  constructor(private readonly opts: ViewHostOptions) {
    this.allowed = new Set(opts.allowedOrigins.filter((o) => o !== '' && o !== 'null'))
    this.log = opts.log ?? ((line) => console.error(line))
  }

  /**
   * 앱별 출처의 열쇠. 포트 배정표의 열쇠이기도 하다. 프로젝트까지 넣는다. 두 프로젝트의
   * `notes` 앱은 서로 다른 앱이라 저장소도 달라야 한다.
   */
  static originKey(app: AppRef): string {
    return `${app.projectId ?? '_user'}/${app.appId}`
  }

  open(app: AppRef, uri: string): { instanceId: string } {
    const id = randomBytes(16).toString('base64url')
    if (this.instances.size >= MAX_INSTANCES) {
      const oldest = this.instances.keys().next().value
      if (oldest !== undefined) this.instances.delete(oldest)
    }
    this.instances.set(id, { id, app: { projectId: app.projectId ?? null, appId: app.appId }, uri, doc: null })
    return { instanceId: id }
  }

  close(instanceId: string): void {
    this.instances.delete(instanceId)
  }

  /**
   * UI가 화면을 띄울 주소 (RPC `apps.viewFrame`).
   *
   * **앱은 인스턴스가 정한다.** 부르는 쪽이 준 `app`은 인스턴스의 앱과 대조만 한다. 다르면
   * 없는 것으로 친다. 그래서 A 앱의 화면 id로 B 앱의 이름을 대도 아무것도 열리지 않는다.
   *
   * 문서는 여기서 한 번 읽어 인스턴스에 둔다. 화면을 다시 열면(`frame()`을 다시 부르면) 새로
   * 읽는다. 앱을 고친 뒤 다시 연 화면이 옛 HTML을 보지 않게 하려는 것이다.
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
    // 앱별 출처라면 주소를 주기 **전에** 그 포트가 떠 있어야 한다. 프록시가 곧바로 그리로 간다
    if (this.originMode(inst.app) === 'app') await this.originServer(ViewHost.originKey(inst.app))
    return {
      url: `http://127.0.0.1:${port}/${this.opts.secret}/views/${inst.id}/?${new URLSearchParams({ host: p.hostOrigin })}`,
      allow: allowAttribute(inst.doc.permissions),
      sandbox: { csp: csp.approved, permissions: approvedPermissions(inst.doc.permissions) },
    }
  }

  /**
   * 화면이 자기 앱의 리소스를 읽는다 (RPC `apps.readResource`, 브리지의 `onreadresource`).
   * 인스턴스를 주면 그 인스턴스의 앱과 같아야 한다.
   */
  async readResource(app: AppRef, uri: string, instanceId?: string): Promise<unknown> {
    if (instanceId !== undefined) {
      const inst = this.instances.get(instanceId)
      if (!inst || !sameApp(inst.app, app)) fail('This app view is not open')
    }
    return this.source().readResource(app, uri)
  }

  /** host 포트에 거는 길. 모두 비밀 칸 뒤에 있다 (HostServer가 게이트를 건다) */
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

  private source(): ViewSource {
    return this.opts.source ?? fail('App views are unavailable: the app runtime is not running')
  }

  private originMode(app: AppRef): OriginMode {
    return this.opts.source?.originMode?.(app) === 'app' ? 'app' : 'opaque'
  }

  private async readDocument(inst: Instance): Promise<ViewDocument> {
    return viewDocumentFromResource(await this.source().readResource(inst.app, inst.uri), inst.uri)
  }

  /** 없는 인스턴스, 허용되지 않은 부모, 읽지 못한 문서는 모두 404다 — 이 길은 무엇도 설명하지 않는다 */
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
      // srcdoc 문서는 이 응답의 정책을 물려받는다 — 화면의 CSP를 거는 자리가 여기다
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildViewCsp(doc.csp).policy },
      body: proxyPageHtml({ mode: 'opaque', hostOrigin, sandbox: SANDBOX_OPAQUE, allow, html: doc.html }),
    }
  }

  /**
   * 앱별 출처의 비밀. host 비밀에서 열쇠마다 파생한다.
   *
   * 이 방식의 화면은 진짜 출처를 가지므로 `location.href`로 자기 주소를 읽는다. 그 주소에 host
   * 포트의 비밀이 그대로 있으면 화면 하나가 모든 앱의 프록시 길을 아는 셈이 된다. 파생한
   * 값은 그 앱의 포트에서만 통한다.
   */
  private originSecret(key: string): string {
    return createHmac('sha256', this.opts.secret).update(`view-origin\0${key}`).digest('base64url')
  }

  /** 열쇠의 앱별 출처 서버. 처음 필요할 때 띄운다(고정 포트, origin-ports.ts) */
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
      // 실패는 기억하지 않는다 — 다음 요청이 다시 시도한다 (포트를 쥔 프로그램이 떠났을 수 있다)
      pending.catch(() => this.origins.delete(key))
      this.origins.set(key, pending)
    }
    return pending
  }

  /** 앱별 출처 포트에서 서빙하는 화면 문서. 그 포트의 앱이 아닌 인스턴스는 없는 것이다 */
  private async originDocument(key: string, instanceId: string) {
    if (!INSTANCE_ID.test(instanceId)) return null
    const inst = this.instances.get(instanceId)
    if (!inst || ViewHost.originKey(inst.app) !== key) return null
    const doc = inst.doc ?? (await this.readDocument(inst).catch(() => null))
    if (!doc) return null
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildViewCsp(doc.csp).policy },
      body: doc.html,
    }
  }
}
